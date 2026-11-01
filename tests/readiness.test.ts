import test from 'node:test'
import assert from 'node:assert/strict'
import type { BootstrapData, Provider } from '../src/shared/types'
import type { McpServerState } from '../src/shared/mcp'
import { assessReadiness, loadReadiness, loadingReadiness, modelReadiness, ReadinessRequestGuard, REQUIRED_MCP, resolveReadinessSelection, type ReadinessData } from '../src/renderer/src/lib/readiness'

const selection = { providerId: 'selected', modelId: 'model-a' }
const provider = (id = 'selected', key = true): Provider => ({ id, name: id, kind: 'custom', protocol: 'openai-completions', baseUrl: 'https://example.invalid', models: [{ id: 'model-a', label: 'Model A' }], isDefault: false, hasApiKey: key, createdAt: '', updatedAt: '' })
const bootstrap = (): BootstrapData => ({ version: 'test', settings: { workspaceRoot: 'workspace', pythonPath: 'C:/Python/python.exe', latexCommand: '', defaultProviderId: 'default', defaultModelId: 'model-a', maxConcurrentRuns: 1, reasoningEffort: '', maxOutputTokens: 0, telemetry: false }, providers: [provider(), provider('default')], projects: [], sshHosts: [], activeProjectId: 'project-a', hasDeepSeekKey: true, latexAvailable: false, uvAvailable: false, pythonAvailable: true })
const servers = (): McpServerState[] => REQUIRED_MCP.map(item => ({ ...item, namespace: item.id, description: '', testTool: '', tools: [], enabled: true, status: 'disconnected', projectId: 'project-a', discoveredTools: [], lastTestAt: '', lastTestOk: null, lastError: '', testSummary: '' }))
const ready = (): ReadinessData => ({ bootstrap: { status: 'ready', data: bootstrap() }, mcp: { status: 'ready', data: servers() } })

test('unavailable project blocks execution but leaves database-backed local features available', () => {
  const data = ready()
  if (data.bootstrap.status !== 'ready') throw new Error('fixture')
  Object.assign(data.bootstrap.data, { projectHealth: [{ projectId: 'project-a', available: false, error: { code: 'ENOENT', message: 'missing root' } }] })
  const result = assessReadiness('project-a', data, selection)
  assert.equal(result.canStartPipeline, false)
  assert.equal(result.canDiscuss, false)
  assert.equal(result.localFeaturesAvailable, true)
  assert.equal(result.issues.find(issue => issue.id === 'project-unavailable')?.to, '/setup')
})

test('complete role configuration enables pipeline without unrelated selected-model key', () => {
  const data = ready()
  if (data.bootstrap.status !== 'ready') throw new Error('fixture')
  data.bootstrap.data.providers[0].hasApiKey = false
  data.bootstrap.data.settings.agentRoleModels = { writing: { providerId: 'default', modelId: 'model-a' }, figures: { providerId: 'default', modelId: 'model-a' }, engineering: { providerId: 'default', modelId: 'model-a' } }
  const result = assessReadiness('project-a', data, selection)
  assert.equal(result.canDiscuss, false)
  assert.equal(result.canStartPipeline, true)
})

test('configured does not imply inference verified or MCP diagnostic connected', () => {
  const result = assessReadiness('project-a', ready(), selection)
  assert.equal(result.modelConfigured, true)
  assert.equal(result.canStartPipeline, true)
  assert.equal(result.inferenceVerified, false)
  assert.equal(result.mcpEnabled, true)
})

test('selection is not substituted by a configured default or unrelated key', () => {
  const data = bootstrap()
  data.providers[0].hasApiKey = false
  assert.equal(modelReadiness(data.providers, selection).configured, false)
  assert.equal(modelReadiness(data.providers, { providerId: 'deleted', modelId: 'model-a' }).configured, false)
  assert.equal(modelReadiness(data.providers, { providerId: 'selected', modelId: 'unlisted' }).configured, false)
  assert.equal(modelReadiness(data.providers, { providerId: 'selected', modelId: '' }).configured, false)
  assert.deepEqual(resolveReadinessSelection(data, { providerId: '', modelId: '' }), { providerId: 'default', modelId: 'model-a' })
  assert.deepEqual(resolveReadinessSelection(data, selection), selection)
  assert.deepEqual(resolveReadinessSelection(data, { providerId: 'selected', modelId: '' }), { providerId: 'selected', modelId: '' })
})

test('explicit Python, detected runtime and uv condition matrix', () => {
  for (const path of ['', '  ', 'C:/Python/python.exe']) for (const pythonAvailable of [false, true]) for (const uvAvailable of [false, true]) {
    const data = ready()
    if (data.bootstrap.status !== 'ready') throw new Error('fixture')
    Object.assign(data.bootstrap.data.settings, { pythonPath: path })
    Object.assign(data.bootstrap.data, { pythonAvailable, uvAvailable })
    const result = assessReadiness('project-a', data, selection)
    assert.equal(result.canStartPipeline, !!path.trim() && pythonAvailable, JSON.stringify({ path, pythonAvailable, uvAvailable }))
    assert.equal(result.canDiscuss, true)
    assert.equal(result.localFeaturesAvailable, true)
  }
})

test('each missing/disabled MCP gets a specific actionable blocker; tests do not enable tools', () => {
  for (const required of REQUIRED_MCP) for (const missing of [false, true]) {
    const data = ready()
    if (data.mcp.status !== 'ready') throw new Error('fixture')
    if (missing) data.mcp.data = data.mcp.data.filter(item => item.id !== required.id)
    else Object.assign(data.mcp.data.find(item => item.id === required.id)!, { enabled: false, status: 'connected', lastTestOk: true })
    const result = assessReadiness('project-a', data, selection)
    assert.equal(result.canStartPipeline, false)
    assert.equal(result.canDiscuss, true)
    assert.equal(result.issues.find(item => item.id === `mcp-${required.id}`)?.to, '/mcp')
  }
})

test('empty MCP responses, missing projects and read failures never report ready', () => {
  const empty = ready(); empty.mcp = { status: 'ready', data: [] }
  assert.equal(assessReadiness('project-a', empty, selection).canStartPipeline, false)
  assert.equal(assessReadiness('', ready(), selection).canStartPipeline, false)
  assert.equal(assessReadiness('', ready(), selection).localFeaturesAvailable, false)
  for (const field of ['bootstrap', 'mcp'] as const) {
    const data = ready(); data[field] = { status: 'error', error: 'connection closed' }
    const result = assessReadiness('project-a', data, selection)
    assert.equal(result.canStartPipeline, false)
    assert.equal(result.failed, true)
    assert.equal(result.localFeaturesAvailable, true)
    assert.ok(result.issues.some(item => item.text.includes('connection closed')))
  }
  assert.equal(assessReadiness('project-a', loadingReadiness(), selection).canStartPipeline, false)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('read-only async loader exposes loading, actual failure, retry and independent local capabilities', async () => {
  const guard = new ReadinessRequestGuard()
  let state = ready()
  const pending = deferred<BootstrapData>()
  const request = loadReadiness(guard, () => pending.promise, async () => { throw new Error('MCP unavailable') }, data => { state = data }, error => (error as Error).message)
  assert.equal(state.bootstrap.status, 'loading')
  assert.equal(assessReadiness('project-a', state, selection).canStartPipeline, false)
  pending.resolve(bootstrap()); await request
  assert.equal(state.bootstrap.status, 'ready')
  assert.deepEqual(state.mcp, { status: 'error', error: 'MCP unavailable' })
  assert.equal(assessReadiness('project-a', state, selection).canDiscuss, true)
  await loadReadiness(guard, async () => bootstrap(), async () => servers(), data => { state = data })
  assert.equal(assessReadiness('project-a', state, selection).canStartPipeline, true)
})

test('late successful reads cannot overwrite newer retry results', async () => {
  const guard = new ReadinessRequestGuard()
  let state = ready()
  const old = deferred<BootstrapData>()
  const first = loadReadiness(guard, () => old.promise, async () => servers(), data => { state = data })
  await loadReadiness(guard, async () => { throw new Error('new failure') }, async () => [], data => { state = data })
  const latest = state
  old.resolve(bootstrap()); await first
  assert.equal(state, latest)
  assert.equal(state.bootstrap.status, 'error')
})

test('scope invalidation discards late error/success after project switch, A-B-A, and unmount', async () => {
  for (const rejectOld of [false, true]) {
    const guard = new ReadinessRequestGuard()
    const old = deferred<BootstrapData>()
    const states: ReadinessData[] = []
    const request = loadReadiness(guard, () => old.promise, async () => servers(), data => states.push(data))
    guard.invalidate()
    guard.begin()
    guard.invalidate()
    if (rejectOld) old.reject(new Error('old project failure'))
    else old.resolve(bootstrap())
    await request
    assert.equal(states.length, 1)
    assert.equal(states[0].bootstrap.status, 'loading')
  }
})
