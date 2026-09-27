import type { ArxivMeta } from '@shared/types'

/** 从 arXiv 链接或裸 ID 中提取标准 ID */
export function parseArxivId(input: string): string | null {
  const text = (input || '').trim()
  if (!text) return null

  // 形如 https://arxiv.org/abs/2401.12345v2
  const urlMatch = /arxiv\.org\/(?:abs|pdf)\/([a-zA-Z.-]+\/\d{7}|\d{4}\.\d{4,5})(v\d+)?/i.exec(text)
  if (urlMatch) return urlMatch[1]

  // 裸 ID
  const bare = /^(?:arXiv:)?\s*([a-zA-Z.-]+\/\d{7}|\d{4}\.\d{4,5})(v\d+)?$/i.exec(text)
  if (bare) return bare[1]

  return null
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
}

function collapse(value: string): string {
  return decodeXml(value).replace(/\s+/g, ' ').trim()
}

function tag(xml: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml)
  return m ? collapse(m[1]) : ''
}

function allTags(xml: string, name: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(collapse(m[1]))
  return out
}

function attr(xml: string, tagName: string, attrName: string): string {
  const m = new RegExp(`<${tagName}[^>]*\\s${attrName}="([^"]*)"`, 'i').exec(xml)
  return m ? decodeXml(m[1]).trim() : ''
}

export async function fetchArxivMeta(idOrUrl: string): Promise<ArxivMeta> {
  const id = parseArxivId(idOrUrl)
  if (!id) throw new Error('无法识别 arXiv ID，请输入形如 2401.12345 的编号或 arXiv 链接。')

  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  let xml = ''
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'PaperVault/0.1 (local research tool)' }
    })
    if (!res.ok) throw new Error(`arXiv 接口返回 ${res.status}`)
    xml = await res.text()
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('请求 arXiv 超时，请检查网络后重试。')
    }
    throw new Error(`请求 arXiv 失败：${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
  }

  const entryMatch = /<entry>([\s\S]*?)<\/entry>/i.exec(xml)
  if (!entryMatch) {
    throw new Error(`arXiv 上找不到 ${id}，请确认编号是否正确。`)
  }
  const entry = entryMatch[1]

  const authors = allTags(entry, 'name').length
    ? allTags(entry, 'name')
    : allTags(entry, 'author').map((a) => stripTags(a))

  const published = tag(entry, 'published')
  const year = published ? Number(published.slice(0, 4)) : new Date().getFullYear()

  return {
    title: tag(entry, 'title'),
    authors,
    abstract: tag(entry, 'summary'),
    published,
    year,
    categories: allTags(entry, 'category').length
      ? [...entry.matchAll(/<category[^>]*term="([^"]*)"/gi)].map((m) => m[1])
      : [],
    arxivId: id,
    doi: tag(entry, 'arxiv:doi'),
    journalRef: tag(entry, 'arxiv:journal_ref'),
    primaryCategory: attr(entry, 'arxiv:primary_category', 'term')
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim()
}
