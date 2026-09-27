import type { EntityKind, PaperGraph } from './lenses'

/**
 * 「方法串联」用到的跨论文相关性判定。
 *
 * 核心主张：**关系必须由数据判定，不能交给模型自由联想**。
 *
 * 只要把一串论文标题丢给模型，它几乎总能写出「都关注具身智能」这种正确但无用的关联，
 * 甚至凭空编出「本文与《X》互补」——而这类句子看起来非常像真的，会被当成知识记住。
 * 所以这里的做法是：先用知识图谱把「真正共享技术要素」的论文筛出来，
 * 只把这些（连同共享点）喂给模型，并在 prompt 里明确允许它说「关系不成立」。
 */

/**
 * 只有这些实体类型算「技术要素」。
 *
 * 刻意排除三类：`concept`（太虚 —— 任何两篇都能共享「多模态」这种词）、
 * `org`（机构相同没有方法论含义）、`metric`（「成功率」几乎人人都有）。
 */
export const RELATED_ENTITY_KINDS: EntityKind[] = [
  'dataset',
  'benchmark',
  'model',
  'method',
  'task',
  'technique'
]

/**
 * 权重：共享一个数据集 / 基准 / 模型 / 方法，远比共享一个笼统的「任务」更能说明两篇真有关联。
 * 阈值 3 正好是「一个具体要素」或「三个笼统要素」——用来挡掉「都用了 Transformer」这一级噪音。
 */
const KIND_WEIGHT: Record<string, number> = {
  dataset: 3,
  benchmark: 3,
  model: 3,
  method: 3,
  task: 1,
  technique: 1
}

const MIN_SCORE = 3
const MAX_CANDIDATES = 6

export interface RelatedPaper {
  id: string
  title: string
  year: number | null
  /** 库里的「一句话总结」；为空表示这篇还没精读过 */
  tldr: string
  /** 共享的实体名（用图谱里的主名，不是别名） */
  shared: string[]
  /** 相关性得分，越大越相关；只用于排序 */
  score: number
}

export interface RelatedCandidate {
  id: string
  title: string
  year: number | null
  tldr: string
  graph?: PaperGraph
}

/** 归一化实体名：大小写、空格、连字符、下划线都不该影响「是不是同一个东西」 */
function normalizeEntity(name: string): string {
  return (name ?? '').toLowerCase().replace(/[\s_\-–—/·]+/g, '')
}

/**
 * 从库里挑出与 `currentId` 真正共享技术要素的论文。
 *
 * @param papers 库里的论文（含 graph / tldr），当前这篇也在里面
 * @returns 按相关度排序的候选；没有真正相关的返回空数组（调用方据此让模型明说「串不上」）
 */
export function relatedPapersFrom(
  currentId: string,
  papers: RelatedCandidate[],
  limit = MAX_CANDIDATES
): RelatedPaper[] {
  const current = papers.find((p) => p.id === currentId)
  const own = new Map<string, { name: string; kind: EntityKind }>()
  for (const entity of current?.graph?.entities ?? []) {
    if (!RELATED_ENTITY_KINDS.includes(entity.kind)) continue
    // 别名只用来匹配，渲染给模型看时仍用主名 —— 别名往往是缩写，模型更容易认主名
    for (const alias of [entity.name, ...(entity.aliases ?? [])]) {
      const key = normalizeEntity(alias)
      if (key && !own.has(key)) own.set(key, { name: entity.name, kind: entity.kind })
    }
  }
  if (!own.size) return []

  const out: RelatedPaper[] = []
  for (const paper of papers) {
    if (paper.id === currentId) continue
    let score = 0
    const shared: string[] = []

    for (const entity of paper.graph?.entities ?? []) {
      if (!RELATED_ENTITY_KINDS.includes(entity.kind)) continue
      const hit = [entity.name, ...(entity.aliases ?? [])]
        .map(normalizeEntity)
        .map((key) => own.get(key))
        .find((value): value is { name: string; kind: EntityKind } => !!value)
      if (!hit) continue
      score += KIND_WEIGHT[entity.kind] ?? 0
      if (!shared.includes(hit.name)) shared.push(hit.name)
    }

    // 分数不够 = 只有噪音级共同点，宁可当它无关，也不要拿给模型去联想
    if (score < MIN_SCORE || !shared.length) continue
    out.push({
      id: paper.id,
      title: paper.title,
      year: paper.year,
      tldr: paper.tldr ?? '',
      shared,
      score
    })
  }

  return out
    .sort((a, b) => b.score - a.score || (b.year ?? 0) - (a.year ?? 0))
    .slice(0, Math.max(0, limit))
}

/**
 * 把候选论文渲染成 prompt 里的一段。
 *
 * 措辞是这一段的关键：必须**明确允许模型说「关系不成立」**。
 * 只给候选而不给出这条退路，模型会默认「给了素材就得写出关联」，
 * 于是把「都用 Transformer」写成「技术路线高度一致」——那正是要避免的东西。
 */
export function renderRelatedPapers(list: RelatedPaper[]): string {
  if (!list.length) {
    return [
      '# 库里读过的其他论文',
      '没有筛出与本篇真正共享技术要素的论文。',
      '因此「方法串联」直接写「库内暂无与本篇真正可串联的论文」，',
      '不要为了让这一节有内容而去关联无关论文。'
    ].join('\n')
  }

  const lines = list.map((paper) => {
    const head = `## ${paper.title}${paper.year ? `（${paper.year}）` : ''}`
    const shared = `- 与本篇共享的技术要素：${paper.shared.join('、')}`
    const tldr = paper.tldr
      ? `- 它的要点：${paper.tldr}`
      : '- 这篇还没有精读笔记，只能当作「你也读过」的线索，不要臆测它的方法细节'
    return [head, shared, tldr].join('\n')
  })

  return [
    '# 库里读过的其他论文（已按「与本篇共享的技术要素」筛过）',
    '下面这些论文确实与本篇共享了具体的技术要素，共享点列在每篇下面。',
    '**只允许基于这些共享点做对照**；如果某个共享点看上去只是巧合（例如数据集同名但场景不同、',
    '或者「都用了 Transformer」这类没有信息量的共同点），就直接说明关系不成立 ——',
    '宁可这一节只有一句话，也不要硬拉关系。',
    '',
    ...lines
  ].join('\n')
}
