import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Db } from '../src/main/lib/db'
import { NoteService } from '../src/main/services/notes'
import { NOTE_LIMITS, noteLink, parseNoteLinks, parseNoteTarget, parseNoteListInput, parseNotePinInput } from '../src/shared/notes'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rp-notes-'))
  const file = join(root, 'local.sqlite')
  const db = new Db(file)
  for (const id of ['p', 'q']) db.run('INSERT INTO projects (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)', id, id, join(root, id), '2026-01-01', '2026-01-01')
  return { root, file, db, notes: new NoteService(db), cleanup() { db.close(); rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } }
}

function edit(notes: NoteService, projectId: string, id: string, patch: { title?: string; body?: string }) {
  const current = notes.get(projectId, id)
  return notes.update({ projectId, id, title: patch.title ?? current.title, body: patch.body ?? current.body, expectedRevision: current.revision })
}

test('notes persist locally across reopen, with bounded summaries and full page reads', () => {
  const f = fixture()
  let second: Db | undefined
  try {
    const body = '# Research log\n\n实验记录 🌲 ' + 'x'.repeat(10000)
    const note = f.notes.create({ projectId: 'p', title: '  Experiment notebook  ', body })
    assert.equal(note.title, 'Experiment notebook')
    assert.equal(note.body, body)
    assert.equal(note.revision, 1)
    assert.equal(note.deletedAt, null)
    assert.equal(note.pinned, false)
    assert.match(note.id, /^note_/)
    assert.ok(Number.isFinite(Date.parse(note.createdAt)))
    const { items, total, hasMore } = f.notes.list('p')
    assert.equal(total, 1)
    assert.equal(hasMore, false)
    assert.equal(items.length, 1)
    assert.equal('body' in items[0], false)
    assert.ok(items[0].snippet.length <= NOTE_LIMITS.snippet)
    second = new Db(f.file)
    assert.deepEqual(new NoteService(second).get('p', note.id), note)
    assert.equal(f.db.scalar<number>('SELECT COUNT(*) FROM knowledge_chunks'), 0)
    assert.equal(f.db.scalar<number>('SELECT COUNT(*) FROM reference_items'), 0)
  } finally { second?.close(); f.cleanup() }
})

test('every read and mutation is scoped to a valid project and ID; foreign links do not materialize', () => {
  const f = fixture()
  try {
    const foreign = f.notes.create({ projectId: 'q', title: 'Private', body: 'foreign-secret' })
    const local = f.notes.create({ projectId: 'p', title: 'Local', body: noteLink(foreign.id, 'Foreign') })
    for (const operation of [
      () => f.notes.get('p', foreign.id),
      () => f.notes.update({ projectId: 'p', id: foreign.id, title: 'intruder', body: 'overwrite', expectedRevision: 1 }),
      () => f.notes.setPinned('p', foreign.id, true),
      () => f.notes.trash('p', foreign.id),
      () => f.notes.restore('p', foreign.id),
      () => f.notes.backlinks('p', foreign.id)
    ]) assert.throws(operation, /不属于/)
    assert.deepEqual(f.notes.get('q', foreign.id), foreign)
    assert.equal(f.notes.list('p', { query: 'foreign-secret' }).total, 0)
    assert.deepEqual(f.notes.backlinks('q', foreign.id), [])
    assert.equal(f.db.scalar<number>('SELECT COUNT(*) FROM note_links'), 0)
    assert.throws(() => f.notes.list('missing'), /项目/)
    assert.throws(() => f.notes.create({ projectId: 'missing', title: 'No project' }), /项目/)
    for (const bad of ['', '../p', 'p\n', 'file:///C:/secret', "p' OR 1=1--", 'x'.repeat(129), null, {}, 1]) {
      assert.throws(() => f.notes.get(bad as string, local.id))
      assert.throws(() => f.notes.get('p', bad as string))
    }
    // Database constraints also prevent accidental cross-project edges.
    assert.throws(() => f.db.run('INSERT INTO note_links VALUES (?, ?, ?)', 'p', local.id, foreign.id), /FOREIGN KEY/)
  } finally { f.cleanup() }
})

test('canonical explicit links/backlinks survive rename, deduplicate, and update atomically', () => {
  const f = fixture()
  try {
    const target = f.notes.create({ projectId: 'p', title: 'Original title' })
    const other = f.notes.create({ projectId: 'p', title: 'Other target' })
    const body = `${noteLink(target.id, 'Original title')}\n${noteLink(target.id, 'Repeated')}\n[missing](research-note:not_existing)`
    const source = f.notes.create({ projectId: 'p', title: 'Source', body })
    assert.deepEqual(f.notes.backlinks('p', target.id).map(row => row.id), [source.id])
    assert.equal(f.db.scalar<number>('SELECT COUNT(*) FROM note_links'), 1)
    edit(f.notes, 'p', target.id, { title: 'Renamed target' })
    edit(f.notes, 'p', source.id, { title: 'Renamed source' })
    assert.equal(f.notes.get('p', source.id).body, body)
    assert.equal(f.notes.backlinks('p', target.id)[0].title, 'Renamed source')
    edit(f.notes, 'p', source.id, { body: noteLink(other.id, 'Changed target') })
    assert.deepEqual(f.notes.backlinks('p', target.id), [])
    assert.deepEqual(f.notes.backlinks('p', other.id).map(row => row.id), [source.id])
    const before = f.notes.get('p', source.id)
    f.db.raw.exec("CREATE TEMP TRIGGER fail_note_link BEFORE INSERT ON note_links BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END")
    assert.throws(() => edit(f.notes, 'p', source.id, { body }), /fixture rollback/)
    assert.deepEqual(f.notes.get('p', source.id), before)
    assert.deepEqual(f.notes.backlinks('p', other.id).map(row => row.id), [source.id])
    assert.deepEqual(f.notes.backlinks('p', target.id), [])
  } finally { f.cleanup() }
})

test('optimistic revisions reject stale writes with no body, timestamp, metadata or link mutation', () => {
  const f = fixture()
  let second: Db | undefined
  try {
    const a = f.notes.create({ projectId: 'p', title: 'Target A' })
    const b = f.notes.create({ projectId: 'p', title: 'Target B' })
    const source = f.notes.create({ projectId: 'p', title: 'First', body: noteLink(a.id, 'A') })
    second = new Db(f.file)
    const otherWindow = new NoteService(second)
    const saved = otherWindow.update({ projectId: 'p', id: source.id, title: 'Newest', body: noteLink(b.id, 'B'), expectedRevision: source.revision })
    assert.equal(saved.revision, 2)
    assert.throws(() => f.notes.update({ projectId: 'p', id: source.id, title: 'Stale', body: noteLink(a.id, 'A'), expectedRevision: source.revision }), /NOTE_CONFLICT/)
    assert.deepEqual(f.notes.get('p', source.id), saved)
    assert.deepEqual(f.notes.backlinks('p', a.id), [])
    assert.deepEqual(f.notes.backlinks('p', b.id).map(row => row.id), [source.id])
    assert.throws(() => f.notes.update({ projectId: 'p', id: source.id, title: saved.title, body: saved.body, expectedRevision: source.revision }), /NOTE_CONFLICT/)
    assert.deepEqual(edit(f.notes, 'p', source.id, {}), saved)
    const pinned = f.notes.setPinned('p', source.id, true)
    assert.equal(pinned.revision, 3)
    assert.throws(() => f.notes.update({ projectId: 'p', id: source.id, title: saved.title, body: 'old edit', expectedRevision: saved.revision }), /NOTE_CONFLICT/)
    assert.deepEqual(f.notes.setPinned('p', source.id, true), pinned)
  } finally { second?.close(); f.cleanup() }
})

test('trash is recoverable and idempotent, keeps content and pins, hides both backlink directions', () => {
  const f = fixture()
  try {
    const target = f.notes.create({ projectId: 'p', title: 'Target' })
    const source = f.notes.create({ projectId: 'p', title: 'Source', body: noteLink(target.id, 'Target') })
    f.notes.setPinned('p', source.id, true)
    const trashed = f.notes.trash('p', source.id)
    assert.ok(trashed.deletedAt)
    assert.equal(trashed.revision, 3)
    assert.equal(trashed.body, source.body)
    assert.equal(trashed.pinned, true)
    assert.deepEqual(f.notes.trash('p', source.id), trashed)
    assert.deepEqual(f.notes.backlinks('p', target.id), [])
    assert.equal(f.notes.list('p').total, 1)
    assert.equal(f.notes.list('p', { filter: 'pinned' }).total, 0)
    assert.deepEqual(f.notes.list('p', { filter: 'trash' }).items.map(row => row.id), [source.id])
    assert.throws(() => edit(f.notes, 'p', source.id, { body: 'lost' }), /回收站/)
    assert.throws(() => f.notes.setPinned('p', source.id, false), /回收站/)
    const restored = f.notes.restore('p', source.id)
    assert.equal(restored.revision, 4)
    assert.equal(restored.deletedAt, null)
    assert.equal(restored.body, source.body)
    assert.equal(restored.id, source.id)
    assert.deepEqual(f.notes.restore('p', source.id), restored)
    assert.equal(f.notes.backlinks('p', target.id).length, 1)
    assert.equal(f.notes.list('p', { filter: 'pinned' }).total, 1)
    f.notes.trash('p', target.id)
    assert.deepEqual(f.notes.backlinks('p', target.id), [])
    // An explicit link added while the target is trashed reappears on restore.
    const another = f.notes.create({ projectId: 'p', title: 'Another source', body: noteLink(target.id, 'Target') })
    f.notes.restore('p', target.id)
    assert.deepEqual(new Set(f.notes.backlinks('p', target.id).map(row => row.id)), new Set([source.id, another.id]))
    assert.throws(() => f.notes.update({ projectId: 'p', id: source.id, title: source.title, body: 'pre-trash draft', expectedRevision: source.revision }), /NOTE_CONFLICT/)
  } finally { f.cleanup() }
})

test('list search is literal, project-scoped and paginated, not capped silently', () => {
  const f = fixture()
  try {
    const one = f.notes.create({ projectId: 'p', title: 'One', body: 'BodyOnlyNeedle 100% 字段_%' })
    f.notes.create({ projectId: 'p', title: 'Two' })
    f.notes.create({ projectId: 'p', title: 'Three' })
    f.notes.setPinned('p', one.id, true)
    assert.equal(f.notes.list('p', { query: 'bodyonlyneedle' }).items[0].id, one.id)
    assert.equal(f.notes.list('p', { query: '字段_%' }).total, 1)
    assert.equal(f.notes.list('p', { query: '%' }).total, 1)
    assert.equal(f.notes.list('p', { query: "' OR 1=1--" }).total, 0)
    const first = f.notes.list('p', { limit: 2 })
    assert.equal(first.total, 3)
    assert.equal(first.hasMore, true)
    assert.equal(first.items[0].id, one.id)
    const next = f.notes.list('p', { limit: 2, offset: 2 })
    assert.equal(next.items.length, 1)
    assert.equal(next.hasMore, false)
    assert.equal(new Set([...first.items, ...next.items].map(row => row.id)).size, 3)
    assert.equal(f.notes.list('p', { offset: 100 }).items.length, 0)
    f.db.transaction(() => {
      const insert = f.db.prepare('INSERT INTO project_notes (id,project_id,title,body,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      for (let index = 0; index < 1001; index++) insert.run(`fixture_${index}`, 'p', `Batch ${index}`, '', 'old', 'old')
    })
    const bounded = f.notes.list('p', { limit: 1000 })
    assert.equal(bounded.items.length, 1000)
    assert.equal(bounded.total, 1004)
    assert.equal(bounded.hasMore, true)
    assert.equal(f.notes.list('p', { limit: 1000, offset: 1000 }).items.length, 4)
    assert.equal(f.notes.list('p').items.length, NOTE_LIMITS.defaultList)
  } finally { f.cleanup() }
})

test('malformed IPC and service inputs are rejected before mutation, with strict bounds', () => {
  const f = fixture()
  try {
    const note = f.notes.create({ projectId: 'p', title: 'Valid' })
    for (const input of [null, [], 42, {}, { projectId: 'p', title: '' }, { projectId: 'p', title: '  ' }, { projectId: 'p', title: 'x'.repeat(201) }, { projectId: 'p', title: 'line\nbreak' }, { projectId: 'p', title: 'x', body: null }, { projectId: 'p', title: 'x', body: 'x'.repeat(200001) }, { projectId: 'p', title: 'x', body: 'nul\0' }, { projectId: 'p', title: 'x', pinned: true }]) {
      assert.throws(() => f.notes.create(input as never))
    }
    for (const expectedRevision of [0, -1, 1.1, NaN, Infinity, '1', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => f.notes.update({ projectId: 'p', id: note.id, title: 'bad', body: 'bad', expectedRevision: expectedRevision as number }))
    }
    for (const options of [null, [], { limit: 0 }, { limit: 1001 }, { limit: '10' }, { offset: -1 }, { offset: Infinity }, { filter: 'bogus' }, { filter: null }, { query: {} }, { query: 'x'.repeat(201) }, { unknown: true }]) {
      assert.throws(() => f.notes.list('p', options as never))
    }
    for (const payload of [null, [], { projectId: 'p' }, { projectId: 'p', id: note.id, arbitraryPath: 'C:/secret' }]) assert.throws(() => parseNoteTarget(payload))
    assert.throws(() => parseNotePinInput({ projectId: 'p', id: note.id, pinned: 1 }))
    assert.throws(() => parseNoteListInput({ projectId: 'p', options: { limit: Infinity } }))
    assert.throws(() => f.notes.setPinned('p', note.id, 'yes' as never))
    assert.deepEqual(f.notes.get('p', note.id), note)
    assert.equal(f.notes.list('p').total, 1)
    const maximum = f.notes.create({ projectId: 'p', title: 'x'.repeat(200), body: 'x'.repeat(200000) })
    assert.equal(maximum.body.length, 200000)
  } finally { f.cleanup() }
})

test('Markdown link parser excludes code, images, escapes and noncanonical URLs', () => {
  const valid = noteLink('note_A', 'Research [draft] \\ `code` *bold* <tag>!')
  assert.deepEqual(parseNoteLinks(valid), ['note_A'])
  const body = [
    valid, '[repeat](research-note:note_A)', '[second](research-note:note_B)',
    '`[code](research-note:inline)`', '``[code with ` tick](research-note:inline_two)``',
    '```md', '[fence](research-note:fenced)', '```',
    '~~~~', '[fence](research-note:tilde)', '~~~~',
    '    [indent](research-note:indented)', '\t[indent](research-note:tabbed)',
    '![image](research-note:image)', '\\[escaped](research-note:escaped)',
    '[external](https://example.test/research-note:external)', '[file](file:///C:/secret)',
    '[unsafe](research-note:../escape)', '[encoded](research-note:note%5FA)',
    '[query](research-note:note_A?project=other)', 'research-note:raw',
    '<!-- [comment](research-note:comment) -->'
  ].join('\n')
  assert.deepEqual(parseNoteLinks(body), ['note_A', 'note_B'])
  assert.deepEqual(parseNoteLinks('```\n[unclosed](research-note:no)\n'), [])
  assert.deepEqual(parseNoteLinks('`unmatched [valid](research-note:yes)'), ['yes'])
  assert.deepEqual(parseNoteLinks('``multi\n[hidden](research-note:no)\nline`` [visible](research-note:yes)'), ['yes'])
  assert.throws(() => noteLink('../file', 'label'))
  assert.throws(() => parseNoteLinks('x'.repeat(200001)))
})

test('append-only migration upgrades an existing database and project deletion cascades notes/edges', () => {
  const f = fixture()
  let upgraded: Db | undefined
  try {
    const version = f.db.scalar<number>('PRAGMA user_version')!
    f.db.run('INSERT INTO app_settings (key, value_json) VALUES (?, ?)', 'sentinel', '"keep me"')
    // Notes were introduced in migration 5. Later independent tables must also be removed before replaying newer migrations.
    f.db.raw.exec('DROP TABLE IF EXISTS pdf_annotations; DROP TABLE reference_reading_drafts; DROP TABLE note_links; DROP TABLE project_notes; PRAGMA user_version = 4')
    upgraded = new Db(f.file)
    assert.equal(upgraded.scalar<number>('PRAGMA user_version'), version)
    assert.equal(upgraded.scalar<string>('SELECT value_json FROM app_settings WHERE key = ?', 'sentinel'), '"keep me"')
    assert.equal(upgraded.scalar<number>('SELECT COUNT(*) FROM projects'), 2)
    const notes = new NoteService(upgraded)
    const target = notes.create({ projectId: 'p', title: 'Target' })
    notes.create({ projectId: 'p', title: 'Source', body: noteLink(target.id, 'Target') })
    const untouched = notes.create({ projectId: 'q', title: 'Other project' })
    upgraded.run('DELETE FROM projects WHERE id = ?', 'p')
    assert.equal(upgraded.scalar<number>('SELECT COUNT(*) FROM note_links'), 0)
    assert.equal(upgraded.scalar<number>('SELECT COUNT(*) FROM project_notes'), 1)
    assert.deepEqual(notes.get('q', untouched.id), untouched)
  } finally { upgraded?.close(); f.cleanup() }
})
