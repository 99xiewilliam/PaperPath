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

/**
 * 单条线程保留的上限。
 *
 * localStorage 装得下的量远大于这个数，这里卡住是因为**每轮提问都会把整段历史
 * 发给模型** —— 历史无限长下去，token 账单会悄悄失控。超出的从最旧的丢。
 */
const MAX_KEPT = 200

interface ChatState {
  /** 线程 key → 消息列表。key 见 `chatThreadKey` */
  threads: Record<string, ChatBubble[]>
  append: (key: string, message: ChatMessage) => void
  clear: (key: string) => void
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

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      threads: {},

      append: (key, message) =>
        set((state) => {
          const next = [...(state.threads[key] ?? []), { ...message, id: newId() }]
          return {
            threads: { ...state.threads, [key]: next.length > MAX_KEPT ? next.slice(-MAX_KEPT) : next }
          }
        }),

      clear: (key) =>
        set((state) => {
          const threads = { ...state.threads }
          delete threads[key]
          return { threads }
        })
    }),
    { name: 'papervault.chat.v1' }
  )
)
