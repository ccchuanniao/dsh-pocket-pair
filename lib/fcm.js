/**
 * 直接向 FCM 发推送。
 *
 * 两个刻意的选择：
 *
 * 1. **不用 google-auth-library。** 换 access token 只需要用服务账号的私钥签一个 JWT 再去换，
 *    `node:crypto` 就够。插件是要发布出去的，少一个依赖就少一份安装体积和一份供应链风险。
 *
 * 2. **自己实现 HTTP 代理隧道。** 这台机器直连 Google 会超时，必须穿 Clash 那类代理。
 *    Node 的 https 不认代理，而拉一个代理库同样是为了几十行的事引入依赖。
 *    这里只做 CONNECT：跟代理建 TCP，让它连目标 443，然后在同一个 socket 上跑 TLS。
 */
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'

const TOKEN_URL_DEFAULT = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
/** access token 有效期一小时，提前五分钟换，避免正好卡在过期的那一刻。 */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 通过 HTTP 代理建一条到 host:port 的 TLS 连接。
 *
 * 代理只被要求做 CONNECT（一条到目标的裸 TCP），TLS 握手仍由我们和真正的对端完成 ——
 * 所以代理看不到明文，也就不能篡改推送内容。
 */
function connectThroughProxy(proxyUrl, host, port) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl)
    const socket = netConnect(Number(proxy.port || 8080), proxy.hostname, () => {
      const auth = proxy.username !== ''
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n`
        : ''
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`)
    })
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString('latin1')
      if (!buffer.includes('\r\n\r\n')) return
      socket.removeListener('data', onData)
      const status = Number(buffer.split(' ')[1])
      if (status !== 200) {
        socket.destroy()
        reject(new Error(`proxy refused CONNECT with ${status}`))
        return
      }
      resolve(tlsConnect({ socket, servername: host }))
    }
    socket.on('data', onData)
    socket.on('error', reject)
    socket.setTimeout(20_000, () => { socket.destroy(); reject(new Error('proxy connect timed out')) })
  })
}

/**
 * 发一个 POST。给了代理就穿代理，否则直连。
 *
 * body 收原始字符串而不是对象：换 access token 那个接口要的是 `application/x-www-form-urlencoded`，
 * 不是 JSON。早先这里一律 JSON.stringify，换 token 会一直失败。
 */
async function postJson(url, { headers, body, proxyUrl, contentType = 'application/json' }) {
  const target = new URL(url)
  const port = Number(target.port || 443)
  const payload = Buffer.from(body, 'utf8')
  const requestHeaders = {
    'content-type': contentType,
    'content-length': payload.length,
    ...headers,
  }

  const send = (request) => new Promise((resolve, reject) => {
    request.on('response', (response) => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: response.statusCode ?? 0, text })
      })
    })
    request.on('error', reject)
    request.end(payload)
  })

  if (proxyUrl === '') {
    return await send(httpsRequest({ host: target.hostname, port, path: `${target.pathname}${target.search}`, method: 'POST', headers: requestHeaders }))
  }
  const socket = await connectThroughProxy(proxyUrl, target.hostname, port)
  return await send(httpsRequest({ createConnection: () => socket, host: target.hostname, port, path: `${target.pathname}${target.search}`, method: 'POST', headers: requestHeaders }))
}

/**
 * 造一个发送器。
 *
 * @param options.serviceAccountFile 服务账号 JSON 的路径。**这是真正的密钥**，绝不该进包里。
 * @param options.proxyUrl 形如 http://proxy.example.com:3128；留空则直连。
 * @param options.logger 插件的 logger。
 */
export function createFcmSender({ serviceAccountFile, proxyUrl = '', logger }) {
  let account = null
  let cachedToken = null
  let cachedUntil = 0

  function load() {
    if (account !== null)
      return account
    const parsed = JSON.parse(readFileSync(serviceAccountFile, 'utf8'))
    if (typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string')
      throw new Error('service account JSON is missing client_email or private_key')
    account = {
      email: parsed.client_email,
      key: parsed.private_key,
      tokenUrl: typeof parsed.token_uri === 'string' ? parsed.token_uri : TOKEN_URL_DEFAULT,
      projectId: typeof parsed.project_id === 'string' ? parsed.project_id : '',
    }
    return account
  }

  /** 换一个 access token，并缓存到快过期为止 —— 每条推送都换一次是白费一次往返。 */
  async function accessToken() {
    const now = Date.now()
    if (cachedToken !== null && now < cachedUntil)
      return cachedToken

    const me = load()
    const issuedAt = Math.floor(now / 1000)
    const expiresAt = issuedAt + 3600
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const claims = base64url(JSON.stringify({
      iss: me.email,
      scope: SCOPE,
      aud: me.tokenUrl,
      iat: issuedAt,
      exp: expiresAt,
    }))
    const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(me.key)
    const assertion = `${header}.${claims}.${base64url(signature)}`

    const answer = await postJson(me.tokenUrl, {
      proxyUrl,
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    })
    if (answer.status !== 200)
      throw new Error(`token exchange failed (${answer.status}): ${answer.text.slice(0, 200)}`)
    const parsed = JSON.parse(answer.text)
    cachedToken = parsed.access_token
    cachedUntil = now + (Number(parsed.expires_in ?? 3600) * 1000) - TOKEN_REFRESH_MARGIN_MS
    if (typeof cachedToken !== 'string' || cachedToken === '')
      throw new Error('token exchange returned no access_token')
    return cachedToken
  }

  return {
    /** 项目号，用来拼发送地址。 */
    projectId: () => load().projectId,

    /**
     * 往一台设备发一条。
     *
     * 一条一个请求，因为 FCM v1 没有批量接口，而这里要按设备发（不能用 topic 广播 ——
     * 那会让所有订阅者都收到别人的通知）。返回错误字符串，成功返回 null。
     */
    async sendToToken(token, { title, body, data = {} }) {
      const project = load().projectId
      if (project === '')
        return 'service account has no project_id'
      let bearer
      try {
        bearer = await accessToken()
      }
      catch (error) {
        return String(error.message ?? error)
      }
      try {
        const answer = await postJson(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
          proxyUrl,
          headers: { authorization: `Bearer ${bearer}` },
          body: JSON.stringify({
            message: {
              token,
              notification: { title, body },
              data,
              android: { priority: 'high' },
            },
          }),
        })
        if (answer.status === 200)
          return null
        // 令牌失效是常见的（重装、长期不用），单独说清楚，调用方好据此清掉它。
        return `${answer.status}: ${answer.text.slice(0, 200)}`
      }
      catch (error) {
        return String(error.message ?? error)
      }
    },
  }
}

export { postJson }
