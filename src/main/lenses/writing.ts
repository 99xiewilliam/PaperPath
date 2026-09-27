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

const SYSTEM = `你是科研写作教练，任务是**拆解别人论文的写作手法**，而不是总结论文内容。
你的信条：
1. 读者要学到的是「怎么写的」，所以必须给出结构骨架、段落分工、句式模板，而不是内容摘要。
2. 引用原文时用英文原句（引号内），并说明它在这里起什么作用。
3. 要指出作者**刻意的设计**：为什么这段放前面、为什么这里要提这个数字、为什么这里要示弱。
4. 只做写作分析，不评价方法好坏。
5. 输出必须是合法 JSON，不要代码块包裹。`

/**
 * 投喂材料按维度给：开篇三节看摘要 / 引言 / 相关工作；
 * 方法与实验看正文主体，外加结论里值得摘录的原句。
 * （给多了既稀释注意力，也白白多花钱。）
 */
const SOURCE_KEYS: Record<WritingId, string[]> = {
  writing: ['Abstract', 'Introduction', 'Related Work'],
  writingMethod: ['Abstract', 'Method', 'Experiments', 'Analysis', 'Conclusion']
}

const WRITING_IDS = ['writing', 'writingMethod'] as const
type WritingId = (typeof WRITING_IDS)[number]

/**
 * 两个写作维度共用同一套分析口径，只有「负责哪几节」和「投喂什么」不同。
 *
 * 为什么拆成两个：原来一个维度要一次写 6 节，实测输出会撞上 max_tokens 被
 * 截断（推理模型的思考先吃掉大半预算），而截断抢救只保住最后一个完整值 ——
 * 结果记录里是 ✓、实际只落了第一节，其余全是空骨架。详见 shared/lenses.ts
 * 里 writingMethod 的注释。
 */
function makeWritingLens(id: WritingId): Lens {
  const meta = lensMeta(id)
  const sections = meta.sections

  const extra = [
    '- 每个「写作手法 · X」章节都要**保留模板给的加粗标签**，标签后跟实际内容。',
    '- 「亮点句式 / 可复用句式 / 可复用表达」请摘录英文原句（放在引号里），并补一句它起什么作用。',
    '- 不要写成内容摘要。如果某节只能写出内容摘要，说明没抓住写作手法，请重写。',
    ...(sections.includes('原文摘录')
      ? ['- 「原文摘录」给 3-5 句值得反复读的原句，不要加解释。']
      : [])
  ].join('\n')

  return {
    id,
    meta,
    system: SYSTEM,

    prompt(ctx: LensContext): string {
      return `# 任务
逐节拆解下面这篇论文的**写作手法**：它每一节怎么组织、用了什么句式、我怎么复用。

# 论文信息
${paperHeader(ctx)}

# 输出 JSON
{
  "sections": {
    ${sections.map((k) => `"${k}": "该章节的 Markdown 内容"`).join(',\n    ')}
  }
}

# 各章节填写要求
${sectionRequirements(sections)}

# 特别注意
${extra}
- 上面 JSON 里的**每个键都要写出来**。只写第一节就停，后面的章节会一直是空骨架。

${jsonOnlyRule()}

# 论文正文
${sourceBlock(ctx, SOURCE_KEYS[id])}`
    },

    parse(payload) {
      return { sections: pickSections(payload, sections) }
    }
  }
}

export const writingLens = makeWritingLens('writing')
export const writingMethodLens = makeWritingLens('writingMethod')
