/**
 * PDF 文本后处理的纯函数部分。
 *
 * 这里刻意不依赖 pdfjs，所以既能在渲染进程用，也能在 Node 脚本里直接跑测试。
 * pdfjs 只负责把每一页的 textContent 交出来，剩下的排版重建、页眉去噪、
 * 标题识别、标题与作者猜测都在这里完成。
 *
 * 关于标题识别：论文的章节标题常常写成「5 Experiments with CultureVerse」这种
 * 「编号 + 名称 + 描述」的形式，纯关键字正则很容易漏。但 PDF 里标题的字号
 * 通常明显大于正文，这是比关键字可靠得多的信号。所以我们在抽取阶段就利用
 * 字号把标题行标成 Markdown 的 `## `，下游（主进程）只要按标题切分即可。
 */

export interface TextItemLike {
  str: string
  transform: number[]
  hasEOL?: boolean
  height?: number
  width?: number
}

export interface LineInfo {
  text: string
  /** 该行最大的 font size，用来识别标题 */
  size: number
}

export interface PdfAssembledText {
  text: string
  title?: string
  authors: string[]
  pageTexts: string[]
  /** 识别出的标题数量，用于判断抽取质量 */
  headingCount: number
  /** 推断出的正文字号 */
  bodySize: number
}

export const HEADING_MARK = '## '

/* ------------------------------------------------------------------ */
/*  行重建                                                              */
/* ------------------------------------------------------------------ */

/** 把一页的 textContent 拼成行，并记录每行的最大字号 */
export function buildLines(items: TextItemLike[]): LineInfo[] {
  const lines: LineInfo[] = []
  let buffer = ''
  let maxSize = 0
  let lastY: number | null = null

  const flush = (): void => {
    const text = buffer.replace(/\s+/g, ' ').trim()
    if (text) lines.push({ text, size: maxSize })
    buffer = ''
    maxSize = 0
  }

  for (const item of items) {
    if (typeof item.str !== 'string') continue
    const y = Array.isArray(item.transform) ? item.transform[5] : null
    const size = Array.isArray(item.transform)
      ? Math.abs(item.transform[3] || item.height || 0)
      : item.height || 0

    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2.2) flush()
    if (size > maxSize) maxSize = size
    buffer += item.str
    lastY = y
    if (item.hasEOL) {
      flush()
      lastY = null
    }
  }
  flush()
  return lines
}

/* ------------------------------------------------------------------ */
/*  带位置的行重建（AI 标重点用）                                          */
/* ------------------------------------------------------------------ */

/** 一行文字 + 它在页面上的归一化矩形（CSS 空间：原点左上、y 向下，与 HighlightRect 契约一致） */
export interface PositionedLine {
  text: string
  rect: { x: number; y: number; w: number; h: number }
}

/**
 * 把一页的 textContent 拼成行，并算出每行在页面上的包围盒（归一化到 0~1）。
 *
 * 和 buildLines 的分组规则相同（y 间隙 / hasEOL），但多记了位置，
 * 并且多一条**横向断开**规则：双栏排版里左右两栏的行 y 坐标几乎相同，
 * 只看 y 会把它们并成一行，于是高亮矩形横跨整页 —— 所以横向间隔
 * 超过一个字宽时也强制换行。
 *
 * 矩形是估算（PDF 文字只有基线和字号，没有真正的行高）：顶部按一个字号
 * 向上、底部留 35% 的下探，视觉上刚好罩住整行文字。
 *
 * **纵向必须翻转**：pdfjs 的 item.transform 是 PDF 用户坐标（原点左下、
 * y 向上），而 HighlightRect 的契约和渲染层都是 CSS 空间（原点左上、
 * y 向下）。归一化的同时翻转，否则 AI 高亮会上下镜像 —— 曾经的实测
 * 事故：首页标题（页顶）的高亮画在了 88% 高度处。
 * （旋转页面仍不支持：viewport 的宽高互换后横向规则不成立，论文极少见。）
 */
export function buildPositionedLines(
  items: TextItemLike[],
  pageWidth: number,
  pageHeight: number
): PositionedLine[] {
  const lines: PositionedLine[] = []
  let buffer = ''
  let lastY: number | null = null
  let lastRight: number | null = null
  let lastSize = 0
  // 当前行的包围盒（页面用户单位，y 仍是从页底量的原始值）
  let minX = Infinity
  let maxX = -Infinity
  let minTop = Infinity
  let maxBottom = -Infinity

  const flush = (): void => {
    const text = buffer.replace(/\s+/g, ' ').trim()
    if (text && pageWidth > 0 && pageHeight > 0) {
      const topFromBottom = Math.max(0, Math.min(1, minTop / pageHeight))
      const bottomFromBottom = Math.max(0, Math.min(1, maxBottom / pageHeight))
      const x = Math.max(0, Math.min(1, minX / pageWidth))
      lines.push({
        text,
        rect: {
          x,
          // CSS 空间的 y（从页顶量）= 1 - 从页底量的底边；高度是延伸量，翻转不变
          y: 1 - bottomFromBottom,
          w: Math.max(0, Math.min(1, maxX / pageWidth)) - x,
          h: bottomFromBottom - topFromBottom
        }
      })
    }
    buffer = ''
    lastY = null
    lastRight = null
    lastSize = 0
    minX = Infinity
    maxX = -Infinity
    minTop = Infinity
    maxBottom = -Infinity
  }

  for (const item of items) {
    if (typeof item.str !== 'string') continue
    const t = Array.isArray(item.transform) ? item.transform : null
    const x = t ? (t[4] ?? 0) : 0
    const baseline = t ? (t[5] ?? 0) : 0
    const size = t ? Math.abs(t[3] || 0) : 0
    // width/height 是 pdfjs 换算好的页面用户单位；缺了按字号估一个
    const w = item.width ?? item.str.length * size * 0.5
    const top = baseline - (item.height ?? size)
    const bottom = baseline + (item.height ?? size) * 0.35

    // 换行条件：y 跳变（新行）、横向大空隙（跨栏）
    const yJump = lastY !== null && Math.abs(baseline - lastY) > 2.2
    const columnJump = lastRight !== null && x - lastRight > Math.max(size, lastSize) * 1.5
    if (yJump || columnJump) flush()

    buffer += item.str
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x + w)
    minTop = Math.min(minTop, top)
    maxBottom = Math.max(maxBottom, bottom)
    lastY = baseline
    lastRight = x + w
    lastSize = size
    if (item.hasEOL) flush()
  }
  flush()
  return lines
}

/* ------------------------------------------------------------------ */
/*  标题识别                                                            */
/* ------------------------------------------------------------------ */

/** 正文行会占压倒性字数，用它来定「正文字号」基准 */
export function inferBodySize(pageLines: LineInfo[][]): number {
  const weight = new Map<number, number>()
  for (const lines of pageLines) {
    for (const line of lines) {
      const key = Math.round(line.size * 2) / 2
      if (key < 5 || key > 22) continue
      weight.set(key, (weight.get(key) ?? 0) + line.text.length)
    }
  }
  let best = 10
  let bestWeight = -1
  for (const [size, w] of weight) {
    if (w > bestWeight) {
      best = size
      bestWeight = w
    }
  }
  return best
}

/**
 * 关键词直命中：即使字号不比正文大（有些模板的 Abstract 反而更小）也要认出来。
 * 注意这里只是「候选」，还必须通过 looksLikeHeading 里的长度约束——
 * 否则 "results demonstrate that our models..." 这种正文句子会被误判成标题。
 */
const STRONG_HEADING =
  /^(?:abstract|introduction|related works?|background|preliminaries|method(?:s|ology)?|proposed (?:method|approach|framework|model)|our (?:method|approach|framework|model)|approach|experiments?|experimental (?:setup|settings?|results?)|evaluation|main results|results?|analysis|ablation(?:s| stud(?:y|ies))?|discussion|conclusions?|concluding remarks?|limitations?(?: and future work)?|future work|references|bibliography|appendix)\b/i

/** 这些单词本身就是无歧义的章节名，允许单独成标题 */
const SINGLE_WORD_HEADING =
  /^(?:abstract|introduction|references|bibliography|appendix|conclusions?|acknowledg(?:e)?ments?)$/i

function isStrongHeading(stripped: string, text: string): boolean {
  if (!STRONG_HEADING.test(stripped)) return false
  const words = text.split(/\s+/).length
  // 真正的标题又短又少词；句子会在这两条上翻车
  if (text.length > 90 || words > 10) return false
  // 单个词只有在无歧义时才认（避免把图注里的 "Analysis" 当成章节）
  if (words === 1) return SINGLE_WORD_HEADING.test(stripped.replace(/[\s.。]+$/, ''))
  return true
}

/** 明显不是章节标题的行：邮箱、链接、arXiv 水印、机构名 */
const NON_HEADING =
  /(@|https?:\/\/|^arxiv:|^\[[a-z]{2}\.|university|universit|institute|institut|research|college|laborator|department|school of|academy)/i

/**
 * 剥掉章节编号：「1. Introduction」→「Introduction」、
 * 「IV. EXPERIMENTS」→「EXPERIMENTS」、「B.2 Details」→「Details」。
 *
 * 罗马数字要单独处理：IEEE 风格用「I. INTRODUCTION」，而「可选字母 + 必需数字」
 * 的写法（`^[A-Z]?\d+`）剥不掉它 —— 没有数字就整体不匹配。结果编号点号被当成
 * 句号，`I. INTRODUCTION` 这类标题会被下面的「句子结构」规则全部误杀。
 *
 * 也刻意**不**写成「任意单个字母 + 点」：那样「A method for solving ...」
 * 会被剥成「method for solving ...」，反而误判成标题。
 */
const SECTION_NUMBER = /^(?:[IVX]{1,6}\.|\d+(?:\.\d+)*\.?|[A-Z]\.\d+)\s+/

function stripSectionNumber(text: string): string {
  const stripped = text.replace(SECTION_NUMBER, '').trim()
  return stripped || text.trim()
}

export function looksLikeHeading(line: LineInfo, bodySize: number, isFirstPage: boolean): boolean {
  const text = line.text.trim()
  if (!text || text.length > 110) return false
  // 句子不会以句号 / 逗号结尾
  if (/[.,;:]$/.test(text)) return false
  // 纯数字 / 纯百分比的表格单元格
  if (/^[\d\s.%()+\-–—/]+$/.test(text)) return false

  /*
   * 剥掉章节编号必须发生在「句子结构」判定**之前**。
   *
   * 带编号的标题写成「1. Introduction」，它的编号点号天生满足
   * 「句号 + 空格 + 大写字母」这条正文特征 —— 拿原始行去判定，
   * 所有编号标题都会被当成正文误杀。
   *
   * 实测教训：某篇论文的 6 个正式章节标题（1. Introduction /
   * 2. Related Work / 5. Experimental Results / 6. Conclusion …）全部被漏标，
   * 于是正文只切出 Abstract 一段。下游按章节名取材料时只命中 Abstract，
   * 模型看不到实验章节，把原文明确写着的「uses Claude Opus 4.6」
   * 判成了「原文未说明」。
   */
  const stripped = stripSectionNumber(text)
  // 含完整句子结构的多半是正文（例如 "Experiments show that the model ..."）
  if (/[.!?]\s+[A-Z]/.test(stripped)) return false

  if (isStrongHeading(stripped, text)) return true

  // 首页版心是标题 / 作者 / 机构，字号很大但都不是章节标题，
  // 只有 Abstract 这类强关键字才认。
  if (isFirstPage) return false
  if (NON_HEADING.test(text)) return false

  // 字号显著大于正文，且是个短句而不是段落
  if (line.size >= bodySize + 1.2) {
    const words = text.split(/\s+/).length
    return words <= 14 && text.length <= 90
  }
  return false
}

/** 全局字号是标题的估算，用于后续判断是否要标 */
export interface HeadingMarkResult {
  pageTexts: string[]
  headingCount: number
  bodySize: number
}

/**
 * 在页面文本里把标题行标成 `## `。
 * 必须在去掉页眉页脚之前调用，因为那时 pageTexts 与 pageLines 还是一一对应的。
 */
export function markHeadings(pageTexts: string[], pageLines: LineInfo[][]): HeadingMarkResult {
  const bodySize = inferBodySize(pageLines)
  let headingCount = 0

  const marked = pageTexts.map((pageText, pageIndex) => {
    const infos = pageLines[pageIndex] ?? []
    const lines = pageText.split('\n')
    return lines
      .map((text, lineIndex) => {
        const info = infos[lineIndex]
        if (!info) return text
        if (!looksLikeHeading(info, bodySize, pageIndex === 0)) return text
        headingCount++
        return HEADING_MARK + text
      })
      .join('\n')
  })

  return { pageTexts: marked, headingCount, bodySize }
}

/* ------------------------------------------------------------------ */
/*  页眉页脚去噪                                                        */
/* ------------------------------------------------------------------ */

/** 去掉在多数页面上重复出现的页眉 / 页脚 */
export function stripRunningHeads(pageTexts: string[]): string[] {
  if (pageTexts.length < 4) return pageTexts
  const pages = pageTexts.map((p) => p.split('\n'))
  const threshold = Math.max(3, Math.floor(pageTexts.length * 0.5))
  const counts = new Map<string, number>()

  const consider = (line: string | undefined): void => {
    if (!line) return
    const key = line.trim()
    if (key.length < 4 || key.length > 90) return
    if (/^\d+$/.test(key)) return
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  for (const lines of pages) {
    for (const l of lines.slice(0, 3)) consider(l)
    for (const l of lines.slice(-3)) consider(l)
  }

  const noisy = new Set<string>()
  for (const [key, count] of counts) {
    if (count >= threshold) noisy.add(key)
  }
  if (!noisy.size) return pageTexts

  return pages
    .map((lines) => {
      const head = lines.slice(0, 3).filter((l) => !noisy.has(l.trim()))
      const tail = lines.slice(-3).filter((l) => !noisy.has(l.trim()))
      const middle = lines.slice(3, Math.max(3, lines.length - 3))
      return [...head, ...middle, ...tail].join('\n')
    })
    .map((p) => p.replace(/\n{3,}/g, '\n\n'))
}

/* ------------------------------------------------------------------ */
/*  标题与作者猜测                                                      */
/* ------------------------------------------------------------------ */

const TITLE_NOISE =
  /^(arxiv|preprint|under review|published as|conference on|proceedings of|workshop|technical report|microsoft word|untitled)/i

function looksLikeTitleLine(text: string): boolean {
  if (text.length < 12 || text.length > 220) return false
  if (TITLE_NOISE.test(text)) return false
  if (/^(abstract|introduction|keywords)/i.test(text)) return false
  return (text.match(/[A-Za-z]/g)?.length ?? 0) > text.length * 0.4
}

interface TitleBlock {
  text: string
  /** 标题占用的行号，用于定位作者区 */
  indexes: number[]
}

/** 标题块：首页里字号最大的那几行（标题可能跨行） */
export function findTitleBlock(firstPageLines: LineInfo[]): TitleBlock | undefined {
  const candidates = firstPageLines
    .slice(0, 40)
    .map((line, index) => ({ ...line, index }))
    .filter((l) => looksLikeTitleLine(l.text))
  if (!candidates.length) return undefined

  const maxSize = Math.max(...candidates.map((c) => c.size))
  const top = candidates.filter((c) => c.size >= maxSize - 0.6).slice(0, 3)
  const text = top
    .map((t) => t.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([:：])\s*$/, '')
    .trim()
  if (!text) return undefined
  return { text, indexes: top.map((t) => t.index) }
}

/** 从首页里猜标题 */
export function guessTitle(firstPageLines: LineInfo[]): string | undefined {
  return findTitleBlock(firstPageLines)?.text
}

export function cleanTitle(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const value = raw.replace(/\s+/g, ' ').trim()
  if (!value || value.length < 8) return undefined
  if (TITLE_NOISE.test(value)) return undefined
  if (/\.(docx?|tex|pdf|pptx?)$/i.test(value)) return undefined
  if (/^Microsoft Word/i.test(value)) return undefined
  return value.slice(0, 220)
}

export function parseAuthors(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/[,;、]|\band\b/i)
    .map((a) => a.replace(/\s+/g, ' ').trim())
    .filter((a) => a.length >= 2 && a.length <= 60 && /[A-Za-z\u4e00-\u9fa5]/.test(a))
    .slice(0, 20)
}

function resolveTitle(
  metaTitle: string | undefined,
  firstPageLines: LineInfo[] | undefined
): string | undefined {
  return (
    cleanTitle(metaTitle) ?? (firstPageLines ? cleanTitle(guessTitle(firstPageLines)) : undefined)
  )
}

const AFFILIATION =
  /(universit|institute|institut|research|college|laborator|department|school of|academy|@|https?:)/i

/** 「姓 名」形式的名字块，最多抓到三段（覆盖 Van Der Berg 这类） */
const NAME_PATTERN = /[A-Z][a-zA-Z\u00C0-\u024F'’.-]*(?:\s+[A-Z][a-zA-Z\u00C0-\u024F'’.-]*){1,2}/g
const NAME_STOP = /^(the|a|an|in|on|of|for|and|with|using|towards|toward|from|to|via)$/i

function extractAuthorNames(block: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of block.match(NAME_PATTERN) ?? []) {
    const name = raw.replace(/\s+/g, ' ').trim()
    if (name.length < 5 || name.length > 60) continue
    if (AFFILIATION.test(name)) continue
    if (name.split(/\s+/).some((w) => NAME_STOP.test(w))) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= 15) break
  }
  return out
}

/**
 * 取作者。PDF 里作者名常常被上标编号（1、*、†）切成好几行，所以不能按行解析——
 * 而是把「标题之后、机构之前」的整块文本拼起来，再用姓名模式整体抽取。
 */
function resolveAuthors(
  metaAuthor: string | undefined,
  firstPageLines: LineInfo[] | undefined
): string[] {
  const fromMeta = parseAuthors(metaAuthor)
  if (fromMeta.length) return fromMeta
  if (!firstPageLines?.length) return []

  const block = findTitleBlock(firstPageLines)
  const start = block?.indexes.length ? Math.max(...block.indexes) + 1 : 1

  const collected: string[] = []
  for (const line of firstPageLines.slice(start, start + 18)) {
    if (AFFILIATION.test(line.text)) break
    collected.push(line.text)
  }
  return extractAuthorNames(collected.join(', '))
}

/* ------------------------------------------------------------------ */
/*  组装                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把逐页文本组装成最终结果：标记标题 -> 去页眉页脚 -> 猜标题作者。
 * 注意顺序：标题标记必须在去页眉之前，否则行与行号的对应关系就断了。
 */
export function assemblePdfText(
  rawPageTexts: string[],
  pageLines: LineInfo[][],
  meta: { title?: string; author?: string } = {}
): PdfAssembledText {
  const title = resolveTitle(meta.title, pageLines[0])
  const authors = resolveAuthors(meta.author, pageLines[0])
  const { pageTexts, headingCount, bodySize } = markHeadings(rawPageTexts, pageLines)
  const cleanedPages = stripRunningHeads(pageTexts)

  return {
    text: cleanedPages.join('\n\n'),
    title,
    authors,
    pageTexts: cleanedPages,
    headingCount,
    bodySize
  }
}
