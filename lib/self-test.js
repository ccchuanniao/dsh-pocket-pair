/**
 * 替一台手机，把"用这个包连上这个部署"这条路真的走一遍。
 *
 * 拆包只能证明**包里写了什么**，证明不了**这样能不能连上**。真正决定成败的还有一长串：
 * 二维码里那个地址解不解析、TLS 通不通、反代在不在、闸门起没起、harness 活着没有、
 * 这把钥匙服务端认不认、换回来的令牌能不能换开控制台。任何一环断了，包在手机里就是
 * 一个"连不上"的包 —— 而这个结论只有拿手机的人看得到，发链接的人看不到。
 *
 * 所以这里按手机的做法走一遍：
 *   1. 拿包里烘的地址和钥匙去兑现一次（公开地址，不是本机回环，走的就是手机会走的那条路）
 *   2. 拿换回来的令牌去换开控制台首页
 * 两步都过了，才说这个包"能连上"。
 *
 * 只回答"此刻行不行"。它不保证明天还通 —— 那取决于服务器和网络，不取决于包。
 */
export function createConnectionProbe({ timeoutMs = 20_000 } = {}) {
  /**
   * @param pairBase 包里烘的那个地址（不是配置里的默认值，是**烘进去**的那个）。
   * @param key 包里烘的那把钥匙。
   * @returns `{ ok, reason, address, device }`。`device` 是这次探测登记出来的设备名，
   *          调用方应当立刻吊销它 —— 否则每构建一次，设备列表里就多一台幽灵。
   */
  async function probe({ pairBase, key }) {
    const base = String(pairBase ?? '').replace(/\/+$/, '')
    if (base === '' || typeof key !== 'string' || key === '')
      return { ok: false, reason: '这个包里没有地址或没有钥匙', address: base, device: '' }

    const device = `connect-probe-${Math.random().toString(36).slice(2, 8)}`
    const signal = AbortSignal.timeout(timeoutMs)

    try {
      const redeem = await fetch(`${base}/dsh-pocket-pair/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: key, device }),
        signal,
      })
      const payload = await redeem.json().catch(() => undefined)
      if (!redeem.ok)
        return { ok: false, reason: `兑现被拒（HTTP ${redeem.status}）：${payload?.error ?? '没有说明'}`, address: base, device: '' }
      const token = typeof payload?.token === 'string' ? payload.token : ''
      if (token === '')
        return { ok: false, reason: '兑现成功，但服务端没有回设备令牌', address: base, device: '' }

      // 拿到令牌不等于能进页面。手机接下来做的是"带着这个令牌去取控制台"，
      // 这里照做：先让它把设备 cookie 种下，再用那个 cookie 取一次首页。
      const admitted = await fetch(`${base}/?device=${encodeURIComponent(token)}`, {
        redirect: 'manual',
        signal,
      })
      const deviceCookie = (admitted.headers.getSetCookie?.() ?? [])
        .map(value => value.split(';')[0])
        .find(value => value.startsWith('dsh-pocket-pair='))

      const page = await fetch(`${base}/`, {
        headers: deviceCookie === undefined ? {} : { cookie: deviceCookie },
        redirect: 'manual',
        signal,
      })
      if (page.status !== 200)
        return { ok: false, reason: `拿着令牌取不到控制台（HTTP ${page.status}）`, address: base, device }

      return { ok: true, reason: '', address: base, device }
    }
    catch (error) {
      const code = error?.cause?.code ?? error?.code
      const reason = (error?.name === 'TimeoutError' || error?.name === 'AbortError')
        ? `连不上 ${base}（${Math.round(timeoutMs / 1000)} 秒内没有回应）`
        : `连不上 ${base}：${code ?? error?.message ?? error}`
      return { ok: false, reason, address: base, device: '' }
    }
  }

  return { probe }
}
