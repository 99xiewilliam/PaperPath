import { lensMeta, type FigureNote } from '@shared/lenses'
import { jsonOnlyRule, paperHeader, sourceBlock, type Lens, type LensContext } from './types'

const SECTION = lensMeta('visuals').sections[0]

/**
 * 「举一反三」的示范维度。
 *
 * 和「写作手法」用的是同一套方法论（拆解 → 归纳套路 → 给出可迁移动作），
 * 只是换了对象：从「文字怎么写」换成「图表怎么设计」。
 * 用户看多了这个模式，就能自己把它套到别的场景上（比如 rebuttal、海报、talk）。
 */
const SYSTEM = `你是科研可视化教练，任务是**拆解论文里图表的设计手法**，而不是描述图表内容。
你的信条：
1. 每张图都在承担一个「论证任务」——先指出它想说服读者什么，再分析它怎么做到的。
2. 关注可复制的设计决策：坐标轴选择、排序规则、配色分组、标注位置、对比维度、是否留白。
3. 表格要分析「行列是什么、怎么排序、加粗给谁」，这是很多人的盲区。
4. 必须给出可迁移动作：我能在我自己的论文里怎么用。
5. 只做可视化设计分析，不评价实验本身。输出必须是合法 JSON，不要代码块包裹。`

function renderVisualSection(strategy: string, figures: FigureNote[]): string {
  const blocks: string[] = []
  if (strategy) blocks.push(`- **整体视觉策略**：${strategy}`)

  if (figures.length) {
    const items = figures.map((f) => {
      return [
        `- **${f.id || '未命名'}**（类型：${f.type || '未说明'}）`,
        `  - 承担什么论证任务：${f.purpose || '原文未说明'}`,
        `  - 设计手法（布局/配色/标注/排序）：${f.design || '原文未说明'}`,
        `  - 可迁移给我：${f.transferable || '原文未说明'}`
      ].join('\n')
    })
    blocks.push(`- **逐图 / 逐表拆解**：\n${items.join('\n')}`)
  }

  return blocks.join('\n')
}

export const visualsLens: Lens = {
  id: 'visuals',
  meta: lensMeta('visuals'),
  system: SYSTEM,

  prompt(ctx: LensContext): string {
    return `# 任务
拆解下面这篇论文的**图表与可视化设计**。用和「写作手法拆解」一样的思路：
拆解具体做法 → 归纳出可复用的套路 → 给出我能直接迁移的动作。

# 论文信息
${paperHeader(ctx)}

# 输出 JSON
{
  "strategy": "整篇论文的视觉策略总结（1-3 句）",
  "figures": [
    {
      "id": "Figure 1 | Table 1 | …",
      "type": "pipeline / 架构图 / 柱状图 / 折线图 / 热力图 / 散点图 / 饼图 / 雷达图 / 对照表 / 消融表 …",
      "purpose": "它承担什么论证任务（想说服读者什么）",
      "design": "具体设计手法：布局、配色、排序、标注、对比维度、是否用了对角结构等",
      "transferable": "我可以怎么迁移到自己的论文里（具体动作）"
    }
  ]
}

# 硬性要求
- 至少覆盖 4 个图表；论文里重要的 Figure 和 Table 都要覆盖到。
- purpose 要写成「它在论证什么」，而不是「它显示了什么数据」。
- design 要写具体到可复制的程度，例如「按从高到低排序并把本文方法置顶」「用同一色系深浅区分数据量档位」「对角线即同分布，非对角线看泛化衰减」。
- transferable 必须以动词开头，写成能直接执行的动作。
- 如果原文没有可分析的图表，figures 返回空数组，并在 strategy 里说明「原文未说明」。

${jsonOnlyRule()}

# 论文正文
${sourceBlock(ctx, ['Abstract', 'Introduction', 'Method', 'Experiments', 'Analysis'], {
  tail: 6000
})}`
  },

  parse(payload) {
    const root = (payload ?? {}) as Record<string, unknown>
    const strategy = String(root.strategy ?? '').trim()
    const raw = Array.isArray(root.figures) ? root.figures : []

    const figures: FigureNote[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const id = String(row.id ?? '').trim()
      const purpose = String(row.purpose ?? '').trim()
      if (!id && !purpose) continue
      figures.push({
        id,
        type: String(row.type ?? '').trim(),
        purpose,
        design: String(row.design ?? '').trim(),
        transferable: String(row.transferable ?? '').trim()
      })
      if (figures.length >= 12) break
    }

    const body = renderVisualSection(strategy, figures)
    return {
      sections: body.trim() ? { [SECTION]: body } : {},
      summary: figures.length ? `拆解了 ${figures.length} 个图表` : '没有可拆解的图表'
    }
  }
}
