/**
 * 演示文稿：把一篇论文讲给**没读过它的人**听。
 *
 * 和 quiz / flow / mindmap 是同一类产物 —— 一次模型调用产出的结构化 JSON，
 * 存进笔记 frontmatter 的 `slides` 键（索引里不建列，读盘取回，见 vault.ts）。
 *
 * 为什么不做「导出成 pptx 文件」：真正要的是「一页一页讲」这件事本身，而应用里
 * 已经有一整套现成的东西可以直接搬上台 —— 原文、方法流程图、思维导图、用户自己
 * 从 PDF 上截下来的图、一句话总结。导出成文件反而把这些拆散了，改一次又要导一次。
 *
 * 这里只有类型与纯函数（容错解析 + 图纸降级 + 画面上台保证）；
 * prompt 与模型调用在 src/main/agents/slides.ts（流程图在 src/main/agents/flow.ts）。
 */
import { normalizeMethodFlow, type MethodFlow } from './flow'

/**
 * 演示稿的格式 / 口径版本号。
 *
 * 存在的理由只有一个：**讲稿会持久化进 frontmatter**（生成一次要花钱也要花时间），
 * 所以改了 prompt 或 Slide 结构之后，已经存在的那份不会自动变好 —— 界面上还是那份
 * 旧稿，看起来就像「新功能没生效」。把版本号存进 deck，界面就能提示「这份是旧版
 * 生成的，重新生成一次」。**凡动 prompt 或 Slide 结构，就把这个数加一。**
 *
 * 版本轨迹：2 = 加例子页 / 原文图 / 流程图兜底；3 = 流程图改由专职 agent
 * （agents/flow.ts）在讲稿之前单独画好落进 frontmatter，讲稿不再内嵌自画的 flow。
 */
export const SLIDE_DECK_REVISION = 3

/**
 * 这一页「用画面上台」而不是一屏文字。
 *
 *   flow    论文里的方法流程图（不是原文的图，是我们按原文重绘的结构图）
 *   mindmap 全篇思维导图
 *   figure  用户从 PDF 上截下来的原文图（框架图 / 结果图 / 伪代码…）
 */
export type SlideVisual = 'flow' | 'mindmap' | 'figure'

/**
 * 走一遍具体例子。
 *
 * 为什么单独做成一个字段而不是几条要点：讲解系统时，「一堆要点」和
 * 「拿一个具体输入走一遍」是两种认知 —— 后者才让人真的看懂。版面也应该不一样，
 * 所以不留成字符串列表。
 */
export interface SlideExample {
  /** 具体输入 / 场景，一句话 */
  input: string
  /** 系统怎么走：2~5 步 */
  steps: string[]
  /** 走出来是什么样 */
  output?: string
}

export interface Slide {
  /** 标题就是这一页的结论，不是「方法」这种空标题 */
  title: string
  bullets: string[]
  /** 口播讲稿：演示时按 P 才显示，是给自己兜底的，可以比要点更口语 */
  note?: string
  /** 出处（§3.2 / Fig.2 / Table.1），让听众知道话有来源 */
  source?: string
  visual?: SlideVisual
  /** visual === 'figure' 用哪张图：相对知识库根的路径（figures/<id>/fig-N.png） */
  figure?: string
  /**
   * 这一页自带的流程图（**旧版讲稿的遗留字段**，revision 3 起不再产出）。
   *
   * 旧口径让讲稿 agent 在 slide 里顺手画一张；新版把「画流程图」拆给了专职
   * agent（agents/flow.ts），画好落进 frontmatter 的 `flow:`，讲稿页只用
   * `visual: 'flow'` 引用它。字段留着是为了旧稿还能照原样渲染。
   */
  flow?: MethodFlow
  /** 具体例子页：输入 → 步骤 → 输出 */
  example?: SlideExample
}

export interface SlideDeck {
  /** 一句话说明这份演示面向谁、大概讲多久 */
  audience?: string
  slides: Slide[]
  createdAt?: string
  /** 生成它的口径版本，见 SLIDE_DECK_REVISION；旧稿没有这个键 */
  revision?: number
}

/*
 * 页数与字数上限。
 *
 * 页数下限不是形式：少于 4 页讲不清「为什么值得听 → 问题 → 做法 → 证据」这条线，
 * 听众会跟不上；上限是防模型话多 —— 十几页之后没人记得住。
 */
const MIN_SLIDES = 4
const MAX_SLIDES = 16
const MIN_BULLETS = 1
const MAX_BULLETS = 6
const MAX_TITLE = 48
const MAX_BULLET = 160
const MAX_NOTE = 400
const MAX_SOURCE = 40
const MAX_AUDIENCE = 120
const MAX_EXAMPLE_INPUT = 200
const MAX_EXAMPLE_STEP = 120
const MIN_EXAMPLE_STEPS = 2
const MAX_EXAMPLE_STEPS = 5

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 解析 example；步骤少于两步就不算「走了一遍」，整块丢掉 */
function normalizeExample(raw: unknown): SlideExample | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const source = raw as Record<string, unknown>
  const input = str(source.input).slice(0, MAX_EXAMPLE_INPUT)
  const steps = (Array.isArray(source.steps) ? source.steps : [])
    .map((s) => str(s).slice(0, MAX_EXAMPLE_STEP))
    .filter(Boolean)
    .slice(0, MAX_EXAMPLE_STEPS)
  if (!input || steps.length < MIN_EXAMPLE_STEPS) return undefined

  const output = str(source.output).slice(0, MAX_EXAMPLE_INPUT)
  return { input, steps, ...(output ? { output } : {}) }
}

/**
 * 把模型返回的东西收敛成可渲染的演示稿；**有效页数不足时返回 undefined**。
 *
 * 返回 undefined 而不是「有几页算几页」：两三页的「演示」给不出任何完整讲解，
 * 调用方应该提示重试（与 normalizeQuiz / normalizeMethodFlow 同一个约定 ——
 * undefined 也意味着「不写这个键」，值为 undefined 的键会让 js-yaml 抛错）。
 */
export function normalizeSlideDeck(raw: unknown, fallbackCreatedAt = ''): SlideDeck | undefined {
  // 模型偶尔直接吐数组，容错（同 normalizeQuiz）
  const root = Array.isArray(raw)
    ? ({ slides: raw } as Record<string, unknown>)
    : ((raw ?? {}) as Record<string, unknown>)
  const rawSlides = Array.isArray(root.slides) ? root.slides : []

  const slides: Slide[] = []
  for (const item of rawSlides) {
    if (slides.length >= MAX_SLIDES) break
    const slide = (item ?? {}) as Record<string, unknown>
    const title = str(slide.title).slice(0, MAX_TITLE)
    // 没标题的页投出去只剩一屏光秃秃的要点，听众不知道这一页在讲什么
    if (!title) continue

    const bullets = (Array.isArray(slide.bullets) ? slide.bullets : [])
      .map((b) => str(b).slice(0, MAX_BULLET))
      .filter(Boolean)
      .slice(0, MAX_BULLETS)

    const rawVisual = str(slide.visual)
    let visual: SlideVisual | undefined =
      rawVisual === 'flow' || rawVisual === 'mindmap' || rawVisual === 'figure'
        ? rawVisual
        : undefined
    const figure = str(slide.figure)
    // 点名了原文图却没给路径 = 这一页无从渲染，退回普通要点页（要点还在，别整页丢）
    if (visual === 'figure' && !figure) visual = undefined

    /*
     * 旧版讲稿页里可能内嵌自画的流程图（revision 3 起改由专职 agent 产出、
     * 不再嵌在页里）。读旧稿时照常收敛：有图就等同于点名了 flow 页 ——
     * 不必再多写一个 visual 字段，多一个字段就多一处两边对不上的机会。
     */
    const flow = normalizeMethodFlow(slide.flow)
    if (!visual && flow) visual = 'flow'

    const example = normalizeExample(slide.example)
    // 一页总得有东西可看：要点、画面、或者一个具体例子
    if (!visual && !example && bullets.length < MIN_BULLETS) continue

    const note = str(slide.note).slice(0, MAX_NOTE)
    const source = str(slide.source).slice(0, MAX_SOURCE)
    slides.push({
      title,
      bullets,
      // 有值的键才出现：undefined 值会让 js-yaml 抛错
      ...(visual ? { visual } : {}),
      ...(visual === 'figure' && figure ? { figure } : {}),
      ...(flow ? { flow } : {}),
      ...(example ? { example } : {}),
      ...(note ? { note } : {}),
      ...(source ? { source } : {})
    })
  }

  if (slides.length < MIN_SLIDES) return undefined

  const audience = str(root.audience).slice(0, MAX_AUDIENCE)
  const createdAt = str(root.createdAt) || fallbackCreatedAt
  /*
   * 版本号只**沿用**磁盘上的，绝不在这里补写。
   * 这个函数读盘时也会跑一遍（vault.readPaperFile），补写等于给每一份旧稿
   * 盖上新版号 —— 那正好把「旧稿要重新生成」这条提示彻底盖掉。
   */
  const revision = Number.isInteger(root.revision) && Number(root.revision) > 0 ? Number(root.revision) : undefined
  return {
    slides,
    ...(audience ? { audience } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(revision !== undefined ? { revision } : {})
  }
}

/** 把一页退回「纯要点页」：丢掉图纸相关字段，保留所有文字内容 */
function stripVisual(slide: Slide): Slide {
  // 显式重建而不是解构剔除：解构出来的丢弃变量容易被 lint 当成未使用
  const rest: Slide = { title: slide.title, bullets: slide.bullets }
  if (slide.note) rest.note = slide.note
  if (slide.source) rest.source = slide.source
  if (slide.example) rest.example = slide.example
  return rest
}

/**
 * 把「库里没有对应画面」的视觉页降级成普通页。
 *
 * 模型会把某一页标成「用流程图讲」或「用 Fig.3 讲」，但这些画面是**别处**产出的：
 * 流程图来自方法维度那次精读，原文图来自用户自己在阅读器里截的图 ——
 * 都可能压根不存在。留着 visual 渲染出来就是一页空白，降级成要点至少还能讲。
 */
export function pruneSlideVisuals(
  deck: SlideDeck,
  available: { flow: boolean; mindmap: boolean; figures: string[] }
): SlideDeck {
  const slides: Slide[] = []
  for (const slide of deck.slides) {
    let next = slide
    if (!slide.visual) {
      // 不动作
    } else if (slide.visual === 'flow') {
      // 自带的流程图不受「笔记里有没有」影响 —— 它是这一页自己的内容
      if (!available.flow && !slide.flow) next = stripVisual(slide)
    } else if (slide.visual === 'mindmap') {
      if (!available.mindmap) next = stripVisual(slide)
    } else if (!(slide.figure && available.figures.includes(slide.figure))) {
      next = stripVisual(slide)
    }
    /*
     * 摘掉画面之后什么都不剩的页只剩一个标题，对着空屏最让人发愣 —— 直接不要。
     * （页数可能因此少一两页，但整份演示本来就 8~12 页，不影响完整讲完。）
     */
    if (!next.visual && !next.example && !next.bullets.length) continue
    slides.push(next)
  }
  return slides.length ? { ...deck, slides } : deck
}

/** 标题里出现这些词，多半就是「讲我们怎么做」的那一页 */
const METHOD_HINT = /方法|做法|框架|系统|流程|管线|管道|pipeline|method|approach/i

function insertSlide(deck: SlideDeck, slide: Slide, index: number): SlideDeck {
  const slides = [...deck.slides]
  slides.splice(Math.max(0, Math.min(index, slides.length)), 0, slide)
  return { ...deck, slides: slides.slice(0, MAX_SLIDES) }
}

/**
 * 保证一份演示里**至少有画面**，而不是一路念文字。
 *
 * 为什么不让模型自己决定：它只看得到原文，看不见我们手上有什么画面道具 ——
 * 实测它经常忘了安排图，于是整份演示变成纯文字，而「讲系统」最该有的那张图
 * 反而没上台。所以这里兜两层，都是纯函数、可测：
 *
 *   1. 有方法流程图 → 安排一页，插在「讲方法」那一页之后（听众刚听完文字描述，
 *      正是该看图的时候）。
 *   2. 一层都没凑出画面时 → 用全篇思维导图补一页放在开场之后当路标。
 *      一份从头到尾没有图的演示，等于把论文念一遍。
 */
export function ensureVisualSlides(
  deck: SlideDeck,
  available: { flow: boolean; mindmap: boolean }
): SlideDeck {
  let next = deck

  if (available.flow && !next.slides.some((s) => s.visual === 'flow')) {
    const at = next.slides.findIndex((s) => METHOD_HINT.test(s.title))
    next = insertSlide(
      next,
      {
        title: '方法流程全貌',
        bullets: [],
        visual: 'flow',
        note: '这一页照重绘的流程图讲：一个框是一步，框下小字是它的出处。按箭头顺序走一遍，别逐条念。'
      },
      at >= 0 ? at + 1 : Math.min(3, next.slides.length)
    )
  }

  if (available.mindmap && !next.slides.some((s) => s.visual)) {
    next = insertSlide(
      next,
      {
        title: '全篇结构一览',
        bullets: [],
        visual: 'mindmap',
        note: '先用这张全貌图给听众定位：主线是哪几条分支，接下来每一页落在哪个分支上。点两三个分支就够，别把树念一遍。'
      },
      1
    )
  }

  return next
}
