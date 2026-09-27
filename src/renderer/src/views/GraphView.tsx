import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  Crosshair,
  ExternalLink,
  Link2,
  Loader2,
  Maximize2,
  Network,
  RefreshCw,
  Route,
  Combine,
  X
} from 'lucide-react'
import {
  ENTITY_KIND_COLOR,
  ENTITY_KIND_LABEL,
  RELATION_LABEL,
  type EntityKind,
  type RelationType
} from '@shared/lenses'
import {
  LINK_TYPE_COLOR,
  LINK_TYPE_HINT,
  LINK_TYPE_LABEL,
  LINK_TYPES,
  normalizeLinks,
  type PaperLinkType
} from '@shared/links'
import { EMPTY_GRAPH_STATS } from '@shared/graph'
import type {
  GraphData,
  GraphEdge,
  GraphNode,
  GraphScope,
  HopPath,
  MultiHopResult
} from '@shared/graph'
import { categoryLabel } from '@shared/taxonomy'
import { cn, errorMessage } from '@/lib/utils'
import { Button, Chip, EmptyState, IconButton, Modal } from '@/components/ui'
import { GraphCanvas, GraphLegend, nodeColor } from '@/components/GraphCanvas'
import { Markdown } from '@/components/Markdown'
import { GraphOverview } from '@/components/GraphOverview'
import { Resizer } from '@/components/Resizer'
import { useAppStore } from '@/store/useAppStore'
import { usePanelStore } from '@/store/usePanelStore'

const EMPTY: GraphData = {
  nodes: [],
  edges: [],
  stats: EMPTY_GRAPH_STATS
}

/**
 * 边的中文名。
 *
 * 两层用的是**两套词表**：实体边查 `RELATION_LABEL`（proposes / trained-on…），
 * 论文关系边查 shared/links 的标签 —— 后者必须和详情页里那些类型 chip 是同一份，
 * 否则同一条关系在两个页面上叫两个名字。
 */
function edgeLabel(edge: GraphEdge): string {
  if (edge.type === 'mentions') return '涉及'
  if (edge.layer === 'paper') return LINK_TYPE_LABEL[edge.type as PaperLinkType] ?? edge.type
  return RELATION_LABEL[edge.type as RelationType] ?? edge.type
}

/** 画布同时绘制的节点上限，超出后按枢纽优先级裁剪 */
const MAX_NODES = 700

export function GraphView(): JSX.Element {
  const papers = useAppStore((s) => s.papers)
  const settings = useAppStore((s) => s.settings)
  const setView = useAppStore((s) => s.setView)
  const selectPaper = useAppStore((s) => s.selectPaper)
  // 左右两栏可拖拽调宽（各自的 <Resizer /> 把手贴在栏边），钳制在 store 里
  const graphLeftWidth = usePanelStore((s) => s.widths.graphLeft)
  const graphRightWidth = usePanelStore((s) => s.widths.graphRight)

  const [data, setData] = useState<GraphData>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [categories, setCategories] = useState<string[]>([])
  const [minPapers, setMinPapers] = useState(1)
  const [includePapers, setIncludePapers] = useState(true)
  const [hiddenKinds, setHiddenKinds] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /**
   * 组合分析的成员（论文 id）。
   *
   * 与 selectedId 分开：单个选中是「看这一篇」，组合是「把这几篇放到一起看有没有新东西」。
   * 只有 ⌘/Shift 点选会改动它 —— 普通点击不碰，否则「随手点一篇看一眼再回来」
   * 就会把刚挑好的组合清掉。
   */
  const [comboIds, setComboIds] = useState<string[]>([])
  const [comboRunning, setComboRunning] = useState(false)
  /**
   * 刚跑出来的组合分析结果，就地显示在右侧抽屉里。
   *
   * 不自动跳走是有意的：组合是要反复试的（换掉一篇、补一篇再跑），
   * 每次跑完把视图抢走，就得手动切回来才能继续调；但结果又必须立刻能读，
   * 所以用一个可以随手关掉的抽屉，而不是只弹一句提示。
   */
  const [resultDoc, setResultDoc] = useState<{ title: string; content: string } | null>(null)
  /** 「把这两篇连起来」的草稿；非空即弹窗打开 */
  const [linkDraft, setLinkDraft] = useState<{
    from: string
    to: string
    type: PaperLinkType
    note: string
  } | null>(null)
  const [linkSaving, setLinkSaving] = useState(false)
  const [hops, setHops] = useState(2)
  const [multiHop, setMultiHop] = useState<MultiHopResult | null>(null)
  const [hopLoading, setHopLoading] = useState(false)
  const [focusedPath, setFocusedPath] = useState<string[] | null>(null)
  /**
   * 默认落在「概览」而不是关系图。
   *
   * 力导向图在论文少的时候就是一团毛球（6 篇能抽出 130+ 个实体，
   * 九成只被 1 篇提到），看不出「这个领域在用什么」；
   * 而同一份数据排成表就是可读的结论。图的价值在「查某一条路径」，
   * 所以它退到第二个页签，需要看具体连接时再切过去。
   */
  const [viewMode, setViewMode] = useState<'overview' | 'graph'>('overview')
  /**
   * 关系图上要不要叠一层「从原文抽出来的实体」。
   *
   * **默认关**。那张实体图的问题不是画得不好，而是它回答的问题是机械的：
   * 「这两篇共享 HotpotQA」多半是巧合，读到了也不会改变你怎么想；而且关系全来自
   * 一次你改不了的抽取。所以默认只看**你建立的**论文关系，实体退到叠加层 ——
   * 想追问「凭什么说这两篇相关」时再打开它。
   */
  const [showEntities, setShowEntities] = useState(false)

  /** 当前画的是哪一层：概览始终用实体层（它的共现统计依赖 mentions 边） */
  const entityLayer = viewMode === 'overview' || showEntities

  const scope: GraphScope = useMemo(
    () =>
      entityLayer
        ? viewMode === 'overview'
          ? // 概览要全量：它自己按「跨几篇论文」排序，不能被粒度筛选提前砍掉
            { categories, minPapers: 1, includePapers: true, mode: 'entities' }
          : { categories, minPapers, includePapers, mode: 'entities' }
        : // 关系层：粒度/论文节点这两个开关都无意义，显式关掉免得被上面的状态带进来
          { categories, minPapers: 1, includePapers: true, mode: 'relations' },
    [entityLayer, viewMode, categories, minPapers, includePapers]
  )

  /**
   * 第一次拿到数据时自动选一个「不至于糊成一团」的粒度。
   *
   * 默认按「跨 ≥2 篇论文」画 —— 跨论文实体才是图的骨架；只被 1 篇提到的实体
   * 各连各的，全画出来就是一团上百个点的毛球（实测 6 篇论文里有 122 个这样的实体）。
   * 用户手动调过之后就不再干预。
   */
  const autoScopeRef = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const snapshot = await window.papervault.graph.snapshot(scope)
      setData(snapshot)
      // 自动选粒度只对实体层有意义（它读的 totalEntities 在关系层恒为 0）
      if (!autoScopeRef.current && entityLayer) {
        autoScopeRef.current = true
        const { totalEntities, multiPaperEntities } = snapshot.stats
        // 只有「确实有足够的跨论文连接」且「全量明显过大」时才收紧，
        // 否则会画出一张空图，比乱更糟
        const suggested = multiPaperEntities >= 4 && totalEntities > 60 ? 2 : 1
        if (suggested !== minPapers) {
          setMinPapers(suggested)
          return
        }
      }
    } finally {
      setLoading(false)
    }
  }, [scope, minPapers])

  useEffect(() => {
    void load()
  }, [load, papers.length])

  /**
   * 按实体类型隐藏 + 规模保护。
   * 力导向的斥力是 O(n²)，节点上千会明显掉帧，所以超出上限时
   * 只保留论文节点和「被最多论文提到」的实体（枢纽优先，信息量最大）。
   */
  const { visible, truncated } = useMemo(() => {
    let nodes = data.nodes
    let edges = data.edges

    if (hiddenKinds.length) {
      const hidden = new Set(hiddenKinds)
      nodes = nodes.filter((n) => n.kind === 'paper' || !hidden.has(n.kind))
      const kept = new Set(nodes.map((n) => n.id))
      edges = edges.filter((e) => kept.has(e.from) && kept.has(e.to))
    }

    let cut = false
    if (nodes.length > MAX_NODES) {
      const papers = nodes.filter((n) => n.kind === 'paper')
      const entities = nodes
        .filter((n) => n.kind !== 'paper')
        .sort((a, b) => b.paperCount - a.paperCount)
      nodes = [...papers, ...entities.slice(0, Math.max(0, MAX_NODES - papers.length))]
      const kept = new Set(nodes.map((n) => n.id))
      edges = edges.filter((e) => kept.has(e.from) && kept.has(e.to))
      cut = true
    }

    return { visible: { ...data, nodes, edges }, truncated: cut }
  }, [data, hiddenKinds])

  const nodeMap = useMemo(() => new Map(visible.nodes.map((n) => [n.id, n])), [visible.nodes])
  const selected = selectedId ? (nodeMap.get(selectedId) ?? null) : null

  /** 库里出现过的实体类型，用于图例与过滤 */
  const presentKinds = useMemo(() => {
    const set = new Set<EntityKind>()
    for (const n of data.nodes) if (n.kind !== 'paper') set.add(n.kind as EntityKind)
    return [...set].sort()
  }, [data.nodes])

  /** 当前图上实际出现的论文关系类型，用于图例（只列有的，免得摆一排没用的） */
  const presentLinkTypes = useMemo(() => {
    const set = new Set<PaperLinkType>()
    for (const edge of data.edges) if (edge.layer === 'paper') set.add(edge.type as PaperLinkType)
    return [...set]
  }, [data.edges])

  /* ---------------- 多跳 ---------------- */
  const runMultiHop = useCallback(
    async (startId: string, h: number) => {
      setHopLoading(true)
      try {
        setMultiHop(await window.papervault.graph.multiHop(startId, h, scope))
      } finally {
        setHopLoading(false)
      }
    },
    [scope]
  )

  useEffect(() => {
    if (!selectedId) {
      setMultiHop(null)
      setFocusedPath(null)
      return
    }
    void runMultiHop(selectedId, hops)
  }, [selectedId, hops, runMultiHop])

  /** 选中节点的相邻节点与边（没有多跳结果时的默认高亮） */
  const highlight = useMemo(() => {
    if (focusedPath) {
      const edges = visible.edges.filter(
        (e) => focusedPath.includes(e.from) && focusedPath.includes(e.to)
      )
      return { nodes: focusedPath, edges: edges.map((e) => e.id) }
    }
    if (multiHop) {
      return { nodes: multiHop.highlightNodes, edges: multiHop.highlightEdges }
    }
    if (!selectedId) return { nodes: undefined, edges: undefined }
    const ids = new Set<string>([selectedId])
    const edgeIds: string[] = []
    for (const e of visible.edges) {
      if (e.from === selectedId || e.to === selectedId) {
        ids.add(e.from)
        ids.add(e.to)
        edgeIds.push(e.id)
      }
    }
    return { nodes: [...ids], edges: edgeIds }
  }, [selectedId, multiHop, focusedPath, visible.edges])

  const openPaper = (paperId: string): void => {
    setView('library')
    void selectPaper(paperId)
  }

  /* ---------------- 空状态 ---------------- */
  if (!loading && data.stats.papers === 0) {
    return (
      <main className="flex h-full min-w-0 flex-1 items-center justify-center bg-bg-base">
        <EmptyState
          icon={<Network className="h-10 w-10" />}
          title="还没有可以建图的数据"
          description={
            papers.length
              ? `知识图谱靠「知识图谱抽取」维度产出的实体与关系构建。你库里有 ${papers.length} 篇论文，但都还没有图谱数据——到论文详情页点「AI 精读」，勾选「知识图谱抽取」跑一次即可。`
              : '先导入几篇论文，再跑一次包含「知识图谱抽取」维度的精读。'
          }
          action={
            <Button variant="primary" size="md" onClick={() => setView('library')}>
              回到论文库
            </Button>
          }
        />
      </main>
    )
  }

  /**
   * 画布点选：普通点击 = 看详情；⌘/Shift 点击 = 加入 / 移出组合。
   * 组合只收论文节点 —— 实体是叠加层的东西，不参与组合分析。
   */
  const selectNode = (id: string | null, additive?: boolean): void => {
    setSelectedId(id)
    if (!additive || !id) return
    const node = nodeMap.get(id)
    if (node?.kind !== 'paper' || !node.paperId) return
    /*
     * 存的是**论文 id**，不是画布节点 id —— 节点 id 是 `p:<paperId>`，
     * 直接交给主进程会一篇都查不到（组合分析、连线都吃论文 id）。
     */
    const paperId = node.paperId
    setComboIds((prev) =>
      prev.includes(paperId) ? prev.filter((x) => x !== paperId) : [...prev, paperId]
    )
  }

  /** 列表载荷里的标题：组合条与连线弹窗显示的都不是画布节点 id */
  const titleOfPaper = (id: string): string =>
    papers.find((p) => p.id === id)?.title ?? '（论文已删除）'

  /** 画布上拖拽连线：画布报的是节点 id，这里换算成论文 id 再开弹窗 */
  const requestLink = (fromNodeId: string, toNodeId: string): void => {
    const from = nodeMap.get(fromNodeId)
    const to = nodeMap.get(toNodeId)
    if (from?.kind !== 'paper' || to?.kind !== 'paper') return
    if (!from.paperId || !to.paperId) return
    setLinkDraft({ from: from.paperId, to: to.paperId, type: 'related', note: '' })
  }

  /**
   * 一键组合分析：把这组论文整体交给主进程（材料与线索都在那边算），
   * 结果是一份文档，在「跨论文」页读。
   */
  const runCombo = async (): Promise<void> => {
    setComboRunning(true)
    useAppStore.getState().setBusy(`正在分析这 ${comboIds.length} 篇的组合空间…`)
    try {
      const res = await window.papervault.ai.comboAnalyze({ paperIds: comboIds })
      if (res.ok && res.synthesisId) {
        await useAppStore.getState().refreshSyntheses()
        // 就地读出来放进抽屉：选择集保留着，方便改了成员再跑一次
        const doc = await window.papervault.synthesis.get(res.synthesisId)
        if (doc) setResultDoc({ title: doc.title, content: doc.content })
        useAppStore.getState().toast(res.message, 'success')
      } else if (res.ok) {
        useAppStore.getState().toast(res.message, 'success')
      } else {
        useAppStore.getState().toast(res.message ?? '分析失败', 'error')
      }
    } catch (err) {
      useAppStore.getState().toast(`分析失败：${errorMessage(err)}`, 'error')
    } finally {
      useAppStore.getState().setBusy(null)
      setComboRunning(false)
    }
  }

  /** 在图上把选中的两篇连起来（落盘走 papers.update，和详情页面板是同一条路） */
  const saveLink = async (): Promise<void> => {
    const draft = linkDraft
    if (!draft) return
    setLinkSaving(true)
    try {
      const detail = await window.papervault.papers.get(draft.from)
      if (!detail) {
        useAppStore.getState().toast('这篇论文已经不在了。', 'error')
        return
      }
      const note = draft.note.trim()
      const links = normalizeLinks(
        [
          ...(detail.meta.links ?? []),
          {
            to: draft.to,
            type: draft.type,
            by: 'user' as const,
            at: new Date().toISOString(),
            ...(note ? { note } : {})
          }
        ],
        draft.from
      )
      const saved = await useAppStore.getState().savePaper({
        id: draft.from,
        // 只提交 links：meta 是增量语义，没传的字段沿用库里原值
        meta: { links },
        sections: detail.sections
      })
      if (!saved) return
      setLinkDraft(null)
      // 重新构图，新边立刻出现在画布上
      await load()
      useAppStore.getState().toast('已建立关系', 'success')
    } catch (err) {
      useAppStore.getState().toast(`建立关系失败：${errorMessage(err)}`, 'error')
    } finally {
      setLinkSaving(false)
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1">
      {/* 左：筛选 */}
      <aside
        style={{ width: graphLeftWidth }}
        className="flex h-full shrink-0 flex-col border-r border-line bg-bg-base"
      >
        <div className="shrink-0 px-3 pb-2 pt-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-ink-high">知识图谱</h2>
            <IconButton title="重新构图" onClick={() => void load()}>
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </IconButton>
          </div>
          <p className="mt-1 text-[10.5px] leading-relaxed text-ink-low">
            {entityLayer ? (
              <>
                {data.stats.papers}/{data.stats.totalPapers} 篇有图谱数据 ·{' '}
                {data.stats.entities} 个实体 · {data.stats.relations} 条关系
                {/* 叠加上来的论文关系单独报一次，否则用户会以为自己的关系丢了 */}
                {data.stats.links ? ` · ${data.stats.links} 条论文关系` : ''}
              </>
            ) : (
              <>
                {data.stats.papers} 篇论文 · {data.stats.relations} 条关系
                {/* 被分类筛选挡住的关系要说出来，否则空画布看不出是「没连过」还是「被筛掉」 */}
                {data.stats.links > data.stats.relations
                  ? `（库里共 ${data.stats.links} 条，其余在当前分类之外）`
                  : ''}
              </>
            )}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          {viewMode === 'graph' ? (
            <>
              <Section title="看哪一层">
                <div className="flex flex-wrap gap-1">
                  <button
                    onClick={() => setShowEntities(false)}
                    className={cn(
                      'chip transition',
                      showEntities
                        ? 'text-ink-low hover:border-strong'
                        : 'border-brand/40 bg-brand/[0.10] text-ink-high'
                    )}
                  >
                    论文关系
                  </button>
                  <button
                    onClick={() => setShowEntities(true)}
                    className={cn(
                      'chip transition',
                      showEntities
                        ? 'border-brand/40 bg-brand/[0.10] text-ink-high'
                        : 'text-ink-low hover:border-strong'
                    )}
                  >
                    叠加技术要素
                  </button>
                </div>
                <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-low">
                  {showEntities
                    ? '在论文关系之上再叠一层从原文抽出的实体，用来追问「这两篇凭什么被判定相关」。'
                    : '只画论文和你建立的关系：节点是论文，箭头是「谁基于谁 / 谁和谁冲突」。要连新的关系，去论文详情页的「关联论文」。'}
                </p>
              </Section>

              {showEntities ? (
                <Section title="粒度">
                  <label className="flex items-center gap-2 text-[11.5px] text-ink-mid">
                    <input
                      type="checkbox"
                      checked={includePapers}
                      onChange={(e) => setIncludePapers(e.target.checked)}
                      className="accent-[#74AC8F]"
                    />
                    显示论文节点
                  </label>
                  <div className="mt-2">
                    <div className="mb-1 flex items-center justify-between text-[11px] text-ink-low">
                      <span>实体最少出现于</span>
                      <span className="text-ink-mid">{minPapers} 篇论文</span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={6}
                      step={1}
                      value={minPapers}
                      onChange={(e) => setMinPapers(Number(e.target.value))}
                      className="w-full accent-[#74AC8F]"
                    />
                    {minPapers === 1 && data.stats.singletons > 0 ? (
                      <div className="mt-1.5 rounded-lg border border-warn/30 bg-warn/[0.07] px-2 py-1.5">
                        <p className="text-[10px] leading-relaxed text-warn">
                          画面里 {data.stats.singletons} 个实体只被 1 篇论文提到，它们各连各的 ——
                          这是图变乱的主要原因。
                        </p>
                        <button
                          onClick={() => setMinPapers(2)}
                          className="mt-1 rounded border border-warn/40 px-1.5 py-0.5 text-[10px] text-warn transition hover:bg-warn/[0.12]"
                        >
                          只看骨架（跨 ≥2 篇）
                        </button>
                      </div>
                    ) : null}
                    {minPapers > 1 ? (
                      <div className="mt-1.5">
                        <p className="text-[10px] leading-relaxed text-ink-low">
                          只画跨 ≥{minPapers} 篇论文的实体（{data.stats.entities} 个），已隐藏{' '}
                          {data.stats.singletons} 个只被 1 篇提到的。
                        </p>
                        <button
                          onClick={() => setMinPapers(1)}
                          className="mt-1 text-[10px] text-ink-low underline decoration-dotted transition hover:text-ink-mid"
                        >
                          显示全部（会比较乱）
                        </button>
                      </div>
                    ) : null}
                  </div>
                </Section>
              ) : null}
            </>
          ) : (
            <Section title="粒度">
              <p className="text-[10.5px] leading-relaxed text-ink-low">
                概览始终按<span className="text-ink-mid">全量</span>统计，不受粒度筛选影响——
                排行榜和关联对要完整才有意义。想按粒度裁剪，切到「关系图」。
              </p>
            </Section>
          )}

          {presentKinds.length ? (
            <Section title="实体类型">
              <div className="flex flex-wrap gap-1">
                {presentKinds.map((kind) => {
                  const hidden = hiddenKinds.includes(kind)
                  return (
                    <button
                      key={kind}
                      onClick={() =>
                        setHiddenKinds((prev) =>
                          prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]
                        )
                      }
                      className={cn(
                        'chip transition',
                        hidden ? 'opacity-40 line-through' : 'text-ink-mid hover:border-strong'
                      )}
                      style={
                        hidden
                          ? undefined
                          : {
                              color: ENTITY_KIND_COLOR[kind],
                              borderColor: `${ENTITY_KIND_COLOR[kind]}66`,
                              background: `${ENTITY_KIND_COLOR[kind]}18`
                            }
                      }
                    >
                      {ENTITY_KIND_LABEL[kind]}
                    </button>
                  )
                })}
              </div>
            </Section>
          ) : null}

          <Section title="分类范围">
            <div className="flex flex-wrap gap-1">
              {[...new Set(papers.flatMap((p) => p.categories))].slice(0, 18).map((id) => {
                const active = categories.includes(id)
                return (
                  <Chip
                    key={id}
                    active={active}
                    onClick={() =>
                      setCategories((prev) =>
                        prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
                      )
                    }
                  >
                    {categoryLabel(id, settings.customCategories)}
                  </Chip>
                )
              })}
            </div>
            {categories.length ? (
              <button
                onClick={() => setCategories([])}
                className="mt-1.5 text-[10.5px] text-ink-low transition hover:text-ink-mid"
              >
                清空筛选
              </button>
            ) : null}
          </Section>
        </div>
      </aside>
      <Resizer id="graphLeft" />

      {/* 中：概览 / 关系图 */}
      <main className="flex h-full min-w-0 flex-1 flex-col bg-bg-base">
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-bg-base px-4 py-2">
          <SegButton
            active={viewMode === 'overview'}
            onClick={() => setViewMode('overview')}
            icon={<BarChart3 className="h-3.5 w-3.5" />}
          >
            概览
          </SegButton>
          <SegButton
            active={viewMode === 'graph'}
            onClick={() => setViewMode('graph')}
            icon={<Network className="h-3.5 w-3.5" />}
          >
            关系图
          </SegButton>
          <span className="ml-auto hidden truncate text-[10.5px] text-ink-low sm:block">
            {viewMode === 'overview'
              ? '排序表用来找规律，图用来查「这两篇为什么相关」'
              : entityLayer
                ? '滚轮缩放 · 拖拽平移 · 单击选中 · 双击论文节点打开'
                : '⌘ 点选多篇 → 组合分析 · ⌘ 从一个节点拖到另一个 → 连线 · 双击打开论文'}
          </span>
        </div>

        <div className="relative min-h-0 flex-1">
          {viewMode === 'overview' ? (
            loading && !data.nodes.length ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-brand-soft" />
              </div>
            ) : (
              <GraphOverview
                data={data}
                onSelectEntity={(id) => {
                  // 点排行榜里的实体 → 切到图里定位它，顺带把多跳面板打开
                  setSelectedId(id)
                  setViewMode('graph')
                }}
                onOpenPaper={openPaper}
              />
            )
          ) : (
            <>
              <div className="pointer-events-none absolute left-4 top-4 z-10">
                <div className="pointer-events-auto rounded-lg border border-line bg-bg-base/85 px-3 py-2 backdrop-blur">
                  <GraphLegend
                    kinds={presentKinds.map((k) => ({ kind: k, label: ENTITY_KIND_LABEL[k] }))}
                    links={presentLinkTypes.map((t) => ({ type: t, label: LINK_TYPE_LABEL[t] }))}
                  />
                </div>
              </div>

              {/* 组合条：只在 ⌘/Shift 多选之后出现，不占用平时的画布 */}
              {comboIds.length ? (
                <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
                  <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-line bg-bg-base/95 px-3 py-2 shadow-xl">
                    <span className="text-[11.5px] font-medium text-ink-high">
                      已选 {comboIds.length} 篇
                    </span>
                    <span className="max-w-[260px] truncate text-[10.5px] text-ink-low">
                      {comboIds.map((id) => titleOfPaper(id)).join('、')}
                    </span>
                    {comboIds.length === 2 ? (
                      <Button
                        size="xs"
                        variant="outline"
                        icon={<Link2 className="h-3 w-3" />}
                        disabled={comboRunning}
                        onClick={() =>
                          setLinkDraft({ from: comboIds[0], to: comboIds[1], type: 'related', note: '' })
                        }
                      >
                        连起来
                      </Button>
                    ) : null}
                    {comboIds.length >= 2 ? (
                      <Button
                        size="xs"
                        variant="primary"
                        icon={<Combine className="h-3 w-3" />}
                        loading={comboRunning}
                        onClick={() => void runCombo()}
                      >
                        组合分析
                      </Button>
                    ) : (
                      <span className="text-[10.5px] text-ink-low">再 ⌘ 点一篇</span>
                    )}
                    <button
                      onClick={() => setComboIds([])}
                      title="清空选择"
                      className="rounded p-0.5 text-ink-low transition hover:text-ink-high"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ) : null}

              {/* 「连起来」：在图上直接把两篇建立关系，落盘走 papers.update（和详情页面板同一条路） */}
              {linkDraft ? (
                <Modal
                  open
                  onClose={() => setLinkDraft(null)}
                  title="把这两篇连起来"
                  subtitle="关系只存出边，反方向自动显示"
                  width="max-w-lg"
                  footer={
                    <>
                      <Button variant="ghost" onClick={() => setLinkDraft(null)}>
                        取消
                      </Button>
                      <Button variant="primary" loading={linkSaving} onClick={() => void saveLink()}>
                        建立关系
                      </Button>
                    </>
                  }
                >
                  <div className="space-y-3">
                    <p className="text-[12px] text-ink-mid">
                      <span className="text-ink-high">{titleOfPaper(linkDraft.from)}</span>
                      <span className="mx-1.5 text-ink-low">→</span>
                      <span className="text-ink-high">{titleOfPaper(linkDraft.to)}</span>
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {LINK_TYPES.map((t) => (
                        <button
                          key={t}
                          onClick={() => setLinkDraft({ ...linkDraft, type: t })}
                          title={LINK_TYPE_HINT[t]}
                          className={cn(
                            'chip transition',
                            linkDraft.type === t ? '' : 'text-ink-mid hover:border-strong'
                          )}
                          style={
                            linkDraft.type === t
                              ? {
                                  color: LINK_TYPE_COLOR[t],
                                  borderColor: `${LINK_TYPE_COLOR[t]}88`,
                                  background: `${LINK_TYPE_COLOR[t]}22`
                                }
                              : undefined
                          }
                        >
                          {LINK_TYPE_LABEL[t]}
                        </button>
                      ))}
                    </div>
                    <p className="text-[10.5px] leading-relaxed text-ink-low">
                      {LINK_TYPE_HINT[linkDraft.type]}
                    </p>
                    <input
                      value={linkDraft.note}
                      onChange={(e) => setLinkDraft({ ...linkDraft, note: e.target.value })}
                      placeholder="为什么认为它们有关（可留空，但写一句将来最有用）"
                      className="field"
                    />
                    <button
                      onClick={() =>
                        setLinkDraft({ ...linkDraft, from: linkDraft.to, to: linkDraft.from })
                      }
                      className="text-[10.5px] text-ink-low underline decoration-dotted transition hover:text-ink-mid"
                    >
                      方向反了？交换两篇
                    </button>
                  </div>
                </Modal>
              ) : null}

              <div className="pointer-events-none absolute right-4 top-4 z-10 flex flex-col items-end gap-1.5">
                {truncated ? (
                  <div className="pointer-events-auto rounded-lg border border-warn/35 bg-warn/[0.10] px-3 py-1.5 text-[10.5px] text-warn backdrop-blur">
                    节点过多，已按枢纽优先只画 {MAX_NODES} 个
                  </div>
                ) : null}
                {selectedId ? (
                  <button
                    onClick={() => setSelectedId(null)}
                    className="pointer-events-auto flex items-center gap-1 rounded-lg border border-line bg-bg-base/85 px-2.5 py-1.5 text-[10.5px] text-ink-mid backdrop-blur transition hover:text-ink-high"
                  >
                    <X className="h-3 w-3" />
                    取消选中
                  </button>
                ) : null}
              </div>

              {loading && !visible.nodes.length ? (
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-brand-soft" />
                </div>
              ) : visible.nodes.length === 0 ? (
                <div className="flex h-full items-center justify-center px-8">
                  <EmptyState
                    icon={<Maximize2 className="h-8 w-8" />}
                    title={entityLayer ? '当前筛选下没有节点' : '还没有建立任何论文关系'}
                    description={
                      entityLayer
                        ? '试着调低「实体最少出现于」，或清空分类筛选。'
                        : data.stats.links > 0
                          ? `库里有 ${data.stats.links} 条关系，但都在当前分类之外 —— 清空分类筛选就能看到。`
                          : '打开任意一篇论文，在「关联论文」里连一条：基于/改进、对比/竞争、同一问题、可迁移、结论冲突。连好之后这里就是你的论文关系图。'
                    }
                  />
                </div>
              ) : (
                <GraphCanvas
                  nodes={visible.nodes}
                  edges={visible.edges}
                  highlightNodes={highlight.nodes}
                  highlightEdges={highlight.edges}
                  selectedId={selectedId}
                  onSelect={selectNode}
                  onLinkRequest={requestLink}
                  onOpenPaper={openPaper}
                />
              )}
            </>
          )}

          {/* 组合分析结果抽屉：就地读，不打断「继续调组合」这件事 */}
          {resultDoc ? (
            <div className="absolute inset-y-0 right-0 z-20 flex w-[420px] max-w-[70%] flex-col border-l border-line bg-bg-base shadow-2xl">
              <div className="flex shrink-0 items-start gap-2 border-b border-line px-4 py-3">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-[12.5px] font-medium text-ink-high">
                    {resultDoc.title}
                  </h3>
                  <p className="mt-0.5 text-[10.5px] text-ink-low">
                    组合分析结果 · 已存进知识库（syntheses/）
                  </p>
                </div>
                <Button size="xs" variant="outline" onClick={() => setView('synthesis')}>
                  去跨论文页
                </Button>
                <IconButton title="关闭" onClick={() => setResultDoc(null)}>
                  <X className="h-3.5 w-3.5" />
                </IconButton>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                <Markdown content={resultDoc.content} />
              </div>
            </div>
          ) : null}
        </div>
      </main>

      {/* 右：详情 + 多跳 —— 只在关系图下有意义（概览里没有「选中节点」这回事） */}
      {viewMode === 'graph' ? (
      <>
      <Resizer id="graphRight" />
      <aside
        style={{ width: graphRightWidth }}
        className="flex h-full shrink-0 flex-col border-l border-line bg-bg-base"
      >
        {!selected ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <Network className="h-7 w-7 text-ink-low" />
            <p className="text-[12px] font-medium text-ink-mid">点一个节点看看</p>
            <p className="text-[11px] leading-relaxed text-ink-low">
              {entityLayer
                ? '选中后这里会显示它关联的论文、以及从它出发 N 跳内能连到哪些论文——也就是「这些论文为什么相关」的答案。'
                : '选中一篇论文，这里会列出你连给它的每一条关系（箭头方向就是关系的方向），以及沿关系走 N 跳能摸到哪些论文。'}
            </p>
          </div>
        ) : (
          <>
            <div className="shrink-0 border-b border-line px-3.5 py-3">
              <div className="flex items-start gap-2">
                <span
                  className={cn(
                    'mt-1 shrink-0 rounded-full',
                    selected.kind === 'paper' ? 'h-3 w-3 border-2' : 'h-3 w-3'
                  )}
                  style={
                    selected.kind === 'paper'
                      ? { borderColor: nodeColor(selected) }
                      : { background: nodeColor(selected) }
                  }
                />
                <div className="min-w-0 flex-1">
                  <h3 className="break-words text-[12.5px] font-medium leading-snug text-ink-high">
                    {selected.name}
                  </h3>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Chip className="text-ink-low">
                      {selected.kind === 'paper'
                        ? '论文'
                        : ENTITY_KIND_LABEL[selected.kind as EntityKind]}
                    </Chip>
                    {selected.kind !== 'paper' ? (
                      <Chip className="text-ink-low">
                        {selected.paperCount} 篇论文提到
                      </Chip>
                    ) : selected.year ? (
                      <Chip className="text-ink-low">{selected.year}</Chip>
                    ) : null}
                  </div>
                </div>
                {selected.kind === 'paper' && selected.paperId ? (
                  <IconButton title="打开这篇论文" onClick={() => openPaper(selected.paperId!)}>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </IconButton>
                ) : null}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
              {/* 多跳 */}
              <div className="mb-3 rounded-xl border border-line bg-bg-raised p-3">
                <div className="flex items-center gap-2">
                  <Route className="h-3.5 w-3.5 shrink-0 text-brand-soft" />
                  <span className="text-[11.5px] font-medium text-ink-high">多跳检索</span>
                  {hopLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin text-ink-low" />
                  ) : null}
                  <span className="ml-auto text-[10.5px] text-ink-low">{hops} 跳内</span>
                </div>

                <input
                  type="range"
                  min={1}
                  max={4}
                  step={1}
                  value={hops}
                  onChange={(e) => setHops(Number(e.target.value))}
                  className="mt-2 w-full accent-[#74AC8F]"
                />

                {multiHop ? (
                  <p className="mt-1 text-[10.5px] leading-relaxed text-ink-low">
                    共命中 {multiHop.paths.length} 个节点，其中{' '}
                    <span className="text-ink-mid">
                      {multiHop.paths.filter((p) => p.paperId && p.paperId !== selected.paperId).length}
                    </span>{' '}
                    篇其他论文。点击可直接跳到那篇论文。
                  </p>
                ) : null}
              </div>

              {/* 可达论文 */}
              {multiHop && multiHop.paths.some((p) => p.paperId) ? (
                <div className="mb-3">
                  <SubTitle>可达的论文</SubTitle>
                  <div className="space-y-1">
                    {multiHop.paths
                      .filter((p) => p.paperId && p.paperId !== selected.paperId)
                      .slice(0, 14)
                      .map((path) => (
                        <PathRow
                          key={path.nodeId}
                          path={path}
                          active={focusedPath?.[focusedPath.length - 1] === path.nodeId}
                          onHover={(on) => setFocusedPath(on ? path.path : null)}
                          onOpen={() => path.paperId && openPaper(path.paperId)}
                        />
                      ))}
                  </div>
                </div>
              ) : null}

              {/* 直接邻居 */}
              <SubTitle>
                {selected.kind === 'paper' ? '涉及的实体' : '关联的论文'}
              </SubTitle>
              <RelationList
                nodeId={selected.id}
                data={visible}
                nodeMap={nodeMap}
                onSelect={setSelectedId}
                onOpenPaper={openPaper}
              />
            </div>
          </>
        )}
      </aside>
      </>
      ) : null}
    </div>
  )
}

/** 顶部视图切换按钮 */
function SegButton({
  active,
  onClick,
  icon,
  children
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11.5px] transition',
        active
          ? 'border-brand/45 bg-brand/[0.10] text-ink-high'
          : 'border-line text-ink-mid hover:border-strong hover:text-ink-high'
      )}
    >
      {icon}
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ */

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="mb-4">
      <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-ink-low">
        {title}
      </div>
      {children}
    </div>
  )
}

function SubTitle({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-ink-low">
      {children}
    </div>
  )
}

function PathRow({
  path,
  active,
  onHover,
  onOpen
}: {
  path: HopPath
  active: boolean
  onHover: (on: boolean) => void
  onOpen: () => void
}): JSX.Element {
  return (
    <button
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onClick={onOpen}
      className={cn(
        'w-full rounded-lg border px-2.5 py-2 text-left transition',
        active ? 'border-brand/50 bg-brand/[0.08]' : 'border-line hover:border-strong'
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="rounded px-1 py-0.5 font-mono text-[9.5px]"
          style={{
            background: 'rgba(56,189,248,0.14)',
            color: '#7DD3FC'
          }}
        >
          {path.hops} hop
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-high">{path.name}</span>
      </div>
      {path.via.length ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-ink-low">经由</span>
          {path.via.slice(0, 4).map((name) => (
            <span
              key={name}
              className="max-w-[110px] truncate rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-ink-mid"
            >
              {name}
            </span>
          ))}
          {path.via.length > 4 ? (
            <span className="text-[10px] text-ink-low">+{path.via.length - 4}</span>
          ) : null}
        </div>
      ) : null}
    </button>
  )
}

/** 选中节点的直接关联列表 */
function RelationList({
  nodeId,
  data,
  nodeMap,
  onSelect,
  onOpenPaper
}: {
  nodeId: string
  data: GraphData
  nodeMap: Map<string, GraphNode>
  onSelect: (id: string) => void
  onOpenPaper: (paperId: string) => void
}): JSX.Element {
  const groups = useMemo(() => {
    const out = new Map<
      string,
      { label: string; items: { node: GraphNode; note?: string; dir?: 'out' | 'in' }[] }
    >()
    for (const edge of data.edges) {
      if (edge.from !== nodeId && edge.to !== nodeId) continue
      const otherId = edge.from === nodeId ? edge.to : edge.from
      const other = nodeMap.get(otherId)
      if (!other) continue
      // key 带上层：两层即使撞上同一个 type 字面量也不该合成一组（标签不是一套词表）
      const key = `${edge.layer === 'paper' ? 'paper' : 'entity'}|${edge.type}`
      if (!out.has(key)) out.set(key, { label: edgeLabel(edge), items: [] })
      const group = out.get(key)!
      if (group.items.some((i) => i.node.id === otherId)) continue
      group.items.push({
        node: other,
        // 论文关系边附上你写的那句「为什么有关」，并标出方向：是这篇指向对方，还是反过来
        ...(edge.layer === 'paper'
          ? {
              note: edge.evidence,
              dir: edge.from === nodeId ? ('out' as const) : ('in' as const)
            }
          : {})
      })
    }
    return [...out.entries()].sort((a, b) => b[1].items.length - a[1].items.length)
  }, [data.edges, nodeMap, nodeId])

  if (!groups.length) {
    return <p className="text-[11px] text-ink-low">没有关联记录。</p>
  }

  return (
    <div className="space-y-2.5">
      {groups.map(([key, group]) => (
        <div key={key}>
          <div className="mb-1 flex items-center gap-1.5 text-[10.5px] text-ink-low">
            <span>{group.label}</span>
            <span className="text-[10px] opacity-70">{group.items.length}</span>
          </div>
          <div className="space-y-0.5">
            {group.items.slice(0, 16).map(({ node, note, dir }) => (
              <div key={node.id}>
                <div className="flex items-center gap-1.5">
                  {/* 论文关系是有方向的：「A 基于 B」和「B 基于 A」不是一件事 */}
                  {dir ? (
                    <span
                      title={dir === 'out' ? '你标的：这篇 → 对方' : '对方标的：对方 → 这篇'}
                      className="shrink-0 font-mono text-[10px] text-ink-low"
                    >
                      {dir === 'out' ? '→' : '←'}
                    </span>
                  ) : null}
                  <button
                    onClick={() => onSelect(node.id)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left transition hover:bg-white/[0.05]"
                  >
                    <span
                      className={cn('h-2 w-2 shrink-0 rounded-full', node.kind === 'paper' && 'border')}
                      style={
                        node.kind === 'paper'
                          ? { borderColor: nodeColor(node) }
                          : { background: nodeColor(node) }
                      }
                    />
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink-mid">
                      {node.name}
                    </span>
                  </button>
                  {node.kind === 'paper' && node.paperId ? (
                    <button
                      title="打开这篇论文"
                      onClick={() => onOpenPaper(node.paperId!)}
                      className="shrink-0 rounded p-1 text-ink-low transition hover:text-ink-high"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  ) : null}
                </div>
                {note ? (
                  <p className="mb-1 ml-2 border-l border-line pl-2 text-[10.5px] leading-relaxed text-ink-low">
                    {note}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
