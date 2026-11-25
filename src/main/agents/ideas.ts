/**
 * 选题 agent：针对开放问题池里的一个问题，结合出处论文的笔记、用户自己的想法、
 * 以及库里其他论文能借来用的东西，产出可验证的选题。
 *
 * 出处论文编号 P1…，库内其他论文编号 L1…，理由同 problems agent：编号比长 slug 好抄。
 */
import { normalizeIdeaDrafts, type ResearchIdea } from '@shared/ideas'
import type { OpenProblem } from '@shared/problems'
import type { LlmSettings } from '@shared/types'
import { chatCompletion, extractJson } from '../llm'

export interface IdeaSourcePaper {
  id: string
  title: string
  year: number | null
  /** 已经挑好、裁好的笔记片段：章节名 → 内容 */
  notes: Record<string, string>
  /** 用户本人的划线与想法 */
  thoughts: string[]
}

export interface IdeaLibraryPaper {
  id: string
  title: string
  oneLiner: string
}

export type IdeaDraft = Pick<
  ResearchIdea,
  'title' | 'hypothesis' | 'approach' | 'experiment' | 'falsifier' | 'gaps' | 'paperIds'
>

const SYSTEM = `你是一位严格的研究导师，帮研究生把一个开放问题落成能动手的选题。
原则：
1. 每个选题必须有**可证伪的假设**、**最小验证实验**（具体到数据集 / 基线 / 指标，越小越好，一两周能跑出信号）、
   **反证条件**（出现什么结果就说明这条路走不通）。三者缺一就不要输出这个选题。
2. 优先利用用户自己的想法和库里已有论文的方法做组合，而不是凭空发明；引用论文只能用给定编号。
3. 不要给「用更大的模型 / 更多数据」这类没有信息量的选题，除非问题本身就是规模瓶颈。
4. 和「已有选题」重复的不要再给。
5. 宁缺毋滥：想不出好的就少给，最多 3 个。
6. 输出必须是合法 JSON，不要代码块包裹。`

export async function runIdeaAgent(
  input: {
    problem: OpenProblem
    sources: IdeaSourcePaper[]
    library: IdeaLibraryPaper[]
    existing: string[]
  },
  llm: LlmSettings
): Promise<IdeaDraft[]> {
  const keyToId = new Map<string, string>()
  input.sources.forEach((p, i) => keyToId.set(`P${i + 1}`, p.id))
  input.library.forEach((p, i) => keyToId.set(`L${i + 1}`, p.id))

  const sources = input.sources
    .map((p, i) => {
      const parts = [`## P${i + 1}《${p.title}》（${p.year ?? '年份未知'}）`]
      for (const [key, value] of Object.entries(p.notes)) parts.push(`### ${key}\n${value}`)
      if (p.thoughts.length) {
        parts.push(`### 用户本人的划线与想法\n${p.thoughts.join('\n')}`)
      }
      return parts.join('\n')
    })
    .join('\n\n')
  const library = input.library.length
    ? input.library.map((p, i) => `- L${i + 1}《${p.title}》${p.oneLiner}`).join('\n')
    : '（无）'
  const existing = input.existing.length ? input.existing.map((t) => `- ${t}`).join('\n') : '（无）'

  const prompt = `# 开放问题
${input.problem.title}

${input.problem.detail}
${input.problem.direction ? `\n问题池给的切入方向：${input.problem.direction}` : ''}

# 已有选题（不要重复）
${existing}

# 输出 JSON
{
  "ideas": [
    {
      "title": "一句话选题",
      "hypothesis": "可证伪的核心假设",
      "approach": "怎么做：借哪篇的什么方法、改在哪里",
      "experiment": "最小验证实验：数据集 / 基线 / 指标 / 预期信号",
      "falsifier": "出现什么结果就说明假设不成立",
      "gaps": "开工前还缺什么（数据、算力、前置结论），没有就留空字符串",
      "papers": ["P1", "L2"]
    }
  ]
}

# 提出这个问题的论文
${sources}

# 库里其他可以借用的论文（标题 + 一句话总结）
${library}`

  const res = await chatCompletion(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt }
    ],
    llm,
    { json: true, temperature: 0.5, maxTokens: Math.max(llm.maxTokens ?? 0, 4096) }
  )
  const payload = (extractJson(res.content) ?? {}) as Record<string, unknown>
  return normalizeIdeaDrafts(payload.ideas, (ref) => {
    return keyToId.get(ref.toUpperCase().replace(/\s+/g, '')) ?? null
  })
}
