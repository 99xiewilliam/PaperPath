import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { Database } from 'sql.js'
import { categoryLabel } from '@shared/taxonomy'
import { normalizeExperimentProfile } from '@shared/experiment'
import { buildLikeClause } from '@shared/search'
import { LEARNING_KEYS, normalizeLearningReview } from '@shared/learning'
import { countEffectiveChars, extractTldr, isAiFilled, isSectionFilled } from '@shared/template'
import type {
  PaperCollection,
  PaperMeta,
  PaperStatus,
  PaperSummary,
  StatsOverview,
  TaxonomyNode
} from '@shared/types'
import type { ExperimentProfile } from '@shared/experiment'
import type { Highlight } from '@shared/highlights'
import {
  normalizePhrases,
  pruneRetiredLenses,
  type EnglishPhrase,
  type LensRunRecord
} from '@shared/lenses'
import { normalizeWritingLogic, type WritingLogic } from '@shared/writing-logic'

// sql.js 是 CJS/UMD 发布，这里用 require 规避 ESM 互操作差异
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sqlJsModule = require('sql.js') as unknown as {
  default?: typeof import('sql.js')
} & typeof import('sql.js')
const initSqlJs: typeof import('sql.js') = (sqlJsModule.default ??
  sqlJsModule) as typeof import('sql.js')

let db: Database | null = null
let dbFile = ''
let vaultRoot = ''
let dirty = false
let flushTimer: NodeJS.Timeout | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS papers (
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
  exp          TEXT NOT NULL DEFAULT '{}',
  phrases      TEXT NOT NULL DEFAULT '[]',
  graph        TEXT NOT NULL DEFAULT '{}',
  -- 写作逻辑卡的镜像（frontmatter 的 wlogic 才是唯一事实来源，见 shared/writing-logic.ts）
  wlogic       TEXT NOT NULL DEFAULT '{}',
  highlights   TEXT NOT NULL DEFAULT '[]',
  learning_review TEXT NOT NULL DEFAULT '{}',
  -- 与库里其他论文的关系（frontmatter 的 links 在索引里的镜像，供构图用，见 shared/links.ts）
  links        TEXT NOT NULL DEFAULT '[]',
  tldr         TEXT NOT NULL DEFAULT '',
  search_blob  TEXT NOT NULL DEFAULT '',
  char_count   INTEGER NOT NULL DEFAULT 0,
  ai_filled    INTEGER NOT NULL DEFAULT 0,
  writing_notes    INTEGER NOT NULL DEFAULT 0,
  experiment_notes INTEGER NOT NULL DEFAULT 0,
  -- 上一次精读的结局（成功 / 失败 / 取消都记，见 LensRunRecord）
  last_run     TEXT NOT NULL DEFAULT '',
  -- 扫描时用来判断 Markdown 有没有变过，没变就跳过重解析（见 ipc.rescanVault）
  file_mtime   INTEGER NOT NULL DEFAULT 0,
  file_size    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_papers_updated ON papers(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_papers_status  ON papers(status);

CREATE TABLE IF NOT EXISTS syntheses (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  scope       TEXT NOT NULL DEFAULT '{}',
  content     TEXT NOT NULL DEFAULT '',
  rel_path    TEXT NOT NULL DEFAULT '',
  paper_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  paper_ids   TEXT NOT NULL DEFAULT '[]',
  notes       TEXT NOT NULL DEFAULT '',
  rel_path    TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`

/* ------------------------------------------------------------------ */
/*  生命周期                                                            */
/* ------------------------------------------------------------------ */

export async function openDatabase(vaultPath: string): Promise<void> {
  if (db && vaultRoot === vaultPath) return
  closeDatabase()
  vaultRoot = vaultPath

  const SQL = await initSqlJs({
    locateFile: (file: string) => join(dirname(require.resolve('sql.js')), file)
  })

  const dir = join(vaultPath, '.papervault')
  mkdirSync(dir, { recursive: true })
  dbFile = join(dir, 'index.sqlite')

  let loaded: Uint8Array | undefined
  if (existsSync(dbFile)) {
    try {
      loaded = new Uint8Array(readFileSync(dbFile))
    } catch {
      loaded = undefined
    }
  }

  const fresh = !loaded || loaded.length === 0
  let corrupt = false
  try {
    db = loaded && loaded.length ? new SQL.Database(loaded) : new SQL.Database()
    db.exec('SELECT 1')
  } catch {
    console.warn('[db] 索引损坏，重建空库')
    db = new SQL.Database()
    corrupt = true
  }
  db.exec(SCHEMA)
  const migrated = migrate()
  const staleIndex = invalidateStaleSearchIndex()

  /*
   * 只有库真的动过才落盘。以前无条件 persistNow()，导致每次启动都要把
   * 整个 sqlite 重新序列化写一遍 —— 库越大越明显，而绝大多数启动其实
   * 什么也没变。markDirty() 在迁移过程中若写过数据也会把 dirty 置位。
   */
  if (fresh || corrupt || migrated || staleIndex || dirty) persistNow()
}

/** 老版本索引缺列时补齐（SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS） */
/**
 * 索引格式（目前就是 search_blob 的截断上限）变了 → 把论文的文件指纹清掉，
 * 让下一次重扫全量重算。返回是否动过库。
 *
 * 为什么必须有这条：重扫走的是「mtime/size 没变就跳过」的快路径，
 * **连「重建索引」按钮都跳不过去** —— 上限一改，存量 blob 就永远停在旧内容上，
 * 搜索照样搜不到后半段。而图谱 / 句式库这类只存在索引里的数据又不能靠删库重建
 * 来修，所以只能在这里自愈。
 */
function invalidateStaleSearchIndex(): boolean {
  if (!db) return false
  if (metaGet('search_blob_limit') === String(SEARCH_BLOB_LIMIT)) return false
  run('UPDATE papers SET file_mtime = 0, file_size = 0')
  metaSet('search_blob_limit', String(SEARCH_BLOB_LIMIT))
  return true
}

function migrate(): boolean {
  if (!db) return false
  let changed = false
  const steps = [
    "ALTER TABLE papers ADD COLUMN exp TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE papers ADD COLUMN phrases TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE papers ADD COLUMN graph TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE papers ADD COLUMN wlogic TEXT NOT NULL DEFAULT '{}'",
    'ALTER TABLE papers ADD COLUMN writing_notes INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE papers ADD COLUMN experiment_notes INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE papers ADD COLUMN last_run TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE papers ADD COLUMN file_mtime INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE papers ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0'
  ]
  for (const sql of steps) {
    try {
      db.exec(sql)
      changed = true
    } catch (err) {
      /*
       * 只吞「列已存在」—— 迁移本来就是靠 ALTER 抛这个错来判断「早就加过」的。
       * 其余错误（磁盘满、库损坏、权限）必须抛出去：静默吞掉会让迁移**看起来**
       * 成功，而列其实没加上，之后所有查询都对着一个残缺的表跑。
       */
      const msg = err instanceof Error ? err.message : String(err)
      if (!/duplicate column name/i.test(msg)) throw err
    }
  }

  try {
    db.exec("ALTER TABLE papers ADD COLUMN learning_review TEXT NOT NULL DEFAULT '{}'")
    // Markdown is authoritative: rebuild the derived review queue on the next scan.
    db.exec('UPDATE papers SET file_mtime = 0, file_size = 0')
    changed = true
  } catch {
    /* column already exists */
  }

  /*
   * highlights 是新加的列，但高亮数据一直存在 Markdown 的 frontmatter 里
   *（`vault.normalizeMeta` 一直在读它，索引这边从来没有对应的列）。
   *
   * 危险点：新列默认 '[]'，索引会因此认为「这篇没有高亮」；而所有保存路径都用
   * `paperMetaFromRow` 构造 meta，于是下一次保存就会把 Markdown 里的 `highlights:`
   * 键整段删掉 —— 高亮是用户手动划的，丢了没法重建。
   *
   * 所以加完列必须清一次文件指纹，强制下一轮扫描全量重解析，把高亮从 Markdown
   * 灌进索引。不做这一步，「升级即丢高亮」。
   */
  let addedHighlights = false
  try {
    db.exec("ALTER TABLE papers ADD COLUMN highlights TEXT NOT NULL DEFAULT '[]'")
    addedHighlights = true
    changed = true
  } catch {
    /* 列已存在 */
  }
  if (addedHighlights) {
    try {
      db.exec('UPDATE papers SET file_mtime = 0, file_size = 0')
      changed = true
    } catch {
      /* 老库还没有指纹列，本来就会走全量重解析 */
    }
  }

  /*
   * 老版本把整篇笔记（10-20KB/篇）也存进了 sections 列，等于把 Markdown
   * 又抄了一份，索引体积因此膨胀好几倍、每次落盘都要全量序列化。
   * 现在章节统一按需从 Markdown 读，这个列不再需要。
   *
   * 但删列之前必须先把派生指标回填出来 —— 否则升级之后「沉淀统计」里的
   * 拆解完成度会全部变成 0，用户还以为数据丢了（要手动重建索引才能恢复）。
   */
  /*
   * links 是关系图的数据来源，走的是和 highlights 一模一样的路：数据一直在
   * Markdown 的 frontmatter 里，索引这一列默认是 '[]'。不强制重解析的话，索引会
   * 认为「这篇没有任何关系」，而所有保存路径都用 paperMetaFromRow 构造 meta ——
   * 于是随便保存一次（改个评分）就把用户亲手连的关系整段删掉。关系丢了没法重建。
   */
  let addedLinks = false
  try {
    db.exec("ALTER TABLE papers ADD COLUMN links TEXT NOT NULL DEFAULT '[]'")
    addedLinks = true
    changed = true
  } catch {
    /* 列已存在 */
  }
  if (addedLinks) {
    try {
      db.exec('UPDATE papers SET file_mtime = 0, file_size = 0')
      changed = true
    } catch {
      /* 老库还没有指纹列，本来就会走全量重解析 */
    }
  }

  const hadSections = backfillNoteMetrics()

  try {
    db.exec('ALTER TABLE papers DROP COLUMN sections')
    changed = true
  } catch {
    try {
      db.exec("UPDATE papers SET sections = '{}'")
    } catch {
      /* 列本来就不存在 */
    }
  }

  /*
   * DROP COLUMN 只是把列标记为不可用，页空间不会自动回收，索引文件不会真的变小。
   * VACUUM 才能把腾出来的页还给文件系统（也顺手把残留的笔记正文从空闲页里清掉）。
   * 只在确实回收到了东西时才跑 —— 大库的 VACUUM 是有成本的，不能让启动白白变慢。
   */
  if (hadSections) {
    try {
      db.exec('VACUUM')
    } catch (err) {
      console.warn('[db] VACUUM 失败，索引仍可正常使用', err)
    }
  }

  return changed
}

/**
 * 从老库遗留的 sections 列回填 writing_notes / experiment_notes。
 * 新库没有 sections 列，SELECT 会直接抛错，函数静默返回。
 *
 * @returns 是否真的读到过正文（决定要不要 VACUUM 回收空间）
 */
function backfillNoteMetrics(): boolean {
  if (!db) return false
  let rows: Row[]
  try {
    rows = all('SELECT id, sections, writing_notes, experiment_notes FROM papers')
  } catch {
    return false
  }

  let touched = false
  for (const row of rows) {
    let sections: Record<string, string> = {}
    try {
      sections = JSON.parse(String(row.sections ?? '{}')) as Record<string, string>
    } catch {
      continue
    }
    if (!Object.keys(sections).length) continue
    touched = true

    if (Number(row.writing_notes ?? 0) || Number(row.experiment_notes ?? 0)) continue
    const metrics = deriveNoteMetrics(sections)
    if (!metrics.writing && !metrics.experiment) continue
    run('UPDATE papers SET writing_notes = ?, experiment_notes = ? WHERE id = ?', [
      metrics.writing,
      metrics.experiment,
      String(row.id ?? '')
    ])
  }
  return touched
}

export function isOpen(): boolean {
  return db !== null
}

export function closeDatabase(): void {
  if (!db) return
  if (dirty) persistNow()
  try {
    db.close()
  } catch {
    /* ignore */
  }
  db = null
  dirty = false
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

function markDirty(): void {
  dirty = true
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    persistNow()
  }, 400)
}

export function persistNow(): void {
  if (!db || !dbFile) return
  try {
    const data = db.export()
    const tmp = `${dbFile}.tmp`
    writeFileSync(tmp, Buffer.from(data))
    renameSync(tmp, dbFile)
    dirty = false
  } catch (err) {
    console.error('[db] 落盘失败', err)
  }
}

/* ------------------------------------------------------------------ */
/*  基础执行封装                                                        */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>

function all(sql: string, params: unknown[] = []): Row[] {
  if (!db) return []
  const stmt = db.prepare(sql)
  try {
    if (params.length) stmt.bind(params as never)
    const out: Row[] = []
    while (stmt.step()) out.push(stmt.getAsObject() as Row)
    return out
  } finally {
    stmt.free()
  }
}

function run(sql: string, params: unknown[] = []): void {
  if (!db) return
  db.run(sql, params as never)
  markDirty()
}

/* ------------------------------------------------------------------ */
/*  论文索引                                                            */
/* ------------------------------------------------------------------ */

/**
 * search_blob 的截断上限。
 *
 * 曾经是 12000，理由是「AI 生成的笔记约 5~12KB，够用」—— 这个假设已经不成立：
 * 实测一个 14 篇的库**每一篇都顶在上限**，意味着每篇笔记的后半段和 PDF 原文片段
 * （拼接顺序里排最后）根本没进索引，搜这些词永远搜不到，而用户会以为「搜索坏了」。
 *
 * 放宽的代价用 bench:search（2000 篇合成语料）量过：
 *   上限 12KB → 文本 22.9MB / 单次扫描 36.5ms
 *   上限 24KB → 文本 26.7MB / 43.2ms
 *   上限 40KB → 文本 26.7MB / 43.5ms
 * 24KB 之上体积不再增长（语料本身就只有这么大），远不是「翻数倍」。
 * 40KB 取的是「大到不会截断真实笔记」的余量，而不是精确阈值。
 *
 * 改动这一行之后，存量库需要跑一次「重建索引」才会用新上限重算。
 */
const SEARCH_BLOB_LIMIT = 40000

export function buildSearchBlob(
  meta: PaperMeta,
  sections: Record<string, string>,
  custom: TaxonomyNode[] = [],
  textSnippet = ''
): string {
  // Keep the learner's own takeaways searchable even after a long AI analysis.
  const noteText = [
    ...LEARNING_KEYS.map((key) => sections[key] ?? ''),
    ...Object.entries(sections)
      .filter(([key]) => !LEARNING_KEYS.includes(key))
      .map(([, value]) => value)
  ].join('\n')
  const exp = meta.exp
  const expText = exp
    ? [
        exp.datasets.join(' '),
        exp.baselines.join(' '),
        exp.metrics.join(' '),
        exp.openModels.join(' '),
        exp.closedModels.join(' '),
        exp.compute,
        exp.scale,
        exp.runs,
        exp.humanEval
      ].join('\n')
    : ''
  return [
    meta.title,
    meta.authors.join(' '),
    meta.venue,
    String(meta.year ?? ''),
    meta.arxivId,
    meta.tags.join(' '),
    meta.categories.map((c) => categoryLabel(c, custom)).join(' '),
    extractTldr(sections),
    noteText,
    expText,
    textSnippet
  ]
    .join('\n')
    .toLowerCase()
    .slice(0, SEARCH_BLOB_LIMIT)
}

export interface IndexPaperInput {
  meta: PaperMeta
  sections: Record<string, string>
  relPath: string
  customCategories?: TaxonomyNode[]
  /** 抽取出的原文摘要片段，用于检索 */
  textSnippet?: string
  /** Markdown 文件的 mtime / size，供下次扫描判断要不要跳过重解析 */
  fileMtime?: number
  fileSize?: number
}

/** 「写作手法」维度至少写满几节才算拆解完成 */
export const WRITING_NOTES_MIN = 3

/**
 * 从章节内容算出统计所需的派生指标。
 * 索引里不存原文，只存这种「结论」——这样 dashboard 统计依然是一次 SQL
 * 扫描就能算出来，不需要为了统计去读几百个 Markdown 文件。
 */
function deriveNoteMetrics(sections: Record<string, string>): {
  writing: number
  experiment: number
} {
  /*
   * 判据是「内容有没有被动过」，不是「长度够不够」。
   * 骨架模板本身就有一两百字，拿长度当阈值时，一篇从没精读成功的论文
   * 会统计成「写作拆解 5/5、实验方法论完成度 100%」——统计页在最该报警的时候
   * 反而是一片绿。
   */
  const filled = (key: string): boolean => isSectionFilled(key, sections[key])
  const writing = Object.keys(sections).filter((k) => k.startsWith('写作手法') && filled(k)).length
  return { writing, experiment: filled('实验方法论') ? 1 : 0 }
}

/**
 * 整行写入的列清单（顺序必须和 upsertPaper 的参数数组一一对应）。
 *
 * 占位符由这份清单**算出来**，不手写 `?,?,?…`：手写的话往中间插一列就得数一遍
 * 问号，数错一个就是整行错位 —— 而 SQLite 不会报错，只会把值静默塞进别的列。
 */
const PAPER_UPSERT_COLUMNS = `id, title, authors, year, venue, url, arxiv_id, doi, status, rating, importance,
  categories, tags, pdf, rel_path, exp, phrases, graph, wlogic, highlights, links, tldr, search_blob,
  char_count, ai_filled, writing_notes, experiment_notes, file_mtime, file_size,
  created_at, updated_at, learning_review, last_run`

const PAPER_UPSERT_PLACEHOLDERS = PAPER_UPSERT_COLUMNS.split(',')
  .map(() => '?')
  .join(',')

export function upsertPaper(input: IndexPaperInput): void {
  const { meta, sections, relPath } = input
  const tldr = extractTldr(sections)
  const charCount = countEffectiveChars(sections)
  const aiFilled = isAiFilled(sections) ? 1 : 0
  const blob = buildSearchBlob(
    meta,
    sections,
    input.customCategories ?? [],
    input.textSnippet ?? ''
  )
  const createdAt = Date.parse(meta.createdAt) || Date.now()
  const updatedAt = Date.parse(meta.updatedAt) || Date.now()
  const expJson = JSON.stringify(meta.exp ?? normalizeExperimentProfile(null))
  const metrics = deriveNoteMetrics(sections)

  /*
   * graph / phrases / highlights 有个共同点：**它们都不在 Markdown 的 frontmatter 里**
   * （不像 exp 那样两边都有），所以「重新扫描时按文件重新解析」这类调用传进来的
   * meta 根本不含它们。
   *
   * 以前这里写的是 `meta.phrases ?? []` / `meta.graph ?? {}` —— 「没传」被当成了
   * 「清空」，于是 rescanVault 一跑就把全库的图谱和句式库清零：在设置里改一次
   * 自定义分类就会触发全库重扫，数据当场丢失。
   *
   * 现在区分开：**undefined = 调用方不携带该字段，保持库里原值**；
   * 显式的 `[]` / `{}` 仍然是「确实要清空」，不会被误判成「没传」。
   */
  const stored = all(
    'SELECT phrases, graph, wlogic, highlights, links, last_run FROM papers WHERE id = ?',
    [meta.id]
  )[0]
  const phrasesWrite = meta.phrases ?? parseJson<EnglishPhrase[]>(stored?.phrases, [])
  // 图谱是已下线功能，索引列仍在：undefined = 不携带、保留原值（老库里的数据不丢）
  const graphWrite = meta.graph ?? parseJson<unknown>(stored?.graph, undefined)
  /*
   * wlogic 走和 graph 完全一样的语义：undefined = 本次调用不携带，保留库里的；
   * `{}` = 明确清空。少了这一条，rescanVault（改自定义分类就会触发）会把
   * 全库的写作逻辑卡一起清掉 —— 而它是套路库的唯一数据来源。
   */
  const wlogicWrite =
    meta.wlogic ?? normalizeWritingLogic(parseJson<unknown>(stored?.wlogic, undefined))
  const highlightsWrite = meta.highlights ?? parseJson<Highlight[]>(stored?.highlights, [])
  // 关系同样是已下线功能：不携带就保留库里原值
  const linksWrite = meta.links ?? parseJson<unknown>(stored?.links, [])

  run(
    `INSERT OR REPLACE INTO papers
     (${PAPER_UPSERT_COLUMNS})
     VALUES (${PAPER_UPSERT_PLACEHOLDERS})`,
    [
      meta.id,
      meta.title,
      JSON.stringify(meta.authors),
      meta.year,
      meta.venue,
      meta.url,
      meta.arxivId,
      meta.doi,
      meta.status,
      meta.rating,
      meta.importance,
      JSON.stringify(meta.categories),
      JSON.stringify(meta.tags),
      meta.pdf,
      relPath,
      expJson,
      JSON.stringify(phrasesWrite),
      JSON.stringify(graphWrite ?? {}),
      JSON.stringify(wlogicWrite ?? {}),
      JSON.stringify(highlightsWrite),
      JSON.stringify(linksWrite),
      tldr,
      blob,
      charCount,
      aiFilled,
      metrics.writing,
      metrics.experiment,
      Math.round(input.fileMtime ?? 0),
      Math.round(input.fileSize ?? 0),
      createdAt,
      updatedAt,
      JSON.stringify(normalizeLearningReview(meta.learningReview) ?? {}),
      String(stored?.last_run ?? '')
    ]
  )
}

export function removePaperRow(id: string): void {
  run('DELETE FROM papers WHERE id = ?', [id])
}

/* ------------------------------------------------------------------ */
/*  精读运行记录                                                        */
/* ------------------------------------------------------------------ */

/**
 * 记下一次精读的结局。
 *
 * 单独走一条 UPDATE 而不是 `upsertPaper`：记录运行结果是高频且轻量的动作，
 * 而整行写入要重算派生指标、还要把 search_blob 整个重建一遍 ——
 * 「补齐画像」批量跑 50 篇时会白白变成 50 次全量写。
 */
export function setPaperRun(id: string, record: LensRunRecord | null): void {
  try {
    run('UPDATE papers SET last_run = ? WHERE id = ?', [record ? JSON.stringify(record) : '', id])
  } catch (err) {
    // 记录运行结果失败绝不该把精读本身搞挂 —— 它只是诊断信息
    console.error('[db] 写入精读运行记录失败', err)
  }
}

export function getPaperRun(id: string): LensRunRecord | null {
  try {
    const row = all('SELECT last_run FROM papers WHERE id = ?', [id])[0]
    const raw = String(row?.last_run ?? '')
    if (!raw.trim()) return null
    const parsed = JSON.parse(raw) as LensRunRecord
    // 形状不对就当没有：这段 JSON 是给人看的诊断信息，不值得为它崩界面
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.lenses)) return null
    return pruneRetiredLenses(parsed)
  } catch {
    return null
  }
}

export function clearPapers(): void {
  run('DELETE FROM papers')
}

function parseArr(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]'))
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function parseExp(value: unknown): ExperimentProfile {
  if (typeof value === 'string' && value.trim() && value !== '{}') {
    try {
      return normalizeExperimentProfile(JSON.parse(value))
    } catch {
      return normalizeExperimentProfile(null)
    }
  }
  if (value && typeof value === 'object') return normalizeExperimentProfile(value)
  return normalizeExperimentProfile(null)
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as T
      return parsed ?? fallback
    } catch {
      return fallback
    }
  }
  if (value && typeof value === 'object') return value as T
  return fallback
}

function mapPaperRow(row: Row): PaperSummary {
  const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : d)
  return {
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    authors: parseArr(row.authors),
    year: row.year == null ? null : num(row.year),
    venue: String(row.venue ?? ''),
    status: String(row.status ?? 'inbox') as PaperStatus,
    rating: num(row.rating),
    importance: num(row.importance, 3),
    categories: parseArr(row.categories),
    tags: parseArr(row.tags),
    exp: parseExp(row.exp),
    /*
     * 过一遍归一化，而不是直接信 JSON。
     *
     * 索引里可能存着 `{}` 这种空壳（老版本写进去的），透出去的话，拿到它的人
     * 只要写一句 `graph.entities.length` 就崩 —— 实测崩在**保存笔记**那一步，
     * 整篇 frontmatter 都写不出去。归一化顺带保证 relations 键存在、kind 是已知值，
     * 下游就不用到处写防御性代码。
     */
    phrases: normalizePhrases(parseJson<EnglishPhrase[]>(row.phrases, [])),
    tldr: String(row.tldr ?? ''),
    updatedAt: new Date(num(row.updated_at)).toISOString(),
    relPath: String(row.rel_path ?? ''),
    hasPdf: !!String(row.pdf ?? ''),
    charCount: num(row.char_count),
    aiFilled: num(row.ai_filled) === 1
  }
}

const PAPER_COLUMNS = `id, title, authors, year, venue, url, arxiv_id, doi, status, rating,
  importance, categories, tags, pdf, rel_path, exp, phrases, graph, wlogic, highlights, links, tldr,
  char_count, ai_filled, writing_notes, experiment_notes, created_at, updated_at, learning_review`

const SUMMARY_COLUMNS = `id, title, authors, year, venue, url, arxiv_id, doi, status, rating,
  importance, categories, tags, pdf, rel_path, exp, phrases, graph, links, tldr,
  char_count, ai_filled, writing_notes, experiment_notes, created_at, updated_at, learning_review`

export function listPaperRows(): PaperSummary[] {
  const rows = all(`SELECT ${SUMMARY_COLUMNS} FROM papers ORDER BY updated_at DESC`)
  return rows.map(mapPaperRow)
}

/**
 * 渲染层列表用的瘦身列：不带 graph / phrases 两个大 JSON 字段。
 * 渲染层没有任何组件从列表项读它们（图谱走 graph:snapshot、句式走
 * phrases:list），带着只会让每次刷新的 IPC 载荷白白膨胀好几 MB。
 * 主进程内部的消费者（构图、句式聚合等）继续用上面的全量版本。
 */
const LIST_COLUMNS = `id, title, authors, year, venue, url, arxiv_id, doi, status, rating,
  importance, categories, tags, pdf, rel_path, exp, '[]' AS phrases, '{}' AS graph, links,
  tldr, char_count, ai_filled, writing_notes, experiment_notes, created_at, updated_at, learning_review`

export function listPaperSummaries(): PaperSummary[] {
  const rows = all(`SELECT ${LIST_COLUMNS} FROM papers ORDER BY updated_at DESC`)
  return rows.map(mapPaperRow)
}

/** 「写作思路」页一行：论文身份 + 它的写作逻辑卡 */
export interface WritingLogicRow {
  id: string
  title: string
  year: number | null
  categories: string[]
  updatedAt: string
  wlogic?: WritingLogic
}

/**
 * 只给「写作思路」页用的窄查询。
 *
 * 为什么不把 wlogic 塞进 PaperSummary：卡片是几百字到两千字的 JSON，
 * 而列表页每次刷新都会整份传一遍 —— 和图谱、句式库当初被移出列表载荷
 * 是同一个理由（见 LIST_COLUMNS 上的注释）。这个页面按需拉，拉一次就够。
 */
export function listWritingLogicRows(): WritingLogicRow[] {
  const rows = all(
    'SELECT id, title, year, categories, updated_at, wlogic FROM papers ORDER BY updated_at DESC'
  )
  return rows.map((row) => {
    const logic = normalizeWritingLogic(parseJson<unknown>(row.wlogic, undefined))
    return {
      id: String(row.id ?? ''),
      title: String(row.title ?? ''),
      year: row.year == null ? null : Number(row.year),
      categories: parseArr(row.categories),
      updatedAt: new Date(Number(row.updated_at ?? 0)).toISOString(),
      ...(logic ? { wlogic: logic } : {})
    }
  })
}

/**
 * 全文检索：返回命中的论文 id。
 *
 * search_blob 里含标题 / 作者 / 会议 / 标签 / 分类 / 一句话总结 / 全部笔记正文 /
 * 实验画像 / 原文摘要，所以它的覆盖面**严格包含**原来渲染层那套 JS 过滤
 * （只扫标题、作者、总结、标签）。
 *
 * 为什么不建 FTS5 索引：sql.js 的构建没有编译 FTS5 模块
 * （`no such module: fts5`，见 `npm run bench:search`），而 FTS4 对中文同样
 * 按 token 分词，搜「检索」匹配不到「多跳检索」。tokenized LIKE 在个人知识库
 * 量级下实测 2000 篇约 8~12ms，够用且行为可预期。
 *
 * 空查询返回空数组 —— 「没有搜索词」应当表示「不过滤」，由调用方区分处理。
 */
export function searchPaperIds(query: string): string[] {
  const { where, params } = buildLikeClause('search_blob', query)
  if (!where) return []
  const rows = all(`SELECT id FROM papers WHERE ${where}`, params)
  return rows.map((row) => String(row.id ?? ''))
}

export function getPaperSummary(id: string): PaperSummary | null {
  const rows = all(`SELECT ${SUMMARY_COLUMNS} FROM papers WHERE id = ?`, [id])
  return rows[0] ? mapPaperRow(rows[0]) : null
}

export function getPaperRow(id: string): Row | null {
  const rows = all(`SELECT ${PAPER_COLUMNS} FROM papers WHERE id = ?`, [id])
  return rows[0] ?? null
}

/*
 * 这里曾经有 paperSections(id)：从索引的 sections 列反序列化章节内容。
 * 现在索引不再保存正文，章节一律按需从 Markdown 读取
 * （见 vault.readPaperSections），避免同一份内容存两处。
 */

export function paperMetaFromRow(row: Row): PaperMeta {
  const s = mapPaperRow(row)
  return {
    id: s.id,
    title: s.title,
    authors: s.authors,
    year: s.year,
    venue: s.venue,
    url: String(row.url ?? ''),
    arxivId: String(row.arxiv_id ?? ''),
    doi: String(row.doi ?? ''),
    status: s.status,
    rating: s.rating,
    importance: s.importance,
    categories: s.categories,
    tags: s.tags,
    exp: s.exp,
    phrases: s.phrases,
    // 高亮此前只存在 Markdown 里、索引缺这一列，导致所有保存路径都以为「没有高亮」
    // 而把 frontmatter 里的 highlights 键删掉 —— 详见 migrate() 里的说明
    highlights: parseJson<Highlight[]>(row.highlights, []),
    /*
     * 已下线功能的历史字段。列缺失时给 undefined（=「本次不携带」，落盘沿用磁盘值），
     * 而不是空值 —— 空值会被下游当成「这篇没有数据」写回去，把老数据抹掉。
     */
    graph: row.graph === undefined ? undefined : parseJson<unknown>(row.graph, undefined),
    links: row.links === undefined ? undefined : parseJson<unknown>(row.links, []),
    learningReview:
      row.learning_review === undefined
        ? undefined
        : normalizeLearningReview(parseJson<unknown>(row.learning_review, undefined)),
    /*
     * 和 links 同一条规则：列缺失时给 undefined（=「本次不携带」，
     * 落盘时沿用磁盘值），而不是 `{}`（=「明确清空」）。
     * 这条路径是精读写回时构造 nextMeta 用的 —— 给错成空值，
     * 一次只跑某个维度的重跑就会把整张写作逻辑卡清掉。
     */
    wlogic:
      row.wlogic === undefined
        ? undefined
        : normalizeWritingLogic(parseJson<unknown>(row.wlogic, undefined)),
    pdf: String(row.pdf ?? ''),
    createdAt: new Date(Number(row.created_at ?? Date.now())).toISOString(),
    updatedAt: s.updatedAt
  }
}

/* ------------------------------------------------------------------ */
/*  统计                                                                */
/* ------------------------------------------------------------------ */

function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * 统计只需要这几个标量列。
 *
 * 这里刻意不走 PAPER_COLUMNS：那会把 graph / phrases 两个大 JSON 一起捞出来，
 * 然后被 mapPaperRow 逐行 JSON.parse —— 而统计页一个字段都用不到它们。
 * 大库上这一次无谓的解析相当可观。
 */
const STATS_COLUMNS = `id, year, status, rating, categories, tags,
  char_count, writing_notes, experiment_notes, created_at`

export function computeStats(custom: TaxonomyNode[] = []): StatsOverview {
  const rows = all(`SELECT ${STATS_COLUMNS} FROM papers`)
  const byStatus: Record<PaperStatus, number> = { inbox: 0, reading: 0, read: 0, archived: 0 }
  const catCount = new Map<string, number>()
  const tagCount = new Map<string, number>()
  const yearCount = new Map<number, number>()
  const weekCount = new Map<string, number>()
  let totalChars = 0
  let withExperimentNotes = 0
  let withWritingNotes = 0
  let ratingSum = 0
  let ratingN = 0

  for (const row of rows) {
    const status = String(row.status ?? 'inbox') as PaperStatus
    byStatus[status] = (byStatus[status] ?? 0) + 1
    for (const c of parseArr(row.categories)) catCount.set(c, (catCount.get(c) ?? 0) + 1)
    for (const t of parseArr(row.tags)) tagCount.set(t, (tagCount.get(t) ?? 0) + 1)

    const year = row.year == null ? null : Number(row.year)
    if (year) yearCount.set(year, (yearCount.get(year) ?? 0) + 1)

    const rating = Number(row.rating ?? 0)
    if (rating > 0) {
      ratingSum += rating
      ratingN++
    }
    totalChars += Number(row.char_count ?? 0)

    const createdAt = Number(row.created_at ?? Date.now())
    const key = isoWeekKey(new Date(createdAt))
    weekCount.set(key, (weekCount.get(key) ?? 0) + 1)

    // 拆解完成度用的是写入时就算好的派生指标，不再反序列化整篇正文
    if (Number(row.experiment_notes ?? 0) >= 1) withExperimentNotes++
    if (Number(row.writing_notes ?? 0) >= WRITING_NOTES_MIN) withWritingNotes++
  }

  // 最近 12 周
  const weekly: { week: string; count: number }[] = []
  const cursor = new Date()
  for (let i = 11; i >= 0; i--) {
    const d = new Date(cursor)
    d.setDate(d.getDate() - i * 7)
    const key = isoWeekKey(d)
    weekly.push({ week: key, count: weekCount.get(key) ?? 0 })
  }

  return {
    total: rows.length,
    byStatus,
    byCategory: [...catCount.entries()]
      .map(([id, count]) => ({ id, label: categoryLabel(id, custom), count }))
      .sort((a, b) => b.count - a.count),
    byTag: [...tagCount.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 40),
    byYear: [...yearCount.entries()]
      .map(([year, count]) => ({ year, count }))
      .sort((a, b) => b.year - a.year)
      .slice(0, 12),
    weekly,
    totalChars,
    withExperimentNotes,
    withWritingNotes,
    avgRating: ratingN ? Math.round((ratingSum / ratingN) * 10) / 10 : 0
  }
}

export function paperCount(): number {
  const rows = all('SELECT COUNT(*) AS c FROM papers')
  return Number(rows[0]?.c ?? 0)
}

export function listPaperIds(): string[] {
  return all('SELECT id FROM papers').map((row) => String(row.id ?? ''))
}

/* ------------------------------------------------------------------ */
/*  专题索引                                                            */
/* ------------------------------------------------------------------ */

function mapCollectionRow(row: Row): PaperCollection {
  const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : Number(v ?? d) || d)
  return {
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    description: String(row.description ?? ''),
    paperIds: parseArr(row.paper_ids),
    notes: String(row.notes ?? ''),
    relPath: String(row.rel_path ?? ''),
    createdAt: new Date(num(row.created_at)).toISOString(),
    updatedAt: new Date(num(row.updated_at)).toISOString()
  }
}

export function upsertCollection(collection: PaperCollection): void {
  run(
    `INSERT INTO collections (id, title, description, paper_ids, notes, rel_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       paper_ids = excluded.paper_ids,
       notes = excluded.notes,
       rel_path = excluded.rel_path,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    [
      collection.id,
      collection.title,
      collection.description,
      JSON.stringify(collection.paperIds),
      collection.notes,
      collection.relPath,
      Date.parse(collection.createdAt) || Date.now(),
      Date.parse(collection.updatedAt) || Date.now()
    ]
  )
}

export function listCollections(): PaperCollection[] {
  return all('SELECT * FROM collections ORDER BY updated_at DESC').map(mapCollectionRow)
}

export function getCollection(id: string): PaperCollection | null {
  const rows = all('SELECT * FROM collections WHERE id = ?', [id])
  return rows[0] ? mapCollectionRow(rows[0]) : null
}

export function listCollectionIds(): string[] {
  return all('SELECT id FROM collections').map((row) => String(row.id ?? ''))
}

export function removeCollectionRow(id: string): void {
  run('DELETE FROM collections WHERE id = ?', [id])
}

export interface PaperFileStamp {
  id: string
  mtime: number
  size: number
}

/**
 * 磁盘扫描用：relPath → 已索引记录的文件指纹。
 * 有它才能在重新扫描时跳过「文件没变过」的论文，不必每次都把几百个
 * Markdown 重新解析、重新算 blob、重新写一遍索引。
 */
export function listFileStamps(): Map<string, PaperFileStamp> {
  const rows = all('SELECT id, rel_path, file_mtime, file_size FROM papers')
  const map = new Map<string, PaperFileStamp>()
  for (const row of rows) {
    const rel = String(row.rel_path ?? '')
    if (!rel) continue
    map.set(rel, {
      id: String(row.id ?? ''),
      mtime: Number(row.file_mtime ?? 0),
      size: Number(row.file_size ?? 0)
    })
  }
  return map
}

/**
 * 正文内容指纹：论文增删、或任何一篇的笔记正文变化都会让它改变。
 *
 * 与 graphStamp 的区别是它盯着 search_blob（含全部笔记正文）与 phrases，
 * 而不是 graph 字段，所以「手改了章节内容」「单独重跑了英语短语维度」
 * 都能被感知到 —— 句式库缓存靠它失效。
 */
export function contentStamp(): string {
  if (!db) return '0:0:0:0'
  const rows = all(
    `SELECT COUNT(*) AS c,
            COALESCE(SUM(LENGTH(search_blob)), 0) AS b,
            COALESCE(SUM(LENGTH(phrases)), 0) AS p,
            COALESCE(MAX(updated_at), 0) AS t
     FROM papers`
  )
  const row = rows[0] ?? {}
  return `${row.c ?? 0}:${row.b ?? 0}:${row.p ?? 0}:${row.t ?? 0}`
}

/* ------------------------------------------------------------------ */
/*  meta 键值表（迁移 / 全局指纹用）                                     */
/* ------------------------------------------------------------------ */

export function metaGet(key: string): string | null {
  const rows = all('SELECT value FROM meta WHERE key = ?', [key])
  return rows[0] ? String(rows[0].value ?? '') : null
}

export function metaSet(key: string, value: string): void {
  run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value])
}
