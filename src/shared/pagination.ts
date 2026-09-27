/**
 * 连续滚动的分页几何。
 *
 * 阅读器把整篇 PDF 竖直排成一列，这里负责三件事：
 *   1. 每页在列里的位置（pageOffsets）
 *   2. 视口当前落在哪一页（currentPageAt）—— 工具栏的「3 / 24」跟着它走
 *   3. 真正需要渲染的页码区间（visiblePageRange）—— 窗口外的页只放占位框，
 *      上百页的文档才不会一次性铺出上百张 canvas 和文字层。
 *
 * 全部是纯函数，坐标一律用「列坐标」：第一页顶部为 0，单位像素。
 * 容器内边距的换算只发生在组件里的一处（PdfReader 的 CONT_PAD），
 * 这里不感知 DOM，所以能在脚本里直接测。
 */

/**
 * 每页顶部在列里的偏移。第一页为 0，之后每页 = 前一页底部 + 页间距。
 */
export function pageOffsets(heights: number[], gap: number): number[] {
  const offsets: number[] = []
  let acc = 0
  for (const h of heights) {
    offsets.push(acc)
    acc += h + gap
  }
  return offsets
}

/**
 * 翻到某页时该设的滚动位置（列坐标）。页码越界收敛到首尾页，
 * 调用方不用自己做边界判断。
 */
export function scrollTopForPage(offsets: number[], index: number): number {
  if (!offsets.length) return 0
  const i = Math.min(Math.max(Math.round(index), 0), offsets.length - 1)
  return offsets[i]
}

/**
 * 锚点（列坐标）落在哪一页，返回 0 基页码。
 *
 * 规则是「最后一页顶部 ≤ 锚点」：锚点落在两页之间的缝隙里时归上面那页，
 * 滚过整篇文档时停在最后一页 —— 页码指示不会在缝隙里闪烁跳变。
 */
export function currentPageAt(anchor: number, offsets: number[]): number {
  if (!offsets.length) return 0
  let page = 0
  for (let i = 1; i < offsets.length; i++) {
    if (offsets[i] <= anchor) page = i
    else break
  }
  return page
}

export interface VisibleRange {
  /** 0 基、闭区间；没有页面时是 { start: 0, end: -1 } */
  start: number
  end: number
}

/* ------------------------------------------------------------------ */
/*  阅读位置（「上次读到哪」）                                            */
/* ------------------------------------------------------------------ */

/**
 * 每篇论文记住的阅读位置。
 *
 * 存比例而不是像素：scrollTop / 可滚动总量。下次打开时缩放可能不同、
 * 窗口可能不同，比例都 still 成立。存在索引 DB 的 meta 表里而不是
 * frontmatter —— 它是随手变化的 UI 状态，不该每次滚动都让笔记文件变脏。
 */
export interface ReadingPosition {
  /** 滚动比例 0~1 */
  ratio: number
  /** 当时的页码（1 基），给界面展示用 */
  page: number
  updatedAt: string
}

/** 从 DB 读到的任意结构收敛成 ReadingPosition；不合法就当作没存过 */
export function normalizeReadingPosition(raw: unknown): ReadingPosition | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const p = raw as Record<string, unknown>
  const ratio = Number(p.ratio)
  const page = Number(p.page)
  if (!Number.isFinite(ratio) || !Number.isFinite(page)) return undefined
  return {
    ratio: Math.max(0, Math.min(1, ratio)),
    page: Math.max(1, Math.round(page)),
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : ''
  }
}
/**
 * 需要真实渲染的页码区间（0 基、闭区间）。
 *
 * [colTop, colBottom] 是视口在列坐标里的覆盖范围，调用方通常已经把
 * overscan 缓冲算进去。与视口相交（哪怕 1px）的页都在区间内 ——
 * 露了个边的页不渲染的话，滚动时会看到一条刺眼的白缝。
 */
export function visiblePageRange(
  colTop: number,
  colBottom: number,
  offsets: number[],
  heights: number[]
): VisibleRange {
  if (!offsets.length) return { start: 0, end: -1 }
  let start = 0
  // 底部在 colTop 之上的页完全不可见，跳过
  while (start < offsets.length - 1 && offsets[start] + heights[start] < colTop) start++
  let end = offsets.length - 1
  // 顶部在 colBottom 之下的页完全不可见，跳过
  while (end > start && offsets[end] > colBottom) end--
  return { start, end }
}
