/**
 * 「写作思路」的回归（纯函数，不联网）。
 *
 * 这条链路有两个地方特别容易悄悄坏掉：
 *
 *   1. **归一化**：frontmatter 是用户可手改的 YAML，枚举拼错、角色写成中文都会发生。
 *      归一化一旦放行脏值，整个套路库的统计都会偏 —— 而且看起来一切正常。
 *   2. **聚类阈值**：这是「多篇逻辑一样就串起来」这件事的全部依据。
 *      权重改一改，「两篇不同打法的论文被塞进同一套」或者「永远聚不出套路」
 *      都不报错，只是结果错了。所以把当前口径锁成断言。
 *
 * 用法：npm run smoke:writing
 */
import {
  buildWritingOverview,
  clusterWritingPatterns,
  normalizeWritingLogic,
  writingLogicCompleteness,
  writingLogicMissing,
  writingLogicSimilarity,
  type WritingLogic
} from '../src/shared/writing-logic'

const out: string[] = []
let bad = 0
let total = 0
const check = (name: string, cond: boolean, extra = ''): void => {
  total++
  if (!cond) bad++
  out.push(`${cond ? '✅' : '❌'} ${name}${extra ? `  ← ${extra}` : ''}`)
}

/** 造一张卡：只关心聚类用到的三个信号，其余字段给能过归一化的最小值 */
function mk(type: string, advantages: string[], roles: string[]): WritingLogic {
  const logic = normalizeWritingLogic({
    storyline: {
      type,
      oneliner: `${type} 的一条主线`,
      pain: '痛点',
      gap: '缺口',
      insight: '洞察',
      validation: '验证'
    },
    intro: {
      paragraphs: [{ n: 1, question: '这段回答什么', quote: 'We show that…', slot: '换成我的场景' }],
      gapTurn: 'However, none of them…',
      contributions: [{ claim: '提出了 X', kind: 'mechanism', backsGap: '缺口', support: 'Table 1' }]
    },
    citedWorks: roles.map((role, i) => ({
      work: `Work${i}`,
      section: 'Introduction',
      role,
      highlights: []
    })),
    advantages: advantages.map((dimension) => ({
      dimension,
      claim: `${dimension} 更好`,
      support: 'Table 2'
    })),
    relatedWork: {
      axis: '按是否需要训练',
      groups: [{ label: '训练型', gist: '要训', gap: '成本高' }],
      positioning: '我们放在这一类之后'
    },
    method: { steps: [{ step: '编码', purpose: '证明可扩展' }], argument: '只能这么选' }
  })
  if (!logic) throw new Error(`fixture 造卡失败：${type}`)
  return logic
}

function main(): void {
  /* ① 归一化：脏值要挡住，而不是让它们进统计 */
  const dirty = normalizeWritingLogic({
    storyline: { type: 'BOGUS_TYPE', oneliner: '  一条主线  ' },
    citedWorks: [
      { work: 'A', role: '靶子', highlights: ['accuracy', '不存在的维度'] },
      { work: 'a', role: 'target' }
    ],
    advantages: [{ dimension: 'nope', claim: '不该被收' }],
    intro: { paragraphs: [{ n: 0, question: '问' }] }
  })
  check('有主线就算有效卡', dirty != null)
  check('未知故事线类型退回 gap-driven', dirty?.storyline.type === 'gap-driven', dirty?.storyline.type)
  check('中文角色退回 background', dirty?.citedWorks[0]?.role === 'background', dirty?.citedWorks[0]?.role)
  check('未知优势维度被丢掉', dirty?.advantages.length === 0, `实际 ${dirty?.advantages.length}`)
  check(
    '同一条被引工作按大小写去重',
    dirty?.citedWorks.length === 1,
    `实际 ${dirty?.citedWorks.length}`
  )
  check(
    'highlights 里的未知维度被过滤',
    dirty?.citedWorks[0]?.highlights.length === 1,
    `实际 ${dirty?.citedWorks[0]?.highlights.length}`
  )
  check('段落序号缺省时补 1', dirty?.intro.paragraphs[0]?.n === 1, String(dirty?.intro.paragraphs[0]?.n))

  /* ② 没有故事线主线的卡视为无效 —— 它进了聚类只会制造噪声 */
  check('缺主线 → undefined', normalizeWritingLogic({ storyline: { type: 'gap-driven' } }) === undefined)
  check('非对象 → undefined', normalizeWritingLogic('nope') === undefined)

  /* ③ 相似度：同类型 + 同优势 + 同引用结构 = 满分 */
  const a = mk('gap-driven', ['accuracy', 'efficiency'], ['target', 'target', 'target', 'background'])
  const b = mk('gap-driven', ['accuracy', 'efficiency'], ['target', 'target', 'target', 'background'])
  const c = mk('efficiency', ['cost'], ['tool', 'tool', 'background'])
  check('完全一致的两张卡相似度为 1', writingLogicSimilarity(a, b) > 0.999, String(writingLogicSimilarity(a, b)))
  check('故事线 + 优势都不同的卡相似度低', writingLogicSimilarity(a, c) < 0.3, String(writingLogicSimilarity(a, c)))

  /* ④ 聚类：相似的三篇成一套，不同的一篇单独列 */
  const d = mk('gap-driven', ['accuracy'], ['target', 'target', 'background'])
  const { patterns, singletons } = clusterWritingPatterns([
    { paperId: 'p1', logic: a },
    { paperId: 'p2', logic: b },
    { paperId: 'p3', logic: d },
    { paperId: 'p4', logic: c }
  ])
  check('聚出一套', patterns.length === 1, `实际 ${patterns.length}`)
  check('成员数正确', patterns[0]?.memberIds.length === 3, `实际 ${patterns[0]?.memberIds.length}`)
  check('成员 id 已排序', patterns[0]?.memberIds.join(',') === 'p1,p2,p3', patterns[0]?.memberIds.join(','))
  check('不同打法的论文进单篇列表', singletons.includes('p4'), singletons.join(','))
  check('套路 id 由成员决定', patterns[0]?.id.startsWith('wp') === true)
  check('簇内紧密度在合理区间', (patterns[0]?.cohesion ?? 0) > 0.5, String(patterns[0]?.cohesion))

  /* ⑤ 单篇不构成套路：不硬凑 —— 这是「宁少不错」那条线 */
  const solo = clusterWritingPatterns([{ paperId: 'only', logic: a }])
  check('只有一篇时没有套路', solo.patterns.length === 0)
  check('只有一篇时进单篇列表', solo.singletons.join(',') === 'only')

  /* ⑥ 完成度与缺口提示 */
  check('完整卡完成度为 1', writingLogicCompleteness(a) === 1, String(writingLogicCompleteness(a)))
  check('没有卡完成度为 0', writingLogicCompleteness(undefined) === 0)
  check('没有卡时缺口提示明确', writingLogicMissing(undefined)[0] === '还没有写作逻辑卡')

  const partial = normalizeWritingLogic({
    storyline: { type: 'unification', oneliner: '主线' },
    citedWorks: [{ work: 'X', role: 'target' }]
  })
  check('半张卡不会算成完整', (writingLogicCompleteness(partial) ?? 0) < 0.6, String(writingLogicCompleteness(partial)))
  check('缺的区块被点名', writingLogicMissing(partial).includes('Introduction 逐段'))

  /* ⑦ 页面快照：卡片与套路来自同一次计算，不该出现「套路里有、卡片里没有」 */
  const overview = buildWritingOverview([
    { id: 'p1', title: 'A', year: 2024, categories: [], wlogic: a },
    { id: 'p2', title: 'B', year: 2025, categories: [], wlogic: b },
    { id: 'p3', title: 'C', year: null, categories: [] }
  ])
  check('每篇论文都有一张卡（哪怕还没抽）', overview.cards.length === 3, String(overview.cards.length))
  check('没抽过的那篇标了缺口', (overview.cards.find((x) => x.paperId === 'p3')?.missing.length ?? 0) > 0)
  check('套路成员都能在卡片里找到', overview.patterns[0]?.memberIds.every((id) => overview.cards.some((c) => c.paperId === id)) === true)

  process.stdout.write(`\n── 写作思路 ────────────────────────────\n${out.join('\n')}\n\n`)
  if (bad) {
    process.stdout.write(`${bad}/${total} 条断言失败\n`)
    process.exit(1)
  }
  process.stdout.write(`${total}/${total} 通过\n`)
}

main()
