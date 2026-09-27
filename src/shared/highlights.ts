/**
 * PDF 高亮。
 *
 * 矩形按页面宽高归一化到 0~1，而不是存像素：这样换缩放比例、换设备像素比、
 * 甚至重新渲染都不用重算，只需要乘上当前页面的实际尺寸即可。
 *
 * 存在论文 Markdown 的 frontmatter 里（而不是 .papervault/ 下的旁挂文件），
 * 因为高亮本身就是需要沉淀的知识，应当跟笔记一样可读、可 Git 管理，
 * 也不该在清理索引目录时被一起删掉。
 */

export interface HighlightRect {
  /** 相对页面宽度的左边界，0~1 */
  x: number
  /** 相对页面高度的上边界，0~1 */
  y: number
  /** 相对页面宽度的宽度，0~1 */
  w: number
  /** 相对页面高度的宽度，0~1 */
  h: number
}

export interface Highlight {
  id: string
  /** 页码，从 1 开始 */
  page: number
  /** 被选中的原文 */
  text: string
  rects: HighlightRect[]
  /** CSS 颜色（含透明度） */
  color: string
  /** 备注：用户手写，或把 AI 的解读存下来 */
  note?: string
  /**
   * true 表示这条是「AI 标重点」产出的，和用户手划的区分开：
   * 重跑标注时整条替换 AI 的、绝不动用户的；渲染样式和列表分组也靠它区分。
   */
  ai?: boolean
  createdAt: string
}

export const HIGHLIGHT_COLORS: { id: string; value: string; label: string }[] = [
  { id: 'amber', value: 'rgba(251,191,36,0.34)', label: '琥珀' },
  { id: 'teal', value: 'rgba(45,212,191,0.30)', label: '青' },
  { id: 'indigo', value: 'rgba(129,140,248,0.32)', label: '靛' },
  { id: 'rose', value: 'rgba(248,113,113,0.28)', label: '红' }
]

export const DEFAULT_HIGHLIGHT_COLOR = HIGHLIGHT_COLORS[0].value

/** AI 标重点的专用色：不在用户可选色板里，一眼就能分出来源 */
export const AI_HIGHLIGHT_COLOR = 'rgba(96,165,250,0.30)'

export function newHighlightId(): string {
  return `hl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** 把任意输入收敛成合法的归一化矩形，顺手丢掉退化（宽或高为 0）的 */
export function normalizeRect(raw: unknown): HighlightRect | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
  }
  const rect: HighlightRect = { x: num(r.x), y: num(r.y), w: num(r.w), h: num(r.h) }
  // 退化矩形不画（缩放判断误差会产出 0 宽的行）
  if (rect.w <= 0.0005 || rect.h <= 0.0005) return null
  return rect
}

/** 从 frontmatter 里读到的任意结构收敛成 Highlight[] */
export function normalizeHighlights(value: unknown): Highlight[] {
  if (!Array.isArray(value)) return []
  const out: Highlight[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const h = raw as Record<string, unknown>
    const rects = Array.isArray(h.rects)
      ? h.rects.map(normalizeRect).filter((r): r is HighlightRect => r !== null)
      : []
    const text = typeof h.text === 'string' ? h.text : ''
    // 没文字也没矩形的高亮没有意义
    if (!text && !rects.length) continue
    const note = typeof h.note === 'string' && h.note ? h.note : ''
    out.push({
      id: typeof h.id === 'string' && h.id ? h.id : newHighlightId(),
      page: Math.max(1, Math.round(Number(h.page) || 1)),
      text,
      rects,
      color: typeof h.color === 'string' && h.color ? h.color : DEFAULT_HIGHLIGHT_COLOR,
      createdAt: typeof h.createdAt === 'string' ? h.createdAt : new Date().toISOString(),
      /*
       * 没有备注就**不要出现这个键**，不能写成 `note: undefined`：
       * 这份数据会被写回 Markdown frontmatter，而 js-yaml 遇到 undefined 会抛
       * "unacceptable kind of an object to dump"（vault.writePaperFile 里有同样的说明）。
       * 从文件读出来再写回去的路径以前不通，所以这个坑一直没暴露。
       * ai 同理：只有 true 才出现，读改写一圈之后标记不能丢
       *（丢了的话，重跑 AI 标注会把它们当用户高亮留下来，越攒越多）。
       */
      ...(note ? { note } : {}),
      ...(h.ai === true ? { ai: true } : {})
    })
  }
  return out
}
