/**
 * 问答 agent 能调用的工具：让模型在「选中的笔记不够用」时自己去库里查。
 *
 * 全部只读。返回给模型的是**可读文本**而不是 JSON：模型读文本更稳，
 * 而且每个结果都有字数上限 —— 工具结果会进入后续每一步的上下文，放任它长就是放任账单长。
 *
 * 论文用 id 指代（search_library 的结果里带着），也接受标题，免得模型抄错 slug 就卡住。
 */
import type { ChatScope } from '@shared/api'
import { IDEA_STATUS_LABEL } from '@shared/ideas'
import { PROBLEM_SCOPE_ALL } from '@shared/problems'
import type { LlmToolSpec } from './llm'
import * as db from './db'
import { listIdeas } from './idea-service'
import { evidenceSnippets } from './lenses/types'
import { sectionsOf } from './paper-service'
import { getProblemMap } from './problem-service'
import { requireVault } from './runtime'
import * as vault from './vault'

export interface ChatTool {
  spec: LlmToolSpec
  /** 给用户看的一句话：「搜索库：xxx」 */
  describe(args: Record<string, unknown>): string
  run(args: Record<string, unknown>): string
}

const RESULT_LIMIT = 6000

function clip(text: string, max = RESULT_LIMIT): string {
  return text.length > max ? `${text.slice(0, max)}\n…（已截断，需要更多就换个更具体的查法）` : text
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 先按 id 精确找，再按标题（完全相同 → 包含）找 */
export function resolvePaper(ref: string): { id: string; title: string } | null {
  const key = ref.trim()
  if (!key) return null
  const exact = db.getPaperSummary(key)
  if (exact) return { id: exact.id, title: exact.title }
  const lower = key.toLowerCase().replace(/[《》]/g, '')
  const all = db
    .listPaperIds()
    .map((id) => db.getPaperSummary(id))
    .filter((p): p is NonNullable<typeof p> => !!p)
  const hit =
    all.find((p) => p.title.toLowerCase() === lower) ??
    all.find((p) => p.title.toLowerCase().includes(lower) || lower.includes(p.title.toLowerCase()))
  return hit ? { id: hit.id, title: hit.title } : null
}

function titleOf(id: string): string {
  return db.getPaperSummary(id)?.title ?? id
}

const searchLibrary: ChatTool = {
  spec: {
    name: 'search_library',
    description:
      '在用户的整个论文库里按关键词检索（标题、笔记正文都会搜）。用户问到选中论文以外的工作、或想找「库里有没有做过 X 的论文」时用。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '2~4 个关键词，空格分隔；多个词是「同时包含」的关系，词越少命中越多'
        }
      },
      required: ['query']
    }
  },
  describe: (args) => `搜索库：「${str(args.query)}」`,
  run(args) {
    const query = str(args.query)
    if (!query) return '没有给关键词。'
    const ids = db.searchPaperIds(query).slice(0, 8)
    if (!ids.length) return `库里没有同时包含「${query}」的论文。可以减少关键词或换个说法再试。`
    return ids
      .map((id) => {
        const p = db.getPaperSummary(id)
        if (!p) return ''
        const tldr = p.tldr.replace(/\s+/g, ' ').slice(0, 140)
        return `- id: ${id}\n  《${p.title}》（${p.year ?? '年份未知'}）${tldr ? `\n  一句话：${tldr}` : ''}`
      })
      .filter(Boolean)
      .join('\n')
  }
}

const readNote: ChatTool = {
  spec: {
    name: 'read_note',
    description:
      '读某篇论文的精读笔记。不给 section 时返回这篇有哪些章节（带字数）和一句话总结；给了 section 返回那一节的全文。',
    parameters: {
      type: 'object',
      properties: {
        paper: { type: 'string', description: '论文 id（search_library 结果里的）或标题' },
        section: { type: 'string', description: '章节名，例如「方法细节」「实验方法论」；可省略' }
      },
      required: ['paper']
    }
  },
  describe: (args) => {
    const p = resolvePaper(str(args.paper))
    const section = str(args.section)
    return `读笔记：《${p?.title ?? str(args.paper)}》${section ? ` · ${section}` : ''}`
  },
  run(args) {
    const paper = resolvePaper(str(args.paper))
    if (!paper) return `库里找不到「${str(args.paper)}」。先用 search_library 找到它的 id。`
    const sections = sectionsOf(paper.id)
    const filled = Object.entries(sections).filter(([, v]) => v.trim())
    const want = str(args.section)
    if (!want) {
      if (!filled.length) return `《${paper.title}》还没有精读笔记。`
      const tldr = sections['一句话总结']?.trim()
      return [
        `《${paper.title}》的笔记章节：`,
        ...filled.map(([k, v]) => `- ${k}（${v.trim().length} 字）`),
        tldr ? `\n一句话总结：${tldr}` : ''
      ].join('\n')
    }
    const hit =
      filled.find(([k]) => k === want) ?? filled.find(([k]) => k.includes(want) || want.includes(k))
    if (!hit) {
      return `《${paper.title}》没有「${want}」这一节（或还是空的）。有内容的章节：${filled.map(([k]) => k).join('、') || '无'}`
    }
    return clip(`《${paper.title}》· ${hit[0]}\n\n${hit[1].trim()}`)
  }
}

const searchSource: ChatTool = {
  spec: {
    name: 'search_source',
    description:
      '在某篇论文的 PDF 原文里按关键词找片段。笔记里没写、但用户问到具体数字、设置、公式、某张表时用。',
    parameters: {
      type: 'object',
      properties: {
        paper: { type: 'string', description: '论文 id 或标题' },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: '原文里可能出现的词（英文论文就给英文），按重要性排序，1~5 个'
        }
      },
      required: ['paper', 'keywords']
    }
  },
  describe: (args) => {
    const p = resolvePaper(str(args.paper))
    const keywords = Array.isArray(args.keywords) ? args.keywords.map(String).join(' / ') : ''
    return `查原文：《${p?.title ?? str(args.paper)}》「${keywords}」`
  },
  run(args) {
    const paper = resolvePaper(str(args.paper))
    if (!paper) return `库里找不到「${str(args.paper)}」。`
    const keywords = (Array.isArray(args.keywords) ? args.keywords : [])
      .map((k) => String(k ?? '').trim())
      .filter(Boolean)
      .slice(0, 5)
    if (!keywords.length) return '没有给关键词。'
    const text = vault.readExtractedText(requireVault(), paper.id)
    if (!text.trim()) return `《${paper.title}》没有抽取过原文（可能是手动建的条目）。`
    const hits = evidenceSnippets(text, keywords, 4000)
    return hits
      ? `《${paper.title}》原文片段（「…」表示不连续）：\n${hits}`
      : `《${paper.title}》原文里没有找到「${keywords.join(' / ')}」。换个写法（缩写、全称、单复数）再试。`
  }
}

function makeListProblems(scope?: ChatScope): ChatTool {
  return {
    spec: {
      name: 'list_problems',
      description:
        '看用户已经汇总过的开放问题池（各篇「局限与未来工作」聚出来的未解决问题）。讨论研究方向、选题、「还有什么没人做」时用。',
      parameters: { type: 'object', properties: {} }
    },
    describe: () => '看开放问题池',
    run() {
      const scopes = [PROBLEM_SCOPE_ALL, ...(scope?.collectionId ? [scope.collectionId] : [])]
      const parts: string[] = []
      for (const s of scopes) {
        const map = getProblemMap(s)
        if (!map) continue
        parts.push(
          `## ${map.scopeTitle}（${map.problems.length} 个问题）`,
          ...map.problems.map(
            (p, i) =>
              `${i + 1}. ${p.title}\n   出处：${p.paperIds.map((id) => `《${titleOf(id)}》`).join('、')}${
                p.direction ? `\n   切入：${p.direction}` : ''
              }`
          )
        )
      }
      return parts.length ? clip(parts.join('\n')) : '还没有汇总过开放问题池。'
    }
  }
}

const listIdeasTool: ChatTool = {
  spec: {
    name: 'list_ideas',
    description:
      '看用户的选题本（从开放问题生成、正在跟进的选题，含状态和用户备注）。用户问「我之前想做的那个」「我的选题」时用。',
    parameters: { type: 'object', properties: {} }
  },
  describe: () => '看选题本',
  run() {
    const ideas = listIdeas()
    if (!ideas.length) return '选题本还是空的。'
    return clip(
      ideas
        .map(
          (i) =>
            `- 【${IDEA_STATUS_LABEL[i.status]}】${i.title}\n  假设：${i.hypothesis}${
              i.note ? `\n  用户备注：${i.note.slice(0, 300)}` : ''
            }`
        )
        .join('\n')
    )
  }
}

export function chatTools(scope?: ChatScope): ChatTool[] {
  return [searchLibrary, readNote, searchSource, makeListProblems(scope), listIdeasTool]
}
