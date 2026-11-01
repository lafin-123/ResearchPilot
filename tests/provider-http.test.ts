import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverProviderModels, normalizeProviderBase, providerHttpError, redactProviderError, testProviderInference } from '../src/main/lib/provider-http'
import type { Provider } from '../src/shared/types'
const provider: Provider = { id: 'demo', name: 'Demo', kind: 'custom', protocol: 'openai-responses', baseUrl: 'https://gateway.example', models: [{ id: 'gpt-test', label: 'Test' }], isDefault: false, hasApiKey: true, createdAt: '', updatedAt: '' }
const response = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('discovery keeps explicit upstream capabilities, ignores malformed entries and never infers from model names', async () => {
  const fetcher = (async () => response({ data: [null, 5, {}, { id: 'vision-looking-name' }, { id: 'actual', display_name: 'Actual model', context_window: 131072, max_output_tokens: 8192, capabilities: { vision: true, tools: false, reasoning: true } }, { id: 'actual' }, { id: 'bad-meta', context_window: -1, capabilities: { vision: 'yes' } }] })) as typeof fetch
  const result = await discoverProviderModels(provider, 'test', fetcher)
  assert.equal(result.ok, true)
  assert.deepEqual(result.models.map(m => m.id), ['vision-looking-name', 'actual', 'bad-meta'])
  const model = result.models[1]
  assert.equal(model.contextWindow, 131072)
  assert.equal(model.maxOutput, 8192)
  assert.deepEqual(model.capabilities, { vision: true, tools: false, reasoning: true })
  assert.equal(model.metadataSource, 'upstream')
  assert.equal(result.models[0].capabilities, undefined)
  assert.equal(result.models[2].contextWindow, undefined)
  assert.equal(result.models[2].capabilities, undefined)
})

test('discovery reads explicit modality and supported-parameter metadata from compatible gateways', async () => {
  const fetcher = (async () => response({ data: [{ id: 'gateway-model', context_length: 200000, top_provider: { max_completion_tokens: 16000 }, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools', 'reasoning'] }] })) as typeof fetch
  const result = await discoverProviderModels(provider, 'test', fetcher)
  assert.equal(result.models[0].maxOutput, 16000)
  assert.deepEqual(result.models[0].capabilities, { vision: true, tools: true, reasoning: true })
})

test('root gateway URL gains v1 while custom routing and TLS checks are preserved', () => {
  assert.equal(normalizeProviderBase('https://gateway.example/', 'openai-completions'), 'https://gateway.example/v1')
  assert.equal(normalizeProviderBase('https://gateway.example/custom/v2/', 'openai-responses'), 'https://gateway.example/custom/v2')
  assert.equal(normalizeProviderBase('http://127.0.0.1:11434/v1', 'openai-completions'), 'http://127.0.0.1:11434/v1')
  assert.throws(() => normalizeProviderBase('http://gateway.example', 'openai-completions'), /HTTPS/)
  assert.throws(() => normalizeProviderBase('https://gateway.example/v1/chat/completions', 'openai-completions'), /基础地址/)
  assert.throws(() => normalizeProviderBase('https://user:secret@gateway.example', 'openai-completions'), /密码/)
})
test('expired keys are explicit and error content never echoes credentials', () => {
  const key = 'test-secret-value'
  assert.match(providerHttpError(403, '{"code":"API_KEY_EXPIRED"}', key), /已过期/)
  assert.ok(!providerHttpError(400, `echo ${key}`, key).includes(key))
  assert.ok(!redactProviderError('sk-sensitivekey12345').includes('sensitivekey'))
})
test('model discovery is not presented as successful inference', async () => {
  const fetcher = (async (url, init) => {
    assert.equal(String(url), 'https://gateway.example/v1/models')
    assert.equal(init?.redirect, 'error')
    return response({ data: [{ id: 'unavailable-in-practice' }] })
  }) as typeof fetch
  const result = await discoverProviderModels(provider, 'not-a-secret-test', fetcher)
  assert.equal(result.ok, true)
  assert.match(result.message, /不代表模型可推理/)
})
test('real inference posts prompt and requires actual response marker', async () => {
  let called = false
  const fetcher = (async (url, init) => {
    assert.equal(String(url), 'https://gateway.example/v1/responses')
    assert.equal(init?.method, 'POST')
    assert.equal(JSON.parse(init?.body as string).store, false)
    called = true
    return response({ output: [{ content: [{ type: 'output_text', text: 'RESEARCHPILOT_OK' }] }] })
  }) as typeof fetch
  assert.equal((await testProviderInference(provider, 'test', fetcher)).ok, true)
  assert.equal(called, true)
  const empty = (async () => response({ choices: [{ message: { content: '' } }] })) as typeof fetch
  assert.equal((await testProviderInference(provider, 'test', empty)).ok, false)
})
test('listed-but-unsupported models remain failed rather than auto switching paid routes', async () => {
  const fetcher = (async () => response({ error: { message: 'Model is not supported' } }, 400)) as typeof fetch
  const result = await testProviderInference(provider, 'test', fetcher)
  assert.equal(result.ok, false)
  assert.match(result.message, /HTTP 400/)
})
