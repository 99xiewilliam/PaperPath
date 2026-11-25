import { useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { PANEL_LIMITS, usePanelStore, type PanelId } from '@/store/usePanelStore'

const LABELS: Record<PanelId, string> = {
  sidebar: '侧栏宽度',
  list: '论文列表宽度'
}

/**
 * 面板之间的拖拽调宽把手。
 *
 * 结构上是一个 `w-0` 的占位元素，插在「固定宽面板 | flex-1 主区」的接缝上：
 * 占位本身不占布局，视觉上的分界线仍然是面板自己的 hairline 边框——
 * 静止时整个把手完全隐形，只有一根 14px 宽、跨在接缝两侧的命中区。
 * 悬停时分界线亮成松绿，拖动中给出实时像素数。
 *
 * 交互细节：
 *   - `setPointerCapture` + window 监听：拖进 PDF 阅读器 / 图谱 WebGL 画布
 *     上方也不会被它们的事件处理截胡（pdf.js 的文本层会自己抢 pointer）；
 *   - 拖动期间 body 挂 `panel-resizing` 类（styles.css）：全局锁 col-resize
 *     光标 + 禁止文本选择，松手恢复；
 *   - 双击回到默认宽度；键盘 ←/→ ±16px（Shift ±1px）、Home 重置。
 */
export function Resizer({ id }: { id: PanelId }): JSX.Element {
  const width = usePanelStore((s) => s.widths[id])
  const setWidth = usePanelStore((s) => s.setWidth)
  const [dragging, setDragging] = useState(false)
  const limits = PANEL_LIMITS[id]

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startWidth = width
    setDragging(true)
    document.body.classList.add('panel-resizing')

    const move = (ev: PointerEvent): void => {
      // 左栏、右栏通用：把手都在面板的外侧边缘上，向面板方向拖 = 变宽
      setWidth(id, startWidth + (ev.clientX - startX))
    }
    const up = (): void => {
      setDragging(false)
      document.body.classList.remove('panel-resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={LABELS[id]}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setWidth(id, limits.default)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          const step = (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 1 : 16)
          setWidth(id, width + step)
        } else if (e.key === 'Home') {
          e.preventDefault()
          setWidth(id, limits.default)
        }
      }}
      className={cn(
        'group relative w-0 shrink-0 cursor-col-resize touch-none outline-offset-2',
        dragging ? 'z-[120]' : 'z-10'
      )}
    >
      {/* 命中区：跨在接缝两侧各 7px，静止时透明、不拦截滚轮，不占布局 */}
      <span className="absolute inset-y-0 left-1/2 w-[14px] -translate-x-1/2" />
      {/* 分界线：悬停亮起、拖动加宽，松手回落到面板自己的 hairline */}
      <span
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 rounded-full transition-colors',
          dragging
            ? 'bg-brand-soft shadow-[0_0_8px_rgba(116,172,143,0.45)]'
            : 'bg-transparent group-hover:bg-brand-soft/60'
        )}
      />
      {dragging ? (
        <span className="pointer-events-none absolute left-1/2 top-7 z-[121] -translate-x-1/2 rounded-md border border-line bg-bg-overlay px-1.5 py-0.5 font-mono text-caption tabular-nums text-ink-mid shadow-lg">
          {width}px
        </span>
      ) : null}
    </div>
  )
}
