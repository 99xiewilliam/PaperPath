import { lensMeta } from '@shared/lenses'
import {
  jsonOnlyRule,
  paperHeader,
  pickSections,
  sectionRequirements,
  sourceBlock,
  type Lens,
  type LensContext
} from './types'

const SYSTEM = `你是科研写作教练，任务是**拆解别人论文的写作手法**，而不是总结论文内容。
你的信条：
1. 读者要学到的是「怎么写的」：段落分工、推进顺序、可复用的句式，而不是内容摘要。
2. **说清比说全重要**：这一节的写作逻辑先用一句话讲明白，再逐段展开；讲不出所以然的细节不要写。
3. **写作逻辑 = 这一步在回答读者的哪个疑问**：不要写「介绍了背景」，要写「先让读者看到任务失败长什么样，再问为什么已有方法接不住」。
4. 每条判断都要能指回原文：引一句英文原句（引号内），或点明「第 2 段」。
5. 要指出作者**刻意的设计**：为什么这段放前面、为什么这里要提这个数字、为什么这里要示弱。
6. 只做写作分析：不评价方法好坏，也不复述实验设置（那是「实验画像 / 实验方法论」的事）。
7. 输出必须是合法 JSON，不要代码块包裹。`

/**
 * 投喂材料按维度给：开篇三节看摘要 / 引言 / 相关工作；
 * 方法与实验看正文主体，外加结论里值得摘录的原句。
 * （给多了既稀释注意力，也白白多花钱。）
 */
const SOURCE_KEYS: Record<WritingId, string[]> = {
  writing: ['Abstract', 'Introduction', 'Related Work'],
  writingMethod: ['Abstract', 'Method', 'Experiments', 'Analysis', 'Conclusion']
}

const WRITING_IDS = ['writing', 'writingMethod'] as const
type WritingId = (typeof WRITING_IDS)[number]

/**
 * 每一节真正要回答的问题不同，所以公共约束之外再给「本节特有角度」。
 *
 * 为什么贡献段要单列一条：它是最常被读、也最常被抄的部分，而「逐段推进」
 * 只会把它压成「最后列出了三条贡献」。贡献段必须按**主张**读：
 * 每条声称什么、回扣前文哪个缺口、由什么支撑、条目之间是否重叠；
 * 实验类条目还要写清「支持了什么结论」，而不是「做了哪些实验」。
 * 这套口径同时是读别人论文时的检查表 —— 抄结构，也抄防线。
 */
const SECTION_RULES: Record<string, string[]> = {
  '写作手法 · Abstract': [
    '- 摘要要写**压缩策略**：先让读者接受什么（问题为什么值得做），再给方法、最后给证据；指出哪一块被压成一句、哪一块干脆省略。'
  ],
  '写作手法 · Introduction': [
    '- 贡献段**逐条拆**，不能写成「列出了三点贡献」：每条写「主张类型（缺口 / 机制 / 证据）→ 回扣前文哪个缺口 → 由什么支撑」。',
    '- 检查条目边界：哪两条其实在说同一件事、哪一条只是功能清单；实验类条目要写清「它支持了什么结论」。',
    '- 指出表述与证据的落差（first / significant / independent 这类词在正文里有没有定义或对应结果）——这是可迁移的防线，不是挑刺。'
  ],
  '写作手法 · Related Work': [
    '- 每类综述都要指出「这一类最后留下什么缺口」，并把它和 Intro 的 Gap 对上；对不上说明定位是硬贴的。',
    '- 看它把自己放在哪一类之后、用一句什么样的话划开距离（引用原句）。'
  ]
}

/**
 * 单节重写（agents/rewrite.ts）也要带上同一节的专属规则。
 *
 * 为什么必须导出：重写走的是「该节归属维度的 system prompt + 节骨架」，如果
 * 专属规则只活在精读的 prompt 里，就会出现「精读拆了条目边界、点一次重写
 * 又退回『列出了三点贡献』」的口径分叉 —— 重写恰恰是用户对产出不满意时
 * 用的按钮，退步最不该发生在那里。非写作章节返回空数组，等于不生效。
 */
export function sectionRulesFor(key: string): string[] {
  return SECTION_RULES[key] ?? []
}

/**
 * 两个写作维度共用同一套分析口径，只有「负责哪几节」和「投喂什么」不同。
 *
 * 为什么拆成两个：原来一个维度要一次写 6 节，实测输出会撞上 max_tokens 被
 * 截断（推理模型的思考先吃掉大半预算），而截断抢救只保住最后一个完整值 ——
 * 结果记录里是 ✓、实际只落了第一节，其余全是空骨架。详见 shared/lenses.ts
 * 里 writingMethod 的注释。
 */
function makeWritingLens(id: WritingId): Lens {
  const meta = lensMeta(id)
  const sections = meta.sections

  /*
   * 这一串约束是**针对「写得又长又抽象」这个具体毛病**加的，每条都能对应到实测里
   * 见过的一种废话：堆抽象名词（「对任务进行了深入剖析」）、换着说法重复同一句
   * （「层层递进 / 结构清晰 / 逻辑严密」）、为了填满标签而凑句子。
   * 它们和骨架是一套的：骨架先收窄到「一句话主线 + 逐段推进」，这里再把每条压到 1-3 行。
   */
  const extra = [
    '- 每个「写作手法 · X」章节都要**保留模板给的加粗标签**，标签后跟实际内容。',
    '- **先给「一句话主线」**，再展开逐段 / 逐块推进；主线说不清，说明这一节还没读懂。',
    '- **不要空话**：「结构清晰」「层层递进」「承上启下」「具有重要意义」「值得学习」这类词一个都别用；换不成具体动作的判断，整条删掉。',
    '- **不要抽象名词堆砌**：写「先用一句话交代任务，再指出四类失败场景」，而不是「对任务进行了深入剖析」。',
    '- **不要重复**：同一个意思只说一次，不要换个说法再讲一遍，也不要为了填满标签而凑字。',
    '- 篇幅：每个标签下 1-3 行短句（可以用列表），整节控制在 700 字以内。宁可短，不要长。',
    '- 「可复用句式」摘英文原句（放在引号里），每条后面用一句话说清它用在哪。',
    '- 不要写成内容摘要。如果某节只能写出内容摘要，说明没抓住写作手法，请重写。',
    ...(sections.includes('原文摘录')
      ? ['- 「原文摘录」给 3-5 句值得反复读的原句，不要加解释。']
      : []),
    ...sections.flatMap((key) => SECTION_RULES[key] ?? [])
  ].join('\n')

  return {
    id,
    meta,
    system: SYSTEM,

    prompt(ctx: LensContext): string {
      return `# 任务
逐节拆解下面这篇论文的**写作手法**：它每一节怎么组织、用了什么句式、我怎么复用。

# 论文信息
${paperHeader(ctx)}

# 输出 JSON
{
  "sections": {
    ${sections.map((k) => `"${k}": "该章节的 Markdown 内容"`).join(',\n    ')}
  }
}

# 各章节填写要求
${sectionRequirements(sections)}

# 特别注意
${extra}
- 上面 JSON 里的**每个键都要写出来**。只写第一节就停，后面的章节会一直是空骨架。

${jsonOnlyRule()}

# 论文正文
${sourceBlock(ctx, SOURCE_KEYS[id])}`
    },

    parse(payload) {
      return { sections: pickSections(payload, sections) }
    }
  }
}

export const writingLens = makeWritingLens('writing')
export const writingMethodLens = makeWritingLens('writingMethod')
