import { coerceSectionText, SECTION_SPECS } from '@shared/template'
import type { LensId, LensMeta } from '@shared/lenses'
import type { RelatedPaper } from '@shared/connections'
import type { ExperimentProfile } from '@shared/experiment'
import type { PaperMeta, TaxonomyNode } from '@shared/types'
import type { LlmSource } from '../papertext'

/** 跑一个维度时能拿到的全部上下文 */
export interface LensContext {
  paper: {
    title: string
    authors: string[]
    year: number | null
    venue: string
    url: string
    arxivId: string
    categories: string[]
  }
  categoryCatalog: TaxonomyNode[]
  /** 已有章节（维度之间可以互相引用产出） */
  sections: Record<string, string>
  /** 原文全文（已按预算截断），作为最后兜底的投喂材料 */
  fullText: string
  /**
   * 未截断的完整原文；缺省时退回 fullText。
   *
   * 只给「按需取片段」的机制用（关键词回捞、正文后段），不直接投喂 ——
   * 附录里的算力 / 复现细节常常落在预算之外，扫截断后的文本根本够不到。
   */
  rawText?: string
  /** 按章节切分的原文（可能为空）；已按「全篇均分」的配额截断 */
  sourceSections: Record<string, string>
  /**
   * 按章节切分、**未截断**的原文；缺省时退回 sourceSections。
   *
   * 只给 sourceBlock 用 —— 它知道本次要的是哪几节，能只在这几节之间分配额度，
   * 从而避免「最有用的那一节被全篇均分的配额切得最狠」。
   */
  rawSections?: Record<string, string>
  /** 已有实验画像 */
  exp?: ExperimentProfile
  /** 已有英语短语（用于去重） */
  existingPhrases?: { text: string }[]
  /**
   * 库里与本篇**真正共享技术要素**的其他论文（见 shared/connections.ts）。
   *
   * 只有「方法串联」维度会读它。空数组表示没筛出真正相关的论文 —— 那是合法结论，
   * 该维度会据此写「库内暂无与本篇真正可串联的论文」，而不是硬拉关系。
   */
  relatedPapers?: RelatedPaper[]
}

/**
 * 由「原文准备结果」构造 LensContext 的公共部分。
 *
 * 主进程（ipc.ts）和 smoke:ai 脚本都要拼这个结构 —— 以前是各拼各的，
 * 结果给 fullText 加了 rawText 之后只改了一处，另一处漏掉，
 * 表现为「修复看起来没生效」（脚本跑出来的结论和 App 不一致）。
 * 统一在这里拼，就再也不会分叉。
 */
export function baseLensContext(
  source: LlmSource,
  paper: LensContext['paper'],
  categoryCatalog: TaxonomyNode[],
  sections: Record<string, string>
): LensContext {
  return {
    paper,
    categoryCatalog,
    sections,
    fullText: source.fullText,
    rawText: source.rawText,
    sourceSections: source.sourceSections ?? {},
    rawSections: source.rawSections
  }
}

/** 一个维度的产出 */
export interface LensOutput {
  /** 写进 Markdown 正文的章节 */
  sections?: Record<string, string>
  /** 写进 frontmatter 的结构化数据 */
  data?: Record<string, unknown>
  /** 需要合并进 meta 的字段（分类、标签） */
  meta?: Partial<PaperMeta>
  /** 给用户看的一句话结论 */
  summary?: string
}

export interface Lens {
  id: LensId
  meta: LensMeta
  system: string
  prompt(ctx: LensContext): string
  parse(payload: unknown, ctx: LensContext): LensOutput
}

/* ------------------------------------------------------------------ */
/*  prompt 组装用的公共片段                                            */
/* ------------------------------------------------------------------ */

export function paperHeader(ctx: LensContext): string {
  const p = ctx.paper
  return [
    `- 标题：${p.title || '（未知）'}`,
    `- 作者：${p.authors.length ? p.authors.join(', ') : '（未知）'}`,
    `- 年份：${p.year ?? '（未知）'}`,
    `- 发表：${p.venue || '（未知）'}`,
    `- arXiv：${p.arxivId || '（无）'}`,
    `- 用户已选分类：${p.categories.length ? p.categories.join(', ') : '（未选，请你判断）'}`
  ].join('\n')
}

export function categoryList(ctx: LensContext): string {
  return ctx.categoryCatalog
    .map((c) => `- ${c.id} → ${c.label}${c.hint ? `（${c.hint}）` : ''}`)
    .join('\n')
}

/**
 * 按关键词从**全文**里回捞证据片段。
 *
 * 为什么需要它：`tail` 是「取全文最后 N 字符」，而长论文的附录跨度极大 ——
 * 实测一篇 116KB 的论文，算力段落在第 91KB 处，而 tail 窗口要到 105KB 才开始，
 * 那段信息从头到尾就没被送给模型，模型只能老老实实写「算力硬件原文未说明」。
 * 关键词回捞不依赖章节名、也不依赖位置，是这类「针在干草堆里」的通用解法。
 *
 * @param keywords 按**优先级**排列：预算有限时先满足靠前的关键词，
 *                 所以最具体的写法要放前面（'GPU-hour' 排在 'GPU' 之前）。
 * @param budget   回捞内容的总字符上限，避免把长论文里的高频词全捞进来
 */
export function evidenceSnippets(
  fullText: string,
  keywords: string[],
  budget = 2500
): string {
  if (!fullText || !keywords.length || budget <= 0) return ''

  const lines = fullText.split('\n')
  const lowered = keywords.map((k) => k.toLowerCase())

  const hits: { index: number; priority: number }[] = []
  lines.forEach((line, index) => {
    const text = line.toLowerCase()
    const priority = lowered.findIndex((k) => text.includes(k))
    if (priority >= 0) hits.push({ index, priority })
  })
  if (!hits.length) return ''

  // 高优先级的命中先占预算；同优先级内保持原文顺序
  hits.sort((a, b) => a.priority - b.priority || a.index - b.index)

  const kept = new Set<number>()
  let used = 0

  for (const { index } of hits) {
    // 命中行前后各留 2 行，避免把句子或小标题切断
    const group = [index - 2, index - 1, index, index + 1, index + 2].filter(
      (i) => i >= 0 && i < lines.length && !kept.has(i) && lines[i].trim()
    )
    const groupSize = group.reduce((sum, i) => sum + lines[i].trim().length, 0)

    if (used + groupSize <= budget) {
      for (const i of group) {
        kept.add(i)
        used += lines[i].trim().length
      }
      continue
    }

    /*
     * 整组放不下就退一步：只放命中行本身。
     * 不能直接返回 —— 那样在预算偏小时会「什么都没捞到」，
     * 而命中的那一句恰恰是最该带上的东西。
     */
    const line = lines[index].trim()
    if (used + line.length > budget) break
    kept.add(index)
    used += line.length
  }

  return renderSnippets(kept, lines)
}

/** 按原文顺序输出，断档处用「…」标出，让模型知道这些片段并不连续 */
function renderSnippets(indexes: Set<number>, lines: string[]): string {
  const sorted = [...indexes].sort((a, b) => a - b)
  const out: string[] = []
  let prev = Number.NaN
  for (const i of sorted) {
    if (out.length && i !== prev + 1) out.push('…')
    out.push(lines[i].trim())
    prev = i
  }
  return out.join('\n')
}

/**
 * 复现 / 算力细节的关键词表，供实验相关的维度回捞附录用。
 *
 * 顺序即优先级：越具体的写法越靠前，免得 'GPU' 这类高频词先吃光预算。
 * 这些信息通常写在附录（Compute / Implementation details / Reproducibility），
 * 而附录可能跨几十 KB，光靠 tail 够不到。
 */
export const REPRO_EVIDENCE_KEYWORDS = [
  'GPU-hour',
  'GPU hour',
  'GPU hours',
  'A100',
  'H100',
  'V100',
  'A800',
  'L40',
  'TPU',
  'compute budget',
  'compute cost',
  'compute',
  'random seed',
  'seeds',
  'epochs',
  'batch size',
  'GPU'
]

/**
 * 「指定章节」的总预算与单节下限（字符）。
 *
 * 为什么不沿用 prepareLlmSource 的「全篇均分」配额：那是给「不知道读者要哪几节」
 * 的兜底场景准备的，节数一多，每节就所剩无几，而且**越有用的节越容易被切**。
 * 实测一篇 9 节的论文每节只有 6,666 字符，把 Experiments（11,370）从 §5.3 之后
 * 直接切断 —— §5.4 消融 / §5.5 真机验证整节没送到模型，于是 ablationCount /
 * realWorld 被填成「未说明」，而论文里明明写着。
 *
 * 这里改成按**本次真正要的这几节**分额度，单节下限 8,000 也保证节数多时
 * 不至于把某一节压到只剩几百字。
 */
const SECTION_BUDGET = 24000
const MIN_SECTION_CHARS = 8000

/** 截断时留个记号，让模型知道自己看到的不是完整一节 */
function capSection(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…（本段已截断）` : text
}

/**
 * 组装原文材料。
 *
 * 每个维度关心的章节不同，精确投喂既提升抽取质量、也大幅省 token——
 * 把整篇原文塞给每个维度会让 6 个维度的输入总量翻好几倍。
 *
 * @param preferredKeys 只投喂这些章节的片段
 * @param options.tail  额外补一段正文后段（含附录）的字符数；算力规模、
 *                      人工评测这类信息常写在附录里，需要的维度才开
 * @param options.evidence 按关键词从全文回捞证据（见 evidenceSnippets）。
 *                     用于「信息可能在附录中段、tail 够不到」的场景。
 * @param options.sectionBudget 指定章节的总预算；默认 SECTION_BUDGET
 */
export function sourceBlock(
  ctx: LensContext,
  preferredKeys?: string[],
  options: {
    tail?: number
    evidence?: string[]
    evidenceBudget?: number
    sectionBudget?: number
  } = {}
): string {
  const parts: string[] = []

  const matched = (preferredKeys ?? []).filter((key) => ctx.sourceSections[key])
  if (matched.length) {
    /*
     * 命中了指定章节 → 取**未截断**的那一份，并只在这几节之间分额度。
     * 上游的 sourceSections 已经按全篇均分切过，直接用它就复现了上面注释里的坑。
     */
    const source = ctx.rawSections ?? ctx.sourceSections
    const perSection = Math.max(
      MIN_SECTION_CHARS,
      Math.floor((options.sectionBudget ?? SECTION_BUDGET) / matched.length)
    )
    for (const key of matched) {
      const value = source[key] ?? ctx.sourceSections[key]
      if (!value) continue
      parts.push(`### 原文片段：${key}\n${capSection(value, perSection)}`)
    }
  } else if (Object.keys(ctx.sourceSections).length) {
    // 指定章节一个都没命中（原文没切出结构）→ 退回全部章节，用上游已经控过总量的版本
    for (const [key, value] of Object.entries(ctx.sourceSections)) {
      parts.push(`### 原文片段：${key}\n${value}`)
    }
  }

  /*
   * 回捞和 tail 都要扫**未截断**的全文。
   * 算力 / 复现细节写在附录，而附录常常落在 budget 之外 ——
   * 扫截断后的文本根本看不到那一段，tail 也会变成「正文中段」。
   */
  const scanning = ctx.rawText ?? ctx.fullText

  const evidence = options.evidence?.length
    ? evidenceSnippets(scanning, options.evidence, options.evidenceBudget)
    : ''
  if (evidence) {
    parts.push(
      `### 全文关键词命中（从正文各处回捞，用「…」分隔表示片段不连续）\n${evidence}`
    )
  }

  const tailSize = options.tail ?? 0
  if (tailSize > 0) {
    const tail = scanning.slice(Math.max(0, scanning.length - tailSize))
    if (tail.trim().length > 500) {
      parts.push(
        `### 原文片段：正文后段（含参考文献与附录，算力 / 人工评测细节常在此）\n${tail}`
      )
    }
  }

  if (parts.length) return parts.join('\n\n')
  return ctx.fullText || '（没有可用的原文，只能依据已有笔记回答）'
}

/* ------------------------------------------------------------------ */
/*  输出解析的公共工具                                                 */
/* ------------------------------------------------------------------ */

export function asStringArray(value: unknown, limit = 30): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => String(v ?? '').trim())
      .filter(Boolean)
      .slice(0, limit)
  }
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[,;、\n]/)
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, limit)
  }
  return []
}

/** 从 payload 里按固定章节名取出内容（自动容错数组 / 对象形态） */
export function pickSections(
  payload: unknown,
  keys: string[],
  container: 'sections' | 'root' = 'sections'
): Record<string, string> {
  const root = (payload ?? {}) as Record<string, unknown>
  const bag =
    container === 'root'
      ? root
      : ((root.sections ?? {}) as Record<string, unknown>)

  const out: Record<string, string> = {}
  for (const key of keys) {
    const text = coerceSectionText(bag[key])
    if (text) out[key] = text
  }
  return out
}

/**
 * 由章节骨架生成 prompt 里的「填写要求」。
 * 直接读 template 里的 scaffold，保证 prompt 与论文模板永远一致。
 */
export function sectionRequirements(keys: string[]): string {
  return keys
    .map((key) => {
      const spec = SECTION_SPECS.find((s) => s.key === key)
      if (!spec) return `- "${key}"`
      const structure = spec.scaffold
        .split('\n')
        .map((line) => `      ${line}`)
        .join('\n')
      return `- 键名 "${key}"\n    要求：${spec.hint}${
        structure.trim() ? `\n    建议保留的内部结构：\n${structure}` : ''
      }`
    })
    .join('\n')
}

/** 通用的 JSON 输出约束说明，拼进每个维度的 prompt */
export function jsonOnlyRule(): string {
  return [
    '# 输出要求',
    '- 只输出一个合法的 JSON 对象，不要 markdown 代码块包裹，不要任何解释性文字。',
    '- 所有字符串值都使用 Markdown 片段（列表、加粗标签），便于直接贴进笔记。',
    '- 原文没有提到的信息写「原文未说明」，不要推测或编造。'
  ].join('\n')
}
