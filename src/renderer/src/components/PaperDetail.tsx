import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Download,
  ExternalLink,
  FileText,
  FlaskConical,
  FolderOpen,
  Layers,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PenLine,
  Plus,
  Sparkles,
  Star,
  Trash2,
  X
} from 'lucide-react'
import {
  allSectionKeys,
  paperPreamble,
  renderPaperBody,
  SECTION_GROUP_ORDER,
  sectionGroup
} from '@shared/template'
import {
  enabledLensIds,
  estimateCost,
  formatCost,
  formatDuration,
  formatTokens,
  LENS_META,
  lensMeta,
  RUN_STATUS_LABEL,
  type LensId,
  type LensRunRecord
} from '@shared/lenses'
import { allCategories, categoryColor, categoryLabel, groupCategories } from '@shared/taxonomy'
import { emptyExperimentProfile } from '@shared/experiment'
import { insertMarkdownSnippet } from '@shared/figures'
import { STATUS_LABEL } from '@shared/types'
import type { PaperMeta, PaperStatus } from '@shared/types'
import { cn, downloadText, errorMessage } from '@/lib/utils'
import { collectionsOfPaper, useAppStore } from '@/store/useAppStore'
import { AddToCollectionDialog } from './AddToCollectionDialog'
import { CollectionPanel } from './CollectionPanel'
import { PdfReader } from './PdfReader'
import { ExperimentProfilePanel } from './ExperimentProfilePanel'
import { SectionEditor } from './SectionEditor'
import { MethodFlowCard } from './MethodFlowCard'
import { MindMapCard } from './MindMapCard'
import { MyThoughts } from './MyThoughts'
import { ReferencesPanel } from './ReferencesPanel'
import { ChatPanel } from './ChatPanel'
import { Button, Chip, EmptyState, IconButton, Modal, useConfirm } from './ui'

type Tab = 'notes' | 'source' | 'exp' | 'chat'

interface Draft {
  meta: PaperMeta
  sections: Record<string, string>
}

/**
 * 「上次精读」状态条。
 *
 * 存在的意义只有一个：让「笔记是空的」这件事有个解释。以前精读的产出只写回
 * 「跑完、且至少一个维度成功」的那一刻，其余情况（失败 / 取消 / 根本没能启动）
 * 全都不留痕迹 —— 用户只能对着一片空白猜是论文没写还是系统出错。
 */
function LastRunBar({
  paperId,
  record,
  busy,
  onRerun,
  onRetryFailed
}: {
  paperId: string
  record?: LensRunRecord | null
  busy: boolean
  /** 按设置里启用的全部维度重跑 */
  onRerun: () => void
  /** 只重跑这些维度 */
  onRetryFailed: (lensIds: LensId[]) => void
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  // 从没跑过就不占位置（注意 hooks 必须都在这个提前返回之前）
  const settings = useAppStore((s) => s.settings)

  /*
   * 可以关掉。
   *
   * 这条提示的职责是「解释笔记为什么是空的」，读明白之后它就是噪音 ——
   * 尤其是失败了一次、暂时不打算重试的论文，它会在每一篇的顶部各占一行。
   *
   * 关闭状态按 `finishedAt` 记：**认的是「哪一次精读」而不是「哪篇论文」**。
   * 所以下次真跑一次（时间戳变了）它会自己回来，不会因为以前关过就永久失声。
   */
  const dismissKey = `papervault.lastrun.dismissed.${paperId}`
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!record) return
    try {
      setDismissed(localStorage.getItem(dismissKey) === record.finishedAt)
    } catch {
      // 隐私模式 / 存储被禁用：不记忆，本次会话内仍可关
    }
  }, [dismissKey, record])

  if (!record || dismissed) return null

  const failed = record.lenses.filter((l) => !l.ok)
  /*
   * 「成功但有保留」也要能被点开看到：只产出 2/3 节这类警告以前被一个 ✓ 盖住，
   * 界面上完全看不出这一节其实没写全。
   */
  const noted = record.lenses.filter((l) => l.ok && l.note)
  const issues = [...failed, ...noted]
  const bad = record.status !== 'ok'
  const tone =
    record.status === 'ok'
      ? 'text-ok'
      : record.status === 'cancelled'
        ? 'text-ink-mid'
        : 'text-warn'

  /*
   * 用量：金额只在用户填了单价时才出现 —— 没填就只显示 token 数。
   * 显示「¥0.00」比不显示更糟，那会让人以为这次精读是免费的。
   */
  const u = record.usage
  const totalTokens = u ? u.promptTokens + u.completionTokens : 0
  const costText = u
    ? formatCost(estimateCost(u, settings.llm.priceInput, settings.llm.priceOutput))
    : ''
  const usageTitle = u
    ? [
        `${u.calls} 次调用 · ${u.requests} 次请求${
          u.requests > u.calls ? `（重试 ${u.requests - u.calls} 次）` : ''
        }`,
        `输入 ${u.promptTokens.toLocaleString('zh-CN')} / 输出 ${u.completionTokens.toLocaleString('zh-CN')} token`,
        `耗时 ${formatDuration(u.elapsedMs)}`,
        u.model ? `模型 ${u.model}` : '',
        // 天书一样的指纹，作用只有一个：两次精读对一下，就知道 prompt 变没变过
        `prompt 版本 ${u.prompt}`,
        u.truncated ? `${u.truncated} 次撞上 max_tokens` : '',
        u.failed ? `${u.failed} 次失败（同样计费）` : ''
      ]
        .filter(Boolean)
        .join('\n')
    : ''

  return (
    <div
      className={cn(
        'rounded-xl border px-4 py-2.5',
        record.status === 'ok'
          ? 'border-ok/30 bg-ok/[0.08]'
          : record.status === 'cancelled'
            ? 'border-line bg-white/[0.04]'
            : 'border-warn/40 bg-warn/10'
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {bad ? (
          <AlertTriangle className={cn('h-3.5 w-3.5 shrink-0', tone)} />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-ok" />
        )}
        <span className={cn('text-meta font-medium', tone)}>
          上次精读 · {RUN_STATUS_LABEL[record.status]}
        </span>
        <span className="text-caption text-ink-low">
          {new Date(record.finishedAt).toLocaleString('zh-CN')}
        </span>
        {u ? (
          <span className="shrink-0 text-caption text-ink-low" title={usageTitle}>
            {/*
             * 别显示「0 token」。
             *
             * 部分重跑时 usage 只记**本次**那一个维度（见 mergeRunRecord），
             * 而请求失败时服务商不返回用量，于是整条状态条上写着一个刺眼的
             * 「0 token」—— 看起来像这次精读没花任何成本，实际上前面几万
             * token 已经花掉了。真拿不到用量就明说「未计费」。
             */}
            {totalTokens > 0
              ? `${record.message.startsWith('只重试了') ? '本次重试 ' : ''}${formatTokens(totalTokens)} token`
              : '本次未计费'}
            {totalTokens > 0 && costText ? ` · ${costText}` : ''}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-meta text-ink-mid" title={record.message}>
          {record.message}
        </span>
        {issues.length ? (
          <button
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 rounded-md border border-line px-2 py-0.5 text-caption text-ink-low transition hover:border-strong hover:text-ink-mid"
          >
            {open
              ? '收起'
              : failed.length === issues.length
                ? `看 ${failed.length} 个失败原因`
                : `看 ${issues.length} 个明细`}
          </button>
        ) : null}
        {bad ? (
          busy ? (
            <span className="shrink-0 rounded-md border border-line px-2 py-0.5 text-caption text-ink-low">
              运行中…
            </span>
          ) : (
            <>
              {/*
               * 默认只补失败的那几个。
               *
               * 全量重跑在这个场景下几乎总是错的：本来成功的维度会被重新生成
               *（温度 0.3，输出必然不同），于是为了修 1 个维度，
               * 手改过的另外几节被覆盖掉。
               */}
              {failed.length ? (
                <button
                  onClick={() => onRetryFailed(failed.map((l) => l.id))}
                  className="shrink-0 rounded-md border border-warn/40 px-2 py-0.5 text-caption text-warn transition hover:bg-warn/10"
                >
                  只重试失败 {failed.length} 个
                </button>
              ) : null}
              <button
                onClick={onRerun}
                title="按设置里启用的全部维度重跑，已经写好的章节会被重新生成"
                className="shrink-0 rounded-md border border-line px-2 py-0.5 text-caption text-ink-low transition hover:border-strong hover:text-ink-mid"
              >
                全部重跑
              </button>
            </>
          )
        ) : null}
        {/*
         * 关闭按钮：这条提示的用途是「解释为什么笔记是空的」，看过一次就够了。
         * 记住的是这一次运行的时间戳，所以下次真跑一次它会自己回来。
         */}
        <button
          onClick={() => {
            setDismissed(true)
            try {
              localStorage.setItem(dismissKey, record.finishedAt)
            } catch {
              // 存不进去就只在本次会话内生效
            }
          }}
          title="关掉这条提示（下次精读后会重新出现）"
          aria-label="关掉上次精读提示"
          className="-mr-1 shrink-0 rounded-md p-0.5 text-ink-low transition hover:bg-white/10 hover:text-ink-high"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {open ? (
        <div className="mt-2 space-y-1.5 border-t border-white/10 pt-2">
          {issues.map((l) => (
            <div key={l.id} className="text-meta leading-relaxed">
              <span className="font-medium text-ink-high">{l.ok ? `${l.label} ✓` : l.label}</span>
              <span className="text-ink-mid">　{l.ok ? l.note : l.message}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function PaperDetail(): JSX.Element {
  const detail = useAppStore((s) => s.detail)
  const loading = useAppStore((s) => s.loadingDetail)
  const settings = useAppStore((s) => s.settings)
  // 关联论文面板要拿全库来挑目标、以及现算「谁指向我」
  const papers = useAppStore((s) => s.papers)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [tab, setTab] = useState<Tab>('notes')
  /**
   * 看 PDF 时收起页眉那堆论文信息（标题 / 分类 / 标签 / 关联论文），把纵向空间让给正文。
   *
   * 横向窗口里「适应宽度」会让页面比视口高出一倍多，页眉再压掉三百来像素的话，
   * 一屏就只剩半页了。只在「原文 + PDF 原版面」时生效（class 加在 header 上，
   * 见下方 CSS 里的 .pdf-focus），其它 tab 完全不受影响；想顺手改个分类、打分，
   * 点 tabs 右侧那个按钮展开即可。
   */
  const [pdfFocus, setPdfFocus] = useState(true)
  const [saveState, setSaveState] = useState<'idle' | 'pending' | 'saved' | 'error'>('idle')
  const [summarizing, setSummarizing] = useState(false)
  const [rewriting, setRewriting] = useState<string | null>(null)
  const [categoryOpen, setCategoryOpen] = useState(false)
  const [sourceText, setSourceText] = useState<string | null>(null)
  /** 「原文」标签页的显示方式：默认直接看 PDF 原始版面，而不是提取出来的文字 */
  const [sourceMode, setSourceMode] = useState<'pdf' | 'text'>('pdf')
  const [pdfJump, setPdfJump] = useState<{ page: number; at: number } | null>(null)
  const [tagInput, setTagInput] = useState('')
  const [extractingProfile, setExtractingProfile] = useState(false)
  const [lensPickerOpen, setLensPickerOpen] = useState(false)
  const [addToCollectionOpen, setAddToCollectionOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(() => localStorage.getItem(INFO_OPEN_KEY) === '1')
  const toggleInfo = (): void => {
    setInfoOpen((v) => {
      localStorage.setItem(INFO_OPEN_KEY, v ? '0' : '1')
      return !v
    })
  }
  const { confirm: askDelete, dialog: deleteDialog } = useConfirm()
  const collections = useAppStore((s) => s.collections)
  const collectionId = useAppStore((s) => s.filters.collectionId)
  const selectCollection = useAppStore((s) => s.selectCollection)
  const removePapersFromCollection = useAppStore((s) => s.removePapersFromCollection)

  /** 实际启用的维度数。设置里存的是「关掉了哪些」，这里换算一次 */
  const enabledCount = enabledLensIds(settings.disabledLenses).length

  /**
   * 笔记所在目录（相对知识库根）。
   *
   * 笔记正文里的图片写的是**相对笔记文件**的路径（`../figures/<id>/fig-1.png`，
   * 这样知识库整体搬走不会断链），渲染时要拿这个目录当基准去解析；
   * 用当前页面地址解析只会指到 dev server 上去。
   */
  const noteDir = (detail?.relPath ?? '').split('/').slice(0, -1).join('/')

  const lastIdRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftRef = useRef<Draft | null>(null)
  const dirtyRef = useRef(false)
  draftRef.current = draft
  /** 笔记编辑器里最近一次光标位置（精确到字符）。换论文后旧记录作废 */
  const caretRef = useRef<{ section: string; pos: number } | null>(null)
  /** 最近手动编辑过的章节：光标记录缺位时的插入回落点 */
  const lastEditedRef = useRef<string | null>(null)

  const sectionKeys = useMemo(
    () => allSectionKeys(settings.customSections),
    [settings.customSections]
  )

  const flush = useCallback(async () => {
    const current = draftRef.current
    if (!current || !dirtyRef.current) return true
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const saved = await useAppStore.getState().savePaper({
      id: current.meta.id,
      meta: current.meta,
      sections: current.sections
    })
    // A previous paper's response must not acknowledge a newer draft as saved.
    if (draftRef.current === current) {
      dirtyRef.current = !saved
      setSaveState(saved ? 'saved' : 'error')
    }
    return !!saved
  }, [])

  /**
   * 保存成功才继续跑 AI。
   *
   * 以前这里是一句光秃秃的 `if (!(await flush())) return`：保存失败时点
   * 「只重试失败 1 个」完全没有任何反馈，看起来就像按钮坏了 —— 而这正是
   * 「失败重试有 bug」最容易产生的错觉。现在至少说一句为什么没跑。
   */
  const flushOrWarn = useCallback(async (): Promise<boolean> => {
    if (await flush()) return true
    useAppStore
      .getState()
      .toast('笔记还没保存成功，先处理保存错误（右下角会提示原因）再重试', 'error')
    return false
  }, [flush])

  useEffect(() => {
    const incomingId = detail?.id ?? null
    if (incomingId && incomingId !== lastIdRef.current) {
      // 切换论文前，先把上一篇里还没落盘的改动写回 Markdown
      if (lastIdRef.current && dirtyRef.current) void flush()
      lastIdRef.current = incomingId
      const next = { meta: detail!.meta, sections: { ...detail!.sections } }
      draftRef.current = next
      dirtyRef.current = false
      setDraft(next)
      setSourceText(null)
      setSourceMode('pdf')
      setTab('notes')
      setSaveState('idle')
      caretRef.current = null
      lastEditedRef.current = null
      return
    }
    if (!incomingId) {
      if (dirtyRef.current) void flush()
      lastIdRef.current = null
      draftRef.current = null
      dirtyRef.current = false
      setDraft(null)
    }
  }, [detail, flush])

  const schedule = useCallback(
    (next: Draft) => {
      setDraft(next)
      draftRef.current = next
      dirtyRef.current = true
      setSaveState('pending')
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        void flush()
      }, 900)
    },
    [flush]
  )

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (dirtyRef.current) void flush()
    },
    [flush]
  )

  const reload = useCallback(async () => {
    if (!detail) return
    const id = detail.id
    await useAppStore.getState().selectPaper(null)
    await useAppStore.getState().selectPaper(id)
    await useAppStore.getState().refreshAll()
  }, [detail])

  const loadSource = useCallback(async () => {
    if (!detail || sourceText !== null) return
    try {
      const text = await window.papervault.papers.text(detail.id)
      setSourceText(text || '（这篇论文还没有抽取到原文，可能是手动建立的条目。）')
    } catch (err) {
      /*
       * 必须落一个终态：sourceText 停在 null 的话，渲染层永远停在那句
       * 「正在读取原文…」的转圈上 —— 既不报错，也没有重试入口。
       */
      setSourceText(`（读取原文失败：${errorMessage(err)}）`)
    }
  }, [detail, sourceText])

  const handleOpenPdf = useCallback(async () => {
    if (!detail) return
    const res = await window.papervault.papers.openPdf(detail.id)
    if (!res.ok) useAppStore.getState().toast(res.message ?? '无法打开 PDF', 'error')
  }, [detail])

  useEffect(() => {
    if (tab === 'source') void loadSource()
  }, [tab, loadSource])

  if (loading && !detail) {
    return (
      <main className="flex h-full flex-1 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-brand-soft" />
      </main>
    )
  }

  if (!detail || !draft) {
    if (collectionId) return <CollectionPanel collectionId={collectionId} />
    return (
      <main className="flex h-full min-w-0 flex-1 items-center justify-center bg-bg-base">
        <EmptyState
          icon={<BookOpen className="h-10 w-10" />}
          title="从左侧选一篇论文"
          description="每篇论文都会按固定章节沉淀「写作手法」与「实验方法论」，攒够同类论文后就能一键归纳出这一类论文的通用套路。"
        />
      </main>
    )
  }

  const { meta, sections } = draft
  const paperCollections = collectionsOfPaper(collections, meta.id)
  const selectedIds = new Set(meta.categories)
  const infoSummary = [
    meta.categories.length ? `${meta.categories.length} 分类` : '',
    meta.tags.length ? `${meta.tags.length} 标签` : '',
    paperCollections.length ? `${paperCollections.length} 专题` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  /** 有没有可以用来抽取实验画像的材料 */
  const hasProfileSource =
    detail.hasPdf ||
    (sections['实验方法论'] ?? '').trim().length > 60 ||
    (sections['写作手法 · Experiments'] ?? '').trim().length > 60

  /** 原文页正在内嵌看 PDF：此时外层不滚动，把整块高度让给 iframe */
  const showPdfViewer = tab === 'source' && detail.hasPdf && sourceMode === 'pdf'

  const patchMeta = (patch: Partial<PaperMeta>): void =>
    schedule({ meta: { ...meta, ...patch }, sections })

  const patchSection = (key: string, value: string): void => {
    lastEditedRef.current = key
    schedule({ meta, sections: { ...sections, [key]: value } })
  }

  /**
   * 把截取的图表片段直接写进笔记草稿，返回落点章节（失败返回空串）。
   *
   * 插入必须走这里而不是别处直写 store：draft 是权威草稿，900ms 防抖后
   * 整体落盘，绕过它写的store 会在下一次保存时被覆盖掉。
   *
   * 落点优先级：最近光标位置（精确到字符）→ 最近编辑过的章节 → 第一个章节。
   * PDF 阅读器和笔记编辑器分属两个标签页，截图那一刻编辑器多半没挂载，
   * 「光标」只能靠编辑时顺手记录；三档都没有才退到第一个章节，且 toast
   * 会明说落点，不会静默插到用户找不到的地方。
   *
   * 插完把光标记录挪到片段末尾 —— 连截几张图会按截图顺序往下排。
   * 刻意不切到笔记标签页：用户通常还要连截好几张，切走反而打断。
   */
  const insertToNote = (markdown: string): string => {
    const current = draftRef.current
    if (!current || !markdown) return ''
    const keys = sectionKeys
    if (!keys.length) return ''
    const caret = caretRef.current
    const fallback = lastEditedRef.current
    const key =
      caret && keys.includes(caret.section)
        ? caret.section
        : fallback && keys.includes(fallback)
          ? fallback
          : keys[0]
    const content = current.sections[key] ?? ''
    const result = insertMarkdownSnippet(
      content,
      caret && caret.section === key ? caret.pos : null,
      markdown
    )
    schedule({
      meta: current.meta,
      sections: { ...current.sections, [key]: result.next }
    })
    caretRef.current = { section: key, pos: result.at }
    useAppStore.getState().toast(`已插入「${key}」`, 'success')
    return key
  }

  const handleSummarize = async (): Promise<void> => {
    setSummarizing(true)
    useAppStore.getState().setBusy('AI 正在精读全文…')
    try {
      if (!(await flushOrWarn())) return
      const res = await window.papervault.ai.summarize(meta.id)
      useAppStore.getState().toast(res.message, res.ok ? 'success' : 'error')
      /*
       * 失败也要重载：这次运行的结局（含「压根没跑起来」）已经落到索引里，
       * 详情页要把它显示出来 —— 否则用户只看得到一闪而过的 toast，
       * 之后笔记还是一片空白，和「论文没写」分不开。
       */
      await reload()
    } catch (err) {
      useAppStore.getState().toast(`精读失败：${errorMessage(err)}`, 'error')
    } finally {
      useAppStore.getState().setBusy(null)
      setSummarizing(false)
    }
  }

  /**
   * 只重跑指定的维度 —— 状态条上「只重试失败 N 个」走这里。
   *
   * 为什么不复用 handleSummarize：那个按设置里启用的维度全量重跑，
   * 会把已经成功的维度重新生成一遍（输出必然不同），手改过的章节会被覆盖。
   */
  const handleRetryFailed = async (lensIds: LensId[]): Promise<void> => {
    if (!lensIds.length) return
    setSummarizing(true)
    useAppStore.getState().setBusy(`正在重试 ${lensIds.length} 个维度…`)
    try {
      if (!(await flushOrWarn())) return
      const res = await window.papervault.ai.runLens(meta.id, lensIds)
      useAppStore.getState().toast(res.message, res.ok ? 'success' : 'error')
      await reload()
    } catch (err) {
      useAppStore.getState().toast(`重试失败：${errorMessage(err)}`, 'error')
    } finally {
      useAppStore.getState().setBusy(null)
      setSummarizing(false)
    }
  }

  const handleRewrite = async (key: string): Promise<void> => {
    setRewriting(key)
    useAppStore.getState().setBusy(`正在重写「${key}」…`)
    try {
      if (!(await flushOrWarn())) return
      const res = await window.papervault.ai.rewriteSection(meta.id, key)
      if (res.ok) {
        const next = {
          meta,
          sections: {
            ...(draftRef.current?.sections ?? sections),
            [key]: res.content
          }
        }
        schedule(next)
        useAppStore.getState().toast(`「${key}」已重写`, 'success')
      } else {
        useAppStore.getState().toast(res.message ?? '重写失败', 'error')
      }
    } catch (err) {
      useAppStore.getState().toast(`重写失败：${errorMessage(err)}`, 'error')
    } finally {
      useAppStore.getState().setBusy(null)
      setRewriting(null)
    }
  }

  /** 只重跑某一个分析维度（例如只更新「英语写作短语」） */
  const handleRunLens = async (lensId: LensId): Promise<void> => {
    setLensPickerOpen(false)
    setSummarizing(true)
    useAppStore.getState().setBusy(`正在运行「${lensMeta(lensId).label}」…`)
    try {
      if (!(await flushOrWarn())) return
      const res = await window.papervault.ai.runLens(meta.id, lensId)
      useAppStore.getState().toast(res.message, res.ok ? 'success' : 'error')
      await reload()
    } catch (err) {
      useAppStore.getState().toast(`运行失败：${errorMessage(err)}`, 'error')
    } finally {
      useAppStore.getState().setBusy(null)
      setSummarizing(false)
    }
  }

  const handleExtractProfile = async (): Promise<void> => {
    setExtractingProfile(true)
    useAppStore.getState().setBusy('正在抽取实验画像…')
    try {
      if (!(await flushOrWarn())) return
      const res = await window.papervault.ai.buildProfile(meta.id)
      useAppStore.getState().toast(res.message, res.ok ? 'success' : 'error')
      // 同上：失败也要重载，让「上次运行」的记录显示出来
      await reload()
    } catch (err) {
      useAppStore.getState().toast(`抽取失败：${errorMessage(err)}`, 'error')
    } finally {
      useAppStore.getState().setBusy(null)
      setExtractingProfile(false)
    }
  }

  const handleExport = (): void => {
    const metaLine = [
      meta.authors.length ? meta.authors.join(', ') : '',
      meta.venue,
      meta.year ? String(meta.year) : ''
    ]
      .filter(Boolean)
      .join(' · ')
    const head = [
      `# ${meta.title}`,
      '',
      metaLine ? `> ${metaLine}` : '',
      meta.arxivId ? `> arXiv:${meta.arxivId}` : '',
      meta.url ? `> ${meta.url}` : '',
      '',
      ''
    ]
      .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
      .join('\n')
    /*
     * 章节用当前草稿渲染（「导出的是你眼前看到的」），但正文顶部那段不属于
     * 任何章节的手写内容不在草稿里 —— 它只能在磁盘上的原文里找到，
     * 所以从 `detail.body` 里取出来补在最前面。少了这一步，导出会悄悄
     * 丢掉用户自己写在前言的批注。
     */
    const preamble = detail?.body ? paperPreamble(detail.body) : ''
    downloadText(
      `${meta.title}.md`,
      `${head}${preamble ? `${preamble}\n\n` : ''}${renderPaperBody(sections, settings.customSections)}`
    )
  }

  const addTag = (): void => {
    const value = tagInput.trim().replace(/^#/, '')
    if (!value || meta.tags.includes(value)) {
      setTagInput('')
      return
    }
    patchMeta({ tags: [...meta.tags, value] })
    setTagInput('')
  }

  const categoryGroups = groupCategories(allCategories(settings.customCategories))

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-bg-base">
      {/* 头部 */}
      <header
        className={cn(
          'shrink-0 border-b border-line px-5 pb-3 pt-4',
          // 收起态：页眉只留 tabs（.pdf-focus-keep），其余直接子元素在 CSS 里隐藏
          showPdfViewer && pdfFocus && 'pdf-focus'
        )}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {/*
             * 标题是「论文的内容面」，用衬线 18px——宋体/Georgia 的大字号标题
             * 正是论文首页的样子；年份/会议这类编目字段保持无衬线小字，
             * 「内容衬线、骨架无衬线」是整套界面的分界规则。
             */}
            <input
              value={meta.title}
              onChange={(e) => patchMeta({ title: e.target.value })}
              placeholder="论文标题"
              className="w-full bg-transparent font-serif text-[18px] font-semibold leading-snug text-ink-high outline-none placeholder:text-ink-low"
            />
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ink-mid">
              <input
                value={meta.authors.join(', ')}
                onChange={(e) =>
                  patchMeta({
                    authors: e.target.value
                      .split(',')
                      .map((a) => a.trim())
                      .filter(Boolean)
                  })
                }
                placeholder="作者（逗号分隔）"
                className="min-w-[180px] flex-1 bg-transparent font-serif text-ui text-ink-mid outline-none placeholder:font-sans placeholder:text-ink-low"
              />
              {/*
               * 年份 / 会议是「编目字段」：做成目录卡上的下划线填空，而不是
               * 又一个表单盒子——和这条元信息行的书卷气一致。年份用等宽数字，
               * 会议保持衬线斜体。
               */}
              <input
                value={meta.year ?? ''}
                onChange={(e) =>
                  patchMeta({
                    year: e.target.value ? Number(e.target.value) || null : null
                  })
                }
                placeholder="年份"
                className="w-14 border-b border-line bg-transparent px-1 py-0.5 text-center font-mono text-meta outline-none transition placeholder:font-sans placeholder:text-ink-low focus:border-brand-soft"
              />
              <input
                value={meta.venue}
                onChange={(e) => patchMeta({ venue: e.target.value })}
                placeholder="会议 / 期刊"
                className="w-40 border-b border-line bg-transparent px-1 py-0.5 font-serif text-meta italic outline-none transition placeholder:font-sans placeholder:not-italic placeholder:text-ink-low focus:border-brand-soft"
              />
              {meta.arxivId ? (
                <button
                  onClick={() =>
                    void window.papervault.app.openExternal(`https://arxiv.org/abs/${meta.arxivId}`)
                  }
                  className="inline-flex items-center gap-0.5 text-brand-mist hover:underline"
                >
                  arXiv:{meta.arxivId}
                  <ExternalLink className="h-3 w-3" />
                </button>
              ) : null}
              {meta.url ? (
                <button
                  onClick={() => void window.papervault.app.openExternal(meta.url)}
                  className="inline-flex items-center gap-0.5 text-brand-mist hover:underline"
                >
                  链接
                  <ExternalLink className="h-3 w-3" />
                </button>
              ) : null}
              <span className="ml-auto flex items-center gap-2.5">
                <Stars value={meta.rating} onChange={(v) => patchMeta({ rating: v })} />
                <select
                  value={meta.status}
                  onChange={(e) => patchMeta({ status: e.target.value as PaperStatus })}
                  className="rounded border border-line bg-bg-raised px-1.5 py-0.5 text-meta text-ink-mid outline-none focus:border-brand/50"
                >
                  {(Object.keys(STATUS_LABEL) as PaperStatus[]).map((s) => (
                    <option key={s} value={s} className="bg-bg-overlay">
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
                <button
                  onClick={toggleInfo}
                  title={infoOpen ? '收起分类 / 标签 / 专题' : '展开分类 / 标签 / 专题'}
                  className={cn(
                    'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-meta transition hover:bg-white/[0.06] hover:text-ink-high',
                    infoOpen ? 'text-ink-high' : 'text-ink-low'
                  )}
                >
                  {infoSummary || '分类 / 标签'}
                  <ChevronDown className={cn('h-3 w-3 transition', infoOpen && 'rotate-180')} />
                </button>
              </span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="primary"
              size="sm"
              icon={summarizing ? undefined : <Sparkles className="h-3.5 w-3.5" />}
              loading={summarizing}
              onClick={() => setLensPickerOpen(true)}
            >
              {summarizing ? '运行中' : 'AI 精读'}
            </Button>
            {meta.pdf ? (
              <IconButton title="预览 PDF（独立窗口）" onClick={() => void handleOpenPdf()}>
                <FileText className="h-4 w-4" />
              </IconButton>
            ) : null}
            <MoreMenu
              items={[
                ...(meta.pdf
                  ? [
                      {
                        label: '在文件夹中显示 PDF',
                        icon: FolderOpen,
                        onClick: () => void window.papervault.vault.reveal(meta.pdf)
                      }
                    ]
                  : []),
                {
                  label: '导出为 Markdown',
                  icon: Download,
                  onClick: handleExport
                },
                {
                  label: '删除这篇笔记',
                  icon: Trash2,
                  danger: true,
                  onClick: () => {
                    void askDelete({
                      title: '删除这篇笔记？',
                      description: `《${meta.title}》的精读笔记与已归档的 PDF 副本都会被删除，此操作不可撤销。`,
                      confirmLabel: '删除',
                      danger: true
                    }).then((ok) => {
                      if (ok) void useAppStore.getState().deletePaper(meta.id)
                    })
                  }
                }
              ]}
            />
          </div>
        </div>

        {infoOpen ? (
          <div className="mt-2.5 space-y-1.5 rounded-lg border border-line bg-white/[0.02] px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="flex flex-wrap items-center gap-1">
                {meta.categories.map((id) => (
                  <Chip
                    key={id}
                    color={categoryColor(id, settings.customCategories)}
                    active
                    onClick={() =>
                      patchMeta({
                        categories: meta.categories.filter((c) => c !== id)
                      })
                    }
                    title="点击移除"
                  >
                    {categoryLabel(id, settings.customCategories)}
                    <X className="h-2.5 w-2.5" />
                  </Chip>
                ))}
                <button
                  onClick={() => setCategoryOpen(true)}
                  className="chip border-dashed text-ink-low transition hover:border-brand/60 hover:text-brand-mist"
                >
                  <Plus className="h-2.5 w-2.5" />
                  分类
                </button>
              </div>

              <div className="ml-auto flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-meta text-ink-low">
                  重要性
                  <select
                    value={meta.importance}
                    onChange={(e) => patchMeta({ importance: Number(e.target.value) })}
                    className="rounded border border-line bg-bg-raised px-1.5 py-0.5 text-meta text-ink-mid outline-none focus:border-brand/50"
                  >
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n} className="bg-bg-overlay">
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1">
              {meta.tags.map((t) => (
                <Chip key={t} onClick={() => patchMeta({ tags: meta.tags.filter((x) => x !== t) })}>
                  #{t}
                  <X className="h-2.5 w-2.5" />
                </Chip>
              ))}
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addTag()
                  }
                }}
                onBlur={addTag}
                placeholder="+ 标签"
                className="w-24 bg-transparent text-meta text-ink-mid outline-none placeholder:text-ink-low"
              />
            </div>

            <div className="flex flex-wrap items-center gap-1">
              {paperCollections.map((c) => (
                <Chip
                  key={c.id}
                  active={collectionId === c.id}
                  onClick={() => selectCollection(c.id)}
                  title="查看这个专题"
                  className="gap-1"
                >
                  <Layers className="h-2.5 w-2.5" />
                  {c.title}
                  <button
                    type="button"
                    title="从专题移出"
                    onClick={(e) => {
                      e.stopPropagation()
                      void removePapersFromCollection(c.id, [meta.id])
                    }}
                    className="rounded p-0.5 text-ink-low hover:text-warn"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </Chip>
              ))}
              <button
                type="button"
                onClick={() => setAddToCollectionOpen(true)}
                className="chip cursor-pointer text-ink-low hover:border-strong hover:text-ink-mid"
              >
                + 专题
              </button>
            </div>
          </div>
        ) : null}

        {/*
         * Tabs 用期刊式「ruling」下划线：激活项压一条松绿短线在页眉的
         * hairline 上（纸页的天头地脚就是这么排的），而不是整块底色药丸。
         */}
        <div className="pdf-focus-keep mt-3 flex flex-wrap items-center gap-0.5">
          {(
            [
              ['notes', '结构化笔记', BookOpen],
              ['exp', '实验画像', FlaskConical],
              ['source', '原文', FileText],
              ['chat', 'AI 问答', MessageSquare]
            ] as [Tab, string, typeof BookOpen][]
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                'relative inline-flex items-center gap-1.5 px-2.5 py-1.5 text-ui transition',
                tab === key ? 'font-medium text-ink-high' : 'text-ink-mid hover:text-ink-high'
              )}
            >
              <Icon className={cn('h-3.5 w-3.5', tab === key ? 'text-brand-soft' : '')} />
              {label}
              {/* -bottom-[13px]：页眉 pb-3 + 1px 边框，让短线正好压在 hairline 上 */}
              {tab === key ? (
                <span className="absolute inset-x-1.5 -bottom-[13px] h-[2px] rounded-full bg-brand-soft" />
              ) : null}
            </button>
          ))}
          <span className="ml-auto flex items-center gap-1.5 text-caption text-ink-low">
            {saveState === 'pending' ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                正在保存…
              </>
            ) : saveState === 'saved' ? (
              <>
                <Check className="h-3 w-3 text-ok" />
                已保存到 Markdown
              </>
            ) : saveState === 'error' ? (
              <button className="text-warn underline" onClick={() => void flush()}>
                保存失败，点击重试
              </button>
            ) : null}
          </span>
          {/* 只在看 PDF 时出现：展开 / 收起页眉里那堆论文信息 */}
          {showPdfViewer ? (
            <button
              onClick={() => setPdfFocus((v) => !v)}
              className="ml-2 shrink-0 rounded-lg border border-line px-2 py-0.5 text-caption text-ink-low transition hover:border-strong hover:text-ink-mid"
            >
              {pdfFocus ? '显示论文信息' : '收起论文信息'}
            </button>
          ) : null}
        </div>
      </header>

      {/* 内容 */}
      <div
        className={cn(
          // min-w-0：同上，横向也得允许被压缩，否则放大后的页面会把整页顶宽
          'min-h-0 min-w-0 flex-1 px-5 py-4',
          // 内嵌 PDF 时把滚动交给 PDF 阅读器自己，外层滚动会跟它抢滚轮事件
          showPdfViewer ? 'overflow-hidden' : 'overflow-y-auto'
        )}
      >
        {tab === 'notes' ? (
          <div className="mx-auto max-w-3xl space-y-4 pb-16">
            {/*
              上次精读的结局。放在章节列表最上面，正是因为「一片空白的笔记」
              最需要的解释就在这里 —— 是没跑过、跑失败了，还是论文确实没内容。
            */}
            <LastRunBar
              paperId={detail.meta.id}
              record={detail.lastRun}
              busy={summarizing}
              onRerun={() => void handleSummarize()}
              onRetryFailed={(ids) => void handleRetryFailed(ids)}
            />
            <MyThoughts
              highlights={meta.highlights ?? []}
              onOpen={(page) => {
                if (detail.hasPdf) setSourceMode('pdf')
                setPdfJump({ page, at: Date.now() })
                setTab('source')
              }}
            />
            {SECTION_GROUP_ORDER.map((group) => {
              const keys = sectionKeys.filter((k) => sectionGroup(k) === group)
              if (!keys.length) return null
              return (
                <section key={group} className="space-y-1.5">
                  {/*
                   * 分组标题后接一段带铜色的细线（gilt rule）——纸书里章首
                   * 装饰线的做法，比一条灰色分隔线多一点「装帧」的意思。
                   */}
                  <h3 className="flex items-center gap-2.5 text-meta font-medium uppercase tracking-wider text-ink-low">
                    {group}
                    <span className="h-px flex-1 bg-gradient-to-r from-brand/30 to-line" />
                    {/*
                      这几节散文回答「这一节怎么写」，而「为什么这么写、引用在承担什么」
                      是跨篇才看得出来的东西 —— 入口统一放「写作思路」页，不在这里重复。
                    */}
                    {group === '写作拆解' ? (
                      <button
                        onClick={() => useAppStore.getState().openWriting(meta.id)}
                        title="在「写作思路」里看结构化拆解：故事线、逐段引用功能、优势对齐、贡献回扣"
                        className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-caption normal-case tracking-normal text-ink-low transition hover:bg-white/[0.06] hover:text-brand-mist"
                      >
                        <PenLine className="h-3 w-3" />
                        写作思路
                      </button>
                    ) : null}
                  </h3>
                  {/*
                    思维导图挂在「速览」分组最上面：它是整篇的结构总览，
                    初学者先看图建立框架，再往下读一句话总结和故事线。
                  */}
                  {group === '速览' && meta.mindmap ? <MindMapCard map={meta.mindmap} /> : null}
                  {/*
                    方法流程图挂在「方法拆解」分组最上面。
                    放在这一组而不是单独开一块：它就是这一组内容的图版，
                    读者看完图再往下读文字，比先读两千字再回头看图轻松得多。
                  */}
                  {group === '方法拆解' && meta.flow ? <MethodFlowCard flow={meta.flow} /> : null}
                  {keys.map((key) => (
                    <SectionEditor
                      key={key}
                      sectionKey={key}
                      content={sections[key] ?? ''}
                      onChange={(value) => patchSection(key, value)}
                      onRewrite={() => void handleRewrite(key)}
                      rewriting={rewriting === key}
                      defaultOpen={group === '速览' && key === '一句话总结'}
                      imageBase={noteDir}
                      onCaretChange={(pos) => {
                        caretRef.current = { section: key, pos }
                      }}
                    />
                  ))}
                </section>
              )
            })}
            <ReferencesPanel paperId={meta.id} hasSource={detail.hasPdf} />
          </div>
        ) : null}

        {tab === 'exp' ? (
          <div className="mx-auto max-w-3xl pb-16">
            <ExperimentProfilePanel
              exp={meta.exp}
              onChange={(patch) =>
                patchMeta({
                  exp: { ...(meta.exp ?? emptyExperimentProfile()), ...patch }
                })
              }
              onExtract={() => void handleExtractProfile()}
              extracting={extractingProfile}
              hasSource={hasProfileSource}
            />
          </div>
        ) : null}

        {tab === 'source' ? (
          <div
            className={cn(
              showPdfViewer ? 'flex h-full min-h-0 flex-col' : 'mx-auto max-w-3xl pb-16'
            )}
          >
            {detail.hasPdf ? (
              <div className="mb-2 flex shrink-0 flex-wrap items-center gap-1.5">
                {(
                  [
                    ['pdf', 'PDF 原版面'],
                    ['text', '提取文本']
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    onClick={() => setSourceMode(mode)}
                    className={cn(
                      'rounded-lg border px-2.5 py-1 text-meta transition',
                      sourceMode === mode
                        ? 'border-brand/50 bg-brand/10 text-brand-mist'
                        : 'border-line text-ink-mid hover:border-strong hover:text-ink-high'
                    )}
                  >
                    {label}
                  </button>
                ))}
                <span className="ml-1 text-caption text-ink-low">
                  {sourceMode === 'pdf'
                    ? '原始版面，可缩放与页内搜索'
                    : '供复制粘贴与检索用的纯文本'}
                </span>
                <button
                  onClick={() => void handleOpenPdf()}
                  className="ml-auto flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-meta text-ink-mid transition hover:border-strong hover:text-ink-high"
                >
                  <ExternalLink className="h-3 w-3" />
                  独立窗口
                </button>
              </div>
            ) : null}

            {showPdfViewer ? (
              // relative：给 PdfReader 的 absolute inset-0 当包含块（见那边对 min-w-0 的说明）
              <div className="relative min-h-0 min-w-0 flex-1">
                <PdfReader
                  paperId={meta.id}
                  highlights={meta.highlights ?? []}
                  onHighlightsChange={(next) => patchMeta({ highlights: next })}
                  onInsertToNote={insertToNote}
                  jumpTo={pdfJump}
                />
              </div>
            ) : sourceText === null ? (
              <div className="flex justify-center py-10">
                <Loader2 className="h-5 w-5 animate-spin text-brand-soft" />
              </div>
            ) : (
              <pre className="whitespace-pre-wrap rounded-xl border border-line bg-bg-raised p-4 font-mono text-ui leading-relaxed text-ink-mid">
                {sourceText}
              </pre>
            )}
          </div>
        ) : null}

        {tab === 'chat' ? (
          <div className="mx-auto max-w-3xl pb-16">
            <ChatPanel paperIds={[meta.id]} />
          </div>
        ) : null}
      </div>

      <Modal
        open={lensPickerOpen}
        onClose={() => setLensPickerOpen(false)}
        title="AI 分析"
        subtitle="每个维度是一次独立的模型调用，有自己的 prompt 与输入。可以只重跑其中一个，不影响其他维度的产出。"
        width="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setLensPickerOpen(false)}>
              关闭
            </Button>
            <Button
              variant="primary"
              loading={summarizing}
              disabled={!enabledCount}
              onClick={() => {
                setLensPickerOpen(false)
                void handleSummarize()
              }}
            >
              运行全部启用维度（{enabledCount}）
            </Button>
          </>
        }
      >
        <div className="space-y-1.5">
          {LENS_META.map((lens) => {
            const enabled = !settings.disabledLenses.includes(lens.id)
            return (
              <div
                key={lens.id}
                className={cn(
                  'flex items-start gap-3 rounded-lg border px-3 py-2.5',
                  enabled ? 'border-line bg-bg-raised' : 'border-line/60 opacity-55'
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-ui font-medium text-ink-high">{lens.label}</span>
                    <span className="font-mono text-caption text-ink-low">{lens.id}</span>
                    {!enabled ? <span className="text-caption text-warn">设置里已关闭</span> : null}
                  </div>
                  <p className="mt-0.5 text-meta leading-relaxed text-ink-low">
                    {lens.description}
                  </p>
                  {lens.sections.length ? (
                    <p className="mt-1 text-caption leading-relaxed text-ink-low">
                      写入：{lens.sections.join('、')}
                    </p>
                  ) : (
                    <p className="mt-1 text-caption text-ink-low">不写章节，只产出结构化数据</p>
                  )}
                </div>
                <Button
                  variant="subtle"
                  size="sm"
                  disabled={summarizing}
                  onClick={() => void handleRunLens(lens.id)}
                >
                  只跑这个
                </Button>
              </div>
            )
          })}
        </div>
      </Modal>

      <Modal
        open={categoryOpen}
        onClose={() => setCategoryOpen(false)}
        title="选择分类"
        subtitle="可以多选。分类决定了「套路归纳」时这篇论文会和谁放在一起比较。"
        footer={
          <Button variant="subtle" onClick={() => setCategoryOpen(false)}>
            完成
          </Button>
        }
      >
        <div className="space-y-4">
          {categoryGroups.map((group) => (
            <div key={group.group}>
              <div className="mb-1.5 text-caption font-medium uppercase tracking-wider text-ink-low">
                {group.group}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {group.items.map((node) => {
                  const selected = selectedIds.has(node.id)
                  return (
                    <button
                      key={node.id}
                      onClick={() =>
                        patchMeta({
                          categories: selected
                            ? meta.categories.filter((c) => c !== node.id)
                            : [...meta.categories, node.id]
                        })
                      }
                      className={cn(
                        'flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition',
                        selected
                          ? 'border-brand/50 bg-brand/10'
                          : 'border-line hover:border-strong hover:bg-white/[0.03]'
                      )}
                    >
                      <span
                        className="mt-1 h-2 w-2 shrink-0 rounded-full"
                        style={{ background: node.color ?? '#7A766D' }}
                      />
                      <span className="min-w-0">
                        <span className="block text-ui font-medium text-ink-high">
                          {node.label}
                        </span>
                        {node.description ? (
                          <span className="mt-0.5 block text-caption leading-snug text-ink-low">
                            {node.description}
                          </span>
                        ) : null}
                      </span>
                      {selected ? (
                        <Check className="ml-auto mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-soft" />
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </Modal>

      <AddToCollectionDialog
        open={addToCollectionOpen}
        onClose={() => setAddToCollectionOpen(false)}
        paperIds={[meta.id]}
      />

      {deleteDialog}
    </main>
  )
}

const INFO_OPEN_KEY = 'pv.detail.infoOpen'

interface MoreMenuItem {
  label: string
  icon: typeof Download
  onClick: () => void
  danger?: boolean
}

function MoreMenu({ items }: { items: MoreMenuItem[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <IconButton title="更多操作" onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal className="h-4 w-4" />
      </IconButton>
      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[168px] rounded-lg border border-line bg-bg-overlay py-1 shadow-xl">
          {items.map(({ label, icon: Icon, onClick, danger }) => (
            <button
              key={label}
              onClick={() => {
                setOpen(false)
                onClick()
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui transition hover:bg-white/[0.06]',
                danger ? 'text-warn' : 'text-ink-mid hover:text-ink-high'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Stars({
  value,
  onChange
}: {
  value: number
  onChange: (value: number) => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-0.5" title="点击评分">
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          onClick={() => onChange(i === value ? 0 : i)}
          className="p-0.5 transition hover:scale-110"
        >
          <Star
            className={cn('h-3.5 w-3.5', i <= value ? 'fill-warn text-warn' : 'text-ink-low')}
          />
        </button>
      ))}
    </div>
  )
}
