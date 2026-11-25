import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { assemblePdfText, buildLines, type LineInfo, type TextItemLike } from './pdfText'

/*
 * pdfjs 主库有 1MB 左右，而它只在真正导入 PDF 时才用得到。
 * 静态引入会把它塞进首屏 bundle（应用启动即下载、解析 1MB 用不上的代码），
 * 所以改成按需加载 —— 落到单独 chunk，第一次解析 PDF 时才拉取。
 * worker 的 URL 只是个字符串，保持静态引入即可（它本来就是独立资源）。
 */
let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null

export function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = workerUrl
      return lib
    })
  }
  return pdfjsPromise
}

export interface PdfExtractionResult {
  text: string
  pageCount: number
  title?: string
  authors?: string[]
  /** 页面级文本，便于调试与按页展示 */
  pageTexts: string[]
}

export async function extractPdfText(
  data: Uint8Array,
  onProgress?: (done: number, total: number) => void
): Promise<PdfExtractionResult> {
  const pdfjsLib = await loadPdfjs()
  const doc = await pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
    // 关闭 range 请求与流式加载，本地文件走一次性读取
    disableAutoFetch: true,
    disableStream: true
  }).promise

  const pageCount = doc.numPages
  const pageTexts: string[] = []
  const pageLines: LineInfo[][] = []

  /*
   * 整个解析过程包在 try/finally 里释放 doc：中途任何一页抛错（损坏页、加密页）
   * 都会跳出循环，而 pdf.js 的文档对象与 worker 只有在 destroy 之后才释放 ——
   * 导入是逐份 catch 后继续的，漏一处就是每导入一份坏 PDF 泄漏一次。
   */
  try {
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i)
      try {
        const content = await page.getTextContent()
        const lines = buildLines(content.items as unknown as TextItemLike[])
        pageLines.push(lines)
        pageTexts.push(lines.map((l) => l.text).join('\n'))
      } finally {
        page.cleanup()
      }
      onProgress?.(i, pageCount)
    }

    let info: { title?: string; author?: string } = {}
    try {
      const meta = await doc.getMetadata()
      const raw = meta.info as Record<string, unknown> | undefined
      info = {
        title: typeof raw?.Title === 'string' ? raw.Title : undefined,
        author: typeof raw?.Author === 'string' ? raw.Author : undefined
      }
    } catch {
      /* 元数据缺失不影响主流程 */
    }

    const assembled = assemblePdfText(pageTexts, pageLines, info)
    return {
      text: assembled.text,
      pageCount,
      title: assembled.title,
      authors: assembled.authors,
      pageTexts: assembled.pageTexts
    }
  } finally {
    // 成功、失败都释放 pdf.js 的文档与 worker
    await doc.destroy()
  }
}

/* ------------------------------------------------------------------ */
/*  阅读器用的文档：生命周期绑在**论文**上，不绑在组件上                  */
/* ------------------------------------------------------------------ */

let cached: { paperId: string; doc: PDFDocumentProxy } | null = null

/**
 * 取一篇论文的 PDF 文档（带缓存）。
 *
 * 为什么不交给组件按需加载、卸载时销毁 —— 因为阅读器只在 `tab === 'source'`
 * 时挂载，而**「AI 标重点」要先逐页提取带坐标的文字行**（`extractSourceLines`：
 * 三十页的论文要 getPage + getTextContent 三十次，几秒到几十秒）。
 * 用户在等待期间切到「结构化笔记」，组件一卸载就把 doc 销毁，正在跑的 getPage
 * 当场抛错 —— 表现就是「AI 提取重点会中途停止」。
 *
 * 文档属于**这篇论文**，不属于某个 tab：切来切去不该让它消失。
 * 只留最近一份：同一时刻只会读一篇，多留白占内存和 worker。
 *
 * @param load 由调用方提供（这里不直接碰 window，保持本模块可单独测试）
 */
export async function openPdfDocument(
  paperId: string,
  load: (paperId: string) => Promise<Uint8Array>
): Promise<PDFDocumentProxy> {
  if (cached?.paperId === paperId) return cached.doc
  if (cached) {
    void cached.doc.destroy()
    cached = null
  }
  const pdfjsLib = await loadPdfjs()
  const data = await load(paperId)
  // slice() 是因为 pdfjs 会接管（可能 detach）传入的 buffer
  const doc = await pdfjsLib.getDocument({ data: data.slice() }).promise
  cached = { paperId, doc }
  return doc
}

/** 明确释放（换知识库、关闭阅读时用）。不调用也不会泄漏 —— 换论文时会自动释放上一份 */
export function closePdfDocument(): void {
  void cached?.doc.destroy()
  cached = null
}
