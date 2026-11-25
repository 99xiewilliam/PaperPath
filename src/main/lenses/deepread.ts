import { lensMeta } from '@shared/lenses'
import { parseReadingSkill } from '@shared/reading-skill'
import { coerceSectionText } from '@shared/template'
import {
  paperHeader,
  REPRO_EVIDENCE_KEYWORDS,
  sourceBlock,
  type Lens,
  type LensContext
} from './types'

const SECTION = lensMeta('deepread').sections[0]
const DEFAULT_SKILL = parseReadingSkill(null)

/**
 * 导师精读：按用户的读论文风格写一整篇导读。
 *
 * 口吻、结构、示例都来自 skills/读论文风格.md，所以这里的 system 只放角色和硬约束；
 * 用户把「导读结构」整块删掉时退回默认结构 —— 没有结构，这个维度就写不成一篇。
 * 口吻已经在 prompt 里，不再走 lensSystemPrompt 拼第二遍。
 */
export const deepreadLens: Lens = {
  id: 'deepread',
  meta: lensMeta('deepread'),
  voice: false,
  system: `你是一位带过很多届博士生、自己也常发顶会的导师，正在给学生写一篇论文导读。
硬约束：
1. 论文本身的事实（设计、数字、实验设置、结论）只依据给定原文；原文没写的写「原文未说明」。
2. 可以用领域常识帮学生定位这篇论文，但必须标注「（领域背景，非原文）」，绝不编造论文名、作者或数字。
3. 输出必须是合法 JSON，不要代码块包裹。`,

  prompt(ctx: LensContext): string {
    const skill = ctx.skill ?? DEFAULT_SKILL
    const structure = skill.structure.trim() || DEFAULT_SKILL.structure
    const example = skill.example.trim()

    return `# 任务
为下面这篇论文写一篇完整的导读。

# 论文信息
${paperHeader(ctx)}

# 讲解口吻
${skill.voice.trim() || '（用户没有指定，按资深导师给低年级博士生讲解的口吻写）'}

# 导读结构
${structure}
${
  example
    ? `
# 示例片段（只学口吻和组织方式；示例里的论文、术语、数字一律不得出现在你的输出里）
${example}
`
    : ''
}
# 输出 JSON
{
  "sections": {
    "${SECTION}": "整篇导读的 Markdown"
  }
}

# 格式要求
- 只输出一个合法的 JSON 对象，不要 markdown 代码块包裹，不要任何解释性文字。
- 导读内部用 \`###\` 做小标题，**不要出现以 \`#\` 或 \`##\` 开头的行**（笔记按二级标题分节）。
- 可以用表格、加粗、列表、引用；**不要用 LaTeX**（界面不渲染公式），箭头直接写 →。
- 引用原文位置时写章节号 / 图表号（§3、Figure 2、Table 1），方便回原文核对。

# 论文正文
${sourceBlock(
  ctx,
  [
    'Abstract',
    'Introduction',
    'Background',
    'Motivation',
    'Method',
    'Experiments',
    'Analysis',
    'Discussion',
    'Limitations',
    'Conclusion'
  ],
  { tail: 12000, sectionBudget: 64000, evidence: REPRO_EVIDENCE_KEYWORDS, evidenceBudget: 1500 }
)}`
  },

  parse(payload) {
    const root = (payload ?? {}) as Record<string, unknown>
    const bag = (root.sections ?? root) as Record<string, unknown>
    const text = coerceSectionText(bag[SECTION])
    return text ? { sections: { [SECTION]: text } } : {}
  }
}
