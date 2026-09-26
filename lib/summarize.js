/**
 * 用宿主自己的模型，把"这一轮干了什么"压成一条适合放通知栏的话。
 *
 * 这个模块只做一件事，但它有两个必须讲清楚的约束。
 *
 * 一、**它是可选能力，不是依赖。** 调用方（index.js）拿到 `{ ok: false }` 必须能退回
 *     "最后一条助手消息的开头"，绝不能让通知因为模型抽风而发不出去。手机收不到通知
 *     比收到一条不好看的正文严重得多。
 *
 * 二、**它不构造自己的 provider/model 路由，而是问宿主要当前默认。**
 *     `agentDefaultModel.currentSelection()` 就是用户在界面上选的那个模型，所以这里
 *     不需要任何新配置项 —— 用户换模型，推送文案跟着换。
 *
 * 消息构造沿用宿主自己的 `createUserMessage`，而不是手搓一个 `{role, content}` 字面量：
 * 消息上有一个不透明的 `id` 品牌，手搓等于绕过宿主的校验契约。
 */
import { BlockAssembler, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * 生成超时。
 *
 * 15 秒是刻意的折中：一轮刚跑完，用户正等着那条通知。这个调用只是"锦上添花"，
 * 让它把通知拖到半分钟以后才响，就本末倒置了 —— 超时后调用方会用原文兜底，
 * 所以这个值宁小勿大。
 */
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * 喂给模型的正文上限（字符）。
 *
 * 摘要只需要结论，而结论几乎总在最后。截尾而不是截头也不对 —— 有些模型最后一句是
 * "要我继续吗"。所以从尾部取，取不到结论时摘要会退化成不理想的句子，但不会失败。
 */
const MAX_INPUT_CHARS = 4000

/**
 * 通知正文的硬上限（字符）。
 *
 * 这个值只是**安全网**，正常长度由提示词去管。之所以不是一个很小的数：字符数和信息量
 * 的关系取决于文字。80 个汉字足够说清一件事，80 个拉丁字母却只够说半句（英文会被截成
 * "…gate a"）。App 那边用的是 BigTextStyle，正文长了会展开，所以这里给宽一点更划算。
 */
const MAX_OUTPUT_CHARS = 120

/**
 * 判断该用什么语言输出，返回 `{ code, rule }`。
 *
 * 为什么不让模型自己"看语言"：系统提示本身是中文，模型会不自觉地跟着写中文。实测
 * 中文正文混着英文标识符（`X-Dsh-Device-Token`、`PushRegistration.kt`）时它会输出英文，
 * 而纯英文正文它又会输出中文 —— 两头都错。会话语言是这条通知最容易坏、也最显眼的属性，
 * 不能交给模型猜。
 *
 * 所以这里自己数，把结论直接写进指令：
 * - 有假名 → 日文（只凭汉字分不出中日的经典做法）。
 * - 汉字压过拉丁字母 → 中文。注意是**直接比大小**而不是固定比例：标识符会把字母数量
 *   抬高，比例阈值在这种情况下反而判错。
 * - 拉丁字母压倒性多 → 默认英文，但留一句余地给同属拉丁字母的其他语言。之所以能留余地，
 *   是因为"这是不是拉丁字母语言"是个容易的判断，而"这是不是中文"已经由上面处理掉了，
 *   模型不需要再跟中文系统提示对抗。
 */
function scriptHint(text) {
  const kana = (text.match(/[\u3040-\u30ff]/g) ?? []).length
  const han = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length
  const latin = (text.match(/[A-Za-z]/g) ?? []).length
  if (kana >= 4)
    return { code: 'ja', rule: '必须用日文输出。' }
  if (han >= 6 && han >= latin)
    return { code: 'zh', rule: '必须用中文输出，即使正文里夹着英文的代码标识符。' }
  if (latin >= 20)
    return { code: 'en', rule: '必须用英文输出。除非下面这段内容明显是另一种拉丁字母语言（如西班牙语、法语），那就用那种语言。' }
  return { code: 'auto', rule: '输出的语言必须和下面这段内容一致。' }
}

/**
 * 摘要指令。
 *
 * 逐条禁令（Markdown、代码块、前缀）不是洁癖 —— 通知栏不渲染 Markdown，模型很爱加的
 * "好的，""根据以上分析，"这类开场白在通知里纯粹是噪音。
 *
 * 长度分语言给：按字符数一刀切会让中文太松、英文太紧。
 */
function systemPromptFor(text) {
  return [
    '你把一段 AI 编程助手刚完成的工作，压成一条手机通知栏上的话。',
    '',
    '规则：',
    '- 只输出这一句话本身，不要开场白、不要解释、不要引号、不要 Markdown、不要代码块。',
    '- 说"做完了什么、结果是什么"，不要复述过程、不要罗列步骤。',
    '- 尽量短：中文 40 字以内，其他语言约 120 个字符以内。',
    '- 如果内容是失败、报错、或者正在等用户回答，就如实说这件事。',
    '',
    scriptHint(text).rule,
  ].join('\n')
}

/** 可调用的 dsh-llm 能力的最小形状。防御式：不假设服务一定挂上了。 */
function llmOf(ctx) {
  const llm = ctx?.llm
  if (llm === null || typeof llm !== 'object' || typeof llm.stream !== 'function')
    return null
  return llm
}

/**
 * 当前模型是否声明支持 reasoning effort（含 `'off'`）。
 *
 * 显式传 `reasoningEffort` 给一个没有 reasoning 元数据的模型，dsh-llm 会判
 * `UNSUPPORTED_REASONING_EFFORT`，请求发不出去并被适配器折叠成**空流** —— 表现是
 * "模型没返回文本"，而不是报错，非常难查。所以只在模型确实声明了 `off` 时才传；
 * 其余情况省略该字段，语义上本来就等价于"不关思考"。
 *
 * 探测失败一律按不支持处理：不传只是保留模型的默认行为，传错却会让整次调用作废。
 */
async function supportsReasoningOff(llm, provider, model) {
  if (typeof llm.resolveModelInfo !== 'function')
    return false
  try {
    const info = await llm.resolveModelInfo(provider, model)
    return info?.reasoning?.efforts?.some(effort => effort.id === 'off') ?? false
  }
  catch {
    return false
  }
}

/** 取模型的文本输出。非文本块（工具调用）一律丢掉。 */
function textOf(assembler) {
  return assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim()
}

/** 一句话不需要换行；模型偶尔会违规返回多行，这里只留第一行有内容的。 */
function firstLine(text) {
  const line = text.split('\n').map(part => part.trim()).find(part => part !== '')
  return line ?? ''
}

/**
 * 把终止原因翻译成失败描述，成功时返回 `null`。
 *
 * 这一步不能省。dsh-llm 会把适配器层面的失败（没适配器、鉴权失败、限流、超时）**折叠成
 * 一个终止 chunk**，而不是抛异常 —— 也就是说 `for await` 正常结束、`blocks()` 返回空数组。
 * 只看"有没有文本"，这些失败就全都变成一句"模型没返回文本"，真正的原因（比如密钥没配）
 * 被吞掉，排查时完全无从下手。
 */
function finishFailure(finish) {
  switch (finish?.kind) {
    case 'stop':
      return null
    case 'error':
    case 'aborted':
      return finish.failure?.message ?? '模型调用失败'
    case 'max-tokens':
      return '输出被 token 上限截断'
    case 'tool-calls':
      return '模型意外请求了工具'
    default:
      return finish === undefined ? null : `未预期的终止原因：${String(finish.kind)}`
  }
}

/** 超长就截断并加省略号，避免通知被系统截成半句还没提示。 */
function clamp(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/**
 * 建一个摘要器。没有模型可用不是错误，是"这个能力没开成"，所以构造本身不会失败。
 *
 * @param ctx 宿主上下文，需要 `llm` 和 `agentDefaultModel`。
 * @param logger 宿主日志器。
 * @param timeoutMs 单次生成超时。
 */
export function createPushSummarizer({ ctx, logger, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return {
    /**
     * 把一段工作记录压成一条通知正文。
     *
     * @param text 这一轮的助手输出（可以是多段拼起来的）。
     * @returns `{ ok: true, text }`，或 `{ ok: false, reason, message }`。
     *          调用方在任何 `ok: false` 下都必须有兜底文案。
     */
    async describe(text) {
      const source = String(text ?? '').trim()
      if (source === '')
        return { ok: false, reason: 'empty-input', message: '这一轮没有可摘要的文本' }

      const llm = llmOf(ctx)
      if (llm === null)
        return { ok: false, reason: 'no-llm', message: '宿主没有提供 LLM 服务' }

      // 路由取"当前对话用的模型"。取不到不是异常，是用户还没选模型。
      let selection = null
      try {
        selection = ctx?.agentDefaultModel?.currentSelection?.() ?? null
      }
      catch {
        selection = null
      }
      if (selection === null || !selection.provider || !selection.model)
        return { ok: false, reason: 'no-model', message: '当前没有选定模型' }

      const { provider, model } = selection
      const tail = source.length <= MAX_INPUT_CHARS ? source : source.slice(-MAX_INPUT_CHARS)
      const supportsOff = await supportsReasoningOff(llm, provider, model)

      /**
       * 刻意**不设** `maxTokens`。
       *
       * 推理模型把思考也算进输出预算，给一个"通知只要 60 token"的小上限，会把正文
       * 整个截掉，表现为空回复。长度改由 `MAX_OUTPUT_CHARS` 在结果上兜。
       */
      const request = {
        provider,
        model,
        system: systemPromptFor(tail),
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: tail }],
            source: { kind: 'plugin', plugin: 'dsh-pocket-pair' },
          }),
        ],
        temperature: 0.3,
        ...(supportsOff ? { reasoningEffort: ReasoningEffortId('off') } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      }

      const assembler = new BlockAssembler()
      try {
        for await (const chunk of llm.stream(request))
          assembler.push(chunk)
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger?.warn?.(`dsh-pocket-pair: 摘要生成失败：${message}`)
        return { ok: false, reason: 'generate-error', message }
      }

      const line = firstLine(textOf(assembler))
      if (line === '') {
        const failure = finishFailure(assembler.finish)
        const message = failure ?? '模型没有返回文本'
        logger?.warn?.(`dsh-pocket-pair: 摘要没拿到文本：${message}`)
        return { ok: false, reason: failure === null ? 'no-text' : 'finish-error', message }
      }

      return { ok: true, text: clamp(line, MAX_OUTPUT_CHARS), provider, model }
    },
  }
}
