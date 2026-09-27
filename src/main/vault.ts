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
import { normalizeQuiz, type Quiz } from '@shared/quiz'
import { normalizeLinks, type PaperLink } from '@shared/links'
import { normalizeSlideDeck, type SlideDeck } from '@shared/slides'
import { normalizeLearningReview, type LearningReview } from '@shared/learning'
import { normalizeHighlights } from '@shared/highlights'
import type { Highlight } from '@shared/highlights'
import { paperPreamble, parsePaperBody, renderPaperBody, SECTION_ORDER } from '@shared/template'
import type { PaperMeta, PaperStatus } from '@shared/types'
import { assertGranted } from './file-grants'

export const VAULT_DIRS = {
  meta: '.papervault',
  pdfs: '.papervault/pdfs',
  texts: '.papervault/texts',
  papers: 'papers',
  /** 从原文里裁下来的图。跟 papers/ 平级，见 shared/figures.ts 的说明 */
  figures: 'figures',
  syntheses: 'syntheses'
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

export function ensureVaultStructure(vaultPath: string): void {
  for (const dir of Object.values(VAULT_DIRS)) {
    mkdirSync(join(vaultPath, dir), { recursive: true })
  }
  const readme = join(vaultPath, 'README.md')
  if (!existsSync(readme)) {
    writeFileSync(readme, VAULT_README, 'utf-8')
  }
}

export const VAULT_README = `# PaperVault 知识库

这是由 PaperVault 管理的本地论文知识库。

- \`papers/\` 每篇论文一个 Markdown 文件，frontmatter 存书目信息，正文是固定章节的精读笔记。
- \`figures/\` 从原文里裁下来的图（图表、框架图），笔记用相对路径引用，可直接用看图软件浏览。
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
    quiz: raw.quiz ? normalizeQuiz(raw.quiz) : undefined,
    slides: raw.slides ? normalizeSlideDeck(raw.slides) : undefined,
    links: normalizeLinks(raw.links),
    learningReview: normalizeLearningReview(raw.learningReview),
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
): { id: string; preamble: string; highlights: Highlight[]; flow?: MethodFlow; mindmap?: MindMap; quiz?: Quiz; slides?: SlideDeck; links: PaperLink[]; learningReview?: LearningReview } | null {
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
      quiz: data?.quiz ? normalizeQuiz(data.quiz) : undefined,
      slides: data?.slides ? normalizeSlideDeck(data.slides) : undefined,
      links: normalizeLinks(data?.links),
      learningReview: normalizeLearningReview(data?.learningReview)
    }
  } catch {
    return null
  }
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

  const absPath = target?.abs ?? join(vaultPath, fallbackRel)

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
  const quiz = finalMeta.quiz ?? target?.info?.quiz
  if (quiz) {
    frontmatter.quiz = quiz
  }
  /*
   * 演示稿同理：索引里没有这一列，普通保存（改评分 / 改分类）构造出的 meta
   * 不带它 —— 少了「meta 没给就沿用磁盘上的」，顺手保存一次就把整份演示删了。
   */
  const slides = finalMeta.slides ?? target?.info?.slides
  if (slides) {
    frontmatter.slides = slides
  }
  /*
   * 关系同理（索引里那一列只是给构图用的镜像，Markdown 仍是唯一事实来源）。
   *
   * 两处和别的字段不一样：
   *   - 显式传空数组时要**把键删掉**，否则「取消最后一条关系」永远存不下去
   *     （沿用磁盘旧值 → 下次读回来又出现了）；
   *   - 要把规整后的结果写回 finalMeta —— persistPaper 紧接着会拿它整行 upsert，
   *     索引列才不会和磁盘漂移。
   */
  const links = normalizeLinks(finalMeta.links ?? target?.info?.links ?? [], finalMeta.id)
  if (links.length) frontmatter.links = links
  else delete frontmatter.links
  finalMeta.links = links
  const learningReview = normalizeLearningReview(finalMeta.learningReview ?? target?.info?.learningReview)
  if (learningReview) frontmatter.learningReview = learningReview
  finalMeta.learningReview = learningReview

  writeFileSync(absPath, matter.stringify(body, frontmatter), 'utf-8')

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
  const abs = join(vaultPath, VAULT_DIRS.texts, `${id}.txt`)
  if (!existsSync(abs)) return ''
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

export function synthesisRelPath(vaultPath: string, id: string): string {
  return vaultRelative(vaultPath, join(vaultPath, VAULT_DIRS.syntheses, `${id}.md`))
}

export { SECTION_ORDER }
