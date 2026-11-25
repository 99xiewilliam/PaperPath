import { useMemo } from 'react'
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  FlaskConical,
  PenTool,
  Sparkles,
  Table2,
  Tags
} from 'lucide-react'
import { hasProfile } from '@shared/experiment'
import { categoryColor } from '@shared/taxonomy'
import { STATUS_LABEL } from '@shared/types'
import type { PaperStatus } from '@shared/types'
import { cn, formatNumber } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { EmptyState } from '@/components/ui'
import { IdeaBoard } from '@/components/IdeaBoard'
import { ProblemPool } from '@/components/ProblemPool'

export function DashboardView(): JSX.Element {
  const stats = useAppStore((s) => s.stats)
  const papers = useAppStore((s) => s.papers)
  const settings = useAppStore((s) => s.settings)
  const setView = useAppStore((s) => s.setView)
  const selectPaper = useAppStore((s) => s.selectPaper)
  /**
   * 「接着读这些」的队列：在读的优先，其次待读，同组按重要度。
   *
   * 这块原来是「复习计划」（按 learningReview 的到期日排），复习功能删掉之后退回成
   * 纯阅读队列 —— 面板本身仍然有用，没必要跟着一起删。
   */
  const queue = useMemo(
    () =>
      papers
        .filter((p) => p.status === 'reading' || p.status === 'inbox')
        .sort(
          (a, b) =>
            Number(b.status === 'reading') - Number(a.status === 'reading') ||
            b.importance - a.importance
        ),
    [papers]
  )

  const profileCount = useMemo(() => papers.filter((p) => hasProfile(p.exp)).length, [papers])

  const inferred = useMemo(() => {
    if (stats) return null
    const byCategory = new Map<string, number>()
    const byTag = new Map<string, number>()
    for (const p of papers) {
      for (const c of p.categories) byCategory.set(c, (byCategory.get(c) ?? 0) + 1)
      for (const t of p.tags) byTag.set(t, (byTag.get(t) ?? 0) + 1)
    }
    return {
      byCategory: [...byCategory.entries()].map(([id, count]) => ({
        id,
        label: id,
        count
      })),
      byTag: [...byTag.entries()].map(([tag, count]) => ({ tag, count }))
    }
  }, [stats, papers])

  if (!stats || stats.total === 0) {
    return (
      <main className="h-full min-w-0 flex-1 overflow-y-auto bg-bg-base px-6 py-5">
        <div className="mx-auto max-w-5xl space-y-5 pb-16">
          <Header />
          <div className="flex min-h-[36vh] items-center justify-center">
            <EmptyState
              icon={<BarChart3 className="h-10 w-10" />}
              title="还没有可以统计的数据"
              description="导入几篇论文并完成精读后，这里会显示积累量、分类分布，以及你真正在沉淀的东西。"
            />
          </div>
        </div>
      </main>
    )
  }

  const readingProgress = stats.total
    ? Math.round(((stats.byStatus.read + stats.byStatus.archived) / stats.total) * 100)
    : 0

  const maxCategory = Math.max(1, ...stats.byCategory.map((c) => c.count))
  const maxYear = Math.max(1, ...stats.byYear.map((y) => y.count))
  const maxWeek = Math.max(1, ...stats.weekly.map((w) => w.count))
  const maxTag = Math.max(
    1,
    ...(stats.byTag.length
      ? stats.byTag.map((t) => t.count)
      : (inferred?.byTag ?? []).map((t) => t.count))
  )

  return (
    <main className="h-full min-w-0 flex-1 overflow-y-auto bg-bg-base px-6 py-5">
      <div className="mx-auto max-w-5xl space-y-5 pb-16">
        <Header />

        <Panel
          title="接着读这些"
          subtitle="在读的优先，其次待读，同组按重要度。读完一篇记得把状态推到「已读完」。"
        >
          {queue.length ? (
            <div className="space-y-2">
              {queue.slice(0, 5).map((paper) => (
                <button
                  key={paper.id}
                  onClick={() => {
                    setView('library')
                    void selectPaper(paper.id)
                  }}
                  className="flex w-full items-center gap-3 rounded-lg border border-line px-3 py-2.5 text-left transition hover:border-brand/50"
                >
                  <BookOpen className="h-4 w-4 shrink-0 text-brand-mist" />
                  <span className="min-w-0 flex-1 truncate text-ui text-ink-high">
                    {paper.title}
                  </span>
                  <span className="shrink-0 text-meta text-ink-low">
                    {STATUS_LABEL[paper.status]}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-low" />
                </button>
              ))}
              {queue.length > 5 ? <p className="text-meta text-ink-low">只显示前 5 篇。</p> : null}
            </div>
          ) : (
            <p className="text-ui text-ink-mid">没有在读或待读的论文 —— 导入一篇 PDF 开始吧。</p>
          )}
        </Panel>

        <ProblemPool />
        <IdeaBoard />

        {/* KPI 用 auto-fit：窗口断点（lg 是窗口宽度）会被固定 236px 的左栏顶掉一档 */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
          <Kpi
            icon={<BookOpen className="h-4 w-4" />}
            label="论文总数"
            value={String(stats.total)}
            hint={`${stats.byStatus.read + stats.byStatus.archived} 篇已读完 · 进度 ${readingProgress}%`}
          />
          <Kpi
            icon={<PenTool className="h-4 w-4" />}
            label="笔记沉淀"
            value={formatNumber(stats.totalChars)}
            hint={`平均 ${formatNumber(Math.round(stats.totalChars / Math.max(1, stats.total)))} 字 / 篇`}
          />
          <Kpi
            icon={<FlaskConical className="h-4 w-4" />}
            label="实验方法论"
            value={String(stats.withExperimentNotes)}
            hint="已拆解实验设计的论文数"
          />
          <Kpi
            icon={<Sparkles className="h-4 w-4" />}
            label="写作手法"
            value={String(stats.withWritingNotes)}
            hint={`已拆解 ≥3 个章节的论文数 · 均分 ${stats.avgRating || '—'}`}
          />
          <Kpi
            icon={<Table2 className="h-4 w-4" />}
            label="实验画像"
            value={`${profileCount}/${papers.length}`}
            hint="已结构化、可进入对比表的论文"
          />
        </div>

        {papers.length > 0 && profileCount < papers.length ? (
          <button
            onClick={() => setView('compare')}
            className="flex w-full items-center gap-2.5 rounded-xl border border-brand/30 bg-brand/[0.07] px-4 py-3 text-left transition hover:border-brand/50 hover:bg-brand/[0.11]"
          >
            <Table2 className="h-4 w-4 shrink-0 text-brand-mist" />
            <span className="min-w-0 flex-1 text-ui leading-relaxed text-ink-mid">
              还有 <span className="text-ink-high">{papers.length - profileCount}</span>{' '}
              篇论文没有实验画像，补上之后就能在实验对比表里横向比较数据集、基线、指标、重复次数与模型选型。
            </span>
            <span className="flex shrink-0 items-center gap-1 text-meta text-brand-mist">
              去补齐
              <ArrowRight className="h-3.5 w-3.5" />
            </span>
          </button>
        ) : null}

        <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-4">
          <Panel title="分类分布" subtitle="按你实际打的分类标签统计">
            {stats.byCategory.length ? (
              <BarList
                items={stats.byCategory.map((c) => ({
                  key: c.id,
                  label: c.label,
                  value: c.count,
                  color: categoryColor(c.id, settings.customCategories)
                }))}
                max={maxCategory}
              />
            ) : (
              <p className="py-4 text-center text-ui text-ink-low">还没有分类数据</p>
            )}
          </Panel>

          <Panel title="阅读状态" subtitle="IP 待读 → 精读中 → 已读完">
            <div className="space-y-2 pt-1">
              {(Object.keys(STATUS_LABEL) as PaperStatus[]).map((status) => {
                const value = stats.byStatus[status] ?? 0
                const percent = stats.total ? Math.round((value / stats.total) * 100) : 0
                return (
                  <div key={status}>
                    <div className="mb-1 flex items-center justify-between text-meta">
                      <span className="text-ink-mid">{STATUS_LABEL[status]}</span>
                      <span className="text-ink-low">
                        {value} 篇 · {percent}%
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                      <div
                        className="h-full rounded-full bg-brand-soft transition-all"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </Panel>

          <Panel title="最近 12 周入库量" subtitle="看你还保持不保持阅读节奏">
            <div className="flex h-32 items-end gap-1.5 pt-2">
              {stats.weekly.map((w) => (
                <div key={w.week} className="group flex flex-1 flex-col items-center gap-1">
                  <div
                    className="w-full rounded-t bg-brand/50 transition-all group-hover:bg-brand"
                    style={{
                      height: `${Math.max(3, (w.count / maxWeek) * 96)}px`
                    }}
                    title={`${w.week}：${w.count} 篇`}
                  />
                  <span className="text-tiny text-ink-low">{w.week.split('-W')[1]}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="发表年份分布" subtitle="你关注的是新东西还是经典">
            {stats.byYear.length ? (
              <div className="space-y-1.5 pt-1">
                {stats.byYear.map((y) => (
                  <div key={y.year} className="flex items-center gap-2">
                    <span className="w-10 shrink-0 text-right font-mono text-meta text-ink-low">
                      {y.year}
                    </span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-white/[0.05]">
                      <div
                        className="flex h-full items-center justify-end rounded bg-accent/45 pr-1.5 text-caption text-white/90"
                        style={{
                          width: `${Math.max(8, (y.count / maxYear) * 100)}%`
                        }}
                      >
                        {y.count}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-4 text-center text-ui text-ink-low">还没有年份数据</p>
            )}
          </Panel>
        </div>

        <Panel
          title={
            <span className="inline-flex items-center gap-1.5">
              <Tags className="h-3.5 w-3.5" />
              高频标签
            </span>
          }
          subtitle="标签反映出你反复关注的技术点"
        >
          {stats.byTag.length || inferred?.byTag.length ? (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {(stats.byTag.length ? stats.byTag : inferred!.byTag).map((t) => (
                <span
                  key={t.tag}
                  className="chip"
                  style={{
                    opacity: 0.45 + 0.55 * (t.count / maxTag),
                    borderColor: 'rgba(116,172,143,0.35)',
                    color: '#ABD3BC'
                  }}
                >
                  #{t.tag}
                  <span className="text-ink-low">{t.count}</span>
                </span>
              ))}
            </div>
          ) : (
            <p className="py-4 text-center text-ui text-ink-low">还没有标签</p>
          )}
        </Panel>
      </div>
    </main>
  )
}

/** 标题只写「沉淀」：它现在同时是二级入口的落点，加「统计」两个字盖不住 */
function Header(): JSX.Element {
  return (
    <header>
      <h1 className="font-serif text-[20px] font-semibold text-ink-high">沉淀</h1>
      <p className="mt-1 text-ui text-ink-mid">
        这里衡量的是你「真正带走了什么」，而不是读了多少篇。
      </p>
    </header>
  )
}

function Kpi({
  icon,
  label,
  value,
  hint
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
}): JSX.Element {
  return (
    <div className="rounded-xl border border-line bg-bg-raised px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-meta text-ink-low">
        <span className="text-brand-soft">{icon}</span>
        {label}
      </div>
      {/*
       * 数值用衬线：Georgia / New York 的数字是 old-style（高低错落的文字
       * 数字），大号显示时自带出版物质感——统计页的「数字」就是内容面。
       */}
      <div className="mt-1.5 font-serif text-[24px] font-semibold leading-none text-ink-high">
        {value}
      </div>
      {hint ? <div className="mt-1.5 text-caption text-ink-low">{hint}</div> : null}
    </div>
  )
}

function Panel({
  title,
  subtitle,
  children
}: {
  title: React.ReactNode
  subtitle?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="rounded-xl border border-line bg-bg-raised p-4">
      <div className="mb-3">
        <h3 className="font-serif text-body font-semibold text-ink-high">{title}</h3>
        {subtitle ? <p className="mt-0.5 text-meta text-ink-low">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  )
}

function BarList({
  items,
  max
}: {
  items: { key: string; label: string; value: number; color?: string }[]
  max: number
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      {items.map((item) => (
        <div key={item.key} className="flex items-center gap-2">
          <span className="w-32 shrink-0 truncate text-meta text-ink-mid" title={item.label}>
            {item.label}
          </span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-white/[0.05]">
            <div
              className={cn('h-full rounded transition-all')}
              style={{
                width: `${Math.max(6, (item.value / max) * 100)}%`,
                background: item.color ?? '#74AC8F',
                opacity: 0.75
              }}
            />
          </div>
          <span className="w-6 shrink-0 text-right text-meta text-ink-low">{item.value}</span>
        </div>
      ))}
    </div>
  )
}
