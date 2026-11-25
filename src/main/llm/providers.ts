/**
 * 接口协议 → 适配器。
 *
 * 接一家原生接口不同的厂商（Anthropic Messages、Gemini generateContent …）=
 * 写一个实现 LlmProvider 的文件 + 在这里登记 + 在 shared/types 的 LLM_PROVIDER_IDS 里加 id。
 * 重试、预算翻倍、取消、记账、工具循环都在上层，不用跟着改。
 */
import type { LlmProviderId, LlmSettings } from '@shared/types'
import { openaiCompatible } from './openai'
import type { LlmProvider } from './types'

const PROVIDERS: Record<LlmProviderId, LlmProvider> = {
  'openai-compatible': openaiCompatible
}

/** 没填或填了不认识的协议都退回 OpenAI 兼容：老配置、手写错的 .env 都不至于直接不能用 */
export function providerFor(settings: Pick<LlmSettings, 'provider'>): LlmProvider {
  return (settings.provider && PROVIDERS[settings.provider]) || openaiCompatible
}
