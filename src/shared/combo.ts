/**
 * 「组合分析」的原料与线索。
 *
 * 与「研究想法」（shared/ideas.ts）的区别在问题本身：
 *   - 想法是**沿着一条已确认的关系**往前走（A 和 B 之间那条线能长成什么题）；
 *   - 组合是**面对一组论文**问「把它们凑在一起，有没有组合创新的空间」——
 *     成员之间甚至可能还没有任何关系，那正是要看出来的东西。
 *
 * 这里只做两件事，都不交给模型：
 *   1. **拼原料**：参与组合的每篇的方法 / 局限 / 可迁移点 / 实验画像 / 组内已有关系；
 *   2. **算线索**（computeComboSignals）：纯数据能算出来的结构性事实 ——
 *      共享了哪些具体技术要素、只有谁用到的要素、数据集与指标是否错位、基线是否重叠、
 *      组内有没有结论冲突、谁自己写下了可迁移点。
 *
 * 线索的分寸要紧：它们只说明「这里值得看一眼」，**不构成创新空间的证据**——
 * 「都用了 Transformer」当然不是创新空间。所以 prompt 里会明说这一层，
 * 并且允许模型回答「这组凑不出东西来」。
 */
import type { ExperimentProfile } from './experiment'
import { LINK_TYPE_LABEL, type PaperLink, type PaperLinkType } from './links'
import { RELATED_ENTITY_KINDS } from './connections'

export const MIN_COMBO_PAPERS = 2
/** 上限 6 篇：材料量按篇数线性涨，再多模型会开始「平均地看每一篇」 */
export const MAX_COMBO_PAPERS = 6

export interface ComboEntity {
  name: string
  kind: string
}

export interface ComboPaper {
  id: string
  title: string
  year: number | null
  tldr: string
  method: string
  limitation: string
  transferable: string
  exp?: ExperimentProfile
  /** 它的关系列表（用来找**组内**已有的关系） */
  links?: PaperLink[]
  /** 知识图谱抽出来的实体，用来算共享 / 互补 */
  entities?: ComboEntity[]
}

export type ComboRelation = {
  from: string
  to: string
  type: PaperLinkType
  note?: string
}

export type ComboSignalKind =
  /** 两篇以上共享同一个具体技术要素：同一赛道 */
  | 'shared-tech'
  /** 只有一篇用到的技术要素：可能互补的原料 */
  | 'distinct-tech'
  /** 数据集 / 指标 / 基线的错位：能交叉验证，或口径本身有问题 */
  | 'experiment-gap'
  /** 组内存在「结论冲突」：谁对本身就是题目 */
  | 'conflict'
  /** 有人自己写下了可迁移点 */
  | 'transferable'

export interface ComboSignal {
  kind: ComboSignalKind
  /** 一句人话，直接进 prompt 与文档 */
  text: string
}

/** 组内论文之间的关系（两个方向都收，去重） */
export function collectComboRelations(papers: ComboPaper[]): ComboRelation[] {
  const ids = new Set(papers.map((p) => p.id))
  const out: ComboRelation[] = []
  const seen = new Set<string>()
  for (const paper of papers) {
    for (const link of paper.links ?? []) {
      if (!ids.has(link.to) || link.to === paper.id) continue
      const key = `${paper.id}|${link.to}|${link.type}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        from: paper.id,
        to: link.to,
        type: link.type,
        ...(link.note ? { note: link.note } : {})
      })
    }
  }
  return out
}

export function computeComboSignals(papers: ComboPaper[]): ComboSignal[] {
  const signals: ComboSignal[] = []
  const titleOf = (id: string): string => shortTitle(papers.find((p) => p.id === id)?.title ?? id)

  /* ---- 技术要素：谁和谁共享，谁独有 ---- */
  const owners = new Map<string, Set<string>>()
  for (const paper of papers) {
    for (const entity of paper.entities ?? []) {
      if (!RELATED_ENTITY_KINDS.includes(entity.kind as never)) continue
      const key = entity.name.trim()
      if (!key) continue
      if (!owners.has(key)) owners.set(key, new Set())
      owners.get(key)!.add(paper.title)
    }
  }
  const shared = [...owners.entries()].filter(([, who]) => who.size >= 2).map(([name]) => name)
  const distinct = [...owners.entries()].filter(([, who]) => who.size === 1).map(([name]) => name)

  if (shared.length) {
    signals.push({
      kind: 'shared-tech',
      text: `多篇共用的具体技术要素：${clipList(shared, 8)} —— 说明它们大体在同一赛道，差别要看方法细节`
    })
  }
  if (distinct.length) {
    signals.push({
      kind: 'distinct-tech',
      text: `只有一篇用到的技术要素：${clipList(distinct, 8)} —— 这些是可能被搬过去的原料`
    })
  }

  /* ---- 实验设置：错位与重叠 ---- */
  const withExp = papers.filter((p) => p.exp)
  if (withExp.length >= 2) {
    const byField = (pick: (exp: ExperimentProfile) => string[]): [string, string[]][] =>
      withExp
        .map((p) => [shortTitle(p.title), pick(p.exp as ExperimentProfile)] as [string, string[]])
        .filter(([, values]) => values.length > 0)

    const datasets = byField((exp) => exp.datasets ?? [])
    if (datasets.length >= 2 && new Set(datasets.flatMap(([, v]) => v)).size > 1) {
      signals.push({
        kind: 'experiment-gap',
        text: `数据集错位：${datasets.map(([t, v]) => `${t} 用 ${v.join('、')}`).join('；')} —— 可以交叉验证，也可能根本不可迁移`
      })
    }

    const metrics = byField((exp) => exp.metrics ?? [])
    if (metrics.length >= 2 && new Set(metrics.flatMap(([, v]) => v)).size > 1) {
      signals.push({
        kind: 'experiment-gap',
        text: `评价指标不一致：${metrics.map(([t, v]) => `${t} 用 ${v.join('、')}`).join('；')} —— 度量口径本身可能就是个问题`
      })
    }

    const baselines = byField((exp) => exp.baselines ?? [])
    const overlap = baselines.length >= 2
      ? [...new Set(baselines[0][1])].filter((b) => baselines.every(([, v]) => v.includes(b)))
      : []
    if (overlap.length) {
      signals.push({
        kind: 'experiment-gap',
        text: `共用基线：${overlap.join('、')} —— 它们的结论可以直接同台比较（结论冲突时尤其有用）`
      })
    }
  }

  /* ---- 组内已有的关系 ---- */
  const conflicts = collectComboRelations(papers).filter((r) => r.type === 'contradicts')
  if (conflicts.length) {
    signals.push({
      kind: 'conflict',
      text: `组内存在结论冲突：${conflicts
        .map((r) => `${titleOf(r.from)} ↔ ${titleOf(r.to)}`)
        .join('、')} —— 弄清谁对本身就是个可做的题目`
    })
  }

  const transferable = papers.filter((p) => (p.transferable ?? '').trim().length >= 20)
  if (transferable.length) {
    signals.push({
      kind: 'transferable',
      text: `已经自己写下可迁移点的：${transferable.map((p) => shortTitle(p.title)).join('、')} —— 那是你已经看见的方向`
    })
  }

  return signals
}

export interface ComboAngle {
  title: string
  hypothesis: string
  why: string
  /** 这个角度主要来自哪几篇（用标题，方便写进文档） */
  from: string[]
  minimalTest: string
  falsify: string
  risk?: string
}

/** 「如果把它们合成一篇论文，会是什么样」*/
export interface ComboComposite {
  title: string
  contribution: string
  skeleton: string
  experiments: string
  /** 还缺什么才能成立 —— 这一项比前面的结论更有用 */
  missing: string
}

export interface ComboAnalysis {
  ok: boolean
  /** 一句话总判断：这组论文里有没有组合空间 */
  verdict?: string
  space?: 'none' | 'weak' | 'promising'
  angles: ComboAngle[]
  composite?: ComboComposite
  /** 判定「凑不出东西」或材料不足时的理由 */
  reason?: string
}

export const SPACE_LABEL: Record<'none' | 'weak' | 'promising', string> = {
  none: '没有组合空间',
  weak: '空间很弱',
  promising: '有值得做的地方'
}

export interface ComboDocInput {
  papers: ComboPaper[]
  relations: ComboRelation[]
  signals: ComboSignal[]
  analysis: ComboAnalysis
  at: string
}

export function renderComboDoc({ papers, relations, signals, analysis, at }: ComboDocInput): string {
  const lines: string[] = [
    `# 组合分析：${papers.map((p) => shortTitle(p.title)).join(' + ')}`,
    '',
    `> 由 ${papers.length} 篇论文组合而成；数据侧只提供线索，判断由 AI 给出，取舍在你。`,
    `> 生成时间：${at}`,
    '',
    `**总判断**：${analysis.verdict ?? '（无）'}${analysis.space ? `（${SPACE_LABEL[analysis.space]}）` : ''}`,
    ''
  ]

  if (!analysis.ok) {
    lines.push(
      `**这次没有找到可做的组合角度**：${analysis.reason ?? '材料不足以支撑一个可验证的题目。'}`,
      '',
      '这不一定是坏事 —— 把几篇只是「都做这个方向」的论文凑在一起，本来就不该硬造出题目。',
      '可以试试：补上其中一两篇的「局限与未来工作 / 可迁移到我的研究」，或者换一组差异更大的论文。',
      ''
    )
  }

  if (analysis.angles.length) {
    lines.push('## 组合角度', '')
    for (const [index, angle] of analysis.angles.entries()) {
      lines.push(
        `### ${index + 1}. ${angle.title}`,
        '',
        `**假设**：${angle.hypothesis}`,
        '',
        ...(angle.why ? [`**为什么值得做**：${angle.why}`, ''] : []),
        `**来自**：${angle.from.length ? angle.from.join('、') : papers.map((p) => shortTitle(p.title)).join('、')}`,
        '',
        `**最小验证实验**：${angle.minimalTest}`,
        '',
        `**反证条件**：${angle.falsify}`,
        '',
        ...(angle.risk ? [`**风险与前提**：${angle.risk}`, ''] : [])
      )
    }
  }

  if (analysis.composite) {
    lines.push(
      '## 组合论文分析（如果把它们合成一篇）',
      '',
      `**题目**：${analysis.composite.title}`,
      '',
      `**贡献**：${analysis.composite.contribution}`,
      '',
      `**方法骨架**：${analysis.composite.skeleton}`,
      '',
      `**实验设计**：${analysis.composite.experiments}`,
      '',
      `**还缺什么**：${analysis.composite.missing}`,
      ''
    )
  }

  if (relations.length) {
    lines.push(
      '## 组内已有的关系',
      '',
      ...relations.map(
        (r) =>
          `- ${shortTitle(papers.find((p) => p.id === r.from)?.title ?? r.from)} → ${shortTitle(
            papers.find((p) => p.id === r.to)?.title ?? r.to
          )}：${LINK_TYPE_LABEL[r.type]}${r.note ? `（${r.note}）` : ''}`
      ),
      ''
    )
  }

  if (signals.length) {
    lines.push(
      '## 数据侧线索（只说明「值得看一眼」，不是创新空间）',
      '',
      ...signals.map((s) => `- ${s.text}`),
      ''
    )
  }

  lines.push('## 参与组合的论文', '')
  for (const paper of papers) {
    const tldr = paper.tldr ? `：${paper.tldr}` : ''
    lines.push(`- **${shortTitle(paper.title)}**（${paper.year ?? '年份未知'}）${tldr}`)
  }
  lines.push('')

  return lines.join('\n').trimEnd() + '\n'
}

function clipList(values: string[], max: number): string {
  const kept = values.slice(0, max)
  return values.length > max ? `${kept.join('、')}…（共 ${values.length} 个）` : kept.join('、')
}

function shortTitle(title: string): string {
  return title.length <= 60 ? title : `${title.slice(0, 60)}…`
}
