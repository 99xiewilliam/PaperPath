/**
 * 论文读写服务：索引不存正文，Markdown 才是唯一真相源。
 *
 * 这一层的规矩很简单：任何「按 id 拿内容」都要从磁盘读，
 * 任何「按 id 写内容」都要经过 persistPaper 走一次索引更新 + 指纹记录。
 */
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { emptySections, renderPaperBody as renderBody } from '@shared/template'
import type { BulkResult } from '@shared/api'
import type { Highlight } from '@shared/highlights'
import type {
  PaperBulkUpdate,
  PaperCreateInput,
  PaperDetail,
  PaperMeta,
  PaperUpdateInput
} from '@shared/types'
import * as db from './db'
import { textSnippet } from './papertext'
import { fileStamp, requireVault } from './runtime'
import { getSettings } from './settings'
import { emitProgress } from './tasks'
import * as vault from './vault'

/** 章节内容的统一入口：索引不存正文，一律从 Markdown 读 */
export function sectionsOf(id: string): Record<string, string> {
  const row = db.getPaperRow(id)
  return vault.readPaperSections(requireVault(), id, row ? String(row.rel_path ?? '') : undefined)
}

/**
 * 高亮的统一入口 —— 和章节一样，以 Markdown 为准。
 *
 * 索引里虽然补了 highlights 列，但它要等一次重新扫描才会被填上；
 * 而「读」这条路径必须立刻正确，否则渲染层拿不到、保存时又会把它删掉。
 */
export function highlightsOf(id: string): Highlight[] {
  const row = db.getPaperRow(id)
  const file = vault.readPaperFileById(
    requireVault(),
    id,
    row ? String(row.rel_path ?? '') : undefined
  )
  return file?.meta.highlights ?? []
}

export function buildDetail(id: string): PaperDetail | null {
  const summary = db.getPaperSummary(id)
  const row = db.getPaperRow(id)
  if (!summary || !row) return null
  /*
   * 一次读盘同时拿到章节和正文。
   *
   * `body` 取磁盘上的原文，而不是从章节字典重建 —— 重建会漏掉正文顶部那段
   * 不属于任何章节的手写前言（`renderPaperBody` 只认 `## ` 分节），
   * 于是详情页「导出 Markdown」出来的文件就和知识库里那份对不上。
   * 导出的东西应该和原文一模一样。
   */
  const file = vault.readPaperFileById(requireVault(), id, String(row.rel_path ?? ''))
  const sections = file?.sections ?? {}
  return {
    ...summary,
    /*
     * highlights / flow / mindmap / quiz 都要**从磁盘文件**取：它们在索引里没有
     * 独立的列，只认索引的话，详情页拿不到、下次保存又会把它删掉
     * （见 writePaperFile 的注释）。
     */
    meta: {
      ...db.paperMetaFromRow(row),
      highlights: file?.meta.highlights ?? [],
      flow: file?.meta.flow,
      mindmap: file?.meta.mindmap,
      quiz: file?.meta.quiz,
      slides: file?.meta.slides,
      links: file?.meta.links,
      learningReview: file?.meta.learningReview
    },
    body: file?.body ?? renderBody(sections, getSettings().customSections),
    sections,
    // 上一次精读的结局。存在索引里而不是 Markdown —— 它是运行诊断信息，
    // 不该混进笔记正文，也没必要跟笔记一起同步
    lastRun: db.getPaperRun(id)
  }
}

export function persistPaper(meta: PaperMeta, sections: Record<string, string>): PaperDetail {
  const vaultPath = requireVault()
  const settings = getSettings()
  /*
   * 把索引里记的真实文件位置传下去：文件名可能被用户手动改过，写回时不认它
   * 就会新造一个 `${id}.md`，同一个 id 出现两份笔记（见 writePaperFile 注释）。
   * 新建的论文还没有索引行，取到 undefined，走默认的 `${id}.md`。
   */
  const row = db.getPaperRow(meta.id)
  const written = vault.writePaperFile(
    vaultPath,
    meta,
    sections,
    settings.customSections,
    row ? String(row.rel_path ?? '') : undefined
  )
  const raw = vault.readExtractedText(vaultPath, meta.id)
  db.upsertPaper({
    meta: written.meta,
    sections,
    relPath: written.relPath,
    customCategories: settings.customCategories,
    textSnippet: raw ? textSnippet(raw) : '',
    // 顺手把刚写出来的文件指纹记下，这样紧接着的一次扫描就能跳过它
    ...fileStamp(written.absPath)
  })
  // 不再显式 persistNow()：upsertPaper 内部已经 markDirty()，400ms 防抖会落盘。
  // 之前每次保存笔记都要把整个 sqlite 重新序列化写一遍，批量操作时尤其亏。
  const detail = buildDetail(meta.id)
  if (!detail) throw new Error('保存后读取失败')
  return detail
}

export function createPaper(input: PaperCreateInput): PaperDetail {
  const meta = vault.blankPaperMeta({
    title: input.title?.trim() || '未命名论文',
    authors: input.authors ?? [],
    year: input.year ?? null,
    venue: input.venue ?? '',
    url: input.url ?? '',
    arxivId: input.arxivId ?? '',
    doi: input.doi ?? '',
    status: input.status ?? 'inbox',
    categories: input.categories ?? [],
    tags: input.tags ?? [],
    pdf: input.pdf ?? ''
  })
  const sections = { ...emptySections(getSettings().customSections), ...(input.sections ?? {}) }
  return persistPaper(meta, sections)
}

export function updatePaper(input: PaperUpdateInput): PaperDetail {
  const vaultPath = requireVault()
  const row = db.getPaperRow(input.id)
  if (!row) throw new Error('论文不存在或已被删除。')
  /*
   * 高亮先从 Markdown 读回来再合并：input.meta 来自渲染层，不一定带这个字段，
   * 而写回时少了它就会把磁盘上的高亮键删掉。
   */
  const current: PaperMeta = {
    ...db.paperMetaFromRow(row),
    highlights: highlightsOf(input.id)
  }
  const meta: PaperMeta = { ...current, ...input.meta, id: current.id }
  const sections = { ...input.sections }
  // 校验 PDF 引用是否还在，并且没被手改成指向知识库外的路径
  if (meta.pdf) {
    const abs = vault.resolveInside(vaultPath, meta.pdf)
    if (!abs || !existsSync(abs)) meta.pdf = ''
  }
  return persistPaper(meta, sections)
}

export function deletePaper(id: string): void {
  const vaultPath = requireVault()
  const summary = db.getPaperSummary(id)
  if (summary) {
    // relPath 来自索引，但仍然过一遍越界校验 —— 它是从磁盘上的 frontmatter
    // 反推出来的，同样不可全信。
    vault.deletePaperFile(vaultPath, summary.relPath)
  }
  const row = db.getPaperRow(id)
  if (row) {
    const pdf = String(row.pdf ?? '')
    if (pdf) {
      const abs = vault.resolveInside(vaultPath, pdf)
      if (abs) rmSync(abs, { force: true })
    }
  }
  // 抽取文本同样过一遍越界校验：id 是从 frontmatter 读出来的，不可全信
  const textAbs = vault.resolveInside(vaultPath, join(vault.VAULT_DIRS.texts, `${id}.txt`))
  if (textAbs) rmSync(textAbs, { force: true })
  db.removePaperRow(id)
}

/* ------------------------------------------------------------------ */
/*  批量操作                                                            */
/* ------------------------------------------------------------------ */

/** 先加后减（减优先），去重并保持原有顺序 */
function mergeList(current: string[], add?: string[], remove?: string[]): string[] {
  const drop = new Set(remove ?? [])
  return [...new Set([...current, ...(add ?? [])])].filter((v) => !drop.has(v))
}

/**
 * 批量修改论文属性。
 *
 * 刻意只做**增量**（加 / 减），不提供整份覆盖的入口：用户想给 20 篇加个标签时，
 * 不该顺手把已手选的分类、已抽好的实验画像、写了一半的笔记一起清掉。
 *
 * 逐篇串行，每篇之间发一次进度 —— 选了几十篇之后界面必须能显示「第几篇」，
 * 否则看起来就像卡死了。单篇失败只记下来继续跑，不做回滚：
 * 50 篇里 1 篇的文件被外部删掉，不该连另外 49 篇的结果一起丢掉。
 */
export function bulkUpdatePapers(input: PaperBulkUpdate): BulkResult {
  const ids = (input.ids ?? []).filter(Boolean)
  if (!ids.length) {
    return { ok: true, total: 0, succeeded: 0, failed: 0, message: '没有选中任何论文' }
  }

  let succeeded = 0
  const failures: string[] = []

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    emitProgress('bulk', `正在修改 ${i + 1}/${ids.length}…`, id)
    try {
      const row = db.getPaperRow(id)
      if (!row) throw new Error('论文不存在或已被删除。')
      const meta = db.paperMetaFromRow(row)

      const patch: Partial<PaperMeta> = {}
      if (input.status) patch.status = input.status
      if (input.addCategories?.length || input.removeCategories?.length) {
        patch.categories = mergeList(meta.categories, input.addCategories, input.removeCategories)
      }
      if (input.addTags?.length || input.removeTags?.length) {
        patch.tags = mergeList(meta.tags, input.addTags, input.removeTags)
      }

      // 复用单篇的 updatePaper：它会顺手校验 PDF 引用是否还指向库内，
      // 并走 persistPaper 更新索引与文件指纹。批量不该绕开这些。
      updatePaper({ id, meta: patch, sections: sectionsOf(id) })
      succeeded++
    } catch (err) {
      failures.push((err as Error).message)
    }
  }

  const failed = ids.length - succeeded
  return {
    ok: succeeded > 0,
    total: ids.length,
    succeeded,
    failed,
    message: failures.length
      ? `完成 ${succeeded}/${ids.length} 篇。首个错误：${failures[0]}`
      : `已更新 ${succeeded} 篇论文`
  }
}

/** 批量删除：Markdown / PDF 副本 / 抽取文本一起清理（复用 deletePaper） */
export function bulkDeletePapers(ids: string[]): BulkResult {
  const list = (ids ?? []).filter(Boolean)
  if (!list.length) {
    return { ok: true, total: 0, succeeded: 0, failed: 0, message: '没有选中任何论文' }
  }

  let succeeded = 0
  const failures: string[] = []

  for (let i = 0; i < list.length; i++) {
    emitProgress('bulk', `正在删除 ${i + 1}/${list.length}…`, list[i])
    try {
      deletePaper(list[i])
      succeeded++
    } catch (err) {
      failures.push((err as Error).message)
    }
  }

  const failed = list.length - succeeded
  return {
    ok: succeeded > 0,
    total: list.length,
    succeeded,
    failed,
    message: failures.length
      ? `已删除 ${succeeded}/${list.length} 篇。首个错误：${failures[0]}`
      : `已删除 ${succeeded} 篇论文`
  }
}
