/**
 * 构建并发布安装包。
 *
 * 这个模块让「设置 → 手机配对」页面上的一次点击，走完平时要在命令行做的几步：
 * 跑 Gradle release 构建、把产物拷进插件自己的安装包目录、读出它的版本号。
 * 之后二维码就会指向新包 —— 不需要重启 harness，也不需要碰 VPS。
 *
 * 两件必须记住的事：
 *
 * 1. 这是一个**能执行任意构建脚本**的入口（Gradle 构建就是跑代码）。所以它只能挂在
 *    受鉴权的 /api 通道上，绝不能像兑现路由那样公开。
 * 2. 同时只允许一个构建。Gradle 并发写同一个 build 目录会互相踩，
 *    而且那种失败看起来像"随机报错"，最难查。
 *
 * 输出保留成有上限的环形缓冲：构建几分钟里会打几百行，界面只需要最后几行看进度或看报错。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { apkContains } from './apk-probe.js'

/** 环形缓冲保留的行数。够看报错尾部，又不至于把状态接口撑大。 */
const TAIL_LINES = 120

/** 单次构建的上限。Gradle release 构建在这台机器上约两分钟，给足余量后强杀。 */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000

export function createBuilder({
  expectedPairBase = () => '', projectDir, outputApk, targetApk, gradle, timeoutMs = DEFAULT_TIMEOUT_MS, logger }) {
  let running = false
  let startedAt = 0
  let finishedAt = 0
  let ok = null
  let failure = ''
  let version = null
  const tail = []

  function record(line) {
    for (const part of String(line).split('\n')) {
      const text = part.trimEnd()
      if (text === '')
        continue
      tail.push(text)
      if (tail.length > TAIL_LINES)
        tail.shift()
    }
  }

  function snapshot() {
    return { running, startedAt, finishedAt, ok, failure, version, tail: [...tail] }
  }

  /**
   * 从产物旁边读出版本号。
   *
   * Android Gradle Plugin 自己会写一份 `output-metadata.json`，直接读它就行 ——
   * 不需要 aapt2，也就不需要猜 Android SDK 装在哪。读不到不该让构建算失败：
   * 包已经出来了，只是界面上少显示一行。
   */
  function readVersion() {
    try {
      const metadata = JSON.parse(readFileSync(join(dirname(outputApk), 'output-metadata.json'), 'utf8'))
      const element = metadata?.elements?.[0]
      if (typeof element?.versionCode !== 'number')
        return null
      return { code: element.versionCode, name: String(element.versionName ?? '') }
    }
    catch {
      return null
    }
  }

  /**
   * 命令行里不允许进日志的参数。
   *
   * 构建时会把一把一次性配对钥匙通过 `-PpairKey=` 传进来，而完整命令行是要记进构建日志的
   * —— 那个日志会显示在页面上，也就会出现在截图、粘贴、issue 里。钥匙虽然一次性，但"一次性"
   * 只有在它还没被用掉时才有意义：日志比手机先到，钥匙就废了。
   *
   * 只盖值不盖开关：看日志的人需要知道"传了钥匙"，不需要知道钥匙是什么。
   */
  const SECRET_FLAGS = ['pairKey']

  function redactCommand(argv) {
    return argv.map((part) => {
      const eq = part.indexOf('=')
      if (eq <= 0)
        return part
      const flag = part.slice(0, eq)
      return SECRET_FLAGS.includes(flag.replace(/^-P/, '')) ? `${flag}=***` : part
    })
  }

  /**
   * 启动一次构建，**立刻**返回。
   *
   * 不能在响应里等构建结束：一次 release 构建是分钟级的，HTTP 请求早就超时了，
   * 而且前端也就没法显示进度。所以这里只负责把进程拉起来，进度由 snapshot() 提供，
   * 前端轮询状态接口。
   */
  function start({ args = [] }) {
    if (running)
      return { started: false, reason: 'a build is already running' }

    try {
      copyFileSync(targetApk, `${targetApk}.previous`)
    }
    catch {
      // 第一次构建没有上一份产物，这是正常的。
    }

    running = true
    startedAt = Date.now()
    finishedAt = 0
    ok = null
    failure = ''
    version = null
    tail.length = 0
    const command = [...gradle.slice(1), ...args]
    record(`$ ${gradle[0]} ${redactCommand(command).join(' ')}`)

    const child = spawn(gradle[0], command, { cwd: projectDir })
    const timer = setTimeout(() => {
      record(`--- 超过 ${Math.round(timeoutMs / 60000)} 分钟，已强杀 ---`)
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', chunk => record(chunk))
    child.stderr.on('data', chunk => record(chunk))

    child.on('error', (error) => {
      clearTimeout(timer)
      running = false
      finishedAt = Date.now()
      ok = false
      failure = `无法启动构建：${error.message}`
      record(failure)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      void (async () => {
        if (code !== 0) {
          running = false
          finishedAt = Date.now()
          ok = false
          failure = `构建失败，退出码 ${code}`
          record(failure)
          return
        }
        // 发布之前先核对**产物本身**，而不是命令行。
        //
        // Gradle 的构建目录是共享的（多个 profile 可以指向同一个安卓工程），产物也可能被
        // 另一个进程先写一遍。于是"我传的参数是对的"推不出"这个 APK 里的值是对的" ——
        // 曾经照命令行判断，把一个指向测试地址的包发布了出去，手机装完怎么都连不上。
        const expected = expectedPairBase()
        if (expected !== '' && !apkContains(outputApk, expected)) {
          running = false
          finishedAt = Date.now()
          ok = false
          failure = `产物里没有当前配置的地址（${expected}），拒绝发布。`
            + '多半是构建目录被别的实例或上一次构建写过了 —— 清掉 app/build 再构建一次。'
          record(failure)
          logger.warn(`dsh-pocket-pair: ${failure}`)
          return
        }
        try {
          mkdirSync(dirname(targetApk), { recursive: true })
          copyFileSync(outputApk, targetApk)
          record(`已发布：${targetApk}（${statSync(targetApk).size} 字节）`)
        }
        catch (error) {
          running = false
          finishedAt = Date.now()
          ok = false
          failure = `构建成功但发布失败：${error.message}`
          record(failure)
          return
        }
        version = readVersion()
        if (version !== null)
          record(`版本：${version.name}（versionCode ${version.code}）`)
        running = false
        finishedAt = Date.now()
        ok = true
        logger.info(`dsh-pocket-pair: build published${version === null ? '' : ` as ${version.name}`}`)
      })()
    })

    return { started: true }
  }

  return { start, snapshot }
}
