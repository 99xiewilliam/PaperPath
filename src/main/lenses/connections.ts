import { lensMeta } from '@shared/lenses'
import { renderRelatedPapers } from '@shared/connections'
import {
  jsonOnlyRule,
  paperHeader,
  pickSections,
  sectionRequirements,
  sourceBlock,
  type Lens,
  type LensContext
} from './types'

const SECTIONS = lensMeta('connections').sections

const SYSTEM = `你是一位帮研究者做「横向串联」与「迁移思考」的导师。
你的信条：
1. **不许硬凑关系。** 给你的候选论文是先用知识图谱按「共享的技术要素」筛过的，但你仍要复核：
   如果某个共享点看上去只是巧合（数据集同名但场景不同、都用了 Transformer 这类无信息量的共同点），
   就明确说明关系不成立并讲清理由。宁可这一节只有一句话，也不要凑三段没用的关联。
   写「库内暂无与本篇真正可串联的论文」是完全合格的答案。
2. 串联必须落到**具体差异**：同一个数据集上各自怎么用、同类方法各自卡在哪、
   谁更适合什么场景。「都关注具身智能」这种正确但无用的判断不要写。
3. 举一反三要给**可执行的具体设想**：搬到哪个任务、怎么改、为什么成立、可能踩什么坑。
   不要写「具有广泛的应用前景」这类空话。
4. 输出必须是合法 JSON，不要代码块包裹。`

/**
 * 方法串联与举一反三。
 *
 * 「串联」这条线的关键不在 prompt 写得多严厉，而在**候选是谁给的**：
 * 候选由 shared/connections.ts 从知识图谱里按共享实体算出来（并带权重门槛），
 * 筛不出就传空数组，prompt 里再明确允许模型说「串不上」。
 * 否则把一堆标题丢给模型，它总能编出「都关注 XX」这种正确但没用的关系。
 */
export const connectionsLens: Lens = {
  id: 'connections',
  meta: lensMeta('connections'),
  system: SYSTEM,

  prompt(ctx: LensContext): string {
    return `# 任务
先做**同行对照**：把本篇方法与库里读过的、确实共享技术要素的论文串起来；
再做**举一反三**：把这个方法或它的核心洞察迁移到别的任务与场景。

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

${renderRelatedPapers(ctx.relatedPapers ?? [])}

# 特别注意
- 「方法串联」只写**库里读过的**论文（不要拿没读到全文的外部论文凑数）。每一条都要写清
  「共享什么 → 差异在哪 → 各自更适合什么场景」。候选如果都不成立，就写
  「库内暂无与本篇真正可串联的论文」——这是合法且常见的结论，不是失败。
- 「举一反三」至少给 2 条迁移设想，每条具体到「搬到哪个任务 / 怎么改 / 为什么成立 / 坑在哪」，
  并明确写出**搬不过去的地方**及原因。

${jsonOnlyRule()}

# 论文正文
${sourceBlock(
  ctx,
  ['Method', 'Approach', 'Abstract', 'Introduction', 'Related Work', 'Limitations', 'Conclusion'],
  { tail: 8000 }
)}`
  },

  parse(payload) {
    return { sections: pickSections(payload, SECTIONS) }
  }
}
