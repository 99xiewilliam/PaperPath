import { FlaskConical, FolderOpen, Layers, PenTool, Sparkles, Wand2 } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { Button } from '@/components/ui'

const FEATURES = [
  {
    icon: PenTool,
    title: '写作手法拆解',
    desc: '每篇论文按 Abstract / Introduction / Related Work / Methodology / Experiments 逐节拆解它的组织方式与可复用句式。'
  },
  {
    icon: FlaskConical,
    title: '实验方法论沉淀',
    desc: '评估指标怎么选、跑几次、报告不报告方差、开源还是闭源模型、算力规模——全部结构化记录下来。'
  },
  {
    icon: Layers,
    title: '细粒度分类',
    desc: 'Benchmark、RAG 方法、具身智能、训练与对齐……21 个内置细分类，还能自己加。'
  },
  {
    icon: Wand2,
    title: '跨论文套路归纳',
    desc: '同类论文攒够以后，一键横向比对，生成「这类论文一般怎么写、怎么做实验」的手册。'
  }
]

export function Onboarding(): JSX.Element {
  const chooseVault = useAppStore((s) => s.chooseVault)
  const isMac = window.papervault.app.platform === 'darwin'

  return (
    <div className="relative flex h-full flex-col overflow-y-auto bg-bg-base">
      {isMac ? <div className="app-drag h-9 shrink-0" /> : null}
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-8 py-10">
        <div className="mb-8">
          {/*
           * 校徽式「紫底象牙字」monogram，和侧栏的品牌标同一枚：
           * 中大紫的面上放象牙衬线斜体花押。首屏从此不是「一个渐变方块
           * App」，而是一枚贴在扉页上的藏书票。
           */}
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-b from-cuhk to-cuhk-deep shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_1px_3px_rgba(0,0,0,0.5)]">
            <span className="font-serif text-[19px] italic leading-none tracking-tight text-ink-high">
              PV
            </span>
          </div>
          <h1 className="font-serif text-[28px] font-semibold leading-snug text-ink-high">
            别再让读过的论文白白溜走
          </h1>
          <p className="mt-3 max-w-xl text-[13.5px] leading-relaxed text-ink-mid">
            PaperVault 是一个本地优先的论文阅读知识库。它不只是存档，而是逼你把每篇论文
            <span className="text-ink-high">「学到了什么」</span>、
            <span className="text-ink-high">「它怎么写」</span>、
            <span className="text-ink-high">「它怎么做实验」</span>
            这三件事写下来，并且在你攒够同类论文之后，自动帮你归纳出这一类论文的通用套路。
          </p>
        </div>

        <div className="mb-8 grid gap-3 sm:grid-cols-2">
          {FEATURES.map((f) => {
            const Icon = f.icon
            return (
              <div key={f.title} className="rounded-xl border border-line bg-bg-raised p-4">
                <div className="mb-2 flex items-center gap-2">
                  <Icon className="h-4 w-4 text-brand-soft" />
                  <span className="text-[12.5px] font-medium text-ink-high">{f.title}</span>
                </div>
                <p className="text-[11.5px] leading-relaxed text-ink-low">{f.desc}</p>
              </div>
            )
          })}
        </div>

        <div className="rounded-xl border border-line bg-bg-raised p-4">
          <div className="flex items-center gap-2 text-[12.5px] text-ink-high">
            <FolderOpen className="h-4 w-4 text-brand-soft" />
            先选一个目录作为知识库
          </div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-low">
            随便新建一个空文件夹即可，例如 <code className="font-mono">~/Documents/PaperVault</code>
            。论文会以 Markdown 存在 <code className="font-mono">papers/</code> 下，附件放在{' '}
            <code className="font-mono">.papervault/</code> 下，整个目录可以直接 Git 管理。
          </p>
          <div className="mt-3.5 flex items-center gap-3">
            <Button
              variant="primary"
              size="md"
              icon={<Sparkles className="h-4 w-4" />}
              onClick={() => void chooseVault()}
            >
              选择知识库目录
            </Button>
            <span className="text-[11px] text-ink-low">
              所有内容只保存在本地，不上传任何服务器
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
