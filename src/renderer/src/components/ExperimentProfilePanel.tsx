import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ClipboardList, FlaskConical, RotateCw } from 'lucide-react'
import {
  DATA_USAGE_COLOR,
  DATA_USAGE_LABEL,
  emptyExperimentProfile,
  EXPERIMENT_KIND_COLOR,
  EXPERIMENT_KIND_LABEL,
  MODEL_CHOICE_COLOR,
  MODEL_CHOICE_LABEL,
  profileCompleteness,
  type DataUsage,
  type ExperimentProfile,
  type ExperimentRow,
  type ModelChoice
} from '@shared/experiment'
import { cn } from '@/lib/utils'
import { Markdown } from './Markdown'
import { Button, Chip } from './ui'

const MODEL_ORDER: ModelChoice[] = ['open', 'closed', 'both', 'none', 'unclear']
/** 从「全量」到「未说明」：判断难度递增，按这个顺序摆 */
const DATA_USAGE_ORDER: DataUsage[] = ['full', 'sampled', 'both', 'unclear']

/** 完整度满分。口径见 shared/experiment.ts 的 profileCompleteness，字段有增减时这里要同步 */
const MAX_SCORE = 19

/** 字段的最小高度（约两行文字）：这些值一屏经常放不下，单行看着太局促 */
const MIN_FIELD_HEIGHT = 44

function listToText(values?: string[]): string {
  return (values ?? []).join('、')
}

function textToList(text: string): string[] {
  return text
    .split(/[,，;；、\n]/)
    .map((v) => v.trim())
    .filter(Boolean)
}

/**
 * 可编辑的 Markdown 字段。
 *
 * 这两个诉求是绑在一起的，所以合成一个控件：
 *
 *   1. **要能渲染 Markdown**：模型抽出来的值自带语法
 *      （`**MatDesign Science test set**`、`**5×H100**`），单行 `input`
 *      只能把星号原样显示 —— 用户看到的是一堆记号而不是重点。非编辑态这里
 *      直接走 `Markdown` 渲染，加粗 / 列表 / 链接都能正常显示。
 *   2. **不能只有一行**：对比基线、评估指标、训练规模这些值经常长到一屏放不下，
 *      单行输入框只能左右滚动，既看不全也改不动 —— 编辑态换成**会自动长高**的
 *      多行 `textarea`，预览态同样按内容换行。
 *
 * 交互：点一下进入编辑并聚焦，失焦回到渲染态（内容始终以原文存，不做任何转换）。
 */
function MarkdownField({
  value,
  onChange,
  placeholder,
  title
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  title?: string
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  // 先归零再量 scrollHeight，否则盒子只会单调变高、删字不会缩回去
  useEffect(() => {
    const el = ref.current
    if (!editing || !el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(MIN_FIELD_HEIGHT, el.scrollHeight)}px`
  }, [editing, value])

  useEffect(() => {
    if (editing) ref.current?.focus()
  }, [editing])

  if (editing) {
    return (
      <textarea
        ref={ref}
        value={value}
        rows={2}
        spellCheck={false}
        placeholder={placeholder}
        title={title}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setEditing(false)}
        style={{ minHeight: MIN_FIELD_HEIGHT }}
        className="field resize-none leading-relaxed"
      />
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      title={title ? `${title}（点击编辑）` : '点击编辑'}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setEditing(true)
        }
      }}
      className={cn(
        // select-text：正文默认是 user-select:none，这里的值是给人复制到写作里的
        'field min-h-[44px] cursor-text select-text',
        // .md-body 是给笔记正文定的（13.5px + 段间距），塞进表单要压回字段尺寸
        '[&_.md-body]:text-ui [&_.md-body]:leading-[1.7]',
        '[&_p]:my-0 [&_ul]:my-0 [&_ol]:my-0 [&_pre]:my-1 [&_blockquote]:my-1'
      )}
    >
      {value.trim() ? (
        <Markdown content={value} />
      ) : (
        <span className="text-ink-low">{placeholder}</span>
      )}
    </div>
  )
}

/**
 * 表格单元格里的 Markdown（只读）。
 *
 * 模型抽出来的值常带 `**+3.2**` 这类记号，不渲染就是一堆星号。
 * 但表格里的正文要压到单元格尺寸 —— `.md-body` 是给笔记正文定的
 * （13.5px + 段间距），直接塞进表格会把行高撑得很难看。
 */
function MarkdownCell({ text }: { text: string }): JSX.Element {
  if (!text.trim()) return <span className="text-ink-low">—</span>
  return (
    <div className="select-text [&_.md-body]:text-meta [&_.md-body]:leading-[1.65] [&_li]:my-0 [&_p]:my-0 [&_ul]:my-0">
      <Markdown content={text} />
    </div>
  )
}

/** 「主实验 3 · 消融 4 · 分析 1」这样的一行小结 */
function kindSummary(rows: ExperimentRow[]): string {
  return (['main', 'ablation', 'analysis'] as const)
    .map((k) => [k, rows.filter((r) => r.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${EXPERIMENT_KIND_LABEL[k]} ${n}`)
    .join(' · ')
}

/**
 * 「（3）」这样的小计数。
 *
 * 抽到几条不该让人自己数 —— 「数据集 / 测试集（3）」比一串名字更能说明这一篇的
 * 实验规模，也是横向比论文时第一眼要看的东西。
 */
function countSuffix(items?: string[]): string {
  const n = items?.length ?? 0
  return n ? `（${n}）` : ''
}

/**
 * 表格里的一行：左边是标签（可带数量与说明），右边是控件。
 *
 * 为什么这些字段改用表格而不是两列表单：它们都是固定几项「标签 : 值」，
 * 表格能对齐、能一眼扫完 —— 而成组信息散在两列网格里，读的人得来回找。
 * 右侧仍然是原来的可编辑控件，所以只是换了排版，没有牺牲修改能力。
 * hint 放在标签下方而不是藏进 title：这些提示是「怎么填」的关键（顿号分隔、
 * 不含本文方法），藏起来就等于没有。
 */
function FieldRow({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <tr className="border-t border-line align-top first:border-t-0">
      <th className="w-[148px] py-2 pr-3 text-left font-normal text-ink-mid">
        {label}
        {hint ? <span className="mt-0.5 block text-caption text-ink-low">{hint}</span> : null}
      </th>
      <td className="py-2">{children}</td>
    </tr>
  )
}

function TriState({
  value,
  onChange
}: {
  value: boolean | null
  onChange: (next: boolean | null) => void
}): JSX.Element {
  const options: [string, boolean | null][] = [
    ['未说明', null],
    ['是', true],
    ['否', false]
  ]
  return (
    <div className="flex gap-1">
      {options.map(([label, v]) => (
        <button
          key={label}
          onClick={() => onChange(v)}
          className={cn(
            'flex-1 rounded-lg border px-2 py-1.5 text-meta transition',
            value === v
              ? v === true
                ? 'border-ok/50 bg-ok/[0.12] text-ok'
                : v === false
                  ? 'border-warn/50 bg-warn/[0.12] text-warn'
                  : 'border-line bg-white/[0.06] text-ink-mid'
              : 'border-line text-ink-low hover:border-strong hover:text-ink-mid'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export function ExperimentProfilePanel({
  exp,
  onChange,
  onExtract,
  extracting,
  hasSource
}: {
  exp?: ExperimentProfile
  onChange: (patch: Partial<ExperimentProfile>) => void
  onExtract: () => void
  extracting: boolean
  hasSource: boolean
}): JSX.Element {
  const profile = exp ?? emptyExperimentProfile()
  const score = profileCompleteness(profile)

  /*
   * 三种「空」必须分开说，否则用户不知道该不该点重试：
   *   抽过且有内容 → 空字段就是「原文未说明」（一个结论）
   *   抽过但失败   → 失败原因在 profile.error 里
   *   还没抽过     → 尚未抽取
   *
   * 以前这三种都显示「原文未说明」，等于把「系统出错」说成了「论文没写」——
   * 一份 14 个字段全空的画像，看起来和「这篇论文确实没写实验设置」一模一样。
   */
  const failed = Boolean(profile.error)
  const extracted = Boolean(profile.extractedAt)
  const emptyText = extracted ? '原文未说明' : failed ? '抽取失败' : '尚未抽取'
  const percent = Math.round((Math.min(score, MAX_SCORE) / MAX_SCORE) * 100)

  return (
    <div className="space-y-4">
      {/* 概览 */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-bg-raised px-4 py-3">
        <FlaskConical className="h-4 w-4 shrink-0 text-brand-soft" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-ui font-medium text-ink-high">实验画像</span>
            <span className="text-caption text-ink-low">
              完整度 {score}/{MAX_SCORE}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${percent}%`,
                background: percent >= 70 ? '#5FA983' : percent >= 35 ? '#C9973F' : '#C4584D'
              }}
            />
          </div>
        </div>
        <Button
          variant="subtle"
          icon={
            extracting ? (
              <RotateCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ClipboardList className="h-3.5 w-3.5" />
            )
          }
          disabled={extracting || !hasSource}
          onClick={onExtract}
        >
          {extracting ? '抽取中…' : 'AI 重新抽取'}
        </Button>
      </div>

      {/*
        抽取失败必须在面板上留痕。
        以前失败只体现在「所有字段都是空的」上，而空字段的占位符又叫「原文未说明」——
        于是「系统出错了」被读成了「论文没写」，用户根本不知道该重试。
      */}
      {failed ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3">
          <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0 text-warn" />
          <div className="min-w-0 flex-1">
            <p className="text-meta leading-relaxed text-warn">
              {extracted ? '上次抽取失败，下面保留的是之前的结果。' : '抽取失败，字段没有被填上。'}
              原因：{profile.error}
            </p>
            <p className="mt-1 text-caption leading-relaxed text-ink-low">
              这和「论文没写」不是一回事 —— 限流、网关抖动这类瞬时故障已自动重试，再跑一次通常就好。
            </p>
          </div>
          <button
            onClick={onExtract}
            disabled={extracting || !hasSource}
            className="shrink-0 rounded-md border border-warn/40 px-2 py-0.5 text-caption text-warn transition hover:bg-warn/10 disabled:opacity-45"
          >
            {extracting ? '抽取中…' : '重试'}
          </button>
        </div>
      ) : null}

      <p className="text-meta leading-relaxed text-ink-low">
        「<span className="text-ink-mid">原文未说明</span>
        」= 论文里没写，这是一个结论而不是抽取失败，直接点进去就能手动补； 「
        <span className="text-ink-mid">尚未抽取</span>
        」= 这篇还没跑过；「<span className="text-ink-mid">抽取失败</span>」=
        没抽成功，上面会写明原因。 这些字段会进入「实验对比」表格，用来横向比较同类论文的实验设计。
      </p>

      {/* 实验设置 */}
      <section className="rounded-xl border border-line bg-bg-raised p-4">
        <h4 className="mb-3 text-meta font-medium uppercase tracking-wider text-ink-low">
          实验设置
        </h4>
        <table className="w-full border-collapse text-meta">
          <tbody>
            <FieldRow
              label={`数据集 / 测试集${countSuffix(profile.datasets)}`}
              hint="用顿号或逗号分隔"
            >
              <MarkdownField
                value={listToText(profile.datasets)}
                onChange={(next) => onChange({ datasets: textToList(next) })}
                placeholder={emptyText}
                title="例：HotpotQA、MuSiQue"
              />
            </FieldRow>
            <FieldRow label={`对比基线${countSuffix(profile.baselines)}`} hint="不含本文方法">
              <MarkdownField
                value={listToText(profile.baselines)}
                onChange={(next) => onChange({ baselines: textToList(next) })}
                placeholder={emptyText}
                title="例：DPR、ColBERT"
              />
            </FieldRow>
            <FieldRow label={`评估指标${countSuffix(profile.metrics)}`}>
              <MarkdownField
                value={listToText(profile.metrics)}
                onChange={(next) => onChange({ metrics: textToList(next) })}
                placeholder={emptyText}
                title="例：EM、F1、Recall@10"
              />
            </FieldRow>
            <FieldRow label="消融 / 分析实验组数" hint="明细在下面的实验清单里">
              <input
                type="number"
                min={0}
                value={profile.ablationCount ?? ''}
                onChange={(e) =>
                  onChange({
                    ablationCount:
                      e.target.value === '' ? null : Math.max(0, Number(e.target.value))
                  })
                }
                placeholder={emptyText}
                title="是整数组数，不是表格行数；没做就留空"
                className="field"
              />
            </FieldRow>
          </tbody>
        </table>
      </section>

      {/* 实验清单：整块画像的重点 —— 每条实验在证明什么、得到什么结论 */}
      <section className="rounded-xl border border-line bg-bg-raised p-4">
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h4 className="text-meta font-medium uppercase tracking-wider text-ink-low">
            实验清单 · 每条在证明什么
          </h4>
          {profile.experiments.length ? (
            <span className="text-caption text-ink-low">{kindSummary(profile.experiments)}</span>
          ) : null}
        </div>
        <p className="mb-3 text-caption leading-relaxed text-ink-low">
          一行是<strong>一个实验主张</strong>（论文里那句「To verify X, we …」），不是一张结果表。
          「—」表示原文没写。这块只读——五列结构化内容不适合逐格改，要改就重新抽取， 或者直接在笔记的
          Markdown 里改。
        </p>
        {profile.experiments.length ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-meta">
              <thead>
                <tr className="text-left text-caption text-ink-low">
                  <th className="w-[68px] pb-1.5 pr-2 font-normal">类别</th>
                  <th className="pb-1.5 pr-2 font-normal">验证什么</th>
                  <th className="pb-1.5 pr-2 font-normal">怎么做的</th>
                  <th className="pb-1.5 pr-2 font-normal">结果</th>
                  <th className="pb-1.5 font-normal">结论</th>
                </tr>
              </thead>
              <tbody>
                {profile.experiments.map((row, i) => (
                  <tr key={`${row.kind}-${i}`} className="border-t border-line align-top">
                    <td className="py-2 pr-2">
                      <span
                        className="chip"
                        style={{
                          color: EXPERIMENT_KIND_COLOR[row.kind],
                          borderColor: `${EXPERIMENT_KIND_COLOR[row.kind]}88`,
                          background: `${EXPERIMENT_KIND_COLOR[row.kind]}22`
                        }}
                      >
                        {EXPERIMENT_KIND_LABEL[row.kind]}
                      </span>
                    </td>
                    <td className="py-2 pr-2 text-ink-high">
                      <MarkdownCell text={row.claim} />
                    </td>
                    <td className="py-2 pr-2 text-ink-mid">
                      <MarkdownCell text={row.setup} />
                    </td>
                    <td className="py-2 pr-2 text-ink-mid">
                      <MarkdownCell text={row.result} />
                    </td>
                    <td className="py-2 text-ink-high">
                      <MarkdownCell text={row.conclusion} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-meta leading-relaxed text-ink-low">
            {profile.extractedAt
              ? '这次抽取没有拿到实验清单。多半是原文的实验章节没被投喂到，或者模型跳过了这一段——点右上角的「重新抽取」重跑一次。'
              : '还没抽过。点「重新抽取」，它会逐条还原「在验证什么 → 看到什么 → 因此声称什么」。'}
          </p>
        )}
      </section>

      {/* 严谨性：这四项合起来就是「这篇论文的复现条件」，排成一张体检表比散在两列里好用 */}
      <section className="rounded-xl border border-line bg-bg-raised p-4">
        <h4 className="mb-3 text-meta font-medium uppercase tracking-wider text-ink-low">
          实验严谨性 / 复现条件
        </h4>
        <table className="w-full border-collapse text-meta">
          <tbody>
            <FieldRow label="重复次数 / 随机种子">
              <MarkdownField
                value={profile.runs}
                onChange={(next) => onChange({ runs: next })}
                placeholder={emptyText}
                title="例：3 个随机种子，报告均值±标准差"
              />
            </FieldRow>
            <FieldRow label="报告方差 / 置信区间" hint="只跑一次就选「否」">
              <TriState
                value={profile.reportsVariance}
                onChange={(v) => onChange({ reportsVariance: v })}
              />
            </FieldRow>
            <FieldRow label="人工评测规模">
              <MarkdownField
                value={profile.humanEval}
                onChange={(next) => onChange({ humanEval: next })}
                placeholder={emptyText}
                title="例：200 条样本、3 名标注者"
              />
            </FieldRow>
            <FieldRow label="真机 / 真实场景实验">
              <TriState value={profile.realWorld} onChange={(v) => onChange({ realWorld: v })} />
            </FieldRow>
          </tbody>
        </table>
      </section>

      {/* 模型与算力 */}
      <section className="rounded-xl border border-line bg-bg-raised p-4">
        <h4 className="mb-3 text-meta font-medium uppercase tracking-wider text-ink-low">
          模型选型与算力
        </h4>

        <table className="w-full border-collapse text-meta">
          <tbody>
            <FieldRow label="模型选型" hint="不涉及语言模型就选「不涉及」">
              <div className="flex flex-wrap gap-1">
                {MODEL_ORDER.map((choice) => (
                  <button
                    key={choice}
                    onClick={() => onChange({ modelChoice: choice })}
                    className={cn(
                      'chip transition',
                      profile.modelChoice === choice ? '' : 'text-ink-mid hover:border-strong'
                    )}
                    style={
                      profile.modelChoice === choice
                        ? {
                            color: MODEL_CHOICE_COLOR[choice],
                            borderColor: `${MODEL_CHOICE_COLOR[choice]}88`,
                            background: `${MODEL_CHOICE_COLOR[choice]}22`
                          }
                        : undefined
                    }
                  >
                    {MODEL_CHOICE_LABEL[choice]}
                  </button>
                ))}
              </div>
            </FieldRow>
            <FieldRow label={`开源模型${countSuffix(profile.openModels)}`}>
              <MarkdownField
                value={listToText(profile.openModels)}
                onChange={(next) => onChange({ openModels: textToList(next) })}
                placeholder={emptyText}
                title="例：Llama-3-8B、Qwen2.5-7B"
              />
            </FieldRow>
            <FieldRow label={`闭源 / API 模型${countSuffix(profile.closedModels)}`}>
              <MarkdownField
                value={listToText(profile.closedModels)}
                onChange={(next) => onChange({ closedModels: textToList(next) })}
                placeholder={emptyText}
                title="例：GPT-4o、Claude-3.5"
              />
            </FieldRow>
            <FieldRow label="算力规模" hint="附录的 Compute 一节最常有">
              <MarkdownField
                value={profile.compute}
                onChange={(next) => onChange({ compute: next })}
                placeholder={emptyText}
                title="例：8×A100-80G"
              />
            </FieldRow>
            <FieldRow label="训练 / 推理规模">
              <MarkdownField
                value={profile.scale}
                onChange={(next) => onChange({ scale: next })}
                placeholder={emptyText}
                title="例：训练 2 天 / 单卡 A100"
              />
            </FieldRow>
            <FieldRow
              label="评估数据"
              hint="在完整测试集上跑，还是采样一个子集 —— 两者得到的数字不能直接比"
            >
              <div className="flex flex-wrap items-center gap-1">
                {DATA_USAGE_ORDER.map((usage) => (
                  <button
                    key={usage}
                    onClick={() => onChange({ dataUsage: usage })}
                    className={cn(
                      'chip transition',
                      profile.dataUsage === usage ? '' : 'text-ink-mid hover:border-strong'
                    )}
                    style={
                      profile.dataUsage === usage
                        ? {
                            color: DATA_USAGE_COLOR[usage],
                            borderColor: `${DATA_USAGE_COLOR[usage]}88`,
                            background: `${DATA_USAGE_COLOR[usage]}22`
                          }
                        : undefined
                    }
                  >
                    {DATA_USAGE_LABEL[usage]}
                  </button>
                ))}
              </div>
            </FieldRow>
            {/*
             * 抽样做法只在「抽样 / 两者都有」时才有意义 ——
             * 全量评估时这一栏永远是空的，摆着只会让人以为漏填了。
             */}
            {profile.dataUsage === 'sampled' || profile.dataUsage === 'both' ? (
              <FieldRow label="抽样做法">
                <MarkdownField
                  value={profile.dataUsageNote}
                  onChange={(next) => onChange({ dataUsageNote: next })}
                  placeholder={emptyText}
                  title="例：从 12 万条里随机抽 2000 条"
                />
              </FieldRow>
            ) : null}
          </tbody>
        </table>
      </section>

      {profile.note ? (
        <div className="rounded-xl border border-line bg-bg-raised px-4 py-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-caption font-medium uppercase tracking-wider text-ink-low">
              抽取备注
            </span>
            {/*
             * 重新抽取的按钮原本只在面板顶部。但读备注的时候人已经滚到底部了，
             * 正是最想「重跑一次」的时刻，动作却在视线之外——所以在这里再放一个。
             */}
            <button
              onClick={onExtract}
              disabled={extracting || !hasSource}
              className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-caption text-ink-low transition hover:border-strong hover:text-ink-mid disabled:opacity-45"
            >
              <RotateCw className={cn('h-2.5 w-2.5', extracting && 'animate-spin')} />
              重新抽取
            </button>
          </div>
          <div className="select-text text-meta text-ink-mid [&_.md-body]:text-meta [&_p]:my-1">
            <Markdown content={profile.note} />
          </div>
        </div>
      ) : null}

      {profile.extractedAt ? (
        <p className="text-caption text-ink-low">
          最近抽取：{new Date(profile.extractedAt).toLocaleString('zh-CN')}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-1">
        {profile.datasets.slice(0, 6).map((d) => (
          <Chip key={`d-${d}`} color="#7FA3C7">
            {d}
          </Chip>
        ))}
        {profile.metrics.slice(0, 6).map((m) => (
          <Chip key={`m-${m}`} color="#C9973F">
            {m}
          </Chip>
        ))}
      </div>
    </div>
  )
}
