import { useEffect, useState } from 'react'
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  GraduationCap,
  Loader2,
  RotateCcw,
  Sparkles,
  XCircle
} from 'lucide-react'
import { gradeQuiz, type Quiz } from '@shared/quiz'
import { cn, errorMessage } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { Button, Modal } from './ui'

type Phase = 'intro' | 'answering' | 'result'

/**
 * 「考考我」自测面板。
 *
 * 像语文/英语阅读理解：答完立刻判分（gradeQuiz 是本地纯函数，
 * 对答案不烧模型调用），每题带解析和出处 —— 答错的人知道回哪里重读，
 * 这比分数本身重要。
 *
 * 题是沉淀在笔记 frontmatter 里的：重测用同一套题；「重新出题」才调用模型。
 */
export function QuizPanel({
  paperId,
  quiz,
  open,
  onClose,
  onGenerated
}: {
  paperId: string
  quiz: Quiz | undefined
  open: boolean
  onClose: () => void
  /** 新题已在主进程落盘，这里只同步渲染层的本地 meta */
  onGenerated: (quiz: Quiz) => void
}): JSX.Element {
  const toast = useAppStore((s) => s.toast)
  const [phase, setPhase] = useState<Phase>('intro')
  const [answers, setAnswers] = useState<(number | null)[]>([])
  const [current, setCurrent] = useState(0)
  const [generating, setGenerating] = useState(false)

  // 换论文 / 重新打开面板时回到起点；已答的题不保留（重新开始就是重新测）
  useEffect(() => {
    if (open) {
      setPhase('intro')
      setAnswers(quiz ? Array.from({ length: quiz.questions.length }, () => null) : [])
      setCurrent(0)
    }
    // quiz 重新生成后长度可能变，作答状态以打开那一刻的题为准
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, paperId])

  const generate = async (): Promise<void> => {
    if (generating) return
    setGenerating(true)
    try {
      const res = await window.papervault.ai.quiz(paperId)
      if (!res.ok || !res.quiz) {
        toast(res.message ?? '出题失败', 'error')
        return
      }
      onGenerated(res.quiz)
      setAnswers(Array.from({ length: res.quiz.questions.length }, () => null))
      setCurrent(0)
      setPhase('intro')
      toast(`出了 ${res.quiz.questions.length} 道题`, 'success')
    } catch (err) {
      toast(`出题失败：${errorMessage(err)}`, 'error')
    } finally {
      setGenerating(false)
    }
  }

  const start = (): void => {
    if (!quiz) return
    setAnswers(Array.from({ length: quiz.questions.length }, () => null))
    setCurrent(0)
    setPhase('answering')
  }

  const grade = quiz && phase === 'result' ? gradeQuiz(quiz, answers) : null
  const question = quiz?.questions[current]

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-1.5">
          <GraduationCap className="h-4 w-4 text-brand-mist" />
          考考我 · 读懂了没有
        </span>
      }
      subtitle="答错不可怕 —— 每题都有解析和出处，知道回哪里重读才是目的"
      width="max-w-xl"
    >
      {/* 出题中 */}
      {generating ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-ink-low">
          <Loader2 className="h-4 w-4 animate-spin text-brand-soft" />
          正在读原文出题…（要设计合理的干扰项，比摘要慢一些）
        </div>
      ) : phase === 'intro' ? (
        <div className="py-4 text-center">
          {quiz ? (
            <>
              <p className="text-[13px] text-ink-high">
                这套题共 {quiz.questions.length} 道
                {quiz.createdAt ? `，出题于 ${quiz.createdAt.slice(0, 10)}` : ''}
              </p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-low">
                考的是「为什么这么做」「哪个实验支撑哪个结论」这类理解题，不是定义背诵。
                答完立刻判分，每题带解析与原文出处。
              </p>
              <div className="mt-4 flex items-center justify-center gap-2">
                <Button variant="primary" onClick={start}>
                  开始测试
                </Button>
                <Button
                  icon={<RotateCcw className="h-3.5 w-3.5" />}
                  onClick={() => void generate()}
                >
                  重新出题
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-[13px] text-ink-high">还没有出过题</p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-low">
                AI 会按原文出 5~8 道理解题：问题动机、方法取舍、实验结论。
                出过的题会存进笔记，随时可以回来重测。
              </p>
              <div className="mt-4">
                <Button
                  variant="primary"
                  icon={<Sparkles className="h-3.5 w-3.5" />}
                  onClick={() => void generate()}
                >
                  出题
                </Button>
              </div>
            </>
          )}
        </div>
      ) : phase === 'answering' && quiz && question ? (
        <div>
          <p className="mb-3 text-[11px] text-ink-low">
            第 {current + 1} / {quiz.questions.length} 题
            {question.source ? (
              <span className="ml-2 font-mono text-brand-mist">{question.source}</span>
            ) : null}
          </p>
          <p className="mb-3 text-[13.5px] font-medium leading-relaxed text-ink-high">
            {question.q}
          </p>
          <div className="space-y-1.5">
            {question.options.map((option, i) => (
              <button
                key={i}
                onClick={() =>
                  setAnswers((prev) => prev.map((a, ai) => (ai === current ? i : a)))
                }
                className={cn(
                  'flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-[12.5px] leading-relaxed transition',
                  answers[current] === i
                    ? 'border-brand/60 bg-brand/10 text-ink-high'
                    : 'border-line text-ink-mid hover:border-strong hover:text-ink-high'
                )}
              >
                <span className="shrink-0 font-mono text-[11px] text-ink-low">
                  {String.fromCharCode(65 + i)}.
                </span>
                {option}
              </button>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between">
            <Button
              icon={<ChevronLeft className="h-3.5 w-3.5" />}
              disabled={current === 0}
              onClick={() => setCurrent((c) => Math.max(0, c - 1))}
            >
              上一题
            </Button>
            <span className="text-[10.5px] text-ink-low">
              已答 {answers.filter((a) => a !== null).length} / {quiz.questions.length}
            </span>
            {current < quiz.questions.length - 1 ? (
              <Button
                variant="primary"
                icon={<ChevronRight className="h-3.5 w-3.5" />}
                onClick={() => setCurrent((c) => c + 1)}
              >
                下一题
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setPhase('result')}>
                交卷
              </Button>
            )}
          </div>
        </div>
      ) : phase === 'result' && quiz && grade ? (
        <div>
          <p className="mb-1 text-center text-[15px] font-semibold text-ink-high">
            答对 {grade.correct} / {grade.total}
          </p>
          <p className="mb-4 text-center text-[11px] text-ink-low">
            {grade.correct === grade.total
              ? '这次全部答对了。试着再用自己的话讲清方法和证据，过几天回来复习。'
              : '这些题提示了值得再读的地方。结合解析回到原文核对，AI 题目和解析也可能有误。'}
          </p>
          <div className="max-h-[46vh] space-y-2.5 overflow-y-auto pr-1">
            {quiz.questions.map((q, i) => (
              <div
                key={i}
                className={cn(
                  'rounded-lg border px-3 py-2.5',
                  grade.results[i] ? 'border-line' : 'border-warn/40 bg-warn/[0.06]'
                )}
              >
                <p className="flex items-start gap-1.5 text-[12.5px] font-medium leading-snug text-ink-high">
                  {grade.results[i] ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />
                  ) : (
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
                  )}
                  {q.q}
                </p>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-mid">
                  正确答案：{String.fromCharCode(65 + q.answer)}. {q.options[q.answer]}
                  {!grade.results[i] && answers[i] !== null ? (
                    <span className="text-warn">
                      （你选了 {String.fromCharCode(65 + (answers[i] ?? 0))}）
                    </span>
                  ) : null}
                </p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-low">{q.why}</p>
                {q.source ? (
                  <p className="mt-1 font-mono text-[10px] text-brand-mist">出处：{q.source}</p>
                ) : null}
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button variant="primary" onClick={start}>
              再测一次
            </Button>
            <Button icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => void generate()}>
              重新出题
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}
