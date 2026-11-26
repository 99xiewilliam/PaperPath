import type { AppSettings } from '@shared/types'

/**
 * 渲染层在拿到主进程设置前的占位值。
 *
 * **必须与 main/settings.ts 的 DEFAULT_SETTINGS 保持一致**：
 * 两份漂移的表现是「设置页显示某个维度已关闭，运行时照样跑」——
 * 而且只在首屏渲染的那一瞬间出现，极难复现。改一边就改另一边。
 */
export const DEFAULT_SETTINGS: AppSettings = {
  vaultPath: '',
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.3,
    maxTokens: 16384
  },
  autoSummarizeOnImport: true,
  pdfDarkMode: false,
  customCategories: [],
  customSections: [],
  // 与主进程一致：图表与可视化设计默认关闭
  disabledLenses: ['visuals'],
  settingsVersion: 2
}

export const LLM_PRESETS = [
  {
    label: '智增增 zhizengzeng',
    baseUrl: 'https://api.zhizengzeng.com/v1',
    model: 'deepseek-v4-flash'
  },
  {
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat'
  },
  {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  {
    label: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-128k'
  },
  {
    label: '阿里通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus'
  },
  {
    label: '智谱 GLM Coding',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    model: 'glm-5.4'
  },
  {
    label: '智谱 GLM（资源包）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash'
  },
  {
    label: '本地 Ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:14b'
  }
]
