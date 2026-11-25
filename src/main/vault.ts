import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'path'
import matter from 'gray-matter'
import { normalizeExperimentProfile, profileCompleteness } from '@shared/experiment'
import { figureMarkdown, isImagePath, normalizeFigureExtension } from '@shared/figures'
import { normalizeMethodFlow, type MethodFlow } from '@shared/flow'
import { normalizeMindMap, type MindMap } from '@shared/mindmap'
import { normalizeHighlights } from '@shared/highlights'
import type { Highlight } from '@shared/highlights'
import { normalizePhrases, type EnglishPhrase } from '@shared/lenses'
import { ideaMarkdown, parseIdea, type ResearchIdea } from '@shared/ideas'
import { DEFAULT_READING_SKILL, READING_SKILL_FILE } from '@shared/reading-skill'
import { normalizeProblems, problemMapMarkdown, type ProblemMap } from '@shared/problems'
import { normalizeWritingLogic, type WritingLogic } from '@shared/writing-logic'
import { paperPreamble, parsePaperBody, renderPaperBody, SECTION_ORDER } from '@shared/template'
import type { PaperCollection, PaperMeta, PaperStatus } from '@shared/types'
import { assertGranted } from './file-grants'

export const VAULT_DIRS = {
  meta: '.papervault',
  pdfs: '.papervault/pdfs',
  texts: '.papervault/texts',
  papers: 'papers',
  /** 从原文里裁下来的图。跟 papers/ 平级，见 shared/figures.ts 的说明 */
  figures: 'figures',
  syntheses: 'syntheses',
  /** 用户手动归到一起的论文组，见 shared/types.ts 的 PaperCollection */
  collections: 'collections',
  /** 开放问题池，每个范围一份，见 shared/problems.ts */
  problems: 'problems',
  /** 选题本：从开放问题生成、用户长期跟进的选题，见 shared/ideas.ts */
  ideas: 'ideas',
  /** 用户可编辑的读论文风格，见 shared/reading-skill.ts */
  skills: 'skills',
  /** 从原文抽出的参考文献列表（派生数据，可重新抽取） */
  refs: '.papervault/refs'
}

export interface ParsedPaperFile {
  meta: PaperMeta
  body: string
  sections: Record<string, string>
  relPath: string
  absPath: string
}

const RESERVED = /[\\/:*?"<>|#%{}^~[\]`]/g

export function slugify(title: string): string {
  const cleaned = title
    .normalize('NFKC')
    .replace(RESERVED, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
  return cleaned || 'paper'
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8)
}

export function newPaperId(title: string): string {
  return `${slugify(title)}-${shortId()}`
}

export function newCollectionId(title: string): string {
  return `${slugify(title)}-${shortId()}`
}

export function ensureVaultStructure(vaultPath: string): void {
  for (const dir of Object.values(VAULT_DIRS)) {
    mkdirSync(join(vaultPath, dir), { recursive: true })
  }
  const readme = join(vaultPath, 'README.md')
  if (!existsSync(readme)) {
    writeFileSync(readme, VAULT_README, 'utf-8')
  }
  const skill = join(vaultPath, READING_SKILL_FILE)
  if (!existsSync(skill)) {
    writeFileSync(skill, DEFAULT_READING_SKILL, 'utf-8')
  }
}

export function readReadingSkill(vaultPath: string): string {
  const abs = join(vaultPath, READING_SKILL_FILE)
  try {
    return existsSync(abs) ? readFileSync(abs, 'utf-8') : DEFAULT_READING_SKILL
  } catch {
    return DEFAULT_READING_SKILL
  }
}

export function writeReadingSkill(vaultPath: string, content: string): void {
  ensureVaultStructure(vaultPath)
  writeFileSync(join(vaultPath, READING_SKILL_FILE), content, 'utf-8')
}

export const VAULT_README = `# PaperVault 知识库

这是由 PaperVault 管理的本地论文知识库。

- \`papers/\` 每篇论文一个 Markdown 文件，frontmatter 存书目信息，正文是固定章节的精读笔记。
- \`figures/\` 从原文里裁下来的图（图表、框架图），笔记用相对路径引用，可直接用看图软件浏览。
- \`collections/\` 专题：用户手动归到一起的论文组，方便指定 agent 专门分析这一块。
- \`problems/\` 开放问题池：把多篇论文的局限与未来工作聚成的问题清单（全库一份，每个专题一份）。
- \`skills/读论文风格.md\` 精读 agent 的口吻与导读结构，改它就能改 AI 的写法。
- \`ideas/\` 选题本：从开放问题生成的选题，每个一份，含假设、最小验证实验、反证条件和你的备注。
- \`syntheses/\` 跨论文文档：套路归纳、研究想法、组合分析。
- \`.papervault/\` 索引与附件（PDF 副本、抽取出的原文文本）。

删掉 \`.papervault/\` 后重建索引，可以从 Markdown 恢复书目、笔记正文、实验画像和高亮；
但**知识图谱与句式库只存在索引里**，删除后需要用 AI 重新抽取。

整个目录可以直接用 Git 管理。
`

export function vaultRelative(vaultPath: string, absPath: string): string {
  return relative(vaultPath, absPath).split('\\').join('/')
}

/**
 * 把知识库内的相对路径解析成绝对路径；越界（`../` 逃出知识库）返回 null。
 *
 * frontmatter 里的 `pdf` / `relPath` 都是可以被手工改写的，凡是「拿它去
 * 读写磁盘」的地方都必须先过这一关，否则一个 `pdf: ../../../x` 就能删到
 * 知识库外的文件。
 */
export function resolveInside(vaultPath: string, relPath: string): string | null {
  const root = resolve(vaultPath)
  const abs = resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + sep)) return null
  return abs
}

export function listPaperFiles(vaultPath: string): string[] {
  const root = join(vaultPath, VAULT_DIRS.papers)
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') out.push(abs)
    }
  }
  walk(root)
  return out
}

/**
 * 已下线功能的历史字段：空对象 / 空数组一律当「没有」。
 *
 * 这些字段不再有业务含义，只剩下「别把用户磁盘上的数据抹掉」这一个责任。
 * 但空壳不能反过来污染磁盘：`graph: {}` / `links: []` 写回去既没有信息，
 * 又会让「有没有这个键」这种判断失去意义（老版本就踩过 `{}` 让保存崩掉）。
 */
function legacyField(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined
  if (Array.isArray(raw)) return raw.length ? raw : undefined
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    const keys = Object.keys(obj)
    if (!keys.length) return undefined
    /*
     * `{ entities: [], relations: [] }` 这种「壳还在、内容清空」也要当没有：
     * 图谱的清空语义一直是「实体为空」，只看键数会把它写成 `graph:` 空结构。
     */
    const values = Object.values(obj)
    if (values.every((v) => Array.isArray(v) && v.length === 0)) return undefined
    return raw
  }
  return raw
}

function normalizeMeta(raw: Record<string, unknown>, fallbackId: string): PaperMeta {
  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : v ? [String(v)] : []
  const num = (v: unknown, d: number | null): number | null => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
    return Number.isFinite(n) ? n : d
  }
  const status = str(raw.status) as PaperStatus

  return {
    id: str(raw.id) || fallbackId,
    title: str(raw.title),
    authors: arr(raw.authors),
    year: num(raw.year, null),
    venue: str(raw.venue),
    url: str(raw.url),
    arxivId: str(raw.arxivId),
    doi: str(raw.doi),
    status: (['inbox', 'reading', 'read', 'archived'] as const).includes(status) ? status : 'inbox',
    rating: Math.max(0, Math.min(5, num(raw.rating, 0) ?? 0)),
    importance: Math.max(1, Math.min(5, num(raw.importance, 3) ?? 3)),
    categories: arr(raw.categories),
    tags: arr(raw.tags),
    exp: raw.exp ? normalizeExperimentProfile(raw.exp) : undefined,
    highlights: normalizeHighlights(raw.highlights),
    flow: raw.flow ? normalizeMethodFlow(raw.flow) : undefined,
    mindmap: raw.mindmap ? normalizeMindMap(raw.mindmap) : undefined,
    /*
     * 已下线功能的历史字段，原样透传。
     *
     * 不再 normalize —— 解析器已经删了，但**必须原样带回去**：`writePaperFile`
     * 是白名单重建 frontmatter，不带上就等于在用户保存时把这些数据永久删掉。
     * 空对象 / 空数组当「没有」，避免把空壳写回磁盘（见 legacyField）。
     */
    quiz: legacyField(raw.quiz),
    slides: legacyField(raw.slides),
    // 关系是数组：没有这个键时给空数组，下游按「一篇都没连过」处理
    links: legacyField(raw.links) ?? [],
    learningReview: legacyField(raw.learningReview),
    graph: legacyField(raw.graph),
    /*
     * 写作逻辑卡同理：它只活在 Markdown 里，索引那一列是镜像。
     * 少了这一行，一次「重建索引」就会让整个「写作思路」页变成空的。
     */
    wlogic: raw.wlogic ? normalizeWritingLogic(raw.wlogic) : undefined,
    phrases: normalizePhrases(raw.phrases),
    pdf: str(raw.pdf),
    createdAt: str(raw.createdAt) || new Date().toISOString(),
    updatedAt: str(raw.updatedAt) || new Date().toISOString()
  }
}

export function readPaperFile(absPath: string, vaultPath: string): ParsedPaperFile | null {
  try {
    const raw = readFileSync(absPath, 'utf-8')
    const parsed = matter(raw)
    const fallbackId = basename(absPath, '.md')
    const meta = normalizeMeta(parsed.data as Record<string, unknown>, fallbackId)
    const body = parsed.content.replace(/^\n+/, '')
    return {
      meta,
      body,
      sections: parsePaperBody(body),
      relPath: vaultRelative(vaultPath, absPath),
      absPath
    }
  } catch (err) {
    console.error('[vault] 读取失败', absPath, err)
    return null
  }
}

/**
 * 按 id 找到磁盘上那篇论文的文件（文件名可能被用户改过）并**整份**读回来。
 *
 * 返回整份而不是只返回章节，是为了让需要原文的地方（详情页的「导出 Markdown」）
 * 也能拿到正文里不属于任何章节的那部分 —— 见 `paperPreamble`。
 */
export function readPaperFileById(
  vaultPath: string,
  id: string,
  relPath?: string
): ParsedPaperFile | null {
  /*
   * 一律过 resolveInside。relPath 虽然来自索引、由扫描器从真实路径算出，
   * 但和 frontmatter 里的 `pdf` 属于同一类输入 ——「拿它去读写磁盘」——
   * 按本项目的规矩就该在这一关挡一次（绝对路径与 `../` 都会被拒）。
   */
  const abs = resolveInside(vaultPath, relPath || join(VAULT_DIRS.papers, `${id}.md`))
  if (!abs || !existsSync(abs)) return null
  return readPaperFile(abs, vaultPath)
}

/**
 * 按 id 读取一篇论文的章节内容。
 *
 * 索引里不再保存正文（避免同一份内容存两处、索引膨胀），所以章节一律
 * 从这里按需读 Markdown。读单篇的成本可以忽略；批量场景（句式库、
 * 套路归纳）也只在用户显式触发时发生。
 *
 * `relPath` 是索引里记下的真实文件位置。文件名不一定是 `${id}.md`
 * （用户可能手动重命名过），传上它才不会读空。
 */
export function readPaperSections(
  vaultPath: string,
  id: string,
  relPath?: string
): Record<string, string> {
  return readPaperFileById(vaultPath, id, relPath)?.sections ?? {}
}

/**
 * 读一遍磁盘上已有的那个文件，取回写回时需要的两样东西：
 * frontmatter 里的 `id`，以及正文里第一个 `## ` 之前那段不属于任何章节的内容。
 *
 * 两样都要，是因为它们回答的是两个不同的问题：「这个文件还是这篇论文的吗」
 * 和「用户手写在顶部的东西是什么」。读一次文件同时拿到，不必读两遍。
 */
function inspectExistingPaper(
  absPath: string
): {
  id: string
  preamble: string
  highlights: Highlight[]
  flow?: MethodFlow
  mindmap?: MindMap
  /** 已下线功能的历史数据：原样透传，不解析 */
  quiz?: unknown
  slides?: unknown
  links?: unknown
  learningReview?: unknown
  graph?: unknown
  wlogic?: WritingLogic
  phrases?: EnglishPhrase[]
} | null {
  try {
    const parsed = matter(readFileSync(absPath, 'utf-8'))
    const data = parsed.data as Record<string, unknown> | undefined
    const rawId = data?.id
    return {
      id: typeof rawId === 'string' ? rawId : '',
      preamble: paperPreamble(parsed.content),
      highlights: normalizeHighlights(data?.highlights),
      flow: normalizeMethodFlow(data?.flow),
      mindmap: normalizeMindMap(data?.mindmap),
      quiz: legacyField(data?.quiz),
      slides: legacyField(data?.slides),
      links: legacyField(data?.links) ?? [],
      learningReview: legacyField(data?.learningReview),
      graph: legacyField(data?.graph),
      wlogic: data?.wlogic ? normalizeWritingLogic(data.wlogic) : undefined,
      phrases: normalizePhrases(data?.phrases)
    }
  } catch {
    return null
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * 递归丢掉值为 `undefined` 的键（顺带把丢掉的位置记进 `dropped`）。
 *
 * 为什么要有这道兜底：frontmatter 是交给 js-yaml **整篇**序列化的，而它遇到
 * undefined 值直接抛「unacceptable kind of an object to dump [object Undefined]」。
 * 抛在这一步的代价特别大 —— 精读跑了十几分钟，产出一个字都写不出去，笔记停在
 * 空骨架，界面上只留一句看不出是哪个字段的报错（`last_run` 里也只有这一句）。
 *
 * 这个坑已经踩到第三次了（画像的 `error` → 高亮的 `note` → 图谱的 `aliases` /
 * `evidence` 与句式库的 `example` / `from`），每次都是「某个可选字段没值时顺手
 * 写成了 undefined」。所以除了逐个修掉源头，这里再兜一层：宁可少写一个键，
 * 也不要让一个字段毁掉整篇。丢掉的键会打进主进程日志 —— 它意味着上游有地方
 * 该用「没有这个键」来表达「没有这个值」。
 */
function stripUndefined<T>(value: T, dropped: string[] = [], path = ''): T {
  if (Array.isArray(value)) {
    return value.map((item, i) => stripUndefined(item, dropped, `${path}[${i}]`)) as unknown as T
  }
  // 只递归普通对象：Date / Map 这类碰了会变形成空对象
  if (value && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const child = path ? `${path}.${key}` : key
      if (item === undefined) {
        dropped.push(child)
        continue
      }
      out[key] = stripUndefined(item, dropped, child)
    }
    return out as T
  }
  return value
}

export function writePaperFile(
  vaultPath: string,
  meta: PaperMeta,
  sections: Record<string, string>,
  customSections: string[] = [],
  /** 索引里记下的真实文件位置。文件名可能被用户手动改过，见下方注释 */
  existingRelPath?: string
): ParsedPaperFile {
  ensureVaultStructure(vaultPath)
  const now = new Date().toISOString()
  const finalMeta: PaperMeta = { ...meta, updatedAt: now }

  /*
   * 先定「这次写到哪个文件」，不能一律写 `${id}.md`。
   *
   * `readPaperSections` 专门收一个 relPath，就是因为文件名不一定是 `${id}.md`
   * —— 用户会把 `abc.md` 手动改成 `我的论文.md`，而索引里记的是真实位置。
   * 写回时若不认旧文件名，就会凭空新造一个 `${id}.md`：同一个 id 在库里出现
   * 两份笔记，下一次扫描谁覆盖谁还取决于文件系统的遍历顺序，用户看到的正文
   * 会变得不确定，而他改过名的那份从此变成孤儿。
   *
   * 只认「frontmatter 里的 id 就是这篇」的文件：万一用户把两个文件的内容对调过，
   * 也不至于把 A 的正文写进 B 的文件。
   */
  const fallbackRel = join(VAULT_DIRS.papers, `${finalMeta.id}.md`)
  const target = [existingRelPath, fallbackRel]
    .filter((rel): rel is string => !!rel)
    .map((rel) => resolveInside(vaultPath, rel))
    .filter((abs): abs is string => !!abs && existsSync(abs))
    .map((abs) => ({ abs, info: inspectExistingPaper(abs) }))
    .find((c) => !c.info?.id || c.info.id === finalMeta.id)

  /*
   * 索引里记着路径、磁盘上却找不到 → 这份笔记被外部删掉或改名了。
   * 这时候**不能凭空新建**：那等于把「删除」悄悄撤销；改名的情形还会新造出
   * `${id}.md`，同一个 id 在库里出现两份笔记（谁覆盖谁取决于遍历顺序）。
   * 让用户先「重建索引」把索引和磁盘对齐 —— 保存动作不该替用户决定这件事。
   */
  if (!target && existingRelPath) {
    throw new Error(
      '这篇笔记的文件不在磁盘上了（可能被外部删除或改名）。先执行一次「重建索引」，再保存。'
    )
  }
  // fallback 也要过 resolveInside：id 来自 frontmatter（共享 vault 里可能被改成 `../../x`）
  const fallbackAbs = resolveInside(vaultPath, fallbackRel)
  if (!fallbackAbs) throw new Error('笔记路径非法，已拒绝写入。')
  const absPath = target?.abs ?? fallbackAbs

  /*
   * 第一个 `## ` 之前的内容原样带回去。
   * `renderPaperBody` 是从章节字典重建整篇正文的，不带就等于每次保存都把
   * 用户手写的导语 / 大标题删掉 —— 而「保存」的触发点包括批量改属性。
   */
  const preamble = target?.info?.preamble ?? ''
  const rendered = renderPaperBody(sections, customSections)
  const body = preamble ? `${preamble}\n\n${rendered}` : rendered

  // 注意：不能把 undefined 放进 frontmatter —— js-yaml 遇到 undefined 会抛
  // "unacceptable kind of an object to dump"。没有值的字段直接不写这个键。
  const frontmatter: Record<string, unknown> = {
    id: finalMeta.id,
    title: finalMeta.title,
    authors: finalMeta.authors,
    venue: finalMeta.venue,
    url: finalMeta.url,
    arxivId: finalMeta.arxivId,
    doi: finalMeta.doi,
    status: finalMeta.status,
    rating: finalMeta.rating,
    importance: finalMeta.importance,
    categories: finalMeta.categories,
    tags: finalMeta.tags,
    pdf: finalMeta.pdf,
    createdAt: finalMeta.createdAt,
    updatedAt: finalMeta.updatedAt
  }
  if (finalMeta.year != null) frontmatter.year = finalMeta.year
  // 没有抽取过实验画像的论文不写这个键，保持 frontmatter 干净
  if (finalMeta.exp && profileCompleteness(finalMeta.exp) > 0) {
    frontmatter.exp = finalMeta.exp
  }
  /*
   * 高亮和上面的 preamble 是同一类问题：它只存在 Markdown 里（索引过去根本没有
   * 这一列），所以有些调用路径构造出来的 meta 不带 highlights。
   * 没有这一句「没传就沿用磁盘上的」，保存一次就会把用户手划的高亮整段删掉 ——
   * 高亮丢了没法重建，比丢一段 AI 结果严重得多。
   */
  const highlights = finalMeta.highlights ?? target?.info?.highlights ?? []
  // 没有高亮就不写这个键，避免给每篇论文都塞一个空数组
  if (highlights.length) {
    frontmatter.highlights = highlights
  }
  /*
   * 流程图和高亮是同一类问题：它由 AI 写进 frontmatter，而索引里没有这一列，
   * 于是「批量改属性」「改个评分」这些路径构造出来的 meta 都不带它 ——
   * 少了下面这句「meta 没给就沿用磁盘上的」，随便保存一次就会把图删掉。
   */
  const flow = finalMeta.flow ?? target?.info?.flow
  if (flow) {
    frontmatter.flow = flow
  }
  // 思维导图和自测题是同一类问题：meta 没给就沿用磁盘上的，否则普通保存会抹掉
  const mindmap = finalMeta.mindmap ?? target?.info?.mindmap
  if (mindmap) {
    frontmatter.mindmap = mindmap
  }
  const phrases = finalMeta.phrases ?? target?.info?.phrases
  if (phrases?.length) {
    frontmatter.phrases = phrases
  }
  /*
   * 写作逻辑卡与图谱同一类问题：只存在 Markdown 里，而「改评分」「批量加标签」
   * 这些路径构造出来的 meta 不带它。少了「meta 没给就沿用磁盘上的」这一句，
   * 顺手保存一次就会把整张卡抹掉 —— 而它没法从正文重新长出来。
   *
   * 要把规整后的结果写回 finalMeta：紧接着的 upsert 会拿它进索引列，
   * 不写回的话索引和磁盘会在下一次保存时漂移。
   */
  const wlogic = finalMeta.wlogic ?? target?.info?.wlogic
  if (wlogic?.storyline?.oneliner) {
    frontmatter.wlogic = wlogic
  }
  finalMeta.wlogic = wlogic
  /*
   * 已下线功能的字段：quiz / slides / links / learningReview / graph。
   *
   * 只做「meta 没给就沿用磁盘旧值」的透传，不解析、不规整、不参与业务判断。
   * 保留的唯一理由是**不能让老数据在用户保存时消失** —— 这几个键在磁盘上可能存着
   * 之前花 token 生成的题目、讲稿和关系，删了应用内也再没有入口能恢复。
   * 用户想清理就自己用 Obsidian 删键。
   */
  for (const key of ['quiz', 'slides', 'links', 'learningReview', 'graph'] as const) {
    const value = legacyField(finalMeta[key] ?? target?.info?.[key])
    // frontmatter 是从空白对象逐键重建的：不写这一行，等价于把磁盘上的键删掉。
    // 空壳不写则保证「显式清空」真的会删键，而不是留一个 {} / []。
    if (value !== undefined) {
      frontmatter[key] = value
    }
  }

  // 写盘前兜一层：万一还有哪个字段是 undefined，也只丢那一个键，不整篇失败
  const dropped: string[] = []
  const serializable = stripUndefined(frontmatter, dropped)
  if (dropped.length) {
    console.warn(`[vault] frontmatter 里有值为 undefined 的键，已跳过：${dropped.join('、')}`)
  }
  writeFileSync(absPath, matter.stringify(body, serializable), 'utf-8')

  return {
    meta: finalMeta,
    body,
    sections,
    relPath: vaultRelative(vaultPath, absPath),
    absPath
  }
}

/** 删除知识库内的一个文件；路径越界（`../`）时拒绝执行 */
export function deletePaperFile(vaultPath: string, relPath: string): boolean {
  const abs = resolveInside(vaultPath, relPath)
  if (!abs || !existsSync(abs)) return false
  rmSync(abs, { force: true })
  return true
}

export function saveExtractedText(vaultPath: string, id: string, text: string): string {
  const dir = join(vaultPath, VAULT_DIRS.texts)
  mkdirSync(dir, { recursive: true })
  const abs = join(dir, `${id}.txt`)
  writeFileSync(abs, text, 'utf-8')
  return vaultRelative(vaultPath, abs)
}

export function readExtractedText(vaultPath: string, id: string): string {
  /*
   * 必须过 resolveInside：id 是渲染层传下来的（`papers:text` 原样透传），
   * 不收敛就往 `texts/` 里拼的话，`../../../某处/secret` 这样的 id 能读到
   * 知识库之外的 .txt 文件。这是全项目唯一漏掉这道校验的读入口。
   */
  const abs = resolveInside(vaultPath, join(VAULT_DIRS.texts, `${id}.txt`))
  if (!abs || !existsSync(abs)) return ''
  try {
    return readFileSync(abs, 'utf-8')
  } catch {
    return ''
  }
}

/**
 * 把外部 PDF 复制进知识库。
 *
 * 这里是「外部文件 → 知识库」的唯一通道，所以授权校验放在这里而不是调用方：
 * 将来多一个调用者也不会漏掉。`sourcePath` 来自渲染层，绝不可信 ——
 * 没有这一层校验，渲染层可以把磁盘上任意文件复制进库再读回来。
 */
export function copyPdfIntoVault(vaultPath: string, sourcePath: string, id: string): string {
  const source = assertGranted(sourcePath, '导入 PDF')
  const dir = join(vaultPath, VAULT_DIRS.pdfs)
  mkdirSync(dir, { recursive: true })
  const ext = extname(source) || '.pdf'
  const abs = join(dir, `${id}${ext}`)
  copyFileSync(source, abs)
  return vaultRelative(vaultPath, abs)
}

/** 列出 vault 内所有已保存的原文文本文件名（对应 paper id） */
export function listExtractedTextIds(vaultPath: string): string[] {
  const dir = join(vaultPath, VAULT_DIRS.texts)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => basename(f, '.txt'))
}

/* ------------------------------------------------------------------ */
/*  原文图表                                                            */
/* ------------------------------------------------------------------ */

/**
 * 一篇论文的图库目录名。paperId 来自渲染层，不能直接当路径用 ——
 * 一个 `../../x` 就能把图写到知识库外面去。所以先剥掉所有路径分隔符，
 * 再用 resolveInside 复核落点仍在库内。
 *
 * 只剥路径分隔符与 NUL，**不要**顺手把非 ASCII 一起过滤掉：
 * 论文 id 里带中文是常态（这个项目的笔记文件名就是中文标题），
 * 滤掉之后目录名只剩一串短后缀，用户在图库目录里认不出哪张图属于哪篇。
 */
function figureDirName(paperId: string): string {
  return (
    (paperId ?? '')
      .replace(/[/\\\0]/g, '')
      // 纯点号（`.` / `..`）会指到知识库本身或上一级，当没给名字处理
      .replace(/^\.+$/, '')
      .slice(0, 80) || 'unknown'
  )
}

/** fig-2 要排在 fig-10 前面，按数字比，不按字符串比 */
function figureOrder(name: string): number {
  return Number(/^fig-(\d+)\./.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER)
}

/**
 * 列出一篇论文截过的全部图，返回相对知识库根的路径，按 fig-N 升序。
 * 保存和列举走同一个目录名清洗 —— 两处规则一旦漂移，列出来的就不是存进去的。
 */
export function listFigures(vaultPath: string, paperId: string): string[] {
  const dir = resolveInside(vaultPath, join(VAULT_DIRS.figures, figureDirName(paperId)))
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => isImagePath(f))
    .sort((a, b) => figureOrder(a) - figureOrder(b) || a.localeCompare(b))
    .map((f) => vaultRelative(vaultPath, join(dir, f)))
}

/**
 * 删一张图。比 readFigure 更严一道：路径必须真的落在 figures/ 里。
 * 读的白名单放开到全库，是因为笔记正文可能引用库内任意位置的图；
 * 删除的口子只开给图库本身 —— 用户手动放进笔记目录的图片资产，
 * 不归这条通道管。
 */
export function deleteFigure(vaultPath: string, relPath: string): boolean {
  if (!isImagePath(relPath)) return false
  const abs = resolveInside(vaultPath, relPath)
  const root = resolveInside(vaultPath, VAULT_DIRS.figures)
  if (!abs || !root || !abs.startsWith(root + sep)) return false
  try {
    rmSync(abs)
    return true
  } catch {
    return false
  }
}

/**
 * 保存一张从原文里裁下来的图，返回它**相对知识库根目录**的路径。
 */
export function saveFigure(
  vaultPath: string,
  paperId: string,
  data: Uint8Array,
  ext?: string
): string | null {
  const dir = resolveInside(vaultPath, join(VAULT_DIRS.figures, figureDirName(paperId)))
  if (!dir) return null
  mkdirSync(dir, { recursive: true })
  const abs = join(dir, nextFigureName(dir, ext))
  writeFileSync(abs, data)
  return vaultRelative(vaultPath, abs)
}

/** fig-1.png、fig-2.png … 照已有文件递增，图在文件管理器里也是按顺序排的 */
function nextFigureName(dir: string, ext?: string): string {
  let max = 0
  try {
    for (const name of readdirSync(dir)) {
      const m = /^fig-(\d+)\./.exec(name)
      if (m) max = Math.max(max, Number(m[1]))
    }
  } catch {
    /* 目录还不存在，从 1 开始 */
  }
  return `fig-${max + 1}${normalizeFigureExtension(ext)}`
}

/**
 * 读一张图给界面显示。
 *
 * 两道限制缺一不可：扩展名必须在白名单里（否则这条通道就成了「读知识库里
 * 任意文件」的通用口子），路径必须落在知识库内。
 */
export function readFigure(vaultPath: string, relPath: string): Uint8Array | null {
  if (!isImagePath(relPath)) return null
  const abs = resolveInside(vaultPath, relPath)
  if (!abs || !existsSync(abs)) return null
  try {
    return new Uint8Array(readFileSync(abs))
  } catch {
    return null
  }
}

/**
 * 笔记里该写的相对路径。
 *
 * 写成**相对笔记文件**的路径（`../figures/<id>/fig-1.png`），而不是绝对路径或
 * 自定义协议：知识库整个搬走不会断链，在 Obsidian / VS Code 里也能直接显示。
 *
 * 这段算在 main 侧，因为只有这里同时知道笔记的真实位置（用户可能把笔记放进了
 * 子目录，那层级就不是 `../`）和图库的位置。
 */
export function figureMarkdownFor(noteRelPath: string, figureRelPath: string): string {
  const rel = relative(dirname(noteRelPath), figureRelPath).split('\\').join('/')
  return figureMarkdown(rel)
}

/* ------------------------------------------------------------------ */
/*  专题文件                                                            */
/* ------------------------------------------------------------------ */

function walkMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') out.push(abs)
    }
  }
  walk(root)
  return out
}

export function listCollectionFiles(vaultPath: string): string[] {
  return walkMarkdownFiles(join(vaultPath, VAULT_DIRS.collections))
}

function uniqueIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of ids) {
    const id = String(raw ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export function readCollectionFile(absPath: string, vaultPath: string): PaperCollection | null {
  try {
    const raw = readFileSync(absPath, 'utf-8')
    const parsed = matter(raw)
    const data = parsed.data as Record<string, unknown>
    const id = typeof data.id === 'string' ? data.id.trim() : ''
    if (!id) return null
    const createdAt =
      typeof data.createdAt === 'string' && data.createdAt ? data.createdAt : new Date().toISOString()
    const updatedAt =
      typeof data.updatedAt === 'string' && data.updatedAt ? data.updatedAt : createdAt
    return {
      id,
      title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : '未命名专题',
      description: typeof data.description === 'string' ? data.description : '',
      paperIds: uniqueIds(data.paperIds),
      notes: (parsed.content ?? '').replace(/^\n+/, ''),
      relPath: vaultRelative(vaultPath, absPath),
      createdAt,
      updatedAt
    }
  } catch {
    return null
  }
}

export function writeCollectionFile(
  vaultPath: string,
  collection: PaperCollection,
  existingRelPath?: string
): PaperCollection {
  ensureVaultStructure(vaultPath)
  const now = new Date().toISOString()
  const next: PaperCollection = {
    ...collection,
    title: collection.title.trim() || '未命名专题',
    description: collection.description.trim(),
    paperIds: uniqueIds(collection.paperIds),
    notes: collection.notes ?? '',
    updatedAt: now,
    createdAt: collection.createdAt || now
  }

  const fallbackRel = join(VAULT_DIRS.collections, `${next.id}.md`)
  const fallbackAbs = resolveInside(vaultPath, fallbackRel)
  if (!fallbackAbs) throw new Error('专题路径非法，已拒绝写入。')

  let absPath = fallbackAbs
  if (existingRelPath) {
    const existingAbs = resolveInside(vaultPath, existingRelPath)
    if (!existingAbs || !existsSync(existingAbs)) {
      throw new Error(
        '这份专题的文件不在磁盘上了（可能被外部删除或改名）。先执行一次「重建索引」，再保存。'
      )
    }
    absPath = existingAbs
  }

  const frontmatter: Record<string, unknown> = {
    id: next.id,
    title: next.title,
    description: next.description,
    paperIds: next.paperIds,
    createdAt: next.createdAt,
    updatedAt: next.updatedAt
  }
  writeFileSync(absPath, matter.stringify(next.notes.replace(/\n+$/, '') + '\n', frontmatter), 'utf-8')
  next.relPath = vaultRelative(vaultPath, absPath)
  return next
}

export function deleteCollectionFile(vaultPath: string, relPath: string): boolean {
  const abs = resolveInside(vaultPath, relPath)
  if (!abs || !existsSync(abs)) return false
  /*
   * 只允许删 collections/ 里的文件：relPath 来自索引，而索引最初来自磁盘上的
   * frontmatter，同样不可全信。
   */
  const allowed = resolveInside(vaultPath, VAULT_DIRS.collections)
  if (!allowed || abs === allowed || !abs.startsWith(allowed + sep)) return false
  rmSync(abs, { force: true })
  return true
}

/* ------------------------------------------------------------------ */
/*  开放问题池                                                          */
/* ------------------------------------------------------------------ */

function problemFilePath(vaultPath: string, scope: string): string {
  const safe = scope.replace(/[\\/]/g, '_')
  const abs = resolveInside(vaultPath, join(VAULT_DIRS.problems, `${safe}.md`))
  if (!abs) throw new Error('问题池路径非法，已拒绝。')
  return abs
}

export function readProblemFile(vaultPath: string, scope: string): ProblemMap | null {
  const abs = problemFilePath(vaultPath, scope)
  if (!existsSync(abs)) return null
  try {
    const data = matter(readFileSync(abs, 'utf-8')).data as Record<string, unknown>
    const paperIds = uniqueIds(data.paperIds)
    const known = new Set(paperIds)
    return {
      scope,
      scopeTitle: typeof data.scopeTitle === 'string' ? data.scopeTitle : scope,
      generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : '',
      paperIds,
      summary: typeof data.summary === 'string' ? data.summary : '',
      problems: normalizeProblems(data.problems, (id) => (known.has(id) ? id : null))
    }
  } catch {
    return null
  }
}

export function writeProblemFile(
  vaultPath: string,
  map: ProblemMap,
  titleOf: (id: string) => string
): void {
  ensureVaultStructure(vaultPath)
  const frontmatter: Record<string, unknown> = {
    scope: map.scope,
    scopeTitle: map.scopeTitle,
    generatedAt: map.generatedAt,
    paperIds: map.paperIds,
    summary: map.summary,
    problems: map.problems.map((p) => ({ ...p }))
  }
  writeFileSync(
    problemFilePath(vaultPath, map.scope),
    matter.stringify(problemMapMarkdown(map, titleOf), frontmatter),
    'utf-8'
  )
}

/* ------------------------------------------------------------------ */
/*  选题本                                                              */
/* ------------------------------------------------------------------ */

export function newIdeaId(title: string): string {
  return `${slugify(title)}-${shortId()}`
}

function ideaFilePath(vaultPath: string, id: string): string {
  const abs = resolveInside(
    vaultPath,
    join(VAULT_DIRS.ideas, `${id.replace(/[\\/]/g, '_')}.md`)
  )
  if (!abs) throw new Error('选题路径非法，已拒绝。')
  return abs
}

export function readIdeaFile(vaultPath: string, id: string): ResearchIdea | null {
  const abs = ideaFilePath(vaultPath, id)
  if (!existsSync(abs)) return null
  try {
    return parseIdea(id, matter(readFileSync(abs, 'utf-8')).data as Record<string, unknown>)
  } catch {
    return null
  }
}

export function listIdeaFiles(vaultPath: string): ResearchIdea[] {
  const dir = join(vaultPath, VAULT_DIRS.ideas)
  if (!existsSync(dir)) return []
  const out: ResearchIdea[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    const idea = readIdeaFile(vaultPath, name.slice(0, -3))
    if (idea) out.push(idea)
  }
  return out
}

export function writeIdeaFile(
  vaultPath: string,
  idea: ResearchIdea,
  titleOf: (id: string) => string
): void {
  ensureVaultStructure(vaultPath)
  const frontmatter: Record<string, unknown> = { ...idea }
  delete frontmatter.id
  if (!frontmatter.problemId) delete frontmatter.problemId
  writeFileSync(
    ideaFilePath(vaultPath, idea.id),
    matter.stringify(ideaMarkdown(idea, titleOf), frontmatter),
    'utf-8'
  )
}

export function deleteIdeaFile(vaultPath: string, id: string): boolean {
  const abs = ideaFilePath(vaultPath, id)
  if (!existsSync(abs)) return false
  rmSync(abs, { force: true })
  return true
}

/* ------------------------------------------------------------------ */
/*  参考文献缓存（派生数据，放在 .papervault/ 下）                      */
/* ------------------------------------------------------------------ */

function refsFilePath(vaultPath: string, paperId: string): string {
  const abs = resolveInside(
    vaultPath,
    join(VAULT_DIRS.refs, `${paperId.replace(/[\\/]/g, '_')}.json`)
  )
  if (!abs) throw new Error('参考文献缓存路径非法，已拒绝。')
  return abs
}

export function readRefsFile(vaultPath: string, paperId: string): unknown {
  const abs = refsFilePath(vaultPath, paperId)
  if (!existsSync(abs)) return null
  try {
    return JSON.parse(readFileSync(abs, 'utf-8'))
  } catch {
    return null
  }
}

export function writeRefsFile(vaultPath: string, paperId: string, data: unknown): void {
  ensureVaultStructure(vaultPath)
  writeFileSync(refsFilePath(vaultPath, paperId), JSON.stringify(data, null, 2), 'utf-8')
}

/** 生成用于新建论文的空白章节 */
export function blankPaperMeta(partial: Partial<PaperMeta> = {}): PaperMeta {
  const now = new Date().toISOString()
  return {
    id: partial.id ?? newPaperId(partial.title ?? 'untitled'),
    title: partial.title ?? '未命名论文',
    authors: partial.authors ?? [],
    year: partial.year ?? null,
    venue: partial.venue ?? '',
    url: partial.url ?? '',
    arxivId: partial.arxivId ?? '',
    doi: partial.doi ?? '',
    status: partial.status ?? 'inbox',
    rating: partial.rating ?? 0,
    importance: partial.importance ?? 3,
    categories: partial.categories ?? [],
    tags: partial.tags ?? [],
    // 注意：exp 必须一并带上，否则调用方传进来的实验画像会被静默丢掉
    exp: partial.exp,
    pdf: partial.pdf ?? '',
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now
  }
}

export { SECTION_ORDER }
