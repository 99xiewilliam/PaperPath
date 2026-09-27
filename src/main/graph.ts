/**
 * 跨论文知识图谱：构图 + 缓存 + 多跳检索。
 *
 * 为什么不在 SQLite 里建三张表（entities / paper_entities / relations）：
 * 个人知识库的量级（几千篇 × 约 25 个实体）用 JS 构建邻接表只要几十毫秒，
 * 而多跳 BFS 在内存里做远比递归 SQL 简单可靠，也少一次 schema 迁移的风险。
 * 用 db.graphStamp() 做缓存指纹，任何一篇论文变了就自动重建。
 */
import type { EntityKind, RelationType } from '@shared/lenses'
import type {
  GraphData,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  GraphScope,
  HopPath,
  MultiHopResult,
  PaperNodeKind
} from '@shared/graph'
import * as db from './db'

const PAPER_PREFIX = 'p:'
const ENTITY_PREFIX = 'e:'

/* ------------------------------------------------------------------ */
/*  内部结构                                                            */
/* ------------------------------------------------------------------ */

interface MutableNode {
  id: string
  name: string
  kind: GraphNodeKind
  papers: Set<string>
  mentions: number
  year?: number | null
  categories?: string[]
}

interface BuiltGraph {
  nodes: Map<string, MutableNode>
  edges: GraphEdge[]
  /** 只保留语义关系边（不含 paper→entity），用于关系计数 */
  semanticEdges: number
  /** 论文之间的关系边数（用户建立 / 采纳 AI 提议），不受任何筛选影响 */
  paperLinks: number
  papersWithGraph: number
  totalPapers: number
}

let cache: { stamp: string; graph: BuiltGraph } | null = null

function paperId(id: string): string {
  return PAPER_PREFIX + id
}

/** 实体名做同名合并：大小写与首尾空格差异不该产生两个节点 */
function normalizeName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/** 并查集：把「同一事物的多种写法」并成一组 */
class UnionFind {
  private parent = new Map<string, string>()

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x)
      return x
    }
    let root = x
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string
    // 路径压缩，避免长链反复遍历
    let cursor = x
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor) as string
      this.parent.set(cursor, root)
      cursor = next
    }
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

interface NameStat {
  /** 展示用的原始写法 */
  display: string
  /** 作为「主名」出现的次数（只当别名出现的不算） */
  count: number
  kind: EntityKind
}

/* ------------------------------------------------------------------ */
/*  构图                                                                */
/* ------------------------------------------------------------------ */

function build(): BuiltGraph {
  const papers = db.listPaperRows()
  const nodes = new Map<string, MutableNode>()
  const edges: GraphEdge[] = []
  const seenEdge = new Set<string>()
  let semanticEdges = 0
  let papersWithGraph = 0

  const ensureNode = (
    id: string,
    name: string,
    kind: GraphNodeKind,
    paper?: string,
    extra?: { year?: number | null; categories?: string[] }
  ): MutableNode => {
    let node = nodes.get(id)
    if (!node) {
      node = {
        id,
        name,
        kind,
        papers: new Set(),
        mentions: 0,
        year: extra?.year,
        categories: extra?.categories
      }
      nodes.set(id, node)
    }
    if (paper) node.papers.add(paper)
    return node
  }

  const pushEdge = (edge: GraphEdge): void => {
    if (seenEdge.has(edge.id)) return
    seenEdge.add(edge.id)
    edges.push(edge)
  }

  /*
   * 第一遍：把「实体名 + 它的别名」并成同一组。
   *
   * 模型其实已经抽出了 aliases（实测覆盖率约一半，而且质量不错：
   * π0→pi0、GRPO→Group Relative Policy Optimization、
   * Vision-Language-Action→VLA、Visual Differencing Module→VDM），
   * 但构图时完全没用上 —— 只按 name 建节点，同一个东西的几种写法
   * 就变成几个互不相连的点，白丢掉本该有的跨论文连接。
   *
   * 合并策略保守优先：只有字面完全一致（忽略大小写与空白）才并到一起，
   * 不做模糊匹配 —— 宁可少连，也不能把不相干的东西糊成一个节点。
   */
  const uf = new UnionFind()
  const stats = new Map<string, NameStat>()

  /** 登记一个写法；primary 表示它是某个实体的正式名字（而不是别名） */
  const noteName = (raw: string, kind: EntityKind, primary: boolean): string | null => {
    const name = normalizeName(raw)
    if (!name) return null
    const key = name.toLowerCase()
    const prev = stats.get(key)
    if (prev) {
      if (primary) prev.count++
    } else {
      stats.set(key, { display: name, count: primary ? 1 : 0, kind })
    }
    uf.find(key)
    return key
  }

  for (const paper of papers) {
    for (const entity of paper.graph?.entities ?? []) {
      const kind = (entity.kind ?? 'concept') as EntityKind
      const key = noteName(entity.name ?? '', kind, true)
      if (!key) continue
      for (const alias of entity.aliases ?? []) {
        const aliasKey = noteName(String(alias), kind, false)
        if (aliasKey && aliasKey !== key) uf.union(key, aliasKey)
      }
    }
  }

  /**
   * 每组选一个规范名：以「作为主名出现的次数」最多者胜；
   * 并列时取更短的写法；再并列按字典序 —— 保证结果稳定、不随论文顺序变化。
   */
  const groupCanonical = new Map<string, string>()
  for (const [key, stat] of stats) {
    const root = uf.find(key)
    const current = groupCanonical.get(root)
    if (!current) {
      groupCanonical.set(root, key)
      continue
    }
    const best = stats.get(current) as NameStat
    const better =
      stat.count > best.count ||
      (stat.count === best.count &&
        (stat.display.length < best.display.length ||
          (stat.display.length === best.display.length && stat.display < best.display)))
    if (better) groupCanonical.set(root, key)
  }

  /** 任意写法（含别名）→ 全局节点 id */
  const resolve = (raw: string): { id: string; name: string; kind: EntityKind } | null => {
    const name = normalizeName(raw)
    if (!name) return null
    const canonicalKey = groupCanonical.get(uf.find(name.toLowerCase()))
    if (!canonicalKey) return null
    const stat = stats.get(canonicalKey) as NameStat
    return { id: ENTITY_PREFIX + canonicalKey, name: stat.display, kind: stat.kind }
  }

  /* 第二遍：真正建图 */
  for (const paper of papers) {
    const pId = paperId(paper.id)
    ensureNode(pId, paper.title || '(未命名论文)', 'paper' as PaperNodeKind, paper.id, {
      year: paper.year,
      categories: paper.categories
    })

    const graph = paper.graph
    if (!graph?.entities?.length) continue
    papersWithGraph++

    // 论文内写法（含别名）→ 全局节点 id
    const localId = new Map<string, string>()
    // 同一篇论文里若把同一实体写了两种写法，mentions 只能算一次
    const counted = new Set<string>()

    for (const entity of graph.entities) {
      const resolved = resolve(entity.name ?? '')
      if (!resolved) continue

      const key = normalizeName(entity.name ?? '').toLowerCase()
      localId.set(key, resolved.id)
      // 别名也登记，这样关系里写成别名也能接上
      for (const alias of entity.aliases ?? []) {
        const aliasKey = normalizeName(String(alias)).toLowerCase()
        if (aliasKey) localId.set(aliasKey, resolved.id)
      }

      if (!counted.has(resolved.id)) {
        counted.add(resolved.id)
        const node = ensureNode(resolved.id, resolved.name, resolved.kind)
        node.mentions++
        pushEdge({
          id: `${pId}>${resolved.id}`,
          from: pId,
          to: resolved.id,
          type: 'mentions',
          paperId: paper.id
        })
      }
    }

    for (const relation of graph.relations ?? []) {
      const from = localId.get(normalizeName(relation.from ?? '').toLowerCase())
      const to = localId.get(normalizeName(relation.to ?? '').toLowerCase())
      if (!from || !to || from === to) continue
      const type = (relation.type ?? 'uses') as RelationType
      pushEdge({
        id: `${from}|${type}|${to}|${paper.id}`,
        from,
        to,
        type,
        paperId: paper.id,
        evidence: relation.evidence
      })
      semanticEdges++
    }
  }

  /*
   * 最后一遍：论文↔论文的关系边（你手工建立或采纳 AI 提议的）。
   *
   * 单独一轮而不是并进上面的循环：那个循环遇到「没抽过实体的论文」会
   * `continue`（`if (!graph?.entities?.length) continue`），而关系跟有没有跑过
   * 精读毫无关系 —— 并进去会让「还没精读的论文」之间刚连好的关系静默消失。
   */
  let paperLinks = 0
  for (const paper of papers) {
    const from = paperId(paper.id)
    for (const link of paper.links ?? []) {
      const to = paperId(link.to)
      // 目标论文已经不在库里（被删掉 / id 改过）→ 丢掉这条，不画悬空的线
      if (to === from || !nodes.has(to)) continue
      pushEdge({
        // 方向 + 类型都进 id：A 基于 B 和 B 对比 A 是两条不同的边，都得留下
        id: `${from}=${link.type}=>${to}`,
        from,
        to,
        type: link.type,
        layer: 'paper',
        paperId: paper.id,
        by: link.by,
        evidence: link.note ?? link.evidence
      })
      paperLinks++
    }
  }

  return {
    nodes,
    edges,
    semanticEdges,
    paperLinks,
    papersWithGraph,
    totalPapers: papers.length
  }
}

function built(): BuiltGraph {
  const stamp = db.graphStamp()
  if (cache && cache.stamp === stamp) return cache.graph
  const graph = build()
  cache = { stamp, graph }
  return graph
}

/* ------------------------------------------------------------------ */
/*  快照                                                                */
/* ------------------------------------------------------------------ */

function toGraphNode(node: MutableNode): GraphNode {
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    paperCount: node.kind === 'paper' ? 1 : node.papers.size,
    paperId: node.kind === 'paper' ? node.id.slice(PAPER_PREFIX.length) : undefined,
    year: node.kind === 'paper' ? node.year : undefined,
    categories: node.kind === 'paper' ? node.categories : undefined,
    mentions: node.kind === 'paper' ? undefined : node.mentions
  }
}

/**
 * 生成用于可视化的子图。
 * 默认会把「只被 1 篇论文提到」的实体过滤掉——它们是图变乱的主要来源。
 */
export function graphSnapshot(scope: GraphScope = {}): GraphData {
  const graph = built()
  const includePapers = scope.includePapers !== false
  const minPapers = Math.max(1, scope.minPapers ?? 1)
  const categoryFilter = new Set(scope.categories ?? [])

  // 先筛出符合条件的论文节点
  const keptPapers = new Set<string>()
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'paper') continue
    if (categoryFilter.size) {
      const cats = node.categories ?? []
      if (!cats.some((c) => categoryFilter.has(c))) continue
    }
    keptPapers.add(node.id)
  }

  /*
   * 论文关系视图：节点只有论文，边只有你建立（或采纳）的关系。
   *
   * 没连过任何关系的论文**不画**：一排孤点除了让人以为图坏了，没有任何信息 ——
   * 想连就去详情页的「关联论文」连一条。这也正是 stats.links 存在的理由：
   * 空画布必须能区分「一篇都没连过」和「连了、但被分类或搜索挡掉了」。
   */
  if ((scope.mode ?? 'entities') === 'relations') {
    const links = graph.edges.filter((e) => e.layer === 'paper')
    const linked = new Set<string>()
    for (const edge of links) {
      if (!keptPapers.has(edge.from) || !keptPapers.has(edge.to)) continue
      linked.add(edge.from)
      linked.add(edge.to)
    }
    const nodes: GraphNode[] = []
    for (const id of linked) {
      const node = graph.nodes.get(id)
      if (node) nodes.push(toGraphNode(node))
    }
    const edges = links.filter((e) => linked.has(e.from) && linked.has(e.to))
    return {
      nodes,
      edges,
      stats: {
        // 论文关系视图里「参与构图的论文」= 至少有一条关系的论文
        papers: linked.size,
        totalPapers: graph.totalPapers,
        entities: 0,
        relations: edges.length,
        singletons: 0,
        totalEntities: 0,
        multiPaperEntities: 0,
        links: graph.paperLinks
      }
    }
  }

  // 统计实体在「已选论文」里的出现次数，用于 minPapers 过滤
  const entityPaperSet = new Map<string, Set<string>>()
  for (const edge of graph.edges) {
    if (edge.type !== 'mentions') continue
    if (!keptPapers.has(edge.from)) continue
    if (!entityPaperSet.has(edge.to)) entityPaperSet.set(edge.to, new Set())
    entityPaperSet.get(edge.to)!.add(edge.from)
  }

  const keptEntities = new Set<string>()
  for (const [id, papers] of entityPaperSet) {
    if (papers.size >= minPapers) keptEntities.add(id)
  }

  /*
   * 先算出「至少涉及一个保留实体」的论文集合。
   * 以前是在遍历节点时对每个论文节点跑一次 edges.some()，复杂度 O(V×E)；
   * 图谱一大就明显拖慢（多跳检索每次都会走一遍这里）。
   */
  const papersWithKeptEntity = new Set<string>()
  for (const edge of graph.edges) {
    if (edge.type !== 'mentions') continue
    if (!keptEntities.has(edge.to)) continue
    papersWithKeptEntity.add(edge.from)
  }

  const nodes: GraphNode[] = []
  for (const node of graph.nodes.values()) {
    if (node.kind === 'paper') {
      if (!includePapers || !keptPapers.has(node.id)) continue
      // 没有任何实体的孤立论文节点不画出来（否则是一堆孤点）
      if (!papersWithKeptEntity.has(node.id)) continue
      nodes.push(toGraphNode(node))
      continue
    }
    if (!keptEntities.has(node.id)) continue
    const view = toGraphNode(node)
    // paperCount 按筛选后的论文数重算，保证界面上的数字与眼前这张图一致
    view.paperCount = entityPaperSet.get(node.id)?.size ?? 0
    nodes.push(view)
  }

  const kept = new Set(nodes.map((n) => n.id))
  const edges = graph.edges.filter((e) => kept.has(e.from) && kept.has(e.to))

  const singletons = [...entityPaperSet.values()].filter((s) => s.size === 1).length
  const multiPaperEntities = [...entityPaperSet.values()].filter((s) => s.size >= 2).length

  return {
    nodes,
    edges,
    stats: {
      papers: graph.papersWithGraph,
      totalPapers: graph.totalPapers,
      entities: nodes.filter((n) => n.kind !== 'paper').length,
      // 只数**抽出来的**语义关系：论文关系边是自己建立的一层（另有 stats.links 统计），
      // 混进来会让「N 条关系」这个数字忽大忽小、也失去意义
      relations: edges.filter((e) => e.type !== 'mentions' && e.layer !== 'paper').length,
      singletons,
      // 这两个统计的是「筛选前」的全部实体，渲染层靠它自动选一个不至于糊成一团的粒度
      totalEntities: entityPaperSet.size,
      multiPaperEntities,
      links: graph.paperLinks
    }
  }
}

/* ------------------------------------------------------------------ */
/*  多跳检索                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从某个节点出发做 BFS，返回 N 跳内可达的节点与最短路径。
 *
 * 典型用法：以一篇论文为起点，看 2~3 跳内能连到哪些**其他论文**，
 * 以及「是通过哪些共同实体连上的」——这就是跨论文找关系的核心。
 */
export function multiHopPaths(startId: string, maxHops = 2, scope: GraphScope = {}): MultiHopResult {
  const empty: MultiHopResult = {
    start: null,
    paths: [],
    highlightNodes: [],
    highlightEdges: [],
    maxHops
  }

  if (!db.isOpen()) return empty

  // 在图谱全量里搜索（而不是筛选后的子图），否则多跳会因为隐藏节点而断链
  const graph = built()
  const startNode = graph.nodes.get(startId)
  if (!startNode) return empty

  const hops = Math.max(1, Math.min(maxHops, 4))

  // 邻接表：无向，因为「论文涉及实体」和「实体关系」都应该能双向走
  const adjacency = new Map<string, { to: string; edgeId: string }[]>()
  const addAdj = (from: string, to: string, edgeId: string): void => {
    if (!adjacency.has(from)) adjacency.set(from, [])
    adjacency.get(from)!.push({ to, edgeId })
    if (!adjacency.has(to)) adjacency.set(to, [])
    adjacency.get(to)!.push({ to: from, edgeId })
  }
  /*
   * 关系视图下只走论文关系边：这样「经由」列出来的是**论文名**（A 通过 B 连到 C），
   * 而不是「都提到了某个数据集」那种实体中介 —— 后者在实体视图里看。
   */
  const mode = scope.mode ?? 'entities'
  for (const edge of graph.edges) {
    if (mode === 'relations' && edge.layer !== 'paper') continue
    addAdj(edge.from, edge.to, edge.id)
  }

  // BFS（按跳数分层，天然得到最短路径）
  const dist = new Map<string, number>([[startId, 0]])
  const parent = new Map<string, { from: string; edgeId: string }>()
  let frontier = [startId]

  for (let depth = 1; depth <= hops; depth++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const link of adjacency.get(id) ?? []) {
        if (dist.has(link.to)) continue
        dist.set(link.to, depth)
        parent.set(link.to, { from: id, edgeId: link.edgeId })
        next.push(link.to)
      }
    }
    if (!next.length) break
    frontier = next
  }

  const highlightEdges = new Set<string>()
  const highlightNodes = new Set<string>([startId])
  const paths: HopPath[] = []

  for (const [id, depth] of dist) {
    if (id === startId) continue
    const node = graph.nodes.get(id)
    if (!node) continue

    const chain: string[] = [id]
    const via: string[] = []
    let cursor = id
    let guard = 0
    while (cursor !== startId && guard++ < 16) {
      const step = parent.get(cursor)
      if (!step) break
      highlightEdges.add(step.edgeId)
      highlightNodes.add(step.from)
      cursor = step.from
      chain.unshift(cursor)
      const mid = graph.nodes.get(cursor)
      // 关系视图里「途经」的就是论文；实体视图里只有实体才算途经
      if (mid && cursor !== startId && (mid.kind !== 'paper' || mode === 'relations')) {
        via.unshift(mid.name)
      }
    }
    // 终点本身也是实体的话，也算「途经」（关系视图的终点是论文，行里已经写了它的名字）
    if (node.kind !== 'paper' && mode !== 'relations') via.push(node.name)

    paths.push({
      nodeId: id,
      name: node.name,
      kind: node.kind,
      hops: depth,
      path: chain,
      via,
      paperId: node.kind === 'paper' ? id.slice(PAPER_PREFIX.length) : undefined
    })
  }

  // 排序：论文优先、跳数少的优先、被引用多的优先
  paths.sort((a, b) => {
    const ap = a.kind === 'paper' ? 0 : 1
    const bp = b.kind === 'paper' ? 0 : 1
    if (ap !== bp) return ap - bp
    if (a.hops !== b.hops) return a.hops - b.hops
    const ac = graph.nodes.get(a.nodeId)?.papers.size ?? 0
    const bc = graph.nodes.get(b.nodeId)?.papers.size ?? 0
    return bc - ac
  })

  // 用 scope 过滤掉不该出现的节点（但搜索本身不受影响）
  const visible = graphSnapshot({ ...scope, minPapers: 1 })
  const visibleIds = new Set(visible.nodes.map((n) => n.id))

  return {
    start: visibleIds.has(startId)
      ? toGraphNode(startNode)
      : { ...toGraphNode(startNode) },
    paths: paths.filter((p) => visibleIds.has(p.nodeId)),
    highlightNodes: [...highlightNodes].filter((id) => visibleIds.has(id)),
    highlightEdges: [...highlightEdges],
    maxHops: hops
  }
}

/** 供「重新抽取图谱」等场景判断是否有数据 */
export function hasGraphData(): boolean {
  return built().papersWithGraph > 0
}
