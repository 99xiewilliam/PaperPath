import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, Compass, FileText, Lightbulb, Sparkles } from 'lucide-react'
import {
  PROBLEM_SCOPE_ALL,
  PROBLEM_SOURCE_LABEL,
  type OpenProblem,
  type ProblemMap
} from '@shared/problems'
import { cn, errorMessage, formatDate } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { IdeaCard } from './IdeaCard'
import { Button } from './ui'

/**
 * 开放问题池：把一批论文的「局限与未来工作」聚成问题清单。
 *
 * 传了 `scope` 就固定在那个范围（专题页里用）；不传就让用户在全库和各专题之间选。
 */
export function ProblemPool({ scope: fixedScope }: { scope?: string }): JSX.Element {
  const collections = useAppStore((s) => s.collections)
  const papers = useAppStore((s) => s.papers)
  const [pickedScope, setPickedScope] = useState(PROBLEM_SCOPE_ALL)
  const scope = fixedScope ?? pickedScope

  const [map, setMap] = useState<ProblemMap | null>(null)
  const [status, setStatus] = useState<{ total: number; ready: number } | null>(null)
  const [building, setBuilding] = useState(false)

  const load = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([
        window.papervault.problems.get(scope),
        window.papervault.problems.status(scope)
      ])
      setMap(m)
      setStatus(s)
    } catch (err) {
      setMap(null)
      setStatus(null)
      useAppStore.getState().toast(`读取问题池失败：${errorMessage(err)}`, 'error')
    }
  }, [scope])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void useAppStore.getState().refreshIdeas()
  }, [])

  const build = async (): Promise<void> => {
    setBuilding(true)
    useAppStore.getState().setBusy('正在汇总开放问题…')
    try {
      const res = await window.papervault.problems.build(scope)
      useAppStore.getState().toast(res.message ?? '', res.ok ? 'success' : 'error')
      if (res.ok && res.map) setMap(res.map)
    } catch (err) {
      useAppStore.getState().toast(`汇总失败：${errorMessage(err)}`, 'error')
    } finally {
      useAppStore.getState().setBusy(null)
      setBuilding(false)
    }
  }

  const titleOf = (id: string): string => papers.find((p) => p.id === id)?.title ?? id
  const ready = status?.ready ?? 0
  const pending = map ? Math.max(0, ready - map.paperIds.length) : 0

  return (
    <section className="rounded-xl border border-line bg-bg-raised p-4">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-1.5 font-serif text-body font-semibold text-ink-high">
            <Compass className="h-3.5 w-3.5 text-brand-soft" />
            开放问题池
          </h3>
          <p className="mt-0.5 text-meta text-ink-low">
            把各篇的「局限与未来工作」聚到一起：被反复提到、还没人解决的，往往就是下一个题目。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {fixedScope ? null : (
            <select
              value={pickedScope}
              onChange={(e) => setPickedScope(e.target.value)}
              className="h-8 rounded-lg border border-line bg-bg-base pl-2 pr-6 text-meta text-ink-mid outline-none focus:border-brand/50"
            >
              <option value={PROBLEM_SCOPE_ALL}>全库</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  专题：{c.title}
                </option>
              ))}
            </select>
          )}
          <Button
            variant={map ? 'subtle' : 'primary'}
            icon={<Sparkles className="h-3.5 w-3.5" />}
            loading={building}
            disabled={ready < 2}
            title={ready < 2 ? '至少要 2 篇论文写好了「局限与未来工作」' : undefined}
            onClick={() => void build()}
          >
            {map ? '重新汇总' : '生成问题池'}
          </Button>
        </div>
      </div>

      {status ? (
        <p className="mb-3 text-caption text-ink-low">
          {map
            ? `基于 ${map.paperIds.length} 篇 · 生成于 ${formatDate(map.generatedAt)}`
            : `范围内 ${status.total} 篇，其中 ${ready} 篇已有「局限与未来工作」`}
          {pending ? (
            <span className="text-warn"> · 又有 {pending} 篇写好了，重新汇总可以纳入</span>
          ) : null}
        </p>
      ) : null}

      {map ? (
        <div className="space-y-3">
          {map.summary ? (
            <p className="rounded-lg border border-brand/25 bg-brand/[0.07] px-3 py-2 text-ui leading-relaxed text-ink-mid">
              {map.summary}
            </p>
          ) : null}
          <ol className="space-y-2">
            {map.problems.map((p, i) => (
              <ProblemCard
                key={`${i}-${p.title}`}
                index={i + 1}
                scope={scope}
                problem={p}
                titleOf={titleOf}
              />
            ))}
          </ol>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-ui leading-relaxed text-ink-mid">
          {ready < 2
            ? '先对几篇论文跑一次 AI 精读（「局限与未来工作」维度默认开启），这里才有原料。'
            : '还没有汇总过。点右上角「生成问题池」，一次模型调用。'}
        </p>
      )}
    </section>
  )
}

function ProblemCard({
  index,
  scope,
  problem,
  titleOf
}: {
  index: number
  scope: string
  problem: OpenProblem
  titleOf: (id: string) => string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const setView = useAppStore((s) => s.setView)
  const selectPaper = useAppStore((s) => s.selectPaper)
  const allIdeas = useAppStore((s) => s.ideas)
  const ideas = useMemo(
    () =>
      allIdeas.filter(
        (i) =>
          i.scope === scope &&
          (i.problemId ? i.problemId === problem.id : i.problem === problem.title)
      ),
    [allIdeas, scope, problem.id, problem.title]
  )

  const generate = async (): Promise<void> => {
    setGenerating(true)
    await useAppStore.getState().generateIdeas(scope, problem.id)
    setGenerating(false)
  }

  return (
    <li className="rounded-lg border border-line bg-bg-base px-3.5 py-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2.5 text-left"
      >
        <span className="mt-[1px] w-5 shrink-0 font-serif text-ui text-ink-low">{index}.</span>
        <span className="min-w-0 flex-1">
          <span className="block font-serif text-body font-medium leading-snug text-ink-high">
            {problem.title}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-low">
            <span
              className={cn(
                'rounded px-1.5 py-[1px]',
                problem.source === 'author'
                  ? 'bg-white/[0.06] text-ink-mid'
                  : 'bg-accent/15 text-accent-soft'
              )}
            >
              {PROBLEM_SOURCE_LABEL[problem.source]}
            </span>
            <span>{problem.paperIds.length} 篇提到</span>
            {ideas.length ? <span className="text-brand-mist">{ideas.length} 个选题</span> : null}
          </span>
        </span>
        <ChevronDown
          className={cn('mt-1 h-3.5 w-3.5 shrink-0 text-ink-low transition', open && 'rotate-180')}
        />
      </button>

      {problem.direction ? (
        <p className="mt-2 flex items-start gap-1.5 pl-[30px] text-ui leading-relaxed text-brand-mist">
          <Lightbulb className="mt-[3px] h-3.5 w-3.5 shrink-0" />
          <span>{problem.direction}</span>
        </p>
      ) : null}

      {open ? (
        <div className="mt-2 space-y-2 pl-[30px]">
          {problem.detail ? (
            <p className="whitespace-pre-wrap text-ui leading-relaxed text-ink-mid">
              {problem.detail}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1">
            {problem.paperIds.map((id) => (
              <button
                key={id}
                onClick={() => {
                  setView('library')
                  void selectPaper(id)
                }}
                className="chip max-w-full gap-1 text-ink-mid transition hover:border-strong hover:text-ink-high"
                title="打开这篇论文"
              >
                <FileText className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate">{titleOf(id)}</span>
              </button>
            ))}
          </div>

          <div className="border-t border-line pt-2.5">
            <div className="mb-2 flex items-center gap-2">
              <span className="flex-1 text-caption text-ink-low">
                {ideas.length
                  ? `已有 ${ideas.length} 个选题，再生成会避开它们`
                  : '把这个问题落成能动手的选题：假设、最小验证实验、反证条件'}
              </span>
              <Button
                size="xs"
                variant={ideas.length ? 'ghost' : 'subtle'}
                icon={<Sparkles className="h-3 w-3" />}
                loading={generating}
                onClick={() => void generate()}
              >
                {ideas.length ? '再生成几个' : '生成选题'}
              </Button>
            </div>
            {ideas.length ? (
              <div className="space-y-2">
                {ideas.map((idea) => (
                  <IdeaCard key={idea.id} idea={idea} />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  )
}
