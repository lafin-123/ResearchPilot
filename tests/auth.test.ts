import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalSessionService, type LocalWorkspaceScope, type LocalSessionLifecycle } from '../src/main/services/auth'
import type { AuthStatus } from '../src/shared/auth'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(overrides: Partial<LocalSessionLifecycle> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'researchpilot-local-session-'))
  const data = join(root, 'profile')
  const workspace = join(root, 'workspace')
  const scopes: LocalWorkspaceScope[] = []
  const changes: AuthStatus[] = []
  const lifecycle: LocalSessionLifecycle = {
    async activate(scope) { scopes.push(scope) },
    async deactivate() {},
    changed(status) { changes.push(status) },
    ...overrides
  }
  const session = new LocalSessionService(data, workspace, lifecycle)
  return { session, scopes, changes, root, data, workspace, lifecycle, async cleanup() { try { await session.close() } finally { rmSync(root, { force: true, recursive: true }) } } }
}

test('fresh startup needs no credentials or accounts file; readiness exposes only a stable workspace identity', async () => {
  const f = fixture()
  try {
    assert.deepEqual(f.session.status(), { ready: false, user: null, mode: 'local' })
    assert.throws(() => f.session.authorize(), /尚未就绪/)
    const status = await f.session.initialize()
    assert.deepEqual(status, { ready: true, user: { id: 'local-default', name: '本地工作区' }, mode: 'local' })
    assert.deepEqual(f.scopes, [{ user: status.user, dataRoot: f.data, databasePath: join(f.data, 'researchpilot.db'), workspaceRoot: f.workspace }])
    assert.equal(existsSync(join(f.data, 'accounts.sqlite')), false)
    assert.deepEqual(readdirSync(f.root), [])
    for (const method of ['register', 'login', 'logout', 'changePassword']) assert.equal(method in f.session, false)
    status.user!.id = 'renderer-mutated'
    assert.equal(f.session.status().user?.id, 'local-default')
  } finally { await f.cleanup() }
})

test('legacy database, account metadata sidecars, and subaccount directories remain byte-for-byte untouched', async () => {
  const f = fixture()
  mkdirSync(join(f.data, 'accounts', 'secondary'), { recursive: true })
  mkdirSync(join(f.workspace, 'accounts', 'secondary'), { recursive: true })
  // Even invalid metadata is ignored: startup neither opens nor repairs the retired account database.
  const files = new Map([
    [join(f.data, 'researchpilot.db'), 'legacy database sentinel'],
    [join(f.data, 'accounts.sqlite'), 'do not open account metadata'],
    [join(f.data, 'accounts.sqlite-wal'), 'legacy account WAL'],
    [join(f.data, 'accounts.sqlite-shm'), 'legacy account SHM'],
    [join(f.data, 'accounts', 'secondary', 'researchpilot.db'), 'secondary private database'],
    [join(f.workspace, 'manuscript.txt'), 'original manuscript'],
    [join(f.workspace, 'accounts', 'secondary', 'manuscript.txt'), 'secondary private manuscript']
  ])
  for (const [path, content] of files) writeFileSync(path, content)
  try {
    await f.session.initialize()
    assert.equal(f.scopes[0]!.dataRoot, f.data)
    assert.equal(f.scopes[0]!.workspaceRoot, f.workspace)
    await f.session.close()
    for (const [path, content] of files) assert.equal(readFileSync(path, 'utf8'), content)
    assert.deepEqual(readdirSync(join(f.data, 'accounts')), ['secondary'])
    assert.deepEqual(readdirSync(join(f.workspace, 'accounts')), ['secondary'])
  } finally { await f.cleanup() }
})

test('a fresh process reopens the same original database and preserves saved data without login', async () => {
  const f = fixture()
  let database: DatabaseSync | null = null
  f.lifecycle.activate = async (scope) => {
    mkdirSync(scope.dataRoot, { recursive: true })
    database = new DatabaseSync(scope.databasePath)
    database.exec('CREATE TABLE IF NOT EXISTS notes (body TEXT)')
  }
  f.lifecycle.deactivate = async () => { database?.close(); database = null }
  let restarted: LocalSessionService | null = null
  try {
    const first = await f.session.initialize()
    database!.prepare('INSERT INTO notes VALUES (?)').run('retained research')
    await f.session.close()
    restarted = new LocalSessionService(f.data, f.workspace, f.lifecycle)
    assert.equal(restarted.isAuthorized(), false)
    const second = await restarted.initialize()
    assert.equal(second.user!.id, first.user!.id)
    assert.equal((database!.prepare('SELECT body FROM notes').get() as { body: string }).body, 'retained research')
    assert.equal(existsSync(join(f.data, 'accounts.sqlite')), false)
  } finally { await restarted?.close(); await f.cleanup() }
})

test('concurrent initialization shares one activation and authorization waits for every startup step', async () => {
  const started = deferred()
  const finish = deferred()
  let activations = 0
  const f = fixture({ async activate() { activations += 1; started.resolve(); await finish.promise } })
  try {
    const first = f.session.initialize()
    const second = f.session.initialize()
    assert.equal(first, second)
    await started.promise
    assert.equal(f.session.isAuthorized(), false)
    assert.throws(() => f.session.authorize(), /尚未就绪/)
    finish.resolve()
    assert.equal((await first).ready, true)
    assert.equal((await second).ready, true)
    await f.session.initialize()
    assert.equal(activations, 1)
    assert.equal(f.changes.length, 1)
  } finally { finish.resolve(); await f.cleanup() }
})

test('revocation immediately denies new work; teardown drains async leases and release is idempotent', async () => {
  const operation = deferred()
  let deactivated = false
  const f = fixture({ async deactivate() { deactivated = true } })
  try {
    await f.session.initialize()
    const release = f.session.authorize()
    const pending = (async () => { try { await operation.promise } finally { release(); release() } })()
    const closing = f.session.close()
    assert.equal(closing, f.session.close())
    assert.equal(f.session.status().ready, false)
    assert.equal(f.session.status().user, null)
    assert.throws(() => f.session.authorize(), /正在关闭/)
    await Promise.resolve()
    assert.equal(deactivated, false)
    operation.resolve()
    await pending
    await closing
    assert.equal(deactivated, true)
    await assert.rejects(f.session.initialize(), /已关闭/)
  } finally { operation.resolve(); await f.cleanup() }
})

test('close during initialization cannot resurrect authorization and waits to tear down the opening workspace', async () => {
  const started = deferred()
  const finish = deferred()
  let deactivated = false
  const f = fixture({
    async activate() { started.resolve(); await finish.promise },
    async deactivate() { deactivated = true }
  })
  try {
    const opening = f.session.initialize()
    const rejected = assert.rejects(opening, /初始化已取消/)
    await started.promise
    const closing = f.session.close()
    assert.equal(f.session.isAuthorized(), false)
    assert.equal(deactivated, false)
    finish.resolve()
    await rejected
    await closing
    assert.equal(deactivated, true)
    assert.equal(f.session.isAuthorized(), false)
    assert.ok(f.changes.every((status) => !status.ready))
  } finally { finish.resolve(); await f.cleanup() }
})

test('failed initialization stays revoked and permits safe partial cleanup without an account retry', async () => {
  let cleaned = false
  const f = fixture({
    async activate() { throw new Error('cannot open original workspace') },
    async deactivate() { cleaned = true }
  })
  try {
    await assert.rejects(f.session.initialize(), /cannot open original workspace/)
    assert.equal(f.session.status().ready, false)
    assert.throws(() => f.session.authorize(), /尚未就绪/)
    await assert.rejects(f.session.initialize(), /已关闭/)
    await f.session.close()
    assert.equal(cleaned, true)
  } finally { await f.cleanup() }
})

test('failed teardown never restores authorization', async () => {
  const f = fixture({ async deactivate() { throw new Error('shutdown failure') } })
  try {
    await f.session.initialize()
    await assert.rejects(f.session.close(), /shutdown failure/)
    assert.equal(f.session.isAuthorized(), false)
    assert.throws(() => f.session.authorize(), /正在关闭/)
    await assert.rejects(f.session.initialize(), /已关闭/)
  } finally { await f.cleanup().catch(() => undefined) }
})

test('revoking before the activation microtask prevents initialization entirely', async () => {
  const f = fixture()
  try {
    const opening = f.session.initialize()
    f.session.revoke()
    await assert.rejects(opening, /初始化已取消/)
    assert.equal(f.scopes.length, 0)
    assert.equal(f.session.status().ready, false)
  } finally { await f.cleanup() }
})
