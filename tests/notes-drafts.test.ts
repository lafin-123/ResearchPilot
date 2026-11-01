import assert from 'node:assert/strict'
import test from 'node:test'
import { NotesContext, NotesDrafts, noteExportFilename, noteMarkdown, safeNoteUrl, warnForUnsavedNotes } from '../src/renderer/src/lib/notes-drafts'

const scope = (projectId = 'project-a', id = 'note-a') => ({ projectId, id })
const note = (projectId = 'project-a', id = 'note-a', revision = 1, title = 'Original title', body = 'Original body') => ({ projectId, id, revision, title, body })

test('note drafts are isolated by project and note, including ambiguous delimiters', () => {
  const drafts = new NotesDrafts()
  const targets = [scope(), scope('project-b'), scope('project-a', 'note-b'), scope('a:b', 'c'), scope('a', 'b:c')]
  targets.forEach((target, index) => {
    drafts.load({ ...target, revision: 1, title: `Title ${index}`, body: `Body ${index}` })
    drafts.edit(target, { body: `Draft ${index}` })
  })
  targets.forEach((target, index) => assert.equal(drafts.get(target)?.body, `Draft ${index}`))
  assert.equal(drafts.hasModified('unrelated-project'), false)
  assert.equal(drafts.hasModified('project-b'), true)
})

test('empty-string edits survive navigation and late reads without changing their revision baseline', () => {
  const drafts = new NotesDrafts()
  drafts.load(note())
  drafts.edit(scope(), { title: '', body: '' })
  drafts.load(note('project-a', 'note-a', 5, 'Remote title', 'Remote body'))
  assert.equal(drafts.get(scope())?.title, '')
  assert.equal(drafts.get(scope())?.body, '')
  assert.equal(drafts.get(scope())?.revision, 1)
  assert.equal(drafts.isModified(scope()), true)
  // Module memory is deliberate: a renderer reload starts an empty store.
  assert.equal(new NotesDrafts().get(scope()), null)
})

test('fresh reads refresh clean drafts but an older result cannot regress a newer revision', () => {
  const drafts = new NotesDrafts()
  drafts.load(note())
  drafts.load(note('project-a', 'note-a', 3, 'New title', 'New body'))
  drafts.load(note('project-a', 'note-a', 2, 'Stale title', 'Stale body'))
  assert.equal(drafts.get(scope())?.title, 'New title')
  assert.equal(drafts.get(scope())?.revision, 3)
  assert.equal(drafts.isModified(scope()), false)
})

test('save acknowledges exactly the submitted snapshot while preserving edits made during IPC', () => {
  const drafts = new NotesDrafts()
  drafts.load(note())
  drafts.edit(scope(), { title: '  Submitted title  ', body: 'Submitted body' })
  const submitted = drafts.get(scope())!
  drafts.edit(scope(), { body: 'Typed while saving' })
  drafts.saved(note('project-a', 'note-a', 2, 'Submitted title', 'Submitted body'), submitted)
  assert.equal(drafts.get(scope())?.title, 'Submitted title')
  assert.equal(drafts.get(scope())?.body, 'Typed while saving')
  assert.equal(drafts.get(scope())?.savedBody, 'Submitted body')
  assert.equal(drafts.get(scope())?.revision, 2)
  assert.equal(drafts.isModified(scope()), true)
})

test('a stale save acknowledgement cannot regress a newer baseline', () => {
  const drafts = new NotesDrafts()
  drafts.load(note())
  drafts.edit(scope(), { body: 'Submitted' })
  const submitted = drafts.get(scope())!
  drafts.reload(note('project-a', 'note-a', 4, 'Remote', 'New remote body'))
  drafts.saved(note('project-a', 'note-a', 2, 'Original title', 'Submitted'), submitted)
  assert.equal(drafts.get(scope())?.revision, 4)
  assert.equal(drafts.get(scope())?.body, 'New remote body')
})

test('pin/trash/restore can advance metadata revisions without discarding local edits', () => {
  const drafts = new NotesDrafts()
  drafts.load(note())
  drafts.edit(scope(), { body: 'Unsaved local work' })
  drafts.metadataUpdated(note('project-a', 'note-a', 2))
  assert.equal(drafts.get(scope())?.body, 'Unsaved local work')
  assert.equal(drafts.get(scope())?.revision, 2)
  assert.equal(drafts.isModified(scope()), true)
})

test('metadata mutation never silently rebases a dirty draft over remote content changes', () => {
  const drafts = new NotesDrafts()
  drafts.load(note())
  drafts.edit(scope(), { body: 'Local work' })
  drafts.metadataUpdated(note('project-a', 'note-a', 3, 'Original title', 'Someone else changed this'))
  assert.equal(drafts.get(scope())?.body, 'Local work')
  assert.equal(drafts.get(scope())?.savedBody, 'Original body')
  assert.equal(drafts.get(scope())?.revision, 1)
  // Therefore the next save sends expectedRevision=1 and must conflict, not overwrite revision 3.
})

test('confirmed reload preserves replaced edits in a recovery copy that survives later clean reads', () => {
  const drafts = new NotesDrafts()
  drafts.load(note())
  drafts.edit(scope(), { title: 'Local title', body: 'Local work' })
  drafts.reload(note('project-a', 'note-a', 7, 'Server title', 'Server work'))
  assert.deepEqual(drafts.get(scope())?.recovery, { title: 'Local title', body: 'Local work' })
  assert.equal(drafts.get(scope())?.body, 'Server work')
  assert.equal(drafts.get(scope())?.revision, 7)
  assert.equal(drafts.isModified(scope()), false)
  drafts.load(note('project-a', 'note-a', 7, 'Server title', 'Server work'))
  assert.deepEqual(drafts.get(scope())?.recovery, { title: 'Local title', body: 'Local work' })
})

test('mutation lock survives route remount, notifies subscribers, and releases after completion', () => {
  const drafts = new NotesDrafts()
  let notifications = 0
  const unsubscribe = drafts.subscribe(() => notifications++)
  const release = drafts.acquire(scope())
  assert.ok(release)
  assert.equal(drafts.acquire(scope()), null)
  assert.equal(drafts.isBusy(scope()), true)
  assert.equal(drafts.isBusy(scope('project-b')), false)
  assert.equal(notifications, 1)
  release()
  assert.equal(drafts.isBusy(scope()), false)
  assert.equal(notifications, 2)
  unsubscribe()
  drafts.load(note())
  assert.equal(notifications, 2)
})

test('A -> B -> A selection and unmount invalidate stale async contexts', () => {
  const context = new NotesContext()
  const firstA = context.capture()
  context.invalidate()
  const b = context.capture()
  context.invalidate()
  const nextA = context.capture()
  assert.equal(context.isCurrent(firstA), false)
  assert.equal(context.isCurrent(b), false)
  assert.equal(context.isCurrent(nextA), true)
  context.invalidate()
  assert.equal(context.isCurrent(nextA), false)
})

test('a late create completion cannot take over navigation, including A -> B -> A', async () => {
  const context = new NotesContext()
  const token = context.capture()
  let finish!: () => void
  let navigations = 0
  const pending = new Promise<void>(resolve => { finish = resolve }).then(() => {
    if (context.isCurrent(token)) navigations++
  })
  context.invalidate()
  context.invalidate()
  finish()
  await pending
  assert.equal(navigations, 0)
})

test('unsaved-close warning follows memory drafts rather than mounted Notes routes', () => {
  const drafts = new NotesDrafts()
  let prevented = false
  const event = { preventDefault: () => { prevented = true }, returnValue: true as string | boolean }
  warnForUnsavedNotes(drafts, event)
  assert.equal(prevented, false)
  drafts.load(note())
  drafts.edit(scope(), { body: 'Unsaved after navigating away' })
  warnForUnsavedNotes(drafts, event)
  assert.equal(prevented, true)
  assert.equal(event.returnValue, '')
  const submitted = drafts.get(scope())!
  drafts.saved(note('project-a', 'note-a', 2, 'Original title', submitted.body), submitted)
  prevented = false
  warnForUnsavedNotes(drafts, event)
  assert.equal(prevented, false)
})

test('Markdown URL policy allows stable page links and clean HTTPS only', () => {
  assert.equal(safeNoteUrl('research-note:note_123-abc'), 'research-note:note_123-abc')
  assert.equal(safeNoteUrl('https://example.org/paper?q=notes#results'), 'https://example.org/paper?q=notes#results')
  for (const unsafe of [
    'javascript:alert(1)', 'JavaScript:alert(1)', 'file:///C:/private.txt', 'data:text/html,hello',
    'http://example.org', '//example.org', '/local-path', '#fragment', 'research-note:../../private',
    'research-note:', 'research-note:note?project=other', 'https://user:secret@example.org', 'https://'
  ]) assert.equal(safeNoteUrl(unsafe), '', unsafe)
})

test('Markdown export escapes the plain title and strips unsafe filename characters', () => {
  assert.equal(noteMarkdown('A [title]\n# Heading', 'Body\n\n- item'), '# A \\[title\\] \\# Heading\n\nBody\n\n- item\n')
  assert.equal(noteExportFilename('A/B:C*?<>"|\\'), 'A-B-C-------.md')
  assert.equal(noteExportFilename('... '), 'research-note.md')
  assert.equal(noteExportFilename('x'.repeat(200)).length, 103)
})
