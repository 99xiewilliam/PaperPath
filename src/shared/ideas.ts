/**
 * 研究想法的「原料组合」与文档渲染。
 *
 * 想法不能凭空生成 —— 让模型面对「我读了这几篇论文」自由发挥，它会给出一堆
 * 听起来激动人心、但没有任何抓手的方向（「探索更高效的图检索」这类），既不能验证
 * 也不能反证。所以这里只做一件事：把**一个你确认过的关系**，连同两篇论文的
 * 具体原料拼成一个组合单元（seed），交给专门的 agent 写成一个可验证的题目。
 *
 * 三段职责照旧分开：
 *   1. **原料从哪来** —— 本文件（纯函数）：已确认的关系 + 方法细节 / 局限 / 可迁移点 / 实验画像；
 *   2. **写成什么题目** —— agents/ideas.ts（一对一次地问模型，允许它说这条关系撑不起题目）；
 *   3. **落在哪** —— ai-service 渲染成 Markdown 存进 syntheses/，人读、改、挑。
 *
 * 两个刻意的取舍：
 *   - **只用 `by: 'user'` 的关系**。AI 提议还不算数：想法要站在你自己的判断上，
 *     否则整条链路会变成「AI 用 AI 猜的关系生成 AI 想做的题」。
 *   - **来源与依据由数据渲染，不由模型写**（见 renderIdeaDoc）。模型只负责「能不能做成题」，
 *     至于「这条想法是从哪两篇、哪条关系来的」——那是事实，不该经过一次转述。
 */
import type { ExperimentProfile } from './experiment'
import { LINK_TYPE_LABEL, type PaperLink, type PaperLinkType } from './links'

/** 一段材料少于这么多字就当没写（骨架模板、随口一句都撑不起一个题目） */
const MIN_MATERIAL = 20

/** 一次最多组合多少条：每条一次模型调用，宁可让人分批跑，也不要一次账单失控 */
export const MAX_IDEA_SEEDS = 6

export interface IdeaSeedPaper {
  id: string
  title: string
  year: number | null
  /** 一句话总结 */
  tldr: string
  /** 它到底怎么做的 */
  method: string
  /** 它自己承认没解决的（想法的靶子） */
  limitation: string
  /** 能搬到哪去（想法的原料） */
  transferable: string
  /** 实验画像：最小验证实验可以直接照着它的设置做 */
  exp?: ExperimentProfile
  /** 这篇的关系列表（只有出边会被用到） */
  links?: PaperLink[]
}

export interface IdeaSeedRelation {
  type: PaperLinkType
  note?: string
  evidence?: string
  /** 这条关系是 seed.from → seed.to（out），还是反过来（in） */
  direction: 'out' | 'in'
}

export interface IdeaSeed {
  from: IdeaSeedPaper
  to: IdeaSeedPaper
  /** 同一对论文之间的全部已确认关系（去重后） */
  relations: IdeaSeedRelation[]
}

/**
 * 出题的潜力排序。
 *
 * 「结论冲突」最容易长成题目（弄清谁对本身就是个实验）；「可迁移」次之（照搬一个做法去试）；
 * 「同一问题」也不错（两个答案必有差别）；「基于/改进」偏工程（多数是调参）；「相关」最虚。
 */
const TYPE_PRIORITY: PaperLinkType[] = [
  'contradicts',
  'inspires',
  'same-problem',
  'builds-on',
  'contrast',
  'related'
]

export function buildIdeaSeeds(papers: IdeaSeedPaper[], limit = MAX_IDEA_SEEDS): IdeaSeed[] {
  const byId = new Map(papers.map((p) => [p.id, p]))
  const pairs = new Map<string, IdeaSeed>

  for (const paper of papers) {
    for (const link of paper.links ?? []) {
      // 只用你确认过的关系：AI 提议还没算数
      if (link.by !== 'user') continue
      const other = byId.get(link.to)
      if (!other || other.id === paper.id) continue

      const key = pairKey(paper.id, other.id)
      let seed = pairs.get(key)
      if (!seed) {
        /*
         * from 固定取 id 小的那篇：同一对论文不管关系写在谁身上，出来的 seed
         * 都一样（方向、字段都稳定），跑两次不会得到两份不同的文档。
         */
        seed = paper.id < other.id ? { from: paper, to: other, relations: [] } : { from: other, to: paper, relations: [] }
        pairs.set(key, seed)
      }

      const direction: 'out' | 'in' = paper.id === seed.from.id ? 'out' : 'in'
      if (seed.relations.some((r) => r.type === link.type && r.direction === direction)) continue
      seed.relations.push({
        type: link.type,
        direction,
        ...(link.note ? { note: link.note } : {}),
        ...(link.evidence ? { evidence: link.evidence } : {})
      })
    }
  }

  return [...pairs.values()]
    // 两边都没写下任何原料 → 交给模型只能得到空话，不如不跑（省一次调用）
    .filter((seed) => materialCount(seed.from) + materialCount(seed.to) > 0)
    .sort((a, b) => seedRank(b) - seedRank(a))
    .slice(0, Math.max(0, limit))
}

/** 一个 idea agent 的输出；`ok: false` 表示这条关系撑不起可验证的题目 */
export interface Idea {
  ok: boolean
  title?: string
  /** 一句话假设：把「A 的做法搬到 B 的短板」写成一个可被实验检验的判断 */
  hypothesis?: string
  why?: string
  minimalTest?: string
  falsify?: string
  risk?: string
  /** 判不成立时说明缺什么（只用于文档末尾，不落进正文） */
  reason?: string
}

export interface IdeaDocInput {
  seed: IdeaSeed
  idea: Idea
}

/**
 * 渲染成一份 Markdown 文档。
 *
 * 「来源」与「依据」两行**从 seed 生成**，不取模型的话：这两行是事实
 *（哪两篇、哪条关系、你写的那句为什么），事实不该经过一次转述 ——
 * 转述一次就可能把「可迁移」说成「基于」，而读者（将来的你）没有别的线索可核对。
 */
export function renderIdeaDoc(
  items: IdeaDocInput[],
  declined: IdeaDocInput[],
  meta: { at: string; confirmedLinks: number }
): string {
  const head = [
    '# 研究想法 · 从已确认的论文关系组合',
    '',
    `> 由 ${meta.confirmedLinks} 条**你确认过的**论文关系组合而成（AI 提议未采纳的不参与）。`,
    '> 每条都写明来源、依据、最小验证实验与反证条件 —— 缺任何一项就说明它还只是个方向，不是题目。',
    `> 生成时间：${meta.at}`,
    ''
  ]

  if (!items.length) {
    head.push(
      '这次没有组合出可验证的题目。',
      '',
      '常见原因：关系两边的「局限与未来工作 / 可迁移到我的研究 / 方法细节」还是空的。',
      '先把这两节写一点，原料够了再来一次 —— 空笔记上长不出题目，只会长出空话。',
      ''
    )
  }

  for (const [index, { seed, idea }] of items.entries()) {
    head.push(
      `## ${index + 1}. ${idea.title ?? '（未命名）'}`,
      '',
      `**假设**：${idea.hypothesis ?? ''}`,
      '',
      ...(idea.why ? [`**为什么值得做**：${idea.why}`, ''] : []),
      `**来源**：${brief(seed.from)} ↔ ${brief(seed.to)}`,
      '',
      ...seed.relations.map(
        (r) =>
          `- ${r.direction === 'out' ? `${shortTitle(seed.from.title)} → ${shortTitle(seed.to.title)}` : `${shortTitle(seed.to.title)} → ${shortTitle(seed.from.title)}`}：${LINK_TYPE_LABEL[r.type]}${r.note ? `（${r.note}）` : ''}`
      ),
      '',
      `**最小验证实验**：${idea.minimalTest ?? ''}`,
      '',
      `**反证条件**：${idea.falsify ?? ''}`,
      '',
      ...(idea.risk ? [`**风险与前提**：${idea.risk}`, ''] : [])
    )
  }

  if (declined.length) {
    head.push(
      '---',
      '',
      '## 没能组合成题目的关系',
      '',
      '这些关系本身是有效的，只是现有笔记还撑不起一个可验证的题目（不必删掉，材料够了会自然浮上来）：',
      '',
      ...declined.map(
        ({ seed, idea }) =>
          `- ${shortTitle(seed.from.title)} ↔ ${shortTitle(seed.to.title)}${idea.reason ? `：${idea.reason}` : ''}`
      ),
      ''
    )
  }

  return head.join('\n').trimEnd() + '\n'
}

/** 把一篇论文渲染成 prompt / 文档里的一行身份 */
function brief(paper: IdeaSeedPaper): string {
  return `${shortTitle(paper.title)}（${paper.year ?? '年份未知'}）`
}

function shortTitle(title: string): string {
  return title.length <= 48 ? title : `${title.slice(0, 48)}…`
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function materialCount(paper: IdeaSeedPaper): number {
  return [paper.method, paper.limitation, paper.transferable].filter(
    (text) => (text ?? '').trim().length >= MIN_MATERIAL
  ).length
}

function seedRank(seed: IdeaSeed): number {
  const best = Math.min(...seed.relations.map((r) => TYPE_PRIORITY.indexOf(r.type)))
  // 类型优先（结论冲突最容易出题），同类型再看原料够不够
  return (TYPE_PRIORITY.length - Math.max(0, best)) * 10 + Math.min(3, materialCount(seed.from) + materialCount(seed.to))
}
