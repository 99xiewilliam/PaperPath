/**
 * 论文原文的规范化与章节切分。
 * 目标不是完美还原 PDF 结构，而是给 LLM 提供「带结构提示的输入」，
 * 让它在长文本里不至于漏掉实验章节。
 */

/**
 * 前缀式关键字表：标题常常写成「5 Experiments with CultureVerse」这种
 * 「编号 + 名称 + 描述」的形式，所以这里只要求开头命中，不锚定结尾。
 * 只用于给已经确认是标题的行归类，不用于发现标题（那样容易误伤正文）。
 */
const KEYWORDS_PREFIX: [string, RegExp][] = [
  ['Abstract', /^(?:abstract|summary)\b/i],
  ['Introduction', /^introduction\b/i],
  [
    'Related Work',
    /^(?:related works?|background|prior work|literature review|existing (?:work|methods))\b/i
  ],
  [
    'Preliminaries',
    /^(?:preliminaries|problem (?:formulation|setup|definition)|task (?:formulation|definition))\b/i
  ],
  [
    'Method',
    /^(?:method(?:s|ology)?|our (?:method|approach|framework|model)|proposed (?:method|approach|framework|model)|approach|model(?: architecture)?|system (?:design|overview)|training)\b/i
  ],
  [
    'Experiments',
    /^(?:experiments?|experimental (?:setup|settings?|results?|details?)|evaluation|empirical (?:study|evaluation)|main results|results)\b/i
  ],
  [
    'Analysis',
    /^(?:analysis|ablation(?:s| stud(?:y|ies))?|discussion|case stud(?:y|ies)|(?:further|furthermore) analysis)\b/i
  ],
  [
    'Conclusion',
    /^(?:conclusions?|concluding remarks?|limitations?(?: and future work)?|future work)\b/i
  ],
  ['References', /^(?:references|bibliography)\b/i],
  ['Appendix', /^(?:appendix|supplementary)\b/i]
]

/** 「5 Experiments」→「Experiments」；「5.1 Setup」→「Setup」；「B.2 Details」→「Details」 */
function stripHeadingNumber(raw: string): string {
  const stripped = raw.replace(/^(?:[A-Z]|\d+)(?:\.\d+)*\.?\s+/, '').trim()
  return stripped || raw.trim()
}

/** 带「N.M」编号的标题是子标题，内容应并入父章节 */
function isSubsectionHeading(raw: string): boolean {
  return /^(?:[A-Z]|\d+)(?:\.\d+)+/.test(raw.trim())
}

/** 把原始标题映射到固定章节名；归不了类就保留原标题（截断） */
function canonicalName(raw: string): string {
  const stripped = stripHeadingNumber(raw)
  for (const [name, re] of KEYWORDS_PREFIX) {
    if (re.test(stripped)) return name
  }
  return stripped.slice(0, 60)
}

/**
 * 发现标题用的严格规则（仅在标记路径不够用时兜底，避免误伤正文）。
 *
 * 这里的规则**不带编号前缀** —— 编号统一交给 `stripHeadingNumber` 剥掉再匹配。
 * 原本每条都内联了一个 `(?:\d+\.?\s*)?`，只认阿拉伯数字，IEEE 风格的
 * 罗马数字标题（「IV. EXPERIMENTS」）就永远匹配不上。
 */
const HEADING_PATTERNS: [string, RegExp][] = [
  ['Abstract', /^(?:abstract|summary)\s*$/i],
  ['Introduction', /^introduction\s*$/i],
  [
    'Related Work',
    /^(?:related works?|background|prior work|literature review|preliminaries)\s*$/i
  ],
  [
    'Method',
    /^(?:methods?|methodology|our (?:method|approach|framework|model)|proposed (?:method|approach|framework|model)|approach|model architecture|the proposed .{0,40})\s*$/i
  ],
  [
    'Experiments',
    /^(?:experiments?|experimental (?:setup|settings?|results?)|evaluation|empirical (?:study|evaluation)|main results|results and (?:analysis|discussion))\s*$/i
  ],
  ['Analysis', /^(?:analysis|ablation(?:s| stud(?:y|ies))?|discussion)\s*$/i],
  [
    'Conclusion',
    /^(?:conclusions?|concluding remarks?|limitations?(?: and future work)?|future work)\s*$/i
  ],
  ['References', /^(?:references|bibliography)\s*$/i],
  ['Appendix', /^(?:appendix|supplementary material|supplementary)\b/i]
]

export function normalizePaperText(raw: string): string {
  let text = (raw || '').replace(/\r\n?/g, '\n')
  // 行尾连字符断词：仅在下一行以小写字母开头时拼接
  text = text.replace(/([A-Za-z])-\n(?=[a-z])/g, '$1')
  // 合并被 PDF 换行拆开的句子（上一行未结束、下一行非标题）
  text = text.replace(/([a-z,;])\n(?=[a-z])/g, '$1 ')
  // 压缩空白
  text = text.replace(/[ \t\u00a0]+/g, ' ')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

function isLikelyHeading(line: string): string | null {
  const raw = line.trim()
  if (!raw || raw.length > 80) return null
  // 先剥编号再匹配：这样阿拉伯数字「5. Experiments」和罗马数字「IV. EXPERIMENTS」
  // 走同一条路径，规则表里就不用再各写一份前缀
  const stripped = stripHeadingNumber(raw).replace(/[:.]\s*$/, '').trim()
  if (stripped.split(/\s+/).length > 8) return null
  for (const [name, re] of HEADING_PATTERNS) {
    if (re.test(stripped)) return name
  }
  return null
}

interface SectionMark {
  name: string
  /** 原始标题文本；关键字路径发现的标题没有标记行，所以是可选的 */
  raw?: string
  index: number
  /** 带 N.M 编号的子标题，内容要并进父章节 */
  sub: boolean
}

/** 正文结束标志：从这里往后都是参考文献与附录，不进 LLM 输入 */
const TAIL_HEADING =
  /^(?:[A-Z]?\d+(?:\.\d+)*\.?\s+)?(?:references|bibliography|appendix|supplementary|acknowledg)/i

/**
 * 按章节切分论文正文。
 *
 * 优先走「标记路径」：PDF 抽取阶段已经根据字号把标题行标成了 `## `，
 * 这里只需要切分 + 归类。这样「5 Experiments with CultureVerse」这种
 * 带描述后缀的标题也不会漏。
 *
 * 没有标记时退化到「关键字路径」，用于直接贴纯文本的场景。
 */
export function splitPaperSections(text: string): Record<string, string> {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')

  const marked: SectionMark[] = []
  // 正文结束位置（参考文献 / 附录的起点），最后一个章节不能越过它
  let endIndex = lines.length
  for (let i = 0; i < lines.length; i++) {
    const m = /^#{1,3}\s+(.+?)\s*$/.exec(lines[i])
    if (!m) continue
    const raw = m[1].trim()
    if (!raw) continue
    // 遇到参考文献就停，后面的附录不属于正文
    if (TAIL_HEADING.test(raw)) {
      endIndex = i
      break
    }
    marked.push({ name: canonicalName(raw), raw, index: i, sub: isSubsectionHeading(raw) })
  }

  if (marked.length >= 3) {
    const byMark = buildFromMarks(lines, mergeWithHeadingNames(lines, marked, endIndex), endIndex)
    if (Object.keys(byMark).length >= 3) return byMark
  }

  return splitByKeywords(lines)
}

/**
 * 把「抽取阶段按字号标出的标题」和「按锚定标题名找到的标题」合并。
 *
 * 为什么必须合并：字号启发式会漏标题，最典型的是带编号的
 * 「5. Experimental Results」—— 它的编号点号在 `looksLikeHeading` 里会被
 * 误当成句号（原因见 pdfText.ts 的注释）。而这里原本只要标记路径能切出
 * ≥3 段就直接 return，永远轮不到关键字兜底，于是「漏标」变成了「静默漏段」。
 *
 * 漏掉 Experiments 的代价很大：下游按章节名取材料的维度只会命中 Abstract，
 * 模型看不到实验章节，把原文里明确写着的模型名 / 算力信息判成「原文未说明」。
 *
 * 合并还有个现实好处：**已经导入的库不需要重新导入**。它们的原文 .txt 是
 * 修复前抽取的、标记已经残缺，光修 looksLikeHeading 救不到它们。
 *
 * 关键字规则全部是「整行锚定」的（`^...\s*$`），只会命中恰好是标题的那一行，
 * 精度足够高；再配合行号去重和同名去重，不会重复切分。
 */
function mergeWithHeadingNames(
  lines: string[],
  marked: SectionMark[],
  endIndex: number
): SectionMark[] {
  const occupied = new Set(marked.map((m) => m.index))
  const names = new Set(marked.map((m) => m.name))
  const merged = [...marked]

  // 只记录关键字路径上一次的命中，用于抑制页眉式的连续同名
  let lastKeyword: { name: string; index: number } | null = null

  for (let i = 0; i < endIndex; i++) {
    if (occupied.has(i)) continue
    const name = isLikelyHeading(lines[i])
    if (!name) continue
    // 标记路径已经切出过这个章节，不再重复添加（否则两段内容会被拼在一起）
    if (names.has(name)) continue
    if (lastKeyword && lastKeyword.name === name && i - lastKeyword.index < 5) continue

    merged.push({ name, index: i, sub: false })
    names.add(name)
    lastKeyword = { name, index: i }
  }

  merged.sort((a, b) => a.index - b.index)
  return merged
}

/** 用抽取阶段标好的标题切分，子标题内容并入父章节 */
function buildFromMarks(
  lines: string[],
  marks: SectionMark[],
  endIndex: number
): Record<string, string> {
  const result: Record<string, string> = {}
  const append = (name: string, chunk: string): void => {
    if (!chunk) return
    result[name] = result[name] ? `${result[name]}\n\n${chunk}` : chunk
  }

  let currentTop: string | null = null
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]
    const stop = marks[i + 1]?.index ?? endIndex
    const chunk = lines.slice(mark.index + 1, stop).join('\n').trim()

    if (mark.sub) {
      // 子章节内容并进当前一级章节，标题降一级保留，方便 LLM 看到结构
      if (currentTop) append(currentTop, chunk ? `### ${mark.name}\n${chunk}` : '')
      continue
    }
    currentTop = mark.name
    append(mark.name, chunk)
  }

  // 丢掉几乎没内容的章节（通常是目录页或孤零零的页眉）
  for (const name of Object.keys(result)) {
    const body = result[name].replace(/\s/g, '')
    if (body.length < 60) {
      delete result[name]
      continue
    }
    // 目录页会被字号规则误判成标题，这里直接清掉
    if (/^(contents|table of contents|目录)$/i.test(name) && body.length < 2000) {
      delete result[name]
    }
  }
  return result
}

/** 完全没有标题标记时的兜底：用严格关键字规则发现标题 */
function splitByKeywords(lines: string[]): Record<string, string> {
  const marks: { name: string; index: number }[] = []

  for (let i = 0; i < lines.length; i++) {
    const name = isLikelyHeading(lines[i])
    if (!name) continue
    // 同一标题连续命中通常是页眉，跳过
    const last = marks[marks.length - 1]
    if (last && last.name === name && i - last.index < 5) continue
    marks.push({ name, index: i })
  }

  const unique = new Set(marks.map((m) => m.name))
  if (unique.size < 3) return {}

  // 同名标题保留「内容量最大」的那一段（对应正文而非目录）
  const result: Record<string, string> = {}
  for (const mark of marks) {
    const stopIndex =
      marks.find((m) => m.index > mark.index && m.name !== mark.name)?.index ?? lines.length
    const chunk = lines.slice(mark.index + 1, stopIndex).join('\n').trim()
    if (chunk.length < 60) continue
    if (!result[mark.name] || chunk.length > result[mark.name].length) {
      result[mark.name] = chunk
    }
  }
  delete result.References
  delete result.Appendix

  // 切完之后如果有效章节太少，说明这是目录页之类的误命中，整体放弃
  if (Object.keys(result).length < 3) return {}
  return result
}

export interface LlmSource {
  /** 按预算截断后的正文，作为最后兜底的投喂材料 */
  fullText: string
  /**
   * **未截断**的完整原文。
   *
   * 只给「按需取片段」的机制用（关键词回捞），不直接投喂。
   *
   * 为什么必须单独留一份：附录里全是算力规模、人工评测规模、复现细节，
   * 而附录常常落在 budget 之外。实测一篇 115K 字符的论文，预算 60K ——
   * 算力段落在 91K 处，于是 tail 取到的是**正文中段**（而不是它自称的「正文后段」），
   * 关键词回捞扫的也是被截断的文本，两边都够不到，
   * 模型只能老老实实写「原文未说明」。
   */
  rawText: string
  /** 按章节切分、且**已按全篇均分配额截断**的正文片段 */
  sourceSections?: Record<string, string>
  /**
   * 按章节切分的**未截断**正文。
   *
   * 给 `sourceBlock` 用：它知道本次要的是哪几节，可以只在这几节之间分配额度。
   * 而 sourceSections 的配额是「全篇均分」，对长论文很不公平 ——
   * 一篇 9 个章节的论文每节只有 6,666 字符，实测足以把 Experiments（11,370）
   * 从 §5.3 之后切断，于是 §5.4 消融 / §5.5 真机验证整节没送到模型，
   * `ablationCount` / `realWorld` 被填成「未说明」——而论文里明明写了。
   */
  rawSections?: Record<string, string>
}

/**
 * 为 LLM 准备输入：优先给带章节结构的片段，并控制总长度。
 */
export function prepareLlmSource(raw: string, budget = 60000): LlmSource {
  const text = normalizePaperText(raw)
  if (!text) return { fullText: '', rawText: '' }

  const sections = splitPaperSections(text)
  const names = Object.keys(sections)

  if (names.length >= 3) {
    /*
     * 这里的配额是「全篇均分」，只适合「不知道读者要哪几节」的兜底场景。
     * 真正精确的那一份留给 sourceBlock —— 它拿着维度声明的章节名，
     * 只在这几节之间分配额度（见 rawSections 的注释）。
     */
    const perSection = Math.max(4000, Math.floor(budget / names.length))
    const capped: Record<string, string> = {}
    for (const name of names) {
      const value = sections[name]
      capped[name] = value.length > perSection ? `${value.slice(0, perSection)}\n…（本段已截断）` : value
    }
    return { fullText: text.slice(0, budget), rawText: text, sourceSections: capped, rawSections: sections }
  }

  return { fullText: text.slice(0, budget), rawText: text }
}

/**
 * 为「实验画像抽取」挑材料。
 *
 * 优先给实验相关的标准章节；但算力规模、人工评测人数这类信息经常只写在附录里，
 * 而正文切分会在参考文献处截断，所以额外补一段正文后段，保证这些字段有机会被填上。
 */
export function pickProfileSource(
  raw: string | null | undefined,
  noteSections: Record<string, string>
): { text: string; label: string } {
  if (raw && raw.trim()) {
    const source = prepareLlmSource(raw, 40000)
    const parts: string[] = []
    const sections = source.sourceSections

    if (sections && Object.keys(sections).length) {
      // benchmark 类论文的核心章节常常归不了类，这时把所有章节都带上
      const preferred = ['Experiments', 'Analysis', 'Method', 'Abstract'].filter((k) => sections[k])
      const keys = preferred.length ? preferred : Object.keys(sections)
      for (const key of keys) parts.push(`### 原文片段：${key}\n${sections[key]}`)
    }

    const tail = source.fullText.slice(Math.max(0, source.fullText.length - 14000))
    if (tail.trim().length > 500) {
      parts.push(
        `### 原文片段：正文后段（含参考文献与附录，算力规模 / 人工评测细节常在此）\n${tail}`
      )
    }

    if (parts.length) return { text: parts.join('\n\n'), label: '论文原文（章节片段 + 正文后段）' }

    const fallback = source.fullText.slice(-24000)
    if (fallback.trim()) return { text: fallback, label: '论文原文（正文后段）' }
  }

  const picked = ['写作手法 · Experiments', '实验方法论', '关键收获']
    .map((key) => (noteSections[key] ? `### 笔记：${key}\n${noteSections[key]}` : ''))
    .filter(Boolean)
    .join('\n\n')
  if (picked) return { text: picked, label: '已有的精读笔记' }
  return { text: '', label: '（没有可用的原文或笔记）' }
}

/** 用于索引检索的正文摘要片段 */
export function textSnippet(raw: string, max = 3000): string {
  return normalizePaperText(raw).slice(0, max)
}

/** 估算 token（粗略），用于提示用户 */
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 2.2)
}
