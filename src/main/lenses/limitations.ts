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

const SECTIONS = lensMeta('limitations').sections

const SYSTEM = `你是一位挑刺很准的审稿人。你读论文时最关心的不是它做成了什么，而是**它在哪一步偷了懒**。
你的信条：
1. 作者自陈的局限是「作者想让你知道的」，你要额外找出「作者不想让你注意到的」。
2. 挑毛病必须具体到可验证：指出是哪张表、哪个设置、哪个缺失的对照，
   并说明这个缺失会让哪条结论不成立。泛泛的「样本量可以更大」没有价值。
3. 区分清楚哪些是**作者承认**的，哪些是**你发现的**，不要混为一谈。
4. 不做人身评价，不因为领域冷门或方法简单就贬低；只针对实验设计与论证链条。
5. 输出必须是合法 JSON，不要代码块包裹。`

/**
 * 局限与未来工作。
 *
 * 从原来的 experiment 维度拆出来的批判型任务。它和实验画像是两种认知模式：
 * 画像要求「忠实还原作者写了什么」，而这个维度要求「跳出作者的框架找漏洞」。
 * 把这两种要求塞进同一个 prompt 会让模型自我审查——一边被要求别推测，
 * 一边被要求多挑刺，最后两头都做得不到位。
 */
export const limitationsLens: Lens = {
  id: 'limitations',
  meta: lensMeta('limitations'),
  system: SYSTEM,

  prompt(ctx: LensContext): string {
    return `# 任务
从审稿人视角审视下面这篇论文：它自陈了哪些局限，以及你额外发现了哪些问题。

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
- 「作者自陈」只写论文里**明确承认**的局限；作者没写就写「原文未说明」，不要替作者总结。
- 「我发现的额外问题」给 3-5 条，每条要包含三件事：
  ① 问题出在哪（哪张表 / 哪个设置 / 哪个缺失的对照）；
  ② 为什么它是问题；
  ③ 它会让哪条结论站不住，或者补做什么实验能验证。
- 优先挑这些类型：缺少方差或多随机种子、基线选择偏向本文方法、评测集与训练集重叠、
  只用单一指标下结论、闭源模型导致不可复现、消融不完整、显著的提升幅度与代价不匹配。
- 如果这篇论文的实验设计确实扎实、挑不出实质问题，就如实说「未发现实质性问题」并说明理由，
  不要为了凑数硬编。

${jsonOnlyRule()}

# 论文正文
${sourceBlock(ctx, [
  'Limitations',
  'Discussion',
  'Conclusion',
  'Experiments',
  'Analysis',
  'Introduction'
])}`
  },

  parse(payload) {
    return { sections: pickSections(payload, SECTIONS) }
  }
}
