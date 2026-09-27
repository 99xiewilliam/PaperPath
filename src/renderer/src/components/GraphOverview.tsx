import { useMemo } from 'react'
import { AlertTriangle, ExternalLink, Network, Trophy, Link2, BarChart3 } from 'lucide-react'
import {
  ENTITY_KIND_COLOR,
  ENTITY_KIND_LABEL,
  RELATION_LABEL,
  type EntityKind,
  type RelationType
} from '@shared/lenses'
import type { GraphData } from '@shared/graph'

/** 排行榜最多展示多少行，避免几百个实体把页面撑爆 */
const RANK_LIMIT = 40
/** 论文对最多展示多少行 */
const PAIR_LIMIT = 20

interface Props {
  data: GraphData
  /** 点击实体 → 在关系图里定位它 */
  onSelectEntity: (id: string) => void
  onOpenPaper: (paperId: string) => void
}

/**
 * 知识图谱「概览」视图。
 *
 * 为什么需要它：力导向图在论文少的时候就是一团毛球 ——
 * 6 篇论文能抽出 130+ 个实体，其中九成只被 1 篇提到，
 * 图上根本看不出「这个领域在用什么」。而把同样的数据换成
 * 排序表 + 关联对 + 分布条，一眼就能读出「标配是什么、谁和谁能比」。
 *
 * 图仍然有用，但它的价值在「查具体一条路径」，不在「看全局」。
 */
export function GraphOverview({ data, onSelectEntity, onOpenPaper }: Props): JSX.Element {
  const nodeMap = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data.nodes])

  /** 论文 → 它涉及的实体 id 集合 */
  const paperEntities = useMemo(() => {
    const out = new Map<string, Set<string>>()
    for (const edge of data.edges) {
      if (edge.type !== 'mentions') continue
      if (!out.has(edge.from)) out.set(edge.from, new Set())
      out.get(edge.from)!.add(edge.to)
    }
    return out
  }, [data.edges])

  /** 实体 → 提到它的论文 id 列表 */
  const entityPapers = useMemo(() => {
    const out = new Map<string, string[]>()
    for (const [pid, entities] of paperEntities) {
      for (const eid of entities) {
        if (!out.has(eid)) out.set(eid, [])
        out.get(eid)!.push(pid)
      }
    }
    return out
  }, [paperEntities])

  /** 领域标配：跨 ≥2 篇论文的实体，按覆盖论文数降序 */
  const ranking = useMemo(
    () =>
      data.nodes
        .filter((n) => n.kind !== 'paper' && n.paperCount >= 2)
        .sort((a, b) => b.paperCount - a.paperCount || (b.mentions ?? 0) - (a.mentions ?? 0))
        .slice(0, RANK_LIMIT),
    [data.nodes]
  )

  /** 共享实体的论文对 —— 「这两篇能一起比」的依据 */
  const { pairs, islands } = useMemo(() => {
    const ids = [...paperEntities.keys()]
    const out: { a: string; b: string; shared: string[] }[] = []
    const linked = new Set<string>()
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const ea = paperEntities.get(ids[i])!
        const eb = paperEntities.get(ids[j])!
        const shared = [...ea].filter((id) => eb.has(id))
        if (!shared.length) continue
        out.push({ a: ids[i], b: ids[j], shared })
        linked.add(ids[i])
        linked.add(ids[j])
      }
    }
    out.sort((x, y) => y.shared.length - x.shared.length)
    return { pairs: out.slice(0, PAIR_LIMIT), islands: ids.filter((id) => !linked.has(id)) }
  }, [paperEntities])

  /** 两张分布条 */
  const kindDist = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of data.nodes) {
      if (n.kind === 'paper') continue
      counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1)
    }
    return [...counts].sort((a, b) => b[1] - a[1])
  }, [data.nodes])

  const relDist = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of data.edges) {
      if (e.type === 'mentions') continue
      /*
       * 论文关系边不算进来：那是你建立的关系，词表和这里「抽出来的语义关系」
       * 不是一套 —— 混进来会多出几根英文类型名的柱子（builds-on / inspires…）。
       */
      if (e.layer === 'paper') continue
      counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
    }
    return [...counts].sort((a, b) => b[1] - a[1])
  }, [data.edges])

  const { stats } = data
  const paperCount = stats.papers
  /** 跨论文实体占比 —— 这就是「图有没有说服力」的量化指标 */
  const share = stats.entities ? Math.round(((stats.entities - stats.singletons) / stats.entities) * 100) : 0

  const paperName = (id: string): string => {
    const node = nodeMap.get(id)
    return node ? shorten(node.name, 26) : id
  }
  const entityName = (id: string): string => nodeMap.get(id)?.name ?? id

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 px-6 py-5 pb-16">
        {/* 诊断 */}
        <section className="rounded-xl border border-line bg-bg-raised px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Network className="h-3.5 w-3.5 shrink-0 text-brand-soft" />
            <span className="text-[12.5px] font-medium text-ink-high">
              {paperCount} 篇论文 · {stats.entities} 个实体 · {stats.relations} 条关系
            </span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-mid">
            跨论文出现的实体（也就是真正把论文连起来的）
            <span className="text-ink-high"> {stats.entities - stats.singletons} 个</span>，占 {share}%。
          </p>
          {stats.singletons > 0 ? (
            <p className="mt-1 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-warn">
              <AlertTriangle className="mt-[2px] h-3 w-3 shrink-0" />
              <span>
                另外 {stats.singletons} 个实体只被 1 篇论文提到 —— 它们各说各的，图上连不起来。
                想让图谱开始产出规律，最有效的做法是
                <span className="text-ink-mid">优先补充同一方向的论文</span>
                （一个方向攒到 10 篇以上），而不是泛泛地加论文。
              </span>
            </p>
          ) : null}
        </section>

        {/* 领域标配 */}
        <section className="rounded-xl border border-line bg-bg-raised">
          <Header icon={<Trophy className="h-3.5 w-3.5 text-[#C9973F]" />} title="领域标配">
            跨 ≥2 篇论文的实体。数量越多说明它越是这个方向绕不开的东西。
          </Header>
          {ranking.length ? (
            <div className="divide-y divide-line/60">
              {ranking.map((node) => (
                <button
                  key={node.id}
                  onClick={() => onSelectEntity(node.id)}
                  className="flex w-full items-center gap-2.5 px-4 py-2 text-left transition hover:bg-white/[0.04]"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: ENTITY_KIND_COLOR[node.kind as EntityKind] }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink-high">{node.name}</span>
                  <span className="shrink-0 text-[10.5px] text-ink-low">
                    {ENTITY_KIND_LABEL[node.kind as EntityKind]}
                  </span>
                  <Bar value={node.paperCount} max={ranking[0].paperCount} color={ENTITY_KIND_COLOR[node.kind as EntityKind]} />
                  <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-ink-mid">
                    {node.paperCount} 篇
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="px-4 pb-4">
              <p className="text-[11px] leading-relaxed text-ink-low">
                目前没有任何实体跨过 2 篇论文，所以还谈不上「标配」。
                这不代表抽取有问题——{paperCount} 篇论文本来就很难重叠。
              </p>
            </div>
          )}
        </section>

        {/* 论文关联 */}
        <section className="rounded-xl border border-line bg-bg-raised">
          <Header icon={<Link2 className="h-3.5 w-3.5 text-[#7FA3C7]" />} title="论文之间的关联">
            共享实体的论文可以放在一起比较。没有共享实体的论文，多半属于不同方向。
          </Header>
          <div className="space-y-1 px-4 pb-4 pt-1">
            {pairs.length ? (
              pairs.map((pair) => (
                <div
                  key={`${pair.a}|${pair.b}`}
                  className="rounded-lg border border-line/70 bg-bg-base/60 px-2.5 py-2"
                >
                  <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                    <button
                      onClick={() => {
                        const pid = nodeMap.get(pair.a)?.paperId
                        if (pid) onOpenPaper(pid)
                      }}
                      className="max-w-[38%] truncate text-ink-high transition hover:text-brand-mist"
                    >
                      {paperName(pair.a)}
                    </button>
                    <span className="text-ink-low">↔</span>
                    <button
                      onClick={() => {
                        const pid = nodeMap.get(pair.b)?.paperId
                        if (pid) onOpenPaper(pid)
                      }}
                      className="max-w-[38%] truncate text-ink-high transition hover:text-brand-mist"
                    >
                      {paperName(pair.b)}
                    </button>
                    <span className="ml-auto shrink-0 text-[10.5px] text-ink-low">
                      {pair.shared.length} 个共同点
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {pair.shared.slice(0, 8).map((id) => (
                      <span
                        key={id}
                        className="max-w-[130px] truncate rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-ink-mid"
                      >
                        {entityName(id)}
                      </span>
                    ))}
                    {pair.shared.length > 8 ? (
                      <span className="text-[10px] text-ink-low">+{pair.shared.length - 8}</span>
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-[11px] text-ink-low">还没有任意两篇论文共享实体。</p>
            )}

            {islands.length ? (
              <div className="mt-2 rounded-lg border border-line/60 bg-bg-base/40 px-2.5 py-2">
                <p className="text-[10.5px] leading-relaxed text-ink-low">
                  <span className="text-ink-mid">{islands.length} 篇论文与其它论文没有任何交集</span>
                  （属于不同方向或确实独立）：
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {islands.map((id) => (
                    <button
                      key={id}
                      onClick={() => {
                        const pid = nodeMap.get(id)?.paperId
                        if (pid) onOpenPaper(pid)
                      }}
                      className="max-w-[200px] truncate rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-mid transition hover:border-strong hover:text-ink-high"
                    >
                      {paperName(id)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </section>

        {/* 分布 */}
        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-line bg-bg-raised">
            <Header icon={<BarChart3 className="h-3.5 w-3.5 text-[#ACA3CF]" />} title="实体类型分布" />
            <Dist rows={kindDist} total={kindDist.reduce((s, [, v]) => s + v, 0)} colorOf={(k) => ENTITY_KIND_COLOR[k as EntityKind]} labelOf={(k) => ENTITY_KIND_LABEL[k as EntityKind] ?? k} />
          </div>
          <div className="rounded-xl border border-line bg-bg-raised">
            <Header icon={<BarChart3 className="h-3.5 w-3.5 text-[#5FA983]" />} title="关系类型分布" />
            <Dist
              rows={relDist}
              total={relDist.reduce((s, [, v]) => s + v, 0)}
              colorOf={() => '#5FA983'}
              labelOf={(k) => RELATION_LABEL[k as RelationType] ?? k}
            />
          </div>
        </section>

        <p className="text-[10.5px] leading-relaxed text-ink-low">
          数据来自「{LENS_LABEL}」维度。换个角度查「这两篇为什么相关」，切到
          <span className="text-ink-mid">关系图</span>：选一个节点 → 看它 2~3 跳内连到哪些论文、经由了哪些实体。
        </p>
      </div>
    </div>
  )
}

const LENS_LABEL = '知识图谱抽取'

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function Header({
  icon,
  title,
  children
}: {
  icon: JSX.Element
  title: string
  children?: React.ReactNode
}): JSX.Element {
  return (
    <div className="px-4 pb-1.5 pt-3">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-[12px] font-medium text-ink-high">{title}</span>
      </div>
      {children ? (
        <p className="mt-1 text-[10.5px] leading-relaxed text-ink-low">{children}</p>
      ) : null}
    </div>
  )
}

function Bar({ value, max, color }: { value: number; max: number; color: string }): JSX.Element {
  return (
    <span className="hidden h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-white/[0.07] sm:block">
      <span
        className="block h-full rounded-full"
        style={{ width: `${max ? Math.max(8, (value / max) * 100) : 0}%`, background: color }}
      />
    </span>
  )
}

function Dist({
  rows,
  total,
  colorOf,
  labelOf
}: {
  rows: [string, number][]
  total: number
  colorOf: (key: string) => string
  labelOf: (key: string) => string
}): JSX.Element {
  if (!rows.length) {
    return <p className="px-4 pb-4 text-[11px] text-ink-low">暂无数据。</p>
  }
  return (
    <div className="space-y-1 px-4 pb-4 pt-1">
      {rows.map(([key, count]) => (
        <div key={key} className="flex items-center gap-2">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: colorOf(key) }}
          />
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-mid">{labelOf(key)}</span>
          <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-white/[0.07]">
            <span
              className="block h-full rounded-full"
              style={{ width: `${total ? (count / total) * 100 : 0}%`, background: colorOf(key) }}
            />
          </span>
          <span className="w-7 shrink-0 text-right text-[10.5px] tabular-nums text-ink-low">
            {count}
          </span>
        </div>
      ))}
    </div>
  )
}

