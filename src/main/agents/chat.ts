/**
 * 知识库问答 agent：基于用户选中的论文精读笔记回答问题。
 *
 * 笔记挑选与预算控制（选哪几篇、超预算就截断）在 ai-service 里做，
 * 这个 agent 只管「把这些笔记 + 对话记录变成一次问答调用」。
 */
import { SECTION_ORDER } from '@shared/template'
import type { ChatMessage, LlmSettings } from '@shared/types'
import { chatCompletion } from '../llm'

export const CHAT_SYSTEM = `你是用户的私人科研助理，服务于一个本地论文知识库。
你会收到用户选定论文的精读笔记作为上下文。
要求：
1. 只依据给定上下文回答；上下文里没有的信息，明确说「你的笔记里没有记录」，不要编造。
2. 回答简洁、结构化，多用列表；需要对比时用表格。
3. 如果用户问的是「我该怎么做」，给出可执行的具体建议，并指明建议来自哪篇笔记。`

export interface ChatAgentPaper {
  title: string
  year: number | null
  categories: string[]
  sections: Record<string, string>
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
      return `# ${p.title}（${p.year ?? '年份未知'}）\n${body}`
    })
    .join('\n\n---\n\n')
}

export async function runChatAgent(
  input: { papers: ChatAgentPaper[]; messages: ChatMessage[] },
  llm: LlmSettings
): Promise<string> {
  const context = input.papers.length
    ? `# 用户的知识库笔记\n\n${buildChatContext(input.papers)}`
    : '# 用户没有选中任何论文，请先提示他选择论文或在问题里说明。'

  const res = await chatCompletion(
    [
      { role: 'system', content: CHAT_SYSTEM },
      { role: 'user', content: context },
      ...input.messages
    ],
    llm,
    { temperature: 0.4 }
  )
  return res.content.trim()
}
