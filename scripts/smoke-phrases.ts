/**
 * 句式抽取的回归（纯函数，不联网）。
 *
 * 起因：做「一键复制写作手法里的句式」时，发现这条路已经有现成的抽取器
 * （`extractPhraseCandidates`），差点另写一套。两套规则并存会漂移成
 * 「复制按钮说有 3 条、句式库显示 5 条」—— 而用户没有理由判断该信哪个。
 * 所以把它的行为锁下来：现在「详情页复制」和「句式库」用的是同一个函数。
 *
 * 它面对的输入有两个特点，也正是失败的两种方向：
 *   - **模型写的**：格式不总是守规矩 → 漏收（句式明明在，一条都没抽出来）；
 *   - **人会手改**：会换成中文、会补说明 → 错收（把分析当句式收走，
 *     而用户往往粘进自己论文才发现）。
 *
 * 用法：npm run smoke:phrases
 */
import {
  buildPhraseBank,
  extractPhraseCandidates,
  phraseBankGroupOf,
  phraseBankGroups,
  type PhrasePaperInput
} from '../src/shared/phrases'

const out: string[] = []
let bad = 0
let total = 0
const check = (name: string, cond: boolean, extra = ''): void => {
  total++
  if (!cond) bad++
  out.push(`${cond ? '✅' : '❌'} ${name}${extra ? `  ← ${extra}` : ''}`)
}

function main(): void {
  /* ① 标准 scaffold：抽「可复用句式」下的列表项 */
  const intro = [
    '- **段落推进逻辑**（每段做什么）：',
    '  - 第一段铺背景，第二段逼出 gap',
    '- **可复用句式**：',
    '  - "We propose a unified framework for multi-hop retrieval."',
    '  - "Unlike prior work that relies on sparse retrieval, our method keeps …"',
    '- **Contribution 怎么写**：',
    '  - 三条，动词用 propose / introduce / demonstrate'
  ].join('\n')
  const a = extractPhraseCandidates({ '写作手法 · Introduction': intro })
  check('抽出两条可复用句式', a.length === 2, `实际 ${a.length}：${a.map((p) => p.text).join(' | ')}`)
  check('包裹的引号被剥掉', a[0]?.text.startsWith('We propose') === true, a[0]?.text)
  check('来源标记为 writing', a.every((p) => p.source === 'writing'))
  check('标签保留子项名', a[0]?.label === '可复用句式', a[0]?.label)

  /* ② 只认「写作手法 / 原文摘录」两类章节 —— 详情页的复制按钮只传一节，别把别节顺带抽走 */
  const mixed = extractPhraseCandidates({
    '写作手法 · Abstract':
      '- **亮点句式**：\n  - "In this paper we show that retrieval can be learned end to end."',
    方法细节: '- **亮点句式**：\n  - "This line must never be picked up from method details."'
  })
  check('只抽写作手法章节', mixed.length === 1, `实际 ${mixed.length}`)
  check('方法细节里的同名小节不被抽', !mixed.some((p) => p.text.includes('never be picked up')))

  /* ③ 太短 / 纯数字 / URL 要挡掉，否则清单里全是噪音 */
  const noise = extractPhraseCandidates({
    '写作手法 · Experiments': [
      '- **可复用表达**：',
      '  - yes',
      '  - 3.14',
      '  - https://example.com/paper',
      '  - "We evaluate on three benchmarks and report the mean over five runs."'
    ].join('\n')
  })
  check(
    '太短 / 纯数字 / URL 被挡掉，只留下真正的句子',
    noise.length === 1,
    `实际 ${noise.length}：${noise.map((p) => p.text).join(' | ')}`
  )

  /* ④ 切到下一个子项就收手 —— 「错收」的主要来源 */
  const thenNext = extractPhraseCandidates({
    '写作手法 · Related Work': [
      '- **可复用表达**：',
      '  - "Prior work has largely focused on the single-hop setting."',
      '- **如何温和地指出他人不足**：',
      '  - 先说他们解决了什么，再指出在他们的设定下成立'
    ].join('\n')
  })
  check('切到下一子项后停止收集', thenNext.length === 1, `实际 ${thenNext.length}`)

  /* ⑤ 正文里被引号摘出来的英文原句也要收（模型常直接摘原文） */
  const quoted = extractPhraseCandidates({
    '写作手法 · Abstract':
      '作者用 "We introduce a benchmark that requires compositional reasoning over multiple documents." 开门见山。'
  })
  check('正文引号里的英文长句被摘出来', quoted.length === 1, `实际 ${quoted.length}`)
  check('引文标记为引文摘录', quoted[0]?.label === '引文摘录', quoted[0]?.label)

  /* ⑥ 去重：同一句出现在两个子项下只留一条 */
  const dup = extractPhraseCandidates({
    '写作手法 · Abstract': [
      '- **亮点句式**：',
      '  - "We propose a method that works well in practice."',
      '- **可复用表达**：',
      '  - "We propose a method that works well in practice."'
    ].join('\n')
  })
  check('重复句子只留一条', dup.length === 1, `实际 ${dup.length}`)

  /* ⑦ 边界：空输入不崩 */
  check('空章节字典返回空', extractPhraseCandidates({}).length === 0)
  check('空内容返回空', extractPhraseCandidates({ '写作手法 · Abstract': '' }).length === 0)

  /* ⑧ 句式库聚合：带上论文信息，curated（模型精炼）优先于正则抽取 */
  const papers: PhrasePaperInput[] = [
    {
      id: 'p1',
      title: 'Paper One',
      year: 2026,
      categories: ['rag'],
      sections: {
        '写作手法 · Abstract':
          '- **亮点句式**：\n  - "We propose a retrieval-augmented pipeline for open-domain QA."'
      },
      structuredPhrases: [{ category: '引言', text: 'to the best of our knowledge', usage: '限定范围' }]
    }
  ]
  const bank = buildPhraseBank(papers)
  check('句式库带上论文信息', bank.every((e) => e.paperId === 'p1' && e.paperTitle === 'Paper One'))
  check('curated 的短语排在前面', bank[0]?.source === 'curated', bank[0]?.source)
  check('正则抽的句式也在库里', bank.some((e) => e.source === 'writing'))
  check('同一句不会重复入榜', bank.length === new Set(bank.map((e) => e.text.toLowerCase())).size)

  /*
   * ⑨ 分组口径。
   *
   * 句式库并入「写作思路」后，左栏分组由 shared/phrases.ts 统一提供，
   * 页面里那份写死的 groupOf 已经删掉。这里锁住三条容易改坏的口径：
   * 章节前缀要去掉、原文摘录单独成组、分组顺序按写作流程而不是字母。
   */
  check(
    '章节前缀被去掉',
    phraseBankGroupOf({ ...bank[0], section: '写作手法 · Introduction' }) === 'Introduction'
  )
  check(
    '原文摘录单独成组',
    phraseBankGroupOf({ ...bank[0], source: 'excerpt', section: '写作手法 · Abstract' }) === '原文摘录'
  )
  const grouped = phraseBankGroups([
    { ...bank[0], section: '写作手法 · Abstract' },
    { ...bank[0], section: '写作手法 · Introduction' },
    { ...bank[0], section: '写作手法 · Introduction' },
    { ...bank[0], source: 'excerpt', section: '写作手法 · Abstract' }
  ])
  check('分组按写作顺序排（Abstract 在 Introduction 前）', grouped[0]?.[0] === 'Abstract', grouped[0]?.[0])
  check('同组计数正确', grouped.find(([g]) => g === 'Introduction')?.[1] === 2)
  check(
    '原文摘录排在最后',
    grouped[grouped.length - 1]?.[0] === '原文摘录',
    grouped[grouped.length - 1]?.[0]
  )
}

main()
console.log(out.join('\n'))
console.log(
  bad
    ? `\n❌ smoke:phrases ${total - bad}/${total} 通过`
    : `\n✅ smoke:phrases ${total}/${total} 通过`
)
process.exit(bad ? 1 : 0)
