import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check,
  Copy,
  Download,
  Loader2,
  Quote,
  RefreshCw,
  Search
} from 'lucide-react'
import type { PhraseEntry } from '@shared/phrases'
import { categoryColor, categoryLabel } from '@shared/taxonomy'
import type { TaxonomyNode } from '@shared/types'
import { cn, downloadText } from '@/lib/utils'
import { Button, Chip, EmptyState, IconButton } from '@/components/ui'
import { useAppStore } from '@/store/useAppStore'

/** 分组展示顺序，把最常用的写作章节排前面 */
const GROUP_ORDER = [
  'Abstract',
  'Introduction',
  'Related Work',
  'Methodology',
  'Experiments',
  'Limitations',
  '原文摘录'
]

type SourceFilter = 'all' | 'writing' | 'excerpt'

/** 一条句式归到哪个分组 */
function groupOf(entry: PhraseEntry): string {
  if (entry.source === 'excerpt') return '原文摘录'
  return entry.section.replace(/^写作手法\s*·\s*/, '').trim() || entry.section
}

export function PhraseBankView(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const papers = useAppStore((s) => s.papers)
  const setView = useAppStore((s) => s.setView)
  const selectPaper = useAppStore((s) => s.selectPaper)

  const [entries, setEntries] = useState<PhraseEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [group, setGroup] = useState<string>('all')
  const [source, setSource] = useState<SourceFilter>('all')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setEntries(await window.papervault.phrases.list())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, papers.length])

  const groups = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of entries) {
      const g = groupOf(e)
      counts.set(g, (counts.get(g) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => {
      const ia = GROUP_ORDER.indexOf(a[0])
      const ib = GROUP_ORDER.indexOf(b[0])
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || b[1] - a[1]
    })
  }, [entries])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter((e) => {
      if (group !== 'all' && groupOf(e) !== group) return false
      if (source !== 'all' && e.source !== source) return false
      if (!q) return true
      return (
        e.text.toLowerCase().includes(q) ||
        e.paperTitle.toLowerCase().includes(q) ||
        e.label.toLowerCase().includes(q)
      )
    })
  }, [entries, group, source, query])

  const copy = async (text: string, id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1400)
    } catch {
      useAppStore.getState().toast('复制失败，请手动选中复制。', 'error')
    }
  }

  const togglePick = (id: string): void =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const copyPicked = async (): Promise<void> => {
    const chosen = filtered.filter((e) => picked.includes(e.id))
    if (!chosen.length) return
    await copy(chosen.map((e) => e.text).join('\n\n'), '__batch__')
    useAppStore.getState().toast(`已复制 ${chosen.length} 条句式`, 'success')
  }

  const exportMarkdown = (): void => {
    const chosen = picked.length ? filtered.filter((e) => picked.includes(e.id)) : filtered
    if (!chosen.length) return
    const byGroup = new Map<string, PhraseEntry[]>()
    for (const e of chosen) {
      const g = groupOf(e)
      if (!byGroup.has(g)) byGroup.set(g, [])
      byGroup.get(g)!.push(e)
    }
    const body = [...byGroup.entries()]
      .map(
        ([g, list]) =>
          `## ${g}\n\n${list
            .map((e) => `- ${e.text}\n  <sub>— ${e.paperTitle}${e.paperYear ? ` (${e.paperYear})` : ''}</sub>`)
            .join('\n')}`
      )
      .join('\n\n')
    downloadText(
      `句式库-${group === 'all' ? '全部' : group}.md`,
      `# 可复用句式库\n\n> 共 ${chosen.length} 条，导出时间 ${new Date().toLocaleString('zh-CN')}\n\n${body}\n`
    )
  }

  if (!loading && entries.length === 0) {
    return (
      <main className="flex h-full min-w-0 flex-1 items-center justify-center bg-bg-base">
        <EmptyState
          icon={<Quote className="h-10 w-10" />}
          title="句式库还是空的"
          description="句式来自两个地方：一是 AI 精读时填写的「亮点句式 / 可复用表达」小节，二是你在笔记里用引号摘录的英文原句。先精读一两篇论文，这里就会自动长出内容。"
          action={
            <Button
              variant="primary"
              size="md"
              onClick={() => setView('library')}
            >
              回到论文库
            </Button>
          }
        />
      </main>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-1">
      {/* 左侧分组 */}
      <section className="flex h-full w-[240px] shrink-0 flex-col border-r border-line bg-bg-base">
        <div className="shrink-0 px-3 pb-2 pt-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-ink-high">句式库</h2>
            <IconButton title="重新扫描" onClick={() => void load()}>
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </IconButton>
          </div>
          <p className="mt-1 text-[10.5px] leading-relaxed text-ink-low">
            从 {new Set(entries.map((e) => e.paperId)).size} 篇笔记里聚合出{' '}
            {entries.length} 条可复用表达
          </p>
        </div>

        <div className="px-2">
          <button
            onClick={() => setGroup('all')}
            className={cn(
              'mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] transition',
              group === 'all'
                ? 'bg-brand/15 font-medium text-brand-mist'
                : 'text-ink-mid hover:bg-white/[0.05] hover:text-ink-high'
            )}
          >
            全部
            <span className="ml-auto text-[10.5px] text-ink-low">{entries.length}</span>
          </button>
          {groups.map(([name, count]) => (
            <button
              key={name}
              onClick={() => setGroup(name)}
              className={cn(
                'mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition',
                group === name
                  ? 'bg-brand/15 font-medium text-brand-mist'
                  : 'text-ink-mid hover:bg-white/[0.05] hover:text-ink-high'
              )}
            >
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <span className="text-[10.5px] text-ink-low">{count}</span>
            </button>
          ))}
        </div>

        <div className="mt-3 px-3">
          <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-ink-low">
            来源
          </div>
          <div className="flex flex-wrap gap-1">
            {(
              [
                ['all', '全部'],
                ['writing', '写作拆解'],
                ['excerpt', '原文摘录']
              ] as [SourceFilter, string][]
            ).map(([key, label]) => (
              <Chip key={key} active={source === key} onClick={() => setSource(key)}>
                {label}
              </Chip>
            ))}
          </div>
        </div>
      </section>

      {/* 右侧列表 */}
      <main className="flex h-full min-w-0 flex-1 flex-col bg-bg-base">
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-low" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜句式内容、来源论文或标签…"
              className="field pl-8"
            />
          </div>
          <span className="shrink-0 text-[11px] text-ink-low">{filtered.length} 条</span>
          {picked.length ? (
            <Button
              variant="primary"
              size="sm"
              icon={copiedId === '__batch__' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              onClick={() => void copyPicked()}
            >
              复制已选 {picked.length} 条
            </Button>
          ) : null}
          <Button
            variant="subtle"
            size="sm"
            icon={<Download className="h-3.5 w-3.5" />}
            onClick={exportMarkdown}
            disabled={!filtered.length}
          >
            导出
          </Button>
          {picked.length ? (
            <Button variant="ghost" size="sm" onClick={() => setPicked([])}>
              清空选择
            </Button>
          ) : null}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mx-auto max-w-4xl space-y-2 pb-16">
            {loading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-brand-soft" />
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={<Search className="h-8 w-8" />}
                title="没有匹配的句式"
                description="换个关键词，或者切换左侧的分组与来源。"
              />
            ) : (
              filtered.map((entry) => (
                <PhraseCard
                  key={entry.id}
                  entry={entry}
                  group={groupOf(entry)}
                  picked={picked.includes(entry.id)}
                  copied={copiedId === entry.id}
                  onToggle={() => togglePick(entry.id)}
                  onCopy={() => void copy(entry.text, entry.id)}
                  onOpenPaper={() => {
                    setView('library')
                    void selectPaper(entry.paperId)
                  }}
                  customCategories={settings.customCategories}
                />
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

function PhraseCard({
  entry,
  group,
  picked,
  copied,
  onToggle,
  onCopy,
  onOpenPaper,
  customCategories
}: {
  entry: PhraseEntry
  group: string
  picked: boolean
  copied: boolean
  onToggle: () => void
  onCopy: () => void
  onOpenPaper: () => void
  customCategories: TaxonomyNode[]
}): JSX.Element {
  const isEnglish = (entry.text.match(/[A-Za-z]/g)?.length ?? 0) > entry.text.length * 0.5

  return (
    <article
      className={cn(
        'group rounded-xl border px-3.5 py-3 transition',
        picked ? 'border-brand/45 bg-brand/[0.07]' : 'border-line bg-bg-raised hover:border-strong'
      )}
    >
      <div className="flex items-start gap-3">
        <button
          onClick={onToggle}
          title={picked ? '取消选择' : '选中以便批量复制'}
          className={cn(
            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition',
            picked ? 'border-brand bg-brand text-[#EDEAE0]' : 'border-strong hover:border-brand'
          )}
        >
          {picked ? <Check className="h-2.5 w-2.5" /> : null}
        </button>

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'select-text leading-relaxed text-ink-high',
              isEnglish ? 'text-[12.5px]' : 'text-[13px]'
            )}
          >
            {entry.text}
          </p>
          {entry.usage ? (
            <p className="mt-1 text-[11px] leading-relaxed text-ink-low">{entry.usage}</p>
          ) : null}
        </div>

        <button
          onClick={onCopy}
          title="复制这条句式"
          className="mt-0.5 shrink-0 rounded-lg p-1 text-ink-low transition hover:bg-white/[0.08] hover:text-ink-high"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-7">
        {entry.source === 'curated' ? <Chip color="#4E9E8F">AI 精炼</Chip> : null}
        <Chip className="text-ink-low">{group}</Chip>
        {entry.source !== 'curated' ? <Chip className="text-ink-low">{entry.label}</Chip> : null}
        <button
          onClick={onOpenPaper}
          className="truncate text-[10.5px] text-ink-low transition hover:text-brand-mist"
          title={entry.paperTitle}
        >
          — {entry.paperTitle}
          {entry.paperYear ? ` (${entry.paperYear})` : ''}
        </button>
        {entry.categories.slice(0, 2).map((c) => (
          <Chip key={c} color={categoryColor(c, customCategories)}>
            {categoryLabel(c, customCategories)}
          </Chip>
        ))}
      </div>
    </article>
  )
}
