import type { ExperimentProfile } from './experiment'
import type { MethodFlow } from './flow'
import type { MindMap } from './mindmap'
import type { Quiz } from './quiz'
import type { SlideDeck } from './slides'
import type { PaperLink } from './links'
import type { LearningReview } from './learning'
import type { Highlight } from './highlights'
import type { EnglishPhrase, LensId, LensRunRecord, PaperGraph } from './lenses'

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
  /** 实体与关系，由 graph 维度抽取，用于跨论文建图 */
  graph?: PaperGraph
  /** 方法流程图，由「方法细节与例子」维度顺带产出，见 shared/flow.ts */
  flow?: MethodFlow
  /** 全文思维导图，由「速览与故事线」维度顺带产出，见 shared/mindmap.ts */
  mindmap?: MindMap
  /** 「考考我」自测题，由阅读页按需生成，见 shared/quiz.ts */
  quiz?: Quiz
  /** 演示文稿（讲给没读过的人听），由详情页按需生成，见 shared/slides.ts */
  slides?: SlideDeck
  /**
   * 与库里其他论文的关系（手工建立，或采纳 AI 提议），见 shared/links.ts。
   * 只存**出边**，反方向在界面上现算 —— 一条关系存两份迟早会漂移。
   */
  links?: PaperLink[]
  /** 手动回顾后的复习安排，随 Markdown 知识库保存。 */
  learningReview?: LearningReview
  /** 相对 vault 根目录的 PDF 路径，空串表示无附件 */
  pdf: string
  createdAt: string
  updatedAt: string
}

/** 列表页使用的轻量视图 */
export interface PaperSummary {
  learningReview?: LearningReview
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
  /** 实体与关系（知识图谱） */
  graph?: PaperGraph
  /** 与库里其他论文的关系；列表页也带上，详情页靠它现算「谁指向我」 */
  links?: PaperLink[]
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

/** 跨论文的 AI 文档：套路归纳，或从已确认的论文关系组合出的研究想法 */
export interface Synthesis {
  id: string
  title: string
  /** 归纳范围：按分类 / 按标签 / 手动挑选 */
  scope: SynthesisScope
  content: string
  relPath: string
  createdAt: string
  updatedAt: string
  paperCount: number
}

export interface SynthesisScope {
  /**
   * 这份文档是怎么选出来的：
   *   - category / tag / papers：套路归纳的三种范围；
   *   - links：从**你确认过的**论文关系组合出的研究想法（见 shared/ideas.ts）；
   *   - combo：对一组自己挑的论文做组合分析（见 shared/combo.ts）。
   */
  type: 'category' | 'tag' | 'papers' | 'links' | 'combo'
  value: string
  /** type=papers 时生效 */
  paperIds?: string[]
}

export interface SynthesisScopeInput {
  type: 'category' | 'tag' | 'papers'
  value: string
  paperIds?: string[]
  /** 归纳聚焦的维度，留空表示全维度 */
  focus?: string[]
}

/** 应用设置 */
export interface AppSettings {
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
}

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
  synthesisCount: number
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
  synthesisId?: string
}

/**
 * 「AI 找关系」的结果。
 *
 * 带回落盘后的**完整** links（而不只是新增的那几条）：渲染层直接拿它覆盖 draft 就行，
 * 不用自己拼一遍 —— 拼接逻辑分散在两边迟早漂移，而 `normalizeLinks` 已经在主进程
 * 做过去重、限长、人手工优先，那才是权威版本。
 */
export interface LinkDiscoveryResult {
  ok: boolean
  message: string
  /** 这篇论文落盘后的完整关系列表 */
  links?: PaperLink[]
  /** 实际判断了多少对候选 */
  judged?: number
  /** 其中判定成立、写成提议的条数 */
  proposed?: number
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
