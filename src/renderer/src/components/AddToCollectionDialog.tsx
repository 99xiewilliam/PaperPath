import { useEffect, useMemo, useState } from 'react'
import { Layers, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { Button, Field, Modal } from './ui'

/**
 * 把当前选中的论文放进一个专题：挑已有的，或顺手新建一个。
 *
 * paperIds 为空时退化成「只新建专题」（侧栏的 + 走这条）。
 */
export function AddToCollectionDialog({
  open,
  onClose,
  paperIds
}: {
  open: boolean
  onClose: () => void
  paperIds: string[]
}): JSX.Element {
  const collections = useAppStore((s) => s.collections)
  const createCollection = useAppStore((s) => s.createCollection)
  const addPapersToCollection = useAppStore((s) => s.addPapersToCollection)
  const selectCollection = useAppStore((s) => s.selectCollection)
  const clearSelection = useAppStore((s) => s.clearSelection)

  const [mode, setMode] = useState<'new' | string>('new')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  const adding = paperIds.length > 0
  const existing = useMemo(
    () => [...collections].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    [collections]
  )

  useEffect(() => {
    if (!open) return
    const list = useAppStore.getState().collections
    setMode(paperIds.length && list.length ? list[0].id : 'new')
    setTitle('')
    setDescription('')
  }, [open, paperIds.length])

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (mode === 'new') {
        const name = title.trim()
        if (!name) {
          useAppStore.getState().toast('先给专题起个名字', 'error')
          return
        }
        const created = await createCollection({
          title: name,
          description: description.trim(),
          paperIds
        })
        if (!created) return
        if (adding) clearSelection()
        onClose()
        return
      }

      const added = await addPapersToCollection(mode, paperIds)
      if (!added) return
      clearSelection()
      selectCollection(added.id)
      useAppStore.getState().toast(`已加入专题「${added.title}」`, 'success')
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={adding ? `把 ${paperIds.length} 篇放进专题` : '新建专题'}
      subtitle={
        adding
          ? '专题是你手动归到一起的一组论文，之后可以指定 agent 专门分析这一块。'
          : '先建一个空专题，再从列表里把论文加进去。'
      }
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {mode === 'new' ? '创建' : '加入'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {adding && existing.length ? (
          <div className="space-y-1">
            {existing.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setMode(c.id)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition',
                  mode === c.id ? 'border-brand/50 bg-brand/15' : 'border-line hover:border-strong'
                )}
              >
                <Layers className="h-3.5 w-3.5 shrink-0 text-brand-soft" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui text-ink-high">{c.title}</span>
                  <span className="block truncate text-meta text-ink-low">
                    {c.paperIds.length} 篇{c.description ? ` · ${c.description}` : ''}
                  </span>
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setMode('new')}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition',
                mode === 'new' ? 'border-brand/50 bg-brand/15' : 'border-line hover:border-strong'
              )}
            >
              <Plus className="h-3.5 w-3.5 shrink-0 text-ink-low" />
              <span className="text-ui text-ink-high">新建专题</span>
            </button>
          </div>
        ) : null}

        {mode === 'new' || !adding ? (
          <div className="space-y-3">
            <Field label="名称">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void submit()
                  }
                }}
                placeholder="例如：VLA 阅读周"
                className="field"
                autoFocus
              />
            </Field>
            <Field label="一句话说明" hint="可选">
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="集中看的具身智能 / VLA 论文"
                className="field"
              />
            </Field>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
