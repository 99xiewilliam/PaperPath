import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BookOpen,
  Boxes,
  FileText,
  Layers,
  Lightbulb,
  Loader2,
  PenLine,
  RefreshCw,
  Search,
  Sparkles,
  Target,
  Waypoints
} from 'lucide-react'
import {
  ADVANTAGE_LABEL,
  CITATION_ROLE_HINT,
  CITATION_ROLE_LABEL,
  NARRATIVE_HINT,
  NARRATIVE_LABEL,
  PATTERN_THRESHOLD,
  type AdvantageDimension,
  type CitedWork,
  type CitationRole,
  type WritingCard,
  type WritingLogic,
  type WritingOverview,
  type WritingPattern
} from '@shared/writing-logic'
import { cn, downloadText, errorMessage } from '@/lib/utils'
import { Button, Chip, EmptyState, IconButton } from '@/components/ui'
import { PhraseBankPanel } from '@/components/PhraseBankPanel'
import { usePhraseBank } from '@/lib/usePhraseBank'
import { useAppStore, type WritingTab } from '@/store/useAppStore'

/**
 * 「写作思路」：单篇逻辑卡与跨篇套路库的**同一个入口**。
 *
 * 为什么合成一个页面而不是各开一个：
 *   - 单篇卡是套路库的原料，套路库是单篇卡的横向视图 —— 两者共享同一份数据，
 *     分开放会让人以为它们是两个功能，而实际上「攒够几篇 → 自动聚出套路」
 *     是一条连续的路；
 *   - 之前的写作相关能力散在三个地方（详情页的写作手法章节、速览里的故事线、
 *     跨论文页的套路归纳），找的时候得先想「这件事归哪个页面管」。
 *
 * 页面里刻意不重复「写作手法」那几节散文：它们是给人读、可以手改的笔记，
 * 入口留在论文详情页。这里只做**只有这里才能做的事** —— 跨篇对齐与聚类。
 *
 * 句式库曾是独立页面，现在并成第三个分区：它回答的是同一条线上的问题
 * （「这一句别人怎么写的」），单独占一个顶级入口只会让导航变长。
 */

type Tab = WritingTab

/** 引用角色的配色：靶子偏红、垫脚石偏橙、共识偏青、威胁偏赭、工具偏蓝、背景灰 */
const ROLE_COLOR: Record<CitationRole, string> = {
  target: '#C06A5E',
  'stepping-stone': '#C9973F',
  consensus: '#5FA898',
  threat: '#B4735F',
  tool: '#7FA3C7',
  background: '#8D9199'
}

const ROLE_ORDER: CitationRole[] = [
  'target',
  'stepping-stone',
  'threat',
  'consensus',
  'tool',
  'background'
]

export function WritingView(): JSX.Element {
  const papers = useAppStore((s) => s.papers)
  const setView = useAppStore((s) => s.setView)

  const [overview, setOverview] = useState<WritingOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('single')
  const [activePaperId, setActivePaperId] = useState<string | null>(null)
  const [activePatternId, setActivePatternId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const data = await window.papervault.writing.overview()
      setOverview(data)
    } catch (err) {
      useAppStore.getState().toast(`读取写作逻辑失败：${errorMessage(err)}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /*
   * 消费一次性的跳转意图（详情页「写作拆解」→ 单篇、句式入口 → 句式分区）。
   *
   * 监听 intent 而不是只在挂载时读一次：用户可能已经在这个页面里，
   * 又从别处点了「查看句式库」—— 那时组件不会重新挂载，只在挂载时读会漏。
   * 取完立刻清空，否则下次从导航进来还会停在上次的分区。
   */
  const intent = useAppStore((s) => s.writingIntent)
  useEffect(() => {
    if (!intent) return
    setTab(intent.tab)
    if (intent.paperId) setActivePaperId(intent.paperId)
    useAppStore.getState().takeWritingIntent()
  }, [intent])

  /** 句式分区左栏的选中分组；'all' 表示不过滤 */
  const [phraseGroup, setPhraseGroup] = useState<string>('all')
  // 只有切到句式分区才拉数据，写作思路默认停在单篇
  const phraseBank = usePhraseBank(tab === 'phrases')

  const cards = overview?.cards ?? []
  const patterns = overview?.patterns ?? []

  /** 有卡的排在前面、完整的排前面：列表的第一屏应该全是能看的 */
  const sortedCards = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? cards.filter(
          (c) =>
            c.title.toLowerCase().includes(q) ||
            (c.logic?.storyline.oneliner ?? '').toLowerCase().includes(q)
        )
      : cards
    return [...filtered].sort((a, b) => {
      if (!!a.logic !== !!b.logic) return a.logic ? -1 : 1
      return b.completeness - a.completeness || a.title.localeCompare(b.title)
    })
  }, [cards, query])

  const activeCard = useMemo(
    () => sortedCards.find((c) => c.paperId === activePaperId) ?? sortedCards[0] ?? null,
    [sortedCards, activePaperId]
  )

  const activePattern = useMemo(
    () => patterns.find((p) => p.id === activePatternId) ?? patterns[0] ?? null,
    [patterns, activePatternId]
  )

  /** 论文 id → 卡片，套路详情里要按 id 取成员 */
  const cardOf = useMemo(() => new Map(cards.map((c) => [c.paperId, c])), [cards])

  const withCard = cards.filter((c) => c.logic).length

  const runLens = async (paperId: string): Promise<void> => {
    setBusyId(paperId)
    useAppStore.getState().setBusy('正在拆解这篇论文的写作逻辑…')
    try {
      const res = await window.papervault.ai.runLens(paperId, 'writingLogic')
      useAppStore.getState().toast(res.message, res.ok ? 'success' : 'error')
      await refresh()
    } catch (err) {
      useAppStore.getState().toast(`拆解失败：${errorMessage(err)}`, 'error')
    } finally {
      useAppStore.getState().setBusy(null)
      setBusyId(null)
    }
  }

  /**
   * 把一套打法导出成 Markdown。
   *
   * 之前这里是「生成套路手册」，调用跨论文那条 AI 链路、产物落进
   * `syntheses/` 再由跨论文页打开。跨论文整块下线后，那条链路和它的查看页
   * 都没了 —— 但「这几篇逻辑一样」这个结论本身仍然值得带走。
   *
   * 所以改成**纯本地导出**：不烧 token、不依赖任何 IPC，内容全部是页面上
   * 已经算好并展示过的东西（成员、共享的故事线、共性优势）。用户拿到 .md
   * 放进自己的写作模板里照着抄，比一份还要再打开一个页面的手册更直接。
   */
  const exportPattern = (pattern: WritingPattern): void => {
    const members = pattern.memberIds.map((id) => cardOf.get(id)).filter(Boolean) as WritingCard[]
    const lines: string[] = [
      `# ${NARRATIVE_LABEL[pattern.type]}套路（${members.length} 篇）`,
      '',
      `> ${NARRATIVE_HINT[pattern.type] ?? ''}`,
      `> 簇内平均相似度 ${pattern.cohesion.toFixed(2)}${pattern.cohesion < 0.7 ? '（较松，可能只是共享类型）' : ''}`,
      '',
      '## 成员',
      ...members.map((c) => `- ${c.title}（${c.year ?? '年份未知'}）`),
      ''
    ]

    const advantages = [
      ...members
        .flatMap((c) => c.logic?.advantages ?? [])
        .reduce(
          (map, a) => map.set(a.dimension, (map.get(a.dimension) ?? 0) + 1),
          new Map<AdvantageDimension, number>()
        )
        .entries()
    ]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])

    if (advantages.length) {
      lines.push(
        '## 共性优势',
        ...advantages.map(([dim, n]) => `- ${ADVANTAGE_LABEL[dim]}（${n} 篇）`),
        ''
      )
    }

    const oneliners = members.filter((c) => c.logic?.storyline.oneliner)
    if (oneliners.length) {
      lines.push('## 各篇主线')
      for (const c of oneliners) lines.push(`- **${c.title}**：${c.logic?.storyline.oneliner}`)
      lines.push('')
    }

    const safe = `${NARRATIVE_LABEL[pattern.type]}-${members.length}篇套路`.replace(
      /[\\/:*?"<>|]/g,
      '-'
    )
    downloadText(`${safe}.md`, lines.join('\n'))
    useAppStore.getState().toast('已导出为 Markdown', 'success')
  }

  return (
    <div className="flex h-full min-w-0 flex-1">
      {/* 左栏：三个分区各自的清单 */}
      <section className="flex h-full w-[300px] shrink-0 flex-col border-r border-line bg-bg-base">
        <div className="shrink-0 space-y-2 px-3 pb-2 pt-3">
          <div className="flex items-center justify-between">
            <h2 className="text-body font-semibold text-ink-high">写作思路</h2>
            <IconButton
              title={tab === 'phrases' ? '重新扫描句式' : '重新计算套路'}
              onClick={() => (tab === 'phrases' ? void phraseBank.reload() : void refresh())}
            >
              <RefreshCw
                className={cn(
                  'h-3.5 w-3.5',
                  (tab === 'phrases' ? phraseBank.loading : loading) && 'animate-spin'
                )}
              />
            </IconButton>
          </div>

          <div className="flex items-center gap-1">
            {(
              [
                ['single', '单篇拆解'],
                ['pattern', `套路库${patterns.length ? ` ${patterns.length}` : ''}`],
                ['phrases', '句式库']
              ] as [Tab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={cn(
                  'rounded-lg px-2.5 py-1 text-meta transition',
                  tab === key
                    ? 'bg-brand/20 font-medium text-brand-mist'
                    : 'text-ink-mid hover:bg-white/[0.05] hover:text-ink-high'
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'single' ? (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-low" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜论文标题 / 故事线"
                className="h-7 w-full rounded-lg border border-line bg-bg-base pl-8 pr-2 text-meta text-ink-high outline-none placeholder:text-ink-low focus:border-brand/50"
              />
            </div>
          ) : tab === 'pattern' ? (
            <p className="px-0.5 text-caption leading-relaxed text-ink-low">
              相似度 ≥ {PATTERN_THRESHOLD} 的论文自动归为一套打法
            </p>
          ) : (
            <p className="px-0.5 text-caption leading-relaxed text-ink-low">
              从 {new Set(phraseBank.entries.map((e) => e.paperId)).size} 篇笔记里聚合出{' '}
              {phraseBank.entries.length} 条可复用表达
            </p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {tab === 'single' ? (
            sortedCards.map((card) => (
              <CardRow
                key={card.paperId}
                card={card}
                active={activeCard?.paperId === card.paperId}
                onClick={() => setActivePaperId(card.paperId)}
              />
            ))
          ) : tab === 'pattern' ? (
            patterns.map((pattern) => (
              <PatternRow
                key={pattern.id}
                pattern={pattern}
                titles={pattern.memberIds.map((id) => cardOf.get(id)?.title ?? id)}
                active={activePattern?.id === pattern.id}
                onClick={() => setActivePatternId(pattern.id)}
              />
            ))
          ) : (
            <>
              <GroupRow
                label="全部"
                count={phraseBank.entries.length}
                active={phraseGroup === 'all'}
                onClick={() => setPhraseGroup('all')}
              />
              {phraseBank.groups.map(([name, count]) => (
                <GroupRow
                  key={name}
                  label={name}
                  count={count}
                  active={phraseGroup === name}
                  onClick={() => setPhraseGroup(name)}
                />
              ))}
            </>
          )}

          {tab === 'single' && !loading && !sortedCards.length ? (
            <p className="px-3 py-6 text-center text-meta text-ink-low">库里还没有论文</p>
          ) : null}
          {tab === 'pattern' && !loading && !patterns.length ? (
            <p className="px-3 py-6 text-center text-meta leading-relaxed text-ink-low">
              还没有两篇逻辑相似的论文。
              <br />
              先给几篇建好写作逻辑卡，这里会自动聚出套路。
            </p>
          ) : null}
        </div>

        <div className="shrink-0 border-t border-line px-3 py-2 text-caption text-ink-low">
          {tab === 'phrases'
            ? `${phraseBank.entries.length} 条句式`
            : `${withCard}/${cards.length} 篇有逻辑卡`}
        </div>
      </section>

      {/* 右栏 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {tab === 'phrases' ? (
          <PhraseBankPanel
            entries={phraseBank.entries}
            loading={phraseBank.loading}
            group={phraseGroup}
            onOpenPaper={(id) => {
              void useAppStore.getState().selectPaper(id)
              setView('library')
            }}
            onGoLibrary={() => setView('library')}
          />
        ) : tab === 'single' ? (
          activeCard ? (
            <SinglePaperPanel
              card={activeCard}
              busy={busyId === activeCard.paperId}
              onRun={() => void runLens(activeCard.paperId)}
              onOpenPaper={() => {
                void useAppStore.getState().selectPaper(activeCard.paperId)
                setView('library')
              }}
              pattern={patterns.find((p) => p.memberIds.includes(activeCard.paperId)) ?? null}
              onOpenPattern={(id) => {
                setActivePatternId(id)
                setTab('pattern')
              }}
            />
          ) : (
            <EmptyState
              icon={<PenLine className="h-7 w-7" />}
              title="还没有写作逻辑卡"
              description="先在论文库里跑一次精读，再回到这里生成卡片 —— 它会告诉你这篇论文的论证是按什么顺序搭起来的。"
              action={<Button onClick={() => setView('library')}>去论文库</Button>}
            />
          )
        ) : activePattern ? (
          <PatternPanel
            pattern={activePattern}
            cards={activePattern.memberIds
              .map((id) => cardOf.get(id))
              .filter((c): c is WritingCard => !!c)}
            onExport={() => exportPattern(activePattern)}
            onOpenPaper={(id) => {
              setActivePaperId(id)
              setTab('single')
            }}
          />
        ) : (
          <EmptyState
            icon={<Boxes className="h-7 w-7" />}
            title="还没凑出套路"
            description={`当两篇论文的故事线类型、优势维度、引用结构相似度达到 ${PATTERN_THRESHOLD} 时会自动归为一套。单篇不构成套路，所以不会硬凑。`}
            action={<Button onClick={() => setTab('single')}>看单篇拆解</Button>}
          />
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  左栏条目                                                           */
/* ------------------------------------------------------------------ */

function CardRow({
  card,
  active,
  onClick
}: {
  card: WritingCard
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'mb-0.5 w-full rounded-lg px-2.5 py-2 text-left transition',
        active ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'
      )}
    >
      <div className="truncate text-ui text-ink-high">{card.title}</div>
      <div className="mt-0.5 flex items-center gap-1.5 text-caption text-ink-low">
        {card.logic ? (
          <>
            <span className="rounded bg-white/[0.06] px-1 py-px text-ink-mid">
              {NARRATIVE_LABEL[card.logic.storyline.type]}
            </span>
            <span>{card.logic.citedWorks.length} 条引用</span>
          </>
        ) : (
          <span className="text-ink-low">未建卡</span>
        )}
        {card.logic && card.completeness < 0.999 ? (
          <span className="text-warn">{Math.round(card.completeness * 100)}%</span>
        ) : null}
      </div>
    </button>
  )
}

function PatternRow({
  pattern,
  titles,
  active,
  onClick
}: {
  pattern: WritingPattern
  titles: string[]
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'mb-0.5 w-full rounded-lg px-2.5 py-2 text-left transition',
        active ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'
      )}
    >
      <div className="flex items-center gap-1.5">
        <Layers className="h-3 w-3 shrink-0 text-brand-soft" />
        <span className="truncate text-ui text-ink-high">
          {NARRATIVE_LABEL[pattern.type]} · {pattern.memberIds.length} 篇
        </span>
      </div>
      <div className="mt-0.5 truncate text-caption text-ink-low">{titles.join(' / ')}</div>
    </button>
  )
}

/** 句式分区的左栏条目：分组名 + 条数 */
function GroupRow({
  label,
  count,
  active,
  onClick
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ui transition',
        active
          ? 'bg-brand/15 font-medium text-brand-mist'
          : 'text-ink-mid hover:bg-white/[0.05] hover:text-ink-high'
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-caption text-ink-low">{count}</span>
    </button>
  )
}

/* ------------------------------------------------------------------ */
/*  单篇面板                                                           */
/* ------------------------------------------------------------------ */

function SinglePaperPanel({
  card,
  busy,
  onRun,
  onOpenPaper,
  pattern,
  onOpenPattern
}: {
  card: WritingCard
  busy: boolean
  onRun: () => void
  onOpenPaper: () => void
  pattern: WritingPattern | null
  /** 跳到这张卡所属的那套打法（不是跳去「跨论文」页 —— 那是生成手册之后的事） */
  onOpenPattern: (patternId: string) => void
}): JSX.Element {
  const logic = card.logic

  return (
    <>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-[14px] font-semibold text-ink-high">{card.title}</h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-meta text-ink-low">
            <span>{card.year ?? '年份未知'}</span>
            {logic ? (
              <>
                <span>·</span>
                <span className="text-brand-mist">{NARRATIVE_LABEL[logic.storyline.type]}</span>
                <span title={NARRATIVE_HINT[logic.storyline.type]}>
                  （{NARRATIVE_HINT[logic.storyline.type]}）
                </span>
              </>
            ) : null}
            {pattern ? (
              <>
                <span>·</span>
                <button
                  onClick={() => onOpenPattern(pattern.id)}
                  className="text-info hover:underline"
                >
                  属于一套 {pattern.memberIds.length} 篇的打法 →
                </button>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button icon={<BookOpen className="h-3.5 w-3.5" />} onClick={onOpenPaper}>
            打开笔记
          </Button>
          <Button
            variant="primary"
            icon={<Sparkles className="h-3.5 w-3.5" />}
            loading={busy}
            onClick={onRun}
          >
            {logic ? '重跑拆解' : '生成逻辑卡'}
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {logic ? (
          <div className="mx-auto max-w-4xl space-y-3">
            <StorylineBlock logic={logic} />

            {card.missing.length ? (
              <div className="rounded-xl border border-warn/30 bg-warn/[0.07] px-3.5 py-2.5 text-meta text-warn">
                这张卡还缺：{card.missing.join('、')}
                。原文里可能有，但这次没抽到 —— 可以重跑一次。
              </div>
            ) : null}

            <IntroBlock logic={logic} />
            <CitationsBlock works={logic.citedWorks} />
            <AdvantageBlock logic={logic} />
            <ContributionsBlock logic={logic} />
            <RelatedWorkBlock logic={logic} />
            <MethodBlock logic={logic} />
            {logic.phrases?.length ? <PhrasesBlock phrases={logic.phrases} /> : null}
          </div>
        ) : (
          <div className="mx-auto max-w-2xl rounded-xl border border-line bg-bg-raised p-6">
            <div className="flex items-center gap-2 text-body font-medium text-ink-high">
              <Lightbulb className="h-4 w-4 text-brand-soft" />
              还没有拆过这篇的写作逻辑
            </div>
            <p className="mt-2 text-ui leading-relaxed text-ink-mid">
              跑一次会得到：这篇论文的故事线属于哪种打法、Introduction 每一段在替读者解决什么疑问、
              它引了哪些工作以及每篇被引工作在论证里干什么活、这些引用反衬出它的哪个优势、
              贡献是怎么回扣缺口的、Related Work 按什么轴分类、方法按什么顺序被论证。
            </p>
            <p className="mt-2 text-meta leading-relaxed text-ink-low">
              只读开篇与方法章节，比整篇精读便宜。跑完会自动和其他论文比对，凑够两篇相似的就归成一套打法。
            </p>
            <Button
              variant="primary"
              className="mt-4"
              icon={<Sparkles className="h-3.5 w-3.5" />}
              loading={busy}
              onClick={onRun}
            >
              生成写作逻辑卡
            </Button>
          </div>
        )}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  卡片区块                                                           */
/* ------------------------------------------------------------------ */

function Block({
  icon,
  title,
  hint,
  children
}: {
  icon: React.ReactNode
  title: string
  hint?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="rounded-xl border border-line bg-bg-raised p-4">
      <div className="mb-2.5 flex items-baseline gap-2">
        <span className="text-brand-soft">{icon}</span>
        <h3 className="text-ui font-semibold text-ink-high">{title}</h3>
        {hint ? <span className="text-caption text-ink-low">{hint}</span> : null}
      </div>
      {children}
    </section>
  )
}

/** 一行「标签：值」，值可以为空（空就不显示这一行，避免整屏都是「原文未说明」） */
function Line({ label, value }: { label: string; value: string }): JSX.Element | null {
  if (!value?.trim()) return null
  return (
    <div className="flex gap-2 py-0.5 text-ui leading-relaxed">
      <span className="w-14 shrink-0 text-ink-low">{label}</span>
      <span className="min-w-0 flex-1 text-ink-mid">{value}</span>
    </div>
  )
}

function Quote({ text }: { text?: string }): JSX.Element | null {
  if (!text?.trim()) return null
  return (
    <blockquote className="mt-1 border-l-2 border-line pl-2 text-meta italic leading-relaxed text-ink-low">
      “{text}”
    </blockquote>
  )
}

function StorylineBlock({ logic }: { logic: WritingLogic }): JSX.Element {
  const s = logic.storyline
  return (
    <Block icon={<Waypoints className="h-3.5 w-3.5" />} title="故事线" hint="它按什么顺序让你相信">
      <p className="mb-2 rounded-lg bg-white/[0.03] px-2.5 py-2 text-ui leading-relaxed text-ink-high">
        {s.oneliner}
      </p>
      <Line label="痛点" value={s.pain} />
      <Line label="Gap" value={s.gap} />
      <Line label="核心洞察" value={s.insight} />
      <Line label="验证" value={s.validation} />
    </Block>
  )
}

function IntroBlock({ logic }: { logic: WritingLogic }): JSX.Element | null {
  const { paragraphs, gapTurn } = logic.intro
  if (!paragraphs.length && !gapTurn) return null
  return (
    <Block
      icon={<PenLine className="h-3.5 w-3.5" />}
      title="Introduction 逐段"
      hint="每段在回答读者的哪个疑问"
    >
      <div className="space-y-2">
        {paragraphs.map((p) => (
          <div key={p.n} className="rounded-lg border border-line/60 px-2.5 py-2">
            <div className="flex gap-2">
              <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded bg-white/[0.07] text-caption text-ink-mid">
                {p.n}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-ui leading-relaxed text-ink-high">{p.question}</div>
                <Quote text={p.quote} />
                {p.slot ? (
                  <div className="mt-1 text-meta text-ink-low">
                    我写时换成：<span className="text-ink-mid">{p.slot}</span>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
      {gapTurn ? (
        <div className="mt-2.5 rounded-lg border border-brand/25 bg-brand/[0.07] px-2.5 py-2">
          <div className="text-meta text-brand-mist">Gap 从这里转向</div>
          <Quote text={gapTurn} />
        </div>
      ) : null}
    </Block>
  )
}

/**
 * 引用功能表 —— 整个页面最核心的一块。
 *
 * 「它引了哪些工作、为什么引这些」如果只写成一段话，跨论文就没法比；
 * 拆成「角色 + 反衬的优势」两列之后，「这篇靠否定前人开局、那篇靠借用组件」
 * 这种差别才看得见。
 */
function CitationsBlock({ works }: { works: CitedWork[] }): JSX.Element | null {
  if (!works.length) return null
  return (
    <Block
      icon={<Target className="h-3.5 w-3.5" />}
      title="引用功能"
      hint="每篇被引工作在论证里干什么活"
    >
      <div className="space-y-1.5">
        {works.map((w, i) => (
          <div key={`${w.work}-${i}`} className="rounded-lg border border-line/60 px-2.5 py-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-ui text-ink-high">{w.work}</span>
              <span
                className="rounded px-1 py-px text-caption"
                style={{
                  color: ROLE_COLOR[w.role],
                  background: `${ROLE_COLOR[w.role]}1F`
                }}
                title={CITATION_ROLE_HINT[w.role]}
              >
                {CITATION_ROLE_LABEL[w.role]}
              </span>
              <span className="text-caption text-ink-low">{w.section}</span>
              {w.highlights.map((h) => (
                <span
                  key={h}
                  className="rounded border border-line px-1 py-px text-caption text-ink-mid"
                  title="这篇被引工作反衬出的优势"
                >
                  反衬：{ADVANTAGE_LABEL[h]}
                </span>
              ))}
            </div>
            <Quote text={w.quote} />
          </div>
        ))}
      </div>
    </Block>
  )
}

function AdvantageBlock({ logic }: { logic: WritingLogic }): JSX.Element | null {
  if (!logic.advantages.length) return null
  return (
    <Block
      icon={<Sparkles className="h-3.5 w-3.5" />}
      title="优势对齐"
      hint="它想凸显什么、靠什么撑住"
    >
      <div className="space-y-2">
        {logic.advantages.map((a, i) => (
          <div key={`${a.dimension}-${i}`} className="rounded-lg border border-line/60 px-2.5 py-2">
            <div className="text-caption text-brand-mist">{ADVANTAGE_LABEL[a.dimension]}</div>
            <div className="mt-0.5 text-ui leading-relaxed text-ink-high">{a.claim}</div>
            {a.support ? (
              <div className="mt-0.5 text-meta text-ink-low">支撑：{a.support}</div>
            ) : null}
          </div>
        ))}
      </div>
    </Block>
  )
}

const KIND_LABEL: Record<string, string> = {
  gap: '补缺口',
  mechanism: '给机制',
  evidence: '给证据'
}

function ContributionsBlock({ logic }: { logic: WritingLogic }): JSX.Element | null {
  const list = logic.intro.contributions
  if (!list.length) return null
  return (
    <Block
      icon={<Layers className="h-3.5 w-3.5" />}
      title="贡献段"
      hint="每条声称什么 → 回扣哪个缺口 → 由什么支撑"
    >
      <div className="space-y-1.5">
        {list.map((c, i) => (
          <div key={i} className="rounded-lg border border-line/60 px-2.5 py-2">
            <div className="flex items-start gap-1.5">
              <span className="mt-px rounded bg-white/[0.07] px-1 py-px text-caption text-ink-mid">
                {KIND_LABEL[c.kind] ?? c.kind}
              </span>
              <span className="min-w-0 flex-1 text-ui leading-relaxed text-ink-high">
                {c.claim}
              </span>
            </div>
            {c.backsGap ? (
              <div className="mt-1 text-meta text-ink-low">
                回扣缺口：<span className="text-ink-mid">{c.backsGap}</span>
              </div>
            ) : null}
            {c.support ? (
              <div className="text-meta text-ink-low">
                支撑：<span className="text-ink-mid">{c.support}</span>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </Block>
  )
}

function RelatedWorkBlock({ logic }: { logic: WritingLogic }): JSX.Element | null {
  const rw = logic.relatedWork
  if (!rw.groups.length && !rw.axis) return null
  return (
    <Block
      icon={<Layers className="h-3.5 w-3.5" />}
      title="Related Work"
      hint="按什么轴分、每类留下什么"
    >
      {rw.axis ? (
        <div className="mb-2 text-meta text-ink-mid">
          分类轴：<span className="text-ink-high">{rw.axis}</span>
        </div>
      ) : null}
      <div className="space-y-1.5">
        {rw.groups.map((g, i) => (
          <div key={i} className="rounded-lg border border-line/60 px-2.5 py-2">
            <div className="text-ui text-ink-high">{g.label}</div>
            {g.gist ? <div className="mt-0.5 text-meta text-ink-mid">{g.gist}</div> : null}
            {g.gap ? (
              <div className="mt-1 rounded bg-warn/[0.08] px-1.5 py-1 text-meta text-warn">
                留下的缺口：{g.gap}
              </div>
            ) : null}
            <Quote text={g.quote} />
          </div>
        ))}
      </div>
      {rw.positioning ? (
        <div className="mt-2 rounded-lg border border-brand/25 bg-brand/[0.07] px-2.5 py-2 text-meta leading-relaxed text-ink-mid">
          <span className="text-brand-mist">它把自己插在哪：</span>
          {rw.positioning}
        </div>
      ) : null}
    </Block>
  )
}

function MethodBlock({ logic }: { logic: WritingLogic }): JSX.Element | null {
  const m = logic.method
  if (!m.steps.length && !m.argument) return null
  return (
    <Block icon={<Waypoints className="h-3.5 w-3.5" />} title="方法论证链" hint="每一步要证明什么">
      <div className="space-y-1.5">
        {m.steps.map((s, i) => (
          <div key={i} className="flex gap-2 rounded-lg border border-line/60 px-2.5 py-1.5">
            <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded bg-white/[0.07] text-caption text-ink-mid">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-ui text-ink-high">{s.step}</div>
              {s.purpose ? <div className="text-meta text-ink-mid">证明：{s.purpose}</div> : null}
              {s.figure ? <div className="text-caption text-ink-low">{s.figure}</div> : null}
            </div>
          </div>
        ))}
      </div>
      {m.argument ? (
        <div className="mt-2 text-meta leading-relaxed text-ink-mid">
          <span className="text-ink-low">设计选择怎么被论证：</span>
          {m.argument}
        </div>
      ) : null}
    </Block>
  )
}

function PhrasesBlock({ phrases }: { phrases: string[] }): JSX.Element {
  return (
    <Block icon={<PenLine className="h-3.5 w-3.5" />} title="可复用短语">
      <div className="flex flex-wrap gap-1">
        {phrases.map((p, i) => (
          <span key={i} className="chip text-meta text-ink-mid">
            {p}
          </span>
        ))}
      </div>
    </Block>
  )
}

/* ------------------------------------------------------------------ */
/*  套路面板                                                           */
/* ------------------------------------------------------------------ */

/** 引用角色分布的横向堆叠条：一眼看出这套打法靠什么开局 */
function RoleBar({ cards }: { cards: WritingCard[] }): JSX.Element | null {
  const totals = new Map<CitationRole, number>()
  for (const c of cards) {
    for (const w of c.logic?.citedWorks ?? []) {
      totals.set(w.role, (totals.get(w.role) ?? 0) + 1)
    }
  }
  const sum = [...totals.values()].reduce((a, b) => a + b, 0)
  if (!sum) return null

  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.06]">
        {ROLE_ORDER.map((role) => {
          const n = totals.get(role) ?? 0
          if (!n) return null
          return (
            <div
              key={role}
              style={{
                width: `${(n / sum) * 100}%`,
                background: ROLE_COLOR[role]
              }}
              title={`${CITATION_ROLE_LABEL[role]} ${n} 条`}
            />
          )
        })}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-caption">
        {ROLE_ORDER.filter((r) => totals.get(r)).map((role) => (
          <span key={role} className="flex items-center gap-1 text-ink-low">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: ROLE_COLOR[role] }} />
            {CITATION_ROLE_LABEL[role]} {totals.get(role)}
          </span>
        ))}
      </div>
    </div>
  )
}

function PatternPanel({
  pattern,
  cards,
  onExport,
  onOpenPaper
}: {
  pattern: WritingPattern
  cards: WritingCard[]
  /** 纯本地导出成 Markdown（不再调模型，见主组件里的 exportPattern） */
  onExport: () => void
  onOpenPaper: (id: string) => void
}): JSX.Element {
  /**
   * 共性优势：成员里出现 2 次以上的维度。
   *
   * 只出现一次的不算共性 —— 那是某一篇的个别卖点。这个门槛和
   * `dominantAdvantages` 保持一致，否则页面上的「共性」和聚类用的信号会对不上。
   */
  const advantageCounts = useMemo(() => {
    const counts = new Map<AdvantageDimension, number>()
    for (const c of cards) {
      for (const a of c.logic?.advantages ?? []) {
        counts.set(a.dimension, (counts.get(a.dimension) ?? 0) + 1)
      }
    }
    return [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])
  }, [cards])

  return (
    <>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-[14px] font-semibold text-ink-high">
            <Layers className="h-4 w-4 text-brand-soft" />
            {NARRATIVE_LABEL[pattern.type]} · {pattern.memberIds.length} 篇
          </h1>
          <p className="mt-0.5 text-meta text-ink-low">
            {NARRATIVE_HINT[pattern.type]} · 簇内平均相似度 {pattern.cohesion.toFixed(2)}
            {pattern.cohesion < 0.7 ? '（较松，可能只是共享类型）' : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button icon={<FileText className="h-3.5 w-3.5" />} onClick={onExport}>
            导出为 Markdown
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto max-w-4xl space-y-3">
          <Block icon={<Target className="h-3.5 w-3.5" />} title="这套打法的骨架">
            <div className="space-y-2.5">
              <div>
                <div className="mb-1 text-meta text-ink-low">引用结构</div>
                <RoleBar cards={cards} />
              </div>
              <div>
                <div className="mb-1 text-meta text-ink-low">共同凸显的优势</div>
                {advantageCounts.length ? (
                  <div className="flex flex-wrap gap-1">
                    {advantageCounts.map(([dim, n]) => (
                      <Chip key={dim}>
                        {ADVANTAGE_LABEL[dim]}
                        <span className="opacity-70">
                          {n}/{cards.length}
                        </span>
                      </Chip>
                    ))}
                  </div>
                ) : (
                  <p className="text-meta text-ink-low">
                    没有两个以上成员共享的优势维度 —— 这一簇的共性只在故事线类型上。
                  </p>
                )}
              </div>
            </div>
          </Block>

          <section className="rounded-xl border border-line bg-bg-raised p-4">
            <h3 className="mb-2.5 text-ui font-semibold text-ink-high">成员对照</h3>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="text-caption uppercase tracking-wider text-ink-low">
                    <th className="py-1.5 pr-3 font-normal">论文</th>
                    <th className="py-1.5 pr-3 font-normal">故事线</th>
                    <th className="py-1.5 pr-3 font-normal">凸显的优势</th>
                    <th className="py-1.5 pr-3 font-normal">引用结构</th>
                  </tr>
                </thead>
                <tbody>
                  {cards.map((c) => {
                    const logic = c.logic
                    if (!logic) return null
                    const roles = new Map<CitationRole, number>()
                    for (const w of logic.citedWorks) {
                      roles.set(w.role, (roles.get(w.role) ?? 0) + 1)
                    }
                    const topRoles = [...roles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
                    return (
                      <tr key={c.paperId} className="border-t border-line/60 align-top">
                        <td className="py-2 pr-3">
                          <button
                            onClick={() => onOpenPaper(c.paperId)}
                            className="text-left text-ui text-ink-high hover:text-brand-mist hover:underline"
                          >
                            {c.title}
                          </button>
                          <div className="text-caption text-ink-low">{c.year ?? ''}</div>
                        </td>
                        <td className="py-2 pr-3 text-meta text-ink-mid">
                          {NARRATIVE_LABEL[logic.storyline.type]}
                        </td>
                        <td className="py-2 pr-3">
                          <div className="flex flex-wrap gap-1">
                            {logic.advantages.length ? (
                              logic.advantages.map((a) => (
                                <span
                                  key={a.dimension}
                                  className="rounded bg-white/[0.06] px-1 py-px text-caption text-ink-mid"
                                >
                                  {ADVANTAGE_LABEL[a.dimension]}
                                </span>
                              ))
                            ) : (
                              <span className="text-caption text-ink-low">未写</span>
                            )}
                          </div>
                        </td>
                        <td className="py-2 pr-3">
                          <div className="flex flex-wrap gap-1">
                            {topRoles.map(([role, n]) => (
                              <span
                                key={role}
                                className="rounded px-1 py-px text-caption"
                                style={{
                                  color: ROLE_COLOR[role],
                                  background: `${ROLE_COLOR[role]}1F`
                                }}
                              >
                                {CITATION_ROLE_LABEL[role]} {n}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <div className="rounded-xl border border-line bg-bg-raised p-4 text-meta leading-relaxed text-ink-mid">
            <div className="mb-1 flex items-center gap-1.5 text-ui font-medium text-ink-high">
              <Lightbulb className="h-3.5 w-3.5 text-brand-soft" />
              这套打法是什么
            </div>
            开局用「{NARRATIVE_LABEL[pattern.type]}
            」，把读者的共识建立在这一类缺口上；成员的引用结构相似，
            说明它们靠同一种方式把前人工作摆成对照。点右上角可以把这
            {pattern.memberIds.length} 篇的成员、共性优势与各篇主线导出成 Markdown，
            放进自己的写作模板里照着写。
          </div>
        </div>
      </div>
    </>
  )
}

/* 兜底：整页没有任何卡片时，右下角不该只剩一片空白 */
export function WritingViewFallback(): JSX.Element {
  return (
    <div className="flex h-full flex-1 items-center justify-center">
      <Loader2 className="h-4 w-4 animate-spin text-brand-soft" />
    </div>
  )
}
