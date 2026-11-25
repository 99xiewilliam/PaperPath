import { lensMeta } from '@shared/lenses'
import { normalizeExperimentProfile } from '@shared/experiment'
import {
  jsonOnlyRule,
  paperHeader,
  REPRO_EVIDENCE_KEYWORDS,
  sourceBlock,
  type Lens,
  type LensContext
} from './types'

const SYSTEM = `你是一位实验方法论教练，专门从论文里**抽取结构化的实验设置**。
你的信条：
1. 数字与名称优先：数据集名、基线名、指标名、消融组数、算力规模，能写具体就不写笼统。
2. 原文没写的一律填 null 或空字符串，绝不推测。这条是硬要求——这份数据要用于跨论文
   横向对比，编一个「看起来合理」的数字比留空危害大得多。
3. 这是一次**纯抽取**任务：不要写你自己的总结、评论或建议，只把字段填准。
   注意 experiments 里的 claim / conclusion **是论文作者的主张**，必须来自原文 ——
   它们是「抽取出来的主张」，不是「你替作者做的归纳」，所以和本条信条并不冲突。
4. 输出必须是合法 JSON，不要代码块包裹。`

/**
 * 实验画像抽取。
 *
 * 这个维度只干一件事：把实验设置填成结构化字段。它**不写任何章节**
 * （meta.sections 为空，和知识图谱维度一样），产出的 exp 直接喂给
 * 「实验对比」表格做跨论文统计。
 *
 * 其中 `experiments` 是重点：它不是名词清单，而是**实验的论证链** ——
 * 每个实验在验证什么主张、看到什么、作者由此声称什么。
 * 只有一堆数据集 / 基线 / 指标的名字，是回答不了「这篇论文的实验讲清楚了没有」的。
 *
 * 为什么把它从原来的「实验方法论」里拆出来：
 *   - 它要的材料不一样：算力 / 复现细节在附录，散文部分主要在实验章节；
 *   - 它的失败代价不一样：填错一个数字会污染整张对比表，
 *     而散文写浅一点只是笔记质量差一些；
 *   - 它必须能被单独重跑（「补齐画像」批量执行），不该顺带把两段散文也重写一遍。
 */
export const experimentLens: Lens = {
  id: 'experiment',
  meta: lensMeta('experiment'),
  system: SYSTEM,
  voice: false,

  prompt(ctx: LensContext): string {
    return `# 任务
从下面这篇论文里抽取**结构化的实验画像**。只填字段，不写任何章节。

# 论文信息
${paperHeader(ctx)}

# 输出 JSON
{
  "experiment": {
    "datasets": ["数据集/测试集名称，只写名字"],
    "baselines": ["对比的基线系统名称，只写名字"],
    "metrics": ["评估指标名称"],
    "experiments": [
      {
        "kind": "main | ablation | analysis",
        "claim": "这一行在验证的主张（作者想证明什么）",
        "setup": "怎么做的：数据集 / 基线 / 指标 / 关键设置",
        "result": "看到的结果，数字优先",
        "conclusion": "作者由此声称什么；原文没给结论就写空字符串"
      }
    ],
    "ablationCount": 4,
    "runs": "重复实验方式，如「3 个随机种子，报告均值±标准差」；未说明写空字符串",
    "reportsVariance": true,
    "modelChoice": "open | closed | both | none | unclear",
    "openModels": ["用到的开源模型名"],
    "closedModels": ["用到的闭源/API 模型名"],
    "compute": "算力规模，如 8×A100-80G；未说明写空字符串",
    "scale": "训练/推理规模",
    "dataUsage": "full | sampled | both | unclear",
    "dataUsageNote": "抽样怎么抽的，如「从 5 万条里随机抽 2000 条」；非抽样写空字符串",
    "humanEval": "人工评测规模；没有写空字符串",
    "realWorld": false,
    "note": "信息缺失时的说明，正常情况写空字符串"
  }
}

# 字段判定规则（这份数据会用于跨论文横向对比）
- datasets / baselines / metrics 只写名称本身，不要描述；baselines 不要包含本文方法。

## experiments 是这份画像的重点：把实验的**论证链**还原出来
- **一行 = 一个实验主张**（论文里那句「To verify X, we …」，或一个带结论的小节），
  **不是一张表格**。一张结果表同时支撑好几个主张时，就拆成多行。
- kind 的判据：
  · main     = 主实验：在标准设定下与基线比较，证明「整体更好」；
  · ablation = 消融：逐个拿掉组件 / 换掉设计，证明「每一处设计都必要」；
  · analysis = 分析性实验：case study、可视化、人工评测、超参敏感性、失败案例、
               规模效应 —— 不归上面两类的都放这里。
- claim 写「想证明什么」，不要写实验名、数据集名或表格编号。
- result 写「看到了什么」，数字优先（如「F1 +3.2，5 个数据集里 4 个领先」）。
- conclusion 写「作者由此声称什么」。**不要把 claim 或 result 复述一遍** ——
  宁可写「未见明确结论」，也不要把同一句话换个说法塞进来。
- 覆盖要全但**不许凑数**：论文有几个主张就写几行；确实只做了主实验就只写 main。
- 按论文章节顺序排，最多 16 行。
- ablationCount 是消融/分析实验的**组数**，不是表格行数；没做消融写 null。
- reportsVariance：是否给出标准差 / 置信区间 / 多次运行的波动；只跑一次写 false。
- dataUsage 只判**评估阶段用了多少数据**：在完整的测试集 / 全集上评测 → full；
  只用了抽样、子集、部分划分、固定条数 → sampled；两种设定都做了 → both；没提 → unclear。
  为什么单独立这一项：全量评估与抽样评估得到的数字**不能直接比较**，
  而两者在论文里都写作「we evaluate on …」，光看散文分不出来。
- dataUsageNote 只在 sampled / both 时填：写清**从多大数据里抽了多少**
  （如「从 12 万条里随机抽 2000 条」）。只写「抽样」不写规模，等于没写。
- modelChoice：闭源 API 模型 → closed；可下载权重的模型 → open；两类都有 → both；不涉及语言模型 → none；没提 → unclear。
- 所有数字型字段原文没写就填 null；字符串字段没写就填空字符串 ""。
- note 只写「哪些字段为什么填不出来」，不要写论文总结或方法评价。

# 特别注意
- experiments 的材料在实验章节的**叙述文字**里（「To verify…」「We attribute…」
  「This confirms…」），不只在表格数字里：表格给你 result，叙述才给你 claim 与 conclusion。
- 算力 / 复现细节常写在**附录**里（Compute / Implementation details / Reproducibility）。
  下面已经按关键词把全文里相关的片段捞出来了，请优先读这部分再判断 compute / runs。
- 但捞出来的片段只是线索，**没写就是没写**：不要因为同领域论文通常用 8 卡，
  就给这篇也填上 8×A100。

${jsonOnlyRule()}

# 论文正文
${sourceBlock(ctx, ['Experiments', 'Analysis', 'Conclusion', 'Method', 'Abstract'], {
  tail: 12000,
  evidence: REPRO_EVIDENCE_KEYWORDS
})}`
  },

  parse(payload) {
    const root = (payload ?? {}) as Record<string, unknown>
    const exp = normalizeExperimentProfile(root.experiment)
    const filled = Object.values(exp).filter(
      (v) => v != null && v !== '' && (!Array.isArray(v) || v.length)
    ).length
    return {
      data: { exp },
      summary: exp.experiments.length
        ? `实验画像 ${filled} 项 · 实验清单 ${exp.experiments.length} 条`
        : `实验画像完整度 ${filled} 项`
    }
  }
}
