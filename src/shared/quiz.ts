/**
 * 「考考我」理解力自测。
 *
 * 给初学者的功能：读论文最常见的错觉是「看了一遍 = 读懂了」。
 * 像语文/英语阅读理解那样，让模型出一套题，读者答完立刻知道自己
 * 哪里的理解是假的 —— 每题带解析和出处，答错了知道回哪里重读。
 *
 * 两个刻意的设计：
 *   1. **判分在本地**（gradeQuiz 是纯函数），不为了对答案再发一次模型调用；
 *      解析在出题时就一并生成好。
 *   2. 题目要沉淀进 frontmatter（跟流程图一个路子）：出过的题留着，
 *      隔几天再测一次才是真正的复习；每次重测都重新出题就把这个变成烧 token 的机器。
 *
 * 这里只有类型与纯函数（容错解析 + 本地判分）；出题的 prompt 与模型调用
 * 在 src/main/agents/quiz.ts。
 */

export interface QuizQuestion {
  /** 题干（中文） */
  q: string
  /** 选项，2~5 个 */
  options: string[]
  /** 正确选项下标 */
  answer: number
  /** 解析：为什么对、干扰项为什么错 */
  why: string
  /** 出处（章节 / 页码，例如「§3.2」「Experiments」） */
  source?: string
}

export interface Quiz {
  questions: QuizQuestion[]
  /** 出题时间；重测多次也不刷新它 —— 题是同一套 */
  createdAt?: string
}

/** 题量上下限：太少测不出理解盲区，太多初学者做不完 */
const MIN_QUESTIONS = 3
const MAX_QUESTIONS = 8
const MAX_Q = 200
const MAX_OPTION = 120
const MAX_WHY = 300
const MAX_SOURCE = 40

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 把模型返回的 quiz 收敛成可渲染的结构；**有效题目不足时返回 undefined**。
 *
 * 返回 undefined 而不是「有几道算几道」：1~2 道题的「自测」给不出任何
 * 信号，调用方应该提示重试（和 normalizeMethodFlow 同一个约定，
 * undefined 也意味着「不写这个键」—— undefined 值会让 js-yaml 抛错）。
 */
export function normalizeQuiz(raw: unknown, fallbackCreatedAt = ''): Quiz | undefined {
  const root = (raw ?? {}) as Record<string, unknown>
  const rawQuestions = Array.isArray(root.questions) ? root.questions : []

  const questions: QuizQuestion[] = []
  for (const item of rawQuestions) {
    if (questions.length >= MAX_QUESTIONS) break
    const q = (item ?? {}) as Record<string, unknown>
    const text = str(q.q).slice(0, MAX_Q)
    // Keep the correct option's identity when blank / duplicate choices are removed.
    const original = (Array.isArray(q.options) ? q.options : []).map((o) => str(o).slice(0, MAX_OPTION))
    const rawAnswer = typeof q.answer === 'number' ? q.answer : typeof q.answer === 'string' && /^\d+$/.test(q.answer) ? Number(q.answer) : NaN
    if (!Number.isInteger(rawAnswer) || rawAnswer < 0 || rawAnswer >= original.length || !original[rawAnswer]) continue
    const options = [...new Set(original.filter(Boolean))]
    if (options.length > 5) continue
    const answer = options.indexOf(original[rawAnswer])
    const why = str(q.why).slice(0, MAX_WHY)
    // 解析是这功能的一半价值：答错的人全靠它知道回哪里重读。没解析的题不要
    if (!text || options.length < 2 || !why) continue
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) continue

    const source = str(q.source).slice(0, MAX_SOURCE)
    questions.push({
      q: text,
      options,
      answer,
      why,
      // 有值的键才出现：undefined 值会让 js-yaml 抛错
      ...(source ? { source } : {})
    })
  }

  if (questions.length < MIN_QUESTIONS) return undefined

  const createdAt = str(root.createdAt) || fallbackCreatedAt
  return { questions, ...(createdAt ? { createdAt } : {}) }
}

/* ------------------------------------------------------------------ */
/*  判分（纯函数，本地完成，不再调用模型）                                  */
/* ------------------------------------------------------------------ */

export interface QuizGrade {
  /** 每题对错，与 questions 对齐 */
  results: boolean[]
  correct: number
  total: number
}

/** 未作答 / 答案下标越界都算错 —— 自测不是考试，跳过就是一种回答 */
export function gradeQuiz(quiz: Quiz, answers: (number | null)[]): QuizGrade {
  const results = quiz.questions.map((q, i) => answers[i] === q.answer)
  return {
    results,
    correct: results.filter(Boolean).length,
    total: quiz.questions.length
  }
}
