import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, CheckCircle2, AlertTriangle, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'

/* -------------------------------- Button -------------------------------- */

type ButtonVariant = 'primary' | 'subtle' | 'ghost' | 'danger' | 'outline'
type ButtonSize = 'xs' | 'sm' | 'md'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: React.ReactNode
}

const VARIANTS: Record<ButtonVariant, string> = {
  /*
   * primary 用「同色系竖向渐变 + 顶部内高光 + 底部一像素投影」——
   * 纯平色块配大圆角是玩具感来源之一，一点竖向光影就是实体按键的手感。
   * 刻意不做斜向 / 双色渐变：那是最典型的消费级 App 味。
   *
   * 松绿底配象牙字：深绿上放纸色字（约 5.5:1），是紫底书房里
   * 「墨绿书封上烫象牙字」的样子，也是全界面唯一的实色动作块。
   */
  primary: 'btn-primary disabled:opacity-40',
  subtle:
    'bg-white/[0.07] text-ink-high hover:bg-white/[0.11] border border-line shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
  ghost: 'text-ink-mid hover:text-ink-high hover:bg-white/[0.06]',
  danger: 'bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25',
  outline: 'border border-line text-ink-mid hover:text-ink-high hover:border-strong'
}

const SIZES: Record<ButtonSize, string> = {
  xs: 'h-6 px-2 text-meta gap-1 rounded-md',
  sm: 'h-8 px-2.5 text-ui gap-1.5 rounded-lg',
  md: 'h-9 px-3.5 text-body gap-2 rounded-lg'
}

export function Button({
  variant = 'subtle',
  size = 'sm',
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {children}
    </button>
  )
}

export function IconButton({
  title,
  className,
  children,
  active,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean
}): JSX.Element {
  return (
    <button
      {...rest}
      title={title}
      className={cn(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors',
        active
          ? 'bg-brand/20 text-brand-mist'
          : 'text-ink-low hover:bg-white/[0.08] hover:text-ink-high',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className
      )}
    >
      {children}
    </button>
  )
}

/* --------------------------------- Chip --------------------------------- */

export function Chip({
  children,
  color,
  className,
  onClick,
  active,
  title
}: {
  children: React.ReactNode
  color?: string
  className?: string
  onClick?: () => void
  active?: boolean
  title?: string
}): JSX.Element {
  const style = color
    ? {
        color,
        borderColor: active ? color : `${color}44`,
        background: active ? `${color}26` : `${color}12`
      }
    : undefined
  return (
    <span
      title={title}
      onClick={onClick}
      style={style}
      className={cn(
        'chip whitespace-nowrap transition',
        color ? '' : active ? 'border-brand/50 bg-brand/20 text-brand-mist' : 'text-ink-mid',
        onClick && 'cursor-pointer hover:brightness-125',
        className
      )}
    >
      {children}
    </span>
  )
}

/* --------------------------------- Modal -------------------------------- */

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 'max-w-2xl'
}: {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  subtitle?: React.ReactNode
  children?: React.ReactNode
  footer?: React.ReactNode
  width?: string
}): JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  /*
   * role="dialog" + aria-modal 不只是给读屏软件用的：
   * PaperList 的全局方向键处理靠 `[role="dialog"]` 判断「当前有没有弹窗」，
   * 免得在弹窗里按 Esc 时把列表的选择集一起清掉。
   */
  return createPortal(
    /*
     * 这里刻意**不用** backdrop-blur。
     *
     * 这是一层铺满全屏的遮罩，一旦带上 backdrop-filter，它就成了一个覆盖整窗的
     * backdrop root；而弹窗内部/上方还有 `animate-spin` 这类每帧都在动的内容
     *（忙碌胶囊顶部那条同理），合成器只能每帧重新光栅化整块底图 —— 表现就是
     * 「精读时整个窗口一直在抽搐」，CPU 还看不出异常（不是 JS 在跑，是重绘）。
     * 用不透明的压暗代替模糊，观感几乎一致，但重绘成本从「每帧全窗」降到「零」。
     */
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-bg-sunken/80 p-8">
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          // 圆角 16→12，边框上强一档，投影改成「大而远」的分层阴影 —— 浮起感来自纵深而不是描边
          'animate-slide-up my-auto w-full rounded-xl border border-strong bg-bg-overlay shadow-[0_24px_70px_-20px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.05)]',
          width
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-ink-high">{title}</h3>
            {subtitle ? <p className="mt-1 text-ui text-ink-mid">{subtitle}</p> : null}
          </div>
          <IconButton title="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body
  )
}

/* ------------------------------ Confirm -------------------------------- */

export interface ConfirmRequest {
  title: React.ReactNode
  description?: React.ReactNode
  confirmLabel?: string
  /** 危险操作（删除等）用红色按钮，默认聚焦在「取消」上 */
  danger?: boolean
}

/**
 * 统一的二次确认弹窗。
 *
 * 之前删除笔记 / 综述用的是浏览器原生 `confirm()`：在 Windows 上完全是系统
 * 默认的样子，和应用里其它弹窗两套观感，而且会阻塞整个渲染线程。
 * 这里复用 `Modal`，保证风格一致。
 *
 * 用法：`const { confirm, dialog } = useConfirm()`，
 * 在 JSX 里渲染一次 `{dialog}`，需要确认时 `await confirm({...})`。
 */
export function useConfirm(): {
  confirm: (request: ConfirmRequest) => Promise<boolean>
  dialog: JSX.Element
} {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const resolver = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback((next: ConfirmRequest): Promise<boolean> => {
    // 上一个还没结算就被再次调用时，先把它当成「取消」，避免 Promise 悬着
    resolver.current?.(false)
    setRequest(next)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const settle = useCallback((ok: boolean) => {
    setRequest(null)
    const resolve = resolver.current
    resolver.current = null
    resolve?.(ok)
  }, [])

  const dialog = (
    <Modal
      open={!!request}
      onClose={() => settle(false)}
      title={request?.title ?? ''}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={() => settle(false)}>
            取消
          </Button>
          <Button variant={request?.danger ? 'danger' : 'primary'} onClick={() => settle(true)}>
            {request?.confirmLabel ?? '确定'}
          </Button>
        </>
      }
    >
      {request?.description ? (
        <p className="text-ui leading-relaxed text-ink-mid">{request.description}</p>
      ) : null}
    </Modal>
  )

  return { confirm, dialog }
}

/* -------------------------------- Fields -------------------------------- */

export function Field({
  label,
  hint,
  children,
  className
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
  className?: string
}): JSX.Element {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-ui font-medium text-ink-mid">{label}</span>
        {hint ? <span className="text-meta text-ink-low">{hint}</span> : null}
      </span>
      {children}
    </label>
  )
}

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-ui text-ink-mid">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-soft" />
      {label}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action
}: {
  icon?: React.ReactNode
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      {icon ? <div className="text-ink-low">{icon}</div> : null}
      <div className="text-[14px] font-medium text-ink-high">{title}</div>
      {description ? (
        <div className="max-w-md text-ui leading-relaxed text-ink-mid">{description}</div>
      ) : null}
      {action}
    </div>
  )
}

/* -------------------------------- Toaster ------------------------------- */

export function Toaster(): JSX.Element {
  const toasts = useAppStore((s) => s.toasts)
  const dismiss = useAppStore((s) => s.dismissToast)

  return createPortal(
    <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-[360px] flex-col gap-2">
      {toasts.map((t) => {
        /*
         * 实底 + 左侧色条：半透明底会让下面的正文透上来和提示文字叠在一起；
         * 颜色只给图标和色条，正文保持象牙色，整段红字读起来很累。
         */
        const tone =
          t.kind === 'error' ? 'text-danger' : t.kind === 'success' ? 'text-ok' : 'text-info'
        const bar = t.kind === 'error' ? 'bg-danger' : t.kind === 'success' ? 'bg-ok' : 'bg-info'
        return (
          <div
            key={t.id}
            onClick={() => dismiss(t.id)}
            className="animate-slide-up pointer-events-auto relative flex cursor-pointer items-start gap-2.5 overflow-hidden rounded-lg border border-strong bg-bg-overlay py-2.5 pl-4 pr-2.5 text-ui text-ink-high shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
          >
            <span className={cn('absolute inset-y-0 left-0 w-[3px]', bar)} />
            {t.kind === 'error' ? (
              <AlertTriangle className={cn('mt-[3px] h-4 w-4 shrink-0', tone)} />
            ) : t.kind === 'success' ? (
              <CheckCircle2 className={cn('mt-[3px] h-4 w-4 shrink-0', tone)} />
            ) : (
              <Info className={cn('mt-[3px] h-4 w-4 shrink-0', tone)} />
            )}
            <span className="min-w-0 flex-1 leading-relaxed">{t.text}</span>
            <X className="mt-[3px] h-3.5 w-3.5 shrink-0 text-ink-low" aria-hidden />
          </div>
        )
      })}
    </div>,
    document.body
  )
}

/* -------------------------------- BusyBar ------------------------------- */

export function BusyOverlay(): JSX.Element | null {
  const busy = useAppStore((s) => s.busy)
  const activeTaskId = useAppStore((s) => s.activeTaskId)
  const cancelTask = useAppStore((s) => s.cancelTask)
  const [cancelling, setCancelling] = useState(false)

  if (!busy) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[90] flex justify-center">
      {/*
       * 胶囊本身不放 backdrop-blur：它浮在上面时，底图里正有 `animate-spin`
       * 在逐帧变化，带 backdrop-filter 会让合成器每帧重新过滤一次（见上面 Modal
       * 的注释）。`bg-bg-overlay/95` 已经接近实色，去掉模糊肉眼几乎看不出差别。
       */}
      <div className="animate-fade-in pointer-events-auto mt-3 flex items-center gap-2.5 rounded-full border border-line bg-bg-overlay/95 px-4 py-2 text-ui text-ink-high shadow-xl">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-soft" />
        <span className="max-w-[52vw] truncate">{busy.label}</span>
        {activeTaskId ? (
          <button
            onClick={() => {
              setCancelling(true)
              void cancelTask().finally(() => setCancelling(false))
            }}
            disabled={cancelling}
            className="ml-1 flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-meta text-ink-mid transition hover:border-strong hover:text-ink-high disabled:opacity-50"
          >
            <X className="h-3 w-3" />
            取消
          </button>
        ) : null}
      </div>
    </div>
  )
}

/* -------------------------------- HoverTip ------------------------------ */

const TIP_WIDTH = 320
const TIP_GAP = 8
const TIP_MARGIN = 12

/**
 * 悬停时把被截断的内容完整浮出来。
 *
 * 用在哪：方法流程图 / 思维导图把节点画在固定尺寸的 `foreignObject` 里，
 * 超出的文字被 `line-clamp` 截掉 —— 这是**有意**的（节点等高，整体布局才稳，
 * 题注长短不一会把图撑得七零八落）。但读者经常卡在「这半句话到底是什么」，
 * 为了看一眼去改布局又不值当，所以悬停时在旁边浮一张完整内容的卡片。
 *
 * 两个实现细节：
 *   - 用 `createPortal` 送到 body：卡片要能越过外层 `overflow-x-auto` 的裁剪
 *     （流程条宽了要横向滚动），portal 是最稳的越界方式；
 *   - 卡片 `pointer-events-none`：否则它会顶在鼠标底下，触发 mouseleave
 *     再 mouseenter，闪成一片。
 */
export function HoverTip({
  content,
  className,
  children
}: {
  /** 悬停时展示的完整内容 */
  content: React.ReactNode
  /** 触发元素自身的类名 */
  className?: string
  children: React.ReactNode
}): JSX.Element {
  const [rect, setRect] = useState<DOMRect | null>(null)

  return (
    <>
      <div
        className={className}
        onMouseEnter={(e) => setRect(e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => setRect(null)}
      >
        {children}
      </div>
      {rect ? createPortal(<TipCard rect={rect}>{content}</TipCard>, document.body) : null}
    </>
  )
}

function TipCard({ rect, children }: { rect: DOMRect; children: React.ReactNode }): JSX.Element {
  const width = Math.min(TIP_WIDTH, window.innerWidth - TIP_MARGIN * 2)
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - width / 2, TIP_MARGIN),
    window.innerWidth - width - TIP_MARGIN
  )
  /*
   * 翻上还是翻下：节点落在窗口下半屏时往上。
   * 160 是卡片高度的粗估 —— 刻意不做「先量再摆」，那会多一帧闪烁。
   */
  const flip = rect.bottom + 160 > window.innerHeight
  return (
    <div
      style={{
        left,
        width,
        maxHeight: '50vh',
        ...(flip
          ? { bottom: window.innerHeight - rect.top + TIP_GAP }
          : { top: rect.bottom + TIP_GAP })
      }}
      className="pointer-events-none fixed z-[95] overflow-y-auto rounded-xl border border-line bg-bg-overlay px-3.5 py-2.5 text-ui leading-relaxed text-ink-high shadow-2xl"
    >
      {children}
    </div>
  )
}
