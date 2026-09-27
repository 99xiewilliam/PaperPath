import { lazy, Suspense, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useUiStore } from '@/store/useUiStore'
import { useHotkeys } from '@/lib/useHotkeys'
import { Sidebar } from '@/components/Sidebar'
import { PaperList } from '@/components/PaperList'
import { PaperDetail } from '@/components/PaperDetail'
import { Resizer } from '@/components/Resizer'
import { ImportDialog } from '@/components/ImportDialog'
import { NewPaperDialog } from '@/components/NewPaperDialog'
import { BusyOverlay, Toaster } from '@/components/ui'

/*
 * 非首屏视图按需加载：论文库是启动就用的，其余五个（尤其带着画布和
 * 表格逻辑的图谱 / 对比页）没必要打进首屏 bundle。
 */
const CompareView = lazy(() =>
  import('@/views/CompareView').then((m) => ({ default: m.CompareView }))
)
const PhraseBankView = lazy(() =>
  import('@/views/PhraseBankView').then((m) => ({ default: m.PhraseBankView }))
)
const GraphView = lazy(() => import('@/views/GraphView').then((m) => ({ default: m.GraphView })))
const SynthesisView = lazy(() =>
  import('@/views/SynthesisView').then((m) => ({ default: m.SynthesisView }))
)
const DashboardView = lazy(() =>
  import('@/views/DashboardView').then((m) => ({ default: m.DashboardView }))
)
const SettingsView = lazy(() =>
  import('@/views/SettingsView').then((m) => ({ default: m.SettingsView }))
)
const Onboarding = lazy(() => import('@/views/Onboarding').then((m) => ({ default: m.Onboarding })))

export default function App(): JSX.Element {
  const ready = useAppStore((s) => s.ready)
  const vault = useAppStore((s) => s.vault)
  const view = useAppStore((s) => s.view)
  const init = useAppStore((s) => s.init)
  const openImport = useUiStore((s) => s.openImport)
  // 只有 macOS 隐藏了原生标题栏（见主进程的 titleBarStyle），
  // Windows / Linux 有系统标题栏，不需要额外补拖拽带
  const isMac = window.papervault.app.platform === 'darwin'

  useHotkeys()

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    return window.papervault.app.onFilesDropped((paths) => openImport(paths))
  }, [openImport])

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-ink-mid">
        <Loader2 className="h-4 w-4 animate-spin text-brand-soft" />
        正在启动 PaperVault…
      </div>
    )
  }

  if (!vault.opened) {
    return (
      <>
        <Suspense fallback={<ViewLoading />}>
          <Onboarding />
        </Suspense>
        <Toaster />
        <BusyOverlay />
      </>
    )
  }

  return (
    <div className="flex h-full">
      <Sidebar />
      <Resizer id="sidebar" />

      {/*
       * 主内容区顶部的拖拽带。
       *
       * 窗口是 hiddenInset（原生标题栏被隐藏），拖动完全依赖 CSS 的
       * -webkit-app-region —— 而原来这条拖拽带**只存在于侧边栏顶部那 36px**
       * （见 Sidebar 里的 app-drag），右侧这么大一片主内容区是死的。
       * 人的直觉是抓窗口顶部那片空白，于是表现成「窗口拖不动」。
       *
       * 这里补一条与侧边栏等高的拖拽带，两条连成贯穿整窗的标题栏，
       * 从此窗口顶部任意位置都能拖。
       *
       * 它必须**占真实布局高度**，不能写成绝对定位的浮层：浮层会盖住下面
       * 首屏顶部的搜索框和筛选按钮，把那些控件变成点不动的死区。
       */}
      <div className="flex min-h-0 flex-1 flex-col">
        {isMac ? <div className="app-drag h-9 shrink-0" aria-hidden /> : null}
        <div className="flex min-h-0 flex-1">
          {view === 'library' ? (
            <>
              <PaperList />
              <Resizer id="list" />
              <PaperDetail />
            </>
          ) : (
            <Suspense fallback={<ViewLoading />}>
              {view === 'compare' ? <CompareView /> : null}
              {view === 'phrases' ? <PhraseBankView /> : null}
              {view === 'graph' ? <GraphView /> : null}
              {view === 'synthesis' ? <SynthesisView /> : null}
              {view === 'dashboard' ? <DashboardView /> : null}
              {view === 'settings' ? <SettingsView /> : null}
            </Suspense>
          )}
        </div>
      </div>

      <ImportDialog />
      <NewPaperDialog />
      <Toaster />
      <BusyOverlay />
    </div>
  )
}

function ViewLoading(): JSX.Element {
  return (
    <div className="flex h-full flex-1 items-center justify-center gap-2 text-[12.5px] text-ink-low">
      <Loader2 className="h-4 w-4 animate-spin text-brand-soft" />
      加载中…
    </div>
  )
}
