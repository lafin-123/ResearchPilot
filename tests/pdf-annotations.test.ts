import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, linkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Db } from '../src/main/lib/db'
import { ReferenceService } from '../src/main/services/references'
import { PdfAnnotationService } from '../src/main/services/pdf-annotations'
import { annotationMarkdown, normalizePdfRects, parsePdfAnnotationCreate, type PdfAnnotationCreate } from '../src/shared/pdf-annotations'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rp-pdf-annotations-'))
  const file = join(root, 'account.sqlite'); const db = new Db(file)
  for (const id of ['p', 'q']) {
    mkdirSync(join(root, id))
    db.run('INSERT INTO projects (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)', id, id, join(root, id), new Date().toISOString(), new Date().toISOString())
  }
  const refs = new ReferenceService(db)
  const ref = refs.upsert({ projectId: 'p', title: 'Local paper', notes: 'Keep human notes', doi: '10.1234/example' })
  const source = join(root, 'fixture.pdf')
  // Service only checks file header, not PDF structure; actual rendering uses the desktop two-page fixture.
  writeFileSync(source, '%PDF-1.7\n% service-level bytes\n%%EOF')
  const attached = refs.attachPdf('p', ref.id, source)
  const target = join(root, 'p', attached.pdfRelativePath)
  const service = new PdfAnnotationService(db, refs)
  const opened = service.open('p', ref.id)
  const scope = { projectId: 'p', referenceId: ref.id, fingerprint: opened.fingerprint }
  const input: PdfAnnotationCreate = { ...scope, page: 1, quote: 'Source text', comment: 'Check method', color: 'yellow', rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }] }
  return { root, file, db, refs, ref, source, target, service, scope, input, cleanup() { db.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('PDF annotation create/update/delete persist in SQLite, keep PDF bytes and human notes unchanged', () => {
  const f = fixture()
  try {
    const original = readFileSync(f.target)
    const saved = f.service.create(f.input)
    assert.equal(saved.revision, 1)
    assert.equal(saved.fingerprint, createHash('sha256').update(original).digest('hex'))
    const reopened = new Db(f.file)
    try { assert.deepEqual(new PdfAnnotationService(reopened, new ReferenceService(reopened)).open('p', f.ref.id).annotations, [saved]) } finally { reopened.close() }
    const changed = f.service.update({ ...f.scope, id: saved.id, comment: 'Revised', color: 'green', expectedRevision: 1 })
    assert.equal(changed.revision, 2); assert.equal(changed.comment, 'Revised'); assert.deepEqual(changed.rects, saved.rects)
    assert.throws(() => f.service.update({ ...f.scope, id: saved.id, comment: 'Stale', color: 'yellow', expectedRevision: 1 }), /其他窗口/)
    f.service.remove(f.scope, saved.id)
    assert.deepEqual(f.service.list(f.scope), [])
    const comment = f.service.create({ ...f.input, page: 2, quote: '', rects: [], comment: 'Page comment' })
    assert.throws(() => f.service.update({ ...f.scope, id: comment.id, comment: ' ', color: 'rose', expectedRevision: 1 }), /不能为空/)
    assert.deepEqual(readFileSync(f.target), original)
    assert.deepEqual(readFileSync(f.source), original)
    assert.equal(f.refs.get('p', f.ref.id).notes, 'Keep human notes')
    f.refs.delete('p', f.ref.id)
    assert.equal(f.db.scalar<number>('SELECT count(*) FROM pdf_annotations'), 0)
  } finally { f.cleanup() }
})

test('project/reference/fingerprint scoping rejects cross-resource access and stale attached PDF', () => {
  const f = fixture()
  try {
    const saved = f.service.create(f.input)
    assert.throws(() => f.service.open('q', f.ref.id), /不存在/)
    assert.throws(() => f.service.list({ ...f.scope, projectId: 'q' }), /不存在/)
    assert.throws(() => f.service.remove({ ...f.scope, projectId: 'q' }, saved.id), /不存在/)
    const other = f.refs.upsert({ projectId: 'p', title: 'Same bytes, separate paper' })
    f.refs.attachPdf('p', other.id, f.source)
    const otherScope = { ...f.scope, referenceId: other.id }
    assert.deepEqual(f.service.list(otherScope), [])
    assert.throws(() => f.service.remove(otherScope, saved.id), /不属于/)
    assert.throws(() => f.service.update({ ...otherScope, id: saved.id, expectedRevision: 1, comment: 'x', color: 'yellow' }), /不属于/)
    writeFileSync(f.target, '%PDF-1.7\n% DIFFERENT FILE\n%%EOF')
    assert.throws(() => f.service.create(f.input), /替换或修改/)
    assert.throws(() => f.service.list(f.scope), /替换或修改/)
    assert.throws(() => f.service.remove(f.scope, saved.id), /替换或修改/)
    assert.deepEqual(f.service.open('p', f.ref.id).annotations, [])
    f.refs.attachPdf('p', f.ref.id, f.source)
    assert.equal(f.service.open('p', f.ref.id).annotations[0]?.id, saved.id)
  } finally { f.cleanup() }
})

test('annotation operations reject unsafe paths, hardlinks and non-PDF files through the scoped reader', () => {
  const f = fixture()
  try {
    f.db.run('UPDATE reference_items SET pdf_relative_path = ? WHERE id = ?', '../fixture.pdf', f.ref.id)
    assert.throws(() => f.service.open('p', f.ref.id), /traversal/)
    const hard = join(f.root, 'p', 'hard.pdf'); linkSync(f.source, hard)
    f.db.run('UPDATE reference_items SET pdf_relative_path = ? WHERE id = ?', 'hard.pdf', f.ref.id)
    assert.throws(() => f.service.open('p', f.ref.id), /Hardlinked/)
    writeFileSync(join(f.root, 'p', 'not.pdf'), '<script>bad</script>')
    f.db.run('UPDATE reference_items SET pdf_relative_path = ? WHERE id = ?', 'not.pdf', f.ref.id)
    assert.throws(() => f.service.open('p', f.ref.id), /有效的 PDF/)
    assert.throws(() => f.service.open('../p', f.ref.id), /标识/)
  } finally { f.cleanup() }
})

test('annotation validation bounds pages, texts, coordinates, rectangle count, colors and unknown fields', () => {
  const f = fixture()
  try {
    const invalid: unknown[] = [null, [], { ...f.input, projectId: 'p\n' }, { ...f.input, fingerprint: 'a'.repeat(64) + '\n' }, { ...f.input, extra: true }, { ...f.input, page: 0 }, { ...f.input, page: 1.5 }, { ...f.input, page: 10001 }, { ...f.input, quote: 'a'.repeat(4001) }, { ...f.input, comment: '\0' }, { ...f.input, color: 'blue' }, { ...f.input, rects: Array(101).fill(f.input.rects[0]) }, { ...f.input, rects: [{ x: 0.9, y: 0, width: 0.2, height: 0.1 }] }, { ...f.input, rects: [{ x: NaN, y: 0, width: 0.2, height: 0.1 }] }, { ...f.input, rects: [{ x: 0, y: 0, width: 0, height: 0.1 }] }, { ...f.input, rects: [{ x: 0, y: -1, width: 0.2, height: 0.1 }] }, { ...f.input, quote: '' }, { ...f.input, rects: [], quote: '', comment: '' }]
    for (const input of invalid) assert.throws(() => parsePdfAnnotationCreate(input))
    assert.equal(f.service.list(f.scope).length, 0)
  } finally { f.cleanup() }
})

test('selection geometry clips, deduplicates, rejects non-finite values and remains invariant under zoom', () => {
  const rects = [{ left: 20, top: 40, right: 80, bottom: 50 }, { left: -10, top: 0, right: 10, bottom: 10 }]
  const expected = [{ x: 0.2, y: 0.2, width: 0.6, height: 0.05 }, { x: 0, y: 0, width: 0.1, height: 0.05 }]
  assert.deepEqual(normalizePdfRects([...rects, rects[0]!], { left: 0, top: 0, width: 100, height: 200 }), expected)
  assert.deepEqual(normalizePdfRects(rects.map(r => ({ left: 10 + r.left * 2, top: 30 + r.top * 2, right: 10 + r.right * 2, bottom: 30 + r.bottom * 2 })), { left: 10, top: 30, width: 200, height: 400 }), expected)
  assert.deepEqual(normalizePdfRects([{ left: NaN, top: 0, right: 20, bottom: 20 }], { left: 0, top: 0, width: 100, height: 200 }), [])
  assert.deepEqual(normalizePdfRects(rects, { left: 0, top: 0, width: 0, height: 200 }), [])
})

test('reading-note text includes source/page/hash and escapes untrusted markdown and HTML', () => {
  const f = fixture()
  try {
    const saved = f.service.create({ ...f.input, quote: '<img src=x> [click](https://bad.test)', comment: '## Not a heading' })
    const body = annotationMarkdown({ title: '# Title', doi: '10.1234/example' }, saved)
    assert.match(body, /第 1 页/); assert.match(body, /10\\\.1234\/example/); assert.ok(body.includes(saved.fingerprint))
    assert.ok(body.includes('\\<img')); assert.ok(body.includes('\\[click\\]')); assert.ok(body.includes('\\#\\# Not a heading'))
    assert.ok(!body.includes('research-pdf:'))
  } finally { f.cleanup() }
})
