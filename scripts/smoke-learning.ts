import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LEARNING_KEYS, normalizeLearningReview, type LearningReview } from '@shared/learning'
import type { PaperDetail } from '@shared/types'
import { invoke } from './stubs/electron'
import { registerIpc } from '../src/main/ipc'
import * as db from '../src/main/db'

async function main(): Promise<void> {
  const now = new Date('2026-09-18T10:00:00Z')
  /*
   * 复习功能已经删掉，但 frontmatter 里可能还写着 learningReview ——
   * 下面这一组断言的是「老元数据仍能安全往返」，而不是那个功能本身。
   */
  const first: LearningReview = {
    reviewedAt: now.toISOString(),
    nextReviewAt: '2026-09-25T10:00:00.000Z',
    intervalDays: 7,
    count: 1,
    rating: 'good'
  }
  assert.deepEqual(normalizeLearningReview(first), first)
  for (const invalid of [null, {}, { ...first, count: -1 }, { ...first, intervalDays: 0 }, { ...first, nextReviewAt: 'invalid' }, { ...first, nextReviewAt: first.reviewedAt }, { ...first, rating: 'unknown' }]) {
    assert.equal(normalizeLearningReview(invalid), undefined)
  }
  console.log('✓ 老复习元数据：能原样读回，无效值一律当没有')

  const root = mkdtempSync(join(tmpdir(), 'pv-learning-'))
  const previousCwd = process.cwd()
  process.chdir(root) // Never read the developer's .env during offline tests.
  try {
    registerIpc()
    await invoke('vault:open', root)
    const paper = await invoke<PaperDetail>('paper:create', { title: '入门测试论文' })
    const sections = { ...paper.sections, [LEARNING_KEYS[0]]: '研究稀疏证据检索', [LEARNING_KEYS[6]]: '复现表 2，并记录随机种子' }
    db.setPaperRun(paper.id, { status: 'failed', message: '保留运行诊断', finishedAt: now.toISOString(), lenses: [] })
    const saved = await invoke<PaperDetail>('paper:update', { id: paper.id, meta: { learningReview: first }, sections })
    assert.deepEqual(saved.meta.learningReview, first)
    assert.equal(saved.sections[LEARNING_KEYS[6]], sections[LEARNING_KEYS[6]])
    assert.equal(db.getPaperRun(paper.id)?.message, '保留运行诊断', 'ordinary saves must not reset last_run')
    assert.ok(readFileSync(join(root, saved.relPath), 'utf8').includes('learningReview:'))
    assert.ok((await invoke<string[]>('paper:search', '稀疏证据')).includes(paper.id))
    assert.ok(db.buildSearchBlob(saved.meta, { ...sections, '自由笔记': '很长的 AI 分析。'.repeat(3000) }).includes('稀疏证据'), 'personal notes precede the search index truncation')
    await invoke('paper:bulkUpdate', { ids: [paper.id], addTags: ['学习'] })
    await invoke('vault:rescan')
    const reread = await invoke<PaperDetail>('paper:get', paper.id)
    assert.deepEqual(reread.meta.learningReview, first)
    assert.equal(reread.sections[LEARNING_KEYS[0]], sections[LEARNING_KEYS[0]])
    db.closeDatabase()
    await db.openDatabase(root)
    const reopened = await invoke<PaperDetail>('paper:get', paper.id)
    assert.deepEqual(reopened.meta.learningReview, first, 'review dates survive reopening')
    console.log('✓ IPC → Markdown → 索引 → 批量修改 → 重扫 → 重开，历史字段与运行诊断均保留')
  } finally {
    db.closeDatabase()
    process.chdir(previousCwd)
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
