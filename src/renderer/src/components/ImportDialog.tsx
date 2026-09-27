import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, FileText, FolderOpen, Loader2, Plus, Trash2, X } from 'lucide-react'
import { allCategories, categoryColor } from '@shared/taxonomy'
import { cn, errorMessage } from '@/lib/utils'
import { extractPdfText } from '@/lib/pdf'
import { useAppStore } from '@/store/useAppStore'
import { useUiStore } from '@/store/useUiStore'
import { Button, Modal } from './ui'

type Status = 'pending' | 'extracting' | 'importing' | 'summarizing' | 'done' | 'failed'

interface QueueItem {
  path: string
  name: string
  status: Status
  page?: number
  total?: number
  message?: string
  paperId?: string
}

const STATUS_TEXT: Record<Status, string> = {
  pending: '等待',
  extracting: '解析 PDF',
  importing: '写入知识库',
  summarizing: 'AI 精读',
  done: '完成',
  failed: '失败'
}

export function ImportDialog(): JSX.Element {
  const open = useUiStore((s) => s.importOpen)
  const importPaths = useUiStore((s) => s.importPaths)
  const consumePaths = useUiStore((s) => s.consumeImportPaths)
  const close = useUiStore((s) => s.close)
  const settings = useAppStore((s) => s.settings)

  const [queue, setQueue] = useState<QueueItem[]>([])
  const [running, setRunning] = useState(false)
  const [categories, setCategories] = useState<string[]>([])
  const [autoSummarize, setAutoSummarize] = useState(true)
  const queueRef = useRef<QueueItem[]>([])
  queueRef.current = queue

  useEffect(() => {
    if (!importPaths.length) return
    setQueue((prev) => {
      const known = new Set(prev.map((q) => q.path))
      const added = importPaths
        .filter((p) => !known.has(p))
        .map((p) => ({ path: p, name: fileName(p), status: 'pending' as Status }))
      return [...prev, ...added]
    })
    consumePaths()
  }, [importPaths, consumePaths])

  useEffect(() => {
    if (open) setAutoSummarize(settings.autoSummarizeOnImport)
  }, [open, settings.autoSummarizeOnImport])

  const pendingCount = useMemo(() => queue.filter((q) => q.status === 'pending').length, [queue])

  const patch = (path: string, next: Partial<QueueItem>): void =>
    setQueue((prev) => prev.map((q) => (q.path === path ? { ...q, ...next } : q)))

  const pick = async (): Promise<void> => {
    const paths = await window.papervault.papers.pickPdfs()
    if (!paths.length) return
    setQueue((prev) => {
      const known = new Set(prev.map((q) => q.path))
      return [
        ...prev,
        ...paths
          .filter((p) => !known.has(p))
          .map((p) => ({ path: p, name: fileName(p), status: 'pending' as Status }))
      ]
    })
  }

  const run = async (): Promise<void> => {
    if (running) return
    const targets = queueRef.current.filter((q) => q.status === 'pending' || q.status === 'failed')
    if (!targets.length) return

    setRunning(true)
    const store = useAppStore.getState()
    let lastId: string | null = null
    let ok = 0

    for (const item of targets) {
      try {
        patch(item.path, { status: 'extracting', page: 0, total: 0, message: undefined })
        store.setBusy(`正在解析 ${item.name}…`)
        const bytes = await window.papervault.files.readBinary(item.path)
        const result = await extractPdfText(bytes, (done, total) =>
          patch(item.path, { page: done, total })
        )

        patch(item.path, { status: 'importing', message: `抽取 ${result.text.length} 字` })
        if (autoSummarize) store.setBusy(`正在精读 ${item.name}…`)
        const res = await window.papervault.papers.importPdf({
          sourcePath: item.path,
          fileName: item.name,
          text: result.text,
          extractedTitle: result.title,
          extractedAuthors: result.authors,
          pageCount: result.pageCount,
          autoSummarize,
          categories
        })

        if (res.ok) {
          ok++
          if (res.paperId) lastId = res.paperId
          patch(item.path, {
            status: 'done',
            paperId: res.paperId,
            message: res.warning ?? `共 ${result.pageCount} 页`
          })
        } else {
          // 先取 message：那才是 queuedTask 写入的真实原因，error 只是兜底文案
          patch(item.path, { status: 'failed', message: res.message ?? res.error ?? '导入失败' })
        }
      } catch (err) {
        patch(item.path, { status: 'failed', message: errorMessage(err) })
      } finally {
        store.setBusy(null)
      }
    }

    setRunning(false)
    await useAppStore.getState().refreshAll()
    if (lastId) await useAppStore.getState().selectPaper(lastId)
    useAppStore
      .getState()
      .toast(ok ? `成功导入 ${ok} 篇论文` : '导入结束，但没有成功入库的论文', ok ? 'success' : 'error')
    if (ok && queueRef.current.every((q) => q.status === 'done')) {
      setTimeout(() => {
        close('importOpen')
        setQueue([])
      }, 1200)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => (running ? undefined : close('importOpen'))}
      title="导入论文 PDF"
      subtitle="PaperVault 会抽取全文、复制一份 PDF 到知识库，并按固定章节自动生成精读笔记。"
      width="max-w-3xl"
      footer={
        <>
          <span className="mr-auto text-[11.5px] text-ink-low">
            {queue.length ? `${queue.length} 个文件 · ${pendingCount} 个待处理` : ''}
          </span>
          <Button variant="ghost" onClick={() => close('importOpen')} disabled={running}>
            关闭
          </Button>
          <Button variant="subtle" onClick={() => void pick()} disabled={running}>
            继续添加
          </Button>
          <Button
            variant="primary"
            loading={running}
            disabled={!pendingCount}
            onClick={() => void run()}
          >
            {running ? '处理中…' : `开始导入 ${pendingCount ? `(${pendingCount})` : ''}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <button
          onClick={() => void pick()}
          disabled={running}
          className="flex w-full flex-col items-center gap-1.5 rounded-xl border border-dashed border-line py-7 text-ink-mid transition hover:border-brand/50 hover:bg-brand/[0.04] hover:text-ink-high disabled:opacity-50"
        >
          <FolderOpen className="h-6 w-6" />
          <span className="text-[12.5px] font-medium">点击选择 PDF，或直接把文件拖进窗口</span>
          <span className="text-[11px] text-ink-low">支持一次选多篇，逐篇解析</span>
        </button>

        {queue.length ? (
          <div className="space-y-1.5">
            {queue.map((item) => (
              <div
                key={item.path}
                className="flex items-center gap-3 rounded-lg border border-line bg-bg-raised px-3 py-2"
              >
                <FileText className="h-4 w-4 shrink-0 text-ink-low" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-ink-high">{item.name}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-ink-low">
                    <span
                      className={cn(
                        item.status === 'done' && 'text-ok',
                        item.status === 'failed' && 'text-danger',
                        (item.status === 'extracting' || item.status === 'importing') && 'text-info'
                      )}
                    >
                      {STATUS_TEXT[item.status]}
                    </span>
                    {item.status === 'extracting' && item.total ? (
                      <span>
                        第 {item.page}/{item.total} 页
                      </span>
                    ) : null}
                    {item.message ? (
                      <span className="truncate text-ink-low">{item.message}</span>
                    ) : null}
                  </div>
                </div>
                {item.status === 'done' ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" />
                ) : item.status === 'failed' ? (
                  <X className="h-4 w-4 shrink-0 text-danger" />
                ) : item.status === 'pending' ? (
                  <button
                    onClick={() => setQueue((prev) => prev.filter((q) => q.path !== item.path))}
                    className="shrink-0 text-ink-low transition hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-info" />
                )}
              </div>
            ))}
          </div>
        ) : null}

        <div className="rounded-xl border border-line bg-bg-raised p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[12px] font-medium text-ink-mid">导入时预打的分类</span>
            <span className="text-[10.5px] text-ink-low">
              留空则交给 AI 自动判断（可在笔记里随时改）
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
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
                  className={cn('chip transition', active ? '' : 'text-ink-mid hover:border-strong')}
                  style={
                    active
                      ? {
                          color: node.color,
                          borderColor: `${node.color}88`,
                          background: `${node.color}22`
                        }
                      : undefined
                  }
                >
                  {node.label}
                </button>
              )
            })}
          </div>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-bg-raised p-3">
          <input
            type="checkbox"
            checked={autoSummarize}
            onChange={(e) => setAutoSummarize(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 accent-brand"
          />
          <span>
            <span className="block text-[12px] font-medium text-ink-high">
              导入后立即调用 AI 精读
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-low">
              会逐篇请求模型，生成本次翻译好的写作手法与实验方法论拆解。模型：{settings.llm.model || '未配置'}
              {settings.llm.apiKey ? '' : '（尚未配置 API Key，将跳过）'}
            </span>
          </span>
        </label>

        {!settings.llm.apiKey ? (
          <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[11.5px] text-warn">
            <Plus className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            还没有配置大模型 API Key，本次只会完成文本抽取与建档；配置后可以在笔记页点「AI 精读」补齐。
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
