import { useEffect } from 'react'
import { useAppStore, VIEW_ORDER } from '@/store/useAppStore'
import { useUiStore } from '@/store/useUiStore'

/**
 * 全局快捷键：
 *   ⌘K     聚焦搜索
 *   ⌘I     导入 PDF
 *   ⌘N     新建条目
 *   ⌘1~6   切换左侧导航
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
