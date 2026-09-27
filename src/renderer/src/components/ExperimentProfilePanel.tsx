import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ClipboardList, FlaskConical, RotateCw } from 'lucide-react'
import {
  emptyExperimentProfile,
  MODEL_CHOICE_COLOR,
  MODEL_CHOICE_LABEL,
  profileCompleteness,
  type ExperimentProfile,
  type ModelChoice
} from '@shared/experiment'
import { cn } from '@/lib/utils'
import { Markdown } from './Markdown'
import { Button, Chip, Field } from './ui'

const MODEL_ORDER: ModelChoice[] = ['open', 'closed', 'both', 'none', 'unclear']

const MAX_SCORE = 14

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
        '[&_.md-body]:text-[12.5px] [&_.md-body]:leading-[1.7]',
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
            'flex-1 rounded-lg border px-2 py-1.5 text-[11.5px] transition',
            value === v
              ? v === true
                ? 'border-ok/50 bg-ok/12 text-ok'
                : v === false
                  ? 'border-warn/50 bg-warn/12 text-warn'
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
            <span className="text-[12.5px] font-medium text-ink-high">实验画像</span>
            <span className="text-[10.5px] text-ink-low">
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
          icon={extracting ? <RotateCw className="h-3.5 w-3.5 animate-spin" /> : <ClipboardList className="h-3.5 w-3.5" />}
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
            <p className="text-[11.5px] leading-relaxed text-warn">
              {extracted ? '上次抽取失败，下面保留的是之前的结果。' : '抽取失败，字段没有被填上。'}
              原因：{profile.error}
            </p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-ink-low">
              这和「论文没写」不是一回事 —— 限流、网关抖动这类瞬时故障已自动重试，再跑一次通常就好。
            </p>
          </div>
          <button
            onClick={onExtract}
            disabled={extracting || !hasSource}
            className="shrink-0 rounded-md border border-warn/40 px-2 py-0.5 text-[10.5px] text-warn transition hover:bg-warn/10 disabled:opacity-45"
          >
            {extracting ? '抽取中…' : '重试'}
          </button>
        </div>
      ) : null}

      <p className="text-[11px] leading-relaxed text-ink-low">
        「<span className="text-ink-mid">原文未说明</span>
        」= 论文里没写，这是一个结论而不是抽取失败，直接点进去就能手动补；
        「<span className="text-ink-mid">尚未抽取</span>
        」= 这篇还没跑过；「<span className="text-ink-mid">抽取失败</span>」= 没抽成功，上面会写明原因。
        这些字段会进入「实验对比」表格，用来横向比较同类论文的实验设计。
      </p>

      {/* 实验设置 */}
      <section className="rounded-xl border border-line bg-bg-raised p-4">
        <h4 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-ink-low">
          实验设置
        </h4>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="数据集 / 测试集" hint="用顿号或逗号分隔">
            <MarkdownField
              value={listToText(profile.datasets)}
              onChange={(next) => onChange({ datasets: textToList(next) })}
              placeholder={emptyText}
              title="例：HotpotQA、MuSiQue"
            />
          </Field>
          <Field label="对比基线" hint="不含本文方法">
            <MarkdownField
              value={listToText(profile.baselines)}
              onChange={(next) => onChange({ baselines: textToList(next) })}
              placeholder={emptyText}
              title="例：DPR、ColBERT"
            />
          </Field>
          <Field label="评估指标">
            <MarkdownField
              value={listToText(profile.metrics)}
              onChange={(next) => onChange({ metrics: textToList(next) })}
              placeholder={emptyText}
              title="例：EM、F1、Recall@10"
            />
          </Field>
          <Field label="消融 / 分析实验组数">
            <input
              type="number"
              min={0}
              value={profile.ablationCount ?? ''}
              onChange={(e) =>
                onChange({
                  ablationCount: e.target.value === '' ? null : Math.max(0, Number(e.target.value))
                })
              }
              placeholder={emptyText}
              title="没做消融就留空"
              className="field"
            />
          </Field>
        </div>
      </section>

      {/* 严谨性 */}
      <section className="rounded-xl border border-line bg-bg-raised p-4">
        <h4 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-ink-low">
          实验严谨性
        </h4>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="重复次数 / 随机种子">
            <MarkdownField
              value={profile.runs}
              onChange={(next) => onChange({ runs: next })}
              placeholder={emptyText}
              title="例：3 个随机种子，报告均值±标准差"
            />
          </Field>
          <Field label="是否报告方差 / 置信区间">
            <TriState
              value={profile.reportsVariance}
              onChange={(v) => onChange({ reportsVariance: v })}
            />
          </Field>
          <Field label="人工评测规模">
            <MarkdownField
              value={profile.humanEval}
              onChange={(next) => onChange({ humanEval: next })}
              placeholder={emptyText}
              title="例：200 条样本、3 名标注者"
            />
          </Field>
          <Field label="是否有真机 / 真实场景实验">
            <TriState value={profile.realWorld} onChange={(v) => onChange({ realWorld: v })} />
          </Field>
        </div>
      </section>

      {/* 模型与算力 */}
      <section className="rounded-xl border border-line bg-bg-raised p-4">
        <h4 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-ink-low">
          模型选型与算力
        </h4>

        <Field label="模型选型" className="mb-3">
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
        </Field>

        <div className="grid gap-3 md:grid-cols-2">
          <Field label="开源模型">
            <MarkdownField
              value={listToText(profile.openModels)}
              onChange={(next) => onChange({ openModels: textToList(next) })}
              placeholder={emptyText}
              title="例：Llama-3-8B、Qwen2.5-7B"
            />
          </Field>
          <Field label="闭源 / API 模型">
            <MarkdownField
              value={listToText(profile.closedModels)}
              onChange={(next) => onChange({ closedModels: textToList(next) })}
              placeholder={emptyText}
              title="例：GPT-4o、Claude-3.5"
            />
          </Field>
          <Field label="算力规模">
            <MarkdownField
              value={profile.compute}
              onChange={(next) => onChange({ compute: next })}
              placeholder={emptyText}
              title="例：8×A100-80G"
            />
          </Field>
          <Field label="训练 / 推理规模">
            <MarkdownField
              value={profile.scale}
              onChange={(next) => onChange({ scale: next })}
              placeholder={emptyText}
              title="例：训练 2 天 / 单卡 A100"
            />
          </Field>
        </div>
      </section>

      {profile.note ? (
        <div className="rounded-xl border border-line bg-bg-raised px-4 py-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[10.5px] font-medium uppercase tracking-wider text-ink-low">
              抽取备注
            </span>
            {/*
             * 重新抽取的按钮原本只在面板顶部。但读备注的时候人已经滚到底部了，
             * 正是最想「重跑一次」的时刻，动作却在视线之外——所以在这里再放一个。
             */}
            <button
              onClick={onExtract}
              disabled={extracting || !hasSource}
              className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[10.5px] text-ink-low transition hover:border-strong hover:text-ink-mid disabled:opacity-45"
            >
              <RotateCw className={cn('h-2.5 w-2.5', extracting && 'animate-spin')} />
              重新抽取
            </button>
          </div>
          <div className="select-text text-[11.5px] text-ink-mid [&_.md-body]:text-[11.5px] [&_p]:my-1">
            <Markdown content={profile.note} />
          </div>
        </div>
      ) : null}

      {profile.extractedAt ? (
        <p className="text-[10.5px] text-ink-low">
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
