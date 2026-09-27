import { lensMeta, PHRASE_CATEGORIES, type EnglishPhrase } from '@shared/lenses'
import { jsonOnlyRule, paperHeader, sourceBlock, type Lens, type LensContext } from './types'

const SECTION = lensMeta('english').sections[0]

const SYSTEM = `你是一位英语学术写作教练，专门帮中文母语的研究者积累**可直接套用的小颗粒英文短语**。
你的信条：
1. 只收「小短语」（3-10 个词），不要整句长句——小颗粒才容易被记住和迁移。
2. 短语必须**从给定原文里原样摘出**，不要自己造，也不要改写。原样摘取是这份库可信的前提。
3. 每条都要说清「什么场景用、语气如何（强势/谦逊/中性）」，这才是学习者真正需要的。
4. 同类短语要覆盖不同用法，不要 10 条全是同一个意思。
5. 输出必须是合法 JSON，不要代码块包裹。`

/** 把结构化短语渲染成 Markdown 章节内容 */
function renderPhraseSection(phrases: EnglishPhrase[]): string {
  if (!phrases.length) return ''
  const byCategory = new Map<string, EnglishPhrase[]>()
  for (const phrase of phrases) {
    const key = phrase.category || '其他'
    if (!byCategory.has(key)) byCategory.set(key, [])
    byCategory.get(key)!.push(phrase)
  }

  // 按预定义顺序输出，未在预定义里的分类排在最后
  const order = [...PHRASE_CATEGORIES, ...byCategory.keys()]
  const seen = new Set<string>()
  const blocks: string[] = []

  for (const category of order) {
    if (seen.has(category)) continue
    seen.add(category)
    const list = byCategory.get(category)
    if (!list?.length) continue

    const items = list.map((p) => {
      const lines = [`- \`${p.text}\` —— ${p.usage}`]
      if (p.example) lines.push(`  - 例：${p.example}`)
      if (p.from) lines.push(`  - 出处：${p.from}`)
      return lines.join('\n')
    })
    blocks.push(`### ${category}\n${items.join('\n')}`)
  }

  return `${blocks.join('\n\n')}\n\n> 以上短语原样摘自本文，可直接在自己的写作中替换主语/宾语套用。`
}

export const englishLens: Lens = {
  id: 'english',
  meta: lensMeta('english'),
  system: SYSTEM,

  prompt(ctx: LensContext): string {
    const existing = (ctx.existingPhrases ?? []).map((p) => p.text).filter(Boolean)
    return `# 任务
从下面这篇论文里摘出 **10-16 条可复用的英文小短语**，按功能分类，用于积累英语学术写作能力。

# 论文信息
${paperHeader(ctx)}

# 允许的分类（category 字段只能从这些里选）
${PHRASE_CATEGORIES.map((c) => `- ${c}`).join('\n')}

# 输出 JSON
{
  "phrases": [
    {
      "category": "从上面分类里选一个",
      "text": "原样摘出的英文小短语（3-10 个词）",
      "usage": "中文说明：什么场景用、语气如何",
      "example": "含该短语的完整原句（便于体会它在句子里的位置）",
      "from": "Abstract | Introduction | Related Work | Methodology | Experiments | Conclusion"
    }
  ]
}

# 硬性要求
- text **必须是原文里原样出现的片段**，不要改写、不要合并、不要自己造句。
- text 控制在 3-10 个词，越短越好；不要摘整句。
- 优先摘「功能性强」的短语：引出 gap、转折、限定、报告结果、铺垫贡献、收尾展望。
- 覆盖尽量多的分类，不要集中在某一类。
- usage 用中文写，**不超过 30 字**，说清语气（强势 / 中性 / 谦逊）与常见位置。
- example 也必须是原文原句（可以截取），**不超过 25 个词**，不要自己造。
- 严格 10-16 条，不要超量。
${existing.length ? `\n# 需要避开（库里已有）\n${existing.slice(0, 60).join('; ')}\n` : ''}
${jsonOnlyRule()}

# 论文正文
${sourceBlock(ctx, ['Abstract', 'Introduction', 'Related Work', 'Method', 'Experiments'])}`
  },

  parse(payload) {
    const root = (payload ?? {}) as Record<string, unknown>
    const raw = Array.isArray(root.phrases) ? root.phrases : []

    const validCategories = new Set<string>(PHRASE_CATEGORIES)
    const seen = new Set<string>()
    const phrases: EnglishPhrase[] = []

    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const text = String(row.text ?? '').trim()
      if (!text || text.length > 120) continue
      const key = text.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)

      const category = String(row.category ?? '').trim()
      phrases.push({
        category: validCategories.has(category) ? category : '其他',
        text,
        usage: String(row.usage ?? '').trim(),
        example: String(row.example ?? '').trim() || undefined,
        from: String(row.from ?? '').trim() || undefined
      })
      if (phrases.length >= 24) break
    }

    const sections = phrases.length ? { [SECTION]: renderPhraseSection(phrases) } : {}
    return {
      sections,
      data: { phrases },
      summary: phrases.length ? `收录 ${phrases.length} 条英文短语` : '没有摘到可复用短语'
    }
  }
}
