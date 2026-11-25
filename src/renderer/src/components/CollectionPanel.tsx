import { useEffect, useMemo, useState } from 'react'
import { Layers, Pencil, Trash2, X } from 'lucide-react'
import { authorLine, cn, formatDate, truncate } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { ChatPanel } from './ChatPanel'
import { Markdown } from './Markdown'
import { ProblemPool } from './ProblemPool'
import { Button, EmptyState, IconButton, useConfirm } from './ui'

const COLLECTION_PRESETS = [
  '这几篇论文在研究问题上有什么共性，又有哪些分歧？',
  '方法上有没有一条可以串起来的演进线？各自解决了前人哪一块没做完的？',
  '局限和未解决问题能不能拼成一个值得做的新题目？',
  '实验设置横向对比：这类工作的「最低配置」是什么？',
  '如果要把它们写成一篇 related work，该怎么分组？'
]

/**
 * 专题面板：出现在右侧详情栏（没有打开某篇论文的时候）。
 *
 * 上半是这组论文的名单，下半直接把 ChatPanel 接到这组成员上 ——
 * 这就是「指定 agent 专门分析这一块」的入口。
 */
export function CollectionPanel({ collectionId }: { collectionId: string }): JSX.Element {
  const collection = useAppStore((s) => s.collections.find((c) => c.id === collectionId) ?? null)
  const papers = useAppStore((s) => s.papers)
  const selectPaper = useAppStore((s) => s.selectPaper)
  const updateCollection = useAppStore((s) => s.updateCollection)
  const deleteCollection = useAppStore((s) => s.deleteCollection)
  const removePapersFromCollection = useAppStore((s) => s.removePapersFromCollection)
  const { confirm, dialog } = useConfirm()

  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [notes, setNotes] = useState('')
  const [notesEditing, setNotesEditing] = useState(false)

  useEffect(() => {
    if (!collection) return
    setTitle(collection.title)
    setDescription(collection.description)
    setNotes(collection.notes)
    setEditing(false)
  }, [collection])

  const members = useMemo(() => {
    if (!collection) return []
    const map = new Map(papers.map((p) => [p.id, p]))
    return collection.paperIds
      .map((id) => map.get(id))
      .filter((p): p is NonNullable<typeof p> => !!p)
  }, [collection, papers])

  if (!collection) {
    return (
      <main className="flex h-full min-w-0 flex-1 items-center justify-center bg-bg-base">
        <EmptyState
          icon={<Layers className="h-10 w-10" />}
          title="专题不在了"
          description="可能刚被删掉。从左侧再挑一个，或新建一个。"
        />
      </main>
    )
  }

  const saveMeta = async (): Promise<void> => {
    const nextTitle = title.trim() || collection.title
    const nextDescription = description.trim()
    if (nextTitle === collection.title && nextDescription === collection.description) {
      setEditing(false)
      return
    }
    await updateCollection({
      id: collection.id,
      title: nextTitle,
      description: nextDescription
    })
    setEditing(false)
  }

  const saveNotes = async (): Promise<void> => {
    if (notes === collection.notes) return
    await updateCollection({ id: collection.id, notes })
  }

  const archiveAnswer = async (answer: string, question: string): Promise<void> => {
    const stamp = new Date().toLocaleDateString('zh-CN')
    const heading = `### ${question.trim().split('\n')[0] || 'AI 分析'}（${stamp}）`
    const next = [notes.trimEnd(), `${heading}\n\n${answer.trim()}`].filter(Boolean).join('\n\n')
    setNotes(next)
    setNotesEditing(false)
    await updateCollection({ id: collection.id, notes: next })
    useAppStore.getState().toast('已存到专题笔记', 'success')
  }

  const confirmDelete = async (): Promise<void> => {
    const ok = await confirm({
      title: `删除专题「${collection.title}」？`,
      description: '只删这个分组，里面的论文笔记都还在。',
      confirmLabel: '删除专题',
      danger: true
    })
    if (ok) await deleteCollection(collection.id)
  }

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-bg-base">
      <header className="shrink-0 border-b border-line px-6 py-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/15">
            <Layers className="h-4 w-4 text-brand-soft" />
          </div>
          <div className="min-w-0 flex-1">
            {editing ? (
              <div className="space-y-2">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveMeta()
                    if (e.key === 'Escape') setEditing(false)
                  }}
                  className="field text-[16px] font-medium"
                  autoFocus
                />
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveMeta()
                    if (e.key === 'Escape') setEditing(false)
                  }}
                  placeholder="一句话说明这组论文为什么放在一起"
                  className="field"
                />
                <div className="flex gap-1.5">
                  <Button size="xs" variant="primary" onClick={() => void saveMeta()}>
                    保存
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <h1 className="font-serif text-[18px] font-semibold leading-snug text-ink-high">
                  {collection.title}
                </h1>
                {collection.description ? (
                  <p className="mt-1 text-ui leading-relaxed text-ink-mid">
                    {collection.description}
                  </p>
                ) : (
                  <p className="mt-1 text-ui text-ink-low">
                    还没有说明。点编辑补一句，分析时会带给 agent。
                  </p>
                )}
                <p className="mt-1.5 text-meta text-ink-low">
                  {members.length} 篇 · 更新于 {formatDate(collection.updatedAt)}
                </p>
              </>
            )}
          </div>
          {!editing ? (
            <div className="flex shrink-0 items-center gap-0.5">
              <IconButton title="改名称 / 说明" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton title="删除专题" onClick={() => void confirmDelete()}>
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          ) : null}
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-5 pb-16">
        <section>
          <div className="mb-2 text-caption font-medium uppercase tracking-wider text-ink-low">
            成员
          </div>
          {members.length ? (
            <div className="space-y-1">
              {members.map((paper) => (
                <div
                  key={paper.id}
                  className="group flex items-start gap-2 rounded-lg border border-transparent px-2 py-1.5 transition hover:border-line hover:bg-white/[0.03]"
                >
                  <button
                    type="button"
                    onClick={() => void selectPaper(paper.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-body text-ink-high">{paper.title}</span>
                    <span className="block truncate text-meta text-ink-low">
                      {authorLine(paper.authors, 2)}
                      {paper.year ? ` · ${paper.year}` : ''}
                      {paper.tldr ? ` · ${truncate(paper.tldr, 48)}` : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    title="从专题移出（不删论文）"
                    onClick={() => void removePapersFromCollection(collection.id, [paper.id])}
                    className={cn(
                      'mt-0.5 shrink-0 rounded p-1 text-ink-low transition hover:text-warn',
                      'opacity-0 group-hover:opacity-100'
                    )}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-line px-3 py-3 text-ui leading-relaxed text-ink-mid">
              还没有论文。在左侧列表里勾选几篇，点底部的「加入专题」。
            </p>
          )}
        </section>

        {members.length >= 2 ? <ProblemPool scope={collection.id} /> : null}

        <section className="min-h-[420px]">
          <div className="mb-2 text-caption font-medium uppercase tracking-wider text-ink-low">
            分析这组论文
          </div>
          <ChatPanel
            paperIds={collection.paperIds}
            emptyHint="先往专题里加论文，才能基于这组笔记提问。"
            presets={COLLECTION_PRESETS}
            scope={{
              title: collection.title,
              description: collection.description,
              collectionId: collection.id
            }}
            onSaveAnswer={archiveAnswer}
            saveLabel="存到专题笔记"
          />
        </section>

        <section>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-caption font-medium uppercase tracking-wider text-ink-low">
              专题笔记
            </span>
            {notes.trim() ? (
              <button
                onClick={() => {
                  if (notesEditing) void saveNotes()
                  setNotesEditing((v) => !v)
                }}
                className="ml-auto rounded-md px-1.5 py-0.5 text-caption text-ink-low transition hover:bg-white/[0.06] hover:text-ink-high"
              >
                {notesEditing ? '完成' : '编辑'}
              </button>
            ) : null}
          </div>
          {notesEditing || !notes.trim() ? (
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => void saveNotes()}
              rows={6}
              autoFocus={notesEditing}
              placeholder="分析结论、待做的题目、还想补读的方向……失焦即保存。上面每条 AI 回答都可以「存到专题笔记」。"
              className="field min-h-[140px] resize-y"
            />
          ) : (
            <div
              onDoubleClick={() => setNotesEditing(true)}
              title="双击编辑"
              className="rounded-lg border border-line bg-bg-raised px-4 py-3"
            >
              <Markdown content={notes} />
            </div>
          )}
        </section>
      </div>

      {dialog}
    </main>
  )
}
