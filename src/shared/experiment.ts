/**
 * 实验画像（Experiment Profile）
 *
 * 精读时除了写散文，还会把论文的实验设置抽成结构化字段。
 * 有了它，「这批论文一般怎么做实验」就能直接算出来，而不用每次再问一遍模型：
 *   - 平均用几个数据集 / 几个基线
 *   - 有多少篇报告了方差、多少篇只跑了一次
 *   - 开源 / 闭源 / 两者都用的比例
 *
 * 字段存在 Markdown frontmatter 的 `exp` 键下，所以索引丢了也能从笔记恢复。
 */

export type ModelChoice = 'open' | 'closed' | 'both' | 'none' | 'unclear'

export const MODEL_CHOICE_LABEL: Record<ModelChoice, string> = {
  open: '仅开源',
  closed: '仅闭源',
  both: '开源+闭源',
  none: '不涉及',
  unclear: '未说明'
}

export const MODEL_CHOICE_COLOR: Record<ModelChoice, string> = {
  open: '#5FA983',
  closed: '#7FA3C7',
  both: '#ACA3CF',
  none: '#8D9199',
  unclear: '#52525B'
}

/** 实验的类别 */
export type ExperimentKind = 'main' | 'ablation' | 'analysis'

export const EXPERIMENT_KIND_LABEL: Record<ExperimentKind, string> = {
  main: '主实验',
  ablation: '消融',
  analysis: '分析'
}

export const EXPERIMENT_KIND_COLOR: Record<ExperimentKind, string> = {
  main: '#7FA3C7',
  ablation: '#ACA3CF',
  analysis: '#8D9199'
}

/**
 * 评估数据的使用方式：在完整测试集上跑，还是采样一个子集。
 *
 * 为什么要单独立一个字段：这是**实验可比性的第一个岔路口** ——
 * 「在完整测试集上评估」和「随机抽 2000 条评估」得到的数字不能直接对比，
 * 但两者在论文里都写得很自然（「we evaluate on …」），光看散文分不出来。
 * 跨论文统计「这个领域有多少篇在抽样评估」本身也是有用的信号：
 * 抽样多说明领域内默认这么干（比如大规模检索评测），全量多说明数据规模本来就不大。
 *
 * 口径取**评估阶段**：训练用多少数据主要由算力决定，评估用多少才是方法论选择。
 */
export type DataUsage = 'full' | 'sampled' | 'both' | 'unclear'

export const DATA_USAGE_LABEL: Record<DataUsage, string> = {
  full: '全量评估',
  sampled: '抽样评估',
  both: '两者都有',
  unclear: '未说明'
}

export const DATA_USAGE_COLOR: Record<DataUsage, string> = {
  full: '#5FA983',
  sampled: '#C9973F',
  both: '#ACA3CF',
  unclear: '#52525B'
}

/**
 * 一条实验 —— 论证链上的一环。
 *
 * 为什么需要它：原来的画像只有一堆**扁平的名词列表**（数据集 / 基线 / 指标各一串），
 * 于是「做了哪些实验、各自得出什么结论」这条最关键的论证链整个看不到 ——
 * 消融只剩一个「4 组」的数字，分析性实验（case study / 人工评测 / 超参敏感性）
 * 连露面的机会都没有；跨论文对比时也只能比「用了几张卡」这类表面指标。
 *
 * 一行的定义是**一个实验主张**（论文里那句「To verify X, we …」），不是「一张表格」：
 * 一张结果表常常同时支撑好几个主张，按表格切会切错。
 */
export interface ExperimentRow {
  kind: ExperimentKind
  /** 这一行在验证什么：作者想证明的那个 claim */
  claim: string
  /** 怎么做的：数据集 / 基线 / 指标 / 关键设置 */
  setup: string
  /** 结果（数字优先） */
  result: string
  /** 结论：作者由此声称什么 */
  conclusion: string
}

export interface ExperimentProfile {
  /** 数据集 / 测试集名称 */
  datasets: string[]
  /** 对比的基线系统名称 */
  baselines: string[]
  /** 评估指标名称 */
  metrics: string[]
  /**
   * 实验清单：主实验与消融各自在证明什么、得到什么结论。
   *
   * 这是整个画像里**唯一带因果结构**的字段（其余都是名词清单），
   * 也是跨论文对比时最能看出「实验设计思路差异」的地方。
   */
  experiments: ExperimentRow[]
  /** 消融实验组数，null 表示未做或未说明 */
  ablationCount: number | null
  /** 重复实验方式，例如「3 个随机种子，报告均值±标准差」 */
  runs: string
  /** 是否报告了方差 / 置信区间 */
  reportsVariance: boolean | null
  /** 模型选型 */
  modelChoice: ModelChoice
  /** 用到的开源模型 */
  openModels: string[]
  /** 用到的闭源模型 */
  closedModels: string[]
  /** 算力规模，例如「8×A100-80G」 */
  compute: string
  /** 训练 / 推理规模 */
  scale: string
  /** 评估数据的使用方式（全量 / 抽样）；老数据没有，按 unclear 处理 */
  dataUsage: DataUsage
  /** 抽样的话，怎么抽的（「从 5 万条里随机抽 2000 条」）；未抽样时为空 */
  dataUsageNote: string
  /** 人工评测规模 */
  humanEval: string
  /** 是否有真机 / 真实场景实验 */
  realWorld: boolean | null
  /** 抽取备注（信息缺失时的说明） */
  note: string
  /**
   * 抽取时间。
   *
   * **只在真的抽到了内容时才有值**（见 normalizeExperimentProfile）。
   * 它是详情页「最近抽取」的唯一依据，所以不能靠「记录里有没有对象」来判断。
   */
  extractedAt?: string
  /**
   * 上次抽取失败的原因。
   *
   * 需要它是因为「抽取失败」和「抽取成功但论文没写」在数据上长得一模一样 ——
   * 都是十几个空字段。不把失败原因单独记下来，界面上就无从区分，
   * 用户只能看到一片「原文未说明」，既不知道系统出了错，也不知道该不该重试。
   */
  error?: string
}

export function emptyExperimentProfile(): ExperimentProfile {
  return {
    datasets: [],
    baselines: [],
    metrics: [],
    experiments: [],
    ablationCount: null,
    runs: '',
    reportsVariance: null,
    modelChoice: 'unclear',
    openModels: [],
    closedModels: [],
    compute: '',
    scale: '',
    dataUsage: 'unclear',
    dataUsageNote: '',
    humanEval: '',
    realWorld: null,
    note: ''
  }
}

function toStrArray(value: unknown, limit = 24): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => String(v ?? '').trim())
      .filter((v) => v && v.length <= 80)
      .slice(0, limit)
  }
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[,;、\n]/)
      .map((v) => v.trim())
      .filter((v) => v && v.length <= 80)
      .slice(0, limit)
  }
  return []
}

function toBoolOrNull(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (['true', 'yes', '是', '有', '1'].includes(v)) return true
    if (['false', 'no', '否', '没有', '0', ''].includes(v)) return false
  }
  return null
}

function toIntOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** 实验类别归一化：模型可能给英文、中文，也可能漏掉 */
function toExperimentKind(value: unknown): ExperimentKind {
  const v = String(value ?? '').trim().toLowerCase()
  if (/^(main|主|主实验|主要实验|main-?result)/.test(v)) return 'main'
  if (/^(ablation|消融|消融实验|ablation-?study)/.test(v)) return 'ablation'
  return 'analysis'
}

/**
 * 评估数据使用方式归一化。
 *
 * 容错要点：模型很容易把「我们使用了完整的测试集」写成一句描述，
 * 所以除了枚举值，还要认得出常见的中英文说法；认不出的**一律 unclear** ——
 * 猜成「全量」会让统计结果偏向乐观，那比留空更糟。
 */
function toDataUsage(value: unknown): DataUsage {
  const v = String(value ?? '').trim().toLowerCase()
  if (!v) return 'unclear'
  if (['full', 'sampled', 'both', 'unclear'].includes(v)) return v as DataUsage
  const saysBoth = /both|都|两者|混合|mix/.test(v)
  const saysFull = /full|entire|complete|whole|全量|完整|全部|整个/.test(v)
  const saysSampled = /sampl|subset|sub-?set|partial|采样|抽样|子集|随机抽|部分/.test(v)
  if (saysBoth || (saysFull && saysSampled)) return 'both'
  if (saysSampled) return 'sampled'
  if (saysFull) return 'full'
  return 'unclear'
}

/**
 * 实验清单归一化。
 *
 * 容错三件事（模型返回的形状不会总是听话）：
 *   - 键名中英混写（claim / 验证 / 主张…）；
 *   - 整行都是空壳 —— 这类必须丢掉，否则表格里会出现一行行空白；
 *   - 行数失控 —— 上限 16 行，和 prompt 里的要求对齐。
 */
function toExperimentRows(value: unknown): ExperimentRow[] {
  if (!Array.isArray(value)) return []
  const rows: ExperimentRow[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const pick = (...keys: string[]): string => {
      for (const k of keys) {
        const v = r[k]
        if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 400)
      }
      return ''
    }
    const row: ExperimentRow = {
      kind: toExperimentKind(r.kind ?? r.类别 ?? r.type),
      claim: pick('claim', 'what', '验证', '主张'),
      setup: pick('setup', '设置', '做法'),
      result: pick('result', '结果'),
      conclusion: pick('conclusion', '结论')
    }
    if (!row.claim && !row.setup && !row.result && !row.conclusion) continue
    rows.push(row)
  }
  return rows.slice(0, 16)
}

/** 把模型返回的任意形状归一化成 ExperimentProfile */
export function normalizeExperimentProfile(raw: unknown): ExperimentProfile {
  const base = emptyExperimentProfile()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Record<string, unknown>

  const rawChoice = String(r.modelChoice ?? r.model_choice ?? '').trim()
  const lower = rawChoice.toLowerCase().replace(/[\s_]/g, '-')
  let modelChoice: ModelChoice
  if (['open', 'closed', 'both', 'none', 'unclear'].includes(lower)) {
    modelChoice = lower as ModelChoice
  } else {
    // 容错：模型可能写成中文或「开源+闭源」这类混写
    const hasOpen = /开源|open-?source|open-?weight|llama|qwen|mistral|intern|vicuna/i.test(rawChoice)
    const hasClosed = /闭源|closed|proprietary|\bapi\b|gpt|claude|gemini/i.test(rawChoice)
    const saysBoth = /都|both|混合|mix|兼/i.test(rawChoice)
    if (saysBoth || (hasOpen && hasClosed)) modelChoice = 'both'
    else if (hasOpen) modelChoice = 'open'
    else if (hasClosed) modelChoice = 'closed'
    else if (/不涉及|none|n\/a|not-applicable|没(有)?(使用|用到)?.*模型|不使用.*模型/i.test(rawChoice)) {
      modelChoice = 'none'
    }
    else modelChoice = 'unclear'
  }

  const profile: ExperimentProfile = {
    datasets: toStrArray(r.datasets),
    baselines: toStrArray(r.baselines),
    metrics: toStrArray(r.metrics),
    experiments: toExperimentRows(r.experiments),
    ablationCount: toIntOrNull(r.ablationCount ?? r.ablation_count),
    runs: String(r.runs ?? '').trim().slice(0, 300),
    reportsVariance: toBoolOrNull(r.reportsVariance ?? r.reports_variance),
    modelChoice,
    openModels: toStrArray(r.openModels ?? r.open_models, 12),
    closedModels: toStrArray(r.closedModels ?? r.closed_models, 12),
    compute: String(r.compute ?? '').trim().slice(0, 200),
    scale: String(r.scale ?? '').trim().slice(0, 200),
    dataUsage: toDataUsage(r.dataUsage ?? r.data_usage),
    dataUsageNote: String(r.dataUsageNote ?? r.data_usage_note ?? '').trim().slice(0, 200),
    humanEval: String(r.humanEval ?? r.human_eval ?? '').trim().slice(0, 200),
    realWorld: toBoolOrNull(r.realWorld ?? r.real_world),
    note: String(r.note ?? '').trim().slice(0, 300)
  }

  /*
   * 状态位（error / extractedAt）不能用「值为 undefined 的键」表达「没有」。
   *
   * 画像会被 writePaperFile 写进 frontmatter，而那是 js-yaml 序列化 ——
   * js-yaml 遇到值为 undefined 的键会直接抛
   * 「unacceptable kind of an object to dump [object Undefined]」。
   * 实测后果是：**抽取明明成功了，却在落盘这一步整篇抛掉**，
   * 笔记一个字段都没写出去 —— 排查时先怀疑了抽取、投喂、模型，
   * 绕了一大圈才发现死在序列化。
   */
  if (typeof r.error === 'string' && r.error.trim()) {
    profile.error = r.error.trim().slice(0, 300)
  }

  /*
   * 抽取时间只在**真的抽到了内容**时才作数。
   *
   * 不能拿「返回对象里有没有键」当判据：落盘的空骨架本身就带十几个键
   * （datasets: []、compute: "" …），于是每次读盘都被当成「有内容」，
   * 给从未抽取过的论文盖上一个崭新的时间戳，详情页就显示「最近抽取」。
   * 实测过一例：时间戳只比笔记落盘早 2 毫秒 —— 一眼就是读盘时现造的，
   * 排查「实验画像为什么全空」时被它带偏了很久。
   *
   * 用「有没有内容」判断还有个好处：历史数据里那些带假时间戳的空画像
   * 读一次就被清干净，不需要单独写迁移。
   */
  if (profileCompleteness(profile) > 0) {
    profile.extractedAt = r.extractedAt ? String(r.extractedAt) : new Date().toISOString()
  }

  return profile
}

/** 画像信息量评分，用于判断是否值得重新抽取 */
export function profileCompleteness(exp?: ExperimentProfile | null): number {
  if (!exp) return 0
  let score = 0
  if (exp.datasets.length) score += 2
  if (exp.baselines.length) score += 2
  if (exp.metrics.length) score += 2
  /*
   * 实验清单给的权重最高：它是画像里唯一带因果结构的字段，
   * 也是「这篇论文的实验到底讲清楚没有」的直接判据。
   * 主实验与消融分开计分 —— 只做主实验（没做消融）是常见且合理的情况，
   * 不该和「两样都没抽到」拿一样的分。
   */
  if (exp.experiments.length) score += 2
  if (exp.experiments.some((e) => e.kind === 'main')) score += 1
  if (exp.experiments.some((e) => e.kind === 'ablation')) score += 1
  if (exp.ablationCount != null) score += 1
  if (exp.runs) score += 1
  if (exp.reportsVariance != null) score += 1
  if (exp.modelChoice !== 'unclear') score += 2
  if (exp.openModels.length || exp.closedModels.length) score += 1
  if (exp.compute) score += 1
  if (exp.dataUsage !== 'unclear') score += 1
  if (exp.realWorld != null) score += 1
  return score
}

export function hasProfile(exp?: ExperimentProfile | null): boolean {
  return profileCompleteness(exp) >= 4
}

/* ------------------------------------------------------------------ */
/*  聚合：把一批画像算成「这类论文一般怎么做实验」                        */
/* ------------------------------------------------------------------ */

export interface ProfileAggregate {
  total: number
  withProfile: number
  varianceReported: number
  varianceNotReported: number
  varianceUnknown: number
  runsReported: number
  modelChoice: Record<ModelChoice, number>
  topDatasets: { name: string; count: number }[]
  topMetrics: { name: string; count: number }[]
  topBaselines: { name: string; count: number }[]
  /** 用到的模型（开源 + 闭源合在一起按名字计数） */
  topModels: { name: string; count: number }[]
  /**
   * 实验构成：主实验 / 消融 / 分析各有多少条（跨论文累计）。
   *
   * 口径是**行数**不是论文数 —— 它回答的是「这个领域的实验里，
   * 有多少精力花在证明『整体更好』，多少花在证明『每个设计都必要』」。
   */
  experiments: Record<ExperimentKind, number>
  /** 至少列出一条消融实验的论文数 */
  ablationPapers: number
  /** 评估数据使用方式分布 */
  dataUsage: Record<DataUsage, number>
  avgDatasets: number
  avgBaselines: number
  avgAblations: number
  maxAblations: number
  realWorldCount: number
  humanEvalCount: number
  computeNotes: { title: string; compute: string }[]
}

/** 计数表里的一项：归一化的键对应「首次出现的写法」与次数 */
interface NamedCount {
  name: string
  count: number
}

function topCounts(map: Map<string, NamedCount>, limit: number): { name: string; count: number }[] {
  return [...map.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((v) => ({ name: v.name, count: v.count }))
}

/**
 * 同一个东西在不同论文里写法不同（大小写、空格），直接计数会把
 * 「GPT-4o」和「gpt-4o」算成两个 —— 跨论文统计里这会凭空制造出一堆
 * 「用过一次的模型」，让排行榜全是噪音。
 *
 * 所以以小写去空格后的形式为键，值里带着**首次出现的原始写法**供显示。
 * 刻意不做「单复数 / 缩写」的进一步归并：那需要领域词典，猜错会把
 * 「BERT」和「BERT-base」这类本来有区别的东西并成一个。
 */
function addName(map: Map<string, NamedCount>, raw: string): void {
  const name = raw.trim()
  if (!name) return
  const key = name.toLowerCase().replace(/\s+/g, ' ')
  const cur = map.get(key)
  if (cur) cur.count++
  else map.set(key, { name, count: 1 })
}

export function aggregateProfiles(
  rows: { title: string; exp?: ExperimentProfile | null }[]
): ProfileAggregate {
  const modelChoice: Record<ModelChoice, number> = {
    open: 0,
    closed: 0,
    both: 0,
    none: 0,
    unclear: 0
  }
  const dataUsage: Record<DataUsage, number> = { full: 0, sampled: 0, both: 0, unclear: 0 }
  const experiments: Record<ExperimentKind, number> = { main: 0, ablation: 0, analysis: 0 }
  const datasets = new Map<string, NamedCount>()
  const metrics = new Map<string, NamedCount>()
  const baselines = new Map<string, NamedCount>()
  const models = new Map<string, NamedCount>()
  const computeNotes: { title: string; compute: string }[] = []

  let withProfile = 0
  let ablationPapers = 0
  let varianceReported = 0
  let varianceNotReported = 0
  let varianceUnknown = 0
  let runsReported = 0
  let realWorldCount = 0
  let humanEvalCount = 0
  let dsSum = 0
  let blSum = 0
  let abSum = 0
  let abN = 0
  let abMax = 0

  for (const row of rows) {
    const exp = row.exp
    if (!hasProfile(exp)) continue
    withProfile++

    if (exp!.reportsVariance === true) varianceReported++
    else if (exp!.reportsVariance === false) varianceNotReported++
    else varianceUnknown++
    if (exp!.runs) runsReported++
    if (exp!.realWorld === true) realWorldCount++
    if (exp!.humanEval) humanEvalCount++

    modelChoice[exp!.modelChoice]++
    dataUsage[exp!.dataUsage]++
    if (exp!.experiments.some((e) => e.kind === 'ablation')) ablationPapers++
    for (const e of exp!.experiments) experiments[e.kind]++

    for (const d of exp!.datasets) addName(datasets, d)
    for (const m of exp!.metrics) addName(metrics, m)
    for (const b of exp!.baselines) addName(baselines, b)
    for (const m of exp!.openModels) addName(models, m)
    for (const m of exp!.closedModels) addName(models, m)

    dsSum += exp!.datasets.length
    blSum += exp!.baselines.length
    if (exp!.ablationCount != null) {
      abSum += exp!.ablationCount
      abN++
      abMax = Math.max(abMax, exp!.ablationCount)
    }
    if (exp!.compute) computeNotes.push({ title: row.title, compute: exp!.compute })
  }

  const n = Math.max(1, withProfile)
  return {
    total: rows.length,
    withProfile,
    varianceReported,
    varianceNotReported,
    varianceUnknown,
    runsReported,
    modelChoice,
    topDatasets: topCounts(datasets, 12),
    topMetrics: topCounts(metrics, 12),
    topBaselines: topCounts(baselines, 12),
    topModels: topCounts(models, 12),
    experiments,
    ablationPapers,
    dataUsage,
    avgDatasets: Math.round((dsSum / n) * 10) / 10,
    avgBaselines: Math.round((blSum / n) * 10) / 10,
    avgAblations: abN ? Math.round((abSum / abN) * 10) / 10 : 0,
    maxAblations: abMax,
    realWorldCount,
    humanEvalCount,
    computeNotes: computeNotes.slice(0, 20)
  }
}

/* ------------------------------------------------------------------ */
/*  领域聚合：把「这批论文」换成「每个方向各自怎么做」                    */
/* ------------------------------------------------------------------ */

/**
 * 一个方向的实验惯例。
 *
 * 为什么要有这一层：`aggregateProfiles` 算的是**当前筛选范围**的一个总览 ——
 * 它回答「我挑出来的这 20 篇怎么做实验」。但真正有信息量的问法是
 * 「Agent 方向和 RAG 方向各自怎么做实验、差在哪」：同一个数字放在
 * 混合样本里会被互相抵消 —— 「平均 4.2 个数据集」既不像 Agent 也不像 NLP，
 * 而「Agent 常用 success rate、NLP 常用 F1」才是能带走的知识。
 *
 * 所以这里按分类逐个聚合，让不同方向可以并排比较。
 */
export interface DomainNorm {
  /** 分类 id（内置分类是固定 id，自定义分类用其 id） */
  id: string
  /** 分类显示名 */
  label: string
  /** 该方向下的论文总数（含没抽过画像的） */
  papers: number
  aggregate: ProfileAggregate
}

/** 领域聚合默认要求的最少论文数：1 篇谈不上「惯例」 */
export const DOMAIN_MIN_PAPERS = 2

/**
 * 按分类聚合成各方向的实验惯例。
 *
 * 一篇论文可以属于多个分类，会分别计入 —— 这是刻意的：
 * 交叉方向的论文本来就同时属于两边，强行只算一次反而失真。
 * 代价是各方向的论文数之和会大于总论文数，界面上不显示「合计」即可避免误读。
 *
 * @param papers 论文（至少要有 categories 与 exp）
 * @param labelOf 分类 id → 显示名（调用方掌握分类表，包括自定义分类）
 * @param minPapers 少于这个数就跳过（默认 2）
 */
export function buildDomainNorms(
  papers: { id: string; title: string; categories: string[]; exp?: ExperimentProfile | null }[],
  labelOf: (id: string) => string,
  minPapers = DOMAIN_MIN_PAPERS
): DomainNorm[] {
  const byCategory = new Map<string, { id: string; title: string; exp?: ExperimentProfile | null }[]>()
  for (const p of papers) {
    for (const c of p.categories) {
      if (!byCategory.has(c)) byCategory.set(c, [])
      byCategory.get(c)!.push({ id: p.id, title: p.title, exp: p.exp })
    }
  }

  const out: DomainNorm[] = []
  for (const [id, list] of byCategory) {
    if (list.length < minPapers) continue
    out.push({
      id,
      label: labelOf(id) || id,
      papers: list.length,
      aggregate: aggregateProfiles(list)
    })
  }

  /*
   * 排序按「有画像的论文数」而不是论文总数：
   * 一个方向有 20 篇但都没抽过画像，在惯例面板里是空的 ——
   * 它不该排在「有 8 篇、每篇都抽全了」的方向前面。
   */
  return out.sort(
    (a, b) =>
      b.aggregate.withProfile - a.aggregate.withProfile ||
      b.papers - a.papers ||
      a.label.localeCompare(b.label)
  )
}
