import type {
  AiTaskResult,
  AppSettings,
  ArxivMeta,
  ChatMessage,
  ImportPdfResult,
  LinkDiscoveryResult,
  LlmSettings,
  PaperBulkUpdate,
  PaperCreateInput,
  PaperDetail,
  PaperSummary,
  PaperUpdateInput,
  ScanResult,
  StatsOverview,
  Synthesis,
  SynthesisScopeInput,
  VaultStatus
} from './types'
import type { PhraseEntry } from './phrases'
import type { LensId } from './lenses'
import type { GraphData, GraphScope, MultiHopResult } from './graph'
import type { Highlight } from './highlights'
import type { ReadingPosition } from './pagination'
import type { SourceLine } from './autohighlight'
import type { Quiz } from './quiz'
import type { SlideDeck } from './slides'

/** 划词面板的首轮动作；prompt 本体在 src/main/agents/passage.ts */
export type PassageMode = 'translate' | 'explain'
/** 划词面板里除了首轮的翻译/解读，还能继续追问 */
export type PassageAskMode = PassageMode | 'ask'

export interface TaskProgress {
  /** 属于哪个任务；null 表示当前没有任务在跑 */
  taskId: string | null
  stage: string
  message: string
  paperId?: string
  at: number
}

/** 主进程任务队列的当前状态 */
export interface TaskState {
  id: string
  label: string
  startedAt: number
}

/** 流式增量。streamId 由渲染层生成，用来认领自己那次请求的内容 */
export interface StreamDelta {
  streamId: string
  delta: string
}

export interface ImportPdfPayload {
  sourcePath: string
  fileName?: string
  text: string
  extractedTitle?: string
  extractedAuthors?: string[]
  pageCount?: number
  autoSummarize?: boolean
  categories?: string[]
}

export interface AiTextResult {
  ok: boolean
  content: string
  message?: string
}

/**
 * 批量操作的统一返回形状：批量抽实验画像、批量改属性、批量删除共用。
 *
 * 一律「部分成功也算成功」—— 50 篇里有 1 篇因为文件被外部删掉而失败，
 * 不该把另外 49 篇的结果一起回滚。失败明细放在 message 的首个错误里。
 */
export interface BulkResult {
  ok: boolean
  total: number
  succeeded: number
  failed: number
  message: string
}

/** 兼容旧名：批量抽实验画像用的就是 BulkResult */
export type BatchProfileResult = BulkResult

export interface PaperVaultApi {
  app: {
    platform: string
    openExternal(url: string): Promise<void>
    onProgress(cb: (progress: TaskProgress) => void): () => void
    onFilesDropped(cb: (paths: string[]) => void): () => void
    /** 订阅模型流式增量 */
    onStreamDelta(cb: (payload: StreamDelta) => void): () => void
  }
  task: {
    /** 取消当前正在运行的 AI 任务，并丢弃队列里还没开始的 */
    cancel(): Promise<boolean>
    /** 当前任务状态（null 表示空闲） */
    state(): Promise<TaskState | null>
  }
  vault: {
    status(): Promise<VaultStatus>
    choose(): Promise<VaultStatus | null>
    open(path: string): Promise<VaultStatus>
    rescan(): Promise<ScanResult>
    reveal(relPath: string): Promise<void>
  }
  papers: {
    list(): Promise<PaperSummary[]>
    /** 全文检索，覆盖笔记正文与实验画像；返回命中的论文 id */
    search(query: string): Promise<string[]>
    get(id: string): Promise<PaperDetail | null>
    create(input: PaperCreateInput): Promise<PaperDetail>
    update(input: PaperUpdateInput): Promise<PaperDetail>
    remove(id: string): Promise<boolean>
    /**
     * 批量改属性（增量语义）。走任务队列串行执行，逐篇发进度。
     * 与批量抽画像共用 BulkResult。
     */
    bulkUpdate(input: PaperBulkUpdate): Promise<BulkResult>
    /** 批量删除（Markdown + PDF 副本 + 抽取文本一起清理） */
    bulkDelete(ids: string[]): Promise<BulkResult>
    text(id: string): Promise<string>
    /** 用内置 PDF 阅读器打开这篇论文的 PDF（独立窗口） */
    openPdf(id: string): Promise<{ ok: boolean; message?: string }>
    /** 取 PDF 原始字节，渲染层用 Blob URL 内嵌预览 */
    pdfData(id: string): Promise<{ ok: boolean; data?: Uint8Array; message?: string }>
    /** 新增 / 覆盖一条高亮 */
    saveHighlight(
      paperId: string,
      highlight: Highlight
    ): Promise<{ ok: boolean; highlights?: Highlight[]; message?: string }>
    removeHighlight(
      paperId: string,
      highlightId: string
    ): Promise<{ ok: boolean; highlights?: Highlight[]; message?: string }>
    /**
     * 阅读位置（「上次读到哪」）。存在索引 DB 里而不是笔记 frontmatter ——
     * 它是随手变化的 UI 状态，不该让笔记文件一直变脏。没有记录时 position 缺省。
     */
    getReadingPosition(paperId: string): Promise<{ ok: boolean; position?: ReadingPosition }>
    saveReadingPosition(
      paperId: string,
      pos: { ratio: number; page: number }
    ): Promise<{ ok: boolean }>
    pickPdfs(): Promise<string[]>
    importPdf(payload: ImportPdfPayload): Promise<ImportPdfResult>
  }
  files: {
    readBinary(path: string): Promise<Uint8Array>
  }
  arxiv: {
    fetch(input: string): Promise<ArxivMeta>
  }
  ai: {
    test(llm: LlmSettings): Promise<{ ok: boolean; reply?: string; message?: string }>
    summarize(id: string, instruction?: string): Promise<AiTaskResult>
    rewriteSection(
      id: string,
      sectionKey: string,
      instruction?: string
    ): Promise<AiTextResult>
    chat(paperIds: string[], messages: ChatMessage[]): Promise<AiTextResult>
    synthesize(input: SynthesisScopeInput): Promise<AiTaskResult>
    /**
     * 从**已确认的**论文关系组合研究想法，落成一份跨论文文档（synthesies/）。
     * 不吃范围参数：范围只由「你确认过哪些关系」决定。
     */
    synthesizeIdeas(): Promise<AiTaskResult>
    /**
     * 组合分析：对一组自己挑的论文（2-6 篇）整体判断有没有组合创新的空间，
     * 产出「角度 + 组合论文蓝图」文档。成员之间可以还没有任何关系。
     * 传 `synthesisId` 表示原地重跑（成员与内容一起换新，不新建文档）。
     */
    comboAnalyze(input: {
      paperIds: string[]
      title?: string
      synthesisId?: string
    }): Promise<AiTaskResult>
    /**
     * AI 找关系：在本篇「数据判定过共享技术要素」的候选论文上逐对判断，
     * 成立的写成 `by: 'ai'` 的提议（要人在面板里确认才算数）。
     */
    discoverLinks(paperId: string): Promise<LinkDiscoveryResult>
    /** 只抽取结构化实验画像，比整篇精读便宜得多 */
    buildProfile(id: string): Promise<AiTaskResult>
    /** 批量抽取；传 'missing' 表示补全所有还没有画像的论文 */
    buildProfiles(ids: string[] | 'missing'): Promise<BatchProfileResult>
    /**
     * PDF 划词：首轮翻译 / 解读，或继续追问（走流式，增量通过 onStreamDelta 推送）。
     * history 由渲染层维护，main 只负责拼 system + history + 本轮指令。
     */
    passage(input: {
      paperId: string
      mode: PassageAskMode
      text: string
      question?: string
      history?: ChatMessage[]
      streamId: string
    }): Promise<AiTextResult>
    /**
     * AI 自动标重点：渲染层传带位置编号的行，模型挑区间，主进程换算落盘。
     * 重跑语义 = 替换旧的 AI 标注，用户手划的高亮不动。
     */
    autoHighlight(input: {
      paperId: string
      lines: SourceLine[]
    }): Promise<{
      ok: boolean
      highlights?: Highlight[]
      added?: number
      truncated?: boolean
      message?: string
    }>
    /**
     * 「考考我」出题：按原文出 5~8 道阅读理解式选择题，解析随题生成。
     * 判分在渲染层本地完成（gradeQuiz），不为了对答案再调用模型。
     * 出过的题沉淀进 frontmatter，重测不重新出题。
     */
    quiz(paperId: string): Promise<{ ok: boolean; quiz?: Quiz; message?: string }>
    /**
     * 生成「演示」：把论文拆成一页页，讲给**没读过它的人**听。
     *
     * 一次调用产出整份讲稿，存进 frontmatter 的 slides 键（同 quiz）——
     * 重新生成才会再调模型，平时翻页是纯本地的。
     */
    slides(paperId: string): Promise<{ ok: boolean; deck?: SlideDeck; message?: string }>
    /**
     * 只重跑指定的分析维度（一个或多个）。
     *
     * 传数组是给「只重试上一次失败的那几个」用的：全量重跑会把本来已经成功的
     * 维度重新生成一遍（输出必然不同），手改过的章节会被覆盖。
     */
    runLens(id: string, lensIds: LensId | LensId[], instruction?: string): Promise<AiTaskResult>
  }
  /**
   * 原文图表（从 PDF 里裁下来的图）。
   *
   * 单独一个命名空间而不是挂在 papers 下：图是知识库根目录的独立资产
   * （`figures/<paperId>/`），不归某篇笔记私有，将来别处也可能引用它。
   */
  figures: {
    /**
     * 保存一张图。返回的 `markdown` 是**相对笔记文件**的路径片段，
     * 可以直接贴进笔记正文（相对路径的好处：知识库整体搬走不会断链）。
     */
    save(
      paperId: string,
      data: Uint8Array,
      ext?: string
    ): Promise<{ ok: boolean; message?: string; relPath?: string; markdown?: string }>
    /** 读一张图给界面显示（只允许知识库内的图片） */
    read(relPath: string): Promise<{ ok: boolean; message?: string; data?: Uint8Array }>
    /** 列出一篇论文的全部图（相对知识库根的路径，fig-N 升序） */
    list(paperId: string): Promise<{ ok: boolean; message?: string; figures?: string[] }>
    /** 删一张图（只允许 figures/ 目录内的图片；笔记里的引用会因此裂图） */
    remove(relPath: string): Promise<{ ok: boolean; message?: string }>
  }
  phrases: {
    /** 从全部笔记里聚合出跨论文的可复用句式 */
    list(): Promise<PhraseEntry[]>
  }
  graph: {
    /** 拉取用于可视化的子图（已按筛选条件裁剪） */
    snapshot(scope?: GraphScope): Promise<GraphData>
    /** 从某个节点出发做多跳检索，返回路径与高亮集合 */
    multiHop(startId: string, hops?: number, scope?: GraphScope): Promise<MultiHopResult>
  }
  synthesis: {
    list(): Promise<Synthesis[]>
    get(id: string): Promise<Synthesis | null>
    save(id: string, title: string, content: string): Promise<Synthesis | null>
    remove(id: string): Promise<boolean>
  }
  stats: {
    overview(): Promise<StatsOverview>
  }
  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
  }
}
