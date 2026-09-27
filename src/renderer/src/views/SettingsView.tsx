import { useEffect, useState } from 'react'
import {
  Check,
  FileCode2,
  FolderOpen,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Zap
} from 'lucide-react'
import { enabledLensIds, LENS_META } from '@shared/lenses'
import { VIEW_LABEL, VIEW_ORDER } from '@/store/useAppStore'
import type { LlmSettings, TaxonomyNode } from '@shared/types'
import { cn, errorMessage } from '@/lib/utils'
import { LLM_PRESETS } from '@/store/defaults'
import { useAppStore } from '@/store/useAppStore'
import { Button, Chip, Field, IconButton } from '@/components/ui'

export function SettingsView(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const vault = useAppStore((s) => s.vault)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const chooseVault = useAppStore((s) => s.chooseVault)
  const rescan = useAppStore((s) => s.rescan)

  const [llm, setLlm] = useState<LlmSettings>(settings.llm)
  const [dirty, setDirty] = useState(false)
  const [testing, setTesting] = useState(false)

  const envFiles = settings.env?.files ?? []
  const envOverridden = settings.env?.overridden ?? []
  const fromEnv = (field: string): boolean => envOverridden.includes(field)
  const ENV_HINT = '由 .env 提供'

  const [newCategory, setNewCategory] = useState({ label: '', group: '自定义', color: '#7A84DD', description: '' })
  const [newSection, setNewSection] = useState('')

  useEffect(() => {
    setLlm(settings.llm)
    setDirty(false)
  }, [settings.llm])

  const update = (patch: Partial<LlmSettings>): void => {
    setLlm((prev) => ({ ...prev, ...patch }))
    setDirty(true)
  }

  const saveLlm = async (): Promise<void> => {
    await patchSettings({ llm })
    setDirty(false)
    useAppStore.getState().toast('模型配置已保存', 'success')
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    try {
      const res = await window.papervault.ai.test(llm)
      useAppStore.getState().toast(`连通成功，模型回复：${res.reply}`, 'success')
    } catch (err) {
      useAppStore.getState().toast(`连接失败：${errorMessage(err)}`, 'error')
    } finally {
      setTesting(false)
    }
  }

  const addCategory = async (): Promise<void> => {
    if (!newCategory.label.trim()) return
    const id = slugId(newCategory.label)
    const node: TaxonomyNode = {
      id,
      label: newCategory.label.trim(),
      group: newCategory.group.trim() || '自定义',
      description: newCategory.description.trim(),
      color: newCategory.color,
      builtin: false
    }
    await patchSettings({ customCategories: [...settings.customCategories, node] })
    setNewCategory({ label: '', group: '自定义', color: '#7A84DD', description: '' })
    useAppStore.getState().toast('已添加分类', 'success')
  }

  const removeCategory = async (id: string): Promise<void> => {
    await patchSettings({
      customCategories: settings.customCategories.filter((c) => c.id !== id)
    })
  }

  const addSection = async (): Promise<void> => {
    const value = newSection.trim()
    if (!value || settings.customSections.includes(value)) return
    await patchSettings({ customSections: [...settings.customSections, value] })
    setNewSection('')
    useAppStore.getState().toast('已添加章节', 'success')
  }

  return (
    <main className="h-full min-w-0 flex-1 overflow-y-auto bg-bg-base px-6 py-5">
      <div className="mx-auto max-w-3xl space-y-5 pb-16">
        <header>
          <h1 className="font-serif text-[18px] font-semibold text-ink-high">设置</h1>
          <p className="mt-1 text-[12px] text-ink-mid">
            所有数据都在本地。API Key 只保存在你自己的机器上。
          </p>
        </header>

        {/* 知识库 */}
        <Section title="知识库" subtitle="论文以 Markdown 形式存放，可以直接用 Git 管理">
          <div className="flex items-center gap-2 rounded-lg border border-line bg-bg-base px-3 py-2.5">
            <FolderOpen className="h-4 w-4 shrink-0 text-ink-low" />
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-mid">
              {vault.path || '（未打开）'}
            </span>
            <Button variant="subtle" onClick={() => void chooseVault()}>
              更换目录
            </Button>
            <Button
              variant="subtle"
              icon={<RefreshCw className="h-3.5 w-3.5" />}
              onClick={() => void rescan()}
            >
              重建索引
            </Button>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-[11.5px] text-ink-low">
            <span>论文 {vault.paperCount} 篇</span>
            <span>归纳文档 {vault.synthesisCount} 篇</span>
            <span>存储形态：Markdown + SQLite 索引</span>
          </div>
          {fromEnv('vaultPath') ? (
            <p className="mt-2 text-[11px] text-ink-low">
              当前目录来自 <code className="font-mono">PAPERVAULT_VAULT_PATH</code>
              （仅在首次启动时生效，选过之后以界面为准）。
            </p>
          ) : null}
        </Section>

        {/* 模型 */}
        <Section
          title="大模型服务"
          subtitle="任意 OpenAI 兼容接口。精读、重写章节、套路归纳都走这里。"
        >
          {envOverridden.length ? (
            <div className="mb-3 rounded-lg border border-accent/30 bg-accent/[0.07] px-3 py-2.5">
              <div className="flex items-center gap-2 text-[11.5px] font-medium text-accent-soft">
                <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                配置来自 .env，优先级高于本页设置
              </div>
              <div className="mt-1.5 space-y-0.5 text-[10.5px] leading-relaxed text-ink-mid">
                {envFiles.map((file) => (
                  <div key={file} className="truncate font-mono" title={file}>
                    {file}
                  </div>
                ))}
                <div className="pt-0.5">
                  被接管的字段：
                  <span className="text-ink-high">{envOverridden.join('、')}</span>
                  （界面上改不了，直接改 .env 后重启）
                </div>
              </div>
            </div>
          ) : (
            <div className="mb-3 rounded-lg border border-line bg-bg-base px-3 py-2.5 text-[11px] leading-relaxed text-ink-low">
              也可以把配置写进 <code className="font-mono text-ink-mid">.env</code>{' '}
              文件，就不用每次在这里填。项目根目录的{' '}
              <code className="font-mono text-ink-mid">.env.example</code> 里有全部可用变量。
            </div>
          )}

          <div className="mb-3 flex flex-wrap gap-1">
            {LLM_PRESETS.map((preset) => (
              <Chip
                key={preset.label}
                onClick={() => {
                  update({
                    ...(fromEnv('llm.baseUrl') ? {} : { baseUrl: preset.baseUrl }),
                    ...(fromEnv('llm.model') ? {} : { model: preset.model })
                  })
                }}
                active={llm.baseUrl === preset.baseUrl}
              >
                {preset.label}
              </Chip>
            ))}
          </div>

          <div className="space-y-3">
            <Field label="Base URL" hint={fromEnv('llm.baseUrl') ? ENV_HINT : undefined}>
              <input
                value={llm.baseUrl}
                disabled={fromEnv('llm.baseUrl')}
                onChange={(e) => update({ baseUrl: e.target.value })}
                placeholder="https://api.deepseek.com/v1"
                className="field font-mono text-[12px] disabled:cursor-not-allowed disabled:opacity-60"
              />
            </Field>
            <Field
              label="API Key"
              hint={fromEnv('llm.apiKey') ? ENV_HINT : '仅存本地配置文件'}
            >
              <input
                type="password"
                value={llm.apiKey}
                disabled={fromEnv('llm.apiKey')}
                onChange={(e) => update({ apiKey: e.target.value })}
                placeholder="sk-…"
                className="field font-mono text-[12px] disabled:cursor-not-allowed disabled:opacity-60"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="模型名" hint={fromEnv('llm.model') ? ENV_HINT : undefined}>
                <input
                  value={llm.model}
                  disabled={fromEnv('llm.model')}
                  onChange={(e) => update({ model: e.target.value })}
                  placeholder="deepseek-chat"
                  className="field font-mono text-[12px] disabled:cursor-not-allowed disabled:opacity-60"
                />
              </Field>
              <Field
                label="最大输出 tokens"
                hint={fromEnv('llm.maxTokens') ? ENV_HINT : '精读建议 ≥ 4096'}
              >
                <input
                  type="number"
                  value={llm.maxTokens}
                  disabled={fromEnv('llm.maxTokens')}
                  onChange={(e) => update({ maxTokens: Number(e.target.value) || 4096 })}
                  className="field disabled:cursor-not-allowed disabled:opacity-60"
                />
              </Field>
            </div>
            <Field label={`温度 ${llm.temperature.toFixed(2)}`} hint="越低越稳定，精读建议 0.2-0.4">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={llm.temperature}
                onChange={(e) => update({ temperature: Number(e.target.value) })}
              />
            </Field>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="primary"
              loading={testing}
              icon={<Zap className="h-3.5 w-3.5" />}
              onClick={() => void test()}
            >
              测试连通
            </Button>
            <Button variant="subtle" disabled={!dirty} onClick={() => void saveLlm()}>
              保存
            </Button>
            {dirty ? <span className="text-[11px] text-warn">有未保存的修改</span> : null}
          </div>
        </Section>

        {/* 偏好 */}
        <Section title="精读偏好" subtitle="导入 PDF 时的默认行为">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={settings.autoSummarizeOnImport}
              onChange={(e) => void patchSettings({ autoSummarizeOnImport: e.target.checked })}
              className="mt-0.5 h-3.5 w-3.5 accent-brand"
            />
            <span>
              <span className="block text-[12.5px] text-ink-high">导入后自动调用 AI 精读</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-low">
                关闭后只做文本抽取与建档，可以之后在笔记页手动点「AI 精读」。
              </span>
            </span>
          </label>
        </Section>

        {/* 分析维度 */}
        <Section
          title="分析维度"
          subtitle="每个维度是一次独立的模型调用，各有专属 prompt —— 不塞进一个大 prompt，效果更稳、也能单独重跑。"
        >
          <div className="space-y-1.5">
            {LENS_META.map((lens) => {
              const enabled = !settings.disabledLenses.includes(lens.id)
              return (
                <button
                  key={lens.id}
                  onClick={() =>
                    void patchSettings({
                      disabledLenses: enabled
                        ? [...settings.disabledLenses, lens.id]
                        : settings.disabledLenses.filter((id) => id !== lens.id)
                    })
                  }
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition',
                    enabled
                      ? 'border-brand/45 bg-brand/[0.07]'
                      : 'border-line hover:border-strong hover:bg-white/[0.03]'
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition',
                      enabled ? 'border-brand bg-brand text-[#EDEAE0]' : 'border-strong'
                    )}
                  >
                    {enabled ? <Check className="h-2.5 w-2.5" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="text-[12.5px] font-medium text-ink-high">{lens.label}</span>
                      <span className="font-mono text-[10px] text-ink-low">{lens.id}</span>
                      <span className="text-[10px] text-ink-low">
                        {lens.sections.length ? `${lens.sections.length} 个章节` : '只产出结构化数据'}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-low">
                      {lens.description}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] text-ink-low">
                    {lens.needsSource ? '需原文' : '可用笔记'}
                  </span>
                </button>
              )
            })}
          </div>
          {enabledLensIds(settings.disabledLenses).length === 0 ? (
            <p className="mt-2 text-[11px] text-warn">
              一个维度都没开，AI 精读会直接报错。至少启用「速览与故事线」。
            </p>
          ) : null}
        </Section>

        {/* 自定义分类 */}
        <Section
          title="自定义分类"
          subtitle="内置分类覆盖 benchmark / RAG / 具身智能等方向，不够用就在这里加"
        >
          <div className="space-y-1.5">
            {settings.customCategories.length === 0 ? (
              <p className="text-[11.5px] text-ink-low">还没有自定义分类。</p>
            ) : (
              settings.customCategories.map((node) => (
                <div
                  key={node.id}
                  className="flex items-center gap-2 rounded-lg border border-line bg-bg-raised px-3 py-2"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: node.color }}
                  />
                  <span className="text-[12px] text-ink-high">{node.label}</span>
                  <span className="text-[10.5px] text-ink-low">{node.id}</span>
                  <IconButton
                    title="删除"
                    className="ml-auto"
                    onClick={() => void removeCategory(node.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </div>
              ))
            )}
          </div>
          <div className="mt-3 grid grid-cols-[1fr_120px_90px_auto] items-end gap-2">
            <Field label="分类名">
              <input
                value={newCategory.label}
                onChange={(e) => setNewCategory({ ...newCategory, label: e.target.value })}
                placeholder="例如：表格理解"
                className="field"
              />
            </Field>
            <Field label="分组">
              <input
                value={newCategory.group}
                onChange={(e) => setNewCategory({ ...newCategory, group: e.target.value })}
                className="field"
              />
            </Field>
            <Field label="颜色">
              <input
                type="color"
                value={newCategory.color}
                onChange={(e) => setNewCategory({ ...newCategory, color: e.target.value })}
                className="h-9 w-full cursor-pointer rounded-lg border border-line bg-bg-base px-1"
              />
            </Field>
            <Button
              variant="subtle"
              icon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => void addCategory()}
              disabled={!newCategory.label.trim()}
            >
              添加
            </Button>
          </div>
        </Section>

        {/* 自定义章节 */}
        <Section title="自定义章节" subtitle="在默认的 14 个章节之后追加你自己的观察维度">
          <div className="flex flex-wrap gap-1">
            {settings.customSections.length === 0 ? (
              <p className="text-[11.5px] text-ink-low">还没有自定义章节。</p>
            ) : (
              settings.customSections.map((s) => (
                <Chip
                  key={s}
                  onClick={() =>
                    void patchSettings({
                      customSections: settings.customSections.filter((x) => x !== s)
                    })
                  }
                  title="点击删除"
                >
                  {s}
                  <Trash2 className="h-2.5 w-2.5" />
                </Chip>
              ))
            )}
          </div>
          <div className="mt-3 flex items-end gap-2">
            <Field label="章节名" className="flex-1">
              <input
                value={newSection}
                onChange={(e) => setNewSection(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addSection()
                }}
                placeholder="例如：相关工作里的对比表格设计"
                className="field"
              />
            </Field>
            <Button
              variant="subtle"
              icon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => void addSection()}
              disabled={!newSection.trim()}
            >
              添加
            </Button>
          </div>
        </Section>

        {/* 快捷键 */}
        <Section title="快捷键" subtitle="已支持 ⌘（macOS）或 Ctrl（Windows / Linux）">
          <div className="grid gap-1.5 sm:grid-cols-2">
            {([
              ['⌘ K', '聚焦论文搜索'],
              ['⌘ I', '导入 PDF'],
              ['⌘ N', '新建论文条目'],
              // 视图快捷键由 VIEW_ORDER 派生，新增视图时这里自动跟着变
              ...VIEW_ORDER.map(
                (key, index) => [`⌘ ${index + 1}`, VIEW_LABEL[key]] as [string, string]
              )
            ] as [string, string][]).map(([key, label]) => (
              <div
                key={key}
                className="flex items-center gap-2.5 rounded-lg border border-line bg-bg-base px-2.5 py-1.5"
              >
                <kbd className="rounded border border-line bg-bg-raised px-1.5 py-0.5 font-mono text-[10.5px] text-ink-mid">
                  {key}
                </kbd>
                <span className="text-[11.5px] text-ink-mid">{label}</span>
              </div>
            ))}
          </div>
        </Section>

        {/* 关于 */}
        <Section title="关于" subtitle="PaperVault 0.1.0">
          <ul className="space-y-1.5 text-[11.5px] leading-relaxed text-ink-mid">
            {[
              '数据完全本地：论文笔记是 Markdown，索引是 SQLite，PDF 保存在 .papervault/pdfs。',
              '笔记正文、实验画像、PDF 高亮都存在 Markdown 里，删掉 .papervault 也能重建。',
              '知识图谱与句式库只存在索引里（数据量大，不适合塞进 frontmatter），删掉索引需要重新抽取。',
              'AI 只会依据抽取到的原文作答，原文没写的信息它会标为「原文未说明」。',
              '实验画像可以手动改，也能用 AI 从实验章节单独重新抽取。',
              '实验对比表的统计全部在本地计算，不会额外调用模型；只有「补齐画像」才会请求模型。',
              '句式库 = 笔记里的可复用表达（纯本地规则抽取，不消耗 token）+ AI 精炼的英语短语。'
            ].map((line) => (
              <li key={line} className="flex gap-2">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-low" />
                {line}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center gap-2 text-[11px] text-ink-low">
            <Check className="h-3.5 w-3.5 text-ok" />
            运行平台：{window.papervault.app.platform}
          </div>
          <div className="mt-3">
            <Button
              variant="ghost"
              icon={<Loader2 className={cn('h-3.5 w-3.5', testing && 'animate-spin')} />}
              onClick={() => void window.papervault.vault.reveal('README.md')}
            >
              在访达中查看知识库文件
            </Button>
          </div>
        </Section>
      </div>
    </main>
  )
}

function Section({
  title,
  subtitle,
  children
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="rounded-xl border border-line bg-bg-raised p-4">
      <div className="mb-3">
        <h2 className="text-[13.5px] font-semibold text-ink-high">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-[11px] text-ink-low">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  )
}

function slugId(label: string): string {
  const ascii = label
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return ascii || `cat-${Math.random().toString(36).slice(2, 6)}`
}
