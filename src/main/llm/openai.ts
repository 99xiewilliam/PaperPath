/**
 * OpenAI 兼容协议（/chat/completions）的适配器。
 *
 * 智谱、DeepSeek、通义、各类中转都走它。服务商特有的开关
 * （智谱的 `thinking`、通义的 `enable_thinking` …）由 settings.extraBody 原样并进请求体。
 */
import {
  EMPTY_CONTENT_HINT,
  LlmError,
  type LlmProvider,
  type LlmResult,
  type LlmToolCall,
  type ProviderRequest
} from './types'

function endpointOf(baseUrl: string): string {
  const b = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!b) throw new LlmError('尚未配置 API Base URL，请到「设置」里填写。')
  if (/\/chat\/completions$/.test(b)) return b
  if (/\/v\d+$/.test(b)) return `${b}/chat/completions`
  return `${b}/v1/chat/completions`
}

interface RawToolCall {
  id?: string
  function?: { name?: string; arguments?: string | Record<string, unknown> }
}

interface StreamToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

/** 有的服务商把 arguments 直接给成对象而不是 JSON 字符串，统一成字符串 */
function toolCallOf(raw: RawToolCall, index: number): LlmToolCall {
  const args = raw.function?.arguments
  return {
    id: raw.id || `call_${index}`,
    name: raw.function?.name ?? '',
    arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {})
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
    let finishReason = ''
    let usage: LlmResult['usage']
    /** 工具调用按 index 分片到达：第一片带 id 和函数名，后面只追加 arguments */
    const calls = new Map<number, LlmToolCall>()

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
            choices?: {
              delta?: { content?: string; tool_calls?: StreamToolCallDelta[] }
              message?: { content?: string; tool_calls?: RawToolCall[] }
              finish_reason?: string | null
            }[]
            usage?: LlmResult['usage']
            error?: { message?: string }
          }
          if (parsed.error?.message) throw new LlmError(parsed.error.message)
          if (parsed.usage) usage = parsed.usage
          const head = parsed.choices?.[0]
          if (head?.finish_reason) finishReason = head.finish_reason
          for (const piece of head?.delta?.tool_calls ?? []) {
            const index = piece.index ?? calls.size
            const call = calls.get(index) ?? { id: '', name: '', arguments: '' }
            if (piece.id) call.id = piece.id
            if (piece.function?.name) call.name += piece.function.name
            if (piece.function?.arguments) call.arguments += piece.function.arguments
            calls.set(index, call)
          }
          if (!calls.size && head?.message?.tool_calls?.length) {
            head.message.tool_calls.forEach((c, i) => calls.set(i, toolCallOf(c, i)))
          }
          /*
           * 绝大多数服务商走 delta；也有不切片的（部分网关直接把整段放在
           * message.content 里）。后者只在这条流还一个字都没收到时才认 ——
           * 否则服务商若在最后一帧补一个累计的 message，正文会被整段重复一遍。
           */
          const choice = parsed.choices?.[0]
          const delta = choice?.delta?.content ?? (content ? '' : (choice?.message?.content ?? ''))
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

    const toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, c]) => ({ ...c, id: c.id || `call_${i}` }))
      .filter((c) => c.name)
    if (!content.trim() && !toolCalls.length) {
      throw new LlmError(EMPTY_CONTENT_HINT)
    }
    return {
      content,
      usage,
      truncated: finishReason === 'length',
      ...(toolCalls.length ? { toolCalls } : {})
    }
  } catch (err) {
    if (err instanceof LlmError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      if (external?.aborted) throw new LlmError('任务已取消。', undefined, true)
      throw new LlmError(
        `请求超时（${Math.round(timeoutMs / 1000)} 秒），可以换用更快的模型或缩短输入。`
      )
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
      choices?: {
        message?: { content?: string | null; tool_calls?: RawToolCall[] }
        finish_reason?: string
      }[]
      usage?: LlmResult['usage']
      error?: { message?: string }
    }
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new LlmError(`接口返回了非 JSON 内容：${text.slice(0, 300)}`)
    }
    if (parsed.error?.message) throw new LlmError(parsed.error.message)

    const message = parsed.choices?.[0]?.message
    const toolCalls = (message?.tool_calls ?? []).map(toolCallOf).filter((c) => c.name)
    const content = typeof message?.content === 'string' ? message.content : ''
    if (!content.trim() && !toolCalls.length) {
      throw new LlmError(EMPTY_CONTENT_HINT)
    }
    return {
      content,
      usage: parsed.usage,
      truncated: parsed.choices?.[0]?.finish_reason === 'length',
      ...(toolCalls.length ? { toolCalls } : {})
    }
  } catch (err) {
    if (err instanceof LlmError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      // 取消和超时都是 AbortError，靠外部 signal 的状态区分，否则用户会看到
      // 「请求超时」这种误导性的提示
      if (external?.aborted) throw new LlmError('任务已取消。', undefined, true)
      throw new LlmError(
        `请求超时（${Math.round(timeoutMs / 1000)} 秒），可以换用更快的模型或缩短输入。`
      )
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

export const openaiCompatible: LlmProvider = {
  id: 'openai-compatible',
  complete(req: ProviderRequest): Promise<LlmResult> {
    const { settings } = req
    const url = endpointOf(settings.baseUrl)
    const body: Record<string, unknown> = {
      model: settings.model.trim(),
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stream: !!req.onDelta,
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({ type: 'function', function: t })),
            tool_choice: 'auto'
          }
        : {}),
      /*
       * 服务商特有的开关不在 OpenAI 兼容协议里，由 .env 的 PAPERVAULT_LLM_EXTRA_BODY 提供。
       * 放在最后展开，所以它也能覆盖上面的默认值。
       */
      ...(settings.extraBody ?? {})
    }
    // 只有「空内容 → 预算翻倍」的重试才压过 extraBody 里可能写的 max_tokens
    if (req.escalated) body.max_tokens = req.maxTokens
    if (req.json) body.response_format = { type: 'json_object' }
    return req.onDelta
      ? requestStream(url, body, settings.apiKey, req.timeoutMs, req.signal, req.onDelta)
      : request(url, body, settings.apiKey, req.timeoutMs, req.signal)
  }
}
