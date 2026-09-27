/**
 * 论文笔记的固定章节骨架。
 *
 * 设计要点：
 * 1. 章节名固定 → 才能跨论文做结构化聚合（例如「所有 benchmark 论文的 Experiments 写法」）。
 * 2. 章节内容全部是 Markdown → 用户随时可以手改，AI 只是初始化。
 * 3. 每个章节带 scaffold（填写骨架），保证不同论文之间字段对齐。
 */

export interface SectionSpec {
  key: string
  group: SectionGroup
  /** 编辑器里显示的提示语 */
  hint: string
  /** 新建论文时的初始内容 */
  scaffold: string
}

export type SectionGroup = '速览' | '方法拆解' | '写作拆解' | '语言积累' | '实验沉淀' | '延伸'

/**
 * 分组在详情页的**展示顺序**，也是读一篇论文的自然顺序：
 * 先知道它是什么 → 再看方法怎么做的（含例子）→ 然后才是它怎么写、怎么做的实验
 * → 最后是延伸到我自己身上的部分。
 */
export const SECTION_GROUP_ORDER: SectionGroup[] = [
  '速览',
  '方法拆解',
  '写作拆解',
  '语言积累',
  '实验沉淀',
  '延伸'
]

export const SECTION_SPECS: SectionSpec[] = [
  {
    key: '一句话总结',
    group: '速览',
    hint: '1-2 句话讲清「做了什么 + 为什么重要」。将来检索列表就靠它。',
    scaffold: '- '
  },
  {
    key: '核心问题与动机',
    group: '速览',
    hint: '它想解决什么问题？为什么这个问题重要？',
    scaffold: '- **要解决什么问题**：\n- **为什么重要 / 应用场景**：\n- **之前的方法卡在哪**：'
  },
  {
    key: '关键收获',
    group: '速览',
    hint: '读完这篇我真正带走的东西，3-5 条。',
    scaffold: '- \n- \n- '
  },
  {
    key: '故事线拆解',
    group: '速览',
    hint: '论文的「叙事骨架」。这条线清晰了，自己写论文时就能照着搭。',
    scaffold:
      '- **痛点（Motivation）**：\n- **Gap（已有方法缺什么）**：\n- **核心洞察（Key Insight）**：\n- **如何验证（Validation）**：\n- **一句话故事线**：'
  },
  {
    key: '方法细节',
    group: '方法拆解',
    hint: '讲到「能照着复现」：每一步收到什么、吐出什么，术语给中英对照，公式逐个符号解释。只写论文说了的。',
    /*
     * 这个骨架是**具体导向**的，因为它最容易写成摘要级空话
     *（「融合了多模态特征」「设计了若干模块」），读者读完仍然不知道发生了什么。
     * 其中两条最关键：
     *   - 「走一遍」逼出一条真实的数据流（没有它，一串步骤名仍然看不出数据长什么样）；
     *   - 「术语对照」让读者能拿着原词回 PDF 里搜到它。
     * 注意改了骨架要连带看 lens 的 prompt：填写要求是从这里生成的（sectionRequirements）。
     */
    scaffold:
      '- **一句话概括**：\n- **输入 / 输出**（形态与字段；原文没给就写「原文未说明」）：\n- **整体流程**（按执行顺序，每一步：收到什么 → 做什么 → 吐出什么）：\n- **走一遍**（拿一个具体输入逐步走完，标明是论文里的例子还是你构造的）：\n- **各模块在做什么**（每个模块都要带具体名词：图号 / 公式 / 字段 / 取值）：\n- **关键设计选择 + 作者给的理由**（选了什么、为什么不选另一个）：\n- **术语对照**（原文写法 → 一句话人话）：\n- **公式 / 符号含义**（逐个符号：含义 + 维度 / 取值范围）：\n- **训练与超参细节**（有数字就写数字）：\n- **复现还缺什么**（照现在的描述会在哪里卡住）：'
  },
  {
    key: '具体例子',
    group: '方法拆解',
    hint: '论文里**真实出现**的例子（示例输入、prompt 模板、case study、图示场景）。没有就明说，不要编。',
    scaffold:
      '- **例子 1**\n  - 出处（章节 / 图 / 表 / 附录）：\n  - 原文（用 > 逐字引用）：\n  - 它演示了什么：\n- **例子 2**\n  - 出处：\n  - 原文（用 > 逐字引用）：\n  - 它演示了什么：\n- **论文没有给出具体例子**（确实没有时才留这一行 —— 不要自己造一个）'
  },
  {
    key: '写作手法 · Abstract',
    group: '写作拆解',
    hint: '拆它的摘要怎么组织、用了哪些句式。',
    scaffold:
      '- **结构拆解**（背景 → 现有做法 → 不足 → 本文做法 → 结果 → 影响）：\n- **亮点句式**：\n  - \n- **可复用表达**：\n  - \n- **给我的启发**：'
  },
  {
    key: '写作手法 · Introduction',
    group: '写作拆解',
    hint: 'Intro 是全文的销售页，重点看它怎么一步步把读者逼到你的方法上。',
    scaffold:
      '- **段落推进逻辑**（每段做什么）：\n- **如何铺垫 Gap**：\n- **Contribution 怎么写**（几条、动词、粒度）：\n- **Teaser 图 / 首图的作用**：\n- **可复用句式**：'
  },
  {
    key: '写作手法 · Related Work',
    group: '写作拆解',
    hint: '看它怎么「分类别人」再「定位自己」。',
    scaffold:
      '- **分类维度**：\n- **如何温和地指出他人不足**：\n- **如何把自己定位进去**：\n- **篇幅 / 引用密度 / 组织方式**：'
  },
  {
    key: '写作手法 · Methodology',
    group: '写作拆解',
    hint: '方法章节的组织、符号体系与图示策略。',
    scaffold:
      '- **章节组织顺序**：\n- **符号与公式体系**（怎么定义、怎么避免歧义）：\n- **图示策略**（框架图/模块图怎么画）：\n- **如何论证设计合理性**（而不是只描述）：'
  },
  {
    key: '写作手法 · Experiments',
    group: '写作拆解',
    hint: '实验章节是审稿人最看的地方，逐条拆它的论证链。',
    scaffold:
      '- **实验设计逻辑**（要依次证明哪几个 claim）：\n- **数据集 / 测试集**：\n- **基线选择**（强基线？最新？开源？）：\n- **评估指标**：\n- **消融实验设置**：\n- **主结果表怎么组织**（行列是什么、加粗规则）：\n- **Case study / 可视化 / 人工评测**：'
  },
  {
    key: '图表与可视化设计',
    group: '写作拆解',
    hint: '同样的拆解思路换个场景：不看文字，看它的图、表、流程怎么设计。',
    scaffold:
      '- **整体视觉策略**：\n- **逐图拆解**：\n  - **Figure 1**（类型：___）\n    - 承担什么论证任务：\n    - 设计手法（布局/配色/标注/排序）：\n    - 可迁移给我：\n- **逐表拆解**：\n  - **Table 1**（类型：___）\n    - 行 / 列分别是什么：\n    - 排序与加粗规则：\n    - 可迁移给我：'
  },
  {
    key: '英语写作短语',
    group: '语言积累',
    hint: '从小颗粒短语开始积累，比背整句更容易迁移到自己的写作里。',
    scaffold: ''
  },
  {
    key: '实验方法论',
    group: '实验沉淀',
    hint: '这篇论文「做实验」的做法本身，是我最想沉淀的部分。',
    scaffold:
      '- **指标为什么选它**：\n- **跑几次 / 随机种子 / 是否报告方差**：\n- **模型选择（开源 vs 闭源 vs 都选）及理由**：\n- **算力与训练 / 推理规模**：\n- **人工评测协议**（如有）：\n- **复现要点与坑**：\n- **可迁移到我自己实验的设计**：'
  },
  {
    key: '局限与未来工作',
    group: '实验沉淀',
    hint: '作者自陈的局限 + 你发现的漏洞，往往就是下一篇论文的入口。',
    scaffold: '- **作者自陈**：\n- **我发现的额外问题**：'
  },
  {
    key: '可迁移到我的研究',
    group: '延伸',
    hint: '直接能用到自己课题上的具体动作。',
    scaffold: '- '
  },
  {
    key: '举一反三',
    group: '延伸',
    hint: '把方法或洞察搬到别的任务 / 场景：具体设想 + 为什么成立 + 可能踩的坑。',
    scaffold:
      '- **可迁移的核心洞察**：\n- **能搬到哪里**（具体任务 / 场景）：\n  - 怎么搬：\n  - 为什么成立：\n  - 可能踩的坑：\n- **搬不过去的地方 / 为什么**：'
  },
  {
    key: '方法串联',
    group: '延伸',
    hint: '与库内**真正相关**论文的对照。必须有实际共享的技术要素，凑不出就明说没有。',
    scaffold:
      '- **与《论文 A》**\n  - 共享什么（数据集 / 基准 / 模型 / 方法 / 任务）：\n  - 差异在哪：\n  - 谁更优 / 各自适用场景：\n  - 我可以怎么用这个对照：\n- **库内暂无与本篇真正可串联的论文**（确实没有时才留这一行 —— 不要为了凑而硬拉关系）'
  },
  {
    key: '原文摘录',
    group: '延伸',
    hint: '值得反复读的原句，用 > 引用。',
    scaffold: '> '
  },
  {
    key: '自由笔记',
    group: '延伸',
    hint: '任何其他东西。',
    scaffold: ''
  }
]

export const SECTION_ORDER: string[] = SECTION_SPECS.map((s) => s.key)

const SPEC_MAP = new Map(SECTION_SPECS.map((s) => [s.key, s]))

/**
 * 把模型返回的章节值规整成 Markdown 字符串。
 *
 * 虽然 Prompt 里明确要求字符串，但模型在长输出时经常自作主张：
 *   "一句话总结": ["构建 CultureVerse…", "覆盖 188 个国家…"]        → 数组
 *   "写作手法 · Abstract": { "结构拆解": "…", "亮点句式": ["…"] }   → 对象
 * 这些都应当在本地被容错接住，而不是整篇笔记变成空白。
 */
export function coerceSectionText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value
      .map((item) => coerceSectionText(item))
      .filter(Boolean)
      .join('\n')
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([label, inner]) => {
        const text = coerceSectionText(inner)
        if (!text) return ''
        // 已经是列表项就不用再加前缀
        return text.startsWith('-') ? text : `- **${label}**：${text}`
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export function sectionSpec(key: string): SectionSpec | undefined {
  return SPEC_MAP.get(key)
}

export function sectionHint(key: string): string {
  return SPEC_MAP.get(key)?.hint ?? ''
}

export function sectionGroup(key: string): SectionGroup {
  return SPEC_MAP.get(key)?.group ?? '延伸'
}

export function allSectionKeys(customSections: string[] = []): string[] {
  return [...SECTION_ORDER, ...customSections.filter((k) => !SECTION_ORDER.includes(k))]
}

export function emptySections(customSections: string[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  for (const spec of SECTION_SPECS) out[spec.key] = spec.scaffold
  for (const key of customSections) if (!(key in out)) out[key] = ''
  return out
}

/**
 * 取正文里第一个 `## ` 标题**之前**的内容。
 *
 * 这段不属于任何章节，`parsePaperBody` 按设计会把它丢掉。但它是用户自己写的
 * —— 在 Obsidian / 任意编辑器里给这篇笔记加的 `# 大标题`、一行「和谁讨论过」、
 * 一段导语 —— 所以写回文件时必须原样带上。
 *
 * 不带上会怎样：任何一次保存都会走 `renderPaperBody` 重新生成整篇正文，
 * 于是「批量给 20 篇加个标签」就能把这些手写内容全部抹掉。
 *
 * 判定 `## ` 时要跳过代码围栏，和 `parsePaperBody` 保持同一套规则 ——
 * 否则笔记里贴一段含 `## xxx` 的代码，前言就会被从代码中间截断。
 */
export function paperPreamble(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const head: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (!inFence && /^##\s+/.test(line)) break
    head.push(line)
  }
  return head.join('\n').trim()
}

/**
 * 把 Markdown 正文按 `## 标题` 切分成章节字典。
 * 二级标题以下的内容（###、列表、代码块）都归属当前章节。
 */
export function parsePaperBody(body: string): Record<string, string> {
  const sections: Record<string, string> = {}
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  let current: string | null = null
  let buffer: string[] = []
  let inFence = false

  const flush = (): void => {
    if (current !== null) {
      sections[current] = buffer.join('\n').trim()
    }
    buffer = []
  }

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence
    const m = !inFence ? /^##\s+(.+?)\s*$/.exec(line) : null
    if (m) {
      flush()
      current = m[1]
      continue
    }
    if (current !== null) buffer.push(line)
  }
  flush()

  // 丢弃完全空白的章节，避免污染
  for (const key of Object.keys(sections)) {
    if (!sections[key]) delete sections[key]
  }
  return sections
}

/** 把章节字典渲染回 Markdown 正文 */
export function renderPaperBody(
  sections: Record<string, string>,
  customSections: string[] = []
): string {
  const keys = allSectionKeys(customSections)
  const seen = new Set<string>()
  const parts: string[] = []

  for (const key of keys) {
    seen.add(key)
    const content = (sections[key] ?? '').trim()
    parts.push(`## ${key}\n\n${content}`)
  }
  // 保留用户手工新增的、不在模板里的章节
  for (const [key, content] of Object.entries(sections)) {
    if (seen.has(key)) continue
    parts.push(`## ${key}\n\n${(content ?? '').trim()}`)
  }
  return parts.join('\n\n').trim() + '\n'
}

/**
 * 从章节字典里取「一句话总结」用于列表展示。
 * 这是纯文本场景（列表卡片、检索关键词），所以 Markdown 标记要全部去掉。
 */
export function extractTldr(sections: Record<string, string>): string {
  const raw = sections['一句话总结'] ?? ''
  return raw
    .split('\n')
    .map((line) =>
      line
        .replace(/^[-*>]\s*/, '')
        // `**做了什么**：` 这类小标题前缀整段去掉，只留内容
        .replace(/^\*\*[^*]{1,24}\*\*\s*[:：]\s*/, '')
        // 剩余的行内加粗 / 行内代码标记也去掉
        .replace(/\*\*/g, '')
        .replace(/`/g, '')
        .trim()
    )
    .filter((line) => line && line !== '（待补充）')
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 200)
}

/** 比对骨架时忽略空白与全/半角括号差异，只看内容有没有被动过 */
function normalizeScaffold(text: string): string {
  return text.replace(/\s+/g, '').replace(/[（）()]/g, '')
}

/**
 * 这一节里**真的有内容吗**（而不是原封未动的骨架模板）。
 *
 * 不能只拿长度当判据：骨架本身就有一两百字
 * （例如 `- **结构拆解**（背景 → 现有做法 → 不足 → 本文做法 → 结果 → 影响）：`），
 * 于是「刚导入、一次精读都没跑完」的笔记会被判成「已精读」——
 * 列表上打着「已精读」、点进去全是空标签，**失败看起来像成功**。
 *
 * 实测过一例：一篇精读始终没跑完的论文，库里 `ai_filled=1`、`writing_notes=5`、
 * `experiment_notes=1`，而 `graph` / `phrases` 还是初始值 —— 正是这组假指标
 * 让「其实一次都没成功」变得看不出来。
 */
export function isSectionFilled(key: string, value: string | undefined): boolean {
  const text = (value ?? '').trim()
  if (!text) return false
  const scaffold = (SPEC_MAP.get(key)?.scaffold ?? '').trim()
  // 没有骨架的章节（自由笔记这种）只要有字就算写了
  if (!scaffold) return true
  return normalizeScaffold(text) !== normalizeScaffold(scaffold)
}

/** 判断这篇论文是否已经被 AI / 用户认真填写过 */
export function isAiFilled(sections: Record<string, string>): boolean {
  const writingKeys = SECTION_ORDER.filter((k) => k.startsWith('写作手法'))
  const filled = writingKeys.filter((k) => isSectionFilled(k, sections[k]))
  return filled.length >= 2
}

/** 统计正文里非 scaffold 的有效字数 */
export function countEffectiveChars(sections: Record<string, string>): number {
  let total = 0
  for (const [key, value] of Object.entries(sections)) {
    // 骨架原样的一律不算。用 isSectionFilled 判而不是「文本完全相等」——
    // 后者只要模型在骨架后多留一个换行就漏判，字数统计会突然虚高。
    if (!isSectionFilled(key, value)) continue
    // 去掉骨架里的标签，只算真实填写内容
    const text = (value ?? '').replace(/\*\*[^*]+\*\*：/g, '')
    total += text.replace(/\s/g, '').length
  }
  return total
}
