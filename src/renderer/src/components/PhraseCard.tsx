import { Check, Copy } from 'lucide-react'
import type { PhraseEntry } from '@shared/phrases'
import { categoryColor, categoryLabel } from '@shared/taxonomy'
import type { TaxonomyNode } from '@shared/types'
import { cn } from '@/lib/utils'
import { Chip } from './ui'

/**
 * 句式库里的一张卡。
 *
 * 从 PhraseBankView 里原样抽出来的纯展示组件：零 store 依赖，
 * 所有交互走 props。抽出来是为了让它能同时用在「写作思路 · 句式库」
 * 分区和未来的其它位置（例如单篇拆解里推荐相关句式）。
 */
export function PhraseCard({
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
  /*
   * 中英混排时字号要分开：英文句子在 12.5px 下密度合适，
   * 中文说明用 13px 才不显得虚。按字母占比猜，比按字数猜稳。
   */
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
            picked ? 'border-brand bg-brand text-ink-high' : 'border-strong hover:border-brand'
          )}
        >
          {picked ? <Check className="h-2.5 w-2.5" /> : null}
        </button>

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'select-text leading-relaxed text-ink-high',
              isEnglish ? 'text-ui' : 'text-body'
            )}
          >
            {entry.text}
          </p>
          {entry.usage ? (
            <p className="mt-1 text-meta leading-relaxed text-ink-low">{entry.usage}</p>
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
          className="truncate text-caption text-ink-low transition hover:text-brand-mist"
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
