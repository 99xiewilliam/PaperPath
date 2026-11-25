/**
 * 调用记账的回归测试（不联网、不花钱，所以能进 `verify`）。
 *
 * 为什么要单独测它：记账是靠 `finally` 上报的 —— 静默失效的话，界面只是少一个
 * 数字，没有任何报错。而它恰恰是「这次精读花了多少、重试了几次、prompt 是哪一版」
 * 的唯一来源，坏了等于观测整条线断掉。
 *
 * 做法是起一个本地 stub 服务冒充 OpenAI 兼容接口，把四条路径都走一遍：
 *   ① 成功          → 记对 model / usage / 耗时 / 指纹
 *   ② prompt 变化   → 指纹随之变化（「prompt 版本可追溯」的前提）
 *   ③ 500 + 退避重试 → 请求数 = 3，且失败也有一笔记录（失败的调用一样计费）
 *   ④ 漏标 label    → 兜底成「未标注」，便于发现新增调用忘了标注
 */
import { createServer } from 'http'
import { chatCompletion, type LlmCallRecord } from '../src/main/llm'
import { mergeUsage } from '../src/main/lenses/run'
import type { LensRunUsage } from '@shared/lenses'

const out: string[] = []
let bad = 0
let total = 0
const check = (name: string, cond: boolean, extra = ''): void => {
  total++
  if (!cond) bad++
  out.push(`${cond ? '✅' : '❌'} ${name}${extra ? `  ← ${extra}` : ''}`)
}

let mode: 'ok' | 'fail' = 'ok'

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (mode === 'fail') {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'stub boom' } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 }
      })
    )
  })
})

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const llm = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'stub-key',
    model: 'stub-model',
    temperature: 0,
    maxTokens: 128
  }
  const msgs = (system: string): { role: 'system' | 'user'; content: string }[] => [
    { role: 'system', content: system },
    { role: 'user', content: 'hi' }
  ]

  /* ① 成功路径 */
  let calls: LlmCallRecord[] = []
  const res = await chatCompletion(msgs('系统提示 A'), llm, {
    label: 'lens:test',
    onCall: (r) => calls.push(r)
  })
  check('成功调用回调恰好一次', calls.length === 1, `实际 ${calls.length} 次`)
  check('返回值不受影响', res.content === '{"ok":true}', res.content)
  check('ok=true', calls[0]?.ok === true)
  check('label 透传', calls[0]?.label === 'lens:test', calls[0]?.label ?? '(空)')
  check('model 记录', calls[0]?.model === 'stub-model', calls[0]?.model ?? '(空)')
  check(
    'usage 记录',
    calls[0]?.promptTokens === 123 && calls[0]?.completionTokens === 45,
    `${calls[0]?.promptTokens}/${calls[0]?.completionTokens}`
  )
  check('requests=1', calls[0]?.requests === 1, String(calls[0]?.requests))
  check('prompt 指纹为 8 位', /^[0-9a-f]{8}$/.test(calls[0]?.prompt ?? ''), calls[0]?.prompt ?? '(空)')
  check('耗时已计', (calls[0]?.elapsedMs ?? -1) >= 0, `${calls[0]?.elapsedMs}ms`)
  const fpA = calls[0]?.prompt

  /* ② 指纹随 system 变化 */
  await chatCompletion(msgs('系统提示 B'), llm, { label: 'lens:test', onCall: (r) => calls.push(r) })
  check('换 system → 指纹变化', calls[1]?.prompt !== fpA, `${fpA} → ${calls[1]?.prompt}`)
  await chatCompletion(msgs('系统提示 A'), llm, { label: 'lens:other', onCall: (r) => calls.push(r) })
  check('同一 system → 指纹相同', calls[2]?.prompt === fpA, `${calls[2]?.prompt}`)

  /* ③ 失败 + 退避重试：1 次首发 + 2 次退避重试 = 3 个请求 */
  mode = 'fail'
  calls = []
  let threw = false
  try {
    await chatCompletion(msgs('系统提示 A'), llm, { label: 'lens:test', onCall: (r) => calls.push(r) })
  } catch {
    threw = true
  }
  check('失败向上抛', threw)
  check('失败也回调恰好一次', calls.length === 1, `实际 ${calls.length} 次`)
  check('ok=false', calls[0]?.ok === false)
  check('error 有内容', !!calls[0]?.error, calls[0]?.error ?? '(空)')
  check('requests=3（含两次退避重试）', calls[0]?.requests === 3, String(calls[0]?.requests))

  /* ④ 漏标 label 的兜底 */
  mode = 'ok'
  calls = []
  await chatCompletion(msgs('系统提示 A'), llm, { onCall: (r) => calls.push(r) })
  check('漏标 label → 「未标注」', calls[0]?.label === '未标注', calls[0]?.label ?? '(空)')

  /* ⑤ 合计：token 相加、指纹与完成顺序无关 */
  const mk = (prompt: string, pt: number): LensRunUsage => ({
    model: 'm',
    prompt,
    promptTokens: pt,
    completionTokens: 1,
    elapsedMs: 10,
    requests: 1,
    calls: 1,
    truncated: 0,
    failed: 0
  })
  const m1 = mergeUsage([mk('aaaa', 10), mk('bbbb', 20)])
  check(
    '合计 token',
    m1?.promptTokens === 30 && m1?.completionTokens === 2,
    `${m1?.promptTokens}/${m1?.completionTokens}`
  )
  check('合计 calls/requests', m1?.calls === 2 && m1?.requests === 2)
  const m2 = mergeUsage([mk('bbbb', 20), mk('aaaa', 10)])
  check('指纹与完成顺序无关', m1?.prompt === m2?.prompt, `${m1?.prompt} vs ${m2?.prompt}`)
  check('空输入 → undefined', mergeUsage([undefined]) === undefined)
  const m3 = mergeUsage([mk('aaaa', 10), { ...mk('aaaa', 10), failed: 1, truncated: 1 }])
  check('合计失败与截断', m3?.failed === 1 && m3?.truncated === 1, `${m3?.failed}/${m3?.truncated}`)
}

void main()
  .then(() => {
    console.log(out.join('\n'))
    console.log(bad ? `\n❌ smoke:usage ${total - bad}/${total} 通过` : `\n✅ smoke:usage ${total}/${total} 通过`)
    server.close()
    process.exit(bad ? 1 : 0)
  })
  .catch((err: unknown) => {
    // 崩了也要把已跑到的结果打出来，否则诊断不了断在哪一步
    console.log(out.join('\n'))
    console.log(`\n❌ smoke:usage 中断：${err instanceof Error ? err.message : String(err)}`)
    server.close()
    process.exit(1)
  })
