/**
 * json.ts —— 从模型输出里稳健地取出 JSON（与厂商无关）。
 */
import { LlmError } from './types'

/**
 * 扫描出文本里所有「括号平衡」的 JSON 片段（字符串内的括号不计入）。
 * 需要它是因为部分中转服务的 JSON 模式会把 `{"type":"json_object"}` 这样的
 * 提示对象混进输出，简单取「第一个 { 到最后一个 }」会拼出非法 JSON。
 */
function balancedJsonSpans(text: string): string[] {
  const spans: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}' && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        spans.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return spans
}

/**
 * 修补被截断的 JSON：回退到最后一个「值完整」的位置，再补齐未闭合的括号。
 *
 * 推理型模型会把 reasoning token 算进 max_tokens，很容易把 JSON 尾部切掉。
 * 与其整篇失败，不如把已经生成的部分抢救出来。
 */
function repairTruncatedJson(raw: string): unknown | null {
  const start = raw.indexOf('{')
  if (start < 0) return null
  const text = raw.slice(start)

  let depth = 0
  let inString = false
  let escaped = false
  /**
   * 最后一个可以安全截断的位置：`}`、`]` 或 `,` 之后。
   * 截在这些位置后面，剩下的部分一定是合法的 JSON 前缀（可能带个悬挂逗号）。
   * 注意不能在「键名字符串」后截断——那会留下 { "key" 这种缺值的结构。
   */
  let cut = -1

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') {
      depth++
      continue
    }
    if (ch === '}' || ch === ']') {
      depth--
      cut = i + 1
      if (depth === 0) return null // 本来就闭合了，说明不是截断场景
      continue
    }
    if (ch === ',') cut = i + 1
  }

  if (cut < 0) return null
  let body = text.slice(0, cut).replace(/,\s*$/, '')

  // 补齐未闭合的括号
  const closers: string[] = []
  let str = false
  let esc = false
  for (const ch of body) {
    if (str) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') str = false
      continue
    }
    if (ch === '"') str = true
    else if (ch === '{') closers.push('}')
    else if (ch === '[') closers.push(']')
    else if (ch === '}' || ch === ']') closers.pop()
  }
  if (str) body += '"'
  body += closers.reverse().join('')

  try {
    const parsed = JSON.parse(body) as unknown
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 从模型输出里稳健地取出 JSON 对象 */
export function extractJson<T = unknown>(raw: string): T {
  const text = (raw ?? '').trim()
  const candidates: { value: unknown; keys: number }[] = []

  const consider = (source: string): void => {
    if (!source) return
    try {
      const parsed = JSON.parse(source) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        candidates.push({ value: parsed, keys: Object.keys(parsed as object).length })
      }
    } catch {
      /* 这个片段不是合法 JSON，换下一个 */
    }
  }

  consider(text)
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) consider(fence[1].trim())
  for (const span of balancedJsonSpans(text)) consider(span)

  // 最后一道防线：输出被 max_tokens 截断时，抢救已经生成的部分
  if (!candidates.length) {
    const repaired = repairTruncatedJson(text)
    if (repaired) return repaired as T
  }

  if (!candidates.length) {
    throw new LlmError(`无法解析模型返回的 JSON：${text.slice(0, 300)}`)
  }
  // 取「顶层键最多」的那个对象，避免误拿到前导提示对象
  candidates.sort((a, b) => b.keys - a.keys)
  return candidates[0].value as T
}
