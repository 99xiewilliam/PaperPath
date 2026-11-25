/**
 * 「写作逻辑卡」维度：只抽结构化数据，不写任何笔记章节。
 *
 * 与 `writing` / `writingMethod` 的分工是刻意划开的，不是重复：
 *   - 那两个维度产出**散文**（给人读、可编辑、可重写一节）；
 *   - 这个维度产出**字段**（给跨篇聚合用）。
 *
 * 为什么不干脆让散文维度顺带输出结构化数据：writing 已经踩过两次「一次写太多
 * 撞 max_tokens、截断抢救只保住最后一节」的坑（见 shared/lenses.ts 的注释）。
 * 再往同一个 JSON 里塞 20 条引用记录，只会让那两节也一起空掉。拆开的代价是
 * 多一次调用，换来的是「散文写坏了不影响卡片、卡片写坏了不影响散文」。
 */
import {
  ADVANTAGE_DIMENSIONS,
  ADVANTAGE_LABEL,
  CITATION_ROLES,
  CITATION_ROLE_HINT,
  CITATION_ROLE_LABEL,
  NARRATIVE_HINT,
  NARRATIVE_LABEL,
  NARRATIVE_TYPES,
  normalizeWritingLogic
} from '@shared/writing-logic'
import { lensMeta } from '@shared/lenses'
import { jsonOnlyRule, paperHeader, sourceBlock, type Lens, type LensContext } from './types'

const SYSTEM = `你是科研写作的拆解师，专门回答一个问题：**这篇论文的论证是怎么搭起来的**。
你的信条：
1. 你分析的是**论证结构**，不是论文内容。不要复述他们做了什么，要指出他们按什么顺序让你相信什么。
2. 每一条判断都要能指回原文：给英文原句（引号内）。原文找不到依据的，宁可留空，不要替作者补理由。
3. 引用不是背景噪音：**每一篇被引工作在论证里都有一份活干**（当靶子 / 当垫脚石 / 当共识 / 当威胁 / 当工具）。
   你要判断它干的是哪一份，以及它反衬出本文的哪个优势。判断不了就选 background，不要硬猜。
4. 「凸显什么优势」必须落到受控维度上，不要写「性能更好」这种没有信息量的话。
5. 输出必须是合法 JSON，不要代码块包裹。`

/** 材料：开篇三节决定故事线与引用；方法与实验决定论证链 */
const SOURCE_KEYS = ['Abstract', 'Introduction', 'Related Work', 'Method', 'Experiments']

export const writingLogicLens: Lens = {
  id: 'writingLogic',
  meta: lensMeta('writingLogic'),
  system: SYSTEM,
  voice: false,

  prompt(ctx: LensContext): string {
    return `# 任务
把下面这篇论文的**写作逻辑**抽成结构化数据。它之后会和其他论文横向比较，
所以每一个判断都必须落在给定的枚举上，不能自造类别。

# 论文信息
${paperHeader(ctx)}

# 故事线类型（storyline.type 只能选一个）
${NARRATIVE_TYPES.map((t) => `- ${t}：${NARRATIVE_LABEL[t]} —— ${NARRATIVE_HINT[t]}`).join('\n')}

# 引用功能（citedWorks[].role 只能选一个）
${CITATION_ROLES.map((r) => `- ${r}：${CITATION_ROLE_LABEL[r]} —— ${CITATION_ROLE_HINT[r]}`).join('\n')}

# 优势维度（advantages[].dimension / citedWorks[].highlights 只能选这些）
${ADVANTAGE_DIMENSIONS.map((d) => `- ${d}：${ADVANTAGE_LABEL[d]}`).join('\n')}

# 输出 JSON
{
  "storyline": {
    "type": "上面七个类型之一",
    "oneliner": "一句话主线：作者要读者依次接受哪几件事（30-60 字）",
    "pain": "开篇让读者看到的那个痛点/场景（一句）",
    "gap": "现有方法在这个痛点上的具体缺口（一句，不要写「效果不好」）",
    "insight": "作者的核心洞察——为什么这个缺口有解（一句）",
    "validation": "用什么结果收口（一句，带关键数字）"
  },
  "intro": {
    "paragraphs": [
      {
        "n": 1,
        "question": "这一段替读者解决哪个疑问",
        "quote": "起决定作用的英文原句（逐字，不要改写）",
        "slot": "我写自己的论文时，这一段换成什么内容"
      }
    ],
    "gapTurn": "Gap 从哪一句开始转向（英文原句）",
    "contributions": [
      {
        "claim": "这一条声称了什么（不要写「提出了方法」这种空话）",
        "kind": "gap | mechanism | evidence",
        "backsGap": "回扣前文哪一个缺口",
        "support": "由什么支撑（哪张表 / 哪节方法 / 哪个实验）"
      }
    ]
  },
  "citedWorks": [
    {
      "work": "被引工作的标识（方法名，或「第一作者 年份」）",
      "section": "Introduction | Related Work | 其他",
      "role": "上面六个角色之一",
      "highlights": ["它反衬出本文的哪个优势，0-2 个"],
      "quote": "说明它被这么用的英文原句（可选，但强烈建议给）"
    }
  ],
  "advantages": [
    {
      "dimension": "优势维度之一",
      "claim": "作者具体怎么声称这个优势（一句）",
      "support": "靠什么撑住：引用反衬 / 实验数字 / 机制设计（点明是哪一个）"
    }
  ],
  "relatedWork": {
    "axis": "按什么轴把别人分类（例如「按是否需要训练」「按输入模态」）",
    "groups": [
      {
        "label": "这一类的名字（作者自己的叫法）",
        "gist": "这一类的共同做法（一句）",
        "gap": "这一类最后被留下的缺口（一句）",
        "quote": "定性这一类的英文原句（可选）"
      }
    ],
    "positioning": "作者把自己插在哪一类之后、用哪句话划开距离（英文原句 + 一句解释）"
  },
  "method": {
    "steps": [
      {
        "step": "这一节/这一步讲什么",
        "purpose": "它要证明什么（而不是描述什么）",
        "figure": "配的图或表（如 Figure 2），没有就不写"
      }
    ],
    "argument": "设计选择怎么被论证成「只能这么选」（一句）"
  },
  "phrases": ["3-6 条本篇论证结构里值得复用的英文短语（原句片段，不是完整长句）"]
}

# 硬性要求
- **citedWorks 是这张卡的核心**：Introduction 与 Related Work 里被**点名讨论**过的工作都要收进来，
  只出现在括号里凑数的不要收。控制在 6-14 条。
- 每条 citedWorks 的 role 判定要看**作者怎么用它**，不是它本身是什么：
  同一个方法，被作者拿来当失败案例就是 target，被作者借用组件就是 tool。
- highlights 只在「这篇工作被提，是为了反衬我某一项优势」时才填；
  role 是 tool / background 时通常留空数组。
- contributions **逐条**写，2-5 条。同一条里不要混两种主张类型。
- relatedWork.groups 2-4 类。每类的 gap 必须和 intro 的 gap 对得上 —— 对不上说明作者定位是硬贴的，
  这时如实在 positioning 里写「定位与前文缺口不完全对齐」。
- 原文没有某一块（例如没有 Related Work 章节）就返回空数组 / 空串，**不要编**。
- 所有字符串控制在 60 字以内，quote 可以长一点。整份 JSON 不要超过 3000 字。

${jsonOnlyRule()}

# 论文正文
${sourceBlock(ctx, SOURCE_KEYS)}`
  },

  parse(payload) {
    const root = (payload ?? {}) as Record<string, unknown>
    const logic = normalizeWritingLogic({
      ...root,
      extractedAt: new Date().toISOString()
    })

    /*
     * 归一化后仍然为空 = 这次抽取没读懂，必须抛出去。
     *
     * 这个维度 sections 是空数组，所以 run.ts 里那条「声明了要写章节却一个都没产出」
     * 的判据不会覆盖到它 —— 不在这里抛，一次彻底失败的抽取会以 ✓ 的姿态落盘，
     * 界面上表现为「卡片是空的，但状态显示成功」，正是最难排查的那种。
     */
    if (!logic) throw new Error('模型没有返回可用的写作逻辑（缺故事线主线）')

    const filled = [
      logic.intro.paragraphs.length,
      logic.citedWorks.length,
      logic.intro.contributions.length,
      logic.advantages.length
    ].filter((n) => n > 0).length

    return {
      data: { wlogic: logic },
      summary: `故事线「${NARRATIVE_LABEL[logic.storyline.type]}」，${logic.intro.paragraphs.length} 段 Intro、${logic.citedWorks.length} 条引用、${logic.intro.contributions.length} 条贡献${
        filled >= 3 ? '' : '（部分区块为空）'
      }`
    }
  }
}
