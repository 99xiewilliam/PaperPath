/**
 * 原文图表（从 PDF 里裁下来的图）的共享约定。
 *
 * 图存在知识库根目录的 `figures/<paperId>/` 下 —— 刻意**不放进 `.papervault/`**：
 * 那个目录是索引与缓存，「删掉重建」是 README 里写明的常规操作，图放进去会被
 * 一起清掉；而图和笔记一样是需要沉淀的内容，要能被人直接看到、跟着 Git 走。
 */

/**
 * 这条通道只送图片。
 * 放开扩展名等于给渲染层开一个「读知识库里任意文件」的通用口子，不值得。
 */
export const FIGURE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const

export function isImagePath(path: string): boolean {
  const lower = (path ?? '').toLowerCase()
  return FIGURE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** 收敛成白名单里的扩展名；认不出来的一律当 PNG */
export function normalizeFigureExtension(ext: string | undefined): string {
  const lower = (ext ?? '').toLowerCase()
  return (FIGURE_EXTENSIONS as readonly string[]).includes(lower) ? lower : '.png'
}

/**
 * blob URL 要带上正确的 MIME —— 只写 image/png 的话，webp / gif
 * 在部分引擎里会解码失败，表现为图裂。
 */
export function imageMimeOf(path: string): string {
  const lower = (path ?? '').toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'image/png'
}

export function figureMarkdown(relPath: string, alt = '原文图表'): string {
  return `![${alt}](${relPath})`
}

/**
 * 把一段 Markdown 片段（如图表引用）插进章节正文，返回新正文与「片段结束位置」。
 *
 * 不让调用方直接字符串拼接的原因：图片语法必须**独占一行**才会被渲染成图 ——
 * 卡在一句话中间、或紧贴上一行结尾都会被吞进普通段落里。这里统一补齐
 * 段落分隔，并把插入结束的位置还给调用方：连续截几张图时拿它当下一次的
 * 光标，片段才会按截图顺序往下排，而不是全挤进同一个位置倒着堆。
 *
 * caret 传 null（从没在笔记里放过光标）视为追加到末尾；越界一律收敛到
 * 正文长度 —— 记录光标到真正插入之间，内容可能已经被 AI 重写或手动改过。
 */
export function insertMarkdownSnippet(
  content: string,
  caret: number | null,
  snippet: string
): { next: string; at: number } {
  const pos = Math.min(Math.max(caret ?? content.length, 0), content.length)
  let before = content.slice(0, pos)
  let after = content.slice(pos)

  // 片段前补出段落分隔：已是空行就不动，单个换行补成两个，没有换行补两个
  if (before.trim()) {
    if (before.endsWith('\n\n')) {
      /* 已经是段落分隔 */
    } else if (before.endsWith('\n')) {
      before += '\n'
    } else {
      before += '\n\n'
    }
  }
  // 片段后同理：原来这行剩下的字挪到下一行，别粘在图片语法后面
  if (after.trim() && !after.startsWith('\n')) after = `\n${after}`

  return { next: before + snippet + after, at: before.length + snippet.length }
}

/**
 * 把 Markdown 里的相对路径解析成「相对知识库根目录」的路径。
 *
 * 为什么需要它：笔记里存的是**相对笔记文件**的路径（`../figures/<id>/fig-1.png`）——
 * 这样知识库整个搬走不会断链，在 Obsidian / VS Code 里也能正常显示。
 * 而渲染时得先知道这条路径从知识库根算起落在哪，才能去读它的字节。
 *
 * 约定：
 *   - 带协议的地址（`http:`、`data:`、`blob:`、自定义协议）返回 null，交给调用方原样用
 *   - 以 `/` 开头 = 相对知识库根
 *   - `..` 一路退出知识库根 → null（否则就能拿它去请求库外的文件）
 */
export function resolveVaultRelative(baseDir: string, src: string): string | null {
  const raw = (src ?? '').trim()
  if (!raw) return null
  /*
   * 协议前缀一律拒掉。注意 Windows 盘符 `C:` 也长这样 —— 那种绝对路径同样
   * 不该由这里处理，一起拒掉最省心。
   */
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null

  const stack = raw.startsWith('/') ? [] : (baseDir ?? '').split('/').filter(Boolean)
  for (const part of raw.replace(/^\/+/, '').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      // 已经在根上还往上走 = 越界
      if (!stack.length) return null
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack.join('/')
}

/**
 * 从笔记章节里扫出「原文图出现在哪、引用它的时候在说什么」。
 *
 * 为什么需要它：演示这类要「挑一张图来讲」的功能里，模型**看不到图本身**，
 * 唯一线索就是这张图出现在哪一节、前后写了什么。没有这层上下文，它只能瞎指一张，
 * 而随机摆一张图上去比不放图更糟 —— 听众会以为那张图就对应你正在说的话。
 */
export interface FigureReference {
  /** 相对知识库根的路径（figures/<id>/fig-N.png），可直接喂给 figures:read */
  relPath: string
  /** 引用它所在的章节名；空串表示这张图还没被任何笔记引用过 */
  section: string
  /** 图前后的一小段文字，作为「这张图画的是什么」的唯一线索 */
  excerpt: string
}

const IMAGE_MD = /!\[[^\]]*\]\(\s*([^)\s]+)/g

/**
 * 把 Markdown 里的图片地址收敛成「相对知识库根」的路径。
 *
 * 笔记里存的是**相对笔记文件**的路径（`../figures/<id>/fig-1.png`）。这里直接
 * 截 `figures/` 之后的部分，而不是拿笔记位置去反推 —— 前者在「笔记被挪过目录」
 * 之后依然成立，后者会算出一个不存在的路径。
 */
export function vaultFigurePathOf(src: string): string | null {
  const clean = (src ?? '').split(/[?#]/)[0].replace(/\\/g, '/')
  const at = clean.lastIndexOf('figures/')
  if (at < 0) return null
  const rel = clean.slice(at)
  return rel.length > 'figures/'.length ? rel : null
}

export function scanFigureReferences(
  sections: Record<string, string>,
  excerptChars = 120
): FigureReference[] {
  const found = new Map<string, FigureReference>()
  for (const [section, content] of Object.entries(sections)) {
    const text = content ?? ''
    // 每个章节用一个新的正则：带 /g 的正则会在 exec 之间记住 lastIndex
    const re = new RegExp(IMAGE_MD.source, 'g')
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) {
      const relPath = vaultFigurePathOf(match[1] ?? '')
      if (!relPath || found.has(relPath)) continue
      const at = match.index
      const before = text.slice(Math.max(0, at - excerptChars), at)
      const after = text.slice(at + match[0].length, at + match[0].length + excerptChars)
      found.set(relPath, {
        relPath,
        section,
        excerpt: `${before} … ${after}`.replace(/\s+/g, ' ').trim()
      })
    }
  }
  return [...found.values()]
}
