import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import {
  Check,
  CheckSquare,
  FileText,
  Plus,
  Search,
  SlidersHorizontal,
  ClipboardList,
  Star,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { allCategories, categoryColor, categoryLabel } from '@shared/taxonomy'
import { STATUS_LABEL } from '@shared/types'
import type { PaperBulkUpdate, PaperStatus, PaperSummary } from '@shared/types'
import { authorLine, cn, formatDate, truncate } from '@/lib/utils'
import { selectVisiblePapers, useAppStore } from '@/store/useAppStore'
import { useUiStore } from '@/store/useUiStore'
import { usePanelStore } from '@/store/usePanelStore'
import { Button, Chip, EmptyState, Field, IconButton, Modal, useConfirm } from './ui'

/** 标签输入：逗号 / 空格分隔，允许带 # 前缀（和新建条目里的写法保持一致） */
function splitTags(raw: string): string[] {
  return raw
    .split(/[,，\s]+/)
    .map((t) => t.replace(/^#/, '').trim())
    .filter(Boolean)
}

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'updated', label: '最近更新' },
  { value: 'created', label: '最近入库' },
  { value: 'importance', label: '重要性' },
  { value: 'rating', label: '我的评分' },
  { value: 'year', label: '发表年份' },
  { value: 'title', label: '标题' }
]

const STATUS_DOT: Record<PaperStatus, string> = {
  inbox: 'bg-ink-low',
  reading: 'bg-info',
  read: 'bg-ok',
  archived: 'bg-white/20'
}

export function PaperList(): JSX.Element {
  const papers = useAppStore((s) => selectVisiblePapers(s))
  const total = useAppStore((s) => s.papers.length)
  // 宽度可拖拽调（App 里的 <Resizer id="list" />），钳制在 store 里
  const width = usePanelStore((s) => s.widths.list)
  const filters = useAppStore((s) => s.filters)
  const setFilters = useAppStore((s) => s.setFilters)
  const selectedId = useAppStore((s) => s.detail?.id ?? null)
  const selectPaper = useAppStore((s) => s.selectPaper)
  const settings = useAppStore((s) => s.settings)
  const openImport = useUiStore((s) => s.openImport)
  const openNewPaper = useUiStore((s) => s.openNewPaper)

  // 多选。与 selectedId（当前打开的那篇）是两套状态，见 useAppStore 里的说明。
  const selectedIds = useAppStore((s) => s.selectedIds)
  const toggleSelected = useAppStore((s) => s.toggleSelected)
  const selectRangeTo = useAppStore((s) => s.selectRangeTo)
  const selectAllVisible = useAppStore((s) => s.selectAllVisible)
  const clearSelection = useAppStore((s) => s.clearSelection)
  const bulkDelete = useAppStore((s) => s.bulkDelete)
  const bulkBuildProfiles = useAppStore((s) => s.bulkBuildProfiles)
  const bulkUpdate = useAppStore((s) => s.bulkUpdate)
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [bulkOpen, setBulkOpen] = useState(false)
  const selectionActive = selectedIds.size > 0

  /*
   * 「批量修改」弹窗的草稿。关掉即丢弃，不做持久化 —— 批量操作本来就是一次性的。
   * 分类用三态循环（未选 → 添加 → 移除 → 未选），比「两个多选框列表」省一半空间，
   * 也比「先选动作再选分类」少一次点击。
   */
  const [bulkStatus, setBulkStatus] = useState<'' | PaperStatus>('')
  const [bulkCats, setBulkCats] = useState<Record<string, 'add' | 'remove'>>({})
  const [bulkAddTags, setBulkAddTags] = useState('')
  const [bulkRemoveTags, setBulkRemoveTags] = useState('')

  const resetBulkDraft = (): void => {
    setBulkStatus('')
    setBulkCats({})
    setBulkAddTags('')
    setBulkRemoveTags('')
  }

  const allVisibleSelected = papers.length > 0 && papers.every((p) => selectedIds.has(p.id))

  const submitBulk = async (): Promise<void> => {
    const patch: Omit<PaperBulkUpdate, 'ids'> = {}
    if (bulkStatus) patch.status = bulkStatus
    const add = Object.entries(bulkCats)
      .filter(([, mode]) => mode === 'add')
      .map(([id]) => id)
    const remove = Object.entries(bulkCats)
      .filter(([, mode]) => mode === 'remove')
      .map(([id]) => id)
    if (add.length) patch.addCategories = add
    if (remove.length) patch.removeCategories = remove
    const addTags = splitTags(bulkAddTags)
    const removeTags = splitTags(bulkRemoveTags)
    if (addTags.length) patch.addTags = addTags
    if (removeTags.length) patch.removeTags = removeTags

    // 一个字都没改就提交，只会白跑一轮任务队列，在本地就拦掉
    if (!Object.keys(patch).length) {
      useAppStore.getState().toast('还没有选择要修改的内容', 'error')
      return
    }
    setBulkOpen(false)
    resetBulkDraft()
    await bulkUpdate(patch)
  }

  const confirmBulkDelete = async (): Promise<void> => {
    const ok = await confirm({
      title: `删除 ${selectedIds.size} 篇论文？`,
      description: '会同时删除 Markdown 笔记、库内 PDF 副本和抽取出的全文文本，无法撤销。',
      confirmLabel: '删除',
      danger: true
    })
    if (ok) await bulkDelete()
  }

  const confirmBulkProfiles = async (): Promise<void> => {
    const ok = await confirm({
      title: `为 ${selectedIds.size} 篇论文抽取实验画像？`,
      description: '会逐篇调用模型，已有画像将被覆盖。期间可以在顶部进度条上取消。',
      confirmLabel: '开始抽取'
    })
    if (ok) await bulkBuildProfiles()
  }

  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** 标记「这次选中是键盘移动造成的」，用来决定要不要自动滚动（见下方 effect） */
  const keyboardNavRef = useRef(false)

  /*
   * 搜索框用本地 state + 防抖：每键击都对上千篇论文重拼 haystack 并全量重排
   * 会明显掉帧。150ms 足够让输入手感保持连续，又省掉大部分中间计算。
   */
  const [queryDraft, setQueryDraft] = useState(filters.query)

  // 外部改了 query（⌘K 清空、重置筛选、从别处跳转）时同步回输入框
  useEffect(() => {
    setQueryDraft(filters.query)
  }, [filters.query])

  useEffect(() => {
    if (queryDraft === filters.query) return
    const timer = setTimeout(() => setFilters({ query: queryDraft }), 150)
    return () => clearTimeout(timer)
  }, [queryDraft, filters.query, setFilters])

  useEffect(() => {
    const handler = (): void => {
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('pv:focus-search', handler)
    return () => window.removeEventListener('pv:focus-search', handler)
  }, [])

  /*
   * 键盘导航：↑ / ↓ 在列表里移动，Home / End 跳首尾，Esc 退出。
   *
   * 只在「焦点不在别的控件里」时才接管方向键 —— 否则用户在详情页用方向键
   * 滚正文、或在别的输入框里移动光标，都会被列表抢走。判据是焦点在 body 上、
   * 在列表内、或在搜索框里。
   *
   * 搜索框也算「自己人」，是因为「⌘K 搜索 → ↓ 直接进列表」是最顺的一条路径，
   * 而方向键在单行输入框里本来就没有意义。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const store = useAppStore.getState()
      if (store.view !== 'library') return
      const ui = useUiStore.getState()
      if (ui.importOpen || ui.newPaperOpen || ui.arxivOpen) return
      // 任何弹窗（含二次确认）开着时都不接管：Esc 该由弹窗自己处理
      if (document.querySelector('[role="dialog"]')) return

      /*
       * ⌘A 全选当前可见列表。要放在「带修饰键一律放行」之前，
       * 否则会被直接放行掉。
       */
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        const focused = document.activeElement
        // 在输入框里 ⌘A 是「全选文本」，不能抢
        if (
          focused instanceof HTMLInputElement ||
          focused instanceof HTMLTextAreaElement ||
          (focused instanceof HTMLElement && focused.isContentEditable)
        ) {
          return
        }
        event.preventDefault()
        store.selectAllVisible()
        return
      }

      // 其余带修饰键的一律放行（⌘1~7 切视图、⌘K 搜索等在 useHotkeys 里）
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return

      const active = document.activeElement
      const fromSearch = active === searchRef.current
      const mine =
        active === null ||
        active === document.body ||
        fromSearch ||
        (!!active && !!listRef.current?.contains(active))
      if (!mine) return

      const list = selectVisiblePapers(store)
      if (!list.length) return

      const current = store.detail?.id ?? null
      const index = current ? list.findIndex((p) => p.id === current) : -1
      let next = index

      switch (event.key) {
        case 'ArrowDown':
          next = index < 0 ? 0 : Math.min(index + 1, list.length - 1)
          break
        case 'ArrowUp':
          next = index < 0 ? list.length - 1 : Math.max(index - 1, 0)
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = list.length - 1
          break
        case 'Escape':
          /*
           * 一次 Esc 只做一件事，按「由外向内」的顺序退：
           * 先退选择集（它是最显眼的临时状态，底部还挂着操作条），
           * 再退搜索框焦点，最后才是取消选中那篇。
           */
          if (store.selectedIds.size) {
            event.preventDefault()
            store.clearSelection()
            return
          }
          if (fromSearch) {
            event.preventDefault()
            searchRef.current?.blur()
          }
          if (current) {
            event.preventDefault()
            void store.selectPaper(null)
          }
          return
        default:
          return
      }

      event.preventDefault()
      if (next === index) return
      keyboardNavRef.current = true
      void store.selectPaper(list[next].id)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /*
   * 键盘移动之后把选中项滚进视口。
   *
   * 用 ref 标记而不是「只要 selectedId 变了就滚」：鼠标点卡片时它本来就在
   * 视野里，再滚一次反而让列表跳一下。
   */
  useEffect(() => {
    if (!keyboardNavRef.current) return
    keyboardNavRef.current = false
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const activeFilterLabels = useMemo(
    () => filters.categories.map((c) => categoryLabel(c, settings.customCategories)),
    [filters.categories, settings.customCategories]
  )

  return (
    <section
      style={{ width }}
      className="flex h-full shrink-0 flex-col border-r border-line bg-bg-base"
    >
      <div className="shrink-0 space-y-2 px-3 pb-2 pt-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-low" />
          {/* bg-bg-raised：列表栏本身就是 bg-base，不下沉一档搜索框会「隐形」 */}
          <input
            ref={searchRef}
            value={queryDraft}
            onChange={(e) => setQueryDraft(e.target.value)}
            placeholder="搜索标题、作者、笔记正文…"
            className="field bg-bg-raised pl-8 pr-14"
          />
          {!queryDraft ? (
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-line px-1.5 py-0.5 font-mono text-[9.5px] tracking-wide text-ink-low">
              ⌘K
            </span>
          ) : null}
          {queryDraft ? (
            <IconButton
              title="清空"
              onClick={() => setQueryDraft('')}
              className="absolute right-1 top-1/2 -translate-y-1/2"
            >
              <X className="h-3.5 w-3.5" />
            </IconButton>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <select
            value={filters.sort}
            onChange={(e) => setFilters({ sort: e.target.value as typeof filters.sort })}
            className="h-7 flex-1 rounded-lg border border-line bg-bg-raised px-2 text-[11.5px] text-ink-mid outline-none focus:border-brand/50"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value} className="bg-bg-overlay">
                {o.label}
              </option>
            ))}
          </select>
          <span className="shrink-0 tabular-nums text-[11px] text-ink-low">
            {papers.length}
            {papers.length !== total ? ` / ${total}` : ''} 篇
          </span>
          <IconButton title="新建条目" onClick={openNewPaper}>
            <Plus className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton title="导入 PDF" onClick={() => openImport()}>
            <Upload className="h-3.5 w-3.5" />
          </IconButton>
        </div>

        {activeFilterLabels.length || filters.status || filters.onlyUnread ? (
          <div className="flex flex-wrap gap-1">
            {filters.status ? (
              <Chip
                active
                onClick={() => setFilters({ status: null })}
                className="gap-1"
                title="点击移除"
              >
                {STATUS_LABEL[filters.status]}
                <X className="h-2.5 w-2.5" />
              </Chip>
            ) : null}
            {filters.onlyUnread ? (
              <Chip active onClick={() => setFilters({ onlyUnread: false })} title="点击移除">
                待精读
                <X className="h-2.5 w-2.5" />
              </Chip>
            ) : null}
            {activeFilterLabels.map((label, i) => (
              <Chip
                key={label}
                active
                color={categoryColor(filters.categories[i], settings.customCategories)}
                onClick={() =>
                  setFilters({ categories: filters.categories.filter((c) => c !== filters.categories[i]) })
                }
                title="点击移除"
              >
                {label}
                <X className="h-2.5 w-2.5" />
              </Chip>
            ))}
          </div>
        ) : null}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {papers.length === 0 ? (
          <EmptyState
            icon={<FileText className="h-8 w-8" />}
            title={total === 0 ? '知识库还是空的' : '没有匹配的论文'}
            description={
              total === 0
                ? '拖进来一篇 PDF，PaperVault 会自动抽取全文、按结构生成精读笔记骨架，并拆解它的写作手法与实验方法论。'
                : '试试换个关键词，或清除左侧的筛选条件。'
            }
            action={
              total === 0 ? (
                <button
                  onClick={() => openImport()}
                  className="mt-1 rounded-lg bg-gradient-to-b from-[#41856A] to-[#2F644F] px-3.5 py-2 text-[12.5px] font-medium text-[#EDEAE0] shadow-[inset_0_1px_0_rgba(214,242,224,0.22)] transition hover:from-[#4A9175] hover:to-[#38735A]"
                >
                  导入第一篇论文
                </button>
              ) : null
            }
          />
        ) : (
          papers.map((paper) => (
            <PaperCard
              key={paper.id}
              paper={paper}
              active={paper.id === selectedId}
              selected={selectedIds.has(paper.id)}
              selectionActive={selectionActive}
              onSelect={(event) => {
                /*
                 * 卡片有两个身份：复选框 = 「加入选择集」，卡片主体 = 「打开读」。
                 * 带 ⌘/Ctrl 或 Shift 点主体也走选择，和文件管理器一致；直接点主体
                 * 只打开、不动选择集 —— 「选好 5 篇，逐篇看一眼再决定要不要执行」
                 * 是很常见的路径，不该因为看一眼就把选择清掉。删除另有二次确认兜底，
                 * 所以不怕「选择集还在、手滑点了删除」。
                 */
                if (event.metaKey || event.ctrlKey) {
                  toggleSelected(paper.id)
                  return
                }
                if (event.shiftKey) {
                  selectRangeTo(paper.id)
                  return
                }
                void selectPaper(paper.id)
              }}
              onToggle={() => toggleSelected(paper.id)}
              onRangeSelect={() => selectRangeTo(paper.id)}
              customCategories={settings.customCategories}
            />
          ))
        )}
      </div>

      {selectionActive ? (
        <div className="shrink-0 border-t border-line bg-bg-raised px-3 py-2.5">
          <div className="mb-2 flex items-center gap-2">
            <CheckSquare className="h-3.5 w-3.5 shrink-0 text-brand-soft" />
            <span className="text-[12px] font-medium text-ink-high">
              已选 {selectedIds.size} 篇
            </span>
            <button
              onClick={() => (allVisibleSelected ? clearSelection() : selectAllVisible())}
              className="text-[11px] text-ink-low transition hover:text-ink-high"
            >
              {allVisibleSelected ? '取消全选' : `全选可见（${papers.length}）`}
            </button>
            <IconButton title="清空选择（Esc）" onClick={clearSelection} className="ml-auto">
              <X className="h-3.5 w-3.5" />
            </IconButton>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="subtle"
              icon={<SlidersHorizontal className="h-3 w-3" />}
              onClick={() => setBulkOpen(true)}
            >
              改属性
            </Button>
            <Button
              size="xs"
              variant="subtle"
              icon={<ClipboardList className="h-3 w-3" />}
              onClick={() => void confirmBulkProfiles()}
            >
              抽画像
            </Button>
            <Button
              size="xs"
              variant="danger"
              className="ml-auto"
              icon={<Trash2 className="h-3 w-3" />}
              onClick={() => void confirmBulkDelete()}
            >
              删除
            </Button>
          </div>
        </div>
      ) : null}

      <Modal
        open={bulkOpen}
        onClose={() => {
          setBulkOpen(false)
          resetBulkDraft()
        }}
        title={`批量修改 ${selectedIds.size} 篇论文`}
        subtitle="只填想改的字段，留空的一律保持原样。分类点一下是添加，再点是移除，第三下取消。"
        width="max-w-xl"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setBulkOpen(false)
                resetBulkDraft()
              }}
            >
              取消
            </Button>
            <Button variant="primary" onClick={() => void submitBulk()}>
              应用到 {selectedIds.size} 篇
            </Button>
          </>
        }
      >
        <div className="space-y-3.5">
          <Field label="阅读状态" hint="留空表示不改">
            <select
              value={bulkStatus}
              onChange={(e) => setBulkStatus(e.target.value as '' | PaperStatus)}
              className="field"
            >
              <option value="" className="bg-bg-overlay">
                不修改
              </option>
              {(Object.keys(STATUS_LABEL) as PaperStatus[]).map((s) => (
                <option key={s} value={s} className="bg-bg-overlay">
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="分类" hint="添加 / 移除 / 不改，循环切换">
            <div className="flex flex-wrap gap-1 pt-0.5">
              {allCategories(settings.customCategories).map((node) => {
                const mode = bulkCats[node.id]
                const color = node.color ?? categoryColor(node.id, settings.customCategories)
                return (
                  <button
                    key={node.id}
                    title={node.description}
                    onClick={() =>
                      setBulkCats((prev) => {
                        const next = { ...prev }
                        if (!next[node.id]) next[node.id] = 'add'
                        else if (next[node.id] === 'add') next[node.id] = 'remove'
                        else delete next[node.id]
                        return next
                      })
                    }
                    className={cn(
                      'chip transition',
                      mode === 'add'
                        ? ''
                        : mode === 'remove'
                          ? 'border-danger/50 bg-danger/15 text-danger line-through'
                          : 'text-ink-mid hover:border-strong'
                    )}
                    style={
                      mode === 'add'
                        ? { color, borderColor: `${color}88`, background: `${color}22` }
                        : undefined
                    }
                  >
                    {mode === 'add' ? '+ ' : mode === 'remove' ? '− ' : ''}
                    {node.label}
                  </button>
                )
              })}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="添加标签" hint="空格或逗号分隔">
              <input
                value={bulkAddTags}
                onChange={(e) => setBulkAddTags(e.target.value)}
                placeholder="long-context rerank"
                className="field"
              />
            </Field>
            <Field label="移除标签">
              <input
                value={bulkRemoveTags}
                onChange={(e) => setBulkRemoveTags(e.target.value)}
                placeholder="待整理"
                className="field"
              />
            </Field>
          </div>
        </div>
      </Modal>

      {confirmDialog}
    </section>
  )
}

function PaperCard({
  paper,
  active,
  selected,
  selectionActive,
  onSelect,
  onToggle,
  onRangeSelect,
  customCategories
}: {
  paper: PaperSummary
  active: boolean
  selected: boolean
  selectionActive: boolean
  onSelect: (event: ReactMouseEvent<HTMLButtonElement>) => void
  onToggle: () => void
  onRangeSelect: () => void
  customCategories: ReturnType<typeof useAppStore.getState>['settings']['customCategories']
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      // 键盘导航靠它找到当前项并滚进视口（见 PaperList 里的 effect）
      data-active={active}
      // 只在多选进行中对外暴露「选中」，否则读屏会把「选中」和「当前打开」混为一谈
      aria-pressed={selectionActive ? selected : undefined}
      className={cn(
        /*
         * 图书馆卡片目录式条目：不再是圆角小卡片，而是 hairline 分隔的目录行。
         * 标题用衬线（论文本身就是衬线的），当前打开的一篇用左缘一条松绿
         * 「书签丝带」标记——实体书里读到哪一页就夹到哪一页的缎带。
         */
        'group relative w-full border-b border-line px-3 py-3 text-left transition last:border-b-0',
        selected
          ? 'bg-brand/[0.10]'
          : active
            ? 'bg-white/[0.03]'
            : 'hover:bg-white/[0.02]'
      )}
    >
      {active ? (
        <span className="absolute bottom-2.5 left-0 top-2.5 w-[2px] rounded-full bg-brand-soft" />
      ) : null}
      <div className="flex items-start gap-2">
        {/*
         * 复选框故意做成 <span> 而不是 <button>：外层卡片本身就是 <button>，
         * HTML 不允许按钮嵌套按钮。它只承担鼠标点击（stopPropagation 后交给
         * onToggle / onRangeSelect），键盘路径由 ⌘A、Shift+点击、Esc 覆盖，
         * 而语义状态已经通过外层按钮的 aria-pressed 暴露，所以这里标 aria-hidden。
         *
         * 未选中时用 opacity 隐藏而不是 display:none —— 保留占位，鼠标划过时
         * 不会因为突然多出一个方块把整行文字挤位移。
         */}
        <span
          aria-hidden="true"
          onClick={(e) => {
            e.stopPropagation()
            if (e.shiftKey) onRangeSelect()
            else onToggle()
          }}
          className={cn(
            'mt-[3px] flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-[5px] border transition',
            selected
              ? 'border-brand bg-brand text-[#EDEAE0]'
              : 'border-strong text-transparent',
            !selected &&
              (selectionActive
                ? 'opacity-60 hover:opacity-100'
                : 'opacity-0 group-hover:opacity-100')
          )}
        >
          <Check className="h-3 w-3" strokeWidth={3} />
        </span>
        <span
          className={cn('mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[paper.status])}
          title={STATUS_LABEL[paper.status]}
        />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 font-serif text-[13px] font-medium leading-[1.5] text-ink-high">
            {paper.title}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10.5px] text-ink-low">
            <span>{paper.year ?? '—'}</span>
            {paper.venue ? (
              <>
                <span>·</span>
                {/* 会议/期刊斜体衬线：期刊引文里刊名排斜体的惯例 */}
                <span className="max-w-[130px] truncate font-serif italic text-ink-mid">
                  {paper.venue}
                </span>
              </>
            ) : null}
            {paper.authors.length ? (
              <>
                <span>·</span>
                <span className="max-w-[150px] truncate">{authorLine(paper.authors, 2)}</span>
              </>
            ) : null}
          </div>

          {paper.tldr ? (
            <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-relaxed text-ink-mid">
              {truncate(paper.tldr, 140)}
            </p>
          ) : null}

          {paper.categories.length || paper.tags.length ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {paper.categories.slice(0, 3).map((c) => (
                <Chip key={c} color={categoryColor(c, customCategories)}>
                  {categoryLabel(c, customCategories)}
                </Chip>
              ))}
              {paper.tags.slice(0, 2).map((t) => (
                <Chip key={t} className="text-ink-low">
                  #{t}
                </Chip>
              ))}
            </div>
          ) : null}

          <div className="mt-2 flex items-center gap-2 tabular-nums text-[10px] text-ink-low">
            {paper.rating > 0 ? (
              <span className="inline-flex items-center gap-0.5 text-warn">
                <Star className="h-2.5 w-2.5 fill-current" />
                {paper.rating}
              </span>
            ) : null}
            {paper.aiFilled ? <span className="text-accent">已精读</span> : <span>待精读</span>}
            <span className="ml-auto">{formatDate(paper.updatedAt)}</span>
          </div>
        </div>
      </div>
    </button>
  )
}
