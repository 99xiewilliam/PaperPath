import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Eye, Pencil, PenLine, RotateCw } from 'lucide-react'
import { isSectionFilled, sectionGroup, sectionHint } from '@shared/template'
import { cn } from '@/lib/utils'
import { Markdown } from './Markdown'
import { IconButton } from './ui'

const GROUP_STYLE: Record<string, string> = {
  速览: 'text-info',
  方法拆解: 'text-ok',
  写作拆解: 'text-brand-mist',
  语言积累: 'text-warn',
  实验沉淀: 'text-accent',
  延伸: 'text-ink-mid'
}

export function SectionEditor({
  sectionKey,
  content,
  onChange,
  onRewrite,
  rewriting,
  defaultOpen = false,
  imageBase,
  onCaretChange
}: {
  sectionKey: string
  content: string
  onChange: (value: string) => void
  onRewrite: () => void
  rewriting?: boolean
  defaultOpen?: boolean
  /** 笔记所在目录（相对知识库根），用于解析正文里图片的相对路径 */
  imageBase?: string
  /** 光标 / 焦点位置变化时上报；「插入到光标处」靠它记住落点 */
  onCaretChange?: (position: number) => void
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  /*
   * 默认渲染 Markdown，而不是直接摊开源文。
   *
   * 这些章节的内容绝大多数是 AI 精读写进来的，默认该看到的是「笔记」，
   * 而不是满屏 `**加粗**`、`- ` 记号；要改再点标题行右侧的铅笔切到编辑态。
   * 内容本身始终按原文存，这里只影响默认怎么显示。
   */
  const [preview, setPreview] = useState(true)
  const ref = useRef<HTMLTextAreaElement>(null)
  const group = sectionGroup(sectionKey)
  const hint = sectionHint(sectionKey)
  const filled = isSectionFilled(sectionKey, content)

  useEffect(() => {
    const el = ref.current
    if (!el || !open || preview) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(72, el.scrollHeight)}px`
  }, [content, open, preview])

  return (
    <div
      className={cn(
        'group rounded-xl border transition',
        open ? 'border-line bg-bg-raised' : 'border-transparent bg-white/[0.02] hover:bg-white/[0.04]'
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-low" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-low" />
          )}
          <span className="truncate text-[12.5px] font-medium text-ink-high">{sectionKey}</span>
          <span className={cn('shrink-0 text-[10px]', GROUP_STYLE[group])}>{group}</span>
          {!filled ? <span className="shrink-0 text-[10px] text-ink-low">空白</span> : null}
          {!open && filled ? (
            <span className="min-w-0 flex-1 truncate text-[11px] text-ink-low">
              {content.replace(/\s+/g, ' ').slice(0, 90)}
            </span>
          ) : null}
        </button>

        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
          <IconButton
            title={preview ? '编辑' : '预览渲染效果'}
            onClick={() => {
              setOpen(true)
              setPreview((v) => !v)
            }}
            active={preview}
          >
            {preview ? <Pencil className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </IconButton>
          <IconButton title="用 AI 重写这一节" onClick={onRewrite} disabled={rewriting}>
            {rewriting ? (
              <RotateCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <PenLine className="h-3.5 w-3.5" />
            )}
          </IconButton>
        </div>
      </div>

      {open ? (
        <div className="px-3 pb-3">
          {hint ? (
            <p className="mb-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-[11px] leading-relaxed text-ink-low">
              {hint}
            </p>
          ) : null}
          {preview ? (
            <div className="min-h-[72px] rounded-lg border border-line bg-bg-base px-3 py-2">
              <Markdown content={content || '_（这一节还是空的）_'} imageBase={imageBase} />
            </div>
          ) : (
            <textarea
              ref={ref}
              value={content}
              spellCheck={false}
              onChange={(e) => {
                onChange(e.target.value)
                onCaretChange?.(e.target.selectionStart)
              }}
              onSelect={(e) => onCaretChange?.(e.currentTarget.selectionStart)}
              onFocus={(e) => onCaretChange?.(e.currentTarget.selectionStart)}
              placeholder="用 Markdown 记录…"
              className="w-full resize-none rounded-lg border border-line bg-bg-base px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink-high outline-none transition placeholder:text-ink-low focus:border-brand/50"
              style={{ minHeight: 72 }}
            />
          )}
        </div>
      ) : null}
    </div>
  )
}
