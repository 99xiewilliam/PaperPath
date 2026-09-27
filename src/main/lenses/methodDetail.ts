import { lensMeta } from '@shared/lenses'
import { normalizeMethodFlow } from '@shared/flow'
import {
  jsonOnlyRule,
  paperHeader,
  pickSections,
  sectionRequirements,
  sourceBlock,
  type Lens,
  type LensContext
} from './types'

const SECTIONS = lensMeta('methodDetail').sections

const SYSTEM = `你是一位把论文方法讲到「读者能照着复现」的讲解者。
你的读者是同行研究生，但不是这篇论文所在子方向的专家：基本原理他懂，看不懂的是这篇的具体做法。

你的信条：
1. 讲方法要落到可操作的颗粒度：输入是什么形态、每一步收到什么又吐出什么、关键设计为什么这么选。
   复述「我们提出了一个框架」这种摘要级空话等于没讲。
2. **每一句都要能回答「它对什么数据做了什么」或「它凭什么做这个决定」。**
   回答不了的句子一律不要写 ——「深度融合了多模态信息」「有效地提升了性能」「设计了若干模块」
   这类话是通顺的，但读者读完依然不知道发生了什么。
3. 术语第一次出现写「原文写法（一句话人话）」：读者要能拿着这个词回原文里搜到它。
   公式要逐个符号说明含义 —— 抄一个公式而不解释，读者依然看不懂。
4. 能用论文自己的符号、图号、取值就用它，不要用自己发明的类比去替换。
5. 原文没写的（超参、实现细节、失败情况）写「原文未说明」，不要用同领域惯例补。
6. 输出必须是合法 JSON，不要代码块包裹。`

/**
 * 方法细节（顺带产出方法流程图）。
 *
 * 为什么单独成维度：现有维度里没有一个负责「把方法本身讲清楚」——
 * 速览讲的是它做了什么、写作手法讲的是它怎么写、实验方法论讲的是它怎么做实验，
 * 而读者真要动手复现时最缺的「方法到底怎么跑起来」从来没被写过。
 *
 * 为什么只写一节：它原来还兼着「具体例子」，一次写 2 节 + 流程图，
 * 在慢模型上直接超 300s 超时（真实失败：deepseek-chat），两节一起空白。
 * 例子拆去 methodExample 了 —— 和写作维度拆成两个是同一味药。
 */
export const methodDetailLens: Lens = {
  id: 'methodDetail',
  meta: lensMeta('methodDetail'),
  system: SYSTEM,

  prompt(ctx: LensContext): string {
    return `# 任务
把这篇论文的**方法讲清楚到能照着复现**。

# 论文信息
${paperHeader(ctx)}

# 输出 JSON
{
  "sections": {
    ${SECTIONS.map((k) => `"${k}": "该章节的 Markdown 内容"`).join(',\n    ')}
  },
  "flow": {
    "title": "这条例程的一句话名字",
    "nodes": [
      { "id": "n1", "label": "输入是什么", "source": "§3.1" },
      { "id": "n2", "label": "第一步做什么", "note": "为什么这么设计", "source": "§3.2 Fig.2" },
      { "id": "n3", "label": "输出是什么", "source": "§3.4" }
    ],
    "edges": [
      { "from": "n1", "to": "n2" },
      { "from": "n2", "to": "n3" }
    ]
  }
}

# 各章节填写要求
${sectionRequirements(SECTIONS)}

# 特别注意
- 「方法细节」按**执行顺序**讲：输入 → 各步骤 → 输出。每一步都写清「做什么 + 为什么这么做」，
  不要只贴模块名。作者做了取舍的地方（选了 A 而不是 B、为什么不用 B）必须写出作者给的理由；
  作者没给理由时写「原文未说明理由」，不要替他编一个。
- **「走一遍」是这一节最有用的部分，必须写**：拿一个具体输入（论文里的例子优先；没有就自己构造一个最小的，
  并标明「这是我构造的」），一步一步走完，写清每一步之后它的形态或取值变成了什么。
  只列步骤名，读者仍然不知道数据长什么样 —— 这一条就是用来堵这个的。
- 每一步尽量标出处（§3.2 / Fig.2 / 表 3），读者好回原文核对。
- 术语给中英对照（原文怎么写就怎么留）；公式与符号逐个解释含义与维度；有默认值或超参就写数字。
- 论文没说明的（训练细节、失败模式、实现坑）写「原文未说明」。
- 全文 1200-2200 字。**宁可每条只写两三句，也不要为了填满结构写空话** —— 这一节的价值全在具体，不在长。
- 写完自查一遍：读者读完这节，能不能答上「输入长什么样」「第三步为什么不用另一种做法」
  「哪些数字是原文给的、哪些原文没写」？答不上就补；补不了就写「原文未说明」。
- \`flow\` 会被画成一张**流程图**给初学者看：
  - 节点按执行顺序排，**4~8 个为宜**；label 写「这一步在做什么」（20 字以内，别抄整句原文），
    note 写「为什么这么做」（没有就不写），source 标出原文出处（\`§3.2\` / \`Fig.2\` / \`附录 B\`）。
  - 有分支就写成分支（例如「失败 → 重试」），不要硬拉成一条直线。
  - **论文没有清晰的方法流程时（纯理论、综述、纯数据集论文），整个 \`flow\` 字段都不要出现。**
    硬编一条流程比没有图更糟：读者会以为那就是论文的结构。

${jsonOnlyRule()}

# 论文正文
${sourceBlock(
  ctx,
  ['Method', 'Approach', 'Methodology', 'Preliminaries', 'Abstract', 'Introduction', 'Experiments'],
  { tail: 12000 }
)}`
  },

  parse(payload) {
    const flow = normalizeMethodFlow((payload as Record<string, unknown> | null)?.flow)
    return {
      sections: pickSections(payload, SECTIONS),
      // 画不成图（节点太少 / 都是坏数据）就不带这个键，界面上那一块整个不出现
      ...(flow ? { data: { flow } } : {})
    }
  }
}
