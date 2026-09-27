/**
 * dsh-pocket-pair 宿主半侧。
 *
 * 这个插件把「让一台手机进得来」这件事从服务器上的命令行搬进 DSH 本体：
 * 所有者在网页端点一下按钮拿到一次性配对码，手机拿码去兑现，码当场作废。
 *
 * 两条路由，鉴权等级完全不同，这是本插件最需要小心的地方：
 *
 *   POST /api/pocket-pair/mint   受保护。挂在 connection 的共享 /api 通道上，
 *                                Host 栅栏和浏览器 cookie 都由 Connection 先过一遍，
 *                                所以只有已经登录的浏览器能生成码。
 *   POST /dsh-pocket-pair/redeem 公开。直接挂在 webServer 上，DSH 不拦它
 *                                （Connection 只保护首页和 /api 前缀）。这是插件的
 *                                唯一无凭证入口，因此限流和码校验必须自己做。
 *
 * 兑现成功后交给手机的不是自制凭证 —— DSH 没有可供插件签发浏览器会话的接口 ——
 * 而是 ctx.connection.authenticatedUrl()，也就是进程启动令牌的 URL。手机打开它一次，
 * DSH 自己把会话 cookie 种下去。代价是 DSH 那边没有按设备吊销的能力；吊销要在前面的
 * 闸门层做（见插件 README 的说明）。
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes, randomInt } from 'node:crypto'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import QRCode from 'qrcode'
import { createLanGate, hostLiteral, lanAddresses } from './lan-gate.js'
import { createBuilder } from './build.js'
import { createFcmSender } from './fcm.js'
import { createPushSummarizer } from './summarize.js'

export const name = 'pocket-pair'

// webServer 用来挂公开的兑现路由；connection 提供受保护的 /api 通道和放行 URL。
export const inject = ['webServer', 'connection']

export const Config = z.object({
  /** 网页端「生成配对码」按钮点出来的码，默认一小时有效。 */
  codeTtlSeconds: z.natural().default(3600),
  /**
   * 二维码里带的安卓安装包地址。留空表示"由插件自己发" —— 默认指向本插件的
   * /apk/<apkName> 下载路由，这样换域名、换机器都不用再管一个外部下载站。
   * 填了就用填的（比如你已经有一个 CDN）。
   */
  apkUrl: z.string().default(''),
  /**
   * 安装包在磁盘上的目录。构建好的 APK 拷进来，插件的下载路由就发它。
   * 留空则是 <DSH_HOME>/dsh-pocket-pair/apk。
   */
  apkDir: z.string().default(''),
  /** 默认的安装包文件名，决定二维码默认指向哪一个。 */
  apkName: z.string().default('dsh-pocket.apk'),
  /**
   * 服务账号 JSON 的路径。**这是真正的密钥**，只在服务端，绝不进包。
   * 留空则不发送推送（App 那边照样能登记令牌，只是没人发）。
   */
  fcmServiceAccountFile: z.string().default(''),
  /**
   * HTTP proxy used to reach Google's OAuth and FCM endpoints, as `http://host:port`.
   *
   * Only needed when the host cannot reach them directly. The proxy sees a raw TCP tunnel:
   * TLS is negotiated end-to-end with Google, so it cannot read the traffic.
   */
  fcmProxy: z.string().default(''),
  /** 推送开关。关掉只影响发送，不影响 App 侧登记令牌。 */
  pushEnabled: z.boolean().default(true),
  /** 推送标题。 */
  pushTitle: z.string().default('DSH 任务完成'),
  /**
   * 正文是否交给当前对话用的模型生成。
   *
   * 关着（默认）用这一轮最后一条助手消息的开头 —— 免费、瞬时、永不失败。
   * 开着则由模型压成一句话：更像人话，但每次推送都要多花一次模型调用，
   * 而且要等它返回。所以这是个开关，不是默认行为。
   */
  pushAiSummary: z.boolean().default(false),
  /** 生成摘要的超时。超时就用原文兜底，不会导致通知发不出去。 */
  pushAiTimeoutMs: z.natural().default(15000),
  // Firebase 的客户端配置默认值。都是公开值；页面上填的会覆盖它。
  firebaseProjectId: z.string().default(''),
  firebaseAppId: z.string().default(''),
  firebaseApiKey: z.string().default(''),
  firebaseSenderId: z.string().default(''),
  notifyTopic: z.string().default(''),
  /**
   * 二维码里告诉手机该连的完整地址（含协议）。
   *
   * 用完整 base 而不是光一个域名，是因为放行 URL 的协议必须和实际入口一致：
   * 公网入口是 https（nginx 终结 TLS），而模拟器/局域网直连那条路是明文 http。
   * 局域网模式落地后这里会换成探测到的地址。
   */
  pairBase: z.string().default(''),
  /** 公开兑现路由每分钟允许的尝试次数，按来源地址计。 */
  redeemPerMinute: z.natural().default(10),
  /**
   * 局域网闸门的端口。手机走这个口直连时，鉴权和吊销都发生在这里。
   *
   * 和 harness 自己的端口分开放，是因为闸门要绑 `::`（双栈），而 harness 只肯绑
   * IPv4 的 loopback —— 共用端口在实现上不可能。
   */
  lanPort: z.natural().max(65535).default(8081),
  /** 关掉就不开闸门，只保留公网/直连那条路。 */
  lanEnabled: z.boolean().default(true),
  /** 二维码里报给手机的局域网地址；留空就自动挑一个非 loopback 地址。 */
  lanAdvertise: z.string().default(''),
  /**
   * 是否允许从网页端触发构建。
   *
   * 这个开关存在是因为那个按钮等同于让一个 HTTP 请求去跑 Gradle —— 也就是执行构建脚本。
   * 它挂在受鉴权的 /api 通道上，所以只有已登录的浏览器能碰；不想给这个能力就关掉。
   */
  buildEnabled: z.boolean().default(false),
  /** 安卓工程目录（里面要有 gradlew）。 */
  buildProjectDir: z.string().default(''),
  /** Gradle 构建产物的路径，相对工程目录。 */
  buildOutputApk: z.string().default('app/build/outputs/apk/release/app-release.apk'),
})

const MINT_PATH = '/api/pocket-pair/mint'
const STATE_PATH = '/api/pocket-pair/state'
const REDEEM_PATH = '/dsh-pocket-pair/redeem'
const REVOKE_PATH = '/api/pocket-pair/revoke'
const SETTINGS_PATH = '/api/pocket-pair/settings'
const BUILD_PATH = '/api/pocket-pair/build'
const CLOSE_PATH = '/api/pocket-pair/close'
const SUMMARIZE_PATH = '/api/pocket-pair/summarize'

/**
 * 配对码字母表：去掉了 0/o/1/l/i 这些看错的字符。
 *
 * 这个码要从屏幕读到手机上手打，所以没有形近字符比多几位熵更值钱。
 * 32 个字符取 8 位约 40 bit，配合一次性使用和一分钟 10 次的限流足够。
 */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const CODE_LENGTH = 8

function mintCode() {
  let code = ''
  for (let index = 0; index < CODE_LENGTH; index += 1)
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

/**
 * 配对码仓库。落盘是刻意的：生成码之后 owner 可能重启 DSH 再让手机连，
 * 只放内存里的话那一刻码就没了。
 */
/** 页面可填的 Firebase 客户端字段。都是公开值，不是密钥。 */
const FIREBASE_FIELDS = ['firebaseProjectId', 'firebaseAppId', 'firebaseApiKey', 'firebaseSenderId', 'notifyTopic']

/**
 * 把页面上生效的部署值同步进安卓工程自己的配置文件。
 *
 * 页面保存设置只写 settings.json，而 `dsh-pocket.properties` 是构建脚本真正读的那份。
 * 两边不同步的话，"点按钮构建"（-P 传 settings.json 的值）和"手动构建"（读
 * dsh-pocket.properties）会用不同的值 —— 这正是之前分发出错包的原因之一。
 *
 * 只写页面管理的键（pairBase、Firebase、notifyTopic）；
 * applicationId 和 appLinkHost 留在原样 —— 它们不在页面上编辑，是部署者手配的。
 * buildProjectDir 为空（构建没开）时跳过：不该为一个不存在的工程写配置。
 */
function syncToBuildProperties(settings, projectDir) {
  if (projectDir === '')
    return
  const file = join(projectDir, 'dsh-pocket.properties')
  let existing = ''
  try {
    existing = readFileSync(file, 'utf8')
  }
  catch {
    // 不存在就从头写：第一次部署就是这个路径。
  }
  // 写完必须让**构建的那个人**读得到。这台机器上 Gradle 可能以另一个用户跑，
  // 读不到这份文件时构建**不会报错** —— 它会静默退回中性默认值，打出一个没有地址的包。
  // 所以首次写入用 0644（这里本来就没有秘密：Firebase 客户端配置和地址都是公开值，
  // 真正的一次性钥匙只走 -P 命令行），已有文件则沿用它原来的权限位。
  let mode = 0o644
  try {
    mode = statSync(file).mode & 0o777
  }
  catch {
    // 文件还不存在，用默认权限。
  }
  const managed = {
    pairBase: settings.pairBase,
    firebaseProjectId: settings.firebaseProjectId,
    firebaseAppId: settings.firebaseAppId,
    firebaseApiKey: settings.firebaseApiKey,
    firebaseSenderId: settings.firebaseSenderId,
    notifyTopic: settings.notifyTopic,
  }
  // 保留文件里原有的非管理键（applicationId、appLinkHost、注释），替换/追加管理键。
  const managedKeys = new Set(Object.keys(managed))
  const kept = []
  for (const line of existing.split('\n')) {
    const key = line.split('=')[0]?.trim()
    if (key !== '' && managedKeys.has(key))
      continue
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '')
    kept.pop()
  for (const [key, value] of Object.entries(managed)) {
    if (value !== '')
      kept.push(`${key}=${value}`)
  }
  const content = kept.join('\n') + '\n'
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, content, { mode })
  // 新建文件受 umask 影响，chmod 一次把权限位定死。
  chmodSync(temporary, mode)
  renameSync(temporary, file)
}


/**
 * 所有者填的部署参数。
 *
 * 域名和安装包地址不写死在 profile 配置里：换一个反代、换一台 VPS、临时指向测试包，
 * 都是日常动作，不该每次都改配置文件再重启 harness。存在插件自己的目录下，
 * 读取发生在每次请求，所以改完立刻生效。
 *
 * 配置项仍然保留，作为没填过时的默认值。
 */
class DeploymentSettings {
  constructor(file, defaults, logger) {
    this.file = file
    this.defaults = defaults
    this.logger = logger
    this.stored = {}
    this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.pairBase === 'string') this.stored.pairBase = parsed.pairBase
        if (typeof parsed.apkUrl === 'string') this.stored.apkUrl = parsed.apkUrl
        for (const field of FIREBASE_FIELDS) {
          if (typeof parsed[field] === 'string') this.stored[field] = parsed[field]
        }
        // 布尔不能走 pick()：那个函数按"空串=没填"处理，而 false 是有效取值。
        if (typeof parsed.pushAiSummary === 'boolean') this.stored.pushAiSummary = parsed.pushAiSummary
      }
    }
    catch (error) {
      if (error?.code !== 'ENOENT')
        this.logger.warn(`dsh-pocket-pair: settings unreadable, using defaults: ${error}`)
    }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.stored, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.file)
  }

  /**
   * 生效中的值：所有者填过就用填的，没填过退回配置默认。
   *
   * 空串按"没填"处理。用 `??` 是不够的 —— 空串不是 null/undefined，会让所有者在界面上
   * 清空输入框时得到空地址，而不是回到配置里的默认值；那个错误直到二维码扫不出东西才显形。
   */
  pick(stored, fallback) {
    const value = (stored ?? '').trim()
    return value !== '' ? value : (fallback ?? '').trim()
  }

  get pairBase() {
    return this.pick(this.stored.pairBase, this.defaults.pairBase).replace(/\/+$/, '')
  }

  /**
   * 生效中的安装包地址。
   *
   * 三级：所有者填过 → 用它；配置里给过 → 用它；都没有 → 指向本插件自己的下载路由。
   * 最后这一档是有意为之：默认就是"插件负责分发"，不依赖任何外部下载站。
   */
  get firebaseProjectId() { return this.pick(this.stored.firebaseProjectId, this.defaults.firebaseProjectId) }
  get firebaseAppId() { return this.pick(this.stored.firebaseAppId, this.defaults.firebaseAppId) }
  get firebaseApiKey() { return this.pick(this.stored.firebaseApiKey, this.defaults.firebaseApiKey) }
  get firebaseSenderId() { return this.pick(this.stored.firebaseSenderId, this.defaults.firebaseSenderId) }
  get notifyTopic() { return this.pick(this.stored.notifyTopic, this.defaults.notifyTopic) }

  /**
   * 生效中的"AI 生成推送正文"开关。
   *
   * 和字符串字段不同，这里**不把 false 当作"没填"** —— 关掉是一个明确的选择，
   * 不能被配置默认值覆盖回去。只有从未存过（undefined）才用配置默认。
   */
  get pushAiSummary() {
    if (typeof this.stored.pushAiSummary === 'boolean')
      return this.stored.pushAiSummary
    return this.defaults.pushAiSummary === true
  }

  set pushAiSummary(value) {
    this.stored.pushAiSummary = value === true
    this.save()
  }

  get apkUrl() {
    const explicit = this.pick(this.stored.apkUrl, this.defaults.apkUrl)
    if (explicit !== '')
      return explicit
    const base = this.pairBase
    if (base === '')
      return ''
    return `${base}/apk/${this.defaults.apkName}`
  }

  update(next) {
    for (const field of ['pairBase', 'apkUrl', ...FIREBASE_FIELDS]) {
      if (next[field] === undefined)
        continue
      // 空值删键而不是存空串，落盘的文件才会如实反映"没填过"。
      if (next[field].trim() === '')
        delete this.stored[field]
      else
        this.stored[field] = next[field].trim()
    }
    this.save()
  }
}

/**
 * 已配对设备表。
 *
 * 这是**唯一**能做按设备吊销的地方：DSH 的会话 cookie 是无状态 HMAC，验证只查
 * 签名、authority 和有效期，没有名单可查。删掉这里的一行，那台机器下一次请求就被闸门挡住。
 */
class DeviceTable {
  constructor(entries, onChange) {
    this.entries = entries
    this.onChange = onChange
  }

  /** 按令牌找设备，同时记下最近一次活动时间。 */
  find(token, now) {
    const entry = this.entries.find(candidate => candidate.token === token)
    if (entry === undefined)
      return undefined
    entry.lastSeenAt = now
    return entry
  }

  touch(token, now) {
    const entry = this.entries.find(candidate => candidate.token === token)
    if (entry !== undefined)
      entry.lastSeenAt = now
  }

  add(device, now) {
    // 令牌是设备会话的唯一凭证，32 字节随机；不复用旧设备的令牌，
    // 否则重新配对会悄悄把已经吊销的那台又放进来。
    const token = randomBytes(32).toString('hex')
    this.entries.push({ token, device, pairedAt: now, lastSeenAt: now })
    this.onChange()
    return token
  }

  /**
   * 记下这台设备的推送令牌。
   *
   * 令牌会变（重装、恢复备份、长期不用之后 Firebase 会换新的），所以这是覆盖写而不是追加：
   * 留着旧令牌只会让服务端往一个已经失效的地址发消息，而失败是静默的。
   */
  setPushToken(device, token, now) {
    const entry = this.entries.find(candidate => candidate.device === device)
    if (entry === undefined)
      return false
    entry.pushToken = token
    entry.pushTokenAt = now
    this.onChange()
    return true
  }

  /** 有推送令牌的设备。发送时只轮到这些。 */
  withPushToken() {
    return this.entries.filter(entry => typeof entry.pushToken === 'string' && entry.pushToken !== '')
  }

  /**
   * 按设备名吊销。
   *
   * @returns 被吊销设备的令牌，或 `null`（没有这台设备）。**返回令牌而不是布尔**：
   *          调用方还要拿它断开那台设备已经建立的长连接，否则"吊销"对开着的页面不生效。
   */
  revokeByName(device) {
    const at = this.entries.findIndex(entry => entry.device === device)
    if (at === -1)
      return null
    const [removed] = this.entries.splice(at, 1)
    this.onChange()
    return typeof removed?.token === 'string' ? removed.token : null
  }

  revoke(token) {
    const at = this.entries.findIndex(entry => entry.token === token)
    if (at === -1)
      return false
    // 原地删除：调用方持有的就是同一个数组，重新赋值会让它和落盘状态脱钩。
    this.entries.splice(at, 1)
    this.onChange()
    return true
  }

  list() {
    return this.entries
  }
}

class PairingStore {
  constructor(file, ttlSeconds, logger) {
    this.file = file
    this.ttlSeconds = ttlSeconds
    this.logger = logger
    // `bakedCode` 是**已经烘进当前这个安装包**的那把钥匙。它必须单独记着：
    // 包一旦发出去（下载站、别人手机里），页面上再生成一个新码不能把它弄没，
    // 否则装包的人拿到的是一个当场就被拒的钥匙 —— 而那正是"包能装、连不上"。
    this.state = { codes: [], devices: [], bakedCode: '' }
    this.load()
    this.devices = new DeviceTable(this.state.devices, () => this.save())
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (parsed && Array.isArray(parsed.codes) && Array.isArray(parsed.devices)) {
        this.state = {
          codes: parsed.codes,
          devices: parsed.devices,
          bakedCode: typeof parsed.bakedCode === 'string' ? parsed.bakedCode : '',
        }
      }
    }
    catch (error) {
      // 首次运行没有文件，这是正常路径；只有文件真损坏时才值得留一行日志，
      // 而且两种情况都不该让插件起不来 —— 大不了从空仓库开始。
      if (error?.code !== 'ENOENT')
        this.logger.warn(`dsh-pocket-pair: pairing store unreadable, starting empty: ${error}`)
    }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.file)
  }

  /**
   * 关掉配对入口：清掉所有还没用的码。已配对的设备不受影响。
   *
   * 这是唯一会主动作废"包里那把钥匙"的动作，而且是明确的：所有者说"我不想再配了"。
   */
  closeEnrollment() {
    this.state.codes = []
    this.state.bakedCode = ''
    this.save()
  }

  /** 丢掉过期的码，让界面上永远只剩还能用的。 */
  prune(now) {
    const before = this.state.codes.length
    this.state.codes = this.state.codes.filter(entry => entry.expiresAt > now)
    return before !== this.state.codes.length
  }

  /** 页面上正在显示的那个码：最新生成的那个。 */
  newest() {
    return this.state.codes[this.state.codes.length - 1]
  }

  /** 包里那把钥匙：只有它还在有效期内才算数。 */
  baked(now) {
    return this.state.codes.find(entry => entry.code === this.state.bakedCode && entry.expiresAt > now)
  }

  /**
   * 页面上的「生成配对码」。
   *
   * 保留**已经烘进安装包**的那把钥匙，只替换其余的。这两个动作以前是互相拆台的：
   * 构建烘一把，然后点一下生成配对码就把那把删掉，于是刚下载安装的人拿到一个
   * 当场被拒的钥匙 —— 页面上显示的是一个码，包里装的是另一个，怎么试都连不上。
   * 留下的那把不会让界面变复杂（页面显示的仍然是最新生成的这个），但它让
   * "下载 → 安装 → 自己连上"在生成新码之后依然成立。
   *
   * 上限两个：包里那把 + 最新生成的那把。再多就只是白白扩大可猜中的面。
   */
  mint(now) {
    this.prune(now)
    const kept = this.state.codes.filter(entry => entry.code === this.state.bakedCode)
    const entry = {
      code: mintCode(),
      createdAt: now,
      expiresAt: now + this.ttlSeconds * 1000,
    }
    this.state.codes = [...kept, entry]
    this.save()
    return entry
  }

  /**
   * 构建要烘进包里的那把钥匙。
   *
   * 优先用页面上正在显示的那个码，这样二维码指向的安装包和页面显示的码就是同一个：
   * 扫一下装完就能连上，不需要在两个码之间猜。只有手上一个有效码都没有时才新生成。
   */
  bake(now) {
    this.prune(now)
    const entry = this.newest() ?? this.mint(now)
    this.state.bakedCode = entry.code
    this.save()
    return entry
  }

  /** 界面要显示的码。最新的在前 —— 页面显示第一个，也就是刚生成的那个。 */
  active(now) {
    this.prune(now)
    return [...this.state.codes].reverse()
  }

  /**
   * 兑现一个码：命中且未过期就把它从仓库里删掉，然后记录这台设备。
   *
   * 删除发生在写设备记录之前，所以「配对码用一次」不依赖后续步骤成功 ——
   * 中途出错也只会让 owner 重新生成一个，不会留下一个还能再用的码。
   */
  redeem(code, device, now) {
    const entry = this.state.codes.find(candidate => candidate.code === code)
    if (entry === undefined)
      return { ok: false, error: 'unknown code' }
    if (entry.expiresAt <= now) {
      this.prune(now)
      this.save()
      return { ok: false, error: 'code expired' }
    }
    this.state.codes = this.state.codes.filter(candidate => candidate !== entry)
    const token = this.devices.add(device, now)
    this.save()
    return { ok: true, token }
  }
}

/** 按来源地址限流的滑动窗口。兑现路由是公开的，没有这一层就是一个无限次猜码的接口。 */
class RedeemLimiter {
  constructor(perMinute) {
    this.perMinute = perMinute
    this.attempts = new Map()
  }

  refuse(address, now) {
    const recent = (this.attempts.get(address) ?? []).filter(at => now - at < 60_000)
    recent.push(now)
    this.attempts.set(address, recent)
    if (this.attempts.size > 512) {
      for (const [key, times] of this.attempts) {
        if (times.every(at => now - at >= 60_000))
          this.attempts.delete(key)
      }
    }
    return recent.length > this.perMinute
  }
}

/** 单次请求体上限。这个路由只收一个小 JSON，超过就没必要再读。 */
const MAX_BODY_BYTES = 4096

/**
 * 从 node 请求流里读一个有上限的 JSON 体。
 *
 * 公开路由拿到的是一手的 IncomingMessage，没有框架帮忙解析，所以要自己收字节；
 * 超限时先 resume 再放弃，否则对端会因为没人读而挂住。
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
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

/**
 * 报一下默认安装包在不在、多大、什么时候改的。
 *
 * 界面上要能一眼看出"二维码指向的包到底存不存在" —— 否则所有者会看到一个能扫的码，
 * 手机点下去才 404，而错误现场在手机上。
 */
function describeApk(dir, name) {
  try {
    const stat = statSync(join(dir, name))
    if (stat.isFile())
      return { exists: true, size: stat.size, modifiedAt: stat.mtimeMs }
  }
  catch {
    // 还没放过包，这是首次部署的正常状态。
  }
  return { exists: false }
}

/**
 * 把一条配对链接算成 SVG 二维码。
 *
 * 在宿主侧算：浏览器半侧是手写的 bundle，没有打包器，引第三方库会牵出一整条构建链，
 * 而这里只需要一段字符串。
 */
function qrFor(link) {
  return QRCode.toString(link, { type: 'svg', margin: 1, width: 240, errorCorrectionLevel: 'M' })
}

/** 判断一个字符串是不是能当 authority 用的绝对 http/https 地址。 */
function isAbsoluteHttpUrl(value) {
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== ''
  }
  catch {
    return false
  }
}

function json(payload, status = 200) {
  return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * 二维码内容。
 *
 * 扫出来的是一个能直接下载 APK 的 https 地址，配对信息挂在 fragment 上：
 * fragment 不会被发给服务器，所以码不会出现在下载站的访问日志里，
 * 而 App 一旦注册了这个地址的处理权，装完之后仍能从系统拿到整条链接。
 */
function pairingLink({ apkUrl, pairBase, code }) {
  const fragment = new URLSearchParams({ b: pairBase, c: code }).toString()
  // 安装包地址为空（比如 pairBase 也没填）时不能就此抛错：那样连配对码都生成不出来。
  // 退化成"只有配对信息"的链接，手机装了 App 一样能用，只是不能从码里下载。
  if (apkUrl === '')
    return `${pairBase.replace(/\/+$/, '')}/#${fragment}`
  const url = new URL(apkUrl)
  url.hash = fragment
  return url.href
}

export function apply(ctx, config) {
  const ttlSeconds = config?.codeTtlSeconds ?? 3600
  const settings = new DeploymentSettings(
    join(resolveDshHome(), 'dsh-pocket-pair', 'settings.json'),
    {
      pairBase: config?.pairBase ?? '',
      apkUrl: config?.apkUrl ?? '',
      apkName: config?.apkName ?? 'dsh-pocket.apk',
      // 默认值来自配置（cordis.patch.yml），页面上填的会覆盖它。
      firebaseProjectId: config?.firebaseProjectId ?? '',
      firebaseAppId: config?.firebaseAppId ?? '',
      firebaseApiKey: config?.firebaseApiKey ?? '',
      firebaseSenderId: config?.firebaseSenderId ?? '',
      notifyTopic: config?.notifyTopic ?? '',
      pushAiSummary: config?.pushAiSummary ?? false,
    },
    ctx.logger,
  )
  const apkDir = (config?.apkDir ?? '').trim() !== ''
    ? config.apkDir.trim()
    : join(resolveDshHome(), 'dsh-pocket-pair', 'apk')
  const store = new PairingStore(join(resolveDshHome(), 'dsh-pocket-pair', 'pairing.json'), ttlSeconds, ctx.logger)
  const limiter = new RedeemLimiter(config?.redeemPerMinute ?? 10)
  const lanPort = config?.lanPort ?? 8081
  const lanEnabled = config?.lanEnabled ?? true

  /**
   * 二维码和兑现结果里报给手机的局域网地址。
   *
   * 自动挑一个只是省事，不保证对：一台机器可能有多个网段，选错的那个手机连不上。
   * 所以留了配置项，让所有者能直接指定。
   */
  function advertisedAddress() {
    const configured = String(config?.lanAdvertise ?? '').trim()
    if (configured !== '')
      return configured
    const found = lanAddresses()
    return found.length > 0 ? found[0].address : ''
  }

  const lanBase = () => {
    const address = advertisedAddress()
    if (address === '')
      return null
    return `http://${hostLiteral(address)}:${lanPort}`
  }

  /**
   * 闸门起没起来，要能在界面上看见。
   *
   * 端口占用是最常见的失败，而它只会在后台日志里留一行 —— 所有者看到的是
   * 「局域网入口：未启用」，然后去猜为什么。把原因带到状态接口里。
   */
  let lanFailure = null

  if (lanEnabled && ctx.webServer?.port !== undefined) {
    const gate = createLanGate({
      devices: store.devices,
      port: lanPort,
      upstreamPort: ctx.webServer.port,
      connection: ctx.connection,
      publicPaths: [REDEEM_PATH],
      apkDir,
      apkName: config?.apkName ?? 'dsh-pocket.apk',
      onPushToken: (device, token) => {
        store.devices.setPushToken(device, token, Date.now())
        ctx.logger.info(`dsh-pocket-pair: push token registered for ${device}`)
      },
      logger: ctx.logger,
    })
    ctx.effect(() => {
      gate.start().then(
        () => ctx.logger.info(`dsh-pocket-pair: LAN gate on ${lanBase() ?? `port ${lanPort}`}`),
        (error) => {
          lanFailure = String(error?.message ?? error)
          ctx.logger.error(`dsh-pocket-pair: LAN gate failed to start: ${lanFailure}`)
        },
      )
      return () => gate.stop()
    }, 'dsh-pocket-pair: LAN gate')
  }

  const describe = entry => ({
    code: entry.code,
    expiresAt: entry.expiresAt,
    link: pairingLink({ apkUrl: settings.apkUrl, pairBase: settings.pairBase, code: entry.code }),
  })

  ctx.effect(() => ctx.connection.fetch.register({
    path: STATE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const now = Date.now()
      const codes = store.active(now)
      // 二维码也在这里算出来。刷新页面后码还在、码图却没了 —— 因为之前只有 mint 会算它，
      // 所有者会以为"码没生成"，其实只是界面少画了一张图。
      const described = await Promise.all(codes.map(async (entry) => {
        const one = describe(entry)
        return { ...one, qrSvg: await qrFor(one.link) }
      }))
      return json({
        codes: described,
        // 入口开着 ⟺ 还有没用的码。配对成功会把码删掉，所以这个字段会自动变 false。
        enrollmentOpen: codes.length > 0,
        // 已经烘进当前那个安装包里的钥匙。跟 codes[0]（页面上显示的那个）可能不是同一个：
        // 生成过新码之后就是这样，而两个都还有效 —— 装包的人用包里那个，扫码的人用显示的那个。
        // 报出来是为了这一层不再隐形：页面上显示的码和包里那把不一致时，人得看得见。
        bakedCode: (store.baked(now) ?? {}).code ?? '',
        // 设备令牌是设备会话的唯一凭证，绝不能随状态查询回到浏览器里 ——
        // 只报能认出是哪台机器的信息。
        devices: store.devices.list().map(entry => ({
          device: entry.device,
          pairedAt: entry.pairedAt,
          lastSeenAt: entry.lastSeenAt,
          // 只报"有没有"，不把令牌本身回传给浏览器。
          pushReady: typeof entry.pushToken === 'string' && entry.pushToken !== '',
        })),
        apkUrl: settings.apkUrl,
        pairBase: settings.pairBase,
        ttlSeconds,
        lanBase: lanBase(),
        lanFailure,
        storedPairBase: settings.stored.pairBase ?? '',
        storedApkUrl: settings.stored.apkUrl ?? '',
        firebaseProjectId: settings.firebaseProjectId,
        firebaseAppId: settings.firebaseAppId,
        firebaseApiKey: settings.firebaseApiKey,
        firebaseSenderId: settings.firebaseSenderId,
        apkDir,
        apkName: config?.apkName ?? 'dsh-pocket.apk',
        apkFile: describeApk(apkDir, config?.apkName ?? 'dsh-pocket.apk'),
        buildEnabled: builder !== null,
        // 页面上"将要烘进包里的值"：让使用者在点构建之前就能核对这些。
        // 和构建用的 -P 参数是同一个来源，不会因为显示的是一套、烘进去的是另一套而分叉。
        bakePreview: {
          pairBase: settings.pairBase,
          firebaseProjectId: settings.firebaseProjectId,
          firebaseAppId: settings.firebaseAppId,
          firebaseApiKey: settings.firebaseApiKey,
          firebaseSenderId: settings.firebaseSenderId,
        },
        pushConfigured: (config?.fcmServiceAccountFile ?? '').trim() !== '',
        pushAiSummary: settings.pushAiSummary,
        pushTrace: {
          ...trace,
          // 直接摊开两个 Map 的 key：只要和 lastAgentId 对不上，"取不到正文"就是
          // 一目了然的事，不用再从行为反推。
          lastSaidKeys: [...lastSaid.keys()].map(String),
          turnKeys: [...turnLog.keys()].map(String),
        },
        pushProxy: (config?.fcmProxy ?? '').trim(),
        pushFailed: senderFailed,
        pushReady: store.devices.withPushToken().length,
        build: builder === null ? null : builder.snapshot(),
      })
    },
  }), 'dsh-pocket-pair: GET state')

  // 构建功能默认关闭，而且工程目录没配就不启用。
  // 它不是一个通用能力：它会在一个本机目录里跑 Gradle，也就是执行那个目录里的构建脚本。
  // 只有自己搭这套东西的人才该打开它，所以默认值必须是"关"而不是"开"。
  const buildProjectDir = (config?.buildProjectDir ?? '').trim()
  /**
   * 推送发送器。懒建：没有配服务账号就完全不碰文件系统。
   *
   * 两台机器之间必须说清楚的一件事：**令牌是设备给的，密钥是我们的**。
   * 设备令牌存在设备表里（`pushToken`），服务账号只在服务端。
   */
  let sender = null
  let senderFailed = ''
  function fcmSender() {
    if (sender !== null)
      return sender
    const file = (config?.fcmServiceAccountFile ?? '').trim()
    if (file === '')
      return null
    try {
      sender = createFcmSender({ serviceAccountFile: file, proxyUrl: (config?.fcmProxy ?? '').trim(), logger: ctx.logger })
      senderFailed = ''
    }
    catch (error) {
      senderFailed = String(error.message ?? error)
      ctx.logger.error(`dsh-pocket-pair: 服务账号读不了：${senderFailed}`)
      return null
    }
    return sender
  }

  /**
   * 每个会话最近一条助手消息的开头，用来当推送正文。
   *
   * 只说"任务完成了"没什么用 —— 手机响的时候人往往不在电脑前，正文里那一句才是要不要
   * 现在过去看的关键。
   */
  const lastSaid = new Map()

  /**
   * 排查用的计数器，以及"最近几次推送到底推了什么"。
   *
   * 加这个是因为一件查不动的事：所有者收到的一直是兜底文案，也就是"这一轮最后一条助手
   * 消息"没取到 —— 但按类型签名，`session/event` 给的 `session.id` 和 `agent/status`
   * 给的 `agent.id` 都该是同一个 `SessionId`。日志指望不上（`ctx.logger.info` 根本不进
   * journal），所以把事实记在这里，从状态接口读。
   *
   * 计数刻意发生在**所有早退之前**：如果只在真正推送时记，那就正好漏掉"为什么没推"。
   */
  const trace = {
    sessionEvents: {},
    agentStatus: { running: 0, idle: 0 },
    lastSessionId: '',
    lastAgentId: '',
    bareStatus: 0,
    pushes: [],
    sent: 0,
    skipped: '',
  }
  function bump(bag, key) {
    bag[key] = (bag[key] ?? 0) + 1
  }

  /**
   * 推送记录落盘。
   *
   * 这不是调试脚手架，是留证据：手机响的时候人不在电脑前，回头想问"这条通知是哪来的、
   * 正文为什么是这个"，没有记录就只能猜。文件有上限，不会无限长。
   */
  const pushLogFile = join(resolveDshHome(), 'dsh-pocket-pair', 'push.log')
  function recordPush(entry) {
    trace.pushes.push(entry)
    while (trace.pushes.length > 20)
      trace.pushes.shift()
    try {
      mkdirSync(dirname(pushLogFile), { recursive: true })
      if (existsSync(pushLogFile) && statSync(pushLogFile).size > 64 * 1024) {
        const kept = readFileSync(pushLogFile, 'utf8').split('\n').slice(-100).join('\n')
        writeFileSync(pushLogFile, kept, { mode: 0o600 })
      }
      const line = [
        new Date(entry.at).toISOString(),
        `agent=${entry.agentId}`,
        `来源=${entry.source}`,
        `设备=${entry.devices}`,
        entry.summaryReason === undefined ? '' : `摘要失败=${entry.summaryReason}`,
        `正文=${String(entry.body).replace(/\s+/g, ' ').slice(0, 100)}`,
      ].filter(part => part !== '').join(' | ')
      appendFileSync(pushLogFile, `${line}\n`, { mode: 0o600 })
    }
    catch {
      // 记不下来不该影响推送本身 —— 这是"顺手留证据"，不是推送的前置条件。
    }
  }

  /**
   * 当前这一轮里助手说过的原文，按会话累积。
   *
   * 和 `lastSaid` 存的不是一回事：那个是**兜底正文**（压成一行、140 字），这个是给模型
   * 看的**原材料**（保留段落结构，模型才看得出结论在哪）。只留最近几条 —— 一轮里
   * 助手可能说十几次话，全留着既浪费上下文也淹没了结论。
   */
  const turnLog = new Map()
  const TURN_LOG_ENTRIES = 6

  /**
   * 从事件里取出助手正文。
   *
   * **载荷在 `event.data` 里，不在 `event` 上。** `SessionEvent` 是个信封：
   * `{ type, seq, time, data: SessionEventMap[type], ... }` —— 只有 `type` 在外层，
   * `assistant/message` 的 `message`/`turn`/`step` 都在 `data` 下面。
   *
   * 这一点值一条注释：写成 `event.message` 不会报错，只会永远拿到 `undefined`，
   * 表现成"推送正文一直是兜底那句"。这里踩过，所以写清楚。
   */
  function assistantTextOf(event) {
    const content = event?.data?.message?.content
    if (typeof content === 'string')
      return content
    if (!Array.isArray(content))
      return ''
    return content.filter(part => part?.type === 'text').map(part => part.text).join('')
  }

  ctx.on('session/event', (session, event) => {
    bump(trace.sessionEvents, String(event?.type ?? 'undefined'))
    trace.lastSessionId = String(session?.id ?? '')
    if (event?.type !== 'assistant/message')
      return
    const text = assistantTextOf(event)
    // 留最近一次看到的正文：判断"插件到底有没有拿到助手说的话"就看它，一眼的事。
    trace.lastAssistantText = text.slice(0, 200)
    const trimmed = text.replace(/\s+/g, ' ').trim()
    if (trimmed !== '')
      lastSaid.set(session.id, trimmed.slice(0, 140))
    const raw = text.trim()
    if (raw === '')
      return
    const log = turnLog.get(session.id) ?? []
    // 单条也截断：一条就能有几千字，塞满后后面的段落反而进不来。
    log.push(raw.slice(0, 2000))
    while (log.length > TURN_LOG_ENTRIES)
      log.shift()
    turnLog.set(session.id, log)
  })

  /**
   * 摘要器只在宿主真的提供了 llm 和 agentDefaultModel 时才建起来。
   *
   * 这两个**不能**写进模块顶层的 `inject` 数组。那个数组是"必需依赖"，写进去就意味着
   * 在没有模型服务的 harness 上**整个插件都不会加载** —— 配对、闸门、APK 分发全都跟着
   * 一起没了。摘要只是可选增强，不该有这种牵连。
   *
   * cordis 访问未注入的服务会直接抛 "cannot get property ... without inject"（不是返回
   * undefined），所以这里也不能用 try/catch 去"摸一下"。
   *
   * `ctx.inject(deps, cb)` 才是"服务就绪时装配"的写法：回调没跑，就说明这台机器没有
   * 可用的模型，下面所有用到摘要的地方都按"没这个能力"处理。
   */
  let summarizer = null
  ctx.inject(['llm', 'agentDefaultModel'], (llmCtx) => {
    summarizer = createPushSummarizer({
      ctx: llmCtx,
      logger: ctx.logger,
      timeoutMs: config?.pushAiTimeoutMs ?? 15000,
    })
  })

  /**
   * 一轮跑完就推一条。
   *
   * `agent/status` 从 running 变 idle 就是"这一轮结束了"。只认这个方向：idle → running 是
   * 开始，推它没有意义。
   */
  const busy = new Set()
  ctx.on('agent/status', ({ agent, status }) => {
    bump(trace.agentStatus, status)
    trace.lastAgentId = String(agent?.id ?? '')
    if (status === 'running') {
      busy.add(agent.id)
      turnLog.set(agent.id, [])
      return
    }
    // 没登记过 running 的 idle：一轮的开始没看见（插件是在这一轮中途加载的，或者
    // 状态抖动）。这种情况没有正文可用，记下来，否则表现成"收到一句莫名其妙的兜底"。
    if (!busy.delete(agent.id)) {
      trace.bareStatus += 1
      return
    }
    // 先把这一轮的正文取走并清掉：留着既占内存，也会让下一轮串上这一轮的话。
    const turn = (turnLog.get(agent.id) ?? []).join('\n\n')
    turnLog.delete(agent.id)
    const last = lastSaid.get(agent.id) ?? ''
    const fallback = last !== '' ? last : '这一轮已经结束，回到电脑前看看结果吧。'

    const push = fcmSender()
    if (push === null || (config?.pushEnabled ?? true) === false) {
      trace.skipped = push === null ? '没有推送发送器' : '推送被配置关掉了'
      return
    }
    const targets = store.devices.withPushToken()
    if (targets.length === 0) {
      trace.skipped = '没有登记令牌的设备'
      return
    }
    void (async () => {
      /**
       * 正文：开了开关就请模型压一句，**失败一律退回原文**。
       *
       * 这个兜底不是客气话。推送是这个插件唯一"必须送达"的东西，而模型调用会因为
       * 没配模型、超时、限流、返回空而失败 —— 任何一条都不该让手机收到通知。
       */
      let body = fallback
      let source = last !== '' ? '最后一条回复' : '兜底'
      let summaryReason
      if (settings.pushAiSummary && summarizer !== null) {
        const summary = await summarizer.describe(turn)
        if (summary.ok) {
          body = summary.text
          source = 'AI'
        }
        else {
          summaryReason = summary.reason
        }
      }
      else if (settings.pushAiSummary) {
        summaryReason = 'no-llm'
      }
      recordPush({
        at: Date.now(),
        agentId: String(agent.id),
        source,
        devices: targets.length,
        summaryReason,
        // 正文长度和"这一轮攒到多少原材料"是判断问题出在哪一步的关键：
        // turn 为空 = 收事件那步没成；turn 有内容却用了兜底 = 找正文那步没对上。
        turnChars: turn.length,
        body,
      })
      for (const device of targets) {
        const failure = await push.sendToToken(device.pushToken, {
          title: config?.pushTitle ?? 'DSH 任务完成',
          body,
          data: { sessionId: agent.id },
        })
        if (failure === null) {
          trace.sent += 1
          continue
        }
        ctx.logger.warn(`dsh-pocket-pair: 推送 ${device.device} 失败：${failure}`)
        // 令牌失效（重装、长期不用）是常见的。留着它只会让以后每条都白跑一次。
        if (failure.includes('NOT_FOUND') || failure.includes('INVALID_ARGUMENT') || failure.includes('UNREGISTERED'))
          store.devices.setPushToken(device.device, '', Date.now())
      }
    })()
  })

  const builder = (config?.buildEnabled ?? false) && buildProjectDir !== ''
    ? createBuilder({
        projectDir: buildProjectDir,
        outputApk: join(buildProjectDir, config?.buildOutputApk ?? 'app/build/outputs/apk/release/app-release.apk'),
        targetApk: join(apkDir, config?.apkName ?? 'dsh-pocket.apk'),
        gradle: ['./gradlew', ':app:assembleRelease', '--console=plain'],
        logger: ctx.logger,
        // 发布之后核对产物里有没有这些值。传函数而不是值：构建要几分钟，
        // 期间配置可能被改；这一读发生在发布那一刻才是准的。
        expectedBakedValues: () => ({
          pairBase: settings.pairBase,
          firebaseProjectId: settings.firebaseProjectId,
        }),
      })
    : null

  /**
   * 触发一次构建并发布。
   *
   * 挂在这个位置（/api 通道）而不是闸门：闸门是公开的，而这个入口会让请求去跑构建脚本。
   * 返回是"是否已启动"而不是"构建结果" —— 构建要几分钟，等它做完再回响应会让前端超时。
   * 进度从状态接口里读。
   */
  ctx.effect(() => ctx.connection.fetch.register({
    path: BUILD_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      if (builder === null)
        return json({ error: 'build is disabled in this profile' }, 409)
      // 构建的时候顺手开一个配对窗口，并把地址和这把一次性钥匙打进包里。
      // 于是"装完打开就连上"成立：App 首次启动拿它兑现一次，换到自己的设备令牌，
      // 这把钥匙当场作废 —— 包公开下载也不会被第二个人用上。
      const buildArgs = []
      let bakedKey = null
      if (settings.pairBase !== '') {
        bakedKey = store.bake(Date.now()).code
        buildArgs.push(`-PpairBase=${settings.pairBase}`, `-PpairKey=${bakedKey}`)
      }
      // Firebase 的客户端配置也一并注入。这几个值是公开的（每个 Firebase App 里都有），
      // 注入是为了让仓库里不放任何人的配置 —— 插件才能给别人用。
      for (const [property, value] of [
        ['firebaseProjectId', settings.firebaseProjectId],
        ['firebaseAppId', settings.firebaseAppId],
        ['firebaseApiKey', settings.firebaseApiKey],
        ['firebaseSenderId', settings.firebaseSenderId],
        ['notifyTopic', settings.notifyTopic],
      ]) {
        if (value !== '')
          buildArgs.push(`-P${property}=${value}`)
      }
      const outcome = builder.start({ args: buildArgs })
      if (!outcome.started)
        return json({ error: outcome.reason }, 409)
      return json({ ok: true, build: builder.snapshot(), bakedKey })
    },
  }), 'dsh-pocket-pair: POST build')

  /**
   * 主动关掉配对入口。
   *
   * 配对成功本来就会自动关（码被删掉），所以这个接口是给"反悔了"用的：
   * 生成了码又不想配了，点一下就作废，不用等它过期。
   */
  ctx.effect(() => ctx.connection.fetch.register({
    path: CLOSE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      store.closeEnrollment()
      return json({ ok: true, codes: [] })
    },
  }), 'dsh-pocket-pair: POST close')

  /**
   * 所有者保存域名和安装包地址。
   *
   * 只接受 http/https 的绝对地址：这两个值会被拼进二维码、也会被拿去当作放行 URL 的
   * authority，填错了就会让手机连到一个不存在的地方，而错误现场在手机上。
   * 空串表示"改回配置默认"，所以它也是合法输入。
   */
  ctx.effect(() => ctx.connection.fetch.register({
    path: SETTINGS_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await request.json().catch(() => undefined)
      if (body === undefined || typeof body !== 'object')
        return json({ error: 'body must be a JSON object' }, 400)
      const next = {}
      for (const field of ['pairBase', 'apkUrl', ...FIREBASE_FIELDS]) {
        if (body[field] === undefined)
          continue
        if (FIREBASE_FIELDS.includes(field)) {
          // Firebase 的值不是 URL，只做长度限制，避免把整个文件塞进来。
          next[field] = String(body[field]).trim().slice(0, 200)
          continue
        }
        if (typeof body[field] !== 'string')
          return json({ error: `${field} must be a string` }, 400)
        const value = body[field].trim()
        if (value !== '' && !isAbsoluteHttpUrl(value))
          return json({ error: `${field} must be an absolute http or https URL` }, 400)
        next[field] = value
      }
      // 布尔单独走：它既不是 URL 也不是字符串，"空串=改回默认"那套不适用。
      if (body.pushAiSummary !== undefined) {
        if (typeof body.pushAiSummary !== 'boolean')
          return json({ error: 'pushAiSummary must be a boolean' }, 400)
        settings.pushAiSummary = body.pushAiSummary
      }
      settings.update(next)
      // 同步到构建配置：页面改的值，构建（无论插件还是手动）都该用同一份。
      syncToBuildProperties(settings, builder === null ? '' : buildProjectDir)
      return json({
        ok: true,
        pairBase: settings.pairBase,
        apkUrl: settings.apkUrl,
        pushAiSummary: settings.pushAiSummary,
        storedPairBase: settings.stored.pairBase ?? '',
        storedApkUrl: settings.stored.apkUrl ?? '',
      })
    },
  }), 'dsh-pocket-pair: POST settings')

  /**
   * 试生成一条推送正文。
   *
   * 存在的理由是"开关打开之后到底会推什么"在按下开关的那一刻是不可见的 —— 要等到
   * 下一轮任务跑完才知道，而那时候人可能已经不在电脑前了。这个接口让所有者拿一段文本
   * 当场试一次。
   *
   * 它挂在受鉴权的 /api 通道上（会花掉一次模型调用，不该让未登录的人碰），并且**不落盘**：
   * 输入是请求体给的，输出直接回给调用者，不进任何日志。
   */
  ctx.effect(() => ctx.connection.fetch.register({
    path: SUMMARIZE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await request.json().catch(() => undefined)
      if (body === undefined || typeof body !== 'object')
        return json({ error: 'body must be a JSON object' }, 400)
      const text = typeof body.text === 'string' ? body.text : ''
      if (text.trim() === '')
        return json({ error: 'text is required' }, 400)
      // 503 而不是 500：这不是请求写错了，是这台机器没有能用的模型。
      if (summarizer === null)
        return json({ ok: false, reason: 'no-llm', message: '这台机器没有可用的模型服务' }, 503)
      const summary = await summarizer.describe(text.slice(0, 8000))
      if (!summary.ok)
        return json({ ok: false, reason: summary.reason, message: summary.message }, 502)
      return json({ ok: true, text: summary.text, provider: summary.provider, model: summary.model })
    },
  }), 'dsh-pocket-pair: POST summarize')

  // 吊销只能在闸门这一层做，所以这个接口是它唯一的入口。
  ctx.effect(() => ctx.connection.fetch.register({
    path: REVOKE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      // 按设备名吊销，不按令牌：状态查询刻意不回传令牌，浏览器拿不到它。
      // 设备名是安装时生成的 `dsh-xxxxxxxx`，一台一次配对，足够定位。
      const body = await request.json().catch(() => undefined)
      const device = typeof body?.device === 'string' ? body.device : ''
      if (device === '')
        return json({ error: 'device is required' }, 400)
      const revoked = store.devices.revokeByName(device)
      if (revoked === null)
        return json({ error: 'unknown device' }, 404)
      // 吊销只挡住"下一次请求"，而已经握过手的 WebSocket 不会再有下一次请求 ——
      // 页面还开着的话控制台会一直连着。所以这里主动断开，让界面上的"已吊销"名副其实。
      const closed = gate.disconnect(revoked)
      return json({ ok: true, connectionsClosed: closed })
    },
  }), 'dsh-pocket-pair: POST revoke')

  ctx.effect(() => ctx.connection.fetch.register({
    path: MINT_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      // 没填地址就不出码：二维码里没有可连的地址时，手机扫出来的东西毫无意义，
      // 而错误现场在手机上、很难查。宁可在这里挡住并说清楚该去哪儿填。
      if (settings.pairBase === '')
        return json({ error: '先在下面填一个「二维码里告诉手机该连哪个地址」，再生成配对码。' }, 409)

      const entry = store.mint(Date.now())
      const described = describe(entry)
      const qrSvg = await QRCode.toString(described.link, {
        type: 'svg',
        margin: 1,
        width: 240,
        errorCorrectionLevel: 'M',
      })
      // 把和状态接口同一组部署信息一并带上：前端 mint 之后会用这个返回值覆盖本地状态，
      // 少一个字段就会把那一条显示清空（曾经 lanBase 就是这么丢的）。
      return json({ ...described, qrSvg, apkUrl: settings.apkUrl, pairBase: settings.pairBase, ttlSeconds, lanBase: lanBase(), lanFailure })
    },
  }), 'dsh-pocket-pair: POST mint')

  // 公开路由。DSH 的 Connection 只保护首页和 /api 前缀，挂在这里的路径没有任何鉴权，
  // 所以下面的限流 + 单次码是这条路唯一的防线。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REDEEM_PATH,
    handler: async (req, res) => {
      const send = (status, payload) => {
        const body = JSON.stringify(payload)
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        })
        res.end(body)
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }

      const address = req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? 'unknown'
      if (limiter.refuse(String(address), Date.now())) {
        send(429, { error: 'too many attempts' })
        return
      }

      const body = await readJsonBody(req)
      const code = typeof body?.code === 'string' ? body.code.trim() : ''
      const device = typeof body?.device === 'string' ? body.device.slice(0, 64) : ''

      /**
       * 配对码是**唯一**的凭证，没有它一律不放行。
       *
       * 这里曾经有一条"窗口开着就免码放行"的分支，理由是"包里烘的一次性钥匙会因为服务端
       * 重新生成而失效，不如把窗口本身当凭证"。那是错的：**窗口开着不是秘密**。入口是公网
       * 可达的，任何人在窗口期内 POST 一个空码就能拿到设备令牌和进入控制台的 URL ——
       * 8 位随机码、一次性、限流，一个都没起作用。
       *
       * 实际的安全性来自"钥匙是随机的且只有拿到它的那一方能出示"：二维码把码放在 URL
       * fragment 里（fragment 不发给服务器），构建时烘进包里的那把也是**随机码**。
       * 两者都不需要免码通道。
       */
      if (code === '') {
        send(403, { error: 'pairing code required' })
        return
      }

      const outcome = store.redeem(code, device, Date.now())
      if (!outcome.ok) {
        send(403, {
          error: outcome.error === 'unknown code'
            ? '配对入口没开，或者那个码已经用过了。去 harness 的「设置 → 手机配对」里点一下生成/构建，再试。'
            : outcome.error,
        })
        return
      }

      // 放行 URL 由 Connection 拼：它带的是本次进程的启动令牌，浏览器打开一次就换成
      // 会话 cookie。插件拿不到也造不出那个 cookie，这是 DSH 给的唯一合规入口。
      // 放行 URL 的 authority 必须和手机实际用的 authority 一致，否则 DSH 种下的
      // cookie 绑的是另一个 authority，手机带着它回来仍然通不过校验。
      // 只回令牌，不回拼好的地址：手机该继续用**它自己配对时用的那个地址**。
      // 插件不知道手机是从公网还是局域网过来的（Host 头能看出来，但那要依赖反代
      // 老实转发），而手机自己一定知道 —— 让知道的一方去拼，比在这里猜可靠。
      send(200, {
        ok: true,
        token: outcome.token,
        // 直连那条路（不进闸门）仍然给一个现成的入场 URL，留着不用也没关系。
        url: ctx.connection.authenticatedUrl(`${settings.pairBase}/`),
      })
    },
  }), 'dsh-pocket-pair: POST redeem')
}
