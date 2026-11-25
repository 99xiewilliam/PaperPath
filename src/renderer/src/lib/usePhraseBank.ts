import { useCallback, useEffect, useMemo, useState } from 'react'
import { phraseBankGroups, type PhraseEntry } from '@shared/phrases'
import { errorMessage } from '@/lib/utils'
import { useAppStore } from '@/store/useAppStore'

/**
 * 句式库的数据加载。
 *
 * 为什么做成 hook 而不是留在页面里：句式库现在是「写作思路」的第三个分区，
 * 分区切换会反复挂载 / 卸载面板，把加载逻辑绑在页面上会让每次切回来都重新
 * 拉一遍。hook 由外层页面持有，面板只负责展示。
 *
 * @param enabled 只有真正切到句式分区才拉数据 —— 写作思路默认停在单篇，
 *                不该为了一个没打开的 tab 白扫一遍全库笔记。
 */
export function usePhraseBank(enabled: boolean): {
  entries: PhraseEntry[]
  groups: [string, number][]
  loading: boolean
  reload: () => Promise<void>
} {
  const papers = useAppStore((s) => s.papers)
  const [entries, setEntries] = useState<PhraseEntry[]>([])
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setEntries(await window.papervault.phrases.list())
    } catch (err) {
      /*
       * 必须提示。静默失败会渲染成「句式库是空的」，
       * 让人以为库里真的没攒下东西，而不是读取出错。
       */
      useAppStore.getState().toast(`读取句式库失败：${errorMessage(err)}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  /*
   * 依赖篇数：精读完一篇之后句式会变多，而这里不会重新挂载。
   * 以前的独立页面是同样的口径（见 PhraseBankView 的 useEffect）。
   */
  useEffect(() => {
    if (!enabled) return
    void reload()
  }, [enabled, reload, papers.length])

  const groups = useMemo(() => phraseBankGroups(entries), [entries])

  return { entries, groups, loading, reload }
}
