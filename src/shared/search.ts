/**
 * 检索的查询侧逻辑（主进程与脚本共用）。
 *
 * 为什么不用 FTS5：sql.js 的构建没有编译 FTS5 模块（`no such module: fts5`），
 * FTS4 虽然可用，但对中文同样是按 token 分词——搜「检索」匹配不到「多跳检索」，
 * 而这正是中文用户最常用的检索方式。
 *
 * 所以走「把查询切成 token，每个 token 各自做子串匹配」的路子：
 *   - 中文天然支持（子串匹配就是中文用户对「搜索」的直觉）
 *   - 语义与原来的 JS 过滤完全一致，不会出现「升级后搜不到原来能搜到的」
 *   - 实测 2000 篇论文单次扫描 3~12ms，配合防抖完全够用
 *     （见 `npm run bench:search`）
 */

const CJK = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/
const WORD = /[A-Za-z0-9_]/

/**
 * 把查询切成 token：
 *   - 连续的 CJK 片段整体保留为一个 token（不做分词，靠子串匹配）
 *   - ASCII 词小写后作为一个 token
 *   - 空白与标点是分隔符
 */
export function tokenizeQuery(query: string): string[] {
  const out: string[] = []
  let i = 0
  const text = query ?? ''
  while (i < text.length) {
    const ch = text[i]
    if (CJK.test(ch)) {
      let j = i
      while (j < text.length && CJK.test(text[j])) j++
      out.push(text.slice(i, j))
      i = j
    } else if (WORD.test(ch)) {
      let j = i
      while (j < text.length && WORD.test(text[j])) j++
      out.push(text.slice(i, j).toLowerCase())
      i = j
    } else {
      i++
    }
  }
  return out
}

/** 转义 LIKE 的通配符，避免用户输入的 % 或 _ 变成通配 */
export function escapeLikePattern(token: string): string {
  return token.replace(/[\\%_]/g, (m) => `\\${m}`)
}

export interface SearchClause {
  /** WHERE 片段，token 之间是 AND */
  where: string
  params: string[]
}

/**
 * 生成 SQL 的 WHERE 片段。
 * 返回值直接拼进 SQL —— 片段里只有占位符，用户输入只走 params，不存在注入。
 */
export function buildLikeClause(column: string, query: string): SearchClause {
  const tokens = tokenizeQuery(query)
  if (!tokens.length) return { where: '', params: [] }
  return {
    where: tokens.map(() => `${column} LIKE ? ESCAPE '\\'`).join(' AND '),
    params: tokens.map((t) => `%${escapeLikePattern(t)}%`)
  }
}
