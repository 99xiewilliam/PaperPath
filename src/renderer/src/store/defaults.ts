import type { AppSettings } from '@shared/types'

/** 渲染层在拿到主进程设置前的占位值，字段与主进程保持一致 */
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
  disabledLenses: []
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
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus'
  },
  {
    label: '本地 Ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:14b'
  }
]
