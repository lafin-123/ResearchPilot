import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BridgeService } from '../src/main/services/bridge'
import { getBridgeEndpoint } from '../src/main/lib/bridge-state'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'research-bridge-'))
  let authorized = false, rendered = 0, exported = 0, created = 0
  let approval: () => Promise<{ approved: boolean }> = async () => ({ approved: false })
  const figures = { list: () => [], render: async () => { rendered++; return {} }, createStructured: async (input: unknown) => { created++; return input }, getStructured: (_p: string, id: string) => ({ id }), saveStructured: async (_p: string, id: string, spec: unknown) => ({ id, spec }), exportPptx: async (_p: string, id: string) => { exported++; return { id, pptxPath: 'figure.pptx' } } }
  const bridge = new BridgeService(
    { list: () => [], get: () => ({ id: 'project', rootPath: root }) } as never,
    { list: () => [] } as never, { list: () => [] } as never, { list: () => [] } as never,
    { runningCount: () => 0 } as never, figures as never, {} as never,
    { request: () => approval(), cancelAll: () => {} } as never, {} as never, {} as never, () => authorized
  )
  const rpc = async (method: string, params: Record<string, unknown> = {}, token?: string) => {
    const endpoint = getBridgeEndpoint()!
    return fetch(`${endpoint.url}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${token ?? endpoint.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'project', method, params }) })
  }
  return { root, bridge, rpc, authorize: (value: boolean) => { authorized = value }, approve: (fn: typeof approval) => { approval = fn }, counts: () => ({ rendered, exported, created }), cleanup: async () => { await bridge.stop(); rmSync(root, { recursive: true, force: true }) } }
}

test('bridge never recreates a missing registered root when syncing', async () => {
  const f = fixture()
  try {
    await f.bridge.start()
    const missing = join(f.root, 'missing')
    assert.throws(() => f.bridge.syncProject({ id: 'missing', rootPath: missing } as never), /ENOENT/)
    assert.equal(existsSync(missing), false)
  } finally { await f.cleanup() }
})

test('bridge can initialize while locked but rejects RPC until authenticated and token-valid', async () => {
  const f = fixture()
  try {
    await f.bridge.start()
    assert.equal((await f.rpc('status')).status, 401)
    f.authorize(true)
    assert.equal((await f.rpc('status', {}, 'bad-token')).status, 401)
    const response = await f.rpc('status')
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ok, true)
    await f.bridge.stop()
    assert.equal(getBridgeEndpoint()?.token, '')
    assert.equal(f.bridge.isBusy(), false)
  } finally { await f.cleanup() }
})

test('authorization is checked again after approval before executing a script', async () => {
  const f = fixture()
  try {
    let resolveApproval!: (decision: { approved: boolean }) => void
    let signal!: () => void
    const requested = new Promise<void>((resolve) => { signal = resolve })
    f.approve(() => new Promise((resolve) => { resolveApproval = resolve; signal() }))
    await f.bridge.start(); f.authorize(true)
    const response = f.rpc('figs.render', { name: 'unsafe', code: 'print(1)' })
    await requested
    assert.equal(f.bridge.isBusy(), true)
    f.authorize(false)
    resolveApproval({ approved: true })
    assert.equal((await response).status, 400)
    assert.equal(f.counts().rendered, 0)
  } finally { await f.cleanup() }
})

test('structured figure CLI contract reads spec files and exports native pptx without running Python', async () => {
  const f = fixture()
  try {
    await f.bridge.start(); f.authorize(true)
    writeFileSync(join(f.root, 'spec.json'), JSON.stringify({ version: 1, kind: 'diagram', title: 'fixture', provenance: { sourceLabel: 'fixture', isDemo: true } }))
    const created = await f.rpc('figs.create', { specFile: 'spec.json', name: 'fixture' })
    assert.equal(created.status, 200)
    assert.equal((await created.json()).result.spec.kind, 'diagram')
    assert.equal((await f.rpc('figs.get', { id: 'fig-id' })).status, 200)
    assert.equal((await f.rpc('figs.update', { id: 'fig-id', specFile: 'spec.json' })).status, 200)
    assert.equal((await f.rpc('figs.export', { id: 'fig-id', format: 'pptx' })).status, 200)
    assert.equal((await f.rpc('figs.export', { id: 'fig-id', format: 'png' })).status, 400)
    assert.equal((await f.rpc('figs.create', { specFile: '../outside.json' })).status, 400)
    assert.deepEqual(f.counts(), { rendered: 0, exported: 1, created: 1 })
  } finally { await f.cleanup() }
})

test('external Crossref search is denied without an approval', async () => {
  const f = fixture()
  try {
    await f.bridge.start(); f.authorize(true)
    const result = await f.rpc('refs.search', { query: 'private unpublished project' })
    assert.equal(result.status, 400)
    assert.match((await result.json()).error, /拒绝/)
  } finally { await f.cleanup() }
})
