/**
 * AI 自动标重点。
 *
 * 给初学者的功能：他们自己读全文又慢又抓不住重点，所以让模型把
 * 「读这篇论文最不该跳过的句子」直接标在原文版面上 —— 每条都带一句
 * 「为什么这是重点」，标得多了，初学者自己就学会怎么抓重点了。
 *
 * 关键设计：模型**不返回原文文本**，只返回行号区间。
 * 行（含页面矩形）由渲染层从 pdfjs 的 textContent 抽出来编好号发给主进程，
 * 模型挑区间，我们再拿行号回查出矩形和文字 —— 所以标注的位置永远是真的，
 * 不存在「模型编了一句原文里不存在的话，还标在了错的页上」这种幻觉。
 *
 * 标注重入按「内容类型」拆成 4 个专家 agent（问题动机 / 核心方法 / 实验
 * 与结果 / 结论与局限），各喂各的章节、各有配额。这个文件因此持有拆分
 * 所需的全部纯函数：章节标题归类、标题 → 行段分配、区间校验、跨专家
 * 合并、行 → 高亮换算 —— 全都能在脚本里测（smoke:parse）。
 * prompt 与模型调用在 src/main/agents/autohighlight.ts。
 */
import {
  AI_HIGHLIGHT_COLOR,
  normalizeRect,
  type Highlight,
  type HighlightRect
} from './highlights'

/** 渲染层从 PDF 抽出来的一行（矩形已按页面宽高归一化） */
export interface SourceLine {
  /** 全局行号，prompt 里给模型引用的就是它 */
  id: number
  /** 页码，从 1 开始 */
  page: number
  text: string
  rect: HighlightRect
}

export type HighlightKind =
  | 'problem'
  | 'method'
  | 'experiment'
  | 'result'
  | 'conclusion'
  | 'other'

export const HIGHLIGHT_KIND_LABEL: Record<HighlightKind, string> = {
  problem: '问题动机',
  method: '核心方法',
  experiment: '关键实验',
  result: '主要结果',
  conclusion: '结论与局限',
  other: '其他'
}

/** 一次最多标多少处：标满整页就等于没标，初学者反而更不知道看哪 */
const MAX_PICKS = 24
/** 单个区间最多几行：粒度是「一句话 / 一个论点」，不是整段 */
const MAX_SPAN_LINES = 6
const MAX_WHY = 120
const MAX_TEXT = 300
/**
 * 发给模型的行文本总预算（字符）。超了从尾部截 —— 末尾通常是参考文献，价值最低。
 * 约 12 万字符 ≈ 3 万 token：对 GLM / GPT 级别的上下文窗口（≥128k）很宽裕，
 * 定这个值是为了让 40 页以内的论文**全文**进模型（含附录消融）；
 * 再往上截主要是延迟 / 成本，以及行号列表过长时模型引用精度下降 ——
 * 引用错行号的区间会被 normalizeAutoHighlights 整条丢弃，宁可少标不可错标。
 */
export const AUTO_HIGHLIGHT_BUDGET = 120000

/* ------------------------------------------------------------------ */
/*  输入预算                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把预算内的行编成模型可引用的文本。
 * 超预算从尾部截断并标记 —— 末尾一般是参考文献 / 附录，损失最小。
 */
export function clipLinesForBudget(
  lines: SourceLine[],
  budget = AUTO_HIGHLIGHT_BUDGET
): { lines: SourceLine[]; truncated: boolean } {
  let used = 0
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    used += lines[i].text.length + 12 // 行号与换行的开销
    if (used > budget) {
      end = i
      break
    }
  }
  return { lines: lines.slice(0, Math.max(1, end)), truncated: end < lines.length }
}

/* ------------------------------------------------------------------ */
/*  按类型拆分：章节标题归类、标题 → 行段分配                              */
/* ------------------------------------------------------------------ */

/** 拆分后的 4 个专家各管一类重点（experiment 专家同时负责 result 类） */
export type AgentKind = 'problem' | 'method' | 'experiment' | 'conclusion'

export const AGENT_KINDS: readonly AgentKind[] = ['problem', 'method', 'experiment', 'conclusion']

/**
 * 从抽取文本里按出现顺序取出章节标题（`## ` 行的正文部分）。
 * 这些标记是导入时按字号启发式打上的（renderer/src/lib/pdfText 的 markHeadings），
 * 是主进程不用重新解析 PDF 就能拿到的最可靠的结构信息。
 */
export function extractHeadingTitles(extractedText: string): string[] {
  const titles: string[] = []
  for (const line of extractedText.split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m?.[1]) titles.push(m[1])
  }
  return titles
}

/*
 * 标题编号：阿拉伯「5.」「5.2」、罗马「IV.」、附录「B.3」。
 * 和 pdfText 的 SECTION_NUMBER 同族 —— shared 不能反向依赖渲染层，只能复制一份，
 * 改动其中一处时另一处要跟着（两处的误杀面不同：那边还要防正文句子）。
 */
const HEADING_NUMBER = /^(?:[IVX]{1,6}\.|\d+(?:\.\d+)*\.?|[A-Z]\.\d+)\s+/

/** 带 N.M / A.3 编号的是子标题，内容跟父章节走 */
const SUBSECTION_NUMBER = /^(?:\d+\.\d+|[A-Z]\.\d+)/

/** 标题清洗：剥编号 → 剥冠词 → 去尾冒号 → 压空白 → 小写，给关键词匹配用 */
function stripHeadingTitle(title: string): string {
  const noNum = title.replace(HEADING_NUMBER, '').trim() || title.trim()
  return noNum
    .replace(/^(?:a|an|the)\s+/i, '')
    .replace(/[:.]\s*$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim()
}

/*
 * 关键词按整词匹配清洗后的标题。顺序即优先级：
 * 先认跳过项，再按 problem → method → experiment → conclusion 依次试。
 * 「Results and Discussion」会归 experiment（结果占主导，可接受）；
 * 「A Method for …」剥掉冠词后也能认出 method。
 */
const SKIP_HEADING =
  /\b(references?|bibliography|acknowledg\w*|appendix|appendices|supplementary|supplement|author contributions?|funding|financial|conflicts? of interest|declarations?|ethics?|reproducibility statement)\b/
/**
 * 跳过项里也有该留下的：附录 / 补充材料里的**实现细节、超参、数据集统计、复现声明**，
 * 恰恰是实验设置的主要藏身处（正文只写一句「详见附录 A」）。
 *
 * 少了这一条，模型永远标不到「用了什么硬件、什么超参、数据多少条」——
 * 而那些正是复现一篇论文时最需要、初学者也最容易跳过的信息。
 *
 * 只认**带限定词**的标题：「Appendix A Proofs」仍然跳过（证明过程不是实验设置），
 * 「Appendix B Implementation Details」「C Hyperparameters」则归给实验专家。
 */
const SKIP_BUT_KEEP =
  /\b(implementation|details?|hyper-?parameters?|setup|settings?|datasets?|data statistics|training|experimental|reproducib\w*)\b/
const PROBLEM_KEYWORDS =
  /\b(abstract|introduction|motivation|background|related works?|problem|overview|objective)\b/
const METHOD_KEYWORDS =
  /\b(method\w*|approach|model\w*|framework|architecture|algorithm\w*|design|formulation|training|inference|preliminar\w*|notation|our|proposed)\b/
const EXPERIMENT_KEYWORDS =
  /\b(experiment\w*|evaluation|results?|analysis|ablation\w*|benchmark\w*|setup|settings?|datasets?|empirical|comparison|metrics?|studies|study|implementation|hyper-?parameters?|data statistics|training details?)\b/
const CONCLUSION_KEYWORDS =
  /\b(conclusion\w*|discussion|limitations?|future works?|summary|concluding|takeaways?|implications?|impact)\b/

/**
 * 把标题序列归类到 4 个专家（或跳过）。
 *
 * - 命中跳过词（参考文献 / 致谢 / 附录容器…）的不喂给任何专家，
 *   **但附录里的实现细节 / 超参 / 数据集统计除外**（见 SKIP_BUT_KEEP）；
 * - 命不中任何关键词时：带 N.M / A.3 编号的子标题**继承上一个标题的类别**
 *   （「3.2 Loss Function」跟「3 Method」走），上一个是跳过项则它也跳过
 *   （「Appendix」下的「A.2 Proofs」不该喂给任何人）；
 * - 顶层未命中的（「7 Broader Impact」这类）按跳过处理 —— 喂错专家比不喂更糟。
 */
export function classifyHeadings(titles: string[]): Array<AgentKind | 'skip'> {
  const kinds: Array<AgentKind | 'skip'> = []
  for (let i = 0; i < titles.length; i++) {
    const stripped = stripHeadingTitle(titles[i])
    if (SKIP_HEADING.test(stripped)) {
      kinds.push(SKIP_BUT_KEEP.test(stripped) ? 'experiment' : 'skip')
    } else if (PROBLEM_KEYWORDS.test(stripped)) kinds.push('problem')
    else if (METHOD_KEYWORDS.test(stripped)) kinds.push('method')
    else if (EXPERIMENT_KEYWORDS.test(stripped)) kinds.push('experiment')
    else if (CONCLUSION_KEYWORDS.test(stripped)) kinds.push('conclusion')
    else if (SUBSECTION_NUMBER.test(titles[i]) && kinds[i - 1] && kinds[i - 1] !== 'skip') {
      kinds.push(kinds[i - 1])
    } else kinds.push('skip')
  }
  return kinds
}

function headingMatchesLine(title: string, lineText: string): boolean {
  const a = title.replace(/\s+/g, ' ').trim()
  const b = lineText.replace(/\s+/g, ' ').trim()
  if (!a || !b) return false
  if (a === b) return true
  // 标题行偶尔和邻栏并线、或抽取时被截，允许前缀匹配；太短的前缀会误配
  const shorter = a.length < b.length ? a : b
  return shorter.length >= 5 && (b.startsWith(a) || a.startsWith(b))
}

export interface KindLinePlan {
  /** 每个专家分到的行（全局行号、升序）。没分到行的类型不在表里 */
  byKind: Partial<Record<AgentKind, SourceLine[]>>
  /** 结构没认出来（不足两类可归类）→ 调用方退回单 agent 全文 */
  fallback: boolean
}

/**
 * 把行流按章节边界切给各专家。
 *
 * 标题在行流里的定位靠**文本匹配**：抽取文本和行流来自两次独立抽取
 * （buildLines 带字号给标题打标 vs buildPositionedLines 带矩形给模型引用），
 * 行号互不对应，但标题原文两边都有 —— 同一份 textContent，空白归一规则也一致。
 * 匹配从上一个边界往后扫：标题天然按出现顺序排列，全篇扫只会把目录页的
 * 「1 Introduction … 3」错当成章节头。找不到的标题当边界缺失处理，
 * 它的内容并入上一段 —— 宁可范围糊一点，不可错切。
 */
export function assignLinesByKind(lines: SourceLine[], titles: string[]): KindLinePlan {
  const byKind: Partial<Record<AgentKind, SourceLine[]>> = {}
  if (!lines.length) return { byKind, fallback: true }

  const kinds = classifyHeadings(titles)
  // skip 标题也参与定位：它是「从这里开始别喂」的闸门（References 之后不该归结论专家）
  const boundaries: Array<{ index: number; kind: AgentKind | 'skip' }> = []
  let cursor = 0
  for (let i = 0; i < titles.length; i++) {
    let found = -1
    for (let j = cursor; j < lines.length; j++) {
      if (headingMatchesLine(titles[i], lines[j].text)) {
        found = j
        break
      }
    }
    if (found < 0) continue
    boundaries.push({ index: found, kind: kinds[i] })
    cursor = found + 1
  }

  for (let b = 0; b < boundaries.length; b++) {
    const kind = boundaries[b].kind
    if (kind === 'skip') continue
    const start = boundaries[b].index
    const end = b + 1 < boundaries.length ? boundaries[b + 1].index : lines.length
    const slice = lines.slice(start, end)
    if (!slice.length) continue
    byKind[kind] = [...(byKind[kind] ?? []), ...slice]
  }

  const kindsWithLines = AGENT_KINDS.filter((k) => (byKind[k]?.length ?? 0) > 0)
  return { byKind, fallback: kindsWithLines.length < 2 }
}

/* ------------------------------------------------------------------ */
/*  解析与换算                                                          */
/* ------------------------------------------------------------------ */

export interface AutoHighlightPick {
  page: number
  rects: HighlightRect[]
  text: string
  why: string
  kind: HighlightKind
}

const KINDS = new Set<string>(['problem', 'method', 'experiment', 'result', 'conclusion'])

function toKind(value: unknown): HighlightKind {
  return typeof value === 'string' && KINDS.has(value) ? (value as HighlightKind) : 'other'
}

/** 模型返回的一个区间（已通过行号校验，尚未拆页） */
export interface AutoHighlightSpan {
  /** 闭区间，全局行号 */
  from: number
  to: number
  kind: HighlightKind
  why: string
}

/**
 * 把模型返回的 spans 校验成可信区间（这一步不拆页）。
 *
 * 容错原则（和 normalizeMethodFlow 一致）：坏条目丢掉而不是让整个功能失败，
 * 行号越界 / from > to / 区间太长都直接丢。
 *
 * 校验单独成函数的意义：拆成多专家后，每个专家拿**自己那份行**调它 ——
 * 引用了别人地盘行号的区间会因 byId 查不到而整条丢弃，这是「各喂各的章节」
 * 自带的防线（宁可少标不可错标）。
 */
export function normalizeSpans(raw: unknown, lines: SourceLine[]): AutoHighlightSpan[] {
  const root = (raw ?? {}) as Record<string, unknown>
  const items = Array.isArray(root.spans)
    ? root.spans
    : Array.isArray(raw)
      ? (raw as unknown[])
      : []
  const byId = new Map(lines.map((l) => [l.id, l]))

  const spans: AutoHighlightSpan[] = []
  for (const item of items) {
    const span = (item ?? {}) as Record<string, unknown>
    const from = Number(span.from)
    const to = Number(span.to)
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) continue
    if (to - from + 1 > MAX_SPAN_LINES) continue

    let valid = true
    for (let id = from; id <= to; id++) {
      if (!byId.has(id)) {
        valid = false
        break
      }
    }
    if (!valid) continue

    spans.push({
      from,
      to,
      kind: toKind(span.kind),
      why: (typeof span.why === 'string' ? span.why.trim() : '').slice(0, MAX_WHY)
    })
  }
  return spans
}

/**
 * 跨专家合并区间。
 *
 * 按构造各专家分到的行段互不重叠，所以这里的去重是**防御**：标题匹配错位
 * （比如把目录页的「1 Introduction」当成了章节头）时两个专家可能摸到同一段。
 * 完全相同的区间把「为什么」去重合并 —— 初学者看到两条理由不算坏事；
 * 部分重叠保留起点更早的，先到先得是确定性规则。总量守 MAX_PICKS 上限。
 */
export function mergeSpans(spans: AutoHighlightSpan[]): AutoHighlightSpan[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from || a.to - b.to)
  const out: AutoHighlightSpan[] = []
  for (const span of sorted) {
    const last = out[out.length - 1]
    if (last && span.from <= last.to) {
      if (span.from === last.from && span.to === last.to) {
        const reasons = [...last.why.split('；'), ...span.why.split('；')]
          .map((s) => s.trim())
          .filter(Boolean)
        last.why = [...new Set(reasons)].join('；').slice(0, MAX_WHY)
      }
      continue // 部分重叠：丢掉后来的
    }
    if (out.length >= MAX_PICKS) break
    out.push({ ...span })
  }
  return out
}

/**
 * 区间 → 重点标注：拆页（Highlight 只能属于一页）、拼文字、按阅读顺序排。
 * 从单 agent 路径里拆出来独立成函数，供跨专家合并后的统一换算。
 */
export function spansToPicks(
  spans: AutoHighlightSpan[],
  lines: SourceLine[]
): AutoHighlightPick[] {
  const byId = new Map(lines.map((l) => [l.id, l]))
  const picks: AutoHighlightPick[] = []
  for (const span of spans) {
    if (picks.length >= MAX_PICKS) break
    const spanLines: SourceLine[] = []
    for (let id = span.from; id <= span.to; id++) {
      const line = byId.get(id)
      if (!line) break
      spanLines.push(line)
    }
    // 区间里有行不在表里 → 整个区间作废（校验过的输入不该走到这，守一道）
    if (spanLines.length !== span.to - span.from + 1) continue

    // 跨页区间拆成每页一条：Highlight 只能属于一页
    const byPage = new Map<number, SourceLine[]>()
    for (const line of spanLines) {
      const list = byPage.get(line.page)
      if (list) list.push(line)
      else byPage.set(line.page, [line])
    }
    for (const [page, pageLines] of byPage) {
      if (picks.length >= MAX_PICKS) break
      // 矩形过一遍归一化：行数据来自 IPC，落盘前把越界 / 退化的丢掉
      const rects = pageLines
        .map((l) => normalizeRect(l.rect))
        .filter((r): r is HighlightRect => r !== null)
      if (!rects.length) continue
      picks.push({
        page,
        rects,
        text: pageLines
          .map((l) => l.text)
          .join(' ')
          .slice(0, MAX_TEXT),
        why: span.why,
        kind: span.kind
      })
    }
  }

  // 按页面与位置排序，从上到下读才符合阅读顺序
  picks.sort(
    (a, b) => a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0)
  )
  return picks
}

/**
 * 把模型返回的 spans 收敛成可落盘的重点标注（单 agent 全文路径）。
 * 就是「校验 → 换算」的组合，不含跨专家合并 —— 多专家路径在 agents
 * 里先 mergeSpans 再 spansToPicks。一个有效区间都没有时返回空数组，
 * 由调用方决定报错而不是静默覆盖掉已有标注。
 */
export function normalizeAutoHighlights(raw: unknown, lines: SourceLine[]): AutoHighlightPick[] {
  return spansToPicks(normalizeSpans(raw, lines), lines)
}

/**
 * 把标注换算成 Highlight。
 *
 * id 用确定性生成（`ai-hl-<序号>`）而不是随机：重跑标注本来就是整条替换，
 * 不需要全局唯一；确定性 id 让「解析 → 落盘」这条路可以在脚本里完整复现。
 */
export function buildAiHighlights(picks: AutoHighlightPick[], createdAt: string): Highlight[] {
  return picks.map((pick, i) => ({
    id: `ai-hl-${i + 1}`,
    page: pick.page,
    text: pick.text,
    rects: pick.rects,
    color: AI_HIGHLIGHT_COLOR,
    // note 是界面上的「为什么重要」说明；空 why 时退化为类型标签
    note: pick.why ? `【${HIGHLIGHT_KIND_LABEL[pick.kind]}】${pick.why}` : `【${HIGHLIGHT_KIND_LABEL[pick.kind]}】`,
    ai: true,
    createdAt
  }))
}

/**
 * 合并进现有高亮：用户手划的一条不动，旧的 AI 标注整条替换。
 *
 * 这是「重跑标注」的语义 —— 不替换的话每跑一次就多攒一轮旧标注；
 * 动到用户高亮则是事故（它们和 AI 标注就靠 ai 标记区分，见 highlights.ts）。
 */
export function mergeAiHighlights(existing: Highlight[], aiHighlights: Highlight[]): Highlight[] {
  return [...existing.filter((h) => !h.ai), ...aiHighlights]
}
