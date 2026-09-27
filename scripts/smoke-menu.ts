/**
 * 应用菜单冒烟测试。
 *
 * ## 为什么这个测试值得单独存在
 *
 * 菜单加速键的问题**没有 GUI 就完全看不见**：默认菜单把 ⌘A 绑给「全选」时，
 * 渲染层里再怎么 `preventDefault()` 都拦不住（菜单加速键在
 * `before-input-event` 阶段就匹配了，早于页面的 keydown），表现是每按一次 ⌘A
 * 整页正文也被选中一遍。这个环境起不了 Electron 窗口（沙箱不允许写
 * SingletonLock），所以「⌘A 必须留空」这条只能靠断言钉住。
 *
 * 另一个容易踩的点：**Electron 的 role 自带默认加速键**
 * （`menu-item-roles.ts` 里 `selectall` → `CommandOrControl+A`），
 * 而 `MenuItem` 用 `overrideProperty('accelerator', getDefaultAccelerator(role))`
 * 补默认值，判据是 `== null` —— 所以显式写 `accelerator: null` 也压不住。
 * 换句话说，只要编辑菜单里出现 `{ role: 'selectAll' }`，⌘A 就没了。
 *
 * 用法：npm run smoke:menu
 */
import { installApplicationMenu } from '../src/main/menu'
import { app, menuTemplate, type StubMenuTemplate } from './stubs/electron'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? `  ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log('')
  console.log(`── ${title} ──────────────────────────`)
}

/** 把模板拍平成一维，便于整体扫描（分隔符丢掉，它没有语义） */
function flatten(items: StubMenuTemplate[]): StubMenuTemplate[] {
  const out: StubMenuTemplate[] = []
  for (const item of items) {
    if (item.type === 'separator') continue
    out.push(item)
    if (item.submenu) out.push(...flatten(item.submenu))
  }
  return out
}

/** 修饰键的规范顺序。用它来拼输出，顺带保证 `Control+Command+F` 与 `Command+Control+F` 等价 */
const MODIFIER_ORDER = ['cmd', 'ctrl', 'alt', 'shift']

/**
 * 加速键归一化：`Cmd` / `Command` / `CmdOrCtrl` / `CommandOrControl` 全部
 * 折成同一个 `cmd` 记号。
 *
 * 这么折是刻意的：应用的键盘处理本来就是 `event.metaKey || event.ctrlKey`
 * 一视同仁（见 useHotkeys.ts），所以「⌘K 和 Ctrl+K 撞车」在它眼里就是同一件事。
 */
function canonical(accelerator: string): string {
  const parts = accelerator
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .map((p) => {
      if (p === 'cmd' || p === 'command' || p === 'cmdorctrl' || p === 'commandorcontrol') {
        return 'cmd'
      }
      if (p === 'ctrl' || p === 'control') return 'ctrl'
      if (p === 'alt' || p === 'option') return 'alt'
      if (p === 'shift') return 'shift'
      return p
    })

  const mods = MODIFIER_ORDER.filter((m) => parts.includes(m))
  const keys = parts.filter((p) => !MODIFIER_ORDER.includes(p))
  return [...mods, ...keys].join('+')
}

/**
 * Electron role → 默认加速键的快照，只列本模板用到的 role。
 * 出处：electron/lib/browser/api/menu-item-roles.ts（roleList）。
 * 键名一律小写 —— 和 Electron 自己的 `RoleId` 联合类型一致，
 * 也因为 `MenuItem` 构造时会把 role 统一转成小写。
 *
 * 为什么要抄一份：模板里「看不见」的加速键才最容易撞车 —— 它们由
 * `MenuItem` 在构造时补进去，肉眼看模板根本发现不了。
 *
 * 这张表按 macOS 取值（`quit` 在 Windows 上是 undefined，
 * `redo` / `toggleDevTools` / `togglefullscreen` / `pasteAndMatchStyle`
 * 也有平台差异）。对「会不会撞上应用自己的快捷键」这个用途来说，
 * 平台差异不影响结论 —— 差异项没有一个是 ⌘K / ⌘I / ⌘N / ⌘1~7。
 */
const ROLE_ACCELERATORS: Record<string, string | undefined> = {
  about: undefined,
  close: 'CommandOrControl+W',
  copy: 'CommandOrControl+C',
  cut: 'CommandOrControl+X',
  delete: undefined,
  forcereload: 'Shift+CmdOrCtrl+R',
  front: undefined,
  hide: 'Command+H',
  hideothers: 'Command+Alt+H',
  minimize: 'CommandOrControl+M',
  paste: 'CommandOrControl+V',
  pasteandmatchstyle: 'Cmd+Option+Shift+V',
  quit: 'CommandOrControl+Q',
  redo: 'Shift+CommandOrControl+Z',
  reload: 'CmdOrCtrl+R',
  resetzoom: 'CommandOrControl+0',
  services: undefined,
  toggledevtools: 'Alt+Command+I',
  togglefullscreen: 'Control+Command+F',
  undo: 'CommandOrControl+Z',
  unhide: undefined,
  zoom: undefined,
  zoomin: 'CommandOrControl+Plus',
  zoomout: 'CommandOrControl+-'
}

/** 应用自己的快捷键（useHotkeys.ts + PaperList.tsx）。菜单一律不许碰这些键 */
const APP_SHORTCUTS = [
  'cmd+k', // 聚焦搜索
  'cmd+i', // 导入 PDF
  'cmd+n', // 新建条目
  'cmd+a', // 全选可见论文
  'cmd+1',
  'cmd+2',
  'cmd+3',
  'cmd+4',
  'cmd+5',
  'cmd+6',
  'cmd+7'
]

/** 菜单项实际生效的加速键：模板里写了的优先，否则取 role 的默认值 */
function effectiveAccelerator(item: StubMenuTemplate): { value?: string; source: string } {
  if (item.accelerator) return { value: item.accelerator, source: '模板' }
  const role = item.role?.toLowerCase()
  if (role && role in ROLE_ACCELERATORS) {
    const value = ROLE_ACCELERATORS[role]
    if (value) return { value, source: `role:${item.role}` }
  }
  return { source: '' }
}

function main(): void {
  installApplicationMenu()

  const template = menuTemplate()
  if (!template) {
    console.error('❌ 没有装上任何应用菜单')
    process.exit(1)
  }

  const items = flatten(template)

  section('1. 菜单结构')
  check('菜单装上了', Array.isArray(template) && template.length > 0, `${template.length} 个顶级菜单`)
  const expectedTops =
    process.platform === 'darwin' ? `${app.name} / 编辑 / 视图 / 窗口` : '编辑 / 视图 / 窗口'
  check(
    '顶级菜单标签齐全',
    template.map((m) => m.label).join(' / ') === expectedTops,
    template.map((m) => m.label).join(' / ')
  )
  check(
    '所有菜单项都有 label（避免退回英文默认名）',
    items.every((i) => typeof i.label === 'string' && i.label.length > 0),
    items
      .filter((i) => !i.label)
      .map((i) => i.role ?? '(无 role)')
      .join(', ') || '全部有'
  )

  section('2. ⌘A 必须留给论文列表（核心回归点）')
  const claimingA = items
    .map((i) => ({ label: i.label, ...effectiveAccelerator(i) }))
    .filter((i) => i.value && canonical(i.value) === 'cmd+a')
  check(
    '没有任何菜单项占用 ⌘A',
    claimingA.length === 0,
    claimingA.length ? claimingA.map((i) => `${i.label}(${i.source})`).join(', ') : '无'
  )
  check(
    '编辑菜单里没有 selectAll（它的 role 默认就绑 ⌘A，压不住）',
    !items.some((i) => i.role?.toLowerCase() === 'selectall')
  )

  section('3. role 快照没有过期（新加 role 会在这里被拦住）')
  const unknownRoles = [
    ...new Set(
      items
        .map((i) => i.role)
        .filter((r): r is string => !!r && !(r.toLowerCase() in ROLE_ACCELERATORS))
    )
  ]
  check(
    '用到的每个 role 都在快照表里',
    unknownRoles.length === 0,
    unknownRoles.length ? `缺：${unknownRoles.join(', ')}` : `${Object.keys(ROLE_ACCELERATORS).length} 个 role 已登记`
  )

  section('4. 编辑菜单该有的都在')
  const roles = new Set(items.map((i) => i.role?.toLowerCase()))
  for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'delete']) {
    check(`保留了 ${role}`, roles.has(role))
  }

  section('5. 视图 / 窗口菜单')
  check('保留了 toggleDevTools', roles.has('toggledevtools'))
  check('保留了 togglefullscreen', roles.has('togglefullscreen'))
  check('保留了 reload', roles.has('reload'))
  if (process.platform === 'darwin') {
    check('macOS 保留了 quit / hide', roles.has('quit') && roles.has('hide'))
  } else {
    check('非 macOS 保留了 quit', roles.has('quit'))
  }

  section('6. 菜单加速键不撞应用快捷键')
  const resolved = items.map((i) => ({ label: i.label ?? '', ...effectiveAccelerator(i) }))
  const withKey = resolved.filter((i) => !!i.value)
  const collisions = withKey.filter((i) => APP_SHORTCUTS.includes(canonical(i.value as string)))
  check(
    '没有菜单项占用应用快捷键（⌘K / ⌘I / ⌘N / ⌘A / ⌘1~7）',
    collisions.length === 0,
    collisions.length ? collisions.map((i) => `${i.label}=${i.value}(${i.source})`).join(', ') : '无'
  )

  const seen = new Map<string, string>()
  const dupes: string[] = []
  for (const item of withKey) {
    const key = canonical(item.value as string)
    const prev = seen.get(key)
    if (prev) dupes.push(`${key}: ${prev} / ${item.label}`)
    else seen.set(key, item.label)
  }
  check(
    '没有重复的加速键（重复的会静默失效）',
    dupes.length === 0,
    dupes.join('; ') || `${seen.size} 个生效的加速键：${[...seen.keys()].join(' ')}`
  )

  console.log('')
  console.log(`${pass}/${pass + fail} 通过`)
  if (fail) process.exitCode = 1
}

try {
  main()
} catch (err) {
  console.error('❌ 失败：', err)
  process.exit(1)
}
