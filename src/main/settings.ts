import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { allLensIds, disabledLensesFromLegacy } from '@shared/lenses'
import {
  LLM_PROVIDER_IDS,
  type AppSettings,
  type EnvConfigInfo,
  type LlmProviderId,
  type LlmSettings
} from '@shared/types'

/* ------------------------------------------------------------------ */
/*  API Key 的静态加密                                                  */
/* ------------------------------------------------------------------ */

const ENC_PREFIX = 'enc:v1:'

/**
 * 用系统钥匙串（macOS Keychain / Windows DPAPI / Linux libsecret）加密 API Key。
 *
 * settings.json 是明文 JSON，直接存 Key 的话，任何能读这个文件的程序
 * （或者不小心把目录提交进 git）都能拿到。safeStorage 不可用时（部分 Linux
 * 桌面没装 keyring）退回明文，但至少不会把用户挡在门外。
 */
function encryptSecret(plain: string): { apiKey?: string; apiKeyEnc?: string } {
  const value = plain.trim()
  if (!value) return {}
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { apiKeyEnc: ENC_PREFIX + safeStorage.encryptString(value).toString('base64') }
    }
  } catch (err) {
    console.warn('[settings] 系统钥匙串不可用，API Key 将以明文保存', err)
  }
  return { apiKey: value }
}

/** 解密；兼容老版本的明文存储 */
function decryptSecret(raw: Record<string, unknown>): string {
  const enc = typeof raw.apiKeyEnc === 'string' ? raw.apiKeyEnc : ''
  if (enc.startsWith(ENC_PREFIX)) {
    try {
      return safeStorage.decryptString(Buffer.from(enc.slice(ENC_PREFIX.length), 'base64'))
    } catch (err) {
      console.error(
        '[settings] API Key 解密失败（可能换过机器或系统钥匙串被重置），请到设置里重新填写',
        err
      )
      return ''
    }
  }
  return typeof raw.apiKey === 'string' ? raw.apiKey : ''
}

/**
 * 设置结构版本。改「必须对老用户生效一次的默认值」时把它 +1，
 * 并在 `migrateSettings` 里补一条分支。
 *
 * 必须声明在 `DEFAULT_SETTINGS` 之前：后者初始化时就要读它，
 * 写在后面会撞上 const 的暂时性死区（模块一加载就抛 ReferenceError）。
 *
 * 历史：
 *   1 → 2：`visuals` 维度改为默认关闭
 *   2 → 3：`graph` 维度下线，从 `disabledLenses` 里清掉已不存在的 id
 */
export const SETTINGS_VERSION = 3

export const DEFAULT_SETTINGS: AppSettings = {
  vaultPath: '',
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.3,
    // 推理型模型会把 reasoning token 也算进 max_tokens，
    // 给低了会把 JSON 尾部截断，所以默认放宽到 16k。
    maxTokens: 16384,
    // 0 = 未填。界面据此只显示 token 数、不显示金额（见 shared/types.ts 的说明）
    priceInput: 0,
    priceOutput: 0
  },
  autoSummarizeOnImport: true,
  pdfDarkMode: false,
  pdfShowAiHighlights: true,
  customCategories: [],
  customSections: [],
  /*
   * opt-out 列表（存「关掉了哪些」而不是「启用了哪些」），新增维度自动生效。
   *
   * 默认关掉 `visuals`（图表与可视化设计）：它产出的那一节在实际使用里
   * 很少被回头看，却是每次精读都跑一遍的固定成本。想用的人到
   * 设置 → 分析维度里打开即可。
   *
   * 老用户的这个数组里没有 visuals，靠下面 `settingsVersion` 的迁移补上 ——
   * 只改默认值对他们无效（默认值只在没有 settings.json 时生效）。
   */
  disabledLenses: ['visuals'],
  settingsVersion: SETTINGS_VERSION
}

/**
 * 把磁盘上的老设置升级到当前版本。
 *
 * 幂等：版本号已经追平就直接返回。**必须幂等**——写成「每次启动都补一遍」，
 * 用户手动把图表维度打开之后，下次启动又会被关掉，而且没有任何提示。
 *
 * 在 `app.whenReady()` 里、任何 `getSettings()` 之前调用：它要改写的是
 * 磁盘上那份配置，晚于读取就会被别的模块先缓存进内存。
 */
export function migrateSettings(): void {
  const current = readSettingsFile()
  const from = current.settingsVersion ?? 1
  if (from >= SETTINGS_VERSION) return

  const patch: Partial<AppSettings> = { settingsVersion: SETTINGS_VERSION }
  const disabled = new Set(current.disabledLenses ?? [])
  if (from < 2) disabled.add('visuals')
  if (from < 3) {
    /*
     * 知识图谱维度已整块下线：opt-out 清单里留一个不存在的 id 不会报错
     * （enabledLensIds 按 LENS_META 过滤），但配置会越攒越脏，
     * 设置页也解释不了那一条是什么。顺手清掉。
     */
    const known = new Set(allLensIds())
    for (const id of [...disabled]) if (!known.has(id)) disabled.delete(id)
  }
  patch.disabledLenses = [...disabled]

  console.log(`[settings] 配置迁移 ${from} → ${SETTINGS_VERSION}`, patch)
  setSettings(patch)
}

/* ------------------------------------------------------------------ */
/*  .env 支持                                                          */
/* ------------------------------------------------------------------ */

/**
 * 极简 .env 解析器（不引依赖）。
 * 支持：`KEY=VALUE`、`export KEY=VALUE`、`#` 注释、单/双引号包裹、
 * 双引号内的 `\n` 与 `\"` 转义、行尾注释。
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of content.replace(/\r\n?/g, '\n').split('\n')) {
    let line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice(7).trim()

    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue

    let value = line.slice(eq + 1).trim()
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]
      const end = value.indexOf(quote, 1)
      value = end >= 0 ? value.slice(1, end) : value.slice(1)
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    } else {
      const hash = value.indexOf(' #')
      if (hash >= 0) value = value.slice(0, hash)
      value = value.trim()
    }
    out[key] = value
  }
  return out
}

interface EnvBundle {
  values: Record<string, string>
  files: string[]
}

let envBundle: EnvBundle | null = null

/** 候选 .env 路径，靠前的优先 */
function envCandidates(): string[] {
  const list = [
    // 用户数据目录：升级 / 重装 App 都不会覆盖，推荐放这里
    join(app.getPath('userData'), '.env'),
    // 项目根目录（开发时最顺手）
    join(app.getAppPath(), '.env'),
    join(process.cwd(), '.env')
  ]
  return [...new Set(list)]
}

function loadEnv(): EnvBundle {
  if (envBundle) return envBundle
  const values: Record<string, string> = {}
  const files: string[] = []

  for (const file of envCandidates()) {
    if (!existsSync(file)) continue
    try {
      const parsed = parseEnvFile(readFileSync(file, 'utf-8'))
      // 先加载的优先，所以这里不覆盖已有键
      for (const [key, value] of Object.entries(parsed)) {
        if (values[key] === undefined) values[key] = value
      }
      files.push(file)
    } catch (err) {
      console.error('[settings] 读取 .env 失败', file, err)
    }
  }

  envBundle = { values, files }
  return envBundle
}

/** 读取一个环境变量：真实进程环境优先于 .env 文件，空串视为未设置 */
function readVar(...names: string[]): string | undefined {
  const { values } = loadEnv()
  for (const name of names) {
    const raw = process.env[name] ?? values[name]
    if (raw != null && String(raw).trim() !== '') return String(raw).trim()
  }
  return undefined
}

/**
 * 解析 PAPERVAULT_LLM_EXTRA_BODY。
 *
 * 注意 .env 里**不要给它加引号**：本文件那个极简解析器会把第一个 `"` 当结束符，
 * 于是 `"{"thinking":...}"` 只会解析出一个 `{`。直接写裸 JSON 才对。
 */
function parseExtraBody(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    console.error('[settings] PAPERVAULT_LLM_EXTRA_BODY 必须是 JSON 对象，已忽略：', raw)
  } catch (err) {
    /*
     * 不能抛。这个函数每次 getSettings() 都会跑，抛出去会让设置页、笔记页
     * 一起打不开 —— 一个写错的额外参数不该有这种破坏力。
     */
    console.error('[settings] PAPERVAULT_LLM_EXTRA_BODY 不是合法 JSON，已忽略：', raw, err)
  }
  return null
}

interface EnvResolution {
  vaultPath?: string
  llm: Partial<LlmSettings>
  overridden: string[]
  files: string[]
}

function resolveEnv(): EnvResolution {
  const baseUrl = readVar('PAPERVAULT_LLM_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE')
  const apiKey = readVar('PAPERVAULT_LLM_API_KEY', 'OPENAI_API_KEY')
  const model = readVar('PAPERVAULT_LLM_MODEL', 'OPENAI_MODEL')
  const temperatureRaw = readVar('PAPERVAULT_LLM_TEMPERATURE')
  const maxTokensRaw = readVar('PAPERVAULT_LLM_MAX_TOKENS')
  const extraBodyRaw = readVar('PAPERVAULT_LLM_EXTRA_BODY')
  const providerRaw = readVar('PAPERVAULT_LLM_PROVIDER')
  const vaultPath = readVar('PAPERVAULT_VAULT_PATH')
  const { files } = loadEnv()

  const llm: Partial<LlmSettings> = {}
  const overridden: string[] = []

  if (baseUrl) {
    llm.baseUrl = baseUrl
    overridden.push('llm.baseUrl')
  }
  if (apiKey) {
    llm.apiKey = apiKey
    overridden.push('llm.apiKey')
  }
  if (model) {
    llm.model = model
    overridden.push('llm.model')
  }
  if (temperatureRaw != null) {
    const t = Number(temperatureRaw)
    if (Number.isFinite(t)) {
      llm.temperature = Math.max(0, Math.min(1, t))
      overridden.push('llm.temperature')
    }
  }
  if (maxTokensRaw != null) {
    const n = Number(maxTokensRaw)
    if (Number.isFinite(n) && n > 0) {
      llm.maxTokens = Math.round(n)
      overridden.push('llm.maxTokens')
    }
  }
  if (extraBodyRaw != null) {
    const parsed = parseExtraBody(extraBodyRaw)
    if (parsed) {
      llm.extraBody = parsed
      overridden.push('llm.extraBody')
    }
  }
  if (providerRaw != null) {
    const id = providerRaw.trim()
    if ((LLM_PROVIDER_IDS as readonly string[]).includes(id)) {
      llm.provider = id as LlmProviderId
      overridden.push('llm.provider')
    } else {
      console.error(
        `[settings] PAPERVAULT_LLM_PROVIDER 只认 ${LLM_PROVIDER_IDS.join(' / ')}，已忽略：`,
        providerRaw
      )
    }
  }
  if (vaultPath) overridden.push('vaultPath')

  return { vaultPath, llm, overridden, files }
}

/* ------------------------------------------------------------------ */
/*  设置读写                                                            */
/* ------------------------------------------------------------------ */

/** 磁盘上的 llm 字段比内存里多一个 apiKeyEnc（密文），用它来描述落盘结构 */
type StoredLlm = LlmSettings & { apiKeyEnc?: string }

let fileCache: AppSettings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function merge(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    ...base,
    ...patch,
    llm: { ...base.llm, ...(patch.llm ?? {}) },
    customCategories: patch.customCategories ?? base.customCategories,
    customSections: patch.customSections ?? base.customSections
  }
}

/** 只读磁盘上的设置，不含 .env 覆盖 */
function readSettingsFile(): AppSettings {
  if (fileCache) return fileCache
  const file = settingsPath()
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<AppSettings>
      const llmRaw = (raw.llm ?? {}) as Record<string, unknown>
      const merged = merge(DEFAULT_SETTINGS, raw)
      // 维度偏好单独迁移：老配置存的是白名单，语义与现在相反
      merged.disabledLenses = disabledLensesFromLegacy(raw)
      // 磁盘上是密文，内存里换成明文交给调用方；顺带把 apiKeyEnc 从对象里摘干净
      const { apiKeyEnc: _enc, apiKey: _plain, ...llmRest } = merged.llm as StoredLlm
      merged.llm = { ...llmRest, apiKey: decryptSecret(llmRaw) }
      fileCache = merged
    } else {
      fileCache = { ...DEFAULT_SETTINGS }
    }
  } catch {
    fileCache = { ...DEFAULT_SETTINGS }
  }
  return fileCache
}

/**
 * 生效设置 = 磁盘设置 + .env / 环境变量覆盖。
 * 优先级：进程环境变量 > .env 文件 > settings.json。
 */
export function getSettings(): AppSettings {
  const base = readSettingsFile()
  const env = resolveEnv()

  // 知识库路径只作为「首次运行的默认值」：一旦用户在界面上选过，
  // 就以界面选择为准，避免 .env 把目录钉死导致「更换目录」点了没反应。
  const vaultPath = base.vaultPath || env.vaultPath || ''
  const overridden = env.overridden.filter((key) => key !== 'vaultPath' || !base.vaultPath)

  return {
    ...base,
    vaultPath,
    llm: { ...base.llm, ...env.llm },
    env: {
      active: overridden.length > 0,
      files: env.files,
      overridden
    }
  }
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const { env: _envIgnored, ...cleanPatch } = patch
  const next = merge(readSettingsFile(), cleanPatch)
  fileCache = next

  // 落盘前把明文 Key 换成密文；内存里（fileCache）始终是明文
  const { apiKey, apiKeyEnc: _drop, ...llmRest } = next.llm as StoredLlm
  const secret = encryptSecret(apiKey ?? '')
  const persisted: AppSettings = {
    ...next,
    llm: {
      ...llmRest,
      apiKey: secret.apiKey ?? '',
      ...(secret.apiKeyEnc ? { apiKeyEnc: secret.apiKeyEnc } : {})
    }
  }

  const file = settingsPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(persisted, null, 2), 'utf-8')
  return getSettings()
}

export function envInfo(): EnvConfigInfo {
  const env = resolveEnv()
  return { active: env.overridden.length > 0, files: env.files, overridden: env.overridden }
}
