import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Crop,
  Eye,
  EyeOff,
  GripVertical,
  Hand,
  Highlighter,
  Images,
  Languages,
  Lightbulb,
  List,
  Loader2,
  Maximize2,
  Moon,
  ScanText,
  Send,
  Bot,
  Sun,
  Trash2,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import {
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLORS,
  newHighlightId,
  type Highlight,
  type HighlightRect
} from '@shared/highlights'
import {
  currentPageAt,
  pageOffsets,
  scrollTopForPage,
  visiblePageRange,
  type ReadingPosition,
  type VisibleRange
} from '@shared/pagination'
import type { SourceLine } from '@shared/autohighlight'
import type { PassageAskMode, PassageMode } from '@shared/api'
import type { ChatMessage } from '@shared/types'
import { cn, errorMessage } from '@/lib/utils'
import { loadPdfjs } from '@/lib/pdf'
import { buildPositionedLines, type TextItemLike } from '@/lib/pdfText'
import { useAppStore } from '@/store/useAppStore'
import { Markdown } from './Markdown'
import { FigureLightbox, FigureThumb } from './FigureBoard'
import { useConfirm } from './ui'
import '@/styles/pdf-textlayer.css'

/**
 * 自己用 PDF.js 渲染的阅读器。
 *
 * 为什么不用 Chromium 内置的 PDF 阅读器（iframe / 独立窗口）：它是跑在
 * 独立渲染上下文里的闭源组件，**拿不到文字选区**，也没法往里注入 UI，
 * 等于「选中文字弹出工具栏」这类功能完全做不了。
 *
 * 自己的渲染 = canvas 画版面 + 一层绝对定位的透明文字层，
 * 于是选中的是真实 DOM 文字，能用 window.getSelection() 拿到，
 * 也能算出席选区的精确矩形用于高亮。
 *
 * 连续滚动：整篇 PDF 竖直排成一列，滚动即翻页。但只渲染视口附近的页面
 * （visiblePageRange，窗口外的页只留固定尺寸的占位框）—— 上百页的文档
 * 一次性铺出全部 canvas + 文字层，内存和首屏都会被直接拖垮。
 * 「当前页 / 渲染窗口 / 翻页落点」的数学全在 @shared/pagination 的纯函数里
 * （smoke:pagination 守着），这个组件只负责 DOM 与列坐标之间的换算。
 */

interface Props {
  paperId: string
  highlights: Highlight[]
  onHighlightsChange: (next: Highlight[]) => void
  /** 把片段直接写进笔记草稿（PaperDetail 传入），返回落点章节；不给则只提供复制 */
  onInsertToNote?: (markdown: string) => string
}

interface SelectionInfo {
  /** 选区所在的页（1 基）——连续滚动下选区、工具栏、对话卡片都挂在那一页上 */
  page: number
  text: string
  rects: HighlightRect[]
  /** 工具栏锚点，已按卡片宽度做过边界收敛 */
  anchorX: number
  anchorY: number
}

interface PageSize {
  /** scale = 1 时的页面尺寸（PDF 用户单位） */
  width: number
  height: number
}

const MIN_SCALE = 0.5
const MAX_SCALE = 3
/** 对话面板宽度（固定，位置收敛时需要它来算边界） */
const CARD_WIDTH = 420
/**
 * 页间距 / 容器内边距（px）。这两个值参与列坐标换算，
 * 改成 Tailwind 类的话要和这里保持同步，否则「当前页」判定会偏。
 */
const PAGE_GAP = 16
const CONT_PAD = 16
/** 判定「当前页」的锚点：视口顶部往下 40% 处的那条水平线 */
const ANCHOR_RATIO = 0.4

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(Math.max(value, lo), hi)

export function PdfReader({ paperId, highlights, onHighlightsChange, onInsertToNote }: Props): JSX.Element {
  const toast = useAppStore((s) => s.toast)
  const patchSettings = useAppStore((s) => s.patchSettings)
  // 阅读器深色模式：偏好存在设置里，跟着用户走
  const dark = useAppStore((s) => s.settings.pdfDarkMode ?? false)
  // AI 标出的重点是否显示在版面上（用户自己的高亮不受开关影响）
  const showAi = useAppStore((s) => s.settings.pdfShowAiHighlights ?? true)

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [pageCount, setPageCount] = useState(0)
  /** 每页在 scale=1 下的尺寸；槽位高度、滚动换算全靠它，加载完才出正文 */
  const [pageSizes, setPageSizes] = useState<PageSize[] | null>(null)
  /** 当前页（1 基）。只读派生态：滚动时由锚点算出来，翻页按钮只是改滚动位置 */
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(1.2)
  const [loading, setLoading] = useState(true)
  /** 正在渲染 canvas 的页码集 —— 非空时工具栏显示「渲染中…」 */
  const [pendingPages, setPendingPages] = useState<ReadonlySet<number>>(new Set())
  /** 文字层为空的页（扫描件），按页记录，工具栏提示看当前页在不在这里面 */
  const [emptyPages, setEmptyPages] = useState<ReadonlySet<number>>(new Set())
  /** 渲染窗口（0 基闭区间）：只有区间内的页挂 canvas，其余是占位框 */
  const [range, setRange] = useState<VisibleRange>({ start: 0, end: -1 })
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  /**
   * 划词对话面板。
   *
   * 位置存进状态而不是每帧从选区现算：面板可以被拖动，而且流式过程中选区
   * 可能失效（用户点了别处）—— 存下来位置才不会乱跳。
   * page 记录面板挂在哪一页上：那页滚出窗口时会被强制保留，面板不会半路消失。
   */
  const [chat, setChat] = useState<{
    page: number
    /** 整段对话共享的选中原文 */
    passage: string
    messages: ChatMessage[]
    streaming: boolean
    x: number
    y: number
  } | null>(null)
  const [askDraft, setAskDraft] = useState('')
  const [aiBusy, setAiBusy] = useState<PassageAskMode | null>(null)
  const [showList, setShowList] = useState(false)
  const [color, setColor] = useState(DEFAULT_HIGHLIGHT_COLOR)
  /** 「AI 标重点」正在跑（一次全文调用，几十秒量级） */
  const [aiMarking, setAiMarking] = useState(false)
  /**
   * 上次读到哪。undefined = 还在向主进程查；null = 没存过。
   * 恢复动作只做一次（restoredPosRef），用户已经滚动了就不拽回来。
   */
  const [savedPos, setSavedPos] = useState<ReadingPosition | null | undefined>(undefined)
  /** 框选截取模式：页面上盖一层只收框选的透明层 */
  const [captureMode, setCaptureMode] = useState(false)
  /** 抓手模式：按住左键平移页面（放大后比反复滚动更好对准位置） */
  const [panMode, setPanMode] = useState(false)
  /** 正在拖出来的框（归一化坐标 + 所在页），松手后清空 */
  const [captureBox, setCaptureBox] = useState<{ page: number; rect: HighlightRect } | null>(null)
  const [capturing, setCapturing] = useState(false)
  /**
   * 刚截好的图。
   *
   * 存 url + markdown 两样：url 是缩略图（blob），markdown 是能直接贴进笔记的
   * 片段 —— 贴进去的是**相对路径**，笔记预览会自己去知识库里把图读出来。
   * insertedTo 记录「插入笔记」落在了哪个章节，按钮随之变成确认文案。
   */
  const [shot, setShot] = useState<{
    url: string
    markdown: string
    relPath: string
    insertedTo?: string
  } | null>(null)
  /** 图库面板：null 表示还没拉过列表 */
  const [showLibrary, setShowLibrary] = useState(false)
  const [library, setLibrary] = useState<string[] | null>(null)
  /** 正在大图查看的图（相对知识库根的路径） */
  const [lightbox, setLightbox] = useState<string | null>(null)
  const { confirm: askDeleteFigure, dialog: deleteFigureDialog } = useConfirm()

  const scrollRef = useRef<HTMLDivElement>(null)
  /** 每一页的槽位元素（1 基页码 → div）：选区矩形、卡片定位都要拿它做基准 */
  const pageBoxRefs = useRef(new Map<number, HTMLDivElement>())
  const fittedRef = useRef(false)
  /** 缩放前的视口锚点（哪一页 + 页内相对位置），缩放后原地接回去 */
  const zoomAnchorRef = useRef<{ index: number; ratio: number } | null>(null)
  /** 阅读位置是否已恢复（恢复前禁止保存，免得打开时用顶部位置覆盖掉存档） */
  const restoredPosRef = useRef(false)
  const posSaveTimerRef = useRef<number | undefined>(undefined)
  /** scroll 回调里要拿到最新的页码，绕开闭包旧值 */
  const pageRef = useRef(page)
  pageRef.current = page

  const registerBox = useCallback(
    (pageNumber: number) => (el: HTMLDivElement | null) => {
      if (el) pageBoxRefs.current.set(pageNumber, el)
      else pageBoxRefs.current.delete(pageNumber)
    },
    []
  )

  /* ---------------- 读取并解析 PDF ---------------- */
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setDoc(null)
    setPageSizes(null)
    setPage(1)
    setSelection(null)
    setChat(null)
    setCaptureBox(null)
    setPendingPages(new Set())
    setEmptyPages(new Set())
    setRange({ start: 0, end: -1 })
    fittedRef.current = false
    zoomAnchorRef.current = null
    scrollRef.current?.scrollTo({ top: 0, left: 0 })

    void (async () => {
      try {
        const res = await window.papervault.papers.pdfData(paperId)
        if (cancelled) return
        if (!res.ok || !res.data) throw new Error(res.message ?? '读取 PDF 失败')

        const pdfjsLib = await loadPdfjs()
        // slice() 是因为 pdfjs 会接管（可能 detach）传入的 buffer
        const task = pdfjsLib.getDocument({ data: res.data.slice() })
        const loaded = await task.promise
        if (cancelled) {
          void loaded.destroy()
          return
        }
        setDoc(loaded)
        setPageCount(loaded.numPages)
      } catch (err) {
        if (!cancelled) setError(errorMessage(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [paperId])

  // 换文档时销毁上一份，否则 pdfjs 的 worker 和缓存会一直累积
  useEffect(() => {
    return () => {
      void doc?.destroy()
    }
  }, [doc])

  /* ---------------- 阅读位置（上次读到哪） ---------------- */

  // 打开论文时查一次存档；undefined → 有值/没有 的转换触发恢复（见下方的 layout effect）
  useEffect(() => {
    let cancelled = false
    restoredPosRef.current = false
    setSavedPos(undefined)
    void window.papervault.papers.getReadingPosition(paperId).then((res) => {
      if (!cancelled) setSavedPos(res.ok ? (res.position ?? null) : null)
    })
    return () => {
      cancelled = true
    }
  }, [paperId])

  /** 把当前滚动比例存进索引 DB（比例存的不是像素，换缩放/换窗口都 still 对得上） */
  const saveReadingPos = useCallback(() => {
    const el = scrollRef.current
    if (!el || !restoredPosRef.current) return
    const max = el.scrollHeight - el.clientHeight
    if (max <= 0) return
    void window.papervault.papers.saveReadingPosition(paperId, {
      ratio: clamp(el.scrollTop / max, 0, 1),
      page: pageRef.current
    })
  }, [paperId])

  // 滚动停下 800ms 后才落盘；关闭/换论文时立刻补存最后一次
  const scheduleSavePos = useCallback(() => {
    window.clearTimeout(posSaveTimerRef.current)
    posSaveTimerRef.current = window.setTimeout(saveReadingPos, 800)
  }, [saveReadingPos])
  useEffect(() => {
    return () => {
      window.clearTimeout(posSaveTimerRef.current)
      saveReadingPos()
    }
  }, [saveReadingPos])

  /*
   * 预取每页尺寸（scale=1）。只拿 viewport、不渲染，开销很小；
   * 没有它就不知道每页槽位的高度，滚动条和「当前页」换算都无从谈起。
   */
  useEffect(() => {
    if (!doc) return
    let cancelled = false
    void (async () => {
      try {
        const sizes: PageSize[] = []
        for (let i = 1; i <= doc.numPages; i++) {
          const pdfPage = await doc.getPage(i)
          const viewport = pdfPage.getViewport({ scale: 1 })
          sizes.push({ width: viewport.width, height: viewport.height })
          if (cancelled) return
        }
        setPageSizes(sizes)
      } catch (err) {
        if (!cancelled) setError(errorMessage(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doc])

  /* ---------------- 列坐标派生态 ---------------- */
  // 槽位尺寸取整：canvas 的 CSS 尺寸也按取整值来，两边对齐，覆盖层的百分比定位才准
  const heights = useMemo(
    () => (pageSizes ?? []).map((s) => Math.max(1, Math.floor(s.height * scale))),
    [pageSizes, scale]
  )
  const widths = useMemo(
    () => (pageSizes ?? []).map((s) => Math.max(1, Math.floor(s.width * scale))),
    [pageSizes, scale]
  )
  const offsets = useMemo(() => pageOffsets(heights, PAGE_GAP), [heights])

  /**
   * 滚动 → 派生态（渲染窗口 + 当前页）。
   * scroll 事件每帧都可能来，这里全部用函数式 setState，值没变就不触发重渲染。
   */
  const updateFromScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el || !offsets.length) return
    const colTop = el.scrollTop - CONT_PAD
    const viewH = el.clientHeight
    // 上下各多渲染一屏：正常速度的滚动永远落在已渲染区里，不会看到白缝
    const overscan = viewH
    setRange((prev) => {
      const next = visiblePageRange(colTop - overscan, colTop + viewH + overscan, offsets, heights)
      return prev.start === next.start && prev.end === next.end ? prev : next
    })
    setPage((prev) => {
      const next = currentPageAt(colTop + viewH * ANCHOR_RATIO, offsets) + 1
      return prev === next ? prev : next
    })
  }, [offsets, heights])

  // 滚动 + 容器尺寸变化（侧栏开关、窗口拖拽）都会改变窗口和当前页
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const schedule = (): void => {
      scheduleSavePos()
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        updateFromScroll()
      })
    }
    el.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', schedule)
      observer.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [updateFromScroll, scheduleSavePos])

  /*
   * 缩放（或尺寸就绪）后：先接回锚点，再重算派生态。
   * 用 layout effect 是为了在绘制前改 scrollTop，用户看不到跳变。
   * 首次排版时顺带恢复「上次读到哪」—— 只在用户还没滚动过时恢复，
   * 否则存档查回来得晚会把人拽回去。
   */
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !offsets.length) return
    if (!restoredPosRef.current && savedPos !== undefined) {
      restoredPosRef.current = true
      const max = el.scrollHeight - el.clientHeight
      if (savedPos && max > 0 && el.scrollTop < 4) {
        el.scrollTop = savedPos.ratio * max
      }
    }
    const anchor = zoomAnchorRef.current
    if (anchor) {
      zoomAnchorRef.current = null
      const i = Math.min(anchor.index, offsets.length - 1)
      el.scrollTop = CONT_PAD + offsets[i] + anchor.ratio * heights[i] - el.clientHeight * ANCHOR_RATIO
    }
    updateFromScroll()
  }, [offsets, heights, updateFromScroll, savedPos])

  /** 翻到某一页：设滚动位置 + 同步派生态（scroll 事件是异步的，连点按钮不能等它） */
  const scrollToPage = useCallback(
    (pageNumber: number) => {
      const el = scrollRef.current
      if (!el || !offsets.length) return
      el.scrollTop = scrollTopForPage(offsets, pageNumber - 1)
      updateFromScroll()
    },
    [offsets, updateFromScroll]
  )

  /** 缩放前记下「视口锚线压在哪一页的什么位置」，缩放后原地接回，不跳页 */
  const captureZoomAnchor = useCallback(() => {
    const el = scrollRef.current
    if (!el || !offsets.length) return
    const index = clamp(page - 1, 0, offsets.length - 1)
    const h = heights[index] || 1
    const anchorCol = el.scrollTop - CONT_PAD + el.clientHeight * ANCHOR_RATIO
    // 锚线可能落在页缝隙或页外（极端缩放中），收敛到页内附近即可
    zoomAnchorRef.current = { index, ratio: clamp((anchorCol - offsets[index]) / h, -0.5, 1.5) }
  }, [offsets, heights, page])

  const zoomBy = useCallback(
    (delta: number) => {
      captureZoomAnchor()
      setScale((s) => clamp(s + delta, MIN_SCALE, MAX_SCALE))
    },
    [captureZoomAnchor]
  )

  /* ---------------- 适应宽度 ---------------- */
  const fitWidth = useCallback(() => {
    const el = scrollRef.current
    if (!el || !pageSizes?.length) return
    const base = pageSizes[clamp(page - 1, 0, pageSizes.length - 1)]
    const available = el.clientWidth - 40
    if (available <= 0) return
    captureZoomAnchor()
    setScale(clamp(available / base.width, MIN_SCALE, MAX_SCALE))
  }, [pageSizes, page, captureZoomAnchor])

  // 文档加载完自动适应一次宽度，之后由用户手动缩放
  useEffect(() => {
    if (!pageSizes || fittedRef.current) return
    fittedRef.current = true
    fitWidth()
  }, [pageSizes, fitWidth])

  /* ---------------- 每页渲染状态上报（PdfPageCanvas → 这里） ---------------- */
  const handleRenderStart = useCallback((pageNumber: number) => {
    setPendingPages((prev) => new Set(prev).add(pageNumber))
  }, [])

  /**
   * 渲染结束（成功、失败、被取消都走这里，先把「渲染中」摘了）。
   * hasText 只有成功铺完文字层才带：false 记进扫描件集合，true 把它摘出来。
   */
  const handleRenderEnd = useCallback((pageNumber: number, hasText?: boolean) => {
    setPendingPages((prev) => {
      if (!prev.has(pageNumber)) return prev
      const next = new Set(prev)
      next.delete(pageNumber)
      return next
    })
    if (hasText === false) {
      setEmptyPages((prev) => new Set(prev).add(pageNumber))
    } else if (hasText === true) {
      setEmptyPages((prev) => {
        if (!prev.has(pageNumber)) return prev
        const next = new Set(prev)
        next.delete(pageNumber)
        return next
      })
    }
  }, [])

  const handleRenderError = useCallback(
    (pageNumber: number, message: string) => {
      toast(`第 ${pageNumber} 页渲染失败：${message}`, 'error')
    },
    [toast]
  )

  /* ---------------- 选区 ---------------- */
  const handleMouseUp = useCallback(
    (pageNumber: number) => {
      const box = pageBoxRefs.current.get(pageNumber)
      if (!box) return
      // 截取 / 抓手模式下不算划词：那时上层盖着截取层，或者用户正在平移页面
      if (captureMode || panMode) return
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSelection(null)
        return
      }
      const range = sel.getRangeAt(0)
      // 只认发生在这一页里的选区（跨页拖选时共同祖先在列容器上，谁也不认 → 清掉）
      if (!box.contains(range.commonAncestorContainer)) {
        setSelection(null)
        return
      }
      const text = sel.toString().replace(/\s+/g, ' ').trim()
      if (!text) {
        setSelection(null)
        return
      }

      const boxRect = box.getBoundingClientRect()
      const rects: HighlightRect[] = []
      let topMost = Number.POSITIVE_INFINITY
      let anchorX = 0

      for (const r of Array.from(range.getClientRects())) {
        const w = r.width / boxRect.width
        const h = r.height / boxRect.height
        // 丢掉退化的矩形（缩放误差会产生 0 宽的行）
        if (w <= 0.002 || h <= 0.002) continue
        rects.push({
          x: (r.left - boxRect.left) / boxRect.width,
          y: (r.top - boxRect.top) / boxRect.height,
          w,
          h
        })
        if (r.top < topMost) {
          topMost = r.top
          anchorX = r.left + r.width / 2 - boxRect.left
        }
      }
      if (!rects.length) {
        setSelection(null)
        return
      }

      // 选新文字不关掉已有对话面板 —— 用户可能想对照着看
      setSelection({
        page: pageNumber,
        text,
        rects,
        // 收敛到页面内，避免卡片贴边被裁掉
        anchorX: Math.min(Math.max(anchorX, 200), Math.max(200, boxRect.width - 200)),
        anchorY: topMost - boxRect.top
      })
    },
    [captureMode, panMode]
  )

  useEffect(() => {
    // 缩放 / 换论文后旧选区已经失效。对话面板不清 —— 它有自己的上下文，
    // 而且用户很可能边看边缩放，清掉会很烦。
    // （滚动不清：连续滚动下选区跟着页面走，依然有效）
    setSelection(null)
  }, [scale, paperId])

  /* ---------------- 图库（本篇论文截过的全部图） ---------------- */

  const reloadLibrary = useCallback(async (): Promise<void> => {
    const res = await window.papervault.figures.list(paperId)
    setLibrary(res.ok ? (res.figures ?? []) : [])
  }, [paperId])

  const toggleLibrary = useCallback((): void => setShowLibrary((v) => !v), [])

  // 面板开着才拉列表；换论文时旧列表作废，开着就重拉
  useEffect(() => {
    setLibrary(null)
  }, [paperId])
  useEffect(() => {
    if (showLibrary) void reloadLibrary()
  }, [showLibrary, reloadLibrary])

  const removeFigure = useCallback(
    (relPath: string): void => {
      void askDeleteFigure({
        title: '删除这张图？',
        description: `${relPath}\n\n文件会从知识库里删掉，此操作不可撤销。如果笔记正文引用了它，那处的预览会裂图。`,
        confirmLabel: '删除',
        danger: true
      }).then((ok) => {
        if (!ok) return
        void (async () => {
          const res = await window.papervault.figures.remove(relPath)
          if (!res.ok) {
            toast(res.message ?? '删除失败', 'error')
            return
          }
          // 大图正开着这张的话一起关掉，别留在屏上
          setLightbox((current) => (current === relPath ? null : current))
          toast('已删除', 'success')
          await reloadLibrary()
        })()
      })
    },
    [askDeleteFigure, toast, reloadLibrary]
  )

  /* ---------------- 框选截取图表 ---------------- */

  /**
   * 把页面上的一块区域裁成 PNG 存进知识库。
   *
   * 不复用屏幕上那个 canvas：它按 devicePixelRatio 画（还被 clamp 到 2），尺寸就是
   * 当前缩放下的显示尺寸，直接裁下来会糊。这里按 PDF 用户坐标**重新渲染一份
   * 3 倍图**再裁，所以当前缩放多大都不影响导出清晰度。
   */
  const captureRegion = useCallback(
    async (pageNumber: number, rect: HighlightRect): Promise<void> => {
      if (!doc) return
      setCapturing(true)
      try {
        const pdfPage = await doc.getPage(pageNumber)
        const exportScale = clamp(scale * 3, 2, 6)
        const viewport = pdfPage.getViewport({ scale: exportScale })

        const full = document.createElement('canvas')
        full.width = Math.max(1, Math.floor(viewport.width))
        full.height = Math.max(1, Math.floor(viewport.height))
        const fullCtx = full.getContext('2d')
        if (!fullCtx) throw new Error('无法创建画布')
        /*
         * 先铺白底。论文页面本身没有背景色，PDF 里也不画白底，
         * 不铺的话导出的 PNG 是透明的 —— 贴进笔记在深色界面上几乎看不见。
         */
        fullCtx.fillStyle = '#ffffff'
        fullCtx.fillRect(0, 0, full.width, full.height)
        await pdfPage.render({ canvasContext: fullCtx, viewport }).promise

        // 往外留一点边：手画框很难正好压在图框上，切掉一两个像素的边框很常见
        const PAD = 6
        const cutX = Math.max(0, Math.floor(rect.x * full.width - PAD))
        const cutY = Math.max(0, Math.floor(rect.y * full.height - PAD))
        const cutW = Math.min(full.width - cutX, Math.ceil(rect.w * full.width + PAD * 2))
        const cutH = Math.min(full.height - cutY, Math.ceil(rect.h * full.height + PAD * 2))
        if (cutW < 8 || cutH < 8) throw new Error('选区太小')

        const out = document.createElement('canvas')
        out.width = cutW
        out.height = cutH
        const outCtx = out.getContext('2d')
        if (!outCtx) throw new Error('无法创建画布')
        outCtx.drawImage(full, cutX, cutY, cutW, cutH, 0, 0, cutW, cutH)

        const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'))
        if (!blob) throw new Error('导出图片失败')
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const res = await window.papervault.figures.save(paperId, bytes, '.png')
        if (!res.ok || !res.relPath || !res.markdown) throw new Error(res.message ?? '保存失败')

        setShot({ url: URL.createObjectURL(blob), markdown: res.markdown, relPath: res.relPath })
        // 截完就退出框选模式，不然下一次点击又是在画框
        setCaptureMode(false)
        // 图库面板开着的话同步刷新，新图立刻可见
        if (showLibrary) void reloadLibrary()
      } catch (err) {
        toast(`截取图表失败：${errorMessage(err)}`, 'error')
      } finally {
        setCapturing(false)
      }
    },
    [doc, scale, paperId, toast, showLibrary, reloadLibrary]
  )

  /**
   * 开始框选。
   *
   * 监听挂在 window 上（和拖动对话卡片同一个套路）：鼠标划出页面边界、甚至划到
   * 窗口外时框还得跟着走，把监听挂在元素上会中途断掉。
   */
  const startCapture = useCallback(
    (pageNumber: number, event: React.MouseEvent): void => {
      const box = pageBoxRefs.current.get(pageNumber)
      if (!box) return
      event.preventDefault()
      // 底下的文字层会跟着拖拽形成选区，先清掉
      window.getSelection()?.removeAllRanges()

      const boxRect = box.getBoundingClientRect()
      const at = (clientX: number, clientY: number): { x: number; y: number } => ({
        x: clamp((clientX - boxRect.left) / boxRect.width, 0, 1),
        y: clamp((clientY - boxRect.top) / boxRect.height, 0, 1)
      })

      const from = at(event.clientX, event.clientY)
      let rect: HighlightRect = { x: from.x, y: from.y, w: 0, h: 0 }
      setCaptureBox({ page: pageNumber, rect })

      const onMove = (e: MouseEvent): void => {
        const to = at(e.clientX, e.clientY)
        rect = {
          x: Math.min(from.x, to.x),
          y: Math.min(from.y, to.y),
          w: Math.abs(to.x - from.x),
          h: Math.abs(to.y - from.y)
        }
        setCaptureBox({ page: pageNumber, rect })
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        setCaptureBox(null)
        // 太小当成误触（比如只是在页面上点了一下），不弹报错打扰
        if (rect.w < 0.02 || rect.h < 0.02) return
        void captureRegion(pageNumber, rect)
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [captureRegion]
  )

  /**
   * 抓手拖动。
   *
   * 触控板两指滚动本来也能平移，但放大到 200% 以上之后要「滚一下、松开、再滚」，
   * 很难精确对准想看的位置。PDF 阅读器的惯例都是给一个抓手（macOS 预览、Acrobat
   * 都有），这里补上。
   *
   * 做成显式开关而不是「按住空格拖动」：空格在笔记里是正常输入字符，
   * 一旦焦点判断出岔子就会变成往正文里灌空格。
   */
  const startPan = useCallback(
    (event: React.MouseEvent): void => {
      const box = scrollRef.current
      if (!panMode || !box) return
      event.preventDefault()

      const startX = event.clientX
      const startY = event.clientY
      const startLeft = box.scrollLeft
      const startTop = box.scrollTop

      // 监听挂 window：拖到容器外面时页面还要继续跟着走
      const onMove = (e: MouseEvent): void => {
        box.scrollLeft = startLeft - (e.clientX - startX)
        box.scrollTop = startTop - (e.clientY - startY)
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [panMode]
  )

  /** 关掉结果卡片时把缩略图的 object URL 一起回收 */
  const closeShot = useCallback((): void => {
    setShot((current) => {
      if (current) URL.revokeObjectURL(current.url)
      return null
    })
  }, [])

  /** 把片段写进笔记草稿，落点章节显示在按钮上 */
  const insertShot = useCallback((): void => {
    if (!shot || !onInsertToNote) return
    const target = onInsertToNote(shot.markdown)
    if (target) setShot((current) => (current ? { ...current, insertedTo: target } : current))
  }, [shot, onInsertToNote])

  /* ---------------- 高亮 ---------------- */
  const highlightsByPage = useMemo(() => {
    const map = new Map<number, Highlight[]>()
    for (const h of highlights) {
      const list = map.get(h.page)
      if (list) list.push(h)
      else map.set(h.page, [h])
    }
    return map
  }, [highlights])

  const addHighlight = useCallback(async () => {
    if (!selection) return
    const highlight: Highlight = {
      id: newHighlightId(),
      page: selection.page,
      text: selection.text,
      rects: selection.rects,
      color,
      createdAt: new Date().toISOString()
    }
    const res = await window.papervault.papers.saveHighlight(paperId, highlight)
    if (!res.ok) {
      toast(res.message ?? '保存高亮失败', 'error')
      return
    }
    onHighlightsChange(res.highlights ?? [])
    window.getSelection()?.removeAllRanges()
    setSelection(null)
  }, [selection, color, paperId, onHighlightsChange, toast])

  const removeHighlight = useCallback(
    async (id: string) => {
      const res = await window.papervault.papers.removeHighlight(paperId, id)
      if (!res.ok) {
        toast(res.message ?? '删除高亮失败', 'error')
        return
      }
      onHighlightsChange(res.highlights ?? [])
    },
    [paperId, onHighlightsChange, toast]
  )

  /* ---------------- AI 自动标重点 ---------------- */

  /**
   * 从已加载的 doc 里抽出全部「带位置的行」。
   *
   * 就在渲染层抽（而不是让主进程再解析一遍 PDF）：这里的 textContent 和
   * 屏幕上文字层同源，行号回查出来的矩形和用户看到的文字必然对得上。
   * getTextContent 不渲染页面，整篇抽一遍很快。
   */
  const extractSourceLines = useCallback(async (): Promise<SourceLine[]> => {
    if (!doc) return []
    const lines: SourceLine[] = []
    for (let p = 1; p <= doc.numPages; p++) {
      const pdfPage = await doc.getPage(p)
      const viewport = pdfPage.getViewport({ scale: 1 })
      const content = await pdfPage.getTextContent()
      const pageLines = buildPositionedLines(
        content.items as unknown as TextItemLike[],
        viewport.width,
        viewport.height
      )
      for (const l of pageLines) {
        lines.push({ id: lines.length, page: p, text: l.text, rect: l.rect })
      }
    }
    return lines
  }, [doc])

  const runAutoMark = useCallback(async () => {
    if (!doc || aiMarking) return
    setAiMarking(true)
    try {
      const lines = await extractSourceLines()
      if (!lines.length) {
        toast('没有可分析的文字（可能是扫描件）', 'error')
        return
      }
      const res = await window.papervault.ai.autoHighlight({ paperId, lines })
      if (!res.ok) {
        toast(res.message ?? '标注失败', 'error')
        return
      }
      onHighlightsChange(res.highlights ?? [])
      toast(
        `已标出 ${res.added ?? 0} 处重点` +
          `${res.truncated ? '（论文较长，只覆盖了前面部分）' : ''}` +
          `${res.message ? `（${res.message}）` : ''}`,
        'success'
      )
    } catch (err) {
      toast(`标注失败：${errorMessage(err)}`, 'error')
    } finally {
      setAiMarking(false)
    }
  }, [doc, aiMarking, extractSourceLines, paperId, onHighlightsChange, toast])

  /** AI 标注与用户高亮分开统计：按钮显隐、列表分组都要用 */
  const aiCount = useMemo(() => highlights.filter((h) => h.ai).length, [highlights])

  /* ---------------- 划词对话（流式） ---------------- */
  const streamIdRef = useRef<string | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  const newStreamId = (): string =>
    `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  useEffect(() => {
    return window.papervault.app.onStreamDelta(({ streamId, delta }) => {
      // 只认自己那次请求的增量，否则连续划两次词会串内容
      if (streamId !== streamIdRef.current) return
      setChat((prev) => {
        if (!prev) return prev
        const messages = [...prev.messages]
        const last = messages[messages.length - 1]
        // 增量只会追加到最后一条 assistant 消息上
        if (!last || last.role !== 'assistant') return prev
        messages[messages.length - 1] = { ...last, content: last.content + delta }
        return { ...prev, messages }
      })
    })
  }, [])

  /** 面板初始位置：选区下方居中，并收敛到所在页内 */
  const initialCardPos = useCallback((pageNumber: number, anchorX: number, anchorY: number) => {
    const box = pageBoxRefs.current.get(pageNumber)?.getBoundingClientRect()
    if (!box) return { x: 24, y: 24 }
    return {
      x: clamp(anchorX - CARD_WIDTH / 2, 4, Math.max(4, box.width - CARD_WIDTH - 4)),
      y: clamp(anchorY + 10, 4, Math.max(4, box.height - 140))
    }
  }, [])

  const askAi = useCallback(
    async (mode: PassageMode) => {
      if (!selection) return
      const streamId = newStreamId()
      streamIdRef.current = streamId
      setAiBusy(mode)
      setAskDraft('')
      // 先立一个空面板，增量一到就能边收边显示，不用等整段生成完
      setChat({
        page: selection.page,
        passage: selection.text,
        messages: [{ role: 'assistant', content: '' }],
        streaming: true,
        ...initialCardPos(selection.page, selection.anchorX, selection.anchorY)
      })

      try {
        const res = await window.papervault.ai.passage({
          paperId,
          mode,
          text: selection.text,
          streamId
        })
        if (!res.ok) {
          setChat(null)
          toast(res.message ?? '调用模型失败', 'error')
          return
        }
        // 用完整结果收尾：万一有增量在订阅生效前就发出去了，这里兜底
        setChat((prev) =>
          prev
            ? { ...prev, streaming: false, messages: [{ role: 'assistant', content: res.content }] }
            : prev
        )
      } catch (err) {
        setChat(null)
        toast(`调用模型失败：${errorMessage(err)}`, 'error')
      } finally {
        streamIdRef.current = null
        setAiBusy(null)
      }
    },
    [selection, paperId, toast, initialCardPos]
  )

  /** 继续追问：把已有对话作为 history 带上去 */
  const sendFollowUp = useCallback(async () => {
    const question = askDraft.trim()
    if (!question || !chat || chat.streaming) return

    const streamId = newStreamId()
    const history = chat.messages.filter((m) => m.content.trim())
    streamIdRef.current = streamId
    setAiBusy('ask')
    setAskDraft('')
    setChat((prev) =>
      prev
        ? {
            ...prev,
            streaming: true,
            messages: [
              ...prev.messages,
              { role: 'user', content: question },
              // 占位，增量会往这条上追加
              { role: 'assistant', content: '' }
            ]
          }
        : prev
    )

    try {
      const res = await window.papervault.ai.passage({
        paperId,
        mode: 'ask',
        text: chat.passage,
        question,
        history,
        streamId
      })
      if (!res.ok) {
        toast(res.message ?? '追问失败', 'error')
        // 失败就把占位的空消息去掉，别留个空气泡
        setChat((prev) =>
          prev ? { ...prev, streaming: false, messages: prev.messages.slice(0, -1) } : prev
        )
        return
      }
      setChat((prev) => {
        if (!prev) return prev
        const messages = [...prev.messages]
        messages[messages.length - 1] = { role: 'assistant', content: res.content }
        return { ...prev, streaming: false, messages }
      })
    } catch (err) {
      toast(`追问失败：${errorMessage(err)}`, 'error')
      setChat((prev) =>
        prev ? { ...prev, streaming: false, messages: prev.messages.slice(0, -1) } : prev
      )
    } finally {
      streamIdRef.current = null
      setAiBusy(null)
    }
  }, [askDraft, chat, paperId, toast])

  /** 拖动面板：整条头部都是手柄；边界是它所在那一页 */
  const startCardDrag = useCallback((pageNumber: number, event: React.MouseEvent) => {
    const box = pageBoxRefs.current.get(pageNumber)?.getBoundingClientRect()
    const card = cardRef.current
    if (!box || !card) return
    event.preventDefault()

    // 记下「鼠标相对于卡片左上角」的偏移，拖动过程中保持不变，手感才自然
    const grabX = event.clientX - box.left - card.offsetLeft
    const grabY = event.clientY - box.top - card.offsetTop

    const move = (ev: MouseEvent): void => {
      const current = pageBoxRefs.current.get(pageNumber)?.getBoundingClientRect()
      if (!current) return
      const maxX = Math.max(4, current.width - card.offsetWidth - 4)
      const maxY = Math.max(4, current.height - card.offsetHeight - 4)
      const x = clamp(ev.clientX - current.left - grabX, 4, maxX)
      const y = clamp(ev.clientY - current.top - grabY, 4, maxY)
      setChat((prev) => (prev ? { ...prev, x, y } : prev))
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [])

  const copyText = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text)
        toast(`${label}已复制`, 'success')
      } catch {
        toast('复制失败', 'error')
      }
    },
    [toast]
  )

  /* ---------------- 渲染 ---------------- */

  // error 要在 loading / pageSizes 之前判：加载失败时两个都挂着，先判会把错误页盖掉
  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <div className="max-w-md text-center">
          <ScanText className="mx-auto mb-2 h-7 w-7 text-ink-low" />
          <p className="text-[12.5px] text-ink-mid">{error}</p>
        </div>
      </div>
    )
  }

  if (loading || !doc || !pageSizes) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-ink-low">
        <Loader2 className="h-4 w-4 animate-spin text-brand-soft" />
        正在解析 PDF…
      </div>
    )
  }

  const pages = Array.from({ length: pageCount }, (_, i) => i + 1)

  /** 高亮列表里的一条（AI 重点与用户高亮共用，AI 的多一行「为什么重要」） */
  const renderHighlightItem = (h: Highlight): JSX.Element => (
    <div
      key={h.id}
      className="group rounded-lg border border-line px-2 py-1.5 transition hover:border-strong"
    >
      <div className="flex items-center gap-1.5">
        <button
          title="滚动到这一页"
          onClick={() => scrollToPage(h.page)}
          className="rounded px-1 py-0.5 font-mono text-[9.5px] text-info transition hover:bg-white/5"
          style={{ background: 'rgba(116,172,143,0.14)' }}
        >
          P{h.page}
        </button>
        {h.ai ? (
          <Bot className="h-3 w-3 text-info" />
        ) : (
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: h.color }} />
        )}
        <button
          title="删除这条高亮"
          onClick={() => void removeHighlight(h.id)}
          className="ml-auto rounded p-0.5 text-ink-low opacity-0 transition group-hover:opacity-100 hover:text-danger"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-ink-mid">{h.text}</p>
      {h.ai && h.note ? (
        <p className="mt-1 text-[10.5px] leading-snug text-info/90">{h.note}</p>
      ) : null}
    </div>
  )

  const myHighlights = highlights.filter((h) => !h.ai)
  const aiHighlights = highlights.filter((h) => h.ai)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 工具栏 */}
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-1.5">
        <div className="flex items-center gap-0.5 rounded-lg border border-line p-0.5">
          <ToolButton title="上一页" disabled={page <= 1} onClick={() => scrollToPage(page - 1)}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </ToolButton>
          <span className="min-w-[54px] text-center text-[11.5px] tabular-nums text-ink-mid">
            {page} / {pageCount}
          </span>
          <ToolButton
            title="下一页"
            disabled={page >= pageCount}
            onClick={() => scrollToPage(page + 1)}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </ToolButton>
        </div>

        <div className="flex items-center gap-0.5 rounded-lg border border-line p-0.5">
          <ToolButton title="缩小" disabled={scale <= MIN_SCALE} onClick={() => zoomBy(-0.15)}>
            <ZoomOut className="h-3.5 w-3.5" />
          </ToolButton>
          <span className="min-w-[42px] text-center text-[11.5px] tabular-nums text-ink-mid">
            {Math.round(scale * 100)}%
          </span>
          <ToolButton title="放大" disabled={scale >= MAX_SCALE} onClick={() => zoomBy(0.15)}>
            <ZoomIn className="h-3.5 w-3.5" />
          </ToolButton>
        </div>

        <button
          onClick={fitWidth}
          className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] text-ink-mid transition hover:border-strong hover:text-ink-high"
        >
          <Maximize2 className="h-3 w-3" />
          适应宽度
        </button>

        <button
          title={dark ? '切回浅色（原版面）' : '深色模式（反相显示，护眼）'}
          onClick={() => void patchSettings({ pdfDarkMode: !dark })}
          className={cn(
            'flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition',
            dark
              ? 'border-brand/50 bg-brand/10 text-brand-mist'
              : 'border-line text-ink-mid hover:border-strong hover:text-ink-high'
          )}
        >
          {dark ? <Moon className="h-3 w-3" /> : <Sun className="h-3 w-3" />}
          深色
        </button>

        <button
          title="在页面上拖出一个框，把它裁成图片存进知识库，再贴到笔记里"
          onClick={() => {
            setCaptureMode((v) => !v)
            setSelection(null)
          }}
          className={cn(
            'flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition',
            captureMode
              ? 'border-brand/50 bg-brand/10 text-brand-mist'
              : 'border-line text-ink-mid hover:border-strong hover:text-ink-high'
          )}
        >
          <Crop className="h-3 w-3" />
          {capturing ? '截取中…' : '截取图表'}
        </button>

        <button
          title="抓手：按住左键平移页面（放大后比反复滚动更好对准位置）"
          onClick={() => {
            setPanMode((v) => !v)
            setSelection(null)
          }}
          className={cn(
            'flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition',
            panMode
              ? 'border-brand/50 bg-brand/10 text-brand-mist'
              : 'border-line text-ink-mid hover:border-strong hover:text-ink-high'
          )}
        >
          <Hand className="h-3 w-3" />
          拖动
        </button>

        <button
          title="让 AI 把这篇论文最不该跳过的句子直接标在版面上，每条带「为什么重要」。再点一次 = 重新标注（替换旧的 AI 标注，你自己划的高亮不动）"
          disabled={aiMarking}
          onClick={() => void runAutoMark()}
          className={cn(
            'flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition',
            aiMarking || aiCount > 0
              ? 'border-info/50 bg-info/10 text-info'
              : 'border-line text-ink-mid hover:border-strong hover:text-ink-high'
          )}
        >
          {aiMarking ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Bot className="h-3 w-3" />
          )}
          {aiMarking ? '标注中…' : aiCount > 0 ? `AI 重点 ${aiCount}` : 'AI 标重点'}
        </button>

        {aiCount > 0 ? (
          <button
            title={showAi ? '隐藏 AI 标出的重点（你自己划的不受影响）' : '显示 AI 标出的重点'}
            onClick={() => void patchSettings({ pdfShowAiHighlights: !showAi })}
            className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] text-ink-mid transition hover:border-strong hover:text-ink-high"
          >
            {showAi ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
          </button>
        ) : null}

        <span className="ml-1 hidden text-[10.5px] text-ink-low sm:inline">
          {captureMode ? (
            '在页面上拖出一个框 —— 图表、表格、公式都可以'
          ) : panMode ? (
            '按住左键拖动页面'
          ) : emptyPages.has(page) && pendingPages.size === 0 ? (
            <span className="text-warn">本页没有可选文字（可能是扫描件）</span>
          ) : (
            '选中文字可高亮 / 翻译 / 解读'
          )}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          {pendingPages.size > 0 ? (
            <span className="text-[10.5px] text-ink-low">渲染中…</span>
          ) : null}
          <button
            onClick={toggleLibrary}
            title="这篇论文截过的全部图"
            className={cn(
              'flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition',
              showLibrary
                ? 'border-brand/50 bg-brand/10 text-brand-mist'
                : 'border-line text-ink-mid hover:border-strong hover:text-ink-high'
            )}
          >
            <Images className="h-3 w-3" />
            图库 {library?.length ?? ''}
          </button>
          <button
            onClick={() => setShowList((v) => !v)}
            className={cn(
              'flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition',
              showList
                ? 'border-brand/50 bg-brand/10 text-brand-mist'
                : 'border-line text-ink-mid hover:border-strong hover:text-ink-high'
            )}
          >
            <List className="h-3 w-3" />
            高亮 {highlights.length}
          </button>
        </div>
      </div>

      {/*
        截取结果。做成工具栏下面的一条而不是浮层：浮层会压住正文，
        而用户这会儿通常还要再去框第二张图。
      */}
      {shot ? (
        <div className="mb-2 flex shrink-0 items-start gap-3 rounded-xl border border-brand/30 bg-brand/[0.06] px-3 py-2.5">
          <img
            src={shot.url}
            alt="刚截取的图表"
            className="max-h-[110px] max-w-[200px] rounded-lg border border-line bg-white object-contain"
          />
          <div className="min-w-0 flex-1">
            <p className="text-[11.5px] text-ink-high">已存进知识库：{shot.relPath}</p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-ink-low">
              「插入笔记」写进你上次在笔记里放光标的位置，连截几张会依次往下排；也可以复制后自己贴。
              路径相对笔记存放，知识库整个搬走也不会断。
            </p>
            <code className="mt-1.5 block truncate rounded-md bg-black/30 px-2 py-1 font-mono text-[10.5px] text-accent-soft">
              {shot.markdown}
            </code>
          </div>
          <div className="flex shrink-0 flex-col gap-1">
            {onInsertToNote ? (
              <button
                title={
                  shot.insertedTo
                    ? '再点一次会再插一份（比如想放进两个章节）'
                    : '写进笔记草稿：优先落在你上次放光标的位置，没有就追加到最近编辑的章节'
                }
                onClick={insertShot}
                className="rounded-md border border-brand/40 bg-brand/10 px-2 py-0.5 text-[10.5px] text-brand-mist transition hover:bg-brand/20"
              >
                {shot.insertedTo ? `已插入「${shot.insertedTo}」` : '插入笔记'}
              </button>
            ) : null}
            <button
              onClick={() => void copyText(shot.markdown, '图表 Markdown')}
              className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-ink-mid transition hover:border-strong hover:text-ink-high"
            >
              复制
            </button>
            <button
              onClick={closeShot}
              className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-ink-low transition hover:border-strong hover:text-ink-mid"
            >
              关闭
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-2">
        {/*
          页面区。
          `min-w-0` 不能省：flex-1 只管长，而 `min-width: auto` 会让它**不能小于
          内容的 min-content** —— 页面放大后那块 canvas 有近千像素宽，于是它死活
          不缩，右侧 `w-[260px] shrink-0` 的图库 / 高亮面板被顶到窗口外面去，
          看起来就是「面板打不开 / 只剩一条缝」。加上它之后，超出的部分交给
          这个容器自己的 overflow-auto 滚动，面板才留得住。
        */}
        {/*
          `justify-content: safe center` 是这一块的关键。
          页面列比容器窄时居中；比容器宽时自动退回「从起始边开始」——
          换成普通的 `center`，超出的那半边会落到负坐标里，
          滚动条永远够不到，表现成「放大以后有些位置怎么拖都看不到」。
          safe 关键字 Chromium 93+ 支持，Electron 33 没问题。
        */}
        <div
          ref={scrollRef}
          onMouseDown={startPan}
          style={{ justifyContent: 'safe center', padding: CONT_PAD }}
          className={cn(
            'relative flex min-h-0 min-w-0 flex-1 items-start justify-center overflow-auto rounded-xl border border-line bg-[#1b1b21]',
            panMode && 'cursor-grab active:cursor-grabbing'
          )}
        >
          {/*
            整篇 PDF 排成一列。槽位永远都在（撑起滚动条），canvas 只挂渲染窗口内的页。
            items-center：偶尔出现的横排宽页之外的窄页也能居中。
          */}
          <div className="flex flex-col items-center" style={{ gap: PAGE_GAP }}>
            {pages.map((n) => {
              const i = n - 1
              const inWindow = range.end >= 0 && i >= range.start && i <= range.end
              // 挂着选区 / 对话卡片的页滚出窗口也不能卸载，否则卡片半路消失
              const keepMounted =
                selection?.page === n || chat?.page === n || captureBox?.page === n
              const renderCanvas = inWindow || keepMounted
              return (
                <div
                  key={n}
                  ref={registerBox(n)}
                  onMouseUp={() => handleMouseUp(n)}
                  className={cn(
                    'pdf-viewer-page relative shrink-0 bg-white shadow-lg',
                    dark && 'is-dark'
                  )}
                  style={{ width: widths[i], height: heights[i] }}
                >
                  {renderCanvas ? (
                    <PdfPageCanvas
                      doc={doc}
                      pageNumber={n}
                      scale={scale}
                      dark={dark}
                      onRenderStart={handleRenderStart}
                      onRenderEnd={handleRenderEnd}
                      onRenderError={handleRenderError}
                    />
                  ) : (
                    // 占位框：尺寸和真页一致，滚动条才不会骗人；页码方便快速滚动时对位置
                    <div className="flex h-full w-full select-none items-center justify-center text-[11px] text-black/15">
                      第 {n} 页
                    </div>
                  )}

                  {/*
                    高亮覆盖层：pointer-events:none，否则会挡住文字选择。
                    AI 标重点用「浅底 + 虚线下划线」和用户高亮的纯色块区分开 ——
                    它是导航建议，不是用户自己的标记，视觉上要退后半步。
                  */}
                  <div
                    className={cn('pointer-events-none absolute inset-0', dark && 'pdf-invert')}
                  >
                    {(highlightsByPage.get(n) ?? []).flatMap((h) => {
                      if (h.ai && !showAi) return []
                      return h.rects.map((r, ri) => (
                        <div
                          key={`${h.id}-${ri}`}
                          className="absolute rounded-[2px]"
                          style={{
                            left: `${r.x * 100}%`,
                            top: `${r.y * 100}%`,
                            width: `${r.w * 100}%`,
                            height: `${r.h * 100}%`,
                            background: h.color,
                            mixBlendMode: 'multiply',
                            ...(h.ai ? { borderBottom: '2px dashed rgba(127,163,199,0.9)' } : {})
                          }}
                        />
                      ))
                    })}
                  </div>

                  {/*
                    框选截取层。只在截取模式下挂载 —— 它必须收鼠标事件（不像高亮层那样
                    pointer-events:none），常驻会把文字选择和划词工具栏全挡住。
                    z-30 是为了压住下面 z-20 的浮层卡片。
                  */}
                  {captureMode ? (
                    <div
                      onMouseDown={(e) => startCapture(n, e)}
                      className="absolute inset-0 z-30 cursor-crosshair"
                    >
                      {captureBox && captureBox.page === n ? (
                        <div
                          className="pointer-events-none absolute border-2 border-brand bg-brand/20"
                          style={{
                            left: `${captureBox.rect.x * 100}%`,
                            top: `${captureBox.rect.y * 100}%`,
                            width: `${captureBox.rect.w * 100}%`,
                            height: `${captureBox.rect.h * 100}%`
                          }}
                        />
                      ) : null}
                    </div>
                  ) : null}

                  {/* 划词工具栏 */}
                  {selection && selection.page === n ? (
                    <div
                      className="pdf-float-card absolute z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-lg p-1"
                      style={{ left: selection.anchorX, top: Math.max(4, selection.anchorY - 42) }}
                    >
                      <ActionButton
                        icon={<Highlighter className="h-3.5 w-3.5" />}
                        label="高亮"
                        onClick={() => void addHighlight()}
                      />
                      <ActionButton
                        icon={<Languages className="h-3.5 w-3.5" />}
                        label="翻译"
                        loading={aiBusy === 'translate'}
                        onClick={() => void askAi('translate')}
                      />
                      <ActionButton
                        icon={<Lightbulb className="h-3.5 w-3.5" />}
                        label="解读"
                        loading={aiBusy === 'explain'}
                        onClick={() => void askAi('explain')}
                      />
                      <span className="mx-0.5 h-3.5 w-px bg-white/12" />
                      <ActionButton
                        icon={<Copy className="h-3.5 w-3.5" />}
                        label="复制"
                        onClick={() => void copyText(selection.text, '原文')}
                      />
                      <span className="mx-0.5 h-3.5 w-px bg-white/12" />
                      {HIGHLIGHT_COLORS.map((c) => (
                        <button
                          key={c.id}
                          title={`高亮颜色：${c.label}`}
                          onClick={() => setColor(c.value)}
                          className={cn(
                            'h-4 w-4 rounded-full border transition',
                            color === c.value ? 'border-white/80' : 'border-transparent'
                          )}
                          style={{ background: c.value }}
                        />
                      ))}
                    </div>
                  ) : null}

                  {/* AI 结果 */}
                  {chat && chat.page === n ? (
                    <div
                      ref={cardRef}
                      className="pdf-float-card absolute z-20 flex max-h-[62%] flex-col overflow-hidden rounded-xl"
                      style={{ left: chat.x, top: chat.y, width: CARD_WIDTH }}
                    >
                      {/* 整条头部都是拖拽手柄 */}
                      <div
                        onMouseDown={(e) => startCardDrag(n, e)}
                        className="flex shrink-0 cursor-move select-none items-center gap-1.5 border-b border-white/10 px-3 py-2"
                      >
                        <GripVertical className="h-3.5 w-3.5 shrink-0 text-ink-low" />
                        <span className="text-[11px] font-medium text-brand-mist">选段对话</span>
                        {chat.streaming ? (
                          <span className="flex items-center gap-1 text-[10px] text-brand-mist/80">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-soft" />
                            生成中
                          </span>
                        ) : (
                          <span className="text-[10px] text-ink-low">请自行核对</span>
                        )}
                        <button
                          title="复制最后一条回复"
                          onMouseDown={(e) => e.stopPropagation()}
                          disabled={chat.streaming}
                          onClick={() => {
                            const last = [...chat.messages]
                              .reverse()
                              .find((m) => m.role === 'assistant' && m.content.trim())
                            if (last) void copyText(last.content, '回复')
                          }}
                          className="ml-auto rounded p-1 text-ink-low transition hover:text-ink-high disabled:opacity-30"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                        <button
                          title="关闭"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => {
                            streamIdRef.current = null
                            setChat(null)
                          }}
                          className="rounded p-1 text-ink-low transition hover:text-ink-high"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>

                      {/* 对话内容 */}
                      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-2.5">
                        {chat.messages.map((message, index) =>
                          message.role === 'user' ? (
                            <div
                              key={index}
                              className="mb-2 ml-8 rounded-lg bg-white/[0.07] px-2.5 py-1.5 text-[11.5px] leading-relaxed text-ink-high"
                            >
                              {message.content}
                            </div>
                          ) : message.content ? (
                            <Markdown
                              key={index}
                              content={message.content}
                              className="mb-2 text-[12px] leading-relaxed"
                            />
                          ) : (
                            <p key={index} className="mb-2 text-[11.5px] text-ink-low">
                              正在生成…
                            </p>
                          )
                        )}
                      </div>

                      {/* 追问输入 */}
                      <div className="flex shrink-0 items-center gap-1.5 border-t border-white/10 px-2.5 py-2">
                        <input
                          value={askDraft}
                          onChange={(e) => setAskDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault()
                              void sendFollowUp()
                            }
                          }}
                          placeholder="继续追问这段…"
                          className="min-w-0 flex-1 rounded-lg border border-white/12 bg-black/25 px-2.5 py-1.5 text-[11.5px] text-ink-high outline-none placeholder:text-ink-low focus:border-brand/50"
                        />
                        <button
                          title="发送（Enter）"
                          disabled={!askDraft.trim() || chat.streaming}
                          onClick={() => void sendFollowUp()}
                          className="rounded-lg border border-line p-1.5 text-ink-mid transition hover:border-strong hover:text-ink-high disabled:opacity-30"
                        >
                          {aiBusy === 'ask' ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Send className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>

        {/* 图库 */}
        {showLibrary ? (
          <div className="flex w-[260px] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-bg-raised">
            <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
              <span className="text-[11.5px] font-medium text-ink-high">
                本篇图库 {library?.length ?? 0}
              </span>
              <button
                onClick={toggleLibrary}
                className="rounded p-1 text-ink-low transition hover:text-ink-high"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {library === null ? (
                <p className="px-1 py-2 text-[11px] text-ink-low">读取中…</p>
              ) : !library.length ? (
                <p className="px-1 py-2 text-[11px] leading-relaxed text-ink-low">
                  还没有截过图。点工具栏的「截取图表」，在页面上拖一个框即可。
                </p>
              ) : (
                <div className="space-y-1.5">
                  {library.map((rel) => (
                    <div key={rel} className="group relative">
                      <FigureThumb relPath={rel} onClick={() => setLightbox(rel)} />
                      <button
                        title="删除这张图"
                        onClick={() => removeFigure(rel)}
                        className="absolute right-1.5 top-1.5 rounded-md border border-line bg-bg-overlay p-1 text-ink-low opacity-0 transition hover:text-danger group-hover:opacity-100"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* 高亮列表 */}
        {showList ? (
          <div className="flex w-[260px] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-bg-raised">
            <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
              <span className="text-[11.5px] font-medium text-ink-high">
                全部高亮 {highlights.length}
              </span>
              <button
                onClick={() => setShowList(false)}
                className="rounded p-1 text-ink-low transition hover:text-ink-high"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {!highlights.length ? (
                <p className="px-1 py-2 text-[11px] leading-relaxed text-ink-low">
                  还没有高亮。在 PDF 里选中文字点「高亮」，或点工具栏的「AI 标重点」让
                  AI 把这篇最不该跳过的句子标出来。
                </p>
              ) : (
                <div className="space-y-3">
                  {aiHighlights.length ? (
                    <div>
                      <p className="mb-1.5 flex items-center gap-1 px-1 text-[10.5px] font-medium text-info">
                        <Bot className="h-3 w-3" />
                        AI 重点 {aiHighlights.length}
                        <span className="font-normal text-ink-low">（为什么重要见每条下方）</span>
                      </p>
                      <div className="space-y-1">{aiHighlights.map(renderHighlightItem)}</div>
                    </div>
                  ) : null}
                  {myHighlights.length ? (
                    <div>
                      <p className="mb-1.5 px-1 text-[10.5px] font-medium text-ink-mid">
                        我的高亮 {myHighlights.length}
                      </p>
                      <div className="space-y-1">{myHighlights.map(renderHighlightItem)}</div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>

      {lightbox ? <FigureLightbox relPath={lightbox} onClose={() => setLightbox(null)} /> : null}
      {deleteFigureDialog}
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * 单页的渲染件：canvas 画版面 + 透明文字层。
 *
 * 自己管自己的渲染生命周期（挂载渲染、卸载取消），这样渲染窗口滑动时
 * 每页的装载 / 销毁互不影响。渲染进度通过回调上报给父组件 ——
 * 「渲染中…」指示灯和「本页没有可选文字」提示都是全局状态，不该散在各页里。
 */
function PdfPageCanvas({
  doc,
  pageNumber,
  scale,
  dark,
  onRenderStart,
  onRenderEnd,
  onRenderError
}: {
  doc: PDFDocumentProxy
  pageNumber: number
  scale: number
  dark: boolean
  onRenderStart: (page: number) => void
  onRenderEnd: (page: number, hasText?: boolean) => void
  onRenderError: (page: number, message: string) => void
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let task: RenderTask | null = null
    onRenderStart(pageNumber)

    void (async () => {
      try {
        const pdfPage = await doc.getPage(pageNumber)
        if (cancelled) return
        const viewport = pdfPage.getViewport({ scale })
        const canvas = canvasRef.current
        const textLayerEl = textLayerRef.current
        if (!canvas || !textLayerEl) return

        // canvas 按设备像素比放大、CSS 缩回槽位尺寸（100%），否则高分屏上发虚
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr))
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr))

        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

        task = pdfPage.render({ canvasContext: ctx, viewport })
        await task.promise
        if (cancelled) return

        // 文字层：透明 span 铺在 canvas 上，负责选中与复制
        textLayerEl.replaceChildren()
        // pdfjs 的样式里用 var(--scale-factor) 算字号，这里显式喂给它
        textLayerEl.style.setProperty('--scale-factor', String(viewport.scale))
        const textContent = await pdfPage.getTextContent()
        if (cancelled) return
        const pdfjsLib = await loadPdfjs()
        const layer = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayerEl,
          viewport
        })
        await layer.render()
        if (cancelled) return
        // 渲染完一个 span 都没有 → 这页是扫描图，没有可选文字，明确告诉用户，
        // 而不是让他以为功能坏了
        onRenderEnd(pageNumber, textLayerEl.childElementCount > 0)
      } catch (err) {
        // 滚动过快时页面被卸载、主动 cancel 会抛 RenderingCancelledException，属于正常流程
        const name = (err as Error)?.name
        if (!cancelled && name !== 'RenderingCancelledException') {
          onRenderError(pageNumber, errorMessage(err))
          onRenderEnd(pageNumber)
        }
      }
    })()

    return () => {
      cancelled = true
      try {
        task?.cancel()
      } catch {
        /* 渲染已结束，忽略 */
      }
      // 卸载（滑出窗口 / 缩放重排）时把「渲染中」摘掉，否则指示灯会卡住
      onRenderEnd(pageNumber)
    }
  }, [doc, pageNumber, scale, onRenderStart, onRenderEnd, onRenderError])

  return (
    <>
      <canvas ref={canvasRef} className={cn('block h-full w-full', dark && 'pdf-invert')} />
      <div ref={textLayerRef} className="textLayer" />
    </>
  )
}

/* ------------------------------------------------------------------ */

function ToolButton({
  title,
  disabled,
  onClick,
  children
}: {
  title: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1 text-ink-mid transition hover:text-ink-high disabled:opacity-30 disabled:hover:text-ink-mid"
    >
      {children}
    </button>
  )
}

function ActionButton({
  icon,
  label,
  loading,
  onClick
}: {
  icon: React.ReactNode
  label: string
  loading?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="flex items-center gap-1 rounded px-1.5 py-1 text-[11.5px] text-ink-mid transition hover:bg-white/[0.07] hover:text-ink-high disabled:opacity-60"
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {label}
    </button>
  )
}
