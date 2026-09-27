/**
 * 关系发现 agent：判断**一对**论文之间到底有没有关系、属于哪一类。
 *
 * 三个职责各自独立，这个文件只管中间那一件：
 *   1. **谁值得判** —— shared/connections.ts 用知识图谱判定「真正共享技术要素」，
 *      数据说了算（这一步不在这里，也不该在这里）；
 *   2. **是不是真有关系** —— 本文件，一对一次地问模型；
 *   3. **落盘与确认** —— ai-service 只写 `by: 'ai'` 的提议，人点了采纳才算你的关系。
 *
 * 为什么一次只判一对，而不是把 6 个候选塞进一次调用：
 *   - **独立性**：一次给多对，模型会为了「让每一对都有答案」而拉平差异、甚至互相类比；
 *     一对一次，它可以放心地对某一对说「不成立」——而那恰恰是这里最需要的判断。
 *   - **可失败**：一对失败只丢那一对。
 *   - **注意力**：prompt 里只有两篇的事实，判断质量明显更高。
 *   （和 lenses「一个维度一次调用」是同一个理由。）
 */
import type { LlmSettings } from '@shared/types'
import {
  LINK_TYPES,
  LINK_TYPE_HINT,
  LINK_TYPE_LABEL,
  type PaperLink,
  type PaperLinkType
} from '@shared/links'
import { chatCompletion, extractJson } from '../llm'

export const LINKS_SYSTEM = `你是论文关系判定员。
用户会给你两篇论文的要点，以及一串「它们共享的技术要素」——那串东西是知识图谱按共享的具体数据集 / 基准 / 模型 / 方法算出来的，不是随机配对，但**仍可能只是巧合**。
你的任务：判断这两篇之间是否真的存在一条**值得记录**的关系，并给出类型。

判定规则（按重要性排序）：
1. **不确定就判不成立**。共享点可能毫无意义（同名数据集但场景不同、「都用了 Transformer」这类没有信息量的共同点）。宁可漏，不要错——写进图里的每一条都会被当成你自己的判断。
2. 只允许使用给定材料。材料里没写的事不要推测，不要脑补实验数字、不要替作者下结论。
3. **必须能指着具体东西说话**（哪个共享要素、哪一方的哪个做法或结论）。给不出具体依据，就判不成立。
4. 类型只能从给定词表里选，且要选**最贴切的那一个**，不要一律用 related。
5. \`note\` 是人话的一句话（例如「它把对方的检索环节换成图检索，但没处理多跳场景」），不要写「高度相关」「有较强关联」这类空话。
6. 输出必须是合法 JSON 对象，不要代码块包裹，不要任何解释文字。`

/** 判断关系要用的是「它在解决什么、怎么做、卡在哪、能搬去哪」，与写作手法无关 */
const DIGEST_KEYS = ['核心问题与动机', '方法细节', '关键收获', '局限与未来工作', '可迁移到我的研究']

/** 每段截断长度：留够事实，又别让两篇加起来把注意力摊薄 */
const DIGEST_PER_SECTION = 700

export interface LinkPaperFact {
  title: string
  year: number | null
  venue?: string
  /** 索引里的一句话总结；没精读过时为空 */
  tldr: string
  /** 从精读笔记里挑出的关键段落（见 pickLinkDigest）；空表示这篇还没精读过 */
  digest: string
}

export interface LinkJudgeInput {
  /** 从哪一篇出发判断（关系是有方向的：本篇 → 候选） */
  from: LinkPaperFact
  to: LinkPaperFact
  /** 数据判定出的共享技术要素 */
  shared: string[]
  /** 两篇之间已有的关系，用来避免重复提议 */
  existing?: string[]
}

/**
 * 这个 agent 的判定结果。
 *
 * `ok: false` 是一等公民：允许（并且经常应该）说出「这两篇没关系」。
 */
export interface LinkVerdict {
  ok: boolean
  type?: PaperLinkType
  /** 一句话：它们是什么关系（人话） */
  note?: string
  /** 依据：必须指着具体东西 */
  evidence?: string
  /** 判不成立时的理由，只用于日志与调试，不落盘 */
  reason?: string
}

export function pickLinkDigest(sections: Record<string, string>): string {
  const parts: string[] = []
  for (const key of DIGEST_KEYS) {
    const text = (sections[key] ?? '').trim()
    // 空章节、或只剩模板占位（「- **要解决什么问题**：」）的，不喂给模型
    if (text.length < 20) continue
    parts.push(`【${key}】\n${clip(text, DIGEST_PER_SECTION)}`)
  }
  return parts.join('\n')
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（后略）`
}

function renderPaper(fact: LinkPaperFact, heading: string): string {
  const meta = [fact.year ? `${fact.year}` : '', fact.venue || ''].filter(Boolean).join(' · ')
  const tldr = fact.tldr ? `一句话总结：${fact.tldr}` : '一句话总结：（还没有，这篇可能没精读过）'
  const body = fact.digest
    ? fact.digest
    : '（这篇还没有精读笔记。只能依据标题与上面的共享要素判断，**不要臆测它的方法细节**；看不清就判不成立）'
  return `## ${heading}\n标题：${fact.title}${meta ? `\n发表：${meta}` : ''}\n${tldr}\n${body}`
}

export function buildLinkJudgePrompt(input: LinkJudgeInput): string {
  const types = LINK_TYPES.map(
    (t) => `- \`${t}\`（${LINK_TYPE_LABEL[t]}）：${LINK_TYPE_HINT[t]}`
  ).join('\n')

  const shared = input.shared.length
    ? input.shared.map((s) => `- ${s}`).join('\n')
    : '（空）'

  const existing = input.existing?.length
    ? input.existing.map((s) => `- ${s}`).join('\n')
    : '（无）'

  return `# 待判断的两篇论文

${renderPaper(input.from, '本篇（关系从它出发，「type」描述的是它与候选之间的关系）')}

${renderPaper(input.to, '候选论文')}

# 知识图谱判定出的「它们共享的技术要素」
${shared}

注意：这串共享要素只说明「值得看一看」，**不构成关系成立的证据**。请自己判断这些共享点是真有方法论含义，还是只是巧合。

# 已有的关系（不要重复提议同样的类型）
${existing}

# 关系类型词表（只能从这里选）
${types}

# 输出格式
关系成立时：
{"ok": true, "type": "builds-on", "note": "一句话人话", "evidence": "具体依据：哪个共享要素 / 哪一方的哪个做法或结论"}

关系不成立时：
{"ok": false, "reason": "为什么这些共享点不足以构成关系"}

只输出这个 JSON 对象本身。`
}

/**
 * 把模型输出收敛成判定结果。
 *
 * 两条刻意的严格：**类型不在词表里、或没给依据，一律当不成立** ——
 * 宁可少一条边，也不要往图里加一条说不清的线（那正是这张图以前没人看的原因）。
 */
export function normalizeVerdict(raw: unknown): LinkVerdict {
  const obj = (raw ?? {}) as Record<string, unknown>
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

  // 模型有时把字段写成 relation / related，两种都认
  const ok = obj.ok === true || obj.relation === true || obj.related === true
  const reason = text(obj.reason) || text(obj.why)
  if (!ok) return { ok: false, ...(reason ? { reason } : {}) }

  const typeText = text(obj.type)
  const type = (LINK_TYPES as string[]).includes(typeText) ? (typeText as PaperLinkType) : undefined
  const evidence = text(obj.evidence) || text(obj.basis)
  const note = text(obj.note)

  if (!type) return { ok: false, reason: reason || '没给出词表内的关系类型' }
  if (!evidence) return { ok: false, reason: reason || '没给出可追溯的依据' }

  return { ok: true, type, evidence, ...(note ? { note } : {}) }
}

/** 判定结果 → 一条待确认的提议；不成立 / 依据不足时返回 null */
export function verdictToLink(verdict: LinkVerdict, to: string, at: string): PaperLink | null {
  if (!verdict.ok || !verdict.type || !verdict.evidence) return null
  return {
    to,
    type: verdict.type,
    by: 'ai',
    at,
    evidence: verdict.evidence,
    ...(verdict.note ? { note: verdict.note } : {})
  }
}

export async function runLinkJudgeAgent(
  input: LinkJudgeInput,
  llm: LlmSettings,
  options: { signal?: AbortSignal } = {}
): Promise<LinkVerdict> {
  const res = await chatCompletion(
    [
      { role: 'system', content: LINKS_SYSTEM },
      { role: 'user', content: buildLinkJudgePrompt(input) }
    ],
    llm,
    // 判定类任务要稳：温度压到最低，否则同一对论文两次跑能给两个结论
    { temperature: 0.15, signal: options.signal }
  )
  return normalizeVerdict(extractJson(res.content))
}
