/**
 * 检索方案基准测试：先量再选，别拍脑袋上 FTS5。
 *
 * 回答三个问题：
 *   Q1  sql.js 里 FTS5 可用吗？（决定 FTS5 方案是否可行）
 *   Q2  现在渲染层的 JS 过滤到底慢不慢？（决定「为了性能」是否成立）
 *   Q3  主进程扫 search_blob 能找到 JS 过滤找不到的东西吗？（决定是否有功能价值）
 *
 * 保留这个脚本是因为「库长大了要不要换方案」将来还得再量一次。
 *
 * 用法：npm run bench:search [-- 5000]
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import initSqlJs from 'sql.js'
import type { Database } from 'sql.js'

const COUNT = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 2000)
const REPEAT = 15

const CJK = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/
const WORD = /[A-Za-z0-9_]/

/** 把查询切成 token：CJK 段整体作为一个 token，ASCII 词小写 */
function tokenize(query: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < query.length) {
    const ch = query[i]
    if (CJK.test(ch)) {
      let j = i
      while (j < query.length && CJK.test(query[j])) j++
      out.push(query.slice(i, j))
      i = j
    } else if (WORD.test(ch)) {
      let j = i
      while (j < query.length && WORD.test(query[j])) j++
      out.push(query.slice(i, j).toLowerCase())
      i = j
    } else {
      i++
    }
  }
  return out
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`)
}

function timeIt<T>(fn: () => T, repeat = REPEAT): { ms: number; value: T } {
  const value = fn()
  const samples: number[] = []
  for (let i = 0; i < repeat; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  return { ms: samples[Math.floor(samples.length / 2)], value }
}

const pad = (text: string, width: number): string => text.padEnd(width)

/* ------------------------------------------------------------------ */
/*  语料                                                                */
/* ------------------------------------------------------------------ */

/** bench 类论文：含「多跳检索评测集」等评测向表述 */
const BENCH_ZH =
  '本文提出了一个多跳检索评测集，关注跨文档的证据聚合能力。评测指标包括 Exact Match 与 F1，并报告了检索召回率。我们对比了稠密检索与稀疏检索两类基线，消融实验共 5 组。'
/** method 类论文：含具体训练细节，这些只出现在正文里 */
const METHOD_ZH =
  '本文提出了一种检索增强生成方法，通过两阶段重排提升证据召回率。我们在单卡 A100 上训练了两天，使用 LoRA 进行参数高效微调，训练语料来自 CommonCrawl。'
const BENCH_EN =
  'We introduce a multi-hop retrieval benchmark over heterogeneous document collections. ' +
  'We report exact match and F1, and compare against dense and sparse retrieval baselines.'
const METHOD_EN =
  'We propose a retrieval augmented generation method with a two-stage reranker module. ' +
  'Experiments on long-document benchmarks show consistent improvements.'

interface Doc {
  id: string
  title: string
  authors: string
  tldr: string
  tags: string
  blob: string
}

function buildCorpus(): Doc[] {
  return Array.from({ length: COUNT }, (_, i) => {
    const bench = i % 3 === 0
    const zh = bench ? BENCH_ZH : METHOD_ZH
    const en = bench ? BENCH_EN : METHOD_EN
    const title = bench
      ? `Multi-hop Retrieval Benchmark ${i}`
      : `Reranker for Retrieval Augmented Generation ${i}`
    return {
      id: `p${i}`,
      title,
      authors: bench ? 'Zhang, Wei' : 'Li, Ming',
      tldr: bench ? '- 提出一个多跳检索评测集' : '- 提出两阶段重排方法',
      tags: bench ? 'benchmark multi-hop' : 'rag reranker',
      // 真实索引里 search_blob 会被截到 12000 字符，这里保持同样的上限
      blob: `${title}\n${en}\n${zh}`.repeat(12).slice(0, 12000)
    }
  })
}

/* ------------------------------------------------------------------ */
/*  两种检索实现                                                        */
/* ------------------------------------------------------------------ */

/**
 * 现在的渲染层做法：只对 PaperSummary 里已有的字段拼 haystack。
 * 注意它**搜不到正文**——这是功能上的限制，不是性能问题。
 */
function jsFilter(docs: Doc[], query: string): number {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return docs.length
  let hits = 0
  for (const d of docs) {
    const haystack = [d.title, d.authors, d.tldr, d.tags].join('\n').toLowerCase()
    if (tokens.every((t) => haystack.includes(t))) hits++
  }
  return hits
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pv-bench-'))
  const SQL = await initSqlJs({
    locateFile: (file: string) => join(dirname(require.resolve('sql.js')), file)
  })
  const db: Database = new SQL.Database()

  console.log(`语料：${COUNT} 篇，search_blob 上限 12000 字符（与真实索引一致）`)
  console.log('')

  /* ---------------- Q1：FTS5 可用性 ---------------- */
  console.log('── Q1. sql.js 的 SQLite 能力探测 ──────────────')
  const features: [string, string][] = [
    ['FTS5', `CREATE VIRTUAL TABLE probe USING fts5(x)`],
    ['FTS4', `CREATE VIRTUAL TABLE probe USING fts4(x)`],
    ['trigram 分词器', `CREATE VIRTUAL TABLE probe USING fts5(x, tokenize='trigram')`]
  ]
  for (const [name, sql] of features) {
    try {
      db.exec(sql)
      db.exec('DROP TABLE IF EXISTS probe')
      console.log(`   ${pad(name, 14)} 可用`)
    } catch (err) {
      console.log(`   ${pad(name, 14)} 不可用 —— ${(err as Error).message}`)
    }
  }
  db.exec(`
    CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT, authors TEXT, tldr TEXT, tags TEXT, search_blob TEXT)
  `)
  console.log('')

  /* ---------------- 造数据 ---------------- */
  const corpus = buildCorpus()
  const insert = db.prepare('INSERT INTO papers VALUES (?,?,?,?,?,?)')
  db.exec('BEGIN')
  for (const d of corpus) {
    insert.run([d.id, d.title, d.authors, d.tldr, d.tags, d.blob.toLowerCase()])
  }
  db.exec('COMMIT')
  insert.free()
  console.log(`库体积：${(db.export().length / 1024 / 1024).toFixed(1)}MB`)
  console.log('')

  /* ---------------- Q2：性能对比 ---------------- */
  const count = (sql: string, params: unknown[] = []): number => {
    const stmt = db.prepare(sql)
    try {
      if (params.length) stmt.bind(params as never)
      stmt.step()
      return Number(Object.values(stmt.getAsObject())[0] ?? 0)
    } finally {
      stmt.free()
    }
  }

  /** 主进程候选方案：每个 token 各自 LIKE，全部命中才算（AND 语义） */
  const sqlSearch = (query: string): number => {
    const tokens = tokenize(query)
    if (!tokens.length) return corpus.length
    const where = tokens.map(() => `search_blob LIKE ? ESCAPE '\\'`).join(' AND ')
    return count(
      `SELECT COUNT(*) FROM papers WHERE ${where}`,
      tokens.map((t) => `%${escapeLike(t)}%`)
    )
  }

  const queries = [
    'benchmark',
    'reranker',
    '多跳检索',
    '检索增强',
    'LoRA CommonCrawl',
    '消融实验 基线'
  ]

  console.log('── Q2. JS 过滤 vs 主进程 SQL 扫描 ─────────────')
  console.log(`   ${pad('查询', 22)}${pad('JS(现方案)', 14)}${pad('SQL(候选)', 14)}命中(JS/SQL)`)
  for (const q of queries) {
    const js = timeIt(() => jsFilter(corpus, q))
    const sql = timeIt(() => sqlSearch(q))
    console.log(
      `   ${pad(q, 22)}${pad(`${js.ms.toFixed(2)}ms`, 14)}${pad(`${sql.ms.toFixed(2)}ms`, 14)}${js.value} / ${sql.value}`
    )
  }
  console.log('')

  /* ---------------- Q3：功能差异 ---------------- */
  /* ---------------- Q4：search_blob 截断上限 ---------------- */
  /*
   * search_blob 会被 slice 到固定上限。模板里「实验方法论」「写作手法」排在靠后，
   * 上限太小会把用户最想搜到的沉淀内容截掉（而 P1-A 之后索引里已经没有正文了，
   * 全文检索完全依赖这个字段）。这里量一下放大上限的代价。
   */
  console.log('── Q4. search_blob 上限的代价 ────────────────')
  const caps = [12000, 24000, 40000]
  for (const cap of caps) {
    db.exec(`DROP TABLE IF EXISTS cap_probe`)
    db.exec(`CREATE TABLE cap_probe (id TEXT PRIMARY KEY, search_blob TEXT)`)
    const ins = db.prepare('INSERT INTO cap_probe VALUES (?,?)')
    db.exec('BEGIN')
    for (const d of corpus) ins.run([d.id, d.blob.repeat(4).slice(0, cap).toLowerCase()])
    db.exec('COMMIT')
    ins.free()
    // 只算表本身的体积，排除 sqlite 页开销的干扰
    const bytes = count('SELECT SUM(LENGTH(search_blob)) FROM cap_probe')
    const slow = timeIt(() =>
      count(`SELECT COUNT(*) FROM cap_probe WHERE search_blob LIKE ? ESCAPE '\\'`, ['%多跳检索%'])
    )
    console.log(
      `   上限 ${pad(`${cap / 1000}KB`, 7)} 文本体积 ${pad(`${(bytes / 1024 / 1024).toFixed(1)}MB`, 9)} 单次扫描 ${slow.ms.toFixed(2)}ms`
    )
  }
  db.exec('DROP TABLE cap_probe')
  console.log('')

  console.log('── Q3. 功能覆盖差异 ──────────────────────────')
  const gaps = queries.filter((q) => {
    const js = jsFilter(corpus, q)
    const sql = sqlSearch(q)
    return js === 0 && sql > 0
  })
  if (gaps.length) {
    console.log('   这些查询只出现在正文里，JS 过滤完全找不到：')
    for (const q of gaps) {
      console.log(`     「${q}」 → JS 命中 0，SQL 命中 ${sqlSearch(q)}`)
    }
  } else {
    console.log('   未发现覆盖差异')
  }

  db.close()
  rmSync(dir, { recursive: true, force: true })
}

main().catch((err) => {
  console.error('❌ 基准测试失败：', err)
  process.exit(1)
})
