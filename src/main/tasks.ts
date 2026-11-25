/**
 * 主进程的 AI 任务编排：串行队列 + 可取消。
 *
 * 为什么需要它：
 *   - 之前每个 AI 能力各自为政，用户同时触发两个批量任务时，进度事件会互相
 *     覆盖，busy 文案乱跳；
 *   - 更实际的问题是**没法取消**——关掉导入向导之后，剩下几十篇的精读请求
 *     还在后台继续烧 API 额度。
 *
 * 这个模块刻意不依赖 electron：进度通过外部注册的 broadcaster 发出去，
 * 这样纯 Node 的冒烟测试也能直接跑任务管线，不必启动 Electron。
 */

import type { TaskProgress, TaskState } from '@shared/api'

export type { TaskProgress, TaskState }

export class TaskCancelledError extends Error {
  constructor(message = '任务已取消') {
    super(message)
    this.name = 'TaskCancelledError'
  }
}

export interface TaskContext {
  id: string
  signal: AbortSignal
  /** 给循环体用的检查点：长循环里调一下可以更快响应取消 */
  throwIfCancelled(): void
}

type ProgressBroadcaster = (progress: TaskProgress) => void

interface Job {
  label: string
  run: (ctx: TaskContext) => Promise<unknown>
  settle: { resolve: (value: unknown) => void; reject: (err: unknown) => void }
}

let broadcaster: ProgressBroadcaster | null = null
let seq = 0

/**
 * 当前正在跑的任务的 signal。
 *
 * 这里用一个模块级变量是**安全**的，因为队列保证同一时刻只有一个任务在跑。
 * 有了它，llm.ts 不必把 signal 一路透传过每一层函数签名。
 */
let activeSignal: AbortSignal | null = null

export function currentSignal(): AbortSignal | null {
  return activeSignal
}

export function setProgressBroadcaster(fn: ProgressBroadcaster | null): void {
  broadcaster = fn
}

class TaskRunner {
  private queue: Job[] = []
  private current: { id: string; label: string; controller: AbortController; startedAt: number } | null =
    null

  run<T>(label: string, fn: (ctx: TaskContext) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        label,
        run: fn as (ctx: TaskContext) => Promise<unknown>,
        settle: { resolve: resolve as (value: unknown) => void, reject }
      })
      void this.pump()
    })
  }

  /** 取消当前任务并丢弃队列里还没开始的。返回是否真的有东西被取消。 */
  cancel(): boolean {
    const hadWork = !!this.current || this.queue.length > 0
    if (!hadWork) return false

    for (const job of this.queue.splice(0)) {
      job.settle.reject(new TaskCancelledError())
    }
    this.current?.controller.abort()
    return true
  }

  state(): TaskState | null {
    if (!this.current) return null
    return {
      id: this.current.id,
      label: this.current.label,
      startedAt: this.current.startedAt
    }
  }

  get currentId(): string | null {
    return this.current?.id ?? null
  }

  private context(id: string, signal: AbortSignal): TaskContext {
    return {
      id,
      signal,
      throwIfCancelled: () => {
        if (signal.aborted) throw new TaskCancelledError()
      }
    }
  }

  private async pump(): Promise<void> {
    if (this.current || !this.queue.length) return
    const job = this.queue.shift()
    if (!job) return

    const controller = new AbortController()
    const id = `task-${++seq}`
    this.current = { id, label: job.label, controller, startedAt: Date.now() }
    activeSignal = controller.signal
    this.broadcastState()

    try {
      job.settle.resolve(await job.run(this.context(id, controller.signal)))
    } catch (err) {
      job.settle.reject(err)
    } finally {
      this.current = null
      activeSignal = null
      this.broadcastState()
      void this.pump()
    }
  }

  private broadcastState(): void {
    broadcaster?.({
      taskId: this.currentId,
      stage: 'state',
      message: this.current?.label ?? '',
      at: Date.now()
    })
  }
}

export const tasks = new TaskRunner()

/* ------------------------------------------------------------------ */
/*  交互通道                                                            */
/* ------------------------------------------------------------------ */

/**
 * 在跑的交互任务。用 Map 而不是队列：交互请求「跑一次就走」，**排队正是要消灭的东西**。
 *
 * value 是可选标识：绝大多数交互任务几秒就结束、不需要单独取消，
 * 但「演示生成」要跑几分钟，得让用户能只掐它一个（见 cancelInteractive）。
 */
const interactiveRuns = new Map<AbortController, string | undefined>()

export function activeInteractiveCount(): number {
  return interactiveRuns.size
}

/**
 * 跑一个「用户正等着看结果」的短请求（划词翻译 / 解读 / 追问）。
 *
 * 为什么要独立通道：批处理队列是**串行**的，一次精读要跑几分钟，而这期间用户
 * 划词翻译会被排在精读后面 —— 表现成「点了翻译没反应」，这是最容易被感知的卡点。
 *
 * 两条铁律，写错任何一条都会破坏取消语义：
 *   1. **绝不写 activeSignal**。它属于批处理通道，是「取消当前任务」的唯一依据；
 *      交互任务一旦写进去，用户点「取消」取消的就是翻译，而精读还在后台照跑。
 *   2. 每个任务用**自己的** controller，并把 signal 显式传下去（llm.ts 的
 *      options.signal）—— 否则它会去拿批处理的信号，变成「精读被取消时翻译跟着挂」。
 */
export function runInteractive<T>(fn: (signal: AbortSignal) => Promise<T>, key?: string): Promise<T> {
  const controller = new AbortController()
  interactiveRuns.set(controller, key)
  return fn(controller.signal).finally(() => {
    interactiveRuns.delete(controller)
  })
}

/**
 * 取消交互任务。
 *
 * 传 `key` 时**只**取消带这个标识的：长任务（演示生成要跑几分钟）必须能单独取消 ——
 * 用户点它的取消按钮时，不该顺带掐掉旁边正在跑的划词翻译。
 * 不传则取消全部，那是「切换知识库」这类场景：那一刻所有在跑的请求都已经失效了。
 */
export function cancelInteractive(key?: string): number {
  let count = 0
  for (const [controller, k] of interactiveRuns) {
    if (key !== undefined && k !== key) continue
    controller.abort()
    interactiveRuns.delete(controller)
    count++
  }
  return count
}

/**
 * 发一条进度。任务内外的调用方共用同一个函数，taskId 由 runner 自动带上，
 * 渲染层因此能区分「这个进度属于哪个任务」。
 */
export function emitProgress(stage: string, message: string, paperId?: string): void {
  broadcaster?.({
    taskId: tasks.currentId,
    stage,
    message,
    paperId,
    at: Date.now()
  })
}
