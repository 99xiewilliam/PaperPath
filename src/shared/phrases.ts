/**
 * 跨论文句式库的抽取逻辑。
 *
 * 纯本地规则抽取，不调用模型：从每篇笔记的「写作手法 · X」章节里
 *   - 抓取 `- **亮点句式**：` / `- **可复用表达**：` 这类小节下的列表项；
 *   - 抓取正文里被引号包起来的英文句子（通常是作者摘录的原文句式）。
 * 这样用户攒的每一篇论文都会自动往句式库里加料，攒久了就是一个私人语料库。
 */

export interface PhraseCandidate {
  /** 句式文本 */
  text: string
  /** 所属章节，例如「写作手法 · Introduction」 */
  section: string
  /** 来源标签：亮点句式 / 可复用表达 / 引文摘录；curated 时是功能分类 */
  label: string
  /**
   * 来源：
   *   curated = english 维度用模型精炼出的短语（最可信，优先展示）
   *   writing = 从写作拆解章节里正则抽的
   *   excerpt = 原文摘录章节
   */
  source: 'curated' | 'writing' | 'excerpt'
  /** 中文用法说明（仅 curated 有） */
  usage?: string
}

export interface PhraseEntry extends PhraseCandidate {
  id: string
  paperId: string
  paperTitle: string
  paperYear: number | null
  categories: string[]
}

/** 会被当作「句式收纳框」的小节标签 */
const PHRASE_LABELS = /(句式|表达|模板|措辞|用词|slogan|开头|结尾|转折|过渡|claim|贡献)/i

/** 任意小节标签，用于判断「句式小节结束了」 */
const ANY_LABEL = /^\s*[-*]\s*\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/

const QUOTE_PATTERNS: RegExp[] = [
  /"([^"\n]{15,320})"/g,
  /“([^”\n]{15,320})”/g,
  /‘([^’\n]{15,320})’/g
]

const CJK = /[\u4e00-\u9fa5]/

function looksLikeSentence(text: string): boolean {
  const t = text.trim()
  if (t.length < 15 || t.length > 320) return false
  if (/^https?:\/\//i.test(t)) return false
  if (/^[\d\s.,;:%()-]+$/.test(t)) return false
  // 英文句子：至少 4 个单词
  const words = t.match(/[A-Za-z][A-Za-z'-]*/g)?.length ?? 0
  if (words >= 4) return true
  // 中文句子：至少 10 个字
  if (CJK.test(t) && t.replace(/\s/g, '').length >= 10) return true
  return false
}

function cleanPhrase(text: string): string {
  return text
    .replace(/^\s*[-*]\s*/, '')
    .replace(/^["“”'‘’`\s]+|["“”'‘’`\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function sectionFamily(sectionKey: string): string {
  return sectionKey.replace(/^写作手法\s*·\s*/, '').trim() || sectionKey
}

/**
 * 从一篇论文的章节字典里抽取句式候选。
 */
export function extractPhraseCandidates(
  sections: Record<string, string>
): PhraseCandidate[] {
  const out: PhraseCandidate[] = []
  const seen = new Set<string>()

  const push = (text: string, sectionKey: string, label: string, source: PhraseCandidate['source']): void => {
    const cleaned = cleanPhrase(text)
    if (!looksLikeSentence(cleaned)) return
    const key = cleaned.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ text: cleaned, section: sectionKey, label, source })
  }

  for (const [sectionKey, content] of Object.entries(sections)) {
    if (!content?.trim()) continue
    const isWriting = sectionKey.startsWith('写作手法')
    const isExcerpt = sectionKey === '原文摘录'
    if (!isWriting && !isExcerpt) continue

    const lines = content.replace(/\r\n/g, '\n').split('\n')
    let collecting: string | null = null

    for (const line of lines) {
      const labelMatch = ANY_LABEL.exec(line)
      if (labelMatch) {
        const label = labelMatch[1].trim()
        const inline = labelMatch[2]?.trim() ?? ''
        collecting = PHRASE_LABELS.test(label) ? label : null
        if (collecting && inline) push(inline, sectionKey, collecting, isWriting ? 'writing' : 'excerpt')
        continue
      }
      if (collecting) {
        if (!line.trim()) continue
        if (/^\s*#{1,6}\s/.test(line)) {
          collecting = null
          continue
        }
        push(line, sectionKey, collecting, isWriting ? 'writing' : 'excerpt')
      }
    }

    // 引号里摘录的原文句子
    for (const pattern of QUOTE_PATTERNS) {
      pattern.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = pattern.exec(content)) !== null) {
        push(m[1], sectionKey, isWriting ? '引文摘录' : '原文摘录', isWriting ? 'writing' : 'excerpt')
      }
    }
  }

  return out.slice(0, 80)
}

export interface StructuredPhrase {
  category: string
  text: string
  usage?: string
  example?: string
  from?: string
}

export interface PhrasePaperInput {
  id: string
  title: string
  year: number | null
  categories: string[]
  sections: Record<string, string>
  /** english 维度用模型精炼出的短语，优先级高于正则抽取 */
  structuredPhrases?: StructuredPhrase[]
}

export function buildPhraseBank(papers: PhrasePaperInput[]): PhraseEntry[] {
  const entries: PhraseEntry[] = []
  const seen = new Set<string>()

  const push = (candidate: PhraseCandidate, paper: PhrasePaperInput): void => {
    const key = candidate.text.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    entries.push({
      ...candidate,
      id: `${paper.id}:${entries.length}`,
      paperId: paper.id,
      paperTitle: paper.title,
      paperYear: paper.year,
      categories: paper.categories
    })
  }

  // 先放模型精炼的短语——它们的分类与用法说明质量最高
  for (const paper of papers) {
    for (const phrase of paper.structuredPhrases ?? []) {
      if (!phrase.text?.trim()) continue
      push(
        {
          text: phrase.text.trim(),
          section: '英语写作短语',
          label: phrase.category || '其他',
          source: 'curated',
          usage: phrase.usage
        },
        paper
      )
    }
  }

  // 再补正则抽取的，重复的会被 seen 挡掉
  for (const paper of papers) {
    for (const candidate of extractPhraseCandidates(paper.sections)) {
      push(candidate, paper)
    }
  }

  return entries
}

/** 句式所属的功能分组，用于句式库的左侧导航 */
export function phraseGroupOf(entry: PhraseCandidate): string {
  if (entry.source === 'curated') return entry.label || '英语写作短语'
  if (entry.source === 'excerpt') return '原文摘录'
  return sectionFamily(entry.section)
}

export function phraseSections(entries: PhraseCandidate[]): string[] {
  return [...new Set(entries.map(phraseGroupOf))]
}
