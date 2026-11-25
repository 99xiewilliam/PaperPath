import { useEffect, useState } from 'react'
import { ChevronDown, FileText, Trash2 } from 'lucide-react'
import { IDEA_STATUS_LABEL, IDEA_STATUSES, type IdeaStatus, type ResearchIdea } from '@shared/ideas'
import { cn, formatDate } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { useConfirm } from './ui'

const STATUS_TONE: Record<IdeaStatus, string> = {
  new: 'border-line text-ink-mid',
  pursuing: 'border-ok/40 bg-ok/[0.08] text-ok',
  parked: 'border-warn/35 bg-warn/[0.08] text-warn',
  dropped: 'border-line text-ink-low line-through'
}

/**
 * 一个选题。折叠时只看标题和假设，展开看完整的实验设计、依据和自己的备注。
 * `showProblem` 用在选题本里：脱离了问题池，得告诉用户它是从哪个问题来的。
 */
export function IdeaCard({
  idea,
  showProblem = false
}: {
  idea: ResearchIdea
  showProblem?: boolean
}): JSX.Element {
  const papers = useAppStore((s) => s.papers)
  const setView = useAppStore((s) => s.setView)
  const selectPaper = useAppStore((s) => s.selectPaper)
  const updateIdea = useAppStore((s) => s.updateIdea)
  const deleteIdea = useAppStore((s) => s.deleteIdea)
  const { confirm, dialog } = useConfirm()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState(idea.note)

  useEffect(() => setNote(idea.note), [idea.note])

  const titleOf = (id: string): string => papers.find((p) => p.id === id)?.title ?? id

  const saveNote = (): void => {
    if (note.trim() !== idea.note) void updateIdea(idea.id, { note })
  }

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: `删除选题「${idea.title}」？`,
      description: '会删掉 ideas/ 下对应的 Markdown，连同你写的备注。',
      confirmLabel: '删除',
      danger: true
    })
    if (ok) await deleteIdea(idea.id)
  }

  return (
    <div className="rounded-lg border border-line bg-bg-raised px-3.5 py-3">
      {dialog}
      <div className="flex items-start gap-2.5">
        <button onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 text-left">
          <span
            className={cn(
              'block font-serif text-body font-medium leading-snug text-ink-high',
              idea.status === 'dropped' && 'text-ink-low'
            )}
          >
            {idea.title}
          </span>
          {showProblem ? (
            <span className="mt-0.5 block truncate text-caption text-ink-low">
              来自问题：{idea.problem}
            </span>
          ) : null}
          {open ? null : (
            <span className="mt-1 line-clamp-2 block text-ui leading-relaxed text-ink-mid">
              {idea.hypothesis}
            </span>
          )}
        </button>
        <select
          value={idea.status}
          onChange={(e) => void updateIdea(idea.id, { status: e.target.value as IdeaStatus })}
          className={cn(
            'h-6 shrink-0 rounded-md border bg-transparent pl-1.5 pr-5 text-caption outline-none',
            STATUS_TONE[idea.status]
          )}
          title="选题状态"
        >
          {IDEA_STATUSES.map((s) => (
            <option key={s} value={s}>
              {IDEA_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <button
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 shrink-0 text-ink-low hover:text-ink-high"
          title={open ? '收起' : '展开'}
        >
          <ChevronDown className={cn('h-3.5 w-3.5 transition', open && 'rotate-180')} />
        </button>
      </div>

      {open ? (
        <div className="mt-2.5 space-y-2.5">
          <IdeaField label="假设" text={idea.hypothesis} />
          <IdeaField label="怎么做" text={idea.approach} />
          <IdeaField label="最小验证实验" text={idea.experiment} />
          <IdeaField label="反证条件" text={idea.falsifier} tone="text-warn" />
          <IdeaField label="开工前还缺" text={idea.gaps} />

          {idea.paperIds.length ? (
            <div className="flex flex-wrap gap-1">
              {idea.paperIds.map((id) => (
                <button
                  key={id}
                  onClick={() => {
                    setView('library')
                    void selectPaper(id)
                  }}
                  className="chip max-w-full gap-1 text-ink-mid transition hover:border-strong hover:text-ink-high"
                  title="打开这篇论文"
                >
                  <FileText className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">{titleOf(id)}</span>
                </button>
              ))}
            </div>
          ) : null}

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={saveNote}
            rows={note ? 3 : 2}
            placeholder="我的备注：做到哪了、和导师聊的结论、为什么放弃…（离开输入框自动保存）"
            className="w-full resize-y rounded-lg border border-line bg-bg-base px-2.5 py-2 text-ui leading-relaxed text-ink-high outline-none placeholder:text-ink-low focus:border-brand/50"
          />

          <div className="flex items-center justify-between text-caption text-ink-low">
            <span>生成于 {formatDate(idea.createdAt)}</span>
            <button
              onClick={() => void remove()}
              className="flex items-center gap-1 hover:text-danger"
            >
              <Trash2 className="h-3 w-3" />
              删除
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function IdeaField({
  label,
  text,
  tone
}: {
  label: string
  text: string
  tone?: string
}): JSX.Element | null {
  if (!text) return null
  return (
    <div>
      <div className={cn('mb-0.5 text-caption font-medium text-ink-low', tone)}>{label}</div>
      <p className="whitespace-pre-wrap text-ui leading-relaxed text-ink-mid">{text}</p>
    </div>
  )
}
