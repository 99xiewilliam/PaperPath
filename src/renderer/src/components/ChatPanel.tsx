import { useEffect, useRef, useState } from 'react'
import { Bot, Loader2, Send, Trash2 } from 'lucide-react'
import type { ChatMessage } from '@shared/types'
import { cn, errorMessage } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { chatThreadKey, useChatStore, type ChatBubble } from '@/store/chatStore'
import { Markdown } from './Markdown'
import { IconButton } from './ui'

const PRESETS = [
  '这几篇论文的实验设计有什么共性？',
  '如果要复现，最关键的超参和资源是什么？',
  '它们的 Introduction 是怎么铺垫 gap 的？',
  '帮我列出可以直接迁移到我课题的 3 个做法。'
]

/**
 * 空线程的稳定引用。
 *
 * zustand 的选择器按 `Object.is` 比较，`s.threads[key] ?? []` 这种写法每次都造一个
 * 新数组，会让组件在一棵没变的树上永远重渲染。所以缺省值必须是同一个常量。
 */
const EMPTY_THREAD: ChatBubble[] = []

export function ChatPanel({
  paperIds,
  emptyHint
}: {
  paperIds: string[]
  emptyHint?: string
}): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const papers = useAppStore((s) => s.papers)
  /*
   * 会话从 store 里取（按论文集合分线程），不再放组件 state ——
   * 这个面板在 PaperDetail 里是条件渲染的，切标签 / 换论文 / 重启都会把它连根拔掉，
   * 会话也就跟着一起没了（多轮本身一直是支持的，丢的只是留存）。
   */
  const threadKey = chatThreadKey(paperIds)
  const messages = useChatStore((s) => s.threads[threadKey] ?? EMPTY_THREAD)
  const append = useChatStore((s) => s.append)
  const clearThread = useChatStore((s) => s.clear)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  const titles = papers.filter((p) => paperIds.includes(p.id)).map((p) => p.title)

  const send = async (text: string): Promise<void> => {
    const content = text.trim()
    if (!content || loading) return
    if (!settings.llm.apiKey) {
      useAppStore.getState().toast('请先在「设置」里配置 API Key。', 'error')
      return
    }
    const history: ChatMessage[] = [...messages, { role: 'user', content }]
    append(threadKey, { role: 'user', content })
    setInput('')
    setLoading(true)
    try {
      /*
       * 只把 role / content 发下去。这段 history 会原样透传给模型，
       * 多带一个本地用的 id 字段对校验严格的接口来说是没必要的风险。
       */
      const res = await window.papervault.ai.chat(
        paperIds,
        history.map(({ role, content: c }) => ({ role, content: c }))
      )
      if (res.ok) {
        append(threadKey, { role: 'assistant', content: res.content })
      } else {
        useAppStore.getState().toast(res.message ?? '请求失败', 'error')
      }
    } catch (err) {
      useAppStore.getState().toast(`请求失败：${errorMessage(err)}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-start gap-2 rounded-xl border border-line bg-bg-raised px-3 py-2.5">
        <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-soft" />
        <div className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-ink-mid">
          {paperIds.length ? (
            <>
              基于 <span className="text-ink-high">{paperIds.length}</span> 篇笔记回答：
              <span className="text-ink-low">
                {titles.slice(0, 3).join('、')}
                {titles.length > 3 ? ` 等 ${titles.length} 篇` : ''}
              </span>
            </>
          ) : (
            emptyHint ?? '选择论文后可以向 AI 提问。回答只基于你的笔记，不会凭空编造。'
          )}
        </div>
        {messages.length ? (
          <IconButton title="清空对话" onClick={() => clearThread(threadKey)}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        ) : null}
      </div>

      <div ref={scrollRef} className="min-h-[280px] flex-1 space-y-3 overflow-y-auto pr-1">
        {messages.length === 0 ? (
          <div className="space-y-1.5">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => void send(p)}
                className="block w-full rounded-lg border border-line px-3 py-2 text-left text-[12px] text-ink-mid transition hover:border-strong hover:text-ink-high"
              >
                {p}
              </button>
            ))}
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'max-w-[88%] rounded-xl px-3.5 py-2.5 text-[12.5px]',
                  m.role === 'user'
                    ? 'bg-brand/20 text-ink-high'
                    : 'border border-line bg-bg-raised'
                )}
              >
                {m.role === 'assistant' ? (
                  <Markdown content={m.content} />
                ) : (
                  <span className="whitespace-pre-wrap">{m.content}</span>
                )}
              </div>
            </div>
          ))
        )}
        {loading ? (
          <div className="flex items-center gap-2 text-[12px] text-ink-mid">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-soft" />
            正在阅读你的笔记…
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex items-end gap-2 border-t border-line pt-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void send(input)
            }
          }}
          rows={2}
          placeholder="问点什么…（⌘/Ctrl + Enter 发送）"
          className="field resize-none"
        />
        <button
          onClick={() => void send(input)}
          disabled={loading || !input.trim()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand text-[#EDEAE0] transition hover:bg-brand-soft disabled:opacity-40"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
