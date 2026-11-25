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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatCompletion, extractJson, LlmError } from '../src/main/llm'
import {
  buildRunRecord,
  LENS_TOKEN_CEILING,
  lensNote,
  lensTokenBudget,
  mergeRunRecord,
  summarizeOutcomes,
  type LensRunOutcome
} from '../src/main/lenses/run'
import { baseLensContext, evidenceSnippets, sectionRequirements, sourceBlock } from '../src/main/lenses/types'
import { methodDetailLens } from '../src/main/lenses/methodDetail'
import { englishLens } from '../src/main/lenses/english'
import { normalizePaperText, prepareLlmSource } from '../src/main/papertext'
import { blankPaperMeta, readPaperFile, writePaperFile } from '../src/main/vault'
import { parseEnvFile } from '../src/main/settings'
import type { LlmSettings, PaperMeta } from '@shared/types'
import { emptyExperimentProfile, normalizeExperimentProfile, profileCompleteness } from '@shared/experiment'
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
  demoteEmbeddedHeadings,
  emptySections,
  isAiFilled,
  isSectionFilled,
  parsePaperBody,
  renderPaperBody,
  SECTION_GROUP_ORDER,
  SECTION_ORDER,
  sectionGroup,
  sectionSpec
} from '@shared/template'
import { extractPhraseCandidates } from '@shared/phrases'
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
import { layoutMethodFlow, normalizeMethodFlow } from '@shared/flow'
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
import { getLens } from '../src/main/lenses'
import {
  AUTO_HIGHLIGHT_SYSTEM,
  buildAutoHighlightUser,
  kindSystem
} from '../src/main/agents/autohighlight'
import { buildPassageInstruction, buildPassageSystem } from '../src/main/agents/passage'
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
  /*
   * 老清单里已下线的维度（graph）不再属于 LensId，迁移自然不会带上它 ——
   * 所以对标的不是 LEGACY_DEFAULT 的长度，而是「老清单里还存在的那几个」。
   */
  const legacyStillExists = LEGACY_DEFAULT.filter((id) => allLensIds().includes(id as LensId))
  check(
    '老配置全关时，迁移后仍在的老维度全关',
    migratedAllOff.length === legacyStillExists.length,
    `${migratedAllOff.length}/${legacyStillExists.length}`
  )
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

  /* ---------------- 11b. 实验清单（论证链） ---------------- */
  console.log('')
  console.log('── 11b. 实验清单：主实验 / 消融 / 分析 ─────')

  const rows = normalizeExperimentProfile({
    experiments: [
      { kind: 'main', claim: '整体更强', setup: 'HotpotQA × DPR', result: 'F1 +3.2', conclusion: '方法有效' },
      { kind: '消融', claim: '检索模块有必要', setup: '去掉检索', result: 'F1 −8.1', conclusion: '组件都必要' },
      { 类别: 'analysis', 验证: '中文也适用', 设置: '中文测试集', 结果: '持平', 结论: '可迁移' }
    ]
  }).experiments
  check('抽出 3 条', rows.length === 3, `实际 ${rows.length}`)
  check('英文 kind 归一化', rows[0].kind === 'main', rows[0].kind)
  check('中文 kind 归一化', rows[1].kind === 'ablation', rows[1].kind)
  check(
    '中英混写的键名也能读',
    rows[2].claim === '中文也适用' && rows[2].conclusion === '可迁移',
    `${rows[2].claim} / ${rows[2].conclusion}`
  )
  check(
    '缺 kind 时归到「分析」而不是瞎猜',
    normalizeExperimentProfile({ experiments: [{ claim: 'x' }] }).experiments[0].kind === 'analysis'
  )
  check(
    '空壳行被丢弃（否则表格里出现成片空白）',
    normalizeExperimentProfile({
      experiments: [{ kind: 'main' }, { claim: '' }, { claim: '真内容' }]
    }).experiments.length === 1
  )
  check('非数组不崩', normalizeExperimentProfile({ experiments: 'main' }).experiments.length === 0)
  check(
    '超过 16 行被截断（与 prompt 里的上限对齐）',
    normalizeExperimentProfile({
      experiments: Array.from({ length: 30 }, (_, i) => ({ claim: `c${i}` }))
    }).experiments.length === 16
  )
  check(
    '老数据（没有这个字段）不崩',
    normalizeExperimentProfile({ datasets: ['A'] }).experiments.length === 0
  )
  check(
    '完整度：论证链权重最高（2 + 主实验 1 + 消融 1）',
    profileCompleteness(
      normalizeExperimentProfile({
        experiments: [{ kind: 'main', claim: 'a' }, { kind: 'ablation', claim: 'b' }]
      })
    ) === 4
  )
  check(
    '只做主实验也拿分（没做消融是常见且合理的情况）',
    profileCompleteness(normalizeExperimentProfile({ experiments: [{ kind: 'main', claim: 'a' }] })) === 3
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

  /*
   * 维度输出预算。真实事故：这里一度是 `Math.min(配置值, 维度值)`，
   * 于是 .env 里的 131072 变成死配置、每个维度只剩 2K~4K —— 强制思考的模型
   * 把预算全花在 reasoning 上，一篇 42 页论文 12 个维度里 9 个返回空内容、
   * 3 个被截断（同一批论文在预算放开时是 12 个全成）。
   */
  check('全局配置调小也不会压垮维度自己的体积预算', lensTokenBudget(4096, 2048) === 4096)
  check('全局配置更大时照用（推理模型的思考要从这里扣）', lensTokenBudget(4096, 131072) === LENS_TOKEN_CEILING)
  check('再大也不越过上限（给到 131072 会一路写到超时）', lensTokenBudget(2048, 999_999) === LENS_TOKEN_CEILING)
  check('没配全局预算时用维度自己的值', lensTokenBudget(3072, undefined) === 3072)
  check('上限要高于实测最长的维度输出（14,593）', LENS_TOKEN_CEILING > 14593, String(LENS_TOKEN_CEILING))

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

  /*
   * 同一个坑后来又踩了两次，都是「某个可选字段没值时顺手写成了 undefined」：
   * 图谱的 `aliases` / `evidence`、句式库的 `example` / `from`。
   * 代价完全一样：精读跑了十几分钟，落盘那一步整篇抛掉，笔记停在空骨架，
   * `last_run` 里只留一句看不出是哪个字段的「unacceptable kind of an object to dump」。
   * 所以从两头锁：产出数据的解析器不留 undefined 键，落盘本身也兜一层。
   */
  const hasUndefinedValue = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(hasUndefinedValue)
    if (value && typeof value === 'object') {
      return Object.entries(value).some(([, v]) => v === undefined || hasUndefinedValue(v))
    }
    return false
  }
  const canStringify = (data: Record<string, unknown>): boolean => {
    try {
      matter.stringify('正文', data)
      return true
    } catch {
      return false
    }
  }

  const phraseOut = englishLens.parse(
    {
      phrases: [
        { category: '报告结果', text: 'we observe that', usage: '报告一条实测结论' },
        {
          category: '认不出的分类',
          text: 'as shown in Fig. 3',
          usage: '指向图表',
          example: 'As shown in Fig. 3, …',
          from: 'Experiments'
        }
      ]
    },
    fakeCtx
  )
  const phraseData = (phraseOut.data as { phrases?: unknown[] } | undefined)?.phrases
  check('句式解析不留 undefined 键', !hasUndefinedValue(phraseData))
  check('没有例句的短语能过 js-yaml', canStringify({ phrases: phraseData }))
  check(
    '有例句的短语照常保留例句与出处',
    JSON.stringify(phraseData).includes('As shown in Fig. 3') && JSON.stringify(phraseData).includes('Experiments')
  )

  /*
   * 兜底那一层：故意塞一个值为 undefined 的键（模拟将来某个字段忘了处理），
   * 整篇笔记必须照常落盘，只丢掉那一个键。
   */
  const tempVault = mkdtempSync(join(tmpdir(), 'pv-yaml-'))
  try {
    const yamlMeta = blankPaperMeta({ title: '落盘兜底', authors: ['A'] })
    yamlMeta.graph = {
      entities: [{ name: 'LIBERO', kind: 'benchmark', aliases: undefined }],
      relations: []
    } as unknown as PaperMeta['graph']
    const written = writePaperFile(tempVault, yamlMeta, { 一句话总结: '正文' })
    const back = readPaperFile(written.absPath, tempVault)
    check('落盘兜底：值为 undefined 的键被丢掉，而不是整篇写不出去', back !== null)
    check(
      '其余字段与正文照常落盘',
      back?.meta.title === '落盘兜底' && back?.sections['一句话总结'] === '正文'
    )
  } finally {
    rmSync(tempVault, { recursive: true, force: true })
  }

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

  /* ---------------- 17b. 写作骨架：说清 > 说全 ---------------- */
  console.log('')
  console.log('── 17b. 写作骨架：说清 > 说全 ─────────────')

  /*
   * 起因：写作拆解产出「又长又抽象」—— 一节骨架挂着 5~7 个并列标签，每个标签下模型
   * 写一大段，读到的是一堆「结构清晰 / 层层递进」式的概括，而不是「这段在推哪一步」。
   * 骨架因此收窄成「一句话主线 + 逐段推进 + 一个本节特有角度 + 可复用句式」。
   * 下面这些断言钉的是收窄的效果：防止以后又加回一堆并列标签、或把句式收纳框弄丢。
   */
  const writingKeys = SECTION_ORDER.filter((k) => k.startsWith('写作手法'))
  /** 数骨架里有几个 `**标签**` —— 并列标签越多，模型越会为了填满它们凑字 */
  const labelCount = (text: string): number => [...text.matchAll(/\*\*(.+?)\*\*/g)].length

  check('五个写作章节都在', writingKeys.length === 5, writingKeys.join('、'))
  check(
    '每节都先要求「一句话主线」（写作逻辑先讲清楚）',
    writingKeys.every((k) => sectionSpec(k)?.scaffold.includes('一句话主线')),
    writingKeys.filter((k) => !sectionSpec(k)?.scaffold.includes('一句话主线')).join('、')
  )
  check(
    '每节最多 4 个标签',
    writingKeys.every((k) => labelCount(sectionSpec(k)?.scaffold ?? '') <= 4),
    writingKeys.map((k) => `${k.replace('写作手法 · ', '')}:${labelCount(sectionSpec(k)?.scaffold ?? '')}`).join('　')
  )
  check(
    '每节都留着「可复用句式」收纳框（句式库靠它抽）',
    writingKeys.every((k) => sectionSpec(k)?.scaffold.includes('可复用句式'))
  )
  /*
   * 贡献段是最常被读、也最常被抄的部分。只靠「逐段推进」的话，模型会把它
   * 压成一句「最后列出了三条贡献」—— 读者学不到任何东西。所以 Intro 必须
   * 有一格专门拆「主张 → 缺口 → 证据」，且逐条写。
   */
  check(
    'Introduction 骨架单独拆贡献段（主张 / 缺口 / 证据）',
    (sectionSpec('写作手法 · Introduction')?.scaffold ?? '').includes('贡献段怎么列')
  )

  // 按新骨架填的内容，句式库必须还能抽到引号里的英文原句
  const filledIntro =
    '- **一句话主线**（作者要读者接受什么，按什么顺序推）：先用「任务成功后仍会失败」演一遍问题，再用「现有 benchmark 把条件固定在 reset」切出缺口。\n' +
    '- **逐段推进**（一段一行：这段做什么 → 起作用的英文原句）：\n' +
    '  - 第 1 段：把问题演成场景，不用形容词。\n' +
    '  - 第 2 段：一刀切出缺口，随后立刻给体量数字。\n' +
    '- **Gap 从哪一句开始转向**（引用英文原句）：从 "Many simulation robustness benchmarks fix external conditions at reset" 开始转向。\n' +
    '- **可复用句式**（最多 3 条：英文原句 + 用在哪）：\n' +
    '  - "Robots must often continue a task after a target moves." → 开篇把问题演一遍。'
  const harvested = extractPhraseCandidates({ '写作手法 · Introduction': filledIntro })
  check(
    '新骨架下引号里的英文原句照样进句式库',
    harvested.some((c) => c.text.includes('Robots must often continue')),
    harvested.map((c) => c.text).join(' | ').slice(0, 160)
  )
  check(
    '标签后的括号说明不会被当成句式（否则每篇都塞一条垃圾）',
    !harvested.some((c) => c.text.startsWith('（')),
    harvested.map((c) => c.text).join(' | ').slice(0, 160)
  )

  /*
   * 骨架改版最容易误伤的地方：`isSectionFilled` 是拿**当前**骨架比对的，
   * 于是停在旧骨架上的论文会被判成「已精读」—— 列表打标记、统计虚高，
   * 点进去却全是空标签（正是当初引入它时要防的那件事）。历史骨架因此冻结参与比对。
   */
  const oldIntroScaffold =
    '- **段落推进逻辑**（每段做什么）：\n- **如何铺垫 Gap**：\n- **Contribution 怎么写**（几条、动词、粒度）：\n- **Teaser 图 / 首图的作用**：\n- **可复用句式**：'
  /** 收窄后、补贡献段之前的那一版 —— 它也得进 LEGACY_SCAFFOLDS，否则老笔记会假装「已填」 */
  const narrowIntroScaffold =
    '- **一句话主线**（作者要读者接受什么，按什么顺序推）：\n- **逐段推进**（一段一行：这段做什么 → 起作用的英文原句）：\n- **Gap 从哪一句开始转向**（引用英文原句）：\n- **可复用句式**（最多 3 条：英文原句 + 用在哪）：'
  check(
    '停在旧骨架上的章节仍然算「没填」',
    !isSectionFilled('写作手法 · Introduction', oldIntroScaffold)
  )
  check(
    '上一版（未含贡献段）骨架也仍然算「没填」',
    !isSectionFilled('写作手法 · Introduction', narrowIntroScaffold)
  )
  check('旧骨架也不计进有效字数', countEffectiveChars({ '写作手法 · Introduction': oldIntroScaffold }) === 0)
  check(
    '旧骨架 + 真内容仍然算「已填」（改版不该把老笔记全判成空的）',
    isSectionFilled('写作手法 · Introduction', `${oldIntroScaffold}\n- 第 1 段先演一遍问题。`)
  )
  check(
    '停在旧骨架上的论文不会被当成「已精读」',
    !isAiFilled({ '写作手法 · Introduction': oldIntroScaffold, '写作手法 · Abstract': oldIntroScaffold })
  )

  /* ---------------- 17c. 章节值里自带的「## 」标题不能切碎章节 ---------------- */
  console.log('')
  console.log('── 17c. 章节值里的「## 」标题降级 ─────────────')

  /*
   * 真实事故（2026-10，三篇连续中招）：模型把「方法细节」的骨架标签全写成
   * `## 一句话概括`、`## 输入 / 输出`……落盘再读回来时，正主章节里只剩
   * 第一个自加标题前的 0 字符，几千字正文变成一串孤儿自定义章节 ——
   * 界面上「方法细节 / 具体例子」永远空白，运行记录却是 ✓。
   * 修复在 renderPaperBody：值里的 `## ` 一律降级成 `### `，代码围栏内不动。
   */
  const corrupted = {
    方法细节: '## 一句话概括\n\n用 A 做 B。\n\n## 输入 / 输出\n\n输入是图片，输出是分数。',
    具体例子: '代码里的标题行不该被动：\n\n```md\n## 这是代码示例\n```\n\n完。'
  }
  const repaired = parsePaperBody(renderPaperBody(corrupted))
  check(
    '值里的 ## 标题被降级，正主章节完整保留',
    (repaired['方法细节'] ?? '').includes('用 A 做 B。') &&
      (repaired['方法细节'] ?? '').includes('输入是图片，输出是分数。'),
    Object.keys(repaired).join('、')
  )
  check(
    '不再出现孤儿章节',
    Object.keys(repaired).filter((k) => k.includes('一句话概括') || k.includes('输入 / 输出'))
      .length === 0,
    Object.keys(repaired).join('、')
  )
  check(
    '代码围栏内的 ## 不被动',
    (repaired['具体例子'] ?? '').includes('## 这是代码示例')
  )
  check(
    '降级后的结构仍在（### 保留）',
    (repaired['方法细节'] ?? '').includes('### 一句话概括')
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
    'limitations'
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
    '并回后仍是完整维度数（不是只剩重试的那 1 个）',
    retried.lenses.length === nineLenses.length,
    `${retried.lenses.length} 个`
  )
  check('补上最后一个 → 状态转成「全部成功」', retried.status === 'ok', retried.message)
  check(
    '文案点明这是重试，不会被读成一次完整精读',
    retried.message.includes('只重试了 1 个维度'),
    retried.message
  )
  check('没被重试的维度保留原结局', retried.lenses.find((l) => l.id === 'overview')?.ok === true)

  /*
   * 历史记录里可能留着一条「任务已取消」（上次跑到一半被中断的那些维度）。
   * 它属于历史事实，不该参与「这次重试结果如何」的判定 —— 否则用户单独重试成功，
   * 状态条还是显示「已取消」，看起来就像重试没生效。
   */
  // 基底用「全部成功」的那次（retried），再伪造一个「历史里留着取消」的维度
  const withHistoricCancel = {
    ...retried,
    lenses: retried.lenses.map((l) =>
      l.id === 'visuals' ? { ...l, ok: false, message: '图表与可视化设计：任务已取消。' } : l
    )
  }
  const afterCancelRetry = mergeRunRecord(withHistoricCancel, [outcome('visuals', true, '完成')])
  check(
    '历史里的「任务已取消」不污染这次重试的结果',
    afterCancelRetry.status === 'ok',
    afterCancelRetry.status
  )

  /*
   * 另一个会让人以为「重试坏了」的场景：重试在**发出请求之前**就崩了
   *（没原文 / 401 / 知识库没打开）。此时 outcomes 是空的，不能把整篇从
   * 「部分失败」升级成「失败」—— 那会把另外 8 个成功的维度一起说成失败。
   */
  const crashedRetry = mergeRunRecord(fullRun, [], new Error('接口返回 401'))
  check(
    '单维度重试崩在发请求前，整体状态沿用上一次',
    crashedRetry.status === fullRun.status,
    crashedRetry.status
  )
  check('但这次失败的原因要写进 message', crashedRetry.message.includes('401'), crashedRetry.message)

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
    'system 里写了「覆盖优先」（该标的都要标上 —— 取舍是刻意改的：宁可多标，也别漏掉图注、例子这类助理解的信息）',
    AUTO_HIGHLIGHT_SYSTEM.includes('覆盖优先')
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
    '实现细节 / 超参要喂给实验专家（硬件与超参常常只写在这些章节里）',
    classifyHeadings([
      '4 Experiments',
      'B Implementation Details',
      'C Hyperparameters',
      'D Dataset Statistics'
    ]),
    ['experiment', 'experiment', 'experiment', 'experiment']
  )
  eq(
    '附录里的证明过程仍然跳过（它不是实验设置）',
    classifyHeadings(['Appendix A Proofs', 'References', 'Acknowledgements']),
    ['skip', 'skip', 'skip']
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
    '四个专家 prompt 都带 JSON 约束与覆盖要求（各自单独调模型，不能只钉在总 prompt 上）',
    AGENT_KINDS.map((k) => kindSystem(k)).every(
      (p) => p.includes('只输出一个合法 JSON 对象') && p.includes('覆盖优先')
    )
  )
  check(
    '方法专家要标图注 / 示意图引用 / 具体例子 / 算法框（初学者靠这些才看懂方法设计）',
    ['图注', '例子', 'Algorithm'].every((word) => kindSystem('method').includes(word))
  )
  check(
    '实验专家要标结果图表的图注（图注比在表格里找数字快得多）',
    kindSystem('experiment').includes('图注')
  )
  check(
    '专家 prompt 只允许输出自己那类 kind（混类会打乱配额与标签）',
    kindSystem('problem').includes('"problem"') &&
      !kindSystem('problem').includes('problem|method') &&
      kindSystem('experiment').includes('"experiment" 或 "result"')
  )
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

  console.log('')
  console.log(`${pass}/${pass + fail} 通过`)
  if (fail) process.exitCode = 1
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
