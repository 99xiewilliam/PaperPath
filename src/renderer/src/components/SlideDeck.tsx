import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronLeft,
  ChevronRight,
  ImageOff,
  Info,
  Loader2,
  NotebookPen,
  Presentation,
  RotateCw,
  X
} from 'lucide-react'
import { SLIDE_DECK_REVISION } from '@shared/slides'
import type { Slide, SlideDeck as SlideDeckData, SlideExample } from '@shared/slides'
import { categoryColor, categoryLabel } from '@shared/taxonomy'
import type { TaxonomyNode } from '@shared/types'
import { extractTldr } from '@shared/template'
import type { PaperMeta } from '@shared/types'
import { authorLine, cn, errorMessage } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { MethodFlowCard } from './MethodFlowCard'
import { MindMapCard } from './MindMapCard'
import { useFigureUrl } from './MdImage'
import { Button, Chip, IconButton } from './ui'

/**
 * 演示稿的第一页是**封面**：它从笔记的书目信息现拼，不占模型的页数，
 * 也永远不会被「重新生成」改掉 —— 标题、作者、一句话总结这些本来就在笔记里，
 * 让模型再抄一遍只会多一处对不上的地方。
 */
type Page = { kind: 'cover' } | { kind: 'slide'; slide: Slide }

/**
 * 全屏演示：把一篇论文一页页讲给没读过它的人听。
 *
 * 为什么是应用内全屏而不是导出成文件：能直接上台的东西本来就在笔记里 ——
 * 原文、方法流程图、思维导图、一句话总结。导出成 pptx 等于把它们拆散，
 * 而且每改一次笔记就要重导一次。
 *
 * 键盘：`←/→`、`Space`、`PgUp/PgDn` 翻页，`Home/End` 首尾，`P` 切讲稿，`Esc` 退出。
 * 容器带 `role="dialog"`：论文列表的全局方向键处理靠这个选择器判断「有没有弹窗」，
 * 少了它，按 ← → 会同时把背后列表的选中项也挪一遍。
 */
export function SlideDeck({
  paperId,
  meta,
  sections,
  open,
  onClose,
  onGenerated
}: {
  paperId: string
  meta: PaperMeta
  /** 笔记章节，用来取封面上的「一句话总结」 */
  sections: Record<string, string>
  open: boolean
  onClose: () => void
  /** 新演示稿已在主进程落盘（frontmatter），这里只同步渲染层的本地 meta */
  onGenerated: (deck: SlideDeckData) => void
}): JSX.Element | null {
  const toast = useAppStore((s) => s.toast)
  const customCategories = useAppStore((s) => s.settings.customCategories)
  const [index, setIndex] = useState(0)
  const [showNotes, setShowNotes] = useState(false)
  const [generating, setGenerating] = useState(false)

  const deck = meta.slides
  const pages = useMemo<Page[]>(
    () => [
      { kind: 'cover' },
      ...(deck?.slides ?? []).map((slide) => ({ kind: 'slide' as const, slide }))
    ],
    [deck]
  )
  const pageCount = Math.max(1, pages.length)
  const page: Page = pages[Math.min(index, pageCount - 1)] ?? { kind: 'cover' }

  // 每次打开都回到第一页：演示是从头讲的，接着上次那一页容易讲乱
  useEffect(() => {
    if (!open) return
    setIndex(0)
    setShowNotes(false)
  }, [open, paperId])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'p' || e.key === 'P') {
        setShowNotes((v) => !v)
        return
      }
      // 生成中不让翻页：这时候页数还会变，翻了也会被重置
      if (generating) return
      const last = pageCount - 1
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) {
        e.preventDefault()
        setIndex((i) => Math.min(i + 1, last))
        return
      }
      if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) {
        e.preventDefault()
        setIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Home') {
        e.preventDefault()
        setIndex(0)
        return
      }
      if (e.key === 'End') {
        e.preventDefault()
        setIndex(last)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, generating, pageCount, onClose])

  const generate = async (): Promise<void> => {
    if (generating) return
    setGenerating(true)
    try {
      const res = await window.papervault.ai.slides(paperId)
      if (!res.ok || !res.deck) {
        toast(res.message ?? '生成失败', 'error')
        return
      }
      onGenerated(res.deck)
      setIndex(0)
      toast(`演示稿好了，共 ${res.deck.slides.length + 1} 页`, 'success')
    } catch (err) {
      toast(`生成失败：${errorMessage(err)}`, 'error')
    } finally {
      setGenerating(false)
    }
  }

  if (!open) return null

  const currentNote = page.kind === 'slide' ? page.slide.note : undefined
  const showing = Boolean(deck) && !generating
  /*
   * 旧口径生成的稿子没有 revision，所以 0 也算「旧」—— 正好就是要提示的那一批。
   * 讲稿是持久化的，改了口径它不会自动变好，只能明说让用户重新生成，
   * 否则表现就是「新功能没生效」。
   */
  const stale = (deck?.revision ?? 0) < SLIDE_DECK_REVISION

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="论文演示"
      className="fixed inset-0 z-[85] flex flex-col bg-bg-base"
    >
      {/* 顶部进度条：投影时远远看一眼就知道讲到哪了 */}
      <div className="h-1 shrink-0 bg-white/[0.06]">
        <div
          className="h-full bg-brand transition-all"
          style={{ width: showing ? `${((index + 1) / pageCount) * 100}%` : '0%' }}
        />
      </div>

      <div className="flex shrink-0 items-center gap-3 px-5 py-3">
        <Presentation className="h-4 w-4 shrink-0 text-brand-mist" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-mid">{meta.title}</span>
        {showing ? (
          <>
            <span className="shrink-0 font-mono text-[11.5px] text-ink-low">
              {index + 1} / {pageCount}
            </span>
            <IconButton
              title={showNotes ? '隐藏讲稿（P）' : '显示讲稿（P）'}
              active={showNotes}
              onClick={() => setShowNotes((v) => !v)}
            >
              <NotebookPen className="h-4 w-4" />
            </IconButton>
            <Button
              variant="ghost"
              size="sm"
              icon={<RotateCw className="h-3.5 w-3.5" />}
              onClick={() => void generate()}
            >
              重新生成
            </Button>
          </>
        ) : null}
        <IconButton title="退出演示（Esc）" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>

      {showing && stale ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-warn/30 bg-warn/[0.08] px-5 py-2 text-[11.5px] leading-relaxed text-warn">
          <Info className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            这份讲稿是较早版本生成的：那时流程图还由讲稿顺手画、经常画不出来。
            点右上角「重新生成」，新稿会先照原文画好方法流程图再开讲。
          </span>
        </div>
      ) : null}

      {generating ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <Loader2 className="h-5 w-5 animate-spin text-brand-soft" />
          <p className="text-[12.5px] text-ink-mid">
            没有现成流程图时会先照原文画一张，再通读原文组织讲法（两步都要读原文，比摘要慢一些）
          </p>
        </div>
      ) : !deck ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-8">
          <div className="max-w-lg text-center">
            <Presentation className="mx-auto h-8 w-8 text-brand-mist" />
            <h2 className="mt-4 text-[18px] font-semibold text-ink-high">把这篇论文讲给别人听</h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-mid">
              AI 会按「为什么值得听 → 要解决什么问题 → 别人差在哪 → 我们怎么做 → 关键证据 →
              边界与局限」拆成 8~12 页，每页给要点和一句口播讲稿。
            </p>
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-low">
              讲稿存进笔记里，生成一次可以反复翻；还没有方法流程图时会先照原文画一张，
              连同思维导图一起搬上台。
            </p>
            <div className="mt-5 flex justify-center">
              <Button
                variant="primary"
                icon={<Presentation className="h-3.5 w-3.5" />}
                onClick={() => void generate()}
              >
                生成演示
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-4">
          <div className="mx-auto flex min-h-full max-w-4xl flex-col justify-center">
            {page.kind === 'cover' ? (
              <Cover
                meta={meta}
                tldr={extractTldr(sections)}
                audience={deck.audience}
                customCategories={customCategories}
              />
            ) : (
              <SlideBody slide={page.slide} meta={meta} />
            )}
          </div>
        </div>
      )}

      {showing && showNotes ? (
        <div className="shrink-0 border-t border-line bg-bg-raised px-8 py-3">
          <div className="mx-auto max-w-4xl">
            <p className="text-[10.5px] font-medium uppercase tracking-wider text-ink-low">讲稿</p>
            <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-mid">
              {currentNote ?? '（这一页没有讲稿）'}
            </p>
          </div>
        </div>
      ) : null}

      {showing ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-5 py-3">
          <span className="text-[11px] text-ink-low">
            ← → 翻页 · Home / End 首尾 · P 讲稿 · Esc 退出
          </span>
          <div className="flex items-center gap-2">
            <Button
              icon={<ChevronLeft className="h-3.5 w-3.5" />}
              disabled={index === 0}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
            >
              上一页
            </Button>
            <Button
              variant="primary"
              disabled={index >= pageCount - 1}
              onClick={() => setIndex((i) => Math.min(pageCount - 1, i + 1))}
            >
              下一页
              <ChevronRight className="ml-0.5 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>,
    document.body
  )
}

/** 封面：书目信息 + 一句话总结 + 这份演示面向谁 */
function Cover({
  meta,
  tldr,
  audience,
  customCategories
}: {
  meta: PaperMeta
  tldr: string
  audience?: string
  customCategories: TaxonomyNode[]
}): JSX.Element {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {meta.categories.map((id) => (
          <Chip key={id} color={categoryColor(id, customCategories)}>
            {categoryLabel(id, customCategories)}
          </Chip>
        ))}
      </div>
      <h1 className="mt-4 font-serif text-[30px] font-semibold leading-snug text-ink-high">{meta.title}</h1>
      <p className="mt-3 text-[13px] text-ink-mid">
        {[authorLine(meta.authors), meta.year, meta.venue].filter(Boolean).join(' · ')}
      </p>
      {tldr ? (
        <p className="mt-6 border-l-2 border-brand/50 pl-4 text-[16px] leading-relaxed text-ink-high">
          {tldr}
        </p>
      ) : null}
      {audience ? <p className="mt-6 text-[12.5px] text-ink-low">{audience}</p> : null}
      <p className="mt-8 text-[11.5px] text-ink-low">按 → 开始讲</p>
    </div>
  )
}

/** 一页正文：标题 + 画面（流程图 / 思维导图 / 原文图）+ 具体例子 + 要点 + 出处 */
function SlideBody({ slide, meta }: { slide: Slide; meta: PaperMeta }): JSX.Element {
  /*
   * 画面页优先用论文里已有的那张。`visual` 在生成时已经确认过库里有没有
   * （见 pruneSlideVisuals），这里再兜一层：老笔记的 frontmatter 可能带着
   * 一个当时有效、后来维度被重跑掉的 visual。
   */
  const visual = slide.visual
  /*
   * 流程图两条来源：这一页自带的（论文没跑过方法维度，模型照原文现画的），
   * 或者笔记里那张现成的（更好，逐节点带出处）。自带优先 —— 它是为这一页画的。
   */
  const flow = visual === 'flow' ? slide.flow ?? meta.flow : undefined
  const showFlow = Boolean(flow)
  const showMindMap = visual === 'mindmap' && meta.mindmap
  const showFigure = visual === 'figure' && slide.figure
  const hasVisual = Boolean(showFlow || showMindMap || showFigure)

  return (
    <div>
      <h2 className="font-serif text-[26px] font-semibold leading-snug text-ink-high">{slide.title}</h2>

      {showFlow ? (
        <div className="mt-5">
          <MethodFlowCard flow={flow!} />
        </div>
      ) : null}
      {showMindMap ? (
        <div className="mt-5">
          <MindMapCard map={meta.mindmap!} />
        </div>
      ) : null}
      {showFigure ? (
        <div className="mt-5">
          <FigureCanvas relPath={slide.figure!} />
        </div>
      ) : null}
      {slide.example ? (
        <div className="mt-5">
          <ExampleWalkthrough example={slide.example} />
        </div>
      ) : null}

      {slide.bullets.length ? (
        <ul className={cn('space-y-3', hasVisual || slide.example ? 'mt-5' : 'mt-6')}>
          {slide.bullets.map((bullet, i) => (
            <li key={i} className="flex gap-3 text-[16px] leading-relaxed text-ink-high">
              <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand-soft" />
              <span>{bullet}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {slide.source ? (
        <p className="mt-5 font-mono text-[11.5px] text-brand-mist">出处：{slide.source}</p>
      ) : null}
    </div>
  )
}

/**
 * 具体例子：输入 → 几步 → 输出。
 *
 * 单独一套版面而不是混进要点列表：讲解系统时，「一堆抽象要点」和
 * 「拿一个具体输入走一遍」是两种认知，后者才让人真的看懂 —— 版面得跟着分开。
 */
function ExampleWalkthrough({ example }: { example: SlideExample }): JSX.Element {
  return (
    <div>
      <div className="rounded-xl border border-brand/40 bg-brand/[0.08] px-4 py-3">
        <p className="text-[10.5px] font-medium uppercase tracking-wider text-brand-mist">输入</p>
        <p className="mt-1 text-[15px] leading-relaxed text-ink-high">{example.input}</p>
      </div>

      <ol className="my-3 space-y-2.5 border-l border-line pl-6">
        {example.steps.map((step, i) => (
          <li key={i} className="relative text-[15px] leading-relaxed text-ink-high">
            <span className="absolute -left-[32px] flex h-5 w-5 items-center justify-center rounded-full border border-brand/40 bg-bg-base font-mono text-[10.5px] text-brand-mist">
              {i + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>

      {example.output ? (
        <div className="rounded-xl border border-ok/40 bg-ok/[0.06] px-4 py-3">
          <p className="text-[10.5px] font-medium uppercase tracking-wider text-ok">输出</p>
          <p className="mt-1 text-[15px] leading-relaxed text-ink-high">{example.output}</p>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 演示里的原文图（用户从 PDF 上截下来的）。
 *
 * 走 `useFigureUrl` 的共享缓存：同一张图在笔记里已经读过一次，这里不再走一遍 IPC，
 * 也不会另造一个 object URL —— 缓存就是为「同一张图在多处显示」准备的（见 MdImage）。
 */
function FigureCanvas({ relPath }: { relPath: string }): JSX.Element {
  const { url, failed } = useFigureUrl(relPath)

  if (failed) {
    return (
      <p className="flex items-center gap-2 rounded-xl border border-line bg-bg-raised px-4 py-6 text-[12.5px] text-ink-low">
        <ImageOff className="h-4 w-4 shrink-0" />
        这张图找不到了：{relPath}（可能已被删除）
      </p>
    )
  }
  if (!url) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-brand-soft" />
      </div>
    )
  }
  return (
    <img
      src={url}
      alt={relPath}
      className="mx-auto max-h-[52vh] rounded-lg border border-line bg-white object-contain"
    />
  )
}
