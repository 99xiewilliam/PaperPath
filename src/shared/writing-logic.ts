/**
 * 写作逻辑卡：把「这篇论文的论证是怎么搭起来的」抽成**可比较的结构**。
 *
 * 为什么非要结构化，而不是再写一节散文：
 *   - 散文没法聚合。想回答「这 12 篇里有多少篇是靠否定前人方法开局的」，
 *     只能让模型每次重读一遍再重新数，结论每次措辞都不同，攒不出套路。
 *   - 结构化之后，「引用它当靶子 / 当垫脚石 / 当共识」是字段而不是修辞，
 *     跨论文的分布才可计算；这也是「很多篇逻辑一样」能被自动串起来的前提。
 *
 * 与「写作手法」维度（main/lenses/writing.ts）的分工：
 *   - 写作手法 = 给人读的散文（可编辑、可重写），回答「这一节怎么写」；
 *   - 写作逻辑卡 = 给机器聚合的数据，回答「为什么这么写、靠什么撑住」。
 * 两者不重复：散文里的判断可以随手改，逻辑卡的字段要能参与统计。
 */

/* ------------------------------------------------------------------ */
/*  受控词表                                                           */
/* ------------------------------------------------------------------ */

/**
 * 故事线类型。这一维区分的是**开局的攻法**，不是论文主题。
 *
 * 为什么要枚举而不是让模型自由写：这是聚类的主要锚点。自由文本里
 * 「现有方法存在不足」有几十种写法，永远聚不到一起。
 */
export const NARRATIVE_TYPES = [
  'gap-driven',
  'failure-mode',
  'new-capability',
  'efficiency',
  'unification',
  'scaling',
  'reliability'
] as const

export type NarrativeType = (typeof NARRATIVE_TYPES)[number]

export const NARRATIVE_LABEL: Record<NarrativeType, string> = {
  'gap-driven': '补缺口',
  'failure-mode': '拆失败模式',
  'new-capability': '定义新能力',
  efficiency: '降本增效',
  unification: '统一分散做法',
  scaling: '推向大规模',
  reliability: '提升可靠性'
}

/** 这个类型的开局在替读者建立什么共识（聚类卡上用来解释「为什么归到一类」） */
export const NARRATIVE_HINT: Record<NarrativeType, string> = {
  'gap-driven': '承认现有方向对，指出没人做过的那个缺口',
  'failure-mode': '先让读者看到任务失败长什么样，再问现有方法为什么接不住',
  'new-capability': '先证明这件事现在能做、以前做不了，再定义问题',
  efficiency: '承认能力已具备，但代价高到没法用',
  unification: '承认各条线都对，但彼此不可比、无法复用',
  scaling: '小规模可行，一放大就崩',
  reliability: '方法在理想条件下成立，真实条件下不可信'
}

/**
 * 一篇被引工作在论证里**承担什么功能**。
 *
 * 这是在回答「为啥去提这些」。同一篇工作，在 A 文里是靶子、在 B 文里是垫脚石，
 * 而这个差别决定了作者要把自己的优势定义在哪 —— 所以它必须和优势维度配对记录。
 */
export const CITATION_ROLES = [
  'target',
  'stepping-stone',
  'consensus',
  'threat',
  'tool',
  'background'
] as const

export type CitationRole = (typeof CITATION_ROLES)[number]

export const CITATION_ROLE_LABEL: Record<CitationRole, string> = {
  target: '靶子',
  'stepping-stone': '垫脚石',
  consensus: '共识基础',
  threat: '必须回应的强baseline',
  tool: '直接借用',
  background: '背景铺陈'
}

export const CITATION_ROLE_HINT: Record<CitationRole, string> = {
  target: '被直接否定或指出失效',
  'stepping-stone': '先承认其贡献，再推到它够不到的边界',
  consensus: '用来建立领域共识，不需要反驳',
  threat: '强到必须专门解释「我和它有什么不同」',
  tool: '当作组件 / 数据 / 指标直接使用',
  background: '说明问题重要或历史悠久，不参与对比'
}

/**
 * 优势维度。这是「为了凸显什么」的唯一口径。
 *
 * 收得比较窄是刻意的：维度一多，每篇的分布就摊平成「什么都提一点」，
 * 统计上等于没有信号。宁可把复杂优势归到最接近的一档，也不要放开自由文本。
 */
export const ADVANTAGE_DIMENSIONS = [
  'accuracy',
  'efficiency',
  'cost',
  'generalization',
  'data-efficiency',
  'robustness',
  'interpretability',
  'deployability',
  'scale',
  'simplicity',
  'controllability'
] as const

export type AdvantageDimension = (typeof ADVANTAGE_DIMENSIONS)[number]

export const ADVANTAGE_LABEL: Record<AdvantageDimension, string> = {
  accuracy: '效果更好',
  efficiency: '更快 / 更省算力',
  cost: '成本更低',
  generalization: '泛化更广',
  'data-efficiency': '更少数据',
  robustness: '更鲁棒',
  interpretability: '更可解释',
  deployability: '更易部署',
  scale: '更能扩展',
  simplicity: '更简单',
  controllability: '更可控'
}

/* ------------------------------------------------------------------ */
/*  数据结构                                                           */
/* ------------------------------------------------------------------ */

/** Introduction 里的一段：它替读者解决哪个疑问、用哪句话、我写时换成什么 */
export interface WritingParagraph {
  /** 第几段（从 1 开始） */
  n: number
  /** 这一段在回答读者的哪个疑问 */
  question: string
  /** 英文原句（判断的依据） */
  quote: string
  /** 我写自己的论文时，这一段换成什么内容 */
  slot: string
}

/** 一条被引工作，以及它在论证里干的活 */
export interface CitedWork {
  /** 引用标识：方法名，或「作者 年份」 */
  work: string
  /** 出现在哪一节 */
  section: string
  role: CitationRole
  /** 它反衬出本文的哪个优势（role=background/tool 时可以为空） */
  highlights: AdvantageDimension[]
  /** 支撑判断的英文原句 */
  quote?: string
}

/** 一条贡献声明 */
export interface ContributionItem {
  /** 声称了什么 */
  claim: string
  /** 主张类型：补的是缺口 / 给的是机制 / 给的是证据 */
  kind: 'gap' | 'mechanism' | 'evidence'
  /** 回扣前文哪一个缺口 */
  backsGap: string
  /** 由什么支撑（哪张表、哪个实验、哪节方法） */
  support: string
}

/** Related Work 里的一类工作 */
export interface RelatedWorkGroup {
  /** 这一类的名字（作者自己怎么叫它） */
  label: string
  /** 这一类的共同做法，一句话 */
  gist: string
  /** 这一类最后被留下的缺口 */
  gap: string
  quote?: string
}

/** Method 的一步：讲什么、要证明什么、配了什么图 */
export interface MethodStep {
  step: string
  /** 这一节要证明什么（而不是「讲了什么」） */
  purpose: string
  figure?: string
}

/** 一条优势声明：我强在哪、靠什么撑住 */
export interface AdvantageClaim {
  dimension: AdvantageDimension
  /** 具体怎么说的 */
  claim: string
  /** 由什么支撑：引用反衬 / 实验数字 / 机制设计 */
  support: string
}

export interface WritingLogic {
  storyline: {
    type: NarrativeType
    /** 一句话主线：作者要读者依次接受什么 */
    oneliner: string
    pain: string
    gap: string
    insight: string
    validation: string
  }
  intro: {
    paragraphs: WritingParagraph[]
    /** Gap 从哪一句开始转向（原句） */
    gapTurn: string
    contributions: ContributionItem[]
  }
  citedWorks: CitedWork[]
  advantages: AdvantageClaim[]
  relatedWork: {
    /** 按什么轴分类（例如「按是否需要训练」） */
    axis: string
    groups: RelatedWorkGroup[]
    /** 自己插在哪一类的后面、用哪句话划开距离 */
    positioning: string
  }
  method: {
    steps: MethodStep[]
    /** 设计选择怎么被论证成「只能这么选」 */
    argument: string
  }
  /** 可复用的英文短语（与句式库同源，但只取本篇论证结构里的关键句） */
  phrases?: string[]
  extractedAt?: string
}

/* ------------------------------------------------------------------ */
/*  归一化                                                             */
/* ------------------------------------------------------------------ */

/**
 * 从 frontmatter 读回来的写作逻辑卡做归一化。
 *
 * 和 normalizePaperGraph 同一套理由：frontmatter 是用户可手改的 YAML，
 * 形状不可能保证 —— 枚举拼错、数组写成标量、引用角色写成中文，
 * 不归一化的话一个手改过的字段就能让整个「写作思路」页崩掉。
 *
 * 另外**值为 undefined 的键一律不加**：js-yaml 遇到 undefined 会直接抛，
 * 后果是整篇笔记在落盘那一步全丢（见 vault.ts 里 stripUndefined 的注释）。
 */
const NARRATIVE_SET = new Set<string>(NARRATIVE_TYPES)
const ROLE_SET = new Set<string>(CITATION_ROLES)
const ADVANTAGE_SET = new Set<string>(ADVANTAGE_DIMENSIONS)

/** 文本截断：frontmatter 不是文章，超长字段只说明抽取跑偏了 */
function text(value: unknown, max = 400): string {
  const s = String(value ?? '').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function advList(value: unknown, limit = 4): AdvantageDimension[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const out: AdvantageDimension[] = []
  for (const item of raw) {
    const key = String(item ?? '').trim().toLowerCase()
    if (!ADVANTAGE_SET.has(key) || out.includes(key as AdvantageDimension)) continue
    out.push(key as AdvantageDimension)
    if (out.length >= limit) break
  }
  return out
}

export function normalizeWritingLogic(raw: unknown): WritingLogic | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>

  const st = (r.storyline ?? {}) as Record<string, unknown>
  const oneliner = text(st.oneliner, 300)
  const type = String(st.type ?? '').trim().toLowerCase()
  /*
   * 没有故事线主线的卡片视为无效：这张卡的全部价值在于「一句话讲清论证顺序」，
   * 讲不出来说明这次抽取没读懂，留着只会在聚类里制造噪声。
   */
  if (!oneliner) return undefined

  const introRaw = (r.intro ?? {}) as Record<string, unknown>
  const paragraphs: WritingParagraph[] = []
  for (const item of Array.isArray(introRaw.paragraphs) ? introRaw.paragraphs : []) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    const question = text(p.question, 200)
    if (!question) continue
    paragraphs.push({
      n: Number(p.n) || paragraphs.length + 1,
      question,
      quote: text(p.quote, 400),
      slot: text(p.slot, 200)
    })
    if (paragraphs.length >= 8) break
  }

  const contributions: ContributionItem[] = []
  for (const item of Array.isArray(introRaw.contributions) ? introRaw.contributions : []) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    const claim = text(c.claim, 300)
    if (!claim) continue
    const kind = String(c.kind ?? '').trim().toLowerCase()
    contributions.push({
      claim,
      kind: kind === 'mechanism' || kind === 'evidence' ? kind : 'gap',
      backsGap: text(c.backsGap, 200),
      support: text(c.support, 200)
    })
    if (contributions.length >= 6) break
  }

  const citedWorks: CitedWork[] = []
  const seenWork = new Set<string>()
  for (const item of Array.isArray(r.citedWorks) ? r.citedWorks : []) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    const work = text(c.work, 120)
    if (!work) continue
    const key = work.toLowerCase()
    if (seenWork.has(key)) continue
    seenWork.add(key)
    const role = String(c.role ?? '').trim().toLowerCase()
    const entry: CitedWork = {
      work,
      section: text(c.section, 40) || 'Introduction',
      role: ROLE_SET.has(role) ? (role as CitationRole) : 'background',
      highlights: advList(c.highlights)
    }
    const quote = text(c.quote, 400)
    if (quote) entry.quote = quote
    citedWorks.push(entry)
    if (citedWorks.length >= 20) break
  }

  const advantages: AdvantageClaim[] = []
  for (const item of Array.isArray(r.advantages) ? r.advantages : []) {
    if (!item || typeof item !== 'object') continue
    const a = item as Record<string, unknown>
    const dim = String(a.dimension ?? '').trim().toLowerCase()
    const claim = text(a.claim, 300)
    if (!claim || !ADVANTAGE_SET.has(dim)) continue
    advantages.push({
      dimension: dim as AdvantageDimension,
      claim,
      support: text(a.support, 300)
    })
    if (advantages.length >= 6) break
  }

  const rwRaw = (r.relatedWork ?? {}) as Record<string, unknown>
  const groups: RelatedWorkGroup[] = []
  for (const item of Array.isArray(rwRaw.groups) ? rwRaw.groups : []) {
    if (!item || typeof item !== 'object') continue
    const g = item as Record<string, unknown>
    const label = text(g.label, 120)
    if (!label) continue
    const group: RelatedWorkGroup = {
      label,
      gist: text(g.gist, 300),
      gap: text(g.gap, 300)
    }
    const quote = text(g.quote, 400)
    if (quote) group.quote = quote
    groups.push(group)
    if (groups.length >= 6) break
  }

  const mRaw = (r.method ?? {}) as Record<string, unknown>
  const steps: MethodStep[] = []
  for (const item of Array.isArray(mRaw.steps) ? mRaw.steps : []) {
    if (!item || typeof item !== 'object') continue
    const s = item as Record<string, unknown>
    const step = text(s.step, 200)
    if (!step) continue
    const entry: MethodStep = { step, purpose: text(s.purpose, 300) }
    const figure = text(s.figure, 60)
    if (figure) entry.figure = figure
    steps.push(entry)
    if (steps.length >= 8) break
  }

  const phrases = (Array.isArray(r.phrases) ? r.phrases : [])
    .map((p) => text(p, 200))
    .filter(Boolean)
    .slice(0, 8)

  const logic: WritingLogic = {
    storyline: {
      type: NARRATIVE_SET.has(type) ? (type as NarrativeType) : 'gap-driven',
      oneliner,
      pain: text(st.pain, 300),
      gap: text(st.gap, 300),
      insight: text(st.insight, 300),
      validation: text(st.validation, 300)
    },
    intro: {
      paragraphs,
      gapTurn: text(introRaw.gapTurn, 300),
      contributions
    },
    citedWorks,
    advantages,
    relatedWork: {
      axis: text(rwRaw.axis, 200),
      groups,
      positioning: text(rwRaw.positioning, 300)
    },
    method: {
      steps,
      argument: text(mRaw.argument, 300)
    }
  }
  if (phrases.length) logic.phrases = phrases
  if (typeof r.extractedAt === 'string' && r.extractedAt) logic.extractedAt = r.extractedAt
  return logic
}

/* ------------------------------------------------------------------ */
/*  聚类：把「逻辑一样」的论文串起来                                    */
/* ------------------------------------------------------------------ */

/**
 * 两张卡有多像（0-1）。
 *
 * 三个信号，权重按「谁更能说明论证结构相同」排：
 *   1. **故事线类型**：开局攻法一样，基本就是同一套论证模板 —— 权重最高；
 *   2. **优势维度集合**：都在拿「更省算力」当卖点，说明边界定义一致；
 *   3. **引用角色分布**：靠否定前人开局 vs 靠借用组件开局，骨架差别很大。
 *
 * 刻意不用引用**具体某篇工作**做信号：不同领域引的是不同论文，
 * 拿它做相似度只会把同一套路拆散。
 */
export function writingLogicSimilarity(a: WritingLogic, b: WritingLogic): number {
  let score = 0
  if (a.storyline.type === b.storyline.type) score += 0.45

  const advA = new Set(a.advantages.map((x) => x.dimension))
  const advB = new Set(b.advantages.map((x) => x.dimension))
  score += 0.3 * jaccard(advA, advB)

  score += 0.25 * roleCosine(a.citedWorks, b.citedWorks)
  return score
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let hit = 0
  for (const x of a) if (b.has(x)) hit++
  return hit / (a.size + b.size - hit)
}

/**
 * 引用角色分布的余弦相似度。
 *
 * 用分布而不是集合：几乎所有论文都会引「背景」类工作，集合相似度会被这一档拉平；
 * 分布比的是**各类占比**，靠靶子开局和靠工具堆起来的论文才分得开。
 */
function roleCosine(a: CitedWork[], b: CitedWork[]): number {
  const va = roleVector(a)
  const vb = roleVector(b)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < va.length; i++) {
    dot += va[i] * vb[i]
    na += va[i] * va[i]
    nb += vb[i] * vb[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function roleVector(works: CitedWork[]): number[] {
  const counts = new Array(CITATION_ROLES.length).fill(0)
  for (const w of works) {
    const idx = CITATION_ROLES.indexOf(w.role)
    if (idx >= 0) counts[idx]++
  }
  const total = counts.reduce((s, n) => s + n, 0)
  // 没有引用记录的卡片不参与这一项，返回全 0（余弦为 0），不影响其它信号
  return total ? counts.map((n) => n / total) : counts
}

/** 相似度阈值：0.55 约等于「类型相同 + 优势有一半重叠」，或「类型相同 + 引用结构极像」 */
export const PATTERN_THRESHOLD = 0.55

export interface WritingPattern {
  /** 稳定 id：成员论文 id 排序后取哈希前缀，成员变了 id 就变（套路是临时视图，不是实体） */
  id: string
  type: NarrativeType
  /** 这个套路的代表优势（成员里出现最多的维度） */
  topAdvantages: AdvantageDimension[]
  /** 成员论文 id（按相似度聚好的） */
  memberIds: string[]
  /** 成员两两相似度的平均值，用来判断这一簇紧不紧 */
  cohesion: number
}

/**
 * 把一批写作逻辑卡按相似度聚成若干套路。
 *
 * 算法是单链接 + 连通分量，不是 k-means：套路数**事先未知**（可能 3 个，也可能全是
 * 各自为战），而且相似度是「这一对像不像」这种成对判断，硬凑 k 个中心会把
 * 明显不同的论文塞进同一簇。单链接的已知缺点是可能串成一条链（A像B、B像C、A不像C），
 * 所以额外用 `cohesion` 把松散的簇标出来，界面上如实显示。
 *
 * 只返回成员 >= 2 的簇：单篇不构成「套路」，它们单独列在 `singletons` 里
 * —— 把单篇也当日式厚的手册卖，等于编。
 */
export function clusterWritingPatterns(
  items: { paperId: string; logic: WritingLogic }[]
): { patterns: WritingPattern[]; singletons: string[] } {
  const n = items.length
  if (!n) return { patterns: [], singletons: [] }

  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }

  const sim = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = writingLogicSimilarity(items[i].logic, items[j].logic)
      sim.set(`${i}|${j}`, s)
      if (s >= PATTERN_THRESHOLD) union(i, j)
    }
  }

  const buckets = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const list = buckets.get(root) ?? []
    list.push(i)
    buckets.set(root, list)
  }

  const patterns: WritingPattern[] = []
  const singletons: string[] = []

  for (const idxs of buckets.values()) {
    if (idxs.length < 2) {
      singletons.push(items[idxs[0]].paperId)
      continue
    }
    const memberIds = idxs.map((i) => items[i].paperId).sort()
    patterns.push({
      id: patternId(memberIds),
      type: dominantType(idxs.map((i) => items[i].logic)),
      topAdvantages: dominantAdvantages(idxs.map((i) => items[i].logic)),
      memberIds,
      cohesion: averageCohesion(idxs, sim)
    })
  }

  // 稳定的展示顺序：成员多的在前，同样多按 id
  patterns.sort((a, b) => b.memberIds.length - a.memberIds.length || a.id.localeCompare(b.id))
  return { patterns, singletons }
}

/** 簇内两两相似度的平均值（只算实际连过边的对，避免被远距离对拉低） */
function averageCohesion(idxs: number[], sim: Map<string, number>): number {
  let sum = 0
  let count = 0
  for (let a = 0; a < idxs.length; a++) {
    for (let b = a + 1; b < idxs.length; b++) {
      const i = Math.min(idxs[a], idxs[b])
      const j = Math.max(idxs[a], idxs[b])
      const s = sim.get(`${i}|${j}`)
      if (s == null) continue
      sum += s
      count++
    }
  }
  return count ? sum / count : 0
}

function dominantType(list: WritingLogic[]): NarrativeType {
  const counts = new Map<NarrativeType, number>()
  for (const l of list) counts.set(l.storyline.type, (counts.get(l.storyline.type) ?? 0) + 1)
  let best: NarrativeType = list[0].storyline.type
  let max = 0
  for (const [type, count] of counts) {
    if (count > max) {
      max = count
      best = type
    }
  }
  return best
}

function dominantAdvantages(list: WritingLogic[], limit = 3): AdvantageDimension[] {
  const counts = new Map<AdvantageDimension, number>()
  for (const l of list) for (const a of l.advantages) {
    counts.set(a.dimension, (counts.get(a.dimension) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([dim]) => dim)
}

/**
 * 簇 id：成员 id 排序后取一个短哈希。
 *
 * 不用递增序号，也不用类型名：成员一变，它就该是一个**新的**套路 ——
 * 沿用旧 id 会让「上次看的那个套路」和「这次看到的内容」悄悄错位。
 * 这是临时视图，不是需要长期引用的实体，所以不需要稳定标识。
 */
function patternId(memberIds: string[]): string {
  const s = memberIds.join('|')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return `wp${(h >>> 0).toString(36)}`
}

/**
 * 一张卡的完成度（0-1），用于在界面上区分「抽了一半」和「抽全了」。
 *
 * 不用「有没有 extractedAt」判断：截断抢救会让记录看起来成功而实际只落了几块，
 * 这个数字至少能让人看出缺的是哪一块。
 */
export function writingLogicCompleteness(logic: WritingLogic | undefined): number {
  if (!logic) return 0
  const checks = [
    Boolean(logic.storyline.oneliner),
    Boolean(logic.storyline.gap),
    logic.intro.paragraphs.length > 0,
    logic.intro.contributions.length > 0,
    logic.citedWorks.length > 0,
    logic.advantages.length > 0,
    logic.relatedWork.groups.length > 0,
    logic.method.steps.length > 0
  ]
  return checks.filter(Boolean).length / checks.length
}

/* ------------------------------------------------------------------ */
/*  页面快照                                                           */
/* ------------------------------------------------------------------ */

/** 「写作思路」页的一张卡 */
export interface WritingCard {
  paperId: string
  title: string
  year: number | null
  categories: string[]
  /** 还没有跑过这个维度时为 undefined */
  logic?: WritingLogic
  /** 0-1；没有卡为 0 */
  completeness: number
  /** 缺哪几块（没有卡时是「还没有写作逻辑卡」） */
  missing: string[]
}

export interface WritingOverview {
  cards: WritingCard[]
  patterns: WritingPattern[]
  /** 没凑成套路的论文 id（单篇不构成套路） */
  singletons: string[]
}

/**
 * 把索引里的原始行组装成页面快照。
 *
 * 聚类放在**主进程**做而不是渲染层：它要读全部卡片的字段，而渲染层拿到的
 * 应该是已经算好的结果 —— 同一个算法在两处各写一遍，早晚会分叉成两种套路。
 * 这个函数是纯的，所以也能被 smoke 脚本直接喂数据验证。
 */
export function buildWritingOverview(
  rows: {
    id: string
    title: string
    year: number | null
    categories: string[]
    wlogic?: WritingLogic
  }[]
): WritingOverview {
  const cards: WritingCard[] = rows.map((r) => ({
    paperId: r.id,
    title: r.title,
    year: r.year,
    categories: r.categories,
    logic: r.wlogic,
    completeness: writingLogicCompleteness(r.wlogic),
    missing: writingLogicMissing(r.wlogic)
  }))

  const withLogic = cards
    .filter((c): c is WritingCard & { logic: WritingLogic } => c.logic != null)
    .map((c) => ({ paperId: c.paperId, logic: c.logic }))

  const { patterns, singletons } = clusterWritingPatterns(withLogic)
  return { cards, patterns, singletons }
}

/** 界面上的缺口提示：缺哪一块就明说，不要让人对着半张卡猜 */
export function writingLogicMissing(logic: WritingLogic | undefined): string[] {
  if (!logic) return ['还没有写作逻辑卡']
  const out: string[] = []
  if (!logic.intro.paragraphs.length) out.push('Introduction 逐段')
  if (!logic.intro.contributions.length) out.push('贡献段')
  if (!logic.citedWorks.length) out.push('引用功能')
  if (!logic.advantages.length) out.push('优势对齐')
  if (!logic.relatedWork.groups.length) out.push('Related Work 分类')
  if (!logic.method.steps.length) out.push('方法论证链')
  return out
}
