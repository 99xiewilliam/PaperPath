import type { TaxonomyNode } from './types'

/**
 * 内置的细粒度分类体系。
 * 设计原则：按「读这篇论文时我关心什么」来分，而不是按会议/年份分。
 *
 * 色板取向：旧书装帧布 / 矿物颜料的低饱和色（褪色普蓝、苔绿、赭石、茜红）。
 * 高饱和的原色（翡翠绿、亮橙）在深色界面里会变成「糖果豆」，压一档饱和度
 * 之后整屏的分类 chip 才能沉下来。
 */
export const BUILTIN_CATEGORIES: TaxonomyNode[] = [
  // ── 评测与数据 ──────────────────────────────────────────────
  {
    id: 'benchmark',
    label: 'Benchmark 评测基准',
    group: '评测与数据',
    description: '提出新任务/新评测集，定义怎么衡量能力',
    hint: '提出新的 benchmark、评测套件、任务集合，核心贡献是「怎么考」',
    color: '#7D9FC9',
    builtin: true
  },
  {
    id: 'dataset',
    label: 'Dataset 数据集构建',
    group: '评测与数据',
    description: '数据采集、标注流程、质量控制的论文',
    hint: '核心贡献是数据本身：采集 pipeline、标注规范、数据统计与质量分析',
    color: '#6FA3BE',
    builtin: true
  },
  {
    id: 'evaluation',
    label: 'Evaluation 评估方法',
    group: '评测与数据',
    description: '研究怎么评、用什么指标、LLM-as-judge 等',
    hint: '不提供数据，而是研究评估协议本身：指标设计、LLM-as-judge、评估偏差分析',
    color: '#6BA8B5',
    builtin: true
  },
  {
    id: 'analysis',
    label: 'Analysis 实证分析',
    group: '评测与数据',
    description: '对已有模型/现象做系统性实证研究',
    hint: '通过大规模受控实验给出对现象的解释，没有提出新方法',
    color: '#6BA593',
    builtin: true
  },

  // ── RAG 与检索 ─────────────────────────────────────────────
  {
    id: 'rag-method',
    label: 'RAG 方法',
    group: 'RAG 与检索',
    description: '检索增强生成的 pipeline / 框架 / 组件改进',
    hint: '检索增强生成：pipeline 设计、query 改写、rerank、多跳检索、长文档 RAG',
    color: '#8F8AC2',
    builtin: true
  },
  {
    id: 'retrieval',
    label: 'Retrieval 检索与表征',
    group: 'RAG 与检索',
    description: '向量检索、稠密/稀疏表征、embedding 训练',
    hint: '检索模型本身：embedding 训练、对比学习、稀疏/稠密检索、索引结构',
    color: '#A192C0',
    builtin: true
  },
  {
    id: 'knowledge',
    label: 'Knowledge 知识组织',
    group: 'RAG 与检索',
    description: '知识图谱、结构化知识、长上下文记忆',
    hint: '知识的组织与表示：KG、memory、长上下文管理、知识注入',
    color: '#AF93C6',
    builtin: true
  },

  // ── 方法与算法 ─────────────────────────────────────────────
  {
    id: 'llm-method',
    label: 'LLM 通用方法',
    group: '方法与算法',
    description: '不属于特定方向的基础方法改进',
    hint: '语言模型层面的通用方法：架构、注意力、解码、prompting 等',
    color: '#7B7FBA',
    builtin: true
  },
  {
    id: 'agent',
    label: 'Agent 智能体',
    group: '方法与算法',
    description: '规划、工具调用、多智能体协作',
    hint: '智能体：任务规划、工具使用、多智能体协作、环境交互',
    color: '#927FC0',
    builtin: true
  },
  {
    id: 'reasoning',
    label: 'Reasoning 推理',
    group: '方法与算法',
    description: 'CoT、测试时计算、自反思',
    hint: '推理能力：思维链、测试时扩展、自我验证、形式化推理',
    color: '#C08BA4',
    builtin: true
  },
  {
    id: 'training',
    label: 'Training 训练与对齐',
    group: '方法与算法',
    description: '预训练、SFT、RLHF/DPO、数据配比',
    hint: '训练范式：预训练、指令微调、偏好对齐、数据配方、scaling law',
    color: '#C4878D',
    builtin: true
  },
  {
    id: 'efficiency',
    label: 'Efficiency 效率优化',
    group: '方法与算法',
    description: '推理加速、量化、稀疏、长上下文效率',
    hint: '效率：推理加速、量化、剪枝、KV cache、显存与吞吐优化',
    color: '#BCA166',
    builtin: true
  },

  // ── 具身智能 ───────────────────────────────────────────────
  {
    id: 'embodied-ai',
    label: '具身智能 / VLA',
    group: '具身智能',
    description: '视觉-语言-动作模型、通用机器人策略',
    hint: 'Vision-Language-Action 模型、通用机器人基础模型、指令跟随操作',
    color: '#6FAF8D',
    builtin: true
  },
  {
    id: 'robot-policy',
    label: 'Robot Policy 策略学习',
    group: '具身智能',
    description: '模仿学习、强化学习策略、动作表示',
    hint: '机器人策略学习：模仿学习、RL、扩散策略、动作空间与表示设计',
    color: '#5F9E7E',
    builtin: true
  },
  {
    id: 'sim2real',
    label: 'Sim2Real 与真机部署',
    group: '具身智能',
    description: '仿真到真机迁移、真实世界实验',
    hint: '仿真训练到真机部署、域随机化、真实机器人实验与系统集成',
    color: '#4E8F72',
    builtin: true
  },
  {
    id: 'embodied-benchmark',
    label: 'Embodied Benchmark',
    group: '具身智能',
    description: '具身任务的仿真环境与评测协议',
    hint: '具身智能的仿真环境、任务套件、真机评测协议',
    color: '#578E85',
    builtin: true
  },

  // ── 多模态 ─────────────────────────────────────────────────
  {
    id: 'multimodal',
    label: 'Multimodal / VLM',
    group: '多模态',
    description: '视觉语言模型、跨模态对齐',
    hint: '视觉语言模型、多模态对齐、图文理解与生成',
    color: '#C49364',
    builtin: true
  },
  {
    id: 'video',
    label: 'Video 视频理解与生成',
    group: '多模态',
    description: '视频理解、时序建模、视频生成',
    hint: '视频相关：时序理解、长视频、视频生成与编辑',
    color: '#B97F55',
    builtin: true
  },

  // ── 其他 ───────────────────────────────────────────────────
  {
    id: 'survey',
    label: 'Survey 综述',
    group: '其他',
    description: '领域综述与 taxonomy 梳理',
    hint: '综述论文，重点看它怎么组织领域、怎么划分类别',
    color: '#8D9199',
    builtin: true
  },
  {
    id: 'application',
    label: 'Application 应用系统',
    group: '其他',
    description: '面向具体场景的系统与产品化工作',
    hint: '面向具体领域/场景的应用系统，侧重工程落地',
    color: '#9B9A98',
    builtin: true
  },
  {
    id: 'position',
    label: 'Position / 观点',
    group: '其他',
    description: '立场性、展望性论文',
    hint: '立场论文、open problem、roadmap，重在观点和叙事',
    color: '#8F8D8A',
    builtin: true
  }
]

/** 内置分类分组顺序 */
export const CATEGORY_GROUP_ORDER = [
  '评测与数据',
  'RAG 与检索',
  '方法与算法',
  '具身智能',
  '多模态',
  '其他',
  '自定义'
]

export function allCategories(custom: TaxonomyNode[] = []): TaxonomyNode[] {
  return [...BUILTIN_CATEGORIES, ...custom]
}

export function findCategory(id: string, custom: TaxonomyNode[] = []): TaxonomyNode | undefined {
  return allCategories(custom).find((c) => c.id === id)
}

export function categoryLabel(id: string, custom: TaxonomyNode[] = []): string {
  return findCategory(id, custom)?.label ?? id
}

export function categoryColor(id: string, custom: TaxonomyNode[] = []): string {
  return findCategory(id, custom)?.color ?? '#7A766D'
}

export function groupCategories(
  nodes: TaxonomyNode[]
): { group: string; items: TaxonomyNode[] }[] {
  const map = new Map<string, TaxonomyNode[]>()
  for (const node of nodes) {
    const key = node.builtin ? node.group : '自定义'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(node)
  }
  return [...map.entries()]
    .sort((a, b) => {
      const ia = CATEGORY_GROUP_ORDER.indexOf(a[0])
      const ib = CATEGORY_GROUP_ORDER.indexOf(b[0])
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
    .map(([group, items]) => ({ group, items }))
}
