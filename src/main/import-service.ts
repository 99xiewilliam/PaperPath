/**
 * PDF 导入：归档副本 + 保存抽取文本 + 落 Markdown + 可选自动精读。
 *
 * 单独成一层是为了打断潜在的循环：ai-service 需要 paper-service，
 * 而导入流程又要调用 ai-service 的自动精读。把它放在两者之上，
 * 依赖就始终是单向的（import → paper / ai → runtime）。
 */
import { basename } from 'path'
import { emptySections } from '@shared/template'
import type { ImportPdfPayload } from '@shared/api'
import type { ImportPdfResult } from '@shared/types'
import { runSummarize } from './ai-service'
import { persistPaper } from './paper-service'
import { prepareLlmSource } from './papertext'
import { requireVault } from './runtime'
import { getSettings } from './settings'
import * as vault from './vault'

/*
 * 载荷类型统一从 `@shared/api` 取 —— 它同时是 preload 的类型来源。
 * 之前这里另抄了一份 9 个字段的 interface，两边一旦改动不同步，
 * 渲染层就会发出一个「类型正确但主进程读不到」的载荷。
 */
export async function importPdf(payload: ImportPdfPayload): Promise<ImportPdfResult> {
  const vaultPath = requireVault()
  if (!payload?.text || payload.text.trim().length < 200) {
    return { ok: false, error: '未能从 PDF 中抽取到足够的文本（可能是扫描版，需要 OCR）。' }
  }

  const fallbackTitle = (payload.fileName ?? basename(payload.sourcePath)).replace(/\.pdf$/i, '')
  const title = (payload.extractedTitle || '').trim() || fallbackTitle
  const id = vault.newPaperId(title)

  const meta = vault.blankPaperMeta({
    id,
    title,
    authors: payload.extractedAuthors ?? [],
    categories: payload.categories ?? [],
    status: 'reading'
  })
  meta.pdf = vault.copyPdfIntoVault(vaultPath, payload.sourcePath, id)
  vault.saveExtractedText(vaultPath, id, payload.text)

  const source = prepareLlmSource(payload.text)
  const autoSection: Record<string, string> = {
    ...emptySections(getSettings().customSections),
    ...(source.sourceSections?.['Abstract']
      ? { 一句话总结: source.sourceSections['Abstract'].slice(0, 600) }
      : {})
  }

  persistPaper(meta, autoSection)

  const shouldSummarize = payload.autoSummarize ?? getSettings().autoSummarizeOnImport
  if (!shouldSummarize || !getSettings().llm.apiKey) {
    return {
      ok: true,
      paperId: id,
      title,
      charCount: payload.text.length,
      warning: getSettings().llm.apiKey ? undefined : '未配置 API Key，已跳过自动精读。'
    }
  }

  try {
    const result = await runSummarize(id, undefined)
    return {
      ok: true,
      paperId: id,
      title,
      charCount: payload.text.length,
      warning: result.ok ? undefined : result.message
    }
  } catch (err) {
    return {
      ok: true,
      paperId: id,
      title,
      charCount: payload.text.length,
      warning: `已入库，但自动精读失败：${(err as Error).message}`
    }
  }
}
