import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const key = process.env.RESEARCHPILOT_API_KEY?.trim()
if (!key) throw new Error('Set RESEARCHPILOT_API_KEY in the process environment; never put credentials in this script.')
const origin = new URL(process.env.RESEARCHPILOT_API_ORIGIN || 'https://nova1api.duckdns.org')
if (origin.protocol !== 'https:' || origin.username || origin.password) throw new Error('An HTTPS origin without URL credentials is required.')
const dir = resolve('test-results')
await mkdir(dir, { recursive: true })
const runDir = await mkdtemp(join(dir, 'live-gateway-'))
const report = { origin: origin.origin, startedAt: new Date().toISOString(), tests: [] }
const redact = (text) => String(text).split(key).join('[REDACTED]').replace(/sk-[a-zA-Z0-9_-]{8,}/g, '[REDACTED]')
try {
  const response = await fetch(new URL('/v1/models', origin), { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(30000) })
  const raw = await response.text()
  report.tests.push({ name: 'models', status: response.status, contentType: response.headers.get('content-type') })
  if (!response.ok) throw new Error(`Model discovery HTTP ${response.status}: ${redact(raw).slice(0, 800)}`)
  let payload
  try { payload = JSON.parse(raw) } catch { throw new Error('Model endpoint did not return JSON') }
  const models = (payload.data ?? payload.models ?? []).map((item) => typeof item === 'string' ? item : item.id).filter((id) => typeof id === 'string')
  if (!models.length) throw new Error('No models were returned by the gateway')
  report.models = models
  console.log('MODEL_IDS', JSON.stringify(models))
  const requested = process.env.RESEARCHPILOT_MODEL
  const selected = requested || models.find((id) => /gpt-5\.4-mini/i.test(id)) || models.find((id) => /gpt-5-mini/i.test(id)) || models.find((id) => /gpt-4\.1-mini/i.test(id)) || models.find((id) => /deepseek.*(chat|flash)/i.test(id)) || models.find((id) => /sonnet/i.test(id)) || models.find((id) => /gpt-5/i.test(id)) || models[0]
  if (!models.includes(selected)) throw new Error('Requested model is not listed by this gateway')
  report.selectedModel = selected
  const begin = Date.now()
  const isResponses = process.env.RESEARCHPILOT_PROTOCOL === 'openai-responses'
  report.protocol = isResponses ? 'openai-responses' : 'openai-completions'
  const testPrompt = 'This is an authorized connection test for ResearchPilot. Reply with exactly RESEARCHPILOT_OK. Do not call tools.'
  const reply = await fetch(new URL(isResponses ? '/v1/responses' : '/v1/chat/completions', origin), { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, redirect: 'error', body: JSON.stringify(isResponses ? { model: selected, input: [{ role: 'user', content: [{ type: 'input_text', text: testPrompt }] }], max_output_tokens: 1024, store: false, stream: false } : { model: selected, messages: [{ role: 'user', content: testPrompt }], max_completion_tokens: 1024, stream: false }), signal: AbortSignal.timeout(90000) })
  const text = await reply.text()
  let json
  try { json = JSON.parse(text) } catch { json = null }
  const content = json?.choices?.[0]?.message?.content ?? json?.output_text ?? json?.output?.flatMap((item) => (item.content ?? []).map((part) => part.text ?? '')).join('')
  report.tests.push({ name: 'chat-completion', status: reply.status, durationMs: Date.now() - begin, requestedModel: selected, returnedModel: json?.model, usage: json?.usage, response: typeof content === 'string' ? redact(content).slice(0, 1000) : undefined, error: reply.ok ? undefined : redact(text).slice(0, 1000) })
  console.log('CHAT_RESULT', JSON.stringify(report.tests.at(-1)))
  if (!reply.ok) throw new Error(`Chat HTTP ${reply.status}`)
  if (!String(content).includes('RESEARCHPILOT_OK')) throw new Error('The connection test did not return the required marker')
  report.ok = true
} catch (error) {
  report.ok = false
  report.error = redact(error.message)
  report.cause = error.cause ? { code: error.cause.code, message: redact(error.cause.message) } : undefined
  console.error('PROBE_ERROR', report.error)
  process.exitCode = 1
} finally {
  delete process.env.RESEARCHPILOT_API_KEY
  report.finishedAt = new Date().toISOString()
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log('REPORT_DIR', runDir)
}
