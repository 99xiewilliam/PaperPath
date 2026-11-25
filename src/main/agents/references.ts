/**
 * 参考文献抽取 agent：把 PDF 抽出来的参考文献原文整理成结构化列表。
 *
 * 不用规则解析：编号式（[1] …）还好办，作者-年份式的条目边界和标题位置
 * 各家格式都不一样，规则写出来只能覆盖一部分，模型整理反而稳定。
 */
import { normalizeReferences, type PaperReference } from '@shared/references'
import type { LlmSettings } from '@shared/types'
import { chatCompletion, extractJson } from '../llm'

const SYSTEM = `你负责整理学术论文的参考文献列表。输入是从 PDF 抽出来的参考文献原文，
换行和连字符可能被打断，条目之间也可能没有明确分隔。
要求：
1. 逐条识别，不要遗漏，也不要编造原文里没有的条目。
2. 标题还原成完整的一行（去掉 PDF 断行带来的多余空格与连字符）。
3. authors 只写第一作者姓氏 + et al.（只有一两位作者就照写）。
4. 原文里出现 arXiv 编号（如 2303.08774）就填上，没有就留空字符串。
5. 输出必须是合法 JSON，不要代码块包裹。`

export async function runReferenceAgent(
  block: string,
  llm: LlmSettings
): Promise<PaperReference[]> {
  const res = await chatCompletion(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `# 输出 JSON
{"refs": [{"title": "...", "authors": "Brown et al.", "year": 2020, "arxivId": ""}]}

# 参考文献原文
${block}`
      }
    ],
    llm,
    { json: true, temperature: 0, maxTokens: Math.max(llm.maxTokens ?? 0, 8192) }
  )
  const payload = (extractJson(res.content) ?? {}) as Record<string, unknown>
  return normalizeReferences(payload.refs)
}
