import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowUpDown,
  Download,
  FileSpreadsheet,
  FlaskConical,
  ListPlus,
  Search,
  Table2
} from 'lucide-react'
import {
  aggregateProfiles,
  hasProfile,
  MODEL_CHOICE_COLOR,
  MODEL_CHOICE_LABEL
} from '@shared/experiment'
import type { ModelChoice } from '@shared/experiment'
import { categoryColor, categoryLabel } from '@shared/taxonomy'
import type { PaperSummary, TaxonomyNode } from '@shared/types'
import { cn, downloadText } from '@/lib/utils'
import { Button, Chip, EmptyState, Modal } from '@/components/ui'
import { useAppStore } from '@/store/useAppStore'

type ScopeType = 'all' | 'category' | 'tag'
type SortKey = 'updated' | 'year' | 'datasets' | 'baselines' | 'ablations'

const MODEL_ORDER: ModelChoice[] = ['open', 'closed', 'both', 'none', 'unclear']

export function CompareView(): JSX.Element {
  const papers = useAppStore((s) => s.papers)
  const settings = useAppStore((s) => s.settings)
  const setView = useAppStore((s) => s.setView)
  const selectPaper = useAppStore((s) => s.selectPaper)

  const [scope, setScope] = useState<{ type: ScopeType; value: string }>({
    type: 'all',
    value: ''
  })
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('updated')
  const [filling, setFilling] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const scoped = useMemo(() => {
    if (scope.type === 'category' && scope.value) {
      return papers.filter((p) => p.categories.includes(scope.value))
    }
    if (scope.type === 'tag' && scope.value) {
      return papers.filter((p) => p.tags.includes(scope.value))
    }
    return papers
  }, [papers, scope])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? scoped.filter(
          (p) =>
            p.title.toLowerCase().includes(q) ||
            (p.exp?.datasets.join(' ') ?? '').toLowerCase().includes(q) ||
            (p.exp?.metrics.join(' ') ?? '').toLowerCase().includes(q) ||
            (p.exp?.openModels.join(' ') ?? '').toLowerCase().includes(q) ||
            (p.exp?.closedModels.join(' ') ?? '').toLowerCase().includes(q)
        )
      : scoped

    const list = [...filtered]
    list.sort((a, b) => {
      switch (sort) {
        case 'year':
          return (b.year ?? 0) - (a.year ?? 0)
        case 'datasets':
          return (b.exp?.datasets.length ?? -1) - (a.exp?.datasets.length ?? -1)
        case 'baselines':
          return (b.exp?.baselines.length ?? -1) - (a.exp?.baselines.length ?? -1)
        case 'ablations':
          return (b.exp?.ablationCount ?? -1) - (a.exp?.ablationCount ?? -1)
        default:
          return a.updatedAt < b.updatedAt ? 1 : -1
      }
    })
    return list
  }, [scoped, query, sort])

  const agg = useMemo(() => aggregateProfiles(rows), [rows])
  const missing = useMemo(() => scoped.filter((p) => !hasProfile(p.exp)), [scoped])

  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of papers) for (const c of p.categories) counts.set(c, (counts.get(c) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [papers])

  const tagOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of papers) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24)
  }, [papers])

  /*
   * 表格列：默认只显示「关键列」。
   *
   * 这张表有 13 列，而窗口最窄 1120px（主进程的 minWidth）、主区扣掉左栏只剩约 824px ——
   * 13 列平均每列 63px，任何排版都塞不下，横着滚是数学结论而不是样式问题。
   * 所以把「算力 / 人工评测 / 真机 / 种子 / 方差 / 具体模型」这类**次要列**收起来：
   * 默认 7 列能一屏看完，需要时再展开（展开后横向滚动，并给出提示）。
   */
  const [allColumns, setAllColumns] = useState(false)
  const columns = useMemo(
    () => buildColumns(settings.customCategories),
    [settings.customCategories]
  )
  const visibleColumns = allColumns
    ? columns
    : columns.filter((c) => CORE_COLUMNS.includes(c.key))

  const runFill = async (): Promise<void> => {
    setConfirmOpen(false)
    setFilling(true)
    useAppStore.getState().setBusy('正在抽取实验画像…')
    try {
      const res = await window.papervault.ai.buildProfiles('missing')
      await useAppStore.getState().refreshAll()
      useAppStore.getState().toast(res.message, res.ok ? 'success' : 'error')
    } catch (err) {
      useAppStore.getState().toast(`抽取失败：${(err as Error).message}`, 'error')
    } finally {
      useAppStore.getState().setBusy(null)
      setFilling(false)
    }
  }

  const exportCsv = (): void => {
    const header = columns.map((c) => c.label)
    const body = rows.map((p) => columns.map((c) => c.text(p)))
    const csv = [header, ...body]
      .map((line) => line.map(csvCell).join(','))
      .join('\n')
    downloadText(
      `实验对比-${scopeLabel(scope, settings.customCategories)}.csv`,
      `\uFEFF${csv}`
    )
  }

  const exportMarkdown = (): void => {
    const header = `| ${columns.map((c) => c.label).join(' | ')} |`
    const divider = `| ${columns.map(() => '---').join(' | ')} |`
    const body = rows.map(
      (p) => `| ${columns.map((c) => c.text(p).replace(/\|/g, '\\|') || '—').join(' | ')} |`
    )
    const label = scopeLabel(scope, settings.customCategories)
    const summary = [
      `> 范围：${label} · 共 ${rows.length} 篇，其中 ${agg.withProfile} 篇已抽取实验画像`,
      `> 平均 ${agg.avgDatasets} 个数据集、${agg.avgBaselines} 个基线、${agg.avgAblations} 组消融；${agg.varianceReported} 篇报告了方差`,
      ''
    ].join('\n')
    downloadText(
      `实验对比-${label}.md`,
      `${summary}\n${header}\n${divider}\n${body.join('\n')}\n`
    )
  }

  if (papers.length === 0) {
    return (
      <main className="flex h-full min-w-0 flex-1 items-center justify-center bg-bg-base">
        <EmptyState
          icon={<Table2 className="h-10 w-10" />}
          title="还没有可以对比的论文"
          description="导入几篇同类论文之后，这里会把它们的实验设置拉成一张表——数据集、基线、指标、消融组数、重复次数、是否报告方差、用的是开源还是闭源模型。"
        />
      </main>
    )
  }

  return (
    <main className="h-full min-w-0 flex-1 overflow-y-auto bg-bg-base px-6 py-5">
      <div className="mx-auto max-w-[1400px] space-y-4 pb-16">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-serif text-[18px] font-semibold text-ink-high">实验对比</h1>
            <p className="mt-1 text-[12px] text-ink-mid">
              把同类论文的实验设置拉成一张表，看清这一类论文「一般怎么做实验」。
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="subtle"
              icon={<FileSpreadsheet className="h-3.5 w-3.5" />}
              onClick={exportCsv}
              disabled={!rows.length}
            >
              CSV
            </Button>
            <Button
              variant="subtle"
              icon={<Download className="h-3.5 w-3.5" />}
              onClick={exportMarkdown}
              disabled={!rows.length}
            >
              Markdown
            </Button>
            <Button
              variant="primary"
              icon={<ListPlus className="h-3.5 w-3.5" />}
              loading={filling}
              disabled={!missing.length}
              onClick={() => (missing.length > 8 ? setConfirmOpen(true) : void runFill())}
            >
              补齐画像{missing.length ? ` (${missing.length})` : ''}
            </Button>
          </div>
        </header>

        {/* 筛选栏 */}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-bg-raised px-3 py-2.5">
          <div className="flex items-center gap-1">
            {(
              [
                ['all', '全部'],
                ['category', '按分类'],
                ['tag', '按标签']
              ] as [ScopeType, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setScope({ type: key, value: '' })}
                className={cn(
                  'rounded-lg px-2.5 py-1 text-[11.5px] transition',
                  scope.type === key
                    ? 'bg-brand/20 font-medium text-brand-mist'
                    : 'text-ink-mid hover:bg-white/[0.05] hover:text-ink-high'
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {scope.type === 'category' ? (
            <div className="flex flex-wrap gap-1">
              {categoryOptions.map(([id, count]) => (
                <Chip
                  key={id}
                  color={categoryColor(id, settings.customCategories)}
                  active={scope.value === id}
                  onClick={() => setScope({ type: 'category', value: id })}
                >
                  {categoryLabel(id, settings.customCategories)}
                  <span className="opacity-70">{count}</span>
                </Chip>
              ))}
            </div>
          ) : null}

          {scope.type === 'tag' ? (
            <div className="flex flex-wrap gap-1">
              {tagOptions.map(([tag, count]) => (
                <Chip
                  key={tag}
                  active={scope.value === tag}
                  onClick={() => setScope({ type: 'tag', value: tag })}
                >
                  #{tag}
                  <span className="opacity-70">{count}</span>
                </Chip>
              ))}
            </div>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-low" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜数据集 / 指标 / 模型名"
                className="h-7 w-52 rounded-lg border border-line bg-bg-base pl-8 pr-2 text-[11.5px] text-ink-high outline-none placeholder:text-ink-low focus:border-brand/50"
              />
            </div>
            <div className="flex items-center gap-1 text-[11px] text-ink-low">
              <ArrowUpDown className="h-3 w-3" />
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="h-7 rounded-lg border border-line bg-bg-base px-1.5 text-[11.5px] text-ink-mid outline-none focus:border-brand/50"
              >
                <option value="updated" className="bg-bg-overlay">
                  最近更新
                </option>
                <option value="year" className="bg-bg-overlay">
                  年份
                </option>
                <option value="datasets" className="bg-bg-overlay">
                  数据集数
                </option>
                <option value="baselines" className="bg-bg-overlay">
                  基线数
                </option>
                <option value="ablations" className="bg-bg-overlay">
                  消融组数
                </option>
              </select>
            </div>
          </div>
        </div>

        {missing.length ? (
          <div className="flex items-center gap-2 rounded-xl border border-warn/30 bg-warn/[0.07] px-3.5 py-2.5 text-[11.5px] text-warn">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            当前范围内有 {missing.length} 篇还没有实验画像，它们不会进入下面的统计。
            可以点右上角「补齐画像」批量抽取（只读实验章节，比整篇精读便宜很多）。
          </div>
        ) : null}

        {/* 汇总 */}
        {/*
         * 汇总卡用 `auto-fit` 栅格而不是「窗口断点的栅格」：md/xl 跟的是**窗口**宽度，
         * 而左栏固定占 236px，断点永远差一截。auto-fit 按容器宽度放得下几张摆几张，
         * 每张至少 210px，剩下的均分 —— 任何窗宽都不会溢出、也不会出现一张被拉得很长的孤儿卡。
         */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-3">
          <Card title="画像覆盖">
            <div className="text-[22px] font-semibold leading-none text-ink-high">
              {agg.withProfile}
              <span className="text-[13px] font-normal text-ink-low"> / {agg.total}</span>
            </div>
            <Progress
              value={agg.total ? Math.round((agg.withProfile / agg.total) * 100) : 0}
              color="#38735A"
            />
            <p className="mt-1.5 text-[10.5px] text-ink-low">已抽取实验画像的论文占比</p>
          </Card>

          <Card title="实验规模（均值）">
            <div className="flex items-baseline gap-4">
              <Metric value={agg.avgDatasets} label="数据集" />
              <Metric value={agg.avgBaselines} label="基线" />
              <Metric value={agg.avgAblations} label="消融组" />
            </div>
            <p className="mt-2 text-[10.5px] text-ink-low">
              消融最多的一篇做了 {agg.maxAblations} 组；{agg.realWorldCount} 篇有真机/真实场景实验
            </p>
          </Card>

          <Card title="统计严谨性">
            <div className="text-[22px] font-semibold leading-none text-ink-high">
              {agg.varianceReported}
              <span className="text-[13px] font-normal text-ink-low">
                {' '}
                / {agg.withProfile} 篇报告方差
              </span>
            </div>
            <Progress
              value={agg.withProfile ? Math.round((agg.varianceReported / agg.withProfile) * 100) : 0}
              color="#5FA983"
            />
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-low">
              {agg.runsReported} 篇说明了重复次数/种子，
              {agg.varianceNotReported} 篇明确只跑一次
            </p>
          </Card>

          <Card title="模型选型">
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
              {MODEL_ORDER.map((choice) => {
                const count = agg.modelChoice[choice]
                if (!count || !agg.withProfile) return null
                return (
                  <div
                    key={choice}
                    style={{
                      width: `${(count / agg.withProfile) * 100}%`,
                      background: MODEL_CHOICE_COLOR[choice]
                    }}
                    title={`${MODEL_CHOICE_LABEL[choice]}：${count} 篇`}
                  />
                )
              })}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {MODEL_ORDER.map((choice) => (
                <span key={choice} className="flex items-center gap-1 text-[10.5px] text-ink-mid">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: MODEL_CHOICE_COLOR[choice] }}
                  />
                  {MODEL_CHOICE_LABEL[choice]}
                  <span className="text-ink-low">{agg.modelChoice[choice]}</span>
                </span>
              ))}
            </div>
          </Card>
        </div>

        {/* 高频项：同上，按容器宽度自动决定摆两张还是三张 */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
          <FreqPanel title="最常用的数据集" items={agg.topDatasets} color="#7FA3C7" />
          <FreqPanel title="最常用的指标" items={agg.topMetrics} color="#C9973F" />
          <FreqPanel title="最常对比的基线" items={agg.topBaselines} color="#ACA3CF" />
        </div>

        {/* 表格 */}
        {rows.length === 0 ? (
          <EmptyState
            icon={<FlaskConical className="h-8 w-8" />}
            title="当前范围内没有匹配的论文"
            description="试试换一个分类，或清空搜索关键词。"
          />
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 text-[10.5px] text-ink-low">
              <span>
                {rows.length} 篇 · 显示 {visibleColumns.length}/{columns.length} 列
                {allColumns ? ' · 表格可横向滚动看全部列' : ''}
              </span>
              <button
                onClick={() => setAllColumns((v) => !v)}
                className="chip transition hover:border-strong hover:text-ink-mid"
              >
                {allColumns ? '只看关键列' : `显示全部 ${columns.length} 列`}
              </button>
            </div>
            <div className="overflow-hidden rounded-lg border border-line">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[11.5px]">
                <thead>
                  <tr className="bg-bg-raised">
                    {visibleColumns.map((c) => (
                      <th
                        key={c.key}
                        className={cn(
                          'whitespace-nowrap border-b border-line px-2.5 py-2 text-left font-medium text-ink-mid',
                          c.width
                        )}
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((paper, index) => (
                    <tr
                      key={paper.id}
                      onClick={() => {
                        setView('library')
                        void selectPaper(paper.id)
                      }}
                      className={cn(
                        'cursor-pointer border-b border-line/60 transition hover:bg-white/[0.04]',
                        index % 2 ? 'bg-white/[0.012]' : ''
                      )}
                    >
                      {visibleColumns.map((c) => (
                        <td
                          key={c.key}
                          className={cn('px-2.5 py-2 align-top text-ink-high', c.width)}
                        >
                          {c.render ? c.render(paper) : <CellText text={c.text(paper)} />}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </div>
          </>
        )}
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={`为 ${missing.length} 篇论文抽取实验画像`}
        subtitle="每篇只会读取实验相关章节，token 消耗远低于整篇精读。"
        width="max-w-lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void runFill()}>
              开始（{missing.length} 篇）
            </Button>
          </>
        }
      >
        <p className="text-[12.5px] leading-relaxed text-ink-mid">
          会逐篇顺序调用模型（模型：
          <span className="text-ink-high">{settings.llm.model || '未配置'}</span>），
          中途可以随时关掉页面，已经完成的会立即写入对应的 Markdown。
          按每篇约 2-4 千 token 估算，{missing.length} 篇大约需要{' '}
          {(missing.length * 3).toFixed(0)} 千 token 的输入量。
        </p>
      </Modal>
    </main>
  )
}

/* ------------------------------------------------------------------ */

interface ColumnDef {
  key: string
  label: string
  width: string
  text: (paper: PaperSummary) => string
  render?: (paper: PaperSummary) => JSX.Element
}

/**
 * 默认显示的「关键列」。
 *
 * 剩下的（分类 / 重复与种子 / 方差 / 具体模型 / 算力 / 人工评测 / 真机）在窗口最窄时
 * 会把表格挤到看不见 —— 关键列一屏看得完，其余的按需展开。
 * 导出仍然带**全部**列：导出是数据出口，不该被界面上的显示偏好影响。
 */
const CORE_COLUMNS = ['paper', 'year', 'datasets', 'baselines', 'metrics', 'model', 'ablation']

function buildColumns(custom: TaxonomyNode[]): ColumnDef[] {
  const list = (values?: string[]): JSX.Element => {
    if (!values?.length) return <span className="text-ink-low">—</span>
    const joined = values.join('、')
    return (
      <span className="block max-w-[150px] truncate" title={joined}>
        {joined}
      </span>
    )
  }

  return [
    {
      key: 'paper',
      label: '论文',
      width: 'min-w-[180px] max-w-[240px]',
      text: (p) => p.title,
      render: (p) => (
        <span className="block max-w-[240px] truncate font-medium" title={p.title}>
          {p.title}
        </span>
      )
    },
    {
      key: 'year',
      label: '年',
      width: 'w-14',
      text: (p) => (p.year ? String(p.year) : ''),
      render: (p) => (
        <span className="text-ink-mid">{p.year ?? '—'}</span>
      )
    },
    {
      key: 'categories',
      label: '分类',
      width: 'min-w-[120px]',
      text: (p) => p.categories.map((c) => categoryLabel(c, custom)).join(' | '),
      render: (p) =>
        p.categories.length ? (
          <div className="flex max-w-[150px] flex-wrap gap-1">
            {p.categories.slice(0, 2).map((c) => (
              <Chip key={c} color={categoryColor(c, custom)}>
                {categoryLabel(c, custom)}
              </Chip>
            ))}
          </div>
        ) : (
          <span className="text-ink-low">—</span>
        )
    },
    {
      key: 'datasets',
      label: '数据集',
      width: 'min-w-[130px]',
      text: (p) => p.exp?.datasets.join(' | ') ?? '',
      render: (p) => list(p.exp?.datasets)
    },
    {
      key: 'baselines',
      label: '基线',
      width: 'min-w-[130px]',
      text: (p) => p.exp?.baselines.join(' | ') ?? '',
      render: (p) => list(p.exp?.baselines)
    },
    {
      key: 'metrics',
      label: '指标',
      width: 'min-w-[110px]',
      text: (p) => p.exp?.metrics.join(' | ') ?? '',
      render: (p) => list(p.exp?.metrics)
    },
    {
      key: 'ablation',
      label: '消融',
      width: 'w-14',
      text: (p) => (p.exp?.ablationCount != null ? String(p.exp.ablationCount) : ''),
      render: (p) => (
        <span className={p.exp?.ablationCount != null ? 'text-ink-high' : 'text-ink-low'}>
          {p.exp?.ablationCount != null ? `${p.exp.ablationCount} 组` : '—'}
        </span>
      )
    },
    {
      key: 'runs',
      label: '重复 / 种子',
      width: 'min-w-[150px]',
      text: (p) => p.exp?.runs ?? '',
      render: (p) =>
        p.exp?.runs ? (
          <span className="block max-w-[200px] truncate text-ink-mid" title={p.exp.runs}>
            {p.exp.runs}
          </span>
        ) : (
          <span className="text-ink-low">—</span>
        )
    },
    {
      key: 'variance',
      label: '方差',
      width: 'w-16',
      text: (p) =>
        p.exp?.reportsVariance == null ? '' : p.exp.reportsVariance ? '是' : '否',
      render: (p) => {
        if (p.exp?.reportsVariance == null) return <span className="text-ink-low">—</span>
        return p.exp.reportsVariance ? (
          <span className="text-ok">是</span>
        ) : (
          <span className="text-warn">否</span>
        )
      }
    },
    {
      key: 'model',
      label: '模型选型',
      width: 'min-w-[90px]',
      text: (p) => (p.exp ? MODEL_CHOICE_LABEL[p.exp.modelChoice] : ''),
      render: (p) =>
        p.exp && p.exp.modelChoice !== 'unclear' ? (
          <Chip color={MODEL_CHOICE_COLOR[p.exp.modelChoice]}>
            {MODEL_CHOICE_LABEL[p.exp.modelChoice]}
          </Chip>
        ) : (
          <span className="text-ink-low">—</span>
        )
    },
    {
      key: 'models',
      label: '具体模型',
      width: 'min-w-[160px]',
      text: (p) =>
        [...(p.exp?.openModels ?? []), ...(p.exp?.closedModels ?? [])].join(' | '),
      render: (p) => {
        const names = [...(p.exp?.openModels ?? []), ...(p.exp?.closedModels ?? [])]
        if (!names.length) return <span className="text-ink-low">—</span>
        const joined = names.join('、')
        return (
          <span className="block max-w-[200px] truncate text-ink-mid" title={joined}>
            {joined}
          </span>
        )
      }
    },
    {
      key: 'compute',
      label: '算力',
      width: 'min-w-[120px]',
      text: (p) => p.exp?.compute ?? '',
      render: (p) =>
        p.exp?.compute ? (
          <span className="block max-w-[160px] truncate text-ink-mid" title={p.exp.compute}>
            {p.exp.compute}
          </span>
        ) : (
          <span className="text-ink-low">—</span>
        )
    },
    {
      key: 'humanEval',
      label: '人工评测',
      width: 'min-w-[120px]',
      text: (p) => p.exp?.humanEval ?? '',
      render: (p) =>
        p.exp?.humanEval ? (
          <span className="block max-w-[160px] truncate text-ink-mid" title={p.exp.humanEval}>
            {p.exp.humanEval}
          </span>
        ) : (
          <span className="text-ink-low">—</span>
        )
    },
    {
      key: 'realWorld',
      label: '真机',
      width: 'w-14',
      text: (p) => (p.exp?.realWorld == null ? '' : p.exp.realWorld ? '是' : '否'),
      render: (p) => {
        if (p.exp?.realWorld == null) return <span className="text-ink-low">—</span>
        return p.exp.realWorld ? (
          <span className="text-ok">是</span>
        ) : (
          <span className="text-ink-low">否</span>
        )
      }
    }
  ]
}

function CellText({ text }: { text: string }): JSX.Element {
  if (!text) return <span className="text-ink-low">—</span>
  return (
    <span className="block max-w-[150px] truncate" title={text}>
      {text}
    </span>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="card p-3.5">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-low">
        {title}
      </div>
      {children}
    </section>
  )
}

function Metric({ value, label }: { value: number; label: string }): JSX.Element {
  return (
    <div>
      <div className="text-[20px] font-semibold leading-none text-ink-high">{value}</div>
      <div className="mt-1 text-[10.5px] text-ink-low">{label}</div>
    </div>
  )
}

function Progress({ value, color }: { value: number; color: string }): JSX.Element {
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${Math.min(100, value)}%`, background: color }}
      />
    </div>
  )
}

function FreqPanel({
  title,
  items,
  color
}: {
  title: string
  items: { name: string; count: number }[]
  color: string
}): JSX.Element {
  const max = Math.max(1, ...items.map((i) => i.count))
  return (
    <section className="card p-3.5">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-low">
        {title}
      </div>
      {items.length === 0 ? (
        <p className="py-2 text-[11.5px] text-ink-low">还没有数据</p>
      ) : (
        <div className="space-y-1.5">
          {items.map((item) => (
            <div key={item.name} className="flex items-center gap-2">
              <span
                className="w-28 shrink-0 truncate text-[11px] text-ink-mid"
                title={item.name}
              >
                {item.name}
              </span>
              {/* 条子限宽：卡片被拉宽时，一根代表「2 篇」的长条会显得很空 */}
              <div className="h-3 min-w-0 max-w-[240px] flex-1 overflow-hidden rounded bg-white/[0.05]">
                <div
                  className="h-full rounded"
                  style={{
                    width: `${Math.max(6, (item.count / max) * 100)}%`,
                    background: color,
                    opacity: 0.72
                  }}
                />
              </div>
              <span className="w-6 shrink-0 text-right text-[10.5px] text-ink-low">
                {item.count}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function csvCell(value: string): string {
  const v = value ?? ''
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

function scopeLabel(
  scope: { type: ScopeType; value: string },
  custom: TaxonomyNode[]
): string {
  if (scope.type === 'all') return '全部'
  if (scope.type === 'category') return categoryLabel(scope.value, custom)
  return `#${scope.value}`
}
