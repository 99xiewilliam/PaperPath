import { useMemo, useState } from 'react'
import {
  BarChart3,
  BookOpen,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Network,
  Plus,
  Quote,
  RefreshCw,
  Settings,
  FileStack,
  Table2,
  Upload
} from 'lucide-react'
import { allCategories, groupCategories } from '@shared/taxonomy'
import { STATUS_LABEL } from '@shared/types'
import type { PaperStatus } from '@shared/types'
import { cn, formatNumber } from '@/lib/utils'
import {
  selectVisiblePapers,
  useAppStore,
  VIEW_LABEL,
  VIEW_ORDER,
  type ViewKey
} from '@/store/useAppStore'
import { useUiStore } from '@/store/useUiStore'
import { usePanelStore } from '@/store/usePanelStore'
import { IconButton } from './ui'

const NAV: { key: ViewKey; icon: typeof BookOpen }[] = [
  { key: 'library', icon: BookOpen },
  { key: 'compare', icon: Table2 },
  { key: 'phrases', icon: Quote },
  { key: 'graph', icon: Network },
  { key: 'synthesis', icon: FileStack },
  { key: 'dashboard', icon: BarChart3 },
  { key: 'settings', icon: Settings }
]

const STATUS_ORDER: PaperStatus[] = ['inbox', 'reading', 'read', 'archived']

export function Sidebar(): JSX.Element {
  const vault = useAppStore((s) => s.vault)
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const papers = useAppStore((s) => s.papers)
  const settings = useAppStore((s) => s.settings)
  const filters = useAppStore((s) => s.filters)
  const setFilters = useAppStore((s) => s.setFilters)
  const resetFilters = useAppStore((s) => s.resetFilters)
  const chooseVault = useAppStore((s) => s.chooseVault)
  const rescan = useAppStore((s) => s.rescan)
  const visibleCount = useAppStore((s) => selectVisiblePapers(s).length)
  const openImport = useUiStore((s) => s.openImport)
  const openNewPaper = useUiStore((s) => s.openNewPaper)

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const isMac = window.papervault.app.platform === 'darwin'
  // 宽度可拖拽调（App 里的 <Resizer id="sidebar" />），钳制在 store 里
  const width = usePanelStore((s) => s.widths.sidebar)

  const groups = useMemo(
    () => groupCategories(allCategories(settings.customCategories)),
    [settings.customCategories]
  )

  const categoryCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const p of papers) for (const c of p.categories) map.set(c, (map.get(c) ?? 0) + 1)
    return map
  }, [papers])

  const statusCounts = useMemo(() => {
    const map = new Map<PaperStatus, number>()
    for (const p of papers) map.set(p.status, (map.get(p.status) ?? 0) + 1)
    return map
  }, [papers])

  const totalChars = useMemo(
    () => papers.reduce((sum, p) => sum + p.charCount, 0),
    [papers]
  )

  const hasFilter = filters.categories.length > 0 || filters.status !== null || filters.onlyUnread

  const toggleGroup = (group: string): void =>
    setCollapsed((prev) => ({ ...prev, [group]: !prev[group] }))

  const toggleCategory = (id: string): void => {
    const next = filters.categories.includes(id)
      ? filters.categories.filter((c) => c !== id)
      : [...filters.categories, id]
    setFilters({ categories: next })
    if (view !== 'library') setView('library')
  }

  return (
    <aside
      style={{ width }}
      className="flex h-full shrink-0 flex-col border-r border-line bg-bg-raised"
    >
      {isMac ? <div className="app-drag h-9 shrink-0" /> : null}

      <div className={cn('app-drag px-3 pb-2', !isMac && 'pt-3')}>
        <div className="flex items-center gap-2">
          {/*
           * 品牌标：中大校徽式「紫底象牙字」——#750F6D 的紫面（Pantone 255C）
           * 上放象牙衬线斜体花押，同校徽「深底浅纹」的结构。藏书票
           * （ex libris）是「这本书属于某个读书人」的凭证，和产品同源。
           */}
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-gradient-to-b from-cuhk to-cuhk-deep shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_1px_2px_rgba(0,0,0,0.45)]">
            <span className="font-serif text-[12.5px] italic leading-none tracking-tight text-ink-high">
              PV
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-serif text-[13.5px] font-semibold tracking-wide text-ink-high">
              PaperVault
            </div>
            <div className="truncate text-[10.5px] text-ink-low">论文智库 · 本地优先</div>
          </div>
          <IconButton title="重新索引" onClick={() => void rescan()} className="app-no-drag">
            <RefreshCw className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      <div className="app-no-drag px-3 pb-2">
        <button
          onClick={() => void chooseVault()}
          className="group flex w-full items-center gap-2 rounded-lg border border-line bg-bg-base/60 px-2.5 py-1.5 text-left transition hover:border-strong"
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ink-low" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11.5px] text-ink-mid">
              {vault.path.split('/').filter(Boolean).pop() || '未打开'}
            </span>
            <span className="block text-[10px] text-ink-low">
              {papers.length} 篇 · {formatNumber(totalChars)} 字沉淀
            </span>
          </span>
          <ChevronRight className="h-3 w-3 shrink-0 text-ink-low opacity-0 transition group-hover:opacity-100" />
        </button>
      </div>

      <nav className="app-no-drag px-2">
        {NAV.map((item) => {
          const Icon = item.icon
          const active = view === item.key
          const shortcut = VIEW_ORDER.indexOf(item.key) + 1
          return (
            <button
              key={item.key}
              onClick={() => setView(item.key)}
              className={cn(
                'group mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[12.5px] transition',
                active
                  ? /*
                     * 选中态收敛成「微抬起的底 + 白字 + 品牌色只给图标」：
                     * 整行染色（旧 bg-brand/15 + 品牌色文字）七项导航全点上时，
                     * 左栏会变成一排紫色荧光条 —— 颜色只留在图标上，克制得多。
                     */
                    'bg-white/[0.07] font-medium text-ink-high shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] [&_svg]:text-brand-soft'
                  : 'text-ink-mid hover:bg-white/[0.04] hover:text-ink-high'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {VIEW_LABEL[item.key]}
              <span className="ml-auto flex items-center gap-1.5">
                {item.key === 'library' ? (
                  <span className="text-[10.5px] text-ink-low">
                    {hasFilter ? `${visibleCount}/${papers.length}` : papers.length}
                  </span>
                ) : null}
                <span className="text-[10px] text-ink-low opacity-0 transition group-hover:opacity-70">
                  ⌘{shortcut}
                </span>
              </span>
            </button>
          )
        })}
      </nav>

      <div className="mx-3 my-2 border-t border-line" />

      <div className="app-no-drag min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
        <section>
          <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-ink-low">
            阅读状态
          </div>
          <div className="flex flex-wrap gap-1">
            {STATUS_ORDER.map((status) => (
              <button
                key={status}
                onClick={() => {
                  setFilters({ status: filters.status === status ? null : status })
                  if (view !== 'library') setView('library')
                }}
                className={cn(
                  'chip transition',
                  filters.status === status
                    ? 'border-brand/50 bg-brand/20 text-brand-mist'
                    : 'text-ink-mid hover:border-strong'
                )}
              >
                {STATUS_LABEL[status]}
                <span className="text-ink-low">{statusCounts.get(status) ?? 0}</span>
              </button>
            ))}
            <button
              onClick={() => setFilters({ onlyUnread: !filters.onlyUnread })}
              className={cn(
                'chip transition',
                filters.onlyUnread
                  ? 'border-warn/50 bg-warn/15 text-warn'
                  : 'text-ink-mid hover:border-strong'
              )}
            >
              待精读
            </button>
          </div>
        </section>

        <section>
          <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-ink-low">
            分类体系
          </div>
          <div className="space-y-1.5">
            {groups.map((group) => {
              const isCollapsed = collapsed[group.group]
              return (
                <div key={group.group}>
                  <button
                    onClick={() => toggleGroup(group.group)}
                    className="mb-0.5 flex w-full items-center gap-1 text-[10.5px] font-medium uppercase tracking-wider text-ink-low transition hover:text-ink-mid"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3 w-3" />
                    ) : (
                      <ChevronDown className="h-3 w-3" />
                    )}
                    {group.group}
                  </button>
                  {!isCollapsed ? (
                    <div className="space-y-[1px] pl-1">
                      {group.items.map((node) => {
                        const count = categoryCounts.get(node.id) ?? 0
                        const active = filters.categories.includes(node.id)
                        return (
                          <button
                            key={node.id}
                            title={node.description}
                            onClick={() => toggleCategory(node.id)}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[12px] transition',
                              active
                                ? 'bg-white/[0.08] text-ink-high'
                                : 'text-ink-mid hover:bg-white/[0.04] hover:text-ink-high'
                            )}
                          >
                            <span
                              className="h-1.5 w-1.5 shrink-0 rounded-full"
                              style={{
                                background: node.color ?? '#7A766D',
                                opacity: active ? 1 : 0.6
                              }}
                            />
                            <span className="min-w-0 flex-1 truncate">{node.label}</span>
                            {count > 0 ? (
                              <span className="text-[10.5px] text-ink-low">{count}</span>
                            ) : null}
                          </button>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </section>

        {hasFilter ? (
          <button
            onClick={resetFilters}
            className="w-full rounded-lg border border-line py-1.5 text-[11.5px] text-ink-mid transition hover:border-strong hover:text-ink-high"
          >
            清除筛选
          </button>
        ) : null}
      </div>

      <div className="app-no-drag space-y-1.5 border-t border-line p-3">
        {/*
         * 松绿主按钮配象牙字（同 ui.tsx 里 primary 的取舍：紫底书房里
         * 唯一的实色块留给最重要的动作，字用纸的象牙色）。
         */}
        <button
          onClick={() => openImport()}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-b from-[#41856A] to-[#2F644F] py-2 text-[12.5px] font-medium text-[#EDEAE0] shadow-[inset_0_1px_0_rgba(214,242,224,0.22)] transition hover:from-[#4A9175] hover:to-[#38735A]"
        >
          <Upload className="h-3.5 w-3.5" />
          导入 PDF 精读
        </button>
        <button
          onClick={openNewPaper}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-line py-1.5 text-[11.5px] text-ink-mid transition hover:border-strong hover:text-ink-high"
        >
          <Plus className="h-3.5 w-3.5" />
          手动新建条目
        </button>
      </div>
    </aside>
  )
}
