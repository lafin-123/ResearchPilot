import type { ModelInfo, Provider } from '@shared/types'

export interface ProviderPreset {
  key: string
  label: string
  description: string
  name: string
  kind: 'deepseek' | 'custom'
  protocol: Provider['protocol']
  baseUrl: string
  models: ModelInfo[]
  keyHint: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'nova',
    label: 'Nova 网关',
    description: '已验证 Responses 协议；列表可见不等于模型可调用，请先做真实调用测试。',
    name: 'Nova 网关',
    kind: 'custom',
    protocol: 'openai-responses',
    baseUrl: 'https://nova1api.duckdns.org/v1',
    models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol（网关模型 ID）' }],
    keyHint: '填写你自己的有效 API Key；安装包不包含密钥'
  },
  {
    key: 'openai',
    label: 'ChatGPT / OpenAI',
    description: 'OpenAI API Key，支持 GPT-5/6 与 o 系列',
    name: 'OpenAI',
    kind: 'custom',
    protocol: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { id: 'o4-mini', label: 'o4-mini' }
    ],
    keyHint: 'sk-...'
  },
  {
    key: 'anthropic',
    label: 'Anthropic Claude',
    description: 'Claude API Key，Sonnet / Opus / Haiku',
    name: 'Anthropic Claude',
    kind: 'custom',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    models: [
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' }
    ],
    keyHint: 'sk-ant-...'
  },
  {
    key: 'gemini',
    label: 'Google Gemini',
    description: 'Gemini API Key，通过 OpenAI 兼容端点',
    name: 'Google Gemini',
    kind: 'custom',
    protocol: 'openai-completions',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: [
      { id: 'gemini-pro-latest', label: 'Gemini Pro（最新）' },
      { id: 'gemini-flash-latest', label: 'Gemini Flash（最新）' },
      { id: 'gemini-flash-lite-latest', label: 'Gemini Flash Lite（最新）' }
    ],
    keyHint: 'AIza...'
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    description: '一个 Key 路由 OpenAI、Claude、Gemini 等数百模型',
    name: 'OpenRouter',
    kind: 'custom',
    protocol: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      { id: 'openrouter/auto', label: 'OpenRouter Auto' },
      { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5' },
      { id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash' }
    ],
    keyHint: 'sk-or-v1-...'
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek 官方 API',
    name: 'DeepSeek',
    kind: 'deepseek',
    protocol: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    models: [
      { id: 'deepseek-flash', label: 'DeepSeek V4 Flash', contextWindow: 1_000_000, maxOutput: 131_072 },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 1_000_000, maxOutput: 131_072 }
    ],
    keyHint: 'sk-...'
  },
  {
    key: 'kimi',
    label: 'Kimi / Moonshot',
    description: 'Moonshot 中国站；全球站改用 api.moonshot.ai',
    name: 'Kimi (Moonshot)',
    kind: 'custom',
    protocol: 'openai-completions',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [
      { id: 'kimi-k3', label: 'Kimi K3' },
      { id: 'kimi-k2.6', label: 'Kimi K2.6' },
      { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' }
    ],
    keyHint: 'sk-...'
  },
  {
    key: 'glm',
    label: '智谱 GLM',
    description: 'BigModel 开放平台，GLM-5 系列',
    name: '智谱 GLM',
    kind: 'custom',
    protocol: 'openai-completions',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-5.3', label: 'GLM-5.3' },
      { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash' },
      { id: 'glm-5.2', label: 'GLM-5.2' }
    ],
    keyHint: '...'
  },
  {
    key: 'qwen',
    label: '通义千问',
    description: '阿里云百炼 DashScope 兼容模式',
    name: '通义千问',
    kind: 'custom',
    protocol: 'openai-completions',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen3-max', label: 'Qwen3 Max' },
      { id: 'qwen-plus', label: 'Qwen Plus' },
      { id: 'qwen-turbo', label: 'Qwen Turbo' }
    ],
    keyHint: 'sk-...'
  },
  {
    key: 'xai',
    label: 'xAI Grok',
    description: 'Grok API，OpenAI 兼容协议',
    name: 'xAI Grok',
    kind: 'custom',
    protocol: 'openai-completions',
    baseUrl: 'https://api.x.ai/v1',
    models: [
      { id: 'grok-4.7', label: 'Grok 4.7' },
      { id: 'grok-4.6', label: 'Grok 4.6' }
    ],
    keyHint: 'xai-...'
  },
  {
    key: 'ollama',
    label: 'Ollama（本地）',
    description: '本地模型，无需真实 API Key，可先启动 ollama serve',
    name: 'Ollama 本地',
    kind: 'custom',
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: [
      { id: 'qwen3:8b', label: 'Qwen3 8B' },
      { id: 'llama3.2:3b', label: 'Llama 3.2 3B' }
    ],
    keyHint: '本地服务可留空'
  },
  {
    key: 'custom',
    label: '自定义网关',
    description: '任意 OpenAI / Anthropic 兼容端点或代理',
    name: '',
    kind: 'custom',
    protocol: 'openai-completions',
    baseUrl: '',
    models: [],
    keyHint: 'sk-...'
  }
]
