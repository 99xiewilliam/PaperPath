/**
 * PDF 预览窗口。
 *
 * 单独成文件是因为这里同时管着两件容易被误改的事：
 *   1. 把 frontmatter 里的 `pdf` 相对路径解析成绝对路径时**必须**做越界校验；
 *   2. 同一个文件只允许存在一个窗口（否则反复点「预览」会开出一堆）。
 */
import { BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { basename } from 'path'
import { pathToFileURL } from 'url'
import * as db from './db'
import { requireVault } from './runtime'
import * as vault from './vault'

/** 同一个文件只开一个窗口，重复点「预览」就聚焦已有窗口 */
const pdfWindows = new Map<string, BrowserWindow>()

/**
 * 把一篇论文关联的 PDF 解析成绝对路径。
 *
 * `pdf` 字段来自 frontmatter，可以被手工改成 `../../..` 指向知识库外，
 * 所以必须校验解析后的路径仍在知识库内。
 */
export function resolvePdfPath(id: string): { abs: string } | { message: string } {
  const row = db.getPaperRow(id)
  if (!row) return { message: '论文不存在。' }

  const rel = String(row.pdf ?? '')
  if (!rel) return { message: '这篇论文还没有关联 PDF，可以重新导入一次。' }

  const abs = vault.resolveInside(requireVault(), rel)
  if (!abs) return { message: 'PDF 路径不在知识库内，已拒绝访问。' }
  if (!existsSync(abs)) {
    return { message: 'PDF 文件已不存在，可能在知识库外被移动或删除了。' }
  }
  return { abs }
}

/**
 * 用 Electron 内置的 Chromium PDF 阅读器开一个独立窗口。
 *
 * 为什么不塞在渲染层的 iframe 里：那需要额外开 webviewTag 或自定义协议
 * （还要处理 Range 请求），而内置阅读器的缩放、翻页、页内搜索、打印都是现成的。
 * 独立窗口还方便和笔记窗口左右并排看。
 */
export function openPdfWindow(absPath: string): void {
  const existing = pdfWindows.get(absPath)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return
  }

  const win = new BrowserWindow({
    width: 1180,
    height: 940,
    title: basename(absPath),
    backgroundColor: '#0F1015',
    webPreferences: {
      // Chromium 的内置 PDF 阅读器靠这个开关启用
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  void win.loadURL(pathToFileURL(absPath).toString())
  win.on('closed', () => pdfWindows.delete(absPath))
  pdfWindows.set(absPath, win)
}
