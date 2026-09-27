/**
 * 研究想法 agent：把一个「组合单元」（已确认的关系 + 两篇的具体原料）写成一个
 * **可被实验检验**的题目。
 *
 * 这个 agent 存在的意义是抵抗「听起来很美」：只要允许自由发挥，模型永远能写出
 * 「探索 A 与 B 的结合」这种句子 —— 它不可验证、不可反证，读起来还很有道理。
 * 所以这里把输出钉成四项：假设、最小验证实验、反证条件、（可选的）风险与前提。
 * **写不出反证条件的，一律判不成立**，并说明缺什么。
 *
 * 原料与判定同样分开（见 shared/ideas.ts）：关系是不是你确认的、两篇写了什么，
 * 都是数据侧的事；这里只负责问模型「能不能做成题」。
 */
import type { Idea, IdeaSeed, IdeaSeedPaper } from '@shared/ideas'
import { LINK_TYPE_HINT, LINK_TYPE_LABEL } from '@shared/links'
import type { LlmSettings } from '@shared/types'
import { chatCompletion, extractJson } from '../llm'

export const IDEAS_SYSTEM = `你是研究题目设计员。
用户会给你一条他自己确认过的两篇论文之间的关系，以及两篇论文的具体材料（方法、局限、可迁移点、实验设置）。
你的任务：把这条关系变成一个**可被实验检验**的研究题目。

判定规则（按重要性排序）：
1. **无法反证的方向不是题目，是愿望**。写不出「出现什么结果说明这个想法错了」，就判不成立（ok: false），并在 reason 里说清缺什么。
2. 只允许使用给定材料。不要编造数字、数据集、指标或论文结论；材料里没说的事就不要提。
3. 题目要具体到能看懂怎么做，不要停在抽象层面：
   - 不要「探索 A 与 B 的结合」「提升效率与效果的平衡」；
   - 要「把 A 的某种机制接到 B 的某个环节，在 B 的实验设置上验证」。
4. \`minimalTest\` 必须**用得上材料里出现过的数据集 / 基线 / 指标**（一个都借不上时，说明如何构造一个小规模子集，并讲清为什么这么构造仍能说明问题）。
5. \`falsify\` 必须写清「出现什么结果说明这个想法错了」，不能写「效果不好」「不显著」这种没有阈值的话。
6. \`hypothesis\` 是一句**可被证伪的判断**（有方向、有对象），不是一句介绍。
7. 如果这些材料只够你写出一句正确的废话，就判不成立，不要硬凑。
8. 输出必须是合法 JSON 对象，不要代码块包裹，不要任何解释文字。`

/** 每段材料的截断长度：够判断，又别把两篇的噪音全塞进去 */
const CLIP = 600

export function buildIdeaPrompt(seed: IdeaSeed): string {
  const relations = seed.relations
    .map((r) => {
      const arrow =
        r.direction === 'out'
          ? `论文 A → 论文 B`
          : `论文 B → 论文 A`
      const note = r.note ? `（他写下的理由：${r.note}）` : ''
      return `- ${arrow}：${LINK_TYPE_LABEL[r.type]} —— ${LINK_TYPE_HINT[r.type]}${note}`
    })
    .join('\n')

  return `# 起点：用户确认过的一条论文关系
${relations}

# 论文 A：${paperHead(seed.from)}

${facts(seed.from)}

# 论文 B：${paperHead(seed.to)}

${facts(seed.to)}

# 输出格式

四个字段缺一不可：title（题目）、hypothesis（假设）、minimalTest（最小验证实验）、
falsify（反证条件：出现什么结果就说明这个想法错了）。缺任何一个都必须返回 ok: false，不要用「效果不好」之类的话来占位。

能做成题目时：
{"ok": true, "title": "题目（不超过 40 字，写成一句能做的东西，不要问句）", "hypothesis": "一句可被证伪的判断", "why": "为什么值得做 / 与已有工作的差别", "minimalTest": "最小验证实验：用哪些数据集 / 基线 / 指标，怎么算成功", "falsify": "出现什么结果就说明这个想法错了", "risk": "风险与前提（可选）"}

撑不起题目时：
{"ok": false, "reason": "缺什么：例如「B 的局限一节是空的，看不出要解决什么」"}

只输出这个 JSON 对象本身。`
}

function paperHead(paper: IdeaSeedPaper): string {
  return `${paper.title}（${paper.year ?? '年份未知'}）`
}

function facts(paper: IdeaSeedPaper): string {
  const blocks: string[] = []
  if (paper.tldr) blocks.push(`一句话总结：${paper.tldr}`)
  blocks.push(section('方法细节', paper.method))
  blocks.push(section('局限与未来工作（它自己承认没解决的）', paper.limitation))
  blocks.push(section('可迁移到我的研究', paper.transferable))

  const exp = experimentBlock(paper)
  if (exp) blocks.push(exp)

  return blocks.filter(Boolean).join('\n')
}

function section(label: string, text: string): string {
  const value = (text ?? '').trim()
  // 空章节明说「没写」，而不是留白 —— 留白会让模型以为这里默认有信息，然后自己编
  return value.length < 20 ? `${label}：（没写，不要臆测）` : `${label}：${clip(value, CLIP)}`
}

function experimentBlock(paper: IdeaSeedPaper): string {
  const exp = paper.exp
  if (!exp) return ''
  const parts = [
    exp.datasets?.length ? `数据集 ${exp.datasets.join('、')}` : '',
    exp.baselines?.length ? `基线 ${exp.baselines.join('、')}` : '',
    exp.metrics?.length ? `指标 ${exp.metrics.join('、')}` : '',
    exp.compute ? `算力 ${exp.compute}` : '',
    exp.runs ? `重复 ${exp.runs}` : ''
  ].filter(Boolean)
  return parts.length ? `实验设置（可直接借用）：${parts.join(' · ')}` : ''
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（后略）`
}

/**
 * 把模型输出收敛成一条想法。
 *
 * 四个必需项（标题 / 假设 / 最小验证实验 / 反证条件）缺一个就当不成立：
 * 缺任何一项，它都只是个方向而不是题目，而「方向」正是这个功能要对抗的东西。
 */
export function normalizeIdea(raw: unknown): Idea {
  const obj = (raw ?? {}) as Record<string, unknown>
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

  const ok = obj.ok === true
  const reason = text(obj.reason) || text(obj.whyNot)
  if (!ok) return { ok: false, ...(reason ? { reason } : {}) }

  // 字段名容错：模型偶尔会换写法（最小实验 / 反例）
  const title = text(obj.title) || text(obj.idea)
  const hypothesis = text(obj.hypothesis) || text(obj.claim)
  const minimalTest = text(obj.minimalTest) || text(obj.minimal_test) || text(obj.experiment)
  const falsify = text(obj.falsify) || text(obj.falsification) || text(obj.counter)

  const missing: string[] = []
  if (!title) missing.push('标题')
  if (!hypothesis) missing.push('假设')
  if (!minimalTest) missing.push('最小验证实验')
  if (!falsify) missing.push('反证条件')
  if (missing.length) {
    return { ok: false, reason: reason || `没给出：${missing.join('、')}` }
  }

  const why = text(obj.why)
  const risk = text(obj.risk)
  return {
    ok: true,
    title,
    hypothesis,
    minimalTest,
    falsify,
    ...(why ? { why } : {}),
    ...(risk ? { risk } : {})
  }
}

export async function runIdeaAgent(
  seed: IdeaSeed,
  llm: LlmSettings,
  options: { signal?: AbortSignal } = {}
): Promise<Idea> {
  const res = await chatCompletion(
    [
      { role: 'system', content: IDEAS_SYSTEM },
      { role: 'user', content: buildIdeaPrompt(seed) }
    ],
    llm,
    // 出题需要一点想象力，但材料是给定的 —— 温度略高于判定，低于写作
    { temperature: 0.35, signal: options.signal }
  )
  return normalizeIdea(extractJson(res.content))
}
