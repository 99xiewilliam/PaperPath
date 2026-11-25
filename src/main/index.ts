import { app, BrowserWindow, screen, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { closeDatabase, openDatabase } from './db'
import { registerIpc } from './ipc'
import { installApplicationMenu } from './menu'
import { envInfo, getSettings, migrateSettings } from './settings'

const isMac = process.platform === 'darwin'
let mainWindow: BrowserWindow | null = null

/**
 * 开发时渲染层由 Vite dev server 提供，打包后是 file:// 下的 index.html。
 * 用它来判断一次导航「是不是还在应用自己内部」。
 */
function appOrigin(): string {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    try {
      return new URL(devUrl).origin
    } catch {
      /* 非法 URL 就当开发模式没开 */
    }
  }
  return 'file://'
}

function isInternalUrl(url: string): boolean {
  const origin = appOrigin()
  return origin === 'file://' ? url.startsWith('file://') : url.startsWith(origin)
}

/**
 * 图标文件位置。
 * 打包后由 electron-builder 从 build/ 取用；开发时手动加载，
 * 否则 Windows / Linux 的窗口和任务栏会显示默认的 Electron 图标。
 * 文件是 `npm run icon:build` 生成的（见 scripts/make-icon.ts）。
 */
function appIcon(): string | undefined {
  const candidates = [
    join(app.getAppPath(), 'build', 'icon.png'),
    join(process.cwd(), 'build', 'icon.png')
  ]
  return candidates.find((path) => existsSync(path))
}

function createWindow(): void {
  const icon = appIcon()
  /*
   * 窗口尺寸必须收敛到「屏幕可用区域」以内。
   *
   * 1480×950 是按大屏写的默认值，直接用在 1280 宽的屏幕上会开出一个比屏幕还宽的
   * 窗口：macOS 允许这样，多出来的那部分**整个看不见**，而且没有任何滚动条能把它
   * 拉回来。表现是「右侧的面板、卡片显示不出来」，特别容易被误判成布局 bug
   * （实测：PDF 阅读器右边的图库/高亮面板、实验对比页最右一列，都是这么没的）。
   *
   * minWidth 同样要收敛：它大于屏幕宽度时，用户连手动把窗口拖小都做不到。
   */
  const { workAreaSize } = screen.getPrimaryDisplay()
  mainWindow = new BrowserWindow({
    width: Math.min(1480, workAreaSize.width),
    height: Math.min(950, workAreaSize.height),
    minWidth: Math.min(1120, workAreaSize.width),
    minHeight: Math.min(700, workAreaSize.height),
    show: false,
    backgroundColor: '#171217',
    ...(icon ? { icon } : {}),
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 16, y: 20 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // preload 只用到 ipcRenderer / contextBridge / webUtils / process.platform，
      // 这些在沙箱里都可用（下面的 PDF 窗口早就跑在 sandbox: true 下了），
      // 所以没有理由把渲染进程留在沙箱外。
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // 启用 Chromium 内置的 PDF 阅读器。没有它，内嵌预览 PDF 的 iframe
      // 不会渲染，而是触发下载
      plugins: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  /*
   * 打开「视觉缩放」，否则触控板捏合在 Chromium 那一层就被丢掉了。
   *
   * Electron 默认把 visual zoom 关着（等价于限制在 1）：此时 macOS 的捏合手势
   * 既不会缩放页面，**也不会派发 wheel 事件到渲染层** —— 所以「渲染层自己监听
   * 捏合并翻译成 PDF 缩放」这条路是走不通的，监听写得再对也收不到东西。
   * 官方文档原话：Visual zoom is disabled by default in Electron.
   *
   * 开到 (1,3) 之后，捏合才会以「带 ctrlKey 的 wheel 事件」交到页面手里
   * （VS Code 也是靠这个行为做编辑器缩放的）。
   * 而 Chromium 默认的页面级缩放（整个界面跟着一起变大）由渲染层的
   * useZoomGuard 统一拦掉，手势最终只服务于 PDF 内容的缩放。
   */
  mainWindow.webContents.setVisualZoomLevelLimits(1, 3)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // 页面内导航也只允许停在应用自己的页面上，其余一律拦下并交给系统浏览器。
  // 只处理 window.open 是不够的：一个 <a href> 或 location 赋值同样能把窗口
  // 导航到任意外部站点。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function bootstrap(): Promise<void> {
  const env = envInfo()
  if (env.files.length) {
    console.log('[main] 已加载 .env:', env.files.join(', '))
    console.log('[main] 被环境变量接管的配置:', env.overridden.join(', ') || '(无)')
  }

  /*
   * 配置迁移必须在任何 getSettings() 之前：它改的是磁盘上那份 json，
   * 晚于读取的话旧值已经被 readSettingsFile 缓存进内存，整个进程生命周期
   * 都用不到新默认值（表现是「改了默认设置，重启也没生效」）。
   */
  migrateSettings()

  // 开发模式下 macOS 的 Dock 图标来自 Electron 自己，手动换掉才看得到真实效果
  if (isMac && !app.isPackaged) {
    const icon = appIcon()
    if (icon) {
      try {
        app.dock.setIcon(icon)
      } catch (err) {
        console.warn('[main] 设置 Dock 图标失败', err)
      }
    }
  }

  // 若上次退出时留下了知识库路径，自动恢复
  const saved = getSettings().vaultPath
  if (saved) {
    try {
      await openDatabase(saved)
    } catch (err) {
      console.error('[main] 恢复知识库索引失败', err)
    }
  }

  registerIpc()
  /*
   * 必须在建窗口之前装好菜单。默认菜单把 ⌘A 绑给了「全选」，
   * 会和论文列表的「全选可见」抢同一个键（详见 menu.ts 的注释）。
   */
  installApplicationMenu()
  createWindow()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(bootstrap)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })

  app.on('before-quit', () => {
    closeDatabase()
  })
}
