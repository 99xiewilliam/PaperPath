/**
 * 单章节重写 agent。
 *
 * 重写会复用「拥有这一节的维度」的 system prompt 来保证口径一致（由调用方
 * 查好传进来），但那些 system prompt 末尾都带着「只输出一个合法 JSON 对象」
 * 的抽取约束 —— 所以本 agent 必须追加 REWRITE_FORMAT_OVERRIDE 压住它，
 * 否则模型会把正文包成 {"content": "..."} 返回（曾经就这么把 JSON 落进了笔记）。
 */
import { sectionSpec } from '@shared/template'
import type { LlmSettings } from '@shared/types'
import { chatCompletion } from '../llm'
import { sectionRulesFor } from '../lenses/writing'

export const REWRITE_FORMAT_OVERRIDE = `# 本次任务的输出格式（覆盖上文所有关于 JSON 的要求）
你这次的任务是**重写单个章节的正文**，不是做结构化抽取。
只输出该章节的 Markdown 正文本身：
- 不要输出 JSON，不要输出任何花括号包裹的对象
- 不要用 markdown 代码块包裹
- 不要加「## 章节名」这类二级标题
- 不要任何解释性的开场白或结束语`

/**
 * 收尾处理模型输出。提示词侧已经加了 REWRITE_FORMAT_OVERRIDE，但模型不总听话，
 * 所以这里再兜一层：
 *   1. 剥掉整体包裹的 markdown 代码块
 *   2. 若解析出 JSON，取其中的正文字段——注意 JSON.parse 会把 `\n` 还原成真正的
 *      换行，这正是「屏幕上满屏字面 \n」的成因，所以必须走解析而不是正则去壳
 *   3. 都不匹配就原样返回（合法的 Markdown 正文不该被改动）
 */
export function normalizeSectionRewrite(raw: string): string {
  let text = (raw ?? '').trim()
  if (!text) return ''

  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(text)
  if (fence) text = fence[1].trim()

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const picked = pickRewriteText(JSON.parse(text) as unknown)
      if (picked) return picked
    } catch {
      /* 不是合法 JSON，按正文处理 */
    }
  }
  return text
}

/** 从被误包成 JSON 的返回值里取出正文 */
function pickRewriteText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null

  // 有些模型会把正文按段落拆成数组
  if (Array.isArray(value)) {
    const parts = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    return parts.length ? parts.join('\n').trim() : null
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of ['content', 'markdown', 'text', 'body', 'section', 'result', 'rewritten']) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    // 键名是模型自己取的、只有一个字符串字段时也接受。
    // 要求恰好一个键，避免把合法的 JSON 型笔记内容误当成包装层。
    const keys = Object.keys(obj)
    if (keys.length === 1 && typeof obj[keys[0]] === 'string') {
      return String(obj[keys[0]]).trim() || null
    }
  }
  return null
}

export function buildSectionRewritePrompt(
  paperTitle: string,
  sectionKey: string,
  currentContent: string,
  fullText: string,
  extraInstruction?: string
): string {
  const spec = sectionSpec(sectionKey)
  // 与精读同源的「本节特有角度」（贡献段逐条拆 / 条目边界这类）；
  // 非写作章节没有专属规则，这里自然为空。
  const rules = sectionRulesFor(sectionKey)
  return `# 任务
针对论文《${paperTitle}》，重写笔记中的「${sectionKey}」章节。

# 该章节的填写要求
${spec?.hint ?? ''}
建议结构：
${spec?.scaffold ?? ''}${
    rules.length
      ? `

# 本节的特别注意
${rules.join('\n')}`
      : ''
  }

# 当前内容（可能不完整或有误）
${currentContent || '（空）'}

# 附加要求
${extraInstruction || '（无）'}
请只输出重写后的该章节 Markdown 内容本身，不要加二级标题、不要加任何解释性文字。

# 论文正文
${fullText}`
}

export interface RewriteAgentInput {
  /** 拥有该章节的那个维度的 system prompt（保证重写口径与精读一致） */
  ownerSystem: string
  paperTitle: string
  sectionKey: string
  currentContent: string
  /** 原文材料（章节片段或全文） */
  sourceText: string
  instruction?: string
}

/** 重写一个章节；模型没返回可用内容时返回空串，由调用方决定报错文案 */
export async function runRewriteAgent(
  input: RewriteAgentInput,
  llm: LlmSettings
): Promise<string> {
  const res = await chatCompletion(
    [
      { role: 'system', content: `${input.ownerSystem}\n\n${REWRITE_FORMAT_OVERRIDE}` },
      {
        role: 'user',
        content: buildSectionRewritePrompt(
          input.paperTitle,
          input.sectionKey,
          input.currentContent,
          input.sourceText,
          input.instruction
        )
      }
    ],
    llm,
    { temperature: 0.4 }
  )
  return normalizeSectionRewrite(res.content)
}
