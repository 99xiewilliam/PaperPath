/**
 * 流式请求（SSE）解析的回归测试。
 *
 * 起一个本地假服务返回 SSE，验证 chatCompletion 的 onDelta 路径。
 * 重点覆盖 TCP 分包：SSE 是按行解析的，但网络到达时一行很可能被切成两段，
 * 「按 \n split 然后把最后一段丢掉」这种写法一不小心就会丢字或漏解析，
 * 而且现象是偶发的，不测根本发现不了。
 *
 * 用法：npm run smoke:stream
 */
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { chatCompletion, LlmError } from '../src/main/llm'
import type { LlmSettings } from '@shared/types'

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

const WORD = ['多跳', '检索', '评测集']
const EXPECTED = WORD.join('')

/** 拼成标准 SSE 报文 */
function sse(deltas: string[]): string {
  const body = deltas
    .map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`)
    .join('')
  return `${body}data: [DONE]\n\n`
}

let lastRequestBody = ''
/** 服务端是否观察到客户端把连接断掉了（见第 7 节） */
let midStreamClosed = false

/** 轮询等待某个条件成立，用来观察「稍后才会发生」的断开事件 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

async function main(): Promise<void> {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      lastRequestBody = raw
      const url = req.url ?? ''

      if (url.includes('/error')) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: '上游炸了' } }))
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' })

      if (url.includes('/empty')) {
        // 只有结束标记，一个增量都没有
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      if (url.includes('/split')) {
        // 从中间切断，隔 30ms 再发后半段，模拟 TCP 分包把一行切成两截
        const full = sse(WORD)
        const cut = Math.floor(full.length / 2)
        res.write(full.slice(0, cut))
        setTimeout(() => {
          res.write(full.slice(cut))
          res.end()
        }, 30)
        return
      }

      if (url.includes('/notrailingnl')) {
        /*
         * 收尾不给最后的换行。SSE 规范要求事件之间用空行分隔，但现实里有些
         * 网关就是直接结束 —— 最后那几个字会留在解析器的「半行缓冲」里，
         * 不主动 flush 就永远解析不到。
         */
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '多跳' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '检索评测集' } }] })}`)
        res.end()
        return
      }

      if (url.includes('/messageonly')) {
        // 不切片，整段塞在 message.content 里（部分网关 / 非流式实现会这样）
        res.write(`data: ${JSON.stringify({ choices: [{ message: { content: '整段返回' } }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      if (url.includes('/midstreamerror')) {
        /*
         * 先给一段正常内容，再在流中间报错，然后**故意不结束响应**。
         * 客户端必须自己把响应体 cancel 掉，否则这条连接就一直被占着、
         * 无法回到连接池 —— 批量抽画像连发几十个请求时这就是实打实的 socket 泄漏。
         */
        res.on('close', () => {
          midStreamClosed = true
        })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '开头' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ error: { message: '额度用完了' } })}\n\n`)
        return
      }

      res.write(sse(WORD))
      res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const base: LlmSettings = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'test-key',
    model: 'test-model',
    temperature: 0.2,
    maxTokens: 4096
  }

  const call = async (path: string): Promise<{ content: string; deltas: string[] }> => {
    const deltas: string[] = []
    const res = await chatCompletion(
      [{ role: 'user', content: 'hi' }],
      { ...base, baseUrl: `http://127.0.0.1:${port}${path}` },
      { onDelta: (d) => deltas.push(d) }
    )
    return { content: res.content, deltas }
  }

  /* ---------------- 1. 正常流 ---------------- */
  console.log('── 1. 正常流式 ──────────────────────────────')
  const normal = await call('/v1/chat/completions')
  check('最终内容拼接正确', normal.content === EXPECTED, normal.content)
  check('增量逐段回调', normal.deltas.length === WORD.length, `收到 ${normal.deltas.length} 段`)
  check('增量拼起来等于最终内容', normal.deltas.join('') === EXPECTED)

  const sent = JSON.parse(lastRequestBody) as { stream?: boolean; max_tokens?: number }
  check('请求体带上了 stream: true', sent.stream === true)
  check('没有传 maxTokens 时用设置里的值', sent.max_tokens === 4096, `max_tokens=${sent.max_tokens}`)

  /* ---------------- 2. TCP 分包 ---------------- */
  console.log('')
  console.log('── 2. TCP 分包（一行被切成两段） ─────────────')
  const split = await call('/split/v1/chat/completions')
  check('分包后内容仍然完整（不丢字、不重复）', split.content === EXPECTED, split.content)
  check(
    '分包后增量总数不变',
    split.deltas.length === WORD.length,
    `收到 ${split.deltas.length} 段`
  )

  /* ---------------- 3. 空内容 ---------------- */
  console.log('')
  console.log('── 3. 空内容要报错而不是静默成功 ─────────────')
  let emptyErr: unknown = null
  try {
    await call('/empty/v1/chat/completions')
  } catch (err) {
    emptyErr = err
  }
  check('抛出 LlmError', emptyErr instanceof LlmError)
  check(
    '错误信息说明是空内容',
    emptyErr instanceof LlmError && emptyErr.message.includes('空内容'),
    emptyErr instanceof LlmError ? emptyErr.message : ''
  )

  /* ---------------- 4. HTTP 错误 ---------------- */
  console.log('')
  console.log('── 4. 上游报错要透传原因 ────────────────────')
  let httpErr: unknown = null
  try {
    await call('/error/v1/chat/completions')
  } catch (err) {
    httpErr = err
  }
  check('抛出 LlmError', httpErr instanceof LlmError)
  check('带上了状态码', httpErr instanceof LlmError && httpErr.status === 500)
  check(
    '错误信息里有上游给的原因',
    httpErr instanceof LlmError && httpErr.message.includes('上游炸了'),
    httpErr instanceof LlmError ? httpErr.message : ''
  )

  /* ---------------- 5. 取消 ---------------- */
  console.log('')
  console.log('── 5. 中途取消标记为「已取消」而非超时 ───────')
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 10)
  let cancelErr: unknown = null
  try {
    await chatCompletion(
      [{ role: 'user', content: 'hi' }],
      { ...base, baseUrl: `http://127.0.0.1:${port}/split/v1/chat/completions` },
      { onDelta: () => {}, signal: controller.signal }
    )
  } catch (err) {
    cancelErr = err
  }
  check('抛出 LlmError', cancelErr instanceof LlmError)
  check(
    '标记为 cancelled（不是超时）',
    cancelErr instanceof LlmError && cancelErr.cancelled === true,
    cancelErr instanceof LlmError ? cancelErr.message : ''
  )

  /* ---------------- 6. 收尾的两种情况 ---------------- */
  console.log('')
  console.log('── 6. 收尾：最后一行没有换行 / 整段放在 message 里 ──')
  const noTrailing = await call('/notrailingnl/v1/chat/completions')
  check('最后一行没有换行时也不丢字', noTrailing.content === EXPECTED, noTrailing.content)

  const messageOnly = await call('/messageonly/v1/chat/completions')
  check('整段放在 message.content 里也能拿到', messageOnly.content === '整段返回', messageOnly.content)

  /* ---------------- 7. 流中间报错要断开连接 ---------------- */
  console.log('')
  console.log('── 7. 流中间报错：透传原因 + 主动断开连接 ─────')
  let midErr: unknown = null
  try {
    await call('/midstreamerror/v1/chat/completions')
  } catch (err) {
    midErr = err
  }
  check('抛出 LlmError', midErr instanceof LlmError)
  check(
    '透传了服务商给的原因',
    midErr instanceof LlmError && midErr.message.includes('额度用完了'),
    midErr instanceof LlmError ? midErr.message : ''
  )
  // cancel 之后 undici 会销毁这条连接，服务端随即收到 close
  check('主动断开了连接（没有把 socket 占着不放）', await waitFor(() => midStreamClosed, 1000))

  server.close()

  console.log('')
  console.log(`${pass}/${pass + fail} 通过`)
  if (fail) process.exitCode = 1
}

main().catch((err) => {
  console.error('❌ 失败：', err)
  process.exit(1)
})
