/**
 * 方法流程图。
 *
 * 为什么是「结构化 JSON + 自己画」而不是让模型直接吐 Mermaid / HTML：
 *   1. 可校验。节点/边结构不对可以直接判失败，而一段语法错的 Mermaid 会被原样
 *      写进笔记 —— 对初学者来说「一坨看不懂的源码」比没有图更劝退。
 *   2. 能挂回原文。每个节点可以带 `source`（§3.2 / Fig.2），这才谈得上
 *      「AI 画的图不是幻觉」；塞进 Mermaid 的节点标签里只会把图搞乱。
 *   3. 零依赖、无 eval 风险（本项目的 CSP 刻意没有 unsafe-eval），配色也能跟主题走。
 *
 * 表达力换来的是：只画得了管线 / 分支这类结构图，画不了时序图和状态机 —— 够用就行。
 */

export interface FlowNode {
  id: string
  label: string
  /** 补充说明（作者为什么这么设计），可空 */
  note?: string
  /** 原文出处，例如「§3.2」「Fig.2」「附录 B」 */
  source?: string
}

export interface FlowEdge {
  from: string
  to: string
  label?: string
}

export interface MethodFlow {
  title?: string
  nodes: FlowNode[]
  edges: FlowEdge[]
}

/** 上限都是防模型话多画的：节点太多流程条会变成一堵墙，反而看不懂 */
const MAX_NODES = 12
const MAX_EDGES = 24
const MAX_LABEL = 60
const MAX_NOTE = 120
const MAX_SOURCE = 40
const MAX_TITLE = 60

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 把模型返回的 flow 收敛成可渲染的结构；**画不成图时返回 undefined**。
 *
 * 返回 undefined 而不是空对象，是为了让调用方「不写这个键」——
 * 本项目吃过亏：值为 undefined 的键会让 js-yaml 直接抛错。
 */
export function normalizeMethodFlow(raw: unknown): MethodFlow | undefined {
  const root = (raw ?? {}) as Record<string, unknown>
  const rawNodes = Array.isArray(root.nodes) ? root.nodes : []

  const nodes: FlowNode[] = []
  const ids = new Set<string>()
  for (const item of rawNodes) {
    if (nodes.length >= MAX_NODES) break
    const node = (item ?? {}) as Record<string, unknown>
    const label = str(node.label).slice(0, MAX_LABEL)
    // 没标签的节点画出来是个空框，没有意义
    if (!label) continue

    // id 缺了就按顺序补，后面靠 id 连边才不会全断
    let id = str(node.id) || `n${nodes.length + 1}`
    if (ids.has(id)) id = `${id}-${nodes.length + 1}`
    ids.add(id)

    const note = str(node.note).slice(0, MAX_NOTE)
    const source = str(node.source).slice(0, MAX_SOURCE)
    nodes.push({
      id,
      label,
      // 有值的键才出现：undefined 值会让 js-yaml 抛错
      ...(note ? { note } : {}),
      ...(source ? { source } : {})
    })
  }

  // 一个节点的「流程」没有意义，不如不画
  if (nodes.length < 2) return undefined

  const rawEdges = Array.isArray(root.edges) ? root.edges : []
  const edges: FlowEdge[] = []
  for (const item of rawEdges) {
    if (edges.length >= MAX_EDGES) break
    const edge = (item ?? {}) as Record<string, unknown>
    const from = str(edge.from)
    const to = str(edge.to)
    // 指向不存在节点的边会让渲染器找不到落点 —— 丢掉，而不是画一条悬空的线；
    // 自环同理（一个节点指向自己在流程图上没有意义，还会把布局绕进去）
    if (!ids.has(from) || !ids.has(to) || from === to) continue
    if (edges.some((e) => e.from === from && e.to === to)) continue
    const label = str(edge.label).slice(0, 30)
    edges.push({ from, to, ...(label ? { label } : {}) })
  }

  const title = str(root.title).slice(0, MAX_TITLE)
  return { ...(title ? { title } : {}), nodes, edges }
}

/* ------------------------------------------------------------------ */
/*  布局（纯函数，便于测试）                                            */
/* ------------------------------------------------------------------ */

export interface FlowLayoutNode extends FlowNode {
  /** 相对画布左上角 */
  x: number
  y: number
  w: number
  h: number
  /** 第几层（从上往下） */
  layer: number
}

export interface FlowLayoutEdge extends FlowEdge {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface FlowLayout {
  width: number
  height: number
  nodes: FlowLayoutNode[]
  edges: FlowLayoutEdge[]
}

export const FLOW_NODE_W = 170
export const FLOW_NODE_H = 56
const GAP_X = 18
const GAP_Y = 36

/**
 * 分层：每个节点的层 = 「从任一入口到它的最长路径」。
 *
 * 为什么取最长路径：取最短的话，a→b→c 与 a→c 同时存在时 c 会被放到第 1 层，
 * 于是 a→b→c 这条边会**从下往上倒着画**。
 *
 * 环形依赖不能让这里死循环：Kahn 拓扑剥完后剩下的节点（都在环里）统一落到
 * 最后一层。模型偶尔会写出互指的节点，为此挂住整个界面不值得。
 */
function assignLayers(flow: MethodFlow): Map<string, number> {
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const node of flow.nodes) {
    incoming.set(node.id, 0)
    outgoing.set(node.id, [])
  }
  for (const edge of flow.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    outgoing.get(edge.from)?.push(edge.to)
  }

  const layer = new Map<string, number>()
  const queue = flow.nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0).map((n) => n.id)
  for (const id of queue) layer.set(id, 0)

  let head = 0
  while (head < queue.length) {
    const id = queue[head++]
    const base = layer.get(id) ?? 0
    for (const next of outgoing.get(id) ?? []) {
      // 最长路径：取更大的那层
      layer.set(next, Math.max(layer.get(next) ?? 0, base + 1))
      const left = (incoming.get(next) ?? 0) - 1
      incoming.set(next, left)
      if (left === 0) queue.push(next)
    }
  }

  // 环里的节点（拓扑剥不掉）兜到最后一层，保证每个节点都有位置
  const maxLayer = Math.max(0, ...Array.from(layer.values()))
  for (const node of flow.nodes) {
    if (!layer.has(node.id)) layer.set(node.id, maxLayer + 1)
  }
  return layer
}

/**
 * 把流程排成「从上到下的层」：同一层的节点并排，层与层之间留出箭头的空间。
 *
 * 竖排而不是横排：笔记区宽度通常只有六七百像素，横排的流程条很快就要横向滚动，
 * 而纵向滚动在笔记页里是自然的。
 */
export function layoutMethodFlow(flow: MethodFlow): FlowLayout {
  const layerOf = assignLayers(flow)
  const rows = new Map<number, FlowNode[]>()
  for (const node of flow.nodes) {
    const layer = layerOf.get(node.id) ?? 0
    const row = rows.get(layer)
    if (row) row.push(node)
    else rows.set(layer, [node])
  }

  const widthOf = (count: number): number => count * FLOW_NODE_W + (count - 1) * GAP_X
  const width = Math.max(FLOW_NODE_W, ...Array.from(rows.values(), (r) => widthOf(r.length)))

  const nodes: FlowLayoutNode[] = []
  for (const [layer, row] of Array.from(rows.entries()).sort((a, b) => a[0] - b[0])) {
    // 每层居中，看起来才像一条主流程
    const startX = (width - widthOf(row.length)) / 2
    row.forEach((node, index) => {
      nodes.push({
        ...node,
        x: Math.round(startX + index * (FLOW_NODE_W + GAP_X)),
        y: layer * (FLOW_NODE_H + GAP_Y),
        w: FLOW_NODE_W,
        h: FLOW_NODE_H,
        layer
      })
    })
  }

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const edges: FlowLayoutEdge[] = []
  for (const edge of flow.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue
    // 同层的边横着连（从右边中点到左边中点）；跨层从下边中点连到上边中点
    const sameRow = from.layer === to.layer
    edges.push({
      ...edge,
      x1: sameRow ? from.x + from.w : from.x + from.w / 2,
      y1: sameRow ? from.y + from.h / 2 : from.y + from.h,
      x2: sameRow ? to.x : to.x + to.w / 2,
      y2: sameRow ? to.y + to.h / 2 : to.y
    })
  }

  const height = nodes.reduce((max, n) => Math.max(max, n.y + n.h), FLOW_NODE_H)
  return { width: Math.round(width), height: Math.round(height), nodes, edges }
}
