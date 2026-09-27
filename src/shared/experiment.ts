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

export interface ExperimentProfile {
  /** 数据集 / 测试集名称 */
  datasets: string[]
  /** 对比的基线系统名称 */
  baselines: string[]
  /** 评估指标名称 */
  metrics: string[]
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
   * 都是 14 个空字段。不把失败原因单独记下来，界面上就无从区分，
   * 用户只能看到一片「原文未说明」，既不知道系统出了错，也不知道该不该重试。
   */
  error?: string
}

export function emptyExperimentProfile(): ExperimentProfile {
  return {
    datasets: [],
    baselines: [],
    metrics: [],
    ablationCount: null,
    runs: '',
    reportsVariance: null,
    modelChoice: 'unclear',
    openModels: [],
    closedModels: [],
    compute: '',
    scale: '',
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
    ablationCount: toIntOrNull(r.ablationCount ?? r.ablation_count),
    runs: String(r.runs ?? '').trim().slice(0, 300),
    reportsVariance: toBoolOrNull(r.reportsVariance ?? r.reports_variance),
    modelChoice,
    openModels: toStrArray(r.openModels ?? r.open_models, 12),
    closedModels: toStrArray(r.closedModels ?? r.closed_models, 12),
    compute: String(r.compute ?? '').trim().slice(0, 200),
    scale: String(r.scale ?? '').trim().slice(0, 200),
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
   * 不能拿「返回对象里有没有键」当判据：落盘的空骨架本身就带 14 个键
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
  if (exp.ablationCount != null) score += 1
  if (exp.runs) score += 1
  if (exp.reportsVariance != null) score += 1
  if (exp.modelChoice !== 'unclear') score += 2
  if (exp.openModels.length || exp.closedModels.length) score += 1
  if (exp.compute) score += 1
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
  avgDatasets: number
  avgBaselines: number
  avgAblations: number
  maxAblations: number
  realWorldCount: number
  humanEvalCount: number
  computeNotes: { title: string; compute: string }[]
}

function topCounts(map: Map<string, number>, limit: number): { name: string; count: number }[] {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
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
  const datasets = new Map<string, number>()
  const metrics = new Map<string, number>()
  const baselines = new Map<string, number>()
  const computeNotes: { title: string; compute: string }[] = []

  let withProfile = 0
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

    for (const d of exp!.datasets) datasets.set(d, (datasets.get(d) ?? 0) + 1)
    for (const m of exp!.metrics) metrics.set(m, (metrics.get(m) ?? 0) + 1)
    for (const b of exp!.baselines) baselines.set(b, (baselines.get(b) ?? 0) + 1)

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
    avgDatasets: Math.round((dsSum / n) * 10) / 10,
    avgBaselines: Math.round((blSum / n) * 10) / 10,
    avgAblations: abN ? Math.round((abSum / abN) * 10) / 10 : 0,
    maxAblations: abMax,
    realWorldCount,
    humanEvalCount,
    computeNotes: computeNotes.slice(0, 20)
  }
}
