/**
 * 模型输出解析的回归测试。
 *
 * 这一组函数是「AI 返回的东西到底长什么样」的缓冲区，出问题会直接
 * 把垃圾写进用户笔记里，所以单独锁一遍。
 *
 * 起因是一个真实 bug：重写章节时复用了维度的 system prompt，而它带着
 * 「只输出一个合法 JSON 对象」的约束，模型于是把正文包成
 * {"content": "...\n..."} 返回，我们直接落盘 —— 笔记里出现一坨转义 JSON。
 *
 * 用法：npm run smoke:parse
 */
import matter from 'gray-matter'
import { chatCompletion, extractJson, LlmError } from '../src/main/llm'
import {
  buildRunRecord,
  lensNote,
  mergeRunRecord,
  summarizeOutcomes,
  type LensRunOutcome
} from '../src/main/lenses/run'
import { baseLensContext, evidenceSnippets, sectionRequirements, sourceBlock } from '../src/main/lenses/types'
import { methodDetailLens } from '../src/main/lenses/methodDetail'
import { normalizePaperText, prepareLlmSource } from '../src/main/papertext'
import { parseEnvFile } from '../src/main/settings'
import { buildMethodFlowUser, METHOD_FLOW_SYSTEM, pickFlowPayload } from '../src/main/agents/flow'
import {
  buildLinkJudgePrompt,
  LINKS_SYSTEM,
  normalizeVerdict,
  pickLinkDigest,
  verdictToLink
} from '../src/main/agents/links'
import { buildIdeaPrompt, IDEAS_SYSTEM, normalizeIdea } from '../src/main/agents/ideas'
import { buildComboPrompt, COMBO_SYSTEM, normalizeCombo } from '../src/main/agents/combo'
import { buildSlidesUser, SLIDES_SYSTEM } from '../src/main/agents/slides'
import type { LlmSettings } from '@shared/types'
import { emptyExperimentProfile, normalizeExperimentProfile } from '@shared/experiment'
import {
  figureMarkdown,
  imageMimeOf,
  insertMarkdownSnippet,
  isImagePath,
  normalizeFigureExtension,
  resolveVaultRelative,
  scanFigureReferences,
  vaultFigurePathOf
} from '@shared/figures'
import {
  countEffectiveChars,
  emptySections,
  isAiFilled,
  isSectionFilled,
  SECTION_GROUP_ORDER,
  SECTION_ORDER,
  sectionGroup
} from '@shared/template'
import {
  allLensIds,
  disabledLensesFromLegacy,
  enabledLensIds,
  lensForSection,
  lensMeta,
  LENS_META,
  type GraphEntity,
  type LensId,
  type PaperGraph
} from '@shared/lenses'
import { relatedPapersFrom, renderRelatedPapers } from '@shared/connections'
import { layoutMethodFlow, normalizeMethodFlow } from '@shared/flow'
import { LINK_TYPES, normalizeLinks, linkKey, type PaperLink, type PaperLinkType } from '@shared/links'
import { buildIdeaSeeds, renderIdeaDoc, type IdeaSeedPaper } from '@shared/ideas'
import {
  collectComboRelations,
  computeComboSignals,
  renderComboDoc,
  type ComboPaper
} from '@shared/combo'
import { ensureVisualSlides, normalizeSlideDeck, pruneSlideVisuals } from '@shared/slides'
import {
  AGENT_KINDS,
  assignLinesByKind,
  buildAiHighlights,
  classifyHeadings,
  clipLinesForBudget,
  extractHeadingTitles,
  mergeAiHighlights,
  mergeSpans,
  normalizeAutoHighlights,
  normalizeSpans,
  spansToPicks,
  type SourceLine
} from '@shared/autohighlight'
import { AI_HIGHLIGHT_COLOR, normalizeHighlights } from '@shared/highlights'
import { layoutMindMap, normalizeMindMap, type MindLayoutNode } from '@shared/mindmap'
import { gradeQuiz, normalizeQuiz } from '@shared/quiz'
import { getLens } from '../src/main/lenses'
import {
  AUTO_HIGHLIGHT_SYSTEM,
  buildAutoHighlightUser,
  kindSystem
} from '../src/main/agents/autohighlight'
import { buildPassageInstruction, buildPassageSystem } from '../src/main/agents/passage'
import { buildQuizUser, QUIZ_SYSTEM } from '../src/main/agents/quiz'
import { normalizeSectionRewrite } from '../src/main/agents/rewrite'

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

async function main(): Promise<void> {
  /* ---------------- 1. 正常内容不该被改动 ---------------- */
  console.log('── 1. 正常 Markdown 原样返回 ─────────────────')

  const plain = '- 痛点：先让读者接受前提\n- Gap：把失败归因到数据偏差\n\n**加粗标签**与 `代码`'
  eq('纯 Markdown 原样通过', normalizeSectionRewrite(plain), plain)
  eq('只有空白', normalizeSectionRewrite('   '), '')
  eq('空串', normalizeSectionRewrite(''), '')

  // 合法 JSON 型笔记内容：多个键、不像包装层，不该被拆
  const jsonish = '{"dataset": "HotpotQA", "metric": "EM"}'
  eq('多键 JSON 内容不被误拆', normalizeSectionRewrite(jsonish), jsonish)

  /* ---------------- 2. 复现并锁死那个 bug ---------------- */
  console.log('')
  console.log('── 2. 解包 JSON 包装层（真实 bug 复现） ───────')

  // 注意 '\\n' 在 TS 源码里是两个字符：反斜杠 + n，正是 JSON 里的转义换行
  const buggy =
    '{"content":"- 痛点（Motivation）：先让读者接受 VLM 已经够强\\n- Gap：先归因到训练数据的结构性偏差\\n- 核心洞察：把诊断和干预焊在同一份数据上"}'
  const fixed = normalizeSectionRewrite(buggy)

  check('不再残留字面 \\n（这就是屏幕上看到的东西）', !fixed.includes('\\n'))
  check('还原出了真正的换行', fixed.split('\n').length >= 3, `行数=${fixed.split('\n').length}`)
  check('去掉了 JSON 外壳', !fixed.includes('{"content"') && !fixed.startsWith('{'))
  check('正文内容完整保留', fixed.includes('核心洞察') && fixed.includes('结构性偏差'))
  eq(
    '期望结果',
    fixed,
    '- 痛点（Motivation）：先让读者接受 VLM 已经够强\n- Gap：先归因到训练数据的结构性偏差\n- 核心洞察：把诊断和干预焊在同一份数据上'
  )

  /* ---------------- 3. 其他包装形态 ---------------- */
  console.log('')
  console.log('── 3. 其他包装形态 ──────────────────────────')

  eq(
    '代码块包裹的 Markdown 被剥掉',
    normalizeSectionRewrite('```markdown\n- 一条笔记\n- 另一条\n```'),
    '- 一条笔记\n- 另一条'
  )
  eq(
    '代码块 + JSON 双重包装',
    normalizeSectionRewrite('```json\n{"content": "- 甲\\n- 乙"}\n```'),
    '- 甲\n- 乙'
  )
  eq(
    '键名是模型自取的（单键）',
    normalizeSectionRewrite('{"rewritten_section": "- 内容"}'),
    '- 内容'
  )
  eq(
    '正文被拆成字符串数组',
    normalizeSectionRewrite('["- 第一段", "- 第二段"]'),
    '- 第一段\n- 第二段'
  )
  eq(
    'markdown 字段名',
    normalizeSectionRewrite('{"markdown": "**粗体**"}'),
    '**粗体**'
  )
  // 不是合法 JSON 就按正文处理，不能丢内容
  eq(
    '花括号开头但不是 JSON',
    normalizeSectionRewrite('{这不是 JSON，只是用了花括号}'),
    '{这不是 JSON，只是用了花括号}'
  )
  eq(
    '内容为空对象时保留原文',
    normalizeSectionRewrite('{"unrelated": {"nested": 1}}'),
    '{"unrelated": {"nested": 1}}'
  )

  /* ---------------- 4. 幂等 ---------------- */
  console.log('')
  console.log('── 4. 幂等（重复处理不出错） ─────────────────')
  const once = normalizeSectionRewrite(buggy)
  eq('处理两次结果不变', normalizeSectionRewrite(once), once)

  /* ---------------- 5. extractJson 仍然可靠 ---------------- */
  console.log('')
  console.log('── 5. extractJson 兜底链 ─────────────────────')
  eq('裸 JSON', extractJson('{"a":1,"b":2}'), { a: 1, b: 2 })
  eq('代码块包裹', extractJson('```json\n{"a":1}\n```'), { a: 1 })
  eq('前后有解释文字', extractJson('好的，这是结果：\n{"a":1}\n希望有帮助'), { a: 1 })
  eq(
    '取顶层键最多的对象（避免误拿前导提示对象）',
    extractJson('{"type":"json_object"}\n{"title":"论文","sections":{},"tags":[]}'),
    { title: '论文', sections: {}, tags: [] }
  )

  /* ---------------- 6. 划词对话的 prompt 组装 ---------------- */
  console.log('')
  console.log('── 6. 划词对话的 prompt 组装 ─────────────────')

  const system = buildPassageSystem({
    paperTitle: 'CultureVLM: Characterizing Cultural Understanding',
    summary: '- 提出 CultureVerse 评测集',
    passage: 'We present CultureVerse, a massive scale benchmark.'
  })
  check('system 里带上了论文标题', system.includes('CultureVLM'))
  check('system 里带上了选中的原文', system.includes('We present CultureVerse'))
  check('system 里带上了论文一句话总结', system.includes('CultureVerse 评测集'))
  check('system 里要求不要复述原文', system.includes('不要复述'))
  // 多轮追问要靠这条，否则每轮都会重新翻译一遍
  check(
    'system 里说明追问时不要重复之前的回答',
    system.includes('不要重复已经给过的翻译或解读'),
    '这是多轮对话能正常工作的前提'
  )

  const noSummary = buildPassageSystem({ paperTitle: 'X', passage: 'Y' })
  check('没有一句话总结时不留空标签', !noSummary.includes('一句话总结'))

  const translate = buildPassageInstruction('translate')
  const explain = buildPassageInstruction('explain')
  check('翻译指令要求只输出译文', translate.includes('只输出译文'))
  check('解读指令要求点出论证作用', explain.includes('论证'))
  check('两条指令内容不同', translate !== explain)
  check(
    '翻译指令不包含解读的要求',
    !translate.includes('控制在 4 行以内'),
    '两种模式不能串味'
  )

  /* ---------------- 7. 全文关键词回捞 ---------------- */
  console.log('')
  console.log('── 7. 关键词回捞（针在干草堆里） ─────────────')

  /*
   * 复刻真实场景：一篇 100KB+ 的论文，算力细节写在**附录中段**，
   * 而 sourceBlock 的 tail 只能覆盖全文最后一段 —— 那段信息根本没被送给模型，
   * 于是模型只能写「算力硬件原文未说明」。
   */
  const filler = 'This subsection describes additional implementation details. '.repeat(10)
  const paragraph = (i: number): string => `Paragraph ${i}. ${filler}`
  // 高频干扰：'GPU' 在很多地方出现，如果它先吃掉预算，真正有用的那行就进不来
  const gpuNoise = Array.from(
    { length: 40 },
    (_, i) => `Environment note ${i}: processes are pinned to separate GPUs and Conda envs.`
  ).join('\n')
  // 刻意让噪声区与算力段落之间隔开五十行，这样捞出来的是两段不相邻的片段
  const head = Array.from({ length: 100 }, (_, i) => paragraph(i)).join('\n')
  const middle = Array.from({ length: 50 }, (_, i) => paragraph(100 + i)).join('\n')
  const computePara = [
    'Compute. A single trial of VoLoAgent (Full) consumes roughly one L40 GPU for the simulator',
    'and one H100 for the VLA. The 126-task sweep takes ~18 GPU-hours per system.'
  ].join('\n')
  const tailPart = 'H.2 Finding 2: vision tools do not transfer to non-photoreal sims. '.repeat(400)
  const fullText = `${head}\n${gpuNoise}\n${middle}\n${computePara}\n${tailPart}`

  check(
    '合成文本足够长（复刻 100KB+ 的真实情况）',
    fullText.length > 100000,
    `${fullText.length} 字符`
  )
  check('算力段落在 tail 窗口之外（这就是当初漏抽的根因）', !fullText.slice(-12000).includes('Compute.'))

  const found = evidenceSnippets(fullText, ['GPU-hour', 'H100', 'GPU'])
  check('关键词回捞能捞到 tail 够不到的算力段落', found.includes('one H100 for the VLA'))
  check('顺带捞到了 GPU-hour 这类具体写法', found.includes('GPU-hours'))
  check('片段不连续处用「…」标出', found.includes('…'))
  check('没有关键词时返回空', evidenceSnippets(fullText, []) === '')
  check('空文本返回空', evidenceSnippets('', ['GPU']) === '')

  const capped = evidenceSnippets(fullText, ['GPU'], 200)
  check(
    '预算偏小时也要捞到东西（不能返回空）',
    capped.length > 0,
    `${capped.length} 字符`
  )
  check('预算被遵守（不会把全文的高频词都捞进来）', capped.length <= 500, `${capped.length} 字符`)

  // 优先级：具体关键词必须排在前面，否则高频词会先吃光预算
  const prioritized = evidenceSnippets(fullText, ['H100', 'GPU'], 300)
  check(
    '具体关键词优先于高频词',
    prioritized.includes('H100'),
    '顺序即优先级：H100 排在 GPU 之前才捞得到'
  )
  const misordered = evidenceSnippets(fullText, ['GPU'], 300)
  check(
    '反证：只给高频词时会先被干扰项占满',
    !misordered.includes('H100'),
    '这是把具体写法排在前面的理由'
  )

  /* ---------------- 8. 接进 sourceBlock 后仍然成立 ---------------- */
  console.log('')
  console.log('── 8. sourceBlock 集成 ───────────────────────')

  const block = sourceBlock(
    {
      paper: {
        title: 'T',
        authors: [],
        year: null,
        venue: '',
        url: '',
        arxivId: '',
        categories: []
      },
      categoryCatalog: [],
      sections: {},
      fullText,
      sourceSections: { Abstract: 'A short abstract.' }
    },
    ['Abstract'],
    { tail: 12000, evidence: ['GPU-hour', 'H100', 'GPU'] }
  )
  check('组装结果里出现了算力段落', block.includes('one H100 for the VLA'))
  check('tail 片段仍在（没有因为新增回捞而丢掉）', block.includes('H.2 Finding 2'))
  check('指定章节仍在', block.includes('A short abstract'))
  check('回捞片段有明确的小标题', block.includes('全文关键词命中'))

  /* ---------------- 9. 维度开关：白名单 → 黑名单迁移 ---------------- */
  console.log('')
  console.log('── 9. 维度开关迁移 ─────────────────────────')

  const LEGACY_DEFAULT = ['overview', 'writing', 'english', 'visuals', 'experiment', 'graph']

  check(
    '各维度 id 唯一（迁移基准不会错位）',
    new Set(allLensIds()).size === allLensIds().length,
    allLensIds().join(', ')
  )
  check(
    '拆分后确实多了 method / limitations',
    allLensIds().includes('method') && allLensIds().includes('limitations')
  )

  // 全新安装：没有任何偏好记录 = 全部启用
  check('全新安装时全部维度启用', disabledLensesFromLegacy({}).length === 0)
  check(
    '全新安装时 method / limitations 也在启用列表里',
    enabledLensIds(disabledLensesFromLegacy({})).includes('method') &&
      enabledLensIds(disabledLensesFromLegacy({})).includes('limitations')
  )

  /*
   * 关键断言：老用户的白名单里没有 method / limitations，因为它们当时还不存在。
   * 迁移必须把这理解成「新增」而不是「用户关掉了」——
   * 否则升级后这两节笔记会永远空着，而且不报错。
   */
  const migratedDefault = disabledLensesFromLegacy({ enabledLenses: LEGACY_DEFAULT })
  check(
    '老默认配置迁移后没有多出关闭项',
    migratedDefault.length === 0,
    migratedDefault.join(', ') || '（空）'
  )
  const afterDefault = enabledLensIds(migratedDefault)
  check('老用户升级后自动跑上 method', afterDefault.includes('method'))
  check('老用户升级后自动跑上 limitations', afterDefault.includes('limitations'))

  // 用户主动关掉的必须继续保持关闭，不能被迁移「修好」
  const migratedOptOut = disabledLensesFromLegacy({
    enabledLenses: LEGACY_DEFAULT.filter((id) => id !== 'visuals')
  })
  check('用户主动关掉的维度仍然关着', migratedOptOut.includes('visuals'), migratedOptOut.join(', '))
  check(
    '主动关掉一个不会牵连其他维度',
    !enabledLensIds(migratedOptOut).includes('visuals') &&
      enabledLensIds(migratedOptOut).includes('method'),
    `关闭 ${migratedOptOut.length} 个`
  )

  // 极端：老用户把当时能关的都关了
  const migratedAllOff = disabledLensesFromLegacy({ enabledLenses: [] })
  check('老配置全关时，迁移后老维度仍全关', migratedAllOff.length === LEGACY_DEFAULT.length)
  /*
   * 「拆分后新增的维度都该按默认值启用」—— 用「老清单之外的 id」推出来断言，
   * 而不是写死字符串：以后再加维度不用改这条测试，但「新维度有没有真的生效」
   * 始终被守着。
   */
  const newSinceLegacy = allLensIds().filter((id) => !LEGACY_DEFAULT.includes(id))
  check(
    '但新增的维度依然按默认值启用',
    enabledLensIds(migratedAllOff).join(',') === newSinceLegacy.join(','),
    enabledLensIds(migratedAllOff).join(', ')
  )

  // 已是新格式：直接采信，不再回头看老字段
  check(
    '新格式优先于老字段',
    disabledLensesFromLegacy({ disabledLenses: ['graph'], enabledLenses: LEGACY_DEFAULT }).join(
      ','
    ) === 'graph'
  )

  // 用户关掉全部维度 → 精读会报错，这是受支持的状态
  check('可以关掉全部维度', enabledLensIds(allLensIds()).length === 0)

  /* ---------------- 10. 超预算论文：附录仍要能捞到 ---------------- */
  console.log('')
  console.log('── 10. 超预算论文（附录落在 60K 之外） ───────')

  /*
   * 复刻真实场景：论文 ~110K 字符，prepareLlmSource 预算 60K，
   * 算力细节写在 ~93K 处的附录里。
   *
   * 修复前的两个毛病：
   *   - tail 取的是「截断后文本的末尾」= 正文中段，而不是它自称的「正文后段」；
   *   - 关键词回捞扫的也是被截断的文本。
   * 两边都够不到那段附录，模型只能写「原文未说明」。
   */
  const chunk = 'This subsection describes additional implementation details. '.repeat(10)
  const body = Array.from({ length: 160 }, (_, i) => `Paragraph ${i}. ${chunk}`).join('\n')
  const appendix = [
    'E. Compute and Implementation Details',
    'Compute. A single trial consumes roughly one L40 GPU for the simulator and one H100 for the VLA.',
    'The 126-task sweep takes ~18 GPU-hours per system.'
  ].join('\n')
  const hugePaper = `${body}\n${appendix}\n${'A. Appendix filler. '.repeat(800)}`

  const prepared = prepareLlmSource(hugePaper, 60000)
  const normalized = normalizePaperText(hugePaper)
  check('原文确实超过预算', normalized.length > 60000, `${normalized.length} 字符`)
  check('fullText 按预算截断', prepared.fullText.length <= 60000, `${prepared.fullText.length} 字符`)
  check(
    'rawText 是规范化后的完整全文（不截断）',
    prepared.rawText.length === normalized.length && prepared.rawText.length > prepared.fullText.length,
    `${prepared.rawText.length} vs ${prepared.fullText.length}`
  )
  check(
    '算力细节落在 fullText 之外（这就是当初抽不到的根因）',
    !prepared.fullText.includes('one H100 for the VLA')
  )

  const bigBlock = sourceBlock(
    {
      paper: {
        title: 'T',
        authors: [],
        year: null,
        venue: '',
        url: '',
        arxivId: '',
        categories: []
      },
      categoryCatalog: [],
      sections: {},
      fullText: prepared.fullText,
      rawText: prepared.rawText,
      sourceSections: {}
    },
    ['Abstract'],
    { tail: 12000, evidence: ['GPU-hour', 'H100', 'GPU'] }
  )
  check('关键词回捞能捞到 60K 之外的算力细节', bigBlock.includes('one H100 for the VLA'))
  check('正文后段取自真实文末（旧行为取的是截断处）', bigBlock.includes('Appendix filler'))
  check(
    '没有 rawText 时退回 fullText（向后兼容）',
    !sourceBlock(
      {
        paper: {
          title: 'T',
          authors: [],
          year: null,
          venue: '',
          url: '',
          arxivId: '',
          categories: []
        },
        categoryCatalog: [],
        sections: {},
        fullText: prepared.fullText,
        sourceSections: {}
      },
      ['Abstract'],
      { evidence: ['H100'] }
    ).includes('one H100 for the VLA')
  )

  /* ---------------- 11. 抽取时间戳不能被伪造 ---------------- */
  console.log('')
  console.log('── 11. 抽取时间戳的真实性 ─────────────────')

  const skeleton = emptyExperimentProfile()
  check(
    '落盘的空骨架不会被盖上抽取时间',
    normalizeExperimentProfile(skeleton).extractedAt === undefined,
    '详情页误显示「最近抽取」的根源'
  )
  check('null 输入不产生时间戳', normalizeExperimentProfile(null).extractedAt === undefined)
  check(
    '历史数据里的假时间戳会被清掉（读一次即自愈）',
    normalizeExperimentProfile({ ...skeleton, extractedAt: '2026-09-12T05:34:02.097Z' }).extractedAt ===
      undefined
  )

  const withData = normalizeExperimentProfile({ datasets: ['RoboVoLo'] })
  check(
    '真有内容时才盖时间戳',
    typeof withData.extractedAt === 'string' && withData.extractedAt.length > 0
  )
  check(
    '读盘幂等：已有的时间戳不会被刷新',
    normalizeExperimentProfile({ datasets: ['A'], extractedAt: '2026-01-01T00:00:00.000Z' })
      .extractedAt === '2026-01-01T00:00:00.000Z'
  )
  check(
    '失败原因会被保留',
    normalizeExperimentProfile({ error: '接口返回 429' }).error === '接口返回 429'
  )
  check(
    '光有失败原因不算「抽过」（否则又变成假时间戳）',
    normalizeExperimentProfile({ error: '接口返回 429' }).extractedAt === undefined
  )

  /* ---------------- 12. 限流 / 网关抖动自动重试 ---------------- */
  console.log('')
  console.log('── 12. 瞬时故障退避重试 ───────────────────')

  const realFetch = globalThis.fetch

  /** 前 failTimes 次返回 status，之后返回一个合法响应；返回「被调用了几次」 */
  const stubFetch = (
    status: number,
    failTimes: number,
    finishReason = 'stop'
  ): (() => number) => {
    let calls = 0
    const reply = (s: number, body: unknown): Response =>
      ({
        ok: s >= 200 && s < 300,
        status: s,
        text: async () => JSON.stringify(body)
      }) as unknown as Response
    globalThis.fetch = (async () => {
      calls++
      return calls <= failTimes
        ? reply(status, { error: { message: 'gateway hiccup' } })
        : reply(200, {
            choices: [{ message: { content: '{"ok":1}' }, finish_reason: finishReason }]
          })
    }) as typeof fetch
    return () => calls
  }

  const probe = {
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'k',
    model: 'm',
    temperature: 0,
    maxTokens: 16
  }
  const ask = (): Promise<{ content: string; truncated?: boolean }> =>
    chatCompletion([{ role: 'user', content: 'hi' }], probe, {
      signal: new AbortController().signal
    })

  try {
    const count429 = stubFetch(429, 1)
    const res = await ask()
    check(
      '撞上限流会退避重试，而不是当场失败',
      res.content === '{"ok":1}' && count429() === 2,
      `${count429()} 次请求`
    )

    const count503 = stubFetch(503, 1)
    await ask()
    check('网关 5xx 同样重试', count503() === 2, `${count503()} 次请求`)

    // 认证错误重试多少次都没用，白等退避时间
    const count401 = stubFetch(401, 99)
    let threw = false
    try {
      await ask()
    } catch {
      threw = true
    }
    check('401 不重试（重试也解决不了认证问题）', threw && count401() === 1, `${count401()} 次请求`)

    // finish_reason=length：JSON 会被抢救成「最后一个完整值」，但内容一定不全
    stubFetch(200, 0, 'length')
    check('撞到 max_tokens 时透出 truncated 标记', (await ask()).truncated === true)
    stubFetch(200, 0)
    check('正常结束时不带这个标记', (await ask()).truncated === false)
  } finally {
    globalThis.fetch = realFetch
  }

  /* ---------------- 13. 指定章节不被「全篇均分」截断 ---------------- */
  console.log('')
  console.log('── 13. 指定章节的额度分配 ─────────────────')

  /*
   * 复刻真实场景：一篇 9 节的论文，Experiments 长 ~11.7K 字符，
   * 而 prepareLlmSource 的「全篇均分」配额只有 max(4000, 60000/9) = 6666 ——
   * 实测那 6666 正好落在 §5.3 之后，§5.4 消融 / §5.5 真机验证整节丢失，
   * 于是 realWorld / ablationCount 被填成「未说明」，而论文里明明写着。
   */
  const fakeSection = (name: string, line: string, count: number): string =>
    `## ${name}\n${Array.from({ length: count }, (_, i) => `${line} ${i}`).join('\n')}\n`
  /*
   * 长度刻意卡在「旧配额 ~8.5K」和「新单节额度 12K」之间 ——
   * 这样既能证明旧逻辑会切断它，又能证明新逻辑能完整送达。
   * 太长（>12K）会撞上新额度的上限，反而证明不了这个修复。
   */
  const longExperiments = `${Array.from(
    { length: 190 },
    (_, i) => `- experiment detail ${i}: one sentence about the setup.`
  ).join('\n')}\nENDSECTION-MARK`
  const fakePaper = [
    fakeSection('Abstract', 'abstract line', 8),
    fakeSection('Introduction', 'intro line', 60),
    fakeSection('Related Work', 'related line', 60),
    `## Experiments\n${longExperiments}\n`,
    fakeSection('Analysis', 'analysis line', 60),
    fakeSection('Method', 'method line', 60),
    fakeSection('Conclusion', 'conclusion line', 60),
    fakeSection('Discussion', 'discussion line', 60),
    fakeSection('Limitations', 'limitation line', 60)
  ].join('\n')

  const fakeSource = prepareLlmSource(fakePaper, 60000)
  const fakeCtx = baseLensContext(
    fakeSource,
    { title: 'T', authors: [], year: null, venue: '', url: '', arxivId: '', categories: [] },
    [],
    {}
  )
  const uniformQuota = Math.max(
    4000,
    Math.floor(60000 / Object.keys(fakeSource.sourceSections ?? {}).length)
  )
  const cappedExperiments = fakeSource.sourceSections?.['Experiments'] ?? ''
  check(
    '上游按「全篇均分」截断了长章节（§5.4 / §5.5 就是这么消失的）',
    cappedExperiments.includes('已截断') && !cappedExperiments.includes('ENDSECTION-MARK'),
    `配额 ${uniformQuota} / 实际 ${longExperiments.length}`
  )
  check(
    '修好后：维度点名的章节能完整送达',
    sourceBlock(fakeCtx, ['Experiments', 'Abstract']).includes('ENDSECTION-MARK')
  )
  check(
    '总量仍受控（不是把全文塞进去）',
    sourceBlock(fakeCtx, ['Experiments', 'Abstract']).length < 60000,
    `${sourceBlock(fakeCtx, ['Experiments', 'Abstract']).length} 字符`
  )
  check(
    '真的超长时仍会截断，并留下记号',
    sourceBlock(fakeCtx, ['Experiments'], { sectionBudget: 1000 }).includes('已截断')
  )
  check(
    '一个都没命中时退回全部章节（旧兜底行为不变）',
    sourceBlock(fakeCtx, ['Nonexistent']).includes('### 原文片段：Introduction')
  )
  check(
    '兜底路径不会被改成「未截断全文」（否则提示词会突然膨胀）',
    !sourceBlock(fakeCtx, ['Nonexistent']).includes('ENDSECTION-MARK')
  )

  /* ---------------- 14. 骨架模板不算「已精读」 ---------------- */
  console.log('')
  console.log('── 14. 空笔记不能被当成已精读 ─────────────')

  /*
   * 真实场景：一篇刚导入、精读一次都没跑完的论文，每个章节都还是骨架模板，
   * 但骨架本身有一两百字 → 旧的「长度 > 40」判据把它算成「已精读」，
   * 于是列表上打着「已精读」、点进去全是空标签 —— 失败看起来像成功。
   */
  const blank = emptySections()
  check('刚导入的笔记不算「已精读」', !isAiFilled(blank))
  check(
    '刚导入的笔记有效字数为 0',
    countEffectiveChars(blank) === 0,
    `char_count=${countEffectiveChars(blank)}`
  )
  check(
    '骨架里没有任何一节算「写了」',
    Object.keys(blank).every((k) => !isSectionFilled(k, blank[k]))
  )

  // 反证：真写了内容必须认出来，否则统计会漏
  const written = {
    ...blank,
    '核心问题与动机': '- **要解决什么问题**：开放词汇长时序操作，需要边跑边决策。'
  }
  check('往骨架里填了内容就算写了', isSectionFilled('核心问题与动机', written['核心问题与动机']))
  check('有效字数跟着涨', countEffectiveChars(written) > 0, `${countEffectiveChars(written)} 字符`)

  const twoWriting = {
    ...blank,
    '写作手法 · Abstract': '- **结构拆解**（背景 → 现有做法 → 不足 → 本文做法 → 结果 → 影响）：先立场景再收窄。',
    '写作手法 · Introduction': '- **段落推进逻辑**（每段做什么）：痛点 → Gap → 贡献。'
  }
  check('写满 2 节「写作手法」才算已精读', isAiFilled(twoWriting))
  check(
    '只写 1 节还不算',
    !isAiFilled({ ...blank, '写作手法 · Abstract': twoWriting['写作手法 · Abstract'] })
  )

  /* ---------------- 15. 精读运行记录 ---------------- */
  console.log('')
  console.log('── 15. 精读运行记录（四种结局要分得开）───')

  const outcome = (id: LensId, ok: boolean, message: string): LensRunOutcome => ({
    lensId: id,
    label: id,
    ok,
    message,
    sectionCount: ok ? 1 : 0
  })

  const allOk = buildRunRecord(
    [outcome('overview', true, '一句话总结 ✓'), outcome('experiment', true, '实验画像完整度 14 项')],
    2
  )
  check('全成功 → ok', allOk.status === 'ok', allOk.message)
  check('记录里带结束时间', !Number.isNaN(Date.parse(allOk.finishedAt)))

  const partial = buildRunRecord(
    [
      outcome('overview', true, '一句话总结 ✓'),
      outcome('experiment', false, '实验画像抽取：模型没有返回可用内容')
    ],
    2
  )
  check('部分失败 → partial', partial.status === 'partial')
  check(
    '失败的维度带原因（详情页展开就能看）',
    partial.lenses.find((l) => l.id === 'experiment')?.message.includes('没有返回可用内容') === true
  )

  // 以前这种情况什么都不写，最难排查
  const neverRan = buildRunRecord([], 8, new LlmError('这篇论文没有抽取到原文，无法做 AI 分析。'))
  check('压根没跑起来 → failed', neverRan.status === 'failed')
  check('没跑起来时也留下原因', neverRan.message.includes('没有抽取到原文'))
  check('没跑起来不会被误判成「全部成功」', neverRan.status !== 'ok' && neverRan.lenses.length === 0)

  const cancelled = buildRunRecord(
    [outcome('overview', true, '一句话总结 ✓')],
    8,
    new LlmError('任务已取消。', undefined, true)
  )
  check('用户取消 → cancelled', cancelled.status === 'cancelled')
  check('取消时写明只跑了几个维度', cancelled.message.includes('1/8'), cancelled.message)

  // 产出不全 / 被截断：以前这些都藏在一个干净的 ✓ 后面
  check('产出不全时写明「只产出 1/6 节」', lensNote(1, 6, false) === '只产出 1/6 节', lensNote(1, 6, false))
  check('被截断时写明截断', lensNote(6, 6, true) === '输出被 max_tokens 截断')
  check(
    '两种都中时都要写出来',
    lensNote(1, 6, true).includes('1/6') && lensNote(1, 6, true).includes('截断')
  )
  check('一切正常时不给噪音', lensNote(6, 6, false) === '')
  check('不写章节的维度（experiment / graph）不报「产出不全」', lensNote(0, 0, false) === '')

  const midway = buildRunRecord([outcome('overview', false, '速览与故事线：任务已取消。')], 8)
  check(
    '中途取消（循环被打断、没抛错）也认得出',
    midway.status === 'cancelled',
    midway.message
  )

  /* ---------------- 16. 画像不能被 undefined 值炸掉 js-yaml ---------------- */
  console.log('')
  console.log('── 16. 画像序列化（writePaperFile 必经之路）───')

  /*
   * 真实 bug：normalizeExperimentProfile 返回的对象带着 `error: undefined`
   * 这个**值为 undefined 的键**，而画像会被 writePaperFile 用 js-yaml 写进
   * frontmatter —— js-yaml 遇到 undefined 值直接抛
   * 「unacceptable kind of an object to dump [object Undefined]」。
   * 于是抽取明明成功了，却整篇死在落盘上，笔记一个字段都没写出去。
   * 「没有这个值」必须表现为「没有这个键」。
   */
  const variants = [
    normalizeExperimentProfile(null),
    normalizeExperimentProfile({}),
    normalizeExperimentProfile({ datasets: ['A'] }),
    normalizeExperimentProfile({ error: '接口 429' }),
    normalizeExperimentProfile({ datasets: ['A'], extractedAt: '2026-01-01T00:00:00.000Z' })
  ]
  check(
    '任何输入下都不产生值为 undefined 的键',
    variants.every((p) => Object.values(p).every((v) => v !== undefined))
  )
  check('error 有值时是字符串', normalizeExperimentProfile({ error: '接口 429' }).error === '接口 429')
  check('error 没值时**键都不存在**', !('error' in normalizeExperimentProfile({ datasets: ['A'] })))
  check(
    '没内容时不产生 extractedAt 键',
    !('extractedAt' in normalizeExperimentProfile(null)) &&
      !('extractedAt' in normalizeExperimentProfile({}))
  )

  // 复刻当时的崩溃现场：把画像交给 js-yaml（writePaperFile 里 matter.stringify 的同一步）
  const fullProfile = normalizeExperimentProfile({
    datasets: ['RoboVoLo', 'RoboLab'],
    modelChoice: 'both',
    closedModels: ['Claude Opus 4.6'],
    compute: '1 L40 + 1 H100',
    ablationCount: 4,
    realWorld: true
  })
  let yamlOk = false
  try {
    matter.stringify('正文', { exp: fullProfile })
    yamlOk = true
  } catch {
    /* js-yaml 抛了 */
  }
  check('带内容的画像能过 js-yaml 序列化（这就是当时崩掉的那一步）', yamlOk)

  /* ---------------- 17. 写作维度拆分（6 节 → 3+3） ---------------- */
  console.log('')
  console.log('── 17. 写作维度拆分 ──────────────────────')

  /*
   * 起因：writing 一次要写 6 节，输出撞上 max_tokens 被截断，而截断抢救
   * 只保住最后一个完整值 —— 记录里是 ✓、实际只落了第一节，其余还是骨架。
   * 拆成两个维度，让每次的输出量减半。
   */
  const writingLenses = LENS_META.filter((l) => l.id === 'writing' || l.id === 'writingMethod')
  check('确实拆成了两个写作维度', writingLenses.length === 2)

  const owned = writingLenses.flatMap((l) => l.sections)
  check('两个维度负责的章节互不重叠', new Set(owned).size === owned.length, owned.join('、'))

  const beforeSplit = [
    '写作手法 · Abstract',
    '写作手法 · Introduction',
    '写作手法 · Related Work',
    '写作手法 · Methodology',
    '写作手法 · Experiments',
    '原文摘录'
  ]
  check(
    '并集正好是拆分前的 6 节（没有章节被弄丢）',
    owned.length === beforeSplit.length && beforeSplit.every((k) => owned.includes(k))
  )
  check(
    '每一节都能找到归属维度（详情页「AI 重写这一节」按归属挑 system prompt）',
    beforeSplit.every((k) => lensForSection(k) != null)
  )
  check(
    '新维度默认启用（老用户不用改配置，靠 opt-out 自动生效）',
    enabledLensIds([]).includes('writingMethod') &&
      enabledLensIds(disabledLensesFromLegacy({ enabledLenses: LEGACY_DEFAULT })).includes(
        'writingMethod'
      )
  )
  check(
    '两边各自都 ≤3 节（输出量减半才是这次拆分的目的）',
    writingLenses.every((l) => l.sections.length <= 3),
    writingLenses.map((l) => `${l.id}:${l.sections.length} 节`).join('　')
  )

  /* ---------------- 18. 重试只补失败的那几个 ---------------- */
  console.log('')
  console.log('── 18. 重试只补失败的那几个 ───────────────')

  /*
   * 起因：状态条上的「重新精读」把启用中的 9 个维度全跑了一遍。
   * 可它出现的前提就是「部分失败」—— 于是 8 个已经成功的维度被重新生成
   *（温度 0.3，输出必然不同），手改过的章节跟着被覆盖。
   * 现在默认只补失败的那几个，并把结局并回上一次的完整记录。
   */
  const nineLenses: LensId[] = [
    'overview',
    'writing',
    'writingMethod',
    'english',
    'visuals',
    'experiment',
    'method',
    'limitations',
    'graph'
  ]
  const fullRun = buildRunRecord(
    nineLenses.map((id) =>
      outcome(
        id,
        id !== 'experiment',
        id === 'experiment' ? '实验画像抽取：无法解析模型返回的 JSON' : '完成'
      )
    ),
    9
  )
  check(
    '上一次是「部分失败」，只失败 1 个',
    fullRun.status === 'partial' && fullRun.lenses.filter((l) => !l.ok).length === 1
  )

  const retried = mergeRunRecord(fullRun, [outcome('experiment', true, '完成')])
  check(
    '并回后仍是 9 个维度（不是只剩重试的那 1 个）',
    retried.lenses.length === 9,
    `${retried.lenses.length} 个`
  )
  check('补上最后一个 → 状态转成「全部成功」', retried.status === 'ok', retried.message)
  check(
    '文案点明这是重试，不会被读成一次完整精读',
    retried.message.includes('只重试了 1 个维度'),
    retried.message
  )
  check('没被重试的维度保留原结局', retried.lenses.find((l) => l.id === 'overview')?.ok === true)

  const retriedAgain = mergeRunRecord(fullRun, [
    outcome('experiment', false, '实验画像抽取：接口返回 429')
  ])
  check('重试再失败 → 仍是 partial', retriedAgain.status === 'partial')
  check(
    '新原因覆盖旧原因',
    retriedAgain.lenses.find((l) => l.id === 'experiment')?.message.includes('429') === true
  )

  // 首次运行 / 上一次压根没跑起来 → 没有东西可并，退化成普通记录
  const noPrevious = mergeRunRecord(null, [outcome('overview', true, '完成')])
  check('没有上一次记录可并时退化成普通记录', noPrevious.lenses.length === 1 && noPrevious.status === 'ok')

  // 整篇精读必须整条替换，否则上次跑过、之后被关掉的维度会一直挂在状态条上
  check(
    '全量运行不并（buildRunRecord 只记本次维度）',
    buildRunRecord([outcome('overview', true, '完成')], 9).lenses.length === 1
  )

  /*
   * 产出不全的警告不能被 ✓ 吞掉。
   * 它以前是拼在 message 里的，而 summarizeOutcomes 只取 `label ✓` ——
   * 于是「写作手法 ✓」看起来像这节写好了，实际上只落了 1/3 节。
   */
  const notedOutcome: LensRunOutcome = {
    lensId: 'writing',
    label: '写作手法 · 开篇',
    ok: true,
    message: '完成',
    note: '只产出 1/3 节',
    sectionCount: 1
  }
  check(
    '小结要带上「只产出 1/3 节」',
    summarizeOutcomes([notedOutcome]).includes('只产出 1/3 节'),
    summarizeOutcomes([notedOutcome])
  )
  const notedRecord = buildRunRecord([notedOutcome], 1)
  check('警告能落进运行记录（状态条展开可看）', notedRecord.lenses[0].note === '只产出 1/3 节')
  check('带警告的维度仍算成功，不算失败', notedRecord.status === 'ok')
  check(
    '重试记录也会带上警告',
    mergeRunRecord(fullRun, [notedOutcome]).lenses.find((l) => l.id === 'writing')?.note ===
      '只产出 1/3 节'
  )

  /* ---------------- 19. 服务商特有参数（thinking 之类） ---------------- */
  console.log('')
  console.log('── 19. 额外请求参数（PAPERVAULT_LLM_EXTRA_BODY）───')

  /*
   * 起因：智谱官方文档里 glm-5.3 的示例带着 `{"thinking":{"type":"enabled"}}` ——
   * 不在 OpenAI 兼容协议里的开关。为了多传这一个字段就去改代码、重新构建不划算，
   * 所以做成 .env 里的通用额外参数。
   */
  const prevFetch = globalThis.fetch
  let sent: Record<string, unknown> | null = null
  globalThis.fetch = (async (_url: string, init: { body?: string }) => {
    sent = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":1}' } }] })
    } as unknown as Response
  }) as typeof fetch

  const extraProbe: LlmSettings = {
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'k',
    model: 'glm-5.3',
    temperature: 0.3,
    maxTokens: 65536
  }
  const askIt = (settings: LlmSettings): Promise<{ content: string }> =>
    chatCompletion([{ role: 'user', content: 'hi' }], settings, {
      signal: new AbortController().signal
    })

  try {
    await askIt(extraProbe)
    check('没配额外参数时，请求体里不会混进无关字段', sent !== null && !('thinking' in sent))

    sent = null
    await askIt({ ...extraProbe, extraBody: { thinking: { type: 'enabled' } } })
    const body = sent as unknown as Record<string, unknown> | null
    check(
      '额外参数原样并进请求体（智谱就这么开思考）',
      JSON.stringify(body?.thinking) === '{"type":"enabled"}',
      JSON.stringify(body?.thinking)
    )
    check(
      '额外参数不挤掉原有字段（模型名 / max_tokens 还在）',
      body?.model === 'glm-5.3' && body?.max_tokens === 65536,
      `${String(body?.model)}　${String(body?.max_tokens)}`
    )
  } finally {
    globalThis.fetch = prevFetch
  }

  // .env 那一行的写法：裸 JSON 能用，加引号会被解析器截断
  const bareJson = parseEnvFile('PAPERVAULT_LLM_EXTRA_BODY={"thinking":{"type":"enabled"}}\n')
  check(
    '裸 JSON 能被 .env 解析器完整取到',
    bareJson.PAPERVAULT_LLM_EXTRA_BODY === '{"thinking":{"type":"enabled"}}',
    bareJson.PAPERVAULT_LLM_EXTRA_BODY
  )
  const quotedJson = parseEnvFile('PAPERVAULT_LLM_EXTRA_BODY="{"thinking":{"type":"enabled"}}"\n')
  check(
    '加了引号会被截断（所以 .env.example 里特意标了「不要加引号」）',
    quotedJson.PAPERVAULT_LLM_EXTRA_BODY !== bareJson.PAPERVAULT_LLM_EXTRA_BODY,
    quotedJson.PAPERVAULT_LLM_EXTRA_BODY
  )

  /* ---------------- 20. 笔记里图片的相对路径 ---------------- */
  console.log('')
  console.log('── 20. 原文图表的路径解析 ─────────────────')

  /*
   * 笔记里写的是**相对笔记文件**的路径（`../figures/<id>/fig-1.png`），
   * 这样知识库整体搬走不断链、在 Obsidian 里也能显示。
   * 渲染时要把这个相对路径换回「相对知识库根」才能去读字节 ——
   * 下面这些断言就是那次换算的边界。
   */
  check(
    '笔记在 papers/ 下：退一级到根，再进 figures/',
    resolveVaultRelative('papers', '../figures/abc/fig-1.png') === 'figures/abc/fig-1.png',
    String(resolveVaultRelative('papers', '../figures/abc/fig-1.png'))
  )
  check(
    '笔记在子目录里也能算对（退两级）',
    resolveVaultRelative('papers/2026', '../../figures/abc/fig-1.png') === 'figures/abc/fig-1.png'
  )
  check(
    '同级路径直接拼',
    resolveVaultRelative('papers', 'img/a.png') === 'papers/img/a.png'
  )
  check(
    '以 / 开头 = 相对知识库根',
    resolveVaultRelative('papers', '/figures/abc/fig-1.png') === 'figures/abc/fig-1.png'
  )
  check(
    '退过头（越出知识库）→ null',
    resolveVaultRelative('papers', '../../../etc/passwd') === null &&
      resolveVaultRelative('', '../x.png') === null
  )
  check(
    '带协议的地址交给调用方原样处理，不算相对路径',
    resolveVaultRelative('papers', 'https://x/y.png') === null &&
      resolveVaultRelative('papers', 'data:image/png;base64,AAA') === null &&
      // Windows 盘符也长这样，同样不该由这里解析
      resolveVaultRelative('papers', 'C:/x/y.png') === null
  )
  check('空路径不给结果', resolveVaultRelative('papers', '   ') === null)

  check(
    '只认白名单里的图片扩展名',
    isImagePath('figures/a/fig-1.png') &&
      isImagePath('X.WEBP') &&
      !isImagePath('figures/a/note.md') &&
      !isImagePath('a.pdf')
  )
  check(
    '认不出的扩展名一律当 PNG',
    normalizeFigureExtension('.jpeg') === '.jpeg' &&
      normalizeFigureExtension('.svg') === '.png' &&
      normalizeFigureExtension(undefined) === '.png'
  )
  check(
    'MIME 跟着扩展名走（都写 image/png 会让 webp / gif 图裂）',
    imageMimeOf('a.png') === 'image/png' &&
      imageMimeOf('a.JPG') === 'image/jpeg' &&
      imageMimeOf('a.webp') === 'image/webp' &&
      imageMimeOf('a.gif') === 'image/gif'
  )

  // 闭环：生成的片段要能被解析回同一张图，否则「复制→粘贴」这条路是断的
  const figureMd = figureMarkdown('../figures/abc/fig-1.png')
  check(
    '生成的 Markdown 片段是标准图片语法',
    figureMd === '![原文图表](../figures/abc/fig-1.png)',
    figureMd
  )
  check(
    '片段里的路径能解析回同一张图（闭环）',
    resolveVaultRelative('papers', /\]\(([^)]+)\)/.exec(figureMd)?.[1] ?? '') ===
      'figures/abc/fig-1.png'
  )

  /* ---------------- 21. 图表片段插入章节正文 ---------------- */
  console.log('')
  console.log('── 21. 图表片段插入章节正文 ─────────────────')

  /*
   * 「插入笔记」的落点算式：图片语法必须独占一行，所以前后要补段落分隔；
   * 返回的 at 是下一次插入该落的位置（连截几张按顺序往下排）。
   */
  const SNIP = '![原文图表](../figures/p/fig-1.png)'

  const intoEmpty = insertMarkdownSnippet('', null, SNIP)
  check(
    '空章节：片段就是正文，at 指向片段末尾',
    intoEmpty.next === SNIP && intoEmpty.at === SNIP.length,
    intoEmpty.next
  )
  check(
    '末尾追加：前面补出段落分隔（图片不能粘在上一行后面）',
    insertMarkdownSnippet('已有内容', null, SNIP).next === `已有内容\n\n${SNIP}`,
    insertMarkdownSnippet('已有内容', null, SNIP).next
  )
  check(
    '结尾只有单个换行时补成空行',
    insertMarkdownSnippet('已有\n', null, SNIP).next === `已有\n\n${SNIP}`
  )
  check(
    '结尾已是空行就不再加',
    insertMarkdownSnippet('已有\n\n', null, SNIP).next === `已有\n\n${SNIP}`
  )
  const mid = insertMarkdownSnippet('第一行\n第二行这句话没写完', 11, SNIP)
  check(
    '句中光标：片段独占一行，原来这行剩下的字挪下去',
    mid.next === `第一行\n第二行这句话没\n\n${SNIP}\n写完`,
    mid.next
  )
  check(
    '越界光标收敛到末尾（记录光标后内容可能被改短）',
    insertMarkdownSnippet('abc', 999, SNIP).next === `abc\n\n${SNIP}`
  )
  check(
    '负数光标收敛到开头',
    insertMarkdownSnippet('abc', -5, SNIP).next === `${SNIP}\nabc`
  )
  const first = insertMarkdownSnippet('- 要点', null, SNIP)
  const second = insertMarkdownSnippet(first.next, first.at, SNIP)
  check(
    '连截两张图按顺序往下排，中间隔空行',
    second.next === `- 要点\n\n${SNIP}\n\n${SNIP}`,
    second.next
  )
  check(
    '插入后的片段仍能解析回同一张图（插入不打断闭环）',
    resolveVaultRelative('papers', /\]\(([^)]+)\)/.exec(second.next)?.[1] ?? '') ===
      'figures/p/fig-1.png'
  )

  /* ---------------- 21. 方法拆解与串联（新增章节） ---------------- */
  console.log('')
  console.log('── 21. 方法细节 / 例子 / 串联 / 举一反三 ──────')

  const NEW_SECTIONS = ['方法细节', '具体例子', '方法串联', '举一反三']
  check(
    '四个新章节都进了模板',
    NEW_SECTIONS.every((key) => SECTION_ORDER.includes(key)),
    `共 ${SECTION_ORDER.length} 节`
  )
  check(
    '新增了「方法拆解」分组，排在速览之后',
    SECTION_GROUP_ORDER.includes('方法拆解') &&
      SECTION_GROUP_ORDER.indexOf('方法拆解') === SECTION_GROUP_ORDER.indexOf('速览') + 1,
    SECTION_GROUP_ORDER.join(' → ')
  )
  check(
    '章节分组正确',
    sectionGroup('方法细节') === '方法拆解' &&
      sectionGroup('具体例子') === '方法拆解' &&
      sectionGroup('方法串联') === '延伸' &&
      sectionGroup('举一反三') === '延伸'
  )

  // 每个章节都得有归属维度，否则不会有任何维度去写它（永远是一副空骨架）
  const owners = NEW_SECTIONS.map((key) =>
    allLensIds().filter((id) => lensMeta(id).sections.includes(key))
  )
  check(
    '每个新章节恰好属于一个维度',
    owners.every((list) => list.length === 1),
    owners.map((list, i) => `${NEW_SECTIONS[i]}:${list.join(',') || '（无归属）'}`).join('　')
  )
  /*
   * 长输出维度的切分上限。
   *
   * 这里不断言「所有维度 ≤3 节」—— overview 本来就是 5 节（都是短列表，一直正常）。
   * 真正的教训是长输出维度不能贪多：
   *   1. 写作类一次写 6 节 → 撞 max_tokens 被截断（见第 17 节）；
   *   2. methodDetail 一次写 2 节 + 流程图 → 在慢模型上超 300s 超时
   *      （真实失败：deepseek-chat），于是「具体例子」拆成了 methodExample，
   *      各自一次只写一节。
   */
  check(
    '方法细节 / 具体例子拆成两个维度，各写 1 节（慢模型超时的修复）',
    lensMeta('methodDetail').sections.length === 1 &&
      lensMeta('methodExample').sections.length === 1,
    `methodDetail:${lensMeta('methodDetail').sections.length}　methodExample:${lensMeta('methodExample').sections.length}`
  )
  check(
    'connections 维持 2 节（内容是短列表，没有超时风险）',
    lensMeta('connections').sections.length === 2
  )
  check(
    '拆分出来的 methodExample 也是默认启用（老用户靠 opt-out 自动生效）',
    enabledLensIds([]).includes('methodDetail') &&
      enabledLensIds([]).includes('methodExample') &&
      enabledLensIds([]).includes('connections')
  )
  check('新建论文时新章节也有骨架', NEW_SECTIONS.every((k) => (emptySections()[k] ?? '').length > 0))
  check(
    '只写了新章节仍不算「已精读」（判定口径没被改宽）',
    !isAiFilled({
      ...emptySections(),
      方法细节: '- 写了',
      具体例子: '- 有例子',
      方法串联: '- 串上了',
      举一反三: '- 迁移了'
    })
  )

  /* ---- 跨论文相关性：关系必须由数据判定 ---- */
  const graphOf = (entities: GraphEntity[]): PaperGraph => ({ entities, relations: [] })
  const me = {
    id: 'me',
    title: '本篇',
    year: 2026,
    tldr: '',
    graph: graphOf([
      { name: 'DROID', kind: 'dataset' },
      { name: 'VLA', kind: 'task' }
    ])
  }
  const sameDataset = {
    id: 'p1',
    title: '也用了 DROID',
    year: 2025,
    tldr: '用 DROID 做真机评测',
    graph: graphOf([{ name: 'droid', kind: 'dataset' }])
  }
  const viaAlias = {
    id: 'p2',
    title: '别名匹配',
    year: 2024,
    tldr: '',
    graph: graphOf([{ name: '某数据集', kind: 'dataset', aliases: [' DROID '] }])
  }
  const onlyConcept = {
    id: 'p3',
    title: '只共享概念词',
    year: 2026,
    tldr: '',
    graph: graphOf([{ name: 'DROID', kind: 'concept' }])
  }
  const onlyTask = {
    id: 'p4',
    title: '只共享一个笼统任务',
    year: 2026,
    tldr: '',
    graph: graphOf([{ name: 'VLA', kind: 'task' }])
  }
  const noGraph = { id: 'p5', title: '没有图谱', year: 2026, tldr: '' }

  const related = relatedPapersFrom('me', [me, sameDataset, viaAlias, onlyConcept, onlyTask, noGraph])
  check(
    '共享数据集 → 命中（大小写不敏感）',
    related.some((p) => p.id === 'p1'),
    related.map((p) => `${p.id}:${p.score}`).join(' ')
  )
  check('别名也认（归一化后同一实体）', related.some((p) => p.id === 'p2'))
  check('自己不出现在候选里', !related.some((p) => p.id === 'me'))
  check(
    '只共享 concept 不算相关 —— 这类词任何两篇都能共享',
    !related.some((p) => p.id === 'p3')
  )
  check(
    '只共享一个笼统任务名不算相关 —— 挡掉「都关注 XX」式关联',
    !related.some((p) => p.id === 'p4')
  )
  check('没有图谱的论文不进候选', !related.some((p) => p.id === 'p5'))
  check(
    '候选带上「因为什么相关」，模型才有依据',
    (related[0]?.shared.length ?? 0) > 0,
    related[0]?.shared.join('、') ?? ''
  )

  const strong = {
    id: 'strong',
    title: '共享一个数据集 + 一个任务',
    year: 2024,
    tldr: '',
    graph: graphOf([
      { name: 'DROID', kind: 'dataset' },
      { name: 'VLA', kind: 'task' }
    ])
  }
  const weak = {
    id: 'weak',
    title: '只共享三个笼统要素',
    year: 2026,
    tldr: '',
    graph: graphOf([
      { name: 'VLA', kind: 'task' },
      { name: 'A', kind: 'technique' },
      { name: 'B', kind: 'technique' }
    ])
  }
  const ranked = relatedPapersFrom('me', [me, weak, strong])
  check(
    '具体要素多的排在笼统要素多的前面',
    ranked[0]?.id === 'strong',
    ranked.map((p) => `${p.id}:${p.score}`).join(' ')
  )

  check('筛不出候选时返回空数组', relatedPapersFrom('me', [me, noGraph]).length === 0)
  check('本篇自己没有图谱时也不乱给候选', relatedPapersFrom('nobody', [me, sameDataset]).length === 0)

  /* ---- prompt 措辞：必须给模型「串不上」这条退路 ---- */
  const emptyBlock = renderRelatedPapers([])
  check(
    '没候选时明确要求写「串不上」而不是硬凑',
    /库内暂无与本篇真正可串联/.test(emptyBlock) && /不要.*关联无关论文/.test(emptyBlock)
  )
  const filledBlock = renderRelatedPapers(related)
  check('有候选时说明筛选依据是「共享的技术要素」', /共享的技术要素/.test(filledBlock))
  check(
    '有候选时也明确允许说「关系不成立」',
    /关系不成立/.test(filledBlock),
    '不给这条退路，模型会默认「给了素材就得写出关联」'
  )

  /*
   * 方法细节这个维度的 prompt 是「具体导向」的，而它的填写要求来自模板 scaffold
   *（sectionRequirements 直接读它）—— 下面几条把「模板骨架」与「lens prompt」的耦合
   * 钉住：谁改了一边都得看另一边，否则 prompt 会悄悄退回摘要级空话。
   */
  const detailRequirements = sectionRequirements(['方法细节'])
  check(
    '「方法细节」的填写要求里必须包含「走一遍」',
    detailRequirements.includes('走一遍'),
    '这一节最有用的部分：逼出一条真实的数据流'
  )
  check(
    '要求里带「术语对照」（读者要能拿着原词回 PDF 里搜）',
    detailRequirements.includes('术语对照')
  )
  check(
    'prompt 写明读者定位（同行，但不是本子方向专家）',
    methodDetailLens.system.includes('不是这篇论文所在子方向的专家')
  )
  check(
    'system 用「读完还是不知道发生了什么」当判据，禁掉那类空话',
    methodDetailLens.system.includes('深度融合了多模态信息')
  )
  const detailPrompt = methodDetailLens.prompt(fakeCtx)
  check(
    'prompt 明确「走一遍」必须写，并要求标出处',
    detailPrompt.includes('「走一遍」是这一节最有用的部分') && detailPrompt.includes('标出处')
  )
  check(
    'prompt 给了长度预算（防止为了填满结构写空话）',
    detailPrompt.includes('1200-2200 字')
  )
  check('system 仍要求合法 JSON（解析链靠它）', methodDetailLens.system.includes('合法 JSON'))
  check(
    '流程图的 4~8 节点与「没有流程就别画」两条仍在',
    detailPrompt.includes('4~8 个为宜') && detailPrompt.includes('字段都不要出现')
  )

  /* ---------------- 22. 方法流程图（结构化 + 自绘） ---------------- */
  console.log('')
  console.log('── 22. 方法流程图：解析与布局 ──────────────')

  const node = (id: string, label = id): { id: string; label: string } => ({ id, label })

  /* 解析容错：模型返回的形状一定不老实 */
  const okFlow = normalizeMethodFlow({
    nodes: [node('a'), node('b')],
    edges: [{ from: 'a', to: 'b' }]
  })
  check('正常输入能解析', okFlow?.nodes.length === 2 && okFlow.edges.length === 1)
  check(
    '只有一个节点 → 返回 undefined（调用方据此不写这个键，界面上那块整个不出现）',
    normalizeMethodFlow({ nodes: [node('a')] }) === undefined
  )
  check(
    '没标签的节点被丢掉',
    normalizeMethodFlow({ nodes: [{ id: 'a' }, node('b'), node('c')] })?.nodes.length === 2
  )
  check(
    '缺 id 时自动补，不会和已有 id 撞',
    (() => {
      const f = normalizeMethodFlow({ nodes: [{ label: '甲' }, node('n1', '乙'), node('n2', '丙')] })
      const ids = f?.nodes.map((n) => n.id) ?? []
      return new Set(ids).size === ids.length && ids.length === 3
    })()
  )
  check(
    '指向不存在节点的边被丢掉（不留悬空线）',
    normalizeMethodFlow({
      nodes: [node('a'), node('b')],
      edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'zzz' }]
    })?.edges.length === 1
  )
  check(
    '自环被丢掉',
    normalizeMethodFlow({
      nodes: [node('a'), node('b')],
      edges: [{ from: 'a', to: 'a' }]
    })?.edges.length === 0
  )
  check(
    '重复边只留一条',
    normalizeMethodFlow({
      nodes: [node('a'), node('b')],
      edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }]
    })?.edges.length === 1
  )
  check(
    '节点数有上限（否则画出来是一堵墙）',
    (normalizeMethodFlow({
      nodes: Array.from({ length: 40 }, (_, i) => node(`n${i}`))
    })?.nodes.length ?? 0) <= 12
  )
  check(
    '没值的字段不出现在对象里（undefined 值会让 js-yaml 抛错）',
    (() => {
      const f = normalizeMethodFlow({ nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b' }] })
      return (
        f !== undefined &&
        Object.values(f.nodes[0]).every((v) => v !== undefined) &&
        Object.values(f.edges[0]).every((v) => v !== undefined)
      )
    })()
  )

  /* 布局 */
  const chain = normalizeMethodFlow({
    nodes: [node('a'), node('b'), node('c')],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' }
    ]
  })!
  const laid = layoutMethodFlow(chain)
  check(
    '一条链排成三层（按最长路径）',
    laid.nodes.map((n) => n.layer).join(',') === '0,1,2',
    laid.nodes.map((n) => `${n.id}:${n.layer}`).join(' ')
  )
  check(
    '层往下走（y 递增）',
    laid.nodes[0].y < laid.nodes[1].y && laid.nodes[1].y < laid.nodes[2].y
  )
  check('每层水平居中：单节点层的 x 相同', laid.nodes[0].x === laid.nodes[1].x)
  check(
    '画布高度容得下所有节点',
    laid.height >= laid.nodes[2].y + laid.nodes[2].h
  )
  check(
    '边从下边中点连到上边中点（跨层）',
    laid.edges[0].x1 === laid.nodes[0].x + laid.nodes[0].w / 2 &&
      laid.edges[0].y1 === laid.nodes[0].y + laid.nodes[0].h &&
      laid.edges[0].y2 === laid.nodes[1].y
  )

  /* 分支：同一层并排，不能重叠 */
  const branch = normalizeMethodFlow({
    nodes: [node('a'), node('b'), node('c')],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' }
    ]
  })!
  const branched = layoutMethodFlow(branch)
  const b = branched.nodes.find((n) => n.id === 'b')!
  const c = branched.nodes.find((n) => n.id === 'c')!
  check('分支的两个节点在同一层', b.layer === c.layer && b.layer === 1)
  check(
    '分支不重叠（横向留出间隔）',
    Math.abs(b.x - c.x) >= b.w,
    `Δx=${Math.abs(b.x - c.x)}　w=${b.w}`
  )

  /* 最长路径：a→b→c 与 a→c 同时存在时，c 不能被提到第 1 层（否则箭头倒着画） */
  const diamond = normalizeMethodFlow({
    nodes: [node('a'), node('b'), node('c')],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'a', to: 'c' }
    ]
  })!
  check(
    'c 取最长路径（第 2 层）',
    layoutMethodFlow(diamond).nodes.find((n) => n.id === 'c')!.layer === 2
  )

  /* 环形依赖：模型偶尔会写出互指的节点，布局不能因此挂住 */
  const cyclic = normalizeMethodFlow({
    nodes: [node('a'), node('b')],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' }
    ]
  })!
  const cyc = layoutMethodFlow(cyclic)
  check(
    '环形依赖不死循环，且每个节点都有位置',
    cyc.nodes.length === 2 &&
      cyc.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y) && n.layer >= 0)
  )

  /* 维度接线：flow 由 methodDetail 顺带产出，坏数据时不带这个键 */
  const detailLens = getLens('methodDetail')
  const goodParse = detailLens?.parse(
    {
      sections: { 方法细节: '- 讲了', 具体例子: '- 有例子' },
      flow: { nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b' }] }
    },
    {} as never
  )
  check(
    '维度把 flow 放进 data（而不是塞进章节正文）',
    (goodParse?.data as Record<string, unknown> | undefined)?.flow !== undefined &&
      goodParse?.sections?.['方法细节'] === '- 讲了'
  )
  const badParse = detailLens?.parse(
    { sections: { 方法细节: '- 讲了' }, flow: { nodes: [node('a')] } },
    {} as never
  )
  check(
    'flow 画不成图时 data 里没有这个键（不是塞一个空对象）',
    badParse?.data === undefined
  )

  /* 拆分后的归属：methodDetail 只管「方法细节」+ flow，「具体例子」归 methodExample */
  check(
    'methodDetail 不再认领「具体例子」（拆了就是拆了，不然超时修复白做）',
    detailLens?.parse(
      { sections: { 方法细节: '- 讲了', 具体例子: '- 有例子' }, flow: { nodes: [node('a')] } },
      {} as never
    )?.sections?.['具体例子'] === undefined
  )
  const exampleLens = getLens('methodExample')
  check(
    '「具体例子」由 methodExample 产出',
    exampleLens?.parse({ sections: { 具体例子: '- 有例子' } }, {} as never)?.sections?.[
      '具体例子'
    ] === '- 有例子'
  )

  /* ---------------- 23. AI 自动标重点 ---------------- */
  console.log('')
  console.log('── 23. AI 标重点：行号区间解析与合并 ────────')

  /*
   * 模型只返回行号区间，位置用文字行回查 —— 标的位置永远是真的。
   * 这一节守的就是「区间 → 高亮」的换算容错：模型给的行号一定不老实。
   */
  const srcLine = (id: number, page: number, y: number, text = `line ${id}`): SourceLine => ({
    id,
    page,
    text,
    rect: { x: 0.1, y, w: 0.8, h: 0.03 }
  })
  const srcLines = [
    srcLine(0, 1, 0.1),
    srcLine(1, 1, 0.15),
    srcLine(2, 1, 0.2),
    srcLine(3, 2, 0.1),
    srcLine(4, 2, 0.15)
  ]

  const okPicks = normalizeAutoHighlights(
    { spans: [{ from: 1, to: 2, kind: 'method', why: '核心设计的出处' }] },
    srcLines
  )
  check('正常区间能解析', okPicks.length === 1)
  check(
    '矩形来自文字行而不是模型编的（位置必然真实）',
    okPicks[0]?.rects.length === 2 && okPicks[0]?.rects[0].y === 0.15
  )
  check(
    '文字是把行拼回来的',
    okPicks[0]?.text === 'line 1 line 2',
    okPicks[0]?.text
  )

  check(
    '行号越界的区间被丢掉',
    normalizeAutoHighlights({ spans: [{ from: 98, to: 99 }] }, srcLines).length === 0
  )
  check(
    'from > to 被丢掉',
    normalizeAutoHighlights({ spans: [{ from: 2, to: 1 }] }, srcLines).length === 0
  )
  check(
    '区间太长被丢掉（粒度是句子，不是整段）',
    (() => {
      const ten = Array.from({ length: 10 }, (_, i) => srcLine(i, 1, i * 0.05))
      return normalizeAutoHighlights({ spans: [{ from: 0, to: 7 }] }, ten).length === 0
    })()
  )
  check(
    '区间中间缺行（引用了不存在的行号）整个作废',
    normalizeAutoHighlights({ spans: [{ from: 3, to: 5 }] }, srcLines).length === 0
  )
  check(
    '模型没包 spans、直接给数组也能解析',
    normalizeAutoHighlights([{ from: 0, to: 1 }], srcLines).length === 1
  )
  check(
    '跨页区间拆成每页一条（Highlight 只能属于一页）',
    (() => {
      const picks = normalizeAutoHighlights({ spans: [{ from: 2, to: 3 }] }, srcLines)
      return picks.length === 2 && picks[0].page === 1 && picks[1].page === 2
    })()
  )
  check(
    '不认识的 kind 收敛成 other（不丢这条）',
    normalizeAutoHighlights({ spans: [{ from: 0, to: 1, kind: 'zzz' }] }, srcLines)[0]?.kind ===
      'other'
  )
  check(
    '标注按阅读顺序排（页码 → 页内从上往下）',
    (() => {
      const picks = normalizeAutoHighlights(
        { spans: [{ from: 3, to: 3 }, { from: 0, to: 0 }, { from: 1, to: 1 }] },
        srcLines
      )
      return picks.map((p) => p.page).join(',') === '1,1,2' &&
        (picks[0].rects[0]?.y ?? 0) < (picks[1].rects[0]?.y ?? 0)
    })()
  )
  check(
    '标注总量有上限（标满整页等于没标）',
    (() => {
      const many = Array.from({ length: 60 }, (_, i) => srcLine(i, 1 + (i % 5), (i % 10) * 0.05))
      const spans = Array.from({ length: 60 }, (_, i) => ({ from: i, to: i }))
      return normalizeAutoHighlights({ spans }, many).length <= 24
    })()
  )
  check(
    '空 spans → 空数组（调用方据此报错，而不是拿空数组覆盖已有标注）',
    normalizeAutoHighlights({ spans: [] }, srcLines).length === 0
  )

  const built = buildAiHighlights(
    normalizeAutoHighlights({ spans: [{ from: 1, to: 2, kind: 'method', why: '核心设计的出处' }] }, srcLines),
    '2026-09-16T00:00:00.000Z'
  )
  check(
    '落成的高亮带 ai 标记和专用色（和用户高亮区分开）',
    built[0]?.ai === true && built[0]?.color === AI_HIGHLIGHT_COLOR
  )
  check(
    'note 带类型标签和「为什么重要」',
    built[0]?.note === '【核心方法】核心设计的出处',
    built[0]?.note
  )
  check(
    'id 是确定性的（重跑整条替换，不需要随机 id）',
    built[0]?.id === 'ai-hl-1'
  )
  check(
    '没有任何值为 undefined 的键（要写进 frontmatter，js-yaml 会炸）',
    built.every((h) => Object.values(h).every((v) => v !== undefined))
  )

  /* 合并语义：重跑标注 = 替换 AI 的，用户手划的一条不动 */
  const userHl = normalizeHighlights([
    { id: 'u1', page: 1, text: '我自己划的', rects: [{ x: 0, y: 0, w: 0.5, h: 0.05 }] }
  ])
  const merged = mergeAiHighlights([...userHl, ...built], buildAiHighlights(
    normalizeAutoHighlights({ spans: [{ from: 0, to: 0 }] }, srcLines),
    '2026-09-16T01:00:00.000Z'
  ))
  check('用户高亮在重跑后还在', merged.some((h) => h.id === 'u1' && !h.ai))
  check('旧 AI 标注被整条替换（不是越攒越多）', merged.filter((h) => h.ai).length === 1)

  /*
   * 关键回归：frontmatter 读改写一圈之后 ai 标记不能丢。
   * 丢了的话，旧 AI 标注会被当成用户高亮 —— 每次重跑都攒一轮，越标越多。
   */
  const roundTripped = normalizeHighlights(JSON.parse(JSON.stringify(built)))
  check(
    'ai 标记挺过 frontmatter 往返（normalizeHighlights 必须透传）',
    roundTripped[0]?.ai === true && roundTripped[0]?.note?.includes('核心方法') === true
  )

  /* prompt 与预算 */
  check(
    'system 里要求只输出 JSON（parse 靠它）',
    AUTO_HIGHLIGHT_SYSTEM.includes('只输出一个合法 JSON 对象')
  )
  check(
    'system 里写了「宁缺毋滥」（标太多等于没标）',
    AUTO_HIGHLIGHT_SYSTEM.includes('宁缺毋滥')
  )
  const userPrompt = buildAutoHighlightUser('测试论文', srcLines)
  check(
    'user 里行号格式是 [id|p页码]（模型按它引用）',
    userPrompt.includes('[2|p1]') && userPrompt.includes('[4|p2]')
  )
  check(
    '超预算从尾部截断并标记（末尾通常是参考文献，损失最小）',
    (() => {
      const big = Array.from({ length: 100 }, (_, i) => srcLine(i, 1, 0.01 * i, 'x'.repeat(100)))
      const clipped = clipLinesForBudget(big, 1000)
      return clipped.truncated && clipped.lines.length < big.length && clipped.lines[0].id === 0
    })()
  )
  check(
    '预算内不动',
    clipLinesForBudget(srcLines, 999999).truncated === false
  )

  /*
   * 按类型拆分（多专家标重点）的纯函数链：
   * 抽取文本里的 ## 标题 → 归类到 4 个专家 → 在行流里对位切分。
   * 行流和标题来自两次独立抽取、行号不对应 —— 只能靠标题原文做文本匹配。
   */
  eq(
    'extractHeadingTitles 只取 ## 行（# / ### / 正文都不算）',
    extractHeadingTitles('# 大标题\n## 1 Introduction\n正文\n### 子标题\n## 2 Method\n'),
    ['1 Introduction', '2 Method']
  )

  eq(
    'classifyHeadings：常规章节按关键词归类（含编号 / 描述后缀 / 冠词开头）',
    classifyHeadings([
      'Abstract',
      '1 Introduction',
      '2 Related Work',
      '3 Method',
      '4.1 Model Architecture',
      '5 Experiments with CultureVerse',
      '5.3 Ablation Studies',
      'A Conclusion',
      'References',
      'Acknowledgments'
    ]),
    [
      'problem',
      'problem',
      'problem',
      'method',
      'method',
      'experiment',
      'experiment',
      'conclusion',
      'skip',
      'skip'
    ]
  )
  eq(
    'classifyHeadings：命不中关键词的子标题继承父章节（3.2 Loss Function 跟 3 Method 走）',
    classifyHeadings(['3 Method', '3.2 Loss Function']),
    ['method', 'method']
  )
  eq(
    'classifyHeadings：Appendix 下的子标题不继承（A.2 Proofs 不喂给任何专家）',
    classifyHeadings(['6 Conclusion', 'Appendix', 'A.2 Proofs']),
    ['conclusion', 'skip', 'skip']
  )
  eq(
    'classifyHeadings：附录里自带关键词的子标题照样归类（C.1 More Ablations → experiment）',
    classifyHeadings(['Appendix', 'C.1 More Ablations']),
    ['skip', 'experiment']
  )
  eq(
    'classifyHeadings：顶层命不中的按跳过处理（喂错专家比不喂更糟）',
    classifyHeadings(['7 Proofs and Derivations']),
    ['skip']
  )

  const paperLine = (id: number, page: number, text: string): SourceLine => ({
    id,
    page,
    text,
    rect: { x: 0.1, y: 0.02 * (id % 40), w: 0.8, h: 0.02 }
  })
  const docLines = [
    paperLine(0, 1, 'My Paper Title'),
    paperLine(1, 1, 'Authors and Affiliations'),
    paperLine(2, 1, 'Abstract'),
    paperLine(3, 1, 'We study how beginners read papers.'),
    paperLine(4, 1, '1 Introduction'),
    paperLine(5, 1, 'Reading papers is hard for newcomers.'),
    paperLine(6, 2, '2 Method'),
    paperLine(7, 2, 'Our method splits highlighting by kind.'),
    paperLine(8, 2, '3 Experiments'),
    paperLine(9, 2, 'Table 1 shows our method wins.'),
    paperLine(10, 2, '4 Conclusion'),
    paperLine(11, 2, 'We acknowledge several limitations.'),
    paperLine(12, 2, 'References'),
    paperLine(13, 2, '[1] Some Reference 2026.')
  ]
  const docTitles = [
    'Abstract',
    '1 Introduction',
    '2 Method',
    '3 Experiments',
    '4 Conclusion',
    'References'
  ]
  const plan = assignLinesByKind(docLines, docTitles)
  check(
    'assignLinesByKind：各专家分到自己的章节（全局行号保留、升序）',
    JSON.stringify(plan.byKind.problem?.map((l) => l.id)) === '[2,3,4,5]' &&
      JSON.stringify(plan.byKind.method?.map((l) => l.id)) === '[6,7]' &&
      JSON.stringify(plan.byKind.experiment?.map((l) => l.id)) === '[8,9]' &&
      JSON.stringify(plan.byKind.conclusion?.map((l) => l.id)) === '[10,11]'
  )
  check(
    'assignLinesByKind：首个标题前的版心、References 之后的内容不喂给任何专家',
    (plan.byKind.problem?.length ?? 0) +
      (plan.byKind.method?.length ?? 0) +
      (plan.byKind.experiment?.length ?? 0) +
      (plan.byKind.conclusion?.length ?? 0) ===
      10
  )
  check('assignLinesByKind：结构认出来了就不回退', plan.fallback === false)
  check(
    'assignLinesByKind：没有标题 / 只认出一类 → 回退单 agent 全文',
    assignLinesByKind(docLines, []).fallback === true &&
      assignLinesByKind(docLines, ['1 Introduction']).fallback === true
  )
  check(
    'assignLinesByKind：行流里找不到的标题当边界缺失，内容并入上一段（不错切）',
    (() => {
      const p = assignLinesByKind(docLines, ['Abstract', '3 Experiments', '4 Conclusion'])
      return JSON.stringify(p.byKind.problem?.map((l) => l.id)) === '[2,3,4,5,6,7]'
    })()
  )

  /* 区间级的校验与跨专家合并 */
  const subset = docLines.slice(6, 10) // id 6~9：method + experiment 两段
  eq(
    'normalizeSpans：只认喂给它的行，跨地盘引用整条丢',
    normalizeSpans(
      {
        spans: [
          { from: 6, to: 7, kind: 'method', why: 'x' },
          { from: 7, to: 9, kind: 'method', why: 'y' },
          { from: 5, to: 6, kind: 'problem', why: 'z' }
        ]
      },
      subset
    ).map((s) => `${s.from}-${s.to}`),
    ['6-7', '7-9']
  )
  check(
    'normalizeSpans：不认识的 kind 收敛成 other、why 截断到上限',
    (() => {
      const spans = normalizeSpans(
        { spans: [{ from: 6, to: 6, kind: 'zzz', why: 'x'.repeat(200) }] },
        subset
      )
      return spans.length === 1 && spans[0].kind === 'other' && spans[0].why.length === 120
    })()
  )
  eq(
    'normalizeAutoHighlights 就是「校验 + 换算」的组合（拆分重构后行为不变）',
    normalizeAutoHighlights(
      { spans: [{ from: 1, to: 2, kind: 'method', why: 'w' }] },
      srcLines
    ),
    spansToPicks(
      normalizeSpans({ spans: [{ from: 1, to: 2, kind: 'method', why: 'w' }] }, srcLines),
      srcLines
    )
  )
  eq(
    'mergeSpans：完全相同的区间把理由去重合并',
    mergeSpans([
      { from: 1, to: 3, kind: 'method', why: '关键设计' },
      { from: 1, to: 3, kind: 'method', why: '关键设计；与基线的区别' }
    ]).map((s) => s.why),
    ['关键设计；与基线的区别']
  )
  eq(
    'mergeSpans：部分重叠保留起点更早的（先到先得是确定性规则）',
    mergeSpans([
      { from: 2, to: 5, kind: 'method', why: 'b' },
      { from: 1, to: 4, kind: 'problem', why: 'a' }
    ]).map((s) => `${s.from}-${s.to}`),
    ['1-4']
  )
  check(
    'mergeSpans：按 from 排序输出、总量守上限',
    (() => {
      const many = Array.from({ length: 40 }, (_, i) => ({
        from: i * 10,
        to: i * 10 + 1,
        kind: 'method' as const,
        why: ''
      }))
      const merged = mergeSpans(many)
      return (
        merged.length === 24 && merged.every((s, i) => i === 0 || merged[i - 1].from < s.from)
      )
    })()
  )
  check(
    '四个专家 prompt 都带 JSON 约束与「宁缺毋滥」（各自单独调模型，不能只钉在总 prompt 上）',
    AGENT_KINDS.map((k) => kindSystem(k)).every(
      (p) => p.includes('只输出一个合法 JSON 对象') && p.includes('宁缺毋滥')
    )
  )
  check(
    '专家 prompt 只允许输出自己那类 kind（混类会打乱配额与标签）',
    kindSystem('problem').includes('"problem"') &&
      !kindSystem('problem').includes('problem|method') &&
      kindSystem('experiment').includes('"experiment" 或 "result"')
  )

  /* ---------------- 24. 「考考我」自测题 ---------------- */
  console.log('')
  console.log('── 24. 自测题：解析容错与本地判分 ──────────')

  const quizQ = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    q: '这篇论文解决的核心问题是什么？',
    options: ['A 甲', 'B 乙', 'C 丙', 'D 丁'],
    answer: 1,
    why: '解析：因为……',
    source: '§1',
    ...over
  })

  const okQuiz = normalizeQuiz({ questions: [quizQ(), quizQ(), quizQ()] }, '2026-09-16T00:00:00.000Z')
  check('正常出题能解析', okQuiz?.questions.length === 3)
  check(
    '有效题目不足 3 道 → undefined（一两道题测不出理解盲区，调用方提示重试）',
    normalizeQuiz({ questions: [quizQ(), quizQ()] }) === undefined
  )
  check(
    '答案下标越界的题被丢掉',
    normalizeQuiz({ questions: [quizQ(), quizQ(), quizQ(), quizQ({ answer: 9 })] })?.questions
      .length === 3
  )
  check(
    '选项去空去重后不足 2 个 → 不成题',
    normalizeQuiz({ questions: [quizQ(), quizQ(), quizQ(), quizQ({ options: ['甲', '', '  '], answer: 0 })] })
      ?.questions.length === 3
  )
  check(
    '没有解析的题被丢掉（答错的人全靠解析知道回哪里重读）',
    normalizeQuiz({ questions: [quizQ(), quizQ(), quizQ(), quizQ({ why: '' })] })?.questions
      .length === 3
  )
  check(
    '题量有上限（太多初学者做不完）',
    normalizeQuiz({ questions: Array.from({ length: 15 }, () => quizQ()) })?.questions.length === 8
  )
  check(
    '没值的字段不出现在对象里（js-yaml 遇 undefined 会抛）',
    (() => {
      const q = normalizeQuiz({ questions: [quizQ(), quizQ(), quizQ({ source: '' })] })!
      return (
        q.questions.every((item) => Object.values(item).every((v) => v !== undefined)) &&
        !('source' in q.questions[2]) &&
        Object.values(q).every((v) => v !== undefined)
      )
    })()
  )
  check(
    '已有 createdAt 不被刷新（重测多次题还是那套题）',
    normalizeQuiz({ createdAt: '2026-01-01', questions: [quizQ(), quizQ(), quizQ()] })?.createdAt ===
      '2026-01-01'
  )

  /* 判分：本地纯函数，对答案不再调用模型 */
  const gradeTarget = normalizeQuiz({ questions: [quizQ({ answer: 0 }), quizQ({ answer: 2 }), quizQ({ answer: 1 })] })!
  const graded = gradeQuiz(gradeTarget, [0, 1, null])
  check(
    '判分：全对 / 答错 / 未作答 分开算',
    graded.correct === 1 && graded.total === 3 && graded.results.join(',') === 'true,false,false',
    JSON.stringify(graded.results)
  )
  check(
    '答案下标越界算错（不抛错）',
    gradeQuiz(gradeTarget, [99, 2, 1]).correct === 2
  )

  check(
    '出题 prompt 写明「考理解，不考记忆」',
    QUIZ_SYSTEM.includes('考理解，不考记忆')
  )
  check('出题 prompt 有 JSON 约束', QUIZ_SYSTEM.includes('合法 JSON'))
  check(
    'user prompt 带上标题和正文',
    buildQuizUser('测试论文', '正文内容').includes('测试论文') &&
      buildQuizUser('测试论文', '正文内容').includes('正文内容')
  )

  /* ---------------- 25. 全文思维导图 ---------------- */
  console.log('')
  console.log('── 25. 思维导图：解析与树布局 ──────────────')

  const mind = (
    label: string,
    children?: unknown[],
    over: Record<string, unknown> = {}
  ): Record<string, unknown> => ({ label, ...(children ? { children } : {}), ...over })

  const okMap = normalizeMindMap({
    title: '测试论文结构',
    root: mind('主题', [
      mind('问题', [mind('痛点 A'), mind('痛点 B')]),
      mind('方法', [mind('设计 X', undefined, { note: '为什么这么做' })]),
      mind('结论', [mind('局限')])
    ])
  })
  check('正常导图能解析', okMap?.root.children?.length === 3)
  check(
    '根没有分支 → undefined（一张只有根的导图不成图，界面上那一块整个不出现）',
    normalizeMindMap({ root: mind('主题') }) === undefined &&
      normalizeMindMap({ root: mind('主题', [mind('独支')]) }) === undefined
  )
  check(
    '根缺标签 → undefined',
    normalizeMindMap({ root: { children: [mind('a'), mind('b')] } }) === undefined
  )
  check(
    '超过 3 层的子树被剪掉（宁可少一层，不要看不懂的图）',
    (() => {
      const deep = normalizeMindMap({
        root: mind('主题', [
          mind('L1', [mind('L2', [mind('L3', [mind('L4 应被剪掉')])])]),
          mind('另一支')
        ])
      })
      const json = JSON.stringify(deep)
      return deep !== undefined && !json.includes('L4 应被剪掉') && json.includes('L3')
    })()
  )
  check(
    '节点总数有上限（标太密就是一堵墙）',
    (() => {
      const wide = normalizeMindMap({
        root: mind('主题', [
          mind('甲', Array.from({ length: 25 }, (_, i) => mind(`叶 ${i}`))),
          mind('乙', Array.from({ length: 25 }, (_, i) => mind(`叶 B${i}`)))
        ])
      })
      return JSON.stringify(wide).split('"label"').length - 1 <= 30
    })()
  )
  check(
    '缺 id 自动补且不撞',
    (() => {
      const m = normalizeMindMap({ root: mind('主题', [mind('a'), mind('b')]) })!
      const ids: string[] = []
      const walk = (n: { id: string; children?: { id: string }[] }): void => {
        ids.push(n.id)
        n.children?.forEach(walk)
      }
      walk(m.root)
      return new Set(ids).size === ids.length && ids.length === 3
    })()
  )
  check(
    '没值的键不出现（children 空 / note 空都不留键，js-yaml 安全）',
    (() => {
      const m = normalizeMindMap({ root: mind('主题', [mind('a', undefined, { note: '' }), mind('b')]) })!
      return m.root.children!.every(
        (c) => !('note' in c) && !('children' in c) && Object.values(c).every((v) => v !== undefined)
      )
    })()
  )

  /* 布局：横向树，父节点居中于子树，兄弟不重叠 */
  const laidMap = layoutMindMap(okMap!)
  check(
    '每个节点都有有限坐标',
    laidMap.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))
  )
  check(
    '深度越深 x 越大（根在最左）',
    (() => {
      const root = laidMap.nodes.find((n) => n.depth === 0)!
      const leaf = laidMap.nodes.find((n) => n.depth === 2)!
      return root.x === 0 && leaf.x > root.x
    })()
  )
  check(
    '父节点垂直居中于它的子树（一眼看出谁归谁）',
    (() => {
      const root = laidMap.nodes.find((n) => n.depth === 0)!
      const kids = laidMap.nodes.filter((n) => n.parentId === root.id)
      const descendantsOf = (id: string): MindLayoutNode[] =>
        laidMap.nodes.filter((n) => {
          let cur = n
          while (cur.parentId) {
            if (cur.parentId === id) return true
            cur = laidMap.nodes.find((p) => p.id === cur.parentId)!
          }
          return false
        })
      // 子树的垂直跨度 = 后代里最顶到最底（不是子节点本身的中心连线 ——
      // 子节点在自己的子树里居中，「节点中心」和「子树跨度」是两回事）
      const first = kids[0]
      const last = kids[kids.length - 1]
      const top = Math.min(first.y, ...descendantsOf(first.id).map((d) => d.y))
      const bottom = Math.max(
        last.y + last.h,
        ...descendantsOf(last.id).map((d) => d.y + d.h)
      )
      return Math.abs(root.y + root.h / 2 - (top + bottom) / 2) < 0.01
    })()
  )
  check(
    '兄弟子树互不重叠（y 区间不相交）',
    (() => {
      const root = laidMap.nodes.find((n) => n.depth === 0)!
      const kids = laidMap.nodes
        .filter((n) => n.parentId === root.id)
        .sort((a, b) => a.y - b.y)
      // 子树最底 = 最深后代的最大 y+h；这里用「下一兄弟的顶 > 上一兄弟子树最深叶子的底」判
      const subtreeBottom = (id: string): number => {
        const self = laidMap.nodes.find((n) => n.id === id)!
        const desc = laidMap.nodes.filter((n) => {
          let cur = n
          while (cur.parentId) {
            if (cur.parentId === id) return true
            cur = laidMap.nodes.find((p) => p.id === cur.parentId)!
          }
          return false
        })
        return Math.max(self.y + self.h, ...desc.map((d) => d.y + d.h))
      }
      return kids.slice(1).every((k, i) => k.y >= subtreeBottom(kids[i].id))
    })()
  )
  check(
    '画布容得下所有节点',
    laidMap.nodes.every((n) => n.x + n.w <= laidMap.width && n.y + n.h <= laidMap.height)
  )

  /* 维度接线：mindmap 由 overview 顺带产出，坏数据时不带这个键 */
  const ovLens = getLens('overview')
  const ovGood = ovLens?.parse(
    {
      categories: [],
      tags: [],
      sections: {},
      mindmap: { root: mind('主题', [mind('a'), mind('b')]) }
    },
    {} as never
  )
  check(
    'overview 把 mindmap 放进 data（而不是塞进章节正文）',
    (ovGood?.data as Record<string, unknown> | undefined)?.mindmap !== undefined
  )
  check(
    '撑不成图时 data 里没有这个键',
    ovLens?.parse({ categories: [], tags: [], sections: {}, mindmap: { root: mind('独根') } }, {} as never)
      ?.data === undefined
  )

  /* ---------------- 24. 演示稿：解析、容错、图纸降级 ---------------- */
  console.log('')
  console.log('── 24. 演示稿：解析 / 容错 / 图纸降级 ──────')

  const mkSlide = (
    title: string,
    bullets: string[] = ['要点'],
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> => ({ title, bullets, ...extra })

  const deck = normalizeSlideDeck({
    audience: '组会，讲 10 分钟',
    slides: [
      mkSlide('为什么值得听', ['一句话讲清它的价值']),
      mkSlide('问题难在哪', ['现有做法全靠人工']),
      mkSlide('方法流程', [], { visual: 'flow' }),
      mkSlide('关键证据', ['3B 模型追平 70B'])
    ]
  })
  check('够页数的演示稿能通过', deck?.slides.length === 4)
  eq('audience 保留', deck?.audience, '组会，讲 10 分钟')
  check(
    '图纸页允许没有要点（一页就一张图）',
    deck?.slides[2].visual === 'flow' && deck?.slides[2].bullets.length === 0
  )
  check(
    '缺标题的页被丢掉（投出去只剩一屏光秃秃的要点）',
    normalizeSlideDeck({
      slides: [mkSlide(''), mkSlide('b'), mkSlide('c'), mkSlide('d'), mkSlide('e')]
    })?.slides.length === 4
  )
  check(
    '纯文字页没有要点也要丢掉',
    normalizeSlideDeck({
      slides: [mkSlide('a', []), mkSlide('b'), mkSlide('c'), mkSlide('d'), mkSlide('e')]
    })?.slides.length === 4
  )
  check(
    '不认识的 visual 收敛成普通页（要点留着，别整页丢）',
    (() => {
      const d = normalizeSlideDeck({
        slides: [mkSlide('a', ['x'], { visual: 'chart' }), mkSlide('b'), mkSlide('c'), mkSlide('d')]
      })
      return d?.slides[0].visual === undefined && d?.slides[0].bullets.length === 1
    })()
  )
  check(
    '要点最多 6 条',
    normalizeSlideDeck({
      slides: [
        mkSlide('a', Array.from({ length: 9 }, (_, i) => `要点 ${i}`)),
        mkSlide('b'),
        mkSlide('c'),
        mkSlide('d')
      ]
    })?.slides[0].bullets.length === 6
  )
  check(
    '标题超长被截断',
    normalizeSlideDeck({
      slides: [mkSlide('标'.repeat(90)), mkSlide('b'), mkSlide('c'), mkSlide('d')]
    })?.slides[0].title.length === 48
  )
  check(
    '页数上限 16 页（再多听众记不住）',
    normalizeSlideDeck({
      slides: Array.from({ length: 30 }, (_, i) => mkSlide(`第 ${i + 1} 页`))
    })?.slides.length === 16
  )
  check(
    '页数不足 4 页返回 undefined（交给调用方报错重试，不拿残稿覆盖）',
    normalizeSlideDeck({ slides: [mkSlide('a'), mkSlide('b'), mkSlide('c')] }) === undefined
  )
  check('空输入返回 undefined', normalizeSlideDeck(null) === undefined)
  check(
    '模型直接吐数组也能解析',
    normalizeSlideDeck([mkSlide('a'), mkSlide('b'), mkSlide('c'), mkSlide('d')])?.slides.length === 4
  )

  /*
   * 可选键必须「没值就不出现」：值为 undefined 的键会让 js-yaml 直接抛
   *（writePaperFile 必经之路，后端真崩过一次）。
   */
  check(
    '可选键缺省时不写出来',
    deck !== undefined && !('note' in deck.slides[0]) && !('source' in deck.slides[0])
  )
  check('演示稿能过 js-yaml 序列化', (() => {
    try {
      matter.stringify('正文\n', { slides: deck })
      return true
    } catch {
      return false
    }
  })())

  /* ---- 具体例子页：讲解系统最有用的一页，不能只有抽象要点 ---- */
  const withExample = normalizeSlideDeck({
    slides: [
      mkSlide('拿一道题走一遍', ['看它怎么处理'], {
        example: { input: '一道多跳问题', steps: ['取检索片段', '拼进 prompt'], output: '带出处的答案' }
      }),
      mkSlide('只有例子没有要点', [], {
        example: { input: '一个场景', steps: ['第一步', '第二步'] }
      }),
      mkSlide('c'),
      mkSlide('d')
    ]
  })
  check('具体例子被解析出来', withExample?.slides[0].example?.steps.length === 2)
  check(
    '只有例子、没有要点也保留（这一页的价值就在例子）',
    withExample?.slides[1].example?.input === '一个场景' && withExample?.slides[1].bullets.length === 0
  )
  check(
    '步骤不足两步不算「走了一遍」，整块丢掉',
    normalizeSlideDeck({
      slides: [
        mkSlide('a', ['x'], { example: { input: 'i', steps: ['只有一步'] } }),
        mkSlide('b'),
        mkSlide('c'),
        mkSlide('d')
      ]
    })?.slides[0].example === undefined
  )
  check(
    '例子缺 input 也算废',
    normalizeSlideDeck({
      slides: [
        mkSlide('a', ['x'], { example: { input: '  ', steps: ['一', '二'] } }),
        mkSlide('b'),
        mkSlide('c'),
        mkSlide('d')
      ]
    })?.slides[0].example === undefined
  )

  /* ---- 原文图页 ---- */
  const withFigure = normalizeSlideDeck({
    slides: [
      mkSlide('看图上的三个模块', ['看右下角怎么连'], { visual: 'figure', figure: 'figures/p1/fig-2.png' }),
      mkSlide('b'),
      mkSlide('c'),
      mkSlide('d')
    ]
  })
  check('原文图页保留路径', withFigure?.slides[0].figure === 'figures/p1/fig-2.png')
  check(
    '点名 figure 却没给路径 → 退回普通页（要点留着，别整页丢）',
    (() => {
      const d = normalizeSlideDeck({
        slides: [mkSlide('a', ['x'], { visual: 'figure' }), mkSlide('b'), mkSlide('c'), mkSlide('d')]
      })
      return d?.slides[0].visual === undefined && d?.slides[0].bullets.length === 1
    })()
  )

  /*
   * 图纸降级：visual 是模型点名的，但那些画面是**别处**产出的 —— 流程图来自
   * 方法维度那次精读，原文图来自用户自己截的图，都可能压根不存在。
   */
  const noVisual = pruneSlideVisuals(deck!, { flow: false, mindmap: false, figures: [] })
  check(
    '库里没有流程图 → 只有画面的那页被摘掉（留着就是对着空屏发愣）',
    noVisual.slides.every((s) => s.title !== '方法流程') && noVisual.slides.length === 3
  )
  check(
    '有流程图 → 保留 visual',
    pruneSlideVisuals(deck!, { flow: true, mindmap: false, figures: [] }).slides[2].visual === 'flow'
  )
  check('降级不动别的页', noVisual.slides[1].title === '问题难在哪')

  const flowWithBullets = normalizeSlideDeck({
    slides: [
      mkSlide('方法流程', ['看左下角那块怎么连'], { visual: 'flow' }),
      mkSlide('b'),
      mkSlide('c'),
      mkSlide('d')
    ]
  })
  check(
    '画面页带着要点时只摘画面，要点留着（还能讲）',
    (() => {
      const d = pruneSlideVisuals(flowWithBullets!, { flow: false, mindmap: false, figures: [] })
      return d.slides[0].visual === undefined && d.slides[0].bullets.length === 1
    })()
  )
  check(
    '图不在库里 → figure 页降级（连路径一起摘掉，免得渲染时裂图）',
    (() => {
      const p = pruneSlideVisuals(withFigure!, {
        flow: false,
        mindmap: false,
        figures: ['figures/p1/fig-9.png']
      })
      return p.slides[0].visual === undefined && p.slides[0].figure === undefined
    })()
  )
  check(
    '图在库里 → 保留 visual 与路径',
    (() => {
      const p = pruneSlideVisuals(withFigure!, {
        flow: false,
        mindmap: false,
        figures: ['figures/p1/fig-2.png']
      })
      return p.slides[0].visual === 'figure' && p.slides[0].figure === 'figures/p1/fig-2.png'
    })()
  )

  const withExtras = normalizeSlideDeck({
    slides: [
      mkSlide('a', ['x'], { note: '口播讲稿', source: '§3.2' }),
      mkSlide('b', ['y'], { visual: 'mindmap' }),
      mkSlide('c'),
      mkSlide('d')
    ]
  })
  const prunedExtras = pruneSlideVisuals(withExtras!, { flow: false, mindmap: false, figures: [] })
  check(
    '降级保留讲稿与出处',
    prunedExtras.slides[0].note === '口播讲稿' && prunedExtras.slides[0].source === '§3.2'
  )
  check('思维导图页同样会被降级', prunedExtras.slides[1].visual === undefined)
  check(
    '降级不丢具体例子（例子是文字，和画面无关）',
    (() => {
      const d = normalizeSlideDeck({
        slides: [
          mkSlide('a', [], { visual: 'flow', example: { input: 'i', steps: ['一', '二'] } }),
          mkSlide('b'),
          mkSlide('c'),
          mkSlide('d')
        ]
      })
      return pruneSlideVisuals(d!, { flow: false, mindmap: false, figures: [] }).slides[0].example !== undefined
    })()
  )
  check('降级后仍可序列化', (() => {
    try {
      matter.stringify('正文\n', { slides: noVisual })
      return true
    } catch {
      return false
    }
  })())

  /* ---- 必须有画面上台（模型经常忘，纯文字演示等于把论文念一遍） ---- */
  const noFlowDeck = normalizeSlideDeck({
    slides: [
      mkSlide('为什么值得听'),
      mkSlide('问题难在哪'),
      mkSlide('我们的方法'),
      mkSlide('关键证据'),
      mkSlide('一句话总结')
    ]
  })
  const flowed = ensureVisualSlides(noFlowDeck!, { flow: true, mindmap: false })
  check('模型忘了安排流程图 → 兜底补一页', flowed.slides.some((s) => s.visual === 'flow'))
  check(
    '补的那页插在「讲方法」之后（刚听完文字，正是该看图的时候）',
    flowed.slides[3].visual === 'flow' && flowed.slides[2].title === '我们的方法'
  )
  check(
    '有流程图时不再补思维导图（两张图挤在一起反而乱）',
    flowed.slides.filter((s) => s.visual).length === 1
  )
  check(
    '一张图都凑不出来 → 用思维导图补一页当路标（放在开场之后）',
    (() => {
      const d = ensureVisualSlides(noFlowDeck!, { flow: false, mindmap: true })
      return d.slides.length === 6 && d.slides[1].visual === 'mindmap'
    })()
  )
  check(
    '两张图都没有就不补（没有画面可用）',
    ensureVisualSlides(noFlowDeck!, { flow: false, mindmap: false }).slides.length === 5
  )
  check(
    '已经有画面页就不再补思维导图',
    ensureVisualSlides(deck!, { flow: false, mindmap: true }).slides.filter((s) => s.visual).length === 1
  )
  check(
    '已经有 flow 页就不重复补',
    ensureVisualSlides(deck!, { flow: true, mindmap: false }).slides.filter((s) => s.visual === 'flow')
      .length === 1
  )
  check(
    '兜底页不超页数上限',
    ensureVisualSlides(noFlowDeck!, { flow: true, mindmap: true }).slides.length <= 16
  )

  /* ---- 旧版讲稿页里内嵌的自画流程图（revision 3 起不再产出，读旧稿仍要认） ---- */
  const ownFlow = normalizeSlideDeck({
    slides: [
      mkSlide('系统怎么跑', [], {
        flow: {
          title: '处理管线',
          nodes: [
            { id: 'n1', label: '读入输入' },
            { id: 'n2', label: '检索候选' }
          ],
          edges: [{ from: 'n1', to: 'n2' }]
        }
      }),
      mkSlide('b'),
      mkSlide('c'),
      mkSlide('d')
    ]
  })
  check('自带的流程图被解析出来', ownFlow?.slides[0].flow?.nodes.length === 2)
  check(
    '有自带流程图就等同于点名了 flow 页（不必再多写一个 visual 字段）',
    ownFlow?.slides[0].visual === 'flow'
  )
  check(
    '画不成图（不足两个节点）就当没有，不写这个键',
    normalizeSlideDeck({
      slides: [
        mkSlide('a', ['x'], { flow: { nodes: [{ id: 'n1', label: '只有一步' }] } }),
        mkSlide('b'),
        mkSlide('c'),
        mkSlide('d')
      ]
    })?.slides[0].flow === undefined
  )
  check(
    '自带的图不受「笔记里没有流程图」影响（它是这一页自己的内容）',
    pruneSlideVisuals(ownFlow!, { flow: false, mindmap: false, figures: [] }).slides[0].flow?.nodes
      .length === 2
  )
  check(
    '自带流程图不会被兜底逻辑重复插一页',
    ensureVisualSlides(ownFlow!, { flow: true, mindmap: true }).slides.filter((s) => s.visual === 'flow')
      .length === 1
  )

  /* ---- 版本号：界面靠它认出「手里这份是旧版生成的稿」 ---- */
  check(
    '版本号会被沿用（读盘时补写，就等于把旧稿当成新稿）',
    normalizeSlideDeck({
      slides: [mkSlide('a'), mkSlide('b'), mkSlide('c'), mkSlide('d')],
      revision: 2
    })?.revision === 2
  )
  check('没写版本号的旧稿读出来就没有这个键', deck?.revision === undefined)
  check(
    '摘掉画面后什么都不剩的页被丢掉（只剩标题对着空屏最让人发愣）',
    (() => {
      const d = normalizeSlideDeck({
        slides: [mkSlide('空画面页', [], { visual: 'flow' }), mkSlide('b'), mkSlide('c'), mkSlide('d')]
      })
      return pruneSlideVisuals(d!, { flow: false, mindmap: false, figures: [] }).slides.every(
        (s) => s.title !== '空画面页'
      )
    })()
  )
  check('自带流程图能过 js-yaml 序列化', (() => {
    try {
      matter.stringify('正文\n', { slides: ownFlow })
      return true
    } catch {
      return false
    }
  })())

  /*
   * 流程图专职 agent（revision 3）：画图从讲稿调用里拆出来，单独一次调用。
   * 起因是真实故障 —— 讲稿 agent 被告知「可用画面」恒为空（availability 读错了
   * 索引行），整份演示一张图都没有；顺带把「长 JSON 尾巴上顺手画图」这条最弱的
   * 路径整个撤掉。这里锁的是拆分后的边界：讲稿 prompt 不再邀请模型画图。
   */
  check(
    '讲稿 prompt 不再让模型自己画流程图（画图归专职 agent）',
    !SLIDES_SYSTEM.includes('你自己照着原文画')
  )
  const slidesUser = buildSlidesUser({
    title: '一篇论文',
    year: 2026,
    venue: 'NeurIPS',
    categories: ['效率'],
    sourceText: '正文',
    noteExcerpt: '',
    stage: { hasFlow: false, hasMindmap: true, figures: [] }
  })
  check(
    '输出 JSON 的示例里不再有 flow 键（免得模型照着学）',
    !slidesUser.includes('"flow":')
  )
  check('没有流程图时把「画不出」如实告诉模型，而不是只说「没有」', slidesUser.includes('画不出'))
  check(
    'flow 的 system prompt 保留「画不出就返回 null」的出口（防硬编假流程）',
    METHOD_FLOW_SYSTEM.includes('flow 返回 null')
  )
  const flowUser = buildMethodFlowUser({ title: 'Jev-Mem', sourceText: '方法正文正文' })
  check('flow 的输入带上标题与正文', flowUser.includes('Jev-Mem') && flowUser.includes('方法正文正文'))
  check(
    '包装形状 { flow: … } 取出本体',
    (() => {
      const body = { nodes: [{ id: 'n1', label: 'a' }] }
      return pickFlowPayload({ flow: body }) === body
    })()
  )
  check('模型直接吐 flow 对象时原样认下', (() => {
    const body = { nodes: [] }
    return pickFlowPayload(body) === body
  })())
  check('flow: null 传出去是 null（normalizeMethodFlow 会转成 undefined）', pickFlowPayload({ flow: null }) === null)
  check(
    '取出的本体直接喂 normalizeMethodFlow 能画成图',
    normalizeMethodFlow(
      pickFlowPayload({
        flow: {
          title: '写入流程',
          nodes: [
            { id: 'n1', label: '读入输入' },
            { id: 'n2', label: '挂上记忆图', source: '§3.2' }
          ],
          edges: [{ from: 'n1', to: 'n2' }]
        }
      })
    )?.nodes.length === 2
  )

  /* ---- 原文图的引用上下文（模型看不到图，只剩这条线索） ---- */
  const refs = scanFigureReferences({
    具体例子: '先看整体框架：\n\n![原文图表](../figures/p1/fig-1.png)\n\n左边是编码器。',
    方法细节: '![原文图表](../figures/p1/fig-1.png)'
  })
  check('扫出笔记里引用的原文图', refs.length === 1 && refs[0].relPath === 'figures/p1/fig-1.png')
  check('带上它出现在哪一节', refs[0].section === '具体例子')
  check(
    '带上图前后的文字（模型判断这张图画什么的唯一线索）',
    refs[0].excerpt.includes('整体框架') && refs[0].excerpt.includes('左边是编码器')
  )
  eq(
    '路径统一成相对知识库根（笔记被挪过目录也不失效）',
    vaultFigurePathOf('../../figures/p1/fig-3.png'),
    'figures/p1/fig-3.png'
  )
  check('外部地址不认（http / data 交给浏览器）', vaultFigurePathOf('https://x.com/a.png') === null)
  check('没有图的章节扫不出东西', scanFigureReferences({ 自由笔记: '纯文字' }).length === 0)

  /* ---------------- 25. 论文关系：手工连接的数据层 ---------------- */
  console.log('')
  console.log('── 25. 论文关系：容错 / 去重 / 优先级 ────────')

  const link = (
    to: string,
    type = 'related',
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> => ({ to, type, ...extra })

  eq(
    '正常一条原样通过',
    normalizeLinks([link('p2', 'builds-on', { note: '改进了它的检索环节', by: 'user' })], 'p1'),
    [{ to: 'p2', type: 'builds-on', by: 'user', note: '改进了它的检索环节' }]
  )
  check(
    '不认识的类型收敛成「相关」，而不是把这条关系丢掉',
    normalizeLinks([link('p2', 'zzz')], 'p1')[0]?.type === 'related'
  )
  check('缺类型的也收敛成「相关」', normalizeLinks([link('p2', '')], 'p1')[0]?.type === 'related')
  check('指向自己的关系丢掉（A→A 是个环，没有信息）', normalizeLinks([link('p1', 'related')], 'p1').length === 0)
  check('缺 to 的条目丢掉', normalizeLinks([link('', 'related')], 'p1').length === 0)
  check('同一对 + 同一类型只留一条', normalizeLinks([link('p2'), link('p2')], 'p1').length === 1)
  check(
    '同一对但类型不同算两条（基于 / 结论冲突可以并存）',
    normalizeLinks([link('p2', 'builds-on'), link('p2', 'contradicts')], 'p1').length === 2
  )
  check(
    '同一对同类型时，人手工的那条优先（AI 提议不许覆盖你的判断）',
    (() => {
      const aiFirst = normalizeLinks(
        [link('p2', 'related', { by: 'ai', note: 'AI 说的' }), link('p2', 'related', { by: 'user', note: '我说的' })],
        'p1'
      )
      const userFirst = normalizeLinks(
        [link('p2', 'related', { by: 'user', note: '我说的' }), link('p2', 'related', { by: 'ai', note: 'AI 说的' })],
        'p1'
      )
      return aiFirst[0]?.note === '我说的' && userFirst[0]?.note === '我说的'
    })()
  )
  check(
    '人手工建立的排在前面（AI 提议是待办，别挤掉已确认的）',
    (() => {
      const list = normalizeLinks([link('p3', 'related', { by: 'ai' }), link('p9', 'related', { by: 'user' })], 'p1')
      return list[0]?.to === 'p9' && list[1]?.to === 'p3'
    })()
  )
  check(
    'note / evidence 超长会截断',
    (() => {
      const list = normalizeLinks([link('p2', 'related', { note: 'x'.repeat(999), evidence: 'y'.repeat(999) })], 'p1')
      return (list[0]?.note?.length ?? 0) === 200 && (list[0]?.evidence?.length ?? 0) === 300
    })()
  )
  check('条数有上限（防脏数据把 frontmatter 撑爆）', (() => {
    const many = Array.from({ length: 60 }, (_, i) => link(`p${i}`, 'related'))
    return normalizeLinks(many, 'p1').length === 40
  })())
  check('非数组输入返回空（模型偶尔会吐出奇怪的东西）', normalizeLinks('nope').length === 0)
  check('元素不是对象也不炸', normalizeLinks([null, 3, 'x', link('p2')], 'p1').length === 1)
  check(
    '没有可选键时键就不出现（js-yaml 序列化安全）',
    (() => {
      const one = normalizeLinks([link('p2', 'related')], 'p1')[0]
      return one !== undefined && !('note' in one) && !('evidence' in one) && !('at' in one)
    })()
  )
  check('关系键能区分同目标不同类型', linkKey({ to: 'p2', type: 'builds-on' }) !== linkKey({ to: 'p2', type: 'contradicts' }))

  /* ---------------- 26. 关系判定：数据给候选，模型负责说不 ---------------- */
  console.log('')
  console.log('── 26. 关系判定（AI 找关系） ──────────────')

  check('system 要求合法 JSON（否则解析链会抛）', LINKS_SYSTEM.includes('合法 JSON'))
  check(
    'system 把「不确定就判不成立」写成第一条规则',
    LINKS_SYSTEM.includes('不确定就判不成立'),
    '这是这个 agent 的核心：宁可漏，不要错'
  )
  check(
    'system 要求依据必须指着具体东西（防「高度相关」这类空话）',
    LINKS_SYSTEM.includes('具体东西') && LINKS_SYSTEM.includes('空话')
  )

  const judgeFrom = {
    title: 'GraphRAG: 用图结构做检索',
    year: 2025,
    venue: 'ACL',
    tldr: '把知识图谱接进 RAG 的检索环节',
    digest: '【方法细节】\n用实体图做多跳检索，代价是索引很重。'
  }
  const judgeTo = {
    title: 'LightRAG: 轻量图检索',
    year: 2024,
    tldr: '用双层图索引降低图检索的成本',
    digest: '【局限与未来工作】\n没处理跨语言场景。'
  }

  const judgePrompt = buildLinkJudgePrompt({
    from: judgeFrom,
    to: judgeTo,
    shared: ['HotpotQA', 'Recall@10'],
    existing: ['对比 / 竞争（你已确认）']
  })
  check(
    'prompt 带上两篇的标题',
    judgePrompt.includes(judgeFrom.title) && judgePrompt.includes(judgeTo.title)
  )
  check(
    'prompt 带上数据判定出的共享要素',
    judgePrompt.includes('HotpotQA') && judgePrompt.includes('Recall@10')
  )
  check(
    'prompt 说清共享要素只是「值得看」，不是关系成立的证据',
    judgePrompt.includes('不构成关系成立的证据'),
    '否则模型会把「共享一个数据集」直接当成关系'
  )
  check(
    'prompt 列出全部六种关系类型（只能从词表选）',
    LINK_TYPES.every((t) => judgePrompt.includes(`\`${t}\``))
  )
  check('prompt 带上已有关系（避免重复提议）', judgePrompt.includes('对比 / 竞争（你已确认）'))
  check(
    '候选没精读过时明说「不要臆测」',
    buildLinkJudgePrompt({
      from: judgeFrom,
      to: { ...judgeTo, digest: '', tldr: '' },
      shared: ['X']
    }).includes('不要臆测')
  )

  eq(
    '合法判定原样通过',
    normalizeVerdict({
      ok: true,
      type: 'builds-on',
      note: '承接了它的检索环节',
      evidence: '两篇都在做图检索的多跳'
    }),
    {
      ok: true,
      type: 'builds-on',
      evidence: '两篇都在做图检索的多跳',
      note: '承接了它的检索环节'
    }
  )
  check(
    '判不成立时带上理由（只用于日志，不落盘）',
    normalizeVerdict({ ok: false, reason: '只是一起用了同一个数据集' }).ok === false
  )
  check(
    '类型不在词表里 → 当不成立',
    normalizeVerdict({ ok: true, type: 'seems-related', evidence: 'x' }).ok === false,
    '宁缺勿滥：说不清的线不进图'
  )
  check('没给依据 → 当不成立', normalizeVerdict({ ok: true, type: 'builds-on' }).ok === false)
  check(
    '模型把字段写成 relation 也认（保底兼容）',
    normalizeVerdict({ relation: true, type: 'inspires', evidence: 'x' }).ok
  )
  check(
    '没给 note 时键就不出现（js-yaml 序列化安全）',
    (() => {
      const verdict = normalizeVerdict({ ok: true, type: 'related', evidence: 'x' })
      return verdict.ok && !('note' in verdict)
    })()
  )
  check(
    '模型包在代码块里返回也能解析（走 extractJson）',
    (() => {
      const verdict = normalizeVerdict(
        extractJson('```json\n{"ok": true, "type": "contradicts", "note": "n", "evidence": "e"}\n```')
      )
      return verdict.ok && verdict.type === 'contradicts'
    })()
  )

  const proposed = verdictToLink(
    normalizeVerdict({ ok: true, type: 'inspires', note: '可搬', evidence: '§4.2' }),
    'p2',
    '2026-09-25T00:00:00.000Z'
  )
  check(
    '判定成立 → 写成 by:ai 的提议（要人确认才算数）',
    proposed?.by === 'ai' && proposed.to === 'p2' && proposed.type === 'inspires'
  )
  check('不成立的判定不产生链接', verdictToLink({ ok: false }, 'p2', 'now') === null)
  check(
    '提议经落盘规整后仍带 by:ai、依据与那句人话',
    (() => {
      const kept = normalizeLinks([proposed], 'p1')[0]
      return kept?.by === 'ai' && kept.evidence === '§4.2' && kept.note === '可搬'
    })()
  )

  const digest = pickLinkDigest({
    一句话总结: '- 只该出现在 tldr 里',
    核心问题与动机: '- **要解决什么问题**：图检索太贵，得把索引成本压下来',
    方法细节: '- 双层图索引：先用实体级图粗筛，再用段落级图精排，成本降到 1/5',
    '写作手法 · Abstract': '- 不该被喂给关系判定（那是写作维度的事）',
    局限与未来工作: '   ',
    可迁移到我的研究: 'x'
  })
  check(
    'digest 只挑与关系判断有关的章节',
    digest.includes('双层图索引') && !digest.includes('写作手法')
  )
  check(
    'digest 跳过空白与过短的章节',
    !digest.includes('局限与未来工作') && !digest.includes('可迁移到我的研究')
  )
  check('一句话总结不由 digest 负责（它单独走 tldr）', !digest.includes('只该出现在 tldr 里'))
  check('超长章节会被截断', pickLinkDigest({ 方法细节: 'x'.repeat(2000) }).includes('后略'))

  /* ---------------- 27. 研究想法：从已确认的关系组合出可验证的题目 ---------------- */
  console.log('')
  console.log('── 27. 研究想法（组合原料与题目约束） ──────')

  const ideaPaper = (id: string, title: string, extra: Partial<IdeaSeedPaper> = {}): IdeaSeedPaper => ({
    id,
    title,
    year: 2024,
    tldr: `${title} 的一句话总结`,
    method: '把检索环节换成图结构：先用实体图粗筛，再用段落图精排。',
    limitation: '没处理跨语言场景，中文检索效果未知。',
    transferable: '它的粗筛思路可以搬到长文摘要的排序上。',
    ...extra
  })
  const confirmed = (to: string, type: PaperLinkType, note?: string): PaperLink => ({
    to,
    type,
    by: 'user',
    ...(note ? { note } : {})
  })

  const seedInput: IdeaSeedPaper[] = [
    ideaPaper('p1', 'GraphRAG', {
      links: [
        confirmed('p2', 'builds-on', '承接了它的检索环节'),
        // AI 提议不算数：想法要站在你自己确认过的判断上
        { to: 'p3', type: 'inspires', by: 'ai' }
      ]
    }),
    ideaPaper('p2', 'LightRAG', { links: [confirmed('p1', 'contradicts')] }),
    // 两边都没写下任何原料 → 不生成（省一次调用，也免得得到正确的废话）
    ideaPaper('p3', 'EmptyNote', {
      method: '',
      limitation: '',
      transferable: '',
      links: [confirmed('p4', 'inspires')]
    }),
    ideaPaper('p4', 'AlsoEmpty', { method: '', limitation: '', transferable: '' })
  ]
  const seeds = buildIdeaSeeds(seedInput)
  check('一对论文只出一条组合单元（两个方向算同一对）', seeds.length === 1, `seeds=${seeds.length}`)
  check('AI 提议的关系不参与组合', seeds[0]?.relations.every((r) => r.type !== 'inspires'))
  check(
    'from 固定取 id 小的那篇（同样的库跑两次得到同一份文档）',
    seeds[0]?.from.id === 'p1' && seeds[0]?.to.id === 'p2'
  )
  check(
    '两个方向的关系都收进同一条，并标出方向',
    seeds[0]?.relations.length === 2 &&
      seeds[0].relations.some((r) => r.direction === 'out' && r.type === 'builds-on') &&
      seeds[0].relations.some((r) => r.direction === 'in' && r.type === 'contradicts')
  )
  check(
    '两边都没写原料的关系不生成（空笔记上长不出题目）',
    !seeds.some((s) => s.from.id === 'p3' || s.to.id === 'p3')
  )

  const rankedSeeds = buildIdeaSeeds([
    ideaPaper('p1', 'A', { links: [confirmed('p2', 'builds-on')] }),
    ideaPaper('p2', 'B'),
    ideaPaper('p5', 'C', { links: [confirmed('p6', 'contradicts')] }),
    ideaPaper('p6', 'D')
  ])
  check(
    '「结论冲突」排在「基于/改进」前面（更容易长成题目）',
    rankedSeeds[0]?.from.id === 'p5',
    rankedSeeds.map((s) => s.from.id).join(',')
  )
  check(
    '一次组合的条数有上限',
    buildIdeaSeeds(seedInput.concat(rankedSeeds.flatMap((s) => [s.from, s.to])), 1).length === 1
  )

  const ideaPrompt = buildIdeaPrompt(seeds[0])
  check(
    'prompt 带上两篇的标题与年份',
    ideaPrompt.includes('GraphRAG') && ideaPrompt.includes('LightRAG')
  )
  check(
    'prompt 带上关系类型与你自己写下的那句理由',
    ideaPrompt.includes('基于 / 改进') && ideaPrompt.includes('承接了它的检索环节')
  )
  check(
    'prompt 把「最小验证实验」与「反证条件」写成必填项',
    ideaPrompt.includes('最小验证实验') && ideaPrompt.includes('反证条件')
  )
  check(
    'prompt 带上实验画像（最小实验可以直接借用）',
    (() => {
      const withExp = buildIdeaSeeds([
        ideaPaper('p9', 'Exp', {
          exp: { ...emptyExperimentProfile(), datasets: ['HotpotQA'], baselines: ['DPR'], metrics: ['EM'] },
          links: [confirmed('p10', 'inspires')]
        }),
        ideaPaper('p10', 'Exp2')
      ])
      const prompt = buildIdeaPrompt(withExp[0])
      return prompt.includes('HotpotQA') && prompt.includes('DPR') && prompt.includes('实验设置')
    })()
  )
  check(
    '没写的章节明说「不要臆测」（留白会让模型自己编）',
    (() => {
      const thin = buildIdeaSeeds([
        ideaPaper('p11', 'Thin', { limitation: '', transferable: '', links: [confirmed('p12', 'inspires')] }),
        ideaPaper('p12', 'Thin2')
      ])
      return buildIdeaPrompt(thin[0]).includes('（没写，不要臆测）')
    })()
  )
  check('system 要求合法 JSON', IDEAS_SYSTEM.includes('合法 JSON'))
  check(
    'system 把「无法反证就不是题目」写进第一条规则',
    IDEAS_SYSTEM.includes('无法反证的方向不是题目'),
    '这是这个 agent 存在的意义：抵抗听起来很美'
  )

  eq(
    '完整的想法原样通过',
    normalizeIdea({
      ok: true,
      title: '把图检索的粗筛接到长文摘要上',
      hypothesis: '用实体图做粗筛能提升长文摘要的召回',
      why: '长文摘要的瓶颈在候选太长',
      minimalTest: '在 HotpotQA 上换掉粗筛层，比 DPR 基线看 EM',
      falsify: 'EM 相对基线没有提升（±0.5 以内）就说明粗筛没起作用',
      risk: '需要先有实体图'
    }),
    {
      ok: true,
      title: '把图检索的粗筛接到长文摘要上',
      hypothesis: '用实体图做粗筛能提升长文摘要的召回',
      minimalTest: '在 HotpotQA 上换掉粗筛层，比 DPR 基线看 EM',
      falsify: 'EM 相对基线没有提升（±0.5 以内）就说明粗筛没起作用',
      why: '长文摘要的瓶颈在候选太长',
      risk: '需要先有实体图'
    }
  )
  check(
    '缺反证条件 → 当不成立（方向不是题目）',
    (() => {
      const idea = normalizeIdea({ ok: true, title: 't', hypothesis: 'h', minimalTest: 'm' })
      return idea.ok === false && (idea.reason ?? '').includes('反证条件')
    })()
  )
  check(
    '缺最小验证实验 → 当不成立',
    normalizeIdea({ ok: true, title: 't', hypothesis: 'h', falsify: 'f' }).ok === false
  )
  check(
    '模型判不成立时保留理由（写进文档末尾，说明缺什么）',
    normalizeIdea({ ok: false, reason: 'B 的局限一节是空的，看不出要解决什么' }).reason ===
      'B 的局限一节是空的，看不出要解决什么'
  )
  check(
    '字段名换写法也认（minimal_test / counter）',
    normalizeIdea({ ok: true, title: 't', hypothesis: 'h', minimal_test: 'm', counter: 'f' }).ok
  )
  check(
    '没给 why / risk 时键就不出现（js-yaml 序列化安全）',
    (() => {
      const idea = normalizeIdea({ ok: true, title: 't', hypothesis: 'h', minimalTest: 'm', falsify: 'f' })
      return idea.ok && !('why' in idea) && !('risk' in idea)
    })()
  )

  const docIdea = {
    ok: true,
    title: '把图检索的粗筛接到长文摘要上',
    hypothesis: '用实体图做粗筛能提升长文摘要的召回',
    minimalTest: '在 HotpotQA 上换掉粗筛层，比 DPR 基线看 EM',
    falsify: 'EM 相对基线没有提升（±0.5 以内）'
  }
  const doc = renderIdeaDoc(
    [{ seed: seeds[0], idea: docIdea }],
    [{ seed: seeds[0], idea: { ok: false, reason: '材料只够写一句正确的话' } }],
    { at: '2026-09-25T00:00:00.000Z', confirmedLinks: 7 }
  )
  check('文档带上条目编号与四项内容', doc.includes('## 1. 把图检索的粗筛接到长文摘要上'))
  check('文档四个小节齐全', ['**假设**', '**最小验证实验**', '**反证条件**'].every((k) => doc.includes(k)))
  check(
    '来源与依据由数据渲染，不转述模型的话',
    doc.includes('GraphRAG') && doc.includes('LightRAG') && doc.includes('基于 / 改进') && doc.includes('承接了它的检索环节')
  )
  check('文档标出「只吃已确认的关系」（AI 提议不参与）', doc.includes('你确认过的'))
  check('没能组合的关系单列一节并写明缺什么', doc.includes('没能组合成题目的关系') && doc.includes('材料只够写一句正确的话'))
  check(
    '一条都没成时给出下一步（而不是留一份空文档）',
    renderIdeaDoc([], [], { at: 'now', confirmedLinks: 3 }).includes('没有组合出可验证的题目')
  )
  check('文档以换行收尾（Markdown 落盘惯例）', doc.endsWith('\n'))

  /* ---------------- 28. 组合分析：一组论文有没有组合创新的空间 ---------------- */
  console.log('')
  console.log('── 28. 组合分析（线索 / 判空 / 蓝图） ──────')

  const comboPaper = (id: string, title: string, extra: Partial<ComboPaper> = {}): ComboPaper => ({
    id,
    title,
    year: 2024,
    tldr: `${title} 做了什么`,
    method: '用双层图索引做检索：先实体级粗筛，再段落级精排。',
    limitation: '没处理跨语言场景。',
    // 必须真有内容（≥20 字）：太短会被数据侧当成「没写」，那是刻意的阈值
    transferable: '粗筛的思路可以搬到长文摘要的排序上，值得先在小样本上试一次。',
    ...extra
  })

  const members: ComboPaper[] = [
    comboPaper('c1', 'GraphRAG', {
      entities: [
        { name: 'HotpotQA', kind: 'dataset' },
        { name: 'EntityGraph', kind: 'method' },
        { name: '多模态', kind: 'concept' }
      ],
      exp: { ...emptyExperimentProfile(), datasets: ['HotpotQA'], metrics: ['EM'], baselines: ['DPR'] },
      links: [
        { to: 'c2', type: 'contradicts', by: 'user', note: '结论互相矛盾' },
        { to: 'zzz', type: 'related', by: 'user' }
      ]
    }),
    comboPaper('c2', 'LightRAG', {
      transferable: '',
      entities: [
        { name: 'HotpotQA', kind: 'dataset' },
        { name: '多模态', kind: 'concept' },
        { name: 'TwoLevelIndex', kind: 'method' }
      ],
      exp: { ...emptyExperimentProfile(), datasets: ['MuSiQue'], metrics: ['F1'], baselines: ['DPR'] }
    })
  ]

  const comboRelations = collectComboRelations(members)
  check(
    '组内关系只收成员之间的（指向组外的不算）',
    comboRelations.length === 1 && comboRelations[0].type === 'contradicts',
    `relations=${comboRelations.length}`
  )

  const signals = computeComboSignals(members)
  const signalKinds = new Set(signals.map((s) => s.kind))
  check(
    '共享的具体技术要素形成线索',
    signalKinds.has('shared-tech') && signals.some((s) => s.text.includes('HotpotQA'))
  )
  check('只有一篇用到的要素算互补原料', signalKinds.has('distinct-tech'))
  check(
    'concept 这类虚的要素不参与（否则「都关注 XX」也会变成线索）',
    !signals.some((s) => s.text.includes('多模态'))
  )
  check(
    '数据集错位形成线索',
    signals.some((s) => s.kind === 'experiment-gap' && s.text.includes('MuSiQue'))
  )
  check(
    '指标不一致形成线索（口径本身可能是个问题）',
    signals.some((s) => s.kind === 'experiment-gap' && s.text.includes('F1'))
  )
  check('共用基线形成线索', signals.some((s) => s.text.includes('共用基线')))
  check('组内结论冲突形成线索', signalKinds.has('conflict'))
  check(
    '只有真写了可迁移点的才进线索',
    (() => {
      const one = signals.find((s) => s.kind === 'transferable')?.text ?? ''
      return one.includes('GraphRAG') && !one.includes('LightRAG')
    })()
  )

  const comboPrompt = buildComboPrompt({ papers: members, relations: comboRelations, signals })
  check('prompt 带上每一篇的标题', members.every((p) => comboPrompt.includes(p.title)))
  check(
    'prompt 带上该组已有的关系与那句为什么',
    comboPrompt.includes('结论冲突') && comboPrompt.includes('结论互相矛盾')
  )
  check('prompt 明说线索不是创新空间的证据', comboPrompt.includes('不是创新空间的证据'))
  check(
    '组内没有关系时告诉模型「这不等于没有空间」',
    buildComboPrompt({ papers: members, relations: [], signals }).includes('还没有建立过任何关系')
  )
  check('system 允许判定「没有组合空间」', COMBO_SYSTEM.includes('允许说没有空间'))
  check(
    'system 禁止「把 A 与 B 结合」这类空话',
    COMBO_SYSTEM.includes('把 A 与 B 结合'),
    '组合必须落到具体机制上'
  )
  check('system 要求合法 JSON', COMBO_SYSTEM.includes('合法 JSON'))

  const fullCombo = normalizeCombo({
    space: 'promising',
    verdict: '两篇的索引层可以互换',
    angles: [
      {
        title: '把粗筛换成实体图',
        hypothesis: 'h',
        why: 'w',
        from: ['GraphRAG'],
        minimalTest: 'm',
        falsify: 'f'
      }
    ],
    composite: { title: 'ct', contribution: 'c', skeleton: 's', experiments: 'e', missing: 'mx' }
  })
  check(
    '完整结果原样通过',
    fullCombo.ok && fullCombo.space === 'promising' && fullCombo.angles.length === 1 && !!fullCombo.composite
  )
  check(
    '角度缺反证条件就被丢掉（与「研究想法」同一把尺子）',
    normalizeCombo({ angles: [{ title: 't', hypothesis: 'h', minimalTest: 'm' }] }).ok === false
  )
  check(
    '既没角度也没蓝图 → 当没有空间，并给出理由',
    (() => {
      const result = normalizeCombo({ space: 'promising', verdict: 'v' })
      return result.ok === false && !!result.reason
    })()
  )
  check(
    '蓝图缺「还缺什么」就不算蓝图（那一行通常比结论更有用）',
    normalizeCombo({
      angles: [],
      composite: { title: 't', contribution: 'c', skeleton: 's', experiments: 'e' }
    }).ok === false
  )
  check(
    '认不出的 space 不硬塞',
    normalizeCombo({
      space: 'maybe',
      angles: [{ title: 't', hypothesis: 'h', minimalTest: 'm', falsify: 'f' }]
    }).space === undefined
  )
  check('模型返回垃圾不崩', normalizeCombo(null).ok === false)

  const comboDoc = renderComboDoc({
    papers: members,
    relations: comboRelations,
    signals,
    analysis: fullCombo,
    at: '2026-09-25T00:00:00.000Z'
  })
  check('文档标题列出成员', comboDoc.startsWith('# 组合分析：') && comboDoc.includes('GraphRAG'))
  check(
    '文档带总判断与空间评价',
    comboDoc.includes('两篇的索引层可以互换') && comboDoc.includes('有值得做的地方')
  )
  check(
    '角度四项齐全',
    ['**假设**', '**最小验证实验**', '**反证条件**'].every((k) => comboDoc.includes(k))
  )
  check(
    '组合论文分析单独成节并写明还缺什么',
    comboDoc.includes('如果把它们合成一篇') && comboDoc.includes('**还缺什么**')
  )
  check(
    '关系与线索单列，并标注线索不是创新空间',
    comboDoc.includes('结论冲突') && comboDoc.includes('不是创新空间')
  )
  check(
    '没有空间时给出下一步（而不是一份空文档）',
    renderComboDoc({
      papers: members,
      relations: [],
      signals: [],
      analysis: { ok: false, angles: [], reason: '它们是同一条赛道的不同实现' },
      at: 'now'
    }).includes('这次没有找到可做的组合角度')
  )
  check('文档以换行收尾', comboDoc.endsWith('\n'))

  console.log('')
  console.log(`${pass}/${pass + fail} 通过`)
  if (fail) process.exitCode = 1
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
