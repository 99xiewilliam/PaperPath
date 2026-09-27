import type { LensId, LensRunEntry, LensRunRecord } from '@shared/lenses'
import type { LlmSettings, PaperMeta } from '@shared/types'
import { chatCompletion, extractJson, LlmError } from '../llm'
import { currentSignal } from '../tasks'
import { resolveLenses } from './index'
import type { Lens, LensContext } from './types'

export interface LensRunOutcome {
  lensId: LensId
  label: string
  ok: boolean
  message: string
  /** 成功但产出不全（只产出 2/3 节 / 被截断）；失败时为空 */
  note?: string
  sectionCount: number
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
    try {
      const prompt = lens.prompt(ctx)
      const res = await chatCompletion(
        [
          { role: 'system', content: lens.system },
          {
            role: 'user',
            content: options.extraInstruction
              ? `${prompt}\n\n# 用户附加要求\n${options.extraInstruction}`
              : prompt
          }
        ],
        llm,
        { json: true, maxTokens: Math.max(llm.maxTokens, lens.meta.maxTokens) }
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
        sectionCount: produced.length
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
        sectionCount: 0
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
    note: o.note
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

  return { finishedAt: new Date().toISOString(), status, message, lenses }
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
      ? { id: o.lensId, label: o.label, ok: o.ok, message: o.message, note: o.note }
      : l
  })
  // 这次跑了、但上次记录里没有的维度（比如期间新启用了一个）补在末尾
  for (const o of outcomes) {
    if (!previous.lenses.some((l) => l.id === o.lensId)) {
      lenses.push({ id: o.lensId, label: o.label, ok: o.ok, message: o.message, note: o.note })
    }
  }

  const cancelled =
    (failure instanceof LlmError && failure.cancelled) ||
    lenses.some((l) => !l.ok && l.message.includes('任务已取消'))
  const failed = lenses.filter((l) => !l.ok)

  let status: LensRunRecord['status']
  if (cancelled) status = 'cancelled'
  else if (failure) status = 'failed'
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

  return { finishedAt: new Date().toISOString(), status, message, lenses }
}
