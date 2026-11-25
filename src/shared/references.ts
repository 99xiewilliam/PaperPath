/**
 * 参考文献对照：从原文里抽出参考文献，标出哪些已经在库里。
 *
 * 抽取结果缓存在 `.papervault/refs/<id>.json`：它完全可以从原文重新抽一遍，
 * 所以和抽取出的原文文本一样算派生数据，不进笔记 frontmatter。
 */

export interface PaperReference {
  title: string
  /** 作者的简写，例如「Brown et al.」 */
  authors: string
  year: number | null
  /** 不带版本号的 arXiv 编号，没有就是空串 */
  arxivId: string
}

export interface PaperReferences {
  extractedAt: string
  refs: PaperReference[]
}

/** 渲染层拿到的是「参考文献 + 它在库里对应哪篇」 */
export interface ReferenceItem extends PaperReference {
  paperId: string | null
}

export interface ReferenceList {
  extractedAt: string
  items: ReferenceItem[]
}

/** 送给模型的参考文献原文上限（字符） */
export const REFERENCE_BLOCK_LIMIT = 40000

const REF_HEADING = /^\s*(?:#{1,6}\s*)?(?:\d+\.?\s+)?(?:references|bibliography|参考文献)\s*$/i
/** 参考文献之后常见的附录起点 */
const AFTER_REFS = /^\s*#{1,6}\s*(?:appendix|appendices|supplementary|[A-H](?:\.\d+)*\s+\S)/i

/**
 * 从抽取出的原文里切出参考文献那一段。取**最后一个**参考文献标题：
 * 正文里偶尔会出现「References」这个词单独成行（比如图注），最后一个才是真的。
 */
export function extractReferenceBlock(text: string): string {
  const lines = (text ?? '').split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) if (REF_HEADING.test(lines[i])) start = i
  if (start < 0) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (AFTER_REFS.test(lines[i])) {
      end = i
      break
    }
  }
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim()
    .slice(0, REFERENCE_BLOCK_LIMIT)
}

/** 标题归一化：只留字母和数字、全小写，用来跨格式比对 */
export function normalizeTitle(title: string): string {
  return (title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

export function normalizeArxivId(id: string): string {
  const m = (id ?? '').match(/(\d{4}\.\d{4,5})/)
  return m ? m[1] : ''
}

export function normalizeReferences(raw: unknown): PaperReference[] {
  if (!Array.isArray(raw)) return []
  const out: PaperReference[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const title = String(r.title ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    const key = normalizeTitle(title)
    if (key.length < 6 || seen.has(key)) continue
    seen.add(key)
    const year = Number(r.year)
    out.push({
      title: title.slice(0, 300),
      authors: String(r.authors ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120),
      year: Number.isInteger(year) && year > 1900 && year < 2100 ? year : null,
      arxivId: normalizeArxivId(String(r.arxivId ?? r.arxiv ?? ''))
    })
    if (out.length >= 300) break
  }
  return out
}

/**
 * 在库匹配：arXiv 编号相同，或归一化标题相同 / 互相包含（两边都够长才算包含，
 * 避免「Attention」这种短标题误配）。
 */
export function matchReferences(
  refs: PaperReference[],
  library: { id: string; title: string; arxivId?: string }[],
  selfId?: string
): ReferenceItem[] {
  const byArxiv = new Map<string, string>()
  const titles: { id: string; key: string }[] = []
  for (const p of library) {
    if (p.id === selfId) continue
    const ax = normalizeArxivId(p.arxivId ?? '')
    if (ax) byArxiv.set(ax, p.id)
    const key = normalizeTitle(p.title)
    if (key) titles.push({ id: p.id, key })
  }
  return refs.map((ref) => {
    const ax = ref.arxivId ? byArxiv.get(ref.arxivId) : undefined
    if (ax) return { ...ref, paperId: ax }
    const key = normalizeTitle(ref.title)
    const hit = titles.find(
      (t) =>
        t.key === key ||
        (key.length >= 20 && t.key.length >= 20 && (t.key.includes(key) || key.includes(t.key)))
    )
    return { ...ref, paperId: hit ? hit.id : null }
  })
}
