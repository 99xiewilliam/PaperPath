import { create } from 'zustand'

/*
 * 各固定宽度侧栏的拖拽调宽（见 components/Resizer.tsx）。
 *
 * 宽度是纯 UI 偏好，不进主进程设置（那是「库的内容配置」），存 localStorage
 * 就够了——换一个知识库目录，窗口还是这个窗口，手感应该延续。
 */

/** 每块面板的最小 / 最大 / 默认宽度，单位 px */
export const PANEL_LIMITS = {
  /** 左侧导航栏。上限 320：再宽它的内容（导航 + 分类）就撑不满，右侧留白很难看 */
  sidebar: { min: 200, max: 320, default: 236 },
  /** 论文列表。下限 280 是「标题两行 + 元信息一行」的最小可读宽 */
  list: { min: 280, max: 560, default: 352 }
} as const

export type PanelId = keyof typeof PANEL_LIMITS

type Widths = Record<PanelId, number>

const STORAGE_KEY = 'papervault.panel-widths.v1'

/** 读存量时也过一遍钳制：手改 localStorage 或改了上限都不至于让面板出界 */
function initialWidths(): Widths {
  let saved: Partial<Widths> | null = null
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Widths> | null
  } catch {
    saved = null
  }
  const widths = {} as Widths
  for (const id of Object.keys(PANEL_LIMITS) as PanelId[]) {
    const { min, max, default: fallback } = PANEL_LIMITS[id]
    widths[id] = Math.min(max, Math.max(min, saved?.[id] ?? fallback))
  }
  return widths
}

interface PanelState {
  widths: Widths
  setWidth: (id: PanelId, width: number) => void
}

/*
 * 持久化做 250ms 防抖：拖拽时每次 pointermove 都会 setWidth，
 * 逐次同步写 localStorage 是白费的——只有停下来那次值得写。
 */
let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave(widths: Widths): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(widths))
    } catch {
      // 存不进去（磁盘满 / 隐私模式）就算了，本次会话内仍然生效
    }
  }, 250)
}

export const usePanelStore = create<PanelState>()((set, get) => ({
  widths: initialWidths(),
  setWidth: (id, width) => {
    const { min, max } = PANEL_LIMITS[id]
    const clamped = Math.round(Math.min(max, Math.max(min, width)))
    if (clamped === get().widths[id]) return
    set((state) => {
      const widths = { ...state.widths, [id]: clamped }
      scheduleSave(widths)
      return { widths }
    })
  }
}))
