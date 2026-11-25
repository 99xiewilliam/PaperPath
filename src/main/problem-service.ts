/**
 * 开放问题池：按范围（全库 / 专题）汇总「局限与未来工作」，交给 agent 聚类，
 * 结果写进 `problems/<scope>.md`。
 */
import {
  LIMITATIONS_SECTION,
  PROBLEM_SCOPE_ALL,
  linkProblems,
  type ProblemMap
} from '@shared/problems'
import { runProblemAgent, type ProblemAgentPaper } from './agents/problems'
import * as db from './db'
import { sectionsOf } from './paper-service'
import { requireVault } from './runtime'
import { getSettings } from './settings'
import * as vault from './vault'

/** 单篇最多带多少字的局限笔记：再长就是在复述，聚类用不上 */
const PER_PAPER_CHARS = 2400
/** 整次调用的输入预算 */
const TOTAL_CHARS = 60000
/** 少于这么多字的局限笔记视为没写（常见的是「原文未说明」） */
const MIN_CHARS = 40

function scopeInfo(scope: string): { title: string; paperIds: string[] } {
  if (scope === PROBLEM_SCOPE_ALL) return { title: '全库', paperIds: db.listPaperIds() }
  const collection = db.getCollection(scope)
  if (!collection) throw new Error('这个专题不存在了。')
  return { title: `专题「${collection.title}」`, paperIds: collection.paperIds }
}

export function getProblemMap(scope: string): ProblemMap | null {
  return vault.readProblemFile(requireVault(), scope)
}

/** 范围内有多少篇已经有可用的「局限与未来工作」——界面据此提示能不能生成 */
export function countProblemSources(scope: string): { total: number; ready: number } {
  const { paperIds } = scopeInfo(scope)
  let ready = 0
  for (const id of paperIds) {
    if ((sectionsOf(id)[LIMITATIONS_SECTION] ?? '').trim().length >= MIN_CHARS) ready++
  }
  return { total: paperIds.length, ready }
}

export async function buildProblemMap(scope: string): Promise<ProblemMap> {
  const vaultPath = requireVault()
  const info = scopeInfo(scope)

  const papers: ProblemAgentPaper[] = []
  let budget = TOTAL_CHARS
  for (const id of info.paperIds) {
    const summary = db.getPaperSummary(id)
    if (!summary) continue
    const text = (sectionsOf(id)[LIMITATIONS_SECTION] ?? '').trim()
    if (text.length < MIN_CHARS) continue
    const clipped = text.length > PER_PAPER_CHARS ? `${text.slice(0, PER_PAPER_CHARS)}…` : text
    if (budget - clipped.length < 0 && papers.length) break
    budget -= clipped.length
    papers.push({ id, title: summary.title, year: summary.year, limitations: clipped })
  }

  if (papers.length < 2) {
    throw new Error(
      `${info.title}里只有 ${papers.length} 篇论文写好了「${LIMITATIONS_SECTION}」，至少要 2 篇才能聚类。先对更多论文跑一次 AI 精读。`
    )
  }

  const { summary, problems } = await runProblemAgent(
    { papers, scopeTitle: info.title },
    getSettings().llm
  )
  if (!problems.length) throw new Error('模型没有返回可用的问题清单，换个时间再试一次。')

  const prev = getProblemMap(scope)
  const linked = linkProblems(problems, prev?.problems ?? [])
  const map: ProblemMap = {
    scope,
    scopeTitle: info.title,
    generatedAt: new Date().toISOString(),
    paperIds: papers.map((p) => p.id),
    summary,
    problems: linked.problems
  }
  const titles = new Map(papers.map((p) => [p.id, p.title]))
  vault.writeProblemFile(vaultPath, map, (id) => titles.get(id) ?? id)
  relinkIdeas(vaultPath, scope, linked.renamed)
  return map
}

/**
 * 问题换了个说法、id 没变时，把已有选题改挂到新标题上。
 * 老选题没有 problemId，就按原来的标题认。
 */
export function relinkIdeas(
  vaultPath: string,
  scope: string,
  renamed: { id: string; from: string; to: string }[]
): number {
  if (!renamed.length) return 0
  let count = 0
  for (const idea of vault.listIdeaFiles(vaultPath)) {
    if (idea.scope !== scope) continue
    const hit = renamed.find(
      (r) => idea.problemId === r.id || (!idea.problemId && idea.problem === r.from)
    )
    if (!hit || (idea.problemId === hit.id && idea.problem === hit.to)) continue
    vault.writeIdeaFile(
      vaultPath,
      { ...idea, problemId: hit.id, problem: hit.to, updatedAt: new Date().toISOString() },
      (id) => db.getPaperSummary(id)?.title ?? id
    )
    count++
  }
  return count
}
