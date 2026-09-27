/**
 * 文件访问授权表（capability 模型）。
 *
 * 渲染层能通过 `file:readBinary` 读到字节、能通过 `paper:importPdf` 复制进
 * 知识库的，只应该是**用户刚刚亲手选进来或拖进来的那份 PDF**。
 *
 * 之前这两个入口都只校验了扩展名，等于「只要是 .pdf 就放行」：渲染层一旦被注入
 * （或我们自己传错一个路径），磁盘上任意一个 .pdf 都能被读出来，甚至整个复制进
 * 知识库再读回。改成授权表之后，主进程只认自己亲眼看见用户授权过的绝对路径。
 *
 * 授权只在这两个用户显式动作时发生：
 *   - `paper:pickPdfs`：系统文件选择框返回的路径
 *   - `file:grant`：preload 把拖拽落下的路径报上来
 *
 * 这个模块刻意不依赖任何其它 main 模块（只用到 path），这样它可以被
 * vault / import-service / ipc 任意一层引用而不产生环。
 */
import { basename, extname, resolve } from 'path'

const granted = new Set<string>()

/**
 * 归一化成绝对路径；不是 PDF 就返回 null。
 *
 * 只放行 .pdf：这两个入口存在的意义就是导入论文，没有别的合法用途。
 */
function normalize(path: string): string | null {
  if (typeof path !== 'string' || !path.trim()) return null
  if (extname(path).toLowerCase() !== '.pdf') return null
  return resolve(path)
}

/** 记录用户显式授权的文件路径，返回真正新增的条数（去重后） */
export function grantPaths(paths: readonly string[]): number {
  let added = 0
  for (const p of paths ?? []) {
    const abs = normalize(p)
    if (!abs || granted.has(abs)) continue
    granted.add(abs)
    added++
  }
  return added
}

export function isGranted(path: string): boolean {
  const abs = normalize(path)
  return abs !== null && granted.has(abs)
}

/**
 * 校验并返回规范化后的绝对路径；未授权直接抛错。
 *
 * 错误信息只带文件名不带目录 —— 它会被回显到渲染层、也可能进日志，
 * 而完整路径本身就是隐私（用户名、目录结构）。
 */
export function assertGranted(path: string, action: string): string {
  const abs = normalize(path)
  if (!abs) throw new Error(`${action}：只支持 PDF 文件。`)
  if (!granted.has(abs)) {
    throw new Error(`${action}：${basename(abs)} 不是用户选择的文件，已拒绝访问。`)
  }
  return abs
}

/** 仅供测试重置授权表 */
export function clearGrants(): void {
  granted.clear()
}
