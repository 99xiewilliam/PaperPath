#!/usr/bin/env node
/**
 * 论文 PDF 解析体检工具。
 *
 * 用法：
 *   npm run inspect:pdf -- "/path/to/paper.pdf"
 *   npm run inspect:pdf -- "/path/to/paper.pdf" --verbose   # additionally dump every heading mark
 *
 * 它走的是和 App 完全相同的代码路径：
 *   PDF → 逐页文本重建 → 按字号标记标题 → 章节切分 → LLM 输入预算
 *
 * 什么时候用：某篇论文导进来之后，如果「写作手法 · Experiments」抽得不对、
 * 或者 AI 精读漏了实验内容，多半是章节切分没切好，跑一下这个脚本就能看出
 * 是哪个环节的问题（扫描版？标题没标出来？正文被误标？）。
 *
 * 前置：.pv-inspect/ 下的编译产物由 npm script 生成。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const pdfText = require(path.join(ROOT, '.pv-inspect/pdfText.cjs'))
const papertext = require(path.join(ROOT, '.pv-inspect/papertext.cjs'))

const file = process.argv[2]
const verbose = process.argv.includes('--verbose')

if (!file) {
  console.error('用法: npm run inspect:pdf -- "/path/to/paper.pdf" [--verbose]')
  process.exit(1)
}
if (!fs.existsSync(file)) {
  console.error('文件不存在: ' + file)
  process.exit(1)
}

/** 打印时对齐用的中英文混排宽度（CJK 算 2 格） */
function width(text) {
  let w = 0
  for (const ch of text) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  return w
}
function pad(text, target) {
  const text2 = String(text)
  return text2 + ' '.repeat(Math.max(0, target - width(text2)))
}

;(async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(fs.readFileSync(file))

  const t0 = Date.now()
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
    disableAutoFetch: true,
    disableStream: true
  }).promise

  const pageTexts = []
  const pageLines = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    try {
      const content = await page.getTextContent()
      const lines = pdfText.buildLines(content.items)
      pageLines.push(lines)
      pageTexts.push(lines.map((l) => l.text).join('\n'))
    } finally {
      page.cleanup()
    }
  }

  let info = {}
  try {
    const meta = await doc.getMetadata()
    info = meta.info || {}
  } catch {
    /* 元数据缺失不影响 */
  }

  const assembled = pdfText.assemblePdfText(pageTexts, pageLines, info)
  const pageCount = doc.numPages
  await doc.destroy()

  const normalized = papertext.normalizePaperText(assembled.text)
  const sections = papertext.splitPaperSections(normalized)
  const source = papertext.prepareLlmSource(assembled.text, 60000)
  const perPage = Math.round(assembled.text.length / Math.max(1, pageCount))

  console.log('')
  console.log('文件        : ' + path.basename(file))
  console.log('解析耗时    : ' + (Date.now() - t0) + ' ms')
  console.log('')
  console.log('── 1. 文本抽取 ─────────────────────────────')
  console.log('页数        : ' + pageCount)
  console.log('总字符      : ' + assembled.text.length + '（每页平均 ' + perPage + '）')
  console.log(
    '判断        : ' +
      (perPage > 800 ? '✅ 文本型 PDF，可正常解析' : '⚠️  每页字符过少，可能是扫描版，需要 OCR')
  )
  console.log('推断正文字号: ' + assembled.bodySize)
  console.log('识别标题数  : ' + assembled.headingCount)
  console.log('')
  console.log('── 2. 标题与作者 ───────────────────────────')
  console.log('元数据标题  : ' + (info.Title || '(空)'))
  console.log('猜测标题    : ' + (assembled.title || '⚠️  未猜出'))
  console.log(
    '猜测作者    : ' + (assembled.authors.length ? assembled.authors.join(', ') : '⚠️  未猜出')
  )

  const names = Object.keys(sections)
  console.log('')
  console.log('── 3. 章节切分 ─────────────────────────────')
  if (!names.length) {
    console.log('⚠️  没切出任何章节，将退化为整篇截断喂给模型')
  } else {
    const max = Math.max(...names.map((n) => sections[n].length))
    for (const n of names) {
      const bar = '█'.repeat(Math.max(1, Math.round((sections[n].length / max) * 24)))
      console.log('  ' + pad(n.slice(0, 34), 36) + pad(sections[n].length, 8) + bar)
    }
    const hasExperiments = names.some((n) => /experiment|evaluation|experimental/i.test(n))
    console.log('')
    console.log(
      hasExperiments
        ? '✅ 已定位到 Experiments 相关章节'
        : '⚠️  没有识别出 Experiments 章节，实验相关内容可能被塞进别的章节'
    )
  }

  console.log('')
  console.log('── 4. LLM 输入预算 ─────────────────────────')
  if (source.sourceSections) {
    const total = Object.values(source.sourceSections).reduce((a, v) => a + v.length, 0)
    console.log('模式        : 按章节喂入')
    console.log('输入字符    : ' + total)
    console.log('估算 token  : ' + papertext.estimateTokens(Object.values(source.sourceSections).join('')))
  } else {
    console.log('模式        : 整篇截断')
    console.log('输入字符    : ' + source.fullText.length)
    console.log('估算 token  : ' + papertext.estimateTokens(source.fullText))
  }

  if (verbose) {
    console.log('')
    console.log('── 5. 全部标题标记（--verbose）─────────────')
    const lines = normalized.split('\n')
    const marks = []
    for (let i = 0; i < lines.length; i++) {
      const m = /^#{1,3}\s+(.+?)\s*$/.exec(lines[i])
      if (m) marks.push({ i, raw: m[1] })
    }
    for (let k = 0; k < marks.length; k++) {
      const stop = marks[k + 1] ? marks[k + 1].i : lines.length
      const size = lines.slice(marks[k].i + 1, stop).join('').replace(/\s/g, '').length
      console.log('  ' + pad('#' + marks[k].i, 8) + pad(size, 8) + marks[k].raw.slice(0, 70))
    }
    console.log('  共 ' + marks.length + ' 个标记')
  }

  console.log('')
  console.log('── 6. 正文开头 400 字 ──────────────────────')
  console.log(normalized.slice(0, 400))
  console.log('')
})().catch((err) => {
  console.error('解析失败:', err)
  process.exit(1)
})
