/**
 * 「演示」生成 agent：把一篇论文拆成一页页，讲给没读过它的人听。
 *
 * 和其他 agent 的约定一致（见本目录）：prompt、采样参数、输出解析都收在这一个
 * 文件里，ai-service 只管「取原文 → 调它 → 落盘」。
 *
 * 和 quiz 的差别全在**听众**上：quiz 面向「刚读完、想验证自己懂没懂」的人，
 * 所以专考细节；演示面向「完全没读过」的人，所以必须从「为什么值得听」起步，
 * 一路铺到「凭什么信」。下面 prompt 里的每一条都是为这件事服务的。
 *
 * 另一条同样重要的东西：**讲系统必须给画面和例子**。这里做了一件别的 agent
 * 不用做的事 —— 把「我们手上有什么画面道具」明确列给它看（方法流程图 / 思维导图 /
 * 用户截过的原文图，以及每张图出现在哪一节、前后写了什么）。模型看不到图本身，
 * 不给这层上下文它就只能瞎指一张，而随机摆张图上去比不放图更糟。
 *
 * 流程图本身不由这份 prompt 画：调用方（ai-service.runSlideDeck）会先跑
 * agents/flow.ts 那个专职 agent 把图画好、落进 frontmatter，这里的「可用画面」
 * 列表里列了就是画好了。讲稿 agent 只负责安排「哪一页用它」。
 */
import type { FigureReference } from '@shared/figures'
import { normalizeSlideDeck, type SlideDeck } from '@shared/slides'
import type { LlmSettings } from '@shared/types'
import { chatCompletion, extractJson } from '../llm'

export const SLIDES_SYSTEM = `你是一位做论文讲解的讲者。听众是**没读过这篇论文**的同行或同学，
你大约有十分钟，目标只有一个：让他们听完能自己讲出「这篇在解决什么问题、怎么做的、凭什么可信」。

拆页原则：
1. 一页只讲一件事，**标题直接写那一页的结论** —— 写「把奖励拆到每一步，让训练信号可验证」，
   而不是「方法」；标题就是听众扫一眼能记住的那句话。
2. 顺着听众的疑问往前推：为什么值得听 → 要解决什么问题、难在哪 → 现有做法差在哪 →
   我们怎么做 → 关键证据 → 边界与局限 → 一句话总结。根据论文可以调整顺序，但不要跳步。
3. 每页 3~5 条要点，每条一句话、40 字以内。说人话：能用日常说法就不堆术语；
   必须出现的术语，第一次出现时用半句话解释。
4. 每页写一句口播讲稿（note）：那是讲的时候给自己看的，可以比要点更口语，
   两三句话把这一页串起来，不要复述要点。

讲「系统」必须给画面和例子 —— 只有一屏文字的演示等于把论文念一遍：
5. **至少一页写具体例子**（example 字段）：拿论文里的一个具体输入（一道题、一张图、
   一句话、一个场景），按「输入 → 中间几步 → 输出」走一遍。这是听众真正看懂系统的地方 ——
   宁可用一整页只讲这一个例子，也不要用三条抽象要点糊过去。
   原文或笔记摘录里确实找不到具体例子时，才可以省略。
6. **「可用画面」里列了方法流程图时，必须安排一页用 visual: "flow"** ——
   只有文字的系统讲解等于没讲，听众只会在脑子里空转。
   没列就说明这篇论文画不出可用的流程图（已经单独试过照原文画了），
   这时**不要自己编一张**：硬编的流程会让听众以为那就是论文的结构，
   靠例子页把系统讲明白比摆一张假图强。
7. 列了原文图时，挑最多两页用 visual: "figure"，并把路径原样填进 figure。
   注意：**你看不到图里的内容**，只能根据它出现在哪一节、附近写了什么来判断。
   所以要只挑线索明确的图，并在这一页的 bullets 里写清「让大家看图上的什么」
   （例如「看右下角三个模块怎么连」）—— 否则听众盯着图不知道看哪。
   线索不明的图宁可不放，乱放一张比不放更糟。
8. 「可用画面」里**只有**思维导图（没有流程图）时，必须安排一页用 visual: "mindmap"
   讲全篇结构 —— 这时它是整份演示唯一的图，别浪费；其余情况用它可有可无。

其余纪律：
9. **只依据给定原文**：不许编造数字、结论、作者没提过的动机；引用数字必须与原文一致，
   不要用「大幅提升」这种模糊说法替掉具体数值。
10. 尽量给每页标出处（§3.2 / Fig.2 / Table.1）；确实找不到出处的页才留空。
11. 输出必须是合法 JSON，不要代码块包裹。`

/** 笔记里最值得喂给演示的几节：具体例子和方法细节密度最高，口吻也最接近「讲给人听」 */
const NOTE_KEYS = ['具体例子', '方法细节', '方法串联', '写作手法 · Methodology', '实验方法论']
const NOTE_BUDGET = 6000

/**
 * 把笔记里已经沉淀的具体例子摘出来当材料。
 *
 * 为什么值得喂：这些是用户自己读这篇论文时留下的（或精读整理出的）内容，
 * 往往已经带着具体例子和中文表述，比直接从英文原文现编一遍更贴近「讲给人听」。
 */
export function buildSlideNotesBlock(sections: Record<string, string>): string {
  const parts: string[] = []
  let budget = NOTE_BUDGET
  for (const key of NOTE_KEYS) {
    if (budget <= 0) break
    const text = (sections[key] ?? '').trim()
    if (!text) continue
    const cut = text.length > budget ? `${text.slice(0, budget)}…` : text
    parts.push(`## ${key}\n${cut}`)
    budget -= cut.length
  }
  return parts.join('\n\n')
}

export interface SlideDeckAgentInput {
  title: string
  year: number | null
  venue: string
  /** 分类的中文名（调用方已经把 id 换成 label） */
  categories: string[]
  /** 按章节挑过的原文片段（由调用方用 sourceBlock 组装） */
  sourceText: string
  /** 笔记摘录（buildSlideNotesBlock 产物），可以是空串 */
  noteExcerpt: string
  /** 手上有什么画面道具 */
  stage: {
    hasFlow: boolean
    hasMindmap: boolean
    /** 用户截过的原文图及其上下文 */
    figures: FigureReference[]
  }
}

function buildStageBlock(stage: SlideDeckAgentInput['stage']): string {
  const lines: string[] = [
    stage.hasFlow
      ? '- 方法流程图：**有**（必须安排一页用 visual: "flow"）'
      : '- 方法流程图：没有 —— 已单独照原文试画过、画不出可用的，不要用 flow，也不要自己编一张',
    stage.hasMindmap ? '- 全篇思维导图：有（可选）' : '- 全篇思维导图：没有，不要用 mindmap'
  ]
  if (!stage.figures.length) {
    lines.push('- 原文图：没有，不要用 figure')
    return lines.join('\n')
  }
  lines.push(`- 原文图 ${stage.figures.length} 张（用 visual: "figure"，figure 填下面这个路径）:`)
  for (const fig of stage.figures) {
    const where = fig.section ? `出现在「${fig.section}」这一节` : '还没被任何笔记引用过'
    lines.push(`  - ${fig.relPath} —— ${where}${fig.excerpt ? `；附近写着：${fig.excerpt}` : ''}`)
  }
  return lines.join('\n')
}

export function buildSlidesUser(input: SlideDeckAgentInput): string {
  const head = [input.year ? `${input.year} 年` : '', input.venue].filter(Boolean).join(' · ')
  return `# 论文
《${input.title}》${head ? `（${head}）` : ''}
${input.categories.length ? `分类：${input.categories.join('、')}` : ''}

# 输出 JSON
{
  "audience": "一句话说明这份演示面向谁、大概讲多久",
  "slides": [
    {
      "title": "这一页的结论（一句话）",
      "bullets": ["要点一", "要点二", "要点三"],
      "note": "口播讲稿",
      "source": "§3.2",
      "example": { "input": "具体输入", "steps": ["中间第一步", "第二步"], "output": "输出长什么样" },
      "visual": "figure",
      "figure": "figures/xxx/fig-2.png"
    }
  ]
}

页数 8~12 页：第一页讲「为什么值得听」，最后一页给「一句话总结 + 能带走什么」。
example / visual / figure 都是可选的，按上面的规则出现在该出现的页上。
visual: "flow" 只在「可用画面」里列了方法流程图时使用；没列就不要出现任何 flow 页。

# 可用画面
${buildStageBlock(input.stage)}

# 笔记摘录（你自己读这篇论文时沉淀下来的，含具体例子 —— 优先用它来写 example 页）
${input.noteExcerpt || '（这篇论文还没有沉淀出笔记摘录）'}

# 论文正文
${input.sourceText}`
}

/**
 * 生成一份演示稿。有效页数不足时返回 undefined —— 由调用方决定报错重试，
 * 而不是拿残稿覆盖掉已有的演示。
 */
export async function runSlideDeckAgent(
  input: SlideDeckAgentInput,
  llm: LlmSettings,
  options: { signal?: AbortSignal } = {}
): Promise<SlideDeck | undefined> {
  const res = await chatCompletion(
    [
      { role: 'system', content: SLIDES_SYSTEM },
      { role: 'user', content: buildSlidesUser(input) }
    ],
    llm,
    // 讲解要一点组织语言的自由度，但高过 0.5 就会开始替论文加戏
    { temperature: 0.45, signal: options.signal }
  )
  return normalizeSlideDeck(extractJson(res.content), new Date().toISOString())
}
