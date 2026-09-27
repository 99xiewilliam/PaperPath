import { useEffect, useRef, useState } from 'react'
import { Bot, Copy, History, Loader2, Plus, Send, Trash2 } from 'lucide-react'
import type { ChatMessage } from '@shared/types'
import { cn, errorMessage, formatDate } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { chatThreadKey, useChatStore, type ChatBubble, type ChatSession } from '@/store/chatStore'
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

/** 同上，给「一组论文下的对话列表」用的稳定空数组 */
const EMPTY_SESSIONS: ChatSession[] = []

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
  const sessions = useChatStore((s) => s.threads[threadKey] ?? EMPTY_SESSIONS)
  const activeId = useChatStore((s) => s.active[threadKey])
  const append = useChatStore((s) => s.append)
  const startSession = useChatStore((s) => s.newSession)
  const selectSession = useChatStore((s) => s.selectSession)
  const removeSession = useChatStore((s) => s.removeSession)

  /*
   * 当前这条对话：选中的那条，没有就落到列表第一条（新开的排在最前）。
   * 一条都没有时 `session` 为 null —— 此时提问会由 store 顺手开一条。
   */
  const session = sessions.find((s) => s.id === activeId) ?? sessions[0] ?? null
  const messages = session?.messages ?? EMPTY_THREAD

  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  const titles = papers.filter((p) => paperIds.includes(p.id)).map((p) => p.title)

  /** 复制一条回答的 Markdown 原文（和 PDF 面板里那个复制是同一套做法） */
  const copyMessage = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      useAppStore.getState().toast('已复制到剪贴板', 'success')
    } catch (err) {
      useAppStore.getState().toast(`复制失败：${errorMessage(err)}`, 'error')
    }
  }

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
        <div className="flex shrink-0 items-center gap-0.5">
          {session && session.messages.length ? (
            <IconButton title="删除这条对话" onClick={() => removeSession(threadKey, session.id)}>
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          ) : null}
          {sessions.length > 1 ? (
            <div className="relative">
              <IconButton
                title={`历史对话（这组论文下共 ${sessions.length} 条）`}
                onClick={() => setHistoryOpen((v) => !v)}
              >
                <History className="h-3.5 w-3.5" />
              </IconButton>
              {historyOpen ? (
                <>
                  {/* 点空白处收起 */}
                  <div className="fixed inset-0 z-30" onClick={() => setHistoryOpen(false)} />
                  <div className="absolute right-0 top-7 z-40 max-h-72 w-64 overflow-y-auto rounded-xl border border-line bg-bg-raised p-1 shadow-xl">
                    {/*
                      列表按「新 → 旧」显示（store 里就是这样存的），当前那条高亮。
                      标题取首个提问 —— 记不住标题的对话，翻历史时等于没有历史。
                    */}
                    {sessions.map((s) => (
                      <div
                        key={s.id}
                        className={cn(
                          'group flex items-center gap-1 rounded-lg px-1.5 py-1 transition',
                          s.id === session?.id ? 'bg-brand/15' : 'hover:bg-white/[0.05]'
                        )}
                      >
                        <button
                          onClick={() => {
                            selectSession(threadKey, s.id)
                            setHistoryOpen(false)
                          }}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="block truncate text-[11.5px] text-ink-mid">
                            {s.title || '（还没提问）'}
                          </span>
                          <span className="block text-[10px] text-ink-low">
                            {s.messages.length} 条 · {formatDate(new Date(s.updatedAt).toISOString())}
                          </span>
                        </button>
                        <button
                          title="删除这条对话"
                          onClick={() => removeSession(threadKey, s.id)}
                          className="shrink-0 rounded p-1 text-ink-low opacity-0 transition hover:text-warn group-hover:opacity-100"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
          <IconButton
            title="新开一条对话（当前这条会留在历史里，随时能翻回来）"
            onClick={() => startSession(threadKey)}
          >
            <Plus className="h-3.5 w-3.5" />
          </IconButton>
        </div>
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
              className={cn('flex flex-col', m.role === 'user' ? 'items-end' : 'items-start')}
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
              {/*
                复制按钮**常显**，不做成悬停才出现 —— 它是这个面板上最常用的动作之一，
                藏起来就等于没有（找不着按钮的人不会去猜「是不是要悬停一下」）。
                复制的是 Markdown 原文，粘进笔记里标题、列表、代码块都还在。
              */}
              <button
                title="复制这段文本（Markdown 原文）"
                onClick={() => void copyMessage(m.content)}
                className="mt-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-ink-low transition hover:bg-white/[0.06] hover:text-ink-high"
              >
                <Copy className="h-3 w-3" />
                复制
              </button>
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
