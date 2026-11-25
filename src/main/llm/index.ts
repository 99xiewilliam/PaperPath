/**
 * 模型调用的统一入口。
 *
 * 分两层：
 * - 这里是**策略层**，与厂商无关：退避重试、空内容时翻倍预算、JSON 降级、取消信号、记账；
 * - 各家协议的翻译在适配器里（openai.ts …，由 providers.ts 按 settings.provider 选）。
 *
 * 调用方只认 `chatCompletion` / `extractJson` / `LlmError` 这些名字，换厂商不影响它们。
 */
import type { LlmSettings } from '@shared/types'
import { currentSignal } from '../tasks'
import { providerFor } from './providers'
import { LlmError, type LlmMessage, type LlmResult, type LlmToolSpec } from './types'

export { extractJson } from './json'
export {
  EMPTY_CONTENT_HINT,
  LlmError,
  type LlmMessage,
  type LlmProvider,
  type LlmResult,
  type LlmToolCall,
  type LlmToolSpec,
  type ProviderRequest
} from './types'

export interface LlmCallOptions {
  /** 给了就带上 function calling；模型可以返回 toolCalls 而不写正文 */
  tools?: LlmToolSpec[]
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
  /**
   * 调用方标识（`lens:method` / `agent:quiz` / `chat`），进观测记录。
   * 漏填的会以「未标注」出现在记录里 —— 刻意显眼，便于发现新增调用忘了标注。
   */
  label?: string
  /**
   * 本次调用结束后回调一条事实记录，**成功与失败都会回调一次**。
   *
   * 为什么走回调而不是塞进返回值：返回值形状被 20 多个调用点依赖，动它得全改一遍；
   * 而记账只有少数调用方（精读链路）真的需要。而且失败路径上拿不到返回值 ——
   * 失败的调用同样计费，恰恰是最该被记下来的那部分。
   */
  onCall?: (record: LlmCallRecord) => void
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
 * 单次模型调用的事实记录。
 *
 * 为什么需要它：`usage` 一直从接口拿得到，但拿到就丢了 —— 于是「这次精读花了多少」
 * 「哪个维度最费钱」「重试了几次」全都答不上来，批量精读前也无法预估花费。
 *
 * 刻意**不记 prompt 正文**：原文和笔记已经发给了模型服务商，但没有理由再往本地
 * 记录里抄一份（体积大，而且这些内容本来就属于用户）。要定位「哪一版 prompt」时，
 * system 指纹足够。
 */
export interface LlmCallRecord {
  /** 调用方标识（`lens:method` / `agent:quiz`）；漏填的显示成「未标注」 */
  label: string
  model: string
  /** system prompt 指纹，见 promptFingerprint */
  prompt: string
  /** 端到端耗时，含重试与退避等待 */
  elapsedMs: number
  /** 实际发出的请求次数（>1 说明重试过） */
  requests: number
  promptTokens?: number
  completionTokens?: number
  /** 输出撞到 max_tokens 被截断 */
  truncated: boolean
  ok: boolean
  /** 失败原因（成功时为空） */
  error?: string
}

/**
 * system prompt 的内容指纹（FNV-1a，8 位十六进制）。
 *
 * 为什么用内容哈希而不是手工版本号：手工维护的版本号一定会忘记加，而内容哈希天然
 * 反映「这一版 prompt 到底长什么样」。改了 prompt，记录里的指纹自动就变了 ——
 * 在此之前，换完 prompt 你无法判断质量变化到底来自 prompt 还是模型。
 *
 * 只取 system 部分：user 消息里装的是论文原文，每次都不同，当不了版本标识。
 */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

function promptFingerprint(messages: LlmMessage[]): string {
  return fingerprint(messages.find((m) => m.role === 'system')?.content ?? '')
}
export async function chatCompletion(
  messages: LlmMessage[],
  settings: LlmSettings,
  options: LlmCallOptions = {}
): Promise<LlmResult> {
  if (!settings.apiKey?.trim()) {
    throw new LlmError('尚未配置 API Key，请到「设置」里填写后再试。')
  }
  if (!settings.model?.trim()) {
    throw new LlmError('尚未配置模型名，请到「设置」里填写。')
  }

  const provider = providerFor(settings)
  /** 本次调用的输出预算。空内容重试要在这个数的基础上翻倍，所以先留一份。 */
  const maxTokens = options.maxTokens ?? settings.maxTokens ?? 4096
  const temperature = options.temperature ?? settings.temperature ?? 0.3

  // 队列保证同一时刻只有一个任务在跑，所以这里取到的就是本任务自己的 signal
  const signal = options.signal ?? currentSignal()
  if (signal?.aborted) throw new LlmError('任务已取消。', undefined, true)

  /** 本次逻辑调用开始时计时；重试属于同一笔调用，计时不重置 */
  const startedAt = Date.now()
  /** 实际发出的请求数：退避重试、JSON 降级、空内容重试都会让这里加一 */
  let requests = 0

  const attempt = async (withJson: boolean, escalateTo?: number): Promise<LlmResult> => {
    requests++
    return provider.complete({
      settings,
      messages,
      tools: options.tools?.length ? options.tools : undefined,
      json: withJson,
      temperature,
      maxTokens: escalateTo ?? maxTokens,
      escalated: escalateTo != null,
      timeoutMs: options.timeoutMs ?? 300_000,
      signal,
      onDelta: options.onDelta
    })
  }

  let done: LlmResult | null = null
  let failure: unknown = null

  /*
   * 两层 try 是必要的：内层承载重试逻辑（有多个 return 出口），外层只为保证
   * 「无论从哪个出口离开，都上报一次调用记录」。合并成一层的话，内层那些
   * return 就都绕过了记账。
   */
  try {
    try {
      done = await attempt(!!options.json)
      return done
    } catch (err) {
      // 用户取消就不要继续重试了，否则点了「取消」还在偷偷发请求
      if (err instanceof LlmError && err.cancelled) throw err
      // 流式同理：已经吐出去的增量追不回来，重试会让用户看到重复内容
      if (options.onDelta) throw err
      if (err instanceof LlmError && err.message.includes('空内容')) {
        /*
         * 推理型模型把输出预算全花在 reasoning 上，正文为空。
         *
         * **原样重发是没有意义的**：预算没变，思考照样吃掉全部。实测连续两次空
         * （记录里 requests=2 / failed=1，两笔都空）—— 那一次白等 60~90 秒，
         * 用户还得多花一笔钱。所以重试要把预算翻倍，给正文留出空间。
         *
         * 翻倍有可能撞上模型自己的 max_tokens 上限（各家不同，小模型尤其低），
         * 那时把两条原因一起报出去 —— 只说「400 参数非法」会看不出真正的问题是预算不够。
         */
        const doubled = maxTokens * 2
        try {
          done = await attempt(!!options.json, doubled)
          return done
        } catch (retryErr) {
          if (retryErr instanceof LlmError && retryErr.cancelled) throw retryErr
          const reason = retryErr instanceof Error ? retryErr.message : String(retryErr)
          throw new LlmError(
            reason === err.message
              ? `${err.message}（已把预算翻倍到 ${doubled} 重试，仍然为空）`
              : `${err.message}（已把预算翻倍到 ${doubled} 重试：${reason}）`,
            err.status
          )
        }
      }
      // 部分服务商不支持 response_format，降级重试一次
      if (options.json && err instanceof LlmError && (err.status === 400 || err.status === 422)) {
        done = await attempt(false)
        return done
      }
      if (!(err instanceof LlmError) || !isTransientStatus(err.status)) throw err

      // 限流 / 网关 5xx：退避重试，每次重试前重新看一眼取消信号
      let last: LlmError = err
      for (const waitMs of RETRY_BACKOFF_MS) {
        await sleep(waitMs, signal)
        if (signal?.aborted) throw new LlmError('任务已取消。', undefined, true)
        try {
          done = await attempt(!!options.json)
          return done
        } catch (retryErr) {
          if (retryErr instanceof LlmError && retryErr.cancelled) throw retryErr
          // 这次错的和上次不是一回事（比如换成了 401），重试下去没意义
          if (!(retryErr instanceof LlmError) || !isTransientStatus(retryErr.status)) throw retryErr
          last = retryErr
        }
      }
      throw last
    }
  } catch (err) {
    failure = err
    throw err
  } finally {
    /*
     * 成功与失败都上报一笔。失败那笔尤其重要 —— 它照样计费，而且
     * 「跑了半天一条记录都没有」正是过去最难排查的情形。
     */
    options.onCall?.({
      label: options.label ?? '未标注',
      model: settings.model?.trim() ?? '',
      prompt: promptFingerprint(messages),
      elapsedMs: Date.now() - startedAt,
      requests,
      promptTokens: done?.usage?.prompt_tokens,
      completionTokens: done?.usage?.completion_tokens,
      truncated: done?.truncated === true,
      ok: !failure,
      error: failure instanceof Error ? failure.message : failure ? String(failure) : undefined
    })
  }
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
