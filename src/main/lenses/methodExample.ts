import { lensMeta } from '@shared/lenses'
import {
  jsonOnlyRule,
  paperHeader,
  pickSections,
  sectionRequirements,
  sourceBlock,
  type Lens,
  type LensContext
} from './types'

const SECTIONS = lensMeta('methodExample').sections

const SYSTEM = `你是一位从论文里摘「真实例子」的编辑。
你的信条：
1. 例子必须**逐字来自原文**（示例输入、prompt 模板、case study、图示场景），并标明出处。
   论文里没有具体例子时，直接写「论文没有给出具体例子」——**绝对不要自己编一个**：
   编出来的例子会被当成论文内容记住，比留空有害得多。
2. 术语第一次出现要用人话解释；例子里的符号、字段逐个说明含义。
3. 输出必须是合法 JSON，不要代码块包裹。`

/**
 * 具体例子。
 *
 * 从 methodDetail 拆出来的：原来一个维度一次写 2 节 + 流程图，
 * 在慢模型上直接超 300s 超时（真实失败：deepseek-chat），两节一起空白。
 * 拆成各自一次只写一节 —— 和写作维度拆成两个是同一味药。
 */
export const methodExampleLens: Lens = {
  id: 'methodExample',
  meta: lensMeta('methodExample'),
  system: SYSTEM,

  prompt(ctx: LensContext): string {
    return `# 任务
摘出这篇论文里**真实出现**的例子，帮初学者建立「方法跑起来长什么样」的直觉。

# 论文信息
${paperHeader(ctx)}

# 输出 JSON
{
  "sections": {
    ${SECTIONS.map((k) => `"${k}": "该章节的 Markdown 内容"`).join(',\n    ')}
  }
}

# 各章节填写要求
${sectionRequirements(SECTIONS)}

# 特别注意
- 「具体例子」只放能从原文**逐字引用**的例子（用 > 引用），并标明出处（章节 / 图 / 表 / 附录）。
  确实找不到就写「论文没有给出具体例子」——**不要编造示例数据或对话**。
- 例子里的符号、字段、参数逐个解释含义；有具体数值就写数值。
- 分点用「- **加粗标签**：」的列表形式，**值里不要出现「## 」标题行**（会把这一节切成碎片）。

${jsonOnlyRule()}

# 论文正文
${sourceBlock(
  ctx,
  ['Method', 'Approach', 'Methodology', 'Experiments', 'Appendix', 'Abstract'],
  { tail: 12000 }
)}`
  },

  parse(payload) {
    return { sections: pickSections(payload, SECTIONS) }
  }
}
