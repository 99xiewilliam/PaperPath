/**
 * 组合分析 agent：面对**一组**论文，判断它们之间有没有组合创新的空间，
 * 并给出（如果有）可验证的角度 + 「如果合成一篇论文会是什么样」。
 *
 * 与关系判定（agents/links.ts）的两个区别：
 *   - 一对一是判断「这两篇有没有关系」；这里是判断「这一组能不能长出新的东西」，
 *     所以**一次调用整组**：组合是整体性质，拆成对去看会丢掉「三篇凑一起」的可能。
 *   - 关系判定可以不成立；这里也可以 —— 而且经常应该。把几篇只是「都做这个方向」
 *     的论文凑在一起，本来就不该硬造出题目。
 *
 * 原料与线索都来自 shared/combo.ts（数据侧），这里只负责问模型要判断。
 */
import type { ComboAnalysis, ComboAngle, ComboComposite, ComboPaper, ComboRelation, ComboSignal } from '@shared/combo'
import { LINK_TYPE_LABEL } from '@shared/links'
import type { LlmSettings } from '@shared/types'
import { chatCompletion, extractJson } from '../llm'

export const COMBO_SYSTEM = `你是研究组合设计员。
用户会把一组论文（2-6 篇）连同它们各自的要点、组内已有的关系、以及一串**数据侧线索**交给你。
你要回答一个问题：把它们凑在一起，有没有组合创新的空间？如果有，具体是什么？

判定规则（按重要性排序）：
1. **允许说没有空间**。如果这几篇只是同一条赛道上的不同实现、差别只在细节，就直接给 space: "none" 并说明理由。硬造出来的题目比没有题目更糟。
2. **组合必须落到具体机制上**。不许出现「把 A 与 B 结合」「取长补短」「探索 X 在 Y 上的应用」这类句子 ——
   要写清谁提供什么、接到谁的哪个环节、替换掉什么。
3. 每个角度都必须能验证：\`minimalTest\` 要写用哪些数据集 / 基线 / 指标（**优先借用材料里出现过的**），
   \`falsify\` 要写清「出现什么结果就说明这个角度不成立」。缺任何一项就别给这个角度。
4. 只允许使用给定材料。不要编造数字、数据集、指标或论文结论；材料里没写的事不要提。
5. 数据侧线索**只说明值得看一眼**，不是创新空间的证据（例如「都用了 Transformer」显然不算）。你可以推翻它们。
6. 「组合论文分析」（composite）是可选的，但如果给，就必须指出**还缺什么才能成立**（missing 字段）—— 那一项通常比结论更有用。
7. 角度最多 3 个，宁可少而实。
8. 输出必须是合法 JSON 对象，不要代码块包裹，不要任何解释文字。`

/** 每段材料的截断长度 */
const CLIP = 500

export interface ComboPromptInput {
  papers: ComboPaper[]
  relations: ComboRelation[]
  signals: ComboSignal[]
}

export function buildComboPrompt(input: ComboPromptInput): string {
  const titleOf = (id: string): string =>
    input.papers.find((p) => p.id === id)?.title ?? id

  const papers = input.papers
    .map((paper, index) => `## 论文 ${index + 1}：${paper.title}（${paper.year ?? '年份未知'}）\n${facts(paper)}`)
    .join('\n\n')

  const relations = input.relations.length
    ? input.relations
        .map((r) => `- ${titleOf(r.from)} → ${titleOf(r.to)}：${LINK_TYPE_LABEL[r.type]}${r.note ? `（${r.note}）` : ''}`)
        .join('\n')
    : '（这一组之间还没有建立过任何关系 —— 没有关系也可以有组合空间，不要因此就判不成立）'

  const signals = input.signals.length
    ? input.signals.map((s) => `- ${s.text}`).join('\n')
    : '（没有算出结构性的线索）'

  return `# 要分析的一组论文（共 ${input.papers.length} 篇）

${papers}

# 组内已有的关系（用户自己建立的）
${relations}

# 数据侧线索（只说明值得看一眼，不是创新空间的证据）
${signals}

# 输出格式

四个顶层字段：space（"none" / "weak" / "promising"）、verdict（一句话总判断）、angles（角度数组，可为空）、composite（组合论文蓝图，可为空）。

有空间时：
{"space": "promising", "verdict": "一句话说清这组的组合空间在哪", "angles": [{"title": "题目（不超过 40 字）", "hypothesis": "一句可被证伪的判断", "why": "为什么值得做 / 与已有工作的差别", "from": ["用到的论文标题"], "minimalTest": "最小验证实验：数据集 / 基线 / 指标，怎么算成功", "falsify": "出现什么结果就说明这个角度不成立", "risk": "风险与前提（可选）"}], "composite": {"title": "合成后那篇论文的题目", "contribution": "核心贡献", "skeleton": "方法骨架：谁提供什么、接到哪", "experiments": "实验设计", "missing": "还缺什么才能成立"}}

没有空间 / 材料不足时：
{"space": "none", "verdict": "一句话总判断", "angles": [], "reason": "为什么凑不出东西（是同一赛道？还是笔记太空？）"}

只输出这个 JSON 对象本身。`
}

function facts(paper: ComboPaper): string {
  const blocks: string[] = []
  if (paper.tldr) blocks.push(`一句话总结：${paper.tldr}`)
  blocks.push(section('方法细节', paper.method))
  blocks.push(section('局限与未来工作（它自己承认没解决的）', paper.limitation))
  blocks.push(section('可迁移到我的研究', paper.transferable))

  const exp = paper.exp
  if (exp) {
    const parts = [
      exp.datasets?.length ? `数据集 ${exp.datasets.join('、')}` : '',
      exp.baselines?.length ? `基线 ${exp.baselines.join('、')}` : '',
      exp.metrics?.length ? `指标 ${exp.metrics.join('、')}` : '',
      exp.compute ? `算力 ${exp.compute}` : ''
    ].filter(Boolean)
    if (parts.length) blocks.push(`实验设置：${parts.join(' · ')}`)
  }

  const entities = (paper.entities ?? []).slice(0, 24).map((e) => e.name)
  if (entities.length) blocks.push(`涉及的技术要素：${entities.join('、')}`)

  return blocks.join('\n')
}

function section(label: string, text: string): string {
  const value = (text ?? '').trim()
  // 空章节明说「没写」：留白会让模型以为这里有默认信息，然后自己编
  return value.length < 20 ? `${label}：（没写，不要臆测）` : `${label}：${clip(value, CLIP)}`
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（后略）`
}

const SPACES = ['none', 'weak', 'promising'] as const

/**
 * 把模型输出收敛成组合分析。
 *
 * 两条本地兜底：
 *   - 角度缺任何一项（标题 / 假设 / 最小实验 / 反证）就丢掉那一条 —— 与「研究想法」同一把尺子；
 *   - 一个角度都没有、也没有组合论文蓝图时，整份降级成「没有组合空间」，
 *     免得界面上出现一份「有空间但什么都没说」的文档。
 */
export function normalizeCombo(raw: unknown): ComboAnalysis {
  const obj = (raw ?? {}) as Record<string, unknown>
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

  const verdict = text(obj.verdict) || text(obj.summary)
  const reason = text(obj.reason)
  const spaceText = text(obj.space)
  const space = (SPACES as readonly string[]).includes(spaceText)
    ? (spaceText as 'none' | 'weak' | 'promising')
    : undefined

  const angles = Array.isArray(obj.angles)
    ? obj.angles.map(normalizeAngle).filter((a): a is ComboAngle => a !== null)
    : []
  const composite = normalizeComposite(obj.composite)

  if (!angles.length && !composite) {
    return {
      ok: false,
      angles: [],
      ...(verdict ? { verdict } : {}),
      ...(space ? { space } : {}),
      reason: reason || '这一组没能给出可验证的角度，也没能给出组合后的论文蓝图'
    }
  }

  return {
    ok: true,
    angles,
    ...(verdict ? { verdict } : {}),
    ...(space ? { space } : {}),
    ...(composite ? { composite } : {})
  }
}

function normalizeAngle(raw: unknown): ComboAngle | null {
  const obj = (raw ?? {}) as Record<string, unknown>
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  const title = text(obj.title)
  const hypothesis = text(obj.hypothesis) || text(obj.claim)
  const minimalTest = text(obj.minimalTest) || text(obj.minimal_test) || text(obj.experiment)
  const falsify = text(obj.falsify) || text(obj.counter)
  if (!title || !hypothesis || !minimalTest || !falsify) return null

  const why = text(obj.why)
  const risk = text(obj.risk)
  const from = Array.isArray(obj.from)
    ? obj.from.map((v) => text(v)).filter(Boolean)
    : []
  return {
    title,
    hypothesis,
    why,
    from,
    minimalTest,
    falsify,
    ...(risk ? { risk } : {})
  }
}

function normalizeComposite(raw: unknown): ComboComposite | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  const title = text(obj.title)
  const contribution = text(obj.contribution)
  const skeleton = text(obj.skeleton) || text(obj.method)
  const experiments = text(obj.experiments)
  const missing = text(obj.missing)
  // 五项缺一不可：少了「还缺什么」，这段就只是一段漂亮的设想
  if (!title || !contribution || !skeleton || !experiments || !missing) return null
  return { title, contribution, skeleton, experiments, missing }
}

export async function runComboAgent(
  input: ComboPromptInput,
  llm: LlmSettings,
  options: { signal?: AbortSignal } = {}
): Promise<ComboAnalysis> {
  const res = await chatCompletion(
    [
      { role: 'system', content: COMBO_SYSTEM },
      { role: 'user', content: buildComboPrompt(input) }
    ],
    llm,
    // 与出题同一档：要一点想象力，但材料是给定的
    { temperature: 0.35, signal: options.signal }
  )
  return normalizeCombo(extractJson(res.content))
}
