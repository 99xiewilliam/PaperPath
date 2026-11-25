import { useMemo, useState } from 'react'
import { Check, Copy, Download, Loader2, Quote, Search } from 'lucide-react'
import { phraseBankGroupOf, type PhraseEntry } from '@shared/phrases'
import { cn, downloadText } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { Button, Chip, EmptyState } from './ui'
import { PhraseCard } from './PhraseCard'

type SourceFilter = 'all' | 'writing' | 'excerpt'

/**
 * 句式库的展示层（「写作思路 · 句式库」分区的右栏）。
 *
 * 与原来的独立页面相比，去掉的是「页面级外壳」：大标题、整页双栏布局、
 * 左栏分组列表 —— 那三样由写作思路页统一提供。留下来的是这个功能真正的
 * 内容：搜索、来源筛选、多选复制、Markdown 导出。
 *
 * 分组筛选（group）仍由外层持有：左栏就在外层，两栏共享同一个选中态，
 * 放在面板内部就得把左栏也搬进来，反而更绕。
 */
export function PhraseBankPanel({
  entries,
  loading,
  group,
  onOpenPaper,
  onGoLibrary
}: {
  entries: PhraseEntry[]
  loading: boolean
  /** 'all' 或某个分组名 */
  group: string
  onOpenPaper: (paperId: string) => void
  onGoLibrary: () => void
}): JSX.Element {
  const settings = useAppStore((s) => s.settings)

  const [source, setSource] = useState<SourceFilter>('all')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter((e) => {
      if (group !== 'all' && phraseBankGroupOf(e) !== group) return false
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

  /**
   * 导出 Markdown。
   *
   * 勾了就用勾的（那是用户明确挑过的），没勾就导当前筛选结果 ——
   * 与「复制已选」保持同一套语义，不然两处按钮的行为要各记一遍。
   */
  const exportMarkdown = (): void => {
    const chosen = picked.length ? filtered.filter((e) => picked.includes(e.id)) : filtered
    if (!chosen.length) return
    const byGroup = new Map<string, PhraseEntry[]>()
    for (const e of chosen) {
      const g = phraseBankGroupOf(e)
      if (!byGroup.has(g)) byGroup.set(g, [])
      byGroup.get(g)!.push(e)
    }
    const body = [...byGroup.entries()]
      .map(
        ([g, list]) =>
          `## ${g}\n\n${list
            .map(
              (e) =>
                `- ${e.text}\n  <sub>— ${e.paperTitle}${e.paperYear ? ` (${e.paperYear})` : ''}</sub>`
            )
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
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<Quote className="h-10 w-10" />}
          title="句式库还是空的"
          description="句式来自两个地方：一是 AI 精读时填写的「亮点句式 / 可复用表达」小节，二是你在笔记里用引号摘录的英文原句。先精读一两篇论文，这里就会自动长出内容。"
          action={
            <Button variant="primary" size="md" onClick={onGoLibrary}>
              回到论文库
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <>
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-low" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜句式内容、来源论文或标签…"
            className="field pl-8"
          />
        </div>

        {/* 来源筛选从原来的左栏搬到这里：左栏现在归三个分区共用 */}
        <div className="flex shrink-0 items-center gap-1">
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

        <span className="shrink-0 text-meta text-ink-low">{filtered.length} 条</span>

        {picked.length ? (
          <Button
            variant="primary"
            size="sm"
            icon={
              copiedId === '__batch__' ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )
            }
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
        <div className={cn('mx-auto max-w-4xl space-y-2 pb-16')}>
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-brand-soft" />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Search className="h-8 w-8" />}
              title="没有匹配的句式"
              description="换个关键词，或者切换左栏的分组与上方的来源。"
            />
          ) : (
            filtered.map((entry) => (
              <PhraseCard
                key={entry.id}
                entry={entry}
                group={phraseBankGroupOf(entry)}
                picked={picked.includes(entry.id)}
                copied={copiedId === entry.id}
                onToggle={() => togglePick(entry.id)}
                onCopy={() => void copy(entry.text, entry.id)}
                onOpenPaper={() => onOpenPaper(entry.paperId)}
                customCategories={settings.customCategories}
              />
            ))
          )}
        </div>
      </div>
    </>
  )
}
