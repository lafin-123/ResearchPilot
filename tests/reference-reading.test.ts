import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Db } from '../src/main/lib/db'
import { ReferenceService } from '../src/main/services/references'
import { BridgeService } from '../src/main/services/bridge'
import { McpToolService } from '../src/main/services/mcp-tools'
import { referenceReadingPrompt } from '../src/shared/reference-reading'
import { isMcpAction, validateMcpArguments } from '../src/shared/mcp'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rp-reading-'))
  const file = join(root, 'account.sqlite'), db = new Db(file)
  for (const id of ['p', 'q']) {
    mkdirSync(join(root, id))
    db.run('INSERT INTO projects (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)', id, id, join(root, id), new Date().toISOString(), new Date().toISOString())
  }
  const refs = new ReferenceService(db)
  const ref = refs.upsert({ projectId: 'p', title: 'Registered study', abstract: 'The abstract reports a controlled comparison, without numerical results.', notes: 'Human judgment must survive.' })
  const input = () => ({ referenceId: ref.id, sourceHash: refs.getReadingSourceHash('p', ref.id), sourceCoverage: 'abstract-only' as const, content: `## 结果\n摘要未提供数值。 [reference:${ref.id}#abstract]` })
  return { root, file, db, refs, ref, input, cleanup() { db.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('AI reading drafts are separate, durable, source-versioned and never overwrite concurrent human notes', () => {
  const f = fixture()
  try {
    const input = f.input()
    f.refs.upsert({ ...f.ref, notes: 'Concurrent human edit' })
    assert.equal(f.refs.getReadingSourceHash('p', f.ref.id), input.sourceHash)
    const draft = f.refs.saveReadingDraft('p', input)
    assert.equal(draft.status, 'ai-draft')
    assert.equal(draft.sourceCoverage, 'abstract-only')
    assert.equal(draft.sourceChanged, false)
    assert.equal(draft.referenceId, f.ref.id)
    assert.ok(Date.parse(draft.createdAt))
    assert.equal(f.refs.get('p', f.ref.id).notes, 'Concurrent human edit')
    const reopened = new Db(f.file)
    try { assert.deepEqual(new ReferenceService(reopened).getReadingDraft('p', f.ref.id), draft) } finally { reopened.close() }
    const second = f.refs.saveReadingDraft('p', { ...input, content: 'Second bounded draft' })
    assert.equal(f.refs.getReadingDraft('p', f.ref.id)?.id, second.id)
    f.refs.upsert({ ...f.refs.get('p', f.ref.id), abstract: 'Updated abstract' })
    assert.equal(f.refs.getReadingDraft('p', f.ref.id)?.sourceChanged, true)
    assert.throws(() => f.refs.saveReadingDraft('p', input), /已变化/)
    assert.equal(f.refs.get('p', f.ref.id).notes, 'Concurrent human edit')
    f.refs.delete('p', f.ref.id)
    assert.equal(f.db.get<{ count: number }>('SELECT count(*) AS count FROM reference_reading_drafts')?.count, 0)
  } finally { f.cleanup() }
})

test('reading draft save and read reject cross-project, missing abstract, wrong coverage and unbounded data', () => {
  const f = fixture()
  try {
    assert.throws(() => f.refs.getReadingDraft('q', f.ref.id), /不存在/)
    assert.throws(() => f.refs.saveReadingDraft('q', f.input()), /不存在/)
    const empty = f.refs.upsert({ projectId: 'p', title: 'PDF only', notes: 'A manual note is not an abstract.' })
    assert.throws(() => f.refs.saveReadingDraft('p', { ...f.input(), referenceId: empty.id, sourceHash: f.refs.getReadingSourceHash('p', empty.id) }), /暂无摘要/)
    assert.throws(() => f.refs.saveReadingDraft('p', { ...f.input(), sourceCoverage: 'full-text' as never }), /abstract-only/)
    for (const content of ['', ' ', '\0', 'x'.repeat(40_001)]) assert.throws(() => f.refs.saveReadingDraft('p', { ...f.input(), content }), /内容/)
    assert.equal(f.refs.getReadingDraft('p', f.ref.id), null)
  } finally { f.cleanup() }
})

test('native read reports honest abstract coverage/hash and explicit prompt refuses empty inputs', async () => {
  const f = fixture()
  try {
    const tools = new McpToolService({ references: f.refs, projects: { get: () => ({ rootPath: join(f.root, 'p') }) } } as never)
    const read = await tools.call('evidence', 'reference_read', { id: f.ref.id }, 'p', new AbortController().signal) as Record<string, unknown>
    assert.equal(read.readingSourceHash, f.input().sourceHash)
    assert.equal(read.sourceCoverage, 'abstract-only')
    assert.equal(read.abstractLocator, `reference:${f.ref.id}#abstract`)
    const prompt = referenceReadingPrompt(f.ref)
    assert.match(prompt, /reference_read/)
    assert.match(prompt, /reference_save_reading_draft/)
    assert.match(prompt, /abstract-only/)
    assert.match(prompt, /待阅读全文核实/)
    assert.match(prompt, /不作为论文证据/)
    assert.throws(() => referenceReadingPrompt({ ...f.ref, abstract: ' ' }), /暂无摘要/)
    assert.equal(isMcpAction('evidence', 'reference_save_reading_draft'), true)
    assert.throws(() => validateMcpArguments('writing', 'reference_save_reading_draft', f.input()), /不属于/)
    assert.throws(() => validateMcpArguments('evidence', 'reference_save_reading_draft', { ...f.input(), modelLabel: 'invented model' }), /不支持参数/)
  } finally { f.cleanup() }
})

test('authenticated scoped MCP save requires approval and rechecks source and authorization after approval', async () => {
  const f = fixture()
  let authorized = true, approvalCalls = 0
  let approve = async () => ({ approved: false })
  const bridge = new BridgeService(
    { list: () => [], get: (id: string) => ({ id, name: id, rootPath: join(f.root, id) }) } as never,
    {} as never, f.refs, {} as never, {} as never, {} as never, {} as never,
    { request: () => { approvalCalls++; return approve() }, cancelAll: () => {} } as never,
    {} as never, {} as never, () => authorized
  )
  try {
    await bridge.start()
    const grant = bridge.issueMcpGrant('p', 'evidence')
    const call = (args = f.input(), token = grant.token) => fetch(grant.url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'reference_save_reading_draft', params: args, projectId: 'p', serverId: 'evidence' }) })
    assert.equal((await call(f.input(), 'invalid')).status, 401)
    assert.equal(approvalCalls, 0)
    assert.equal((await call()).status, 400)
    assert.equal(approvalCalls, 1)
    assert.equal(f.refs.getReadingDraft('p', f.ref.id), null)
    approve = async () => { f.refs.upsert({ ...f.refs.get('p', f.ref.id), notes: 'Edited while approval is open' }); return { approved: true } }
    assert.equal((await call()).status, 200)
    assert.equal(f.refs.get('p', f.ref.id).notes, 'Edited while approval is open')
    const saved = f.refs.getReadingDraft('p', f.ref.id)!
    approve = async () => { f.refs.upsert({ ...f.refs.get('p', f.ref.id), abstract: 'Source changed while approval open' }); return { approved: true } }
    assert.equal((await call()).status, 400)
    assert.equal(f.refs.getReadingDraft('p', f.ref.id)?.id, saved.id)
    approve = async () => { authorized = false; return { approved: true } }
    assert.equal((await call()).status, 400)
    assert.equal(f.refs.getReadingDraft('p', f.ref.id)?.id, saved.id)
  } finally { await bridge.stop(); f.cleanup() }
})
