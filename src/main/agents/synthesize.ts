/**
 * 跨论文「套路归纳」agent：从一批同类论文的精读笔记里提炼通用套路手册。
 *
 * 产物是一篇新的 Markdown 笔记，但**落盘不归这里管**（ai-service 写文件、
 * 更新索引），这个 agent 只负责把材料变成内容。
 */
import type { LlmSettings } from '@shared/types'
import { chatCompletion } from '../llm'

export const SYNTHESIZE_SYSTEM = `你是一位科研写作与方法论教练。
用户会给你一批同一类别论文的结构化精读笔记，你要从中归纳出这一整类论文的「通用套路」。
要求：
1. 归纳必须来自给定材料，但可以横向对比、提炼共性；指出少数派做法时要标注是哪篇论文。
2. 输出纯 Markdown（不要 JSON、不要代码块包裹），可直接作为一篇笔记保存。
3. 明确给出「可操作清单」，让用户下一篇论文能照着做。
4. 语言克制专业，不要空泛的鼓励性表述。`

export interface SynthesizeInput {
  scopeLabel: string
  scopeType: 'category' | 'tag' | 'papers'
  focus?: string[]
  papers: {
    title: string
    year: number | null
    venue: string
    sections: Record<string, string>
  }[]
}

export const SYNTHESIS_SECTIONS = [
  '共性故事线',
  '写作套路 · Abstract',
  '写作套路 · Introduction',
  '写作套路 · Related Work',
  '写作套路 · Methodology',
  '写作套路 · Experiments',
  '图表设计共性',
  '英语短语共性',
  '实验方法论共性',
  '常见坑与检查清单',
  '代表论文对照表'
]

export function buildSynthesizePrompt(input: SynthesizeInput): string {
  const corpus = input.papers
    .map((p, i) => {
      const picked = Object.entries(p.sections)
        .filter(([, v]) => v && v.trim().length > 20)
        .map(([k, v]) => `  【${k}】\n${indent(v.trim(), '    ')}`)
        .join('\n')
      return `## [${i + 1}] ${p.title}（${p.year ?? '年份未知'}${p.venue ? ' · ' + p.venue : ''}）\n${picked}`
    })
    .join('\n\n')

  const focusText =
    input.focus && input.focus.length
      ? `\n# 本次只聚焦这些维度\n${input.focus.map((f) => `- ${f}`).join('\n')}`
      : ''

  return `# 任务
下面是用户在「${input.scopeLabel}」这个范畴下积累的 ${input.papers.length} 篇论文精读笔记。
请归纳出这一类论文的通用写作模式、图表设计习惯与实验方法论，形成一份可直接复用的「套路手册」。
${focusText}

# 输出结构（严格使用这些二级标题）
${SYNTHESIS_SECTIONS.map((s) => `## ${s}`).join('\n')}

其中：
- 「写作套路 · X」章节：总结这类论文在对应部分**通常怎么组织**，给出段落骨架、常用句式模板（可用英文句式），并标注反例。
- 「图表设计共性」：归纳这类论文惯用的图类型与表格组织方式，例如「主结果一律放 2×2 矩阵热图」「消融用折线看数据量曲线」。
- 「英语短语共性」：把各篇笔记里反复出现的英文短语合并去重，按功能分组，给出一个可直接取用的短语清单。
- 「实验方法论共性」需拆成三级标题：指标选择习惯 / 实验规模与次数 / 开源 vs 闭源模型选择 / 消融与鲁棒性实验，并给出统计性描述（例如「N 篇里有 M 篇报告了标准差」）。
- 「代表论文对照表」用 Markdown 表格，列为：论文 / 年份 / 核心贡献一句 / 数据集数 / 基线数 / 是否开源。
- 「常见坑与检查清单」用 Markdown 的复选框语法（方括号里留空的待办项）。

# 注意
- 如果某篇笔记信息缺失，不要让整段结论失效，标注「部分论文未报告」即可。
- 全文 1800-3000 字。

# 材料
${corpus}`
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l) => (l.trim() ? pad + l : l))
    .join('\n')
}

/** 归纳一批论文的套路，返回可直接落盘的 Markdown 正文 */
export async function runSynthesizeAgent(
  input: SynthesizeInput,
  llm: LlmSettings
): Promise<string> {
  const res = await chatCompletion(
    [
      { role: 'system', content: SYNTHESIZE_SYSTEM },
      { role: 'user', content: buildSynthesizePrompt(input) }
    ],
    llm,
    { temperature: 0.35, maxTokens: Math.max(llm.maxTokens, 6000) }
  )
  return res.content.trim()
}
