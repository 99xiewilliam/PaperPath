/**
 * 实验画像维度的端到端回归（不联网，所以能进 `verify`）。
 *
 * 验证的是**管道**：prompt 里确实带上了「论证链」的要求 → 模型返回 JSON →
 * 归一化 → 落到 `data.exp.experiments` → 完整度随之提高。
 *
 * 「真实模型会不会照做」测不了（那要花钱，而且同一篇论文两次跑的结果都不一样）。
 * 这里能挡住的是管道断掉那类问题 —— prompt 漏改、字段名对不上、parse 没把数据
 * 带出去。它们的共同症状是「实验清单」永远空着，而且**不报任何错**。
 */
import { createServer } from 'http'
import {
  buildDomainNorms,
  normalizeExperimentProfile,
  type ExperimentProfile
} from '@shared/experiment'
import { BUILTIN_CATEGORIES } from '@shared/taxonomy'
import { parseReadingSkill } from '@shared/reading-skill'
import { parsePaperBody, renderPaperBody } from '@shared/template'
import { deepreadLens } from '../src/main/lenses/deepread'
import { experimentLens } from '../src/main/lenses/experiment'
import { runLensPipeline } from '../src/main/lenses/run'
import { baseLensContext, type LensContext } from '../src/main/lenses/types'
import { prepareLlmSource } from '../src/main/papertext'

const out: string[] = []
let bad = 0
let total = 0
const check = (name: string, cond: boolean, extra = ''): void => {
  total++
  if (!cond) bad++
  out.push(`${cond ? '✅' : '❌'} ${name}${extra ? `  ← ${extra}` : ''}`)
}

/** 这个假模型这次会返回什么（每个用例自己设置） */
let reply: unknown = {}
/** 收到的请求消息，用来断言 prompt 里带了什么 */
const requests: { role: string; content: string }[][] = []

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    try {
      requests.push(
        (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages
      )
    } catch {
      // 不是 JSON 的请求不记
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 900, completion_tokens: 220 }
      })
    )
  })
})

/**
 * 一段像论文的原文。
 *
 * 实验章节里刻意写成「To verify X, we …」+ 数字的叙述形式 —— 这正是论证链
 * 应该被抽出来的地方，也是这次改动要模型去读的位置（而不是只盯表格数字）。
 */
const PAPER_TEXT = [
  'Abstract',
  'We propose a retrieval-augmented method for multi-hop QA.',
  '',
  'Experiments',
  'To verify the overall effectiveness, we compare against DPR and ColBERT on HotpotQA.',
  'Our method improves F1 by 3.2 points.',
  '',
  'To verify the necessity of the retrieval module, we remove it and observe an 8.1 F1 drop.',
  '',
  'We also conduct a case study on Chinese inputs to check generalization.',
  '',
  'Conclusion',
  'Our method is effective and generalizes across languages.'
].join('\n')

function makeCtx(): LensContext {
  return baseLensContext(
    prepareLlmSource(PAPER_TEXT, 60000),
    {
      title: '测试论文',
      authors: ['Someone'],
      year: 2026,
      venue: 'arXiv',
      url: '',
      arxivId: '',
      categories: []
    },
    BUILTIN_CATEGORIES,
    {}
  )
}

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const llm = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'stub-key',
    model: 'stub-model',
    temperature: 0,
    maxTokens: 512
  }
  const ctx = makeCtx()

  /* ① prompt 必须把「论证链」的要求写进去 —— 这是这次改动的核心 */
  const prompt = experimentLens.prompt(ctx)
  check('prompt 要求 experiments 字段', prompt.includes('"experiments"'))
  check('prompt 定义了「一行 = 一个实验主张」', prompt.includes('一行 = 一个实验主张'))
  check(
    'prompt 给出三类判据',
    prompt.includes('main') && prompt.includes('ablation') && prompt.includes('analysis')
  )
  check('prompt 明确要抽作者的结论', prompt.includes('作者由此声称什么'))
  check(
    'prompt 禁止把 claim / result 复述成结论',
    prompt.includes('不要把 claim 或 result 复述一遍')
  )
  check('prompt 指明材料在叙述文字里，不只在表格里', prompt.includes('叙述文字'))
  check('prompt 要求按章节顺序且最多 16 行', prompt.includes('最多 16 行'))
  check('prompt 要求 dataUsage 字段', prompt.includes('"dataUsage"'))
  check('prompt 说明了这一项的用途（全量与抽样不能直接比）', prompt.includes('不能直接比较'))
  check(
    'system 澄清「抽取作者主张」不等于写评论',
    experimentLens.system.includes('是论文作者的主张')
  )
  check(
    '料源把结论章节也投喂进去了（作者在那里重申主张）',
    prompt.includes('generalizes across languages')
  )

  /* ② 管道：模型返回论证链 → 落到画像里 */
  reply = {
    experiment: {
      datasets: ['HotpotQA'],
      baselines: ['DPR', 'ColBERT'],
      metrics: ['F1'],
      experiments: [
        {
          kind: 'main',
          claim: '整体更强',
          setup: 'HotpotQA，对比 DPR',
          result: 'F1 +3.2',
          conclusion: '方法有效'
        },
        {
          kind: 'ablation',
          claim: '检索模块必要',
          setup: '去掉检索模块',
          result: 'F1 −8.1',
          conclusion: '该组件不可省'
        },
        {
          kind: 'analysis',
          claim: '中文可迁移',
          setup: '中文 case study',
          result: '表现持平',
          conclusion: '跨语言可用'
        }
      ],
      ablationCount: 2,
      dataUsage: 'sampled',
      dataUsageNote: '从 12 万条里随机抽 2000 条'
    }
  }
  const run = await runLensPipeline(ctx, ['experiment'], llm)
  const exp = run.data.exp as ExperimentProfile | undefined
  check('管道跑通', run.ok === true)
  check(
    '实验清单落到画像里',
    (exp?.experiments.length ?? 0) === 3,
    `实际 ${exp?.experiments.length ?? 0}`
  )
  check('主实验 kind 正确', exp?.experiments[0].kind === 'main', exp?.experiments[0].kind)
  check('消融 kind 正确', exp?.experiments[1].kind === 'ablation', exp?.experiments[1].kind)
  check(
    '结论被带出来',
    exp?.experiments[0].conclusion === '方法有效',
    exp?.experiments[0].conclusion
  )
  check(
    '小结里报出条数',
    (run.outcomes[0]?.message ?? '').includes('实验清单 3 条'),
    run.outcomes[0]?.message ?? '(空)'
  )
  check(
    '顺带：这次调用也记了账',
    (run.outcomes[0]?.usage?.promptTokens ?? 0) > 0,
    String(run.outcomes[0]?.usage?.promptTokens)
  )

  /* ③ 老式返回（模型没给 experiments）既不能崩，也不能凭空造 */
  reply = { experiment: { datasets: ['HotpotQA'], metrics: ['F1'] } }
  const legacy = await runLensPipeline(ctx, ['experiment'], llm)
  const legacyExp = legacy.data.exp as ExperimentProfile | undefined
  check('没有 experiments 时不崩', Array.isArray(legacyExp?.experiments))
  check('没有就给空数组，不编内容', (legacyExp?.experiments.length ?? -1) === 0)

  check('评估数据方式落到画像里', exp?.dataUsage === 'sampled', exp?.dataUsage)
  check('抽样做法被带出来', exp?.dataUsageNote.includes('2000') === true, exp?.dataUsageNote)

  /* ④ 归一化那层已经单独测过（smoke:parse），这里只确认端到端不丢字段 */
  check('归一化后仍保留全部列', normalizeExperimentProfile(exp).experiments[1].result === 'F1 −8.1')

  /* ⑤ 领域聚合：同一批画像按分类拆开，各自算各自的惯例 */
  const prof = (metrics: string[], dataUsage: string): ExperimentProfile =>
    normalizeExperimentProfile({
      datasets: ['D'],
      metrics,
      ablationCount: 2,
      modelChoice: 'open',
      dataUsage
    })
  const norms = buildDomainNorms(
    [
      { id: 'a', title: 'A', categories: ['rag'], exp: prof(['F1', 'EM'], 'full') },
      { id: 'b', title: 'B', categories: ['rag'], exp: prof(['F1'], 'sampled') },
      { id: 'c', title: 'C', categories: ['vla'], exp: prof(['success rate'], 'full') },
      // vla 给两篇：少于两篇的方向会被 minPapers 规则跳过（solo 就是用来验这一条的）
      { id: 'e', title: 'E', categories: ['vla'], exp: prof(['success rate', 'IoU'], 'full') },
      { id: 'd', title: 'D', categories: ['solo'], exp: prof(['X'], 'full') }
    ],
    (id) => id
  )
  const rag = norms.find((n) => n.id === 'rag')
  check('按分类聚成两个方向（只有 1 篇的跳过）', norms.length === 2, `实际 ${norms.length}`)
  check(
    '同一方向内同一个指标被两篇提到时计数为 2',
    rag?.aggregate.topMetrics[0]?.count === 2,
    String(rag?.aggregate.topMetrics[0]?.count)
  )
  check(
    '不同方向的指标各算各的，不混在一起',
    norms.find((n) => n.id === 'vla')?.aggregate.topMetrics[0]?.name === 'success rate'
  )
  check(
    '评估数据方式被聚合出来',
    rag?.aggregate.dataUsage.full === 1 && rag?.aggregate.dataUsage.sampled === 1,
    `${rag?.aggregate.dataUsage.full ?? '-'}/${rag?.aggregate.dataUsage.sampled ?? '-'}`
  )
  check(
    '中文写法能归一化',
    normalizeExperimentProfile({ dataUsage: '抽样' }).dataUsage === 'sampled'
  )
  check(
    '认不出来时留 unclear，不猜成全量',
    normalizeExperimentProfile({ dataUsage: '???' }).dataUsage === 'unclear'
  )

  /* ⑥ 读论文风格 skill：口吻进哪些维度、导师精读拿到结构和示例、长文能完整落进笔记 */
  const skillCtx: LensContext = {
    ...ctx,
    skill: { voice: 'VOICE-MARK 先定位再展开', structure: 'STRUCT-MARK', example: 'EXAMPLE-MARK' }
  }
  const deepText =
    '开场定位。\n\n## 模型自作主张的二级标题\n\n### 一、遇到了什么问题？\n\n核心矛盾…'
  reply = { sections: { 导师精读: deepText, 局限与未来工作: '- **作者自陈**：原文未说明' } }
  requests.length = 0
  const skillRun = await runLensPipeline(skillCtx, ['deepread', 'limitations', 'experiment'], llm)
  const sent = (lensMark: string): { system: string; user: string } | undefined => {
    const msgs = requests.find((m) => m[1]?.content.includes(lensMark))
    return msgs ? { system: msgs[0].content, user: msgs[1].content } : undefined
  }
  const deepReq = sent('STRUCT-MARK')
  const limReq = sent('从审稿人视角审视')
  const expReq = sent('结构化的实验画像')
  check('导师精读拿到了导读结构和示例', !!deepReq && deepReq.user.includes('EXAMPLE-MARK'))
  check(
    '导师精读的口吻只出现一次（不在 system 里重复拼）',
    !!deepReq && deepReq.user.includes('VOICE-MARK') && !deepReq.system.includes('VOICE-MARK')
  )
  check('写文字的维度带上了用户口吻', !!limReq && limReq.system.includes('VOICE-MARK'))
  check('结构化抽取的维度不带口吻', !!expReq && !expReq.system.includes('VOICE-MARK'))
  check('导师精读落成了章节', skillRun.sections['导师精读'] === deepText)
  const body = renderPaperBody(skillRun.sections)
  const reparsed = parsePaperBody(body)
  check(
    '长文里模型自带的 ## 被降级，整篇仍在「导师精读」一节里',
    (reparsed['导师精读'] ?? '').includes('### 模型自作主张的二级标题') &&
      (reparsed['导师精读'] ?? '').includes('核心矛盾') &&
      !('模型自作主张的二级标题' in reparsed)
  )

  const defaults = parseReadingSkill(null)
  check(
    '默认 skill 三块都有内容',
    !!defaults.voice && defaults.structure.includes('留坑点') && !!defaults.example
  )
  const onlyVoice = parseReadingSkill('## 口吻\n只要这一条')
  check('删掉的块就是不要（不回退默认）', onlyVoice.voice === '只要这一条' && !onlyVoice.example)
  const fallbackPrompt = deepreadLens.prompt({ ...ctx, skill: onlyVoice })
  check(
    '「导读结构」被删光时退回默认结构，没有示例就不出现示例段',
    fallbackPrompt.includes('数据集与 Baseline') && !fallbackPrompt.includes('# 示例片段')
  )
}

void main()
  .then(() => {
    console.log(out.join('\n'))
    console.log(
      bad
        ? `\n❌ smoke:experiment ${total - bad}/${total} 通过`
        : `\n✅ smoke:experiment ${total}/${total} 通过`
    )
    server.close()
    process.exit(bad ? 1 : 0)
  })
  .catch((err: unknown) => {
    console.log(out.join('\n'))
    console.log(`\n❌ smoke:experiment 中断：${err instanceof Error ? err.message : String(err)}`)
    server.close()
    process.exit(1)
  })
