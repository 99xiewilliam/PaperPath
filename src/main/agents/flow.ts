/**
 * 「方法流程图」生成 agent：照着原文把系统怎么跑画成一张结构化流程图。
 *
 * 为什么从演示 agent 里拆出来单独一次调用（一个产物一个 agent，约定见 ai-service 顶部）：
 * 以前让演示 agent 在一份长 JSON 的尾巴上顺手画（slide 里嵌一个 flow 字段），
 * 那是整次调用里最弱的一环 —— 结构最深、离 prompt 的约束最远、坏了也没有独立的重试机会。
 * 而它画的东西和精读「方法细节」维度产出的又是同一个键（frontmatter `flow:`）、
 * 同一个渲染器，本来就属于「论文的产物」而不是「讲稿的一页」。
 * 拆成专职调用后：prompt 短而专注、校验（normalizeMethodFlow）独立、
 * 失败只影响流程图这一块，讲稿照常往下走。
 *
 * 产出会持久化进笔记 frontmatter 的 `flow:` —— 它不只服务演示：详情页直接展示，
 * 下次重新生成演示也直接复用，不用再画一遍（也就不用再花一次钱）。
 */
import { normalizeMethodFlow, type MethodFlow } from '@shared/flow'
import type { LlmSettings } from '@shared/types'
import { chatCompletion, extractJson } from '../llm'

export const METHOD_FLOW_SYSTEM = `你是一位把论文方法画成流程图的绘图者。读者是没读过这篇论文的人，
他们要靠这张图在脑子里搭起「数据从哪进、经过哪几步、从哪出」的骨架。

1. 只依据给定原文：节点写的必须是论文里真实存在的步骤，不许编，也不许用同领域惯例补。
2. 节点按执行顺序排，**4~8 个为宜**：
   - label 写「这一步在做什么」，20 字以内，别抄整句原文；
   - note 写「为什么这么设计」—— 作者给过理由才写，没给就不写；
   - source 标原文出处（§3.2 / Fig.2 / 附录 B），标不出就留空。
3. 有分支就写成分支（例如「失败 → 重试」），不要硬拉成一条直线。
4. **论文没有清晰的方法流程时（纯理论、综述、纯数据集论文），flow 返回 null。**
   硬编一条流程比没有图更糟：读者会以为那就是论文的结构。
5. 输出必须是合法 JSON，不要代码块包裹。`

export interface MethodFlowAgentInput {
  title: string
  /** 按章节挑过的原文片段（调用方用 sourceBlock 组装） */
  sourceText: string
}

export function buildMethodFlowUser(input: MethodFlowAgentInput): string {
  return `# 任务
照着下面这篇论文的原文，把它的方法画成一张流程图。

# 论文
《${input.title}》

# 输出 JSON
{
  "flow": {
    "title": "这条例程的一句话名字",
    "nodes": [
      { "id": "n1", "label": "输入是什么", "source": "§3.1" },
      { "id": "n2", "label": "第一步做什么", "note": "为什么这么设计", "source": "§3.2 Fig.2" },
      { "id": "n3", "label": "输出是什么", "source": "§3.4" }
    ],
    "edges": [{ "from": "n1", "to": "n2" }, { "from": "n2", "to": "n3" }]
  }
}

论文没有清晰的方法流程时，输出 { "flow": null }，不要硬编。

# 论文正文
${input.sourceText}`
}

/**
 * 从模型返回的 JSON 里取出 flow 本体。
 *
 * 容忍两种形状：约定的 \`{ flow: … }\` 包装，以及模型偶尔直接吐的 flow 对象本身
 * （跟 quiz / slides 的「偶尔直接吐数组」是同一种毛病）。
 */
export function pickFlowPayload(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'flow' in raw) return (raw as Record<string, unknown>).flow
  return raw
}

/**
 * 画一张方法流程图。画不成（论文本来就没有可画的流程，或返回的结构不成立）
 * 返回 undefined —— 调用方「不写这个键」，演示继续往下走。
 */
export async function runMethodFlowAgent(
  input: MethodFlowAgentInput,
  llm: LlmSettings,
  options: { signal?: AbortSignal } = {}
): Promise<MethodFlow | undefined> {
  const res = await chatCompletion(
    [
      { role: 'system', content: METHOD_FLOW_SYSTEM },
      { role: 'user', content: buildMethodFlowUser(input) }
    ],
    llm,
    // 画图要的是忠实复述原文而不是组织语言，温度压到接近复述档
    { temperature: 0.2, signal: options.signal }
  )
  return normalizeMethodFlow(pickFlowPayload(extractJson(res.content)))
}
