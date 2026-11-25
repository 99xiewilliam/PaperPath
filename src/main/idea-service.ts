/**
 * 选题本：从开放问题生成选题、跟进状态与备注。Markdown（`ideas/<id>.md`）是唯一真相源。
 */
import type { IdeaPatch, ResearchIdea } from '@shared/ideas'
import { IDEA_STATUSES } from '@shared/ideas'
import { LIMITATIONS_SECTION, PROBLEM_SCOPE_ALL } from '@shared/problems'
import { runIdeaAgent, type IdeaLibraryPaper, type IdeaSourcePaper } from './agents/ideas'
import * as db from './db'
import { highlightsOf, sectionsOf } from './paper-service'
import { getProblemMap } from './problem-service'
import { requireVault } from './runtime'
import { getSettings } from './settings'
import * as vault from './vault'

/** 出处论文带哪些章节、每节最多多少字 */
const SOURCE_SECTIONS: [string, number][] = [
  ['一句话总结', 300],
  ['核心问题与动机', 800],
  ['方法细节', 1500],
  [LIMITATIONS_SECTION, 1500],
  ['可迁移到我的研究', 1000],
  ['举一反三', 800]
]
const MAX_SOURCES = 6
const MAX_THOUGHTS = 20
const MAX_LIBRARY = 40

function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function titleOf(id: string): string {
  return db.getPaperSummary(id)?.title ?? id
}

export function listIdeas(): ResearchIdea[] {
  const known = new Set(db.listPaperIds())
  return vault
    .listIdeaFiles(requireVault())
    .map((idea) => ({ ...idea, paperIds: idea.paperIds.filter((id) => known.has(id)) }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function generateIdeas(scope: string, problemTitle: string): Promise<ResearchIdea[]> {
  const vaultPath = requireVault()
  const map = getProblemMap(scope)
  const problem =
    map?.problems.find((p) => p.id === problemTitle) ??
    map?.problems.find((p) => p.title === problemTitle)
  if (!problem) throw new Error('问题池已经重新汇总过，这个问题不在了。刷新一下再试。')

  const sources: IdeaSourcePaper[] = []
  for (const id of problem.paperIds.slice(0, MAX_SOURCES)) {
    const summary = db.getPaperSummary(id)
    if (!summary) continue
    const sections = sectionsOf(id)
    const notes: Record<string, string> = {}
    for (const [key, max] of SOURCE_SECTIONS) {
      if (sections[key]?.trim()) notes[key] = clip(sections[key], max)
    }
    const thoughts = highlightsOf(id)
      .filter((h) => !h.ai && h.note)
      .slice(0, MAX_THOUGHTS)
      .map((h) => `- P${h.page}「${h.text.slice(0, 160)}」→ ${h.note}`)
    sources.push({ id, title: summary.title, year: summary.year, notes, thoughts })
  }
  if (!sources.length) throw new Error('提出这个问题的论文都已经不在库里了。')

  // 同一专题的论文排在前面：用户把它们归到一起，说明它们更可能组合得起来
  const taken = new Set(sources.map((s) => s.id))
  const scopeIds = scope === PROBLEM_SCOPE_ALL ? [] : (db.getCollection(scope)?.paperIds ?? [])
  const ordered = [...new Set([...scopeIds, ...db.listPaperIds()])]
  const library: IdeaLibraryPaper[] = []
  for (const id of ordered) {
    if (taken.has(id)) continue
    const summary = db.getPaperSummary(id)
    if (!summary?.tldr.trim()) continue
    library.push({ id, title: summary.title, oneLiner: clip(summary.tldr, 100) })
    if (library.length >= MAX_LIBRARY) break
  }

  const existing = listIdeas()
    .filter((i) => i.problemId === problem.id || i.problem === problem.title)
    .map((i) => i.title)

  const drafts = await runIdeaAgent({ problem, sources, library, existing }, getSettings().llm)
  if (!drafts.length) {
    throw new Error('模型没给出同时有假设、最小实验和反证条件的选题。换个时间再试一次。')
  }

  const now = new Date().toISOString()
  const created = drafts.map((d): ResearchIdea => ({
    ...d,
    id: vault.newIdeaId(d.title),
      problem: problem.title,
      problemId: problem.id,
      scope,
    status: 'new',
    note: '',
    createdAt: now,
    updatedAt: now
  }))
  for (const idea of created) vault.writeIdeaFile(vaultPath, idea, titleOf)
  return created
}

export function updateIdea(id: string, patch: IdeaPatch): ResearchIdea {
  const vaultPath = requireVault()
  const current = vault.readIdeaFile(vaultPath, id)
  if (!current) throw new Error('这个选题不存在了。')
  const next: ResearchIdea = { ...current, updatedAt: new Date().toISOString() }
  if (patch.status && IDEA_STATUSES.includes(patch.status)) next.status = patch.status
  if (typeof patch.note === 'string') next.note = patch.note.trim()
  if (typeof patch.title === 'string' && patch.title.trim()) next.title = patch.title.trim()
  vault.writeIdeaFile(vaultPath, next, titleOf)
  return next
}

export function deleteIdea(id: string): boolean {
  return vault.deleteIdeaFile(requireVault(), id)
}
