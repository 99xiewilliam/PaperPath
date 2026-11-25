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
import type { ChatMemo } from '@shared/api'
import type { ChatMessage } from '@shared/types'

/** 渲染层自己用的气泡：比 `ChatMessage` 多一个稳定 id 供 React 做 key */
export interface ChatBubble extends ChatMessage {
  id: string
  /** 回答这条时模型查阅过的东西；只给人看，不回传给模型 */
  trace?: string[]
}

/** 一组论文下的一条对话 */
export interface ChatSession {
  id: string
  /** 用首个提问当标题；还没提问的空对话没有标题 */
  title: string
  /** 最后一条消息的时间，历史列表按它从新到旧排 */
  updatedAt: number
  messages: ChatBubble[]
  /** 较早轮次的压缩摘要（主进程生成、这里保管），见 ChatMemo */
  memo?: ChatMemo
}

/**
 * 单条对话保留的消息上限，超出的从最旧的丢。
 *
 * 发给模型的量由主进程的压缩控制（较早轮次压成 memo），这里只是防止
 * localStorage 无限长下去。
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
  /**
   * 追加一条消息。给了 sessionId 就写进那一条（回答回来时用户可能已经切到别的对话），
   * 否则写进当前这条。
   */
  append: (key: string, message: ChatMessage & { trace?: string[] }, sessionId?: string) => void
  setMemo: (key: string, sessionId: string, memo: ChatMemo) => void
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
  return (
    globalThis.crypto?.randomUUID?.() ?? `m-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

/** 拿首个提问当标题（只取第一行，太长就截断）—— 历史列表里才认得出是哪一轮 */
function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0]
  return line.length > 24 ? `${line.slice(0, 24)}…` : line
}

function emptySession(): ChatSession {
  return { id: newId(), title: '', updatedAt: Date.now(), messages: [] }
}

/**
 * 往一条对话里加一条消息。
 * 超过 MAX_KEPT 从最旧的丢时，memo.upTo 要跟着前移 —— 它是「前多少条已被摘要覆盖」的下标，
 * 不跟着挪就会指到错位的消息上，主进程会把没摘要过的轮次当成已覆盖跳过。
 */
export function withMessage(session: ChatSession, bubble: ChatBubble): ChatSession {
  const all = [...session.messages, bubble]
  const dropped = Math.max(0, all.length - MAX_KEPT)
  const memo = session.memo
    ? { ...session.memo, upTo: Math.max(0, session.memo.upTo - dropped) }
    : undefined
  return {
    ...session,
    // 标题只在第一条用户消息时定下来，之后不再改 —— 否则列表里的名字会一直变
    title: session.title || (bubble.role === 'user' ? titleFrom(bubble.content) : ''),
    updatedAt: Date.now(),
    messages: dropped ? all.slice(dropped) : all,
    ...(memo ? { memo } : {})
  }
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      threads: {},
      active: {},

      append: (key, message, sessionId) =>
        set((state) => {
          const bubble: ChatBubble = { ...message, id: newId() }
          const list = state.threads[key] ?? []
          const pinned = sessionId ? list.findIndex((s) => s.id === sessionId) : -1
          if (pinned >= 0) {
            const session = list[pinned]
            const next = withMessage(session, bubble)
            return {
              threads: { ...state.threads, [key]: list.map((s, i) => (i === pinned ? next : s)) }
            }
          }
          const activeId = state.active[key]
          /*
           * 写哪条，和界面显示哪条，必须是同一个口径。
           * 面板显示的是 `find(activeId) ?? sessions[0]`，所以这里 activeId 失效时
           * 也要落到列表第一条，而不是另开一条新的 —— 否则会出现「屏幕上显示第 1 条，
           * 发出去的消息却进了新建的第 4 条」。
           */
          const index = activeId ? list.findIndex((s) => s.id === activeId) : -1
          const target = index >= 0 ? index : list.length ? 0 : -1

          // 一条对话都没有 → 顺手开一条，别让消息无处可去
          if (target < 0) {
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

          const session = list[target]
          const next = withMessage(session, bubble)
          return {
            threads: {
              ...state.threads,
              [key]: list.map((s, i) => (i === target ? next : s))
            },
            // 顺手把失效的指针修回来（activeId 指向已删会话时，它一直是坏的）
            ...(target !== index ? { active: { ...state.active, [key]: session.id } } : {})
          }
        }),

      setMemo: (key, sessionId, memo) =>
        set((state) => {
          const list = state.threads[key]
          if (!list?.some((s) => s.id === sessionId)) return state
          return {
            threads: {
              ...state.threads,
              [key]: list.map((s) => (s.id === sessionId ? { ...s, memo } : s))
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

      selectSession: (key, id) => set((state) => ({ active: { ...state.active, [key]: id } })),

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
          // 防御：v1 数据里可能有损坏条目（元素为 null / content 缺失），
          // 一旦在这里抛异常，zustand 会整个回退成空状态 —— 一段坏数据赔上全部历史
          const clean = (Array.isArray(messages) ? messages : []).filter(
            (m): m is ChatBubble => !!m && typeof m.content === 'string'
          )
          if (!clean.length) continue
          const first = clean.find((m) => m.role === 'user')
          const session: ChatSession = {
            id: newId(),
            title: first ? titleFrom(first.content) : '',
            updatedAt: Date.now(),
            messages: clean
          }
          threads[key] = [session]
          active[key] = session.id
        }
        return { threads, active } as ChatState
      }
    }
  )
)
