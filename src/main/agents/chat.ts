/**
 * 知识库问答 agent：基于用户选中的论文精读笔记回答问题，笔记不够时自己调工具去库里查。
 *
 * 状态全在渲染层（会话历史 + 压缩摘要），这里每轮都是无状态的一次「拼上下文 → 工具循环」：
 *   [system] → [选中论文的笔记 + 之前对话的摘要] → [最近几轮原文] → 本轮提问
 * 笔记放在最前且每轮不变，服务商的前缀缓存能命中；历史太长时只压缩较早的部分。
 *
 * 笔记挑选与预算控制（选哪几篇、超预算就截断）在 ai-service 里做。
 */
import type { ChatMemo, ChatScope } from '@shared/api'
import { SECTION_ORDER } from '@shared/template'
import type { ChatMessage, LlmSettings } from '@shared/types'
import type { ChatTool } from '../chat-tools'
import { chatCompletion, LlmError, type LlmMessage } from '../llm'

export const CHAT_SYSTEM = `你是用户的私人科研助理，服务于一个本地论文知识库。
你会收到用户选定论文的精读笔记作为上下文，还可以调用工具查库里的其他论文、笔记章节、PDF 原文、开放问题池和选题本。
要求：
1. 只依据给定上下文和工具查到的内容回答；都没有的信息，明确说「你的笔记里没有记录」，不要编造。
2. 上下文已经够用就直接回答，不要为了查而查；需要具体数字、设置、原文措辞，或问到选中范围以外的论文时再调工具。
3. 回答简洁、结构化，多用列表；需要对比时用表格。
4. 每条关键判断指明来自哪篇（工具查到的标明「原文」还是「笔记」）。
5. 如果用户问的是「我该怎么做」，给出可执行的具体建议。`

/** 工具循环最多几步；到了上限就不再给工具，逼模型用已有材料作答 */
const MAX_TOOL_STEPS = 5

/**
 * 历史压缩的阈值（字符）。超过就把较早的轮次压成摘要。
 * 刻意按字符而不是 token：各家 tokenizer 不同，中文 1 字约 1~2 token，按字符估足够保守。
 */
export const HISTORY_BUDGET = 24000
/** 一步里最多执行几个工具调用，多出来的留到下一步 */
const MAX_TOOL_CALLS = 4
/** 送去压缩时单条消息最多带多少字：几千字的长回答，摘要只需要它的结论 */
const FOLD_MESSAGE_CHARS = 4000

export interface ChatAgentPaper {
  id?: string
  title: string
  year: number | null
  categories: string[]
  sections: Record<string, string>
  /** 用户在 PDF 划线时写下的想法，一行一条 */
  thoughts?: string[]
}

export function buildChatContext(papers: ChatAgentPaper[]): string {
  return papers
    .map((p) => {
      const body = SECTION_ORDER.map((k) => {
        const v = (p.sections[k] ?? '').trim()
        return v ? `【${k}】\n${v}` : ''
      })
        .filter(Boolean)
        .join('\n')
      const thoughts = p.thoughts?.length
        ? `\n【用户本人的划线与想法（比 AI 笔记更能代表用户的判断）】\n${p.thoughts.join('\n')}`
        : ''
      const id = p.id ? ` · id: ${p.id}` : ''
      return `# ${p.title}（${p.year ?? '年份未知'}）${id}\n${body}${thoughts}`
    })
    .join('\n\n---\n\n')
}

function charsOf(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + m.content.length, 0)
}

/**
 * 决定这一轮要不要压缩、从哪里切。纯函数，不调模型。
 *
 * 切点必须落在 user 消息上：保留下来的历史以 assistant 开头，模型会以为
 * 那是对「摘要」的回答，接下来的对话会错位。
 * 只看字数、不看条数：两三条很长的回答一样会超预算。
 * 已经压过一次也要能再压 —— 切点落在上次的 upTo 之后，把新长出来的部分折进去。
 * 返回 null 表示不用压缩（没超预算，或只剩当前这一问、无处可切）。
 */
export function planCompaction(
  messages: ChatMessage[],
  memo?: ChatMemo
): { from: number; cut: number } | null {
  const from = Math.min(Math.max(memo?.upTo ?? 0, 0), Math.max(messages.length - 1, 0))
  if (charsOf(messages.slice(from)) <= HISTORY_BUDGET) return null

  const cuts = messages
    .map((m, i) => (i > from && m.role === 'user' ? i : -1))
    .filter((i) => i >= 0)
  if (!cuts.length) return null
  // 在不超预算的前提下尽量多留原文；都超就只留最近这一问
  const fitting = cuts.filter((i) => charsOf(messages.slice(i)) <= HISTORY_BUDGET)
  return { from, cut: fitting[0] ?? cuts[cuts.length - 1] }
}

const COMPACT_SYSTEM = `你负责把一段科研问答压缩成给自己看的备忘，之后的对话只能看到这份备忘。
保留：用户想解决的问题与偏好、已经得出的结论（带上论文名和关键数字）、做过的决定、还没解决的问题。
去掉：寒暄、重复、已经被推翻的说法、可以从论文笔记里重新查到的大段细节。
用条目写，不超过 1200 字。只输出备忘本身。`

async function compact(
  previous: string | undefined,
  folded: ChatMessage[],
  llm: LlmSettings,
  signal?: AbortSignal
): Promise<string> {
  const transcript = folded
    .map((m) => {
      const text =
        m.content.length > FOLD_MESSAGE_CHARS
          ? `${m.content.slice(0, FOLD_MESSAGE_CHARS)}…`
          : m.content
      return `【${m.role === 'user' ? '用户' : '助理'}】${text}`
    })
    .join('\n\n')
  const res = await chatCompletion(
    [
      { role: 'system', content: COMPACT_SYSTEM },
      {
        role: 'user',
        content: `${previous ? `# 已有备忘（更早的对话）\n${previous}\n\n` : ''}# 需要并入备忘的对话\n${transcript}`
      }
    ],
    llm,
    { temperature: 0.2, label: 'chat:compact', signal }
  )
  return res.content.trim()
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export interface ChatAgentResult {
  content: string
  /** 这一轮新生成的摘要（没压缩就没有） */
  memo?: ChatMemo
  trace: string[]
}

/**
 * 备忘已经压好、但后面的回答失败了。
 * 把备忘带出去，调用方存上，下一轮不必把同一段历史再压一遍。
 */
export class ChatTurnError extends Error {
  constructor(
    message: string,
    readonly memo?: ChatMemo
  ) {
    super(message)
    this.name = 'ChatTurnError'
  }
}

export async function runChatAgent(
  input: {
    papers: ChatAgentPaper[]
    messages: ChatMessage[]
    scope?: ChatScope
    memo?: ChatMemo
    /** 用户选了、但笔记太长没放进上下文的论文标题 */
    omitted?: string[]
    tools?: ChatTool[]
  },
  llm: LlmSettings,
  options: {
    signal?: AbortSignal
    onDelta?: (delta: string) => void
    onStatus?: (status: string) => void
  } = {}
): Promise<ChatAgentResult> {
  const { signal, onDelta, onStatus } = options

  let memo = input.memo
  let fresh: ChatMemo | undefined
  const plan = planCompaction(input.messages, memo)
  if (plan) {
    onStatus?.('对话有点长了，正在整理前面的要点…')
    const text = await compact(memo?.text, input.messages.slice(plan.from, plan.cut), llm, signal)
    memo = fresh = { text, upTo: plan.cut }
  }
  const start = Math.min(Math.max(memo?.upTo ?? 0, 0), Math.max(input.messages.length - 1, 0))
  const history = input.messages.slice(start)

  const scopeBlock = input.scope?.title
    ? `# 当前分析范围：专题《${input.scope.title}》
${input.scope.description ? `${input.scope.description}\n` : ''}
这组论文是用户手动归到一起的。请把它们当作一个整体来分析：找共性与分歧、方法上的演进或对照、以及能拼成新题目的研究空白。指明每条判断来自哪几篇笔记。
`
    : ''
  const omittedBlock = input.omitted?.length
    ? `\n\n# 用户还选了这些论文，但笔记太长，这次没有放进来。需要时用工具去查：\n${input.omitted.map((t) => `- 《${t}》`).join('\n')}`
    : ''
  const notes = input.papers.length
    ? `${scopeBlock}# 用户的知识库笔记\n\n${buildChatContext(input.papers)}${omittedBlock}`
    : `# 用户没有选中任何论文。需要材料时用 search_library 去库里找。${omittedBlock}`
  const memoBlock = memo?.text
    ? `\n\n# 之前对话的备忘（更早的轮次已压缩，以下是要点）\n${memo.text}`
    : ''

  const messages: LlmMessage[] = [
    { role: 'system', content: CHAT_SYSTEM },
    { role: 'user', content: `${notes}${memoBlock}` },
    ...history
  ]

  const tools = input.tools ?? []
  const byName = new Map(tools.map((t) => [t.spec.name, t]))
  const trace: string[] = []
  const parts: string[] = []
  let streamed = false
  const emit = (delta: string): void => {
    streamed = true
    onDelta?.(delta)
  }
  let toolsUsable = tools.length > 0

  try {
    for (let step = 0; ; step++) {
      const offerTools = toolsUsable && step < MAX_TOOL_STEPS
      let res
      try {
        res = await chatCompletion(messages, llm, {
          temperature: 0.4,
          label: 'chat',
          signal,
          onDelta: onDelta ? emit : undefined,
          tools: offerTools ? tools.map((t) => t.spec) : undefined
        })
      } catch (err) {
        /*
         * 不支持 function calling 的服务商会对 tools 字段回 400。
         * 还没吐出任何字时退回「不带工具」再问一次 —— 问答本身不该因为工具不可用而失败。
         */
        if (
          offerTools &&
          !streamed &&
          err instanceof LlmError &&
          (err.status === 400 || err.status === 422)
        ) {
          toolsUsable = false
          step--
          continue
        }
        throw err
      }

      if (res.content.trim()) parts.push(res.content.trim())
      if (!res.toolCalls?.length || !offerTools) break

      messages.push({
        role: 'assistant',
        content: res.content || null,
        tool_calls: res.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments }
        }))
      })
      for (const [index, call] of res.toolCalls.entries()) {
        const tool = byName.get(call.name)
        const args = parseArgs(call.arguments)
        let result: string
        if (index >= MAX_TOOL_CALLS) {
          result = `这一步只执行前 ${MAX_TOOL_CALLS} 个工具调用，这个被跳过了。还需要的话下一步再调。`
        } else if (!tool) {
          result = `没有名为 ${call.name} 的工具。`
        } else {
          const label = tool.describe(args)
          trace.push(label)
          onStatus?.(`正在${label}`)
          try {
            result = tool.run(args)
          } catch (err) {
            result = `工具出错：${err instanceof Error ? err.message : String(err)}`
          }
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result })
      }
      // 下一步的正文和这一步「我先查一下」之类的话分段，流式显示和最终存档一致
      if (res.content.trim()) emit('\n\n')
    }

    const content = parts.join('\n\n').trim()
    if (!content) throw new LlmError('模型查完资料后没有给出回答，换个问法再试一次。')
    return { content, memo: fresh, trace }
  } catch (err) {
    if (!fresh) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new ChatTurnError(message, fresh)
  }
}
