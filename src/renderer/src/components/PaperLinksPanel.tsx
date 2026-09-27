import { useMemo, useState } from 'react'
import { Link2, Loader2, Plus, Trash2, Waypoints } from 'lucide-react'
import {
  LINK_TYPES,
  LINK_TYPE_COLOR,
  LINK_TYPE_HINT,
  LINK_TYPE_LABEL,
  linkKey,
  type PaperLink,
  type PaperLinkType
} from '@shared/links'
import type { PaperMeta, PaperSummary } from '@shared/types'
import { cn, errorMessage } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { Chip } from './ui'

/**
 * 「关联论文」编辑器：手工建立两篇论文之间的关系。
 *
 * 为什么值得手工做这件事：原来图谱里的关系都是抽取出来的，错了改不了、漏了补不上，
 * 于是那张图读起来「花里胡哨但没用」—— 因为里面没有你的判断。关系一旦由你自己连，
 * 它就成了后面组合研究想法的原料（谁的方法能搬到谁的场景、谁的结论和谁冲突）。
 *
 * 两个实现细节：
 *   - **只存出边，反方向现算**。一条关系在两边各存一份，迟早会漂移；
 *     反方向从 `papers`（列表载荷里已经有 links）里筛一遍就够了。
 *   - AI 提议默认**不算数**：`by: 'ai'` 的条目带「采纳」按钮，人点过才是你的关系。
 */
export function PaperLinksPanel({
  meta,
  papers,
  onChange
}: {
  /** 当前这篇（读 meta.links / meta.id） */
  meta: PaperMeta
  /** 库里的论文，用于挑目标、显示标题、现算反方向 */
  papers: PaperSummary[]
  /** 整份 links 交回去（走 patchMeta → 防抖保存） */
  onChange: (links: PaperLink[]) => void
}): JSX.Element {
  const selectPaper = useAppStore((s) => s.selectPaper)
  const [finding, setFinding] = useState(false)
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [type, setType] = useState<PaperLinkType>('related')
  const [note, setNote] = useState('')

  const links = meta.links ?? []
  const titleOf = (id: string): string => papers.find((p) => p.id === id)?.title ?? '（论文已被删除）'

  /** 反方向：库里其他论文指向这一篇的关系 */
  const inbound = useMemo(
    () =>
      papers.flatMap((paper) =>
        (paper.links ?? []).filter((link) => link.to === meta.id).map((link) => ({ from: paper, link }))
      ),
    [papers, meta.id]
  )

  /*
   * 候选：排除自己、排除已经连过的（同一对再连一次会被规整逻辑并掉，
   * 不如在这里就说清「已经连过了」），按标题 / 标签匹配。
   */
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return papers
      .filter((p) => p.id !== meta.id && !links.some((l) => l.to === p.id))
      .filter(
        (p) => p.title.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q))
      )
      .slice(0, 8)
  }, [papers, links, meta.id, query])

  const add = (to: string): void => {
    const trimmed = note.trim()
    onChange([
      ...links,
      { to, type, by: 'user', at: new Date().toISOString(), ...(trimmed ? { note: trimmed } : {}) }
    ])
    setQuery('')
    setNote('')
    setAdding(false)
  }

  const remove = (link: PaperLink): void =>
    onChange(links.filter((l) => linkKey(l) !== linkKey(link)))

  const accept = (link: PaperLink): void =>
    onChange(links.map((l) => (linkKey(l) === linkKey(link) ? { ...l, by: 'user' as const } : l)))

  /**
   * 让主进程逐对判断候选论文。
   *
   * 渲染层只负责发起与显示：候选怎么筛（数据）、判不判得成立（模型）、
   * 写下来的提议怎么合并（normalizeLinks，人手工优先）全在 main 侧。
   * 回包里的 `links` 是**落盘后的权威版本**，直接覆盖 draft 就行 ——
   * 在这边拼一遍迟早会和主进程的规整逻辑漂移。
   */
  const discover = async (): Promise<void> => {
    setFinding(true)
    useAppStore.getState().setBusy('正在逐对判断候选论文…')
    try {
      const res = await window.papervault.ai.discoverLinks(meta.id)
      if (res.links) onChange(res.links)
      useAppStore.getState().toast(res.message, res.ok ? 'success' : 'error')
    } catch (err) {
      useAppStore.getState().toast(`找关系失败：${errorMessage(err)}`, 'error')
    } finally {
      useAppStore.getState().setBusy(null)
      setFinding(false)
    }
  }

  return (
    <div className="mt-2.5 rounded-xl border border-line bg-bg-raised px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Link2 className="h-3.5 w-3.5 shrink-0 text-brand-soft" />
        <span className="text-[12px] font-medium text-ink-high">关联论文</span>
        <span className="text-[10.5px] text-ink-low">
          {links.length ? `${links.length} 条` : '还没连过'}
          {inbound.length ? ` · 被 ${inbound.length} 篇关联` : ''}
        </span>
        <button
          onClick={() => void discover()}
          disabled={finding}
          title="在本篇「共享具体技术要素」的候选论文里逐对判断，成立的写成待确认的提议"
          className={cn(
            'chip ml-auto border-dashed transition hover:border-strong hover:text-ink-mid',
            finding ? 'border-brand/40 text-brand-soft' : 'text-ink-low'
          )}
        >
          {finding ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <Waypoints className="h-2.5 w-2.5" />
          )}
          {finding ? '判断中…' : 'AI 找关系'}
        </button>
        <button
          onClick={() => setAdding((v) => !v)}
          className="chip border-dashed text-ink-low transition hover:border-strong hover:text-ink-mid"
        >
          <Plus className="h-2.5 w-2.5" />
          {adding ? '收起' : '加一条'}
        </button>
      </div>

      {adding ? (
        <div className="mt-2.5 space-y-2 rounded-lg border border-line bg-bg-base p-2.5">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜标题或标签，挑一篇…"
            className="field"
          />
          <div className="flex flex-wrap gap-1">
            {LINK_TYPES.map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                title={LINK_TYPE_HINT[t]}
                className={cn('chip transition', type === t ? '' : 'text-ink-mid hover:border-strong')}
                style={
                  type === t
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
          <p className="text-[10.5px] leading-relaxed text-ink-low">{LINK_TYPE_HINT[type]}</p>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="为什么认为它们有关（可留空，但写一句将来最有用）"
            className="field"
          />
          {query.trim() ? (
            candidates.length ? (
              <ul className="space-y-1">
                {candidates.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => add(p.id)}
                      className="w-full truncate rounded-lg border border-line px-2.5 py-1.5 text-left text-[11.5px] text-ink-mid transition hover:border-brand/50 hover:text-ink-high"
                    >
                      {p.title}
                      {p.year ? ` · ${p.year}` : ''}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[10.5px] text-ink-low">没找到可关联的论文（可能已经连过了）</p>
            )
          ) : null}
        </div>
      ) : null}

      {links.length ? (
        <ul className="mt-2 space-y-2">
          {links.map((link) => (
            <li key={linkKey(link)} className="flex items-start gap-2">
              <Chip color={LINK_TYPE_COLOR[link.type]} title={LINK_TYPE_HINT[link.type]}>
                {LINK_TYPE_LABEL[link.type]}
              </Chip>
              <div className="min-w-0 flex-1">
                <button
                  onClick={() => void selectPaper(link.to)}
                  className="block max-w-full truncate text-left text-[12px] text-ink-high transition hover:text-brand-mist hover:underline"
                >
                  {titleOf(link.to)}
                </button>
                {link.note ? (
                  <p className="text-[11px] leading-relaxed text-ink-low">{link.note}</p>
                ) : null}
                {link.by === 'ai' ? (
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-warn">
                    <Waypoints className="h-2.5 w-2.5 shrink-0" />
                    AI 提议，待你确认
                    {link.evidence ? <span className="text-ink-low">· {link.evidence}</span> : null}
                  </p>
                ) : link.evidence ? (
                  <p className="mt-0.5 text-[10px] leading-relaxed text-ink-low">
                    依据：{link.evidence}
                  </p>
                ) : null}
              </div>
              {link.by === 'ai' ? (
                <button
                  onClick={() => accept(link)}
                  title="确认这条关系，之后它就算你建立的"
                  className="shrink-0 rounded-md border border-ok/40 px-2 py-0.5 text-[10.5px] text-ok transition hover:bg-ok/10"
                >
                  采纳
                </button>
              ) : null}
              <button
                onClick={() => remove(link)}
                title="删除这条关系"
                className="shrink-0 text-ink-low transition hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {inbound.length ? (
        <div className="mt-2.5 border-t border-line pt-2">
          <p className="mb-1 text-[10.5px] text-ink-low">被以下论文关联（反方向，自动显示）</p>
          <ul className="space-y-1">
            {inbound.map(({ from, link }) => (
              <li key={`${from.id}|${linkKey(link)}`} className="flex items-center gap-2">
                <Chip color={LINK_TYPE_COLOR[link.type]}>{LINK_TYPE_LABEL[link.type]}</Chip>
                <button
                  onClick={() => void selectPaper(from.id)}
                  className="min-w-0 truncate text-[11.5px] text-ink-mid transition hover:text-ink-high hover:underline"
                >
                  {from.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
