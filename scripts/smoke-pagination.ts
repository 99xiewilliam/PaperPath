/**
 * 阅读器几何的回归测试。
 *
 * 覆盖三块「滚动时每帧都在跑 / 偏一点就肉眼可见」的数学：
 *   1. 分页几何（@shared/pagination）：当前页显示几 / 渲染哪几页 / 翻页滚到哪。
 *      偏 1px 就表现为「页码乱跳」或「滚到中间突然一屏空白」。
 *   2. 行矩形抽取（pdfText.buildPositionedLines）：AI 标重点的位置来源，
 *      双栏并线会把高亮画成横跨整页的横杠。
 *   3. 阅读位置规范化：存进索引 DB 的「上次读到哪」，坏数据不能把人拽到奇怪的地方。
 *
 * 全是纯函数，在界面上极难复现的问题都锁在这里。
 *
 * 用法：npm run smoke:pagination
 */
import {
  currentPageAt,
  normalizeReadingPosition,
  pageOffsets,
  scrollTopForPage,
  visiblePageRange
} from '@shared/pagination'
import { buildPositionedLines, type TextItemLike } from '../src/renderer/src/lib/pdfText'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? `  ${detail}` : ''}`)
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(name, a === e, a === e ? '' : `实际 ${a}，期望 ${e}`)
}

function main(): void {
  /* ---------------- 1. pageOffsets：位置是累加出来的 ---------------- */
  console.log('── 1. 页面偏移 ─────────────────────────────')

  eq('空文档没有偏移', pageOffsets([], 16), [])
  eq('单页从 0 开始', pageOffsets([1000], 16), [0])
  eq(
    '三页累加：每页 = 前一页底部 + 间距',
    pageOffsets([1000, 800, 1200], 16),
    [0, 1016, 1832]
  )
  check(
    '偏移严格递增（翻页目标不会倒着走）',
    (() => {
      const o = pageOffsets([500, 900, 300, 1100], 16)
      return o.every((v, i) => i === 0 || v > o[i - 1])
    })()
  )
  check(
    '页高可以不一样（论文里偶发横排大图页）',
    pageOffsets([100, 200], 10)[1] === 110
  )

  /* ---------------- 2. scrollTopForPage：翻页落点 ---------------- */
  console.log('')
  console.log('── 2. 翻页落点 ─────────────────────────────')

  const offsets = pageOffsets([1000, 1000, 1000], 16)
  eq('翻到第 1 页 = 回到顶部', scrollTopForPage(offsets, 0), 0)
  eq('翻到第 3 页 = 它的偏移', scrollTopForPage(offsets, 2), 2032)
  check(
    '「下一页」按过头不会飞出文档（收敛到末页）',
    scrollTopForPage(offsets, 99) === 2032
  )
  check(
    '「上一页」按过头不会变负数（收敛到首页）',
    scrollTopForPage(offsets, -5) === 0
  )
  eq('空文档翻页 = 0', scrollTopForPage([], 3), 0)

  /* ---------------- 3. currentPageAt：视口落在哪页 ---------------- */
  console.log('')
  console.log('── 3. 当前页判定 ───────────────────────────')

  eq('还没滚 = 第 1 页', currentPageAt(0, offsets), 0)
  eq('页内任意位置都算这页', currentPageAt(500, offsets), 0)
  check(
    '锚点正好压在新页顶部 → 算新页（边界归属不能反）',
    currentPageAt(1016, offsets) === 1
  )
  check(
    '锚点落在两页缝隙里 → 归上面那页（页码不在缝里闪）',
    currentPageAt(1008, offsets) === 0,
    '第 1 页底部 1000，第 2 页顶部 1016'
  )
  check(
    '滚过整篇 → 停在最后一页（不出现 25 / 24）',
    currentPageAt(99999, offsets) === 2
  )
  eq('负锚点（还没滚到第一页顶部）= 第 1 页', currentPageAt(-50, offsets), 0)
  eq('空文档 = 0', currentPageAt(100, []), 0)

  /* ---------------- 4. visiblePageRange：渲染窗口 ---------------- */
  console.log('')
  console.log('── 4. 渲染窗口 ─────────────────────────────')

  const h10 = Array.from({ length: 10 }, () => 1000)
  const o10 = pageOffsets(h10, 16)

  eq('视口在开头 → 从第 1 页开始', visiblePageRange(0, 800, o10, h10), { start: 0, end: 0 })
  check(
    '露了 1px 的下一页也要渲染（不然滚动时底部一条白缝）',
    visiblePageRange(0, 1017, o10, h10).end === 1,
    '第 2 页顶部在 1016，视口底到 1017 = 相交 1px'
  )
  eq('视口盖住 4~5 页', visiblePageRange(3100, 4700, o10, h10), { start: 3, end: 4 })
  check(
    '窗口随滚动滑动（中段）',
    (() => {
      const r = visiblePageRange(5100, 6300, o10, h10)
      return r.start === 5 && r.end === 6
    })()
  )
  eq(
    '滚到底 → 窗口收敛在末页，不越界',
    visiblePageRange(9200, 11000, o10, h10),
    { start: 9, end: 9 }
  )
  eq('视口比整篇还大 → 全部渲染', visiblePageRange(-100, 99999, o10, h10), { start: 0, end: 9 })
  eq('没有页面 → 空区间', visiblePageRange(0, 800, [], []), { start: 0, end: -1 })

  /*
   * overscan 是调用方的事（视口上下各扩一屏），但函数必须忠实地
   * 把扩进来的页包含进去 —— 否则缓冲形同虚设。
   */
  const withOverscan = visiblePageRange(3100 - 800, 3900 + 800, o10, h10)
  check(
    '上下各扩 800 后窗口变大（overscan 生效）',
    withOverscan.start === 2 && withOverscan.end === 4,
    JSON.stringify(withOverscan)
  )

  // 变高页面：一条横排版式页混进来，窗口边界仍要对
  const mixed = [1000, 500, 1000]
  const om = pageOffsets(mixed, 16)
  eq(
    '变高页面的窗口边界（三页都被视口扫到一点边）',
    visiblePageRange(1000, 1532, om, mixed),
    { start: 0, end: 2 }
  )

  /* ---------------- 5. 往返一致性：翻页落点 ↔ 当前页 ---------------- */
  console.log('')
  console.log('── 5. 翻页往返一致 ─────────────────────────')

  /*
   * 「翻到第 N 页」之后再问「当前在哪页」，答案必须还是 N ——
   * 否则点高亮跳过去之后工具栏显示的是另一页，看起来就像跳错了。
   * 锚点取视口 40% 处（和组件里同一约定）。
   */
  const roundTrip = (index: number): number => {
    const top = scrollTopForPage(o10, index)
    return currentPageAt(top + 400 * 0.4, o10)
  }
  check(
    '每一页翻过去再读回来都是它自己',
    [0, 1, 2, 5, 9].every((i) => roundTrip(i) === i)
  )
  check(
    '翻过去的落点必然在渲染窗口里（不会跳过去还是空白）',
    (() => {
      const i = 6
      const top = scrollTopForPage(o10, i)
      const r = visiblePageRange(top, top + 800, o10, h10)
      return i >= r.start && i <= r.end
    })()
  )

  /* ---------------- 6. 带位置的行抽取（AI 标重点的位置来源） ---------------- */
  console.log('')
  console.log('── 6. 行矩形抽取（pdfText.buildPositionedLines） ──')

  /*
   * AI 标重点的矩形全从这里来。最怕的是双栏排版：左右两栏的行 y 坐标几乎相同，
   * 只看 y 会并成一行，高亮矩形就横跨整页 —— 所以横向大空隙必须强制断行。
   * 页面按 letter 尺寸 612×792 构造。
   */
  const item = (
    str: string,
    x: number,
    baseline: number,
    width: number,
    hasEOL = false
  ): TextItemLike => ({
    str,
    transform: [10, 0, 0, -10, x, baseline],
    width,
    height: 10,
    hasEOL
  })

  const merged = buildPositionedLines([item('Hello', 72, 700, 50), item(' world', 122, 700, 40)], 612, 792)
  check('同一基线上的文字并成一行', merged.length === 1)
  check(
    '包围盒覆盖两个文字块（左到 72，右到 162）',
    merged.length === 1 &&
      Math.abs(merged[0].rect.x - 72 / 612) < 0.002 &&
      Math.abs(merged[0].rect.w - 90 / 612) < 0.002,
    JSON.stringify(merged[0]?.rect)
  )
  check('行内空白被收敛', merged[0]?.text === 'Hello world')
  check(
    '矩形纵向是 CSS 空间（基线 700 靠页顶 → y 小；曾经的镜像 bug 回归）',
    (() => {
      // height=10：top = 700-10 = 690，bottom = 700+10*0.35 = 703.5（都从页底 792 量）
      // CSS y = 1 - 703.5/792 ≈ 0.112，h = 13.5/792 ≈ 0.017
      const l = buildPositionedLines([item('顶部行', 72, 700, 50)], 612, 792)[0]
      return (
        Math.abs(l.rect.y - (1 - 703.5 / 792)) < 0.002 &&
        Math.abs(l.rect.h - (13.5 / 792)) < 0.002
      )
    })()
  )

  const twoRows = buildPositionedLines(
    [item('第一行', 72, 700, 50), item('第二行', 72, 686, 50)],
    612,
    792
  )
  check('y 跳变分行', twoRows.length === 2)

  const twoCols = buildPositionedLines(
    [item('左栏', 72, 700, 100), item('右栏', 350, 700, 100)],
    612,
    792
  )
  check('横向大空隙强制断行（双栏不并线）', twoCols.length === 2, `${twoCols.length} 行`)
  check(
    '左栏的矩形没有横跨到右栏（否则高亮是一整条横杠）',
    twoCols.length === 2 && twoCols[0].rect.x + twoCols[0].rect.w < 0.4,
    JSON.stringify(twoCols[0]?.rect)
  )

  const eol = buildPositionedLines([item('一', 72, 700, 20, true), item('二', 72, 700, 20)], 612, 792)
  check('hasEOL 强制断行', eol.length === 2)

  check(
    '矩形被归一化并收敛到 0~1',
    buildPositionedLines([item('贴边', -10, 800, 700)], 612, 792).every(
      (l) => l.rect.x >= 0 && l.rect.y >= 0 && l.rect.x + l.rect.w <= 1 && l.rect.y + l.rect.h <= 1
    )
  )
  eq('空输入 → 没有行', buildPositionedLines([], 612, 792), [])
  eq('纯空白文字不产生行', buildPositionedLines([item('   ', 72, 700, 20)], 612, 792), [])

  /* ---------------- 7. 阅读位置（上次读到哪） ---------------- */
  console.log('')
  console.log('── 7. 阅读位置规范化 ───────────────────────')

  eq(
    '正常存档原样读回',
    normalizeReadingPosition({ ratio: 0.5, page: 3, updatedAt: '2026-09-16' }),
    { ratio: 0.5, page: 3, updatedAt: '2026-09-16' }
  )
  check(
    '比例越界收敛到 0~1（换窗口/换缩放后旧值可能超界）',
    normalizeReadingPosition({ ratio: 1.8, page: 2 })?.ratio === 1 &&
      normalizeReadingPosition({ ratio: -0.3, page: 2 })?.ratio === 0
  )
  check(
    '页码至少是 1 且取整',
    normalizeReadingPosition({ ratio: 0.1, page: 0 })?.page === 1 &&
      normalizeReadingPosition({ ratio: 0.1, page: 3.6 })?.page === 4
  )
  check(
    '垃圾输入当作没存过（不报错、不恢复）',
    normalizeReadingPosition(null) === undefined &&
      normalizeReadingPosition('0.5') === undefined &&
      normalizeReadingPosition({ ratio: 'abc', page: 1 }) === undefined &&
      normalizeReadingPosition({}) === undefined
  )

  console.log('')
  console.log(`${pass}/${pass + fail} 通过`)
  if (fail) process.exitCode = 1
}

main()
