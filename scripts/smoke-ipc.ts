/**
 * IPC 层冒烟测试。
 *
 * 主进程的 IPC 注册表（`src/main/ipc.ts` 及它背后的 service 模块）一直完全没有
 * 测试覆盖 —— 因为它 import 了 electron，纯 Node 里跑不起来，只能靠手点 App 验证。
 * 这里用 `scripts/stubs/electron.ts`（esbuild 的 `--alias:electron=...`）
 * 把 electron 换成记录调用的替身，于是整条链路都能在冒烟测试里跑：
 *
 *   注册 handler → 调用 → 读写 Markdown / SQLite → 回读断言
 *
 * 覆盖：
 *   1. 频道注册完整性（重构时漏注册会被这条抓住）
 *   2. 打开知识库：目录结构 + 索引
 *   3. 新建 / 更新 / 详情：Markdown 落盘与回读
 *   4. 全文检索：能搜到笔记正文、CJK 子串、多词 AND
 *   5. 统计
 *   6. 文件授权：只有用户选过 / 拖过的 PDF 才能读字节、才能导入知识库
 *   7. PDF 预览窗口 + 路径越界防护（frontmatter 里的 `pdf` 不可信）
 *   8. 未配置 Key 时 AI 任务返回业务错误而不是抛异常，且进度广播到了渲染层
 *   9. API Key 落盘是密文
 *  10. 句式库 / 图谱返回形状
 *  11. 重新扫描：幂等，且能发现外部对 Markdown 的改动
 *  12. 删除：Markdown / PDF 副本 / 抽取文本一起清理，且绝不碰知识库外的文件
 *  13. 批量操作：增量语义（加标签不冲掉原有分类）+ 逐个清理
 *  14. Markdown 往返：正文顶部的手写前言、以及用户改过名的文件，保存后都不能丢
 *  15. 原文图表：保存 / 读取 / 列举 / 删除 / 越权防护
 *  16. 方法流程图：能写进 frontmatter，也不会被普通保存抹掉
 *  17. 阅读位置存索引 DB 不碰笔记文件；AI 高亮的 ai 标记挺过读改写
 *
 * 用法：npm run smoke:ipc
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { GraphData } from '@shared/graph'
import type { Highlight } from '@shared/highlights'
import type { PhraseEntry } from '@shared/phrases'
import type {
  AiTaskResult,
  AppSettings,
  ImportPdfResult,
  PaperDetail,
  PaperSummary,
  ScanResult,
  StatsOverview,
  VaultStatus
} from '@shared/types'
import type { BulkResult } from '@shared/api'
import { invoke, registeredChannels, resetWindows, stubState } from './stubs/electron'
import { closeDatabase } from '../src/main/db'
import { registerIpc } from '../src/main/ipc'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? `  ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log('')
  console.log(`── ${title} ──────────────────────────`)
}

/**
 * 断言这次调用会抛错，返回错误信息；没抛就返回 null。
 * 安全类断言必须用「抛没抛」来判断 —— 主进程对未授权路径是直接拒绝，
 * 不是返回一个 ok:false 的业务对象。
 */
async function rejects(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (err) {
    return (err as Error).message
  }
}

/** 期望注册的 IPC 频道。少一个都说明有 handler 被漏掉了 */
const EXPECTED_CHANNELS = [
  'vault:status',
  'vault:choose',
  'vault:open',
  'vault:rescan',
  'vault:reveal',
  'paper:openPdf',
  'paper:pdfData',
  'paper:saveHighlight',
  'paper:removeHighlight',
  'paper:getReadingPosition',
  'paper:saveReadingPosition',
  'paper:list',
  'paper:search',
  'paper:get',
  'paper:create',
  'paper:update',
  'paper:delete',
  'paper:bulkUpdate',
  'paper:bulkDelete',
  'paper:text',
  'paper:pickPdfs',
  'paper:importPdf',
  'file:readBinary',
  'file:grant',
  'arxiv:fetch',
  'ai:test',
  'ai:summarize',
  'ai:rewriteSection',
  'ai:chat',
  'ai:synthesize',
  'ai:synthesizeIdeas',
  'ai:comboAnalyze',
  'ai:discoverLinks',
  'ai:runLens',
  'ai:buildProfile',
  'ai:passage',
  'ai:autoHighlight',
  'ai:quiz',
  'ai:buildProfiles',
  'task:cancel',
  'task:state',
  'graph:snapshot',
  'graph:multiHop',
  'phrases:list',
  'synthesis:list',
  'synthesis:get',
  'synthesis:save',
  'synthesis:delete',
  'figures:save',
  'figures:read',
  'figures:list',
  'figures:delete',
  'stats:overview',
  'settings:get',
  'settings:set',
  'app:openExternal'
]

const root = mkdtempSync(join(tmpdir(), 'pv-ipc-'))
const vaultDir = join(root, 'vault')
const outsideDir = join(root, 'outside')
const sourcePdf = join(root, 'My Test Paper.pdf')

async function main(): Promise<void> {
  mkdirSync(vaultDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(sourcePdf, Buffer.from('%PDF-1.4 stub payload'))

  /*
   * settings.ts 的 .env 查找会看 process.cwd()。切到临时目录，
   * 免得测试读到项目根那份带真实 Key 的 .env。
   */
  process.chdir(root)
  for (const key of [
    'PAPERVAULT_LLM_BASE_URL',
    'PAPERVAULT_LLM_API_KEY',
    'PAPERVAULT_LLM_MODEL',
    'PAPERVAULT_VAULT_PATH',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_BASE_PATH',
    'OPENAI_MODEL'
  ]) {
    delete process.env[key]
  }

  registerIpc()

  /* ---------------------------------------------------------------- */
  section('1. IPC 频道注册完整性')
  const missing = EXPECTED_CHANNELS.filter((c) => !registeredChannels().includes(c))
  check(
    `注册了全部 ${EXPECTED_CHANNELS.length} 个频道`,
    missing.length === 0,
    missing.length ? `缺少 ${missing.join(', ')}` : ''
  )

  /* ---------------------------------------------------------------- */
  section('2. 打开知识库')
  const status = await invoke<VaultStatus>('vault:open', vaultDir)
  check('vault:open 返回已打开', status.opened === true)
  check(
    '目录结构已建立',
    existsSync(join(vaultDir, 'papers')) &&
      existsSync(join(vaultDir, 'syntheses')) &&
      existsSync(join(vaultDir, '.papervault', 'pdfs')) &&
      existsSync(join(vaultDir, '.papervault', 'texts'))
  )
  check('生成了知识库 README', existsSync(join(vaultDir, 'README.md')))
  check('初始论文数为 0', status.paperCount === 0, `paperCount=${status.paperCount}`)

  /* ---------------------------------------------------------------- */
  section('3. 新建 / 更新 / 详情')
  const created = await invoke<PaperDetail>('paper:create', {
    title: '多跳检索评测集构建',
    authors: ['张三', '李四'],
    year: 2026,
    categories: ['benchmark'],
    tags: ['检索'],
    sections: {
      一句话总结: '提出 MultiHopBench 基准，覆盖多跳检索场景。',
      实验方法论:
        '在 8×A100 上跑 3 个随机种子，报告均值±标准差；另外在 4×A800 上做了一组消融实验，共 6 组设置，全部报告了方差与 95% 置信区间，并在附录里给出完整超参数表。'
    }
  })
  const mdPath = join(vaultDir, 'papers', `${created.id}.md`)
  check('Markdown 已落盘', existsSync(mdPath))
  const mdText = readFileSync(mdPath, 'utf-8')
  check(
    'frontmatter 带上了 id 与标题',
    mdText.includes(`id: ${created.id}`) && mdText.includes('多跳检索评测集构建')
  )
  check('正文写进了章节名', mdText.includes('一句话总结') && mdText.includes('实验方法论'))
  check(
    '详情里章节内容能原样回读',
    (created.sections['一句话总结'] ?? '').includes('MultiHopBench')
  )

  const list = await invoke<PaperSummary[]>('paper:list')
  check('列表里有这篇论文', list.length === 1 && list[0].id === created.id)
  check('列表项带上了派生字段', typeof list[0].title === 'string' && list[0].hasPdf === false)

  const updated = await invoke<PaperDetail>('paper:update', {
    id: created.id,
    meta: { title: '多跳检索评测集构建（改）', importance: 5 },
    sections: {
      ...created.sections,
      实验方法论:
        '在 8×A100 上跑 3 个随机种子，报告均值±标准差。多跳检索评测集的构建方法采用人工标注加自动校验的双通道流程，共覆盖 12 个领域、4800 条样本。'
    }
  })
  check('更新后标题生效', updated.title === '多跳检索评测集构建（改）')
  check('更新后重要性生效', updated.importance === 5)
  check(
    '更新后 Markdown 同步落盘',
    readFileSync(mdPath, 'utf-8').includes('多跳检索评测集的构建方法')
  )

  const fetched = await invoke<PaperDetail | null>('paper:get', created.id)
  check('paper:get 能取回同一篇', fetched?.id === created.id)
  check('取回不存在的 id 返回 null', (await invoke('paper:get', 'no-such-id')) === null)

  /* ---------------------------------------------------------------- */
  section('4. 全文检索（走主进程的 search_blob）')
  const asciiHit = await invoke<string[]>('paper:search', '多跳检索评测集的构建方法')
  check('能搜到笔记正文里的内容', asciiHit.includes(created.id))
  const cjkHit = await invoke<string[]>('paper:search', '均值±标准差')
  check('中文子串能命中（不受分词影响）', cjkHit.includes(created.id))
  const andMiss = await invoke<string[]>('paper:search', 'MultiHopBench 完全不存在的词')
  check('多词 AND 语义：有一个词不命中就为空', andMiss.length === 0)
  const emptyQuery = await invoke<string[]>('paper:search', '   ')
  check('空查询返回空数组（调用方据此表示「不过滤」）', emptyQuery.length === 0)
  const wildcard = await invoke<string[]>('paper:search', '%')
  check('用户输入的 % 不会被当成通配符', wildcard.length === 0)

  /* ---------------------------------------------------------------- */
  section('5. 统计')
  const stats = await invoke<StatsOverview>('stats:overview')
  check('总数正确', stats.total === 1, `total=${stats.total}`)
  check('分类分布被统计到', stats.byCategory.some((c) => c.id === 'benchmark'))
  check('标签被统计到', stats.byTag.some((t) => t.tag === '检索'))
  check('实验方法论完成度被算上', stats.withExperimentNotes === 1)
  check('积累字数大于 0', stats.totalChars > 0, `chars=${stats.totalChars}`)

  /* ---------------------------------------------------------------- */
  section('6. 文件授权 + 导入 PDF（autoSummarize=false，不调用模型）')

  /*
   * `file:readBinary` 与 `paper:importPdf` 都接收渲染层传来的路径。以前只校验
   * 扩展名，等于「磁盘上任意 .pdf 都能读、都能复制进知识库再读回」。
   * 先证明未授权的路径被挡住，再走正常导入。
   */
  const outsidePdfForGrant = join(outsideDir, 'private-notes.pdf')
  writeFileSync(outsidePdfForGrant, Buffer.from('%PDF-1.4 库外的私密文件'))

  const deniedRead = await rejects(invoke('file:readBinary', outsidePdfForGrant))
  check('未授权的路径读不到字节', deniedRead !== null, deniedRead ?? '居然读到了')

  /*
   * 这里断言的是**返回值**而不是「抛异常」。
   *
   * `paper:importPdf` 被 queuedTask 包着，而 queuedTask 会把所有异常统一转成
   * `{ ok: false, message }`（见 runtime.ts）—— 这个入口永远不会 reject。
   * 以前写成 rejects(...)，于是这条断言从那天起就一直是红的，
   * 而它真正要守的东西（库外文件进不了知识库）其实一直是对的。
   */
  const deniedImport = await invoke<ImportPdfResult & { message?: string }>('paper:importPdf', {
    sourcePath: outsidePdfForGrant,
    text: '这是一段足够长的原文，用来绕过长度校验。'.repeat(20),
    autoSummarize: false
  })
  check('未授权的路径无法导入', deniedImport.ok === false, deniedImport.ok ? '居然导入成功了' : '')
  check(
    '拒绝原因是「不是用户选择的文件」',
    /不是用户选择的文件/.test(deniedImport.message ?? ''),
    deniedImport.message ?? '(没有给出原因)'
  )
  check(
    '库外文件没有被复制进知识库',
    readdirSync(join(vaultDir, '.papervault', 'pdfs')).length === 0
  )

  const grantedTxt = await invoke<number>('file:grant', [join(outsideDir, 'not-a-pdf.txt')])
  check('非 PDF 即使授权也不放行', grantedTxt === 0, `added=${grantedTxt}`)

  // 模拟 preload 把拖拽落下的路径报上来授权
  const granted = await invoke<number>('file:grant', [sourcePdf])
  check('file:grant 记下了授权', granted === 1, `added=${granted}`)
  const rawBytes = await invoke<Uint8Array>('file:readBinary', sourcePdf)
  check('授权后能读到字节', rawBytes.byteLength > 0, `bytes=${rawBytes.byteLength}`)

  const imported = await invoke<ImportPdfResult>('paper:importPdf', {
    sourcePath: sourcePdf,
    fileName: 'My Test Paper.pdf',
    text: '这是一段用来测试导入链路的原文。'.repeat(30),
    extractedTitle: '导入测试论文',
    autoSummarize: false
  })
  check('导入成功', imported.ok === true, imported.error ?? '')
  const importedId = imported.paperId ?? ''
  check('猜出的标题被采用', imported.title === '导入测试论文')
  const importedPdf = join(vaultDir, '.papervault', 'pdfs', `${importedId}.pdf`)
  const importedText = join(vaultDir, '.papervault', 'texts', `${importedId}.txt`)
  check('PDF 副本归档进知识库', existsSync(importedPdf))
  check('抽取的原文被保存', existsSync(importedText))
  check(
    '原文摘要进了检索索引（能搜到）',
    (await invoke<string[]>('paper:search', '测试导入链路')).includes(importedId)
  )

  /* ---------------------------------------------------------------- */
  section('7. PDF 预览窗口与路径越界防护')
  resetWindows()
  const openResult = await invoke<{ ok: boolean; message?: string }>('paper:openPdf', importedId)
  check('paper:openPdf 成功', openResult.ok === true, openResult.message ?? '')
  check('打开了独立预览窗口', stubState().windows.length === 1)
  check(
    '窗口加载的是知识库内的 file:// 路径',
    (stubState().windows[0]?.loadedUrls[0] ?? '').startsWith('file://')
  )

  /*
   * frontmatter 里的 pdf 是可以被手工改写的，必须挡住 `../` 逃逸。
   * 直接手写一个指向库外的 Markdown，再走一次扫描把它收进索引。
   */
  const evilId = 'evil-traversal'
  const outsidePdf = join(outsideDir, 'secret.pdf')
  writeFileSync(outsidePdf, Buffer.from('%PDF-1.4 do not delete me'))
  writeFileSync(
    join(vaultDir, 'papers', `${evilId}.md`),
    [
      '---',
      `id: ${evilId}`,
      'title: 越界测试',
      'authors: []',
      'venue: ""',
      'url: ""',
      'arxivId: ""',
      'doi: ""',
      'status: inbox',
      'rating: 0',
      'importance: 3',
      'categories: []',
      'tags: []',
      'pdf: ../outside/secret.pdf',
      'createdAt: 2026-01-01T00:00:00.000Z',
      'updatedAt: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '## 一句话总结',
      '',
      '越界引用测试。',
      ''
    ].join('\n')
  )
  await invoke<ScanResult>('vault:rescan')
  const evilRead = await invoke<{ ok: boolean; message?: string }>('paper:pdfData', evilId)
  check('拒绝读取知识库外的 PDF', evilRead.ok === false, evilRead.message ?? '')
  const evilOpen = await invoke<{ ok: boolean; message?: string }>('paper:openPdf', evilId)
  check('拒绝打开知识库外的 PDF', evilOpen.ok === false)
  check('索引里没有出现第二个预览窗口', stubState().windows.length === 1)

  await invoke('paper:delete', evilId)
  check('删除越界引用时没有碰库外的文件', existsSync(outsidePdf))
  check('越界那条笔记自身被正常删除', !existsSync(join(vaultDir, 'papers', `${evilId}.md`)))

  /* ---------------------------------------------------------------- */
  section('8. 未配置 Key 时的 AI 任务')
  // 用导入进来的那篇：它有抽取好的原文，才会走到「调用模型」这一步
  const sentBefore = stubState().sent.length
  const ai = await invoke<AiTaskResult>('ai:summarize', importedId)
  check('返回业务错误而不是抛异常', ai.ok === false)
  check('错误信息指向设置页', (ai.message ?? '').includes('API Key'), ai.message ?? '')
  const progressed = stubState()
    .sent.slice(sentBefore)
    .some((m) => m.channel === 'task:progress')
  check('任务进度广播到了渲染层', progressed)
  check('任务结束后队列空闲', (await invoke('task:state')) === null)

  /* ---------------------------------------------------------------- */
  section('9. 设置：API Key 落盘加密')
  const before = await invoke<AppSettings>('settings:get')
  const saved = await invoke<AppSettings>('settings:set', {
    llm: { ...before.llm, apiKey: 'sk-super-secret-value', model: 'stub-model' }
  })
  check('设置回读是明文 Key', saved.llm.apiKey === 'sk-super-secret-value')
  const settingsFile = join(stubState().userDataDir, 'settings.json')
  const rawSettings = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf-8') : ''
  check('settings.json 已写出', rawSettings.length > 0)
  check(
    '落盘的是密文，明文 Key 不出现在文件里',
    rawSettings.includes('apiKeyEnc') && !rawSettings.includes('sk-super-secret-value')
  )

  /* ---------------------------------------------------------------- */
  section('10. 句式库 / 图谱')
  const phrases = await invoke<PhraseEntry[]>('phrases:list')
  check('句式库返回数组', Array.isArray(phrases))
  const graph = await invoke<GraphData>('graph:snapshot')
  check(
    '图谱快照形状正确',
    Array.isArray(graph.nodes) &&
      Array.isArray(graph.edges) &&
      typeof graph.stats.totalPapers === 'number',
    `papers=${graph.stats.totalPapers}`
  )
  const hop = await invoke<{ paths: unknown[]; maxHops: number }>(
    'graph:multiHop',
    `p:${created.id}`,
    2
  )
  check('多跳检索返回结构完整', Array.isArray(hop.paths) && hop.maxHops === 2)

  /* ---------------------------------------------------------------- */
  section('11. 重新扫描：幂等 + 能发现外部改动')
  const first = await invoke<ScanResult>('vault:rescan')
  const second = await invoke<ScanResult>('vault:rescan')
  check('两次扫描都没有错误', first.errors.length === 0 && second.errors.length === 0)
  check(
    '重复扫描结果稳定（未变动的文件被跳过）',
    first.indexed === second.indexed,
    `${first.indexed} vs ${second.indexed}`
  )

  // 模拟用户用别的编辑器改了 Markdown：内容变了，索引必须跟上
  const externalMd = readFileSync(mdPath, 'utf-8').replace(
    '多跳检索评测集的构建方法',
    '外部编辑器改动标记 ExternalEditMarker'
  )
  writeFileSync(mdPath, externalMd)
  const third = await invoke<ScanResult>('vault:rescan')
  check('外部改动被扫描发现', third.errors.length === 0)
  check(
    '改动后的正文能立刻搜到',
    (await invoke<string[]>('paper:search', 'ExternalEditMarker')).includes(created.id)
  )

  /* ---------------------------------------------------------------- */
  section('12. 删除：连带清理附件')
  await invoke('paper:delete', created.id)
  check('Markdown 被清理', !existsSync(mdPath))
  check(
    '列表里不再有它',
    (await invoke<PaperSummary[]>('paper:list')).every((p) => p.id !== created.id)
  )
  await invoke('paper:delete', importedId)
  check('归档的 PDF 副本被清理', !existsSync(importedPdf))
  check('抽取的原文文本被清理', !existsSync(importedText))
  check('删除后统计归零', (await invoke<StatsOverview>('stats:overview')).total === 0)

  /* ---------------------------------------------------------------- */
  section('13. 批量操作：增量语义 + 逐个清理')
  const bulkIds: string[] = []
  for (const title of ['批量甲', '批量乙', '批量丙']) {
    const p = await invoke<PaperDetail>('paper:create', {
      title,
      categories: ['benchmark'],
      tags: ['原有标签']
    })
    bulkIds.push(p.id)
  }
  check('准备好三篇待批量操作的论文', bulkIds.length === 3)

  const bulkStatus = await invoke<BulkResult>('paper:bulkUpdate', {
    ids: bulkIds,
    status: 'read'
  })
  check('批量改状态：三篇都成功', bulkStatus.ok && bulkStatus.succeeded === 3, bulkStatus.message)
  const afterStatus = await invoke<PaperSummary[]>('paper:list')
  check(
    '状态真的落到了每一篇',
    bulkIds.every((id) => afterStatus.find((p) => p.id === id)?.status === 'read')
  )

  /*
   * 这一条是批量功能的重点：加标签必须是**增量**。
   * 如果实现成整份覆盖，原有的分类和标签会被一起冲掉 —— 用户只想加个标签，
   * 却把手工整理好的分类弄丢了，这种 bug 比「功能没做」更让人恼火。
   */
  const bulkTag = await invoke<BulkResult>('paper:bulkUpdate', {
    ids: bulkIds,
    addTags: ['新标签']
  })
  check('批量加标签成功', bulkTag.ok && bulkTag.succeeded === 3, bulkTag.message)
  const afterTag = await invoke<PaperSummary[]>('paper:list')
  const tagSample = afterTag.find((p) => p.id === bulkIds[0])
  check(
    '是增量而不是覆盖：原有标签与分类都还在',
    !!tagSample &&
      tagSample.tags.includes('原有标签') &&
      tagSample.tags.includes('新标签') &&
      tagSample.categories.includes('benchmark'),
    `tags=[${tagSample?.tags.join(',')}] cats=[${tagSample?.categories.join(',')}]`
  )

  await invoke<BulkResult>('paper:bulkUpdate', { ids: bulkIds, removeTags: ['原有标签'] })
  const afterRemove = await invoke<PaperSummary[]>('paper:list')
  const removeSample = afterRemove.find((p) => p.id === bulkIds[0])
  check(
    '减标签只减指定的那个',
    !!removeSample &&
      !removeSample.tags.includes('原有标签') &&
      removeSample.tags.includes('新标签'),
    `tags=[${removeSample?.tags.join(',')}]`
  )

  const emptyBulk = await invoke<BulkResult>('paper:bulkUpdate', { ids: [], status: 'inbox' })
  check('空选择是空操作而不是报错', emptyBulk.ok && emptyBulk.total === 0, emptyBulk.message)

  const bulkDel = await invoke<BulkResult>('paper:bulkDelete', bulkIds)
  check('批量删除成功', bulkDel.ok && bulkDel.succeeded === 3, bulkDel.message)
  check(
    '三篇的 Markdown 都被清掉',
    bulkIds.every((id) => !existsSync(join(vaultDir, 'papers', `${id}.md`)))
  )
  check('列表里一篇不剩', (await invoke<PaperSummary[]>('paper:list')).length === 0)

  /* ---------------------------------------------------------------- */
  /*
   * 第 14 节冲着一类「保存会毁数据」的 bug 来。共同点是：正文由
   * `renderPaperBody` 从章节字典**重建**，所以任何不在章节字典里的东西
   * （正文顶部的手写前言、用户改过的文件名）写回时都必须显式搬过去，
   * 否则一次普通保存就把它抹了 —— 而「保存」的触发点包括批量改属性。
   */
  section('14. Markdown 往返：手写前言与改过名的文件')

  const manual = await invoke<PaperDetail>('paper:create', { title: '手工编辑过的论文' })
  const manualMd = join(vaultDir, 'papers', `${manual.id}.md`)

  // 模拟用户用别的编辑器在正文顶部写了一段不属于任何章节的内容
  writeFileSync(
    manualMd,
    readFileSync(manualMd, 'utf-8').replace(
      '\n## ',
      '\n# 我的批注\n\n这篇是和 A 讨论后决定精读的，重点看 3.2 节的消融。\n\n## '
    )
  )
  check('前言已写进磁盘', readFileSync(manualMd, 'utf-8').includes('我的批注'))

  // 走一次最普通的批量改属性 —— 用户完全不会觉得这会动到正文
  const touched = await invoke<BulkResult>('paper:bulkUpdate', {
    ids: [manual.id],
    addTags: ['往返测试']
  })
  check('批量改属性成功', touched.ok && touched.succeeded === 1, touched.message)
  const afterBulk = readFileSync(manualMd, 'utf-8')
  check('正文顶部的手写内容没有被抹掉', afterBulk.includes('我的批注'))
  check('手写的那段话也还在', afterBulk.includes('重点看 3.2 节的消融'))
  check('章节内容没被顺手改坏', afterBulk.includes('## 一句话总结'))

  /*
   * 详情页的 `body` 必须是磁盘上的原文，而不是从章节字典重建的结果 ——
   * 渲染层的「导出 Markdown」靠它把前言补回去，重建过的 body 里没有前言。
   */
  const detailAfterBulk = await invoke<PaperDetail | null>('paper:get', manual.id)
  check(
    'paper:get 的 body 是磁盘原文，带着手写前言',
    !!detailAfterBulk?.body.includes('我的批注')
  )

  /*
   * 再把文件改个名。`readPaperSections` 专门支持这件事（索引记的是真实路径），
   * 写回时也必须认，否则会新造一个 `${id}.md`：同一个 id 出现两份笔记，
   * 下一次扫描谁覆盖谁还取决于文件系统遍历顺序。
   */
  const renamedMd = join(vaultDir, 'papers', '被我改名了.md')
  renameSync(manualMd, renamedMd)
  await invoke<ScanResult>('vault:rescan')

  const afterRenameRead = await invoke<PaperDetail | null>('paper:get', manual.id)
  check(
    '改名后正文仍能读到（读路径认 relPath）',
    Object.values(afterRenameRead?.sections ?? {}).some((v) => v.trim().length > 0)
  )

  const afterRename = await invoke<BulkResult>('paper:bulkUpdate', {
    ids: [manual.id],
    addTags: ['改名测试']
  })
  check('改名后批量改属性成功', afterRename.ok && afterRename.succeeded === 1, afterRename.message)
  check('写回的是改过名的那份，没有新造一个同名文件', !existsSync(manualMd))
  check('改过名的文件还在', existsSync(renamedMd))
  check('改名后前言依然没丢', readFileSync(renamedMd, 'utf-8').includes('我的批注'))

  const renamedList = await invoke<PaperSummary[]>('paper:list')
  check(
    '列表里仍然只有这一篇（没有因为重复文件变两份）',
    renamedList.filter((p) => p.id === manual.id).length === 1,
    `共 ${renamedList.length} 篇`
  )
  check(
    'papers 目录里只有一个文件',
    readdirSync(join(vaultDir, 'papers')).filter((f) => f.endsWith('.md')).length === 1,
    readdirSync(join(vaultDir, 'papers')).join(', ')
  )

  await invoke('paper:delete', manual.id)

  /* ---------------------------------------------------------------- */
  /*
   * 第 15 节守两件事：
   *   1. 图必须落在知识库根目录的 figures/ 下（不是 .papervault/ —— 那是索引
   *      与缓存，重建索引是常规操作，图放那儿会被顺手删掉）；
   *   2. 这条通道不能变成「读知识库里任意文件」或「往库外写文件」的口子。
   */
  section('15. 原文图表：保存 / 读取 / 列举 / 删除 / 越权防护')

  const withFigure = await invoke<PaperDetail>('paper:create', { title: '带图表的论文' })
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])

  const savedFigure = await invoke<{
    ok: boolean
    relPath?: string
    markdown?: string
    message?: string
  }>('figures:save', withFigure.id, pngBytes, '.png')
  check(
    '保存成功并返回相对知识库根的路径',
    savedFigure.ok === true && savedFigure.relPath === `figures/${withFigure.id}/fig-1.png`,
    savedFigure.relPath ?? savedFigure.message ?? ''
  )
  check(
    '图落在 figures/ 而不是 .papervault/（重建索引不该把图带走）',
    existsSync(join(vaultDir, 'figures', withFigure.id, 'fig-1.png')) &&
      !existsSync(join(vaultDir, '.papervault', 'figures'))
  )
  /*
   * 片段里必须是**相对笔记**的路径。写成绝对路径或自定义协议的话，知识库整体
   * 搬走就断链，在 Obsidian / VS Code 里也显示不出来。
   */
  check(
    'Markdown 片段是相对笔记的路径',
    savedFigure.markdown === `![原文图表](../figures/${withFigure.id}/fig-1.png)`,
    savedFigure.markdown ?? ''
  )

  const secondFigure = await invoke<{ relPath?: string }>(
    'figures:save',
    withFigure.id,
    pngBytes,
    '.png'
  )
  check(
    '再截一张不覆盖前一张（文件名递增）',
    secondFigure.relPath === `figures/${withFigure.id}/fig-2.png`
  )

  const readBack = await invoke<{ ok: boolean; data?: Uint8Array }>(
    'figures:read',
    savedFigure.relPath ?? ''
  )
  check(
    '能读回字节',
    readBack.ok === true && readBack.data?.byteLength === pngBytes.byteLength,
    `bytes=${readBack.data?.byteLength ?? 0}`
  )

  const escapeRead = await invoke<{ ok: boolean }>('figures:read', '../outside/secret.png')
  check('越出知识库的路径读不到', escapeRead.ok === false)
  const nonImage = await invoke<{ ok: boolean }>(
    'figures:read',
    `.papervault/texts/${withFigure.id}.txt`
  )
  check('非图片扩展名一律拒绝（否则就成了任意文件读取）', nonImage.ok === false)

  const badId = await invoke<{ ok: boolean; relPath?: string; message?: string }>(
    'figures:save',
    '../../escape',
    pngBytes,
    '.png'
  )
  check(
    '构造出来的 paperId 越不出知识库',
    badId.ok === false || (badId.relPath ?? '').startsWith('figures/'),
    badId.relPath ?? badId.message ?? ''
  )
  const emptySave = await invoke<{ ok: boolean }>('figures:save', withFigure.id, new Uint8Array(0))
  check('空图片不落盘', emptySave.ok === false)
  const ghost = await invoke<{ ok: boolean }>('figures:save', 'no-such-paper', pngBytes)
  check('不存在的论文不给保存', ghost.ok === false)

  /* 图库列举与删除 ------------------------------------------------- */

  const listed = await invoke<{ ok: boolean; figures?: string[] }>('figures:list', withFigure.id)
  check(
    '列举按 fig-N 升序返回两张图',
    listed.ok === true &&
      listed.figures?.length === 2 &&
      listed.figures?.[0] === `figures/${withFigure.id}/fig-1.png` &&
      listed.figures?.[1] === `figures/${withFigure.id}/fig-2.png`,
    JSON.stringify(listed.figures)
  )

  // fig-10 是排序的试金石：字符串比较会把它排到 fig-2 前面
  writeFileSync(join(vaultDir, 'figures', withFigure.id, 'fig-10.png'), pngBytes)
  const ordered = await invoke<{ figures?: string[] }>('figures:list', withFigure.id)
  check(
    'fig-10 排在 fig-2 后面（按数字不按字符串）',
    ordered.figures?.join(',') ===
      [
        `figures/${withFigure.id}/fig-1.png`,
        `figures/${withFigure.id}/fig-2.png`,
        `figures/${withFigure.id}/fig-10.png`
      ].join(','),
    ordered.figures?.join(',')
  )

  const unknownList = await invoke<{ ok: boolean; figures?: string[] }>(
    'figures:list',
    'no-such-paper'
  )
  check('没截过图的论文返回空列表而不是报错', unknownList.ok === true && unknownList.figures?.length === 0)

  const delNote = await invoke<{ ok: boolean }>('figures:delete', 'papers/whatever.md')
  check('删除只认图片扩展名', delNote.ok === false)

  // 图片扩展名匹配、但不在 figures/ 里 —— 手放进库里的其他图片资产不归这条通道管
  writeFileSync(join(vaultDir, 'stray.png'), pngBytes)
  const delOutside = await invoke<{ ok: boolean }>('figures:delete', 'stray.png')
  check(
    '在 figures/ 之外的图片拒删',
    delOutside.ok === false && existsSync(join(vaultDir, 'stray.png'))
  )
  rmSync(join(vaultDir, 'stray.png'))

  const delOk = await invoke<{ ok: boolean }>(
    'figures:delete',
    `figures/${withFigure.id}/fig-2.png`
  )
  check(
    '删除成功且文件真的没了',
    delOk.ok === true && !existsSync(join(vaultDir, 'figures', withFigure.id, 'fig-2.png'))
  )

  const afterDelete = await invoke<{ figures?: string[] }>('figures:list', withFigure.id)
  check(
    '删后列举只剩 fig-1 和 fig-10',
    afterDelete.figures?.length === 2,
    JSON.stringify(afterDelete.figures)
  )

  await invoke('paper:delete', withFigure.id)

  /* ---------------------------------------------------------------- */
  /*
   * 第 16 节守的是本项目踩过好几次的那类坑：**新字段在别的写入路径上被静默抹掉**。
   * 流程图只存在 Markdown 的 frontmatter 里（索引没有这一列），于是
   * 「批量加个标签」这种和它八竿子打不着的操作，构造出来的 meta 是不带 flow 的 ——
   * 写入时若不沿用磁盘上的旧值，图就没了，而且没有任何提示。
   */
  section('16. 方法流程图：能写进去，也不会被普通保存抹掉')

  const flowPaper = await invoke<PaperDetail>('paper:create', { title: '带流程图的方法论文' })
  const flowMd = join(vaultDir, 'papers', `${flowPaper.id}.md`)

  await invoke<PaperDetail>('paper:update', {
    id: flowPaper.id,
    meta: {
      ...flowPaper.meta,
      flow: {
        title: '整体流程',
        nodes: [
          { id: 'n1', label: '输入', source: '§3.1' },
          { id: 'n2', label: '编码', note: '为什么这么做', source: 'Fig.2' }
        ],
        edges: [{ from: 'n1', to: 'n2' }]
      }
    },
    sections: flowPaper.sections
  })
  check('流程图写进了 frontmatter', readFileSync(flowMd, 'utf-8').includes('flow:'))

  const readFlow = await invoke<PaperDetail | null>('paper:get', flowPaper.id)
  check(
    '详情里能读回流程图（这条路必须从文件读，索引里没有这一列）',
    readFlow?.meta.flow?.nodes.length === 2 && readFlow.meta.flow?.nodes[1].note === '为什么这么做',
    `${readFlow?.meta.flow?.nodes.length ?? 0} 个节点`
  )

  await invoke<BulkResult>('paper:bulkUpdate', { ids: [flowPaper.id], addTags: ['流程测试'] })
  const afterFlow = await invoke<PaperDetail | null>('paper:get', flowPaper.id)
  check(
    '批量改属性之后流程图还在（写入路径要沿用磁盘上的旧值）',
    afterFlow?.meta.flow?.nodes.length === 2,
    `${afterFlow?.meta.flow?.nodes.length ?? 0} 个节点`
  )
  check('frontmatter 里的出处标注也还在', readFileSync(flowMd, 'utf-8').includes('§3.1'))
  check('顺手加的标签生效了（不是整段没写）', afterFlow?.tags.includes('流程测试') === true)

  await invoke('paper:delete', flowPaper.id)

  /* ---------------------------------------------------------------- */
  /*
   * 第 17 节守两件事：
   *   1. 阅读位置存在索引 DB（meta 表）而不是笔记文件 —— 它是随手变化的
   *      UI 状态，每滚一屏写一次 Markdown 会让文件一直变脏、触发反复重扫；
   *   2. AI 高亮的 `ai` 标记必须挺过 frontmatter 的读改写。丢了的后果很隐蔽：
   *      重跑「AI 标重点」时旧标注会被当成用户高亮留下来，越攒越多。
   */
  section('17. 阅读位置与 AI 高亮标记的持久化')

  const posPaper = await invoke<PaperDetail>('paper:create', { title: '阅读位置测试' })
  const posMd = join(vaultDir, 'papers', `${posPaper.id}.md`)
  const posMdBefore = readFileSync(posMd, 'utf-8')

  await invoke('paper:saveReadingPosition', posPaper.id, { ratio: 0.42, page: 5 })
  const gotPos = await invoke<{ ok: boolean; position?: { ratio: number; page: number } }>(
    'paper:getReadingPosition',
    posPaper.id
  )
  check(
    '阅读位置能存能取',
    gotPos.ok === true && gotPos.position?.ratio === 0.42 && gotPos.position?.page === 5,
    JSON.stringify(gotPos.position)
  )
  check(
    '没存过的论文返回空而不是报错',
    (await invoke<{ ok: boolean; position?: unknown }>('paper:getReadingPosition', 'no-such-paper'))
      .position === undefined
  )
  check(
    '垃圾位置数据不收（ratio 必须是数字）',
    (
      await invoke<{ ok: boolean }>('paper:saveReadingPosition', posPaper.id, {
        ratio: 'halfway',
        page: 1
      })
    ).ok === false
  )
  check(
    '存阅读位置不碰笔记文件（否则每次滚动都让 Markdown 变脏）',
    readFileSync(posMd, 'utf-8') === posMdBefore
  )
  await invoke('paper:delete', posPaper.id)

  const aiPaper = await invoke<PaperDetail>('paper:create', { title: 'AI 标注测试' })
  const savedAi = await invoke<{ ok: boolean; highlights?: Highlight[] }>(
    'paper:saveHighlight',
    aiPaper.id,
    {
      id: 'ai-hl-1',
      page: 2,
      text: '模型标出的重点句',
      rects: [{ x: 0.1, y: 0.2, w: 0.8, h: 0.03 }],
      color: 'rgba(96,165,250,0.30)',
      note: '【核心方法】关键设计的出处',
      ai: true,
      createdAt: '2026-09-16T00:00:00.000Z'
    }
  )
  check(
    'AI 高亮保存成功且带着 ai 标记回来',
    savedAi.ok === true && savedAi.highlights?.[0]?.ai === true,
    JSON.stringify(savedAi.highlights?.[0])
  )
  const aiMd = join(vaultDir, 'papers', `${aiPaper.id}.md`)
  check('ai 标记写进了 frontmatter', readFileSync(aiMd, 'utf-8').includes('ai: true'))

  // 和流程图同一个坑位：普通保存不能把这个新字段弄丢
  await invoke<BulkResult>('paper:bulkUpdate', { ids: [aiPaper.id], addTags: ['标注测试'] })
  const afterAi = await invoke<PaperDetail | null>('paper:get', aiPaper.id)
  check(
    '批量改属性之后 ai 标记还在（读改写必须透传）',
    afterAi?.meta.highlights?.[0]?.ai === true
  )
  check(
    '「为什么重要」的备注也还在',
    afterAi?.meta.highlights?.[0]?.note?.includes('核心方法') === true
  )
  await invoke('paper:delete', aiPaper.id)

  /* ---------------------------------------------------------------- */
  /*
   * 第 18 节和第 16 节守的是同一类坑，只是字段不同：
   * 思维导图和自测题只存在 frontmatter 里（索引没有这两列），
   * 「批量加个标签」构造出来的 meta 不带它们 —— 写入时若不沿用磁盘旧值，
   * 随便保存一次，图和题就都没了。
   */
  section('18. 思维导图与自测题：能写进去，也不会被普通保存抹掉')

  const richPaper = await invoke<PaperDetail>('paper:create', { title: '带导图和自测题的论文' })
  const richMd = join(vaultDir, 'papers', `${richPaper.id}.md`)

  await invoke<PaperDetail>('paper:update', {
    id: richPaper.id,
    meta: {
      ...richPaper.meta,
      mindmap: {
        title: '结构',
        root: {
          id: 'n0',
          label: '主题',
          children: [
            { id: 'n0-0', label: '问题', children: [{ id: 'n0-0-0', label: '痛点' }] },
            { id: 'n0-1', label: '方法', children: [{ id: 'n0-1-0', label: '设计' }] }
          ]
        }
      },
      quiz: {
        createdAt: '2026-09-16T00:00:00.000Z',
        questions: [
          { q: '问题一？', options: ['甲', '乙', '丙', '丁'], answer: 0, why: '解析一', source: '§1' },
          { q: '问题二？', options: ['甲', '乙'], answer: 1, why: '解析二' },
          { q: '问题三？', options: ['甲', '乙', '丙'], answer: 2, why: '解析三' }
        ]
      }
    },
    sections: richPaper.sections
  })

  const richText = readFileSync(richMd, 'utf-8')
  check('思维导图写进了 frontmatter', richText.includes('mindmap:'))
  check('自测题写进了 frontmatter', richText.includes('quiz:'))

  const readRich = await invoke<PaperDetail | null>('paper:get', richPaper.id)
  check(
    '详情里能读回思维导图（这条路必须从文件读）',
    readRich?.meta.mindmap?.root.children?.length === 2
  )
  check(
    '详情里能读回自测题',
    readRich?.meta.quiz?.questions.length === 3 && readRich.meta.quiz?.questions[0].answer === 0
  )

  await invoke<BulkResult>('paper:bulkUpdate', { ids: [richPaper.id], addTags: ['沉淀测试'] })
  const afterRich = await invoke<PaperDetail | null>('paper:get', richPaper.id)
  check(
    '批量改属性之后思维导图还在（写入路径沿用磁盘旧值）',
    afterRich?.meta.mindmap?.root.children?.length === 2
  )
  check(
    '批量改属性之后自测题还在',
    afterRich?.meta.quiz?.questions.length === 3,
    `${afterRich?.meta.quiz?.questions.length ?? 0} 题`
  )
  check(
    '题里的解析和出处也还在（丢了解析，答错的人就不知道回哪里重读）',
    afterRich?.meta.quiz?.questions[0].why === '解析一' &&
      afterRich?.meta.quiz?.questions[0].source === '§1'
  )
  await invoke('paper:delete', richPaper.id)

  console.log('')
  console.log(`${pass}/${pass + fail} 通过`)
  if (fail) process.exitCode = 1

  /*
   * 先关库再删临时目录：索引落盘带 400ms 防抖，不关的话定时器会在目录被删掉
   * 之后才触发，打一条毫无意义的「落盘失败」日志。
   */
  closeDatabase()
  rmSync(root, { recursive: true, force: true })
}

main().catch((err) => {
  console.error('❌ 失败：', err)
  process.exit(1)
})
