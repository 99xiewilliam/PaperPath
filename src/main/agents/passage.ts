/**
 * PDF 划词 agent：翻译 / 解读 / 追问。
 *
 * 论文背景与选段放进 **system** 而不是 user 消息：这是个多轮对话，
 * 放 system 里每一轮都能稳定拿到同样的上下文，而 history 只负责记
 * 「问过什么、答过什么」，不会被长文本挤掉。
 *
 * 走流式（onDelta）：划词是交互场景，用户盯着面板等，逐字出比干等整段
 * 体验好得多。注意流式不参与重试（增量已吐给用户，没法回滚）。
 */
import type { PassageAskMode, PassageMode } from '@shared/api'
import type { ChatMessage, LlmSettings } from '@shared/types'
import { chatCompletion } from '../llm'

export const PASSAGE_SYSTEM = `你是科研论文阅读助手。用户选中了论文里的一段原文，
你要针对这一段给出简短、直接、不绕弯的帮助。
只输出 Markdown，不要开场白，不要复述用户选中的原文。
用户可能会先让你翻译或解读，然后接着追问；追问时直接回答，
不要重复已经给过的翻译或解读。`

export interface PassageContext {
  paperTitle: string
  /** 论文的一句话总结，给模型一点上下文；没有就不带 */
  summary?: string
  passage: string
}

export function buildPassageSystem(ctx: PassageContext): string {
  return `${PASSAGE_SYSTEM}

# 论文
${ctx.paperTitle}${ctx.summary ? `\n一句话总结：${ctx.summary}` : ''}

# 用户选中的原文
${ctx.passage}`
}

/** 首轮指令（翻译 / 解读）。后续追问直接用用户的问题当消息。 */
export function buildPassageInstruction(mode: PassageMode): string {
  if (mode === 'translate') {
    return `把上面这段原文翻译成中文。

要求：
- 术语用领域内的通用译法；关键术语首次出现时用「中文（English）」标注
- 保留原句的逻辑关系（因果、让步、转折、限定），不要简化掉
- 直译优先，不要意译成概述
- 只输出译文`
  }

  return `解读上面这段原文：它在说什么，作者为什么要写这一句。

要求：
- 先用一句话说清这段在讲什么
- 再说明它在论证里的作用（提出了什么 / 反驳了什么 / 铺垫什么 / 设了什么限定条件）
- 如果这段有容易被误读或值得警惕的地方（绝对化的措辞、没说出口的前提、可能被过度宣称的结论），点出来
- 不要重复原文、不要整段翻译，控制在 4 行以内`
}

export interface PassageAgentInput extends PassageContext {
  mode: PassageAskMode
  /** mode === 'ask' 时的追问内容 */
  question?: string
  /** 之前的对话（由渲染层维护） */
  history?: ChatMessage[]
}

export async function runPassageAgent(
  input: PassageAgentInput,
  llm: LlmSettings,
  options: { signal?: AbortSignal; onDelta?: (delta: string) => void } = {}
): Promise<string> {
  const prompt =
    input.mode === 'ask' ? (input.question ?? '').trim() : buildPassageInstruction(input.mode)
  if (!prompt) throw new Error('请输入想问的内容。')

  const system = buildPassageSystem(input)
  const history = (input.history ?? []).filter((m) => m.role !== 'system')

  const res = await chatCompletion(
    [{ role: 'system', content: system }, ...history, { role: 'user', content: prompt }],
    llm,
    {
      // 翻译要稳（低温度），解读/追问要有点判断（略高）
      temperature: input.mode === 'translate' ? 0.2 : 0.45,
      // 刻意不设 maxTokens：推理型模型会把 reasoning 也算进这个预算，
      // 压低了就会出现「思考完但正文为空」。用设置里的值即可。
      onDelta: options.onDelta,
      signal: options.signal
    }
  )
  return res.content.trim()
}
