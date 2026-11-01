import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Db } from '../src/main/lib/db'
import { BackupService } from '../src/main/services/backups'
import { BACKUP_LIMITS } from '../src/shared/backups'
import { NoteService } from '../src/main/services/notes'
import { noteLink } from '../src/shared/notes'

const stamp = '2026-10-24T10:00:00.000Z'
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rp-backup-test-'))
  const workspace = join(dir, 'workspace'); mkdirSync(workspace)
  const root = join(workspace, 'source'); mkdirSync(root)
  const db = new Db(join(dir, 'test.sqlite'))
  db.run('INSERT INTO projects (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)', 'proj_source', '研究项目', root, stamp, stamp)
  db.run('INSERT INTO projects (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)', 'proj_other', 'Other project', join(workspace, 'other'), stamp, stamp)
  let busy = false
  const service = new BackupService(db, { workspaceRoot: () => workspace, assertIdle: () => { if (busy) throw new Error('busy secret /private/path') } })
  const file = (path: string, content = `research file ${path}`) => { const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, content); return full }
  return { dir, workspace, root, db, service, file, setBusy: (v: boolean) => { busy = v }, cleanup() { db.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) } }
}
function richFixture() {
  const f = fixture()
  const insert = (table: string, row: Record<string, string | number | null>) => f.db.run(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, ...Object.values(row))
  const times = { created_at: stamp, updated_at: stamp }
  insert('documents', { id: 'doc_a', project_id: 'proj_source', title: 'Paper', format: 'latex', file_name: 'paper.tex', relative_path: 'manuscripts/paper.tex', ...times })
  f.file('manuscripts/paper.tex', 'original manuscript')
  insert('document_versions', { id: 'ver_a', document_id: 'doc_a', label: 'before edit', relative_path: '.research/history/doc_a/version.tex', size: 15, created_at: stamp })
  f.file('.research/history/doc_a/version.tex', 'older manuscript')
  insert('reference_items', { id: 'ref_a', project_id: 'proj_source', title: 'Source evidence', pdf_relative_path: 'references/paper.pdf', notes: 'Carefully read', ...times })
  f.file('references/paper.pdf', '%PDF synthetic fixture, not parsed by backup')
  insert('reference_items', { id: 'ref_other', project_id: 'proj_other', title: 'OTHER-PROJECT-SECRET', ...times })
  insert('reference_reading_drafts', { id: 'draft_a', project_id: 'proj_source', reference_id: 'ref_a', source_hash: 'a'.repeat(64), source_coverage: 'abstract-only', content: 'Reading interpretation', model_label: 'original model provenance', created_at: stamp })
  insert('pdf_annotations', { id: 'ann_a', project_id: 'proj_source', reference_id: 'ref_a', fingerprint: 'b'.repeat(64), page: 2, quote: 'Important result', comment: 'Check confidence interval', color: 'yellow', rects_json: '[{"x":0.1,"y":0.2,"width":0.3,"height":0.1}]', ...times })
  insert('reference_activity', { id: 'activity_a', project_id: 'proj_source', reference_id: 'ref_a', title: 'Source evidence', kind: 'read', created_at: stamp })
  insert('experiments', { id: 'exp_a', project_id: 'proj_source', name: 'Baseline', entry_file: 'experiments/baseline/main.py', env_kind: 'ssh', ssh_host_id: 'ssh_sensitive', status: 'succeeded', last_run_id: 'run_a', ...times })
  f.file('experiments/baseline/main.py', 'raise Exception("must never run during restore")')
  f.file('experiments/baseline/runs/run_a/result.csv', 'metric,value\naccuracy,0.9')
  insert('experiment_runs', { id: 'run_a', experiment_id: 'exp_a', project_id: 'proj_source', status: 'succeeded', exit_code: 0, command: 'SECRET-COMMAND', started_at: stamp, finished_at: stamp, stdout: 'SECRET-STDOUT', stderr: 'SECRET-STDERR', metrics_json: '{"accuracy":0.9}', artifact_dir: 'experiments/baseline/runs/run_a', env_json: '{"KEY":"SECRET-ENV"}' })
  insert('figures', { id: 'fig_a', project_id: 'proj_source', experiment_id: 'exp_a', name: 'Accuracy', file_path: 'figures/chart/figure.svg', format: 'svg', created_at: stamp })
  f.file('figures/chart/figure.svg', '<svg></svg>')
  f.file('figures/chart/figure.pptx', 'synthetic editable-source fixture')
  f.file('figures/chart/figure.json', '{"sourceId":"run_a"}')
  const notes = new NoteService(f.db)
  const target = notes.create({ projectId: 'proj_source', title: 'Target', body: 'Persistent thought' })
  const source = notes.create({ projectId: 'proj_source', title: 'Source', body: noteLink(target.id, 'Link') })
  notes.trash('proj_source', target.id)
  f.file('data/results.csv')
  f.file('data/.env', 'SECRET-FILE-ENV')
  f.file('data/secrets.json', 'SECRET-FILE-JSON')
  f.file('data/settings.json', 'SECRET-SETTINGS')
  f.file('experiments/baseline/stdout.txt', 'SECRET-FILE-LOG')
  f.file('.research/bridge.json', 'SECRET-BRIDGE')
  f.file('.agents/skills/evil/SKILL.md', 'SECRET-SKILL')
  f.file('AGENTS.md', 'SECRET-ROOT-INSTRUCTIONS')
  insert('providers', { id: 'provider_a', name: 'Provider', kind: 'custom', protocol: 'openai', api_key_enc: 'SECRET-KEY', ...times })
  insert('chats', { id: 'chat_a', project_id: 'proj_source', title: 'SECRET-CHAT', dsh_session_id: 'SECRET-SESSION', ...times })
  insert('app_settings', { key: 'auth', value_json: '{"token":"SECRET-AUTH"}' })
  return { ...f, sourceNoteId: source.id, targetNoteId: target.id }
}
function exported(f: ReturnType<typeof fixture>, name = 'test.rpbackup') {
  const path = join(f.dir, name)
  f.service.exportProject('proj_source', path)
  return path
}
function mutate(path: string, fn: (manifest: any, metadata: any) => void, rehash = true) {
  const bytes = readFileSync(path)
  const length = bytes.readUInt32LE(8)
  const manifest = JSON.parse(bytes.subarray(12, 12 + length).toString())
  const metadata = JSON.parse(manifest.metadata)
  fn(manifest, metadata)
  manifest.metadata = JSON.stringify(metadata)
  if (rehash) manifest.metadataSha256 = hash(manifest.metadata)
  const body = Buffer.from(JSON.stringify(manifest))
  const header = Buffer.alloc(12); bytes.copy(header, 0, 0, 8); header.writeUInt32LE(body.length, 8)
  writeFileSync(path, Buffer.concat([header, body, bytes.subarray(12 + length)]))
}

test('real roundtrip preserves research assets and remaps all relational IDs without overwriting originals', () => {
  const f = richFixture()
  try {
    const path = exported(f)
    const text = readFileSync(path).toString()
    for (const secret of ['SECRET-', 'OTHER-PROJECT-SECRET', f.root.replaceAll('\\', '\\\\')]) assert.ok(!text.includes(secret), `leaked ${secret}`)
    const preview = f.service.inspect(path)
    assert.equal(preview.projectName, '研究项目')
    assert.equal(preview.counts.pdf_annotations, 1)
    assert.equal(preview.counts.reference_reading_drafts, 1)
    assert.equal(preview.counts.document_versions, 1)
    assert.ok(preview.warnings.some(w => w.includes('未加密')))
    const restored = f.service.restoreCopy(preview.token)
    assert.notEqual(restored.projectId, 'proj_source')
    assert.notEqual(restored.rootPath, f.root)
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM projects'), 3)
    const doc = f.db.get<any>('SELECT * FROM documents WHERE project_id = ?', restored.projectId)!
    assert.notEqual(doc.id, 'doc_a')
    assert.equal(readFileSync(join(restored.rootPath, doc.relative_path), 'utf8'), 'original manuscript')
    const version = f.db.get<any>('SELECT * FROM document_versions WHERE document_id = ?', doc.id)!
    assert.equal(readFileSync(join(restored.rootPath, version.relative_path), 'utf8'), 'older manuscript')
    const ref = f.db.get<any>('SELECT * FROM reference_items WHERE project_id = ?', restored.projectId)!
    for (const table of ['reference_reading_drafts', 'pdf_annotations', 'reference_activity']) assert.equal(f.db.get<any>(`SELECT * FROM ${table} WHERE project_id = ?`, restored.projectId)!.reference_id, ref.id)
    const exp = f.db.get<any>('SELECT * FROM experiments WHERE project_id = ?', restored.projectId)!
    assert.equal(exp.status, 'idle'); assert.equal(exp.env_kind, 'local'); assert.equal(exp.ssh_host_id, ''); assert.equal(exp.last_run_id, '')
    const run = f.db.get<any>('SELECT * FROM experiment_runs WHERE project_id = ?', restored.projectId)!
    assert.equal(run.experiment_id, exp.id); assert.equal(run.metrics_json, '{"accuracy":0.9}'); assert.equal(run.env_json, '{}'); assert.equal(run.command, '')
    const figure = f.db.get<any>('SELECT * FROM figures WHERE project_id = ?', restored.projectId)!
    assert.equal(figure.experiment_id, exp.id)
    assert.ok(existsSync(join(restored.rootPath, 'figures/chart/figure.pptx')))
    assert.equal(readFileSync(join(restored.rootPath, 'figures/chart/figure.json'), 'utf8'), '{"sourceId":"run_a"}')
    const notes = f.db.all<any>('SELECT * FROM project_notes WHERE project_id = ?', restored.projectId)
    const source = notes.find(n => n.title === 'Source')!; const target = notes.find(n => n.title === 'Target')!
    assert.equal(source.body, noteLink(target.id, 'Link'))
    assert.notEqual(target.deleted_at, null)
    assert.equal(f.db.get<any>('SELECT * FROM note_links WHERE project_id = ?', restored.projectId)!.target_id, target.id)
    assert.equal(new NoteService(f.db).get('proj_source', f.sourceNoteId).body, noteLink(f.targetNoteId, 'Link'))
    assert.equal(readFileSync(join(f.root, 'manuscripts/paper.tex'), 'utf8'), 'original manuscript')
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM providers'), 1)
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM chats'), 1)
    assert.equal(existsSync(join(restored.rootPath, '.research/bridge.json')), false)
    assert.throws(() => f.service.restoreCopy(preview.token), /预览已过期/)
    // Restored copies can themselves be exported and restored, including version files.
    const again = join(f.dir, 'again.rpbackup'); f.service.exportProject(restored.projectId, again)
    const second = f.service.restoreCopy(f.service.inspect(again).token)
    assert.notEqual(second.projectId, restored.projectId)
  } finally { f.cleanup() }
})

test('native destination is exclusive: existing files are never replaced', () => {
  const f = fixture()
  try {
    const path = join(f.dir, 'existing.rpbackup'); writeFileSync(path, 'KEEP EXISTING')
    assert.throws(() => f.service.exportProject('proj_source', path))
    assert.equal(readFileSync(path, 'utf8'), 'KEEP EXISTING')
  } finally { f.cleanup() }
})

test('missing registered files fail export rather than silently losing research assets', () => {
  const f = richFixture()
  try {
    rmSync(join(f.root, 'references/paper.pdf'))
    assert.throws(() => exported(f))
    assert.equal(existsSync(join(f.dir, 'test.rpbackup')), false)
  } finally { f.cleanup() }
})

test('checksums catch modified payload, metadata, truncation and trailing bytes', () => {
  for (const kind of ['payload', 'metadata', 'truncated', 'trailing']) {
    const f = fixture()
    try {
      f.file('data/measurement.txt', 'original measurement')
      const path = exported(f)
      if (kind === 'metadata') mutate(path, (_m, d) => { d.records.projects[0].name = 'tampered' }, false)
      else {
        const bytes = readFileSync(path)
        if (kind === 'payload') bytes[bytes.length - 1] ^= 1
        writeFileSync(path, kind === 'truncated' ? bytes.subarray(0, bytes.length - 1) : kind === 'trailing' ? Buffer.concat([bytes, Buffer.from('extra')]) : bytes)
      }
      assert.throws(() => f.service.inspect(path), undefined, kind)
      assert.equal(f.db.scalar('SELECT COUNT(*) FROM projects'), 2)
    } finally { f.cleanup() }
  }
})

test('untrusted manifests reject traversal, unsafe types, duplicate paths and wrong schema', () => {
  const attacks: Array<(m: any, d: any) => void> = [
    m => { m.files[0].path = '../escape.txt' },
    m => { m.files[0].path = 'data/../../escape.txt' },
    m => { m.files[0].path = 'data/C:\\escape.txt' },
    m => { m.files[0].path = 'data/.env' },
    m => { m.files[0].path = 'data/secret.json' },
    m => { m.files[0].path = 'data/AGENTS.md' },
    m => { m.files[0].path = 'data/run.exe' },
    m => { m.files[0].path = 'data/NUL.txt' },
    m => { m.files[0].size = 1e15 },
    m => { m.files.push(m.files[0]) },
    m => { m.version = 100 },
    (_m, d) => { d.records.providers = [] },
    (_m, d) => { d.records.projects[0].root_path = 'C:/target' },
    (_m, d) => { d.records.projects.push(d.records.projects[0]) }
  ]
  for (const attack of attacks) {
    const f = fixture()
    try {
      f.file('data/measurement.txt', 'measurement')
      const path = exported(f); mutate(path, attack)
      assert.throws(() => f.service.inspect(path))
      assert.deepEqual(readdirSync(f.workspace), ['source'])
    } finally { f.cleanup() }
  }
})

test('foreign project ownership and broken references are rejected even with a valid metadata checksum', () => {
  const f = richFixture()
  try {
    const path = exported(f)
    mutate(path, (_m, d) => { d.records.pdf_annotations[0].reference_id = 'ref_other' })
    assert.throws(() => f.service.inspect(path), /文献关系/)
  } finally { f.cleanup() }
})

test('changed archive after preview and expired/disposed tokens cannot restore', () => {
  const f = fixture()
  try {
    const path = exported(f)
    const preview = f.service.inspect(path)
    mutate(path, (_m, d) => { d.records.projects[0].name = 'Changed, valid checksum' })
    assert.throws(() => f.service.restoreCopy(preview.token), /预览后/)
    const p2 = f.service.inspect(path); f.service.dispose()
    assert.throws(() => f.service.restoreCopy(p2.token), /预览已过期/)
    const p3 = f.service.inspect(path)
    const now = Date.now; Date.now = () => now() + BACKUP_LIMITS.tokenLifetimeMs + 1
    try { assert.throws(() => f.service.restoreCopy(p3.token), /预览已过期/) } finally { Date.now = now }
  } finally { f.cleanup() }
})

test('restore database failure rolls back all rows and removes only newly created copy directory', () => {
  const f = richFixture()
  try {
    const path = exported(f)
    const preview = f.service.inspect(path)
    f.db.raw.exec("CREATE TRIGGER block_restore BEFORE INSERT ON pdf_annotations BEGIN SELECT RAISE(ABORT, 'SECRET-SQL-FAILURE'); END")
    assert.throws(() => f.service.restoreCopy(preview.token), error => error instanceof Error && !error.message.includes('SECRET-SQL'))
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM projects'), 2)
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM documents'), 1)
    assert.deepEqual(readdirSync(f.workspace), ['source'])
    assert.equal(readFileSync(join(f.root, 'manuscripts/paper.tex'), 'utf8'), 'original manuscript')
  } finally { f.cleanup() }
})

test('busy callback blocks export and restore and redacts unsafe errors', () => {
  const f = fixture()
  try {
    const path = exported(f)
    const preview = f.service.inspect(path)
    f.setBusy(true)
    assert.throws(() => f.service.exportProject('proj_source', join(f.dir, 'blocked.rpbackup')), error => error instanceof Error && !error.message.includes('private/path'))
    assert.throws(() => f.service.restoreCopy(preview.token))
    assert.deepEqual(readdirSync(f.workspace), ['source'])
  } finally { f.cleanup() }
})

test('hard links and directory junctions cannot export outside data', () => {
  const f = fixture()
  try {
    f.file('data/ordinary.txt')
    const secret = join(f.dir, 'outside.txt'); writeFileSync(secret, 'OUTSIDE-SECRET')
    const hard = join(f.root, 'data/hard.txt'); linkSync(secret, hard)
    assert.throws(() => exported(f))
    rmSync(hard)
    const outsideDir = join(f.dir, 'outside'); mkdirSync(outsideDir); writeFileSync(join(outsideDir, 'text.txt'), 'OUTSIDE-SECRET')
    symlinkSync(outsideDir, join(f.root, 'data/junction'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => exported(f))
  } finally { f.cleanup() }
})

test('manifest file and metadata record limits are enforced', () => {
  const f = fixture()
  try {
    const path = exported(f)
    mutate(path, m => { m.files = Array.from({ length: BACKUP_LIMITS.files + 1 }, (_, i) => ({ path: `data/${i}.txt`, size: 0, sha256: hash('') })) })
    assert.throws(() => f.service.inspect(path), /文件数量/)
    const other = exported(f, 'rows.rpbackup')
    mutate(other, (_m, d) => { d.records.reference_activity = Array.from({ length: BACKUP_LIMITS.rows + 1 }, () => ({})) })
    assert.throws(() => f.service.inspect(other), /记录数量/)
  } finally { f.cleanup() }
})

test('database running state blocks export even without a live runner callback', () => {
  const f = richFixture()
  try {
    f.db.run("UPDATE experiment_runs SET status = 'running' WHERE id = 'run_a'")
    assert.throws(() => exported(f), /实验正在运行/)
    assert.equal(existsSync(join(f.dir, 'test.rpbackup')), false)
  } finally { f.cleanup() }
})

test('restore refuses a linked destination workspace without writing outside it', () => {
  const f = fixture()
  try {
    const path = exported(f)
    const outside = join(f.dir, 'outside'); mkdirSync(outside)
    const linked = join(f.dir, 'linked-workspace'); symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const service = new BackupService(f.db, { workspaceRoot: () => linked, assertIdle: () => {} })
    assert.throws(() => service.restoreCopy(service.inspect(path).token), /链接|联接/)
    assert.deepEqual(readdirSync(outside), [])
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM projects'), 2)
  } finally { f.cleanup() }
})

test('oversized archives are rejected before allocating their payload', () => {
  const f = fixture()
  try {
    const path = join(f.dir, 'huge.rpbackup'); writeFileSync(path, 'RPBACK01'); truncateSync(path, BACKUP_LIMITS.bytes + 1)
    assert.throws(() => f.service.inspect(path), /过大/)
  } finally { f.cleanup() }
})
