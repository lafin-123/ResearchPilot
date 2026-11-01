import type { ModelInfo, Provider } from '../../shared/types'

export function normalizeProviderBase(value: string, protocol: Provider['protocol']): string {
  const url = new URL(value)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('模型地址必须使用 HTTPS（本机服务可使用 HTTP）。')
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含密码、查询参数或锚点。')
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (/\/(?:chat\/completions|responses|messages|models)$/.test(url.pathname)) throw new Error('请填写 API 基础地址，不要包含 /models、/messages 或 /chat/completions。')
  if (!url.pathname || url.pathname === '/') {
    url.pathname = protocol === 'openai-completions' || protocol === 'openai-responses' ? '/v1' : ''
  }
  return url.toString().replace(/\/+$/, '')
}

export function redactProviderError(value: unknown, key = ''): string {
  let text = value instanceof Error ? value.message : String(value)
  if (key) text = text.split(key).join('[密钥已隐藏]')
  return text.replace(/sk-[a-zA-Z0-9_-]{8,}/g, '[密钥已隐藏]').slice(0, 800)
}

export function providerHttpError(status: number, body: string, key: string): string {
  const safe = redactProviderError(body, key)
  if (/API_KEY_EXPIRED|key.*expired/i.test(safe)) return `HTTP ${status}：API Key 已过期，请更换有效密钥。这不代表应用已成功调用模型。`
  if (status === 401) return 'HTTP 401：API Key 缺失或无效，请检查该网关的凭据。'
  if (status === 429) return 'HTTP 429：网关限流或额度不足，请检查额度并稍后重试。'
  return `HTTP ${status}：${safe}`
}

function endpoint(base: string, protocol: Provider['protocol'], operation: 'models' | 'inference'): string {
  const path = operation === 'models' ? 'models' : protocol === 'anthropic-messages' ? 'messages' : protocol === 'openai-responses' ? 'responses' : 'chat/completions'
  return `${base}${protocol === 'anthropic-messages' && !base.endsWith('/v1') ? '/v1' : ''}/${path}`
}

function headers(protocol: Provider['protocol'], key: string): Record<string, string> {
  return protocol === 'anthropic-messages' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } : { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
}

export function parseUpstreamModels(items: unknown[]): ModelInfo[] {
  const models = new Map<string, ModelInfo>()
  const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 100_000_000 ? value : undefined
  for (const raw of items.slice(0, 1000)) {
    const item = typeof raw === 'string' ? { id: raw } : raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
    if (!item) continue
    const rawId = item.id ?? item.name
    if (typeof rawId !== 'string') continue
    const id = rawId.trim()
    if (!id || id.length > 256 || /[\u0000-\u001f]/.test(id) || models.has(id)) continue
    const label = typeof item.display_name === 'string' ? item.display_name.slice(0, 256) : id
    const source = item.capabilities && typeof item.capabilities === 'object' && !Array.isArray(item.capabilities) ? item.capabilities as Record<string, unknown> : {}
    const capabilities: NonNullable<ModelInfo['capabilities']> = {}
    const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
    const architecture = object(item.architecture), top = object(item.top_provider)
    const modalities = item.input_modalities ?? architecture.input_modalities
    const parameters = item.supported_parameters
    if (Array.isArray(modalities) && modalities.includes('image')) capabilities.vision = true
    if (Array.isArray(parameters)) {
      if (parameters.includes('tools') || parameters.includes('tool_choice')) capabilities.tools = true
      if (parameters.includes('reasoning') || parameters.includes('reasoning_effort')) capabilities.reasoning = true
    }
    if (typeof item.supports_vision === 'boolean') capabilities.vision = item.supports_vision
    if (typeof item.supports_tools === 'boolean') capabilities.tools = item.supports_tools
    if (typeof item.supports_reasoning === 'boolean') capabilities.reasoning = item.supports_reasoning
    for (const capability of ['vision', 'tools', 'reasoning'] as const) if (typeof source[capability] === 'boolean') capabilities[capability] = source[capability] as boolean
    models.set(id, {
      id, label, metadataSource: 'upstream',
      ...(positive(item.context_window ?? item.context_length) ? { contextWindow: positive(item.context_window ?? item.context_length) } : {}),
      ...(positive(item.max_output_tokens ?? item.max_output ?? top.max_completion_tokens) ? { maxOutput: positive(item.max_output_tokens ?? item.max_output ?? top.max_completion_tokens) } : {}),
      ...(Object.keys(capabilities).length ? { capabilities } : {})
    })
  }
  return [...models.values()]
}

export async function discoverProviderModels(provider: Provider, key: string, request: typeof fetch): Promise<{ ok: boolean; message: string; models: ModelInfo[] }> {
  if (!key) return { ok: false, message: '尚未配置 API Key。', models: [] }
  const base = normalizeProviderBase(provider.baseUrl || 'https://api.deepseek.com', provider.protocol)
  try {
    const response = await request(endpoint(base, provider.protocol, 'models'), { headers: headers(provider.protocol, key), redirect: 'error', signal: AbortSignal.timeout(30_000) })
    if (!response.ok) return { ok: false, message: providerHttpError(response.status, await response.text(), key), models: [] }
    const payload = await response.json() as { data?: Array<Record<string, unknown> | string>; models?: Array<Record<string, unknown> | string> }
    const items = payload.data ?? payload.models ?? []
    if (!Array.isArray(items)) throw new Error('模型列表格式无效。')
    const models = parseUpstreamModels(items)
    return { ok: true, message: `已读取 ${models.length} 个模型；列表可见不代表模型可推理，请执行“真实调用测试”。`, models }
  } catch (error) { return { ok: false, message: `读取模型列表失败：${redactProviderError(error, key)}。已使用系统网络代理；请检查网关、代理或 TLS 连接。`, models: [] } }
}

export async function testProviderInference(provider: Provider, key: string, request: typeof fetch): Promise<{ ok: boolean; message: string; models: ModelInfo[] }> {
  if (!key) return { ok: false, message: '尚未配置 API Key。', models: [] }
  const model = provider.models[0]?.id
  if (!model) return { ok: false, message: '请先选择一个模型 ID；读取列表不能替代真实推理测试。', models: [] }
  const base = normalizeProviderBase(provider.baseUrl || 'https://api.deepseek.com', provider.protocol)
  const prompt = 'Connection test only. Reply with exactly RESEARCHPILOT_OK and no other words.'
  const body = provider.protocol === 'openai-responses'
    ? { model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }], max_output_tokens: 1024, store: false, stream: false }
    : provider.protocol === 'anthropic-messages'
      ? { model, messages: [{ role: 'user', content: prompt }], max_tokens: 128, stream: false }
      : { model, messages: [{ role: 'user', content: prompt }], ...(/^gpt-5|^gpt-6|^o[134]/.test(model) ? { max_completion_tokens: 1024 } : { max_tokens: 256 }), stream: false }
  const started = Date.now()
  try {
    const response = await request(endpoint(base, provider.protocol, 'inference'), { method: 'POST', headers: headers(provider.protocol, key), body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(90_000) })
    if (!response.ok) return { ok: false, message: providerHttpError(response.status, await response.text(), key), models: [] }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; content?: Array<{ text?: string }>; output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> }
    const text = payload.choices?.[0]?.message?.content ?? payload.content?.map((block) => block.text ?? '').join('') ?? payload.output_text ?? payload.output?.flatMap((item) => item.content?.map((block) => block.text ?? '') ?? []).join('') ?? ''
    if (!text.includes('RESEARCHPILOT_OK')) return { ok: false, message: `${model} 返回 HTTP 200，但没有产生预期文本。不能据此认定推理可用；请检查模型输出额度或协议。`, models: [] }
    return { ok: true, message: `真实调用成功：${model} 返回了验证文本（${((Date.now() - started) / 1000).toFixed(1)} 秒）。该测试使用少量模型额度。`, models: [] }
  } catch (error) { return { ok: false, message: `真实调用失败：${redactProviderError(error, key)}。请检查网关、系统代理或模型协议。`, models: [] } }
}
