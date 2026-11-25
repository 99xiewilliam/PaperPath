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
  /** 按用户的「读论文风格」skill 写一整篇导读 */
  | 'deepread'
  | 'writing'
  /** writing 的后半：方法与实验那两个写作章节 + 原文摘录 */
  | 'writingMethod'
  /**
   * 「写作逻辑卡」：只抽结构化数据（故事线 / 引用功能 / 优势对齐 / 贡献 / 方法论证链），
   * 不写任何章节。与 writing 的分工见 main/lenses/writingLogic.ts。
   */
  | 'writingLogic'
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

export interface LensMeta {
  id: LensId
  label: string
  /** 一句话说明这个维度在沉淀什么 */
  description: string
  /** 它负责填写的正文章节（顺序即渲染顺序） */
  sections: string[]
  /** 是否需要原文（否则可以只靠已有笔记跑） */
  needsSource: boolean
  /**
   * 这个维度写满需要的输出预算。它是**下限**而不是上限：
   * 实际发出去的 max_tokens 取它与全局配置里较大者，再由 LENS_TOKEN_CEILING 兜住
   * —— 推理型模型的思考 token 也从这里扣，所以全局值常常需要比「正文体积」大得多。
   * 见 main/lenses/run.ts 的 lensTokenBudget。
   */
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
    /*
     * 一整篇长文，按 skills/读论文风格.md 的口吻和结构写。
     * 和其余维度的分工：它们各自把一个侧面拆到能复用（固定章节、能跨论文聚合），
     * 这一篇负责「从头到尾讲明白」—— 碎片拼不出导师讲课的那条线。
     */
    id: 'deepread',
    label: '导师精读',
    description:
      '按「六个核心问题 → 留坑点 → 可带走的规律」写一整篇导读，口吻和结构来自知识库里的 skills/读论文风格.md。',
    sections: ['导师精读'],
    needsSource: true,
    maxTokens: 16384,
    defaultEnabled: true
  },
  {
    id: 'writing',
    label: '写作手法 · 开篇',
    description:
      '逐节拆 Abstract / Introduction / Related Work 的组织与句式；Introduction 额外拆贡献段的「主张 → 缺口 → 证据」。',
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
    /*
     * 这个维度**不写章节**，产物是 frontmatter 里的结构化卡片。
     *
     * 为什么不并进 writing：writing 已经有过两次「一次写太多被截断、截断抢救
     * 只保住最后一节」的记录。再往同一个 JSON 里塞十几条引用记录，代价是散文
     * 那一侧也一起空掉；拆开之后两边的失败互不牵连。
     */
    id: 'writingLogic',
    label: '写作逻辑卡',
    description:
      '抽成可跨篇比较的结构：故事线类型、Intro 逐段在回答哪个疑问、每条被引工作是靶子还是垫脚石、反衬出哪个优势、贡献怎么回扣缺口、方法按什么顺序被论证。',
    sections: [],
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
    /*
     * 默认**关闭**。
     *
     * 它产出的「图表与可视化设计」在实际使用里很少被回头看，却是每次精读都跑
     * 一遍的固定成本。想用的人到 设置 → 分析维度 打开即可，历史产出不会丢。
     *
     * 注意：真正决定「默认跑不跑」的是 settings.disabledLenses（见 settings.ts
     * 的 DEFAULT_SETTINGS 与 settingsVersion 迁移），这个字段只是元数据说明。
     * 原因是 enabledLensIds 走的是黑名单语义 —— 只改这里对老用户完全无效，
     * 而让 enabledLensIds 同时看 defaultEnabled，会导致用户手动打开后又被过滤掉。
     */
    id: 'visuals',
    label: '图表与可视化设计',
    description: '同样的拆解思路换个场景：看它的图、表、流程是怎么设计的。',
    sections: ['图表与可视化设计'],
    needsSource: true,
    maxTokens: 4096,
    defaultEnabled: false
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
    description:
      '结构化抽取实验设置：数据集 / 基线 / 指标 / 消融组数 / 重复次数 / 方差 / 开源闭源 / 算力。',
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
  /** 这个维度吃掉多少模型用量；老记录里没有（读取处按可选处理） */
  usage?: LensRunUsage
}

/**
 * 模型用量。
 *
 * 为什么要落盘：`usage` 过去从接口拿回来就丢了，于是「这次精读花了多少 token」
 * 「哪个维度最费钱」「重试了几次」全都答不上来。有了它，批量精读前能预估、
 * 跑完能对账、换模型后能比较成本 —— 这是「改 prompt / 换模型到底值不值」
 * 的唯一依据。
 */
export interface LensRunUsage {
  /** 用到的模型；一次运行里混用过多个会以「,」相连 */
  model: string
  /**
   * prompt 组合指纹（各次调用 system 指纹的再哈希）。
   * 任何一个维度的 prompt 改了它就会变，见 main/llm.ts 的 fingerprint。
   */
  prompt: string
  promptTokens: number
  completionTokens: number
  /** 端到端耗时合计，含重试与重试前的退避等待 */
  elapsedMs: number
  /** 实际发出的请求数（比调用数多，说明发生过重试） */
  requests: number
  /** 调用次数（一个维度算一次） */
  calls: number
  /** 撞上 max_tokens 被截断的调用数 */
  truncated: number
  /** 失败的调用数 —— 它们照样计费，所以要单独可见 */
  failed: number
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
  /**
   * 本次运行的用量合计。
   *
   * 口径是「**本次**」而不是「这篇论文累计」：重跑失败的维度时，这里只统计这次
   * 重跑的消耗 —— 累计值会把同一次精读反复计入，拿来估成本只会误导。
   */
  usage?: LensRunUsage
}

/**
 * 按设置里的单价估算花费（单位随单价，通常填「元 / 百万 token」）。
 *
 * 单价由用户自己填 —— 不同服务商差几倍，代码里写死一个必然错。未填时返回 null：
 * 宁可不显示，也不要甩一个「¥0.00」让人以为免费。
 */
export function estimateCost(
  usage: Pick<LensRunUsage, 'promptTokens' | 'completionTokens'>,
  priceInput?: number,
  priceOutput?: number
): number | null {
  const pin = priceInput ?? 0
  const pout = priceOutput ?? 0
  if (pin <= 0 && pout <= 0) return null
  return (usage.promptTokens / 1e6) * pin + (usage.completionTokens / 1e6) * pout
}

/** 花费的显示文案：极小值也要看得见（「¥0.00」看起来像没花钱） */
export function formatCost(cost: number | null): string {
  if (cost == null) return ''
  if (cost <= 0) return '¥0'
  return cost < 0.01 ? '不足 ¥0.01' : `¥${cost.toFixed(2)}`
}

/** token 数的显示文案：上万之后折成「万」，否则一长串数字读不出量级 */
export function formatTokens(n: number): string {
  if (n < 10000) return n.toLocaleString('zh-CN')
  return `${(n / 10000).toFixed(1)} 万`
}

/** 耗时的显示文案（毫秒进、人话出） */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分`
}

/**
 * 从运行记录里剔除已经下线的维度（例如 `graph`），并据剩下的维度重算状态。
 *
 * 不剔除的话，下线维度的失败会永远挂在状态条上，「只重试失败的」又把这个
 * 已不存在的 id 发给主进程 —— 结果只会得到「没有启用任何分析维度」。
 * 整个流程失败 / 取消的记录不重算：那类状态不是由单个维度决定的。
 */
export function pruneRetiredLenses(record: LensRunRecord): LensRunRecord {
  const lenses = record.lenses.filter((l) => META_MAP.has(l.id))
  if (lenses.length === record.lenses.length) return record
  if (record.status !== 'partial' || !lenses.length) return { ...record, lenses }

  const failed = lenses.filter((l) => !l.ok).length
  if (failed) return { ...record, lenses }
  return { ...record, lenses, status: 'ok', message: `${lenses.length} 个维度全部完成` }
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
const LEGACY_LENS_IDS: LensId[] = ['overview', 'writing', 'english', 'visuals', 'experiment']

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

const KIND_SET = new Set<string>(ENTITY_KINDS)
const RELATION_SET = new Set<string>(RELATION_TYPES)

/**
 * 从笔记 frontmatter 读回来的图谱数据做归一化。
 *
 * 为什么必须有这一步：frontmatter 是用户可手改的 YAML，形状不可能保证 ——
 * 数组写成标量、kind 拼错、relations 引用了不存在的实体，都会发生。不归一化的话，
 * 一个手改过的字段就能让整篇图谱在读取时崩掉；而 frontmatter 恰恰是图谱数据的
 * **唯一持久化位置**（索引可以从它重建，但不能反过来）。
 *
 * 过滤口径与抽取时保持一致（关系两端必须都是收下的实体），否则手改出来的
 * 孤儿关系会在图上变成连不上的悬空节点。
 *
 * 注意：**值为 undefined 的键一律不加**。画像那边的注释记过这个坑 ——
 * js-yaml 遇到 undefined 会直接抛「unacceptable kind of an object to dump」，
 * 后果是整篇笔记在落盘那一步全丢。
 */
export function normalizePaperGraph(raw: unknown): PaperGraph | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>

  const entities: GraphEntity[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(r.entities) ? r.entities : []) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    const name = String(e.name ?? '').trim()
    if (!name || name.length > 80) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const kind = String(e.kind ?? '')
      .trim()
      .toLowerCase()
    const entity: GraphEntity = {
      name,
      kind: KIND_SET.has(kind) ? (kind as EntityKind) : 'concept'
    }
    const aliases = Array.isArray(e.aliases)
      ? e.aliases
          .map((a) => String(a ?? '').trim())
          .filter((a) => a && a.toLowerCase() !== key)
          .slice(0, 6)
      : []
    if (aliases.length) entity.aliases = aliases
    entities.push(entity)
    if (entities.length >= 40) break
  }
  if (!entities.length) return undefined

  const relations: GraphRelation[] = []
  const relSeen = new Set<string>()
  for (const item of Array.isArray(r.relations) ? r.relations : []) {
    if (!item || typeof item !== 'object') continue
    const rel = item as Record<string, unknown>
    const from = String(rel.from ?? '').trim()
    const to = String(rel.to ?? '').trim()
    if (!from || !to || from === to) continue
    if (!seen.has(from.toLowerCase()) || !seen.has(to.toLowerCase())) continue
    const type = String(rel.type ?? '')
      .trim()
      .toLowerCase()
    if (!RELATION_SET.has(type)) continue
    const relKey = `${from}|${type}|${to}`.toLowerCase()
    if (relSeen.has(relKey)) continue
    relSeen.add(relKey)

    const edge: GraphRelation = { from, to, type: type as RelationType }
    const evidence = String(rel.evidence ?? '').trim()
    if (evidence) edge.evidence = evidence
    relations.push(edge)
    if (relations.length >= 80) break
  }

  const graph: PaperGraph = { entities, relations }
  if (typeof r.extractedAt === 'string' && r.extractedAt) graph.extractedAt = r.extractedAt
  return graph
}

/**
 * 从 frontmatter 读回来的英语短语做归一化。
 *
 * 句式库是跨论文聚合 `phrases` 得来的，所以这个字段同样必须落进 frontmatter ——
 * 只写索引的话，重建索引就等于把整个句式库清空（和上面图谱是同一类问题）。
 */
export function normalizePhrases(raw: unknown): EnglishPhrase[] {
  if (!Array.isArray(raw)) return []
  const out: EnglishPhrase[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    const text = String(p.text ?? '').trim()
    if (!text || text.length > 200) continue
    const phrase: EnglishPhrase = {
      category: String(p.category ?? '').trim() || '未分类',
      text,
      usage: String(p.usage ?? '').trim()
    }
    const example = String(p.example ?? '').trim()
    if (example) phrase.example = example
    const from = String(p.from ?? '').trim()
    if (from) phrase.from = from
    out.push(phrase)
    if (out.length >= 60) break
  }
  return out
}
