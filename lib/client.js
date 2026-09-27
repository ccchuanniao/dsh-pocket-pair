/**
 * dsh-pocket-pair 浏览器半侧。
 *
 * 宿主把本文件当一个 bundle 载入，执行它只会注册一个 factory。
 *
 * 只做一件事：在「设置」里多一页，让所有者点一下拿到配对码和二维码。
 * 所有状态都在宿主侧（配对码仓库在宿主进程里），这里只负责显示和触发，
 * 所以刷新页面不会丢码，也不会出现两个标签页各有各的码。
 *
 * 两个请求都走 /api 前缀，因此 Connection 的 Host 栅栏和浏览器会话 cookie
 * 会先过一遍 —— 没有登录的调用拿不到码。插件不自己发明鉴权。
 */
window.__ModuleLoader__.load({
  id: 'dsh-pocket-pair',
  // factory 的签名就是 (require) => moduleExports，loader 直接把 require 传进来。
  // 多包一层箭头函数会让 loader 拿到一个函数而不是模块对象。
  factory: (require) => {
    const { useCallback, useEffect, useRef, useState } = require('react')
    const { jsx: h } = require('react/jsx-runtime')

    const STATE_URL = '/api/pocket-pair/state'
    const MINT_URL = '/api/pocket-pair/mint'
    const REVOKE_URL = '/api/pocket-pair/revoke'
    const SETTINGS_URL = '/api/pocket-pair/settings'
    const BUILD_URL = '/api/pocket-pair/build'
    const CLOSE_URL = '/api/pocket-pair/close'
    const RESET_URL = '/api/pocket-pair/reset'
    const SUMMARIZE_URL = '/api/pocket-pair/summarize'
    const SPLASH_URL = '/dsh-pocket-pair/splash'

    // 「试一句」用的示例文本。刻意写成一段真实的工作汇报，而不是"你好"——
    // 试的是"摘要出来像不像一条通知"，随便一句测不出这件事。
    const AI_PROBE_SAMPLE = '我修好了推送注册的 401 问题。原因是注册请求没带上设备凭据，'
      + '改成在请求头里发 X-Dsh-Device-Token，并让闸门也认这个头。重启服务后从 401 变成 200，'
      + '手机已经能收到推送了。改动文件：PushRegistration.kt、lib/lan-gate.js。'

    /** Setup steps live in AGENTS.md; this prompt contains no deployment values. */
    function agentPrompt() {
      return [
        '帮我把 DSH Pocket 手机连接配置好，并尽量配好任务完成通知。',
        '',
        '请先定位这台机器上 dsh-pocket-pair 插件安装目录里的 AGENTS.md，读完后按手册执行。',
        '能检查和填写的配置请你直接完成，不要让我手抄机器上已有的信息。',
        '缺少账号或远程入口时，按手册给我可选方案和具体下一步；需要我登录或操作手机时再告诉我。',
        '最后说明手机在哪些网络能用、通知是否实测收到，以及还需要我做什么。',
      ].join('\n')
    }

    async function readJson(response) {
      try {
        return await response.json()
      }
      catch {
        return undefined
      }
    }

    /** 一句话说清构建现在是什么状态，别让所有者去猜。 */
    function buildSummary(build) {
      if (!build || (build.running !== true && build.finishedAt === 0))
        return ''
      if (build.running)
        return `构建中…（自 ${new Date(build.startedAt).toLocaleTimeString()} 起，约需几分钟）`
      if (build.ok === false)
        return `失败：${build.failure}`
      const seconds = Math.round((build.finishedAt - build.startedAt) / 1000)
      const version = build.version ? `${build.version.name}（${build.version.code}）` : '版本未知'
      return `已完成：${version}，耗时 ${seconds} 秒。重新生成配对码即可拿到指向新包的二维码。`
    }

    function remaining(expiresAt, now) {
      const seconds = Math.max(0, Math.round((expiresAt - now) / 1000))
      if (seconds === 0)
        return '已过期'
      if (seconds < 60)
        return `${seconds} 秒后过期`
      return `${Math.round(seconds / 60)} 分钟后过期`
    }

    function PairPanel() {
      const [state, setState] = useState(null)
      const [failure, setFailure] = useState('')
      const [busy, setBusy] = useState(false)
      const [now, setNow] = useState(() => Date.now())
      // 域名和安装包地址由所有者填。草稿单独放，只有点保存才写回宿主，
      // 这样打字打到一半不会把二维码里的地址改成半截。
      const [draftBase, setDraftBase] = useState('')
      // Firebase 的四个客户端值。都是公开值，不是密钥 —— 真正的密钥是服务账号，只在服务端。
      const [firebase, setFirebase] = useState({ projectId: '', appId: '', apiKey: '', senderId: '' })
      const [draftApk, setDraftApk] = useState('')
      const [initialised, setInitialised] = useState(false)
      const [savedNotice, setSavedNotice] = useState('')
      // 推送正文是否交给模型生成。开关本体在服务端持久化，这里只是它的镜像。
      const [aiSummary, setAiSummary] = useState(false)
      // 「试一句」的结果。和 savedNotice 分开，因为它是模型输出，可能很长、也可能失败。
      const [aiProbe, setAiProbe] = useState(null)
      // 复制提示词之后的一句反馈。空串表示还没点过。
      const [promptCopied, setPromptCopied] = useState('')
      // 点了「生成配对码」，但还没有安装包，服务端正在先把包打出来。
      // 为真时二维码那块地方盖上开屏动画，等包出来了再露出二维码。
      const [awaitingApk, setAwaitingApk] = useState(false)
      // 动画的挂载/卸载。离场动画播完才置回 false，不然会在半路上把元素拔掉。
      const [splashVisible, setSplashVisible] = useState(false)
      const splashRef = useRef(null)
      // 「初始化当前插件」的确认框。做成页面内的框而不是 window.confirm：
      // 手机端的 WebView 没有实现 onJsConfirm，浏览器弹不出来的话 confirm() 会**静默返回 false**，
      // 点下去看起来像没反应。
      const [confirmingReset, setConfirmingReset] = useState(false)

      const refresh = useCallback(async () => {
        const response = await fetch(STATE_URL)
        if (!response.ok)
          throw new Error(`读取配对状态失败（HTTP ${response.status}）`)
        setState(await readJson(response))
      }, [])

      useEffect(() => {
        refresh().catch(error => setFailure(String(error.message ?? error)))
      }, [refresh])

      useEffect(() => {
        if (initialised || state === null)
          return
        setDraftBase(state.storedPairBase ?? '')
        setDraftApk(state.storedApkUrl ?? '')
        setFirebase({
          projectId: state.firebaseProjectId ?? '',
          appId: state.firebaseAppId ?? '',
          apiKey: state.firebaseApiKey ?? '',
          senderId: state.firebaseSenderId ?? '',
        })
        setAiSummary(state.pushAiSummary === true)
        setInitialised(true)
      }, [state, initialised])
      // 构建要几分钟，而结果是宿主侧的进程状态，只能轮询。只在构建中轮询，
      // 闲着的时候一个请求都不发。
      useEffect(() => {
        if (!state?.build?.running && !awaitingApk)
          return undefined
        const timer = setInterval(() => { refresh().catch(() => {}) }, 4000)
        return () => clearInterval(timer)
      }, [state?.build?.running, awaitingApk, refresh])

      /**
       * 等第一次出包的收尾。
       *
       * `awaitingApk` 要等构建**真的落定**才放下，不能一收到状态就放 —— 二维码指向的
       * 安装包在构建结束前是 404，那段时间露出二维码，人一扫就得到"下载失败"，
       * 而错误现场在手机上。落定之后再播离场动画，所以也不会出现"角色走了、码还没出现"。
       */
      useEffect(() => {
        if (!awaitingApk)
          return undefined
        const build = state?.build
        if (!build || build.running === true || build.finishedAt === 0)
          return undefined
        setAwaitingApk(false)
        if (build.ok === false)
          setFailure(`安装包没打出来：${build.failure}`)
        return undefined
      }, [awaitingApk, state])

      /**
       * 动画的入场与离场。
       *
       * 它住在一张静态页里（和手机开屏同一份），通过 iframe 引用：400 KB，而且自带
       * splashSay / splashLeave 两个入口，不必为了控制它复制一份逻辑。
       */
      useEffect(() => {
        if (awaitingApk) {
          setSplashVisible(true)
          return undefined
        }
        if (!splashVisible)
          return undefined
        try {
          splashRef.current?.contentWindow?.splashLeave?.()
        }
        catch {
          // 动画没加载出来不该让"包已经好了"这件事卡住：直接撤掉就好。
        }
        // 离场本身是 250ms，多留一点让它走完。
        const timer = setTimeout(() => setSplashVisible(false), 700)
        return () => clearTimeout(timer)
      }, [awaitingApk, splashVisible])

      // 只为了让「N 分钟后过期」自己走字，不参与任何判定：过期与否以宿主返回的时间戳为准。
      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 5000)
        return () => clearInterval(timer)
      }, [])

      const mint = useCallback(async () => {
        setBusy(true)
        setFailure('')
        try {
          const response = await fetch(MINT_URL, { method: 'POST' })
          const payload = await readJson(response)
          if (!response.ok)
            throw new Error(payload?.error ?? `生成配对码失败（HTTP ${response.status}）`)
          // 还没有安装包，服务端已经去打了。这里不报错 —— 报错会把"等两分钟"说成"失败了"，
          // 而发一个指向不存在安装包的码才是真正糟糕的结果：错误现场在手机上。
          if (payload?.building === true) {
            setAwaitingApk(true)
            return
          }
          setAwaitingApk(false)
          // 直接用 mint 的返回值，不再回查 state：state 只报码本身，
          // 二维码是 mint 当场算的，回查一次就会把它冲掉。
          // 只覆盖这次真的带回来的字段。用 undefined 去盖会让界面上那一条凭空消失，
          // 而它其实还在正常工作 —— 这种"看起来坏了"最难查。
          setState((current) => {
            const merged = { ...(current ?? {}) }
            for (const [key, value] of Object.entries(payload ?? {})) {
              if (value !== undefined && key !== 'code' && key !== 'expiresAt' && key !== 'link' && key !== 'qrSvg')
                merged[key] = value
            }
            merged.codes = [{ code: payload.code, expiresAt: payload.expiresAt, permanent: payload.permanent, link: payload.link, qrSvg: payload.qrSvg }]
            return merged
          })
        }
        catch (error) {
          setFailure(String(error.message ?? error))
        }
        finally {
          setBusy(false)
        }
      }, [])

      /**
       * 主动关掉配对入口。
       *
       * 配对成功本来就会自动关，这个按钮是给"反悔了"用的：码生成了又不想配，
       * 点一下立刻作废，不用等它过期。
       */
      const closeEnrollment = useCallback(async () => {
        setFailure('')
        try {
          const response = await fetch(CLOSE_URL, { method: 'POST' })
          if (!response.ok)
            throw new Error(`关闭失败（HTTP ${response.status}）`)
          await refresh()
        }
        catch (error) {
          setFailure(String(error.message ?? error))
        }
      }, [refresh])

      const startBuild = useCallback(async () => {
        setFailure('')
        setSavedNotice('')
        try {
          const response = await fetch(BUILD_URL, { method: 'POST' })
          const payload = await readJson(response)
          if (!response.ok)
            throw new Error(payload?.error ?? `无法启动构建（HTTP ${response.status}）`)
          await refresh()
        }
        catch (error) {
          setFailure(String(error.message ?? error))
        }
      }, [refresh])

      /**
       * 初始化当前插件：清掉配对码、断开并吊销所有手机、删掉已发布的安装包。
       *
       * 存在的理由是那条"第一次"的路（还没有安装包时点生成二维码会先出包）平时只有
       * 全新部署才走得到，没有这个按钮就只能手工去文件系统里删东西。
       */
      const resetPlugin = useCallback(async () => {
        setBusy(true)
        setFailure('')
        setSavedNotice('')
        try {
          const response = await fetch(RESET_URL, { method: 'POST' })
          const payload = await readJson(response)
          if (!response.ok)
            throw new Error(payload?.error ?? `初始化失败（HTTP ${response.status}）`)
          setConfirmingReset(false)
          setAwaitingApk(false)
          setSavedNotice(`已初始化：吊销 ${payload.devicesRevoked ?? 0} 台设备，断开 ${payload.connectionsClosed ?? 0} 条连接${payload.apkRemoved ? '，安装包已删除' : ''}。`)
          await refresh()
        }
        catch (error) {
          setFailure(String(error.message ?? error))
        }
        finally {
          setBusy(false)
        }
      }, [refresh])

      const saveSettings = useCallback(async () => {
        setFailure('')
        setSavedNotice('')
        try {
          const response = await fetch(SETTINGS_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              pairBase: draftBase,
              apkUrl: draftApk,
              firebaseProjectId: firebase.projectId,
              firebaseAppId: firebase.appId,
              firebaseApiKey: firebase.apiKey,
              firebaseSenderId: firebase.senderId,
            }),
          })
          const payload = await readJson(response)
          if (!response.ok)
            throw new Error(payload?.error ?? `保存失败（HTTP ${response.status}）`)
          await refresh()
          setSavedNotice(draftBase.trim() === '' ? '已改回配置默认值' : '已保存')
        }
        catch (error) {
          setFailure(String(error.message ?? error))
        }
      }, [draftBase, draftApk, firebase, refresh])

      /**
       * 切换「AI 生成推送正文」。
       *
       * 只提交这一个字段，而不是复用 saveSettings：那个会把域名和安装包地址一起提交，
       * 于是一个还没保存的草稿会被这次切换顺手写进去。开关是即时生效的东西，不该有
       * 这种副作用。
       *
       * 先乐观地把开关拨过去，失败再拨回来 —— 让开关停在"看起来开了、其实没存上"的
       * 状态，比慢半拍更糟。
       */
      const toggleAiSummary = useCallback(async (next) => {
        setFailure('')
        setSavedNotice('')
        setAiProbe(null)
        setAiSummary(next)
        try {
          const response = await fetch(SETTINGS_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pushAiSummary: next }),
          })
          const payload = await readJson(response)
          if (!response.ok)
            throw new Error(payload?.error ?? `保存失败（HTTP ${response.status}）`)
          await refresh()
        }
        catch (error) {
          setAiSummary(!next)
          setFailure(String(error.message ?? error))
        }
      }, [refresh])

      /**
       * 拿一段示例文本试生成一次。
       *
       * 这个按钮的意义是：开关打开之后到底会推什么，本来要等下一轮任务跑完才知道，
       * 而那时人可能已经离开电脑了。有了它，"模型通不通、出来的话像不像样"当场可见。
       */
      const probeAiSummary = useCallback(async () => {
        setAiProbe({ pending: true })
        setFailure('')
        try {
          const response = await fetch(SUMMARIZE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: AI_PROBE_SAMPLE }),
          })
          const payload = await readJson(response)
          if (!response.ok)
            throw new Error(payload?.message ?? payload?.error ?? `试生成失败（HTTP ${response.status}）`)
          setAiProbe({ text: payload.text, model: payload.model })
        }
        catch (error) {
          setAiProbe({ error: String(error.message ?? error) })
        }
      }, [])

      /**
       * 复制提示词。
       *
       * 剪贴板接口在非安全上下文里会直接抛异常，而这条路是"用户不知道怎么办"时的兜底 ——
       * 它恰恰不能是那个会失败的东西。所以失败时不报错了事，而是把展开框打开、把文本选中，
       * 让用户还能手动复制。
       */
      const copyAgentPrompt = useCallback(async () => {
        setPromptCopied('')
        try {
          await navigator.clipboard.writeText(agentPrompt())
          setPromptCopied('已复制。粘贴到能操作这台电脑的 Agent 对话里。')
        }
        catch {
          setPromptCopied('这个页面不让自动复制，请展开下面的框手动复制。')
        }
      }, [])

      const revoke = useCallback(async (device) => {
        setFailure('')
        try {
          const response = await fetch(REVOKE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ device }),
          })
          if (!response.ok) {
            const payload = await readJson(response)
            throw new Error(payload?.error ?? `吊销失败（HTTP ${response.status}）`)
          }
          await refresh()
        }
        catch (error) {
          setFailure(String(error.message ?? error))
        }
      }, [refresh])

      const code = state?.codes?.[0]
      const panelStyle = {
        maxWidth: '560px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        fontSize: '14px',
        lineHeight: '1.6',
      }
      const buttonStyle = {
        alignSelf: 'flex-start',
        padding: '9px 18px',
        borderRadius: '10px',
        border: '1px solid currentColor',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '14px',
        cursor: busy ? 'progress' : 'pointer',
        opacity: busy ? 0.6 : 1,
      }
      const smallButtonStyle = {
        padding: '3px 10px',
        borderRadius: '8px',
        border: '1px solid currentColor',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
      }
      const inputStyle = {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,.45)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '13px',
      }
      const codeStyle = {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '30px',
        letterSpacing: '6px',
        padding: '6px 0',
      }

      // NOTICE: h 是 react/jsx-runtime 的 jsx，签名是 (type, props, key) ——
      // 第三个参数是 key，不是 children。子节点必须写进 props.children，
      // 否则会被静默丢掉，界面只剩一个空白面板。
      return h('div', {
        style: panelStyle,
        children: [
          h('p', {
            key: 'intro',
            style: { margin: 0, opacity: 0.75 },
            children: '先安装 DSH Pocket，再打开配对链接；如果链接没有唤起 App，就在 App 中输入地址和配对码。首次扫码下载并安装后，还需要这一步配对。配对码只能用一次，重新生成会替换之前的码。',
          }),

          h('div', {
            key: 'askai',
            style: {
              border: '1px solid rgba(128,128,128,0.3)',
              borderRadius: '8px',
              padding: '10px 12px',
            },
            children: [
              h('div', { key: 't', style: { fontSize: '13px', fontWeight: 600 }, children: '不知道怎么配？交给 AI' }),
              h('div', {
                key: 'd',
                style: { opacity: 0.6, fontSize: '12px', lineHeight: 1.5, marginTop: '4px' },
                children: '交给能操作这台电脑的 Agent：它来检查和填写配置。缺账号或远程入口时，会带你选择方案，并告诉你手机上该做什么。',
              }),
              h('div', { key: 'r', style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px', flexWrap: 'wrap' }, children: [
                h('button', {
                  key: 'b',
                  type: 'button',
                  style: smallButtonStyle,
                  onClick: copyAgentPrompt,
                  children: '复制提示词',
                }),
                promptCopied === ''
                  ? null
                  : h('span', { key: 'n', style: { fontSize: '12px', opacity: 0.75 }, children: promptCopied }),
              ] }),
              // 折叠起来：这段文本很长，平时不该占着版面，但自动复制失败时它是唯一的退路。
              h('details', { key: 'm', style: { marginTop: '6px' }, children: [
                h('summary', {
                  key: 's',
                  style: { fontSize: '12px', opacity: 0.6, cursor: 'pointer' },
                  children: '展开手动复制',
                }),
                h('textarea', {
                  key: 'a',
                  readOnly: true,
                  value: agentPrompt(),
                  spellCheck: false,
                  // 点一下全选：手动复制的下一步永远是 Ctrl+C，省掉一次三击。
                  onFocus: event => event.target.select(),
                  style: { ...inputStyle, height: '170px', marginTop: '6px', fontSize: '12px', fontFamily: 'monospace' },
                }),
              ] }),
            ],
          }),

          h('button', {
            key: 'mint',
            type: 'button',
            style: buttonStyle,
            onClick: mint,
            disabled: busy,
            children: busy ? '生成中…' : (code ? '重新生成配对码' : '生成配对码'),
          }),

          failure === ''
            ? null
            : h('p', { key: 'failure', style: { margin: 0, color: '#c0392b' }, children: failure }),

          // 入口状态放在最显眼的位置：这是所有者唯一需要判断的东西。
          h('div', {
            key: 'enrollment',
            style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
            children: [
              h('span', {
                key: 'dot',
                style: { width: '9px', height: '9px', borderRadius: '50%', background: code === undefined ? 'rgba(127,127,127,.5)' : '#2e9e5b' },
              }),
              h('span', {
                key: 'text',
                style: { fontSize: '13px', flex: 1, minWidth: '240px' },
                children: code === undefined
                  ? `配对入口已关闭${(state?.devices?.length ?? 0) > 0 ? `，已配对的 ${state.devices.length} 台设备照常使用` : ''}。要再加一台手机，点上面的按钮。`
                  : code.permanent
                    // 安装包钥匙没有有效期，说"多久后过期"是错的。换掉它只有两个入口。
                    ? '配对入口已开启。这个码长期有效：任何拿到这个安装包的人都能连上，直到你点「初始化」或「关闭配对入口」。'
                    : `配对入口已开启，${remaining(code.expiresAt, now)}。扫码即可绑定，配对成功后会自动关闭。`,
              }),
              code === undefined
                ? null
                : h('button', { key: 'close', type: 'button', style: smallButtonStyle, onClick: closeEnrollment, children: '立即关闭' }),
            ],
          }),

          (code === undefined && !awaitingApk)
            ? null
            : h('div', {
                key: 'code',
                style: { display: 'flex', gap: '28px', alignItems: 'flex-start', flexWrap: 'wrap' },
                children: [
                  /**
                   * 二维码和"正在出包"的动画共用这块地方。
                   *
                   * 动画**只铺这一块**，不铺满整页：等待的时候人还在看别的设置项，
                   * 把整页盖住是拿等待惩罚使用者。尺寸就是二维码本身的尺寸，
                   * 所以从"转圈"换成"二维码"时版面不会跳。
                   *
                   * iframe 按 512×512 排版再缩到 256：动画页里的气泡字号和人物尺寸
                   * 是按手机屏幕定的，直接塞进 256 的框里那句话会被 nowrap 截掉。
                   */
                  h('div', {
                    key: 'qr',
                    style: {
                      position: 'relative',
                      flex: '0 0 auto',
                      width: '256px',
                      height: '256px',
                      background: '#fff',
                      padding: '8px',
                      boxSizing: 'border-box',
                      borderRadius: '12px',
                      overflow: 'hidden',
                      lineHeight: 0,
                    },
                    children: [
                      // 二维码是宿主用 qrcode 算出来的 SVG 字符串，不是用户输入，直接内联。
                      code?.qrSvg
                        ? h('div', {
                            key: 'svg',
                            style: { width: '100%', height: '100%' },
                            dangerouslySetInnerHTML: { __html: code.qrSvg },
                          })
                        : null,
                      splashVisible
                        ? h('div', {
                            key: 'waiting',
                            style: { position: 'absolute', inset: 0, background: '#eaf3ff' },
                            children: h('iframe', {
                              ref: splashRef,
                              src: SPLASH_URL,
                              title: '正在构建安装包',
                              style: {
                                display: 'block',
                                width: '512px',
                                height: '512px',
                                border: 0,
                                transform: 'scale(0.5)',
                                transformOrigin: 'top left',
                              },
                              // 载入后把气泡换成我们的话：动画默认显示"加载中… 目前 X%"，
                              // 那是给手机控制台看的，跟"正在打安装包"不是一回事。
                              onLoad: event => {
                                try {
                                  event.target.contentWindow?.splashSay?.('第一次要打安装包，稍等一会儿')
                                }
                                catch {
                                  // 动画没准备好就让它显示自己的默认文案，不影响等待本身。
                                }
                              },
                            }),
                          })
                        : null,
                    ],
                  }),
                  h('div', {
                    key: 'text',
                    style: { minWidth: '200px', flex: 1 },
                    children: [
                      awaitingApk
                        ? h('div', {
                            key: 'waiting',
                            style: { marginBottom: '8px' },
                            children: [
                              h('div', { key: 't', children: '第一次生成二维码要先打安装包，大概一两分钟。' }),
                              h('div', { key: 's', style: { opacity: 0.7, fontSize: '13px' }, children: '打完这里会直接出现二维码，不用再点一次。' }),
                            ],
                          })
                        : null,
                      h('div', { key: 'how', style: { opacity: 0.75 }, children: '用手机相机扫这个码：' }),
                      h('div', { key: 'how2', style: { opacity: 0.75 }, children: '装好的直接进 App 并绑定；没装的先下载安装包，装完再扫一次。' }),
                      // 配对码降级成备用信息：二维码本身就是凭证，正常情况下所有者不需要读它。
                      code === undefined
                        ? null
                        : h('details', {
                            key: 'fallback',
                            style: { marginTop: '10px', opacity: 0.6, fontSize: '12px' },
                            children: [
                              h('summary', { key: 's', children: '扫码没反应？手输这条备用路径' }),
                              h('div', { key: 'b', style: { marginTop: '6px', wordBreak: 'break-all' }, children: `地址 ${state.pairBase}` }),
                              h('div', { key: 'c', style: { marginTop: '2px' }, children: `配对码 ${code.code}` }),
                            ],
                          }),
                    ],
                  }),
                ],
              }),

          h('div', {
            key: 'settings',
            style: { borderTop: '1px solid rgba(127,127,127,.25)', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' },
            children: [
              h('div', { key: 'h', style: { opacity: 0.6 }, children: '部署设置' }),
              h('div', { key: 'bh', style: { opacity: 0.6, fontSize: '13px' }, children: '二维码里告诉手机该连哪个地址' }),
              h('input', {
                key: 'base',
                value: draftBase,
                placeholder: `留空使用默认：${state?.pairBase ?? ''}`,
                spellCheck: false,
                onChange: event => setDraftBase(event.target.value),
                style: inputStyle,
              }),
              h('div', { key: 'be', style: { opacity: 0.5, fontSize: '12px' }, children: `生效中：${state?.pairBase ?? '—'}` }),
              h('div', { key: 'ah', style: { opacity: 0.6, fontSize: '13px', marginTop: '4px' }, children: '二维码指向的安装包地址' }),
              h('input', {
                key: 'apk',
                value: draftApk,
                placeholder: `留空使用默认：${state?.apkUrl ?? ''}`,
                spellCheck: false,
                onChange: event => setDraftApk(event.target.value),
                style: inputStyle,
              }),
              h('div', { key: 'ae', style: { opacity: 0.5, fontSize: '12px' }, children: `生效中：${state?.apkUrl ?? '—'}` }),
              h('div', { key: 'fh', style: { opacity: 0.6, fontSize: '13px', marginTop: '10px' }, children: '推送（Firebase 客户端配置）' }),
              h('div', { key: 'fd', style: { opacity: 0.5, fontSize: '12px' }, children: '可以让 Agent 从你下载的 google-services.json 自动读取并填写，不必逐项抄写。这些客户端配置需要重新构建并安装 App 才会生效；发送通知还需要电脑上的服务账号。' }),
              ...[
                ['projectId', 'projectId', 'your-project-id'],
                ['appId', 'appId（mobilesdk_app_id）', '1:000000000000:android:…'],
                ['apiKey', 'apiKey', 'AIza…'],
                ['senderId', 'senderId（项目编号）', '000000000000'],
              ].map(([field, label, hint]) => h('div', { key: 'f' + field, children: [
                h('div', { key: 'l', style: { opacity: 0.6, fontSize: '12px' }, children: label }),
                h('input', {
                  key: 'i',
                  value: firebase[field],
                  placeholder: hint,
                  spellCheck: false,
                  onChange: event => setFirebase(current => ({ ...current, [field]: event.target.value })),
                  style: inputStyle,
                }),
              ] })),
              h('div', {
                key: 'gnote',
                style: { opacity: 0.5, fontSize: '12px', marginTop: '4px', lineHeight: 1.5 },
                children: '电脑和手机都需要能连接 Google 推送服务，手机还需要可用的 Google Play 服务。暂时不配通知也能使用控制台。已有推送要关闭时请让 Agent 操作；清空字段可能回退到原配置。',
              }),
              h('div', { key: 'ps', style: { opacity: 0.6, fontSize: '12px', marginTop: '4px' }, children: state?.pushConfigured
                ? `服务端发送：已配置${state.pushFailed ? ` · 出错：${state.pushFailed}` : ''}`
                : '服务端发送：未配置服务账号，点了构建也收不到通知' }),
              h('label', {
                key: 'ai',
                style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', cursor: 'pointer' },
                children: [
                  h('input', {
                    key: 'c',
                    type: 'checkbox',
                    checked: aiSummary,
                    onChange: event => toggleAiSummary(event.target.checked),
                    style: { width: '16px', height: '16px', cursor: 'pointer' },
                  }),
                  h('span', { key: 'l', style: { fontSize: '13px' }, children: '推送正文由 AI 生成' }),
                ],
              }),
              h('div', { key: 'aid', style: { opacity: 0.5, fontSize: '12px', lineHeight: 1.5 }, children: '默认关。关闭时发送回复开头的预览，开启时由所选模型生成摘要，并增加一次模型调用；摘要失败会回退到预览。通知正文会经过 Google FCM。关闭摘要不等于关闭推送，是否收到仍需手机验证。' }),
              h('div', { key: 'air', style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' }, children: [
                h('button', {
                  key: 'p',
                  type: 'button',
                  style: smallButtonStyle,
                  disabled: aiProbe?.pending === true,
                  onClick: probeAiSummary,
                  children: aiProbe?.pending === true ? '生成中…' : '试一句',
                }),
                h('span', { key: 'h', style: { opacity: 0.5, fontSize: '12px' }, children: '拿一段示例文本试一次，看通知栏里会显示成什么样' }),
              ] }),
              /**
               * 试生成的结果单独成块显示。
               *
               * 第一版是按钮旁边一行 12px 灰字，结果就是点完看不出发生过什么 ——
               * 按钮立刻变回「试一句」，旁边多一行不显眼的小字，用户会以为按钮没反应。
               * 现在给它边框和底色：出现一块东西本身就是"有反应"的信号。
               */
              aiProbe === null ? null : h('div', {
                key: 'airr',
                style: {
                  marginTop: '6px',
                  padding: '8px 10px',
                  borderRadius: '6px',
                  border: `1px solid ${aiProbe.error === undefined ? 'rgba(128,128,128,0.35)' : 'rgba(229,72,77,0.5)'}`,
                  background: aiProbe.error === undefined ? 'rgba(128,128,128,0.08)' : 'rgba(229,72,77,0.08)',
                  fontSize: '13px',
                  lineHeight: 1.6,
                  wordBreak: 'break-word',
                },
                children: aiProbe.pending === true
                  ? h('span', { key: 'w', style: { opacity: 0.6 }, children: '正在生成…' })
                  : aiProbe.error !== undefined
                    ? h('span', { key: 'e', style: { color: '#e5484d' }, children: `失败：${aiProbe.error}` })
                    : [
                        h('div', { key: 'l', style: { opacity: 0.55, fontSize: '12px' }, children: '通知栏会显示' }),
                        h('div', { key: 't', style: { marginTop: '2px' }, children: aiProbe.text }),
                        aiProbe.model === undefined
                          ? null
                          : h('div', { key: 'm', style: { opacity: 0.45, fontSize: '12px', marginTop: '4px' }, children: `由 ${aiProbe.model} 生成` }),
                      ],
              }),
              h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px' }, children: [
                h('button', { key: 'save', type: 'button', style: smallButtonStyle, onClick: saveSettings, children: '保存' }),
                savedNotice === '' ? null : h('span', { key: 'n', style: { opacity: 0.7, fontSize: '13px' }, children: savedNotice }),
              ] }),
              h('div', { key: 'note', style: { opacity: 0.5, fontSize: '12px' }, children: '留空表示改回配置文件里的默认值。保存后立刻生效，重新生成配对码即可看到新的二维码。' }),
              h('div', { key: 'apkh', style: { opacity: 0.6, fontSize: '13px', marginTop: '6px' }, children: '本机安装包' }),
              h('div', { key: 'apkd', style: { fontSize: '12px', wordBreak: 'break-all' }, children: state?.apkFile?.exists
                ? `已就绪：${state.apkName}（${(state.apkFile.size / 1048576).toFixed(2)} MB，改于 ${new Date(state.apkFile.modifiedAt).toLocaleTimeString()}）`
                : `目录里还没有 ${state?.apkName ?? '安装包'}` }),
              h('div', { key: 'apkp', style: { opacity: 0.5, fontSize: '12px', wordBreak: 'break-all' }, children: `把构建好的 APK 放到：${state?.apkDir ?? '—'}` }),
              state?.bakePreview
                ? h('div', { key: 'bakeprev', style: { fontSize: '12px', opacity: 0.65, lineHeight: 1.6, marginTop: '4px' }, children: [
                    h('div', { key: 't', style: { opacity: 0.8 }, children: '点构建时会烘进包里：' }),
                    h('div', { key: 'b', style: { wordBreak: 'break-all' }, children: `地址：${state.bakePreview.pairBase || '（空）'}` }),
                    h('div', { key: 'f', style: { wordBreak: 'break-all' }, children: `Firebase：${state.bakePreview.firebaseProjectId || '（空，推送不启用）'}` }),
                  ] })
                : null,
              state?.buildEnabled === false
                ? null
                : h('div', { key: 'build', style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }, children: [
                    h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: '12px' }, children: [
                      h('button', {
                        key: 'b',
                        type: 'button',
                        style: smallButtonStyle,
                        onClick: startBuild,
                        disabled: state?.build?.running === true,
                        children: state?.build?.running === true ? '构建中…' : '构建并发布',
                      }),
                      h('span', { key: 's', style: { fontSize: '12px', opacity: 0.7 }, children: buildSummary(state?.build) }),
                    ] }),
                    // 只在失败或构建中显示日志尾部：成功了没必要占版面。
                    state?.build && (state.build.running || state.build.ok === false)
                      ? h('pre', {
                          key: 'log',
                          style: {
                            margin: 0,
                            maxHeight: '160px',
                            overflow: 'auto',
                            fontSize: '11px',
                            lineHeight: 1.45,
                            background: 'rgba(127,127,127,.10)',
                            borderRadius: '8px',
                            padding: '8px 10px',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                          },
                          children: (state.build.tail ?? []).slice(-24).join('\n'),
                        })
                      : null,
                    /**
                     * 构建后的产物核对结果。命令行传对了不等于产物对了 —— 这里直接告诉使用者
                     * 这次烘进包里的到底是什么，不用猜。
                     */
                    state?.build?.baked
                      ? h('div', {
                          key: 'baked',
                          style: {
                            fontSize: '12px',
                            lineHeight: 1.6,
                            padding: '6px 10px',
                            borderRadius: '8px',
                            border: `1px solid ${Object.values(state.build.baked).every(v => v === true) ? 'rgba(64,160,64,0.4)' : 'rgba(229,72,77,0.5)'}`,
                            background: Object.values(state.build.baked).every(v => v === true) ? 'rgba(64,160,64,0.06)' : 'rgba(229,72,77,0.06)',
                          },
                          children: [
                            h('div', { key: 't', style: { opacity: 0.8 }, children: '产物核对（这次烘进包里的值）：' }),
                            ...Object.entries(state.build.baked).map(([k, found]) =>
                              h('div', {
                                key: k,
                                style: { color: found === true ? 'inherit' : '#e5484d' },
                                children: `${found === true ? '✓' : '✗'} ${k}`,
                              })
                            ),
                          ],
                        })
                      : null,
                  ],
                }),
            ],
          }),

          h('div', {
            key: 'devices',
            style: { borderTop: '1px solid rgba(127,127,127,.25)', paddingTop: '12px' },
            children: [
              h('div', { key: 'h', style: { opacity: 0.6 }, children: `已配对设备（${state?.devices?.length ?? 0}）` }),
              state?.devices?.length
                ? h('ul', { key: 'list', style: { margin: '6px 0 0', padding: 0, listStyle: 'none' } },
                    state.devices.map(entry => h('li', {
                      key: entry.device,
                      style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '3px 0' },
                      children: [
                        h('code', { key: 'n', style: { flex: 1 }, children: entry.device }),
                        h('button', {
                          key: 'r',
                          type: 'button',
                          style: smallButtonStyle,
                          onClick: () => revoke(entry.device),
                          children: '吊销',
                        }),
                      ],
                    })))
                : h('div', { key: 'none', style: { opacity: 0.5 } }, '还没有设备配对过。'),
              state?.lanBase
                ? h('div', { key: 'lan', style: { marginTop: '10px', opacity: 0.6 }, children: `局域网入口：${state.lanBase}` })
                : h('div', { key: 'lan', style: { marginTop: '10px', opacity: 0.6 }, children: state?.lanFailure ? `局域网入口启动失败：${state.lanFailure}` : '局域网入口：未启用（或没有可用的非本机地址）' }),
            ],
          }),

          /**
           * 初始化：把插件恢复成"什么都还没生成"的样子。
           *
           * 放在最下面、用弱化的样式，因为它是给所有者测试"第一次"那条路用的，
           * 不是日常动作 —— 每一次正常配对都不需要它。
           */
          h('div', {
            key: 'reset',
            style: { borderTop: '1px solid rgba(127,127,127,.25)', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px' },
            children: [
              h('div', { key: 'h', style: { opacity: 0.6 }, children: '初始化当前插件' }),
              h('div', { key: 'd', style: { opacity: 0.6, fontSize: '13px' }, children: '恢复成什么都还没生成的样子，方便重新走一遍第一次的流程。部署设置不会被清掉。' }),
              h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: '12px' }, children: [
                h('button', {
                  key: 'b',
                  type: 'button',
                  style: { ...smallButtonStyle, color: '#c0392b', borderColor: 'rgba(192,57,43,.5)' },
                  disabled: busy,
                  onClick: () => setConfirmingReset(true),
                  children: '初始化当前插件',
                }),
              ] }),
            ],
          }),

          // 确认框。用页面内的框而不是 window.confirm：手机端 WebView 没实现 onJsConfirm，
          // 那里 confirm() 会静默返回 false，点下去像没反应。
          confirmingReset
            ? h('div', {
                key: 'confirm',
                style: {
                  position: 'fixed',
                  inset: 0,
                  zIndex: 10000,
                  background: 'rgba(0,0,0,.45)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '24px',
                },
                children: h('div', {
                  key: 'card',
                  style: {
                    maxWidth: '440px',
                    background: 'Canvas',
                    color: 'CanvasText',
                    borderRadius: '14px',
                    padding: '20px 22px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                    boxShadow: '0 18px 50px rgba(0,0,0,.35)',
                  },
                  children: [
                    h('div', { key: 't', style: { fontSize: '16px', fontWeight: 600 }, children: '确定要初始化吗？' }),
                    h('div', { key: 'b', style: { lineHeight: 1.7 }, children: [
                      h('div', { key: '1', children: `所有已配对的手机都会立刻断连（当前 ${state?.devices?.length ?? 0} 台），需要重新配对才能再用。` }),
                      h('div', { key: '2', children: '配对码会清空，已经生成的安装包会删掉 —— 二维码指向的下载地址会变成 404，直到你重新构建一次。' }),
                      h('div', { key: '3', style: { opacity: 0.65, fontSize: '13px', marginTop: '6px' }, children: '部署设置（地址、安装包地址、Firebase、推送开关）不会被改动。' }),
                    ] }),
                    h('div', { key: 'row', style: { display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '4px' }, children: [
                      h('button', {
                        key: 'cancel',
                        type: 'button',
                        style: smallButtonStyle,
                        disabled: busy,
                        onClick: () => setConfirmingReset(false),
                        children: '取消',
                      }),
                      h('button', {
                        key: 'go',
                        type: 'button',
                        style: { ...smallButtonStyle, color: '#fff', background: '#c0392b', borderColor: '#c0392b' },
                        disabled: busy,
                        onClick: resetPlugin,
                        children: busy ? '初始化中…' : '确认初始化',
                      }),
                    ] }),
                  ],
                }),
              })
            : null,
        ],
      })
    }

    const sectionName = 'pocket-pair'

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register({
          name: 'settings.section',
          id: sectionName,
          order: 32,
          label: () => '手机配对',
        }, PairPanel)
      })
    }

    return { apply, inject, name: sectionName }
  },
})
