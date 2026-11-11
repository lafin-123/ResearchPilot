import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { Db } from '../src/main/lib/db'
import { BackupService } from '../src/main/services/backups'
import { PaperContextService } from '../src/main/services/paper-context'
import { NoteService } from '../src/main/services/notes'
import { emptyPaperMemory, PAPER_CONTEXT_LIMITS, type PaperSource } from '../src/shared/paper-context'
import type { DocumentService } from '../src/main/services/documents'
import type { ReferenceService } from '../src/main/services/references'
import type { ExperimentService } from '../src/main/services/experiments'
import type { FigureService } from '../src/main/services/figures'

const stamp = '2026-11-07T10:00:00.000Z'
const paperTables = ['paper_memories', 'paper_context_sources', 'paper_context_active'] as const
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
function archive(path: string) {
  const bytes = readFileSync(path), length = bytes.readUInt32LE(8)
  const manifest = JSON.parse(bytes.subarray(12, 12 + length).toString())
  return { bytes, length, manifest, metadata: JSON.parse(manifest.metadata) }
}
function mutate(path: string, change: (manifest: any, records: any) => void) {
  const { bytes, length, manifest, metadata } = archive(path)
  change(manifest, metadata.records)
  manifest.metadata = JSON.stringify(metadata); manifest.metadataSha256 = hash(manifest.metadata)
  const body = Buffer.from(JSON.stringify(manifest)), header = Buffer.from(bytes.subarray(0, 12))
  header.writeUInt32LE(body.length, 8)
  writeFileSync(path, Buffer.concat([header, body, bytes.subarray(12 + length)]))
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rp-backup-paper-')), workspace = join(dir, 'workspace')
  const root = join(workspace, 'source'); mkdirSync(root, { recursive: true })
  const db = new Db(join(dir, 'test.sqlite'))
  const insert = (table: string, row: Record<string, string | number | null>) => db.run(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, ...Object.values(row))
  const file = (path: string, body: string) => { const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, body) }
  const times = { created_at: stamp, updated_at: stamp }
  for (const id of ['p', 'q']) {
    insert('projects', { id, name: id, root_path: id === 'p' ? root : join(workspace, 'other'), ...times })
    insert('documents', { id: `${id}doc`, project_id: id, title: 'Primary paper', format: 'latex', file_name: 'paper.tex', relative_path: 'manuscripts/paper.tex', ...times })
    insert('reference_items', { id: `${id}ref`, project_id: id, title: 'Evidence', abstract: 'Accuracy 0.91', notes: 'Question remains open', ...times })
    insert('experiments', { id: `${id}exp`, project_id: id, name: 'Baseline', entry_file: 'experiments/main.py', ...times })
    insert('experiment_runs', { id: `${id}run`, project_id: id, experiment_id: `${id}exp`, status: 'succeeded', exit_code: 0, started_at: stamp, finished_at: stamp, metrics_json: '{"accuracy":0.91}', command: 'DO-NOT-BACK-UP-COMMAND', env_json: '{"token":"DO-NOT-BACK-UP-TOKEN"}', stdout: 'DO-NOT-BACK-UP-LOG' })
    insert('figures', { id: `${id}fig`, project_id: id, experiment_id: `${id}exp`, name: 'Accuracy', caption: 'Preliminary', file_path: 'figures/result.svg', format: 'svg', created_at: stamp })
  }
  insert('documents', { id: 'pdoc2', project_id: 'p', title: 'Second paper', format: 'latex', file_name: 'second.tex', relative_path: 'manuscripts/second.tex', ...times })
  file('manuscripts/paper.tex', '\\section{Results}\nAccuracy prun and pref are literal prose, not structured identifiers.')
  file('manuscripts/second.tex', '\\section{Introduction}\nSecond paper')
  file('experiments/main.py', '# never execute')
  file('figures/result.svg', '<svg></svg>')
  const notes = new NoteService(db)
  const note = notes.create({ projectId: 'p', title: 'Author note', body: 'Retain uncertainty pref pdoc prun; do not rewrite evidence.' })
  const otherNote = notes.create({ projectId: 'q', title: 'Foreign', body: 'Not in backup' })
  // Adapters expose registered DB metadata/files, exercising real capture/fingerprint logic.
  const documents = {
    get(projectId: string, id: string) {
      const row = db.get<any>('SELECT * FROM documents WHERE project_id = ? AND id = ?', projectId, id)
      if (!row) throw new Error('missing document')
      return { id, projectId, title: row.title, format: row.format, relativePath: row.relative_path }
    },
    async readText(projectId: string, id: string) {
      const doc = this.get(projectId, id), project = db.get<any>('SELECT root_path FROM projects WHERE id = ?', projectId)!
      return { text: readFileSync(join(project.root_path, doc.relativePath), 'utf8'), format: doc.format }
    }
  }
  const references = { get(projectId: string, id: string) {
    const row = db.get<any>('SELECT * FROM reference_items WHERE project_id = ? AND id = ?', projectId, id)
    if (!row) throw new Error('missing reference')
    return { id, projectId, title: row.title, authors: row.authors, year: row.year, venue: row.venue, doi: row.doi, url: row.url, abstract: row.abstract, notes: row.notes, tags: JSON.parse(row.tags_json), bibtex: row.bibtex, pdfRelativePath: row.pdf_relative_path }
  } }
  const experiments = { getRun(id: string) {
    const row = db.get<any>('SELECT * FROM experiment_runs WHERE id = ?', id)!
    return { id, projectId: row.project_id, experimentId: row.experiment_id, status: row.status, exitCode: row.exit_code, startedAt: row.started_at, finishedAt: row.finished_at, metrics: JSON.parse(row.metrics_json), artifactDir: row.artifact_dir }
  } }
  const figures = { get(projectId: string, id: string) {
    const row = db.get<any>('SELECT * FROM figures WHERE project_id = ? AND id = ?', projectId, id)
    if (!row) throw new Error('missing figure')
    return { id, projectId, experimentId: row.experiment_id, name: row.name, caption: row.caption, format: row.format, filePath: row.file_path }
  } }
  const paper = new PaperContextService(db, documents as unknown as DocumentService, references as unknown as ReferenceService, experiments as unknown as ExperimentService, notes, figures as unknown as FigureService, () => {})
  const backup = new BackupService(db, { workspaceRoot: () => workspace, assertIdle: () => {} })
  const exported = (name = 'paper.rpbackup', project = 'p') => { const path = join(dir, name); backup.exportProject(project, path); return path }
  return { dir, workspace, root, db, paper, backup, note, otherNote, exported, cleanup() { db.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) } }
}
async function populate(f: ReturnType<typeof fixture>) {
  const memory = { ...emptyPaperMemory('pdoc'), question: 'Does pref generalize?', hypothesis: 'Uncertain', contribution: 'Controlled baseline', scope: 'Small cohort', terms: 'accuracy',
    decisions: [{ id: 'decision_a', text: 'Keep prun as literal text', status: 'accepted' as const, chapter: 'Results' }, { id: 'decision_b', text: 'Do not overclaim', status: 'rejected' as const, chapter: 'Discussion' }],
    issues: [{ id: 'issue_a', text: 'Check external validity', chapter: 'Discussion', resolved: false }, { id: 'issue_b', text: 'Check units', chapter: 'Results', resolved: true }] }
  await f.paper.save('p', memory)
  await f.paper.save('p', { ...emptyPaperMemory('pdoc2'), question: 'Independent second memory' })
  for (const [kind, targetId] of [['reference', 'pref'], ['run', 'prun'], ['note', f.note.id], ['figure', 'pfig']] as const) await f.paper.link({ projectId: 'p', documentId: 'pdoc', kind, targetId })
  await f.paper.refresh('p', 'pdoc')
  await f.paper.activate('p', 'pdoc2')
  return f.paper.get('p', 'pdoc')
}

test('paper backup real roundtrip preserves author memory, active selection and all five source snapshots', async () => {
  const f = fixture()
  try {
    const original = await populate(f), path = f.exported()
    assert.equal(archive(path).manifest.version, 3)
    const preview = f.backup.inspect(path)
    assert.equal(preview.counts.paper_memories, 2); assert.equal(preview.counts.paper_context_sources, 5); assert.equal(preview.counts.paper_context_active, 1)
    assert.ok(!readFileSync(path).toString().includes('DO-NOT-BACK-UP'))
    const restored = f.backup.restoreCopy(preview.token)
    const docs = f.db.all<any>('SELECT * FROM documents WHERE project_id = ?', restored.projectId)
    const doc = docs.find(row => row.title === 'Primary paper')!, second = docs.find(row => row.title === 'Second paper')!
    const memoryRow = f.db.get<any>('SELECT * FROM paper_memories WHERE document_id = ?', doc.id)!
    assert.deepEqual(JSON.parse(memoryRow.content_json), { ...original.memory, documentId: doc.id })
    assert.equal(memoryRow.revision, original.memory.revision); assert.equal(memoryRow.project_id, restored.projectId)
    assert.equal(memoryRow.updated_at, f.db.scalar('SELECT updated_at FROM paper_memories WHERE document_id = ?', 'pdoc'))
    assert.equal(f.db.scalar('SELECT document_id FROM paper_context_active WHERE project_id = ?', restored.projectId), second.id)
    const snapshot = await f.paper.get(restored.projectId, doc.id)
    const targets = { manuscript: doc.id, reference: f.db.scalar('SELECT id FROM reference_items WHERE project_id = ?', restored.projectId), run: f.db.scalar('SELECT id FROM experiment_runs WHERE project_id = ?', restored.projectId), note: f.db.scalar('SELECT id FROM project_notes WHERE project_id = ?', restored.projectId), figure: f.db.scalar('SELECT id FROM figures WHERE project_id = ?', restored.projectId) }
    for (const source of snapshot.sources) {
      const previous = original.sources.find(item => item.kind === source.kind)!
      assert.notEqual(source.id, previous.id); assert.equal(source.targetId, targets[source.kind])
      assert.equal(source.locator, `${source.kind === 'manuscript' ? 'document' : source.kind}:${source.targetId}`)
      assert.equal(source.hash, previous.hash); assert.equal(source.text, previous.text)
      assert.deepEqual(source.sections, previous.sections); assert.equal(source.coverage, previous.coverage); assert.equal(source.capturedAt, previous.capturedAt)
      assert.equal(source.status, ['run', 'figure'].includes(source.kind) ? 'changed' : 'current')
      const row = f.db.get<any>('SELECT * FROM paper_context_sources WHERE id = ?', source.id)!
      assert.equal(row.project_id, restored.projectId); assert.equal(row.document_id, doc.id); assert.equal(row.target_id, source.targetId)
    }
    assert.deepEqual((await f.paper.get('p', 'pdoc')).memory, original.memory)
    assert.equal((await f.paper.get('p', 'pdoc2')).active, true)
    const again = f.exported('again.rpbackup', restored.projectId)
    const secondCopy = f.backup.restoreCopy(f.backup.inspect(again).token)
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM paper_context_sources WHERE project_id = ?', secondCopy.projectId), 5)
  } finally { f.cleanup() }
})

for (const version of [1, 2]) test(`legacy version ${version} restores absent paper tables as empty without losing research records`, async () => {
  const f = fixture()
  try {
    await populate(f)
    const path = f.exported()
    mutate(path, (manifest, records) => {
      manifest.version = version
      for (const table of paperTables) delete records[table]
      if (version === 1) { delete records.research_workspaces; delete records.research_tasks }
    })
    const preview = f.backup.inspect(path)
    for (const table of paperTables) assert.equal(preview.counts[table], 0)
    const restored = f.backup.restoreCopy(preview.token)
    for (const table of paperTables) assert.equal(f.db.scalar(`SELECT COUNT(*) FROM ${table} WHERE project_id = ?`, restored.projectId), 0)
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM documents WHERE project_id = ?', restored.projectId), 2)
    assert.equal((await f.paper.get(restored.projectId, String(f.db.scalar('SELECT id FROM documents WHERE project_id = ? LIMIT 1', restored.projectId)))).memory.revision, 0)
  } finally { f.cleanup() }
})

test('version 3 requires every paper table; legacy normalization never overwrites malformed present tables', async () => {
  const f = fixture()
  try {
    await populate(f)
    for (const version of [1, 2, 3]) for (const table of paperTables) {
      const path = f.exported(`malformed-${version}-${table}.rpbackup`)
      mutate(path, (manifest, records) => {
        manifest.version = version
        if (version === 1) { delete records.research_workspaces; delete records.research_tasks }
        if (version === 3) delete records[table]; else records[table] = null
      })
      assert.throws(() => f.backup.inspect(path), undefined, `${version} ${table}`)
    }
  } finally { f.cleanup() }
})

test('checksummed tampering rejects foreign/unknown paper relationships before creating a copy', async () => {
  const f = fixture()
  try {
    await populate(f)
    const attacks: Array<(records: any) => void> = [
      r => { r.paper_memories[0].project_id = 'q' },
      r => { r.paper_memories[0].document_id = 'qdoc' },
      r => { r.paper_memories[0].content_json = JSON.stringify({ ...JSON.parse(r.paper_memories[0].content_json), documentId: 'qdoc' }) },
      r => { r.paper_context_active[0].document_id = 'qdoc' },
      r => { r.paper_context_active[0].project_id = 'q' },
      r => { r.paper_context_active.push(r.paper_context_active[0]) },
      r => { r.paper_memories.push(r.paper_memories[0]) },
      r => { r.paper_context_sources[0].document_id = 'qdoc' },
      r => { r.paper_context_sources[0].project_id = 'q' },
      ...(['manuscript', 'reference', 'run', 'note', 'figure'] as const).flatMap(kind => ['unknown', kind === 'note' ? f.otherNote.id : { manuscript: 'qdoc', reference: 'qref', run: 'qrun', figure: 'qfig', note: '' }[kind]].map(target => (r: any) => {
        const row = r.paper_context_sources.find((item: any) => item.kind === kind)
        row.target_id = target; const source = JSON.parse(row.content_json)
        source.targetId = target; source.locator = `${kind === 'manuscript' ? 'document' : kind}:${target}`; row.content_json = JSON.stringify(source)
      })),
      r => { const row = r.paper_context_sources.find((item: any) => item.kind === 'manuscript'); row.target_id = 'pdoc2'; const source = JSON.parse(row.content_json); source.targetId = 'pdoc2'; source.locator = 'document:pdoc2'; row.content_json = JSON.stringify(source) },
      r => { const duplicate = { ...r.paper_context_sources[0], id: 'duplicate_source' }; duplicate.content_json = JSON.stringify({ ...JSON.parse(duplicate.content_json), id: duplicate.id }); r.paper_context_sources.push(duplicate) },
      r => { r.unrecognized_paper_table = [] }
    ]
    for (const [index, attack] of attacks.entries()) {
      const path = f.exported(`relation-${index}.rpbackup`); mutate(path, (_m, records) => attack(records))
      assert.throws(() => f.backup.inspect(path), undefined, `relationship ${index}`)
      assert.deepEqual(readdirSync(f.workspace), ['source'])
      assert.equal(f.db.scalar('SELECT COUNT(*) FROM projects'), 2)
    }
  } finally { f.cleanup() }
})

test('paper snapshots and memory reject malformed, inconsistent, oversized and extra credential metadata', async () => {
  const f = fixture()
  try {
    await populate(f)
    const sourceChanges: Array<(source: any) => void> = [
      s => { s.id = 'wrong_source' }, s => { s.targetId = 'qref' }, s => { s.kind = 'unknown' },
      s => { s.locator = 'reference:qref' }, s => { s.hash = 'not-a-hash' }, s => { s.hash = [s.hash] }, s => { s.capturedAt = 'invalid' },
      s => { s.text = 'x'.repeat(PAPER_CONTEXT_LIMITS.sourceChars + 1) }, s => { s.truncated = 'false' },
      s => { s.sections[0].end = s.text.length + 1 }, s => { s.sections[0].text = 'inconsistent' },
      s => { s.sections.push(s.sections[0]) }, s => { s.sections = {} }, s => { s.env = { token: 'credential' } },
      s => { s.sections[0].api_key = 'credential' }
    ]
    const memoryChanges: Array<(memory: any) => void> = [
      m => { m.revision++ }, m => { m.question = 'x'.repeat(PAPER_CONTEXT_LIMITS.field + 1) },
      m => { m.decisions[0].status = 'unknown' }, m => { m.issues[0].resolved = 'false' },
      m => { m.issues[0].id = m.decisions[0].id }, m => { m.credentials = 'credential' },
      m => { m.decisions[0].api_key = 'credential' }
    ]
    for (const [index, change] of sourceChanges.entries()) {
      const path = f.exported(`source-${index}.rpbackup`)
      mutate(path, (_m, r) => { const row = r.paper_context_sources.find((s: any) => s.kind === 'reference'), source = JSON.parse(row.content_json); change(source); row.content_json = JSON.stringify(source) })
      assert.throws(() => f.backup.inspect(path), undefined, `source ${index}`)
    }
    for (const [index, change] of memoryChanges.entries()) {
      const path = f.exported(`memory-${index}.rpbackup`)
      mutate(path, (_m, r) => { const row = r.paper_memories.find((s: any) => s.document_id === 'pdoc'), memory = JSON.parse(row.content_json); change(memory); row.content_json = JSON.stringify(memory) })
      assert.throws(() => f.backup.inspect(path), undefined, `memory ${index}`)
    }
  } finally { f.cleanup() }
})

test('locator offsets remap only the structured prefix, never captured text or section IDs', async () => {
  const f = fixture()
  try {
    await populate(f)
    const path = f.exported()
    mutate(path, (_m, r) => {
      const row = r.paper_context_sources.find((s: any) => s.kind === 'reference'), source: PaperSource = JSON.parse(row.content_json)
      source.locator += '#page=1&offset=0'; row.content_json = JSON.stringify(source)
    })
    const restored = f.backup.restoreCopy(f.backup.inspect(path).token)
    const row = f.db.get<any>("SELECT * FROM paper_context_sources WHERE project_id = ? AND kind = 'reference'", restored.projectId)!
    assert.equal(JSON.parse(row.content_json).locator, `reference:${row.target_id}#page=1&offset=0`)
  } finally { f.cleanup() }
})

test('paper restore failures roll back new records and copy directory, leaving original memory untouched', async () => {
  const f = fixture()
  try {
    const original = await populate(f), path = f.exported(), preview = f.backup.inspect(path)
    f.db.raw.exec("CREATE TRIGGER block_paper_restore BEFORE INSERT ON paper_context_active BEGIN SELECT RAISE(ABORT, 'private failure'); END")
    assert.throws(() => f.backup.restoreCopy(preview.token))
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM projects'), 2)
    assert.deepEqual(readdirSync(f.workspace), ['source'])
    assert.deepEqual((await f.paper.get('p', 'pdoc')).memory, original.memory)
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM paper_context_sources'), 5)
  } finally { f.cleanup() }
})

test('malformed persisted paper records fail export rather than silently dropping context', async () => {
  const f = fixture()
  try {
    await populate(f)
    f.db.run("UPDATE paper_context_sources SET target_id = 'qref' WHERE kind = 'reference'")
    assert.throws(() => f.exported())
    assert.equal(existsSync(join(f.dir, 'paper.rpbackup')), false)
  } finally { f.cleanup() }
})

test('paper source count and metadata byte budgets are enforced before restore', async () => {
  const f = fixture()
  try {
    await populate(f)
    const path = f.exported()
    mutate(path, (_m, records) => {
      const reference = records.reference_items[0], sourceRow = records.paper_context_sources.find((row: any) => row.kind === 'reference')
      const source = JSON.parse(sourceRow.content_json)
      records.paper_context_sources = Array.from({ length: PAPER_CONTEXT_LIMITS.sources + 1 }, (_, index) => {
        const id = `source_${index}`, targetId = `ref_${index}`
        records.reference_items.push({ ...reference, id: targetId })
        return { ...sourceRow, id, target_id: targetId, content_json: JSON.stringify({ ...source, id, targetId, locator: `reference:${targetId}` }) }
      })
    })
    assert.throws(() => f.backup.inspect(path))
    f.db.run('UPDATE paper_context_sources SET content_json = ? WHERE kind = ?', 'x'.repeat(17 * 1024 * 1024), 'reference')
    assert.throws(() => f.exported('oversize.rpbackup'))
    assert.equal(existsSync(join(f.dir, 'oversize.rpbackup')), false)
    assert.deepEqual(readdirSync(f.workspace), ['source'])
  } finally { f.cleanup() }
})

test('deleted linked reference retains missing snapshot through backup, restore and re-export', async () => {
  const f = fixture()
  try {
    const original = await populate(f), source = original.sources.find(source => source.kind === 'reference')!
    f.db.run('DELETE FROM reference_items WHERE id = ?', 'pref')
    assert.equal((await f.paper.get('p', 'pdoc')).sources.find(s => s.kind === 'reference')!.status, 'missing')
    const path = f.exported()
    const archived = archive(path).metadata.records.paper_context_sources.find((r: any) => r.kind === 'reference')
    assert.equal(JSON.parse(archived.content_json).missingTarget, true)
    assert.equal(JSON.parse(f.db.scalar<string>('SELECT content_json FROM paper_context_sources WHERE id = ?', source.id)!).missingTarget, undefined)
    const restored = f.backup.restoreCopy(f.backup.inspect(path).token)
    const row = f.db.get<any>("SELECT * FROM paper_context_sources WHERE project_id = ? AND kind = 'reference'", restored.projectId)!
    assert.notEqual(row.target_id, 'pref')
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM reference_items WHERE id = ?', row.target_id), 0)
    const snapshot = JSON.parse(row.content_json)
    assert.equal(Object.hasOwn(snapshot, 'missingTarget'), false)
    assert.equal(snapshot.hash, source.hash); assert.equal(snapshot.text, source.text); assert.deepEqual(snapshot.sections, source.sections)
    assert.equal(snapshot.locator, `reference:${row.target_id}`)
    assert.equal((await f.paper.get(restored.projectId, row.document_id)).sources.find(s => s.kind === 'reference')!.status, 'missing')
    const next = f.exported('missing-again.rpbackup', restored.projectId)
    assert.equal(f.backup.inspect(next).counts.paper_context_sources, 5)
  } finally { f.cleanup() }
})

test('missing target marker cannot hide live foreign or bundled targets and must be exactly true', async () => {
  const f = fixture()
  try {
    await populate(f)
    for (const target of ['qref', 'pref']) {
      const path = f.exported(`forged-${target}.rpbackup`)
      mutate(path, (_m, records) => {
        const row = records.paper_context_sources.find((r: any) => r.kind === 'reference'), source = JSON.parse(row.content_json)
        row.target_id = target; source.targetId = target; source.locator = `reference:${target}`; source.missingTarget = true; row.content_json = JSON.stringify(source)
      })
      assert.throws(() => f.backup.inspect(path))
    }
    const malformed = f.exported('marker-false.rpbackup')
    mutate(malformed, (_m, records) => { const row = records.paper_context_sources[0]; row.content_json = JSON.stringify({ ...JSON.parse(row.content_json), missingTarget: false }) })
    assert.throws(() => f.backup.inspect(malformed))
    const row = f.db.get<any>("SELECT * FROM paper_context_sources WHERE kind = 'reference'")!
    f.db.run('UPDATE paper_context_sources SET target_id = ?, content_json = ? WHERE id = ?', 'qref', JSON.stringify({ ...JSON.parse(row.content_json), targetId: 'qref', locator: 'reference:qref', missingTarget: true }), row.id)
    assert.throws(() => f.exported('foreign-export.rpbackup'))
  } finally { f.cleanup() }
})

test('legacy present paper tables are validated and preserved, never defaulted away', async () => {
  const f = fixture()
  try {
    await populate(f)
    const path = f.exported()
    mutate(path, (manifest, records) => { manifest.version = 2; delete records.paper_context_active })
    const preview = f.backup.inspect(path)
    assert.equal(preview.counts.paper_memories, 2); assert.equal(preview.counts.paper_context_sources, 5); assert.equal(preview.counts.paper_context_active, 0)
    const restored = f.backup.restoreCopy(preview.token)
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM paper_memories WHERE project_id = ?', restored.projectId), 2)
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM paper_context_sources WHERE project_id = ?', restored.projectId), 5)
  } finally { f.cleanup() }
})
