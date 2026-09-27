import { useEffect, useRef } from 'react'
import { ENTITY_KIND_COLOR, type EntityKind } from '@shared/lenses'
import { LINK_TYPE_COLOR, type PaperLinkType } from '@shared/links'
import type { GraphEdge, GraphNode } from '@shared/graph'

/**
 * 力导向图画布。
 *
 * 自己写模拟而不是引 react-force-graph / d3-force：
 * 需求很窄（几百个节点的探索图），而自绘能完全控制交互与视觉层级，
 * 也避免为了几十行物理模拟多背一个依赖。
 */

const PAPER_COLOR = '#ECE8DF'

/** 语义关系按「语义家族」着色，比逐类型配色更好读（色值与新调色板同族、降饱和） */
const RELATION_COLOR: Record<string, string> = {
  proposes: '#5FA983',
  improves: '#5FA983',
  extends: '#5FA983',
  'trained-on': '#7FA3C7',
  'evaluated-on': '#7FA3C7',
  'measured-by': '#7FA3C7',
  'compares-with': '#C9973F',
  uses: '#ACA3CF',
  'based-on': '#ACA3CF',
  'applies-to': '#ACA3CF',
  'part-of': '#ACA3CF'
}

const MENTION_COLOR = 'rgba(255,255,255,0.10)'
const HIGHLIGHT = '#74AC8F'

/**
 * 边按层上色：
 *   - 实体边（mentions / 语义关系）沿用原来的淡色 —— 它们是背景信息；
 *   - 论文关系边用 shared/links 那套颜色，跟详情页里类型的 chip **完全一致**：
 *     同一件事在两个地方必须长成一个样子，否则用户得重新学一遍颜色。
 */
function edgeColor(edge: GraphEdge): string {
  if (edge.type === 'mentions') return MENTION_COLOR
  if (edge.layer === 'paper') return LINK_TYPE_COLOR[edge.type as PaperLinkType] ?? '#7A766D'
  return RELATION_COLOR[edge.type] ?? '#7A766D'
}

export function nodeColor(node: GraphNode): string {
  if (node.kind === 'paper') return PAPER_COLOR
  return ENTITY_KIND_COLOR[node.kind as EntityKind] ?? '#8D9199'
}

/** 半径按 sqrt 缩放，避免枢纽节点大得离谱 */
function radiusOf(node: GraphNode): number {
  if (node.kind === 'paper') return 7
  return 4 + Math.sqrt(Math.max(1, node.paperCount)) * 2.6
}

interface SimNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  r: number
  pinned: boolean
  node: GraphNode
}

interface Props {
  nodes: GraphNode[]
  edges: GraphEdge[]
  highlightNodes?: string[]
  highlightEdges?: string[]
  selectedId?: string | null
  /**
   * `additive` = 按住 ⌘/Shift 点的：外层据此把这次点击当成「加入选择集」，
   * 而不是「替换选择」—— 组合分析要一次挑好几篇，但画布本身不该关心多选语义。
   */
  onSelect: (id: string | null, additive?: boolean) => void
  /**
   * ⌘/Shift/Alt 从一个节点拖到另一个节点上松手时触发（参数都是**节点** id）。
   * 画布只报告「谁连谁」，具体建什么类型的关系由外层决定。
   */
  onLinkRequest?: (fromNodeId: string, toNodeId: string) => void
  onOpenPaper?: (paperId: string) => void
  /** 布局完成后的回调，方便外层展示「已稳定」 */
  onSettled?: () => void
}

export function GraphCanvas({
  nodes,
  edges,
  highlightNodes,
  highlightEdges,
  selectedId,
  onSelect,
  onLinkRequest,
  onOpenPaper,
  onSettled
}: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 模拟状态放 ref，避免每帧触发 React 重渲染
  const simRef = useRef<{
    nodes: Map<string, SimNode>
    edges: GraphEdge[]
    alpha: number
    settled: boolean
  }>({ nodes: new Map(), edges: [], alpha: 0, settled: true })

  const viewRef = useRef({ scale: 1, tx: 0, ty: 0 })
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 })
  const dragRef = useRef<{
    mode: 'none' | 'pan' | 'node' | 'link'
    id?: string
    sx: number
    sy: number
  }>({
    mode: 'none',
    sx: 0,
    sy: 0
  })
  /** 连线拖拽中的预览线：起点节点 id + 当前光标的屏幕坐标 */
  const linkRef = useRef<{ from: string | null; x: number; y: number }>({ from: null, x: 0, y: 0 })
  const hoverRef = useRef<string | null>(null)
  const propsRef = useRef({ highlightNodes, highlightEdges, selectedId, onSettled })
  propsRef.current = { highlightNodes, highlightEdges, selectedId, onSettled }

  // rafRef.current === 0 表示渲染循环在「睡觉」；needsRenderRef 记录有状态变化需要补画一帧
  const rafRef = useRef(0)
  const needsRenderRef = useRef(true)
  const wakeRef = useRef<() => void>(() => {})

  /* ---------------- 坐标变换 ---------------- */
  const toScreen = (x: number, y: number): [number, number] => {
    const v = viewRef.current
    const { w, h } = sizeRef.current
    return [x * v.scale + w / 2 + v.tx, y * v.scale + h / 2 + v.ty]
  }
  const toWorld = (sx: number, sy: number): [number, number] => {
    const v = viewRef.current
    const { w, h } = sizeRef.current
    return [(sx - w / 2 - v.tx) / v.scale, (sy - h / 2 - v.ty) / v.scale]
  }

  /* ---------------- 数据变化：重建 / 复用节点位置 ---------------- */
  useEffect(() => {
    const sim = simRef.current
    const previous = sim.nodes
    const next = new Map<string, SimNode>()
    const golden = Math.PI * (3 - Math.sqrt(5))

    nodes.forEach((node, index) => {
      const keep = previous.get(node.id)
      if (keep) {
        next.set(node.id, { ...keep, r: radiusOf(node), node })
        return
      }
      // 新增节点按黄金角撒在圆盘上，比随机分布收敛快也更好看
      const angle = index * golden
      const radius = 12 + Math.sqrt(index) * 26
      next.set(node.id, {
        id: node.id,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        r: radiusOf(node),
        pinned: false,
        node
      })
    })

    sim.nodes = next
    sim.edges = edges
    const grew = next.size > previous.size
    sim.alpha = Math.max(sim.alpha, grew ? 1 : 0.55)
    sim.settled = false
    wakeRef.current()
  }, [nodes, edges])

  /* 外部高亮 / 选中变化时，如果循环在睡觉要叫醒补画一帧 */
  useEffect(() => {
    wakeRef.current()
  }, [highlightNodes, highlightEdges, selectedId])

  /* ---------------- 尺寸 ---------------- */
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    const resize = (): void => {
      const rect = wrap.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      sizeRef.current = { w: rect.width, h: rect.height, dpr }
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [])

  /* ---------------- 模拟 + 渲染循环 ----------------
   * 布局稳定且没有交互时完全停掉 rAF——图谱页挂在后台不该一直吃 CPU。
   * 任何变化（数据 / 高亮 / 选中 / 拖拽 / 缩放）都通过 wakeRef 把它叫醒。
   */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const wake = (): void => {
      needsRenderRef.current = true
      if (!rafRef.current) rafRef.current = requestAnimationFrame(step)
    }
    wakeRef.current = wake

    const step = (): void => {
      const sim = simRef.current
      const list = [...sim.nodes.values()]
      const { w, h, dpr } = sizeRef.current
      const current = propsRef.current

      /* --- 物理 --- */
      if (sim.alpha > 0.004) {
        const alpha = sim.alpha

        // 斥力（O(n²)；几百个节点的量级完全够用）
        for (let i = 0; i < list.length; i++) {
          const a = list[i]
          for (let j = i + 1; j < list.length; j++) {
            const b = list[j]
            let dx = b.x - a.x
            let dy = b.y - a.y
            let d2 = dx * dx + dy * dy
            if (d2 < 0.01) {
              // 完全重合时给一个确定性的微小偏移，避免除零
              dx = (i % 7) - 3 + 0.5
              dy = (j % 7) - 3 + 0.5
              d2 = dx * dx + dy * dy
            }
            const d = Math.sqrt(d2)
            const minGap = a.r + b.r + 26
            const force = (minGap * minGap) / d2
            const fx = (dx / d) * force * 0.014 * alpha
            const fy = (dy / d) * force * 0.014 * alpha
            if (!a.pinned) {
              a.vx -= fx
              a.vy -= fy
            }
            if (!b.pinned) {
              b.vx += fx
              b.vy += fy
            }
          }
        }

        // 边的弹簧
        for (const edge of sim.edges) {
          const a = sim.nodes.get(edge.from)
          const b = sim.nodes.get(edge.to)
          if (!a || !b) continue
          const dx = b.x - a.x
          const dy = b.y - a.y
          const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
          /*
           * 论文关系边拉得更长、更软：论文节点半径只有 7，用实体边那档间距会让
           * 两个圆挤在一起，边上的箭头和两侧标签全糊在一块。关系图节点少，
           * 拉开一点反而读得清。
           */
          const isPaperLink = edge.layer === 'paper'
          const rest = isPaperLink ? 150 : edge.type === 'mentions' ? a.r + b.r + 62 : 96
          const k = (isPaperLink ? 0.016 : edge.type === 'mentions' ? 0.030 : 0.020) * alpha
          const f = (d - rest) * k
          const fx = (dx / d) * f
          const fy = (dy / d) * f
          if (!a.pinned) {
            a.vx += fx
            a.vy += fy
          }
          if (!b.pinned) {
            b.vx -= fx
            b.vy -= fy
          }
        }

        // 向心力 + 阻尼 + 位移
        for (const n of list) {
          if (n.pinned) {
            n.vx = 0
            n.vy = 0
            continue
          }
          n.vx -= n.x * 0.0055 * alpha
          n.vy -= n.y * 0.0055 * alpha
          n.vx *= 0.82
          n.vy *= 0.82
          n.x += Math.max(-40, Math.min(40, n.vx))
          n.y += Math.max(-40, Math.min(40, n.vy))
        }

        sim.alpha *= 0.985

        // 半径小的图几秒内就稳定了，稳定后停止模拟省 CPU
        if (sim.alpha <= 0.004 && !sim.settled) {
          sim.settled = true
          sim.alpha = 0
          current.onSettled?.()
        }
      }

      /* --- 绘制 --- */
      const highlightSet = current.highlightNodes?.length
        ? new Set(current.highlightNodes)
        : null
      const highlightEdgeSet = current.highlightEdges?.length
        ? new Set(current.highlightEdges)
        : null
      const dimmed = !!highlightSet

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      // 自动适配：内容超出视口时缩小（只在还未手动缩放时生效）
      if (viewRef.current.scale === 1 && sim.settled && list.length > 1) {
        let maxX = 1
        let maxY = 1
        for (const n of list) {
          maxX = Math.max(maxX, Math.abs(n.x) + n.r)
          maxY = Math.max(maxY, Math.abs(n.y) + n.r)
        }
        const fit = Math.min((w / 2 - 40) / maxX, (h / 2 - 40) / maxY, 1.6)
        if (fit > 0.05) viewRef.current.scale = fit
      }

      // 边
      for (const edge of sim.edges) {
        const a = sim.nodes.get(edge.from)
        const b = sim.nodes.get(edge.to)
        if (!a || !b) continue
        const [x1, y1] = toScreen(a.x, a.y)
        const [x2, y2] = toScreen(b.x, b.y)
        const hot = highlightEdgeSet?.has(edge.id) ?? false
        const isPaperLink = edge.layer === 'paper'
        ctx.strokeStyle = hot ? HIGHLIGHT : edgeColor(edge)
        ctx.globalAlpha = hot
          ? 1
          : dimmed
            ? 0.16
            : isPaperLink
              ? 0.85
              : edge.type === 'mentions'
                ? 0.5
                : 0.62
        ctx.lineWidth = hot
          ? Math.min(3.2, 1.1 * viewRef.current.scale + 0.6)
          : isPaperLink
            ? 1.6
            : 1
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()

        /*
         * 论文关系边画箭头。
         *
         * 「A 基于 B」与「B 基于 A」是两件不同的事，而实体边（提及、使用了）
         * 本身没有方向可言 —— 所以只给这一层画，顺带也避免整张图变成一片箭头。
         */
        if (isPaperLink) {
          const angle = Math.atan2(y2 - y1, x2 - x1)
          // 箭头尖停在节点圆外一点，别戳到圆心
          const gap = Math.max(2, b.r * Math.min(viewRef.current.scale, 1.8)) + 3
          const tipX = x2 - Math.cos(angle) * gap
          const tipY = y2 - Math.sin(angle) * gap
          const size = 7
          ctx.beginPath()
          ctx.moveTo(tipX, tipY)
          ctx.lineTo(
            tipX - Math.cos(angle - 0.42) * size,
            tipY - Math.sin(angle - 0.42) * size
          )
          ctx.lineTo(
            tipX - Math.cos(angle + 0.42) * size,
            tipY - Math.sin(angle + 0.42) * size
          )
          ctx.closePath()
          ctx.fillStyle = hot ? HIGHLIGHT : edgeColor(edge)
          ctx.fill()
        }
      }
      ctx.globalAlpha = 1

      // 节点
      for (const n of list) {
        const [x, y] = toScreen(n.x, n.y)
        const r = Math.max(2, n.r * Math.min(viewRef.current.scale, 1.8))
        const isSelected = current.selectedId === n.id
        const isHover = hoverRef.current === n.id
        const isHot = highlightSet ? highlightSet.has(n.id) : true

        ctx.globalAlpha = dimmed && !isHot ? 0.22 : 1

        if (isSelected || isHover) {
          ctx.beginPath()
          ctx.arc(x, y, r + 5, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(116,172,143,0.20)'
          ctx.fill()
        }

        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fillStyle = nodeColor(n.node)
        ctx.fill()

        if (n.node.kind === 'paper') {
          // 论文节点画成空心环，一眼区别于实体
          ctx.lineWidth = 2
          ctx.strokeStyle = nodeColor(n.node)
          ctx.stroke()
          ctx.beginPath()
          ctx.arc(x, y, Math.max(1, r - 3.4), 0, Math.PI * 2)
          // 空心环的内芯：跟窗口底色一致（原来是随手写的蓝灰，在新底色下会发灰蓝）
          ctx.fillStyle = '#170D16'
          ctx.fill()
        }

        if (isSelected || isHover || isHot === false) {
          ctx.lineWidth = 2
          ctx.strokeStyle = isSelected ? HIGHLIGHT : 'rgba(255,255,255,0.55)'
          ctx.beginPath()
          ctx.arc(x, y, r, 0, Math.PI * 2)
          ctx.stroke()
        }
      }

      // 标签：只画重要的 / 高亮的 / 悬停的，否则会糊成一团
      const scale = viewRef.current.scale
      ctx.font = '11px ui-sans-serif, -apple-system, "PingFang SC", sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      for (const n of list) {
        const [x, y] = toScreen(n.x, n.y)
        const r = Math.max(2, n.r * Math.min(scale, 1.8))
        const isSelected = current.selectedId === n.id
        const isHover = hoverRef.current === n.id
        const important = n.node.kind === 'paper' || n.node.paperCount >= 3
        if (!isSelected && !isHover && !(important && scale > 0.72)) continue

        ctx.globalAlpha = dimmed && !isSelected && !isHover ? 0.3 : 1
        const label = n.node.name.length > 26 ? `${n.node.name.slice(0, 25)}…` : n.node.name
        const width = ctx.measureText(label).width
        const ly = y + r + 4
        ctx.fillStyle = 'rgba(23,13,22,0.72)'
        ctx.fillRect(x - width / 2 - 3, ly - 1, width + 6, 15)
        ctx.fillStyle = isSelected ? HIGHLIGHT : '#ECE8DF'
        ctx.fillText(label, x, ly)
      }
      // 连线拖拽中的预览线：画在最上层，虚线，让人知道「松手就连上」
      const linking = linkRef.current
      if (linking.from) {
        const source = sim.nodes.get(linking.from)
        if (source) {
          const [sx, sy] = toScreen(source.x, source.y)
          ctx.setLineDash([5, 4])
          ctx.lineWidth = 1.6
          ctx.strokeStyle = HIGHLIGHT
          ctx.globalAlpha = 0.9
          ctx.beginPath()
          ctx.moveTo(sx, sy)
          ctx.lineTo(linking.x, linking.y)
          ctx.stroke()
          ctx.setLineDash([])
        }
      }
      ctx.globalAlpha = 1

      // 还在动（物理未收敛 / 正在拖拽）就继续跑；否则画完被要求的一帧后睡觉
      const active = sim.alpha > 0.004 || dragRef.current.mode !== 'none'
      if (active || needsRenderRef.current) {
        needsRenderRef.current = false
        rafRef.current = requestAnimationFrame(step)
      } else {
        rafRef.current = 0
      }
    }

    wakeRef.current()
    return () => {
      wakeRef.current = () => {}
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---------------- 命中测试 ---------------- */
  const hitTest = (sx: number, sy: number): SimNode | null => {
    const list = [...simRef.current.nodes.values()]
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i]
      const [x, y] = toScreen(n.x, n.y)
      const r = Math.max(4, n.r * Math.min(viewRef.current.scale, 1.8)) + 4
      if ((sx - x) ** 2 + (sy - y) ** 2 <= r * r) return n
    }
    return null
  }

  const localPoint = (event: React.MouseEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return [event.clientX - rect.left, event.clientY - rect.top]
  }

  /* ---------------- 交互 ---------------- */
  const onMouseDown = (event: React.MouseEvent): void => {
    const [sx, sy] = localPoint(event)
    const hit = hitTest(sx, sy)
    if (hit && (event.metaKey || event.shiftKey || event.altKey)) {
      /*
       * ⌘/Shift/Alt 从节点上拖走 = 连线，松手落在另一个节点上才成立。
       * 刻意**不钉住**节点：这个手势表达的是「这两篇有关系」，不是「把它挪到这儿」。
       */
      dragRef.current = { mode: 'link', id: hit.id, sx, sy }
      linkRef.current = { from: hit.id, x: sx, y: sy }
      if (canvasRef.current) canvasRef.current.style.cursor = 'crosshair'
    } else if (hit) {
      hit.pinned = true
      dragRef.current = { mode: 'node', id: hit.id, sx, sy }
      simRef.current.alpha = Math.max(simRef.current.alpha, 0.35)
    } else {
      dragRef.current = { mode: 'pan', sx, sy }
    }
    wakeRef.current()
  }

  const onMouseMove = (event: React.MouseEvent): void => {
    const [sx, sy] = localPoint(event)
    const drag = dragRef.current

    if (drag.mode === 'link') {
      linkRef.current.x = sx
      linkRef.current.y = sy
      // 悬到别的节点上就点亮它，落点是否可连一眼可见
      const hit = hitTest(sx, sy)
      hoverRef.current = hit && hit.id !== drag.id ? hit.id : null
      wakeRef.current()
      return
    }

    if (drag.mode === 'node' && drag.id) {
      const node = simRef.current.nodes.get(drag.id)
      if (node) {
        const [wx, wy] = toWorld(sx, sy)
        node.x = wx
        node.y = wy
        node.vx = 0
        node.vy = 0
      }
      return
    }

    if (drag.mode === 'pan') {
      const view = viewRef.current
      view.tx += sx - drag.sx
      view.ty += sy - drag.sy
      drag.sx = sx
      drag.sy = sy
      return
    }

    const hit = hitTest(sx, sy)
    const next = hit?.id ?? null
    if (next !== hoverRef.current) {
      hoverRef.current = next
      if (canvasRef.current) canvasRef.current.style.cursor = next ? 'pointer' : 'default'
      wakeRef.current()
    }
  }

  const onMouseUp = (event: React.MouseEvent): void => {
    const drag = dragRef.current
    const [sx, sy] = localPoint(event)
    if (drag.mode === 'link' && drag.id) {
      const hit = hitTest(sx, sy)
      // 落回自己身上 / 落空 = 取消，不弹任何东西
      if (hit && hit.id !== drag.id) onLinkRequest?.(drag.id, hit.id)
      linkRef.current = { from: null, x: 0, y: 0 }
      hoverRef.current = null
      if (canvasRef.current) canvasRef.current.style.cursor = 'default'
    } else if (drag.mode === 'node' && drag.id) {
      // 没怎么移动就当作点击
      if (Math.abs(sx - drag.sx) < 3 && Math.abs(sy - drag.sy) < 3) {
        onSelect(drag.id, event.metaKey || event.shiftKey)
      } else {
        const node = simRef.current.nodes.get(drag.id)
        if (node) node.pinned = false
      }
    } else if (drag.mode === 'pan') {
      if (Math.abs(sx - drag.sx) < 3 && Math.abs(sy - drag.sy) < 3) onSelect(null)
    }
    dragRef.current = { mode: 'none', sx: 0, sy: 0 }
  }

  const onDoubleClick = (event: React.MouseEvent): void => {
    const [sx, sy] = localPoint(event)
    const hit = hitTest(sx, sy)
    if (hit?.node.kind === 'paper' && hit.node.paperId && onOpenPaper) {
      onOpenPaper(hit.node.paperId)
    }
  }

  const onWheel = (event: React.WheelEvent): void => {
    event.preventDefault()
    const [sx, sy] = localPoint(event)
    const view = viewRef.current
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
    const next = Math.max(0.15, Math.min(4, view.scale * factor))
    // 以光标为中心缩放
    const { w, h } = sizeRef.current
    const cx = sx - w / 2 - view.tx
    const cy = sy - h / 2 - view.ty
    view.tx -= cx * (next / view.scale - 1)
    view.ty -= cy * (next / view.scale - 1)
    view.scale = next
    wakeRef.current()
  }

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
      />
    </div>
  )
}

/** 画布右下角的图例 */
export function GraphLegend({
  kinds,
  links = []
}: {
  kinds: { kind: EntityKind; label: string }[]
  /** 论文关系类型：只传图里**实际出现**的，免得列一排没有的东西 */
  links?: { type: PaperLinkType; label: string }[]
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-low">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-[#ECE8DF]" />
        论文
      </span>
      {links.map((l) => (
        <span key={l.type} className="flex items-center gap-1.5">
          {/* 关系是「边」，所以用线段色块而不是圆点，和节点区分开 */}
          <span
            className="inline-block h-[3px] w-4 rounded-full"
            style={{ background: LINK_TYPE_COLOR[l.type] }}
          />
          {l.label}
        </span>
      ))}
      {kinds.map((k) => (
        <span key={k.kind} className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: ENTITY_KIND_COLOR[k.kind] }}
          />
          {k.label}
        </span>
      ))}
    </div>
  )
}
