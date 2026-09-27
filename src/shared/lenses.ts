/**
 * 分析维度（Lens）元数据。
 *
 * 设计动机：把「精读一篇论文」拆成若干个互相独立的分析维度，每个维度由
 * 一个**专属 agent（独立 system prompt + 独立输入 + 独立输出 schema）**完成。
 *
 * 为什么不能塞进一个大 prompt：
 *   1. 输出过长 → 截断风险高（实测 14 章节一次性输出时出现过整篇空掉的失败）
 *   2. 注意力被稀释 → 每个维度都写得浅
 *   3. 没法单独重跑某个维度，也没法单独调优它的 prompt
 *   4. 不同维度需要的材料不同（实验画像只要实验章节，写作手法要全文）
 *
 * 这里只放「元数据」（两端共用）；真正的 prompt 与解析逻辑在主进程
 * 的 src/main/lenses/ 下，一个维度一个文件。
 */

export type LensId =
  | 'overview'
  | 'writing'
  /** writing 的后半：方法与实验那两个写作章节 + 原文摘录 */
  | 'writingMethod'
  | 'english'
  | 'visuals'
  /** 把方法讲到能照着复现（顺带产出方法流程图） */
  | 'methodDetail'
  /** 摘出原文里真实出现的例子（没有就明说，不编） */
  | 'methodExample'
  /** 与库内真正相关的论文做对照 + 把方法迁移到别的场景 */
  | 'connections'
  /** 只做结构化抽取，不写任何章节 */
  | 'experiment'
  | 'method'
  | 'limitations'
  | 'graph'

export interface LensMeta {
  id: LensId
  label: string
  /** 一句话说明这个维度在沉淀什么 */
  description: string
  /** 它负责填写的正文章节（顺序即渲染顺序） */
  sections: string[]
  /** 是否需要原文（否则可以只靠已有笔记跑） */
  needsSource: boolean
  /** 建议的最大输出 token */
  maxTokens: number
  /** 新论文默认是否启用 */
  defaultEnabled: boolean
}

export const LENS_META: LensMeta[] = [
  {
    id: 'overview',
    label: '速览与故事线',
    description: '这篇论文讲了什么、讲得怎么样、我该带走什么。',
    sections: ['一句话总结', '核心问题与动机', '关键收获', '故事线拆解', '可迁移到我的研究'],
    needsSource: true,
    maxTokens: 4096,
    defaultEnabled: true
  },
  {
    id: 'writing',
    label: '写作手法 · 开篇',
    description: '逐节拆 Abstract / Introduction / Related Work 的组织与句式。',
    sections: ['写作手法 · Abstract', '写作手法 · Introduction', '写作手法 · Related Work'],
    needsSource: true,
    maxTokens: 4096,
    defaultEnabled: true
  },
  {
    /*
     * 从 writing 拆出来的后半。
     *
     * 原来一个维度要一次写 6 节（5 个写作手法 + 原文摘录），实测输出会撞上
     * max_tokens 被截断，而 `repairTruncatedJson` 只保住了最后一个完整值 ——
     * 于是记录里是「写作手法拆解 ✓」，实际上只落了 Abstract 一节，
     * 其余 5 节还是骨架。同一次运行里只写 1 节的维度（图表 11K 字符、
     * 实验方法论 9K 字符）全都成功，说明预算够写一节、不够写六节。
     */
    id: 'writingMethod',
    label: '写作手法 · 方法与实验',
    description: '逐节拆 Methodology / Experiments 的组织与句式，外加值得反复读的原文摘录。',
    sections: ['写作手法 · Methodology', '写作手法 · Experiments', '原文摘录'],
    needsSource: true,
    maxTokens: 4096,
    defaultEnabled: true
  },
  {
    id: 'english',
    label: '英语写作短语',
    description: '抽取文中可复用的英文小短语，按功能分类，直接攒成自己的表达库。',
    sections: ['英语写作短语'],
    needsSource: true,
    maxTokens: 4096,
    defaultEnabled: true
  },
  {
    id: 'visuals',
    label: '图表与可视化设计',
    description: '同样的拆解思路换个场景：看它的图、表、流程是怎么设计的。',
    sections: ['图表与可视化设计'],
    needsSource: true,
    maxTokens: 4096,
    defaultEnabled: true
  },
  {
    id: 'methodDetail',
    label: '方法细节',
    description:
      '把方法讲到「能照着复现」：输入输出、模块、关键设计选择与理由；顺带产出方法流程图。',
    /*
     * 只写 1 节。踩过两次坑，都是「一次写太多」：
     *   1. 写作维度一次写 6 节 → 撞 max_tokens 被截断，截断抢救只保住最后一个值；
     *   2. 这个维度一次写 2 节 + 流程图 → 在慢模型上直接超 300s 超时
     *      （真实失败：deepseek-chat，SAFE 那篇），两节一起空白。
     * 所以「具体例子」拆出去成 methodExample，各自一次只写一节。
     */
    sections: ['方法细节'],
    needsSource: true,
    maxTokens: 4096,
    defaultEnabled: true
  },
  {
    id: 'methodExample',
    label: '具体例子',
    description:
      '摘出论文里真实出现的例子（示例输入 / prompt 模板 / case study），逐字引用并标出处；没有就明说，不编。',
    // 从 methodDetail 拆出来的，拆分原因见上面的注释
    sections: ['具体例子'],
    needsSource: true,
    maxTokens: 3072,
    defaultEnabled: true
  },
  {
    id: 'connections',
    label: '方法串联与举一反三',
    description:
      '和库里**真正**相关的论文做对照（共享要素由知识图谱判定），再把方法迁移到别的任务；凑不出关系就明说。',
    sections: ['方法串联', '举一反三'],
    needsSource: true,
    maxTokens: 4096,
    defaultEnabled: true
  },
  {
    id: 'experiment',
    /*
     * 这个维度只做**结构化抽取**，不写章节。
     *
     * 它原本同时干三件事（抽画像 + 写实验方法论 + 记录局限），但那是三种
     * 不同性质的任务：精确填字段 / 叙述方法设计 / 批判性挑毛病，
     * 需要的材料也不同（算力在附录、局限常在 Intro 与 Conclusion）。
     * 混在一个 JSON 里还有个实际风险：一旦输出被截断，
     * 喂给「实验对比」表格的结构化字段会和两段散文一起丢。
     */
    label: '实验画像抽取',
    description: '结构化抽取实验设置：数据集 / 基线 / 指标 / 消融组数 / 重复次数 / 方差 / 开源闭源 / 算力。',
    sections: [],
    needsSource: true,
    maxTokens: 2048,
    defaultEnabled: true
  },
  {
    id: 'method',
    label: '实验方法论',
    description: '这篇论文「做实验」的做法本身：指标为什么这么选、方差怎么报、复现要点与坑。',
    sections: ['实验方法论'],
    needsSource: true,
    maxTokens: 3072,
    defaultEnabled: true
  },
  {
    id: 'limitations',
    label: '局限与未来工作',
    description: '作者自陈的局限 + 审稿人视角发现的漏洞，往往就是下一篇论文的入口。',
    sections: ['局限与未来工作'],
    needsSource: true,
    maxTokens: 2048,
    defaultEnabled: true
  },
  {
    id: 'graph',
    label: '知识图谱抽取',
    description: '抽出论文里的实体（模型/数据集/任务/方法）与它们之间的关系，用于跨论文建图。',
    sections: [],
    needsSource: true,
    maxTokens: 4096,
    defaultEnabled: true
  }
]

const META_MAP = new Map(LENS_META.map((l) => [l.id, l]))

/** 章节 → 归属维度（自定义章节返回 null） */
const SECTION_OWNER = new Map<string, LensId>()
for (const lens of LENS_META) {
  for (const key of lens.sections) SECTION_OWNER.set(key, lens.id)
}

export function lensMeta(id: LensId): LensMeta {
  return META_MAP.get(id) ?? LENS_META[0]
}

export function lensForSection(sectionKey: string): LensId | null {
  return SECTION_OWNER.get(sectionKey) ?? null
}

export function allLensIds(): LensId[] {
  return LENS_META.map((l) => l.id)
}

/** 一次精读里单个维度的结局 */
export interface LensRunEntry {
  id: LensId
  label: string
  ok: boolean
  /** 成功时是「完成了什么」，失败时是失败原因 */
  message: string
  /**
   * 成功但产出不全的警告（只产出 2/3 节 / 输出被 max_tokens 截断）。
   *
   * 为什么单独一个字段而不并进 message：并进去以后，`summarizeOutcomes` 拼出的
   * 「写作手法 · 方法与实验 ✓」会把它吞掉，状态条上只剩一个干净的 ✓，
   * 而实际上只落了 1 节 —— 那正是这个警告要防的事。
   */
  note?: string
}

/**
 * 一次精读的落盘记录。
 *
 * 为什么要存这个：精读的结果过去**只在跑完那一刻**落盘，于是「中途被杀」
 * 「用户取消」「压根没跑起来」三种结局在界面上长得一模一样 ——
 * 都是一片空白，和「这篇论文确实没写实验设置」无法区分。
 * 排查时只能靠猜，实测猜错过好几次。
 */
export interface LensRunRecord {
  /** 本次运行的结束时刻 */
  finishedAt: string
  status: 'ok' | 'partial' | 'failed' | 'cancelled'
  /** 给用户看的一句话 */
  message: string
  lenses: LensRunEntry[]
}

export const RUN_STATUS_LABEL: Record<LensRunRecord['status'], string> = {
  ok: '全部成功',
  partial: '部分失败',
  failed: '失败',
  cancelled: '已取消'
}

/**
 * 实际要跑的维度 = 全部维度减去用户手动关掉的。
 *
 * 设置里存的是「关掉了哪些」而不是「启用了哪些」，这是刻意的：
 * 存白名单的话，新版本新增一个维度时老用户的配置里不会有这个 id，
 * 那个维度就永远不会跑 —— 而且不报错，只是静默地少产出内容。
 * 存黑名单则新维度自动生效，用户明确关掉的仍然保持关闭。
 */
export function enabledLensIds(disabled: LensId[] | undefined): LensId[] {
  const off = new Set(disabled ?? [])
  return LENS_META.filter((l) => !off.has(l.id)).map((l) => l.id)
}

/**
 * 「实验方法论」拆分之前存在的维度集合。
 *
 * 这是一份**冻结的历史快照，永远不要再改**：它的唯一用途是把老配置里的
 * 白名单翻译成黑名单，改动它会让已经迁移过的用户配置错乱。
 */
const LEGACY_LENS_IDS: LensId[] = [
  'overview',
  'writing',
  'english',
  'visuals',
  'experiment',
  'graph'
]

/**
 * 把老版本的 enabledLenses（白名单）翻译成 disabledLenses（黑名单）。
 *
 * 难点在于老配置只有一个白名单，从中既看不出「用户主动关掉了什么」，
 * 也看不出「什么在当时还不存在」——而这两者必须区分：
 *   - 当时已存在、但用户没启用 → 保持关闭（这是用户的真实意图）
 *   - 当时还不存在的（比如此后拆出来的 method / limitations）→ 应当启用，
 *     否则升级后这两节笔记会永远空着，而且不报错
 *
 * 所以用 LEGACY_LENS_IDS 作为「当时有哪些」的基准来判定。
 *
 * @param stored 磁盘上的原始设置对象（可能只有老字段、只有新字段，或两者都有）
 */
export function disabledLensesFromLegacy(stored: {
  disabledLenses?: unknown
  enabledLenses?: unknown
}): LensId[] {
  // 已经是新格式，直接采信（不再回头看老字段，避免两者冲突时行为诡异）
  if (Array.isArray(stored.disabledLenses)) return stored.disabledLenses as LensId[]

  if (Array.isArray(stored.enabledLenses)) {
    const on = new Set(stored.enabledLenses as string[])
    return LEGACY_LENS_IDS.filter((id) => !on.has(id))
  }

  // 全新安装：没有任何偏好记录
  return []
}

/* ------------------------------------------------------------------ */
/*  英语写作短语：功能分类（两端共用，保证 AI 输出与 UI 分组一致）        */
/* ------------------------------------------------------------------ */

export const PHRASE_CATEGORIES = [
  '提出问题 / 背景铺垫',
  '指出 Gap',
  '转折与对比',
  '强调贡献',
  '描述方法',
  '报告结果',
  '解释原因',
  '谦逊与限定',
  '局限与展望',
  '过渡与衔接',
  '定义与澄清'
] as const

export type PhraseCategory = (typeof PHRASE_CATEGORIES)[number]

/**
 * 英语写作短语。
 * 刻意设计成「小颗粒」：3-10 个词的套件，而不是整句长句，
 * 这样才更容易被记住和迁移到自己的写作里。
 */
export interface EnglishPhrase {
  /** 功能分类 */
  category: string
  /** 可复用的短语本体，英文 */
  text: string
  /** 中文说明：什么场景用、语气如何 */
  usage: string
  /** 原文中的完整例句（带上下文，方便体会位置感） */
  example?: string
  /** 来自哪一节的写作拆解（Abstract / Introduction / …） */
  from?: string
}

/* ------------------------------------------------------------------ */
/*  图表与可视化设计                                                   */
/* ------------------------------------------------------------------ */

export interface FigureNote {
  /** 例如 "Figure 3" / "Table 1" */
  id: string
  /** 图表类型：pipeline / 架构图 / 柱状图 / 热力图 / 雷达图 / 对照表 … */
  type: string
  /** 它承担什么论证任务（想说明什么） */
  purpose: string
  /** 设计手法：布局、配色、标注、排序、对比维度 */
  design: string
  /** 可迁移到我自己论文的写法 */
  transferable: string
}

export interface VisualDesignPayload {
  /** 整体视觉策略总结 */
  strategy?: string
  /** 逐图逐表拆解 */
  figures?: FigureNote[]
}

/* ------------------------------------------------------------------ */
/*  知识图谱：实体与关系                                                */
/* ------------------------------------------------------------------ */

export const ENTITY_KINDS = [
  'model',
  'dataset',
  'benchmark',
  'task',
  'method',
  'metric',
  'technique',
  'concept',
  'org'
] as const

export type EntityKind = (typeof ENTITY_KINDS)[number]

export const ENTITY_KIND_LABEL: Record<EntityKind, string> = {
  model: '模型',
  dataset: '数据集',
  benchmark: '基准',
  task: '任务',
  method: '方法',
  metric: '指标',
  technique: '技术',
  concept: '概念',
  org: '机构'
}

export const ENTITY_KIND_COLOR: Record<EntityKind, string> = {
  model: '#8F8AC2',
  dataset: '#7FA3C7',
  benchmark: '#5FA898',
  task: '#C9973F',
  method: '#ACA3CF',
  metric: '#C08BA4',
  technique: '#5FA983',
  concept: '#C49364',
  org: '#8D9199'
}

export const RELATION_TYPES = [
  'proposes',
  'uses',
  'trained-on',
  'evaluated-on',
  'compares-with',
  'improves',
  'extends',
  'based-on',
  'applies-to',
  'measured-by',
  'part-of'
] as const

export type RelationType = (typeof RELATION_TYPES)[number]

export const RELATION_LABEL: Record<RelationType, string> = {
  proposes: '提出',
  uses: '使用',
  'trained-on': '训练于',
  'evaluated-on': '评测于',
  'compares-with': '对比',
  improves: '改进',
  extends: '扩展',
  'based-on': '基于',
  'applies-to': '应用于',
  'measured-by': '由…衡量',
  'part-of': '属于'
}

export interface GraphEntity {
  /** 规范化名称（用于跨论文合并节点） */
  name: string
  kind: EntityKind
  /** 别名 / 全称 */
  aliases?: string[]
}

export interface GraphRelation {
  from: string
  to: string
  type: RelationType
  /** 一句话证据（原文依据），用于多跳时解释「为什么连起来」 */
  evidence?: string
}

export interface PaperGraph {
  entities: GraphEntity[]
  relations: GraphRelation[]
  /** 抽取时间 */
  extractedAt?: string
}
