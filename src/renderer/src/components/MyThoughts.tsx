import { useState } from 'react'
import { ChevronDown, PenLine } from 'lucide-react'
import type { Highlight } from '@shared/highlights'
import { cn } from '@/lib/utils'

/** 默认只露出这么多条；写了想法的排在前面 */
const PREVIEW = 4

/**
 * 笔记页顶部的「我的划线与想法」：把 PDF 里自己划的线和写下的想法汇到一处。
 * AI 写的章节和自己的判断分开看——后者才是真正属于你的沉淀。
 */
export function MyThoughts({
  highlights,
  onOpen
}: {
  highlights: Highlight[]
  /** 跳到原文对应页 */
  onOpen: (page: number) => void
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const mine = highlights
    .filter((h) => !h.ai)
    .sort((a, b) => Number(!!b.note) - Number(!!a.note) || a.page - b.page)
  if (!mine.length) return null

  const withNote = mine.filter((h) => h.note).length
  const shown = expanded ? mine : mine.slice(0, PREVIEW)

  return (
    <section className="rounded-xl border border-line bg-bg-raised px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <PenLine className="h-3.5 w-3.5 text-brand-soft" />
        <h3 className="text-meta font-medium text-ink-high">我的划线与想法</h3>
        <span className="text-caption text-ink-low">
          {mine.length} 处划线 · {withNote} 条想法
        </span>
      </div>
      <ul className="space-y-1.5">
        {shown.map((h) => (
          <li key={h.id}>
            <button
              onClick={() => onOpen(h.page)}
              title="跳到原文这一页"
              className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/[0.04]"
            >
              <span className="mt-[2px] shrink-0 font-mono text-tiny text-ink-low">P{h.page}</span>
              <span className="min-w-0 flex-1">
                {h.note ? (
                  <span className="block text-ui leading-relaxed text-ink-high">{h.note}</span>
                ) : null}
                <span
                  className={cn(
                    'block border-l-2 pl-2 font-serif leading-relaxed',
                    h.note
                      ? 'mt-1 line-clamp-2 text-meta text-ink-low'
                      : 'line-clamp-3 text-ui text-ink-mid'
                  )}
                  style={{ borderColor: h.color }}
                >
                  {h.text}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {mine.length > PREVIEW ? (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 flex items-center gap-1 px-2 text-caption text-ink-low transition hover:text-ink-high"
        >
          {expanded ? '收起' : `展开全部 ${mine.length} 条`}
          <ChevronDown className={cn('h-3 w-3 transition', expanded && 'rotate-180')} />
        </button>
      ) : null}
      {!withNote ? (
        <p className="mt-2 px-2 text-caption text-ink-low">
          在原文里选中文字点「想法」，或在高亮列表里给某条补一句，会出现在这里。
        </p>
      ) : null}
    </section>
  )
}
