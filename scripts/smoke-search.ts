/**
 * 全文检索冒烟测试。
 *
 * 为什么值得单独测：
 *   - sql.js 没有 FTS5，所以走了 tokenized LIKE 这条路，中文靠「子串匹配」，
 *     语义必须锁死（搜「检索」要能命中「多跳检索」）；
 *   - LIKE 的 % 和 _ 是通配符，用户输入如果不转义会变成「匹配一切」；
 *   - 这次改动把搜索从渲染层挪到了主进程，覆盖面必须**只增不减**——
 *     原来搜得到的现在也要搜得到，同时新增笔记正文。
 *
 * 用法：npm run smoke:search
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { escapeLikePattern, tokenizeQuery } from '@shared/search'
import * as db from '../src/main/db'
import * as vault from '../src/main/vault'

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

const longEnough = (text: string): string =>
  text + '这是一段补充说明，让章节长度足以通过「是否已填写」的阈值判断。'.repeat(2)

async function main(): Promise<void> {
  /* ---------------- 1. 查询分词 ---------------- */
  console.log('── 1. 查询分词 tokenizeQuery ─────────────────')
  eq('纯中文片段整体保留（不做分词，靠子串匹配）', tokenizeQuery('多跳检索'), ['多跳检索'])
  eq('多个中文片段按空格切开', tokenizeQuery('检索 增强'), ['检索', '增强'])
  eq('英文转小写', tokenizeQuery('LoRA CommonCrawl'), ['lora', 'commoncrawl'])
  eq('中英混排', tokenizeQuery('RAG-based 方法'), ['rag', 'based', '方法'])
  eq('全角括号等标点作为分隔符', tokenizeQuery('A100（单卡）'), ['a100', '单卡'])
  eq('数字与下划线属于同一 token', tokenizeQuery('gate_scale'), ['gate_scale'])
  eq('中文与英文相邻时按类别切开', tokenizeQuery('用LoRA微调'), ['用', 'lora', '微调'])
  eq('空查询', tokenizeQuery(''), [])
  eq('只有空白', tokenizeQuery('   '), [])
  eq('只有标点', tokenizeQuery('!?，。'), [])

  /* ---------------- 2. LIKE 通配符转义 ---------------- */
  console.log('')
  console.log('── 2. LIKE 通配符转义 ────────────────────────')
  check('下划线被转义（否则 _ 会匹配任意单字符）', escapeLikePattern('gate_scale') === 'gate\\_scale')
  check('百分号被转义（否则会匹配一切）', escapeLikePattern('100%') === '100\\%')
  check('反斜杠本身被转义', escapeLikePattern('a\\b') === 'a\\\\b')

  /* ---------------- 3. 建库 ---------------- */
  const dir = mkdtempSync(join(tmpdir(), 'pv-search-'))
  vault.ensureVaultStructure(dir)
  await db.openDatabase(dir)

  interface Fixture {
    id: string
    title: string
    tags?: string[]
    sections?: Record<string, string>
    /** 实验画像字段 */
    exp?: Record<string, unknown>
  }

  const fixtures: Fixture[] = [
    {
      id: 'body-only',
      title: 'Reranker for Retrieval Augmented Generation',
      sections: {
        一句话总结: '- 提出两阶段重排方法',
        // 这个词只出现在正文里，标题/标签/总结里都没有 —— 这是渲染层旧方案搜不到的场景
        实验方法论: longEnough('我们在单卡 A100 上训练两天，使用 LoRA 做参数高效微调。')
      }
    },
    {
      id: 'bench',
      title: 'Multi-hop Retrieval Benchmark',
      tags: ['benchmark'],
      sections: { 一句话总结: '- 提出一个多跳检索评测集' }
    },
    {
      id: 'wildcard-hit',
      title: 'Gate Scaling Study',
      sections: { 自由笔记: longEnough('我们把超参命名为 gate_scale，取值为 1.0。') }
    },
    {
      id: 'wildcard-miss',
      title: 'Gate Scaling Control',
      sections: { 自由笔记: longEnough('对比组使用 gateXscale 作为占位命名。') }
    },
    {
      id: 'exp-only',
      title: 'Quiet Paper',
      sections: { 一句话总结: '- 一篇标题和正文都很平淡的论文' },
      // 数据集名只出现在结构化实验画像里
      exp: { datasets: ['HotpotQA'], metrics: ['F1'] }
    }
  ]

  for (const f of fixtures) {
    const meta = vault.blankPaperMeta({ id: f.id, title: f.title, tags: f.tags ?? [] })
    if (f.exp) {
      meta.exp = {
        datasets: (f.exp.datasets as string[]) ?? [],
        baselines: [],
        metrics: (f.exp.metrics as string[]) ?? [],
        experiments: [],
        ablationCount: null,
        runs: '',
        reportsVariance: null,
        modelChoice: 'unclear',
        openModels: [],
        closedModels: [],
        compute: '',
        scale: '',
        // 这个脚本只关心「数据集名只出现在画像里」这条检索语义，其余字段填空即可。
        // 注意：画像加字段时这里要同步，否则会缺字段而编译失败（已经发生过一次）。
        dataUsage: 'unclear',
        dataUsageNote: '',
        humanEval: '',
        realWorld: null,
        note: ''
      }
    }
    db.upsertPaper({
      meta,
      sections: f.sections ?? {},
      relPath: `papers/${f.id}.md`
    })
  }

  const found = (query: string): string[] => db.searchPaperIds(query).sort()
  const hits = (query: string, ...ids: string[]): void => {
    const actual = found(query)
    const expected = [...ids].sort()
    check(
      `搜「${query}」→ ${expected.length ? expected.join('/') : '（无）'}`,
      JSON.stringify(actual) === JSON.stringify(expected),
      JSON.stringify(actual) === JSON.stringify(expected) ? '' : `实际 ${JSON.stringify(actual)}`
    )
  }

  /* ---------------- 4. 检索覆盖面 ---------------- */
  console.log('')
  console.log('── 3. 检索覆盖面 ────────────────────────────')
  hits('Multi-hop', 'bench')
  hits('多跳检索', 'bench')
  hits('检索', 'bench')

  // 关键：正文里的内容也要能搜到（旧方案只能扫标题/作者/总结/标签）
  hits('LoRA', 'body-only')
  hits('单卡 A100', 'body-only')
  hits('LoRA 微调', 'body-only')
  hits('参数高效微调', 'body-only')

  // 标签、标题这些原方案就支持的字段仍要工作
  hits('benchmark', 'bench')
  hits('Reranker', 'body-only')

  // 实验画像字段也在检索范围内
  hits('HotpotQA', 'exp-only')

  /* ---------------- 5. 检索语义 ---------------- */
  console.log('')
  console.log('── 4. 检索语义 ──────────────────────────────')
  hits('LoRA HotpotQA', ...[]) // 两个词分属不同论文 → AND 语义下应当无命中
  hits('LoRA CommonCrawl', ...[]) // 存在词 + 不存在词 → 无命中
  hits('不存在的词', ...[])
  hits('', ...[]) // 空查询返回空（「没有搜索词」由调用方区分处理）
  hits('   ', ...[])

  // 大小写不敏感
  check('大小写不敏感', JSON.stringify(found('lora')) === JSON.stringify(found('LoRA')))

  /* ---------------- 6. 通配符不会失控 ---------------- */
  console.log('')
  console.log('── 5. 通配符安全性 ──────────────────────────')
  hits('gate_scale', 'wildcard-hit') // 下划线必须按字面匹配
  check(
    '_ 没有被当成通配符（否则 gateXscale 也会命中）',
    !found('gate_scale').includes('wildcard-miss')
  )
  hits('gateXscale', 'wildcard-miss')
  check('查 % 不会匹配到所有论文（库里没有百分号）', found('%').length === 0)
  // 正文里真的含有下划线的是 wildcard-hit，所以只应命中它一篇；
  // 如果 _ 被当成通配符，wildcard-miss 的 gateXscale 也会被匹配上。
  eq('查 _ 只命中真正含下划线的论文', found('_'), ['wildcard-hit'])

  /* ---------------- 7. 内容变化后立即可搜 ---------------- */
  console.log('')
  console.log('── 6. 索引更新后立即可搜 ────────────────────')
  const meta = vault.blankPaperMeta({ id: 'bench', title: 'Multi-hop Retrieval Benchmark' })
  db.upsertPaper({
    meta,
    sections: { 一句话总结: '- 提出一个多跳检索评测集', 自由笔记: longEnough('补充了 RerankerFusion 的细节。') },
    relPath: 'papers/bench.md'
  })
  hits('RerankerFusion', 'bench')

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
