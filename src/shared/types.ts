import type { ExperimentProfile } from './experiment'
import type { MethodFlow } from './flow'
import type { MindMap } from './mindmap'
import type { Highlight } from './highlights'
import type { EnglishPhrase, LensId, LensRunRecord } from './lenses'
import type { WritingLogic } from './writing-logic'

/** 论文阅读状态 */
export type PaperStatus = 'inbox' | 'reading' | 'read' | 'archived'

export const STATUS_LABEL: Record<PaperStatus, string> = {
  inbox: '待读',
  reading: '精读中',
  read: '已读完',
  archived: '已归档'
}

export const STATUS_COLOR: Record<PaperStatus, string> = {
  inbox: 'text-ink-mid bg-white/5 border-white/10',
  reading: 'text-info bg-info/10 border-info/30',
  read: 'text-ok bg-ok/10 border-ok/30',
  archived: 'text-ink-low bg-white/5 border-white/10'
}

/** Markdown frontmatter 中的书目 / 组织信息 */
export interface PaperMeta {
  id: string
  title: string
  authors: string[]
  year: number | null
  venue: string
  url: string
  arxivId: string
  doi: string
  status: PaperStatus
  /** 0-5 星，0 表示未评分 */
  rating: number
  /** 1-5，对当前研究的重要性 */
  importance: number
  /** 分类体系节点 id 数组，见 shared/taxonomy.ts */
  categories: string[]
  tags: string[]
  /** 结构化实验画像，由 AI 精读时抽取，见 shared/experiment.ts */
  exp?: ExperimentProfile
  /** PDF 高亮，见 shared/highlights.ts */
  highlights?: Highlight[]
  /** 结构化英语短语，由 english 维度抽取，见 shared/lenses.ts */
  phrases?: EnglishPhrase[]
  /*
   * 以下是**已下线功能**留下的历史字段：知识图谱、考考我、演示、论文关系、复习安排。
   *
   * 类型一律用 `unknown` 而不是各自的接口 —— 功能删了，但**磁盘上已有的数据不能丢**。
   * `writePaperFile` 是白名单式重建 frontmatter，少一条透传就会在用户改个评分时
   * 把整段数据永久抹掉（quiz / slides 还是花 token 生成的）。
   * 想看内容用外部编辑器打开 Markdown；应用内不再解析、不再展示。
   */
  graph?: unknown
  /**
   * 写作逻辑卡，由 writingLogic 维度抽取，见 shared/writing-logic.ts。
   *
   * 这是「写作思路」页的唯一数据来源：单篇卡直接渲染它，套路库按它的字段聚类。
   * 它只落在 frontmatter 里（索引那一列是它的镜像，可以从 Markdown 重建）。
   */
  wlogic?: WritingLogic
  /** 方法流程图，由「方法细节与例子」维度顺带产出，见 shared/flow.ts */
  flow?: MethodFlow
  /** 全文思维导图，由「速览与故事线」维度顺带产出，见 shared/mindmap.ts */
  mindmap?: MindMap
  /** 已下线：「考考我」自测题，历史数据原样透传 */
  quiz?: unknown
  /** 已下线：「演示」讲稿，历史数据原样透传 */
  slides?: unknown
  /** 已下线：论文关系，历史数据原样透传 */
  links?: unknown
  /** 已下线：复习安排，历史数据原样透传 */
  learningReview?: unknown
  /** 相对 vault 根目录的 PDF 路径，空串表示无附件 */
  pdf: string
  createdAt: string
  updatedAt: string
}

/** 列表页使用的轻量视图 */
export interface PaperSummary {
  id: string
  title: string
  authors: string[]
  year: number | null
  venue: string
  status: PaperStatus
  rating: number
  importance: number
  categories: string[]
  tags: string[]
  /** 结构化实验画像（可能为空，表示还没抽取过） */
  exp?: ExperimentProfile
  /** 结构化英语短语 */
  phrases?: EnglishPhrase[]
  /** 从正文「一句话总结」章节抽取 */
  tldr: string
  updatedAt: string
  relPath: string
  hasPdf: boolean
  /** 正文字数，用于估算沉淀量 */
  charCount: number
  /** 是否已用 AI 填充过 */
  aiFilled: boolean
}

/** 详情页使用的完整对象 */
export interface PaperDetail extends PaperSummary {
  meta: PaperMeta
  /** Markdown 正文（不含 frontmatter） */
  body: string
  /** 按固定标题切分后的章节内容 */
  sections: Record<string, string>
  /**
   * 上一次精读的结局（成功 / 部分失败 / 失败 / 取消都会记）。
   * 没有记录 = 这篇还从没跑过精读。
   */
  lastRun?: LensRunRecord | null
}

/** 更新论文时提交的载荷 */
export interface PaperUpdateInput {
  id: string
  meta: Partial<PaperMeta>
  sections: Record<string, string>
}

/**
 * 批量修改论文属性。
 *
 * 各项都是**增量**语义（加 / 减），没有「整份覆盖」的入口 —— 用户想加个标签时
 * 不该顺手把已手选的分类、已抽的实验画像、写好的笔记一起清掉。
 * 字段全为可选，都不传就是空操作。
 */
export interface PaperBulkUpdate {
  ids: string[]
  status?: PaperStatus
  addCategories?: string[]
  removeCategories?: string[]
  addTags?: string[]
  removeTags?: string[]
}

/**
 * 专题：用户手动把一组相关论文归到一起。
 *
 * 和分类 / 标签不是一回事 —— 那些是给论文打的属性；专题是一个有名字的集合，
 * 对应「我这段时间集中看的那几篇」，方便之后指定 agent 专门分析这一块。
 * Markdown 是唯一事实来源（`collections/<id>.md`），索引只是派生。
 */
export interface PaperCollection {
  id: string
  title: string
  description: string
  paperIds: string[]
  /** 专题自己的笔记（分析结论、待办），不是某篇论文的章节 */
  notes: string
  relPath: string
  createdAt: string
  updatedAt: string
}

export interface CollectionCreateInput {
  title: string
  description?: string
  paperIds?: string[]
  notes?: string
}

export interface CollectionUpdateInput {
  id: string
  title?: string
  description?: string
  paperIds?: string[]
  notes?: string
}

/** 新建论文时的载荷 */
export interface PaperCreateInput {
  title: string
  authors?: string[]
  year?: number | null
  venue?: string
  url?: string
  arxivId?: string
  doi?: string
  categories?: string[]
  tags?: string[]
  status?: PaperStatus
  /** 可选：直接把 PDF 复制进 vault（相对 vault 根目录的已有路径） */
  pdf?: string
  /** 可选：初始章节内容 */
  sections?: Record<string, string>
}

export interface ImportPdfResult {
  ok: boolean
  paperId?: string
  title?: string
  charCount?: number
  extractedSections?: string[]
  warning?: string
  error?: string
  /**
   * 失败原因。
   *
   * 由 queuedTask 统一写入（见 runtime.ts），所以只在 ok === false 时有值。
   * 以前类型里没有它，界面只能显示一个笼统的「导入失败」，
   * 真正的理由（未授权 / 目录不可写 / …）在渲染层就直接丢了。
   */
  message?: string
}

/** 应用设置 */
export interface AppSettings {
  /**
   * 设置结构的版本号，用于**一次性**迁移（见 main/settings.ts 的 migrateSettings）。
   *
   * 为什么需要它：有些默认值改了之后必须对老用户生效一次（例如某个分析维度
   * 从默认开启改为默认关闭），但用户手动改回来之后又不能每次启动都被重置。
   * 靠「每次启动补一遍」是错的，只能靠版本号判断「这条迁移跑过没有」。
   *
   * 缺省视为 1（引入这个字段之前的配置）。
   */
  settingsVersion?: number
  vaultPath: string
  llm: LlmSettings
  /** 是否在导入 PDF 后自动调用 LLM 生成结构化笔记 */
  autoSummarizeOnImport: boolean
  /** PDF 阅读器是否用深色模式（反相显示） */
  pdfDarkMode?: boolean
  /** PDF 阅读器是否显示 AI 自动标出的重点（用户自己的高亮不受开关影响） */
  pdfShowAiHighlights?: boolean
  /** 自定义分类节点，追加在内置分类之后 */
  customCategories: TaxonomyNode[]
  /** 自定义章节（追加到默认模板之后） */
  customSections: string[]
  /**
   * 关掉了哪些分析维度（AI 精读时按维度分别调用）。
   *
   * 存 opt-out 而不是 opt-in：新增维度要能自动对老用户生效，
   * 详见 @shared/lenses 的 enabledLensIds。
   */
  disabledLenses: LensId[]
  /** 只读：当前 .env / 环境变量接管了哪些配置（不落盘） */
  env?: EnvConfigInfo
}

/** .env 与环境变量的生效情况 */
export interface EnvConfigInfo {
  /** 是否有任何字段被 .env / 环境变量接管 */
  active: boolean
  /** 实际加载到的 .env 文件路径 */
  files: string[]
  /** 被接管的字段路径，例如 ['llm.apiKey', 'llm.baseUrl'] */
  overridden: string[]
}

export interface LlmSettings {
  /** OpenAI 兼容的 base url，例如 https://api.deepseek.com/v1 */
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  /**
   * 单价（元 / 百万 token），只用来把用量换算成花费，不参与任何请求。
   *
   * 为什么不给个默认值：不同服务商差几倍，写死必然误导。留空时界面只显示 token
   * 数、不显示金额 —— 宁可少显示，也不要显示一个错的数字。
   */
  priceInput?: number
  priceOutput?: number
  /**
   * 服务商特有的额外请求参数，原样并进 chat/completions 的 body。
   *
   * 为什么需要它：各家的「开关」都不在 OpenAI 兼容协议里 —— 智谱要
   * `{"thinking":{"type":"enabled"}}` 才会真正思考，通义要 enable_thinking，
   * 关掉思考又各有各的写法。为了多传一个字段而改代码、重新构建，
   * 代价远大于让用户自己在 .env 里写一行。
   *
   * 由 `PAPERVAULT_LLM_EXTRA_BODY` 提供（JSON 对象），只从环境变量读取。
   */
  extraBody?: Record<string, unknown>
  /**
   * 接口协议，决定请求由哪个适配器发出（见 main/llm/providers.ts）。
   * 缺省即 OpenAI 兼容 —— 智谱、DeepSeek、通义和各类中转都走它，老配置不用改。
   * 由 `PAPERVAULT_LLM_PROVIDER` 覆盖。
   */
  provider?: LlmProviderId
}

/** 已实现的接口协议。接 Anthropic / Gemini 原生接口时在这里加一项，再写一个适配器 */
export const LLM_PROVIDER_IDS = ['openai-compatible'] as const
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number]

/** 分类体系节点 */
export interface TaxonomyNode {
  id: string
  label: string
  /** 分组名，用于侧边栏折叠展示 */
  group: string
  /** 一句话说明这个分类收录什么样的论文 */
  description?: string
  /** 用于 AI 自动分类时的提示 */
  hint?: string
  color?: string
  builtin?: boolean
}

/** 统计面板数据 */
export interface StatsOverview {
  total: number
  byStatus: Record<PaperStatus, number>
  byCategory: { id: string; label: string; count: number }[]
  byTag: { tag: string; count: number }[]
  byYear: { year: number; count: number }[]
  /** 最近 12 周的沉淀量 */
  weekly: { week: string; count: number }[]
  totalChars: number
  /** 已填写「实验方法论」的论文数 */
  withExperimentNotes: number
  /** 已填写写作拆解的论文数 */
  withWritingNotes: number
  avgRating: number
}

export interface VaultStatus {
  opened: boolean
  path: string
  paperCount: number
}

export interface ScanResult {
  scanned: number
  indexed: number
  removed: number
  errors: string[]
}

export interface AiTaskResult {
  ok: boolean
  message: string
  paperId?: string
}

/** 从 PDF 抽取的原始文本 + 启发式切分的章节 */
export interface ExtractedPdf {
  text: string
  pageCount: number
  /** 依据论文常见标题切分出的原始章节 */
  rawSections: Record<string, string>
  meta: {
    title?: string
    author?: string
    subject?: string
    keywords?: string
  }
}

export interface ArxivMeta {
  title: string
  authors: string[]
  abstract: string
  published: string
  year: number
  categories: string[]
  arxivId: string
  doi: string
  journalRef: string
  primaryCategory: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
