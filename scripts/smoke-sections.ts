/**
 * 章节切分的回归测试。
 *
 * 这里锁的是一个真实踩过的坑，链条有点长：
 *
 *   1. PDF 抽取阶段按字号标标题时，带编号的标题「5. Experimental Results」
 *      被 `looksLikeHeading` 里的「句子结构」规则误杀
 *      （编号点号 + 空格 + 大写字母，正好长得像正文句子）；
 *   2. 于是原文里只剩 3 个标记（Abstract / RoboVoLo / VoLoAgent），
 *      而 `splitPaperSections` 只要标记路径能切出 ≥3 段就直接 return，
 *      关键字兜底永远轮不到 —— 「漏标」变成「静默漏段」；
 *   3. Experiments 整段消失，下游按章节名取材料的维度只命中 Abstract；
 *   4. 模型看不到实验章节，把原文里明确写着的「uses Claude Opus 4.6」
 *      判成了「原文未说明」。
 *
 * 所以这里既测 looksLikeHeading 的正确性，也测切分结果的正确性。
 *
 * 用法：
 *   npm run smoke:sections                     # 跑内置回归
 *   npm run smoke:sections -- path/to/x.txt    # 顺便打印某个真实文本的切分结果
 */
import { existsSync, readFileSync } from 'fs'
import { looksLikeHeading } from '../src/renderer/src/lib/pdfText'
import { normalizePaperText, splitPaperSections } from '../src/main/papertext'

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`  ✅ ${label}${detail ? `  ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${label}${detail ? `  ${detail}` : ''}`)
  }
}

/** 造一段足够长的正文，避免被「章节内容过短就丢弃」的规则吃掉 */
const filler = (tag: string): string =>
  `${tag}. ` + `${tag} 的正文内容，用来保证这个章节长到不会被丢弃。`.repeat(6)

/* ------------------------------------------------------------------ */
/*  1. looksLikeHeading：带编号的标题必须能被认出来                       */
/* ------------------------------------------------------------------ */

console.log('── 1. 标题识别（looksLikeHeading）───────────')

const BODY_SIZE = 10
/** 字号和正文一样 —— 此时只能靠关键字认标题 */
const heading = (text: string): boolean =>
  looksLikeHeading({ text, size: BODY_SIZE }, BODY_SIZE, false)
/** 字号明显大于正文 —— 此时论文自定义的章节名也能认出来 */
const bigHeading = (text: string): boolean =>
  looksLikeHeading({ text, size: BODY_SIZE + 3 }, BODY_SIZE, false)

// ① 关键字路径：标题名本身无歧义，字号不突出也要认
//    （有些模板的 Abstract 字号反而更小，光靠字号会漏）
for (const title of [
  '1. Introduction',
  '2. Related Work',
  '5. Experimental Results',
  '6. Conclusion and Limitations',
  'Abstract'
]) {
  check(`关键字识别「${title}」`, heading(title))
}

// ② 罗马数字编号（IEEE 风格）：另一种编号形态，剥编号规则要认得
for (const title of ['I. INTRODUCTION', 'II. RELATED WORKS', 'IV. EXPERIMENTS', 'V. CONCLUSIONS']) {
  check(`关键字识别罗马数字标题「${title}」`, heading(title))
}

// ③ 字号路径：论文自定义的章节名（RoboVoLo / VoLoAgent 这类术语）
//    不在关键字表里，但有更大的字号 —— 只能靠字号认
for (const title of [
  '3. RoboVoLo Benchmark',
  '4. VoLoAgent and Physical Orchestration',
  'Experiments',
  'Method'
]) {
  check(`字号识别「${title}」`, bigHeading(title))
  check(`字号不突出时不认（避免误伤图注）「${title}」`, !heading(title))
}

// 剥编号不能太激进：单个字母开头但没跟点的正文句子不能被剥成标题
check('不把「A method for solving the problem」当标题', !heading('A method for solving the problem'))
check('不把「I think the results are promising」当标题', !heading('I think the results are promising'))

// 正文句子不能被误判成标题（这条规则本身是必要的，修的是它的执行时机）
for (const sentence of [
  'Experiments show that the model improves the baseline.',
  'The model works. We evaluate on three benchmarks.',
  'In this section we describe our approach in detail.',
  'Analysis of variance reveals a significant difference across settings.'
]) {
  check(`不把正文句子当标题：${sentence.slice(0, 34)}…`, !heading(sentence))
}

check('过长的行不当标题', !heading(`1. ${'x'.repeat(120)}`))

/* ------------------------------------------------------------------ */
/*  2. 切分：标记残缺时，关键字路径必须补上编号标题                        */
/* ------------------------------------------------------------------ */

console.log('')
console.log('── 2. 标记残缺时的切分（核心回归）───────────')

/*
 * 复刻 VoLo 那篇的真实形态：
 *   - 只有 3 个标记（Abstract / RoboVoLo / VoLoAgent），是旧代码打的；
 *   - 正式章节标题是带编号的，全部没有标记；
 *   - 关键句在「5. Experimental Results」之后；
 *   - 旧行为下它会被吸进上一段 VoLoAgent，模型永远看不到。
 */
const staleMarked = normalizePaperText(
  [
    '## Abstract',
    filler('摘要'),
    '',
    '1. Introduction',
    filler('引言'),
    '',
    '2. Related Work',
    filler('相关工作'),
    '',
    '## RoboVoLo',
    filler('基准'),
    '',
    '## VoLoAgent',
    filler('系统'),
    '',
    '5. Experimental Results',
    'VoLoAgent (Full) uses Claude Opus 4.6 as the decision-making VLM.',
    filler('实验结果'),
    '',
    '## References',
    '[1] Anthropic. Claude Opus system card, 2026.'
  ].join('\n')
)

const sections = splitPaperSections(staleMarked)
const names = Object.keys(sections)
console.log(`     切出章节：${names.join(' / ') || '（无）'}`)

check('补上了 Experiments（修复前完全没有）', names.includes('Experiments'))
check('补上了 Introduction', names.includes('Introduction'))
check('补上了 Related Work', names.includes('Related Work'))
check('原有的标记章节没丢', names.includes('Abstract') && names.includes('VoLoAgent'))

check(
  '关键句落在 Experiments 段内（下游维度才拿得到）',
  (sections.Experiments ?? '').includes('uses Claude Opus 4.6')
)
check(
  '关键句不再被吸进 VoLoAgent 段',
  !(sections.VoLoAgent ?? '').includes('uses Claude Opus 4.6')
)
check('同名章节不会重复切分', names.filter((n) => n === 'Experiments').length === 1)

// 参考文献之后的附录不能混进正文
check('References 不会被当成正文章节', !names.includes('References'))

/* ------------------------------------------------------------------ */
/*  3. 标记完整时不能因为合并而劣化                                       */
/* ------------------------------------------------------------------ */

console.log('')
console.log('── 3. 标记完整时保持原样 ───────────────────')

const wellMarked = normalizePaperText(
  [
    '## Abstract',
    filler('摘要'),
    'Experiments show that the model improves the baseline.',
    '',
    '## Introduction',
    filler('引言'),
    '',
    '## Method',
    filler('方法'),
    '',
    '## Experiments',
    filler('实验'),
    '',
    '## Conclusion',
    filler('结论'),
    '',
    '## References',
    '[1] someone, 2026.'
  ].join('\n')
)

const wellNames = Object.keys(splitPaperSections(wellMarked))
console.log(`     切出章节：${wellNames.join(' / ') || '（无）'}`)
check('完整标记的论文章节名不变', wellNames.join(',') === 'Abstract,Introduction,Method,Experiments,Conclusion')
check('正文里的句子没被当成新章节', wellNames.filter((n) => n.includes(' ')).length === 0)

/* ------------------------------------------------------------------ */
/*  4.（可选）打印一个真实文本的切分结果                                  */
/* ------------------------------------------------------------------ */

const target = process.argv[2]
if (target) {
  console.log('')
  console.log(`── 4. 真实文本：${target} ──────────────`)
  if (!existsSync(target)) {
    console.log('  ⚠️  文件不存在')
  } else {
    const result = splitPaperSections(normalizePaperText(readFileSync(target, 'utf-8')))
    const entries = Object.entries(result).sort((a, b) => b[1].length - a[1].length)
    if (!entries.length) console.log('  ⚠️  没有切出任何章节')
    for (const [name, body] of entries) {
      console.log(`  ${name.padEnd(36)} ${String(body.length).padStart(6)} 字符`)
    }
    const hasExperiments = Object.keys(result).some((n) => n.startsWith('Experiments'))
    console.log('')
    console.log(hasExperiments ? '  ✅ 含有 Experiments 相关章节' : '  ⚠️  没有 Experiments 相关章节')
  }

  /*
   * 可选探针：`npm run smoke:sections -- <txt> "<关键词>"`
   * 报告这个关键词落在哪些章节里 —— 用来确认「某句话到底有没有被投喂给模型」。
   */
  const needle = process.argv[3]
  if (needle && existsSync(target)) {
    const hits = Object.entries(
      splitPaperSections(normalizePaperText(readFileSync(target, 'utf-8')))
    )
      .filter(([, body]) => body.includes(needle))
      .map(([name]) => name)
    console.log('')
    console.log(`  包含「${needle}」的章节：${hits.length ? hits.join(' / ') : '（无 —— 这句话不在任何章节里）'}`)
  }
}

console.log('')
console.log(`${pass}/${pass + fail} 通过`)
if (fail) process.exitCode = 1
