/**
 * 流式请求（SSE）解析的回归测试。
 *
 * 起一个本地假服务返回 SSE，验证 chatCompletion 的 onDelta 路径。
 * 重点覆盖 TCP 分包：SSE 是按行解析的，但网络到达时一行很可能被切成两段，
 * 「按 \n split 然后把最后一段丢掉」这种写法一不小心就会丢字或漏解析，
 * 而且现象是偶发的，不测根本发现不了。
 *
 * 第 8~11 节覆盖问答 agent：流式工具调用的分片拼接、工具循环、
 * 不支持 function calling 时的降级、步数上限、历史压缩。
 *
 * 用法：npm run smoke:stream
 */
import { createServer, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import type { ChatTool } from '../src/main/chat-tools'
import { HISTORY_BUDGET, planCompaction, runChatAgent } from '../src/main/agents/chat'
import { chatCompletion, LlmError } from '../src/main/llm'
import { providerFor } from '../src/main/llm/providers'
import type { ChatMessage, LlmSettings } from '@shared/types'

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

const emptyOnceBodies: { max_tokens?: number }[] = []

/** 每次 agent 路由收到的请求体，按顺序记下来 */
const agentRequests: {
  stream?: boolean
  tools?: unknown[]
  messages: { role: string; content: string | null }[]
}[] = []

function streamText(res: ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function streamToolCall(res: ServerResponse, name: string, args: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const frame = {
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: `c${agentRequests.length}`, function: { name, arguments: args } }
          ]
        }
      }
    ]
  }
  res.write(`data: ${JSON.stringify(frame)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

/**
 * 模拟一个会调工具的模型：
 * - /agent：带工具且还没有工具结果 → 调 lookup；有了结果 → 把结果写进回答；非流式请求是压缩备忘
 * - /notools：带 tools 字段就回 400（不支持 function calling 的服务商）
 * - /alwaystool：只要给了工具就一直调，验证步数上限
 */
function handleAgentRoute(url: string, raw: string, res: ServerResponse): void {
  const body = JSON.parse(raw) as (typeof agentRequests)[number]
  agentRequests.push(body)
  if (!body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '备忘内容' } }] }))
    return
  }
  if (url.includes('/notools')) {
    if (body.tools) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'tools not supported' } }))
      return
    }
    streamText(res, '降级回答')
    return
  }
  if (url.includes('/alwaystool')) {
    if (body.tools) streamToolCall(res, 'lookup', '{"q":"again"}')
    else streamText(res, '被迫作答')
    return
  }
  if (url.includes('/manytools')) {
    const seen = body.messages.some((m) => m.role === 'tool')
    if (!seen && body.tools) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const calls = Array.from({ length: 6 }, (_, i) => ({
        index: i,
        id: `c${i}`,
        function: { name: 'lookup', arguments: `{"q":"${i}"}` }
      }))
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls } }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    streamText(res, '收住了')
    return
  }
  const toolResult = body.messages.find((m) => m.role === 'tool')
  if (toolResult) streamText(res, `答案：${toolResult.content}`)
  else if (body.tools) streamToolCall(res, 'lookup', '{"q":"x"}')
  else streamText(res, '无工具回答')
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

      if (url.includes('/emptyonce')) {
        // 非流式：第一次回空内容，之后正常 —— 验证「空内容 → 翻倍预算重试」
        emptyOnceBodies.push(JSON.parse(raw) as { max_tokens?: number })
        const content = emptyOnceBodies.length === 1 ? '' : '第二次有内容'
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content } }] }))
        return
      }

      if (
        url.includes('/agent') ||
        url.includes('/notools') ||
        url.includes('/alwaystool') ||
        url.includes('/manytools')
      ) {
        handleAgentRoute(url, raw, res)
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' })

      if (url.includes('/toolstream')) {
        // 工具调用按 index 分片：第一片带 id + 函数名，参数拆成两片到达
        const frames = [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'c1', function: { name: 'lookup', arguments: '{"q":' } }
                  ]
                }
              }
            ]
          },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
        ]
        for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

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
        res.write(
          `data: ${JSON.stringify({ choices: [{ message: { content: '整段返回' } }] })}\n\n`
        )
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
  check(
    '没有传 maxTokens 时用设置里的值',
    sent.max_tokens === 4096,
    `max_tokens=${sent.max_tokens}`
  )

  /* ---------------- 2. TCP 分包 ---------------- */
  console.log('')
  console.log('── 2. TCP 分包（一行被切成两段） ─────────────')
  const split = await call('/split/v1/chat/completions')
  check('分包后内容仍然完整（不丢字、不重复）', split.content === EXPECTED, split.content)
  check('分包后增量总数不变', split.deltas.length === WORD.length, `收到 ${split.deltas.length} 段`)

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
  check(
    '整段放在 message.content 里也能拿到',
    messageOnly.content === '整段返回',
    messageOnly.content
  )

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

  /* ---------------- 8. 流式工具调用 ---------------- */
  console.log('')
  console.log('── 8. 流式工具调用：分片拼接、只调工具不算空内容 ──')
  const toolRes = await chatCompletion(
    [{ role: 'user', content: 'hi' }],
    { ...base, baseUrl: `http://127.0.0.1:${port}/toolstream/v1/chat/completions` },
    {
      onDelta: () => {},
      tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } }]
    }
  )
  check('拿到了工具调用', toolRes.toolCalls?.[0]?.name === 'lookup')
  check(
    '参数分片拼完整',
    toolRes.toolCalls?.[0]?.arguments === '{"q":"x"}',
    toolRes.toolCalls?.[0]?.arguments
  )
  const toolBody = JSON.parse(lastRequestBody) as { tools?: unknown[]; tool_choice?: string }
  check(
    '请求体带上了 tools 与 tool_choice',
    toolBody.tools?.length === 1 && toolBody.tool_choice === 'auto'
  )

  /* ---------------- 9. 问答 agent 的工具循环 ---------------- */
  console.log('')
  console.log('── 9. 问答 agent：调工具 → 回填结果 → 作答 ─────')
  const ran: Record<string, unknown>[] = []
  const fakeTool: ChatTool = {
    spec: { name: 'lookup', description: '查', parameters: { type: 'object', properties: {} } },
    describe: (args) => `查：${String(args.q)}`,
    run: (args) => {
      ran.push(args)
      return `TOOL-RESULT(${String(args.q)})`
    }
  }
  const agentLlm = (path: string): LlmSettings => ({
    ...base,
    baseUrl: `http://127.0.0.1:${port}${path}/v1/chat/completions`
  })
  const statuses: string[] = []
  let streamedText = ''
  agentRequests.length = 0
  const agent = await runChatAgent(
    { papers: [], messages: [{ role: 'user', content: '问' }], tools: [fakeTool] },
    agentLlm('/agent'),
    { onDelta: (d) => (streamedText += d), onStatus: (s) => statuses.push(s) }
  )
  check('工具按模型给的参数执行', ran.length === 1 && ran[0].q === 'x')
  check('工具结果回填后模型据此作答', agent.content === '答案：TOOL-RESULT(x)', agent.content)
  check('流式吐出的正文和最终存档一致', streamedText === agent.content, streamedText)
  check('查阅记录给到了界面', agent.trace.join() === '查：x' && statuses.includes('正在查：x'))
  const second = agentRequests[1]
  check(
    '第二步带上了 assistant 的 tool_calls 与 tool 消息',
    second?.messages.some((m) => m.role === 'tool') === true &&
      second.messages.some((m) => m.role === 'assistant')
  )

  /* ---------------- 10. 降级与步数上限 ---------------- */
  console.log('')
  console.log('── 10. 不支持工具时降级；一直调工具时被强制作答 ──')
  const degraded = await runChatAgent(
    { papers: [], messages: [{ role: 'user', content: '问' }], tools: [fakeTool] },
    agentLlm('/notools'),
    { onDelta: () => {} }
  )
  check('服务商拒绝 tools 字段时退回普通问答', degraded.content === '降级回答', degraded.content)
  ran.length = 0
  const capped = await runChatAgent(
    { papers: [], messages: [{ role: 'user', content: '问' }], tools: [fakeTool] },
    agentLlm('/alwaystool'),
    { onDelta: () => {} }
  )
  check('工具步数有上限，最后一步不给工具逼模型作答', capped.content === '被迫作答', capped.content)
  check('上限内的工具都执行了', ran.length === 5, `执行 ${ran.length} 次`)
  ran.length = 0
  const many = await runChatAgent(
    { papers: [], messages: [{ role: 'user', content: '问' }], tools: [fakeTool] },
    agentLlm('/manytools'),
    { onDelta: () => {} }
  )
  check('一步里同时来的工具调用只执行前 4 个', ran.length === 4, `执行 ${ran.length} 次`)
  check('多出来的调用被跳过后模型仍然作答', many.content === '收住了', many.content)

  /* ---------------- 11. 历史压缩 ---------------- */
  console.log('')
  console.log('── 11. 历史压缩：只压较早的轮次，切点落在提问上 ──')
  const long = 'x'.repeat(Math.ceil(HISTORY_BUDGET / 8))
  const convo: ChatMessage[] = []
  for (let i = 0; i < 10; i++) {
    convo.push({ role: 'user', content: `问${i}` }, { role: 'assistant', content: long })
  }
  convo.push({ role: 'user', content: '最新的问题' })
  check('短对话不压缩', planCompaction(convo.slice(0, 3)) === null)
  const plan = planCompaction(convo)
  const keptChars = (cut: number, list: ChatMessage[]): number =>
    list.slice(cut).reduce((n, m) => n + m.content.length, 0)
  check('长对话会压缩', !!plan)
  check('切点落在 user 消息上', !!plan && convo[plan.cut].role === 'user')
  check(
    '保留下来的部分不超过预算',
    !!plan && keptChars(plan.cut, convo) <= HISTORY_BUDGET,
    plan ? String(keptChars(plan.cut, convo)) : ''
  )

  const huge = 'y'.repeat(HISTORY_BUDGET + 100)
  const shortOver: ChatMessage[] = [
    { role: 'user', content: '问' },
    { role: 'assistant', content: huge },
    { role: 'user', content: '再问' }
  ]
  const few = planCompaction(shortOver)
  check('条数少但超预算仍然压缩', few?.cut === 2, few ? `cut=${few.cut}` : '没有')
  const again = planCompaction(
    [...shortOver, { role: 'assistant', content: huge }, { role: 'user', content: '三问' }],
    { text: '备忘', upTo: 2 }
  )
  check(
    '压缩过一次后，新的长回答还会再压',
    again?.from === 2 && again.cut === 4,
    again ? `from=${again.from} cut=${again.cut}` : '没有'
  )

  agentRequests.length = 0
  const compacted = await runChatAgent(
    { papers: [], messages: convo, tools: [] },
    agentLlm('/agent'),
    { onDelta: () => {} }
  )
  check(
    '压缩后带回新备忘',
    compacted.memo?.text === '备忘内容' && compacted.memo.upTo === plan?.cut
  )
  const answerReq = agentRequests.find((r) => r.stream)
  check(
    '正式提问里带着备忘，且只发切点之后的历史',
    !!answerReq &&
      (answerReq.messages[1].content ?? '').includes('备忘内容') &&
      answerReq.messages.length === 2 + convo.length - (plan?.cut ?? 0)
  )

  agentRequests.length = 0
  await runChatAgent(
    {
      papers: [],
      messages: [...convo, { role: 'assistant', content: '短' }, { role: 'user', content: '再问' }],
      memo: compacted.memo,
      tools: []
    },
    agentLlm('/agent'),
    { onDelta: () => {} }
  )
  check(
    '带着备忘的下一轮不再重复压缩',
    agentRequests.every((r) => r.stream),
    `请求 ${agentRequests.length} 次`
  )

  /* ---------------- 12. 策略层与适配器的分工 ---------------- */
  console.log('')
  console.log('── 12. 适配器：选择与回退；策略层的预算翻倍仍然生效 ──')
  check('不填协议时用 OpenAI 兼容', providerFor({}).id === 'openai-compatible')
  check(
    '不认识的协议退回 OpenAI 兼容',
    providerFor({ provider: 'bogus' as never }).id === 'openai-compatible'
  )
  const doubled = await chatCompletion([{ role: 'user', content: 'hi' }], {
    ...base,
    baseUrl: `http://127.0.0.1:${port}/emptyonce/v1/chat/completions`,
    extraBody: { max_tokens: 999 }
  })
  check('空内容后重试拿到正文', doubled.content === '第二次有内容', doubled.content)
  check(
    '平时以额外参数里的 max_tokens 为准',
    emptyOnceBodies[0]?.max_tokens === 999,
    String(emptyOnceBodies[0]?.max_tokens)
  )
  check(
    '翻倍重试时预算压过额外参数',
    emptyOnceBodies[1]?.max_tokens === 8192,
    String(emptyOnceBodies[1]?.max_tokens)
  )

  server.close()

  console.log('')
  console.log(`${pass}/${pass + fail} 通过`)
  if (fail) process.exitCode = 1
}

main().catch((err) => {
  console.error('❌ 失败：', err)
  process.exit(1)
})
