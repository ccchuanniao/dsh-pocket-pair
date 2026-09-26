/**
 * 局域网闸门：插件自己监听的一个 HTTP 入口，转发到本机 harness。
 *
 * 为什么必须自己起这个 socket：harness 本体的监听地址被写死成 `127.0.0.1` 或 `0.0.0.0`
 * 两个值，而且 `dsh web --host 0.0.0.0` 被 CLI 明确拒绝（官方理由是"会把远程代码执行
 * 暴露到网络"）。IPv6 更不可能 —— Node 只有在 host 省略或为 `::` 时才会建双栈 socket，
 * 这两个值 schema 都不接受。所以局域网/IPv6 入口只能由插件自己开。
 *
 * 它同时是**闸门**：DSH 那一层没有按设备吊销的能力（会话 cookie 是无状态 HMAC，
 * 验证只查签名+authority+有效期）。按设备吊销只能做在这里 —— 设备表是这个插件自己的，
 * 删掉一行，那台机器下一次请求就进不来。
 *
 * 转发时插件扮演"本机浏览器"：Host 改写成上游的 loopback authority，并附上 DSH 自己的
 * 会话 cookie。会话 cookie 是插件启动后自己去换一次的（见 ensureSession），因为
 * Connection 没有给插件签发会话的接口，而手机那边的 authority 和上游不一样，
 * 直接把它在公网入口换到的 cookie 拿到局域网来是用不了的。
 */
import { networkInterfaces } from 'node:os'
import { createReadStream, statSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'

/** 设备会话 cookie 的名字。手机在自己的域名下带这个 cookie 来，闸门认它。 */
const DEVICE_COOKIE = 'dsh-pocket-pair'

/** 首次进入时用来兑换设备 cookie 的查询参数，兑换完立刻重定向掉。 */
const DEVICE_QUERY = 'device'

/**
 * 安装包文件名只允许这个样子。
 *
 * 这一个正则就是目录穿越的全部防线：不允许任何路径分隔符，也不允许 `..` 之外的花样，
 * 因为目录穿越只有"名字里带路径"这一条路。范围窄一点没有代价 —— 安装包是我们自己生成的。
 */
const APK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/

/**
 * 逐跳头（RFC 7230 第 6.1 节）：只对单条连接有意义，代理必须自己消化，不能原样转发。
 *
 * 尤其是 `transfer-encoding` —— 原样带走会让转发出去的响应和 Node 自己加的编码冲突，
 * 流式连接（harness 的实时通道）就是被这个弄断的。`connection` / `keep-alive` 同理。
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function withoutHopByHop(headers, keep = []) {
  const kept = new Set(keep)
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower) && !kept.has(lower))
      continue
    out[name] = value
  }
  return out
}

/**
 * 把请求头改写成"这台机器上的浏览器"发出的样子。
 *
 * 只改 Host 是不够的：harness 的信任栅栏还会检查，如果请求带了 Origin，
 * 它的 host 必须和 Host 一致。手机从闸门进来时 Origin 是闸门自己的地址
 * （比如 http://192.168.1.10:8081），而 Host 被我们改成了 127.0.0.1:<上游端口>，
 * 两者不等 —— 栅栏直接 403。
 *
 * 这个差异在浏览器里表现得很有迷惑性：普通 GET 不带 Origin，所以页面能正常打开；
 * 而 WebSocket 握手**一定**带 Origin，于是实时连接反复失败、界面一直"自动重连中"。
 */
function forUpstream(headers, upstreamAuthority, keep = []) {
  // keep 是给 WebSocket 握手用的：Connection / Upgrade 对普通请求是逐跳头，
  // 对握手却是**必需**的。一起剥掉的话上游会把升级请求当成普通 GET，回 404。
  const out = withoutHopByHop(headers, keep)
  out.host = upstreamAuthority
  if (typeof out.origin === 'string' && out.origin !== '')
    out.origin = `http://${upstreamAuthority}`
  return out
}

/**
 * 从 node 请求流里读一个有上限的 JSON 体。
 *
 * 闸门自己处理的两条路由拿到的是一手的 IncomingMessage，没有框架帮忙解析。
 * 超限时先 resume 再放弃，否则对端会因为没人读而挂住。
 */
async function readJsonBody(req, limit = 8192) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > limit) {
      req.resume()
      return undefined
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
  }
  catch {
    return undefined
  }
}

function sessionCookieOf(headers) {
  const raw = headers.cookie
  if (typeof raw !== 'string')
    return []
  return raw.split(';').map(part => part.trim()).filter(part => part.length > 0)
}

/**
 * 报出这台机器可以给局域网用的地址。
 *
 * 不做"哪个是对外那个"的判断 —— 一台机器常常同时有多个网段，选错了比给一串更糟。
 * 顺序按 IPv4 优先，因为手机上的手打地址和二维码都更常是 IPv4。
 */
export function lanAddresses() {
  const found = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal)
        continue
      // 链路本地 IPv6 出了这个网段就没有意义，给了只会让人试错。
      if (entry.family === 'IPv6' && /^fe80:/i.test(entry.address))
        continue
      found.push({ name, family: entry.family, address: entry.address })
    }
  }
  return found.sort((left, right) => (left.family === 'IPv4' ? 0 : 1) - (right.family === 'IPv4' ? 0 : 1))
}

/** 把地址拼成 URL 里的 host 段，IPv6 需要方括号。 */
export function hostLiteral(address) {
  return address.includes(':') ? `[${address}]` : address
}

/**
 * 启动闸门。
 *
 * @param options.devices 设备表：`find(token)` 取设备，`touch(token)` 记活跃时间。
 * @param options.port 监听端口。
 * @param options.upstreamPort harness 自己的端口，只在 loopback 上。
 * @param options.connection 用来换 harness 会话 cookie 的 Connection 服务。
 * @param options.publicPaths 不需要设备令牌就能过的路径（兑现路由）。
 * @param options.onPushToken 收到设备的推送令牌时回调 `(deviceName, token)`。
 *        由闸门本地处理而不是转给上游：只有闸门确切知道这条请求是哪台设备发的。
 * @param options.apkDir 安装包所在的目录，插件的下载路由只从这里发文件。
 * @param options.apkName 默认安装包文件名，二维码默认指向它。
 * @param options.logger 插件的 logger。
 */
export function createLanGate({ devices, port, upstreamPort, connection, publicPaths = [], apkDir, apkName, onPushToken, logger }) {
  const upstreamAuthority = `127.0.0.1:${upstreamPort}`

  /**
   * 插件自己那份 harness 会话 cookie。
   *
   * 换法就是浏览器那一步：拿带启动令牌的 URL 请求一次首页，接住 Set-Cookie。
   * 缓存它，因为每次请求都换一遍既没必要也会不停给 harness 记新会话；
   * 上游回过 401 就丢掉重换 —— 那说明密钥轮换或者会话过期了。
   */
  let sessionCookie = null

  /**
   * 还没断开的 WebSocket，按设备令牌索引它的 socket。
   *
   * 存在的原因只有一个：设备校验发生在握手那一刻，之后闸门只是双向 pipe，不再参与。
   * 于是"吊销设备"不会影响已经建立的长连接，页面开着就能一直用下去。要让它立即生效，
   * 就必须记得谁还连着，并在吊销时主动断开。
   */
  const liveSockets = new Map()

  async function ensureSession() {
    if (sessionCookie !== null)
      return sessionCookie
    const admission = connection.authenticatedUrl(`http://${upstreamAuthority}/`)
    const response = await new Promise((resolve, reject) => {
      const request = http.request(admission, { method: 'GET' }, resolve)
      request.on('error', reject)
      request.end()
    })
    response.resume()
    const setCookie = response.headers['set-cookie'] ?? []
    const auth = setCookie.map(value => value.split(';')[0]).find(value => value.startsWith('dsh-auth-'))
    if (auth === undefined) {
      throw new Error(`dsh-pocket-pair: harness did not hand back a session cookie (HTTP ${response.statusCode})`)
    }
    sessionCookie = auth
    return sessionCookie
  }

  /**
   * 从这条请求里认出设备。
   *
   * 只做判断，绝不重建 URL。harness 的插件 bundle 地址形如
   * `/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=…`，把它交给
   * URLSearchParams 再拼回来会把 `@` `/` `,` 转义掉，上游的模块 id 就对不上，
   * bundle 静默 404，页面最后只报一句 "HTML did not preload"。
   * 所以要转发的路径一律原样透传 req.url。
   */
  function authenticated(req) {
    const queryAt = req.url.indexOf('?')
    const offered = queryAt === -1
      ? null
      : new URLSearchParams(req.url.slice(queryAt + 1)).get(DEVICE_QUERY)
    if (offered !== null && devices.find(offered, Date.now()) !== undefined) {
      // 交换一次就把它从地址栏里去掉：留在地址里会被复制、被截图、进历史记录。
      // 只按文本剥掉这一段，其余查询串原样保留。
      const rest = queryAt === -1 ? '' : req.url.slice(queryAt + 1)
      const kept = rest.split('&').filter(part => part !== `${DEVICE_QUERY}=${offered}`)
      const head = queryAt === -1 ? req.url : req.url.slice(0, queryAt)
      return { token: offered, redirect: true, location: kept.length === 0 ? head : `${head}?${kept.join('&')}` }
    }
    for (const part of sessionCookieOf(req.headers)) {
      const at = part.indexOf('=')
      if (at <= 0 || part.slice(0, at) !== DEVICE_COOKIE)
        continue
      const token = part.slice(at + 1)
      if (devices.find(token, Date.now()) !== undefined)
        return { token, redirect: false }
    }
    return null
  }

  function refuse(res) {
    const body = '<!doctype html><meta charset="utf-8"><title>DSH Pocket</title>'
      + '<body style="font:16px system-ui;padding:2rem;line-height:1.6">'
      + '<h1 style="font-size:1.2rem">这台设备还没有配对</h1>'
      + '<p>在 harness 的「设置 → 手机配对」里生成一个配对码，或者用配对二维码重新扫一次。</p>'
      + '<p>如果已经配对过，可能是这台设备被吊销了。</p>'
    res.writeHead(401, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  /**
   * 这条请求真正来自哪里。
   *
   * 闸门可能被两种方式访问：局域网设备直连（来源就是 TCP 对端），或者经过一个本机反代
   * （公网那条路是 VPS 上的 nginx 转隧道进来的）。后一种情况下对端永远是 127.0.0.1，
   * 直接拿它当来源，所有手机就会共用同一个限流桶 —— 一台机器就能把整片地址限掉。
   * 所以只在**对端确实是本机**时才采信 `x-real-ip`；局域网直连时客户端伪造这个头没有用。
   */
  function clientAddress(req) {
    const peer = req.socket.remoteAddress ?? ''
    const fromThisMachine = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
    const forwarded = req.headers['x-real-ip']
    if (fromThisMachine && typeof forwarded === 'string' && forwarded.length > 0)
      return forwarded
    return peer
  }

  /**
   * 转发一条不需要设备令牌的路径。
   *
   * 只用于兑现路由。补 `x-real-ip` 是必须的：主服务器上的限流按这个头计来源，
   * 少了它，所有局域网设备会共用闸门这一个来源，一台机器就能把整片地址限掉。
   */
  /**
   * 首页必须不可缓存。
   *
   * harness 自己的 index 没有带 cache-control，浏览器会按启发式规则缓存它 —— 结果就是
   * 一台被吊销的设备重启 App 之后还能从本地缓存里看到完整控制台，吊销形同虚设。
   * 只钉首页：插件 bundle 是真正的大头，它们的缓存要继续留着。
   */
  function withIndexNoStore(path, headers) {
    const bare = path.split('?')[0]
    if (bare === '/' || bare === '/index.html')
      return { ...headers, 'cache-control': 'no-store' }
    return headers
  }

  async function passthrough(req, res, path) {
    const headers = forUpstream({ ...req.headers, host: upstreamAuthority }, upstreamAuthority)
    headers['x-real-ip'] = clientAddress(req)
    delete headers[DEVICE_COOKIE]
    const upstream = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path, headers: withoutHopByHop(headers) }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers)
      answer.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent)
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end()
    })
    req.pipe(upstream)
  }

  async function proxy(req, res, token, path) {
    let cookie
    try {
      cookie = await ensureSession()
    }
    catch (error) {
      logger.error(String(error))
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh-pocket-pair: could not reach the harness\n')
      return
    }

    devices.touch(token, Date.now())

    const headers = forUpstream({ ...req.headers, host: upstreamAuthority }, upstreamAuthority)
    headers.cookie = [...sessionCookieOf(req.headers).filter(part => !part.startsWith(`${DEVICE_COOKIE}=`)), cookie].join('; ')

    const upstream = http.request({
      host: '127.0.0.1',
      port: upstreamPort,
      method: req.method,
      path,
      headers,
    }, (answer) => {
      // 会话过期或密钥轮换：换一张新 cookie，让浏览器重来一次。
      if (answer.statusCode === 401 && sessionCookie !== null) {
        sessionCookie = null
        answer.resume()
        res.writeHead(303, { location: path, 'cache-control': 'no-store' })
        res.end()
        return
      }
      res.writeHead(answer.statusCode, withoutHopByHop(withIndexNoStore(path, answer.headers)))
      answer.pipe(res)
    })
    upstream.on('error', (error) => {
      logger.warn(`dsh-pocket-pair: upstream failed: ${error}`)
      if (!res.headersSent)
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end()
    })
    req.pipe(upstream)
  }

  /**
   * 把安装包发出去。
   *
   * 这一步刻意不走设备令牌：会用到它的正是**还没配对的手机** —— 它连 App 都没有，
   * 拿什么换令牌。所以这条路由和兑现路由一样，是闸门对外的免鉴权面，
   * 靠的是"只发那一个目录里的 .apk"把可及范围钉死。
   */
  function serveApk(req, res, name) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    if (!APK_NAME.test(name)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('no such package\n')
      return
    }
    let stat
    try {
      stat = statSync(join(apkDir, name))
    }
    catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('no such package\n')
      return
    }
    if (!stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('no such package\n')
      return
    }
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': stat.size,
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(join(apkDir, name)).pipe(res)
  }

  const server = http.createServer((req, res) => {
    const apkAt = req.url.split('?')[0]
    if (apkAt.startsWith('/apk/')) {
      serveApk(req, res, apkAt.slice('/apk/'.length))
      return
    }
    // 推送令牌登记走闸门自己：闸门按 cookie 已经确定了是哪台设备，
    // 转给上游的话上游只能靠一个可伪造的头来相信这件事。
    if (apkAt === '/dsh-pocket-pair/push') {
      // 登记请求来自应用自己的 HTTP 栈，不共享 WebView 的 cookie，所以也接受显式令牌头。
      // 这和 cookie 是同一个 bearer 值，安全等级相同。
      const offered = req.headers['x-dsh-device-token']
      const admitted = (typeof offered === 'string' && devices.find(offered, Date.now()) !== undefined)
        ? { token: offered, redirect: false }
        : authenticated(req)
      if (admitted === null || admitted.redirect) {
        refuse(res)
        return
      }
      void (async () => {
        const body = await readJsonBody(req)
        const token = typeof body?.token === 'string' ? body.token : ''
        if (token === '') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end('{"error":"token is required"}')
          return
        }
        const entry = devices.find(admitted.token, Date.now())
        onPushToken?.(entry?.device ?? 'unknown', token)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end('{"ok":true}')
      })()
      return
    }

    const admitted = authenticated(req)
    if (admitted === null) {
      // 兑现路由必须在局域网入口上也能走：手机要先拿令牌才谈得上用这个口，
      // 而令牌只能靠兑现配对码换。它保持和主服务器上一样的公开程度，
      // 限流在宿主侧按 x-real-ip 照旧生效，这里只负责把真实来源补上。
      const path = req.url.split('?')[0]
      if (publicPaths.includes(path)) {
        void passthrough(req, res, req.url)
        return
      }
      refuse(res)
      return
    }
    if (admitted.redirect) {
      // 把令牌从地址栏挪进 cookie，之后每一条请求都靠 cookie。
      res.writeHead(303, {
        location: admitted.location,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'set-cookie': `${DEVICE_COOKIE}=${admitted.token}; Path=/; HttpOnly; SameSite=Strict`,
      })
      res.end()
      return
    }
    // 原样透传，见 authenticated 的说明。
    void proxy(req, res, admitted.token, req.url)
  })

  // WebSocket 与其它 upgrade 也必须过闸门，否则实时通道会绕过设备校验。
  server.on('upgrade', (req, socket, head) => {
    const admitted = authenticated(req)
    if (admitted === null || admitted.redirect) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    // 记下这条长连接属于哪台设备。设备校验**只在握手时做一次**，之后是双向 pipe，
    // 所以吊销之后这条连接不会自己断 —— 页面还开着的话控制台就一直连着，直到客户端
    // 碰巧重连才发现自己被踢了。"吊销立即生效"对长连接并不成立，除非这里主动断。
    liveSockets.set(socket, admitted.token)
    const forget = () => liveSockets.delete(socket)
    socket.once('close', forget)
    socket.once('error', forget)
    void (async () => {
      let cookie
      try {
        cookie = await ensureSession()
      }
      catch {
        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        return
      }
      devices.touch(admitted.token, Date.now())
      // 同理：WebSocket 握手一定带 Origin，必须一起改写，否则栅栏 403。
      // 但 Connection / Upgrade 这两个头必须留着，它们是握手本身。
      const headers = forUpstream({ ...req.headers, host: upstreamAuthority }, upstreamAuthority, ['connection', 'upgrade'])
      headers.cookie = [...sessionCookieOf(req.headers).filter(part => !part.startsWith(`${DEVICE_COOKIE}=`)), cookie].join('; ')
      // 必须用 req.url：authenticated() 在 cookie 分支只回 token，没有 path。
      // 用 admitted.path 的话这里是 undefined，WebSocket 会被转发到 "/" 而不是真实路径，
      // 结果就是界面能开、但实时连接一直"自动重连中"。
      const upstream = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers })
      upstream.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
        const lines = [`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}`]
        // 握手响应必须带 upgrade / connection，其余逐跳头照常丢掉。
        for (const [name, value] of Object.entries(withoutHopByHop(answer.headers, ['upgrade', 'connection']))) {
          if (Array.isArray(value)) {
            for (const one of value) lines.push(`${name}: ${one}`)
          }
          else if (value !== undefined) {
            lines.push(`${name}: ${value}`)
          }
        }
        socket.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (upstreamHead.length > 0)
          socket.write(upstreamHead)
        if (head.length > 0)
          upstreamSocket.write(head)
        upstreamSocket.pipe(socket)
        socket.pipe(upstreamSocket)
      })
      upstream.on('response', (answer) => {
        // 上游没接受 upgrade：把状态如实带回去，别让客户端一直等。
        answer.resume()
        socket.end(`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\n\r\n`)
      })
      upstream.on('error', () => socket.destroy())
      upstream.end()
    })()
  })

  return {
    /** 绑 `::`，Node 会建双栈 socket，IPv4 和 IPv6 都能进。 */
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '::', () => {
        server.removeListener('error', reject)
        resolve()
      })
    }),
    stop: () => new Promise(resolve => server.close(() => resolve())),
    apkDir,
    apkName,
    /**
     * 断开某台设备已经建立的长连接。
     *
     * 吊销只影响"下一次请求"，而已经握过手的 WebSocket 不会再有下一次请求。调用方在吊销
     * 之后立刻调它，才能让用户在页面上看到的"已吊销"和实际效果一致。
     *
     * @param token 被吊销的设备令牌。
     * @returns 断掉的连接数，便于调用方记日志。
     */
    disconnect: (token) => {
      let closed = 0
      for (const [socket, owner] of liveSockets) {
        if (owner !== token)
          continue
        liveSockets.delete(socket)
        // destroy 而不是 end：握手之后这条 socket 是双向 pipe 的一端，等它优雅关闭
        // 会把已经失效的会话继续留一会儿，而这正是要立刻终止的东西。
        socket.destroy()
        closed += 1
      }
      return closed
    },
    resetSession: () => {
      sessionCookie = null
    },
  }
}
