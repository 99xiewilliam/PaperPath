import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  FileDown,
  Images,
  Layers,
  Lightbulb,
  Loader2,
  Pencil,
  Search,
  FileText,
  PenLine,
  RotateCw,
  Trash2,
  FilePlus,
  X
} from 'lucide-react'
import { categoryColor, categoryLabel } from '@shared/taxonomy'
import type { PaperSummary, Synthesis, SynthesisScopeInput } from '@shared/types'
import { cn, downloadText, errorMessage, formatDate } from '@/lib/utils'
import { Markdown } from '@/components/Markdown'
import { FigureBoard } from '@/components/FigureBoard'
import { Button, Chip, EmptyState, Field, IconButton, Modal, useConfirm } from '@/components/ui'
import { useAppStore } from '@/store/useAppStore'

const FOCUS_OPTIONS = [
  '故事线与叙事骨架',
  'Abstract 写作手法',
  'Introduction 写作手法',
  'Related Work 写作手法',
  'Methodology 写作手法',
  'Experiments 写作手法',
  '实验方法论（指标 / 次数 / 开源还是闭源）'
]

type ScopeType = 'category' | 'tag' | 'papers'
/** 主内容区的两种视图：AI 产出的手册 / 这批论文截下来的原文图 */
type ContentTab = 'doc' | 'figures'

export function SynthesisView(): JSX.Element {
  const syntheses = useAppStore((s) => s.syntheses)
  const papers = useAppStore((s) => s.papers)
  const settings = useAppStore((s) => s.settings)
  const refreshSyntheses = useAppStore((s) => s.refreshSyntheses)

  const [activeId, setActiveId] = useState<string | null>(null)
  const [generatorOpen, setGeneratorOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [rerunning, setRerunning] = useState(false)
  const { confirm: askDelete, dialog: deleteDialog } = useConfirm()

  const [scopeType, setScopeType] = useState<ScopeType>('category')
  const [scopeValue, setScopeValue] = useState('')
  const [pickedPapers, setPickedPapers] = useState<string[]>([])
  const [focus, setFocus] = useState<string[]>(FOCUS_OPTIONS)
  const [paperQuery, setPaperQuery] = useState('')
  const [contentTab, setContentTab] = useState<ContentTab>('doc')

  const active = useMemo(
    () => syntheses.find((s) => s.id === activeId) ?? syntheses[0] ?? null,
    [syntheses, activeId]
  )

  /** 已确认的关系条数：研究想法只从这些组合，AI 提议要先采纳 */
  const confirmedLinks = useMemo(
    () => papers.reduce((n, p) => n + (p.links ?? []).filter((l) => l.by === 'user').length, 0),
    [papers]
  )

  /**
   * 归纳范围内论文的最新列表（对照区按它取图）。
   *
   * 生成归纳时 scope 里存过 paperIds 快照，优先用它 —— 对照区展示的应该是
   * AI 当时真正比过的那批论文，而不是「现在这个分类里有什么」；
   * 老记录没存 ids，就按 category / tag 现算，没有就空着。
   */
  const scopePapers = useMemo(() => {
    if (!active) return []
    const ids = active.scope.paperIds ?? []
    if (ids.length) {
      const byId = new Map(papers.map((p) => [p.id, p]))
      return ids.map((id) => byId.get(id)).filter((p): p is (typeof papers)[number] => p != null)
    }
    if (active.scope.type === 'category') {
      return papers.filter((p) => p.categories.includes(active.scope.value))
    }
    if (active.scope.type === 'tag') {
      return papers.filter((p) => p.tags.includes(active.scope.value))
    }
    return []
  }, [active, papers])

  useEffect(() => {
    if (active && !editing) setDraft(active.content)
  }, [active, editing])

  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of papers) for (const c of p.categories) counts.set(c, (counts.get(c) ?? 0) + 1)
    return [...counts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count)
  }, [papers])

  const tagOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of papers) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 40)
  }, [papers])

  const filteredPapers = useMemo(() => {
    const q = paperQuery.trim().toLowerCase()
    if (!q) return papers
    return papers.filter((p) => p.title.toLowerCase().includes(q) || p.tags.join(' ').includes(q))
  }, [papers, paperQuery])

  const resolvedCount = useMemo(() => {
    if (scopeType === 'category') return papers.filter((p) => p.categories.includes(scopeValue)).length
    if (scopeType === 'tag') return papers.filter((p) => p.tags.includes(scopeValue)).length
    return pickedPapers.length
  }, [scopeType, scopeValue, pickedPapers, papers])

  const runGenerate = async (): Promise<void> => {
    const input: SynthesisScopeInput = {
      type: scopeType,
      value: scopeType === 'papers' ? `选定的 ${pickedPapers.length} 篇` : scopeValue,
      paperIds: scopeType === 'papers' ? pickedPapers : undefined,
      focus
    }
    if (!input.value || resolvedCount < 2) {
      useAppStore.getState().toast('至少需要 2 篇论文，且要选择归纳范围。', 'error')
      return
    }
    setGenerating(true)
    useAppStore.getState().setBusy('正在横向比对这批论文…')
    try {
      const res = await window.papervault.ai.synthesize(input)
      if (res.ok && res.synthesisId) {
        await refreshSyntheses()
        setActiveId(res.synthesisId)
        setEditing(false)
        setGeneratorOpen(false)
        useAppStore.getState().toast(res.message, 'success')
      } else {
        useAppStore.getState().toast(res.message ?? '生成失败', 'error')
      }
    } catch (err) {
      useAppStore.getState().toast(`生成失败：${errorMessage(err)}`, 'error')
    } finally {
      useAppStore.getState().setBusy(null)
      setGenerating(false)
    }
  }

  /**
   * 原地重跑一份组合分析。
   *
   * 传 synthesisId 而不是新建：组合是拿来反复调的（换掉一篇、补一篇再跑），
   * 每次新建的话列表里会堆满半成品，也没法比较「改了什么之后结论变了」。
   */
  const rerunCombo = async (target: Synthesis, paperIds: string[], name: string): Promise<void> => {
    if (paperIds.length < 2) {
      useAppStore.getState().toast('组合至少要 2 篇论文。', 'error')
      return
    }
    setRerunning(true)
    useAppStore.getState().setBusy('正在重新分析这一组…')
    try {
      const res = await window.papervault.ai.comboAnalyze({
        paperIds,
        title: name,
        synthesisId: target.id
      })
      if (res.ok) {
        await refreshSyntheses()
        setEditing(false)
        useAppStore.getState().toast(res.message, 'success')
      } else {
        useAppStore.getState().toast(res.message ?? '分析失败', 'error')
      }
    } catch (err) {
      useAppStore.getState().toast(`分析失败：${errorMessage(err)}`, 'error')
    } finally {
      useAppStore.getState().setBusy(null)
      setRerunning(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!active) return
    setSaving(true)
    try {
      await window.papervault.synthesis.save(active.id, active.title, draft)
      await refreshSyntheses()
      setEditing(false)
      useAppStore.getState().toast('已保存', 'success')
    } catch (err) {
      useAppStore.getState().toast(`保存失败：${errorMessage(err)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (item: Synthesis): Promise<void> => {
    const ok = await askDelete({
      title: '删除这份归纳？',
      description: `《${item.title}》对应的 Markdown 文件也会被删除，此操作不可撤销。`,
      confirmLabel: '删除',
      danger: true
    })
    if (!ok) return
    try {
      await window.papervault.synthesis.remove(item.id)
      await refreshSyntheses()
      if (activeId === item.id) setActiveId(null)
      useAppStore.getState().toast('已删除', 'success')
    } catch (err) {
      useAppStore.getState().toast(`删除失败：${errorMessage(err)}`, 'error')
    }
  }

  /**
   * 从**已确认的**论文关系组合研究想法。
   *
   * 与「套路归纳」共用同一套存储（同一列表、同一编辑器、同一导出），
   * 区别只在 scope.type = 'links'：范围不由用户选，而由「你确认过哪些关系」决定；
   * 所以这里不需要范围表单，只发一个请求。
   */
  const runIdeas = async (): Promise<void> => {
    if (!confirmedLinks) {
      useAppStore
        .getState()
        .toast('还没有确认过的论文关系 —— 先去论文详情页的「关联论文」连几条。', 'error')
      return
    }
    setGenerating(true)
    useAppStore.getState().setBusy('正在把已确认的关系组合成研究题目…')
    try {
      const res = await window.papervault.ai.synthesizeIdeas()
      if (res.ok && res.synthesisId) {
        await refreshSyntheses()
        setActiveId(res.synthesisId)
        setEditing(false)
        useAppStore.getState().toast(res.message, 'success')
      } else {
        useAppStore.getState().toast(res.message ?? '生成失败', 'error')
      }
    } catch (err) {
      useAppStore.getState().toast(`生成失败：${errorMessage(err)}`, 'error')
    } finally {
      useAppStore.getState().setBusy(null)
      setGenerating(false)
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1">
      <section className="flex h-full w-[300px] shrink-0 flex-col border-r border-line bg-bg-base">
        <div className="shrink-0 space-y-2 px-3 pb-2 pt-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-ink-high">跨论文</h2>
            <span className="text-[11px] text-ink-low">{syntheses.length} 篇</span>
          </div>
          <Button
            variant="primary"
            size="md"
            className="w-full"
            icon={<FilePlus className="h-3.5 w-3.5" />}
            onClick={() => setGeneratorOpen(true)}
          >
            生成新的归纳
          </Button>
          <Button
            variant="ghost"
            size="md"
            className="w-full"
            icon={<Lightbulb className="h-3.5 w-3.5" />}
            loading={generating}
            disabled={!confirmedLinks}
            title={
              confirmedLinks
                ? '只吃你确认过的论文关系（AI 提议要先采纳）；每条都写明来源、依据、最小验证实验与反证条件'
                : '还没有确认过的论文关系 —— 先去论文详情页的「关联论文」连几条'
            }
            onClick={() => void runIdeas()}
          >
            从关系生成想法{confirmedLinks ? `（${confirmedLinks} 条）` : ''}
          </Button>
          <p className="text-[10.5px] leading-relaxed text-ink-low">
            这里放 AI 产出的跨论文文档，三种来源：<span className="text-ink-mid">套路归纳</span>
            （同类论文怎么写、怎么做实验）、<span className="text-ink-mid">研究想法</span>
            （从你确认过的关系里组合出题目）、<span className="text-ink-mid">组合分析</span>
            （一组论文里有没有组合创新的空间）。
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
          {syntheses.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11.5px] leading-relaxed text-ink-low">
              还没有归纳文档。
              <br />
              先攒 2 篇以上同类论文，然后点上面的按钮。
            </div>
          ) : (
            syntheses.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  setActiveId(item.id)
                  setEditing(false)
                }}
                className={cn(
                  'group flex w-full items-start gap-2 rounded-lg border px-3 py-2.5 text-left transition',
                  active?.id === item.id
                    ? 'border-brand/45 bg-brand/[0.09]'
                    : 'border-transparent hover:border-line hover:bg-white/[0.03]'
                )}
              >
                <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-soft" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-ink-high">
                    {item.title}
                  </span>
                  <span className="mt-0.5 block text-[10.5px] text-ink-low">
                    {/* 三种文档共用这一个列表，所以标出这是哪一种 */}
                    {item.scope.type === 'links'
                      ? '研究想法 · '
                      : item.scope.type === 'combo'
                        ? '组合分析 · '
                        : ''}
                    {item.paperCount} 篇 · {formatDate(item.updatedAt)}
                  </span>
                </span>
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    void remove(item)
                  }}
                  className="shrink-0 rounded p-0.5 text-ink-low opacity-0 transition hover:text-danger group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </span>
              </button>
            ))
          )}
        </div>
      </section>

      <main className="flex h-full min-w-0 flex-1 flex-col bg-bg-base">
        {!active ? (
          <EmptyState
            icon={<Layers className="h-10 w-10" />}
            title="还没有跨论文文档"
            description="三种方式可以生成：把同类论文（2 篇以上）横向比对成一份「怎么写这类论文」手册；从你确认过的论文关系里组合出可验证的研究题目；或者在关系图上挑 2-6 篇，看看它们之间有没有组合创新的空间。"
            action={
              <Button
                variant="primary"
                size="md"
                icon={<FilePlus className="h-3.5 w-3.5" />}
                onClick={() => setGeneratorOpen(true)}
              >
                生成第一份归纳
              </Button>
            }
          />
        ) : (
          <>
            <header className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <h2 className="truncate font-serif text-[15.5px] font-semibold text-ink-high">{active.title}</h2>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-low">
                  <span>{active.paperCount} 篇论文</span>
                  <span>·</span>
                  <span>更新于 {formatDate(active.updatedAt)}</span>
                  <Chip className="text-ink-low">
                    {active.scope.type === 'category'
                      ? categoryLabel(active.scope.value, settings.customCategories)
                      : active.scope.type === 'tag'
                        ? `#${active.scope.value}`
                        : active.scope.type === 'combo'
                          ? '组合分析'
                          : active.scope.type === 'links'
                            ? '研究想法'
                            : '自选论文'}
                  </Chip>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {editing ? (
                  <>
                    <Button variant="ghost" onClick={() => setEditing(false)}>
                      取消
                    </Button>
                    <Button
                      variant="primary"
                      loading={saving}
                      icon={<Check className="h-3.5 w-3.5" />}
                      onClick={() => void save()}
                    >
                      保存
                    </Button>
                  </>
                ) : (
                  <>
                    <IconButton
                      title="导出 Markdown"
                      onClick={() => downloadText(`${active.title}.md`, draft || active.content)}
                    >
                      <FileDown className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      title="编辑"
                      onClick={() => {
                        setDraft(active.content)
                        setEditing(true)
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                  </>
                )}
              </div>
            </header>

            {/* 组合类文档多一条工作台：改成员 / 改名 / 原地重跑 */}
            {active.scope.type === 'combo' ? (
              <ComboWorkbench
                key={active.id}
                synthesis={active}
                papers={papers}
                rerunning={rerunning}
                onRerun={(paperIds, name) => void rerunCombo(active, paperIds, name)}
              />
            ) : null}

            {/*
              两个视图共用一块内容区：AI 的手册说「这类论文该怎么写」，
              原文图对照区让你直接看「这些论文实际画了什么」—— 两边
              一切换就在一个视线里，这正是对照的意义。
            */}
            <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
              <div className="mb-3 flex shrink-0 items-center gap-1">
                {(
                  [
                    ['doc', 'AI 手册', FileText],
                    ['figures', '原文图表对照', Images]
                  ] as [ContentTab, string, typeof FileText][]
                ).map(([key, label, Icon]) => (
                  <button
                    key={key}
                    onClick={() => setContentTab(key)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] transition',
                      contentTab === key
                        ? 'bg-white/[0.08] font-medium text-ink-high'
                        : 'text-ink-mid hover:bg-white/[0.04] hover:text-ink-high'
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                ))}
                {contentTab === 'figures' ? (
                  <span className="ml-1 text-[10.5px] text-ink-low">
                    一篇论文一列，点击图可放大；去论文的「原文」页截取图表，这里就有了
                  </span>
                ) : null}
              </div>

              <div
                className={cn(
                  'min-h-0 flex-1',
                  contentTab === 'figures' ? 'overflow-x-auto' : 'overflow-y-auto'
                )}
              >
                {contentTab === 'figures' ? (
                  <div className="pb-4">
                    {scopePapers.length ? (
                      <FigureBoard papers={scopePapers} />
                    ) : (
                      <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[12px] leading-relaxed text-ink-low">
                        这份归纳没记录论文清单（可能是旧版本生成的），重新生成一次即可关联。
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="mx-auto max-w-3xl pb-16">
                    {editing ? (
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        spellCheck={false}
                        className="min-h-[60vh] w-full resize-none rounded-xl border border-line bg-bg-raised p-4 font-mono text-[12.5px] leading-relaxed text-ink-high outline-none focus:border-brand/50"
                      />
                    ) : (
                      <Markdown content={draft || active.content} />
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      <Modal
        open={generatorOpen}
        onClose={() => setGeneratorOpen(false)}
        title="生成套路归纳"
        subtitle="选一批论文，AI 会横向比对它们的写作手法与实验方法论，输出一份可复用的手册。"
        width="max-w-3xl"
        footer={
          <>
            <span className="mr-auto text-[11.5px] text-ink-low">
              当前范围命中 {resolvedCount} 篇{resolvedCount < 2 ? '（至少需要 2 篇）' : ''}
            </span>
            <Button variant="ghost" onClick={() => setGeneratorOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              loading={generating}
              disabled={resolvedCount < 2}
              icon={<PenLine className="h-3.5 w-3.5" />}
              onClick={() => void runGenerate()}
            >
              开始归纳
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex gap-1">
            {(
              [
                ['category', '按分类'],
                ['tag', '按标签'],
                ['papers', '自选论文']
              ] as [ScopeType, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => {
                  setScopeType(key)
                  setScopeValue('')
                }}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-[12px] transition',
                  scopeType === key
                    ? 'bg-brand/20 font-medium text-brand-mist'
                    : 'text-ink-mid hover:bg-white/[0.05] hover:text-ink-high'
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {scopeType === 'category' ? (
            categoryOptions.length ? (
              <Field label="选择分类" hint="只列出你已经有论文的分类">
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {categoryOptions.map(({ id, count }) => (
                    <Chip
                      key={id}
                      color={categoryColor(id, settings.customCategories)}
                      active={scopeValue === id}
                      onClick={() => setScopeValue(id)}
                    >
                      {categoryLabel(id, settings.customCategories)}
                      <span className="opacity-70">{count}</span>
                    </Chip>
                  ))}
                </div>
              </Field>
            ) : (
              <p className="text-[12px] text-ink-low">还没有任何论文被分类，先去给论文打上分类吧。</p>
            )
          ) : null}

          {scopeType === 'tag' ? (
            tagOptions.length ? (
              <Field label="选择标签">
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {tagOptions.map(({ tag, count }) => (
                    <Chip key={tag} active={scopeValue === tag} onClick={() => setScopeValue(tag)}>
                      #{tag}
                      <span className="opacity-70">{count}</span>
                    </Chip>
                  ))}
                </div>
              </Field>
            ) : (
              <p className="text-[12px] text-ink-low">还没有标签。</p>
            )
          ) : null}

          {scopeType === 'papers' ? (
            <Field label="勾选论文" hint={`已选 ${pickedPapers.length} 篇`}>
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-low" />
                <input
                  value={paperQuery}
                  onChange={(e) => setPaperQuery(e.target.value)}
                  placeholder="搜索标题或标签"
                  className="field pl-8"
                />
              </div>
              <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-line p-1.5">
                {filteredPapers.map((p) => {
                  const checked = pickedPapers.includes(p.id)
                  return (
                    <button
                      key={p.id}
                      onClick={() =>
                        setPickedPapers((prev) =>
                          checked ? prev.filter((x) => x !== p.id) : [...prev, p.id]
                        )
                      }
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition',
                        checked ? 'bg-brand/15 text-ink-high' : 'text-ink-mid hover:bg-white/[0.05]'
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                          checked ? 'border-brand bg-brand text-[#EDEAE0]' : 'border-strong'
                        )}
                      >
                        {checked ? <Check className="h-2.5 w-2.5" /> : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{p.title}</span>
                      <span className="shrink-0 text-[10px] text-ink-low">{p.year ?? ''}</span>
                    </button>
                  )
                })}
              </div>
            </Field>
          ) : null}

          <Field label="聚焦维度" hint="取消勾选可以缩小归纳范围">
            <div className="flex flex-wrap gap-1 pt-0.5">
              {FOCUS_OPTIONS.map((option) => (
                <Chip
                  key={option}
                  active={focus.includes(option)}
                  onClick={() =>
                    setFocus((prev) =>
                      prev.includes(option) ? prev.filter((f) => f !== option) : [...prev, option]
                    )
                  }
                >
                  {option}
                </Chip>
              ))}
            </div>
          </Field>

          {generating ? (
            <div className="flex items-center gap-2 rounded-lg border border-line bg-bg-raised px-3 py-2.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-soft" />
              <span className="text-[12px] text-ink-mid">
                正在读取 {resolvedCount} 篇笔记并横向比对，通常需要 30-90 秒…
              </span>
            </div>
          ) : null}
        </div>
      </Modal>

      {deleteDialog}
    </div>
  )
}

/* --------------------------------- 组合工作台 -------------------------------- */

/**
 * 组合工作台：改成员、改名、重跑。
 *
 * 成员与名称都是**本地草稿**，点「重新分析」时才提交 —— 一次组合分析就是一份文档，
 * 只改名单不重跑的话，文档会与它记录的成员对不上，下次从列表点进来还会以为分析过。
 * `key={synthesis.id}` 由调用方保证，所以切换文档时这里的状态一定是新的。
 */
function ComboWorkbench({
  synthesis,
  papers,
  rerunning,
  onRerun
}: {
  synthesis: Synthesis
  papers: PaperSummary[]
  rerunning: boolean
  onRerun: (paperIds: string[], name: string) => void
}): JSX.Element {
  const savedName = synthesis.scope.value === '组合分析' ? '' : synthesis.scope.value
  const [members, setMembers] = useState<string[]>(synthesis.scope.paperIds ?? [])
  const [name, setName] = useState(savedName)
  const [query, setQuery] = useState('')

  const titleOf = (id: string): string => papers.find((p) => p.id === id)?.title ?? '（论文已删除）'

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return papers
      .filter((p) => !members.includes(p.id))
      .filter(
        (p) => p.title.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q))
      )
      .slice(0, 6)
  }, [papers, members, query])

  const dirty =
    name !== savedName || members.join('|') !== (synthesis.scope.paperIds ?? []).join('|')

  return (
    <div className="shrink-0 border-b border-line bg-bg-base px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium text-ink-high">组合成员</span>
        <span className="text-[10.5px] text-ink-low">
          {members.length} 篇 · 上限 6 篇（再多模型只能「平均地看每一篇」）
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="给这个组合起个名字"
          className="field ml-auto w-[200px]"
        />
        <Button
          variant="primary"
          size="sm"
          icon={<RotateCw className="h-3.5 w-3.5" />}
          loading={rerunning}
          disabled={!dirty}
          title={
            dirty
              ? '按改动后的成员与名字重新分析（原地更新这份文档）'
              : '成员与名字都没变，不需要重跑'
          }
          onClick={() => onRerun(members, name)}
        >
          重新分析
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {members.map((id) => (
          <span key={id} className="chip flex items-center gap-1 text-ink-mid" title={titleOf(id)}>
            <span className="max-w-[220px] truncate">{titleOf(id)}</span>
            <button
              onClick={() => setMembers((prev) => prev.filter((x) => x !== id))}
              title="移出组合"
              className="text-ink-low transition hover:text-danger"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="+ 加一篇（搜标题或标签）"
          className="field w-[190px]"
        />
        {candidates.map((paper) => (
          <button
            key={paper.id}
            onClick={() => {
              setMembers((prev) => [...prev, paper.id])
              setQuery('')
            }}
            title={paper.title}
            className="chip max-w-[200px] truncate border-dashed text-ink-low transition hover:border-strong hover:text-ink-mid"
          >
            {paper.title}
          </button>
        ))}
      </div>

      {dirty ? (
        <p className="mt-1.5 text-[10.5px] text-warn">
          成员或名字改过了 —— 点「重新分析」才生效（这份文档的内容就是那次分析的结果）。
        </p>
      ) : null}
    </div>
  )
}
