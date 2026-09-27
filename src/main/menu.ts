/**
 * 应用菜单。
 *
 * ## 为什么必须自己建一份，不能靠 Electron 的默认菜单
 *
 * 默认菜单里「编辑 → 全选」绑着 `CmdOrCtrl+A`，而 ⌘A 在论文库里是
 * 「全选当前可见论文」。两者会**同时**触发，表现是每按一次 ⌘A，
 * 整页正文也被选中一遍（满屏蓝色高亮），列表还顺便全选了。
 *
 * 为什么不能在渲染层用 `preventDefault()` 把它拦掉：菜单加速键在
 * `before-input-event` 阶段就被匹配了，而这个事件**先于**页面的
 * `keydown` 派发（Electron 文档原话：`before-input-event` "Emitted before
 * dispatching the keydown and keyup events in the page"）。要在那个阶段
 * 抑制加速键，得用 `webContents.setIgnoreMenuShortcuts()` —— 渲染层里
 * 再怎么 preventDefault 都晚了一步。
 *
 * ## 修法：编辑菜单里**不放**「全选」
 *
 * 注意不能靠「写个 role 但不给 accelerator」来腾出 ⌘A —— **Electron 的 role
 * 自带默认加速键**。`menu-item-roles.ts` 里 `selectall` 的定义就是
 * `{ label: 'Select All', accelerator: 'CommandOrControl+A', webContentsMethod: wc => wc.selectAll() }`，
 * 而 `MenuItem` 构造时会执行
 * `overrideReadOnlyProperty('accelerator', roles.getDefaultAccelerator(this.role))`，
 * `overrideProperty` 的判据是 `== null` —— 所以**显式传 `accelerator: null`
 * 也压不住它**（null 会被当成「没填」，默认值照样补上）。唯一干净的办法
 * 就是别放这一项。
 *
 * 去掉它会损失什么？几乎没有：
 * - 输入框 / 文本域里的 ⌘A 由 Blink 自己的编辑键位处理（`editor_key_bindings.cc`
 *   里的 `{"SelectAll", VKEY_A, kMetaKey}`），跟菜单项无关，照常可用；
 * - 只有「选中整页正文」这一个动作没了 —— 而在这个应用里 ⌘A 本来就该是
 *   「全选论文」，两个语义抢一个键时保留应用语义；
 * - 撤销 / 复制 / 粘贴 / 缩放 / 全屏这些仍然从 role 拿到默认加速键，一个没少。
 *
 * 顺带解决了另一个不一致：默认菜单是英文的，而这个应用全中文。
 *
 * ## 其余各项一律用 `role`，不自己写 click
 *
 * macOS 的撤销 / 重做 / 复制粘贴 / 全屏走的是系统标准实现（响应链）。
 * 自己写 handler 会漏掉一堆边界（比如输入法组字中、密码框、富文本），
 * role 由 Electron 映射到系统行为，省心且不会错。
 */
import { app, Menu, type MenuItemConstructorOptions } from 'electron'

const isMac = process.platform === 'darwin'

export function installApplicationMenu(): void {
  const name = app.name

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: name,
          submenu: [
            { role: 'about', label: `关于 ${name}` },
            { type: 'separator' },
            { role: 'services', label: '服务' },
            { type: 'separator' },
            { role: 'hide', label: `隐藏 ${name}` },
            { role: 'hideOthers', label: '隐藏其他' },
            { role: 'unhide', label: '全部显示' },
            { type: 'separator' },
            { role: 'quit', label: `退出 ${name}` }
          ]
        }
      ]
    : []

  const editMenu: MenuItemConstructorOptions = {
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      ...(isMac
        ? ([
            { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' }
          ] as MenuItemConstructorOptions[])
        : []),
      { role: 'delete', label: '删除' }
      /*
       * 这里**故意没有** `{ role: 'selectAll' }`：它的默认加速键是 ⌘A，
       * 会和论文列表的「全选可见」抢键。原因与替代方案见文件头注释。
       */
    ]
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: '视图',
    submenu: [
      { role: 'reload', label: '重新加载' },
      { role: 'forceReload', label: '强制重新加载' },
      { role: 'toggleDevTools', label: '开发者工具' },
      { type: 'separator' },
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '全屏' }
    ]
  }

  const windowMenu: MenuItemConstructorOptions = {
    label: '窗口',
    submenu: isMac
      ? [
          { role: 'minimize', label: '最小化' },
          { role: 'zoom', label: '缩放' },
          { type: 'separator' },
          { role: 'front', label: '前置全部窗口' }
        ]
      : [
          { role: 'minimize', label: '最小化' },
          { role: 'close', label: '关闭' }
        ]
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate([...appMenu, editMenu, viewMenu, windowMenu]))
}
