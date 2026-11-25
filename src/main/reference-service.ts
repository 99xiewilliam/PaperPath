/**
 * 参考文献对照：抽取（走模型，结果缓存）+ 在库匹配（每次现算，库变了就跟着变）。
 */
import {
  extractReferenceBlock,
  matchReferences,
  normalizeReferences,
  type PaperReferences,
  type ReferenceList
} from '@shared/references'
import { runReferenceAgent } from './agents/references'
import * as db from './db'
import { createPaper } from './paper-service'
import { requireVault } from './runtime'
import { getSettings } from './settings'
import * as vault from './vault'

function readCache(paperId: string): PaperReferences | null {
  const raw = vault.readRefsFile(requireVault(), paperId) as Partial<PaperReferences> | null
  if (!raw || typeof raw !== 'object') return null
  return {
    extractedAt: typeof raw.extractedAt === 'string' ? raw.extractedAt : '',
    refs: normalizeReferences(raw.refs)
  }
}

function withMatches(paperId: string, cache: PaperReferences): ReferenceList {
  const library = db.listPaperIds().map((id) => {
    const row = db.getPaperRow(id)
    return { id, title: String(row?.title ?? ''), arxivId: String(row?.arxiv_id ?? '') }
  })
  return { extractedAt: cache.extractedAt, items: matchReferences(cache.refs, library, paperId) }
}

export function getReferences(paperId: string): ReferenceList | null {
  const cache = readCache(paperId)
  return cache ? withMatches(paperId, cache) : null
}

export async function extractReferences(paperId: string): Promise<ReferenceList> {
  const vaultPath = requireVault()
  if (!db.getPaperSummary(paperId)) throw new Error('论文不存在。')
  const text = vault.readExtractedText(vaultPath, paperId)
  if (!text.trim()) throw new Error('这篇论文没有抽取到原文，先导入 PDF。')
  const block = extractReferenceBlock(text)
  if (!block) throw new Error('原文里没有找到「References / 参考文献」这一节。')

  const refs = await runReferenceAgent(block, getSettings().llm)
  if (!refs.length) throw new Error('模型没有识别出参考文献条目，换个时间再试一次。')
  const cache: PaperReferences = { extractedAt: new Date().toISOString(), refs }
  vault.writeRefsFile(vaultPath, paperId, cache)
  return withMatches(paperId, cache)
}

/** 把一条参考文献建成待读论文（只有书目信息，没有 PDF） */
export function addReferenceToLibrary(paperId: string, index: number): ReferenceList {
  const cache = readCache(paperId)
  const ref = cache?.refs[index]
  if (!cache || !ref) throw new Error('这条参考文献不存在了，重新抽取一次再试。')
  const current = withMatches(paperId, cache).items[index]
  if (!current?.paperId) {
    const source = db.getPaperSummary(paperId)
    createPaper({
      title: ref.title,
      authors: ref.authors ? [ref.authors] : [],
      year: ref.year,
      arxivId: ref.arxivId,
      url: ref.arxivId ? `https://arxiv.org/abs/${ref.arxivId}` : '',
      status: 'inbox',
      tags: ['来自参考文献'],
      sections: source ? { 自由笔记: `从《${source.title}》的参考文献加入。` } : undefined
    })
  }
  return withMatches(paperId, cache)
}
