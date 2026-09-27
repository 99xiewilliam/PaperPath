/**
 * 全文思维导图。
 *
 * 和视频软件的「课程思维导图」同一个目的：初学者读完一篇论文，需要一张
 * 能把整篇挂在脑子的图 —— 中心是主题，主干是「问题 / 方法 / 实验 / 结论」，
 * 叶子是具体设计和数字。
 *
 * 和方法流程图（shared/flow.ts）的分工：流程图画「方法怎么一步步跑」，
 * 思维导图画「整篇论文的知识结构」。两者都是结构化 JSON + 自绘，
 * 理由相同：可校验、能挂出处、零依赖、配色跟主题走。
 *
 * 布局是纯函数（layoutMindMap），所以「子树会不会叠在一起 / 父节点有没有
 * 居中」都能在脚本里直接测（smoke:parse）。
 */

export interface MindNode {
  id: string
  label: string
  /** 补充说明（为什么重要 / 具体数字），可空 */
  note?: string
  children?: MindNode[]
}

export interface MindMap {
  title?: string
  root: MindNode
}

/** 上限都是防模型话多的：节点太多导图会变成一堵墙，反而看不懂 */
const MAX_NODES = 30
/** 根之外最多 3 层：再深导读图的意义就没有了，那是大纲不是导图 */
const MAX_DEPTH = 3
const MAX_LABEL = 40
const MAX_NOTE = 120
const MAX_TITLE = 60

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 把模型返回的 mindmap 收敛成可渲染的树；**撑不成一张图时返回 undefined**。
 *
 * undefined 的语义和 normalizeMethodFlow 一致：调用方「不写这个键」，
 * 界面上那一块整个不出现（undefined 值会让 js-yaml 抛错，所以不能留键）。
 */
export function normalizeMindMap(raw: unknown): MindMap | undefined {
  const root0 = (raw ?? {}) as Record<string, unknown>
  const rawRoot = (root0.root ?? {}) as Record<string, unknown>

  let budget = MAX_NODES
  const usedIds = new Set<string>()

  const parse = (node: Record<string, unknown>, path: string, depth: number): MindNode | null => {
    if (budget <= 0) return null
    const label = str(node.label).slice(0, MAX_LABEL)
    // 没标签的节点画出来是个空框
    if (!label) return null
    budget--

    // id 缺了按路径补；撞了加序号 —— 布局靠 id 做 key，重复 id 会互相覆盖
    let id = str(node.id) || `n${path}`
    while (usedIds.has(id)) id = `${id}x`
    usedIds.add(id)

    const note = str(node.note).slice(0, MAX_NOTE)
    const children: MindNode[] = []
    // 超过深度的子树直接剪掉：宁可少一层，不要一张看不懂的图
    if (depth < MAX_DEPTH && Array.isArray(node.children)) {
      node.children.forEach((child, i) => {
        const parsed = parse((child ?? {}) as Record<string, unknown>, `${path}-${i}`, depth + 1)
        if (parsed) children.push(parsed)
      })
    }

    return {
      id,
      label,
      // 有值的键才出现：undefined 值会让 js-yaml 抛错
      ...(note ? { note } : {}),
      ...(children.length ? { children } : {})
    }
  }

  const root = parse(rawRoot, '0', 0)
  // 根没有分支的思维导图就是一句话，不成图
  if (!root || !root.children || root.children.length < 2) return undefined

  const title = str(root0.title).slice(0, MAX_TITLE)
  return { ...(title ? { title } : {}), root }
}

/* ------------------------------------------------------------------ */
/*  布局（纯函数，便于测试）                                              */
/* ------------------------------------------------------------------ */

export interface MindLayoutNode extends MindNode {
  /** 相对画布左上角 */
  x: number
  y: number
  w: number
  h: number
  depth: number
  parentId?: string
}

export interface MindLayoutEdge {
  from: string
  to: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface MindLayout {
  width: number
  height: number
  nodes: MindLayoutNode[]
  edges: MindLayoutEdge[]
}

export const MIND_NODE_W = 180
export const MIND_NODE_H = 46
const GAP_X = 56
const GAP_Y = 12

/**
 * 排成 XMind 式的横向树：根在最左，子节点往右展开，同层竖直堆叠。
 *
 * 横排而不是竖排：思维导图的层数少（≤3）、每层节点多，横向展开后
 * 高度增长慢，正好适合笔记区「宽度有限、随便往下滚」的形状。
 *
 * 父节点的 y 取子树的垂直中心 —— 这是思维导图「一眼看出谁归谁」的关键。
 */
export function layoutMindMap(map: MindMap): MindLayout {
  const nodes: MindLayoutNode[] = []
  const edges: MindLayoutEdge[] = []
  let maxDepth = 0

  /** 子树占的垂直高度：叶子一个节点高，内部节点 = 子树高度之和 + 间距 */
  const heightOf = (node: MindNode): number => {
    const kids = node.children ?? []
    if (!kids.length) return MIND_NODE_H
    return kids.reduce((sum, c) => sum + heightOf(c), 0) + GAP_Y * (kids.length - 1)
  }

  const place = (node: MindNode, depth: number, top: number, parent?: MindLayoutNode): void => {
    const h = heightOf(node)
    maxDepth = Math.max(maxDepth, depth)
    const placed: MindLayoutNode = {
      ...node,
      x: depth * (MIND_NODE_W + GAP_X),
      y: top + (h - MIND_NODE_H) / 2,
      w: MIND_NODE_W,
      h: MIND_NODE_H,
      depth,
      ...(parent ? { parentId: parent.id } : {})
    }
    nodes.push(placed)
    if (parent) {
      // 从父节点右边中点连到子节点左边中点
      edges.push({
        from: parent.id,
        to: placed.id,
        x1: parent.x + parent.w,
        y1: parent.y + parent.h / 2,
        x2: placed.x,
        y2: placed.y + placed.h / 2
      })
    }
    let cursor = top
    for (const child of node.children ?? []) {
      place(child, depth + 1, cursor, placed)
      cursor += heightOf(child) + GAP_Y
    }
  }

  place(map.root, 0, 0)

  return {
    width: (maxDepth + 1) * MIND_NODE_W + maxDepth * GAP_X,
    height: heightOf(map.root),
    nodes,
    edges
  }
}
