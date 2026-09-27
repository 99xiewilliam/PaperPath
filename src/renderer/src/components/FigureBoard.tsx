import { useEffect, useState } from 'react'
import { ImageOff, Loader2 } from 'lucide-react'
import { useFigureUrl } from './MdImage'
import { Modal } from './ui'

/*
 * 原文图表的三种展示形态：
 *   FigureThumb    —— 缩略图（图库面板 / 对照板共用）
 *   FigureLightbox —— 点缩略图后的大图查看
 *   FigureBoard    —— 归纳页的对照板：一篇论文一列，图竖着排，
 *                     横向滚动 —— 「同类论文的方法框架图并排摆」就是这个样子
 *
 * 图片字节一律走 useFigureUrl 的共享缓存（MdImage.tsx），不另开读文件的口子。
 */

const fileNameOf = (relPath: string): string => relPath.split('/').pop() ?? relPath

export function FigureThumb({ relPath, onClick }: { relPath: string; onClick?: () => void }): JSX.Element {
  const { url, failed } = useFigureUrl(relPath)
  const name = fileNameOf(relPath)

  if (failed) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg border border-line bg-bg-raised px-2 py-3 text-[10.5px] text-ink-low">
        <ImageOff className="h-3.5 w-3.5 shrink-0" />
        图丢了：{name}
      </div>
    )
  }
  if (!url) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-line bg-bg-raised py-6 text-ink-low">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      </div>
    )
  }
  return (
    <button
      title={`${name}（点击放大）`}
      onClick={onClick}
      className="block w-full overflow-hidden rounded-lg border border-line bg-white transition hover:border-brand/50"
    >
      <img src={url} alt={name} className="max-h-[220px] w-full object-contain" />
    </button>
  )
}

export function FigureLightbox({
  relPath,
  onClose
}: {
  relPath: string
  onClose: () => void
}): JSX.Element {
  const { url, failed } = useFigureUrl(relPath)
  return (
    <Modal open onClose={onClose} title={fileNameOf(relPath)} width="max-w-4xl">
      {failed ? (
        <p className="flex items-center gap-2 text-[12px] text-ink-low">
          <ImageOff className="h-4 w-4" />
          图片找不到：{relPath}（可能已被删除）
        </p>
      ) : url ? (
        <img
          src={url}
          alt={fileNameOf(relPath)}
          className="mx-auto max-h-[72vh] rounded-lg bg-white object-contain"
        />
      ) : (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-brand-soft" />
        </div>
      )}
    </Modal>
  )
}

/**
 * 对照板：每篇论文一列。
 *
 * 横向滚动而不是网格 —— 对照「同类论文的方法框架图」时，两三篇的图要能
 * 在同一行视线上直接比，网格会把这些图拆到不同行去。
 */
export function FigureBoard({
  papers
}: {
  papers: { id: string; title: string }[]
}): JSX.Element {
  const [columns, setColumns] = useState<Array<{ id: string; title: string; figures: string[] }>>([])
  const [loading, setLoading] = useState(true)
  const [zoom, setZoom] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void (async () => {
      const results = await Promise.all(
        papers.map(async (paper) => {
          const res = await window.papervault.figures.list(paper.id).catch(() => null)
          return { ...paper, figures: res?.ok ? (res.figures ?? []) : [] }
        })
      )
      if (!alive) return
      setColumns(results)
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [papers])

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-[12px] text-ink-low">
        <Loader2 className="h-4 w-4 animate-spin text-brand-soft" />
        正在读取这批论文的图库…
      </div>
    )
  }

  if (!columns.some((col) => col.figures.length)) {
    return (
      <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[12px] leading-relaxed text-ink-low">
        这批论文还没有截过原文图。
        <br />
        打开一篇论文的「原文」标签页，用「截取图表」框选，图就会出现在这里。
      </p>
    )
  }

  return (
    <>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {columns.map((col) => (
          <section key={col.id} className="w-[230px] shrink-0 space-y-1.5">
            <h4 title={col.title} className="truncate text-[11.5px] font-medium text-ink-mid">
              {col.title}
            </h4>
            {col.figures.length ? (
              col.figures.map((rel) => (
                <FigureThumb key={rel} relPath={rel} onClick={() => setZoom(rel)} />
              ))
            ) : (
              <p className="rounded-lg border border-dashed border-line px-2 py-4 text-center text-[10.5px] text-ink-low">
                还没截过图
              </p>
            )}
          </section>
        ))}
      </div>
      {zoom ? <FigureLightbox relPath={zoom} onClose={() => setZoom(null)} /> : null}
    </>
  )
}
