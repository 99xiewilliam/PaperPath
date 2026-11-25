import { create } from 'zustand'
import type {
  AppSettings,
  CollectionCreateInput,
  CollectionUpdateInput,
  PaperBulkUpdate,
  PaperCollection,
  PaperCreateInput,
  PaperDetail,
  PaperStatus,
  PaperSummary,
  PaperUpdateInput,
  StatsOverview,
  VaultStatus
} from '@shared/types'
import type { IdeaPatch, ResearchIdea } from '@shared/ideas'
import { DEFAULT_SETTINGS } from './defaults'
import { errorMessage } from '@/lib/utils'

export type ViewKey = 'library' | 'writing' | 'compare' | 'dashboard' | 'settings'

/**
 * 侧栏真正渲染的顶级入口，只有四个：读 → 写 → 做实验 → 沉淀。
 *
 * 知识图谱与跨论文整块下线后，ViewKey 里也不再保留它们的键 —— 留一个没有
 * 页面的键，谁将来 `setView('graph')` 一次就会看到一片空白。让编译器直接报错。
 */
export const NAV_KEYS = ['library', 'writing', 'compare', 'dashboard'] as const

/** ⌘1 ~ ⌘4 的顺序，与 Sidebar 导航一致（设置不再占位，走 ⌘,） */
export const VIEW_ORDER: ViewKey[] = [...NAV_KEYS]

/**
 * 子页 → 它属于哪个顶级入口。
 *
 * 两个用途，都是「别的地方不该各自判断一遍」：
 *   - 侧栏高亮：进到知识图谱时高亮停在「沉淀」，而不是整排导航全灭；
 *   - 从二级页返回时知道回哪。
 * 将来把某个子页升回导航，也只改这一处。
 */
export const VIEW_GROUP: Record<ViewKey, ViewKey> = {
  library: 'library',
  writing: 'writing',
  compare: 'compare',
  dashboard: 'dashboard',
  settings: 'settings'
}

/** 「写作思路」页的三个分区 */
export type WritingTab = 'single' | 'pattern' | 'phrases'

/** 一次性的跨页跳转意图，见 `AppState.writingIntent` */
export interface WritingIntent {
  tab: WritingTab
  /** 要预选的论文（只有单篇分区用得上） */
  paperId?: string
}

/** 视图标题的唯一来源：Sidebar 与设置页的快捷键表都从这里取，避免两处漂移 */
export const VIEW_LABEL: Record<ViewKey, string> = {
  library: '论文库',
  /*
   * 单篇逻辑卡与跨篇套路库共用一个入口。之前它们散在三个地方
   * （详情页的写作手法章节 / 速览里的故事线 / 跨论文页的归纳），
   * 找的时候得先判断「这件事归哪个页面管」。
   */
  writing: '写作思路',
  compare: '实验对比',
  /* 叫「沉淀」而不是「沉淀统计」：它是要让人看到积累在变厚的那一屏 */
  dashboard: '沉淀',
  settings: '设置'
}

export interface Filters {
  query: string
  categories: string[]
  tags: string[]
  status: PaperStatus | null
  sort: 'updated' | 'created' | 'rating' | 'importance' | 'year' | 'title'
  /** 只看还没有精读过的 */
  onlyUnread: boolean
  /** 只看某个专题里的论文；null 表示不过滤 */
  collectionId: string | null
}

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'success' | 'error'
}

interface AppState {
  ready: boolean
  vault: VaultStatus
  settings: AppSettings
  papers: PaperSummary[]
  collections: PaperCollection[]
  /** 选题本。问题池里每个问题下的选题和「沉淀」页的选题本共用这一份 */
  ideas: ResearchIdea[]
  detail: PaperDetail | null
  /**
   * 多选集合。与 `detail`（当前打开的那一篇）是两件独立的事：
   * 点卡片 = 打开详情，勾选 / ⌘点击 = 加入多选。
   * 之所以不合并成一个字段，是为了不破坏「单击即阅读」这条主路径 ——
   * 如果单击既打开又选中，那每次阅读都会莫名其妙地攒出一个选择集。
   */
  selectedIds: Set<string>
  /** Shift 连选的锚点：上一次不带 Shift 的勾选落在哪一篇 */
  selectionAnchorId: string | null
  stats: StatsOverview | null
  view: ViewKey
  filters: Filters
  loadingDetail: boolean
  /**
   * 全文检索命中的论文 id。
   * null 表示当前没有搜索词（列表不做搜索维度的过滤）——
   * 之所以用 null 而不是空集合，是为了区分「没搜」和「搜了但没命中」。
   */
  searchIds: Set<string> | null
  busy: { label: string } | null
  /** 主进程正在跑的 AI 任务 id；null 表示空闲（用于决定要不要显示「取消」） */
  activeTaskId: string | null
  toasts: Toast[]
  /**
   * 跳到「写作思路」时要打开哪个分区、预选哪一篇。
   *
   * 这个应用没有路由，跨页面传参没有别的通道；而写进 URL 也不成立。
   * 做成**一次性**字段：页面读到就清空，否则下次从导航点进来还会停在上次那篇，
   * 看起来像「点了导航却回到了旧论文」。
   *
   * 从单个 paperId 升级成对象，是因为句式库并进来之后，详情页的
   * 「查看句式库」要落到第三个分区，而不只是选中某篇论文。
   */
  writingIntent: WritingIntent | null

  init: () => Promise<void>
  chooseVault: () => Promise<void>
  rescan: () => Promise<void>
  refreshPapers: () => Promise<void>
  refreshCollections: () => Promise<void>
  refreshStats: () => Promise<void>
  refreshAll: () => Promise<void>

  setView: (view: ViewKey) => void
  /** 打开「写作思路」并预选某篇论文（论文详情页的「写作拆解」分组走这里） */
  openWriting: (paperId: string) => void
  /** 打开「写作思路」的指定分区（句式库入口走这里） */
  openWritingTab: (tab: WritingTab, paperId?: string) => void
  /** 取走一次性意图并清空（由 WritingView 消费） */
  takeWritingIntent: () => WritingIntent | null
  setFilters: (patch: Partial<Filters>) => void
  resetFilters: () => void
  /** 走主进程的全文检索（覆盖笔记正文），结果写进 searchIds */
  runSearch: (query: string) => Promise<void>

  selectPaper: (id: string | null) => Promise<void>
  createPaper: (input: PaperCreateInput) => Promise<PaperDetail | null>
  savePaper: (input: PaperUpdateInput) => Promise<PaperDetail | null>
  deletePaper: (id: string) => Promise<void>

  toggleSelected: (id: string) => void
  /** Shift 连选：选中锚点到目标之间（按当前可见顺序）的全部论文 */
  selectRangeTo: (id: string) => void
  selectAllVisible: () => void
  clearSelection: () => void
  /** 批量改属性（增量语义）；成功后清空选择集 */
  bulkUpdate: (patch: Omit<PaperBulkUpdate, 'ids'>) => Promise<void>
  bulkDelete: () => Promise<void>
  /** 批量抽实验画像（只跑结构化抽取，比整篇精读便宜）；成功后清空选择集 */
  bulkBuildProfiles: () => Promise<void>

  /**
   * 点侧栏的专题：选中则过滤列表并打开专题面板；再点一次，若正在看其中一篇
   * 就回到专题面板，否则取消筛选。
   */
  selectCollection: (id: string | null) => void
  createCollection: (input: CollectionCreateInput) => Promise<PaperCollection | null>
  updateCollection: (input: CollectionUpdateInput) => Promise<PaperCollection | null>
  deleteCollection: (id: string) => Promise<void>
  addPapersToCollection: (id: string, paperIds: string[]) => Promise<PaperCollection | null>
  removePapersFromCollection: (id: string, paperIds: string[]) => Promise<PaperCollection | null>

  refreshIdeas: () => Promise<void>
  /** 针对问题池里的一个问题生成选题；返回是否成功 */
  generateIdeas: (scope: string, problemTitle: string) => Promise<boolean>
  updateIdea: (id: string, patch: IdeaPatch) => Promise<ResearchIdea | null>
  deleteIdea: (id: string) => Promise<void>

  /**
   * 返回**是否真的写成功**：调用方要据此决定弹不弹「已保存」。
   * 之前它返回 void，于是「设置没存进去」和「存好了」在调用方看来长得一样 ——
   * 失败时这里弹了错误，调用方紧跟着又弹一句成功，用户看到两条互相打架的提示。
   */
  patchSettings: (patch: Partial<AppSettings>) => Promise<boolean>

  setBusy: (label: string | null) => void
  cancelTask: () => Promise<void>
  toast: (text: string, kind?: Toast['kind']) => void
  dismissToast: (id: number) => void
}

const initialFilters: Filters = {
  query: '',
  categories: [],
  tags: [],
  status: null,
  sort: 'updated',
  onlyUnread: false,
  collectionId: null
}

let toastSeq = 0

/** selectPaper 的请求序号，用来丢弃过期响应（见 selectPaper 里的竞态说明） */
let detailRequest = 0

/** 全文检索的请求序号，作用同上 */
let searchRequest = 0

export const useAppStore = create<AppState>()((set, get) => ({
  ready: false,
  vault: { opened: false, path: '', paperCount: 0 },
  settings: DEFAULT_SETTINGS,
  papers: [],
  collections: [],
  ideas: [],
  detail: null,
  selectedIds: new Set<string>(),
  selectionAnchorId: null,
  stats: null,
  view: 'library',
  filters: initialFilters,
  loadingDetail: false,
  searchIds: null,
  busy: null,
  activeTaskId: null,
  toasts: [],
  writingIntent: null,

  async init() {
    try {
      const [settings, vault] = await Promise.all([
        window.papervault.settings.get(),
        window.papervault.vault.status()
      ])
      set({ settings, vault, ready: true })
      if (vault.opened) await get().refreshAll()
    } catch (err) {
      set({ ready: true })
      get().toast(`初始化失败：${errorMessage(err)}`, 'error')
    }

    window.papervault.app.onProgress((progress) => {
      set({ activeTaskId: progress.taskId })
      // 只在渲染层已经进入「忙碌」时才用主进程的进度文案覆盖，
      // 免得把一个后台任务的文案贴到无关操作上（stage === 'state' 只是开关信号）
      if (get().busy && progress.taskId && progress.stage !== 'state') {
        set({ busy: { label: progress.message } })
      }
    })
  },

  async chooseVault() {
    set({ busy: { label: '正在打开知识库…' } })
    try {
      const vault = await window.papervault.vault.choose()
      if (!vault) return
      set({ vault, settings: await window.papervault.settings.get() })
      await get().refreshAll()
      get().toast(
        `已打开知识库，共索引 ${vault.paperCount} 篇论文`,
        'success'
      )
    } catch (err) {
      get().toast(`打开知识库失败：${errorMessage(err)}`, 'error')
    } finally {
      set({ busy: null })
    }
  },

  async rescan() {
    set({ busy: { label: '正在重建索引…' } })
    try {
      const result = await window.papervault.vault.rescan()
      await get().refreshAll()
      const extra = result.errors.length ? `，${result.errors.length} 个文件解析失败` : ''
      get().toast(
        `索引完成：${result.indexed} 篇（清理 ${result.removed} 条失效记录）${extra}`,
        result.errors.length ? 'error' : 'success'
      )
    } catch (err) {
      get().toast(`重建索引失败：${errorMessage(err)}`, 'error')
    } finally {
      set({ busy: null })
    }
  },

  /*
   * 这几个都自带 catch：它们的调用点大量写作 `void refreshXxx()`（切视图时顺手刷新），
   * 一旦 IPC 失败就是未处理的 rejection —— 页面静静停在旧/空数据上，用户什么也看不到。
   */
  async refreshPapers() {
    try {
      const papers = await window.papervault.papers.list()
      set({ papers })
    } catch (err) {
      get().toast(`读取论文列表失败：${errorMessage(err)}`, 'error')
    }
  },

  async refreshCollections() {
    try {
      const collections = await window.papervault.collections.list()
      set({ collections })
      const selected = get().filters.collectionId
      if (selected && !collections.some((c) => c.id === selected)) {
        set({ filters: { ...get().filters, collectionId: null } })
      }
    } catch (err) {
      get().toast(`读取专题失败：${errorMessage(err)}`, 'error')
    }
  },

  async refreshStats() {
    try {
      const stats = await window.papervault.stats.overview()
      set({ stats })
    } catch (err) {
      get().toast(`读取统计失败：${errorMessage(err)}`, 'error')
    }
  },

  async refreshAll() {
    const [papers, stats, vault, collections] = await Promise.all([
      window.papervault.papers.list(),
      window.papervault.stats.overview(),
      window.papervault.vault.status(),
      window.papervault.collections.list()
    ])
    set({ papers, stats, vault, collections })
    const selectedCollection = get().filters.collectionId
    if (selectedCollection && !collections.some((c) => c.id === selectedCollection)) {
      set({ filters: { ...get().filters, collectionId: null } })
    }

    const { detail } = get()
    if (detail && !papers.some((p) => p.id === detail.id)) {
      set({ detail: null })
    }

    /*
     * 同理剪掉选择集里已经不存在的 id。
     * 不剪的话「已选 5 篇」会虚高，批量操作还会对着幽灵 id 发请求 ——
     * 换知识库时也靠这一条自动清空（新旧库的 id 不可能重合）。
     */
    const selected = get().selectedIds
    if (selected.size) {
      const alive = new Set(papers.map((p) => p.id))
      const kept = [...selected].filter((id) => alive.has(id))
      if (kept.length !== selected.size) set({ selectedIds: new Set(kept) })
    }

    // 库里内容变了，搜索结果可能过期（例如刚导入的论文正好命中当前搜索词）
    const query = get().filters.query
    if (query.trim()) void get().runSearch(query)
  },

  setView(view) {
    set({ view })
    /*
     * 仪表盘的数字来自两处：`stats`（主进程聚合）与 `papers`（论文总数、
     * 画像完成度都是从列表现算的）。以前只刷 stats，一旦列表变旧就会同屏
     * 出现「论文总数 121 / 已抽画像 120」这种自相矛盾的画面。
     *
     * 刻意不用 refreshAll：那会顺带清空 detail、重跑当前搜索词，
     * 而进仪表盘并不需要这两件事。
     */
    if (view === 'dashboard') {
      void get().refreshPapers()
      void get().refreshStats()
    }
  },

  openWriting(paperId) {
    get().openWritingTab('single', paperId)
  },

  openWritingTab(tab, paperId) {
    set({ writingIntent: paperId ? { tab, paperId } : { tab } })
    get().setView('writing')
  },

  takeWritingIntent() {
    const intent = get().writingIntent
    if (intent) set({ writingIntent: null })
    return intent
  },

  setFilters(patch) {
    const before = get().filters
    set({ filters: { ...before, ...patch } })
    if (patch.query !== undefined && patch.query !== before.query) {
      void get().runSearch(patch.query)
    }
  },

  resetFilters() {
    searchRequest++
    set({ filters: { ...initialFilters }, searchIds: null })
  },

  async runSearch(query) {
    const q = query.trim()
    // 连打时只认最后一次请求的结果，避免先发后到的旧结果覆盖新结果
    const token = ++searchRequest

    if (!q) {
      set({ searchIds: null })
      return
    }

    try {
      const ids = await window.papervault.papers.search(q)
      if (token !== searchRequest) return
      set({ searchIds: new Set(ids) })
    } catch (err) {
      if (token !== searchRequest) return
      // 搜索失败就退回「不过滤」，总比让列表空着好
      set({ searchIds: null })
      get().toast(`搜索失败：${errorMessage(err)}`, 'error')
    }
  },

  async selectPaper(id) {
    if (!id) {
      detailRequest++
      set({ detail: null, loadingDetail: false })
      return
    }
    if (get().detail?.id === id) return

    // 快速连点两篇论文时，先发的请求可能后返回。只认最新一次请求的结果，
    // 否则详情页会显示成上一篇的内容。
    const token = ++detailRequest
    set({ loadingDetail: true })
    try {
      const detail = await window.papervault.papers.get(id)
      if (token !== detailRequest) return
      set({ detail })
    } catch (err) {
      if (token === detailRequest) get().toast(`读取论文失败：${errorMessage(err)}`, 'error')
    } finally {
      if (token === detailRequest) set({ loadingDetail: false })
    }
  },

  async createPaper(input) {
    try {
      const detail = await window.papervault.papers.create(input)
      await get().refreshAll()
      set({ detail, view: 'library' })
      get().toast(`已新建《${detail.title}》`, 'success')
      return detail
    } catch (err) {
      get().toast(`新建失败：${errorMessage(err)}`, 'error')
      return null
    }
  },

  async savePaper(input) {
    try {
      const detail = await window.papervault.papers.update(input)
      set((state) => ({
        // Saving the previous paper can finish after the reader selected another.
        detail: state.detail?.id === detail.id && !state.loadingDetail ? detail : state.detail,
        /*
         * 列表项要显式带上 links：详情页的「被以下论文关联」是从 papers 列表里
         * 反查的，不同步的话，刚连好的关系在对方那页看不到（要等一次 refreshAll）。
         * 其余字段维持原样 —— 顺手改「展开整个 detail」会连带刷新 updatedAt，
         * 于是在笔记里打字时列表卡片会一直往顶上跳。
         */
        papers: state.papers
          .map((p) => (p.id === detail.id ? { ...p, ...detail, links: detail.meta.links ?? [] } : p))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      }))
      return detail
    } catch (err) {
      get().toast(`保存失败：${errorMessage(err)}`, 'error')
      return null
    }
  },

  async deletePaper(id) {
    try {
      await window.papervault.papers.remove(id)
      set((state) => {
        const selected = new Set(state.selectedIds)
        selected.delete(id)
        return {
          papers: state.papers.filter((p) => p.id !== id),
          detail: state.detail?.id === id ? null : state.detail,
          selectedIds: selected
        }
      })
      await get().refreshStats()
      get().toast('已删除该论文笔记', 'success')
    } catch (err) {
      get().toast(`删除失败：${errorMessage(err)}`, 'error')
    }
  },

  /* ---- 多选 ------------------------------------------------------ */

  toggleSelected(id) {
    const next = new Set(get().selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    // 锚点跟着走：先点第 3 篇再 Shift 点第 8 篇，范围就是 3~8
    set({ selectedIds: next, selectionAnchorId: id })
  },

  selectRangeTo(id) {
    const list = selectVisiblePapers(get())
    const to = list.findIndex((p) => p.id === id)
    if (to < 0) return

    const anchor = get().selectionAnchorId
    const from = anchor ? list.findIndex((p) => p.id === anchor) : -1
    if (from < 0) {
      // 没有锚点，或锚点已被当前筛选条件挡掉 → 退化成「只选这一篇」
      set({ selectedIds: new Set([id]), selectionAnchorId: id })
      return
    }

    const [lo, hi] = from <= to ? [from, to] : [to, from]
    set({
      selectedIds: new Set(list.slice(lo, hi + 1).map((p) => p.id)),
      // 锚点不动：连续 Shift 点击都以最初那个点为基准，和文件管理器一致
      selectionAnchorId: anchor
    })
  },

  selectAllVisible() {
    const list = selectVisiblePapers(get())
    if (!list.length) return
    set({
      selectedIds: new Set(list.map((p) => p.id)),
      selectionAnchorId: list[0].id
    })
  },

  clearSelection() {
    if (!get().selectedIds.size) return
    set({ selectedIds: new Set(), selectionAnchorId: null })
  },

  async bulkUpdate(patch) {
    const ids = [...get().selectedIds]
    if (!ids.length) return
    set({ busy: { label: `正在修改 ${ids.length} 篇论文…` } })
    try {
      const res = await window.papervault.papers.bulkUpdate({ ids, ...patch })
      await get().refreshAll()
      // 改完就清空：留着一个「刚改完」的选择集没有意义，只会让下一次误操作的代价更大
      set({ selectedIds: new Set(), selectionAnchorId: null })
      get().toast(res.message, res.ok ? 'success' : 'error')
    } catch (err) {
      get().toast(`批量修改失败：${errorMessage(err)}`, 'error')
    } finally {
      set({ busy: null })
    }
  },

  async bulkDelete() {
    const ids = [...get().selectedIds]
    if (!ids.length) return
    set({ busy: { label: `正在删除 ${ids.length} 篇论文…` } })
    try {
      const res = await window.papervault.papers.bulkDelete(ids)
      await get().refreshAll()
      set({ selectedIds: new Set(), selectionAnchorId: null })
      get().toast(res.message, res.ok ? 'success' : 'error')
    } catch (err) {
      get().toast(`批量删除失败：${errorMessage(err)}`, 'error')
    } finally {
      set({ busy: null })
    }
  },

  selectCollection(id) {
    const current = get().filters.collectionId
    if (!id || (current === id && !get().detail)) {
      set({ filters: { ...get().filters, collectionId: null } })
      return
    }
    if (current === id && get().detail) {
      void get().selectPaper(null)
      return
    }
    set({ filters: { ...get().filters, collectionId: id }, view: 'library' })
    void get().selectPaper(null)
  },

  async createCollection(input) {
    try {
      const collection = await window.papervault.collections.create(input)
      await get().refreshCollections()
      get().selectCollection(collection.id)
      get().toast(`已创建专题「${collection.title}」`, 'success')
      return collection
    } catch (err) {
      get().toast(`创建专题失败：${errorMessage(err)}`, 'error')
      return null
    }
  },

  async updateCollection(input) {
    try {
      const collection = await window.papervault.collections.update(input)
      set((state) => ({
        collections: state.collections
          .map((c) => (c.id === collection.id ? collection : c))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      }))
      return collection
    } catch (err) {
      get().toast(`保存专题失败：${errorMessage(err)}`, 'error')
      return null
    }
  },

  async deleteCollection(id) {
    try {
      await window.papervault.collections.remove(id)
      set((state) => ({
        collections: state.collections.filter((c) => c.id !== id),
        filters:
          state.filters.collectionId === id
            ? { ...state.filters, collectionId: null }
            : state.filters
      }))
      get().toast('已删除该专题（论文本身还在）', 'success')
    } catch (err) {
      get().toast(`删除专题失败：${errorMessage(err)}`, 'error')
    }
  },

  async addPapersToCollection(id, paperIds) {
    try {
      const collection = await window.papervault.collections.addPapers(id, paperIds)
      set((state) => ({
        collections: state.collections
          .map((c) => (c.id === collection.id ? collection : c))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      }))
      return collection
    } catch (err) {
      get().toast(`加入专题失败：${errorMessage(err)}`, 'error')
      return null
    }
  },

  async removePapersFromCollection(id, paperIds) {
    try {
      const collection = await window.papervault.collections.removePapers(id, paperIds)
      set((state) => ({
        collections: state.collections.map((c) => (c.id === collection.id ? collection : c))
      }))
      return collection
    } catch (err) {
      get().toast(`移出专题失败：${errorMessage(err)}`, 'error')
      return null
    }
  },

  async refreshIdeas() {
    try {
      set({ ideas: await window.papervault.ideas.list() })
    } catch (err) {
      get().toast(`读取选题本失败：${errorMessage(err)}`, 'error')
    }
  },

  async generateIdeas(scope, problemTitle) {
    set({ busy: { label: '正在生成选题…' } })
    try {
      const res = await window.papervault.ideas.generate(scope, problemTitle)
      if (res.ok && res.ideas) set((state) => ({ ideas: [...res.ideas!, ...state.ideas] }))
      get().toast(res.message ?? '', res.ok ? 'success' : 'error')
      return res.ok
    } catch (err) {
      get().toast(`生成选题失败：${errorMessage(err)}`, 'error')
      return false
    } finally {
      set({ busy: null })
    }
  },

  async updateIdea(id, patch) {
    try {
      const idea = await window.papervault.ideas.update(id, patch)
      set((state) => ({ ideas: state.ideas.map((i) => (i.id === id ? idea : i)) }))
      return idea
    } catch (err) {
      get().toast(`保存选题失败：${errorMessage(err)}`, 'error')
      return null
    }
  },

  async deleteIdea(id) {
    try {
      await window.papervault.ideas.delete(id)
      set((state) => ({ ideas: state.ideas.filter((i) => i.id !== id) }))
    } catch (err) {
      get().toast(`删除选题失败：${errorMessage(err)}`, 'error')
    }
  },

  async bulkBuildProfiles() {
    const ids = [...get().selectedIds]
    if (!ids.length) return
    set({ busy: { label: `正在为 ${ids.length} 篇论文抽取实验画像…` } })
    try {
      const res = await window.papervault.ai.buildProfiles(ids)
      await get().refreshAll()
      set({ selectedIds: new Set(), selectionAnchorId: null })
      get().toast(res.message, res.ok ? 'success' : 'error')
    } catch (err) {
      get().toast(`批量抽画像失败：${errorMessage(err)}`, 'error')
    } finally {
      set({ busy: null })
    }
  },

  async patchSettings(patch) {
    try {
      const settings = await window.papervault.settings.set(patch)
      set({ settings })
      await get().refreshStats()
      return true
    } catch (err) {
      get().toast(`保存设置失败：${errorMessage(err)}`, 'error')
      return false
    }
  },

  setBusy(label) {
    set({ busy: label ? { label } : null })
  },

  async cancelTask() {
    try {
      const cancelled = await window.papervault.task.cancel()
      set({ busy: null, activeTaskId: null })
      get().toast(cancelled ? '已取消当前任务' : '当前没有正在运行的任务', 'info')
    } catch (err) {
      get().toast(`取消失败：${errorMessage(err)}`, 'error')
    }
  },

  toast(text, kind = 'info') {
    const id = ++toastSeq
    set((state) => ({ toasts: [...state.toasts, { id, text, kind }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 4000)
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
  }
}))

/* ------------------------------------------------------------------ */
/*  派生选择器                                                          */
/* ------------------------------------------------------------------ */

/**
 * 过滤 + 排序的结果缓存。
 *
 * 这个选择器会被 zustand 在**每次 store 更新**时调用（toast、busy、任务进度
 * 都算一次），而 papers / filters / searchIds 这三个输入往往一个都没变。
 * 缓存上一次的输入与结果，就能把「整列重排 + 新数组」变成一次引用比较 ——
 * 既省掉计算，也避免返回新数组导致列表整列重渲染。
 */
let visibleCache: {
  papers: PaperSummary[]
  filters: Filters
  searchIds: Set<string> | null
  collections: PaperCollection[]
  result: PaperSummary[]
} | null = null

/**
 * 列表的可见论文 = 结构化筛选（状态/分类/标签）+ 搜索命中集合。
 *
 * 搜索维度交给主进程的全文检索（searchIds），因为它能搜到笔记正文，
 * 而列表数据里没有正文——P1-A 之后正文不进 IPC 载荷。
 * 注意 searchIds === null 表示「没有搜索词」，与「空集合」含义不同。
 */
export function selectVisiblePapers(state: AppState): PaperSummary[] {
  const { papers, filters, searchIds, collections } = state
  if (
    visibleCache &&
    visibleCache.papers === papers &&
    visibleCache.filters === filters &&
    visibleCache.searchIds === searchIds &&
    visibleCache.collections === collections
  ) {
    return visibleCache.result
  }

  const result = computeVisiblePapers(papers, filters, searchIds, collections)
  visibleCache = { papers, filters, searchIds, collections, result }
  return result
}

function computeVisiblePapers(
  papers: PaperSummary[],
  filters: Filters,
  searchIds: Set<string> | null,
  collections: PaperCollection[]
): PaperSummary[] {
  const { categories, tags, status, sort, onlyUnread, collectionId } = filters
  const memberIds = collectionId
    ? new Set(collections.find((c) => c.id === collectionId)?.paperIds ?? [])
    : null

  let list = papers.filter((p) => {
    if (status && p.status !== status) return false
    if (onlyUnread && p.aiFilled) return false
    if (searchIds && !searchIds.has(p.id)) return false
    if (memberIds && !memberIds.has(p.id)) return false
    if (categories.length && !categories.some((c) => p.categories.includes(c))) return false
    if (tags.length && !tags.some((t) => p.tags.includes(t))) return false
    return true
  })

  list = [...list].sort((a, b) => {
    switch (sort) {
      case 'rating':
        return b.rating - a.rating || a.title.localeCompare(b.title)
      case 'importance':
        return b.importance - a.importance || a.title.localeCompare(b.title)
      case 'year':
        return (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title)
      case 'title':
        return a.title.localeCompare(b.title, 'zh')
      default:
        return a.updatedAt < b.updatedAt ? 1 : -1
    }
  })

  return list
}

export function collectionsOfPaper(
  collections: PaperCollection[],
  paperId: string
): PaperCollection[] {
  return collections.filter((c) => c.paperIds.includes(paperId))
}

export function collectAllTags(papers: PaperSummary[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const p of papers) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}
