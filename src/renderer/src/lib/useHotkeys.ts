import { useEffect } from 'react'
import { useAppStore, VIEW_ORDER } from '@/store/useAppStore'
import { useUiStore } from '@/store/useUiStore'

/**
 * 全局快捷键：
 *   ⌘K     聚焦搜索
 *   ⌘I     导入 PDF
 *   ⌘N     新建条目
 *   ⌘1~4   切换顶级导航（句式库 / 图谱 / 跨论文是二级入口，不占快捷键）
 *   ⌘,     设置
 */
export function useHotkeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const withMeta = event.metaKey || event.ctrlKey
      if (!withMeta || event.altKey) return
      const key = event.key.toLowerCase()

      if (key === 'k') {
        event.preventDefault()
        useAppStore.getState().setView('library')
        // 等视图切换渲染完成再聚焦
        setTimeout(() => window.dispatchEvent(new CustomEvent('pv:focus-search')), 80)
        return
      }

      if (key === 'i') {
        event.preventDefault()
        useUiStore.getState().openImport()
        return
      }

      if (key === 'n') {
        event.preventDefault()
        useUiStore.getState().openNewPaper()
        return
      }

      /*
       * 设置从导航里挪走了，快捷键要跟着挪：⌘, 是系统里「偏好设置」的通用约定，
       * 而它原来排在导航第 8 位、⌘8 早就没人按得出来。
       */
      if (key === ',') {
        event.preventDefault()
        useAppStore.getState().setView('settings')
        return
      }

      const index = Number(key)
      if (Number.isInteger(index) && index >= 1 && index <= VIEW_ORDER.length) {
        event.preventDefault()
        useAppStore.getState().setView(VIEW_ORDER[index - 1])
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
