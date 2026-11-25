import type { LensId, LensRunEntry, LensRunRecord, LensRunUsage } from '@shared/lenses'
import type { LlmSettings, PaperMeta } from '@shared/types'
import { chatCompletion, extractJson, fingerprint, LlmError, type LlmCallRecord } from '../llm'
import { currentSignal } from '../tasks'
import { resolveLenses } from './index'
import { lensSystemPrompt, type Lens, type LensContext } from './types'

export interface LensRunOutcome {
  lensId: LensId
  label: string
  ok: boolean
  message: string
  /** 成功但产出不全（只产出 2/3 节 / 被截断）；失败时为空 */
  note?: string
  sectionCount: number
  /** 这个维度花了多少；失败也有 —— 失败的调用一样计费 */
  usage?: LensRunUsage
}

export interface LensPipelineResult {
  /** 合并后的章节（已叠加上已有内容） */
  sections: Record<string, string>
  /** 各维度产出的结构化数据（exp / phrases / graph） */
  data: Record<string, unknown>
  /** 需要合并进 meta 的字段（分类、标签） */
  meta: Partial<PaperMeta>
  outcomes: LensRunOutcome[]
  /** 是否至少有一个维度成功 */
  ok: boolean
}

export interface LensPipelineOptions {
  extraInstruction?: string
  /** 并发上限：既压缩总耗时，又不至于触发服务商限流 */
  concurrency?: number
  onProgress?: (message: string, lensId: LensId) => void
}

/**
 * 单个维度的输出预算上限。
 *
 * 这个数不是「模型最多能吐多少」，而是「给到多大才既写得完、又不会一路写到超时」：
 * 12 个维度跑满一篇 36 页论文的实测输出是 4.7K~14.6K token（最长的是具体例子
 * 与写作手法这两类），32768 大约是其中最长者的两倍余量。再往上加不会让模型写得更好，
 * 只会把预算耗在思考上 —— 之前直接给 131072 时就是这么跑到 300 秒超时的。
 */
export const LENS_TOKEN_CEILING = 32768

/**
 * 单次调用的超时。
 *
 * 必须跟着预算一起放宽，否则只是把失败换个名字：实测这个端点 45~60 token/s，
 * 32768 预算理论最长要 ~12 分钟，而实测的 5K~15K 输出要 130~280 秒 ——
 * 600 秒是后者的两倍余量。只放宽预算不放宽超时，就会从
 * 「预算不够 → 正文为空」变成「预算够 → 请求超时」。
 */
export const LENS_TIMEOUT_MS = 600_000

/**
 * 一次调用的输出预算。
 *
 * 三个数一起决定：维度自己的体积预算（lens.meta.maxTokens，改 prompt 时一起调）、
 * 用户配置的全局预算、以及上面的绝对上限。规则是「维度预算是地板、配置值是天花板」：
 *
 * - **地板**：维度预设值是这个维度写满需要多少，用户把全局值调小不该把它压垮；
 * - **天花板取配置值**：推理型模型的思考 token 也从这里扣，所以 .env 里写 131072
 *   是有理由的（它是模型的硬上限），配置值更大时应当照用 —— 只由绝对上限兜住。
 *
 * 这里曾经是 `Math.min(llm.maxTokens, lens.meta.maxTokens)`，本意是防止
 * 「全局值给 131072 → 每个维度都能一直写 → 300 秒超时」。但它把 .env 里的
 * 131072 变成了死配置：每个维度只剩 2K~4K。实测一篇 42 页论文（LIBERO-MAX）
 * 12 个维度里 9 个返回空内容、3 个被截断，就是强制思考的模型把这点预算全花在
 * reasoning 上造成的 —— 而同一批论文在预算放开时是 12 个全成的。
 */
export function lensTokenBudget(lensMaxTokens: number, configuredMaxTokens?: number): number {
  const configured = configuredMaxTokens && configuredMaxTokens > 0 ? configuredMaxTokens : lensMaxTokens
  return Math.max(lensMaxTokens, Math.min(configured, LENS_TOKEN_CEILING))
}

/**
 * Multi-agent 编排：每个维度是独立的一次模型调用，
 * 有自己的 system prompt、自己的输入片段、自己的输出 schema。
 *
 * 这个函数刻意不碰 fs / db / electron，方便被脚本直接调用来做端到端验证。
 */
export async function runLensPipeline(
  ctx: LensContext,
  lensIds: LensId[],
  llm: LlmSettings,
  options: LensPipelineOptions = {}
): Promise<LensPipelineResult> {
  const lenses = resolveLenses(lensIds)
  const sections: Record<string, string> = { ...ctx.sections }
  const data: Record<string, unknown> = {}
  const outcomes: LensRunOutcome[] = []
  let metaPatch: Partial<PaperMeta> = {}
  let started = 0

  const runOne = async (lens: Lens): Promise<void> => {
    started++
    options.onProgress?.(`[${started}/${lenses.length}] ${lens.meta.label}…`, lens.id)
    /*
     * 这一笔账刻意不记在全局账本上：批处理队列与交互通道是**并行**的
     * （见 tasks.ts 的 runInteractive），全局账本会把划词翻译的调用混进精读的账里。
     * 每个维度各收各的，最后由 buildRunRecord 汇总。
     */
    let call: LlmCallRecord | undefined
    try {
      const prompt = lens.prompt(ctx)
      const res = await chatCompletion(
        [
          { role: 'system', content: lensSystemPrompt(lens, ctx) },
          {
            role: 'user',
            content: options.extraInstruction
              ? `${prompt}\n\n# 用户附加要求\n${options.extraInstruction}`
              : prompt
          }
        ],
        llm,
        {
          json: true,
          // 预算怎么算、为什么不能取 min、为什么要有上限，见 lensTokenBudget
          maxTokens: lensTokenBudget(lens.meta.maxTokens, llm.maxTokens),
          // 预算放宽之后超时必须跟着放宽，否则只是把失败换个名字
          timeoutMs: LENS_TIMEOUT_MS,
          label: `lens:${lens.id}`,
          onCall: (record) => {
            call = record
          }
        }
      )

      const output = lens.parse(extractJson(res.content), ctx)
      const produced = Object.keys(output.sections ?? {})

      // 声明了要写章节却一个都没产出 → 视作失败，不要污染笔记
      if (lens.meta.sections.length > 0 && produced.length === 0) {
        throw new LlmError('模型没有返回可用内容')
      }

      Object.assign(sections, output.sections ?? {})
      Object.assign(data, output.data ?? {})
      metaPatch = { ...metaPatch, ...(output.meta ?? {}) }

      const note = lensNote(produced.length, lens.meta.sections.length, res.truncated === true)
      outcomes.push({
        lensId: lens.id,
        label: lens.meta.label,
        ok: true,
        message: output.summary ?? '完成',
        /*
         * 产出不全单独存一个字段，不并进 message。
         * 并进去的话，summarizeOutcomes 拼出的「写作手法 · 方法与实验 ✓」会把它吞掉，
         * 状态条上就只剩一个干净的 ✓ —— 「只产出 1/3 节」又变成看不见了。
         */
        note: note || undefined,
        sectionCount: produced.length,
        usage: usageOf(call)
      })
    } catch (err) {
      outcomes.push({
        lensId: lens.id,
        label: lens.meta.label,
        ok: false,
        message:
          err instanceof LlmError
            ? `${lens.meta.label}：${err.message}`
            : `${lens.meta.label}：${(err as Error).message}`,
        sectionCount: 0,
        // 失败的调用一样计费，所以失败路径也要把用量带上
        usage: usageOf(call)
      })
    }
  }

  // 维度之间可以并发（属于同一个任务内部的并行），任务队列管的是「任务之间串行」
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, lenses.length || 1))
  const queue = [...lenses]
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        // 用户取消后不要再从队列里取新维度，否则只是白白多发几个必失败的请求
        if (currentSignal()?.aborted) break
        const lens = queue.shift()
        if (!lens) break
        await runOne(lens)
      }
    })
  )

  return {
    sections,
    data,
    meta: metaPatch,
    outcomes,
    ok: outcomes.some((o) => o.ok)
  }
}

/** 给 UI 用的一句话小结 */
export function summarizeOutcomes(outcomes: LensRunOutcome[]): string {
  const ok = outcomes.filter((o) => o.ok)
  const failed = outcomes.length - ok.length
  if (!ok.length) return outcomes[0]?.message ?? '没有维度成功'
  // 带保留的 ✓ 要把保留说出来：光一个 ✓ 会把「只产出 1/3 节」盖成「这节写好了」
  const done = ok
    .map((o) => (o.note ? `${o.label} ✓（${o.note}）` : `${o.label} ✓`))
    .join('　')
  return failed ? `${done}（${failed} 个维度失败）` : done
}

/**
 * 维度「成功」不等于「产出完整」。
 *
 * 模型可能只回了 6 节里的 1 节 —— 典型原因是输出撞上 max_tokens 被截断
 *（推理模型把大量预算花在思考上时尤其容易），而 `repairTruncatedJson` 会把
 * 它抢救成「最后一个完整值」，于是从外面看是一个干净的 ✓，界面上完全看不出
 * 少了 5 节。实测碰到过：`写作手法拆解 ✓`，但只有 Abstract 落盘。
 */
export function lensNote(produced: number, expected: number, truncated: boolean): string {
  const parts: string[] = []
  if (expected > 0 && produced < expected) parts.push(`只产出 ${produced}/${expected} 节`)
  if (truncated) parts.push('输出被 max_tokens 截断')
  return parts.join('　')
}

/** 单次调用的事实记录 → 一条用量。有的服务商不返回 usage，缺失一律按 0 计。 */
function usageOf(call: LlmCallRecord | undefined): LensRunUsage | undefined {
  if (!call) return undefined
  return {
    model: call.model,
    prompt: call.prompt,
    promptTokens: call.promptTokens ?? 0,
    completionTokens: call.completionTokens ?? 0,
    elapsedMs: call.elapsedMs,
    requests: call.requests,
    calls: 1,
    truncated: call.truncated ? 1 : 0,
    failed: call.ok ? 0 : 1
  }
}

/**
 * 把多个维度的用量合成一笔。
 *
 * `prompt` 合成「组合指纹」：各次指纹**排序后**拼接再哈希 —— 排序是必要的，并发
 * 扇出的完成顺序不固定，不排序的话同一套 prompt 每次算出来的指纹都不一样，比不了。
 * 合成之后，改了任意一个维度的 prompt 都会让运行档案里的指纹变化。
 *
 * 空数组返回 undefined 而不是一堆 0：宁可不显示，也不要显示「0 token」让人以为免费。
 */
export function mergeUsage(items: (LensRunUsage | undefined)[]): LensRunUsage | undefined {
  const list = items.filter((u): u is LensRunUsage => !!u)
  if (!list.length) return undefined
  const models = [...new Set(list.map((u) => u.model).filter(Boolean))]
  const sum = (pick: (u: LensRunUsage) => number): number =>
    list.reduce((acc, u) => acc + pick(u), 0)
  return {
    model: models.join(','),
    prompt: fingerprint(
      list
        .map((u) => u.prompt)
        .sort()
        .join('|')
    ),
    promptTokens: sum((u) => u.promptTokens),
    completionTokens: sum((u) => u.completionTokens),
    elapsedMs: sum((u) => u.elapsedMs),
    requests: sum((u) => u.requests),
    calls: sum((u) => u.calls),
    truncated: sum((u) => u.truncated),
    failed: sum((u) => u.failed)
  }
}

/**
 * 把一次精读的结局整理成可以落盘的记录。
 *
 * 关键在于把三种「没产出」分开：
 *   - 跑完了、但有维度失败 → `partial`（附每个维度的原因）
 *   - 整个流程抛错（没有原文 / 知识库没打开 / 限流…）→ `failed`
 *   - 用户取消 / 中途被杀 → `cancelled`（并写明只跑了几个维度）
 *
 * 以前这三者在界面上长得一模一样 —— 都是笔记一片空白，和「这篇论文确实
 * 没写实验设置」也无法区分，排查时只能猜。
 *
 * @param total 本次计划跑的维度数（取消时用来显示「只跑了几个」）
 */
export function buildRunRecord(
  outcomes: LensRunOutcome[],
  total: number,
  failure?: unknown
): LensRunRecord {
  const lenses = outcomes.map((o) => ({
    id: o.lensId,
    label: o.label,
    ok: o.ok,
    message: o.message,
    note: o.note,
    usage: o.usage
  }))
  const failed = lenses.filter((l) => !l.ok)
  const cancelled =
    (failure instanceof LlmError && failure.cancelled) ||
    failed.some((l) => l.message.includes('任务已取消'))

  let status: LensRunRecord['status']
  if (cancelled) status = 'cancelled'
  else if (failure) status = 'failed'
  else if (!lenses.length) status = 'failed'
  else if (!failed.length) status = 'ok'
  else if (failed.length < lenses.length) status = 'partial'
  else status = 'failed'

  const message = cancelled
    ? `已取消，本次只跑了 ${lenses.length}/${total} 个维度`
    : failure
      ? failure instanceof LlmError
        ? failure.message
        : ((failure as Error)?.message ?? String(failure))
      : summarizeOutcomes(outcomes)

  return {
    finishedAt: new Date().toISOString(),
    status,
    message,
    lenses,
    usage: mergeUsage(outcomes.map((o) => o.usage))
  }
}

/**
 * 把「只重跑了几个维度」的结局**并回**上一次的完整记录。
 *
 * 为什么必须并、不能直接覆盖：`buildRunRecord` 只记得下**本次传入的**维度。
 * 于是「9 个维度里只重试失败的那 1 个」跑完之后，状态条会变成
 * 「上次精读 · 全部成功　实验方法论 ✓」—— 看起来像整篇刚精读完，
 * 另外 8 个维度的结局反倒从界面上消失了（其中一个可能还失败着）。
 *
 * 并回来还有个好处：重试成功那一刻状态条自然转成「全部成功」（9 个维度全绿），
 * 那正是用户点重试想看到的结果。
 */
export function mergeRunRecord(
  previous: LensRunRecord | null,
  outcomes: LensRunOutcome[],
  failure?: unknown
): LensRunRecord {
  // 没有上一次的记录可并（首次运行 / 上次压根没跑起来）→ 退化成全新记录
  if (!previous?.lenses.length) return buildRunRecord(outcomes, outcomes.length, failure)

  const next = new Map(outcomes.map((o) => [o.lensId, o]))
  const lenses: LensRunEntry[] = previous.lenses.map((l) => {
    const o = next.get(l.id)
    return o
      ? { id: o.lensId, label: o.label, ok: o.ok, message: o.message, note: o.note, usage: o.usage }
      : l
  })
  // 这次跑了、但上次记录里没有的维度（比如期间新启用了一个）补在末尾
  for (const o of outcomes) {
    if (!previous.lenses.some((l) => l.id === o.lensId)) {
      lenses.push({
        id: o.lensId,
        label: o.label,
        ok: o.ok,
        message: o.message,
        note: o.note,
        usage: o.usage
      })
    }
  }

  /*
   * 取消只看**本次**的 outcomes，不看合并后的历史。
   *
   * 历史里可能留着一条「任务已取消」（上次跑到一半被中断的那个维度），
   * 拿它参与判定的话，用户之后单独重试成功、状态条也永远显示「已取消」——
   * 一个改不掉的红色状态，看起来就像重试功能坏了。
   */
  const cancelled =
    (failure instanceof LlmError && failure.cancelled) ||
    outcomes.some((o) => !o.ok && o.message.includes('任务已取消'))
  const failed = lenses.filter((l) => !l.ok)

  let status: LensRunRecord['status']
  if (cancelled) status = 'cancelled'
  else if (failure && !outcomes.length && previous.lenses.length) {
    /*
     * 部分重跑在「发出请求之前」就崩了（没原文 / 接口报错 / 知识库没打开）。
     * 这不是「整篇精读失败」—— 整体状态沿用上一次，只把 message 换成这次的
     * 错误原因。否则一条 4xx 会把另外 8 个本来成功的维度一起标成失败，
     * 状态条从「部分失败 1 个」跳到「失败」，比不重试还吓人。
     */
    status = previous.status
  } else if (failure) status = 'failed'
  else if (!lenses.length) status = 'failed'
  else if (!failed.length) status = 'ok'
  else if (failed.length < lenses.length) status = 'partial'
  else status = 'failed'

  /*
   * 文案必须点明「这是重试」：否则一句「实验方法论 ✓」会被读成
   * 一次完整精读的结果。失败/取消时沿用 buildRunRecord 的口径（原因比小结有用）。
   */
  const message = failure
    ? failure instanceof LlmError
      ? failure.message
      : ((failure as Error)?.message ?? String(failure))
    : outcomes.length
      ? `只重试了 ${outcomes.length} 个维度：${summarizeOutcomes(outcomes)}`
      : previous.message

  /*
   * usage 记的是**本次**的，不与上一次相加：它回答的是「这次重跑花了多少」。
   * 累加会让人以为整篇精读只花了这么点，也会把同一篇的消耗反复计入。
   */
  return {
    finishedAt: new Date().toISOString(),
    status,
    message,
    lenses,
    usage: mergeUsage(outcomes.map((o) => o.usage))
  }
}
