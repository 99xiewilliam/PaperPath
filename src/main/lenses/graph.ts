import {
  ENTITY_KINDS,
  lensMeta,
  RELATION_TYPES,
  type EntityKind,
  type GraphEntity,
  type GraphRelation,
  type RelationType
} from '@shared/lenses'
import { jsonOnlyRule, paperHeader, sourceBlock, type Lens, type LensContext } from './types'

const SYSTEM = `你是一个知识图谱抽取器，从论文里抽出**实体**与**实体间关系**。
你的信条：
1. 实体只抽「可复用、可跨论文对齐」的技术对象：模型、数据集、基准、任务、方法、指标、技术、概念、机构。
   **不要抽**作者、章节名、泛泛的形容词，也不要抽荣誉与事件（Best Paper Award / Nobel Prize 这类）。
2. 名称要规范化：去掉版本后缀以外的修饰，保留通用写法（例如统一写 "LLaVA-1.5" 而不是 "our LLaVA-1.5 model"）。
3. **aliases 必须认真填**：同一事物在文中出现的其他写法（缩写、全称、不同大小写、带前缀的版本）都要列进去。
   构图时会用 aliases 把「同一个东西的几种写法」合并成一个节点 —— 漏填就等于凭空多出几个互相连不上的孤点，
   而跨论文连接正是这张图唯一的价值来源。
4. 关系必须能在原文里找到依据，evidence 写一句原文出处。
5. 只抽原文明确出现的，不要靠常识补全。
6. 输出必须是合法 JSON，不要代码块包裹。`

const KIND_SET = new Set<string>(ENTITY_KINDS)
const RELATION_SET = new Set<string>(RELATION_TYPES)

/**
 * 明显不是技术实体的东西：荣誉、奖项、事件。
 * 实测某篇讲「科学影响力预测」的论文把 "Best Paper Award"、"Nobel Prize"
 * 当成了概念实体塞进图里 —— 这类节点跟技术关联无关，只会稀释图谱。
 */
const NOISE_ENTITY =
  /(best paper|award|prize|medal|honou?r\b|nobel|turing award|fellowship|keynote|workshop chair)/i

function normalizeName(raw: string): string {
  return raw
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[。．.,;；]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export const graphLens: Lens = {
  id: 'graph',
  meta: lensMeta('graph'),
  system: SYSTEM,

  prompt(ctx: LensContext): string {
    return `# 任务
从下面这篇论文里抽取实体与关系，用于构建跨论文的知识图谱。
这张图的目标是：让用户能沿着「模型 —评测于→ 基准 —属于→ 任务」这类路径做多跳跳转，找到看似无关的论文之间的联系。

# 论文信息
${paperHeader(ctx)}

# 实体类型（kind 只能从这里选）
${ENTITY_KINDS.join(' | ')}

# 关系类型（type 只能从这里选）
${RELATION_TYPES.join(' | ')}

# 输出 JSON
{
  "entities": [
    { "name": "规范化名称", "kind": "上面列的类型之一", "aliases": ["别名或全称，可选"] }
  ],
  "relations": [
    {
      "from": "实体 name（必须是上面 entities 里出现过的）",
      "to": "实体 name（必须出现过）",
      "type": "上面列的关系类型之一",
      "evidence": "原文依据，一句话"
    }
  ]
}

# kind 判定规则（选错会让下游「领域标配」统计失真）
- model：具体的模型 / 权重（GPT-4o、Qwen2.5-7B、OpenVLA、π0.5）
- dataset：数据本身（DROID、Microsoft Academic Graph）
- benchmark：**用来评测的套件 / 榜单 / 测试集**（LIBERO、BEHAVIOR、RoboVoLo、CultureVerse）
- task：任务类型（robot manipulation、Block Stacking、object stowing）
- method：方法 / 框架 / 系统（CaP-X、ReKep、TAMP、code-as-policy）
- metric：评价指标（success rate、accuracy、recovery rate）
- technique：可复用的技术手段（GRPO、RLVR、visual differencing、LoRA）
- concept：抽象概念（vision-language-action、closed-loop、failure recovery）
- org：机构（OpenAI、Anthropic、NVIDIA）
- 数据集和 benchmark 分不清时：「本文拿来测自己的」记 benchmark，「本文用来训练/微调的数据」记 dataset。

# 硬性要求
- entities 控制在 10-25 个。宁可少而准，不要多而杂。
- 必须包含本文自己提出的模型 / 方法（用原名称）。
- relations 控制在 10-30 条，from / to 必须都能在 entities 里找到。
- 不要抽作者名、不要抽「Figure 3」这类指代、不要抽通用词（如 "performance"、"method"）。
- evidence 必须是原文里真实出现的依据描述。
- **aliases 尽量填满**。例：
  · name "Vision-Language-Action" → aliases ["VLA"]
  · name "GRPO" → aliases ["Group Relative Policy Optimization"]
  · name "π0.5" → aliases ["pi0.5"]（希腊字母与拉丁拼写的差异一定要收）
  · name "Visual Differencing Module" → aliases ["VDM"]

${jsonOnlyRule()}

# 论文正文
${sourceBlock(ctx, ['Abstract', 'Introduction', 'Method', 'Experiments', 'Analysis'])}`
  },

  parse(payload) {
    const root = (payload ?? {}) as Record<string, unknown>

    const entities: GraphEntity[] = []
    const seen = new Set<string>()
    for (const item of Array.isArray(root.entities) ? root.entities : []) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const name = normalizeName(String(row.name ?? ''))
      if (!name || name.length > 70) continue
      if (NOISE_ENTITY.test(name)) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)

      const kind = String(row.kind ?? '').trim().toLowerCase()
      // 别名也过一遍清洗：既去掉噪音，也避免别名里的空串混进合并索引
      const aliases = Array.isArray(row.aliases)
        ? row.aliases
            .map((a) => normalizeName(String(a)))
            .filter((a) => a && a.length <= 70 && !NOISE_ENTITY.test(a) && a.toLowerCase() !== key)
            .slice(0, 6)
        : []
      entities.push({
        name,
        kind: (KIND_SET.has(kind) ? kind : 'concept') as EntityKind,
        aliases: aliases.length ? aliases : undefined
      })
      if (entities.length >= 30) break
    }

    const names = new Set(entities.map((e) => e.name.toLowerCase()))
    const relations: GraphRelation[] = []
    const relSeen = new Set<string>()
    for (const item of Array.isArray(root.relations) ? root.relations : []) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const from = normalizeName(String(row.from ?? ''))
      const to = normalizeName(String(row.to ?? ''))
      if (!from || !to || from === to) continue
      // 关系两端必须是我们收下的实体，避免图里出现孤儿节点
      if (!names.has(from.toLowerCase()) || !names.has(to.toLowerCase())) continue

      const type = String(row.type ?? '').trim().toLowerCase()
      if (!RELATION_SET.has(type)) continue

      const key = `${from}|${type}|${to}`.toLowerCase()
      if (relSeen.has(key)) continue
      relSeen.add(key)

      relations.push({
        from,
        to,
        type: type as RelationType,
        evidence: String(row.evidence ?? '').trim() || undefined
      })
      if (relations.length >= 60) break
    }

    return {
      data: {
        graph: {
          entities,
          relations,
          extractedAt: new Date().toISOString()
        }
      },
      summary: `抽取 ${entities.length} 个实体、${relations.length} 条关系`
    }
  }
}
