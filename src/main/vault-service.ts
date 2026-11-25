/**
 * 知识库服务：打开 / 状态 / 重新扫描。
 *
 * 扫描是启动路径上最重的一步，所以这里的「文件没变就跳过」快路径是
 * 性能关键点，注释里保留原因说明，避免后来者以为是多余的判断。
 */
import { existsSync, mkdirSync } from 'fs'
import type { ScanResult, VaultStatus } from '@shared/types'
import { rescanCollections } from './collection-service'
import * as db from './db'
import { textSnippet } from './papertext'
import { fileStamp, relativeOf, requireVault } from './runtime'
import { getSettings, setSettings } from './settings'
import * as vault from './vault'

export async function loadVault(vaultPath: string): Promise<VaultStatus> {
  mkdirSync(vaultPath, { recursive: true })
  vault.ensureVaultStructure(vaultPath)
  await db.openDatabase(vaultPath)
  setSettings({ vaultPath })
  await rescanVault()
  return vaultStatus()
}

export function vaultStatus(): VaultStatus {
  const path = getSettings().vaultPath
  if (!path || !existsSync(path)) {
    return { opened: false, path: '', paperCount: 0 }
  }
  return {
    opened: true,
    path,
    paperCount: db.paperCount(),
  }
}

/**
 * 分类名会进 search_blob（检索能命中分类），所以用户改了自定义分类之后，
 * 已索引的论文必须全部重算一遍。用 meta 表记下上次用的分类签名，签名没变
 * 才允许走「文件没变就跳过」的快路径。
 */
const CATEGORY_SIGNATURE_KEY = 'category_signature'

export async function rescanVault(): Promise<ScanResult> {
  const vaultPath = requireVault()
  const settings = getSettings()
  const files = vault.listPaperFiles(vaultPath)
  const errors: string[] = []
  const seen = new Set<string>()

  const categorySignature = JSON.stringify(settings.customCategories ?? [])
  const signatureChanged = db.metaGet(CATEGORY_SIGNATURE_KEY) !== categorySignature
  const stamps = signatureChanged ? new Map<string, db.PaperFileStamp>() : db.listFileStamps()

  let skipped = 0
  for (const abs of files) {
    const relPath = relativeOf(abs, vaultPath)

    /*
     * 快路径：路径 + mtime + size 三者都没变，说明这份 Markdown 自上次索引
     * 以来没被碰过，直接复用索引里的记录 —— 不重新解析、不重算 search_blob、
     * 不重写索引行。以前每次打开知识库都要把几百个文件全解析一遍，这是启动
     * 阶段最大的一块开销。
     */
    const stamp = stamps.get(relPath)
    if (stamp) {
      const current = fileStamp(abs)
      if (
        current.fileMtime !== 0 &&
        current.fileMtime === stamp.mtime &&
        current.fileSize === stamp.size
      ) {
        seen.add(stamp.id)
        skipped++
        continue
      }
    }

    const parsed = vault.readPaperFile(abs, vaultPath)
    if (!parsed) {
      errors.push(abs)
      continue
    }
    seen.add(parsed.meta.id)
    const raw = vault.readExtractedText(vaultPath, parsed.meta.id)
    db.upsertPaper({
      meta: parsed.meta,
      sections: parsed.sections,
      relPath: parsed.relPath,
      customCategories: settings.customCategories,
      textSnippet: raw ? textSnippet(raw) : '',
      ...fileStamp(abs)
    })
  }

  let removed = 0
  for (const id of db.listPaperIds()) {
    if (seen.has(id)) continue
    /*
     * 不能只看「这次扫描没见到它」就删 —— 上面解析失败的文件也会落到这里，
     * 而它对应的 .md 好端端躺在磁盘上。以「文件确实不在了」为准。
     *
     * 这不是理论问题：某个 .md 的 frontmatter 被改成非法 YAML，就足以让这篇论文
     * 从库里消失，并连带删掉只存在于索引的图谱 / 句式库。
     */
    const rel = db.getPaperSummary(id)?.relPath
    const abs = rel ? vault.resolveInside(vaultPath, rel) : null
    if (abs && existsSync(abs)) continue
    db.removePaperRow(id)
    removed++
  }

  if (signatureChanged) db.metaSet(CATEGORY_SIGNATURE_KEY, categorySignature)
  if (skipped) console.log(`[vault] 扫描跳过 ${skipped} 个未变动的文件`)

  rescanCollections()

  db.persistNow()
  return { scanned: files.length, indexed: seen.size, removed, errors }
}
