/**
 * 知识图谱层冒烟测试（用真实 sql.js 建库，不启动 Electron）。
 *
 * 覆盖：
 *   1. 多篇论文的实体同名合并（跨论文建图的正确性前提）
 *   2. graphSnapshot 的筛选（分类范围 / minPapers / includePapers）
 *   3. multiHopPaths 的最短路径与「经由实体」推导
 *   4. 缓存指纹失效（改一篇论文后能重新构图）
 *
 * 测试拓扑（刻意设计成链式，让跳数断言无歧义）：
 *
 *   p:A ──┬─ e:AlphaModel ──(trained-on)── e:AlphaBench ──┬─ p:B
 *         └─ e:AlphaBench                                └─(part-of)── e:BetaSet ──┬─ p:C
 *                                                                                   └─(measured-by)── e:GammaMetric
 *   p:D 没有任何图谱数据
 *
 *   因此：A→B 是 2 跳（靠共享实体 AlphaBench），
 *        A→C 是 3 跳（靠 AlphaBench --part-of--> BetaSet 这条**实体间关系**抄近路，
 *        连论文 B 都不需要经过）。
 *
 * 用法：npm run smoke:graph
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PaperGraph } from '@shared/lenses'
import type { PaperMeta } from '@shared/types'
import * as db from '../src/main/db'
import { graphSnapshot, multiHopPaths } from '../src/main/graph'
import { graphLens } from '../src/main/lenses/graph'
import { blankPaperMeta } from '../src/main/vault'

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

function makePaper(id: string, title: string, categories: string[], graph?: PaperGraph): PaperMeta {
  const meta = blankPaperMeta({ id, title, categories, status: 'read' })
  if (graph) meta.graph = graph
  return meta
}

function G(
  entities: [string, string][],
  relations: [string, string, string][] = []
): PaperGraph {
  return {
    entities: entities.map(([name, kind]) => ({ name, kind: kind as never })),
    relations: relations.map(([from, to, type]) => ({ from, to, type: type as never })),
    extractedAt: new Date().toISOString()
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pv-graph-'))
  await db.openDatabase(dir)

  const paperA = makePaper('A', 'Alpha Paper', ['benchmark'], G(
    [
      ['AlphaModel', 'model'],
      ['AlphaBench', 'benchmark']
    ],
    [['AlphaModel', 'AlphaBench', 'trained-on']]
  ))
  const paperB = makePaper('B', 'Beta Paper', ['benchmark'], G(
    [
      ['AlphaBench', 'benchmark'],
      ['BetaSet', 'dataset']
    ],
    [['AlphaBench', 'BetaSet', 'part-of']]
  ))
  const paperC = makePaper('C', 'Gamma Paper', ['survey'], G(
    [
      ['BetaSet', 'dataset'],
      ['GammaMetric', 'metric']
    ],
    [['GammaMetric', 'BetaSet', 'measured-by']]
  ))
  const paperD = makePaper('D', 'No Graph Paper', ['rag'])

  for (const meta of [paperA, paperB, paperC, paperD]) {
    db.upsertPaper({
      meta,
      sections: { 一句话总结: `- ${meta.title}` },
      relPath: `papers/${meta.id}.md`
    })
  }

  const idOf = (name: string): string => `e:${name.toLowerCase()}`

  console.log('── 1. 构图 ──────────────────────────────')
  const full = graphSnapshot({})
  const nodeById = new Map(full.nodes.map((n) => [n.id, n]))

  check('只统计有图谱数据的论文', full.stats.papers === 3, `papers=${full.stats.papers}`)
  check('总论文数包含没有图谱的', full.stats.totalPapers === 4, `total=${full.stats.totalPapers}`)
  check('关系边独立于 mentions 统计', full.stats.relations === 3, `relations=${full.stats.relations}`)

  check('同名实体跨论文合并为一个节点', !!nodeById.get(idOf('AlphaBench')))
  check(
    '合并后的节点统计到 2 篇论文',
    nodeById.get(idOf('AlphaBench'))?.paperCount === 2,
    `paperCount=${nodeById.get(idOf('AlphaBench'))?.paperCount}`
  )
  check('没有图谱数据的论文不进图', !nodeById.has('p:D'))
  check('论文节点已生成', nodeById.get('p:A')?.kind === 'paper')
  check(
    '论文节点带上了分类信息',
    nodeById.get('p:A')?.categories?.includes('benchmark') === true
  )
  check(
    '实体节点带上出现次数',
    nodeById.get(idOf('AlphaBench'))?.mentions === 2,
    `mentions=${nodeById.get(idOf('AlphaBench'))?.mentions}`
  )

  console.log('')
  console.log('── 2. 筛选 ──────────────────────────────')
  const onlySurvey = graphSnapshot({ categories: ['survey'] })
  const surveyNames = new Set(onlySurvey.nodes.map((n) => n.name))
  check('分类筛选只保留该分类的论文', surveyNames.has('Gamma Paper'))
  check('分类筛选后 AlphaBench 消失', !surveyNames.has('AlphaBench'))
  check('分类筛选后 BetaSet 仍在（C 也提到）', surveyNames.has('BetaSet'))

  const dense = graphSnapshot({ minPapers: 2 })
  check(
    'minPapers=2 只留下被多篇提到的实体',
    !dense.nodes.some((n) => n.name === 'GammaMetric') &&
      dense.nodes.some((n) => n.name === 'AlphaBench'),
    `实体=${dense.nodes.filter((n) => n.kind !== 'paper').map((n) => n.name).join(',')}`
  )
  check('minPapers=2 的统计口径与眼前这张图一致', dense.stats.entities === 2, `entities=${dense.stats.entities}`)

  const noPapers = graphSnapshot({ includePapers: false })
  check(
    'includePapers=false 时不画论文节点',
    noPapers.nodes.length > 0 && noPapers.nodes.every((n) => n.kind !== 'paper')
  )

  console.log('')
  console.log('── 3. 多跳检索 ──────────────────────────')
  const hop1 = multiHopPaths('p:A', 1, {})
  check('1 跳命中 2 个直接邻居', hop1.paths.length === 2, `命中 ${hop1.paths.length}`)
  check('1 跳内不包含论文 B', !hop1.paths.some((p) => p.nodeId === 'p:B'))
  check(
    '1 跳的边被高亮',
    hop1.highlightEdges.length >= 2,
    `edges=${hop1.highlightEdges.length}`
  )

  const hop2 = multiHopPaths('p:A', 2, {})
  const bAt2 = hop2.paths.find((p) => p.nodeId === 'p:B')
  check('2 跳能到达论文 B', bAt2?.hops === 2, bAt2 ? `hops=${bAt2.hops}` : '未命中')
  check(
    '论文 B 的路径经由 AlphaBench',
    bAt2?.via.includes('AlphaBench') === true,
    bAt2 ? `via=${bAt2.via.join(' → ')}` : ''
  )
  check('2 跳内不包含论文 C', !hop2.paths.some((p) => p.nodeId === 'p:C'))

  /**
   * 注意 A→C 是 **3 跳**而不是 4 跳：
   *   p:A → e:AlphaBench → e:BetaSet → p:C
   * 中间那一步是**实体到实体**的关系边（AlphaBench --part-of--> BetaSet），
   * 不需要经过论文 B。这正是知识图谱比「共享关键词」更强的地方——
   * 实体间关系会制造捷径，让两篇不共享任何实体的论文也能连起来。
   */
  const hop3 = multiHopPaths('p:A', 3, {})
  const cAt3 = hop3.paths.find((p) => p.nodeId === 'p:C')
  check('3 跳能到达论文 C', cAt3?.hops === 3, cAt3 ? `hops=${cAt3.hops}` : '未命中')
  check(
    '路径经由两个实体（靠实体间关系抄了近路）',
    cAt3?.path.join('>') === 'p:A>e:alphabench>e:betaset>p:C',
    cAt3 ? cAt3.path.map((id) => nodeById.get(id)?.name ?? id).join(' → ') : ''
  )
  check('路径中不含论文 B，证明不是靠共享论文中转', cAt3?.path.includes('p:B') === false)

  const hop4 = multiHopPaths('p:A', 4, {})
  const cAt4 = hop4.paths.find((p) => p.nodeId === 'p:C')
  check('提高跳数不会让最短路径变长', cAt4?.hops === 3, cAt4 ? `hops=${cAt4.hops}` : '')
  check(
    '「经由」实体回答了「为什么相关」',
    cAt4?.via.join('|') === 'AlphaBench|BetaSet',
    cAt4 ? `via=${cAt4.via.join(' → ')}` : ''
  )

  const fromEntity = multiHopPaths(idOf('AlphaBench'), 2, {})
  check(
    '从实体出发也能做多跳（2 跳内命中 3 篇论文）',
    fromEntity.paths.filter((p) => p.kind === 'paper').length === 3,
    `papers=${fromEntity.paths.filter((p) => p.kind === 'paper').length}`
  )
  check(
    '排序把论文排在实体前面',
    fromEntity.paths[0]?.kind === 'paper',
    `first=${fromEntity.paths[0]?.name}`
  )

  check('起点不存在时安全返回空结果', multiHopPaths('e:不存在', 2, {}).paths.length === 0)

  console.log('')
  console.log('── 4. 缓存失效 ──────────────────────────')
  const before = graphSnapshot({}).stats.entities
  const updated = makePaper('D', 'No Graph Paper', ['rag'], G(
    [
      ['AlphaBench', 'benchmark'],
      ['DeltaMethod', 'method']
    ],
    [['DeltaMethod', 'AlphaBench', 'evaluated-on']]
  ))
  db.upsertPaper({ meta: updated, sections: { 一句话总结: '- x' }, relPath: 'papers/D.md' })
  const after = graphSnapshot({})
  check('修改一篇论文后图谱自动重建', after.stats.entities === before + 1, `${before} → ${after.stats.entities}`)
  check(
    '新增论文让 AlphaBench 的论文数变成 3',
    after.nodes.find((n) => n.name === 'AlphaBench')?.paperCount === 3
  )

  console.log('')
  console.log('── 5. 删除论文 ──────────────────────────')
  db.removePaperRow('D')
  const removed = graphSnapshot({})
  check('删除论文后节点消失', !removed.nodes.some((n) => n.name === 'DeltaMethod'))
  check(
    'AlphaBench 的论文数回落',
    removed.nodes.find((n) => n.name === 'AlphaBench')?.paperCount === 2
  )

  /* ---------------- 6. 别名合并 ---------------- */
  console.log('')
  console.log('── 6. 别名合并（aliases）────────────────')

  /*
   * 同一个东西在论文里常有两三种写法。模型抽出的 aliases 就是用来把它们
   * 并成一个节点的 —— 不合并的话，「VLA」和「Vision-Language-Action」
   * 会变成两个互不相连的点，本该存在的跨论文连接就没了。
   */
  const paperE = makePaper('E', 'Alias Paper', ['vlm'], {
    entities: [
      { name: 'Vision-Language-Action', kind: 'concept', aliases: ['VLA'] },
      { name: 'GRPO', kind: 'technique', aliases: ['Group Relative Policy Optimization'] }
    ],
    relations: [],
    extractedAt: new Date().toISOString()
  })
  const paperF = makePaper('F', 'Another Alias Paper', ['vlm'], {
    entities: [
      // 两篇论文用了不同写法，只有靠 aliases 才连得起来
      { name: 'VLA', kind: 'concept' },
      { name: 'Group Relative Policy Optimization', kind: 'technique' }
    ],
    relations: [],
    extractedAt: new Date().toISOString()
  })
  db.upsertPaper({ meta: paperE, sections: {}, relPath: 'papers/E.md' })
  db.upsertPaper({ meta: paperF, sections: {}, relPath: 'papers/F.md' })

  const merged = graphSnapshot({})
  const vlNodes = merged.nodes.filter(
    (n) => n.id === 'e:vla' || n.id === 'e:vision-language-action'
  )
  check('两种写法被合并成一个节点', vlNodes.length === 1, vlNodes.map((n) => n.name).join(', '))
  check('合并后跨越 2 篇论文', vlNodes[0]?.paperCount === 2, `paperCount=${vlNodes[0]?.paperCount}`)
  check('合并后 mentions 不重复计数', vlNodes[0]?.mentions === 2, `mentions=${vlNodes[0]?.mentions}`)
  check(
    '规范名并列时取更短的写法',
    vlNodes[0]?.name === 'VLA',
    `name=${vlNodes[0]?.name}`
  )
  const grpoNodes = merged.nodes.filter((n) => /grpo|group relative/i.test(n.name))
  check('全称与缩写合并为一', grpoNodes.length === 1, grpoNodes.map((n) => n.name).join(', '))
  check(
    '全称也计入论文数（靠别名索引接上）',
    grpoNodes[0]?.paperCount === 2,
    `paperCount=${grpoNodes[0]?.paperCount}`
  )

  /* ---------------- 7. 噪音实体过滤 ---------------- */
  console.log('')
  console.log('── 7. 噪音实体过滤 ─────────────────────')

  const parsed = graphLens.parse(
    {
      entities: [
        { name: 'Best Paper Award', kind: 'concept' },
        { name: 'Nobel Prize', kind: 'concept' },
        { name: 'GRPO', kind: 'technique', aliases: ['Group Relative Policy Optimization', '   ', 'GRPO'] }
      ],
      relations: []
    },
    {} as never
  )
  const parsedEntities = (parsed.data?.graph as { entities: { name: string; aliases?: string[] }[] })
    .entities
  check(
    '荣誉 / 奖项类实体被滤掉',
    parsedEntities.length === 1,
    parsedEntities.map((e) => e.name).join(', ')
  )
  check(
    '别名里的空串与自身被清掉',
    parsedEntities[0]?.aliases?.join(',') === 'Group Relative Policy Optimization',
    parsedEntities[0]?.aliases?.join(',') ?? '(无)'
  )

  /* ---------------- 8. 粒度统计（自动选粒度的依据） ---------------- */
  console.log('')
  console.log('── 8. 粒度统计 ─────────────────────────')

  /*
   * 渲染层靠这两个统计决定「第一次打开时该按几篇论文起画」——
   * 全量 130 个实体是毛球，跨论文的那几个才是骨架。
   * 所以它们必须统计「筛选前的全部实体」，不能被 minPapers 影响。
   */
  const all = graphSnapshot({ minPapers: 1 })
  const onlyShared = graphSnapshot({ minPapers: 2 })

  check(
    'totalEntities 是全部实体，不受 minPapers 影响',
    all.stats.totalEntities === onlyShared.stats.totalEntities && all.stats.totalEntities > 0,
    `${all.stats.totalEntities} vs ${onlyShared.stats.totalEntities}`
  )
  check(
    'single + multi = total（两个统计互不重叠）',
    all.stats.singletons + all.stats.multiPaperEntities === all.stats.totalEntities,
    `${all.stats.singletons} + ${all.stats.multiPaperEntities} = ${all.stats.totalEntities}`
  )
  check(
    'multiPaperEntities 恰好等于 minPapers=2 时画出的实体数',
    onlyShared.stats.multiPaperEntities ===
      onlyShared.nodes.filter((n) => n.kind !== 'paper').length,
    `multi=${onlyShared.stats.multiPaperEntities}`
  )
  check(
    'minPapers=2 时画布上只剩骨架',
    onlyShared.nodes.every((n) => n.kind === 'paper' || n.paperCount >= 2)
  )

  /* ---------------- 5. 论文关系层 ---------------- */
  console.log('')
  console.log('── 5. 论文关系层（paper） ────────────────')

  /*
   * 刻意把四种情况都摆进来：
   *   A → B   基于（带一句「为什么有关」）
   *   B → A   结论冲突 —— 反方向的另一条，必须各留各的
   *   C → A   可迁移（AI 提议，带依据）
   *   D → ZZZ 指向不存在的论文 —— 必须丢掉，不能画悬空的线
   */
  paperA.links = [
    { to: 'B', type: 'builds-on', by: 'user', note: '把它的检索环节换成了图检索' }
  ]
  paperB.links = [{ to: 'A', type: 'contradicts', by: 'user' }]
  paperC.links = [
    { to: 'A', type: 'inspires', by: 'ai', evidence: '§4.2 说可以搬过去' }
  ]
  paperD.links = [{ to: 'ZZZ', type: 'related', by: 'user' }]
  for (const meta of [paperA, paperB, paperC, paperD]) {
    db.upsertPaper({
      meta,
      sections: { 一句话总结: `- ${meta.title}` },
      relPath: `papers/${meta.id}.md`
    })
  }

  // 这一步同时验证了缓存指纹：links 变了就必须重新构图（改数据前 section 1 已经构图并缓存过）
  const relations = graphSnapshot({ mode: 'relations' })
  check('关系视图里只有论文节点', relations.nodes.every((n) => n.kind === 'paper'))
  check('没连过关系的论文不画（D 不该出现）', !relations.nodes.some((n) => n.paperId === 'D'))
  check('三条有效关系都在', relations.edges.length === 3, `edges=${relations.edges.length}`)
  check(
    '反方向算两条（A→B 基于、B→A 冲突是两件事）',
    relations.edges.some((e) => e.paperId === 'A' && e.type === 'builds-on') &&
      relations.edges.some((e) => e.paperId === 'B' && e.type === 'contradicts')
  )
  check('指向不存在论文的边被丢掉（不画悬空的线）', !relations.edges.some((e) => e.paperId === 'D'))
  check(
    '关系边带上你写的那句「为什么有关」',
    relations.edges.some((e) => e.evidence === '把它的检索环节换成了图检索')
  )
  check(
    'AI 提议的关系带 by=ai（界面上要能认出来）',
    relations.edges.some((e) => e.by === 'ai' && e.evidence === '§4.2 说可以搬过去')
  )
  check('关系边标了 paper 层（画布靠它换配色与线宽）', relations.edges.every((e) => e.layer === 'paper'))
  check('统计里给出关系总数', relations.stats.links === 3, `links=${relations.stats.links}`)

  const byCat = graphSnapshot({ mode: 'relations', categories: ['benchmark'] })
  check(
    '分类筛选对关系层同样生效（C 是 survey，被挡掉）',
    byCat.nodes.length === 2 && byCat.edges.length === 2,
    `nodes=${byCat.nodes.length} edges=${byCat.edges.length}`
  )
  check(
    '被挡住的关系仍算在 links 里（界面靠它区分「没连过」和「被筛掉」）',
    byCat.stats.links === 3 && byCat.stats.relations === 2
  )

  const entityView = graphSnapshot({ mode: 'entities' })
  check(
    '实体层把论文关系边叠上来（这就是「叠加」的意思）',
    entityView.edges.some((e) => e.layer === 'paper')
  )
  check(
    '但「N 条关系」只数抽出来的那些（否则数字会忽大忽小）',
    entityView.stats.relations === 3,
    `relations=${entityView.stats.relations}`
  )

  const hopFromB = multiHopPaths('p:B', 2, { mode: 'relations' })
  const toC = hopFromB.paths.find((p) => p.paperId === 'C')
  check(
    '关系层的多跳：B → A → C，经由的是**论文**而不是实体',
    toC?.hops === 2 && toC.via.includes('Alpha Paper'),
    `via=${toC?.via.join('/') ?? '(无)'}`
  )
  check(
    '关系层不会经由实体抄近路',
    hopFromB.paths.every((p) => p.kind === 'paper'),
    hopFromB.paths.map((p) => p.kind).join(',')
  )
  check(
    '实体层不受影响：仍然经由实体（两层各走各的）',
    multiHopPaths('p:A', 2, {}).paths.some((p) => p.kind !== 'paper' && p.via.length > 0)
  )

  db.closeDatabase()
  rmSync(dir, { recursive: true, force: true })

  console.log('')
  console.log(`${pass}/${pass + fail} 通过`)
  if (fail) process.exitCode = 1
}

main().catch((err) => {
  console.error('❌ 失败：', err)
  process.exit(1)
})
