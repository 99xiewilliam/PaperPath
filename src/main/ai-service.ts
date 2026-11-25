/**
 * AI 能力层：精读（多维度）、章节重写、划词、标重点、知识库问答。
 *
 * 解耦约定：**每个 AI 功能一个 agent，一个文件**，自己的 system prompt、
 * 自己的 user prompt、自己的采样参数、自己的输出解析：
 *   - 精读的分析维度（一个维度一次调用）在 ./lenses/
 *   - 其余一次性功能（标重点 / 划词 / 重写 / 问答）在 ./agents/
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
import {
  buildAiHighlights,
  extractHeadingTitles,
  mergeAiHighlights,
  type SourceLine
} from '@shared/autohighlight'
import { emptyExperimentProfile, hasProfile } from '@shared/experiment'
import type { Highlight } from '@shared/highlights'
import { enabledLensIds, lensForSection, lensMeta, type LensId } from '@shared/lenses'
import { scanFigureReferences, type FigureReference } from '@shared/figures'
import { parseReadingSkill } from '@shared/reading-skill'
import { extractTldr } from '@shared/template'
import type { AiTaskResult, ChatMessage, PaperMeta, PaperSummary } from '@shared/types'
import type {
  AiTextResult,
  BulkResult,
  ChatOptions,
  ChatResult,
  ChatScope,
  PassageAskMode
} from '@shared/api'
import { runAutoHighlightAgents } from './agents/autohighlight'
import { ChatTurnError, runChatAgent, type ChatAgentPaper } from './agents/chat'
import { chatTools } from './chat-tools'
import { runPassageAgent } from './agents/passage'
import { runRewriteAgent } from './agents/rewrite'
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
  emitStreamStatus,
  LENS_SOURCE_LIMIT,
  relativeOf,
  requireVault
} from './runtime'
import { getSettings } from './settings'
import { currentSignal, emitProgress, TaskCancelledError } from './tasks'
import * as vault from './vault'

const DEEPREAD_SECTION = lensMeta('deepread').sections[0]

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
    skill: parseReadingSkill(vault.readReadingSkill(vaultPath))
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
      result: {
        ok: false,
        message: lensIds.length
          ? `这些分析维度已经下线，无需重跑：${lensIds.join('、')}`
          : '没有启用任何分析维度，请到「设置 → 分析维度」里勾选。'
      },
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
    // 同理：这一次没跑写作逻辑卡就沿用旧的，不要让一次局部重跑把它清空
    wlogic: (run.data.wlogic as PaperMeta['wlogic']) ?? freshMeta.wlogic,
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
      ? db
          .listPaperRows()
          .filter((p) => !hasProfile(p.exp))
          .map((p) => p.id)
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

  /*
   * 写回前重读磁盘：这次改写要跑十几秒到一分钟，用户很可能已经在**别的章节**里
   * 写了字 —— 拿开始时的快照整份覆盖会把那些改动一起抹掉。只把这次产出的那一节
   * 写进去（精读那条路就是这么做的，见 runAnalyze 里对 onDisk 的处理）。
   */
  const onDisk = sectionsOf(paperId)
  persistPaper(meta, { ...onDisk, [sectionKey]: content })
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
/*  知识库问答                                                           */
/* ------------------------------------------------------------------ */

export async function runChat(
  paperIds: string[],
  messages: ChatMessage[],
  scope?: ChatScope,
  options: ChatOptions = {},
  /** 交互通道自己的信号（理由同 runPassage） */
  signal?: AbortSignal
): Promise<ChatResult> {
  const settings = getSettings()
  if (!messages.length) throw new Error('消息为空。')

  const picked: ChatAgentPaper[] = []
  /** 笔记太长、这次没放进上下文的论文标题 */
  const omitted: string[] = []
  let budget = CHAT_CONTEXT_BUDGET
  for (const id of paperIds) {
    const summary = db.getPaperSummary(id)
    if (!summary) continue
    const sections = sectionsOf(id)
    // 导读是其余章节的长篇复述：单篇问答时它最好读，多篇时只会挤掉别的论文
    if (paperIds.length > 1) delete sections[DEEPREAD_SECTION]
    const thoughts = highlightsOf(id)
      .filter((h) => !h.ai && h.note)
      .map((h) => `- P${h.page}「${h.text.slice(0, 160)}」→ ${h.note}`)
    const weight = JSON.stringify(sections).length + thoughts.join('\n').length
    if (budget - weight < 0 && picked.length) {
      omitted.push(summary.title)
      continue
    }
    budget -= weight
    picked.push({
      id,
      title: summary.title,
      year: summary.year,
      categories: summary.categories,
      sections,
      thoughts
    })
  }

  const streamId = options.streamId
  const call = {
    signal,
    onDelta: streamId ? (delta: string) => emitStreamDelta(streamId, delta) : undefined,
    onStatus: streamId ? (status: string) => emitStreamStatus(streamId, status) : undefined
  }
  try {
    const result = await runChatAgent(
      { papers: picked, messages, scope, memo: options.memo, omitted, tools: chatTools(scope) },
      settings.llm,
      call
    )
    return {
      ok: true,
      content: result.content,
      ...(result.memo ? { memo: result.memo } : {}),
      ...(result.trace.length ? { trace: result.trace } : {}),
      ...(omitted.length ? { omitted } : {})
    }
  } catch (err) {
    // 备忘已经压好就先交出去，别让失败把这次压缩作废
    if (err instanceof ChatTurnError && err.memo) {
      return { ok: false, content: '', message: err.message, memo: err.memo }
    }
    throw err
  }
}
