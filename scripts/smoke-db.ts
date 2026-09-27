/**
 * 索引层冒烟测试：重点验证「老库升级」这条最容易出事的路径。
 *
 * 背景：索引以前把整篇笔记也存在 sections 列里（等于把 Markdown 抄了一份），
 * 现在改成按需从 Markdown 读。删列之前必须先把统计用的派生指标
 * （writing_notes / experiment_notes）回填出来，否则升级后「沉淀统计」
 * 会全部显示 0，看起来像数据丢了。
 *
 * 覆盖：
 *   1. 用老 schema 造一个库，再用当前代码打开 —— 不崩、数据不丢
 *   2. 派生指标从老 sections 列正确回填
 *   3. 索引行不再映射 sections 列
 *   4. 新写入的派生指标正确
 *   5. 重启后指标依然正确（幂等，不会重复回填出错）
 *
 * 用法：npm run smoke:db
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import initSqlJs from 'sql.js'
import type { Highlight } from '@shared/highlights'
import type { LensRunRecord } from '@shared/lenses'
import { countEffectiveChars, extractTldr, isAiFilled } from '@shared/template'
import * as db from '../src/main/db'
import * as vault from '../src/main/vault'

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

/** 老版本（sections 还在索引里）的 papers 表结构 */
const LEGACY_SCHEMA = `
CREATE TABLE papers (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT '',
  authors      TEXT NOT NULL DEFAULT '[]',
  year         INTEGER,
  venue        TEXT NOT NULL DEFAULT '',
  url          TEXT NOT NULL DEFAULT '',
  arxiv_id     TEXT NOT NULL DEFAULT '',
  doi          TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'inbox',
  rating       INTEGER NOT NULL DEFAULT 0,
  importance   INTEGER NOT NULL DEFAULT 3,
  categories   TEXT NOT NULL DEFAULT '[]',
  tags         TEXT NOT NULL DEFAULT '[]',
  pdf          TEXT NOT NULL DEFAULT '',
  rel_path     TEXT NOT NULL DEFAULT '',
  sections     TEXT NOT NULL DEFAULT '{}',
  exp          TEXT NOT NULL DEFAULT '{}',
  phrases      TEXT NOT NULL DEFAULT '[]',
  graph        TEXT NOT NULL DEFAULT '{}',
  tldr         TEXT NOT NULL DEFAULT '',
  search_blob  TEXT NOT NULL DEFAULT '',
  char_count   INTEGER NOT NULL DEFAULT 0,
  ai_filled    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0
);`

const longText = (label: string): string =>
  `${label}：` + '这是一段用于验证统计口径的笔记内容，长度需要超过阈值才会被计入完成度。'.repeat(3)

/** 塞进老库的「大部头」论文数量，用来让 sections 的体量足够明显 */
const FILLER_COUNT = 30

/** 造一个「老版本留下的」索引文件 + 对应的 Markdown */
async function writeLegacyVault(dir: string): Promise<{
  papers: Record<string, Record<string, string>>
  size: number
}> {
  const papers: Record<string, Record<string, string>> = {
    A: {
      // 实验方法论 + 4 个写作手法章节 → 两个指标都该算完成
      实验方法论: longText('实验方法论'),
      '写作手法 · Abstract': longText('Abstract'),
      '写作手法 · Introduction': longText('Introduction'),
      '写作手法 · Related Work': longText('Related Work'),
      '写作手法 · Experiments': longText('Experiments'),
      一句话总结: '- 老库里的论文 A'
    },
    B: {
      // 只有 2 个写作手法章节 → 写作拆解不算完成
      '写作手法 · Abstract': longText('Abstract'),
      '写作手法 · Introduction': longText('Introduction'),
      一句话总结: '- 老库里的论文 B'
    },
    C: { 一句话总结: '- 老库里的论文 C，什么都没写' }
  }

  // 大部分论文的正文都很长。刻意不用「实验方法论 / 写作手法」这两个章节名，
  // 免得它们干扰上面两条完成度断言。
  const fillerSections = (): Record<string, string> => ({
    自由笔记: longText('自由笔记').repeat(60),
    原文摘录: longText('原文摘录').repeat(60),
    可迁移到我的研究: longText('可迁移到我的研究').repeat(60)
  })
  for (let i = 0; i < FILLER_COUNT; i++) papers[`F${i}`] = fillerSections()

  const SQL = await initSqlJs({
    locateFile: (file: string) => join(dirname(require.resolve('sql.js')), file)
  })
  const legacy = new SQL.Database()
  legacy.exec(LEGACY_SCHEMA)

  for (const [id, sections] of Object.entries(papers)) {
    const now = Date.now()
    const meta = vault.blankPaperMeta({ id, title: `Legacy ${id}` })
    // 忠实还原老版本 upsertPaper 的写入结果：派生字段当年也是算好写进去的。
    // search_blob 必须走真实的 buildSearchBlob —— 它包含整篇笔记（截断到 12KB），
    // 是索引里除了 sections 之外的另一大块，漏算它会得出虚高的瘦身比例。
    legacy.run(
      `INSERT INTO papers
         (id, title, authors, status, sections, tldr, search_blob,
          char_count, ai_filled, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        meta.title,
        JSON.stringify([]),
        'read',
        JSON.stringify(sections),
        extractTldr(sections),
        db.buildSearchBlob(meta, sections),
        countEffectiveChars(sections),
        isAiFilled(sections) ? 1 : 0,
        now,
        now
      ]
    )
    // Markdown 才是事实源，老库的 sections 只是副本
    vault.writePaperFile(dir, meta, sections)
  }

  mkdirSync(join(dir, '.papervault'), { recursive: true })
  const indexPath = join(dir, '.papervault', 'index.sqlite')
  const bytes = legacy.export()
  writeFileSync(indexPath, Buffer.from(bytes))
  legacy.close()
  return { papers, size: statSync(indexPath).size }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pv-db-'))
  vault.ensureVaultStructure(dir)
  const { papers: legacyPapers, size: legacySize } = await writeLegacyVault(dir)
  const total = 3 + FILLER_COUNT

  console.log('── 1. 打开老库（迁移） ──────────────────')
  await db.openDatabase(dir)

  /*
   * highlights 是后加的列。缺了它，索引会认为「这篇没有高亮」，而所有保存路径
   * 都用 paperMetaFromRow 构造 meta —— 下一次保存就会把 Markdown 里的
   * `highlights:` 键整段删掉，用户手动划的高亮全没。所以这一列必须有。
   */
  const legacyRow = db.getPaperRow('A')
  check(
    '迁移补上了 highlights 列（缺列会让保存删掉高亮）',
    !!legacyRow && 'highlights' in legacyRow,
    legacyRow ? Object.keys(legacyRow).includes('highlights') ? '存在' : '不存在' : '行不存在'
  )

  /*
   * last_run 同样是后加的列，用来记「上次精读跑成什么样」。
   * 缺列的后果不像 highlights 那么严重（只是详情页少一行提示），但正因为
   * 无声无息，更需要一条断言守着 —— 否则升完级没人会发现它没生效。
   */
  const runRecord: LensRunRecord = {
    finishedAt: new Date().toISOString(),
    status: 'failed',
    message: '没跑起来',
    lenses: []
  }
  db.setPaperRun('A', runRecord)
  check('迁移补上了 last_run 列（能存能读运行记录）', db.getPaperRun('A')?.message === '没跑起来')
  check('没有运行记录的论文返回 null', db.getPaperRun('B') === null)
  check('旧论文迁移后没有凭空产生 learningReview', db.getPaperSummary('B')?.learningReview === undefined)

  const stats = db.computeStats()
  check('论文总数没丢', stats.total === total, `total=${stats.total}`)
  check('阅读状态统计正确', stats.byStatus.read === total, `read=${stats.byStatus.read}`)
  check(
    '实验方法论完成度从老 sections 列回填',
    stats.withExperimentNotes === 1,
    `withExperimentNotes=${stats.withExperimentNotes}`
  )
  check(
    '写作手法完成度从老 sections 列回填（A 有 4 节，B 只有 2 节）',
    stats.withWritingNotes === 1,
    `withWritingNotes=${stats.withWritingNotes}`
  )

  console.log('')
  console.log('── 2. 索引不再承载正文 ──────────────────')
  const row = db.getPaperRow('A')
  check('行里不再映射 sections 列', row != null && row.sections === undefined)
  /*
   * links 是这一轮新加的列：老库打开时由 migrate() 补上，并顺手清一次文件指纹
   * 强制全量重解析（不这么做，索引会认为「这篇没有任何关系」，下一次保存就会把
   * frontmatter 里手工连的关系整段删掉 —— 和当年 highlights 丢的是同一个坑）。
   */
  check('老库升级后补上了 links 列（迁移路径）', row != null && row.links !== undefined)
  check(
    '老库里没有关系，读出来是空数组而不是崩掉',
    (row ? (db.paperMetaFromRow(row).links?.length ?? -1) : -1) === 0
  )
  check('tldr 等派生字段仍在索引里', String(row?.tldr ?? '').includes('老库里的论文 A'))

  const sectionsA = vault.readPaperSections(dir, 'A')
  check(
    '章节正文完整保留在 Markdown 里（数据没丢）',
    (sectionsA['实验方法论'] ?? '').length > 60 &&
      Object.keys(sectionsA).filter((k) => k.startsWith('写作手法')).length === 4,
    `章节数=${Object.keys(sectionsA).length}`
  )
  check(
    '从 Markdown 读出的内容与老库里的副本一致',
    sectionsA['写作手法 · Abstract'] === legacyPapers.A['写作手法 · Abstract']
  )

  console.log('')
  console.log('── 3. 新写入 ────────────────────────────')
  const metaB = vault.blankPaperMeta({ id: 'B', title: 'Legacy B' })
  // 复习功能已删，这里只验证老的 learningReview 元数据仍能安全落库、重启后原样读回
  metaB.learningReview = {
    reviewedAt: '2026-09-18T10:00:00.000Z',
    nextReviewAt: '2026-09-21T10:00:00.000Z',
    intervalDays: 3,
    count: 1,
    rating: 'hard'
  }
  db.upsertPaper({
    meta: metaB,
    // B 补上第 3 节写作手法 → 应该开始计入完成度
    sections: {
      ...legacyPapers.B,
      '写作手法 · Related Work': longText('Related Work'),
      实验方法论: longText('实验方法论')
    },
    relPath: 'papers/B.md'
  })
  const stats2 = db.computeStats()
  check(
    '补写后 B 计入写作拆解完成',
    stats2.withWritingNotes === 2,
    `withWritingNotes=${stats2.withWritingNotes}`
  )
  check(
    '补写后 B 计入实验方法论完成',
    stats2.withExperimentNotes === 2,
    `withExperimentNotes=${stats2.withExperimentNotes}`
  )

  console.log('')
  console.log('── 4. 重启（迁移幂等） ──────────────────')
  db.closeDatabase()
  await db.openDatabase(dir)
  const stats3 = db.computeStats()
  check('重启后总数正确', stats3.total === total, `total=${stats3.total}`)
  check('旧库升级后 learningReview 仍能保存并恢复', db.getPaperSummary('B')?.learningReview?.intervalDays === 3)
  check(
    '重启后指标不回退、不重复累加',
    stats3.withWritingNotes === 2 && stats3.withExperimentNotes === 2,
    `writing=${stats3.withWritingNotes} experiment=${stats3.withExperimentNotes}`
  )
  check('重启后仍能从 Markdown 读到章节', Object.keys(vault.readPaperSections(dir, 'A')).length >= 4)

  console.log('')
  console.log('── 5. 索引体积（本轮改造的核心收益） ─────')
  db.closeDatabase() // 落盘之后再量，否则量到的是内存里的旧快照
  const sizeAfter = statSync(join(dir, '.papervault', 'index.sqlite')).size
  const saved = (1 - sizeAfter / legacySize) * 100
  console.log(
    `     老库 ${(legacySize / 1024).toFixed(0)}KB → 迁移后 ${(sizeAfter / 1024).toFixed(0)}KB（省 ${saved.toFixed(0)}%）`
  )
  check(
    '正文不再存在索引里，索引明显变小',
    sizeAfter < legacySize * 0.7,
    `${legacySize} → ${sizeAfter}`
  )

  console.log('')
  console.log('── 6. 全新库 ────────────────────────────')
  const fresh = mkdtempSync(join(tmpdir(), 'pv-fresh-'))
  await db.openDatabase(fresh)
  check('空库不报错', db.computeStats().total === 0)
  db.upsertPaper({
    meta: vault.blankPaperMeta({ id: 'N', title: 'New' }),
    sections: { 实验方法论: longText('实验方法论') },
    relPath: 'papers/N.md'
  })
  check('空库写入后指标立即生效', db.computeStats().withExperimentNotes === 1)
  check('空库行里没有 sections 列', db.getPaperRow('N')?.sections === undefined)

  console.log('')
  console.log('── 7. 高亮随 Markdown 往返 ──────────────')
  /*
   * 高亮存在 frontmatter 里，而它是「对象数组里再套对象数组」的嵌套结构，
   * YAML 序列化最容易在这里静默丢字段或改精度，所以单独锁一遍。
   */
  const highlights: Highlight[] = [
    {
      id: 'hl-1',
      page: 3,
      text: 'We present CultureVerse, a massive scale benchmark.',
      rects: [
        { x: 0.1, y: 0.2, w: 0.8, h: 0.02 },
        { x: 0.1, y: 0.23, w: 0.5, h: 0.02 }
      ],
      color: 'rgba(251,191,36,0.34)',
      note: 'dataset 规模',
      createdAt: '2026-09-11T00:00:00.000Z'
    }
  ]

  const hlWritten = vault.writePaperFile(
    dir,
    { ...vault.blankPaperMeta({ id: 'HL', title: 'Highlight Paper' }), highlights },
    { 一句话总结: '- x' }
  )
  const hlRead = vault.readPaperFile(hlWritten.absPath, dir)

  check('高亮数量往返一致', hlRead?.meta.highlights?.length === 1)
  check('页码保留', hlRead?.meta.highlights?.[0]?.page === 3)
  check(
    '矩形数组完整（嵌套两层没被压平）',
    hlRead?.meta.highlights?.[0]?.rects.length === 2,
    `rects=${hlRead?.meta.highlights?.[0]?.rects.length}`
  )
  check(
    '归一化浮点没被 YAML 破坏精度',
    Math.abs((hlRead?.meta.highlights?.[0]?.rects[0]?.w ?? 0) - 0.8) < 1e-9,
    String(hlRead?.meta.highlights?.[0]?.rects[0]?.w)
  )
  check('备注保留', hlRead?.meta.highlights?.[0]?.note === 'dataset 规模')
  check(
    '正文里的中文没被转义成乱码',
    hlRead?.meta.highlights?.[0]?.note === 'dataset 规模' && hlRead.meta.highlights[0].text.includes('CultureVerse')
  )

  // 没有高亮的论文不该被塞一个空键，否则每篇 frontmatter 都多一行噪音
  const plainWritten = vault.writePaperFile(
    dir,
    vault.blankPaperMeta({ id: 'PLAIN', title: 'Plain Paper' }),
    { 一句话总结: '- y' }
  )
  const plainRaw = readFileSync(plainWritten.absPath, 'utf-8')
  check('没有高亮时不写 highlights 键', !/^highlights:/m.test(plainRaw))

  /*
   * 更根本的一道保险在文件层：有些调用路径构造 meta 时压根不带 highlights
   * （它们来自索引行，而索引这一列要等重扫才同步），writePaperFile 必须沿用
   * 磁盘上已有的那份。缺了它，保存一次就把用户手划的高亮删光。
   */
  const withHl = vault.blankPaperMeta({ id: 'KEEPHL', title: 'Keep Highlights' })
  withHl.highlights = [
    { id: 'h9', page: 1, color: '#FFD400', text: 'x', rects: [{ x: 0, y: 0, w: 1, h: 1 }] }
  ] as Highlight[]
  const keepHlWritten = vault.writePaperFile(dir, withHl, { 一句话总结: '- z' })
  check(
    '写入后有 highlights 键',
    /^highlights:/m.test(readFileSync(keepHlWritten.absPath, 'utf-8'))
  )

  // 模拟一次「不带 highlights」的保存（例如从索引行构造出来的 meta）
  vault.writePaperFile(dir, vault.blankPaperMeta({ id: 'KEEPHL', title: 'Keep Highlights' }), {
    一句话总结: '- z2'
  })
  const hlAfter = readFileSync(keepHlWritten.absPath, 'utf-8')
  check('不带 highlights 保存后，文件里的高亮仍在', /^highlights:/m.test(hlAfter))
  check('高亮内容没丢', hlAfter.includes('h9'))

  /* ---------------- 8. 「没传」≠「清空」 ---------------- */
  console.log('')
  console.log('── 8. 索引独有字段的保留语义 ────────────')

  /*
   * graph / phrases / highlights 有个共同点：**它们不在 Markdown 的 frontmatter 里**，
   * 所以 rescanVault 那种「按文件重新解析后写回索引」的调用，meta 里根本不含它们。
   *
   * 以前 upsertPaper 写的是 `meta.phrases ?? []` —— 把「没传」当成了「清空」，
   * 于是 rescan 一跑就把全库的图谱和句式库清零（在设置里改一次自定义分类
   * 就会触发全库重扫）。高亮更糟：索引根本没有这一列，每次保存都会把
   * Markdown 里的 highlights 键删掉。
   */
  const keepMeta = vault.blankPaperMeta({ id: 'KEEP', title: 'Keep Fields' })
  keepMeta.phrases = [{ category: '报告结果', text: 'as shown in', usage: '引出结果' }]
  keepMeta.graph = { entities: [{ name: 'AlphaBench', kind: 'benchmark' }], relations: [] }
  keepMeta.highlights = [
    { id: 'h1', page: 3, color: '#FFD400', text: 'hello', rects: [{ x: 0, y: 0, w: 1, h: 1 }] }
  ] as Highlight[]
  db.upsertPaper({ meta: keepMeta, sections: { 一句话总结: '- x' }, relPath: 'papers/KEEP.md' })

  const keepRow = db.getPaperRow('KEEP')
  const before = keepRow ? db.paperMetaFromRow(keepRow) : null
  check('写入后索引里有句式', (before?.phrases?.length ?? 0) === 1)
  check('写入后索引里有图谱', before?.graph?.entities?.length === 1)
  check(
    '写入后索引里有高亮',
    (before?.highlights?.length ?? 0) === 1,
    `highlights=${before?.highlights?.length ?? 0}`
  )

  // 模拟 rescanVault：按文件重新解析出来的 meta 不含这三个字段
  db.upsertPaper({
    meta: vault.blankPaperMeta({ id: 'KEEP', title: 'Keep Fields' }),
    sections: { 一句话总结: '- x' },
    relPath: 'papers/KEEP.md'
  })

  const afterRow = db.getPaperRow('KEEP')
  const after = afterRow ? db.paperMetaFromRow(afterRow) : null
  check(
    '重扫后句式没被清空',
    (after?.phrases?.length ?? 0) === 1,
    `phrases=${after?.phrases?.length ?? 0}`
  )
  check(
    '重扫后图谱没被清空',
    after?.graph?.entities?.length === 1,
    `entities=${after?.graph?.entities?.length ?? 0}`
  )
  check(
    '重扫后高亮没被清空',
    (after?.highlights?.length ?? 0) === 1,
    `highlights=${after?.highlights?.length ?? 0}`
  )

  // 「保留」不能变成「删不掉」：显式传空值仍然要生效
  const cleared = vault.blankPaperMeta({ id: 'KEEP', title: 'Keep Fields' })
  cleared.phrases = []
  cleared.highlights = []
  db.upsertPaper({ meta: cleared, sections: { 一句话总结: '- x' }, relPath: 'papers/KEEP.md' })
  const clearedRow = db.getPaperRow('KEEP')
  const afterClear = clearedRow ? db.paperMetaFromRow(clearedRow) : null
  check('显式传空数组仍然清空句式', (afterClear?.phrases?.length ?? 0) === 0)
  check('显式传空数组仍然清空高亮', (afterClear?.highlights?.length ?? 0) === 0)
  check(
    '没传的图谱依旧保留（各列互不影响）',
    afterClear?.graph?.entities?.length === 1,
    `entities=${afterClear?.graph?.entities?.length ?? 0}`
  )

  /* ---------------- 9. 论文关系（links） ---------------- */
  console.log('')
  console.log('── 9. 论文关系：frontmatter ↔ 索引 ────────')

  /*
   * 关系和 highlights 是同一个坑：数据在 Markdown 的 frontmatter 里，索引另有一列
   * 镜像。要验三件事：
   *   1. 写盘 → 读回，类型 / 备注 / 来源一个不少；
   *   2. 显式传空数组要**把键删掉**，否则「取消最后一条关系」永远存不下去；
   *   3. 不带 links 的保存（meta 来自索引行）不能把已有关系抹掉。
   */
  const linked = vault.blankPaperMeta({ id: 'LINK', title: 'Linked Paper' })
  linked.links = [
    { to: 'OTHER', type: 'builds-on', by: 'user', note: '改进了它的检索环节' },
    { to: 'AI-ONE', type: 'inspires', by: 'ai', evidence: '§3.2 说可以搬过去' }
  ]
  const linkWritten = vault.writePaperFile(fresh, linked, { 一句话总结: '- l' })
  const linkRead = vault.readPaperFile(linkWritten.absPath, fresh)
  check(
    '关系条数往返一致',
    linkRead?.meta.links?.length === 2,
    `links=${linkRead?.meta.links?.length ?? 0}`
  )
  check(
    '类型 / 备注 / 来源都保留',
    linkRead?.meta.links?.some(
      (l) =>
        l.to === 'OTHER' && l.type === 'builds-on' && l.note === '改进了它的检索环节' && l.by === 'user'
    ) === true
  )
  check(
    'AI 提议的 evidence 保留（那是它唯一可追溯的依据）',
    linkRead?.meta.links?.some(
      (l) => l.to === 'AI-ONE' && l.by === 'ai' && l.evidence === '§3.2 说可以搬过去'
    ) === true
  )

  // 不带 links 的保存：meta 来自索引行 / 列表瘦身列时就是这样
  vault.writePaperFile(fresh, vault.blankPaperMeta({ id: 'LINK', title: 'Linked Paper' }), {
    一句话总结: '- l2'
  })
  const linkRaw = readFileSync(linkWritten.absPath, 'utf-8')
  check('不带 links 的保存不会把文件里的关系删掉', /^links:/m.test(linkRaw))
  check('关系内容没丢', linkRaw.includes('OTHER'))

  // 索引镜像：构图靠它，否则每画一次图都要读全库 Markdown
  db.upsertPaper({ meta: linkRead!.meta, sections: { 一句话总结: '- l' }, relPath: 'papers/LINK.md' })
  const linkRow = db.getPaperRow('LINK')
  check(
    '索引里也有关系（构图靠它）',
    (linkRow ? (db.paperMetaFromRow(linkRow).links?.length ?? 0) : 0) === 2
  )

  db.upsertPaper({
    meta: vault.blankPaperMeta({ id: 'LINK', title: 'Linked Paper' }),
    sections: { 一句话总结: '- l' },
    relPath: 'papers/LINK.md'
  })
  const keptRow = db.getPaperRow('LINK')
  check(
    '不带 links 的写入不会清空索引里的关系（「没传」≠「清空」）',
    (keptRow ? (db.paperMetaFromRow(keptRow).links?.length ?? 0) : 0) === 2
  )

  const clearedLinks = vault.blankPaperMeta({ id: 'LINK', title: 'Linked Paper' })
  clearedLinks.links = []
  db.upsertPaper({ meta: clearedLinks, sections: { 一句话总结: '- l' }, relPath: 'papers/LINK.md' })
  const clearedLinkRow = db.getPaperRow('LINK')
  check(
    '显式传空数组才是真清空（「保留」不能变成「删不掉」）',
    (clearedLinkRow ? (db.paperMetaFromRow(clearedLinkRow).links?.length ?? -1) : -1) === 0
  )
  const clearedFile = vault.writePaperFile(fresh, clearedLinks, { 一句话总结: '- l' })
  check(
    '清空后 frontmatter 里的 links 键被删掉（不是留一个空数组）',
    !/^links:/m.test(readFileSync(clearedFile.absPath, 'utf-8'))
  )

  /* ---------------- 归纳 / 组合文档：原地重跑的语义 ---------------- */
  console.log('')
  console.log('── 跨论文文档：重跑不该新建、也不该改创建时间 ──')

  const comboScope = { type: 'combo' as const, value: '组合分析', paperIds: ['p-a', 'p-b'] }
  db.upsertSynthesis({
    id: 'combo-1',
    title: '组合分析 · 2 篇',
    scope: comboScope,
    content: '第一版',
    relPath: 'syntheses/combo-1.md',
    paperCount: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  })
  db.upsertSynthesis({
    id: 'combo-1',
    title: '组合分析 · 3 篇',
    scope: { ...comboScope, paperIds: ['p-a', 'p-b', 'p-c'] },
    content: '第二版',
    relPath: 'syntheses/combo-1.md',
    paperCount: 3,
    // 刻意不传 createdAt：沿用库里原值（重跑不该把「创建于」推到今天）
    updatedAt: '2026-02-02T00:00:00.000Z'
  })
  const rerun = db.getSynthesis('combo-1')
  check('重跑后还是同一份文档（id 不变、不新建）', db.synthesisCount() === 1)
  check('重跑保留创建时间', rerun?.createdAt.startsWith('2026-01-01') === true, rerun?.createdAt)
  check(
    '重跑更新内容与更新时间',
    rerun?.content === '第二版' && rerun.updatedAt.startsWith('2026-02-02') === true
  )
  check(
    '成员（scope.paperIds）原样读回 —— 重跑正是靠它知道该拿哪几篇',
    rerun?.scope.paperIds?.join('|') === 'p-a|p-b|p-c' && rerun.paperCount === 3
  )

  db.closeDatabase()
  rmSync(dir, { recursive: true, force: true })
  rmSync(fresh, { recursive: true, force: true })

  console.log('')
  console.log(`${pass}/${pass + fail} 通过`)
  if (fail) process.exitCode = 1
}

main().catch((err) => {
  console.error('❌ 失败：', err)
  process.exit(1)
})
