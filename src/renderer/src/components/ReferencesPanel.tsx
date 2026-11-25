import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookMarked, Check, ChevronDown, ExternalLink, Plus, RefreshCw } from 'lucide-react'
import type { ReferenceList } from '@shared/references'
import { cn, errorMessage, formatDate } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { Button } from './ui'

type Filter = 'all' | 'in' | 'out'

const PAGE = 30

/**
 * 参考文献对照：这篇引用的论文里，哪些已经在库、哪些还没读过。
 * 没读的可以一键建成「待读」条目（只有书目信息，PDF 之后再补）。
 */
export function ReferencesPanel({
  paperId,
  hasSource
}: {
  paperId: string
  /** 没有原文就没法抽，按钮直接禁用 */
  hasSource: boolean
}): JSX.Element {
  const selectPaper = useAppStore((s) => s.selectPaper)
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<ReferenceList | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [adding, setAdding] = useState<number | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [limit, setLimit] = useState(PAGE)

  const load = useCallback(async () => {
    try {
      setList(await window.papervault.refs.get(paperId))
    } catch {
      setList(null)
    }
  }, [paperId])

  useEffect(() => {
    setOpen(false)
    setFilter('all')
    setLimit(PAGE)
    void load()
  }, [load])

  const extract = async (): Promise<void> => {
    setExtracting(true)
    useAppStore.getState().setBusy('正在整理参考文献…')
    try {
      const res = await window.papervault.refs.extract(paperId)
      useAppStore.getState().toast(res.message ?? '', res.ok ? 'success' : 'error')
      if (res.ok && res.list) {
        setList(res.list)
        setOpen(true)
      }
    } catch (err) {
      useAppStore.getState().toast(`抽取失败：${errorMessage(err)}`, 'error')
    } finally {
      useAppStore.getState().setBusy(null)
      setExtracting(false)
    }
  }

  const addToLibrary = async (index: number): Promise<void> => {
    setAdding(index)
    try {
      setList(await window.papervault.refs.addToLibrary(paperId, index))
      await useAppStore.getState().refreshAll()
      useAppStore.getState().toast('已加入待读', 'success')
    } catch (err) {
      useAppStore.getState().toast(`加入失败：${errorMessage(err)}`, 'error')
    } finally {
      setAdding(null)
    }
  }

  const indexed = useMemo(() => (list?.items ?? []).map((item, index) => ({ item, index })), [list])
  const inLibrary = indexed.filter(({ item }) => item.paperId).length
  const visible = indexed.filter(({ item }) =>
    filter === 'all' ? true : filter === 'in' ? !!item.paperId : !item.paperId
  )

  return (
    <section className="rounded-xl border border-line bg-bg-raised px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => list && setOpen((v) => !v)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 text-left',
            !list && 'cursor-default'
          )}
        >
          <BookMarked className="h-3.5 w-3.5 shrink-0 text-brand-soft" />
          <span className="text-meta font-medium text-ink-high">参考文献对照</span>
          <span className="truncate text-caption text-ink-low">
            {list
              ? `${list.items.length} 条 · ${inLibrary} 篇已在库 · ${list.items.length - inLibrary} 篇未入库`
              : '看看这篇引用的论文里，哪些你已经读过、哪些值得补'}
          </span>
          {list ? (
            <ChevronDown
              className={cn('h-3.5 w-3.5 shrink-0 text-ink-low transition', open && 'rotate-180')}
            />
          ) : null}
        </button>
        {list ? (
          <button
            onClick={() => void extract()}
            disabled={extracting}
            title={`上次抽取于 ${formatDate(list.extractedAt)}，重新抽取一次`}
            className="rounded p-1 text-ink-low transition hover:bg-white/[0.06] hover:text-ink-high disabled:opacity-40"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', extracting && 'animate-spin')} />
          </button>
        ) : (
          <Button
            size="xs"
            variant="subtle"
            loading={extracting}
            disabled={!hasSource}
            title={hasSource ? '一次模型调用，结果会缓存' : '没有原文，先导入 PDF'}
            onClick={() => void extract()}
          >
            抽取参考文献
          </Button>
        )}
      </div>

      {list && open ? (
        <div className="mt-3">
          <div className="mb-2 flex items-center gap-1">
            {(
              [
                ['all', `全部 ${list.items.length}`],
                ['out', `未入库 ${list.items.length - inLibrary}`],
                ['in', `已在库 ${inLibrary}`]
              ] as [Filter, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => {
                  setFilter(key)
                  setLimit(PAGE)
                }}
                className={cn(
                  'rounded-md px-2 py-0.5 text-caption transition',
                  filter === key
                    ? 'bg-white/[0.08] text-ink-high'
                    : 'text-ink-low hover:text-ink-high'
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <ul className="divide-y divide-line">
            {visible.slice(0, limit).map(({ item, index }) => (
              <li key={index} className="flex items-start gap-2.5 py-2">
                <span className="mt-[2px] w-6 shrink-0 text-right font-mono text-tiny text-ink-low">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-serif text-ui leading-snug text-ink-high">{item.title}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-caption text-ink-low">
                    {item.authors ? <span>{item.authors}</span> : null}
                    {item.year ? <span>· {item.year}</span> : null}
                    {item.arxivId ? (
                      <button
                        onClick={() =>
                          void window.papervault.app.openExternal(
                            `https://arxiv.org/abs/${item.arxivId}`
                          )
                        }
                        className="inline-flex items-center gap-0.5 text-brand-mist hover:underline"
                      >
                        · arXiv:{item.arxivId}
                        <ExternalLink className="h-2.5 w-2.5" />
                      </button>
                    ) : null}
                  </p>
                </div>
                {item.paperId ? (
                  <button
                    onClick={() => void selectPaper(item.paperId!)}
                    title="打开库里的这篇"
                    className="flex shrink-0 items-center gap-1 rounded-md border border-ok/30 px-1.5 py-0.5 text-caption text-ok transition hover:bg-ok/10"
                  >
                    <Check className="h-3 w-3" />
                    在库
                  </button>
                ) : (
                  <button
                    onClick={() => void addToLibrary(index)}
                    disabled={adding !== null}
                    title="建一条只有书目信息的待读条目，PDF 之后再补"
                    className="flex shrink-0 items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-caption text-ink-mid transition hover:border-strong hover:text-ink-high disabled:opacity-40"
                  >
                    <Plus className="h-3 w-3" />
                    {adding === index ? '加入中…' : '加入待读'}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {visible.length > limit ? (
            <button
              onClick={() => setLimit((n) => n + PAGE)}
              className="mt-1 w-full rounded-md py-1 text-caption text-ink-low transition hover:bg-white/[0.04] hover:text-ink-high"
            >
              再显示 {Math.min(PAGE, visible.length - limit)} 条（共 {visible.length}）
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
