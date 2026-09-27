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

  await doc.destroy()

  return {
    text: assembled.text,
    pageCount,
    title: assembled.title,
    authors: assembled.authors,
    pageTexts: assembled.pageTexts
  }
}
