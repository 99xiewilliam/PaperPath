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
  PaperCollection,
  PaperCreateInput,
  PaperDetail,
  PaperSummary,
  PaperUpdateInput,
  ScanResult,
  StatsOverview,
  VaultStatus
} from './types'
import type { PhraseEntry } from './phrases'
import type { LensId } from './lenses'
import type { Highlight } from './highlights'
import type { ReadingPosition } from './pagination'
import type { SourceLine } from './autohighlight'
import type { WritingOverview } from './writing-logic'
import type { IdeaPatch, ResearchIdea } from './ideas'
import type { ProblemMap } from './problems'
import type { ReferenceList } from './references'

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
  /** 进度说明（「正在查：…」）；有它时 delta 通常为空 */
  status?: string
}

/**
 * 问答里较早的轮次被压缩成的摘要。
 * upTo = 摘要覆盖了历史里的前多少条消息；之后的消息原样发给模型。
 */
export interface ChatMemo {
  text: string
  upTo: number
}

export interface ChatResult extends AiTextResult {
  /** 这一轮压缩了历史时带回新的摘要，渲染层存进会话，下一轮再带上 */
  memo?: ChatMemo
  /** 模型这一轮查阅过的东西（「搜索库：…」「读笔记：…」），给用户看，不回传给模型 */
  trace?: string[]
  /** 用户选了、但笔记太长没放进这次上下文的论文标题 */
  omitted?: string[]
}

export interface ChatOptions {
  /** 流式增量通过 onStreamDelta 推送，用它认领；也用于单独取消 */
  streamId?: string
  memo?: ChatMemo
}

/**
 * 问答的分析范围。专题分析会带上名字和一句话说明，让模型把这几篇
 * 当成「用户故意归到一起的一组」而不是随便挑的几篇。
 */
export interface ChatScope {
  title?: string
  description?: string
  /** 来自专题时带上，工具可以据此读这个专题的问题池 */
  collectionId?: string
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
    /**
     * 知识库问答。走交互通道（不排在精读后面）；给了 streamId 就流式推送。
     * 历史由渲染层维护，main 不存状态：太长时把较早的轮次压成摘要随结果带回。
     */
    chat(
      paperIds: string[],
      messages: ChatMessage[],
      scope?: ChatScope,
      options?: ChatOptions
    ): Promise<ChatResult>
    /** 停掉 streamId 对应的那次问答 */
    cancelChat(streamId: string): Promise<boolean>
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
  /**
   * 专题：用户手动归到一起的论文组。
   *
   * 和 papers 平级而不是挂在 papers 下 —— 专题是一等实体（有自己的 Markdown），
   * 不是论文的附属属性。一篇论文可以同时属于多个专题。
   */
  collections: {
    list(): Promise<PaperCollection[]>
    get(id: string): Promise<PaperCollection | null>
    create(input: CollectionCreateInput): Promise<PaperCollection>
    update(input: CollectionUpdateInput): Promise<PaperCollection>
    remove(id: string): Promise<boolean>
    /** 把论文加进专题（已在里面的会跳过，保持原顺序） */
    addPapers(id: string, paperIds: string[]): Promise<PaperCollection>
    /** 从专题里移出论文 */
    removePapers(id: string, paperIds: string[]): Promise<PaperCollection>
  }
  /** 开放问题池；scope 是 'all' 或专题 id */
  problems: {
    get(scope: string): Promise<ProblemMap | null>
    /** 范围内共几篇、其中几篇写好了「局限与未来工作」 */
    status(scope: string): Promise<{ total: number; ready: number }>
    build(scope: string): Promise<{ ok: boolean; message?: string; map?: ProblemMap }>
  }
  /** 读论文风格：知识库里的 skills/读论文风格.md，决定精读 agent 的口吻与导读结构 */
  skill: {
    get(): Promise<string>
    /** 保存并返回落盘后的内容 */
    save(content: string): Promise<string>
    /** 恢复默认并返回默认内容 */
    reset(): Promise<string>
  }
  /** 选题本：从开放问题生成的选题 */
  ideas: {
    list(): Promise<ResearchIdea[]>
    /** 针对 scope 问题池里标题为 problemTitle 的问题生成选题，返回新建的那几个 */
    generate(
      scope: string,
      problemTitle: string
    ): Promise<{ ok: boolean; message?: string; ideas?: ResearchIdea[] }>
    update(id: string, patch: IdeaPatch): Promise<ResearchIdea>
    delete(id: string): Promise<boolean>
  }
  /** 参考文献对照 */
  refs: {
    get(paperId: string): Promise<ReferenceList | null>
    extract(paperId: string): Promise<{ ok: boolean; message?: string; list?: ReferenceList }>
    /** 把第 index 条参考文献建成待读论文，返回刷新后的对照表 */
    addToLibrary(paperId: string, index: number): Promise<ReferenceList>
  }
  phrases: {
    /** 从全部笔记里聚合出跨论文的可复用句式 */
    list(): Promise<PhraseEntry[]>
  }
  writing: {
    /**
     * 「写作思路」页的整页快照：单篇逻辑卡 + 已聚出的套路。
     *
     * 卡片与套路是同一次计算的两个视图，所以只给一个入口 —— 分成两个频道后
     * 聚类参数一改就会一边新一遍旧。
     */
    overview(): Promise<WritingOverview>
  },
  stats: {
    overview(): Promise<StatsOverview>
  }
  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
  }
}
