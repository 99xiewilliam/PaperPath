/**
 * AI 精读链路的端到端冒烟测试（不启动 Electron）。
 *
 * 走的是和 App 完全相同的代码：.env 配置 → PDF 抽取 → 章节切分 →
 * **按维度分别调用模型**（src/main/lenses/run.ts 的 runLensPipeline）
 * → 解析 → 渲染成 Markdown。
 *
 * 用法：
 *   npm run smoke:ai -- --ping                        # 连通性 + 模型列表
 *   npm run smoke:ai -- --list-models                 # 打印全部可用模型 id
 *   npm run smoke:ai -- --selfcheck                   # 只测 JSON 解析器（免费）
 *   npm run smoke:ai -- --lenses                      # 列出所有分析维度
 *   npm run smoke:ai -- "<pdf>" --dry                 # 只打印 Prompt（免费）
 *   npm run smoke:ai -- "<pdf>"                       # 跑全部维度
 *   npm run smoke:ai -- "<pdf>" --only=english,visuals  # 只跑指定维度
 *   npm run smoke:ai -- "<pdf>" --max-tokens=16384    # 复刻 App 的输出上限（默认 8192）
 *   npm run smoke:ai -- "<pdf>" --dump                # 额外写出 Markdown 文件
 */
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { LENS_META, allLensIds, type LensId } from '@shared/lenses'
import { profileCompleteness } from '@shared/experiment'
import { BUILTIN_CATEGORIES } from '@shared/taxonomy'
import { SECTION_ORDER } from '@shared/template'
import { blankPaperMeta, readPaperFile, writePaperFile } from '../src/main/vault'
import { chatCompletion, extractJson } from '../src/main/llm'
import { estimateTokens, prepareLlmSource } from '../src/main/papertext'
import { runLensPipeline } from '../src/main/lenses/run'
import { baseLensContext, type LensContext } from '../src/main/lenses/types'
import { parseEnvFile } from '../src/main/settings'
import { assemblePdfText, buildLines, type LineInfo, type TextItemLike } from '../src/renderer/src/lib/pdfText'

/* ------------------------------------------------------------------ */
/*  参数与配置                                                          */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2)
const flags = argv.filter((a) => a.startsWith('--'))
const positional = argv.filter((a) => !a.startsWith('--'))
const has = (name: string): boolean => flags.some((f) => f === `--${name}`)
const valueOf = (name: string): string | undefined => {
  const hit = flags.find((f) => f.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

function loadEnv(): Record<string, string> {
  const candidates = [valueOf('env'), resolve(process.cwd(), '.env'), resolve(__dirname, '../.env')].filter(
    Boolean
  ) as string[]
  for (const file of candidates) {
    if (file && existsSync(file)) {
      console.log(`（配置来源：${file}）`)
      return parseEnvFile(readFileSync(file, 'utf-8'))
    }
  }
  console.log('（未找到 .env，将使用进程环境变量）')
  return {}
}

const envValues = loadEnv()

function readVar(...names: string[]): string | undefined {
  for (const name of names) {
    const raw = process.env[name] ?? envValues[name]
    if (raw != null && String(raw).trim() !== '') return String(raw).trim()
  }
  return undefined
}

/**
 * 默认 8192，但 App 用的是 settings.json 里的 16384（`Math.max(llm.maxTokens, 维度值)`）。
 * 两边不一致时会出现「脚本能跑、App 全失败」这种最难查的现象——所以留一个开关，
 * 需要复刻 App 时就 `--max-tokens=16384`。
 */
const maxTokens = ((): number => {
  const raw = valueOf('max-tokens')
  const n = raw ? Number(raw) : Number.NaN
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 8192
})()

const llm = {
  baseUrl: valueOf('base-url') ?? readVar('PAPERVAULT_LLM_BASE_URL', 'OPENAI_BASE_URL') ?? '',
  apiKey: readVar('PAPERVAULT_LLM_API_KEY', 'OPENAI_API_KEY') ?? '',
  model: valueOf('model') ?? readVar('PAPERVAULT_LLM_MODEL', 'OPENAI_MODEL') ?? '',
  temperature: 0.3,
  maxTokens
}

function endpoint(path: string): string {
  const base = llm.baseUrl.replace(/\/+$/, '')
  const withVersion = /\/v\d+$/.test(base) ? base : `${base}/v1`
  return `${withVersion}${path}`
}

const line = (s = ''): void => console.log(s)
const rule = (): void => line('─'.repeat(64))

/* ------------------------------------------------------------------ */
/*  连通性 / 模型列表                                                    */
/* ------------------------------------------------------------------ */

async function listModels(): Promise<string[]> {
  const res = await fetch(endpoint('/models'), { headers: { Authorization: `Bearer ${llm.apiKey}` } })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  const parsed = JSON.parse(text) as { data?: { id?: string }[] }
  return (parsed.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean)
}

async function ping(): Promise<void> {
  line(`baseUrl : ${llm.baseUrl || '(空)'}`)
  line(`model   : ${llm.model || '(空)'}`)
  line(`apiKey  : ${llm.apiKey ? `${llm.apiKey.slice(0, 6)}****${llm.apiKey.slice(-4)}` : '❌ 未设置'}`)
  line('')
  try {
    const ids = await listModels()
    line(`账号可用模型共 ${ids.length} 个`)
    line(ids.includes(llm.model) ? `✅ "${llm.model}" 在可用列表中` : `⚠️  "${llm.model}" 不在可用列表中`)
  } catch (err) {
    line(`⚠️  拉取模型列表失败：${(err as Error).message}`)
  }
  line('')
  const t0 = Date.now()
  try {
    const res = await chatCompletion(
      [
        { role: 'system', content: '你是一个测试助手，只回复一个词。' },
        { role: 'user', content: '请只回复：ok' }
      ],
      llm,
      // 512 而不是 16：推理模型会把小预算全花在思考上，正文为空 → 误报「模型名不对」
      { maxTokens: 512, temperature: 0, timeoutMs: 60_000 }
    )
    line(`✅ 连通成功（${Date.now() - t0} ms）  回复：${JSON.stringify(res.content.trim())}`)
    if (res.usage) line(`用量：${JSON.stringify(res.usage)}`)
  } catch (err) {
    line(`❌ 请求失败：${(err as Error).message}`)
    process.exitCode = 1
  }
}

/* ------------------------------------------------------------------ */
/*  PDF                                                                 */
/* ------------------------------------------------------------------ */

async function extractPdf(file: string): Promise<{
  text: string
  title?: string
  authors: string[]
  pageCount: number
  headingCount: number
}> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(readFileSync(file))
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
    disableAutoFetch: true,
    disableStream: true
  }).promise

  const pageTexts: string[] = []
  const pageLines: LineInfo[][] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    try {
      const content = await page.getTextContent()
      const lines = buildLines(content.items as unknown as TextItemLike[])
      pageLines.push(lines)
      pageTexts.push(lines.map((l) => l.text).join('\n'))
    } finally {
      page.cleanup()
    }
  }

  let info: { title?: string; author?: string } = {}
  try {
    const meta = await doc.getMetadata()
    const raw = meta.info as Record<string, unknown> | undefined
    info = {
      title: typeof raw?.Title === 'string' ? raw.Title : undefined,
      author: typeof raw?.Author === 'string' ? raw.Author : undefined
    }
  } catch {
    /* ignore */
  }

  const assembled = assemblePdfText(pageTexts, pageLines, info)
  const pageCount = doc.numPages
  await doc.destroy()
  return {
    text: assembled.text,
    title: assembled.title,
    authors: assembled.authors,
    pageCount,
    headingCount: assembled.headingCount
  }
}

/* ------------------------------------------------------------------ */
/*  extractJson 自检                                                    */
/* ------------------------------------------------------------------ */

function selfCheck(): void {
  const cases: [string, string, (v: Record<string, unknown>) => boolean][] = [
    ['规范输出', '{"a": 1}', (v) => v.a === 1],
    ['markdown 围栏', '```json\n{"a": 1}\n```', (v) => v.a === 1],
    [
      '前导提示对象（zhizengzeng 实测）',
      '{"type": "json_object"}\n{"datasets": ["A"], "metrics": ["EM"]}',
      (v) => Array.isArray(v.datasets)
    ],
    ['围栏 + 前导提示对象', '```json\n{"type":"json_object"}\n{"a":1,"b":2}\n```', (v) => v.a === 1],
    ['前后有说明文字', '好的：\n{"a": 1}\n希望有帮助。', (v) => v.a === 1],
    ['字符串里含花括号', '{"note": "含 } 和 { 的文字", "a": 1}', (v) => v.a === 1],
    ['嵌套对象', '{"experiment": {"datasets": ["A"]}, "n": 1}', (v) => v.n === 1],
    [
      '截断的 JSON（数组被切断）',
      '{"phrases":[{"text":"a b c"},{"text":"d e f"},{"text":"g h',
      (v) => Array.isArray(v.phrases) && (v.phrases as unknown[]).length === 2
    ],
    [
      '截断的 JSON（对象中途断开）',
      '{"sections":{"一句话总结":"构建了 X 基准","关键收获":"部分内容',
      (v) => typeof (v.sections as Record<string, unknown>)?.['一句话总结'] === 'string'
    ]
  ]
  let pass = 0
  for (const [name, raw, check] of cases) {
    try {
      const parsed = extractJson<Record<string, unknown>>(raw)
      if (check(parsed)) {
        pass++
        line(`  ✅ ${name}`)
      } else {
        line(`  ❌ ${name} —— 结果不符：${JSON.stringify(parsed)}`)
      }
    } catch (err) {
      line(`  ❌ ${name} —— 抛错：${(err as Error).message}`)
    }
  }
  line('')
  line(`${pass}/${cases.length} 通过`)
  if (pass !== cases.length) process.exitCode = 1
}

/* ------------------------------------------------------------------ */
/*  多维度流水线                                                        */
/* ------------------------------------------------------------------ */

function resolveTargetLenses(): LensId[] {
  const only = valueOf('only')
  if (!only) return allLensIds()
  const wanted = only.split(',').map((s) => s.trim()).filter(Boolean)
  const valid = allLensIds()
  const picked = wanted.filter((id): id is LensId => (valid as string[]).includes(id))
  if (!picked.length) {
    line(`⚠️  --only 里没有有效维度，可选：${valid.join(', ')}`)
  }
  return picked
}

async function runPipeline(file: string): Promise<void> {
  const lensIds = resolveTargetLenses()

  line('── 1. 解析 PDF ───────────────────────────')
  const pdf = await extractPdf(file)
  line(`${pdf.pageCount} 页 / ${pdf.text.length} 字符 / 识别标题 ${pdf.headingCount} 个`)
  line(`标题：${pdf.title ?? '(未猜出)'}`)
  line(`作者：${pdf.authors.length ? pdf.authors.join(', ') : '(未猜出)'}`)
  line('')

  // 走和主进程同一个构造器，避免两边各拼一份导致行为不一致
  const ctx: LensContext = baseLensContext(
    prepareLlmSource(pdf.text, 60000),
    {
      title: pdf.title ?? '',
      authors: pdf.authors,
      year: null,
      venue: '',
      url: '',
      arxivId: '',
      categories: []
    },
    BUILTIN_CATEGORIES,
    {}
  )

  line('── 2. 待运行的维度 ───────────────────────')
  for (const id of lensIds) {
    const meta = LENS_META.find((l) => l.id === id)
    line(`  · ${id.padEnd(11)} ${meta?.label ?? ''}  →  ${(meta?.sections ?? []).length} 个章节`)
  }
  line('')

  if (has('dry')) {
    line('── Prompt 预览（--dry 不调用模型）─────────')
    const { resolveLenses } = await import('../src/main/lenses')
    for (const lens of resolveLenses(lensIds)) {
      const prompt = lens.prompt(ctx)
      line('')
      line(`════ ${lens.meta.label} ════`)
      line(`system：${lens.system.slice(0, 200)}…`)
      line(`user  ：${prompt.length} 字符（估算 ${estimateTokens(prompt)} tokens）`)
      line(prompt.slice(0, 900))
      line('…')
    }
    return
  }

  line('── 3. 逐维度调用模型 ─────────────────────')
  const t0 = Date.now()
  const result = await runLensPipeline(ctx, lensIds, llm, {
    concurrency: Number(valueOf('concurrency') ?? 3),
    onProgress: (message) => line(`  ${message}`)
  })
  line('')
  line(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  line('')
  line('── 4. 各维度结果 ─────────────────────────')
  for (const outcome of result.outcomes) {
    line(`  ${outcome.ok ? '✅' : '❌'} ${outcome.label.padEnd(14)} ${outcome.message}`)
  }
  line('')

  const filled = Object.keys(result.sections)
  const missing = SECTION_ORDER.filter((k) => !result.sections[k])
  line('── 5. 章节覆盖 ───────────────────────────')
  line(`  ${filled.length}/${SECTION_ORDER.length} 已填写`)
  if (missing.length) line(`  未填写：${missing.join('、')}`)
  line('')

  line('── 6. 结构化数据 ─────────────────────────')
  const exp = result.data.exp as Record<string, unknown> | undefined
  if (exp) {
    const profile = exp as unknown as Parameters<typeof profileCompleteness>[0]
    line(`  exp 完整度 ${profileCompleteness(profile)}/14　模型选型 ${exp.modelChoice}`)
    line(`  数据集：${(exp.datasets as string[])?.join('、') || '(空)'}`)
    line(`  基线  ：${(exp.baselines as string[])?.join('、') || '(空)'}`)
    line(`  指标  ：${(exp.metrics as string[])?.join('、') || '(空)'}`)
    // 模型与算力最容易因为「投喂的原文片段不全」而抽漏，单独打出来便于核对
    line(`  开源模型：${(exp.openModels as string[])?.join('、') || '(空)'}`)
    line(`  闭源模型：${(exp.closedModels as string[])?.join('、') || '(空)'}`)
    line(`  算力规模：${exp.compute || '(空)'}`)
    line(`  重复次数：${exp.runs || '(空)'}`)
    // 消融组数 / 真机实验的原文位置最靠后，最容易因为「章节被截断」而抽漏
    line(`  消融组数：${exp.ablationCount ?? '(空)'}`)
    line(`  真机实验：${exp.realWorld ?? '(空)'}`)
    line(`  备注  ：${exp.note || '(空)'}`)
  } else {
    line('  exp：（该维度未运行）')
  }
  const phrases = result.data.phrases as { category: string; text: string }[] | undefined
  if (phrases) line(`  phrases：${phrases.length} 条英语短语`)
  else line('  phrases：（该维度未运行）')
  const graph = result.data.graph as { entities: unknown[]; relations: unknown[] } | undefined
  if (graph) line(`  graph：${graph.entities.length} 个实体 / ${graph.relations.length} 条关系`)
  else line('  graph：（该维度未运行）')
  if (result.meta.categories?.length) line(`  分类：${result.meta.categories.join('、')}`)
  if (result.meta.tags?.length) line(`  标签：${result.meta.tags.join('、')}`)
  line('')

  line('── 7. 内容抽样 ───────────────────────────')
  for (const key of ['一句话总结', '英语写作短语', '图表与可视化设计']) {
    if (!result.sections[key]) continue
    line(`【${key}】`)
    line(result.sections[key].slice(0, 1200))
    line('')
  }

  if (has('dump')) {
    const meta = blankPaperMeta({
      title: pdf.title ?? '未命名论文',
      authors: pdf.authors,
      categories: (result.meta.categories ?? []) as string[],
      tags: result.meta.tags ?? [],
      status: 'reading',
      exp: result.data.exp as never,
      phrases: result.data.phrases as never,
      graph: result.data.graph as never
    })
    meta.year = null
    const demoVault = resolve(process.cwd(), '.pv-inspect/demo-vault')
    const written = writePaperFile(demoVault, meta, result.sections, [])
    const back = readPaperFile(written.absPath, demoVault)
    line('── 8. 写盘 & 回读校验 ────────────────────')
    line(`路径：${written.absPath}`)
    line(
      `回读：章节 ${Object.keys(back?.sections ?? {}).length} 个、` +
        `画像 ${profileCompleteness(back?.meta.exp)}/14、` +
        `短语 ${back?.meta.phrases?.length ?? 0} 条、` +
        `实体 ${back?.meta.graph?.entities.length ?? 0} 个`
    )
    line('')
    line(readFileSync(written.absPath, 'utf-8'))
  }

  line('✅ 多维度流水线跑通')
}

/* ------------------------------------------------------------------ */

;(async () => {
  if (has('lenses')) {
    for (const meta of LENS_META) {
      line(
        `${meta.id.padEnd(11)} ${meta.label.padEnd(12)} 章节 ${meta.sections.length} 个  ` +
          `${meta.needsSource ? '需原文' : '可用笔记'}  maxTokens=${meta.maxTokens}`
      )
      line(`             ${meta.description}`)
    }
    return
  }
  if (has('selfcheck')) {
    line('── extractJson 自检 ──────────────────────')
    selfCheck()
    return
  }
  if (has('list-models')) {
    for (const id of await listModels()) console.log(id)
    return
  }
  if (has('ping') || positional.length === 0) {
    await ping()
    return
  }
  await runPipeline(resolve(positional[0]))
})().catch((err) => {
  console.error('\n❌ 失败：', err instanceof Error ? err.message : err)
  process.exit(1)
})
