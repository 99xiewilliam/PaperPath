/**
 * 修复「章节被模型自带的 ## 标题切碎」的笔记。
 *
 * 病因与根治见 src/shared/template.ts 的 demoteEmbeddedHeadings：模型在章节值里
 * 写了 `## 小标题`，落盘后 parsePaperBody 把它们当成独立章节，正主章节变成空壳
 * ——界面上就是「方法细节 / 具体例子」永远空白。根治后**新**数据不会再坏，
 * 这个脚本救的是已经坏掉的旧笔记：把空壳章节后面连着的孤儿章节合并回去。
 *
 * 判定相当保守，三道门槛同时满足才动手：
 *   1. 正主章节（模板内的固定章节）内容为空；
 *   2. 紧随其后、直到下一个模板章节之间全是孤儿章节（标题不在模板里）；
 *   3. 块内有「强信号」：某个孤儿标题以正主章节名开头，或能对上该章节骨架里的
 *      加粗标签（方法细节的孤儿标题就是骨架标签改的）。
 *
 * 默认只打印修复计划（dry-run）；加 --apply 才真正写盘。用法：
 *   npm run repair:sections -- <vaultPath> [--apply]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import { SECTION_ORDER, demoteEmbeddedHeadings, sectionSpec } from '../src/shared/template'

const args = process.argv.slice(2).filter((a) => a !== '--apply')
const apply = process.argv.includes('--apply')
const vaultPath = args[0]
if (!vaultPath || !existsSync(vaultPath)) {
  console.error('用法：node repair-split-sections.cjs <vaultPath> [--apply]')
  process.exit(1)
}

/** 与 parsePaperBody 同一套规则：按 `^## ` 切分，跳过代码围栏 */
interface RawSection {
  title: string
  content: string
}

function splitBody(body: string): { preamble: string; sections: RawSection[] } {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const preamble: string[] = []
  const sections: RawSection[] = []
  let current: RawSection | null = null
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence
    const m = !inFence ? /^##\s+(.+?)\s*$/.exec(line) : null
    if (m) {
      current = { title: m[1], content: '' }
      sections.push(current)
      continue
    }
    if (current) current.content += `${line}\n`
    else if (sections.length === 0) preamble.push(line)
  }
  return {
    preamble: preamble.join('\n').trim(),
    sections: sections.map((s) => ({ ...s, content: s.content.trim() }))
  }
}

/** 骨架里的加粗标签，如「一句话概括」「输入 / 输出」 */
function scaffoldLabels(key: string): string[] {
  const scaffold = sectionSpec(key)?.scaffold ?? ''
  return [...scaffold.matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1])
}

const norm = (s: string): string => s.replace(/[\s（）()：:、，,·/＋+]/g, '')

function hasStrongSignal(canonicalKey: string, block: RawSection[]): boolean {
  const labels = scaffoldLabels(canonicalKey).map(norm).filter((l) => l.length >= 4)
  const nk = norm(canonicalKey)
  return block.some(({ title }) => {
    const nt = norm(title)
    return nt.startsWith(nk) || labels.some((l) => nt.includes(l) || l.includes(nt))
  })
}

function repairNote(abs: string): string | null {
  const raw = readFileSync(abs, 'utf-8')
  const parsed = matter(raw)
  const { preamble, sections } = splitBody(parsed.content)
  if (!sections.length) return null

  const canonicalSeen = new Set<string>()
  const merged = new Map<string, string>()
  const drop = new Set<RawSection>()
  const plan: string[] = []

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i]
    const isCanonical = SECTION_ORDER.includes(sec.title) && !canonicalSeen.has(sec.title)
    if (isCanonical) {
      canonicalSeen.add(sec.title)
      continue
    }
    // 模板章节的第二次出现（历史脏数据）不算正主，按孤儿处理
    const owner = sections
      .slice(0, i)
      .reverse()
      .find((s) => SECTION_ORDER.includes(s.title) && s.content.trim() === '')
    if (!owner || merged.has(owner.title) || drop.has(owner)) continue

    // 收集从上一个模板章节之后连着的孤儿块
    const block: RawSection[] = []
    for (let j = i; j < sections.length; j++) {
      if (SECTION_ORDER.includes(sections[j].title)) break
      block.push(sections[j])
    }
    if (!block.length || !block.includes(sec)) continue
    if (!hasStrongSignal(owner.title, block)) continue

    const parts = block.map((b) =>
      norm(b.title).startsWith(norm(owner.title))
        ? b.content
        : `### ${b.title}\n\n${b.content}`
    )
    merged.set(owner.title, parts.join('\n\n').trim())
    for (const b of block) drop.add(b)
    plan.push(
      `「${owner.title}」 ← ${block.map((b) => `「${b.title}」(${b.content.length} 字)`).join('、')}`
    )
  }

  if (!plan.length) return null

  if (apply) {
    const kept = sections.filter((s) => !drop.has(s)).map((s) => ({
      title: s.title,
      content: merged.get(s.title) ?? s.content
    }))
    const rebuilt = kept.map((s) => `## ${s.title}\n\n${demoteEmbeddedHeadings(s.content)}`)
    const body = preamble ? `${preamble}\n\n${rebuilt.join('\n\n')}` : rebuilt.join('\n\n')
    writeFileSync(abs, matter.stringify(`${body.trim()}\n`, parsed.data), 'utf-8')
  }

  return plan.join('\n    ')
}

/* ------------------------------------------------------------------ */

const papersDir = join(vaultPath, 'papers')
if (!existsSync(papersDir)) {
  console.error(`目录不存在：${papersDir}`)
  process.exit(1)
}

let touched = 0
for (const file of readdirSync(papersDir).filter((f) => f.endsWith('.md'))) {
  const plan = repairNote(join(papersDir, file))
  if (!plan) continue
  touched++
  console.log(`\n📄 ${file}${apply ? '' : '（dry-run，未写入）'}`)
  console.log(`    ${plan}`)
}

console.log(`\n${apply ? '已修复' : '发现'} ${touched} 篇${apply ? '' : '（加 --apply 执行写入）'}`)
if (!apply && touched) process.exit(2)
