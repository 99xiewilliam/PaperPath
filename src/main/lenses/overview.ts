import { lensMeta } from '@shared/lenses'
import { normalizeMindMap } from '@shared/mindmap'
import {
  asStringArray,
  categoryList,
  jsonOnlyRule,
  paperHeader,
  pickSections,
  sectionRequirements,
  sourceBlock,
  type Lens,
  type LensContext
} from './types'

const SECTIONS = lensMeta('overview').sections

const SYSTEM = `你是一位资深科研工作者，专门帮低年级博士生做「读完这篇我该带走什么」的提炼。
你的特点：
1. 只依据给定原文，绝不编造。原文没写的信息标注「原文未说明」。
2. 讲「故事线」时不复述内容，而要指出作者**刻意设计的叙事顺序**：先让读者相信什么、再暴露什么缺口、最后如何收口。
3. 「可迁移到我的研究」必须写成可以直接执行的动作，不要写「值得学习」这类空话。
4. 输出必须是合法 JSON，不要代码块包裹。`

export const overviewLens: Lens = {
  id: 'overview',
  meta: lensMeta('overview'),
  system: SYSTEM,

  prompt(ctx: LensContext): string {
    return `# 任务
为下面这篇论文写一份「速览」：它讲了什么、故事线怎么搭的、我能带走什么，并判断它属于哪些分类。

# 论文信息
${paperHeader(ctx)}

# 可选分类体系（categories 只能从这里选 1-3 个 id）
${categoryList(ctx)}

# 输出 JSON
{
  "categories": ["从上面分类体系里选 1-3 个 id"],
  "tags": ["3-6 个具体关键词，用于检索，不要泛泛而谈"],
  "sections": {
    ${SECTIONS.map((k) => `"${k}": "该章节的 Markdown 内容"`).join(',\n    ')}
  },
  "mindmap": {
    "title": "一句话主题",
    "root": {
      "label": "论文主题（10 字以内）",
      "children": [
        { "label": "问题", "children": [{ "label": "要解决什么", "note": "为什么现有方法不够" }] },
        { "label": "方法", "children": [{ "label": "关键设计", "note": "具体做法或数字" }] },
        { "label": "实验", "children": [{ "label": "主要结果", "note": "指标与对比" }] },
        { "label": "结论", "children": [{ "label": "局限", "note": "作者承认的边界" }] }
      ]
    }
  }
}

# 各章节填写要求
${sectionRequirements(SECTIONS)}

# 特别注意
- 「故事线拆解」要写清作者**怎么一步步把读者逼到自己的方法上**，而不是简单总结论文内容。
- 「可迁移到我的研究」给 3-5 条，每条以动词开头（例如「用…论证」「改用…呈现」）。
- \`mindmap\` 会被画成一张**全文思维导图**给初学者看（类似视频课的结构导图）：
  - 一级分支 3~5 个（问题 / 方法 / 实验 / 结论这类主干），每支 2~4 个叶子，
    根之外最多 3 层；label 要短（20 字以内），叶子写具体设计或数字，不要抄整句原文。
  - note 写「为什么重要 / 具体数字」，没有就不写。
  - **论文内容撑不起一张结构图时，整个 \`mindmap\` 字段都不要出现** ——
    硬编一张图比没有图更糟：读者会以为那就是论文的结构。

${jsonOnlyRule()}

# 论文正文
${sourceBlock(ctx, ['Abstract', 'Introduction', 'Analysis', 'Conclusion'])}`
  },

  parse(payload) {
    const root = (payload ?? {}) as Record<string, unknown>
    const mindmap = normalizeMindMap(root.mindmap)
    return {
      sections: pickSections(payload, SECTIONS),
      meta: {
        categories: asStringArray(root.categories, 3),
        tags: asStringArray(root.tags, 8)
      },
      // 撑不成图（分支太少 / 都是坏数据）就不带这个键，界面上那一块整个不出现
      ...(mindmap ? { data: { mindmap } } : {})
    }
  }
}
