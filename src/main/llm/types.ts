/**
 * 模型调用层共用的类型。厂商无关：适配器把各家协议翻译成这里的形状。
 */
import type { ChatMessage, LlmSettings } from '@shared/types'

/** 给模型的一个可调用工具（OpenAI 兼容的 function calling） */
export interface LlmToolSpec {
  name: string
  description: string
  /** JSON Schema */
  parameters: Record<string, unknown>
}

/** 模型发起的一次工具调用；arguments 是模型给的 JSON 字符串，原样保留 */
export interface LlmToolCall {
  id: string
  name: string
  arguments: string
}

/**
 * 发给模型的消息。普通对话只用 ChatMessage；工具循环里多出两种：
 * 模型发起调用的那条 assistant 消息、以及回填结果的 tool 消息。
 */
export type LlmMessage =
  | ChatMessage
  | {
      role: 'assistant'
      content: string | null
      tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

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
 * 「空内容」的提示语。
 *
 * 必须同时点出两种可能，否则会把用户带偏：实测过「推理型模型 + 很小的 max_tokens」
 * 时，思考把输出预算占满、正文为空，而老文案只说「请检查模型名是否正确」——
 * 换服务商时看到它会以为模型名写错了，白折腾半天。
 */
export const EMPTY_CONTENT_HINT =
  '模型返回了空内容：可能是模型名不对，也可能是推理模型的思考把输出预算占满了。'

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
  /** 模型要求调用的工具；有它时 content 可以为空 */
  toolCalls?: LlmToolCall[]
}

/**
 * 一次已经定好参数的请求，交给适配器去发。
 *
 * 重试、预算翻倍、JSON 降级、取消信号的来源、记账这些策略都在上层（index.ts）
 * 定好再传下来 —— 适配器只管「把这次请求翻译成某家的协议、发出去、把响应翻译回来」，
 * 所以接一家新厂商不会把那些踩过的坑再踩一遍。
 */
export interface ProviderRequest {
  settings: LlmSettings
  messages: LlmMessage[]
  tools?: LlmToolSpec[]
  /** 要求严格 JSON 输出（不支持的厂商回 400 / 422，上层会降级重试） */
  json: boolean
  temperature: number
  maxTokens: number
  /**
   * 这次是「空内容后把预算翻倍」的重试。适配器据此让 maxTokens 压过用户在
   * 额外参数里写的同名字段 —— 平时则让用户的写法最后说话。
   */
  escalated: boolean
  timeoutMs: number
  signal?: AbortSignal | null
  /** 给了就走流式，每段正文增量回调一次 */
  onDelta?: (delta: string) => void
}

/**
 * 一种接口协议的适配器。
 *
 * 约定（上层的重试逻辑依赖它们）：
 * - 失败一律抛 LlmError，HTTP 错误带上 status（429 / 5xx 会被退避重试，400 / 422 触发 JSON 降级）；
 * - 用户取消抛 `new LlmError('任务已取消。', undefined, true)`，超时另给说明；
 * - 既没有正文也没有工具调用时抛 EMPTY_CONTENT_HINT（上层据此翻倍预算重试）。
 */
export interface LlmProvider {
  id: LlmSettings['provider'] & string
  complete(req: ProviderRequest): Promise<LlmResult>
}
