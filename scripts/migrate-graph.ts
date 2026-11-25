/**
 * 一次性数据修复：把索引里的图谱 / 英语短语补写进笔记的 frontmatter。
 *
 * 背景：这两个字段从前**只写索引、不写 Markdown**，而索引是能从笔记重建的 ——
 * 重建一次（或换台机器、删掉 `.papervault`）图谱就被抹掉，图谱页随即显示
 * 「还没有可以建图的数据」，句式库一起清空。
 *
 * `writePaperFile` / `readPaperFile` 已经修好，往后新抽的会自动落盘；
 * 这个脚本负责把**已经在索引里、但笔记里还没有**的那部分补回去。
 *
 * 安全性：
 *   - **默认只是预演**，加 `--apply` 才真的写；
 *   - 以磁盘上的 frontmatter 为基础，只补 graph / phrases 两个键，
 *     不碰用户手改过的其他任何字段；
 *   - 章节整段沿用磁盘上的原文（renderPaperBody 也会保留手工新增的章节）；
 *   - 已经写过的会跳过，重复跑没有副作用；
 *   - **逐篇隔离**：某篇失败只跳过那一篇，并报出是哪一篇、错在哪，
 *     不会让整轮修复中断（数据库里本来就可能存着旧结构的数据）。
 *
 * 用法：
 *   npm run migrate:graph -- /path/to/vault            # 预演
 *   npm run migrate:graph -- /path/to/vault --apply    # 真的写
 */
import { existsSync } from 'fs'
import { normalizePaperGraph, normalizePhrases } from '@shared/lenses'
import { getPaperRow, listPaperRows, openDatabase, paperMetaFromRow } from '../src/main/db'
import { readPaperFile, resolveInside, writePaperFile } from '../src/main/vault'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const vaultPath = argv.find((a) => !a.startsWith('--'))

if (!vaultPath || !existsSync(vaultPath)) {
  console.error('用法: npm run migrate:graph -- <知识库路径> [--apply]')
  process.exit(2)
}

type Outcome = 'patched' | 'already' | 'nothing' | 'missing'

async function main(): Promise<void> {
  const vault = vaultPath as string
  await openDatabase(vault)
  const rows = listPaperRows()

  console.log(`知识库：${vault}`)
  console.log(`论文 ${rows.length} 篇 · ${apply ? '写入模式' : '预演模式（不改任何文件）'}`)
  console.log('')

  const tally: Record<Outcome, number> = { patched: 0, already: 0, nothing: 0, missing: 0 }
  const failures: string[] = []

  /** 处理一篇。以磁盘上的 meta 为基础，只补 graph / phrases 两个键。 */
  const migrateOne = (id: string): Outcome => {
    const row = getPaperRow(id)
    if (!row) return 'nothing'
    const indexed = paperMetaFromRow(row)

    /*
     * 补之前先过一遍归一化：索引里那份是旧版本写进去的，**实测有缺 relations 键的**。
     * 直接搬过去的话，writePaperFile 用 js-yaml 落盘时遇到值为 undefined 的键会
     * 直接抛「unacceptable kind of an object to dump」，那一篇笔记整个写不出去。
     */
    const graph = normalizePaperGraph(indexed.graph)
    const phrases = normalizePhrases(indexed.phrases)
    if (!graph && !phrases.length) return 'nothing'

    const relPath =
      String((row as unknown as { rel_path?: string }).rel_path ?? '') || `papers/${id}.md`
    const abs = resolveInside(vault, relPath)
    const back = abs && existsSync(abs) ? readPaperFile(abs, vault) : null
    if (!back) {
      console.log(`⚠️  读不到文件，跳过：${relPath}`)
      return 'missing'
    }

    // graph 功能已下线，字段类型是 unknown；这里只数实体个数，判断「磁盘上有没有」
    const diskGraph =
      ((back.meta.graph as { entities?: unknown[] } | undefined)?.entities?.length ?? 0) > 0
    const diskPhrases = (back.meta.phrases?.length ?? 0) > 0
    if (diskGraph && diskPhrases) return 'already'

    const next = { ...back.meta }
    const addGraph = !diskGraph && !!graph
    const addPhrases = !diskPhrases && phrases.length > 0
    // 磁盘上该有的都有了（例如这篇只抽到短语，而短语已经写在文件里）
    if (!addGraph && !addPhrases) return 'already'
    if (addGraph && graph) next.graph = graph
    if (addPhrases) next.phrases = phrases

    const bits: string[] = []
    if (addGraph && graph) bits.push(`实体 ${graph.entities.length} / 关系 ${graph.relations.length}`)
    if (addPhrases) bits.push(`短语 ${phrases.length}`)
    console.log(
      `${apply ? '✅ 写入' : '·  待补'}  ${id.slice(0, 40).padEnd(42)} ${bits.join(' · ')}`
    )

    if (apply) writePaperFile(vault, next, back.sections, [], relPath)
    return 'patched'
  }

  for (const summary of rows) {
    try {
      tally[migrateOne(summary.id)]++
    } catch (err) {
      tally.nothing++
      const detail = err instanceof Error ? err.message : String(err)
      failures.push(`${summary.id}：${detail}`)
      console.log(`❌ 处理失败，跳过：${summary.id}\n   ${detail}`)
    }
  }

  console.log('')
  console.log(
    `合计：${tally.patched} 篇${apply ? '已补写' : '待补写'} · ${tally.already} 篇笔记里已有 · ` +
      `${tally.nothing} 篇索引里也没有 · ${tally.missing} 篇读不到文件 · ${failures.length} 篇出错`
  )
  if (!apply && tally.patched) {
    console.log('（预演结束，未改动任何文件。确认无误后加 --apply 再跑一次）')
  }
}

void main().catch((err: unknown) => {
  console.error('失败：', err instanceof Error ? err.message : err)
  process.exit(1)
})
