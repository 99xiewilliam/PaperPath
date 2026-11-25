/**
 * IPC 注册表。
 *
 * 这个文件现在只做一件事：把频道名映射到对应 service 的实现，
 * 并决定哪些调用需要进任务队列（`queuedTask`）。业务逻辑一律不写在这里 ——
 * 拆分之前它有一千两百多行，改任何一个功能都得先在这堆 handler 里翻半天。
 *
 * 分工：
 *   runtime.ts        跨模块共享（进度广播 / 任务包装 / 知识库上下文 / 预算常量）
 *   vault-service.ts  打开、状态、重新扫描
 *   paper-service.ts  论文的读（sectionsOf）与写（persistPaper）
 *   collection-service.ts 专题（手动分组的论文集合）
 *   pdf-window.ts     PDF 预览窗口与路径越界校验
 *   import-service.ts PDF 导入
 *   ai-service.ts     精读 / 重写 / 划词 / 问答 / 套路归纳
 */
import { dialog, ipcMain, shell } from 'electron'
import { existsSync, readFileSync } from 'fs'
import type { Highlight } from '@shared/highlights'
import type { LensId } from '@shared/lenses'
import { normalizeReadingPosition } from '@shared/pagination'
import type { SourceLine } from '@shared/autohighlight'
import { buildPhraseBank } from '@shared/phrases'
import type { PhraseEntry } from '@shared/phrases'
import type { PassageAskMode } from '@shared/api'
import { buildWritingOverview, type WritingOverview } from '@shared/writing-logic'
import type {
  AiTaskResult,
  AppSettings,
  ArxivMeta,
  ChatMessage,
  CollectionCreateInput,
  CollectionUpdateInput,
  ImportPdfResult,
  LlmSettings,
  PaperBulkUpdate,
  PaperCreateInput,
  PaperDetail,
  PaperSummary,
  PaperUpdateInput,
  ScanResult,
  StatsOverview
} from '@shared/types'
import type {
  AiTextResult,
  BatchProfileResult,
  BulkResult,
  ChatOptions,
  ChatResult,
  ChatScope,
  ImportPdfPayload
} from '@shared/api'
import {
  runAutoHighlight,
  runBuildProfile,
  runBuildProfiles,
  runChat,
  runLenses,
  runPassage,
  runRewriteSection,
  runSummarize
} from './ai-service'
import {
  addPapersToCollection,
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  removePapersFromCollection,
  updateCollection
} from './collection-service'
import { fetchArxivMeta } from './arxiv'
import { buildProblemMap, countProblemSources, getProblemMap } from './problem-service'
import { deleteIdea, generateIdeas, listIdeas, updateIdea } from './idea-service'
import { addReferenceToLibrary, extractReferences, getReferences } from './reference-service'
import type { IdeaPatch, ResearchIdea } from '@shared/ideas'
import { DEFAULT_READING_SKILL } from '@shared/reading-skill'
import type { ProblemMap } from '@shared/problems'
import type { ReferenceList } from '@shared/references'
import * as db from './db'
import { assertGranted, grantPaths } from './file-grants'
import { importPdf } from './import-service'
import { testConnection } from './llm'
import {
  bulkDeletePapers,
  bulkUpdatePapers,
  buildDetail,
  createPaper,
  deletePaper,
  highlightsOf,
  persistPaper,
  sectionsOf,
  updatePaper
} from './paper-service'
import { openPdfWindow, resolvePdfPath } from './pdf-window'
import { focusedWindow, interactiveTask, queuedTask, requireVault } from './runtime'
import { getSettings, setSettings } from './settings'
import { cancelInteractive, tasks, type TaskState } from './tasks'
import * as vault from './vault'
import { loadVault, rescanVault, vaultStatus } from './vault-service'

/**
 * 句式库聚合缓存。
 * 拼一次要读遍全部论文的 Markdown（几千篇时是实打实的 IO），
 * 而内容没变时结果完全一样 —— 用「知识库路径 + 内容指纹」做键复用。
 */
let phraseCache: { key: string; entries: PhraseEntry[] } | null = null

export function registerIpc(): void {
  /* 知识库 --------------------------------------------------------- */
  ipcMain.handle('vault:status', () => vaultStatus())

  ipcMain.handle('vault:choose', async () => {
    const win = focusedWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: '选择知识库目录',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '使用此目录'
    })
    if (result.canceled || !result.filePaths[0]) return null
    return loadVault(result.filePaths[0])
  })

  ipcMain.handle('vault:open', async (_e, path: string) => loadVault(path))

  ipcMain.handle('vault:rescan', async (): Promise<ScanResult> => {
    const result = await rescanVault()
    return result
  })

  ipcMain.handle('vault:reveal', (_e, relPath: string) => {
    const vaultPath = requireVault()
    const abs = vault.resolveInside(vaultPath, relPath)
    if (abs) shell.showItemInFolder(abs)
  })

  /* PDF 预览 -------------------------------------------------------- */
  ipcMain.handle('paper:openPdf', (_e, id: string): { ok: boolean; message?: string } => {
    const resolved = resolvePdfPath(id)
    if ('message' in resolved) return { ok: false, message: resolved.message }
    openPdfWindow(resolved.abs)
    return { ok: true }
  })

  /**
   * 返回 PDF 原始字节，供渲染层用 Blob URL 内嵌预览。
   *
   * 为什么不注册自定义协议让 iframe 直接加载：那条路一旦协议没被 Chromium
   * 认成「内部协议」，就会被当成外部 URL 交给操作系统处理，
   * 表现为 macOS 弹「没有应用能打开该 URL」。
   * Blob URL 与页面同源，不存在这一类问题；代价是整份 PDF 要过一次 IPC，
   * 单篇预览完全可以接受（大文件也就几十毫秒）。
   */
  ipcMain.handle('paper:pdfData', (_e, id: string) => {
    const resolved = resolvePdfPath(id)
    if ('message' in resolved) return { ok: false, message: resolved.message }
    try {
      return { ok: true, data: new Uint8Array(readFileSync(resolved.abs)) }
    } catch (err) {
      return { ok: false, message: `读取 PDF 失败：${(err as Error).message}` }
    }
  })

  /* 原文图表 ------------------------------------------------------- */

  /**
   * 保存一张从 PDF 里裁下来的图。
   *
   * 相对路径与 Markdown 片段都在 main 侧算：只有这里同时知道笔记的真实位置
   * （用户可能把笔记放进了子目录，层级就不是 `../`）和图库的位置。
   * 放渲染层算的话，子目录里的笔记会算出错的相对路径。
   */
  ipcMain.handle('figures:save', (_e, paperId: string, data: Uint8Array, ext?: string) => {
    const row = db.getPaperRow(paperId)
    if (!row) return { ok: false, message: '论文不存在。' }
    if (!data || !data.length) return { ok: false, message: '图片是空的，没有保存。' }
    const figureRel = vault.saveFigure(requireVault(), paperId, data, ext)
    if (!figureRel) return { ok: false, message: '保存图片失败。' }
    return {
      ok: true,
      relPath: figureRel,
      markdown: vault.figureMarkdownFor(String(row.rel_path ?? ''), figureRel)
    }
  })

  ipcMain.handle('figures:read', (_e, relPath: string) => {
    const data = vault.readFigure(requireVault(), relPath)
    if (!data) return { ok: false, message: '图片不存在或不可读。' }
    return { ok: true, data }
  })

  ipcMain.handle('figures:list', (_e, paperId: string) => {
    return { ok: true, figures: vault.listFigures(requireVault(), paperId) }
  })

  ipcMain.handle('figures:delete', (_e, relPath: string) => {
    if (!vault.deleteFigure(requireVault(), relPath)) {
      return { ok: false, message: '删除失败：只允许删 figures/ 目录里的图片。' }
    }
    return { ok: true }
  })

  /* PDF 高亮 ------------------------------------------------------- */
  ipcMain.handle('paper:saveHighlight', (_e, paperId: string, highlight: Highlight) => {
    const row = db.getPaperRow(paperId)
    if (!row) return { ok: false, message: '论文不存在。' }
    /*
     * 现有高亮从 Markdown 读 —— 不能只看索引：索引里的值要等一次重新扫描才会同步，
     * 直接用会让「新增一条高亮」变成「用这一条替换掉全部」。
     */
    const meta = { ...db.paperMetaFromRow(row), highlights: highlightsOf(paperId) }
    // 同 id 覆盖（用于改颜色 / 补备注），否则追加
    const next = [...meta.highlights.filter((h) => h.id !== highlight.id), highlight]
    const detail = persistPaper({ ...meta, highlights: next }, sectionsOf(paperId))
    return { ok: true, highlights: detail.meta.highlights ?? [] }
  })

  ipcMain.handle('paper:removeHighlight', (_e, paperId: string, highlightId: string) => {
    const row = db.getPaperRow(paperId)
    if (!row) return { ok: false, message: '论文不存在。' }
    const meta = { ...db.paperMetaFromRow(row), highlights: highlightsOf(paperId) }
    const next = meta.highlights.filter((h) => h.id !== highlightId)
    const detail = persistPaper({ ...meta, highlights: next }, sectionsOf(paperId))
    return { ok: true, highlights: detail.meta.highlights ?? [] }
  })

  /*
   * 阅读位置（「上次读到哪」）。
   * 存在索引 DB 的 meta 表而不是 frontmatter：它是随手变化的 UI 状态，
   * 每滚一屏就写一次 Markdown 会让笔记文件一直变脏、触发反复重扫。
   */
  ipcMain.handle('paper:getReadingPosition', (_e, paperId: string) => {
    const raw = db.metaGet(`readpos:${paperId}`)
    if (!raw) return { ok: true }
    try {
      return { ok: true, position: normalizeReadingPosition(JSON.parse(raw)) }
    } catch {
      return { ok: true }
    }
  })

  ipcMain.handle(
    'paper:saveReadingPosition',
    (_e, paperId: string, pos: { ratio: number; page: number }) => {
      const clean = normalizeReadingPosition({ ...pos, updatedAt: new Date().toISOString() })
      if (!clean) return { ok: false }
      db.metaSet(`readpos:${paperId}`, JSON.stringify(clean))
      return { ok: true }
    }
  )

  /* 论文 ----------------------------------------------------------- */
  ipcMain.handle('paper:list', (): PaperSummary[] => db.listPaperSummaries())

  /*
   * 全文检索放在主进程：只有索引里的 search_blob 才包含笔记正文，
   * 渲染层的列表数据里没有（P1-A 之后正文根本不进 IPC 载荷）。
   * 返回 id 数组，渲染层拿它去筛已经排好序的列表。
   */
  ipcMain.handle('paper:search', (_e, query: string): string[] => {
    if (!db.isOpen()) return []
    return db.searchPaperIds(query)
  })

  ipcMain.handle('paper:get', (_e, id: string): PaperDetail | null => buildDetail(id))

  ipcMain.handle('paper:create', (_e, input: PaperCreateInput) => createPaper(input))

  ipcMain.handle('paper:update', (_e, input: PaperUpdateInput) => updatePaper(input))

  ipcMain.handle('paper:delete', (_e, id: string) => {
    deletePaper(id)
    return true
  })

  /*
   * 批量操作走任务队列，理由和 AI 任务一样，但多一层：批量改属性和 AI 精读
   * 都会写同一批 Markdown，不排队就可能互相覆盖。顺带白拿到「可取消」和
   * 逐篇进度 —— 选了几十篇之后界面才不会像卡死。
   */
  ipcMain.handle('paper:bulkUpdate', (_e, input: PaperBulkUpdate) =>
    queuedTask<BulkResult>('批量修改', async () => bulkUpdatePapers(input), {
      total: 0,
      succeeded: 0,
      failed: 0
    })
  )

  ipcMain.handle('paper:bulkDelete', (_e, ids: string[]) =>
    queuedTask<BulkResult>('批量删除', async () => bulkDeletePapers(ids), {
      total: 0,
      succeeded: 0,
      failed: 0
    })
  )

  ipcMain.handle('paper:text', (_e, id: string) => vault.readExtractedText(requireVault(), id))

  /*
   * 文件选择框返回的路径 = 用户显式授权，记进授权表。
   * 后续 `file:readBinary` 与 `paper:importPdf` 只放行授权过的路径 ——
   * 见 file-grants.ts：光校验扩展名等于「只要是 .pdf 就放行」。
   */
  ipcMain.handle('paper:pickPdfs', async () => {
    const win = focusedWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: '选择要导入的论文 PDF',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) return []
    grantPaths(result.filePaths)
    return result.filePaths
  })

  /**
   * 拖拽落下的路径由 preload 报上来授权。
   *
   * 刻意不暴露给渲染层：授权动作只能发生在真实的用户拖拽里，
   * 否则渲染层被注入后可以自己「授权」任意路径，这道门就白设了。
   */
  ipcMain.handle('file:grant', (_e, paths: string[]): number => grantPaths(paths ?? []))

  ipcMain.handle('file:readBinary', (_e, path: string) => {
    // 扩展名与授权一起校验（assertGranted 内部只放行 .pdf）
    const abs = assertGranted(path, '读取 PDF')
    if (!existsSync(abs)) throw new Error('文件不存在。')
    return new Uint8Array(readFileSync(abs))
  })

  /*
   * 导入也进队列。
   *
   * 它内部会自动跑一次精读，而 chatCompletion 在没有显式 signal 时会回退到
   * `currentSignal()` —— 也就是「当前正在跑的那个任务」的信号。不排队的话，
   * 边跑 AI 任务边导入，取消前者会连带把导入中断，进度事件的 taskId 也会串台。
   */
  ipcMain.handle('paper:importPdf', (_e, payload: ImportPdfPayload) =>
    queuedTask<ImportPdfResult>('导入 PDF', () => importPdf(payload), {
      error: '导入失败'
    })
  )

  /* arXiv ---------------------------------------------------------- */
  ipcMain.handle('arxiv:fetch', async (_e, input: string): Promise<ArxivMeta> => fetchArxivMeta(input))

  /* AI ------------------------------------------------------------- */
  ipcMain.handle('ai:test', async (_e, llm: LlmSettings) => {
    const reply = await testConnection(llm)
    return { ok: true, reply }
  })

  ipcMain.handle('ai:summarize', (_e, id: string, instruction?: string) =>
    queuedTask<AiTaskResult>('AI 精读', () => runSummarize(id, instruction))
  )

  ipcMain.handle(
    'ai:rewriteSection',
    (_e, id: string, sectionKey: string, instruction?: string) =>
      queuedTask<AiTextResult>('重写章节', () => runRewriteSection(id, sectionKey, instruction), {
        content: ''
      })
  )

  /*
   * 问答走交互通道：用户正等着看回答，不该排在一次几分钟的精读后面。
   * streamId 同时当取消标识，「停止」只掐这一次问答。
   */
  ipcMain.handle(
    'ai:chat',
    (_e, paperIds: string[], messages: ChatMessage[], scope?: ChatScope, options?: ChatOptions) =>
      interactiveTask<ChatResult>(
        (signal) => runChat(paperIds, messages, scope, options ?? {}, signal),
        { content: '' },
        options?.streamId
      )
  )
  ipcMain.handle('ai:cancelChat', (_e, streamId: string) => cancelInteractive(streamId) > 0)

  /* 专题 ----------------------------------------------------------- */
  ipcMain.handle('collection:list', () => (db.isOpen() ? listCollections() : []))
  ipcMain.handle('collection:get', (_e, id: string) => getCollection(id))
  ipcMain.handle('collection:create', (_e, input: CollectionCreateInput) => createCollection(input))
  ipcMain.handle('collection:update', (_e, input: CollectionUpdateInput) => updateCollection(input))
  ipcMain.handle('collection:delete', (_e, id: string) => deleteCollection(id))
  ipcMain.handle('collection:addPapers', (_e, id: string, paperIds: string[]) =>
    addPapersToCollection(id, paperIds)
  )
  ipcMain.handle('collection:removePapers', (_e, id: string, paperIds: string[]) =>
    removePapersFromCollection(id, paperIds)
  )

  /* 开放问题池 ------------------------------------------------------- */
  ipcMain.handle('problems:get', (_e, scope: string) => getProblemMap(scope))
  ipcMain.handle('problems:status', (_e, scope: string) => countProblemSources(scope))
  ipcMain.handle('problems:build', (_e, scope: string) =>
    queuedTask<{ ok: boolean; message?: string; map?: ProblemMap }>('汇总开放问题', async () => {
      const map = await buildProblemMap(scope)
      return { ok: true, message: `已汇总出 ${map.problems.length} 个开放问题`, map }
    })
  )

  /* 读论文风格（skill） ---------------------------------------------- */
  ipcMain.handle('skill:get', () => {
    // 老知识库是在有 skill 之前建的；读的时候补上，「在 Finder 中显示」才有东西可指
    vault.ensureVaultStructure(requireVault())
    return vault.readReadingSkill(requireVault())
  })
  ipcMain.handle('skill:save', (_e, content: string) => {
    vault.writeReadingSkill(requireVault(), String(content ?? ''))
    return vault.readReadingSkill(requireVault())
  })
  ipcMain.handle('skill:reset', () => {
    vault.writeReadingSkill(requireVault(), DEFAULT_READING_SKILL)
    return DEFAULT_READING_SKILL
  })

  /* 选题本 ----------------------------------------------------------- */
  ipcMain.handle('ideas:list', () => listIdeas())
  ipcMain.handle('ideas:generate', (_e, scope: string, problemTitle: string) =>
    queuedTask<{ ok: boolean; message?: string; ideas?: ResearchIdea[] }>('生成选题', async () => {
      const ideas = await generateIdeas(scope, problemTitle)
      return { ok: true, message: `生成了 ${ideas.length} 个选题`, ideas }
    })
  )
  ipcMain.handle('ideas:update', (_e, id: string, patch: IdeaPatch) => updateIdea(id, patch))
  ipcMain.handle('ideas:delete', (_e, id: string) => deleteIdea(id))

  /* 参考文献对照 ----------------------------------------------------- */
  ipcMain.handle('refs:get', (_e, paperId: string) => getReferences(paperId))
  ipcMain.handle('refs:extract', (_e, paperId: string) =>
    queuedTask<{ ok: boolean; message?: string; list?: ReferenceList }>(
      '抽取参考文献',
      async () => {
        const list = await extractReferences(paperId)
        return { ok: true, message: `识别出 ${list.items.length} 条参考文献`, list }
      }
    )
  )
  ipcMain.handle('refs:addToLibrary', (_e, paperId: string, index: number) =>
    addReferenceToLibrary(paperId, index)
  )

  /**
   * 只重跑指定的维度（一个或多个）。批量入口是给「只重试上一次失败的那几个」用的。
   *
   * 走 mergeRunRecord：部分维度重跑必须并回上一次的完整记录，
   * 否则状态条上只会剩下这次跑的那一两个维度。
   */
  ipcMain.handle('ai:runLens', (_e, id: string, lensIds: LensId | LensId[], instruction?: string) =>
    queuedTask<AiTaskResult>('分析维度', async () => {
      const list = Array.isArray(lensIds) ? lensIds : [lensIds]
      const { result, outcomes } = await runLenses(id, list, instruction, {
        mergeRunRecord: true
      })
      const only = outcomes.length === 1 ? outcomes[0] : undefined
      // 单维度失败时用维度自己的原因——它比「所有维度都失败了」有用得多
      return only && !only.ok ? { ...result, ok: false, message: only.message } : result
    })
  )

  ipcMain.handle('ai:buildProfile', (_e, id: string) =>
    queuedTask<AiTaskResult>('抽取实验画像', () => runBuildProfile(id))
  )

  ipcMain.handle(
    'ai:passage',
    (
      _e,
      input: {
        paperId: string
        mode: PassageAskMode
        text: string
        question?: string
        history?: ChatMessage[]
        streamId: string
      }
    ) =>
      /*
       * 走**交互通道**（不排队）。
       *
       * 划词翻译 / 解读 / 追问是「用户正等着看结果」的短请求，而批处理队列是串行的：
       * 一次精读要跑几分钟，排在里面就是「点了翻译没反应」。它们也互不抢信号 ——
       * 取消精读不会连带掐掉正在进行的翻译（见 tasks.ts 的 runInteractive）。
       */
      interactiveTask<AiTextResult>((signal) => runPassage(input, signal), { content: '' })
  )

  /*
   * AI 标重点同样走交互通道：用户在阅读器里点了按钮等着看标注出现，
   * 不该排在一次几分钟的精读后面。
   */
  ipcMain.handle('ai:autoHighlight', (_e, input: { paperId: string; lines: SourceLine[] }) =>
    interactiveTask((signal) => runAutoHighlight(input.paperId, input.lines, signal))
  )

  ipcMain.handle('ai:buildProfiles', (_e, ids: string[] | 'missing') =>
    queuedTask<BatchProfileResult>('批量抽取实验画像', () => runBuildProfiles(ids), {
      total: 0,
      succeeded: 0,
      failed: 0
    })
  )

  /* 任务控制 -------------------------------------------------------- */
  ipcMain.handle('task:cancel', (): boolean => tasks.cancel())
  ipcMain.handle('task:state', (): TaskState | null => tasks.state())

  /* 写作思路 -------------------------------------------------------- */
  /*
   * 一个频道供整页：卡片与套路是**同一次计算**的两个视图。
   * 拆成两个频道的话，聚类参数一改就会一边新一遍旧，界面上出现
   * 「套路里有这篇、卡片列表里却没有」这种对不上的状态。
   */
  ipcMain.handle('writing:overview', (): WritingOverview => {
    if (!db.isOpen()) return { cards: [], patterns: [], singletons: [] }
    return buildWritingOverview(db.listWritingLogicRows())
  })

  /* 句式库 ---------------------------------------------------------- */
  ipcMain.handle('phrases:list', (): PhraseEntry[] => {
    if (!db.isOpen()) return []
    const vaultPath = getSettings().vaultPath
    if (!vaultPath) return []

    // 键里带上知识库路径：换库时即使指纹碰巧相同也不会串味
    const key = `${vaultPath}|${db.contentStamp()}`
    if (phraseCache?.key === key) return phraseCache.entries

    const inputs = db.listPaperRows().map((p) => ({
      id: p.id,
      title: p.title,
      year: p.year,
      categories: p.categories,
      // 走索引里记的 relPath，文件名被改过也能读到
      sections: vault.readPaperSections(vaultPath, p.id, p.relPath),
      structuredPhrases: p.phrases
    }))
    const entries = buildPhraseBank(inputs)
    phraseCache = { key, entries }
    return entries
  })

  /* 统计与设置 ------------------------------------------------------ */
  ipcMain.handle('stats:overview', (): StatsOverview => {
    if (!db.isOpen()) {
      return {
        total: 0,
        byStatus: { inbox: 0, reading: 0, read: 0, archived: 0 },
        byCategory: [],
        byTag: [],
        byYear: [],
        weekly: [],
        totalChars: 0,
        withExperimentNotes: 0,
        withWritingNotes: 0,
        avgRating: 0
      }
    }
    return db.computeStats(getSettings().customCategories)
  })

  ipcMain.handle('settings:get', (): AppSettings => getSettings())

  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>): AppSettings =>
    setSettings(patch)
  )

  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('仅支持打开 http(s) 链接。')
    return shell.openExternal(url)
  })
}
