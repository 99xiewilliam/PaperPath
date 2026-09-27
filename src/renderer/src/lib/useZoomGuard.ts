import { useEffect } from 'react'

/**
 * 拦住 Chromium 的**页面级**缩放。
 *
 * 为什么需要它：主进程把 visual zoom 开到了 (1,3)（不打开的话，触控板捏合会在
 * Chromium 那层被直接丢掉，渲染层连事件都收不到 —— 见 src/main/index.ts）。
 * 代价是 Chromium 恢复了它的默认语义：⌘/Ctrl + 滚轮、以及触控板捏合，会去缩放
 * **整个界面**（工具栏、侧栏一起变大变小）。
 *
 * 那不是这个应用要的：库里的论文不是网页，用户想放大的是 PDF 正文，不是外壳。
 * 所以在捕获阶段统一把这类事件的默认行为掐掉 —— `preventDefault` 只取消
 * Chromium 的默认缩放，不干扰其它监听器，PDF 面板里那个把它们翻译成内容缩放的
 * 监听器照常收到事件（见 PdfReader 的捏合处理）。
 *
 * 用 capture 是为了抢在别人前面：修饰键 + 滚轮在别处也可能被监听，而「要不要
 * 缩放整个界面」这个决定不该被某个业务组件的 preventDefault 顺序影响。
 */
export function useZoomGuard(): void {
  useEffect(() => {
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey) event.preventDefault()
    }
    /*
     * passive: false 不能省 —— 按规范把 wheel 注册成 passive 时 preventDefault
     * 会被忽略（React 的 onWheel 就是这么注册的，所以这里用原生监听）。
     */
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => window.removeEventListener('wheel', onWheel, { capture: true })
  }, [])
}
