import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { allCategories, categoryColor } from '@shared/taxonomy'
import type { PaperStatus } from '@shared/types'
import { STATUS_LABEL } from '@shared/types'
import { cn, errorMessage } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { useUiStore } from '@/store/useUiStore'
import { Button, Field, Modal } from './ui'

export function NewPaperDialog(): JSX.Element {
  const open = useUiStore((s) => s.newPaperOpen)
  const close = useUiStore((s) => s.close)
  const settings = useAppStore((s) => s.settings)
  const createPaper = useAppStore((s) => s.createPaper)

  const [title, setTitle] = useState('')
  const [authors, setAuthors] = useState('')
  const [year, setYear] = useState('')
  const [venue, setVenue] = useState('')
  const [url, setUrl] = useState('')
  const [arxivId, setArxivId] = useState('')
  const [tags, setTags] = useState('')
  const [status, setStatus] = useState<PaperStatus>('inbox')
  const [categories, setCategories] = useState<string[]>([])
  const [loadingArxiv, setLoadingArxiv] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const reset = (): void => {
    setTitle('')
    setAuthors('')
    setYear('')
    setVenue('')
    setUrl('')
    setArxivId('')
    setTags('')
    setStatus('inbox')
    setCategories([])
  }

  const fetchArxiv = async (): Promise<void> => {
    if (!arxivId.trim()) return
    setLoadingArxiv(true)
    try {
      const meta = await window.papervault.arxiv.fetch(arxivId.trim())
      setTitle(meta.title)
      setAuthors(meta.authors.join(', '))
      setYear(String(meta.year))
      setVenue(meta.journalRef || meta.primaryCategory || 'arXiv')
      setArxivId(meta.arxivId)
      setUrl(`https://arxiv.org/abs/${meta.arxivId}`)
      if (!categories.length) {
        const guess = meta.categories
        if (guess.some((c) => /cs\.CL|cs\.IR/.test(c))) setCategories(['rag-method'])
        else if (guess.some((c) => /cs\.RO|cs\.AI/.test(c))) setCategories(['embodied-ai'])
      }
      useAppStore.getState().toast('已从 arXiv 拉取元信息', 'success')
    } catch (err) {
      useAppStore.getState().toast(errorMessage(err), 'error')
    } finally {
      setLoadingArxiv(false)
    }
  }

  const submit = async (): Promise<void> => {
    if (!title.trim()) {
      useAppStore.getState().toast('请先填写标题', 'error')
      return
    }
    setSubmitting(true)
    try {
      const detail = await createPaper({
        title: title.trim(),
        authors: authors
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean),
        year: year ? Number(year) || null : null,
        venue: venue.trim(),
        url: url.trim(),
        arxivId: arxivId.trim(),
        tags: tags
          .split(/[,，\s]+/)
          .map((t) => t.replace(/^#/, '').trim())
          .filter(Boolean),
        status,
        categories
      })
      if (detail) {
        reset()
        close('newPaperOpen')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => close('newPaperOpen')}
      title="手动新建论文条目"
      subtitle="没有 PDF 时也能先建档。填写 arXiv 编号可以一键拉取标题、作者与年份。"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => close('newPaperOpen')}>
            取消
          </Button>
          <Button variant="primary" loading={submitting} onClick={() => void submit()}>
            创建条目
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div className="flex items-end gap-2">
          <Field label="arXiv 编号或链接" className="flex-1" hint="例如 2401.12345">
            <input
              value={arxivId}
              onChange={(e) => setArxivId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void fetchArxiv()
              }}
              placeholder="2401.12345"
              className="field"
            />
          </Field>
          <Button
            variant="subtle"
            onClick={() => void fetchArxiv()}
            disabled={loadingArxiv || !arxivId.trim()}
            icon={
              loadingArxiv ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )
            }
          >
            拉取
          </Button>
        </div>

        <Field label="标题">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="论文标题"
            className="field"
          />
        </Field>

        <Field label="作者" hint="逗号分隔">
          <input
            value={authors}
            onChange={(e) => setAuthors(e.target.value)}
            placeholder="Alice, Bob, Carol"
            className="field"
          />
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="年份">
            <input
              value={year}
              onChange={(e) => setYear(e.target.value)}
              placeholder="2026"
              className="field"
            />
          </Field>
          <Field label="会议 / 期刊" className="col-span-2">
            <input
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
              placeholder="NeurIPS / ACL / arXiv"
              className="field"
            />
          </Field>
        </div>

        <Field label="链接">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            className="field"
          />
        </Field>

        <Field label="标签" hint="空格或逗号分隔">
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="long-context rerank 复现"
            className="field"
          />
        </Field>

        <div className="grid grid-cols-4 gap-3">
          <Field label="阅读状态">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as PaperStatus)}
              className="field"
            >
              {(Object.keys(STATUS_LABEL) as PaperStatus[]).map((s) => (
                <option key={s} value={s} className="bg-bg-overlay">
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="分类" hint="可多选，稍后在笔记里也能改">
          <div className="flex flex-wrap gap-1 pt-0.5">
            {allCategories(settings.customCategories).map((node) => {
              const active = categories.includes(node.id)
              return (
                <button
                  key={node.id}
                  onClick={() =>
                    setCategories((prev) =>
                      active ? prev.filter((c) => c !== node.id) : [...prev, node.id]
                    )
                  }
                  title={node.description}
                  className={cn(
                    'chip transition',
                    active ? '' : 'text-ink-mid hover:border-strong'
                  )}
                  style={
                    active
                      ? {
                          color: node.color ?? categoryColor(node.id, settings.customCategories),
                          borderColor: `${node.color ?? '#7A766D'}88`,
                          background: `${node.color ?? '#7A766D'}22`
                        }
                      : undefined
                  }
                >
                  {node.label}
                </button>
              )
            })}
          </div>
        </Field>
      </div>
    </Modal>
  )
}
