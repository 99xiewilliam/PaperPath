import { useEffect, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { imageMimeOf, resolveVaultRelative } from '@shared/figures'

/*
 * 笔记里的图片分两类：知识库内的（笔记自己写的相对路径，例如
 * `../figures/<id>/fig-1.png`）和外部地址（http / data / blob）。
 *
 * 前者不能直接丢给 <img>：渲染进程的页面源在开发模式是 http、打包后是 file，
 * 它既不知道知识库目录在哪，Chromium 也不允许 http 页面加载 file:// 子资源。
 * 所以走「主进程读字节 → 转成与页面同源的 blob URL」—— 和 PDF 预览
 * （paper:pdfData）用的是同一套路子，连「不用自定义协议」的理由都一样。
 *
 * 缓存不是优化，是必需品：章节预览会在**每次敲键盘**时重渲染整段 Markdown，
 * 不缓存的话每敲一个字就把同一张 PNG 过一次 IPC、再造一个新的 object URL，
 * 而旧 URL 永远不会被释放。图一旦落盘内容就不再变化（新截的图是新文件名），
 * 所以按路径永久缓存是安全的。
 */
const urlCache = new Map<string, string>()
const inflight = new Map<string, Promise<string | null>>()

function loadFigureUrl(relPath: string): Promise<string | null> {
  const cached = urlCache.get(relPath)
  if (cached) return Promise.resolve(cached)
  const running = inflight.get(relPath)
  if (running) return running

  const task = window.papervault.figures
    .read(relPath)
    .then((res) => {
      if (!res.ok || !res.data) return null
      /*
       * 复制一份再塞给 Blob：IPC 传来的字节类型是 `Uint8Array<ArrayBufferLike>`，
       * 而 BlobPart 只接受 ArrayBuffer 支撑的视图（SharedArrayBuffer 不算），
       * 类型上对不上。复制一份同时也能确保缓冲区不会被别处 detach。
       */
      const bytes = new Uint8Array(res.data)
      const url = URL.createObjectURL(new Blob([bytes], { type: imageMimeOf(relPath) }))
      urlCache.set(relPath, url)
      return url
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(relPath)
    })

  inflight.set(relPath, task)
  return task
}

/**
 * 按知识库内相对路径把图读成 blob URL。图库面板、归纳对照区共用这一份缓存，
 * 别处要用图也走这里，别再开一条自己的 IPC 读字节。
 */
export function useFigureUrl(relPath: string | null): {
  url: string | null
  failed: boolean
} {
  const [url, setUrl] = useState<string | null>(() =>
    relPath ? (urlCache.get(relPath) ?? null) : null
  )
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!relPath || url) return
    let alive = true
    void loadFigureUrl(relPath).then((loaded) => {
      if (!alive) return
      if (loaded) setUrl(loaded)
      else setFailed(true)
    })
    return () => {
      alive = false
    }
  }, [relPath, url])

  return { url, failed }
}

/**
 * Markdown 里的图片。
 *
 * `imageBase` 是**笔记所在目录**（相对知识库根），用来解析相对路径 ——
 * 不能拿当前页面地址去解析，那是 Vite dev server 的地址。
 */
export function MdImage({
  src,
  alt,
  imageBase
}: {
  src?: string
  alt?: string
  imageBase: string
}): JSX.Element | null {
  const rel = src ? resolveVaultRelative(imageBase, src) : null
  const { url, failed } = useFigureUrl(rel)

  if (!src) return null
  // 外部地址（http / data / blob）交给浏览器自己处理
  if (!rel) return <img src={src} alt={alt ?? ''} />
  if (url) return <img src={url} alt={alt ?? ''} />

  /*
   * 占位符要说清是「找不到」还是「还在读」，否则一张缺失的图看起来
   * 和加载慢没区别，用户会一直等下去。
   */
  return (
    <span className="my-2 inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-meta text-ink-low">
      <ImageOff className="h-3.5 w-3.5 shrink-0" />
      {failed ? `图片找不到：${rel}` : '正在读取图片…'}
    </span>
  )
}
