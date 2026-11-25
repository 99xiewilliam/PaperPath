/**
 * 开放问题池：把多篇论文「局限与未来工作」里的问题聚成一张清单。
 *
 * 每个范围（全库 / 某个专题）一份 Markdown：`problems/<scope>.md`。
 * frontmatter 存结构化数据供界面渲染，正文是同一份内容的可读版本，
 * 离开 PaperVault 也能直接看。
 */

/** 问题从哪来：作者自己承认的 / 审稿视角发现的 / 两者都有 */
export type ProblemSource = 'author' | 'reviewer' | 'both'

export const PROBLEM_SOURCE_LABEL: Record<ProblemSource, string> = {
  author: '作者自陈',
  reviewer: '审稿发现',
  both: '作者自陈 + 审稿发现'
}

export interface OpenProblem {
  /**
   * 稳定 id。重新汇总时尽量沿用（标题没变，或出处论文大部分重合），
   * 选题靠它关联，不靠会变的标题。
   */
  id: string
  /** 一句话问题 */
  title: string
  /** 为什么这是个问题、各篇论文分别怎么说 */
  detail: string
  source: ProblemSource
  /** 提到这个问题的论文 id */
  paperIds: string[]
  /** 可以怎么切入（没有就是空串） */
  direction: string
}

export interface ProblemMap {
  /** 'all' 或专题 id */
  scope: string
  scopeTitle: string
  generatedAt: string
  /** 参与汇总的论文 id */
  paperIds: string[]
  /** 整体判断：这批论文的问题集中在哪 */
  summary: string
  problems: OpenProblem[]
}

export const PROBLEM_SCOPE_ALL = 'all'

/** 汇总的原料就是这一节（limitations 维度产出） */
export const LIMITATIONS_SECTION = '局限与未来工作'

const SOURCES = new Set<string>(['author', 'reviewer', 'both'])

/**
 * 把模型输出或 frontmatter 里的问题列表收敛成合法结构。
 * `resolveId` 把模型给的论文编号（P1…）或 frontmatter 里的 id 映射回真实 id，
 * 映射不到的引用直接丢掉 —— 一个问题至少要能追溯到一篇论文。
 */
export function normalizeProblems(
  raw: unknown,
  resolveId: (ref: string) => string | null
): OpenProblem[] {
  if (!Array.isArray(raw)) return []
  const out: OpenProblem[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    const title = String(p.title ?? '').trim()
    if (!title) continue
    const refs = Array.isArray(p.papers) ? p.papers : Array.isArray(p.paperIds) ? p.paperIds : []
    const paperIds = [
      ...new Set(
        refs.map((r) => resolveId(String(r ?? '').trim())).filter((id): id is string => !!id)
      )
    ]
    if (!paperIds.length) continue
    const source = String(p.source ?? '').trim()
    const id = String(p.id ?? '').trim()
    out.push({
      id,
      title: title.slice(0, 160),
      detail: String(p.detail ?? '').trim(),
      source: SOURCES.has(source) ? (source as ProblemSource) : 'reviewer',
      paperIds,
      direction: String(p.direction ?? '').trim()
    })
    if (out.length >= 30) break
  }
  return linkProblems(out).problems
}

/** 标题的稳定指纹。老文件没有 id 时用它补上，同一句话每次得到同一个 id */
export function problemKey(title: string): string {
  let h = 0x811c9dc5
  for (const ch of title.trim().toLowerCase().replace(/\s+/g, '')) {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193)
  }
  return `p-${(h >>> 0).toString(16).padStart(8, '0')}`
}

function overlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0
  const set = new Set(b)
  const shared = a.filter((id) => set.has(id)).length
  return shared / new Set([...a, ...b]).size
}

/**
 * 给问题补上稳定 id，并尽量继承上一版的 id。
 *
 * 先认标题完全相同的；对不上再看出处论文有没有大半重合
 * （重新汇总时常只是换了个说法）。返回 renamed：标题变了、id 没变的那些，
 * 调用方据此把已有选题改挂到新标题上。
 */
export function linkProblems(
  next: OpenProblem[],
  previous: OpenProblem[] = []
): { problems: OpenProblem[]; renamed: { id: string; from: string; to: string }[] } {
  const used = new Set<string>()
  const renamed: { id: string; from: string; to: string }[] = []
  const problems = next.map((problem) => {
    const prev =
      previous.find((old) => old.id && !used.has(old.id) && old.title === problem.title) ??
      previous.find(
        (old) => old.id && !used.has(old.id) && overlap(old.paperIds, problem.paperIds) >= 0.5
      )
    const base = prev?.id || problem.id || problemKey(problem.title)
    let id = base
    let n = 2
    while (used.has(id)) id = `${base}-${n++}`
    used.add(id)
    if (prev && prev.title !== problem.title)
      renamed.push({ id, from: prev.title, to: problem.title })
    return { ...problem, id }
  })
  return { problems, renamed }
}

/** 生成正文（可读版本）。titleOf 把论文 id 换成标题 */
export function problemMapMarkdown(map: ProblemMap, titleOf: (id: string) => string): string {
  const lines: string[] = [
    `# 开放问题池 · ${map.scopeTitle}`,
    '',
    `> ${map.paperIds.length} 篇论文 · 生成于 ${new Date(map.generatedAt).toLocaleString('zh-CN')}`,
    ''
  ]
  if (map.summary) lines.push(map.summary, '')
  map.problems.forEach((p, i) => {
    lines.push(`## ${i + 1}. ${p.title}`, '')
    lines.push(`- 来源：${PROBLEM_SOURCE_LABEL[p.source]}`)
    lines.push(`- 出处：${p.paperIds.map((id) => `《${titleOf(id)}》`).join('、')}`)
    if (p.direction) lines.push(`- 可以怎么切入：${p.direction}`)
    if (p.detail) lines.push('', p.detail)
    lines.push('')
  })
  return lines.join('\n')
}
