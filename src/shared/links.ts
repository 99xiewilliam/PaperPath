/**
 * 论文之间的关系（paper ↔ paper）。
 *
 * 为什么不沿用原来的知识图谱：那张图是「论文——涉及→实体」+「实体——关系→实体」，
 * 它回答的是「这两篇共享了哪些技术要素」—— 一个**机械**的问题。共享一个数据集
 * 往往是巧合，不是值得你记住的关联；而且那些边全部来自一次你无法修改的抽取，
 * 错了改不了、漏了补不上，于是整张图读起来「花里胡哨但没用」。
 *
 * 这里换一种：关系由**你**建立（或者由 AI 在「数据判定过的候选对」上提议、
 * 你采纳），有方向、有类型、有一句为什么。它才是「这两篇之间发生了什么」，
 * 也才谈得上拿它去组合出新的研究想法。
 *
 * 实体抽取（`graph` 维度）不会被丢掉，它换了个岗位：做 AI 提议的**候选筛选**
 *（见 shared/connections.ts），而不再是要你盯着看的那张图。
 */

export type PaperLinkType =
  /** 基于 / 改进：这篇是那篇的后继工作 */
  | 'builds-on'
  /** 对比 / 竞争：同一个赛道，路线不同 */
  | 'contrast'
  /** 同一问题、不同解法：问题定义一致，答案不同 */
  | 'same-problem'
  /** 可迁移 / 受启发：它的做法能搬到那篇的场景 */
  | 'inspires'
  /** 结论冲突：两篇的结论互相矛盾，值得弄清谁对 */
  | 'contradicts'
  /** 说不清属于哪种，但确实有关 */
  | 'related'

export const LINK_TYPES: PaperLinkType[] = [
  'builds-on',
  'contrast',
  'same-problem',
  'inspires',
  'contradicts',
  'related'
]

export const LINK_TYPE_LABEL: Record<PaperLinkType, string> = {
  'builds-on': '基于 / 改进',
  contrast: '对比 / 竞争',
  'same-problem': '同一问题',
  inspires: '可迁移',
  contradicts: '结论冲突',
  related: '相关'
}

/** 挑类型时的提示：写清什么时候该用它，否则这个词本身没法定 */
export const LINK_TYPE_HINT: Record<PaperLinkType, string> = {
  'builds-on': '这篇在方法上承接了那篇（改进了它的某个环节）',
  contrast: '同一个赛道、不同技术路线，实验里通常互为基线',
  'same-problem': '两篇在解决同一个问题，但给出的答案不一样',
  inspires: '它的某个做法可以搬到那篇的场景里试试',
  contradicts: '两篇的结论互相矛盾，弄清楚谁对本身就是个题目',
  related: '说不清属于哪一种，但你认为它们有关'
}

export const LINK_TYPE_COLOR: Record<PaperLinkType, string> = {
  'builds-on': '#5FA983',
  contrast: '#7FA3C7',
  'same-problem': '#C9973F',
  inspires: '#ACA3CF',
  contradicts: '#C4584D',
  related: '#87847E'
}

export interface PaperLink {
  /** 指向哪篇论文（paper id） */
  to: string
  type: PaperLinkType
  /** 一句话：为什么认为它们有关。写给人看，也是将来组合 idea 的原料 */
  note?: string
  /** 谁建立的：人手工，还是 AI 提议（提议要在界面上确认过才算数） */
  by: 'user' | 'ai'
  /** AI 提议时的依据（来自哪一节 / 哪句话 —— 必须可追溯，否则就是空话） */
  evidence?: string
  /** 建立时间 */
  at?: string
}

/** 单篇论文最多存多少条关系：手工维护的量级远用不到，纯粹防脏数据把 frontmatter 撑爆 */
const MAX_LINKS = 40
const MAX_NOTE = 200
const MAX_EVIDENCE = 300

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 把任意来源的关系数组收敛成可渲染、可落盘的结构。
 *
 * 几条刻意的取舍：
 *   - **不认识的类型收敛成 `related` 而不是丢掉**：类型是后来加的词表，
 *     老数据里的陌生值不该让整条关系消失（同 autohighlight 把陌生 kind 收敛成 other）。
 *   - **同一对 + 同一类型只留一条**，且**人手工的那条优先** —— AI 提议不该覆盖你的判断。
 *   - 指向自己的关系直接丢掉：`A → A` 在图上是个环，没有任何信息。
 *   - 没值的键不出现：值为 undefined 的键会让 js-yaml 抛错。
 */
export function normalizeLinks(raw: unknown, selfId = '', limit = MAX_LINKS): PaperLink[] {
  if (!Array.isArray(raw)) return []

  const byKey = new Map<string, PaperLink>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const link = item as Record<string, unknown>
    const to = str(link.to)
    if (!to || to === selfId) continue

    const type = (LINK_TYPES as string[]).includes(str(link.type))
      ? (str(link.type) as PaperLinkType)
      : 'related'
    const key = `${to}|${type}`
    const previous = byKey.get(key)
    // 人手工的那条优先：AI 提议不能覆盖你已经确认的判断
    if (previous?.by === 'user' && str(link.by) !== 'user') continue

    const note = str(link.note).slice(0, MAX_NOTE)
    const evidence = str(link.evidence).slice(0, MAX_EVIDENCE)
    const at = str(link.at)
    byKey.set(key, {
      to,
      type,
      by: str(link.by) === 'ai' ? 'ai' : 'user',
      ...(note ? { note } : {}),
      ...(evidence ? { evidence } : {}),
      ...(at ? { at } : {})
    })
  }

  return [...byKey.values()]
    .sort((a, b) => (a.by === b.by ? a.to.localeCompare(b.to) : a.by === 'user' ? -1 : 1))
    .slice(0, Math.max(0, limit))
}

/** 关系在界面和图上的唯一键 */
export function linkKey(link: Pick<PaperLink, 'to' | 'type'>): string {
  return `${link.to}|${link.type}`
}
