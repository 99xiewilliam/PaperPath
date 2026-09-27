/**
 * AI 能力层：精读（多维度）、章节重写、划词、知识库问答、套路归纳。
 *
 * 解耦约定：**每个 AI 功能一个 agent，一个文件**，自己的 system prompt、
 * 自己的 user prompt、自己的采样参数、自己的输出解析：
 *   - 精读的分析维度（一个维度一次调用）在 ./lenses/
 *   - 其余一次性功能（出题 / 标重点 / 划词 / 重写 / 问答 / 套路归纳）在 ./agents/
 * 本文件只管编排：取原文与笔记、调对应的 agent、把产出落盘。
 *
 * 另一件事需要注意：**本模块不做任务队列包装**。
 * `queuedTask()`（串行 + 可取消 + 失败转返回值）统一在 ipc.ts 的注册处套上，
 * 因为这些函数在批量流程里会被互相调用（importPdf → runSummarize），
 * 若内部再套一层队列就会自我死锁 —— 队列是串行的，等自己永远等不到。
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import matter from 'gray-matter'
import { relatedPapersFrom } from '@shared/connections'
import {
  buildAiHighlights,
  extractHeadingTitles,
  mergeAiHighlights,
  type SourceLine
} from '@shared/autohighlight'
import { emptyExperimentProfile, hasProfile } from '@shared/experiment'
import type { Highlight } from '@shared/highlights'
import { enabledLensIds, lensForSection, type LensId } from '@shared/lenses'
import {
  collectComboRelations,
  computeComboSignals,
  renderComboDoc,
  MAX_COMBO_PAPERS,
  MIN_COMBO_PAPERS,
  type ComboPaper
} from '@shared/combo'
import {
  buildIdeaSeeds,
  renderIdeaDoc,
  type Idea,
  type IdeaDocInput,
  type IdeaSeedPaper
} from '@shared/ideas'
import { LINK_TYPE_LABEL, normalizeLinks, type PaperLink } from '@shared/links'
import { scanFigureReferences, type FigureReference } from '@shared/figures'
import {
  ensureVisualSlides,
  pruneSlideVisuals,
  SLIDE_DECK_REVISION,
  type SlideDeck
} from '@shared/slides'
import { extractTldr } from '@shared/template'
import type { Quiz } from '@shared/quiz'
import type {
  AiTaskResult,
  ChatMessage,
  LinkDiscoveryResult,
  PaperMeta,
  PaperSummary,
  SynthesisScope,
  SynthesisScopeInput
} from '@shared/types'
import type { AiTextResult, BulkResult, PassageAskMode } from '@shared/api'
import { runAutoHighlightAgents } from './agents/autohighlight'
import { runChatAgent } from './agents/chat'
import { runComboAgent } from './agents/combo'
import { runMethodFlowAgent } from './agents/flow'
import { runIdeaAgent } from './agents/ideas'
import { pickLinkDigest, runLinkJudgeAgent, verdictToLink } from './agents/links'
import { runPassageAgent } from './agents/passage'
import { runQuizAgent } from './agents/quiz'
import { runRewriteAgent } from './agents/rewrite'
import { buildSlideNotesBlock, runSlideDeckAgent } from './agents/slides'
import { runSynthesizeAgent, type SynthesizeInput } from './agents/synthesize'
import * as db from './db'
import { resolveLenses } from './lenses'
import {
  buildRunRecord,
  mergeRunRecord,
  runLensPipeline,
  summarizeOutcomes,
  type LensRunOutcome
} from './lenses/run'
import { baseLensContext, sourceBlock, type LensContext } from './lenses/types'
import { LlmError } from './llm'
import { highlightsOf, persistPaper, sectionsOf } from './paper-service'
import { prepareLlmSource } from './papertext'
import {
  categoriesForAi,
  CHAT_CONTEXT_BUDGET,
  describeTaskError,
  emitStreamDelta,
  LENS_SOURCE_LIMIT,
  relativeOf,
  requireVault
} from './runtime'
import { getSettings } from './settings'
import { currentSignal, emitProgress, TaskCancelledError } from './tasks'
import * as vault from './vault'

/* ------------------------------------------------------------------ */
/*  精读：按维度拆成多次调用                                             */
/* ------------------------------------------------------------------ */

export function buildLensContext(vaultPath: string, paperId: string, meta: PaperMeta): LensContext {
  const raw = vault.readExtractedText(vaultPath, paperId)
  // 公共部分走 baseLensContext，避免和 smoke:ai 脚本各拼一份导致漂移
  return {
    ...baseLensContext(
      prepareLlmSource(raw, LENS_SOURCE_LIMIT),
      {
        title: meta.title,
        authors: meta.authors,
        year: meta.year,
        venue: meta.venue,
        url: meta.url,
        arxivId: meta.arxivId,
        categories: meta.categories
      },
      categoriesForAi(),
      sectionsOf(paperId)
    ),
    exp: meta.exp,
    existingPhrases: meta.phrases,
    /*
     * 跨论文候选，只给「方法串联」维度用。
     *
     * 判定放在这里而不是 prompt 里：**关系要由数据说了算**。把一堆论文标题交给模型，
     * 它几乎总能写出「都关注 XX」这种正确但无用的关联。所以先用知识图谱按共享实体
     * 筛一遍，筛不出就传空数组 —— 那个维度会如实写「库内暂无可串联的论文」。
     */
    relatedPapers: relatedPapersFrom(paperId, db.listPaperRows())
  }
}

/**
 * 把「实验画像抽取失败」这件事记进画像里。
 *
 * 为什么不只是弹个提示：任务跑完几分钟后提示就没了，而失败留下的是一份
 * 全空的画像 —— 它和「抽取成功、但这篇论文确实没写实验设置」在数据上
 * 完全一致。用户过几天回来看，只会看到 14 个「原文未说明」，
 * 既不知道系统出过错，也不知道该不该点重试。
 */
function markExperimentFailure(paperId: string, message: string): void {
  const row = db.getPaperRow(paperId)
  if (!row) return
  const current = db.paperMetaFromRow(row)
  // 保留用户已手动填过的字段，只把失败原因挂上去
  const exp = { ...(current.exp ?? emptyExperimentProfile()), error: message }
  persistPaper({ ...current, exp }, sectionsOf(paperId))
}

/**
 * 核心编排：把一个「精读」拆成若干个互相独立的维度，每个维度用自己的
 * system prompt + 自己的输入片段 + 自己的输出 schema 调用一次模型。
 *
 * 相比「一个大 prompt 塞 14 个章节」：
 *   - 输出短、不会截断；注意力集中，每个维度写得更深
 *   - 单个维度失败不影响其他维度（部分成功也会落盘）
 *   - 可以单独重跑某个维度
 */
async function runLensesInner(
  paperId: string,
  lensIds: LensId[],
  extraInstruction?: string
): Promise<{ result: AiTaskResult; outcomes: LensRunOutcome[] }> {
  const vaultPath = requireVault()
  const settings = getSettings()
  const row = db.getPaperRow(paperId)
  if (!row) throw new Error('论文不存在。')

  if (!resolveLenses(lensIds).length) {
    return {
      result: { ok: false, message: '没有启用任何分析维度，请到「设置 → 分析维度」里勾选。' },
      outcomes: []
    }
  }

  const meta = db.paperMetaFromRow(row)
  const ctx = buildLensContext(vaultPath, paperId, meta)
  if (!ctx.fullText && !Object.keys(ctx.sourceSections).length) {
    throw new Error('这篇论文没有抽取到原文，无法做 AI 分析。请先导入 PDF。')
  }

  const run = await runLensPipeline(ctx, lensIds, settings.llm, {
    extraInstruction,
    onProgress: (message) => emitProgress('lens', message, paperId)
  })

  /*
   * 先落盘失败原因，再走「全部维度都失败」的提前返回。
   * 顺序不能反：`runBuildProfile`（单个维度）失败时正是走那条提前返回，
   * 而「AI 重新抽取」按钮走的也是它 —— 不先写，用户点完重试还是什么都看不到。
   */
  const expOutcome = run.outcomes.find((o) => o.lensId === 'experiment')
  if (expOutcome && !expOutcome.ok) markExperimentFailure(paperId, expOutcome.message)

  if (!run.ok) {
    return {
      result: {
        ok: false,
        paperId,
        message: `所有维度都失败了。首个错误：${run.outcomes[0]?.message ?? '未知'}`
      },
      outcomes: run.outcomes
    }
  }

  /*
   * 写回前重新读一次磁盘与索引，**只覆盖本次真正产出的那部分**。
   *
   * 精读要跑几分钟，这期间用户完全可能继续改这篇笔记 —— paper:update 是 900ms
   * 防抖的自动保存，不经过任务队列（高频操作不能排队，否则编辑会卡在 AI 任务后面）。
   * 以前这里直接把精读开始时的那份快照整篇写回，用户这段时间的编辑会被无声抹掉。
   */
  const freshRow = db.getPaperRow(paperId)
  const freshMeta = freshRow ? db.paperMetaFromRow(freshRow) : meta
  const onDisk = sectionsOf(paperId)
  const mergedSections: Record<string, string> = { ...onDisk }
  for (const [key, value] of Object.entries(run.sections)) {
    // 与精读开始时的快照一致 = 这次没产出新内容，以磁盘上的现状为准
    if (!key.startsWith('学习笔记 · ') && value !== ctx.sections[key]) mergedSections[key] = value
  }

  // 分类只在用户还没选过时才写入，避免覆盖手选结果
  const validIds = new Set(ctx.categoryCatalog.map((c) => c.id))
  const aiCategories = (run.meta.categories ?? []).filter((c) => validIds.has(c))
  const nextMeta: PaperMeta = {
    ...freshMeta,
    categories: freshMeta.categories.length ? freshMeta.categories : aiCategories,
    tags: [...new Set([...freshMeta.tags, ...(run.meta.tags ?? [])])],
    exp: (run.data.exp as PaperMeta['exp']) ?? freshMeta.exp,
    phrases: (run.data.phrases as PaperMeta['phrases']) ?? freshMeta.phrases,
    graph: (run.data.graph as PaperMeta['graph']) ?? freshMeta.graph,
    // 这次没产出流程图 / 思维导图就沿用旧的（`freshMeta` 里没有，落盘时会从磁盘取回）
    flow: (run.data.flow as PaperMeta['flow']) ?? freshMeta.flow,
    mindmap: (run.data.mindmap as PaperMeta['mindmap']) ?? freshMeta.mindmap
  }
  if (nextMeta.status === 'inbox') nextMeta.status = 'reading'

  persistPaper(nextMeta, mergedSections)

  return {
    result: { ok: true, paperId, message: summarizeOutcomes(run.outcomes) },
    outcomes: run.outcomes
  }
}

/**
 * 跑一次精读，并把这次的结局落到索引里。
 *
 * 为什么必须落盘：精读的产出只在「跑完且至少一个维度成功」那一刻才写回笔记，
 * 于是另外三种结局 —— 中途被杀、用户取消、压根没跑起来（没原文 / 知识库没打开）——
 * 在界面上全都表现为**笔记一片空白**，跟「这篇论文确实没写实验设置」也分不开。
 * 这个包装把四种结局都记下来，详情页就能直接回答「上一次到底跑成什么样」。
 */
export interface RunLensesOptions {
  /**
   * 把本次结局**并回**上一次的完整记录，而不是覆盖它。
   *
   * 只在「只重跑其中几个维度」时为 true。整篇精读必须整条替换 ——
   * 否则上一次跑过、之后被关掉的维度会一直挂在状态条上。
   */
  mergeRunRecord?: boolean
}

export async function runLenses(
  paperId: string,
  lensIds: LensId[],
  extraInstruction?: string,
  options: RunLensesOptions = {}
): Promise<{ result: AiTaskResult; outcomes: LensRunOutcome[] }> {
  const writeRun = (outcomes: LensRunOutcome[], failure?: unknown): void => {
    if (!options.mergeRunRecord) {
      db.setPaperRun(paperId, buildRunRecord(outcomes, lensIds.length, failure))
      return
    }
    db.setPaperRun(paperId, mergeRunRecord(db.getPaperRun(paperId), outcomes, failure))
  }

  try {
    const out = await runLensesInner(paperId, lensIds, extraInstruction)
    writeRun(out.outcomes)
    return out
  } catch (err) {
    // 连「没跑起来」也要留痕：这类失败以前什么都不会写，最难排查
    writeRun([], err)
    throw err
  }
}

/** 按用户启用的全部维度精读一篇论文 */
export async function runSummarize(
  paperId: string,
  extraInstruction?: string
): Promise<AiTaskResult> {
  // 设置里存的是「关掉了哪些」，这里换算成实际要跑的维度
  const enabled = enabledLensIds(getSettings().disabledLenses)
  const { result } = await runLenses(paperId, enabled, extraInstruction)
  return result
}

/* ------------------------------------------------------------------ */
/*  实验画像：单独抽取，便宜且可批量重跑                                 */
/* ------------------------------------------------------------------ */

/**
 * 只跑「实验画像抽取」这一个维度。
 * 比全量精读便宜得多（只投喂实验相关章节、只输出结构化字段，不写任何章节），
 * 适合「补齐画像」批量执行。
 */
export async function runBuildProfile(paperId: string): Promise<AiTaskResult> {
  const row = db.getPaperRow(paperId)
  if (!row) throw new Error('论文不存在。')
  const title = String(row.title ?? '')

  // 只跑一个维度，所以要并回上一次的完整记录（否则状态条会只剩「实验画像抽取」）
  const { result, outcomes } = await runLenses(paperId, ['experiment'], undefined, {
    mergeRunRecord: true
  })
  const outcome = outcomes.find((o) => o.lensId === 'experiment')
  if (!outcome?.ok) {
    throw new LlmError(outcome?.message ?? result.message)
  }
  return { ok: true, paperId, message: `已抽取《${title}》的实验画像` }
}

export async function runBuildProfiles(ids: string[] | 'missing'): Promise<BulkResult> {
  requireVault()
  const targets =
    ids === 'missing'
      ? db.listPaperRows().filter((p) => !hasProfile(p.exp)).map((p) => p.id)
      : ids.filter(Boolean)

  if (!targets.length) {
    return { ok: true, total: 0, succeeded: 0, failed: 0, message: '没有需要抽取的论文' }
  }

  let succeeded = 0
  let cancelled = false
  const failures: string[] = []

  for (let i = 0; i < targets.length; i++) {
    /*
     * 取消要在这里拦，不能只靠下面捕获 `LlmError.cancelled` ——
     * runBuildProfile 把失败统一包装成了不带该标记的 LlmError，那个判断永远不成立；
     * 而信号一旦中断，每篇都会在 chatCompletion 入口立刻抛，于是飞快把剩下几十篇
     * 空跑一遍，最后报出一个毫无意义的「完成 3/50」。直接看信号最可靠。
     */
    if (currentSignal()?.aborted) {
      cancelled = true
      break
    }
    emitProgress('profile', `正在抽取实验画像 ${i + 1}/${targets.length}…`, targets[i])
    try {
      await runBuildProfile(targets[i])
      succeeded++
    } catch (err) {
      /*
       * 用户取消：立刻停下。否则会因为 signal 已中断而把剩下的论文空跑一遍，
       * 每次都立刻失败，最后报出一个毫无意义的「完成 3/50」。
       */
      if (err instanceof LlmError && err.cancelled) {
        cancelled = true
        break
      }
      failures.push((err as Error).message)
      // 认证 / 配置类错误继续跑剩下的也没意义，直接中断
      if (
        err instanceof LlmError &&
        (err.status === 401 || err.status === 403 || err.status === 404)
      ) {
        break
      }
    }
  }

  const failed = targets.length - succeeded
  return {
    ok: succeeded > 0,
    total: targets.length,
    succeeded,
    failed,
    /*
     * 取消必须单独说一句。落进下面的通用分支会报成
     * 「已完成 0 篇论文的实验画像抽取」—— 明明是用户自己按的取消，
     * 却看起来像是跑完了但一篇都没成，用户会去怀疑配置而不是去重跑。
     */
    message: cancelled
      ? `已取消，完成 ${succeeded}/${targets.length} 篇`
      : failures.length
        ? `完成 ${succeeded}/${targets.length} 篇。首个错误：${failures[0]}`
        : `已完成 ${succeeded} 篇论文的实验画像抽取`
  }
}

/* ------------------------------------------------------------------ */
/*  单章节重写 / 划词 / 问答                                             */
/* ------------------------------------------------------------------ */

export async function runRewriteSection(
  paperId: string,
  sectionKey: string,
  instruction?: string
): Promise<{ ok: boolean; content: string }> {
  const vaultPath = requireVault()
  const settings = getSettings()
  const row = db.getPaperRow(paperId)
  if (!row) throw new Error('论文不存在。')
  const meta = db.paperMetaFromRow(row)
  const sections = sectionsOf(paperId)
  const raw = vault.readExtractedText(vaultPath, paperId)
  const source = prepareLlmSource(raw)

  emitProgress('rewrite', `正在重写「${sectionKey}」…`, paperId)

  // 用「拥有这一节的那个维度」的 system prompt 来重写，保证口径一致：
  // 重写「英语写作短语」走英语教练，重写「写作手法 · Experiments」走写作教练。
  //（维度 prompt 里的 JSON 抽取约束由 rewrite agent 自己追加格式覆盖来压住）
  const ownerLens = lensForSection(sectionKey)
  const ownerSystem =
    resolveLenses(ownerLens ? [ownerLens] : [])[0]?.system ??
    '你是科研写作教练，负责打磨论文精读笔记中的单个章节。'

  const content = await runRewriteAgent(
    {
      ownerSystem,
      paperTitle: meta.title,
      sectionKey,
      currentContent: sections[sectionKey] ?? '',
      sourceText: source.sourceSections
        ? Object.entries(source.sourceSections)
            .map(([k, v]) => `### ${k}\n${v}`)
            .join('\n\n')
        : source.fullText,
      instruction
    },
    settings.llm
  )
  if (!content) throw new Error('模型没有返回可用内容，请重试。')

  const nextSections = { ...sections, [sectionKey]: content }
  persistPaper(meta, nextSections)
  return { ok: true, content }
}

/**
 * PDF 划词：翻译 / 解读。
 * 带上论文标题与一句话总结，让「解读」知道这段出现在什么语境里。
 */
export async function runPassage(
  input: {
    paperId: string
    mode: PassageAskMode
    text: string
    /** mode === 'ask' 时的追问内容 */
    question?: string
    /** 之前的对话（由渲染层维护） */
    history?: ChatMessage[]
    streamId: string
  },
  /**
   * 交互通道自己的一次性信号。
   *
   * 必须显式传进来，不能让 llm.ts 去拿 currentSignal()：那个是批处理任务的信号，
   * 于是「精读跑着时划词翻译」会有两个后果 —— 翻译要等精读（排队问题另说），
   * 而且用户一取消精读，翻译会被一起掐掉。
   */
  signal?: AbortSignal
): Promise<AiTextResult> {
  const settings = getSettings()
  const row = db.getPaperRow(input.paperId)
  if (!row) throw new Error('论文不存在。')
  const meta = db.paperMetaFromRow(row)
  const sections = sectionsOf(input.paperId)

  const content = await runPassageAgent(
    {
      paperTitle: meta.title,
      summary: extractTldr(sections) || undefined,
      passage: input.text,
      mode: input.mode,
      question: input.question,
      history: input.history
    },
    settings.llm,
    {
      onDelta: (delta) => emitStreamDelta(input.streamId, delta),
      // 走交互通道时由调用方给信号；不给才会退回批处理任务的信号
      signal
    }
  )

  return { ok: true, content }
}

/* ------------------------------------------------------------------ */
/*  AI 自动标重点                                                        */
/* ------------------------------------------------------------------ */

/**
 * 把「读这篇论文最不该跳过的句子」直接标在 PDF 版面上。
 *
 * 行（含页面矩形）由渲染层从 pdfjs 抽出来编好号传进来；模型只返回行号区间，
 * 位置用行号回查 —— 标的位置永远是真的，模型编不出「原文不存在的重点」。
 * 解析与合并的纯函数都在 @shared/autohighlight（smoke:parse 守着），
 * prompt 与模型调用在 agents/autohighlight，这里只负责落盘。
 *
 * 落盘语义 = 重跑标注：用户手划的高亮一条不动，旧的 AI 标注整条替换。
 */
export async function runAutoHighlight(
  paperId: string,
  rawLines: SourceLine[],
  signal?: AbortSignal
): Promise<{
  ok: boolean
  highlights?: Highlight[]
  added?: number
  truncated?: boolean
  message?: string
}> {
  const settings = getSettings()
  const row = db.getPaperRow(paperId)
  if (!row) return { ok: false, message: '论文不存在。' }
  const meta = db.paperMetaFromRow(row)

  const out = await runAutoHighlightAgents(
    {
      title: meta.title,
      lines: rawLines,
      // 章节标题来自导入时的抽取文本（按字号打上的 ## 标记）。行流和它来自
      // 两次独立抽取、行号不对应，靠标题原文在 assignLinesByKind 里文本对位
      headingTitles: extractHeadingTitles(vault.readExtractedText(requireVault(), paperId))
    },
    settings.llm,
    { signal }
  )
  if (!out) return { ok: false, message: '没有可分析的文本（可能是扫描件）。' }
  // 部分专家失败但幸存者有产出时照常落盘，只在提示里写明缺了哪类
  const failureNote = out.failedKinds.length
    ? `${out.failedKinds.join('、')}部分标注失败`
    : undefined
  if (!out.picks.length) {
    // 不覆盖已有标注：模型这次没挑出来 ≠ 这篇没有重点
    return {
      ok: false,
      message: failureNote
        ? `只有部分类型完成标注但没有挑出重点（${failureNote}），可稍后重试。`
        : '模型没有挑出值得标注的重点，可稍后重试。'
    }
  }

  const aiHighlights = buildAiHighlights(out.picks, new Date().toISOString())
  const merged = mergeAiHighlights(highlightsOf(paperId), aiHighlights)
  const detail = persistPaper({ ...meta, highlights: merged }, sectionsOf(paperId))
  return {
    ok: true,
    highlights: detail.meta.highlights ?? [],
    added: aiHighlights.length,
    truncated: out.truncated,
    message: failureNote
  }
}

/* ------------------------------------------------------------------ */
/*  「考考我」理解力自测                                                  */
/* ------------------------------------------------------------------ */

/**
 * 出一套阅读理解式的自测题，检验读者是不是真读懂了。
 *
 * 判分不在这里做（gradeQuiz 是渲染层的纯函数，对答案不烧模型调用）；
 * 解析在出题时一并生成。出过的题落进 frontmatter —— 隔几天再测一次
 * 才是复习，每次重测都重新出题就成了烧 token 的机器。
 */
export async function runQuiz(
  paperId: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; quiz?: Quiz; message?: string }> {
  const settings = getSettings()
  const row = db.getPaperRow(paperId)
  if (!row) return { ok: false, message: '论文不存在。' }
  const meta = db.paperMetaFromRow(row)

  const ctx = buildLensContext(requireVault(), paperId, meta)
  if (!ctx.fullText && !Object.keys(ctx.sourceSections).length) {
    return { ok: false, message: '这篇论文没有抽取到原文，无法出题。请先导入 PDF。' }
  }

  const quiz = await runQuizAgent(
    {
      title: meta.title,
      sourceText: sourceBlock(
        ctx,
        ['Abstract', 'Introduction', 'Method', 'Methodology', 'Experiments', 'Conclusion', 'Discussion'],
        { tail: 8000 }
      )
    },
    settings.llm,
    { signal }
  )
  if (!quiz) {
    // 有效题不足 → 报错重试，不拿残题覆盖掉已有的题
    return { ok: false, message: '模型出的题不合格（有效题目不足 3 道），可稍后重试。' }
  }

  const detail = persistPaper({ ...meta, quiz }, sectionsOf(paperId))
  return { ok: true, quiz: detail.meta.quiz }
}

/* ------------------------------------------------------------------ */
/*  演示文稿（讲给没读过这篇论文的人）                                     */
/* ------------------------------------------------------------------ */

/**
 * 把论文拆成一页页，讲给没读过它的人听。
 *
 * 和 quiz 一样是一次「点了在等」的调用：产出落进 frontmatter 的 `slides` 键，
 * 只有重新生成才会再调一次模型。
 *
 * 投喂的章节比 quiz 广一点：演示要从「为什么值得听」一路讲到「凭什么可信」，
 * 少了 Related Work（别人差在哪）和 Discussion / Limitations（边界在哪）就讲不圆。
 *
 * 生成分两步（一个产物一个 agent）：笔记里还没有流程图时，先让 agents/flow.ts
 * 照原文画一张并落进 frontmatter，再让讲稿 agent 引用它。流程图画不出来
 * （纯理论 / 综述论文）或画失败了，讲稿照常生成 —— 思维导图兜底还在。
 */
export async function runSlideDeck(
  paperId: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; deck?: SlideDeck; message?: string }> {
  const settings = getSettings()
  const row = db.getPaperRow(paperId)
  if (!row) return { ok: false, message: '论文不存在。' }
  const meta = db.paperMetaFromRow(row)

  const vaultPath = requireVault()
  const ctx = buildLensContext(vaultPath, paperId, meta)
  if (!ctx.fullText && !Object.keys(ctx.sourceSections).length) {
    return { ok: false, message: '这篇论文没有抽取到原文，无法生成演示。请先导入 PDF。' }
  }

  /*
   * 「手上有什么画面道具」必须看**磁盘上的笔记**：flow / mindmap / slides 都只存
   * frontmatter，索引行里没有这几个键（paperMetaFromRow 构造出的 meta 上恒为
   * undefined）。上一版在这里读了索引行，于是模型被亲口告知「没有思维导图，
   * 不要用 mindmap」、兜底也永远不触发 —— frontmatter 里明明有 mindmap 的论文
   * 照样生成出纯文字演示。同一种坑在 highlights 上踩过一次（见 db.ts migrate）。
   */
  const noteFile = vault.readPaperFileById(
    vaultPath,
    paperId,
    row ? String(row.rel_path ?? '') : undefined
  )
  const sections = noteFile?.sections ?? sectionsOf(paperId)
  const mindmap = noteFile?.meta.mindmap
  let flow = noteFile?.meta.flow

  // 第一步：没有流程图就先照原文画一张（独立调用、独立校验、独立落盘）
  if (!flow) {
    emitProgress('slides', '先照原文画方法流程图…', paperId)
    try {
      flow = await runMethodFlowAgent(
        {
          title: meta.title,
          sourceText: sourceBlock(
            ctx,
            ['Method', 'Methodology', 'Approach', 'Preliminaries', 'Abstract', 'Introduction'],
            { tail: 12000 }
          )
        },
        settings.llm,
        { signal }
      )
    } catch (err) {
      // 用户取消要如实中断；其他失败只丢流程图这一块，讲稿继续（思维导图兜底还在）
      if (err instanceof LlmError && err.cancelled) throw err
    }
  }
  emitProgress('slides', flow ? '流程图就绪，组织讲稿…' : '组织讲稿…', paperId)

  /*
   * 原文图要连「出现在哪一节、前后写了什么」一起给：模型看不到图本身，
   * 那是它判断这张图画什么的唯一线索（见 shared/figures.scanFigureReferences）。
   * 没被任何笔记引用过的图也列上，只是不带线索，让模型自己决定要不要用。
   */
  const referenced = scanFigureReferences(sections)
  const known = new Set(referenced.map((r) => r.relPath))
  const figures: FigureReference[] = [
    ...referenced,
    ...vault
      .listFigures(vaultPath, paperId)
      .filter((rel) => !known.has(rel))
      .map((rel) => ({ relPath: rel, section: '', excerpt: '' }))
  ]

  const deck = await runSlideDeckAgent(
    {
      title: meta.title,
      year: meta.year,
      venue: meta.venue,
      // 分类存的是 id（rag / vla…），喂给模型要换成中文名，否则它会当成缩写乱猜
      categories: categoriesForAi()
        .filter((c) => meta.categories.includes(c.id))
        .map((c) => c.label),
      sourceText: sourceBlock(
        ctx,
        [
          'Abstract',
          'Introduction',
          'Related Work',
          'Method',
          'Methodology',
          'Experiments',
          'Analysis',
          'Conclusion',
          'Discussion',
          'Limitations'
        ],
        { tail: 8000 }
      ),
      // 笔记里的「具体例子 / 方法细节」是写 example 页最好的材料
      noteExcerpt: buildSlideNotesBlock(sections),
      stage: { hasFlow: Boolean(flow), hasMindmap: Boolean(mindmap), figures }
    },
    settings.llm,
    { signal }
  )
  if (!deck) {
    // 有效页数不足 → 报错重试，不拿残稿覆盖掉已有的演示
    return { ok: false, message: '模型给的页数不够（不足 4 页），可稍后重试。' }
  }

  const available = {
    flow: Boolean(flow),
    mindmap: Boolean(mindmap),
    figures: figures.map((f) => f.relPath)
  }
  /*
   * 顺序不能反：先降级「库里没有画面」的页，再兜底补画面。
   * 反过来的话，刚补上的那一页会被降级逻辑当成「模型给的」再检查一遍，
   * 虽然结果一样，但语义会变得难读 —— 兜底补的页不该再被质疑。
   */
  const staged = ensureVisualSlides(pruneSlideVisuals(deck, available), available)
  /*
   * 盖版本号：界面靠它判断「手里这份是不是旧版生成的」（见 SLIDE_DECK_REVISION）。
   * 第一步画出的流程图一起落盘 —— 它是论文的产物，不止这一份讲稿在用；
   * 画不出来（undefined）时 writePaperFile 会保留磁盘上已有的那张（如果有）。
   */
  const detail = persistPaper(
    {
      ...meta,
      ...(flow ? { flow } : {}),
      slides: { ...staged, revision: SLIDE_DECK_REVISION }
    },
    sections
  )
  return { ok: true, deck: detail.meta.slides }
}

/* ------------------------------------------------------------------ */
/*  知识库问答                                                           */
/* ------------------------------------------------------------------ */

export async function runChat(
  paperIds: string[],
  messages: ChatMessage[]
): Promise<{ ok: boolean; content: string }> {
  const settings = getSettings()
  if (!messages.length) throw new Error('消息为空。')

  const picked: { title: string; year: number | null; categories: string[]; sections: Record<string, string> }[] =
    []
  let budget = CHAT_CONTEXT_BUDGET
  for (const id of paperIds) {
    const summary = db.getPaperSummary(id)
    if (!summary) continue
    const sections = sectionsOf(id)
    const weight = JSON.stringify(sections).length
    if (budget - weight < 0 && picked.length) break
    budget -= weight
    picked.push({
      title: summary.title,
      year: summary.year,
      categories: summary.categories,
      sections
    })
  }

  const content = await runChatAgent({ papers: picked, messages }, settings.llm)
  return { ok: true, content }
}

/* ------------------------------------------------------------------ */
/*  套路归纳                                                            */
/* ------------------------------------------------------------------ */

export function resolveScopePapers(input: SynthesisScopeInput): PaperSummary[] {
  const all = db.listPaperRows()
  if (input.type === 'category') {
    return all.filter((p) => p.categories.includes(input.value))
  }
  if (input.type === 'tag') {
    return all.filter((p) => p.tags.includes(input.value))
  }
  const ids = new Set(input.paperIds ?? [])
  return all.filter((p) => ids.has(p.id))
}

export async function runSynthesize(input: SynthesisScopeInput): Promise<AiTaskResult> {
  const vaultPath = requireVault()
  const settings = getSettings()
  const papers = resolveScopePapers(input)
  if (papers.length < 2) {
    throw new Error('至少需要 2 篇论文才能做套路归纳，请先往这个分类里补几篇。')
  }

  const catalog = categoriesForAi()
  let label = input.value
  if (input.type === 'category') {
    label = catalog.find((c) => c.id === input.value)?.label ?? input.value
  } else if (input.type === 'tag') {
    label = `标签「${input.value}」`
  } else {
    label = `选定的 ${papers.length} 篇论文`
  }

  emitProgress('synthesize', `正在归纳「${label}」的 ${papers.length} 篇论文…`)

  const payload: SynthesizeInput['papers'] = papers.slice(0, 40).map((p) => ({
    title: p.title,
    year: p.year,
    venue: p.venue,
    sections: vault.readPaperSections(vaultPath, p.id, p.relPath)
  }))

  const content = await runSynthesizeAgent(
    {
      scopeLabel: label,
      scopeType: input.type,
      focus: input.focus,
      papers: payload
    },
    settings.llm
  )
  const title = `${label} · 套路归纳`
  const id = `synthesis-${vault.slugify(label)}-${Math.random().toString(36).slice(2, 7)}`
  const now = new Date().toISOString()

  const dir = join(vaultPath, vault.VAULT_DIRS.syntheses)
  mkdirSync(dir, { recursive: true })
  const abs = join(dir, `${id}.md`)
  writeFileSync(
    abs,
    matter.stringify(content + '\n', {
      id,
      title,
      type: 'synthesis',
      scope: { type: input.type, value: input.value, paperIds: input.paperIds ?? [] },
      focus: input.focus ?? [],
      paperCount: papers.length,
      createdAt: now,
      updatedAt: now
    }),
    'utf-8'
  )

  db.upsertSynthesis({
    id,
    title,
    scope: { type: input.type, value: input.value, paperIds: input.paperIds ?? [] },
    content,
    relPath: relativeOf(abs, vaultPath),
    paperCount: papers.length,
    createdAt: now,
    updatedAt: now
  })

  return { ok: true, synthesisId: id, message: `已生成《${title}》` }
}

/* ------------------------------------------------------------------ */
/*  关系发现：在数据判定过的候选对上，逐对问模型                        */
/* ------------------------------------------------------------------ */

/**
 * 「AI 找关系」：把本篇与候选论文**逐对**交给模型判断，成立的写成 `by: 'ai'` 的提议。
 *
 * 三段职责彼此独立（详见 agents/links.ts 头注）：
 *   - 谁值得判 → shared/connections.ts 用知识图谱判定共享技术要素，数据说了算；
 *   - 是不是真有关系 → agents/links.ts 一对一次地问模型，并允许它说不成立；
 *   - 算不算数 → 这里只写「提议」，你在面板里点过采纳才成为你的关系。
 *
 * 为什么提议也落盘（而不是只回给渲染层）：判断要花钱，而且一轮几十秒。
 * 落盘之后可以关掉应用、隔天回来慢慢审，不必为了再审一遍再付一次；
 * 提议带 `by: 'ai'` 标记，在面板与图上都与你自己的判断分得开。
 */
export async function runLinkDiscovery(input: {
  paperId: string
  /** 最多判几对，默认由 connections.ts 定（6） */
  limit?: number
}): Promise<LinkDiscoveryResult> {
  const row = db.getPaperRow(input.paperId)
  if (!row) return { ok: false, message: '论文不存在。' }
  const meta = db.paperMetaFromRow(row)
  const settings = getSettings()

  // 候选完全由数据判定：只有「真正共享具体技术要素」的论文才会进来，筛不出就是空数组
  const candidates = relatedPapersFrom(input.paperId, db.listPaperRows(), input.limit)
  const existing: PaperLink[] = meta.links ?? []
  // 已经连过的不再提 —— 你确认过的、和上次 AI 提过的都算。重复提议会让人以为按钮没生效
  const fresh = candidates.filter((c) => !existing.some((l) => l.to === c.id))

  if (!fresh.length) {
    return {
      ok: true,
      links: existing,
      judged: 0,
      proposed: 0,
      message: candidates.length
        ? '这些候选都已经连过了，没有新的可判断。'
        : '库里没有与本篇真正共享技术要素的论文。硬判只会得到「都关注 XX」这类空话，所以这里不猜 —— 先去读几篇同方向的。'
    }
  }

  const ownSections = sectionsOf(input.paperId)
  const from = {
    title: meta.title,
    year: meta.year,
    venue: meta.venue,
    // 一句话总结不在 frontmatter 里，它就在章节正文里
    tldr: extractTldr(ownSections),
    digest: pickLinkDigest(ownSections)
  }

  const now = new Date().toISOString()
  const proposed: PaperLink[] = []
  let failed = 0

  for (let i = 0; i < fresh.length; i++) {
    const candidate = fresh[i]
    emitProgress(
      'relations',
      `正在判断第 ${i + 1}/${fresh.length} 对：${clipTitle(candidate.title)}`,
      input.paperId
    )

    // 已有的那些告诉模型，免得它提议一个你已经标过的类型（它也可能给出**另一个**类型，
    // 那是有信息量的：同一对关系能同时「可迁移」又「结论冲突」）
    const linked = existing
      .filter((l) => l.to === candidate.id)
      .map((l) => `${LINK_TYPE_LABEL[l.type]}（${l.by === 'ai' ? 'AI 提议，未确认' : '你已确认'}）`)

    try {
      const verdict = await runLinkJudgeAgent(
        {
          from,
          to: {
            title: candidate.title,
            year: candidate.year,
            tldr: candidate.tldr,
            digest: pickLinkDigest(sectionsOf(candidate.id))
          },
          shared: candidate.shared,
          existing: linked
        },
        settings.llm,
        { signal: currentSignal() ?? undefined }
      )
      const link = verdictToLink(verdict, candidate.id, now)
      if (link) proposed.push(link)
    } catch (err) {
      /*
       * 一对失败不该让整轮白跑：记一笔继续判下一对。
       * 取消是例外 —— 用户按了取消就该立刻停，不然要等到循环走完才响应。
       */
      if (err instanceof TaskCancelledError) throw err
      failed++
      emitProgress('relations', `第 ${i + 1} 对失败：${describeTaskError(err)}`, input.paperId)
    }
  }

  if (!proposed.length) {
    return {
      ok: true,
      links: existing,
      judged: fresh.length,
      proposed: 0,
      message: `判断了 ${fresh.length} 对候选，没有一条能给出可追溯的依据${failed ? `（另有 ${failed} 对判断失败）` : ''}。`
    }
  }

  /*
   * 落盘前重读一次：这轮跑了可能一两分钟，期间渲染层的防抖保存也许刚把你手加的关系
   * 写进磁盘 —— 拿一开始那份 meta.links 覆盖，会把那条连同这轮提议一起抹掉。
   */
  const latestRow = db.getPaperRow(input.paperId)
  const latest = latestRow ? db.paperMetaFromRow(latestRow) : meta
  const next = normalizeLinks([...(latest.links ?? []), ...proposed], input.paperId)
  persistPaper({ ...latest, links: next }, sectionsOf(input.paperId))

  return {
    ok: true,
    links: next,
    judged: fresh.length,
    proposed: proposed.length,
    message: `判断了 ${fresh.length} 对，AI 提议 ${proposed.length} 条（在「关联论文」里逐条确认）${
      failed ? `；${failed} 对判断失败，可以再点一次` : ''
    }`
  }
}

/** 进度文案里的标题截断：任务胶囊只有一行 */
function clipTitle(title: string): string {
  return title.length <= 40 ? title : `${title.slice(0, 40)}…`
}

/* ------------------------------------------------------------------ */
/*  研究想法：把已确认的关系组合成可验证的题目                          */
/* ------------------------------------------------------------------ */

/**
 * 「生成研究想法」：拿**你确认过的**论文关系，逐条组合成可验证的题目，落成一份跨论文文档。
 *
 * 为什么是这个形状（详见 shared/ideas.ts 头注）：
 *   - 想法必须站在你自己的判断上 —— `by: 'ai'` 的提议不参与；
 *   - 必须有原料（两篇的方法细节 / 局限 / 可迁移点），空笔记上只会长出空话；
 *   - 来源与依据由数据渲染，不由模型转述（转述一次就可能把「可迁移」说成「基于」）。
 *
 * 产物复用「套路归纳」那套存储（syntheses/ 文件 + 索引行 + 同一套阅读/编辑/导出），
 * 只是 scope.type 记成 'links'，用来说明它是从关系组合出来的，而不是按分类横向比对出来的。
 */
export async function runIdeaSynthesis(input: { limit?: number } = {}): Promise<AiTaskResult> {
  const settings = getSettings()
  const rows = db.listPaperRows()
  const byId = new Map(rows.map((row) => [row.id, row]))

  /*
   * 先圈定「需要读正文」的论文：只算被已确认关系牵到的那些。
   * 全库读一遍 Markdown 是没必要的（几百篇就是几百次文件读），而这份文档的取值范围
   * 本来就只由关系决定。
   */
  const needed = new Set<string>()
  let confirmedLinks = 0
  for (const row of rows) {
    for (const link of row.links ?? []) {
      if (link.by !== 'user' || link.to === row.id || !byId.has(link.to)) continue
      confirmedLinks++
      needed.add(row.id)
      needed.add(link.to)
    }
  }

  if (!confirmedLinks) {
    throw new Error(
      '还没有确认过的论文关系。想法要站在你自己的判断上 —— 先去论文详情页的「关联论文」连几条（AI 提议记得点采纳）。'
    )
  }

  const facts: IdeaSeedPaper[] = [...needed].map((id) => {
    const row = byId.get(id) as PaperSummary
    const sections = sectionsOf(id)
    return {
      id,
      title: row.title,
      year: row.year,
      tldr: row.tldr ?? '',
      method: sections['方法细节'] ?? '',
      limitation: sections['局限与未来工作'] ?? '',
      transferable: sections['可迁移到我的研究'] ?? '',
      exp: row.exp,
      links: row.links ?? []
    }
  })

  const seeds = buildIdeaSeeds(facts, input.limit)
  if (!seeds.length) {
    throw new Error(
      '这些关系两边都还没写下「方法细节 / 局限与未来工作 / 可迁移到我的研究」。原料不足时硬生成只会得到正确的废话 —— 先把这几节写一点，再回来。'
    )
  }

  const items: IdeaDocInput[] = []
  const declined: IdeaDocInput[] = []
  let failed = 0

  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i]
    emitProgress(
      'ideas',
      `正在组合第 ${i + 1}/${seeds.length} 条：${clipTitle(seed.from.title)} ↔ ${clipTitle(seed.to.title)}`
    )

    let idea: Idea
    try {
      idea = await runIdeaAgent(seed, settings.llm, { signal: currentSignal() ?? undefined })
    } catch (err) {
      /*
       * 一条失败不该让整份文档作废：记进「没能组合成题目」并写明是调用失败 ——
       * 把它和「材料不够」混在一起，用户会以为自己的笔记有问题。
       */
      if (err instanceof TaskCancelledError) throw err
      failed++
      declined.push({ seed, idea: { ok: false, reason: `调用模型失败：${describeTaskError(err)}` } })
      continue
    }
    ;(idea.ok ? items : declined).push({ seed, idea })
  }

  const at = new Date().toISOString()
  const content = renderIdeaDoc(items, declined, { at, confirmedLinks })
  const title = `研究想法 · ${items.length} 条（自 ${confirmedLinks} 条关系）`
  const id = `ideas-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const scope: SynthesisScope = { type: 'links', value: '已确认的论文关系' }
  const paperCount = needed.size

  const vaultPath = requireVault()
  const dir = join(vaultPath, vault.VAULT_DIRS.syntheses)
  mkdirSync(dir, { recursive: true })
  const abs = join(dir, `${id}.md`)
  writeFileSync(
    abs,
    matter.stringify(content, {
      id,
      title,
      type: 'synthesis',
      scope,
      paperCount,
      createdAt: at,
      updatedAt: at
    }),
    'utf-8'
  )
  db.upsertSynthesis({
    id,
    title,
    scope,
    content,
    relPath: relativeOf(abs, vaultPath),
    paperCount,
    createdAt: at,
    updatedAt: at
  })

  return {
    ok: true,
    synthesisId: id,
    message: items.length
      ? `已生成 ${items.length} 条研究想法${declined.length ? `（另有 ${declined.length} 条没能组合成题目，文档末尾写了缺什么）` : ''}${failed ? `；其中 ${failed} 条是调用失败，可以重跑` : ''}`
      : '这些关系都没能组合出可验证的题目 —— 缺什么写在文档末尾，通常是因为两边的笔记还太薄。'
  }
}

/* ------------------------------------------------------------------ */
/*  组合分析：把一组自己挑的论文放到一起，看有没有组合创新的空间          */
/* ------------------------------------------------------------------ */

/**
 * 「组合分析」：对**一组**论文整体判断有没有组合创新的空间，并给出可验证的角度
 * 与「如果合成一篇论文会是什么样」。
 *
 * 与「研究想法」的分工（详见 shared/combo.ts 头注）：想法沿着**一条已确认的关系**往前走；
 * 组合面对**一组论文**，成员之间甚至可能还没有任何关系 —— 那正是要看出来的东西。
 *
 * 为什么一次调用整组、不拆成对：组合是整体性质，「三篇凑一起」的可能性会被成对的判断丢掉。
 * 代价是材料量随篇数线性涨，所以上限 6 篇（MAX_COMBO_PAPERS）。
 */
export async function runComboAnalysis(input: {
  paperIds: string[]
  /** 组合名；留空用「A 等 N 篇」 */
  title?: string
  /**
   * 传了就是**原地重跑**：更新这份文档（成员与内容一起换新），而不是再生成一份。
   * 组合是要反复调的（换掉一篇再跑一次），每次都新建文档的话，列表很快就全是半成品。
   */
  synthesisId?: string
}): Promise<AiTaskResult> {
  const settings = getSettings()
  const ids = [...new Set(input.paperIds.filter(Boolean))]

  const rows = db.listPaperRows()
  const byId = new Map(rows.map((row) => [row.id, row]))
  // 库里已经不存在的 id 直接丢掉，但它不能悄悄把「2 篇」变成「1 篇」
  const picked = ids
    .map((id) => byId.get(id))
    .filter((row): row is PaperSummary => !!row)

  if (picked.length < MIN_COMBO_PAPERS) {
    throw new Error(`组合分析至少要 ${MIN_COMBO_PAPERS} 篇论文，而且都得还在库里。`)
  }
  if (picked.length > MAX_COMBO_PAPERS) {
    throw new Error(`一次最多分析 ${MAX_COMBO_PAPERS} 篇 —— 再多就只能「平均地看每一篇」，先分出主次。`)
  }

  emitProgress('combo', `正在分析这 ${picked.length} 篇的组合空间…`)

  const papers: ComboPaper[] = picked.map((row) => {
    const sections = sectionsOf(row.id)
    return {
      id: row.id,
      title: row.title,
      year: row.year,
      tldr: row.tldr ?? '',
      method: sections['方法细节'] ?? '',
      limitation: sections['局限与未来工作'] ?? '',
      transferable: sections['可迁移到我的研究'] ?? '',
      exp: row.exp,
      links: row.links ?? [],
      entities: (row.graph?.entities ?? []).map((entity) => ({
        name: entity.name ?? '',
        kind: String(entity.kind ?? '')
      }))
    }
  })

  // 组内已有关系与线索都由数据侧算（shared/combo.ts），模型只拿它们当参考
  const relations = collectComboRelations(papers)
  const signals = computeComboSignals(papers)

  const analysis = await runComboAgent({ papers, relations, signals }, settings.llm, {
    signal: currentSignal() ?? undefined
  })

  const at = new Date().toISOString()
  const content = renderComboDoc({ papers, relations, signals, analysis, at })
  /*
   * 重跑时沿用原来的 id / 文件位置 / 创建时间：组合的成员与内容一起换新，
   * 但它仍然是同一份文档（列表里不会因为反复调试而堆出一串半成品）。
   * 文件位置取库里记的 relPath —— 用户可能手动重命名过那个 .md。
   */
  const existing = input.synthesisId ? db.getSynthesis(input.synthesisId) : null
  const id = existing?.id ?? `combo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const name = (input.title ?? '').trim()
  const title =
    name ||
    existing?.title ||
    `组合分析 · ${clipTitle(picked[0].title)} 等 ${picked.length} 篇`
  /*
   * 存的还是对「挑出来的这几篇」的快照（paperIds）：重跑时正是靠它知道该拿哪几篇去组合，
   * 这也是「组合」这个概念的最小载体。
   */
  const scope: SynthesisScope = {
    type: 'combo',
    value: name || (existing ? existing.scope.value : '组合分析'),
    paperIds: picked.map((row) => row.id)
  }

  const vaultPath = requireVault()
  const dir = join(vaultPath, vault.VAULT_DIRS.syntheses)
  mkdirSync(dir, { recursive: true })
  const relPath = existing?.relPath || join(vault.VAULT_DIRS.syntheses, `${id}.md`)
  const abs = join(vaultPath, relPath)
  writeFileSync(
    abs,
    matter.stringify(content, {
      id,
      title,
      type: 'synthesis',
      scope,
      paperCount: picked.length,
      // 不写 createdAt：upsert 会沿用库里原值，重跑不该把「创建于」推到今天
      updatedAt: at
    }),
    'utf-8'
  )
  db.upsertSynthesis({
    id,
    title,
    scope,
    content,
    relPath,
    paperCount: picked.length,
    updatedAt: at
  })

  return {
    ok: true,
    synthesisId: id,
    message: analysis.ok
      ? `已给出 ${analysis.angles.length} 个组合角度${analysis.composite ? '，并附了一份「合成后的论文」蓝图' : ''}`
      : '这一组没能凑出可验证的角度 —— 原因写在文档里。换一组差异更大的试试，或先补几篇的「局限与未来工作」。'
  }
}
