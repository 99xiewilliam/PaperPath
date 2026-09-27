import type { ChatMessage, LlmSettings } from '@shared/types'
import { currentSignal } from './tasks'

export interface LlmCallOptions {
  /** 请求模型返回严格 JSON */
  json?: boolean
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  /** 显式传入的中断信号；不传则自动使用当前任务队列里正在跑的那个 */
  signal?: AbortSignal
  /**
   * 传入后走 SSE 流式请求，每收到一段增量文本回调一次。
   * 注意：流式不参与重试——已经吐给用户的增量没法回滚，重试会让内容重复。
   */
  onDelta?: (delta: string) => void
  /**
   * 不要覆盖 maxTokens，除非有明确理由。
   * 推理型模型会把 reasoning token 也算进这个预算，压得太低会导致
   * 「思考完了但正文为空」——这个坑踩过一次了。
   */
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** 用户主动取消（区别于超时 / 网络失败），调用方不应重试 */
    readonly cancelled = false
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

/**
 * 瞬时故障的状态码：限流、网关抽风、请求超时。
 *
 * 为什么要单独认这一类：精读是并发扇出的（默认 3 路、一次连发十几个请求），
 * 中转服务撞上限流几乎必然发生。而单维度失败是被刻意设计成「不中断其他维度」的，
 * 于是表现是「某个维度莫名其妙全空」—— 既不报错也看不出原因，
 * 排查成本远高于在这里退避重试一次。
 */
function isTransientStatus(status?: number): boolean {
  return status === 408 || status === 429 || (status != null && status >= 500)
}

const RETRY_BACKOFF_MS = [1000, 3000]

/** 可中断的等待：用户点了取消就不该继续等下去，更不该接着重试 */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * 「空内容」的提示语。
 *
 * 必须同时点出两种可能，否则会把用户带偏：实测过「推理型模型 + 很小的 max_tokens」
 * 时，思考把输出预算占满、正文为空，而老文案只说「请检查模型名是否正确」——
 * 换服务商时看到它会以为模型名写错了，白折腾半天。
 */
const EMPTY_CONTENT_HINT =
  '模型返回了空内容：可能是模型名不对，也可能是推理模型的思考把输出预算占满了。'

function endpointOf(baseUrl: string): string {
  const b = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!b) throw new LlmError('尚未配置 API Base URL，请到「设置」里填写。')
  if (/\/chat\/completions$/.test(b)) return b
  if (/\/v\d+$/.test(b)) return `${b}/chat/completions`
  return `${b}/v1/chat/completions`
}

export interface LlmResult {
  content: string
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  /**
   * 输出撞到 max_tokens 被截断了（`finish_reason === 'length'`）。
   *
   * JSON 会被 `repairTruncatedJson` 抢救成「最后一个完整值」，所以调用方**看起来是成功的**，
   * 但内容一定不全 —— 实测过「声明 6 节、只落 1 节」的情况就是这么来的。
   * 不透出这个信号，界面上只剩一个干巴巴的 ✓。
   */
  truncated?: boolean
}

export async function chatCompletion(
  messages: ChatMessage[],
  settings: LlmSettings,
  options: LlmCallOptions = {}
): Promise<LlmResult> {
  if (!settings.apiKey?.trim()) {
    throw new LlmError('尚未配置 API Key，请到「设置」里填写后再试。')
  }
  if (!settings.model?.trim()) {
    throw new LlmError('尚未配置模型名，请到「设置」里填写。')
  }

  const url = endpointOf(settings.baseUrl)
  const payload: Record<string, unknown> = {
    model: settings.model.trim(),
    messages,
    temperature: options.temperature ?? settings.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? settings.maxTokens ?? 4096,
    stream: !!options.onDelta,
    /*
     * 服务商特有的开关（智谱的 `thinking`、通义的 `enable_thinking` …）不在
     * OpenAI 兼容协议里，由 .env 的 PAPERVAULT_LLM_EXTRA_BODY 提供。
     * 放在最后展开，所以它也能覆盖上面的默认值。
     */
    ...(settings.extraBody ?? {})
  }

  // 队列保证同一时刻只有一个任务在跑，所以这里取到的就是本任务自己的 signal
  const signal = options.signal ?? currentSignal()
  if (signal?.aborted) throw new LlmError('任务已取消。', undefined, true)

  const attempt = async (withJson: boolean): Promise<LlmResult> => {
    const body = withJson ? { ...payload, response_format: { type: 'json_object' } } : payload
    const timeout = options.timeoutMs ?? 300_000
    return options.onDelta
      ? requestStream(url, body, settings.apiKey, timeout, signal, options.onDelta)
      : request(url, body, settings.apiKey, timeout, signal)
  }

  try {
    return await attempt(!!options.json)
  } catch (err) {
    // 用户取消就不要继续重试了，否则点了「取消」还在偷偷发请求
    if (err instanceof LlmError && err.cancelled) throw err
    // 流式同理：已经吐出去的增量追不回来，重试会让用户看到重复内容
    if (options.onDelta) throw err
    if (err instanceof LlmError && err.message.includes('空内容')) {
      // 偶发现象：推理型模型把输出预算全花在 reasoning 上，正文为空。重试一次通常就好。
      return attempt(!!options.json)
    }
    // 部分服务商不支持 response_format，降级重试一次
    if (options.json && err instanceof LlmError && (err.status === 400 || err.status === 422)) {
      return attempt(false)
    }
    if (!(err instanceof LlmError) || !isTransientStatus(err.status)) throw err

    // 限流 / 网关 5xx：退避重试，每次重试前重新看一眼取消信号
    let last: LlmError = err
    for (const waitMs of RETRY_BACKOFF_MS) {
      await sleep(waitMs, signal)
      if (signal?.aborted) throw new LlmError('任务已取消。', undefined, true)
      try {
        return await attempt(!!options.json)
      } catch (retryErr) {
        if (retryErr instanceof LlmError && retryErr.cancelled) throw retryErr
        // 这次错的和上次不是一回事（比如换成了 401），重试下去没意义
        if (!(retryErr instanceof LlmError) || !isTransientStatus(retryErr.status)) throw retryErr
        last = retryErr
      }
    }
    throw last
  }
}

/** 流式请求：按 SSE 逐段解析，边收边回调 */
async function requestStream(
  url: string,
  body: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
  external: AbortSignal | null | undefined,
  onDelta: (delta: string) => void
): Promise<LlmResult> {
  if (external?.aborted) throw new LlmError('任务已取消。', undefined, true)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = (): void => controller.abort()
  external?.addEventListener('abort', onAbort, { once: true })

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
        Accept: 'text/event-stream'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })

    if (!res.ok) {
      throw new LlmError(describeHttpError(res.status, await res.text()), res.status)
    }
    const reader = res.body?.getReader()
    if (!reader) throw new LlmError('接口没有返回可读的流，该服务商可能不支持流式。')

    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''

    /**
     * 处理一段已到达的文本。
     *
     * SSE 以行分隔，而网络到达时一行很可能被切成两截，所以最后那段「半行」
     * 要留到下一次再拼。但流结束时不会再有下一次了 —— `flush` 就是给这个场景准备的：
     * 有些网关收尾时不给最后的换行（`...}}` 之后直接结束），
     * 不留神就会把模型最后吐出来的那几个字整段丢掉。
     */
    const consume = (text: string, flush: boolean): void => {
      buffer += text
      const lines = buffer.split('\n')
      buffer = flush ? '' : (lines.pop() ?? '')

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const raw = trimmed.slice(5).trim()
        if (!raw || raw === '[DONE]') continue
        try {
          const parsed = JSON.parse(raw) as {
            choices?: { delta?: { content?: string }; message?: { content?: string } }[]
            error?: { message?: string }
          }
          if (parsed.error?.message) throw new LlmError(parsed.error.message)
          /*
           * 绝大多数服务商走 delta；也有不切片的（部分网关直接把整段放在
           * message.content 里）。后者只在这条流还一个字都没收到时才认 ——
           * 否则服务商若在最后一帧补一个累计的 message，正文会被整段重复一遍。
           */
          const choice = parsed.choices?.[0]
          const delta =
            choice?.delta?.content ?? (content ? '' : (choice?.message?.content ?? ''))
          if (delta) {
            content += delta
            onDelta(delta)
          }
        } catch (err) {
          if (err instanceof LlmError) throw err
          /* 半行 / 非 JSON 的心跳，跳过 */
        }
      }
    }

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        consume(decoder.decode(value, { stream: true }), false)
      }
      // 不带参数调 decode()，把解码器里残留的半个多字节字符也吐出来
      consume(decoder.decode(), true)
    } finally {
      /*
       * 必须主动 cancel。中途抛错时（比如服务商在流里回了 error）响应体还没读完，
       * 不关掉这条连接就一直被占着、无法复用 —— 批量抽画像连发几十个请求，
       * 几次失败就能积一堆卡住的 socket。流已经读完时 cancel 是空操作。
       */
      await reader.cancel().catch(() => {})
    }

    if (!content.trim()) {
      throw new LlmError(EMPTY_CONTENT_HINT)
    }
    return { content }
  } catch (err) {
    if (err instanceof LlmError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      if (external?.aborted) throw new LlmError('任务已取消。', undefined, true)
      throw new LlmError(`请求超时（${Math.round(timeoutMs / 1000)} 秒），可以换用更快的模型或缩短输入。`)
    }
    throw new LlmError(`网络请求失败：${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onAbort)
  }
}

async function request(
  url: string,
  body: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
  external?: AbortSignal | null
): Promise<LlmResult> {
  if (external?.aborted) throw new LlmError('任务已取消。', undefined, true)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = (): void => controller.abort()
  external?.addEventListener('abort', onAbort, { once: true })

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })

    const text = await res.text()
    if (!res.ok) {
      throw new LlmError(describeHttpError(res.status, text), res.status)
    }

    let parsed: {
      choices?: { message?: { content?: string }; finish_reason?: string }[]
      usage?: LlmResult['usage']
      error?: { message?: string }
    }
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new LlmError(`接口返回了非 JSON 内容：${text.slice(0, 300)}`)
    }
    if (parsed.error?.message) throw new LlmError(parsed.error.message)

    const content = parsed.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      throw new LlmError(EMPTY_CONTENT_HINT)
    }
    return {
      content,
      usage: parsed.usage,
      truncated: parsed.choices?.[0]?.finish_reason === 'length'
    }
  } catch (err) {
    if (err instanceof LlmError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      // 取消和超时都是 AbortError，靠外部 signal 的状态区分，否则用户会看到
      // 「请求超时」这种误导性的提示
      if (external?.aborted) throw new LlmError('任务已取消。', undefined, true)
      throw new LlmError(`请求超时（${Math.round(timeoutMs / 1000)} 秒），可以换用更快的模型或缩短输入。`)
    }
    throw new LlmError(`网络请求失败：${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onAbort)
  }
}

function describeHttpError(status: number, text: string): string {
  let detail = text.slice(0, 400)
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; type?: string } }
    if (parsed.error?.message) detail = parsed.error.message
  } catch {
    /* 保留原始文本 */
  }
  const tips: Record<number, string> = {
    401: 'API Key 无效或已过期',
    403: '没有访问该模型的权限',
    404: 'Base URL 或模型名不对',
    429: '触发限流，稍后重试或降低并发'
  }
  const tip = tips[status] ? `（${tips[status]}）` : ''
  return `模型接口返回 ${status}${tip}：${detail}`
}

/**
 * 扫描出文本里所有「括号平衡」的 JSON 片段（字符串内的括号不计入）。
 * 需要它是因为部分中转服务的 JSON 模式会把 `{"type":"json_object"}` 这样的
 * 提示对象混进输出，简单取「第一个 { 到最后一个 }」会拼出非法 JSON。
 */
function balancedJsonSpans(text: string): string[] {
  const spans: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}' && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        spans.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return spans
}

/**
 * 修补被截断的 JSON：回退到最后一个「值完整」的位置，再补齐未闭合的括号。
 *
 * 推理型模型会把 reasoning token 算进 max_tokens，很容易把 JSON 尾部切掉。
 * 与其整篇失败，不如把已经生成的部分抢救出来。
 */
function repairTruncatedJson(raw: string): unknown | null {
  const start = raw.indexOf('{')
  if (start < 0) return null
  const text = raw.slice(start)

  let depth = 0
  let inString = false
  let escaped = false
  /**
   * 最后一个可以安全截断的位置：`}`、`]` 或 `,` 之后。
   * 截在这些位置后面，剩下的部分一定是合法的 JSON 前缀（可能带个悬挂逗号）。
   * 注意不能在「键名字符串」后截断——那会留下 { "key" 这种缺值的结构。
   */
  let cut = -1

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') {
      depth++
      continue
    }
    if (ch === '}' || ch === ']') {
      depth--
      cut = i + 1
      if (depth === 0) return null // 本来就闭合了，说明不是截断场景
      continue
    }
    if (ch === ',') cut = i + 1
  }

  if (cut < 0) return null
  let body = text.slice(0, cut).replace(/,\s*$/, '')

  // 补齐未闭合的括号
  const closers: string[] = []
  let str = false
  let esc = false
  for (const ch of body) {
    if (str) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') str = false
      continue
    }
    if (ch === '"') str = true
    else if (ch === '{') closers.push('}')
    else if (ch === '[') closers.push(']')
    else if (ch === '}' || ch === ']') closers.pop()
  }
  if (str) body += '"'
  body += closers.reverse().join('')

  try {
    const parsed = JSON.parse(body) as unknown
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 从模型输出里稳健地取出 JSON 对象 */
export function extractJson<T = unknown>(raw: string): T {
  const text = (raw ?? '').trim()
  const candidates: { value: unknown; keys: number }[] = []

  const consider = (source: string): void => {
    if (!source) return
    try {
      const parsed = JSON.parse(source) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        candidates.push({ value: parsed, keys: Object.keys(parsed as object).length })
      }
    } catch {
      /* 这个片段不是合法 JSON，换下一个 */
    }
  }

  consider(text)
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) consider(fence[1].trim())
  for (const span of balancedJsonSpans(text)) consider(span)

  // 最后一道防线：输出被 max_tokens 截断时，抢救已经生成的部分
  if (!candidates.length) {
    const repaired = repairTruncatedJson(text)
    if (repaired) return repaired as T
  }

  if (!candidates.length) {
    throw new LlmError(`无法解析模型返回的 JSON：${text.slice(0, 300)}`)
  }
  // 取「顶层键最多」的那个对象，避免误拿到前导提示对象
  candidates.sort((a, b) => b.keys - a.keys)
  return candidates[0].value as T
}

export async function testConnection(settings: LlmSettings): Promise<string> {
  const res = await chatCompletion(
    [
      { role: 'system', content: '你是一个测试助手，只回复一个词。' },
      { role: 'user', content: '请回复：ok' }
    ],
    settings,
    /*
     * 别用小 maxTokens：推理模型会把预算全花在思考上、正文为空，
     * 「测试连通」于是误报失败（实测 deepseek-v4-flash 在 16 token 下必空）。
     * 超时同理放宽 —— 推理模型的首字延迟本来就比普通模型长。
     */
    { maxTokens: 512, temperature: 0, timeoutMs: 60_000 }
  )
  return res.content.trim().slice(0, 50)
}
