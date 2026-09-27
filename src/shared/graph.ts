/**
 * 跨论文知识图谱的数据契约（主进程构建，渲染层只负责画）。
 *
 * 图里有两类节点：
 *   - paper 节点：一篇论文
 *   - entity 节点：论文里出现过的实体（模型 / 数据集 / 基准 / 任务 / 方法 …）
 *
 * 边有三类语义：
 *   - mentions：论文涉及该实体（paper → entity）
 *   - 抽取出的语义关系：实体 → 实体（trained-on / compares-with / …）
 *
 * 这样「论文A → 共享实体 → 论文B」就是一条 2 跳路径，
 * 也就是用户最想看到的「这两篇看似无关的论文为什么相关」。
 */
import type { EntityKind, RelationType } from './lenses'
import type { PaperLinkType } from './links'

export type PaperNodeKind = 'paper'
export type GraphNodeKind = EntityKind | PaperNodeKind

export interface GraphNode {
  id: string
  name: string
  kind: GraphNodeKind
  /** 涉及该节点的论文数（paper 节点恒为 1） */
  paperCount: number
  /** paper 节点专属 */
  paperId?: string
  year?: number | null
  categories?: string[]
  /** 该实体在库中出现的次数（同一个实体被多篇论文提到时会累加） */
  mentions?: number
}

/**
 * 边分两层，显式标出来而不是靠 `type` 取值去猜：
 *   - `entity`：从论文里抽出来的（论文→实体 `mentions`、实体→实体语义关系）
 *   - `paper` ：**你建立的**论文↔论文关系（见 shared/links.ts），可能带 note 与出处
 *
 * 两层的配色、线宽、弹簧参数都不一样，而 `type` 是两套词表拼起来的
 *（RelationType ∪ PaperLinkType），所以需要一个独立字段。
 * 缺省按 `entity` 处理 —— 加这个字段之前的所有边都是实体边。
 */
export type GraphEdgeLayer = 'entity' | 'paper'

export interface GraphEdge {
  id: string
  from: string
  to: string
  type: RelationType | 'mentions' | PaperLinkType
  layer?: GraphEdgeLayer
  /** 来自哪篇论文（mentions 边就是论文自己；paper 边是发起方那篇） */
  paperId: string
  /** 实体边是抽取依据；paper 边是你写的那句「为什么有关」/ AI 给的依据 */
  evidence?: string
  /** paper 边专属：谁建立的（AI 提议在图上要能一眼认出来） */
  by?: 'user' | 'ai'
}

export interface GraphStats {
  /** 参与构图的论文数（有图谱数据的） */
  papers: number
  /** 论文总数（用于提示还有多少篇没抽图谱） */
  totalPapers: number
  /** 当前筛选后画出来的实体数 */
  entities: number
  relations: number
  /** 只被一篇论文提到的实体数——图变乱的主要来源 */
  singletons: number
  /** 全部实体数（不受 minPapers 影响），用于自动选粒度 */
  totalEntities: number
  /** 跨 ≥2 篇论文的实体数——这才是图的骨架 */
  multiPaperEntities: number
  /**
   * 库里一共有多少条论文关系（**不受当前筛选影响**）。
   *
   * 有了它，界面才能区分「一篇都没连过」和「连过、但被当前分类/筛选挡掉了」——
   * 这两种情况都表现为空画布，提示语却完全不同。
   */
  links: number
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: GraphStats
}

/**
 * 空统计。主进程（库没打开时）和渲染层（初始状态）都要构造它，
 * 放一处就不会在加字段时漏改另一边 —— 这类漂移已经咬过一次了。
 */
export const EMPTY_GRAPH_STATS: GraphStats = {
  papers: 0,
  totalPapers: 0,
  entities: 0,
  relations: 0,
  singletons: 0,
  totalEntities: 0,
  multiPaperEntities: 0,
  links: 0
}

/**
 * 图谱的两套读法：
 *   - `relations`：只看论文↔论文的关系。节点就是论文，边是你建立（或采纳）的关系 ——
 *     这是默认视图，回答的是「我读的这些论文之间发生了什么」。
 *   - `entities` ：论文 + 抽出来的实体，回答的是「这两篇为什么被判定相关」。
 *     它是**叠加层**，默认不显示。
 */
export type GraphMode = 'relations' | 'entities'

/** 构图的筛选条件 */
export interface GraphScope {
  /** 只保留这些分类下的论文（空数组 = 全部） */
  categories?: string[]
  /** 只保留出现次数 ≥ N 篇论文的实体，用来过滤噪音 */
  minPapers?: number
  /** 是否包含 paper 节点（关掉就只看实体之间的关系网） */
  includePapers?: boolean
  /**
   * 缺省 `entities`：保持既有行为不变。`GraphOverview` 的共现统计依赖 mentions 边，
   * 不能跟着默认值一起漂走，所以界面两个视图都会显式传值。
   */
  mode?: GraphMode
}

/* ------------------------------------------------------------------ */
/*  多跳                                                                */
/* ------------------------------------------------------------------ */

export interface HopPath {
  nodeId: string
  name: string
  kind: GraphNodeKind
  /** 跳数 */
  hops: number
  /** 完整节点 id 路径（含起点与终点） */
  path: string[]
  /** 路径中途经的实体名（不含起点终点），这是「它们为什么相关」的答案 */
  via: string[]
  /** 终点是论文时的论文 id */
  paperId?: string
}

export interface MultiHopResult {
  start: GraphNode | null
  paths: HopPath[]
  /** 命中节点与其相邻边，供画布高亮 */
  highlightNodes: string[]
  highlightEdges: string[]
  /** 本次 BFS 实际搜到的跳数 */
  maxHops: number
}
