import { lensMeta } from '@shared/lenses'
import {
  jsonOnlyRule,
  paperHeader,
  pickSections,
  REPRO_EVIDENCE_KEYWORDS,
  sectionRequirements,
  sourceBlock,
  type Lens,
  type LensContext
} from './types'

const SECTIONS = lensMeta('method').sections

const SYSTEM = `你是一位实验方法论教练，擅长把别人「做实验的做法」拆成可以照搬的清单。
你的信条：
1. 讲的是**做法**而不是结果：为什么选这个指标、为什么只跑一次、为什么用闭源模型评、
   算力花在哪，这些才是能迁移的部分；「本文方法提升了 3 个点」这类结果不用写。
2. 有数字就写数字（跑几次、几个种子、几张卡、多少 GPU 小时）。
3. 原文没提的地方明写「原文未说明」，不要用同领域惯例去补。
4. 「可迁移到我自己实验的设计」必须写成可以直接执行的动作，不要写「值得借鉴」这类空话。
5. 输出必须是合法 JSON，不要代码块包裹。`

/**
 * 实验方法论：这篇论文「做实验」的做法本身。
 *
 * 从原来的 experiment 维度拆出来的叙述型任务。它只写「实验方法论」这一节，
 * 不碰结构化画像——因为这两种输出的读者和失败代价都不同：
 * 画像喂机器（填错污染对比表），方法论给人看（写浅只是笔记差一点）。
 */
export const methodLens: Lens = {
  id: 'method',
  meta: lensMeta('method'),
  system: SYSTEM,

  prompt(ctx: LensContext): string {
    return `# 任务
拆解下面这篇论文**做实验的方法论**：实验是怎么设计的、哪些选择有讲究、我能照搬什么。

# 论文信息
${paperHeader(ctx)}

# 输出 JSON
{
  "sections": {
    ${SECTIONS.map((k) => `"${k}": "该章节的 Markdown 内容"`).join(',\n    ')}
  }
}

# 各章节填写要求
${sectionRequirements(SECTIONS)}

# 特别注意
- 请**保留模板里给的加粗标签**（指标体系 / 重复与方差 / 模型选择 / 算力与规模 / 人工评测 / 复现要点 / 可迁移），
  标签后跟实际内容；原文没提的那一项写「原文未说明」并说明你是怎么判断的。
- 「复现要点与坑」写具体到能照着做的程度（数据预处理、评测协议、容易被忽略的实现细节）。
- 「可迁移到我自己实验的设计」给 3-5 条，每条以动词开头。

${jsonOnlyRule()}

# 论文正文
${sourceBlock(ctx, ['Experiments', 'Analysis', 'Method', 'Abstract'], {
  tail: 12000,
  // 「跑几次 / 算力规模」同样落在附录，和实验画像面临一样的问题
  evidence: REPRO_EVIDENCE_KEYWORDS
})}`
  },

  parse(payload) {
    return { sections: pickSections(payload, SECTIONS) }
  }
}
