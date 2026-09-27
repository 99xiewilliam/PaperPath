/**
 * 「考考我」出题 agent。
 *
 * 和其他 agent 的约定一致（见本目录）：prompt、采样参数、输出解析都收在这一个
 * 文件里，ai-service 只管「取原文 → 调它 → 落盘」。
 *
 * 两个刻意的设计（沿用 shared/quiz.ts 头注）：
 *   1. **判分在本地**（gradeQuiz 是纯函数），不为了对答案再发一次模型调用；
 *   2. 题沉淀进 frontmatter，隔几天再测一次才是复习；每次重测重新出题就成了
 *      烧 token 的机器。
 */
import { normalizeQuiz, type Quiz } from '@shared/quiz'
import type { LlmSettings } from '@shared/types'
import { chatCompletion, extractJson } from '../llm'

export const QUIZ_SYSTEM = `你是一位出「阅读理解」题的助教，服务对象是刚开始读科研论文的初学者。
你根据论文出一套自测题，检验读者是不是真的读懂了，而不是以为自己读懂了。

出题原则：
1. 考理解，不考记忆。考「这篇在解决什么、为什么现有方法不够」「方法的关键设计为什么这么选」
   「A 和 B 的本质区别」「哪个实验支撑哪个结论」；不考定义背诵和查得到的事实细节。
2. 每题 4 个选项：1 个正确，3 个干扰项必须是初学者最容易产生的误解，不能是明显错的废话。
3. 正确选项的位置要分散，不能总在同一个位置。
4. 每题附中文解析：说清为什么对、干扰项为什么错；并标注出处（章节名，如 §3.2 / Experiments）。
5. 只依据给定原文出题；原文没有的内容不出，干扰项也不得捏造论文没说的结论。
6. 输出必须是合法 JSON，不要代码块包裹。`

export function buildQuizUser(title: string, sourceText: string): string {
  return `# 论文
《${title}》

# 输出 JSON
{
  "questions": [
    {
      "q": "题干（中文，是一个真问题，不是填空）",
      "options": ["选项A", "选项B", "选项C", "选项D"],
      "answer": 0,
      "why": "解析：为什么对、干扰项为什么错",
      "source": "§3.2"
    }
  ]
}

题量 5~8 道，难度递进：先考「这篇在解决什么问题」，再考方法的关键取舍，最后考实验结论与局限。

# 论文正文
${sourceText}`
}

export interface QuizAgentInput {
  title: string
  /** 按章节挑过的原文片段（由调用方用 sourceBlock 组装） */
  sourceText: string
}

/**
 * 出一套题。有效题不足时返回 undefined —— 由调用方决定报错重试，
 * 而不是拿残题覆盖掉已有的题。
 */
export async function runQuizAgent(
  input: QuizAgentInput,
  llm: LlmSettings,
  options: { signal?: AbortSignal } = {}
): Promise<Quiz | undefined> {
  const res = await chatCompletion(
    [
      { role: 'system', content: QUIZ_SYSTEM },
      { role: 'user', content: buildQuizUser(input.title, input.sourceText) }
    ],
    llm,
    // 出题要有点绕弯的想象力（干扰项设计），但温度别高到编内容
    { temperature: 0.4, signal: options.signal }
  )
  return normalizeQuiz(extractJson(res.content), new Date().toISOString())
}
