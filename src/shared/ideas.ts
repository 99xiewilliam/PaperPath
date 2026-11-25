/**
 * 选题本：从开放问题池里的一个问题出发，生成可验证的研究选题。
 *
 * 每个选题一份 Markdown：`ideas/<id>.md`。和问题池分开存，是因为问题池每次
 * 「重新汇总」都会整份重写，而选题是用户要长期跟进、写备注的东西，不能跟着丢。
 *
 * 一个选题必须同时有「假设 / 最小验证实验 / 反证条件」，缺一项就不算选题 ——
 * 说不清怎么证伪的想法，只是愿望。
 */

export type IdeaStatus = 'new' | 'pursuing' | 'parked' | 'dropped'

export const IDEA_STATUS_LABEL: Record<IdeaStatus, string> = {
  new: '待评估',
  pursuing: '在推进',
  parked: '先放着',
  dropped: '放弃'
}

export const IDEA_STATUSES: IdeaStatus[] = ['new', 'pursuing', 'parked', 'dropped']

export interface ResearchIdea {
  id: string
  title: string
  /** 可证伪的核心假设 */
  hypothesis: string
  /** 打算怎么做：借谁的方法、改哪里 */
  approach: string
  /** 最小验证实验：数据集 / 基线 / 指标，越小越好 */
  experiment: string
  /** 出现什么结果就说明假设不成立 */
  falsifier: string
  /** 开工前还缺什么（数据、算力、前置结论），没有就是空串 */
  gaps: string
  /** 依据的论文 id */
  paperIds: string[]
  /** 来自哪个开放问题（问题标题，给人看） */
  problem: string
  /** 开放问题的稳定 id；老选题没有，界面退回按标题匹配 */
  problemId?: string
  /** 问题池范围：'all' 或专题 id */
  scope: string
  status: IdeaStatus
  /** 用户自己的备注 */
  note: string
  createdAt: string
  updatedAt: string
}

/** 界面可改的字段 */
export type IdeaPatch = Partial<Pick<ResearchIdea, 'status' | 'note' | 'title'>>

const STATUS_SET = new Set<string>(IDEA_STATUSES)

function text(value: unknown, max = 2000): string {
  return String(value ?? '')
    .trim()
    .slice(0, max)
}

/**
 * 把模型输出收敛成选题草稿（还没有 id / 时间 / 状态）。
 * 假设、最小实验、反证条件任一为空就丢掉；论文引用映射不到的也丢掉。
 */
export function normalizeIdeaDrafts(
  raw: unknown,
  resolveId: (ref: string) => string | null
): Pick<
  ResearchIdea,
  'title' | 'hypothesis' | 'approach' | 'experiment' | 'falsifier' | 'gaps' | 'paperIds'
>[] {
  if (!Array.isArray(raw)) return []
  const out: ReturnType<typeof normalizeIdeaDrafts> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    const draft = {
      title: text(p.title, 160),
      hypothesis: text(p.hypothesis),
      approach: text(p.approach),
      experiment: text(p.experiment),
      falsifier: text(p.falsifier),
      gaps: text(p.gaps),
      paperIds: [
        ...new Set(
          (Array.isArray(p.papers) ? p.papers : [])
            .map((r) => resolveId(String(r ?? '').trim()))
            .filter((id): id is string => !!id)
        )
      ]
    }
    if (!draft.title || !draft.hypothesis || !draft.experiment || !draft.falsifier) continue
    out.push(draft)
    if (out.length >= 5) break
  }
  return out
}

/** 从 frontmatter 读回一个选题；关键字段缺失就当文件坏了 */
export function parseIdea(id: string, data: Record<string, unknown>): ResearchIdea | null {
  const title = text(data.title, 160)
  if (!title) return null
  const status = text(data.status)
  const ids = Array.isArray(data.paperIds) ? data.paperIds : []
  return {
    id,
    title,
    hypothesis: text(data.hypothesis),
    approach: text(data.approach),
    experiment: text(data.experiment),
    falsifier: text(data.falsifier),
    gaps: text(data.gaps),
    paperIds: [...new Set(ids.map((x) => String(x ?? '').trim()).filter(Boolean))],
    problem: text(data.problem, 400),
    ...(text(data.problemId) ? { problemId: text(data.problemId) } : {}),
    scope: text(data.scope) || 'all',
    status: STATUS_SET.has(status) ? (status as IdeaStatus) : 'new',
    note: text(data.note, 20000),
    createdAt: text(data.createdAt),
    updatedAt: text(data.updatedAt)
  }
}

/** 正文（可读版本）。titleOf 把论文 id 换成标题 */
export function ideaMarkdown(idea: ResearchIdea, titleOf: (id: string) => string): string {
  const lines = [
    `# ${idea.title}`,
    '',
    `> ${IDEA_STATUS_LABEL[idea.status]} · 来自开放问题「${idea.problem}」`,
    '',
    '## 假设',
    '',
    idea.hypothesis,
    ''
  ]
  if (idea.approach) lines.push('## 怎么做', '', idea.approach, '')
  lines.push('## 最小验证实验', '', idea.experiment, '')
  lines.push('## 反证条件', '', idea.falsifier, '')
  if (idea.gaps) lines.push('## 开工前还缺', '', idea.gaps, '')
  if (idea.paperIds.length) {
    lines.push('## 依据', '', ...idea.paperIds.map((id) => `- 《${titleOf(id)}》`), '')
  }
  if (idea.note) lines.push('## 我的备注', '', idea.note, '')
  return lines.join('\n')
}
