import { useEffect, useState } from 'react'
import { FolderOpen, RotateCcw, Save } from 'lucide-react'
import { READING_SKILL_FILE } from '@shared/reading-skill'
import { errorMessage } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'
import { Button, useConfirm } from './ui'

/**
 * 编辑知识库里的 skills/读论文风格.md。
 * 文件本身就是真相源：在别的编辑器里改也一样生效，这里只是不用离开应用。
 */
export function ReadingSkillEditor(): JSX.Element {
  const toast = useAppStore((s) => s.toast)
  const { confirm, dialog } = useConfirm()
  const [saved, setSaved] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.papervault.skill
      .get()
      .then((content) => {
        setSaved(content)
        setDraft(content)
      })
      .catch((err) => toast(`读取读论文风格失败：${errorMessage(err)}`, 'error'))
  }, [toast])

  const dirty = saved !== null && draft !== saved

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const content = await window.papervault.skill.save(draft)
      setSaved(content)
      setDraft(content)
      toast('已保存，下一次 AI 精读按新风格写', 'success')
    } catch (err) {
      toast(`保存失败：${errorMessage(err)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const reset = async (): Promise<void> => {
    const ok = await confirm({
      title: '恢复默认的读论文风格？',
      description: '你对这份文件的修改会被覆盖。',
      confirmLabel: '恢复默认',
      danger: true
    })
    if (!ok) return
    try {
      const content = await window.papervault.skill.reset()
      setSaved(content)
      setDraft(content)
      toast('已恢复默认', 'success')
    } catch (err) {
      toast(`恢复失败：${errorMessage(err)}`, 'error')
    }
  }

  return (
    <div className="space-y-2.5">
      {dialog}
      <p className="text-meta leading-relaxed text-ink-low">
        只认三个二级标题：<b className="text-ink-mid">## 口吻</b>
        会带进所有写文字的分析维度；<b className="text-ink-mid">## 导读结构</b>
        决定「导师精读」怎么组织；<b className="text-ink-mid">## 示例片段</b>
        示范写法（内容不会被照抄）。想让 agent 学一篇你喜欢的讲解，把它节选贴进示例片段就行。
      </p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        rows={18}
        disabled={saved === null}
        className="w-full resize-y rounded-lg border border-line bg-bg-base px-3 py-2.5 font-mono text-meta leading-relaxed text-ink-high outline-none focus:border-brand/50"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          icon={<Save className="h-3.5 w-3.5" />}
          loading={saving}
          disabled={!dirty}
          onClick={() => void save()}
        >
          保存
        </Button>
        <Button
          variant="ghost"
          icon={<RotateCcw className="h-3.5 w-3.5" />}
          onClick={() => void reset()}
        >
          恢复默认
        </Button>
        <Button
          variant="ghost"
          icon={<FolderOpen className="h-3.5 w-3.5" />}
          onClick={() => void window.papervault.vault.reveal(READING_SKILL_FILE)}
        >
          在 Finder 中显示
        </Button>
        {dirty ? <span className="text-caption text-warn">有未保存的修改</span> : null}
      </div>
    </div>
  )
}
