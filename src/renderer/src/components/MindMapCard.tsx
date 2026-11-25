import { useMemo } from 'react'
import { Network } from 'lucide-react'
import { layoutMindMap, type MindMap } from '@shared/mindmap'
import { cn } from '@/lib/utils'
import { HoverTip } from './ui'

/** 横向树：从父节点右边中点水平贝塞尔到子节点左边中点 */
function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const midX = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
}

/**
 * 全文思维导图（XMind 式横向树）。
 *
 * 用 SVG + `foreignObject` 而不是 canvas，理由和方法流程卡相同：
 * 文字换行、圆角、配色全部交给 CSS 与主题，深色模式不用另写一套。
 * 布局是 shared/mindmap.ts 里的纯函数，这个组件只负责画。
 */
export function MindMapCard({ map, className }: { map: MindMap; className?: string }): JSX.Element {
  const layout = useMemo(() => layoutMindMap(map), [map])

  return (
    <div className={cn('rounded-xl border border-line bg-bg-raised p-3', className)}>
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ink-low">
        <Network className="h-3 w-3 shrink-0" />
        <span className="text-ink-mid">全文思维导图{map.title ? ` · ${map.title}` : ''}</span>
        {/* 同流程卡：必须写明这是重绘，初学者分不清「原文说的」和「模型画的」 */}
        <span className="ml-auto">AI 重绘，非原文</span>
      </div>

      <div className="overflow-x-auto">
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="block"
          role="img"
          aria-label={`全文思维导图：${map.title ?? map.root.label}`}
        >
          {layout.edges.map((edge) => (
            <path
              key={`${edge.from}->${edge.to}`}
              d={edgePath(edge.x1, edge.y1, edge.x2, edge.y2)}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.4}
              className="text-ink-low"
            />
          ))}

          {layout.nodes.map((node) => (
            <foreignObject key={node.id} x={node.x} y={node.y} width={node.w} height={node.h}>
              {/* 同流程卡：节点等高等宽是为了布局稳，代价是文字被截，用悬停卡片补回来 */}
              <HoverTip
                className={cn(
                  'flex h-full w-full flex-col justify-center overflow-hidden rounded-lg border px-2 py-1.5',
                  node.depth === 0
                    ? 'border-brand/60 bg-brand/[0.16]'
                    : node.depth === 1
                      ? 'border-brand/40 bg-brand/[0.08]'
                      : 'border-line bg-bg-overlay'
                )}
                content={
                  <>
                    <div className="font-medium text-ink-high">{node.label}</div>
                    {node.note ? (
                      <div className="mt-1.5 text-meta text-ink-mid">{node.note}</div>
                    ) : null}
                  </>
                }
              >
                <div
                  className={cn(
                    'line-clamp-2 leading-snug',
                    node.depth <= 1
                      ? 'text-meta font-medium text-ink-high'
                      : 'text-meta text-ink-mid'
                  )}
                >
                  {node.label}
                </div>
                {node.note ? (
                  <div className="mt-0.5 line-clamp-1 text-caption text-ink-low">{node.note}</div>
                ) : null}
              </HoverTip>
            </foreignObject>
          ))}
        </svg>
      </div>
    </div>
  )
}
