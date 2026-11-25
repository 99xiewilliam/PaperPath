/**
 * 主进程共享运行时。
 *
 * 这些东西原来都堆在 `ipc.ts` 顶部，拆模块时如果每个模块各留一份，
 * 会立刻出现两种漂移：进度广播器被注册多次（每条进度重复推送）、
 * 同一个上限常量在不同文件里写成不同的数。所以跨模块共用的部分集中在这里。
 *
 * 依赖方向：runtime 只依赖 db / settings / tasks / vault / llm，
 * 不依赖任何 service 模块 —— 否则 service 之间会绕回来形成环。
 */
import { BrowserWindow } from 'electron'
import { existsSync, statSync } from 'fs'
import { allCategories } from '@shared/taxonomy'
import { LlmError } from './llm'
import { getSettings } from './settings'
import { runInteractive, setProgressBroadcaster, TaskCancelledError, tasks } from './tasks'
import * as vault from './vault'

/* ------------------------------------------------------------------ */
/*  进度与流式输出                                                      */
/* ------------------------------------------------------------------ */

/*
 * 任务队列本身不依赖 electron（纯 Node 的冒烟测试要能直接跑任务管线），
 * 所以进度通过注入的 broadcaster 转发到所有窗口。
 */
setProgressBroadcaster((progress) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('task:progress', progress)
  }
})

/**
 * 把流式增量推给渲染层。
 * 带上 streamId 是为了让渲染层只认自己那次请求的增量——
 * 否则用户连续划两次词，第二段内容会被拼进第一个框里。
 */
export function emitStreamDelta(streamId: string, delta: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('ai:stream', { streamId, delta })
  }
}

/** 同一条流上的进度说明（问答查资料时的「正在查：…」），不进正文 */
export function emitStreamStatus(streamId: string, status: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('ai:stream', { streamId, delta: '', status })
  }
}

export function describeTaskError(err: unknown): string {
  if (err instanceof TaskCancelledError) return '任务已取消。'
  if (err instanceof LlmError) return err.message
  return (err as Error).message
}

/**
 * 把一段能力包进任务队列：统一串行、可取消、失败一律转成业务返回值而不是
 * 抛异常 —— 渲染层就不用到处 try/catch。
 *
 * 名字不叫 `aiTask` 是因为它已经不只为 AI 服务了：批量改属性 / 批量删除同样走它。
 * 串行对它们也是必要的 —— 批量改属性和 AI 精读都会写同一批 Markdown，
 * 不排队就可能互相覆盖。
 *
 * @param extra 失败时除 ok/message 之外还要补的字段（例如 content: ''）
 */
export function queuedTask<T extends { ok: boolean; message?: string }>(
  label: string,
  run: () => Promise<T>,
  extra?: Omit<T, 'ok' | 'message'>
): Promise<T> {
  return tasks.run(label, async () => {
    try {
      return await run()
    } catch (err) {
      return { ok: false, message: describeTaskError(err), ...(extra ?? {}) } as T
    }
  })
}

/**
 * 交互任务的包装：与 `queuedTask` 的唯一区别是**不排队**（见 tasks.ts 的 runInteractive）。
 *
 * 失败转返回值、extra 兜底字段这些口径保持一致，调用方不必为两种通道写两套错误处理。
 *
 * 没有 label 参数是有意的：交互任务不进顶部胶囊 —— 一旦进去，
 * 胶囊上的「取消」按钮会去取消批处理任务，点下去取消错对象。
 * 但**进度本身是可以发的**（演示生成就在发，好让那个全屏浮层显示当前跑到哪一步），
 * 前提是发出来的进度带上自己的 stage，别被别的界面当成批处理任务的进度。
 *
 * `key` 给长任务用：它让这个任务能被 `cancelInteractive(key)` **单独**取消。
 */
export function interactiveTask<T extends { ok: boolean; message?: string }>(
  run: (signal: AbortSignal) => Promise<T>,
  extra?: Omit<T, 'ok' | 'message'>,
  /**
   * 可选标识：给了就能被 `cancelInteractive(key)` **单独**取消。
   *
   * 排在 `extra` 后面而不是前面：`extra` 已经占着第二参数（划词那条在用），
   * 挪它会静默改掉调用方的语义 —— 一个对象会被当成标识，取消行为随之失效。
   */
  key?: string
): Promise<T> {
  return runInteractive(async (signal) => {
    try {
      return await run(signal)
    } catch (err) {
      return { ok: false, message: describeTaskError(err), ...(extra ?? {}) } as T
    }
  }, key)
}

export function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

/* ------------------------------------------------------------------ */
/*  知识库上下文                                                        */
/* ------------------------------------------------------------------ */

export function requireVault(): string {
  const path = getSettings().vaultPath
  if (!path || !existsSync(path)) {
    throw new Error('尚未打开知识库目录，请先在首页选择或创建一个目录。')
  }
  return path
}

export function categoriesForAi() {
  return allCategories(getSettings().customCategories)
}

export function relativeOf(absPath: string, vaultPath: string): string {
  return vault.vaultRelative(vaultPath, absPath)
}

/** 取文件的 mtime / size，供扫描跳过判断用；取不到就退化成 0（等于强制重解析） */
export function fileStamp(absPath: string): { fileMtime: number; fileSize: number } {
  try {
    const st = statSync(absPath)
    return { fileMtime: Math.round(st.mtimeMs), fileSize: st.size }
  } catch {
    return { fileMtime: 0, fileSize: 0 }
  }
}

/* ------------------------------------------------------------------ */
/*  投喂预算                                                            */
/* ------------------------------------------------------------------ */

/** 单次精读投喂给某个维度的原文上限（字符） */
export const LENS_SOURCE_LIMIT = 60000
/** 知识库问答里塞进上下文的笔记总量上限（字符） */
export const CHAT_CONTEXT_BUDGET = 70000
