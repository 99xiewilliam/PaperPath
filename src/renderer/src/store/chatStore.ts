/**
 * AI 问答的会话留存。
 *
 * 多轮对话本身在 IPC 这一层早就支持了：`ChatPanel.send()` 每次都会把
 * 「已有历史 + 本次提问」整段发给 `ai:chat`，主进程再原样透传给模型。
 * 真正缺的是**留存** —— 会话原来只活在 `ChatPanel` 的组件 state 里，而它是
 * `{tab === 'chat' ? <ChatPanel/> : null}` 条件渲染的，于是：
 *
 *   - 切一下标签再切回来（组件卸载重建）→ 会话没了；
 *   - 换一篇论文（标签页被重置）→ 上一条会话再也回不去；
 *   - 重启应用 → 全丢。
 *
 * 所以这里按**论文集合**分线程存起来。为什么是「论文集合」而不是「单篇论文」：
 * `ChatPanel` 收的就是 `paperIds: string[]`，同一篇论文单独问、和几篇一起横向问，
 * 是两条不同的上下文，混在一个线程里会让模型的上下文互相污染。
 *
 * 一条线程里再分**多条对话**：同一组论文常常要连着问几件不相干的事（先问实验设计、
 * 再问写作手法）。接着上一轮的上下文问会互相干扰，可清空又等于把前面问出来的东西
 * 扔掉。所以「新对话」是**新开一条**，旧的留在历史里，随时能翻回去看。
 *
 * 为什么不写进知识库的 Markdown：问答是会话语料，不是沉淀下来的笔记 ——
 * 把它塞进 frontmatter 会污染「Markdown 是唯一事实来源」这条线（同一个理由，
 * 运行诊断信息 `last_run` 也是进索引而不是进 frontmatter）。这里用 localStorage，
 * 它是 UI 状态该待的地方，也天然不会跟着知识库一起被 git 管理。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ChatMessage } from '@shared/types'

/** 渲染层自己用的气泡：比 `ChatMessage` 多一个稳定 id 供 React 做 key */
export interface ChatBubble extends ChatMessage {
  id: string
}

/** 一组论文下的一条对话 */
export interface ChatSession {
  id: string
  /** 用首个提问当标题；还没提问的空对话没有标题 */
  title: string
  /** 最后一条消息的时间，历史列表按它从新到旧排 */
  updatedAt: number
  messages: ChatBubble[]
}

/**
 * 单条对话保留的消息上限。
 *
 * localStorage 装得下的量远大于这个数，这里卡住是因为**每轮提问都会把整段历史
 * 发给模型** —— 历史无限长下去，token 账单会悄悄失控。超出的从最旧的丢。
 */
const MAX_KEPT = 200

/**
 * 一组论文保留的对话条数上限。
 * 同样从最旧的丢：历史列表是给人翻的，攒到几十条以上就没人往下看了。
 */
const MAX_SESSIONS = 30

interface ChatState {
  /** 论文集合 key → 对话列表（新的在前）。key 见 `chatThreadKey` */
  threads: Record<string, ChatSession[]>
  /** 论文集合 key → 当前正在看的那条对话；没有就落到列表第一条 */
  active: Record<string, string | undefined>
  append: (key: string, message: ChatMessage) => void
  /** 新开一条对话（旧的留在历史里） */
  newSession: (key: string) => void
  selectSession: (key: string, id: string) => void
  removeSession: (key: string, id: string) => void
}

/**
 * 线程 key。
 *
 * 先排序再拼，这样调用方传 `[a, b]` 还是 `[b, a]` 落到同一条线程上 ——
 * 否则同一组论文会因为入参顺序不同而分裂成两条历史。
 */
export function chatThreadKey(paperIds: string[]): string {
  return [...paperIds].sort().join('|')
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** 拿首个提问当标题（只取第一行，太长就截断）—— 历史列表里才认得出是哪一轮 */
function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0]
  return line.length > 24 ? `${line.slice(0, 24)}…` : line
}

function emptySession(): ChatSession {
  return { id: newId(), title: '', updatedAt: Date.now(), messages: [] }
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      threads: {},
      active: {},

      append: (key, message) =>
        set((state) => {
          const bubble: ChatBubble = { ...message, id: newId() }
          const list = state.threads[key] ?? []
          const activeId = state.active[key]
          const index = activeId ? list.findIndex((s) => s.id === activeId) : list.length - 1

          // 还没有任何对话（或选中的那条被删了）→ 顺手开一条，别让消息无处可去
          if (index < 0) {
            const session: ChatSession = {
              ...emptySession(),
              title: bubble.role === 'user' ? titleFrom(bubble.content) : '',
              messages: [bubble]
            }
            return {
              threads: { ...state.threads, [key]: [session, ...list].slice(0, MAX_SESSIONS) },
              active: { ...state.active, [key]: session.id }
            }
          }

          const session = list[index]
          const messages = [...session.messages, bubble]
          const next: ChatSession = {
            ...session,
            // 标题只在第一条用户消息时定下来，之后不再改 —— 否则列表里的名字会一直变
            title: session.title || (bubble.role === 'user' ? titleFrom(bubble.content) : ''),
            updatedAt: Date.now(),
            messages: messages.length > MAX_KEPT ? messages.slice(-MAX_KEPT) : messages
          }
          return {
            threads: {
              ...state.threads,
              [key]: list.map((s, i) => (i === index ? next : s))
            }
          }
        }),

      newSession: (key) =>
        set((state) => {
          const list = state.threads[key] ?? []
          // 当前这条本来就是空的就什么都不做：连点两下不该攒出一堆空白历史
          const current = list.find((s) => s.id === state.active[key])
          if (current && current.messages.length === 0) return state
          const session = emptySession()
          return {
            threads: { ...state.threads, [key]: [session, ...list].slice(0, MAX_SESSIONS) },
            active: { ...state.active, [key]: session.id }
          }
        }),

      selectSession: (key, id) =>
        set((state) => ({ active: { ...state.active, [key]: id } })),

      removeSession: (key, id) =>
        set((state) => {
          const list = (state.threads[key] ?? []).filter((s) => s.id !== id)
          const threads = { ...state.threads }
          if (list.length) threads[key] = list
          else delete threads[key]
          return {
            threads,
            // 删掉的正是当前这条时，落到剩下的第一条上（没有就留空，下次提问会自动开一条）
            active: { ...state.active, [key]: list[0]?.id }
          }
        })
    }),
    {
      name: 'papervault.chat.v1',
      version: 2,
      /*
       * v1 的结构是 `threads[key] = ChatBubble[]` —— 一组论文只有一条对话。
       * 升级时把它包成一条会话（标题沿用首个提问），而不是丢掉：
       * 用户翻回历史发现全空了，比结构没升级更糟。
       */
      migrate: (persisted) => {
        const old = persisted as { threads?: Record<string, ChatBubble[]> } | undefined
        const threads: Record<string, ChatSession[]> = {}
        const active: Record<string, string | undefined> = {}
        for (const [key, messages] of Object.entries(old?.threads ?? {})) {
          if (!Array.isArray(messages) || !messages.length) continue
          const first = messages.find((m) => m.role === 'user')
          const session: ChatSession = {
            id: newId(),
            title: first ? titleFrom(first.content) : '',
            updatedAt: Date.now(),
            messages
          }
          threads[key] = [session]
          active[key] = session.id
        }
        return { threads, active } as ChatState
      }
    }
  )
)
