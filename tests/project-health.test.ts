import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Project } from '../src/shared/types'
import { ProjectHealthService, assertProjectRootAvailable } from '../src/main/services/project-health'
import { BridgeService } from '../src/main/services/bridge'
import { getBridgeEndpoint } from '../src/main/lib/bridge-state'

function project(id: string, rootPath: string): Project {
  return { id, name: id, rootPath, description: '', archived: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'research-project-health-'))
  const healthy = project('healthy', join(root, 'healthy'))
  const missing = project('missing', join(root, 'missing'))
  const notDirectory = project('file', join(root, 'file'))
  const denied = project('denied', join(root, 'denied'))
  mkdirSync(healthy.rootPath)
  mkdirSync(denied.rootPath)
  writeFileSync(notDirectory.rootPath, 'not a directory')
  const entries = [missing, notDirectory, denied, healthy]
  const projects = { list: () => entries, get: (id: string) => { const found = entries.find(p => p.id === id); if (!found) throw new Error('unknown project'); return found } }
  return { root, healthy, missing, notDirectory, denied, projects, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('startup isolates unavailable roots and prepare errors without recreating a registered missing root', () => {
  const f = fixture()
  try {
    const prepared: string[] = []
    const service = new ProjectHealthService(f.projects, p => {
      prepared.push(p.id)
      if (p.id === 'denied') throw Object.assign(new Error('read-only project'), { code: 'EACCES' })
      mkdirSync(join(p.rootPath, '.research'))
    })
    const results = service.initializeAll()
    assert.deepEqual(prepared, ['denied', 'healthy'])
    assert.equal(results.find(p => p.projectId === 'missing')?.error?.code, 'ENOENT')
    assert.equal(results.find(p => p.projectId === 'file')?.error?.code, 'ENOTDIR')
    assert.equal(results.find(p => p.projectId === 'denied')?.error?.code, 'EACCES')
    assert.equal(results.find(p => p.projectId === 'healthy')?.available, true)
    assert.equal(existsSync(f.missing.rootPath), false)
    assert.equal(existsSync(join(f.healthy.rootPath, '.research')), true)
    assert.equal(f.projects.get('missing').rootPath, f.missing.rootPath)
  } finally { f.cleanup() }
})

test('health list never invokes repair and preserves callback errors until an explicit successful retry', () => {
  const f = fixture()
  try {
    let deny = true, calls = 0
    const service = new ProjectHealthService(f.projects, () => {
      calls++
      if (deny) throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
    })
    service.initializeAll()
    const before = calls
    assert.equal(service.list().find(p => p.projectId === 'healthy')?.error?.code, 'EPERM')
    assert.equal(calls, before)
    assert.throws(() => service.assertAvailable('healthy'), error => error instanceof Error && error.message.includes('EPERM') && error.message.includes(f.healthy.rootPath))
    deny = false
    assert.equal(service.retry('healthy').available, true)
    assert.doesNotThrow(() => service.assertAvailable('healthy'))
    assert.equal(service.retry('missing').error?.code, 'ENOENT')
    assert.equal(existsSync(f.missing.rootPath), false)
    mkdirSync(f.missing.rootPath)
    assert.equal(service.retry('missing').available, true)
    rmSync(f.healthy.rootPath, { recursive: true })
    assert.equal(service.list().find(p => p.projectId === 'healthy')?.error?.code, 'ENOENT')
    assert.throws(() => service.assertAvailable('healthy'), /ENOENT/)
    assert.throws(() => service.retry('unknown'), /unknown project/)
  } finally { f.cleanup() }
})

test('root validation rejects directory links and linked ancestors without following them', () => {
  const f = fixture()
  try {
    const linked = join(f.root, 'linked')
    symlinkSync(f.healthy.rootPath, linked, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => assertProjectRootAvailable(project('link', linked)), /ELOOP/)
    mkdirSync(join(f.healthy.rootPath, 'child'))
    assert.throws(() => assertProjectRootAvailable(project('child', join(linked, 'child'))), /ELOOP/)
    assert.equal(existsSync(join(f.healthy.rootPath, '.research')), false)
  } finally { f.cleanup() }
})

test('bridge startup reports per-project failures and still syncs healthy projects', async () => {
  const f = fixture()
  // A malformed managed directory simulates a write failure deterministically on Windows too.
  writeFileSync(join(f.denied.rootPath, '.research'), 'blocked')
  const health = new ProjectHealthService(f.projects, () => {})
  health.initializeAll()
  const bridge = new BridgeService(f.projects as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, { cancelAll: () => {} } as never, {} as never, {} as never, () => true, health)
  try {
    const results = await bridge.start()
    assert.equal(results.find(p => p.projectId === 'healthy')?.ok, true)
    assert.equal(results.find(p => p.projectId === 'missing')?.error?.code, 'ENOENT')
    assert.equal(results.find(p => p.projectId === 'file')?.ok, false)
    assert.equal(results.find(p => p.projectId === 'denied')?.ok, false)
    assert.equal(existsSync(f.missing.rootPath), false)
    const config = JSON.parse(readFileSync(join(f.healthy.rootPath, '.research', 'bridge.json'), 'utf8'))
    assert.equal(config.projectId, 'healthy')
    assert.equal(typeof config.port, 'number')
    assert.throws(() => bridge.syncProject(f.missing), /ENOENT/)
    assert.equal(health.list().find(p => p.projectId === 'denied')?.available, false)
    assert.equal(bridge.syncAllProjects().find(p => p.projectId === 'healthy')?.ok, true)
  } finally { await bridge.stop(); f.cleanup() }
})

test('bridge mutations fail closed on missing or unhealthy roots while metadata remains readable', async () => {
  const f = fixture()
  const health = new ProjectHealthService(f.projects, () => {})
  health.initializeAll()
  let writes = 0, approvals = 0
  const figures = { list: () => [], render: async () => { writes++; return {} } }
  const bridge = new BridgeService(f.projects as never, { list: () => [] } as never, { list: () => [] } as never, { list: () => [] } as never, { runningCount: () => 0 } as never, figures as never, {} as never, { request: async () => { approvals++; return { approved: true } }, cancelAll: () => {} } as never, {} as never, {} as never, () => true, health)
  const rpc = async (projectId: string, method: string, params: Record<string, unknown> = {}) => {
    const endpoint = getBridgeEndpoint()!
    const response = await fetch(`${endpoint.url}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, method, params }) })
    return { status: response.status, body: await response.json() }
  }
  try {
    await bridge.start()
    assert.equal((await rpc('missing', 'status')).status, 200)
    assert.equal((await rpc('missing', 'figs.list')).status, 200)
    const missing = await rpc('missing', 'figs.render', { name: 'blocked', code: 'print(1)' })
    assert.equal(missing.status, 400)
    assert.match(missing.body.error, /ENOENT/)
    assert.equal(writes, 0)
    assert.equal(approvals, 0)
    assert.equal(existsSync(f.missing.rootPath), false)
    health.recordFailure(f.healthy, Object.assign(new Error('read-only fixture'), { code: 'EACCES' }))
    assert.equal((await rpc('healthy', 'figs.render', { name: 'blocked', code: 'print(1)' })).status, 400)
    health.retry('healthy')
    assert.equal((await rpc('healthy', 'figs.render', { name: 'allowed', code: 'print(1)' })).status, 200)
    assert.equal(writes, 1)
    const grant = bridge.issueMcpGrant('missing', 'artifacts')
    const metadata = await fetch(grant.url, { method: 'POST', headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'missing', serverId: 'artifacts', tool: 'figure_list', params: {} }) })
    assert.equal(metadata.status, 200)
    const response = await fetch(grant.url, { method: 'POST', headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'missing', serverId: 'artifacts', tool: 'project_artifact_write', params: { path: 'exports/draft.md', content: 'draft' } }) })
    assert.equal(response.status, 400)
    assert.equal(approvals, 1)
    assert.equal(existsSync(f.missing.rootPath), false)
  } finally { await bridge.stop(); f.cleanup() }
})

test('bridge rechecks availability after RPC and MCP approval before any write', async () => {
  const f = fixture()
  let writes = 0
  const figures = { list: () => [], render: async () => { writes++; return {} } }
  const health = new ProjectHealthService(f.projects, () => {})
  health.initializeAll()
  const bridge = new BridgeService(f.projects as never, {} as never, {} as never, {} as never, {} as never, figures as never, {} as never, { request: async () => { rmSync(f.healthy.rootPath, { recursive: true }); return { approved: true } }, cancelAll: () => {} } as never, {} as never, {} as never, () => true, health)
  try {
    await bridge.start()
    const endpoint = getBridgeEndpoint()!
    const rpc = await fetch(`${endpoint.url}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'healthy', method: 'figs.render', params: { name: 'blocked', code: 'print(1)' } }) })
    assert.equal(rpc.status, 400)
    assert.equal(writes, 0)
    assert.equal(existsSync(f.healthy.rootPath), false)
    mkdirSync(f.healthy.rootPath)
    assert.equal(health.retry('healthy').available, true)
    const grant = bridge.issueMcpGrant('healthy', 'artifacts')
    const mcp = await fetch(grant.url, { method: 'POST', headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'healthy', serverId: 'artifacts', tool: 'project_artifact_write', params: { path: 'exports/draft.md', content: 'draft' } }) })
    assert.equal(mcp.status, 400)
    assert.equal(existsSync(f.healthy.rootPath), false)
  } finally { await bridge.stop(); f.cleanup() }
})

test('RPC propagates availability guards into delayed document and DOI service writes', async () => {
  const f = fixture()
  const health = new ProjectHealthService(f.projects, () => {})
  health.initializeAll()
  let writes = 0
  const delayedWrite = async (guard: (() => void) | undefined): Promise<object> => {
    rmSync(f.healthy.rootPath, { recursive: true })
    await Promise.resolve()
    guard?.()
    writes++
    return {}
  }
  const bridge = new BridgeService(f.projects as never, { create: (_input: unknown, guard?: () => void) => delayedWrite(guard) } as never, { addFromDoi: (_id: string, _doi: string, _signal?: AbortSignal, guard?: () => void) => delayedWrite(guard) } as never, {} as never, {} as never, {} as never, {} as never, { request: async () => ({ approved: true }), cancelAll: () => {} } as never, {} as never, {} as never, () => true, health)
  try {
    await bridge.start()
    const endpoint = getBridgeEndpoint()!
    for (const [method, params] of [['docs.create', { title: 'blocked' }], ['refs.add', { doi: '10.1000/fixture' }]] as const) {
      const response = await fetch(`${endpoint.url}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'healthy', method, params }) })
      assert.equal(response.status, 400)
      assert.equal(writes, 0)
      assert.equal(existsSync(f.healthy.rootPath), false)
      mkdirSync(f.healthy.rootPath)
      assert.equal(health.retry('healthy').available, true)
    }
  } finally { await bridge.stop(); f.cleanup() }
})

test('generic agent execution approvals recheck project availability before granting permission', async () => {
  const f = fixture()
  const health = new ProjectHealthService(f.projects, () => {})
  health.initializeAll()
  let approvals = 0
  const bridge = new BridgeService(f.projects as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, { request: async () => { approvals++; rmSync(f.healthy.rootPath, { recursive: true }); return { approved: true } }, cancelAll: () => {} } as never, {} as never, {} as never, () => true, health)
  const approve = async (projectId: string) => {
    const endpoint = getBridgeEndpoint()!
    return fetch(`${endpoint.url}/agent/approval`, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, toolName: 'bash', reason: 'write fixture output' }) })
  }
  try {
    await bridge.start()
    assert.equal((await approve('missing')).status, 400)
    assert.equal(approvals, 0)
    const delayed = await approve('healthy')
    assert.equal(delayed.status, 400)
    assert.equal((await delayed.json()).ok, false)
    assert.equal(approvals, 1)
    assert.equal(existsSync(f.healthy.rootPath), false)
  } finally { await bridge.stop(); f.cleanup() }
})

test('managed initialization and bridge sync reject hardlinked output files without modifying their other names', async () => {
  const f = fixture()
  const target = join(f.root, 'outside-config.json')
  writeFileSync(target, 'original')
  mkdirSync(join(f.healthy.rootPath, '.research'))
  linkSync(target, join(f.healthy.rootPath, '.research', 'bridge.json'))
  let prepared = false
  const health = new ProjectHealthService(f.projects, () => { prepared = true })
  const bridge = new BridgeService({ list: () => [], get: f.projects.get } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, { cancelAll: () => {} } as never, {} as never, {} as never)
  try {
    assert.equal(health.retry('healthy').error?.code, 'EMLINK')
    assert.equal(prepared, false)
    await bridge.start()
    assert.throws(() => bridge.syncProject(f.healthy), /EMLINK/)
    assert.equal(readFileSync(target, 'utf8'), 'original')
  } finally { await bridge.stop(); f.cleanup() }
})

test('bridge refuses linked metadata directory or config file rather than writing outside the project', async () => {
  const f = fixture()
  const outside = join(f.root, 'outside')
  mkdirSync(outside)
  const bridge = new BridgeService({ list: () => [], get: f.projects.get } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, { cancelAll: () => {} } as never, {} as never, {} as never)
  try {
    await bridge.start()
    symlinkSync(outside, join(f.healthy.rootPath, '.research'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => bridge.syncProject(f.healthy), /ELOOP/)
    assert.equal(existsSync(join(outside, 'bridge.json')), false)
    rmSync(join(f.healthy.rootPath, '.research'), { recursive: true })
    mkdirSync(join(f.healthy.rootPath, '.research'))
    const target = join(outside, 'bridge.json')
    writeFileSync(target, 'original')
    // File symlinks require elevated privileges on Windows; exercise a directory junction
    // at the config path there, which must be rejected by the same lstat check.
    symlinkSync(process.platform === 'win32' ? outside : target, join(f.healthy.rootPath, '.research', 'bridge.json'), process.platform === 'win32' ? 'junction' : 'file')
    assert.throws(() => bridge.syncProject(f.healthy), /ELOOP/)
    assert.equal(readFileSync(target, 'utf8'), 'original')
  } finally { await bridge.stop(); f.cleanup() }
})
