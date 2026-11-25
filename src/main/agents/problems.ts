/**
 * 开放问题池 agent：把多篇论文的「局限与未来工作」聚成一份问题清单。
 *
 * 论文在 prompt 里用 P1、P2… 编号而不是真实 id：id 是长串 slug，
 * 让模型照抄很容易抄错一个字符，编号映射回去更稳。
 */
import { normalizeProblems, type OpenProblem } from '@shared/problems'
import type { LlmSettings } from '@shared/types'
import { chatCompletion, extractJson } from '../llm'

export interface ProblemAgentPaper {
  id: string
  title: string
  year: number | null
  limitations: string
}

const SYSTEM = `你是一位帮研究生找选题的导师。你会拿到一批论文各自的「局限与未来工作」笔记，
你的任务是跨论文找出**反复出现、尚未解决**的问题，并判断哪些值得做成新课题。
原则：
1. 合并说的是同一件事的问题，哪怕各篇用词不同；只出现在一篇里的问题也可以保留，但要排在后面。
2. 每个问题都必须写明出自哪几篇论文（用给定的编号），不要引用不存在的编号。
3. 「可以怎么切入」要具体到能动手：补什么实验、换什么设定、组合哪两篇的做法。想不出就留空，不要硬编。
4. 不要罗列泛泛的问题（例如「数据集可以更大」），除非多篇论文都把它当作核心瓶颈。
5. 输出必须是合法 JSON，不要代码块包裹。`

export async function runProblemAgent(
  input: { papers: ProblemAgentPaper[]; scopeTitle: string },
  llm: LlmSettings
): Promise<{ summary: string; problems: OpenProblem[] }> {
  const keyToId = new Map(input.papers.map((p, i) => [`P${i + 1}`, p.id]))
  const body = input.papers
    .map((p, i) => `## P${i + 1}《${p.title}》（${p.year ?? '年份未知'}）\n${p.limitations}`)
    .join('\n\n')

  const prompt = `# 任务
下面是「${input.scopeTitle}」范围内 ${input.papers.length} 篇论文的「局限与未来工作」笔记。
请聚类出其中的开放问题，按「被越多论文提到、越接近核心瓶颈」排序，最多 12 个。

# 输出 JSON
{
  "summary": "两三句话：这批论文的问题主要集中在哪，哪一类最值得投入",
  "problems": [
    {
      "title": "一句话问题",
      "detail": "为什么是问题；各篇分别怎么说（引用编号，如 P1、P3）",
      "source": "author | reviewer | both（作者自陈 / 审稿视角发现 / 两者都有）",
      "papers": ["P1", "P3"],
      "direction": "可以怎么切入，没有就留空字符串"
    }
  ]
}

# 各论文的局限与未来工作
${body}`

  const res = await chatCompletion(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt }
    ],
    llm,
    { json: true, temperature: 0.3, maxTokens: Math.max(llm.maxTokens ?? 0, 6144) }
  )
  const payload = (extractJson(res.content) ?? {}) as Record<string, unknown>
  const problems = normalizeProblems(payload.problems, (ref) => {
    const key = ref.toUpperCase().replace(/\s+/g, '')
    return keyToId.get(key) ?? null
  })
  return { summary: String(payload.summary ?? '').trim(), problems }
}
