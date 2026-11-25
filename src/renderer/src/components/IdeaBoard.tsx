import { useEffect, useMemo, useState } from 'react'
import { NotebookPen } from 'lucide-react'
import { IDEA_STATUS_LABEL, IDEA_STATUSES, type IdeaStatus } from '@shared/ideas'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { IdeaCard } from './IdeaCard'

type Filter = 'active' | IdeaStatus

const ORDER: Record<IdeaStatus, number> = { pursuing: 0, new: 1, parked: 2, dropped: 3 }

/**
 * 选题本：所有从开放问题生成的选题集中在这里跟进。
 * 默认只看还活着的（在推进 + 待评估 + 先放着），放弃的单独一栏 —— 留着是为了记住「为什么不做」。
 */
export function IdeaBoard(): JSX.Element | null {
  const ideas = useAppStore((s) => s.ideas)
  const refreshIdeas = useAppStore((s) => s.refreshIdeas)
  const [filter, setFilter] = useState<Filter>('active')

  useEffect(() => {
    void refreshIdeas()
  }, [refreshIdeas])

  const counts = useMemo(() => {
    const out: Record<Filter, number> = { active: 0, new: 0, pursuing: 0, parked: 0, dropped: 0 }
    for (const idea of ideas) {
      out[idea.status]++
      if (idea.status !== 'dropped') out.active++
    }
    return out
  }, [ideas])

  const shown = useMemo(
    () =>
      ideas
        .filter((i) => (filter === 'active' ? i.status !== 'dropped' : i.status === filter))
        .sort((a, b) => ORDER[a.status] - ORDER[b.status]),
    [ideas, filter]
  )

  if (!ideas.length) return null

  const tabs: [Filter, string][] = [
    ['active', '进行中'],
    ...IDEA_STATUSES.map((s): [Filter, string] => [s, IDEA_STATUS_LABEL[s]])
  ]

  return (
    <section className="rounded-xl border border-line bg-bg-raised p-4">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-1.5 font-serif text-body font-semibold text-ink-high">
            <NotebookPen className="h-3.5 w-3.5 text-brand-soft" />
            选题本
          </h3>
          <p className="mt-0.5 text-meta text-ink-low">
            从开放问题生成的选题都在这里。改状态、写备注会直接存进知识库的 ideas/ 目录。
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={cn(
                'rounded-md px-2 py-[3px] text-caption transition',
                filter === key ? 'bg-white/[0.09] text-ink-high' : 'text-ink-low hover:text-ink-mid'
              )}
            >
              {label} {counts[key]}
            </button>
          ))}
        </div>
      </div>
      {shown.length ? (
        <div className="space-y-2">
          {shown.map((idea) => (
            <IdeaCard key={idea.id} idea={idea} showProblem />
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-ui text-ink-mid">
          这一栏还没有选题。
        </p>
      )}
    </section>
  )
}
