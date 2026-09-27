/**
 * 最小 Electron 替身 —— 只给纯 Node 的 smoke 测试用（通过 esbuild 的
 * `--alias:electron=...` 把真实模块替换掉）。
 *
 * 为什么要它：主进程的 IPC 注册表（`src/main/ipc.ts` 与它背后的 service 模块）
 * 因为「一 import electron 就跑不起来」而完全没有测试覆盖 —— 只能靠手点 App 验证。
 * 把 electron 换成一个记录调用的替身之后，整条 IPC 链路（注册 → 调用 →
 * 落盘 → 回读）都能在冒烟测试里跑起来。
 *
 * 只需要实现 ipc.ts / settings.ts / menu.ts 实际用到的那几个 API。
 *
 * 状态挂在 globalThis 上：这样无论打包器把「别名进来的 electron」和
 * 「测试里相对路径 import 的这个文件」算成一个模块还是两个，测试看到的
 * 都是同一份注册表。
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

export interface SentMessage {
  channel: string
  payload: unknown
}

export class StubBrowserWindow {
  readonly title: string
  readonly loadedUrls: string[] = []
  readonly webContents = {
    send: (channel: string, payload: unknown): void => {
      stubState().sent.push({ channel, payload })
    }
  }

  constructor(options: { title?: string } = {}) {
    this.title = options.title ?? ''
    stubState().windows.push(this)
  }

  loadURL(url: string): void {
    this.loadedUrls.push(url)
  }

  on(): void {
    /* 生命周期事件在测试里不需要 */
  }

  isDestroyed(): boolean {
    return false
  }

  isMinimized(): boolean {
    return false
  }

  restore(): void {}
  focus(): void {}
}

interface StubState {
  handlers: Map<string, IpcHandler>
  sent: SentMessage[]
  windows: StubBrowserWindow[]
  revealed: string[]
  external: string[]
  userDataDir: string
  appDir: string
  menuTemplate: StubMenuTemplate[] | null
}

const globalRef = globalThis as typeof globalThis & { __pvElectronStub?: StubState }

export function stubState(): StubState {
  if (!globalRef.__pvElectronStub) {
    globalRef.__pvElectronStub = {
      handlers: new Map(),
      sent: [],
      windows: [],
      revealed: [],
      external: [],
      // 每次进程一份，保证 settings.json 不会写到真实 userData 里
      userDataDir: mkdtempSync(join(tmpdir(), 'pv-electron-stub-')),
      appDir: mkdtempSync(join(tmpdir(), 'pv-app-stub-')),
      menuTemplate: null
    }
  }
  return globalRef.__pvElectronStub
}

/* ------------------------------------------------------------------ */
/*  ipcMain：把 handler 记下来，测试自己触发                             */
/* ------------------------------------------------------------------ */

export const ipcMain = {
  handle(channel: string, fn: IpcHandler): void {
    stubState().handlers.set(channel, fn)
  },
  on(channel: string, fn: IpcHandler): void {
    // ipcMain.on 在当前代码里已不再使用；留着以免将来加回来时静默失败
    stubState().handlers.set(`on:${channel}`, fn)
  }
}

/* ------------------------------------------------------------------ */
/*  BrowserWindow / dialog / shell                                      */
/* ------------------------------------------------------------------ */

/** 名字对齐真实 API，ipc.ts 里写的是 BrowserWindow.xxx */
export const BrowserWindow = Object.assign(StubBrowserWindow, {
  getAllWindows: (): StubBrowserWindow[] => stubState().windows,
  getFocusedWindow: (): StubBrowserWindow | null => {
    const list = stubState().windows
    return list[list.length - 1] ?? null
  }
})

export const dialog = {
  /** 默认「用户点了取消」；测试可以按需覆盖 */
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
    canceled: true,
    filePaths: []
  })
}

export const shell = {
  showItemInFolder: (path: string): void => {
    stubState().revealed.push(path)
  },
  openExternal: async (url: string): Promise<void> => {
    stubState().external.push(url)
  }
}

/* ------------------------------------------------------------------ */
/*  app / safeStorage                                                   */
/* ------------------------------------------------------------------ */

export const app = {
  name: 'PaperVault',
  getPath: (name: string): string =>
    name === 'userData' ? stubState().userDataDir : tmpdir(),
  getAppPath: (): string => stubState().appDir,
  isPackaged: false
}

/* ------------------------------------------------------------------ */
/*  Menu                                                                */
/* ------------------------------------------------------------------ */

/**
 * 只够 `src/main/menu.ts` 用：`buildFromTemplate` 原样收下模板，
 * `setApplicationMenu` 记下来，测试再回读断言。
 *
 * 之所以值得为它写替身：菜单加速键的问题**没有 GUI 就完全看不见** ——
 * 默认菜单把 ⌘A 绑给「全选」时，渲染层里再 preventDefault 也拦不住
 * （菜单加速键在 `before-input-event` 阶段就匹配了，早于页面的 keydown）。
 * 本环境起不了 Electron 窗口，所以只能靠这条断言把「⌘A 必须留空」钉住。
 */
export interface StubMenuTemplate {
  label?: string
  role?: string
  accelerator?: string
  type?: string
  submenu?: StubMenuTemplate[]
}

export const Menu = {
  buildFromTemplate: (template: StubMenuTemplate[]): { template: StubMenuTemplate[] } => ({
    template
  }),
  setApplicationMenu: (menu: { template: StubMenuTemplate[] } | null): void => {
    stubState().menuTemplate = menu?.template ?? null
  }
}

/** 上次 `setApplicationMenu` 装上的模板；没装过是 null */
export function menuTemplate(): StubMenuTemplate[] | null {
  return stubState().menuTemplate
}

/**
 * 用「可逆的假加密」代替系统钥匙串：测试关心的是「落盘的是密文、读回是明文」
 * 这条契约，而不是具体算法。
 */
export const safeStorage = {
  isEncryptionAvailable: (): boolean => true,
  encryptString: (plain: string): Buffer => Buffer.from(`stub-enc:${plain}`, 'utf-8'),
  decryptString: (buf: Buffer): string => buf.toString('utf-8').replace(/^stub-enc:/, '')
}

/* ------------------------------------------------------------------ */
/*  测试辅助                                                            */
/* ------------------------------------------------------------------ */

/** 按频道调用已注册的 handler；event 用不到，给 null */
export async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = stubState().handlers.get(channel)
  if (!handler) throw new Error(`没有注册这个 IPC 频道：${channel}`)
  return (await handler(null, ...args)) as T
}

export function hasChannel(channel: string): boolean {
  return stubState().handlers.has(channel)
}

export function registeredChannels(): string[] {
  return [...stubState().handlers.keys()]
}

/** 清掉窗口与推送记录，便于分段断言 */
export function resetWindows(): void {
  stubState().windows.length = 0
  stubState().sent.length = 0
  stubState().revealed.length = 0
  stubState().external.length = 0
}
