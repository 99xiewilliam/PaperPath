/**
 * 任务队列冒烟测试。
 *
 * tasks.ts 刻意不依赖 electron，所以这里可以直接在纯 Node 里验证排队与取消，
 * 不需要启动 Electron、也不需要真的调用模型。
 *
 * 覆盖：
 *   1. 串行：前一个任务没结束，后一个不会开始
 *   2. 取消：正在跑的任务收到 abort，队列里没开始的直接被丢弃
 *   3. currentSignal 的生命周期（任务内可见、任务外为 null）
 *   4. 任务抛错不会卡死队列（后续任务照常执行）
 *   5. 进度广播带上 taskId，能区分属于哪个任务
 *
 * 用法：npm run smoke:tasks
 */
import type { TaskProgress } from '@shared/api'
import {
  activeInteractiveCount,
  cancelInteractive,
  currentSignal,
  runInteractive,
  setProgressBroadcaster,
  TaskCancelledError,
  tasks
} from '../src/main/tasks'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? `  ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 等待断言条件成立，避免依赖固定 sleep 时长 */
async function waitFor(fn: () => boolean, timeout = 2000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (fn()) return true
    await sleep(5)
  }
  return fn()
}

async function main(): Promise<void> {
  const progressLog: TaskProgress[] = []
  setProgressBroadcaster((p) => progressLog.push(p))

  console.log('── 1. 串行执行 ──────────────────────────')
  const order: string[] = []
  const first = tasks.run('任务一', async () => {
    order.push('一:开始')
    await sleep(60)
    order.push('一:结束')
    return 'A'
  })
  const second = tasks.run('任务二', async () => {
    order.push('二:开始')
    await sleep(10)
    order.push('二:结束')
    return 'B'
  })

  check('第一个任务立刻开始', await waitFor(() => order.includes('一:开始')))
  check('第二个任务排队中，没有抢先开始', !order.includes('二:开始'))
  check('队列状态可见', tasks.state()?.label === '任务一', `label=${tasks.state()?.label}`)

  const [ra, rb] = await Promise.all([first, second])
  check('两个任务都返回了结果', ra === 'A' && rb === 'B')
  check(
    '执行顺序严格串行',
    order.join('|') === '一:开始|一:结束|二:开始|二:结束',
    order.join('|')
  )
  check('全部结束后队列空闲', tasks.state() === null)

  console.log('')
  console.log('── 2. currentSignal 生命周期 ─────────────')
  check('任务外没有信号', currentSignal() === null)

  /*
   * 用一个 holder 装信号，而不是 let 变量：TS 的控制流分析看不到闭包里的
   * 赋值，会把 `let insideSignal: AbortSignal | null = null` 一路窄化成 null，
   * 于是 `insideSignal.aborted` 报「属性不存在于 never」。
   */
  const captured: { signal: AbortSignal | null } = { signal: null }
  await tasks.run('信号任务', async () => {
    captured.signal = currentSignal()
    return null
  })
  const insideSignal = captured.signal
  check('任务内能拿到 signal', insideSignal !== null && !insideSignal.aborted)
  check('任务结束后信号被清掉', currentSignal() === null)

  console.log('')
  console.log('── 3. 取消正在跑的任务 ──────────────────')
  /*
   * 取消是**协作式**的：cancel() 对正在跑的任务只做 abort()、不直接 reject，
   * 任务体自己去观察 signal（生产代码里 chatCompletion 会立刻抛错）。
   * 这个测试体就照这个契约写。
   */
  let started = false
  let aborted = false
  const running = tasks.run('长任务', async (ctx) => {
    started = true
    await new Promise<never>((_, reject) => {
      ctx.signal.addEventListener(
        'abort',
        () => {
          aborted = true
          reject(new TaskCancelledError())
        },
        { once: true }
      )
    })
    return 'should-not-finish'
  })

  const queued = tasks.run('排队任务', async () => 'queued')
  // 立刻挂上 handler：cancel() 会同步 reject 排队中的 promise，
  // 晚挂 handler 会让 Node 报 unhandled rejection
  const runningOutcome = running.then(() => null, (err: unknown) => err)
  const queuedOutcome = queued.then(() => null, (err: unknown) => err)

  check('长任务已开始', await waitFor(() => started))
  await sleep(5)
  check('取消操作返回 true', tasks.cancel() === true)

  check('运行中的任务收到取消错误', (await runningOutcome) instanceof TaskCancelledError)
  check('signal 传播给了任务体', aborted)
  check(
    '队列里没开始的任务被直接丢弃（不该白跑一次）',
    (await queuedOutcome) instanceof TaskCancelledError
  )

  check('取消后队列回到空闲', await waitFor(() => tasks.state() === null))
  check('没有任务时取消返回 false', tasks.cancel() === false)

  console.log('')
  console.log('── 4. 任务失败不卡死队列 ────────────────')
  const boom = tasks.run('会失败的任务', async () => {
    throw new Error('故意失败')
  })
  let boomErr: unknown = null
  try {
    await boom
  } catch (err) {
    boomErr = err
  }
  check('失败原因原样抛出', (boomErr as Error)?.message === '故意失败')

  const after = await tasks.run('后续任务', async () => 'ok')
  check('队列没有被卡死，后续任务正常执行', after === 'ok')

  console.log('')
  console.log('── 5. 进度事件带 taskId ─────────────────')
  progressLog.length = 0
  let capturedId: string | null = null
  await tasks.run('进度任务', async (ctx) => {
    capturedId = ctx.id
    return null
  })
  const withId = progressLog.filter((p) => p.taskId === capturedId)
  check('任务期间广播过带 taskId 的进度', withId.length > 0, `条数=${withId.length}`)
  check(
    '任务结束后广播了 taskId=null 的收尾信号',
    progressLog.some((p) => p.taskId === null && p.stage === 'state')
  )

  console.log('')
  console.log('── 6. 交互通道：不排队、不抢信号 ─────────')

  /*
   * 场景就是真实痛点：一次精读要跑几分钟，用户在这期间划词翻译。
   * 以前翻译进的是同一个串行队列，表现成「点了没反应，要等好几分钟」。
   */
  const laneLog: string[] = []
  // 用 holder 而不是 let：TS 的控制流分析看不到闭包里的赋值，
  // 会把 `let release: (() => void) | null = null` 一路窄化成 null（同第 2 节的注释）
  const batchCtl: { release: (() => void) | null } = { release: null }

  const batch = tasks.run('精读（长任务）', async () => {
    laneLog.push('批处理:开始')
    await new Promise<void>((resolve) => {
      batchCtl.release = resolve
    })
    laneLog.push('批处理:结束')
    return 'batch'
  })

  check('批处理任务已经开始', await waitFor(() => laneLog.includes('批处理:开始')))
  const batchSignal = currentSignal()

  const seen: { count: number; ambient: AbortSignal | null; signal: AbortSignal | null } = {
    count: 0,
    ambient: null,
    signal: null
  }
  const interactive = runInteractive(async (signal) => {
    seen.count = activeInteractiveCount()
    seen.ambient = currentSignal()
    seen.signal = signal
    laneLog.push('交互:开始')
    await sleep(10)
    laneLog.push('交互:结束')
    return 'fast'
  })

  check(
    '交互任务不排队：批处理还卡着，它已经跑完了',
    await waitFor(() => laneLog.includes('交互:结束')),
    laneLog.join('|')
  )
  check('交互任务跑的时候计数为 1', seen.count === 1, `count=${seen.count}`)
  /*
   * 下面两条是本通道最容易写错的地方：
   * 交互任务用的是**自己的** signal，而 currentSignal()（批处理的）没有被顶掉。
   * 一旦 runInteractive 里写了 activeSignal，用户点「取消」取消的就会是翻译。
   */
  check(
    '交互任务用的是自己的信号，不是批处理那个',
    seen.signal !== null && seen.signal !== seen.ambient
  )
  check('交互任务没有顶掉 currentSignal（取消目标仍然是批处理）', seen.ambient === batchSignal)
  await interactive
  check('跑完就从计数里摘掉', activeInteractiveCount() === 0)

  /* 取消批处理，不该把正在跑的翻译一起掐掉 */
  const inFlight = runInteractive(async (signal) => {
    await sleep(60)
    return signal.aborted
  })
  await sleep(5)
  const cancelledBatch = tasks.cancel()
  check('批处理确实被取消了', cancelledBatch === true)
  check('取消批处理不会连带取消交互任务', (await inFlight) === false)

  batchCtl.release?.()
  check('被取消的批处理任务体自己收尾，不卡队列', (await batch) === 'batch')

  /* 反过来：也能单独取消交互任务 */
  const cancelMe = runInteractive(async (signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
    return signal.aborted
  })
  await sleep(5)
  check('cancelInteractive 返回被取消的个数', cancelInteractive() === 1)
  check('交互任务的信号确实被 abort', (await cancelMe) === true)
  check('取消后计数归零', activeInteractiveCount() === 0)

  console.log('')
  console.log(`${pass}/${pass + fail} 通过`)
  if (fail) process.exitCode = 1
}

main().catch((err) => {
  console.error('❌ 失败：', err)
  process.exit(1)
})
