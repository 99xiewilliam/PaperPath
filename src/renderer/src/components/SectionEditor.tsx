import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  Library,
  Pencil,
  PenLine,
  Quote,
  RotateCw
} from 'lucide-react'
import { extractPhraseCandidates } from '@shared/phrases'
import { isSectionFilled, sectionGroup, sectionHint } from '@shared/template'
import { cn, errorMessage } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
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
  /** 刚复制成功的动作（1.4 秒后复位）：图标打个勾，比每次弹 toast 轻 */
  const [justCopied, setJustCopied] = useState<'phrases' | 'section' | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const group = sectionGroup(sectionKey)
  const hint = sectionHint(sectionKey)
  const filled = isSectionFilled(sectionKey, content)
  /*
   * 这一节里可以直接拿去用的句式。
   *
   * 复用句式库那套抽取规则（@shared/phrases），**不另写一套** ——
   * 两套规则迟早会漂移，表现成「复制按钮说有 3 条，句式库里却是 5 条」，
   * 而用户没有理由判断该信哪个。
   */
  const phrases = useMemo(
    () => extractPhraseCandidates({ [sectionKey]: content }),
    [sectionKey, content]
  )

  const flashCopied = (what: 'phrases' | 'section'): void => {
    setJustCopied(what)
    setTimeout(() => setJustCopied((cur) => (cur === what ? null : cur)), 1400)
  }

  const copy = async (text: string, what: 'phrases' | 'section'): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      flashCopied(what)
    } catch (err) {
      useAppStore.getState().toast(`复制失败：${errorMessage(err)}`, 'error')
    }
  }

  /*
   * 跨论文的句式收集**不需要在这里「存」**：句式库本来就会自动收录所有
   * 「写作手法 · X」里的句式（见 shared/phrases.ts 头注）。这里只需要把人送过去，
   * 于是这件事从「多一个需要维护的存储」变成了一个链接。
   */
  const gotoPhraseBank = (): void => {
    // 句式库不再是独立页面，改成打开「写作思路」的第三个分区
    useAppStore.getState().openWritingTab('phrases')
  }

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
        open
          ? 'border-line bg-bg-raised'
          : 'border-transparent bg-white/[0.02] hover:bg-white/[0.04]'
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
          <span className="truncate text-ui font-medium text-ink-high">{sectionKey}</span>
          <span className={cn('shrink-0 text-caption', GROUP_STYLE[group])}>{group}</span>
          {!filled ? <span className="shrink-0 text-caption text-ink-low">空白</span> : null}
          {!open && filled ? (
            <span className="min-w-0 flex-1 truncate text-meta text-ink-low">
              {content.replace(/\s+/g, ' ').slice(0, 90)}
            </span>
          ) : null}
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          {/*
            只留**一个**常显按钮，而且是带条数的那个（`❝ 3`）。
            原来这里是两个复制图标并排 ——「复制句式」和「复制整节」，
            图标都是复制的意思，摆在相邻位置谁也分不清谁。
            带数字就没歧义了：引号 + 3 条，点击即拿走。
            整节复制属于低频动作（要整节不如直接看笔记文件），降进悬停组。
          */}
          {filled && phrases.length ? (
            <button
              onClick={() => void copy(phrases.map((p) => p.text).join('\n'), 'phrases')}
              title={`复制这 ${phrases.length} 条可复用句式（只取「亮点句式 / 可复用表达」下的内容，已去掉列表符号与包裹的引号）`}
              className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-ink-low transition hover:bg-white/[0.08] hover:text-ink-high"
            >
              {justCopied === 'phrases' ? (
                <Check className="h-3.5 w-3.5 text-ok" />
              ) : (
                <Quote className="h-3.5 w-3.5" />
              )}
              <span className="text-caption tabular-nums">{phrases.length}</span>
            </button>
          ) : null}
          <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
            {filled ? (
              <IconButton
                title="复制这一节的 Markdown 原文"
                onClick={() => void copy(content, 'section')}
              >
                {justCopied === 'section' ? (
                  <Check className="h-3.5 w-3.5 text-ok" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </IconButton>
            ) : null}
            <IconButton
              title="在句式库看全部句式（跨论文汇总，可批量复制与导出）"
              onClick={gotoPhraseBank}
            >
              <Library className="h-3.5 w-3.5" />
            </IconButton>
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
      </div>

      {open ? (
        <div className="px-3 pb-3">
          {hint ? (
            <p className="mb-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-meta leading-relaxed text-ink-low">
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
              className="w-full resize-none rounded-lg border border-line bg-bg-base px-3 py-2 font-mono text-ui leading-relaxed text-ink-high outline-none transition placeholder:text-ink-low focus:border-brand/50"
              style={{ minHeight: 72 }}
            />
          )}
        </div>
      ) : null}
    </div>
  )
}
