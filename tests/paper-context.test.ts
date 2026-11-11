import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Db } from '../src/main/lib/db'
import { PaperContextService } from '../src/main/services/paper-context'
import { emptyPaperMemory } from '../src/shared/paper-context'
import { NoteService } from '../src/main/services/notes'
import type { DocumentService } from '../src/main/services/documents'
import type { ReferenceService } from '../src/main/services/references'
import type { ExperimentService } from '../src/main/services/experiments'
import type { FigureService } from '../src/main/services/figures'
import type { ExperimentRun, Figure } from '../src/shared/types'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rp-paper-'))
  const file = join(root, 'local.sqlite'), db = new Db(file)
  for (const projectId of ['p', 'q']) {
    const projectRoot = join(root, projectId)
    mkdirSync(join(projectRoot, 'manuscripts'), { recursive: true })
    db.run('INSERT INTO projects (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)', projectId, projectId, projectRoot, '2026-01-01', '2026-01-01')
    for (const suffix of ['', '2']) {
      const id = projectId + 'doc' + suffix
      db.run("INSERT INTO documents (id,project_id,title,format,file_name,relative_path,created_at,updated_at) VALUES (?,?,?,'latex',?,?,?,?)", id, projectId, id, id + '.tex', `manuscripts/${id}.tex`, '2026-01-01', '2026-01-01')
      writeFileSync(join(projectRoot, 'manuscripts', id + '.tex'), '\\section{Introduction}\nResearch question old draft\n\\section{Results}\nAccuracy result 0.91')
    }
  }
  let reads = 0, locked = false
  const documents = {
    get(projectId: string, id: string) {
      const row = db.get<{ id: string; title: string; format: 'latex' | 'docx'; relative_path: string }>('SELECT * FROM documents WHERE id = ? AND project_id = ?', id, projectId)
      if (!row) throw new Error('文档不存在。')
      return { id, projectId, title: row.title, format: row.format, relativePath: row.relative_path }
    },
    async readText(projectId: string, id: string) {
      reads++
      return { text: readFileSync(join(root, projectId, this.get(projectId, id).relativePath), 'utf8'), format: 'latex' as const }
    }
  }
  const references = {
    get(projectId: string, id: string) {
      const ref = db.get<any>('SELECT * FROM reference_items WHERE id = ? AND project_id = ?', id, projectId)
      if (!ref) throw new Error('文献不存在。')
      return { id, projectId, title: ref.title, authors: '', year: '', venue: '', doi: '', url: '', abstract: ref.abstract, notes: ref.notes, tags: [], bibtex: '', pdfRelativePath: ref.pdf_relative_path }
    },
    readPdf(projectId: string, id: string) {
      return { base64: readFileSync(join(root, projectId, this.get(projectId, id).pdfRelativePath)).toString('base64'), fileName: 'paper.pdf' }
    }
  }
  const notes = new NoteService(db)
  const runs = new Map<string, ExperimentRun>(), figureRecords = new Map<string, Figure>()
  const experiments = { getRun(id: string) { const run = runs.get(id); if (!run) throw new Error('missing run'); return run } }
  const figures = { get(projectId: string, id: string) { const figure = figureRecords.get(id); if (!figure || figure.projectId !== projectId) throw new Error('missing figure'); return figure } }
  const service = new PaperContextService(db, documents as unknown as DocumentService, references as unknown as ReferenceService, experiments as unknown as ExperimentService, notes, figures as unknown as FigureService, () => { if (locked) throw new Error('project locked') })
  return { root, file, db, service, notes, documents, references, runs, figureRecords, reads: () => reads, lock: () => { locked = true }, reopen(database: Db) { return new PaperContextService(database, documents as unknown as DocumentService, references as unknown as ReferenceService, experiments as unknown as ExperimentService, new NoteService(database), figures as unknown as FigureService, () => {}) }, cleanup() { db.close(); rmSync(root, { recursive: true, force: true }) } }
}

function pdf(pages: string[]): Buffer {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`]
  const font = 3 + pages.length * 2
  for (const [i, value] of pages.entries()) {
    const content = value ? `BT /F1 12 Tf 60 700 Td (${value}) Tj ET` : ''
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let text = '%PDF-1.4\n'; const offsets: number[] = []
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(text)
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(text)
}

async function docx(f: ReturnType<typeof fixture>, text = 'Safe DOCX result'): Promise<string> {
  const path = join(f.root, 'p', 'manuscripts', 'pdoc.docx')
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Results</w:t></w:r></w:p><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`)
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }))
  f.db.run("UPDATE documents SET format='docx', relative_path='manuscripts/pdoc.docx' WHERE id='pdoc'")
  return path
}

function deferDocx(f: ReturnType<typeof fixture>): { started: Promise<void>; resume: () => void } {
  let begin!: () => void, resume!: () => void
  const started = new Promise<void>(resolve => { begin = resolve })
  const paused = new Promise<void>(resolve => { resume = resolve })
  const service = f.service as unknown as { checkDocx(bytes: Buffer): Promise<void> }
  const original = service.checkDocx.bind(service)
  service.checkDocx = async bytes => { await original(bytes); begin(); await paused }
  return { started, resume }
}

function reference(f: ReturnType<typeof fixture>, id: string, pdfPath = ''): void {
  f.db.run('INSERT INTO reference_items (id,project_id,title,abstract,notes,pdf_relative_path,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'p', 'Evidence paper', 'Accuracy abstract result', 'Human notes', pdfPath, '2026-01-01', '2026-01-01')
}

test('PDF snapshots include selected text-layer pages, report scanned pages, and get never reextracts', async () => {
  const f = fixture()
  try {
    mkdirSync(join(f.root, 'p', 'references'))
    const path = join(f.root, 'p', 'references', 'paper.pdf')
    writeFileSync(path, pdf(['PDF evidence sample size 42.', '']))
    reference(f, 'ref', 'references/paper.pdf')
    let reads = 0
    const readPdf = f.references.readPdf.bind(f.references)
    f.references.readPdf = (...args) => { reads++; return readPdf(...args) }
    const linked = await f.service.link({ projectId: 'p', documentId: 'pdoc', kind: 'reference', targetId: 'ref' })
    const source = linked.sources[0]
    assert.match(source.text, /sample size 42/)
    assert.match(source.text, /PDF page 1/)
    assert.match(source.coverage, /no OCR/)
    assert.match(source.coverage, /no text on pages 2/)
    assert.equal(reads, 1)
    await f.service.get('p', 'pdoc')
    assert.equal(reads, 1)
    writeFileSync(path, pdf(['PDF evidence sample size 43.', '']))
    assert.equal((await f.service.get('p', 'pdoc')).sources[0].status, 'changed')
    assert.equal(reads, 1)
    const result = await f.service.compose({ projectId: 'p', documentId: 'pdoc', query: 'PDF evidence', chapter: '' })
    assert.equal(result.hits.some(hit => hit.kind === 'reference'), false)
    f.db.run('UPDATE reference_items SET pdf_relative_path = ? WHERE id = ?', '../private.pdf', 'ref')
    assert.equal((await f.service.get('p', 'pdoc')).sources.find(item => item.kind === 'reference')?.status, 'missing')
  } finally { f.cleanup() }
})

test('PDF capture rejects a source changed while readPdf returns old bytes without writing a snapshot', async () => {
  const f = fixture()
  try {
    const path = join(f.root, 'p', 'paper.pdf')
    writeFileSync(path, pdf(['original']))
    reference(f, 'ref', 'paper.pdf')
    f.references.readPdf = () => {
      const bytes = readFileSync(path)
      f.db.run('UPDATE reference_items SET abstract = ? WHERE id = ?', 'Changed while extracting', 'ref')
      return { base64: bytes.toString('base64'), fileName: 'paper.pdf' }
    }
    await assert.rejects(f.service.link({ projectId: 'p', documentId: 'pdoc', kind: 'reference', targetId: 'ref' }), /PAPER_SOURCE_CHANGED/)
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM paper_context_sources'), 0)
  } finally { f.cleanup() }
})

test('source text truncation is explicit and relinking deduplicates without mutating memory', async () => {
  const f = fixture()
  try {
    const note = f.notes.create({ projectId: 'p', title: 'Long note', body: 'x'.repeat(200000) })
    const sourceInput = { projectId: 'p', documentId: 'pdoc', kind: 'note' as const, targetId: note.id }
    const first = await f.service.link(sourceInput)
    assert.equal(first.sources[0].text.length, 200000)
    assert.equal(first.sources[0].truncated, true)
    const second = await f.service.link(sourceInput)
    assert.equal(second.sources.length, 1)
    assert.equal(second.sources[0].id, first.sources[0].id)
    assert.deepEqual(second.memory, emptyPaperMemory('pdoc'))
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM paper_memories'), 0)
    await assert.rejects(f.service.unlink('p', 'pdoc2', first.sources[0].id))
  } finally { f.cleanup() }
})

test('capture revalidates document and project availability after asynchronous extraction', async () => {
  const f = fixture()
  try {
    await docx(f)
    const service = f.service as unknown as { checkDocx(bytes: Buffer): Promise<void> }
    const check = service.checkDocx.bind(service)
    service.checkDocx = async bytes => { await check(bytes); f.lock() }
    await assert.rejects(f.service.compose({ projectId: 'p', documentId: 'pdoc', query: '', chapter: '' }), /locked/)
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM paper_context_sources'), 0)
  } finally { f.cleanup() }
})

test('registered run snapshots omit logs, environment and sensitive metrics; foreign runs are rejected', async () => {
  const f = fixture()
  try {
    for (const project of ['p', 'q']) {
      f.db.run('INSERT INTO experiments (id,project_id,name,created_at,updated_at) VALUES (?,?,?,?,?)', project + 'exp', project, 'Experiment', '2026-01-01', '2026-01-01')
      f.db.run('INSERT INTO experiment_runs (id,experiment_id,project_id,status,started_at) VALUES (?,?,?,?,?)', project + 'run', project + 'exp', project, 'succeeded', '2026-01-01')
      f.runs.set(project + 'run', { id: project + 'run', experimentId: project + 'exp', projectId: project, status: 'succeeded', exitCode: 0, startedAt: '2026-01-01', finishedAt: '2026-01-02', metrics: { accuracy: 0.93, api_key: 'metric-secret', tokenCount: 'sensitive-count', description: 'password=metric-password' }, artifactDir: 'runs/artifacts', command: 'private command', stdout: 'stdout-private', stderr: 'stderr-private', env: { API_KEY: 'env-private' } } as ExperimentRun)
    }
    await assert.rejects(f.service.link({ projectId: 'p', documentId: 'pdoc', kind: 'run', targetId: 'qrun' }))
    const snapshot = await f.service.link({ projectId: 'p', documentId: 'pdoc', kind: 'run', targetId: 'prun' })
    const source = snapshot.sources[0]
    assert.match(source.text, /0\.93/)
    assert.doesNotMatch(source.text, /metric-secret|metric-password|sensitive-count|stdout-private|stderr-private|env-private|private command/)
    assert.match(source.coverage, /no logs or environment/)
    f.runs.get('prun')!.metrics.accuracy = 0.95
    assert.equal((await f.service.get('p', 'pdoc')).sources[0].status, 'changed')
  } finally { f.cleanup() }
})

test('figure snapshots hash registered preview and structured model, never run figure scripts', async () => {
  const f = fixture()
  try {
    mkdirSync(join(f.root, 'p', 'figures'))
    writeFileSync(join(f.root, 'p', 'figures', 'figure.svg'), '<svg>preview</svg>')
    writeFileSync(join(f.root, 'p', 'figures', 'figure.json'), JSON.stringify({ title: 'Accuracy model', caption: '0.91', password: 'figure-secret' }))
    f.figureRecords.set('fig', { id: 'fig', projectId: 'p', name: 'Accuracy figure', caption: 'Measured accuracy', experimentId: '', filePath: 'figures/figure.svg', sourcePath: 'figures/figure.json', format: 'svg', createdAt: '2026-01-01' } as Figure)
    const linked = await f.service.link({ projectId: 'p', documentId: 'pdoc', kind: 'figure', targetId: 'fig' })
    assert.match(linked.sources[0].text, /Accuracy model/)
    assert.doesNotMatch(linked.sources[0].text, /figure-secret/)
    writeFileSync(join(f.root, 'p', 'figures', 'figure.json'), '{"title":"Revised model"}')
    assert.equal((await f.service.get('p', 'pdoc')).sources[0].status, 'changed')
    f.figureRecords.get('fig')!.filePath = '../private.svg'
    assert.equal((await f.service.get('p', 'pdoc')).sources[0].status, 'missing')
  } finally { f.cleanup() }
})

test('source cap includes the manuscript and rejects excess links without writing partial state', async () => {
  const f = fixture()
  try {
    const note = f.notes.create({ projectId: 'p', title: 'Template', body: 'Evidence' })
    const first = await f.service.link({ projectId: 'p', documentId: 'pdoc', kind: 'note', targetId: note.id })
    const template = first.sources[0]
    for (let i = 1; i < 99; i++) {
      const source = { ...template, id: `source_${i}`, targetId: `missing_${i}` }
      f.db.run('INSERT INTO paper_context_sources VALUES (?,?,?,?,?,?)', source.id, 'p', 'pdoc', 'note', source.targetId, JSON.stringify(source))
    }
    await f.service.compose({ projectId: 'p', documentId: 'pdoc', query: '', chapter: '' })
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM paper_context_sources'), 100)
    const another = f.notes.create({ projectId: 'p', title: 'Overflow', body: 'must not insert' })
    await assert.rejects(f.service.link({ projectId: 'p', documentId: 'pdoc', kind: 'note', targetId: another.id }), /100/)
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM paper_context_sources'), 100)
  } finally { f.cleanup() }
})

test('DOCX indexing validates ZIP expansion bounds before calling document text extraction', async () => {
  const f = fixture()
  try {
    const path = await docx(f)
    assert.match((await f.service.compose({ projectId: 'p', documentId: 'pdoc', query: 'Safe', chapter: '' })).text, /Safe DOCX result/)
    const oversized = new JSZip(); oversized.file('word/document.xml', 'a'.repeat(9 * 1024 * 1024))
    writeFileSync(path, await oversized.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
    let called = false
    f.documents.readText = async () => { called = true; return { text: 'must not read oversized zip', format: 'latex' } }
    const rejected = await f.service.compose({ projectId: 'p', documentId: 'pdoc', query: '', chapter: '' })
    assert.equal(called, false)
    assert.ok(rejected.warnings.length)
    assert.equal(rejected.hits.length, 0)
  } finally { f.cleanup() }
})

test('explicit refresh keeps missing evidence snapshot and reports it, and active context is bounded', async () => {
  const f = fixture()
  try {
    reference(f, 'ref')
    const linked = await f.service.link({ projectId: 'p', documentId: 'pdoc', kind: 'reference', targetId: 'ref' })
    assert.match(linked.sources[0].coverage, /PDF not attached/)
    f.db.run('DELETE FROM reference_items WHERE id = ?', 'ref')
    const refreshed = await f.service.refresh('p', 'pdoc')
    assert.equal(refreshed.sources.find(source => source.kind === 'reference')?.status, 'missing')
    assert.ok(refreshed.warnings.some(warning => warning.includes('无法刷新')))
    await f.service.activate('p', 'pdoc')
    const text = await f.service.context('p', 'result')
    assert.match(text, /WORKING CONTEXT/)
    assert.ok(text.length <= 24000)
    const manuscript = refreshed.sources.find(source => source.kind === 'manuscript')!
    await assert.rejects(f.service.unlink('p', 'pdoc', manuscript.id))
    await assert.rejects(f.service.unlink('p', 'pdoc', 'missing_source'))
    await assert.rejects(f.service.link({ projectId: 'p', documentId: 'pdoc', kind: 'manuscript' as 'note', targetId: 'pdoc' }))
    await assert.rejects(f.service.compose({ projectId: 'p', documentId: 'pdoc', query: 'q'.repeat(4001), chapter: '' }))
    await assert.rejects(f.service.compose({ projectId: 'p', documentId: 'pdoc', query: '', chapter: 'c'.repeat(501) }))
  } finally { f.cleanup() }
})

test('PDF page extraction is capped at 100 pages and explicitly discloses truncation', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'p', 'paper.pdf'), pdf(Array.from({ length: 101 }, (_, i) => `Page ${i + 1} result`)))
    reference(f, 'ref', 'paper.pdf')
    const result = await f.service.link({ projectId: 'p', documentId: 'pdoc', kind: 'reference', targetId: 'ref' })
    const source = result.sources[0]
    assert.equal(source.truncated, true)
    assert.match(source.text, /PDF page 100/)
    assert.doesNotMatch(source.text, /PDF page 101/)
    assert.match(source.coverage, /of 101/)
  } finally { f.cleanup() }
})

test('paper migration upgrades version eight with a recoverable database backup', () => {
  const f = fixture(); let upgraded: Db | undefined
  try {
    f.db.raw.exec('DROP TABLE paper_context_active; DROP TABLE paper_context_sources; DROP TABLE paper_memories; PRAGMA user_version = 8')
    upgraded = new Db(f.file)
    assert.equal(upgraded.scalar<number>('PRAGMA user_version'), 9)
    assert.ok(upgraded.migrationBackupPath)
    assert.equal(upgraded.scalar('SELECT COUNT(*) FROM documents'), 4)
    for (const table of ['paper_memories', 'paper_context_sources', 'paper_context_active']) assert.equal(upgraded.scalar(`SELECT COUNT(*) FROM ${table}`), 0)
  } finally { upgraded?.close(); f.cleanup() }
})

test('async refresh cannot resurrect a source unlinked while manuscript extraction was in flight', async () => {
  const f = fixture()
  try {
    const note = f.notes.create({ projectId: 'p', title: 'Evidence', body: 'Current evidence' })
    const linked = await f.service.link({ projectId: 'p', documentId: 'pdoc', kind: 'note', targetId: note.id })
    await docx(f, 'Manuscript after pause')
    const paused = deferDocx(f)
    const refresh = f.service.refresh('p', 'pdoc')
    await paused.started
    await f.service.unlink('p', 'pdoc', linked.sources[0].id)
    paused.resume()
    await assert.rejects(refresh, /PAPER_SOURCE_CHANGED/)
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM paper_context_sources'), 0)
  } finally { f.cleanup() }
})

test('automatic context cannot return an old manuscript after active selection changes during capture', async () => {
  const f = fixture()
  try {
    await f.service.activate('p', 'pdoc')
    await docx(f, 'old-selection-sensitive-manuscript')
    const paused = deferDocx(f)
    const pending = f.service.context('p', '')
    await paused.started
    await f.service.activate('p', 'pdoc2')
    paused.resume()
    const result = await pending
    assert.doesNotMatch(result, /old-selection-sensitive-manuscript/)
    assert.equal(result, '')
  } finally { f.cleanup() }
})

test('manuscript text is extracted from the fingerprinted bytes, never a second path reader', async () => {
  const f = fixture()
  try {
    writeFileSync(manuscriptPath(f), '\\section{Results}\nactual-checked-byte-evidence')
    f.documents.readText = async () => ({ text: '# Results\nABA-unchecked-reader-text', format: 'latex' })
    const result = await f.service.compose({ projectId: 'p', documentId: 'pdoc', query: '', chapter: 'Results' })
    assert.match(result.text, /actual-checked-byte-evidence/)
    assert.doesNotMatch(result.text, /ABA-unchecked-reader-text/)
  } finally { f.cleanup() }
})

test('compose does not await a source snapshot that can be unlinked before building context', async () => {
  const f = fixture()
  try {
    const note = f.notes.create({ projectId: 'p', title: 'Race evidence', body: '# Results\nremoved-before-compose-evidence' })
    const linked = await f.service.link({ projectId: 'p', documentId: 'pdoc', kind: 'note', targetId: note.id })
    const original = f.service.get.bind(f.service)
    let armed = true
    f.service.get = async (...args) => {
      const snapshot = await original(...args)
      if (armed) { armed = false; await f.service.unlink('p', 'pdoc', linked.sources[0].id) }
      return snapshot
    }
    const result = await f.service.compose({ projectId: 'p', documentId: 'pdoc', query: '', chapter: 'Results' })
    // A synchronous final snapshot removes this hook entirely; otherwise changed membership must be rechecked.
    if (!armed) assert.doesNotMatch(result.text, /removed-before-compose-evidence/)
  } finally { f.cleanup() }
})

const manuscriptPath = (f: ReturnType<typeof fixture>) => join(f.root, 'p', 'manuscripts', 'pdoc.tex')

test('memory uses optimistic revisions, never autosaves, and active selection survives reopen', async () => {
  const f = fixture(); let second: Db | undefined
  try {
    const initial = await f.service.get('p', 'pdoc')
    assert.deepEqual(initial.memory, emptyPaperMemory('pdoc'))
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM paper_memories'), 0)
    const first = await f.service.save('p', { ...initial.memory, question: 'Which method generalizes?' })
    assert.equal(first.memory.revision, initial.memory.revision + 1)
    await assert.rejects(f.service.save('p', { ...initial.memory, question: 'stale' }), /PAPER_MEMORY_CONFLICT/)
    assert.equal((await f.service.get('p', 'pdoc')).memory.question, 'Which method generalizes?')
    await f.service.activate('p', 'pdoc')
    second = new Db(f.file)
    assert.equal((await f.reopen(second).get('p', 'pdoc')).active, true)
    await f.service.activate('p', 'pdoc2')
    assert.equal((await f.service.get('p', 'pdoc')).active, false)
    assert.equal((await f.service.get('p', 'pdoc2')).active, true)
    await f.service.deactivate('p')
    assert.equal(await f.service.context('p', 'method'), '')
  } finally { second?.close(); f.cleanup() }
})

test('every operation rejects foreign/malformed/missing documents and respects availability', async () => {
  const f = fixture()
  try {
    for (const id of ['qdoc', 'missing', '../pdoc', 'pdoc\n']) {
      await assert.rejects(f.service.get('p', id))
      await assert.rejects(f.service.activate('p', id))
      await assert.rejects(f.service.compose({ projectId: 'p', documentId: id, query: '', chapter: '' }))
    }
    const foreign = f.notes.create({ projectId: 'q', title: 'Foreign', body: 'foreign material' })
    await assert.rejects(f.service.link({ projectId: 'p', documentId: 'pdoc', kind: 'note', targetId: foreign.id }))
    f.lock()
    await assert.rejects(f.service.get('p', 'pdoc'), /locked/)
    await assert.rejects(f.service.context('p', ''), /locked/)
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM paper_context_sources'), 0)
  } finally { f.cleanup() }
})

test('compose indexes only the selected manuscript and refreshes bytes without timestamp changes', async () => {
  const f = fixture()
  try {
    assert.equal((await f.service.get('p', 'pdoc')).sources.length, 0)
    const first = await f.service.compose({ projectId: 'p', documentId: 'pdoc', query: 'Accuracy', chapter: 'Results' })
    assert.ok(first.hits.some(hit => hit.kind === 'manuscript'))
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM paper_context_sources'), 1)
    const old = (await f.service.get('p', 'pdoc')).sources[0]
    writeFileSync(manuscriptPath(f), '\\section{Results}\nAccuracy result changed 0.97')
    assert.equal((await f.service.get('p', 'pdoc')).sources[0].status, 'changed')
    const next = await f.service.compose({ projectId: 'p', documentId: 'pdoc', query: 'Accuracy', chapter: 'Results' })
    assert.match(next.text, /0\.97/)
    assert.notEqual((await f.service.get('p', 'pdoc')).sources[0].hash, old.hash)
    assert.equal((await f.service.get('p', 'pdoc2')).sources.length, 0)
  } finally { f.cleanup() }
})

test('linked note changes and trash are excluded until explicit refresh, with provenance and redaction', async () => {
  const f = fixture()
  try {
    const note = f.notes.create({ projectId: 'p', title: 'Evidence', body: '# Results\nAccuracy linkedOriginal api_key=secret-value Bearer abcdefghijkl\n' + 'z'.repeat(26000) + '\nlate-important-evidence' })
    const linked = await f.service.link({ projectId: 'p', documentId: 'pdoc', kind: 'note', targetId: note.id })
    const source = linked.sources.find(source => source.kind === 'note')!
    assert.equal(source.status, 'current')
    assert.ok(source.text.includes('late-important-evidence'))
    assert.doesNotMatch(source.text, /secret-value|abcdefghijkl/)
    assert.match(source.locator, /note/)
    assert.equal(source.hash.length, 64)
    f.notes.update({ projectId: 'p', id: note.id, title: note.title, body: '# Results\nAccuracy linkedNewest', expectedRevision: note.revision })
    const stale = await f.service.get('p', 'pdoc')
    assert.equal(stale.sources.find(item => item.id === source.id)?.status, 'changed')
    const result = await f.service.compose({ projectId: 'p', documentId: 'pdoc', query: 'linkedOriginal linkedNewest', chapter: 'Results' })
    assert.ok(result.warnings.length)
    assert.equal(result.hits.some(hit => hit.kind === 'note'), false)
    assert.doesNotMatch(result.hits.map(hit => hit.excerpt).join('\n'), /linkedOriginal|linkedNewest/)
    const refreshed = await f.service.refresh('p', 'pdoc')
    assert.equal(refreshed.sources.find(item => item.id === source.id)?.status, 'current')
    f.notes.trash('p', note.id)
    assert.equal((await f.service.get('p', 'pdoc')).sources.find(item => item.id === source.id)?.status, 'missing')
    await f.service.unlink('p', 'pdoc', source.id)
    assert.equal((await f.service.get('p', 'pdoc')).sources.some(item => item.id === source.id), false)
  } finally { f.cleanup() }
})

test('missing or unsafe manuscript is reported without reading linked files or clobbering sources', async () => {
  const f = fixture()
  try {
    await f.service.compose({ projectId: 'p', documentId: 'pdoc', query: 'result', chapter: '' })
    rmSync(manuscriptPath(f))
    assert.equal((await f.service.get('p', 'pdoc')).sources[0].status, 'missing')
    const output = await f.service.compose({ projectId: 'p', documentId: 'pdoc', query: '', chapter: '' })
    assert.equal(output.hits.length, 0)
    assert.ok(output.warnings.length)
    const secret = join(f.root, 'private.tex'); writeFileSync(secret, 'private-file-secret')
    linkSync(secret, manuscriptPath(f))
    const reads = f.reads()
    await f.service.compose({ projectId: 'p', documentId: 'pdoc', query: '', chapter: '' })
    assert.equal(f.reads(), reads)
    assert.equal((await f.service.get('p', 'pdoc')).sources[0].status, 'missing')
  } finally { f.cleanup() }
})

test('link detects mutation during async extraction and leaves no snapshot behind', async () => {
  const f = fixture()
  try {
    const path = await docx(f)
    const service = f.service as unknown as { checkDocx(bytes: Buffer): Promise<void> }
    const check = service.checkDocx.bind(service)
    service.checkDocx = async bytes => { await check(bytes); writeFileSync(path, 'Changed while extracting') }
    await assert.rejects(f.service.compose({ projectId: 'p', documentId: 'pdoc', query: '', chapter: '' }), /PAPER_SOURCE_CHANGED/)
    assert.equal(f.db.scalar('SELECT COUNT(*) FROM paper_context_sources'), 0)
  } finally { f.cleanup() }
})

test('document and project deletions cascade paper memory, source snapshots and active selection', async () => {
  const f = fixture()
  try {
    await f.service.save('p', { ...emptyPaperMemory('pdoc'), contribution: 'A contribution' })
    await f.service.activate('p', 'pdoc')
    await f.service.compose({ projectId: 'p', documentId: 'pdoc', query: '', chapter: '' })
    f.db.run('DELETE FROM documents WHERE id = ?', 'pdoc')
    for (const table of ['paper_memories', 'paper_context_sources', 'paper_context_active']) assert.equal(f.db.scalar(`SELECT COUNT(*) FROM ${table}`), 0)
  } finally { f.cleanup() }
})
