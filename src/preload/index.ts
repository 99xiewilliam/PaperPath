import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { PaperVaultApi, StreamDelta, TaskProgress } from '@shared/api'
import type {
  AppSettings,
  ChatMessage,
  LlmSettings,
  PaperCreateInput,
  PaperUpdateInput,
  SynthesisScopeInput
} from '@shared/types'
import type { ImportPdfPayload } from '@shared/api'
import type { LensId } from '@shared/lenses'
import type { GraphScope } from '@shared/graph'
import type { Highlight } from '@shared/highlights'
import type { SourceLine } from '@shared/autohighlight'

/**
 * 拖拽进来的 PDF 直接在本进程分发给订阅者。
 *
 * 之前是 preload → 主进程 → 再原样发回同一个窗口，白绕一圈 IPC；
 * 拖拽本身发生在渲染进程，没有理由经过主进程。
 */
const dropListeners = new Set<(paths: string[]) => void>()

const api: PaperVaultApi = {
  app: {
    platform: process.platform,
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    onProgress: (cb) => {
      const handler = (_e: unknown, payload: TaskProgress): void => cb(payload)
      ipcRenderer.on('task:progress', handler)
      return () => ipcRenderer.removeListener('task:progress', handler)
    },
    onFilesDropped: (cb) => {
      dropListeners.add(cb)
      return () => dropListeners.delete(cb)
    },
    onStreamDelta: (cb) => {
      const handler = (_e: unknown, payload: StreamDelta): void => cb(payload)
      ipcRenderer.on('ai:stream', handler)
      return () => ipcRenderer.removeListener('ai:stream', handler)
    }
  },
  vault: {
    status: () => ipcRenderer.invoke('vault:status'),
    choose: () => ipcRenderer.invoke('vault:choose'),
    open: (path) => ipcRenderer.invoke('vault:open', path),
    rescan: () => ipcRenderer.invoke('vault:rescan'),
    reveal: (relPath) => ipcRenderer.invoke('vault:reveal', relPath)
  },
  papers: {
    list: () => ipcRenderer.invoke('paper:list'),
    search: (query: string) => ipcRenderer.invoke('paper:search', query),
    get: (id) => ipcRenderer.invoke('paper:get', id),
    create: (input: PaperCreateInput) => ipcRenderer.invoke('paper:create', input),
    update: (input: PaperUpdateInput) => ipcRenderer.invoke('paper:update', input),
    remove: (id) => ipcRenderer.invoke('paper:delete', id),
    bulkUpdate: (input) => ipcRenderer.invoke('paper:bulkUpdate', input),
    bulkDelete: (ids: string[]) => ipcRenderer.invoke('paper:bulkDelete', ids),
    text: (id) => ipcRenderer.invoke('paper:text', id),
    openPdf: (id: string) => ipcRenderer.invoke('paper:openPdf', id),
    pdfData: (id: string) => ipcRenderer.invoke('paper:pdfData', id),
    saveHighlight: (paperId: string, highlight: Highlight) =>
      ipcRenderer.invoke('paper:saveHighlight', paperId, highlight),
    removeHighlight: (paperId: string, highlightId: string) =>
      ipcRenderer.invoke('paper:removeHighlight', paperId, highlightId),
    getReadingPosition: (paperId: string) =>
      ipcRenderer.invoke('paper:getReadingPosition', paperId),
    saveReadingPosition: (paperId: string, pos: { ratio: number; page: number }) =>
      ipcRenderer.invoke('paper:saveReadingPosition', paperId, pos),
    pickPdfs: () => ipcRenderer.invoke('paper:pickPdfs'),
    importPdf: (payload: ImportPdfPayload) => ipcRenderer.invoke('paper:importPdf', payload)
  },
  figures: {
    save: (paperId: string, data: Uint8Array, ext?: string) =>
      ipcRenderer.invoke('figures:save', paperId, data, ext),
    read: (relPath: string) => ipcRenderer.invoke('figures:read', relPath),
    list: (paperId: string) => ipcRenderer.invoke('figures:list', paperId),
    remove: (relPath: string) => ipcRenderer.invoke('figures:delete', relPath)
  },
  files: {
    readBinary: (path) => ipcRenderer.invoke('file:readBinary', path)
  },
  arxiv: {
    fetch: (input) => ipcRenderer.invoke('arxiv:fetch', input)
  },
  ai: {
    test: (llm: LlmSettings) => ipcRenderer.invoke('ai:test', llm),
    summarize: (id, instruction) => ipcRenderer.invoke('ai:summarize', id, instruction),
    rewriteSection: (id, sectionKey, instruction) =>
      ipcRenderer.invoke('ai:rewriteSection', id, sectionKey, instruction),
    chat: (paperIds: string[], messages: ChatMessage[]) =>
      ipcRenderer.invoke('ai:chat', paperIds, messages),
    synthesize: (input: SynthesisScopeInput) => ipcRenderer.invoke('ai:synthesize', input),
    synthesizeIdeas: () => ipcRenderer.invoke('ai:synthesizeIdeas'),
    comboAnalyze: (input: { paperIds: string[]; title?: string; synthesisId?: string }) =>
      ipcRenderer.invoke('ai:comboAnalyze', input),
    discoverLinks: (paperId: string) => ipcRenderer.invoke('ai:discoverLinks', paperId),
    buildProfile: (id: string) => ipcRenderer.invoke('ai:buildProfile', id),
    passage: (input: {
      paperId: string
      mode: 'translate' | 'explain' | 'ask'
      text: string
      question?: string
      history?: ChatMessage[]
      streamId: string
    }) => ipcRenderer.invoke('ai:passage', input),
    autoHighlight: (input: { paperId: string; lines: SourceLine[] }) =>
      ipcRenderer.invoke('ai:autoHighlight', input),
    quiz: (paperId: string) => ipcRenderer.invoke('ai:quiz', paperId),
    slides: (paperId: string) => ipcRenderer.invoke('ai:slides', paperId),
    buildProfiles: (ids: string[] | 'missing') => ipcRenderer.invoke('ai:buildProfiles', ids),
    runLens: (id: string, lensIds: LensId | LensId[], instruction?: string) =>
      ipcRenderer.invoke('ai:runLens', id, lensIds, instruction)
  },
  phrases: {
    list: () => ipcRenderer.invoke('phrases:list')
  },
  graph: {
    snapshot: (scope?: GraphScope) => ipcRenderer.invoke('graph:snapshot', scope),
    multiHop: (startId: string, hops?: number, scope?: GraphScope) =>
      ipcRenderer.invoke('graph:multiHop', startId, hops, scope)
  },
  task: {
    cancel: () => ipcRenderer.invoke('task:cancel'),
    state: () => ipcRenderer.invoke('task:state')
  },
  synthesis: {
    list: () => ipcRenderer.invoke('synthesis:list'),
    get: (id) => ipcRenderer.invoke('synthesis:get', id),
    save: (id, title, content) => ipcRenderer.invoke('synthesis:save', id, title, content),
    remove: (id) => ipcRenderer.invoke('synthesis:delete', id)
  },
  stats: {
    overview: () => ipcRenderer.invoke('stats:overview')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:set', patch)
  }
}

contextBridge.exposeInMainWorld('papervault', api)

/* 支持把 PDF 直接拖拽进窗口 ---------------------------------------- */
window.addEventListener('dragover', (event: DragEvent) => event.preventDefault(), true)

window.addEventListener(
  'drop',
  (event: DragEvent) => {
    const files = Array.from(event.dataTransfer?.files ?? []) as File[]
    if (!files.length) return
    event.preventDefault()
    const paths: string[] = []
    for (const file of files) {
      try {
        const path = webUtils.getPathForFile(file)
        if (path && path.toLowerCase().endsWith('.pdf')) paths.push(path)
      } catch {
        /* 忽略无法解析的文件 */
      }
    }
    if (!paths.length) return
    /*
     * 先授权再分发：主进程的 `file:readBinary` / `paper:importPdf` 只放行
     * 用户亲手选过或拖过的路径（见 main/file-grants.ts）。
     * 授权失败不阻塞流程 —— 真正读文件时会给出明确错误。
     */
    void ipcRenderer.invoke('file:grant', paths).catch(() => undefined)
    for (const cb of dropListeners) cb(paths)
  },
  true
)
