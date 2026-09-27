/**
 * 学习记录的共享契约。
 *
 * 「学习笔记」面板（三遍读法 + 手动填写）连同「复习安排」都已经删掉，这里只剩两样：
 *   1. `LEARNING_KEYS`：老文件里可能还留着的 `学习笔记 · …` 章节键，检索时给它们优先位置；
 *   2. `LearningReview` 与它的归一化：frontmatter 里可能还写着的复习元数据 ——
 *      保留类型是为了让它**原样往返**，而不是在下次保存时被静默抹掉。
 */

/**
 * 那 7 个「学习笔记 · …」章节的键。
 *
 * 功能删了，但**老文件里可能还有这些章节**（你自己写下的内容），所以检索索引仍然
 * 把它们排在最前面：长论文的检索文本会被截断，而这些是最不该被截掉的部分。
 */
export const LEARNING_KEYS: string[] = [
  '学习笔记 · 研究问题',
  '学习笔记 · 阅读目标',
  '学习笔记 · 方法复述',
  '学习笔记 · 结论与证据',
  '学习笔记 · 术语与疑问',
  '学习笔记 · 局限与联系',
  '学习笔记 · 下一步行动'
]

export type ReviewRating = 'again' | 'hard' | 'good'
export interface LearningReview {
  reviewedAt: string
  nextReviewAt: string
  intervalDays: number
  count: number
  rating: ReviewRating
}

export function normalizeLearningReview(raw: unknown): LearningReview | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const { reviewedAt, nextReviewAt, intervalDays, count, rating } = value
  if (typeof reviewedAt !== 'string' || !Number.isFinite(Date.parse(reviewedAt)) ||
      typeof nextReviewAt !== 'string' || !Number.isFinite(Date.parse(nextReviewAt)) ||
      Date.parse(nextReviewAt) <= Date.parse(reviewedAt) ||
      typeof intervalDays !== 'number' || !Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 60 ||
      typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 ||
      (rating !== 'again' && rating !== 'hard' && rating !== 'good')) return undefined
  return { reviewedAt, nextReviewAt, intervalDays, count, rating }
}

