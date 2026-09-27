import { create } from 'zustand'

interface UiState {
  importOpen: boolean
  /** 拖拽或选择进来的 PDF 绝对路径 */
  importPaths: string[]
  newPaperOpen: boolean
  arxivOpen: boolean
  /** 归纳面板里预选的论文 */
  chatTargets: string[] | null

  openImport: (paths?: string[]) => void
  consumeImportPaths: () => void
  openNewPaper: () => void
  openArxiv: () => void
  setChatTargets: (ids: string[] | null) => void
  close: (key: 'importOpen' | 'newPaperOpen' | 'arxivOpen') => void
}

export const useUiStore = create<UiState>()((set) => ({
  importOpen: false,
  importPaths: [],
  newPaperOpen: false,
  arxivOpen: false,
  chatTargets: null,

  openImport: (paths) =>
    set((state) => ({
      importOpen: true,
      importPaths: paths?.length ? [...new Set([...state.importPaths, ...paths])] : state.importPaths
    })),
  consumeImportPaths: () => set({ importPaths: [] }),
  openNewPaper: () => set({ newPaperOpen: true }),
  openArxiv: () => set({ newPaperOpen: true }),
  setChatTargets: (ids) => set({ chatTargets: ids }),
  close: (key) => set({ [key]: false } as Partial<UiState>)
}))
