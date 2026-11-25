# PaperVault · 论文智库

> 一个本地优先的论文阅读知识库：不只是存论文，而是逼自己把「学到了什么 / 它怎么写 / 它怎么做实验」沉淀下来，并在一批同类论文攒够之后，自动归纳出这类论文的通用套路。

## 为什么做这个

读过的论文很容易就忘了。市面上很多知识库只能帮你「存」，PaperVault 关注的是**科研能力的复利**：

- 每篇论文都按**固定章节**拆解，所以不同论文之间可以横向比较；
- 专门拆 `Abstract / Introduction / Related Work / Methodology / Experiments` 的**写作手法**，积累自己的句式与结构库；
- 专门沉淀**实验方法论**：指标怎么选、跑几次、报不报方差、用开源还是闭源模型、算力规模；
- 同类论文攒够 2 篇以上，一键生成「**这一类论文一般怎么写、怎么做实验**」的手册。

## 功能地图

顶级导航只有四个，对应一条动线：**读 → 写 → 做实验 → 沉淀**。

```
论文库 ──► 写作思路 ──► 实验对比
  │           ├ 单篇拆解        │
  ├ 专题      ├ 套路库          │
  │           └ 句式库          │
  └──────────► 沉淀 ◄───────────┘
                ├ 接着读这些
                ├ 开放问题池 ──► 选题本
                └ 统计
```

为什么这么收：功能不是不够，是**入口太多**。八个并列的导航说不出「这个软件是干什么的」，
四个可以。句式库并进了写作思路，设置从导航挪到侧栏顶部的齿轮（⌘,）。
早期的知识图谱、论文关系、跨论文（套路归纳 / 研究想法 / 组合分析）已经下线；
「从论文里找方向」现在由**开放问题池 → 选题本**这条线承担。

判断标准只有一条：**打开软件第一眼能不能说出它是干什么的**。

## 核心功能

### 给刚开始读论文的人

导入 PDF、跑一次「AI 精读」，你会得到一份结构化笔记：一句话总结、核心问题与动机、关键收获、方法细节、具体例子、实验方法论、局限与未来工作、可迁移到我的研究……精读是按维度拆成多次调用的（见上文），所以某个维度写得不满意可以单独重跑，失败时也只会补失败的那几节。

建议的读法：

1. **先判断值不值得细读**：看「一句话总结」和「核心问题与动机」。
2. **看它到底怎么做**：方法细节、具体例子，以及由「方法细节」维度顺带产出的方法流程图。
3. **看实验撑不撑得住**：实验方法论、局限与未来工作、实验画像（数据集 / 基线 / 指标一览）。
4. **最后落回自己**：可迁移到我的研究、方法串联（库内候选由知识图谱按共享技术要素筛出）、举一反三。

笔记就是普通 Markdown 章节，直接在「结构化笔记」里改。读完后可以用论文头部的「**考考我**」自测一遍 —— 解析带原文出处，答不对的地方正好是要回头补的。

### AI 标重点（阅读器里）

在 PDF 正文里点「AI 标重点」，把「读这篇论文最不该跳过的句子」直接标在原文版面上，每条附一句「为什么这是重点」。位置不可能标错页：模型**不返回原文、只返回行号区间**，渲染层先把每页文字抽成带编号的行（行号 + 页码 + 归一化矩形）发给主进程，模型挑区间，再拿行号回查矩形 —— 引用了不存在行号的区间整条丢弃，宁少不错。

标注不是一口气一个模型做完整篇，而是按内容类型拆成 **4 个专家 agent 并发**，各喂各的章节、各有配额：

| 专家 | 喂的章节 | 配额 |
| --- | --- | --- |
| 问题动机 | Abstract / Introduction / Related Work | 3~5 |
| 核心方法 | Method 及其子节 | 4~6 |
| 实验与结果 | Experiments / Analysis / 附录消融 | 6~8 |
| 结论与局限 | Conclusion / Limitations / Discussion | 3~4 |

为什么拆：**行列表更短，模型引用行号更准**（行号错一位整条丢弃，短列表就是少丢）；每类有自己「什么算重点」的标准，不用在一个 prompt 里权衡四种价值观；单个专家失败不影响其余三类，界面提示缺了哪类；各喂各的章节，总投喂量与单 agent 全文基本持平。章节结构认不出来时（扫描件 / 诡异排版）自动退回单 agent 全文。重跑 = 整条替换旧的 AI 标注，用户手划的高亮永远不动（`mergeAiHighlights`）。

相关回归检查：`npm run smoke:parse` 第 23 节，已纳入 `npm run verify`。

| 模块 | 说明 |
| --- | --- |
| 论文库 | 三栏布局（导航 / 列表 / 详情），支持搜索、排序、状态与分类筛选 |
| **专题** | 手动把一组相关论文归到一起（对应「这段时间集中看的那几篇」）。一篇论文可以同时属于多个专题。打开专题即可基于这组笔记向 agent 提问，满意的回答点一下就**追加进专题笔记**（专题笔记默认按 Markdown 渲染，双击编辑） |
| **开放问题池** | 把范围内（全库或某个专题）每篇的「局限与未来工作」交给模型，按主题聚成一组「这个方向还没解决的问题」，每条标明是作者自陈还是审稿视角、出自哪几篇、可能的切入点。结果存成 `problems/<范围>.md`，可以直接读、也能进 git。入口在「沉淀」页和每个专题的分析面板 |
| **我的想法** | 阅读器里选中文字点「想法」，划线的同时写下自己的判断；笔记页顶部汇总这篇所有划线与想法，点一条跳回 PDF 原处。问答时这些想法会和 AI 笔记一起喂给模型，并标明是用户本人的观点 |
| **参考文献对照** | 在笔记页底部一键从原文抽出参考文献表，逐条标出「已在库」（按 arXiv 编号或标题匹配）或「未入库」，未入库的一键建成待读条目（带上 `来自参考文献` 标签） |
| PDF 导入 | 拖拽或选择 PDF → 抽取全文 → 猜测标题 → 归档副本 → 生成笔记骨架（可自动接 AI 精读） |
| AI 精读 | 把原文按章节切分喂给模型，产出固定章节的结构化笔记 + 一篇按你的读论文风格写的完整导读（「导师精读」）+ 结构化实验画像，并自动打分类标签 |
| 写作手法拆解 | 每个写作章节都有骨架提示与「AI 重写这一节」按钮，可反复打磨 |
| **写作思路** | 写作相关能力的唯一入口，三个分区：单篇**写作逻辑卡**（故事线 / 逐段疑问 / 引用功能 / 优势对齐 / 贡献回扣 / 方法论证链）、按相似度自动聚出的**套路库**（每套可一键生成手册）、**句式库**；侧栏 ⌘2 |
| **实验画像** | 把实验设置抽成结构化字段：数据集 / 基线 / 指标 / 消融组数 / 重复次数 / 是否报告方差 / 开源闭源 / 算力 / 人工评测 |
| **实验对比** | 把同类论文的实验设置拉成一张可排序、可导出（CSV / Markdown）的对比表，并本地算出「这批论文平均几个数据集、几篇报告了方差、开源闭源比例」 |
| **选题本** | 在开放问题池里展开一个问题点「生成选题」：模型结合出处论文的方法与局限、你在这些论文上写的想法、以及库里其他论文的一句话总结，给出最多 3 个选题。每个必须同时有**可证伪的假设 + 最小验证实验 + 反证条件**，缺一项直接丢弃。选题存成 `ideas/<id>.md`，在「沉淀」页集中跟进：改状态（待评估 / 在推进 / 先放着 / 放弃）、写备注。问题池重新汇总不会删掉已有选题；标题换了说法、但出处论文还是那些时，选题仍挂在这个问题下 |
| 细粒度分类 | 21 个内置分类（Benchmark / Dataset / RAG / 检索 / Agent / 具身智能 / VLA / 多模态 …），支持自定义 |
| **沉淀** | 接着读这些、开放问题池、选题本，以及积累字数、实验方法论完成度、实验画像覆盖率、分类分布、12 周入库节奏、高频标签。侧栏 ⌘4 |
| AI 问答 | 基于你选中的论文笔记多轮提问，流式输出、随时可停；笔记不够时模型会自己查库、读别的笔记、翻 PDF 原文、看问题池和选题本，回答下面列出它查阅过什么。只依据笔记和查到的内容作答，不会凭空编造 |
| arXiv 拉取 | 输入 `2401.12345` 即可拉取标题、作者、年份、领域 |

## 分析维度（Multi-Agent）

精读**不是**一个大 prompt 塞满所有章节，而是拆成若干个互相独立的「分析维度」。
每个维度就是一次独立的模型调用，有自己的 system prompt、自己的输入片段、自己的输出 schema：

| 维度 | 负责的章节 | 投喂的原文 |
| --- | --- | --- |
| `overview` 速览与故事线 | 一句话总结 / 核心问题与动机 / 关键收获 / 故事线拆解 / 可迁移到我的研究 | Abstract + Intro + Analysis + Conclusion |
| `writing` 写作手法 · 开篇 | 写作手法 · Abstract / Introduction / Related Work | Abstract + Intro + Related Work |
| `writingMethod` 写作手法 · 方法与实验 | 写作手法 · Methodology / Experiments + 原文摘录 | Abstract + Method + Experiments + Analysis + Conclusion |
| `writingLogic` 写作逻辑卡 | **（不写章节）** frontmatter `wlogic` | Abstract + Intro + Related Work + Method + Experiments |
| `english` 英语写作短语 | 英语写作短语 | Abstract + Intro + Related Work + Method + Experiments |
| `visuals` 图表与可视化设计（**默认关闭**） | 图表与可视化设计 | 正文 + 附录片段（图注散布全书） |
| `experiment` 实验画像抽取 | **（不写章节）** frontmatter `exp` | Experiments + Analysis + Method + 正文后段 + 算力关键词回捞 |
| `method` 实验方法论 | 实验方法论 | Experiments + Analysis + Method + 正文后段 + 算力关键词回捞 |
| `limitations` 局限与未来工作 | 局限与未来工作 | Limitations + Discussion + Conclusion + Experiments + Analysis + Intro |
| `deepread` 导师精读 | 导师精读（一整篇长文） | 正文主干各节（64K 字符预算）+ 正文后段 + 算力关键词回捞 |

**为什么要拆**：输出短不会截断、注意力集中每个维度写得更深、单个维度失败不影响其他维度、
可以单独重跑某一个维度、新增维度只需要加一个文件而不动其他 prompt。

### 读论文风格（Skill）

拆开的代价是「碎」：每个维度把一个侧面拆到能跨论文复用，但拼不出导师从头讲到尾的那条线。
所以另有一个 `deepread` 维度，按知识库里 `skills/读论文风格.md` 写一整篇导读
（开场定位 → 六个核心问题 → 留坑点 → 可带走的规律 → 一句话收获）。

这份文件按二级标题分三块，各有去处：

| 块 | 用在哪 |
| --- | --- |
| `## 口吻` | 拼进**所有写文字的维度**的 system prompt（`experiment` / `writingLogic` / `english` 这类结构化抽取除外，口吻只会干扰字段的忠实度） |
| `## 导读结构` | `deepread` 照着组织整篇；整块删掉时退回默认结构 |
| `## 示例片段` | 只给 `deepread` 看，示范口吻与组织方式，prompt 里明确禁止照抄示例的内容 |

在「设置 → 读论文风格（Skill）」里直接编辑，或者用任何编辑器改这个文件；删掉文件会在下次打开知识库时恢复默认。
想让 agent 学一篇你喜欢的讲解，把它节选进「示例片段」即可——节选时去掉你没核实过的引用，
示例里的编造会被模型当成「可以这么写」。

导读是其余章节的长篇复述，所以**多篇问答时不进上下文**（只会挤掉别的论文），单篇问答时才带上。

相关回归检查：`npm run smoke:experiment` 第 ⑥ 部分（口吻注入范围、长文落盘、默认与缺块回退）、
`npm run smoke:ipc` 第 2 节（skill 文件的生成 / 读写 / 恢复默认）。

**实验相关为什么要拆成三个**：这三件事的认知模式不同，需要的材料也不同——
`experiment` 要求「忠实填字段，没写就留空」，`limitations` 要求「跳出作者框架挑漏洞」，
把这两种相反的要求塞进同一个 prompt 会让模型自我审查，两头都做不好。
拆开还有个实际好处：`experiment` 产出的结构化字段是喂给「实验对比」表格的，
不该因为一段散文被截断而一起丢掉；而它也因此能被「补齐画像」单独批量重跑。

**写作维度为什么要再拆一刀**：它原本一个维度要一次写 6 节（5 个写作手法 + 原文摘录）。
实测输出会撞上 `max_tokens` 被截断，而截断抢救（`repairTruncatedJson`）只保住
「最后一个完整值」—— 于是记录里是「写作手法拆解 ✓」，实际只落了 Abstract 一节、
其余 5 节还是空骨架，界面上完全看不出来。同一次运行里只写 1 节的维度
（图表 11K 字符、实验方法论 9K 字符）全部成功，说明预算够写一节、不够写六节。
拆成 3+3 之后每次的输出量减半；顺带把「产出不全」和「被截断」做成了可见信号
（`lensNote`：会写成「只产出 1/6 节　输出被 max_tokens 截断」），
以后再出现就不会藏在一个 ✓ 后面了。

- 维度可以**独立开关**（设置 → 分析维度），关掉不需要的能省钱提速
- 论文详情页点「AI 精读」会列出所有维度，可以**只跑其中一个**
- 新增一个维度：在 `src/main/lenses/` 加一个文件 + 在 `index.ts` 注册 + 在 `src/shared/lenses.ts` 加元数据
- 开关存的是「**关掉了哪些**」而不是「启用了哪些」——这样新增维度能自动对老用户生效，
  不用改配置（迁移逻辑见 `disabledLensesFromLegacy`，`npm run smoke:parse` 有回归测试）
- **改默认值必须配一次迁移**：`enabledLensIds` 只看 `disabledLenses`，不读 `defaultEnabled`。
  把某个维度从默认开启改成默认关闭（`visuals` 就是这么关掉的），要改
  `main/settings.ts` 的 `DEFAULT_SETTINGS`（只管新装）+ 把 `SETTINGS_VERSION` +1 并补一条
  `migrateSettings` 分支（管老用户）。只改 `defaultEnabled` 对老用户完全无效。

**成本参考**（36 页 / 11.5 万字符的论文，`npm run smoke:ai -- <pdf> --dry` 实测）：

| 维度 | 输入 token |
| --- | --- |
| `overview` | 4,260 |
| `writing` 开篇 | 4,803 |
| `writingMethod` 方法与实验 | 5,347 |
| `english` | 8,332 |
| `visuals` | 9,455 |
| `limitations` | 6,506 |
| `graph` | 7,170 |
| `experiment` | 12,995 |
| `method` | 12,740 |
| **合计** | **约 7.2 万** |

`experiment` / `method` 最贵是有原因的：除了实验章节，它们还要额外拿一段正文后段
（附录里的算力在这里）和一遍全文关键词回捞。

⚠️ 这组数字**完全取决于章节切分**：切分成功时每个维度只拿自己那几节；一旦失败，
没写 `tail` 的维度会退化成「整篇截断投喂」，单项会从几千 token 涨到两万多。
`npm run inspect:pdf` 第一段就会告诉你这篇切出章节没有。

> **给维度点名的章节单独分额度**：`sourceBlock` 只在这几节之间分配
> （`SECTION_BUDGET = 24000`，单节下限 8,000），而不是沿用 `prepareLlmSource`
> 的「全篇均分」。后者在一篇 9 节的论文里每节只剩 6,666 字符，实测把
> Experiments（11,370）从 §5.3 之后直接切断 —— §5.4 消融 / §5.5 真机验证整节
> 没送到模型，于是 `ablationCount` 空着、`realWorld` 被判成「论文没写」，
> 而论文里明明写着。改成按需分配后同一篇：`真机实验 true`、`消融组数 4`、
> 指标从 3 个粗粒度项变成 8 个具体项。

### 「上次精读」记录

详情页的章节列表最上面有一行状态，回答「上一篇笔记为什么是空的」：

| 状态 | 含义 |
| --- | --- |
| 全部成功 | 所有启用的维度都跑出来了 |
| 部分失败 | 哪些维度失败、各自的原因是什么（可展开看） |
| 失败 | **整个流程没跑起来**（没有原文 / 知识库没打开 / 接口报错…），带原始错误 |
| 已取消 | 写明只跑了几个维度 |

为什么需要它：精读的产出**只在「跑完、且至少一个维度成功」那一刻才写回笔记**。
于是「中途被杀」「用户取消」「压根没能启动」这三种结局，在界面上以前是同一幅画面 ——
笔记一片空白，而且和「这篇论文确实没写实验设置」完全无法区分。排查时只能猜，
实测连着猜错过好几次，其中包括把**导入时写进去的 Abstract 占位内容**
（`importPdf` 会把摘要前 600 字符填进「一句话总结」）当成了 AI 的产出。

实现上它存在索引的 `last_run` 列里，**不进 frontmatter** —— 这是运行诊断信息，
不该混进笔记正文，也没必要跟着笔记一起同步。四种结局由 `buildRunRecord` 归一化，
`npm run smoke:parse` 有回归测试；列的迁移由 `npm run smoke:db` 守着。

## 写作思路

写作相关的能力原来散在三处：论文详情里的「写作手法」章节、速览里的「故事线拆解」、
跨论文页的「套路归纳」。找的时候得先判断「这件事归哪个页面管」。
现在**唯一入口是导航里的「写作思路」**，它只做另外两处做不了的事 ——
跨篇对齐与聚类。

**单篇：写作逻辑卡**

`writingLogic` 维度**不写任何笔记章节**，只抽结构化数据。卡片回答七个问题：

| 区块 | 回答什么 |
| --- | --- |
| 故事线 | 属于哪种开局打法（补缺口 / 拆失败模式 / 定义新能力 / 降本 / 统一 / 扩展 / 可靠性），一句话主线是什么 |
| Introduction 逐段 | 每一段替读者解决哪个疑问、起决定作用的英文原句、我写时该换成什么 |
| 引用功能 | 被点名的每篇工作在这里干的是哪份活（靶子 / 垫脚石 / 共识 / 威胁 / 工具 / 背景），以及它反衬出本文的哪个优势 |
| 优势对齐 | 它想凸显哪一项优势、靠什么撑住（引用反衬 / 实验数字 / 机制设计） |
| 贡献段 | 每条声称什么（补缺口 / 给机制 / 给证据）→ 回扣哪个缺口 → 由什么支撑 |
| Related Work | 按什么轴分类、每类最后留下什么缺口、自己插在哪一类之后 |
| 方法论证链 | 每一步要证明什么、配了哪张图、设计选择怎么被论证成「只能这么选」 |

**为什么要拆成字段而不是再写一节散文**：散文没法聚合。想回答「这 12 篇里有多少篇靠否定前人开局」，
只能让模型每次重读一遍重新数，措辞每次都不同，攒不出套路。结构化之后，
「引用它当靶子还是当垫脚石」成了字段而不是修辞，跨论文分布才可计算。

**套路库：怎么判定「逻辑一样」**

三个信号的加权和，阈值 `0.55`（`shared/writing-logic.ts` 的 `PATTERN_THRESHOLD`）：

| 信号 | 权重 | 为什么 |
| --- | --- | --- |
| 故事线类型相同 | 0.45 | 开局攻法一样，基本就是同一套论证模板 |
| 优势维度 Jaccard | 0.30 | 都在拿「更省算力」当卖点，说明边界定义一致 |
| 引用角色分布余弦 | 0.25 | 靠否定前人开局 vs 靠借用组件开局，骨架差别很大 |

刻意**不用「引了哪几篇具体工作」**做信号：不同领域引的是不同论文，拿它算相似度只会把同一套路拆散。

聚类是单链接 + 连通分量，不是 k-means —— 套路数事先未知，硬凑 k 个中心会把明显不同的论文塞进一簇。
单链接的已知缺点（A 像 B、B 像 C、A 不像 C 时会串成一条链）用 `cohesion` 兜住：
簇内平均相似度低于 0.7 时界面上会标「较松，可能只是共享类型」。
**成员少于 2 篇不构成套路**，单篇单独列出 —— 不硬凑。

**数据放哪**：卡片存 frontmatter 的 `wlogic`，索引里那一列只是镜像（能从 Markdown 重建）。
写入语义与图谱、关系一致：**`undefined` = 本次不携带，保留库里原值；`{}` = 明确清空** ——
少了这条，一次全库重扫（改自定义分类就会触发）就会把套路库清空。

回归：`npm run smoke:writing`，已纳入 `npm run verify`。

## 知识图谱

论文越攒越多之后，真正难的是「这些论文之间是什么关系」。`graph` 维度会从每篇论文里抽出
**实体**（模型 / 数据集 / 基准 / 任务 / 方法 / 指标 / 技术 / 概念 / 机构）和**关系**
（提出 / 使用 / 训练于 / 评测于 / 对比 / 改进 / 扩展 / 基于 / 应用于 / 由…衡量 / 属于），
带原文 evidence。图谱页把它们拼成一张可交互的图。

**节点与边**

- 节点：论文（空心环）、实体（实心圆，颜色按类型）
- 边：`论文 —涉及→ 实体`、`实体 —关系→ 实体`
- 同名实体跨论文自动合并，所以 `CultureVerse` 被 3 篇论文提到就是同一个节点

**多跳检索**（图谱页选中任意节点，右侧调跳数）

从一篇论文出发，看 N 跳内能连到哪些**其他论文**，以及**经由了哪些实体**。
这直接回答了「这两篇看起来不相关的论文为什么相关」。

值得注意的一点：**实体间关系会制造捷径**。如果 A 和 C 不共享任何实体，
但 A 提出 `AlphaBench`、`AlphaBench --part-of--> BetaSet`、C 用到 `BetaSet`，
那么 A→C 只有 **3 跳**（A → AlphaBench → BetaSet → C），中间完全不需要经过第三篇论文。
这正是知识图谱比「共享关键词」更强的地方，`npm run smoke:graph` 里有一条断言专门锁住这个行为。

**可读性控制**

- 「实体最少出现于 N 篇论文」——只被 1 篇提到的实体是图变乱的主因，调高即可滤掉
- 按实体类型开关显示
- 按分类圈定范围（只看 RAG 类、只看 benchmark 类……）

**实现说明**：没有在 SQLite 里建三张表，而是在主进程内存里构图并缓存，用
`COUNT(*) + SUM(LENGTH(graph)) + MAX(updated_at)` 作为指纹做失效判断。
个人知识库量级（几千篇 × 约 25 实体）下构建只要几十毫秒，而多跳 BFS 在内存里做
远比递归 SQL 简单可靠，也少一次 schema 迁移的风险。

## 问答怎么做多轮

没有用 agent 框架，是在自己的模型调用层 `llm/`（重试、取消、计费、各家兼容处理都在这里）上加了一个小的工具循环。

- **状态全在渲染层**：会话历史和压缩摘要存在 localStorage（`chatStore.ts`，按论文集合分线程、每组可开多条对话）。
  主进程每轮都是无状态的：拼上下文 → 工具循环 → 返回。
- **上下文顺序**：`system → 选中论文的笔记 + 之前对话的备忘 → 最近几轮原文 → 本轮提问`。
  笔记放最前且每轮不变，服务商的前缀缓存能命中。
- **历史压缩**：还没压过的部分超过 24K 字符就压，不管有几条消息。在不超预算的前提下尽量多留最近的原文，
  切点一定落在提问上；之后又聊长了会再压一次。备忘随结果带回渲染层存进会话。
  备忘已经压好、但回答本身失败时，备忘照样存上，下一轮不必重压。
- **笔记放不下时会说**：多篇一起问、笔记总长超过预算时，放不下的论文不静默丢掉，界面标出「这次没带上」，
  并告诉模型可以用工具去查。
- **长期记忆就是知识库本身**：精读笔记、划线想法、专题笔记、存档的回答、选题本。不另建一个黑盒记忆库，
  否则会和「Markdown 是唯一事实来源」冲突。
- **工具**（`chat-tools.ts`，全部只读、每个结果限 6000 字）：`search_library` 搜库、`read_note` 读某篇笔记某一节、
  `search_source` 按关键词翻 PDF 原文、`list_problems` 看问题池、`list_ideas` 看选题本。
  最多 5 步、每步最多执行 4 个工具调用，到上限就不再给工具，逼模型用已有材料作答；服务商不支持 function calling（对 tools 回 400）时自动退回普通问答。
- **不排队**：问答走交互通道，不会排在几分钟的精读后面；`streamId` 同时是取消标识，「停止」只掐这一次问答，已写出的部分保留。

相关回归检查：`npm run smoke:stream` 第 8~11 节（流式工具调用分片、工具循环、降级、步数上限、压缩），
`npm run smoke:ipc` 第 20 节（各工具对真实知识库的读法）。

## 架构与性能要点

这几条是踩过坑之后的结论，改动前值得先读一遍。

**1. 索引只存「派生数据」，不存正文**

Markdown 是唯一事实来源，`.papervault/index.sqlite` 只是可丢弃的索引。索引里**不保存
章节正文**——那等于把 Markdown 又抄一份。章节一律通过 `vault.readPaperSections()`
按需读取。

`papers` 表里存的是这些算好的派生值：`tldr`、`char_count`、`ai_filled`、
`writing_notes`、`experiment_notes`、`search_blob`。所以「沉淀统计」依然是一次 SQL
扫描就能算出来，不需要为了统计去读几百个 Markdown 文件。

> 老版本升级时会自动回填 `writing_notes` / `experiment_notes`，然后删列并 `VACUUM`
> 回收空间。`npm run smoke:db` 专门覆盖了这条升级路径——实测索引体积缩小约 **61%**。

**2. AI 任务走统一的串行队列，且可取消**

`src/main/tasks.ts` 是一个极简的任务队列：

- **串行**：同一时刻只有一个任务在跑，进度事件因此不会互相覆盖；
- **可取消**：`task:cancel` 会中断正在跑的任务，并直接丢弃队列里还没开始的
  （否则点「取消」之后剩下的几十篇还会继续把请求发出去）；
- **进度带 `taskId`**：渲染层能分辨这条进度属于哪个任务。

取消是**协作式**的：队列只负责 `abort()`，任务体自己观察信号。
`chatCompletion` 会立刻抛错，所以长循环（批量抽取、多维度精读）天然会及时停下。
`llm/` 里区分了「用户取消」和「请求超时」——两者都是 `AbortError`，靠外部 signal
的状态判断，否则用户会看到误导性的「请求超时」。

**3. IPC 载荷按用途裁剪**

`paper:list` 走的是 `LIST_COLUMNS`，不带 `graph` / `phrases` 两个大 JSON 字段——
渲染层没有组件从列表项读它们（图谱走 `graph:snapshot`、句式走 `phrases:list`），
带着只会让每次刷新的载荷白白膨胀好几 MB。主进程内部的消费者用全量版本。

**4. 前端按需加载 + 空闲休眠**

- 六个非首屏视图用 `React.lazy` 拆分；
- `pdfjs-dist`（约 650KB）只在真正解析 PDF 时才动态引入，不进首屏；
  首屏 bundle 因此从 1547KB 降到 **758KB**；
- 图谱画布在布局稳定且无交互时**完全停掉 `requestAnimationFrame`**，
  任何变化（数据 / 高亮 / 选中 / 拖拽 / 缩放）通过 `wakeRef` 唤醒——
  图谱页挂在后台不该一直吃 CPU。

**5. 全文检索走 tokenized LIKE，不用 FTS5**

搜索在主进程，打的是索引里的 `search_blob`——它包含标题 / 作者 / 会议 / 标签 /
分类 / 一句话总结 / 全部笔记正文 / 实验画像 / 原文摘要，所以**能搜到笔记正文**
（这是渲染层旧方案做不到的：它只扫标题、作者、总结、标签）。

为什么不用 FTS5（三条都是实测结论，见 `npm run bench:search`）：

1. **sql.js 的构建没有编译 FTS5** —— `CREATE VIRTUAL TABLE ... USING fts5` 抛
   `no such module: fts5`。FTS4 可用，但对中文同样是按 token 分词。
2. **中文分词问题**：`unicode61` 把连续 CJK 当成一个 token，搜「检索」匹配不到
   「多跳检索评测集」。子串匹配才符合中文用户对「搜索」的直觉。
3. **性能动机不成立**：2000 篇实测，渲染层 JS 过滤 0.5ms，SQL 扫 blob 8~12ms。
   下沉到主进程是为了**覆盖面**，不是为了快。

语义：查询切成 token（CJK 连续段整体保留），每个 token 都要出现（AND），
大小写不敏感。LIKE 的 `%` / `_` / `\` 会被转义，用户输入不会变成通配符。

> 边界：`search_blob` 截断在 12000 字符（真实的 AI 生成笔记约 5~12KB，够用）。
> 上限放大到 40KB 会让索引体积和单次扫描时间都翻数倍，实测收益不划算。

**6. 敏感信息静态加密**

API Key 用 Electron 的 `safeStorage`（macOS Keychain / Windows DPAPI /
Linux libsecret）加密后再写进 `settings.json`，内存里才是明文。
系统钥匙串不可用时（部分 Linux 桌面没装 keyring）退回明文，不会把用户挡在门外。
换机器导致解密失败时会在设置页显示为空，重新填一次即可。

**7. 重新扫描按 mtime / size 跳过未变动的文件**

打开知识库时的 `rescanVault` 不再无条件重解析每个 Markdown。索引里为每篇论文
记了 `file_mtime` / `file_size`，三者（路径 + mtime + size）都没变就直接复用
已有记录——不重新解析、不重算 `search_blob`、不重写索引行。

两个必须一起处理的例外，否则会读到过期数据：

- **自定义分类改了**：分类名也进 `search_blob`，所以已索引的论文必须全部重算。
  用 `meta` 表记一个「分类签名」，签名变了就整体退回全量扫描。
- **落盘时机**：`writePaperFile` 写完之后顺手把新指纹记进索引，紧接着的扫描才不会
  白跑一遍。

**8. 写入与聚合的开销**

- **索引落盘走防抖**：保存笔记只写 Markdown（唯一事实来源），索引由 `markDirty()`
  的 400ms 防抖合并落盘。以前每次保存都要把整个 sqlite 重新序列化写一遍，
  批量补齐画像时尤其亏。退出前 `closeDatabase` 会兜底 flush。
- **启动不再无谓落盘**：`openDatabase` 只在「新建库 / 索引损坏 / 迁移真的改了 schema /
  迁移过程中写过数据」时才写文件。
- **句式库聚合有缓存**：拼一次句式库要读遍全部论文的 Markdown，现在按
  `内容指纹`（`COUNT(*) + SUM(LENGTH(search_blob)) + SUM(LENGTH(phrases)) + MAX(updated_at)`）
  缓存，指纹没变直接复用。
- **统计查询不碰大字段**：`computeStats` 只 SELECT 需要的标量列，不再把
  `graph` / `phrases` 两个大 JSON 捞出来逐行 `JSON.parse`。

**9. 图谱筛选去掉 O(V×E)**

`graphSnapshot` 里判断「某个论文节点要不要画」时，以前对每个节点都扫一遍全部边。
现在先一次性算出「至少涉及一个保留实体」的论文集合再遍历节点，多跳检索
（每次选中节点都会重算一次快照）也跟着受益。

## Markdown 往返：保存不能毁数据

「Markdown 是唯一真相源」有个前提：**写回时不能弄丢任何东西**。
但正文是 `renderPaperBody` 从「章节字典」重新生成的，所以任何不在字典里的内容
都必须显式搬过去 —— 否则一次普通保存就把它抹了，而「保存」的触发点包括**批量改属性**。

现在有两个这样的东西，都有回归测试（`smoke:ipc` 第 14 节）：

| 内容 | 怎么丢的 | 现在怎么保 |
| --- | --- | --- |
| 正文第一个 `## ` **之前**的手写内容（`# 大标题`、一段导语、一行「和谁讨论过」） | `parsePaperBody` 按设计只认 `## ` 分节，前言被丢弃，重建时自然没了 | `paperPreamble()` 把它取出来，`writePaperFile` 写回时原样拼回最前面；详情页导出 Markdown 也会带上 |
| 被用户**手动改过名**的文件 | `writePaperFile` 一律写 `${id}.md`，改名后一保存就新造一份：同一个 id 出现两份笔记，谁覆盖谁取决于文件系统遍历顺序 | 写回前先认索引里记的 `relPath`（并核对 frontmatter 里的 `id` 确实是这一篇），认不到才回落到 `${id}.md` |

顺带把读路径也统一过了 `resolveInside` —— 原先 `readPaperSections` 直接用
`join(vaultPath, relPath)`，而 `resolveInside` 才是本项目处理「拿路径去读写磁盘」的统一关卡
（绝对路径与 `../` 都会被拒）。删除 / 预览 / reveal / 综述保存早就是这么做的，现在读论文也一致了。

> 前言只保证**不丢**，应用界面里不显示它（详情页是按章节组织的编辑器，前言不属于任何章节）。
> 想看或想改，直接用 Obsidian 或任意编辑器打开那份 Markdown。

**已经踩过坑的库怎么办**：如果之前已经因为改名产生了重复文件（`papers/` 下同时存在
`abc.md` 和改名后的那份），修好之后应用会稳定使用索引里记的那一份，但那份孤儿文件仍在磁盘上，
下次扫描还会把它读进来。程序**不会**替用户删文件 —— 请自己对比后删掉不需要的那份。

## 应用安全

除了上面第 6 点的密钥加密，渲染进程这一侧也按 Electron 的推荐做法收紧：

| 措施 | 位置 | 说明 |
| --- | --- | --- |
| `sandbox: true` | `src/main/index.ts` | preload 只用到 `ipcRenderer` / `contextBridge` / `webUtils` / `process.platform`，沙箱下都可用（构建产物是 CJS、唯一 `require` 就是 `electron`） |
| `will-navigate` 拦截 | `src/main/index.ts` | 只处理 `window.open` 不够——`<a href>` 或 `location` 赋值同样能把窗口导航到外部站点 |
| CSP | `src/renderer/index.html` | 掐掉一切远程来源；`default-src` 刻意保留 `'self' file:` 作为兜底，漏写某条指令也不会白屏 |
| 路径越界校验 | `vault.resolveInside` | frontmatter 里的 `pdf` / `relPath` 可被手改，凡是拿它读写磁盘的地方都先过这一关（删除、预览、reveal、综述保存） |
| 文件授权表 | `src/main/file-grants.ts` | 见下 |

### 外部文件授权（capability 模型）

`file:readBinary` 与 `paper:importPdf` 都接收渲染层传来的**任意路径**。原先只校验扩展名，
等于「磁盘上任意 `.pdf` 都能被读出来，甚至整个复制进知识库再读回」——渲染层一旦被注入，
这就是一条越权读取的通道。

现在主进程自己记一份授权表，只放行**用户亲手选过或拖过**的绝对路径：

| 授权来源 | 触发方式 |
| --- | --- |
| `paper:pickPdfs` | 系统文件选择框返回的路径自动入表 |
| `file:grant` | preload 在真实 `drop` 事件里把落下的路径报上来 |

两个细节：

- `file:grant` **不暴露给渲染层**（`contextBridge` 里没有它），否则渲染层被注入后可以自己
  「授权」任意路径，这道门就白设了。
- 校验放在 `vault.copyPdfIntoVault` —— 那是「外部文件 → 知识库」的唯一通道，
  将来多一个调用者也不会漏掉。
- 错误信息只带文件名不带目录：它会被回显到渲染层、也可能进日志，完整路径本身就是隐私。

顺带删掉了 `file:size` 频道：preload 与渲染层都没有引用它，是个纯粹的死接口
（还带着一次无校验的 `readFileSync`）。`smoke:ipc` 的频道完整性断言会防止它被悄悄加回来。

## 应用图标

图标是**用代码画的**，不是美术资源文件：`scripts/make-icon.ts` 在 1024 画布上
用有符号距离场描述形状（超椭圆背景 / 圆角纸张 / 折角 / 知识图谱节点与连线），
按 4 倍超采样渲染后盒式降采样到各目标尺寸，再用自带的 PNG 编码器写盘。

这么做的理由：

- 生成式图片带平台水印，裁掉会破坏构图；缩放后边缘会糊，16px 细节全丢；
- 颜色必须精确对齐品牌色（`#4338CA → #6366F1` 配 `#2DD4BF` 点缀）；
- 想调构图就是改几个常量重跑，不用重新找素材。

一次生成三种产物（纯 Node + zlib，**不依赖任何库，也不依赖 macOS 工具**，
只有 icns 需要系统自带的 `iconutil`）：

| 文件 | 用途 |
| --- | --- |
| `build/icon.png` | 1024×1024，Linux 及 electron-builder 的通用回退 |
| `build/icon.icns` | macOS 应用包图标 |
| `build/icon.ico` | Windows 安装包与任务栏（内置 16/32/48/64/128/256） |

`npm run dist:mac` / `dist:win` 会先自动跑 `icon:build`，所以 `build/` 里的图标产物
被 gitignore 也没关系——随时可以从脚本重建。注意 `build/` 里还有一个**必须提交**的文件
（签名用的 entitlements），所以 `.gitignore` 写的是 `build/*` + `!build/entitlements.mac.plist`，
而不是直接写 `build`（父目录被排除后，`!` 否定规则是无效的）。

要改构图，编辑 `scripts/make-icon.ts` 顶部的 `BG` / `DOC` / `NODES` / 颜色常量。
调试时可以用探针直接查某个坐标最终合成成什么颜色：

```bash
npm run icon:build -- --probe
```

## 打包与签名（macOS）

`npm run dist:mac` 产出 `release/PaperVault-<版本>-<架构>.dmg`。

### 权限：显式 entitlements

`build/entitlements.mac.plist` 是**源码**（不是产物），只申请三条：

| entitlement | 为什么必须 |
| --- | --- |
| `com.apple.security.cs.allow-jit` | V8 需要 JIT；主进程 / 渲染进程 / helper 都跑在 V8 上 |
| `com.apple.security.cs.allow-unsigned-executable-memory` | V8 会分配「可写且可执行」的内存页 |
| `com.apple.security.cs.allow-dyld-environment-variables` | Electron 靠 `DYLD_*` 给 helper 传库路径 |

app 本体与 helper 共用同一份文件（`entitlements` 与 `entitlementsInherit` 都指向它）——
三者需要的权限完全一致，拆成两份只会漂移。

**这份文件替换掉了 `@electron/osx-sign` 的默认值**（`entitlements/default.darwin.plist`）。
那套默认值是按 App Sandbox 应用写的：`device.camera` / `device.audio-input` /
`device.bluetooth` / `device.usb` / `device.print` / `personal-information.location`。
本应用不上沙箱，这些 `device.*` 权限不产生任何实际授权，只是审计时的噪音；
而它们又**漏掉了** Electron 真正需要的 `allow-unsigned-executable-memory` 与
`allow-dyld-environment-variables`。所以这里显式写一份最小且正确的集合。

**刻意不加**的两条（理由写在 plist 的注释里）：

- `com.apple.security.app-sandbox` —— 知识库目录由用户在任意位置自选，还支持外部编辑器
  直接改 Markdown。上沙箱要先改造成 security-scoped bookmark，是另一个量级的改动。
- `com.apple.security.cs.disable-library-validation` —— 只有加载「非本团队签名」的原生模块
  才需要。本项目唯一非 JS 依赖 sql.js 是 WASM（当数据读进来，不是可执行代码），不触发库校验。

### 公证（notarization）

`package.json` 里设了 `mac.notarize: true`：**没有凭据时只打印一行
`skipped macOS notarization` 然后照常出包**，所以本地没证书也能跑 `dist:mac`。
要真正公证，先装好 Developer ID Application 证书，再提供其中一组环境变量：

| 方式 | 环境变量 | 走哪个工具 |
| --- | --- | --- |
| API Key（官方推荐） | `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` | notarytool |
| 钥匙串配置 | `APPLE_KEYCHAIN_PROFILE`（可选 `APPLE_KEYCHAIN`） | notarytool |
| Apple ID | `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` | legacy（altool，Apple 已不推荐） |

钥匙串配置最省事，凭据只存本机钥匙串、不进任何配置文件：

```bash
xcrun notarytool store-credentials "papervault-notary" \
  --apple-id you@example.com --team-id XXXXXXXXXX --password <app-specific-password>
export APPLE_KEYCHAIN_PROFILE=papervault-notary
npm run dist:mac
```

不用设 `gatekeeperAssess`：它的默认值本来就是 `false`，而且这个版本的
electron-builder 已经没有代码读它了（只留在 JSON schema 里），网上很多教程里那行是过期的。

### 两个提醒

- **默认只出宿主架构**。`target: ["dmg"]` 没指定 `arch`，只会打当前机器那一种。
  要同时出 Intel 与 Apple Silicon，用 `--x64 --arm64`，或改成
  `"target": [{ "target": "dmg", "arch": ["x64", "arm64"] }]`。
- **换签名身份后可能弹钥匙串授权框**。设置里的 API Key 密文由系统钥匙串派生，而钥匙串
  条目的访问控制绑在应用签名上。真遇到提示，让用户重新填一次 API Key 即可。

> 签名 + 公证这条链路**在本环境无法验证**（没有证书，也起不了 GUI）。
> 上面这些是从 electron-builder 24.13.3 的实际源码里读出来的结论，不是照抄文档。
> 如果签完名启动即崩，第一件事是把 `default.darwin.plist` 里的某条加回来试。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `⌘K` | 聚焦论文搜索 |
| `⌘I` | 导入 PDF |
| `⌘N` | 新建论文条目 |
| `⌘1` ~ `⌘4` | 切换顶级导航（论文库 / 写作思路 / 实验对比 / 沉淀） |
| `⌘,` | 设置（设置不占导航位，在侧栏顶部齿轮） |
| `↑` / `↓` | 在论文列表里上下移动（自动滚进视口） |
| `Home` / `End` | 跳到列表首 / 尾 |
| `Esc` | 逐层退出：清空多选 → 退出搜索框 → 取消选中 |
| `⌘A` | 全选当前可见列表（焦点在输入框里时仍然是「全选文本」，不抢） |
| `⌘` / `Ctrl` + 点击 | 把某篇加入 / 移出多选 |
| `Shift` + 点击 | 从锚点连选到目标（锚点不随连选移动，和文件管理器一致） |

勾选一批论文后，底部操作条有 **加入专题**：挑一个已有的，或顺手新建。之后在侧栏点这个专题，右侧就是这组论文的分析面板。

列表导航只在焦点位于「列表内 / 搜索框 / 空白处」时接管方向键 —— 在详情页用方向键滚正文、
或在别的输入框里移动光标都不会被抢。带修饰键的方向键一律放行；任何弹窗打开时列表都不接管键盘，
Esc 交给弹窗自己处理。

应用菜单是自己建的（`src/main/menu.ts`，默认菜单是英文的，而且会把 ⌘A 抢给「全选」）。
编辑菜单里**刻意没有「全选」这一项**：Electron 的 role 自带默认加速键，
`selectAll` 的默认值就是 ⌘A，写 `accelerator: null` 也压不住 —— 只能不放它。
输入框里的 ⌘A 由 Blink 自己的编辑键位处理，不受影响。`npm run smoke:menu` 钉住这条。

### 多选与批量操作

鼠标划过卡片左侧会出现复选框（未选中时用 `opacity` 隐藏而不是 `display:none`，
避免划过时整行文字被挤位移）。点复选框进选择集，点卡片主体仍然是「打开读」——
「选好一批，再逐篇看一眼才决定要不要执行」是常见路径，不该因为看一眼就把选择清掉。
底部操作条提供 **改属性**（阅读状态 / 分类增删 / 标签增删，只填想改的字段，留空即保持原样）、
**抽实验画像**、**删除**。

批量操作走主进程的串行任务队列，逐篇发进度、可随时取消，且**部分成功即算成功**：
50 篇里有 1 篇的 PDF 被外部删掉，不会把另外 49 篇的结果一起回滚，失败明细写在返回的
`message` 里。删除是唯一不可逆的操作，所以单独走二次确认弹窗。

## 技术选型

- **Electron 33** + **electron-vite** + **React 18** + **TypeScript** + **Tailwind CSS**
- 渲染层用 `pdfjs-dist` 抽取 PDF 文本（含页眉页脚去噪、标题猜测）
- 主进程用 **sql.js（WASM SQLite）** 建索引，**gray-matter** 读写 Markdown
- 状态管理 `zustand`，图标 `lucide-react`，渲染 `react-markdown`

## 运行

```bash
npm install
npm run dev        # 开发模式
npm run build      # 构建到 out/
npm run dist:mac   # 打包 macOS dmg 到 release/
npm run typecheck  # 类型检查（主进程 / 渲染层 / scripts 三份 tsconfig）
npm run verify     # 一次跑完：类型检查 + 构建 + 全部回归测试
npm run icon:build # 用代码生成应用图标（build/icon.png|icns|ico）
```

首次启动会让你选一个空目录作为知识库，例如 `~/Documents/PaperVault`。

### PDF 解析自检

论文 PDF 的排版千奇百怪，章节切分靠的是「字号 + 关键字」的启发式规则。如果某篇论文导进来之后发现
「写作手法 · Experiments」抽得不对、或者 AI 精读漏了实验内容，先跑一下这个体检工具：

```bash
npm run inspect:pdf -- "/path/to/paper.pdf"
npm run inspect:pdf -- "/path/to/paper.pdf" --verbose   # 额外列出所有标题标记
```

它会走和 App 完全相同的代码路径，并打印：

- 是不是扫描版（每页字符数过少就需要 OCR）
- 猜出来的标题与作者对不对
- 每一节的字数分布（能一眼看出 Experiments 有没有被切出来）
- 喂给模型的输入规模与估算 token

`--verbose` 会列出每一个被标记为「标题」的行及其行号，方便定位是漏标了还是误标了。

### AI 链路自检

不启动 Electron 就能验证整条 AI 精读链路（`.env` → PDF → Prompt → 真实调模型 → JSON → 笔记 + 实验画像）：

```bash
npm run smoke:ai -- --ping                     # 验证连通性，并列出账号可用的模型
npm run smoke:ai -- --list-models              # 打印全部可用模型 id
npm run smoke:ai -- --selfcheck                # 只测 JSON 解析器，不花钱
npm run smoke:ai -- "/path/to/paper.pdf" --dry # 只打印将发送的 Prompt，不花钱
npm run smoke:ai -- "/path/to/paper.pdf"       # 真实跑一次完整精读
npm run smoke:ai -- "/path/to/paper.pdf" --profile   # 只跑实验画像抽取（更便宜）
```

**不消耗 API 额度的回归测试**（用真实 sql.js 建临时库，不启动 Electron）：

```bash
npm run smoke:db      # 索引层，重点覆盖「老库升级」这条路径
npm run smoke:graph   # 知识图谱：构图 / 筛选 / 多跳 / 缓存失效
npm run smoke:search  # 全文检索：中文子串匹配 / AND 语义 / 通配符转义
npm run smoke:tasks   # 任务队列：串行 / 取消 / 错误恢复
npm run smoke:ipc     # IPC 全链路：频道注册 / 落盘回读 / 越界防护 / 密钥加密
npm run smoke:menu    # 应用菜单：⌘A 必须留给论文列表（role 自带加速键也算）
```

`smoke:menu` 的存在理由有点特别：菜单加速键的问题**没有 GUI 就完全看不见**。
Electron 的 role 自带默认加速键（`selectAll` → ⌘A），而 `MenuItem` 补默认值时
判据是 `== null`，所以显式写 `accelerator: null` 也压不住 —— 只要编辑菜单里出现
`{ role: 'selectAll' }`，论文列表的「全选可见」就永远收不到 ⌘A。本环境起不了
Electron 窗口，这条只能靠断言钉住。

检索方案的基准测试（回答「要不要换 FTS5」这类问题）：

```bash
npm run bench:search          # 默认 2000 篇
npm run bench:search -- 5000  # 指定篇数
```

一次跑完所有检查：

```bash
npm run verify
```

`smoke:ai` 需要真实 Key 与 PDF，所以不在 `verify` 里；调 Prompt 时单独跑它，比每次开 App 点一遍快得多（`--dry` 和 `--selfcheck` 完全不消耗额度）。
`verify` 里目前是 9 套冒烟测试：db / graph / search / parse / sections / stream / tasks / ipc / menu。

### IPC 层怎么测的

`src/main/` 下的模块都 `import` 了 electron，纯 Node 里根本跑不起来 ——
于是长期只能靠手点 App 验证。`npm run smoke:ipc` 解决了这个问题：

`scripts/stubs/electron.ts` 是一个最小 Electron 替身（只实现 `ipcMain` / `BrowserWindow` /
`dialog` / `shell` / `app` / `safeStorage` 里实际用到的那几个 API），通过 esbuild 的
`--alias:electron=...` 在打包时把真实模块替换掉。测试因此可以：

- 调 `registerIpc()`，断言**每一个频道都注册上了**（重构时漏注册会被直接抓住）
- 用 `invoke('paper:create', ...)` 驱动真实链路，然后去磁盘上读 Markdown 验证落盘结果
- 断言「frontmatter 里的 `pdf: ../outside/x.pdf` 会被拒绝读写，且删除时绝不碰库外文件」
- 断言「未授权的路径既读不到字节、也复制不进知识库；授权后才放行」（文件授权表）
- 断言「未配置 Key 时 AI 任务返回业务错误而不是抛异常，且进度广播到了渲染层」
- 断言「`settings.json` 里存的是密文，明文 Key 不出现」

当前 64 项断言，`npm run verify` 会连带跑它。

替身的状态挂在 `globalThis` 上，所以无论打包器把别名和相对 import 算成一个还是两个模块，
测试看到的都是同一份注册表。

## 数据存放

```
<你的知识库>/
├── papers/            # 每篇论文一个 .md（frontmatter 存书目信息，正文是固定章节）
├── collections/       # 专题：用户手动归到一起的论文组
├── problems/          # 开放问题池：all.md 是全库，其余按专题 id 命名
├── skills/            # 读论文风格.md：精读 agent 的口吻、导读结构与示例
├── ideas/             # 选题本：每个选题一份（假设 / 最小验证实验 / 反证条件 / 状态 / 备注）
├── syntheses/         # 跨论文文档（套路归纳 / 研究想法 / 组合分析）
├── README.md
└── .papervault/
    ├── index.sqlite   # 检索索引（可删，重建即可）
    ├── pdfs/          # 归档的 PDF 副本
    ├── texts/         # 抽取出的原文文本
    └── refs/          # 从原文抽出的参考文献表（可删，重新抽取即可）
```

- Markdown 是**唯一事实来源**，整个目录可以直接 `git init` 管理。
- 删掉 `.papervault/` 后点侧边栏的「重新索引」，会从 Markdown 完整恢复索引。

### 笔记章节结构

```
一句话总结 · 核心问题与动机 · 关键收获 · 故事线拆解
写作手法 · Abstract / Introduction / Related Work / Methodology / Experiments
实验方法论 · 局限与未来工作 · 可迁移到我的研究 · 原文摘录 · 自由笔记
```

章节名固定是有意为之 —— 只有这样，跨论文的聚合归纳才成立。你也可以在「设置 → 自定义章节」里追加自己的维度。

### frontmatter 里的实验画像

除书目信息外，每篇笔记的 frontmatter 还会带一个 `exp` 块，用来支撑「实验对比」表：

```yaml
exp:
  datasets: [HotpotQA, MuSiQue]
  baselines: [DPR, ColBERT, Self-RAG]
  metrics: [EM, F1]
  ablationCount: 4
  runs: 3 个随机种子，报告均值±标准差
  reportsVariance: true
  modelChoice: both
  openModels: [Llama-3-8B]
  closedModels: [GPT-4o]
  compute: 8×A100-80G
  realWorld: false
  # 下面两个是状态位，不是抽出来的内容
  extractedAt: '2026-09-12T05:34:02.097Z'
  # error: 只有上次抽取失败时才会出现，重新抽取成功会自动清掉
```

- 精读时由模型一并抽取；也可以在论文详情页的「实验画像」标签里手动改。
- 只有画像（结构化字段）的论文没有这个键，保持 frontmatter 干净。
- 老论文可以用「实验对比 → 补齐画像」批量补，或者单篇点「AI 重新抽取」。

**面板上的三种「空」是分开的**，别把它们看成同一件事：

| 框里显示 | 含义 |
| --- | --- |
| `原文未说明` | 抽取跑过、也确实没抽到 —— 这是个**结论**，可以直接手动补 |
| `尚未抽取` | 这篇还没跑过抽取 |
| `抽取失败` | 抽取没成功，面板顶部会写明原因并给一个「重试」 |

为此 `extractedAt` **只在真的抽到内容时才写**。曾经它用「返回对象里有没有键」判断，
而落盘的空骨架本身就带 14 个键，于是每篇没抽过的论文都被盖上一个崭新的「最近抽取」——
排查「为什么整页都是原文未说明」时，这个假时间戳把人带偏了很久。

失败原因会落到 `exp.error`（界面上的红色横幅）。不记的话，「系统出错」和
「论文没写实验设置」在数据上完全一样，用户无从判断该不该重试。

另外，`429 / 5xx / 408` 这类瞬时故障会在 `llm/index.ts` 里自动退避重试两次
（`1s`、`3s`）—— 精读是并发 3 路连发十几个请求，撞限流几乎必然，而单个维度失败
被设计成不中断其他维度，不重试的话表现就是「某个维度莫名其妙全空」。

## 配置大模型

支持任意 **OpenAI 兼容**接口。两种配置方式，任选其一。

### 接口协议与适配器

模型调用分两层：`llm/index.ts` 是与厂商无关的**策略层**（退避重试、空内容时翻倍预算、JSON 降级、取消、记账），
各家协议的翻译放在**适配器**里，由 `PAPERVAULT_LLM_PROVIDER` 选（缺省 `openai-compatible`，智谱 / DeepSeek / 通义 / 中转都走它）。

目前只实现了 OpenAI 兼容一种。以后接 Anthropic、Gemini 这类原生接口时：
在 `shared/types.ts` 的 `LLM_PROVIDER_IDS` 加一个 id → 写一个实现 `LlmProvider` 的文件 → 在 `llm/providers.ts` 登记。
适配器要守的约定写在 `llm/types.ts` 的 `LlmProvider` 注释里（错误带 status、取消单独标记、空内容抛约定的提示），
上层的重试与工具循环靠这些约定工作，不用跟着改。

### 方式一：`.env` 文件（推荐，不用手填）

项目根目录已经放好一个 `.env`（已被 `.gitignore` 忽略），把 Key 补上即可：

```ini
PAPERVAULT_LLM_BASE_URL=https://api.zhizengzeng.com/v1
PAPERVAULT_LLM_MODEL=deepseek-v4-flash
PAPERVAULT_LLM_API_KEY=在这里粘贴你的 key
```

保存后重启 App 生效。全部可用变量见 `.env.example`：

| 变量 | 说明 |
| --- | --- |
| `PAPERVAULT_LLM_BASE_URL` | 接口地址，也兼容 `OPENAI_BASE_URL` / `OPENAI_API_BASE` |
| `PAPERVAULT_LLM_API_KEY` | 密钥，也兼容 `OPENAI_API_KEY` |
| `PAPERVAULT_LLM_MODEL` | 模型名，也兼容 `OPENAI_MODEL` |
| `PAPERVAULT_LLM_TEMPERATURE` | 可选，0~1 |
| `PAPERVAULT_LLM_MAX_TOKENS` | 可选 |
| `PAPERVAULT_VAULT_PATH` | 可选，只在首次启动时作为知识库目录的默认值 |

`.env` 查找顺序（靠前优先）：

1. `~/Library/Application Support/papervault/.env` — 打包成 App 之后推荐放这里
2. `<项目根目录>/.env` — 开发时最顺手

**优先级：进程环境变量 > `.env` 文件 > 应用内设置页。** 被 `.env` 接管的字段，在设置页里会显示
「由 .env 提供」并且输入框不可编辑——直接改 `.env` 再重启即可。

### 方式二：应用内设置

「设置 → 大模型服务」里填，内置了常见服务商预设（点一下即填好 Base URL 与模型名）：

- 智增增 zhizengzeng `https://api.zhizengzeng.com/v1` · `deepseek-v4-flash`
- DeepSeek 官方 · OpenAI · Kimi · 通义千问 · 智谱 GLM · 本地 Ollama

这种方式下 Key 存在 `userData/settings.json`。两种方式都只在本机，不会上传到任何地方。
配置好之后点「测试连通」可以立即验证。

## 推荐使用节奏

1. **导入**：读完一篇论文就拖进 PaperVault，让 AI 先把 14 个章节和实验画像填一版。
2. **改写**：AI 填完之后，自己按印象最深的点手改一遍——这一步才是真正的沉淀。
3. **打标**：确认分类与标签，保证同类论文能被正确聚合。集中看过的那几篇可以再放进一个**专题**，之后指定 agent 专门分析这一组。
4. **对比**：同类论文到 3 篇以上，去「实验对比」看一眼——你会立刻看到这类论文的平均实验规模、方差报告习惯、开源闭源偏好。**这一步直接回答「我该跑几次、该选什么模型」**。
5. **归纳**：在「写作思路 → 套路库」里把逻辑相似的几篇自动聚成一套打法，一键生成手册；顺手去「写作思路 → 句式库」把反复出现的句式抄进自己的写作模板。
6. **回看**：写自己论文时打开对应分类的归纳文档，直接对着检查清单写。

## 目录结构（源码）

```
src/
├── main/          # 主进程
│   ├── index.ts          # 应用入口：窗口、菜单、导航与 CSP 加固
│   ├── ipc.ts            # IPC 注册表：频道名 → service 实现（不写业务逻辑）
│   ├── runtime.ts        # 跨模块共享：进度广播、任务包装、知识库上下文、投喂预算
│   ├── file-grants.ts    # 外部文件授权表（只有用户选过 / 拖过的 PDF 能读能导入）
│   ├── vault-service.ts  # 打开知识库、状态、重新扫描（含「文件没变就跳过」）
│   ├── paper-service.ts  # 论文读写：sectionsOf / persistPaper / 增删改
│   ├── collection-service.ts # 专题：手动分组，Markdown 是唯一真相源
│   ├── problem-service.ts    # 开放问题池：收集各篇局限 → 聚类 → 写 problems/*.md
│   ├── idea-service.ts       # 选题本：从一个开放问题生成选题，跟进状态与备注
│   ├── reference-service.ts  # 参考文献对照：抽取、与库内论文匹配、加入待读
│   ├── pdf-window.ts     # PDF 预览窗口 + 路径越界校验
│   ├── import-service.ts # PDF 导入（依赖 paper + ai，保持单向依赖）
│   ├── ai-service.ts     # 精读 / 重写 / 划词 / 问答 / 套路归纳
│   ├── chat-tools.ts     # 问答 agent 能调用的只读工具（搜库 / 读笔记 / 翻原文 / 问题池 / 选题本）
│   ├── vault.ts          # Markdown 与目录结构的底层读写
│   ├── db.ts             # SQLite 索引（可丢弃的派生数据）
│   ├── graph.ts          # 知识图谱
│   ├── lenses/           # 分析维度定义与流水线
│   ├── llm/              # 模型调用：index.ts 策略层（重试 / 预算翻倍 / 取消 / 记账）+ 各协议适配器（openai.ts）
│   ├── papertext.ts      # PDF 文本清洗与切分
│   ├── arxiv.ts          # arXiv 元数据
│   ├── settings.ts       # 设置持久化（API Key 走 safeStorage）
│   └── tasks.ts          # 串行可取消任务队列
├── preload/       # contextBridge 安全桥
├── shared/        # 类型、分类体系、笔记模板、实验画像、句式抽取、Prompt（两端共用）
└── renderer/src/  # React 界面：components / views / store / lib
```

**主进程的依赖方向是单向的**：`runtime` → `vault / paper / pdf` → `ai` → `import`。
`runtime.ts` 只依赖 `db / settings / tasks / vault / llm`，不依赖任何 service ——
否则 service 之间会绕回来形成循环 import。

另有一条容易踩的规矩：**任务队列只在 `ipc.ts` 的注册处套一层**（`queuedTask`，
住在 `runtime.ts` 里；名字不叫 `aiTask` 是因为批量改属性 / 批量删除也走它）。
批量流程里 service 会互相调用（`importPdf → runSummarize`），若在 service 内部
再套一层队列就会自我死锁 —— 队列是串行的，等自己永远等不到。

## 工程约定

### 一条命令跑全部检查

```bash
npm run verify
```

= `typecheck`（三个 tsconfig：主进程 / 渲染层 / scripts）+ `build` + 8 个 smoke 套件。
`smoke:ai` 需要真实 API Key 与 PDF，不在里面（见上文「AI 链路自检」）。

### 依赖变动后必须同步 lockfile

`npm ci` 会先校验 `package.json` 与 `package-lock.json` 是否一致，不一致就直接报错退出。
注意它**是在删 `node_modules` 之前退出**的（源码里 `validateLockfile()` 排在清理之前），
所以校验失败不会把本地环境搞坏。改了依赖之后跑：

```bash
npm install --package-lock-only
```

不需要装任何东西，只重写 lockfile。另外 **`engines` 字段也会进 lockfile 的根条目** ——
所以往 `package.json` 加 `engines` 同样要跑一次上面那条命令，别只改一边。

想在不碰 `node_modules` 的前提下确认是否同步：

```bash
npm ci --dry-run
```

（`--dry-run` 会在校验之后跳过清理那一步，所以这条命令是安全的。）

### 待办：ESLint / Prettier

还没接入。仓库根目录已有 `.prettierrc.json`（无分号、单引号、行宽 100），
手动跑 `npx prettier --write <文件>` 会按现有风格格式化；但还没有全量格式化过，
对老文件整份跑会带出不少无关的换行改动。注意本机 `node_modules` 里目前**存在** eslint 相关包（某次安装被宿主
broker 打断后留下的残留），但 `package.json` 并没有声明它们 —— 也就是说 `npm ci`
会把它们清掉，不能依赖。要正式接入：

1. `npm i -D eslint @eslint/js typescript-eslint eslint-plugin-react-hooks prettier`
2. 加 `"lint": "eslint . && prettier --check ."`，并把 `npm run lint` 加进 `verify` 链
3. 删掉 `.github/workflows/verify.yml` 里那段「刻意只跑 verify」的说明注释
