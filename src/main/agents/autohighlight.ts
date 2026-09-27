/**
 * AI 自动标重点 agent。
 *
 * 给初学者的功能：他们自己读全文又慢又抓不住重点，所以让模型把
 * 「读这篇论文最不该跳过的句子」直接标在原文版面上。
 *
 * 关键设计：模型**不返回原文文本**，只返回行号区间。位置用行号回查，
 * 标的位置永远是真的 —— 不存在「编了一句原文里不存在的话还标错页」的幻觉。
 *
 * 按内容类型拆成 4 个专家（问题动机 / 核心方法 / 实验与结果 / 结论与局限），
 * 各喂各的章节、各有配额、并发跑：
 * - 更短的行列表 → 模型引用行号更准（行号错一位整条丢，短列表就是少丢）；
 * - 每类有自己的选重点标准，不用在一个 prompt 里权衡四种价值观；
 * - 单个专家失败不影响其余三类（部分成功也是一次可用的标注）；
 * - 各喂各的章节，总投喂量和单 agent 全文基本持平，成本近似不变。
 *
 * 章节归类、行段分配、区间校验与合并等纯函数在 @shared/autohighlight
 * （smoke:parse 守着），这里只持有 prompt 和模型调用。
 */
import {
  AGENT_KINDS,
  assignLinesByKind,
  clipLinesForBudget,
  mergeSpans,
  normalizeAutoHighlights,
  normalizeSpans,
  spansToPicks,
  type AgentKind,
  type AutoHighlightPick,
  type AutoHighlightSpan,
  type SourceLine
} from '@shared/autohighlight'
import type { LlmSettings } from '@shared/types'
import { chatCompletion, extractJson } from '../llm'

export const AUTO_HIGHLIGHT_SYSTEM = `你是一位带科研初学者读论文的助教。
用户会给你一篇论文按行编号的全文文本，格式是「[行号|p页码] 文本」。
请挑出初学者读这篇论文时**最不该跳过**的行区间，直接标在原文上。

选重点的标准（按价值排序）：
1. 研究问题与动机：要解决什么、为什么现有方法不够
2. 核心方法：方法的关键设计、和已有工作的本质区别
3. 关键实验与结果：主要对比、说明哪个设计重要的消融
4. 结论与局限：作者自己承认的边界

规则：
- 总量 12~24 个区间，宁缺毋滥 —— 标得太多等于没标
- 每个区间 1~6 行，粒度是「一句话或一个完整论点」，不要整段整段地标
- 跳过：参考文献、致谢、作者与机构信息、页眉页脚、纯过渡句
- 每个区间配一句中文「为什么这是重点」，向初学者说清它在论证里的作用，不要复述原文
- 只输出一个合法 JSON 对象，不要输出任何解释文字：
  {"spans":[{"from": 起始行号, "to": 结束行号, "kind": "problem|method|experiment|result|conclusion", "why": "..."}]}
- 行号是闭区间且 from <= to，必须来自输入里真实出现过的行号
- 论文实在没有值得标注的内容（比如只有参考文献），返回 {"spans":[]}`

export function buildAutoHighlightUser(title: string, lines: SourceLine[]): string {
  const body = lines.map((l) => `[${l.id}|p${l.page}] ${l.text}`).join('\n')
  return `# 论文标题\n${title}\n\n# 按行编号的全文\n${body}`
}

/* ------------------------------------------------------------------ */
/*  按类型拆分的专家 prompt                                              */
/* ------------------------------------------------------------------ */

interface KindSpec {
  label: string
  /** 该专家可输出的 kind 枚举片段（拼进 JSON 约束里） */
  kinds: string
  /** 配额：四类上限之和 23 ≤ 24（MAX_PICKS），不会互相挤爆总量 */
  count: string
  focus: string
}

export const KIND_SPECS: Record<AgentKind, KindSpec> = {
  problem: {
    label: '问题动机',
    kinds: '"problem"',
    count: '3~5 个',
    focus: [
      '- 研究要解决什么问题、为什么它重要',
      '- 现有方法差在哪（痛点 / 缺口的原句）',
      '- 任务定义、核心假设或主要贡献的宣告'
    ].join('\n')
  },
  method: {
    label: '核心方法',
    kinds: '"method"',
    count: '4~6 个',
    focus: [
      '- 方法的关键设计与核心思想',
      '- 各组件怎么协作（数据 / 模型 / 训练或推理流程里的枢纽步骤）',
      '- 和已有工作的本质区别、作者为什么这么设计'
    ].join('\n')
  },
  experiment: {
    label: '实验与结果',
    kinds: '"experiment" 或 "result"',
    count: '6~8 个',
    focus: [
      '- 主对比结果：和哪个基线比、在什么条件下赢了多少',
      '- 消融：说明哪个设计是必要的',
      '- 关键数字所在的结论句（headline 结果用 "result"，实验设置用 "experiment"）'
    ].join('\n')
  },
  conclusion: {
    label: '结论与局限',
    kinds: '"conclusion"',
    count: '3~4 个',
    focus: [
      '- 作者自己承认的局限与适用边界',
      '- 未来工作方向',
      '- 全文的总结论（只在它真的在总结时才标）'
    ].join('\n')
  }
}

/** 导出给 smoke:parse：四个专家各自单独调模型，JSON 约束不能只钉在总 prompt 上 */
export function kindSystem(kind: AgentKind): string {
  const spec = KIND_SPECS[kind]
  return `你是一位带科研初学者读论文的助教，只负责「${spec.label}」这一类重点。
用户会给你这篇论文中与「${spec.label}」相关的章节文本，每行格式是「[行号|p页码] 文本」。
行号可能不连续 —— 中间是别的章节，不在你的职责内；绝不要引用输入里没出现过的行号。

选「${spec.label}」的标准：
${spec.focus}

规则：
- 总量 ${spec.count} 区间，宁缺毋滥 —— 标得太多等于没标
- 每个区间 1~6 行，粒度是「一句话或一个完整论点」，不要整段整段地标
- 跳过：参考文献、致谢、作者与机构信息、页眉页脚、纯过渡句
- 每个区间配一句中文「为什么这是重点」，向初学者说清它在论证里的作用，不要复述原文
- 只输出一个合法 JSON 对象，不要输出任何解释文字：
  {"spans":[{"from": 起始行号, "to": 结束行号, "kind": ${spec.kinds}, "why": "..."}]}
- 行号是闭区间且 from <= to，必须来自输入里真实出现过的行号
- 给你的文本里实在没有值得标注的内容，返回 {"spans":[]}`
}

/* ------------------------------------------------------------------ */
/*  模型调用                                                            */
/* ------------------------------------------------------------------ */

export interface AutoHighlightAgentResult {
  picks: AutoHighlightPick[]
  /** 输入超预算被从尾部截断（末尾通常是参考文献，损失最小） */
  truncated: boolean
}

/**
 * 跑一遍标重点。没有可用文本（扫描件）时返回 undefined；
 * 模型一个区间都没挑出来时 picks 为空数组 —— 两者由调用方分别给出提示，
 * 并且都不允许覆盖已有标注。
 */
export async function runAutoHighlightAgent(
  input: { title: string; lines: SourceLine[] },
  llm: LlmSettings,
  options: { signal?: AbortSignal } = {}
): Promise<AutoHighlightAgentResult | undefined> {
  // 行数据过一遍编号与预算：超长论文从尾部截（末尾一般是参考文献，损失最小）
  const lines = input.lines
    .filter((l) => l && typeof l.text === 'string' && l.text.trim())
    .map((l, i) => ({ ...l, id: i, text: l.text.trim() }))
  if (!lines.length) return undefined
  const clipped = clipLinesForBudget(lines)

  const res = await chatCompletion(
    [
      { role: 'system', content: AUTO_HIGHLIGHT_SYSTEM },
      { role: 'user', content: buildAutoHighlightUser(input.title, clipped.lines) }
    ],
    llm,
    { temperature: 0.2, signal: options.signal }
  )

  return {
    picks: normalizeAutoHighlights(extractJson(res.content), clipped.lines),
    truncated: clipped.truncated
  }
}

export interface AutoHighlightAgentsResult extends AutoHighlightAgentResult {
  /** 章节结构没认出来，退回了单 agent 全文 */
  fallbackSingle: boolean
  /** 部分专家失败的类型标签（全失败会直接抛错，不会走到这） */
  failedKinds: string[]
}

/**
 * 按类型拆分跑标重点：4 个专家并发，各拿各的章节行段（全局行号），
 * 区间校验后合并去重再统一拆页。部分专家失败时用幸存者的结果继续 ——
 * 少一两类的重点好过一次报错；全部失败 / 用户取消则抛出原始错误。
 */
export async function runAutoHighlightAgents(
  input: { title: string; lines: SourceLine[]; headingTitles: string[] },
  llm: LlmSettings,
  options: { signal?: AbortSignal } = {}
): Promise<AutoHighlightAgentsResult | undefined> {
  const lines = input.lines
    .filter((l) => l && typeof l.text === 'string' && l.text.trim())
    .map((l) => ({ ...l, text: l.text.trim() }))
  if (!lines.length) return undefined

  const plan = assignLinesByKind(lines, input.headingTitles)
  if (plan.fallback) {
    // 章节结构没认出来（扫描件 / 诡异排版）→ 退回单 agent 全文，
    // 走原有路径（含它的行号重排与预算截断）
    const single = await runAutoHighlightAgent({ title: input.title, lines: input.lines }, llm, options)
    return single ? { ...single, fallbackSingle: true, failedKinds: [] } : undefined
  }

  const active = AGENT_KINDS.filter((kind) => (plan.byKind[kind]?.length ?? 0) > 0)
  const settled = await Promise.allSettled(
    active.map((kind) => {
      // 各专家独立截预算：全局行号原样保留（不重排），跨章节引用的行号
      // 会在 normalizeSpans 的 byId 查不到而整条丢弃 —— 宁可少标不可错标
      const clipped = clipLinesForBudget(plan.byKind[kind]!)
      return chatCompletion(
        [
          { role: 'system', content: kindSystem(kind) },
          { role: 'user', content: buildAutoHighlightUser(input.title, clipped.lines) }
        ],
        llm,
        { temperature: 0.2, signal: options.signal }
      ).then((res) => ({
        spans: normalizeSpans(extractJson(res.content), clipped.lines),
        truncated: clipped.truncated
      }))
    })
  )

  const spans: AutoHighlightSpan[] = []
  const failedKinds: string[] = []
  let truncated = false
  let firstError: unknown
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      spans.push(...result.value.spans)
      truncated = truncated || result.value.truncated
    } else {
      if (firstError === undefined) firstError = result.reason
      failedKinds.push(KIND_SPECS[active[i]].label)
    }
  })

  // 全失败，或取消之后只剩残缺结果：把原始错误抛出去，让调用方如实报告
  if (failedKinds.length === active.length || (options.signal?.aborted && firstError !== undefined)) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError))
  }

  return {
    picks: spansToPicks(mergeSpans(spans), lines),
    truncated,
    fallbackSingle: false,
    failedKinds
  }
}
