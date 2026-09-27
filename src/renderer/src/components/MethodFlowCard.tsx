import { useMemo } from 'react'
import { Workflow } from 'lucide-react'
import { layoutMethodFlow, type MethodFlow } from '@shared/flow'
import { cn } from '@/lib/utils'
import { HoverTip } from './ui'

/** 跨层走竖向三次贝塞尔；同层（y 相等）自然退化成一条横线 */
function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const midY = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`
}

/**
 * 方法流程图。
 *
 * 用 SVG + `foreignObject` 而不是 canvas：文字换行、圆角、配色全部交给 CSS 与主题，
 * 深色模式下不用另写一套（canvas 得自己算每一行宽高，本项目已经有一个 canvas 图谱了，
 * 那个是必要的，这里没有必要）。
 *
 * 布局是 shared/flow.ts 里的纯函数，这个组件只负责画 —— 所以「节点会不会重叠 /
 * 环会不会死循环」这些都能在脚本里直接测，不用启动界面。
 */
export function MethodFlowCard({
  flow,
  className
}: {
  flow: MethodFlow
  className?: string
}): JSX.Element {
  const layout = useMemo(() => layoutMethodFlow(flow), [flow])

  return (
    <div className={cn('rounded-xl border border-line bg-bg-raised p-3', className)}>
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-low">
        <Workflow className="h-3 w-3 shrink-0" />
        <span className="text-ink-mid">方法流程{flow.title ? ` · ${flow.title}` : ''}</span>
        {/*
          必须写明这是重绘、以及依据在哪 —— 初学者分不清「原文说的」和「模型画的」，
          一张幻觉的框架图会被当成知识背下来。
        */}
        <span className="ml-auto">AI 重绘，非原文；每个节点标了出处</span>
      </div>

      <div className="overflow-x-auto">
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="block"
          role="img"
          aria-label={`方法流程图：${flow.title ?? flow.nodes.map((n) => n.label).join(' → ')}`}
        >
          <defs>
            <marker
              id="pv-flow-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" className="text-ink-low" />
            </marker>
          </defs>

          {layout.edges.map((edge) => (
            <g key={`${edge.from}->${edge.to}`}>
              <path
                d={edgePath(edge.x1, edge.y1, edge.x2, edge.y2)}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.4}
                className="text-ink-low"
                markerEnd="url(#pv-flow-arrow)"
              />
              {edge.label ? (
                <text
                  x={(edge.x1 + edge.x2) / 2}
                  y={(edge.y1 + edge.y2) / 2 + 3}
                  textAnchor="middle"
                  className="fill-ink-low text-[9.5px]"
                >
                  {edge.label}
                </text>
              ) : null}
            </g>
          ))}

          {layout.nodes.map((node) => (
            <foreignObject
              key={node.id}
              x={node.x}
              y={node.y}
              width={node.w}
              height={node.h}
            >
              {/*
                节点正文按固定高度截断（布局要稳），完整内容悬停时浮出来 ——
                节点里那两行常常只剩半句，而「这半句到底是什么」正是读图时最常卡住的地方。
              */}
              <HoverTip
                className="flex h-full w-full flex-col justify-center overflow-hidden rounded-lg border border-brand/40 bg-brand/[0.08] px-2 py-1.5"
                content={
                  <>
                    <div className="font-medium text-ink-high">{node.label}</div>
                    {node.note ? (
                      <div className="mt-1.5 text-[11.5px] text-ink-mid">{node.note}</div>
                    ) : null}
                    {node.source ? (
                      <div className="mt-1.5 font-mono text-[10.5px] text-brand-mist">
                        出处：{node.source}
                      </div>
                    ) : null}
                  </>
                }
              >
                <div className="line-clamp-2 text-[11.5px] font-medium leading-snug text-ink-high">
                  {node.label}
                </div>
                {node.note ? (
                  <div className="mt-0.5 line-clamp-1 text-[10px] text-ink-low">{node.note}</div>
                ) : null}
                {node.source ? (
                  <div className="mt-0.5 font-mono text-[9.5px] text-brand-mist">{node.source}</div>
                ) : null}
              </HoverTip>
            </foreignObject>
          ))}
        </svg>
      </div>
    </div>
  )
}
