/**
 * 专题读写：Markdown 是唯一真相源，索引只是派生。
 *
 * 专题和论文分类 / 标签不是一回事 —— 那些是打在论文上的属性；
 * 专题是用户手动归到一起的一组论文，对应「我这段时间集中看的那几篇」，
 * 方便之后指定 agent 专门分析这一块。
 */
import { existsSync } from 'fs'
import type { CollectionCreateInput, CollectionUpdateInput, PaperCollection } from '@shared/types'
import * as db from './db'
import { requireVault } from './runtime'
import * as vault from './vault'

function uniqueIds(ids: string[] | undefined): string[] {
  if (!ids?.length) return []
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

function livePaperIds(ids: string[] | undefined): string[] {
  if (!ids?.length) return []
  const alive = new Set(db.listPaperIds())
  return uniqueIds(ids).filter((id) => alive.has(id))
}

function persistCollection(collection: PaperCollection): PaperCollection {
  const vaultPath = requireVault()
  const row = db.getCollection(collection.id)
  const written = vault.writeCollectionFile(
    vaultPath,
    collection,
    row ? row.relPath : undefined
  )
  db.upsertCollection(written)
  return written
}

export function listCollections(): PaperCollection[] {
  return db.listCollections()
}

export function getCollection(id: string): PaperCollection | null {
  return db.getCollection(id)
}

export function createCollection(input: CollectionCreateInput): PaperCollection {
  const title = (input.title ?? '').trim() || '未命名专题'
  const now = new Date().toISOString()
  return persistCollection({
    id: vault.newCollectionId(title),
    title,
    description: (input.description ?? '').trim(),
    paperIds: livePaperIds(input.paperIds),
    notes: input.notes ?? '',
    relPath: '',
    createdAt: now,
    updatedAt: now
  })
}

export function updateCollection(input: CollectionUpdateInput): PaperCollection {
  const current = db.getCollection(input.id)
  if (!current) throw new Error('专题不存在或已被删除。')
  return persistCollection({
    ...current,
    title: input.title !== undefined ? input.title.trim() || current.title : current.title,
    description: input.description !== undefined ? input.description.trim() : current.description,
    paperIds: input.paperIds !== undefined ? livePaperIds(input.paperIds) : current.paperIds,
    notes: input.notes !== undefined ? input.notes : current.notes
  })
}

export function deleteCollection(id: string): boolean {
  const vaultPath = requireVault()
  const row = db.getCollection(id)
  if (row) vault.deleteCollectionFile(vaultPath, row.relPath)
  db.removeCollectionRow(id)
  return true
}

export function addPapersToCollection(id: string, paperIds: string[]): PaperCollection {
  const current = db.getCollection(id)
  if (!current) throw new Error('专题不存在或已被删除。')
  return persistCollection({
    ...current,
    paperIds: livePaperIds([...current.paperIds, ...paperIds])
  })
}

export function removePapersFromCollection(id: string, paperIds: string[]): PaperCollection {
  const current = db.getCollection(id)
  if (!current) throw new Error('专题不存在或已被删除。')
  const drop = new Set(uniqueIds(paperIds))
  return persistCollection({
    ...current,
    paperIds: current.paperIds.filter((pid) => !drop.has(pid))
  })
}

/**
 * 论文被删时，把它从所有专题的成员列表里拿掉。
 *
 * 不在这里做，专题 Markdown 里会留下幽灵 id：界面上看不见，但下次保存专题
 * 时又会把死 id 写回去。删论文是唯一会改「这篇还在不在」的动作，所以在这里剪。
 */
export function prunePaperFromCollections(paperId: string): void {
  if (!paperId) return
  for (const collection of db.listCollections()) {
    if (!collection.paperIds.includes(paperId)) continue
    persistCollection({
      ...collection,
      paperIds: collection.paperIds.filter((id) => id !== paperId)
    })
  }
}

/**
 * 打开知识库 / 重建索引时，从 Markdown 把专题灌进索引。
 *
 * 成员列表以磁盘为准，但会顺手丢掉已经不存在的论文 id（不写回 ——
 * 下次用户保存专题时自然就干净了；重扫不该把专题文件的 mtime 弄脏）。
 */
export function rescanCollections(): { scanned: number; indexed: number; removed: number } {
  const vaultPath = requireVault()
  const files = vault.listCollectionFiles(vaultPath)
  const seen = new Set<string>()
  const alive = new Set(db.listPaperIds())
  let indexed = 0

  for (const abs of files) {
    const parsed = vault.readCollectionFile(abs, vaultPath)
    if (!parsed) continue
    const paperIds = uniqueIds(parsed.paperIds).filter((id) => alive.has(id))
    db.upsertCollection({ ...parsed, paperIds })
    seen.add(parsed.id)
    indexed++
  }

  let removed = 0
  for (const id of db.listCollectionIds()) {
    if (seen.has(id)) continue
    const rel = db.getCollection(id)?.relPath
    const abs = rel ? vault.resolveInside(vaultPath, rel) : null
    if (abs && existsSync(abs)) continue
    db.removeCollectionRow(id)
    removed++
  }

  return { scanned: files.length, indexed, removed }
}
