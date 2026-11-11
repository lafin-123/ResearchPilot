import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import type { Db } from '../lib/db'
import { extractPdfPages } from '../lib/research-sources'
import { newId, nowIso } from '../lib/util'
import { readMcpFile } from './mcp-tools'
import type { DocumentService } from './documents'
import type { ReferenceService } from './references'
import type { ExperimentService } from './experiments'
import type { NoteService } from './notes'
import type { FigureService } from './figures'
import {
  buildPaperContext, emptyPaperMemory, parsePaperMemory, parsePaperTarget, splitPaperSections,
  redactPaperText as publicText, PAPER_CONTEXT_LIMITS,
  type PaperContextInput, type PaperContextResult, type PaperMemory, type PaperSnapshot,
  type PaperSource, type PaperSourceInput, type PaperSourceKind
} from '../../shared/paper-context'

const MAX_TEXT = PAPER_CONTEXT_LIMITS.sourceChars
const MAX_SOURCES = PAPER_CONTEXT_LIMITS.sources
const PDF_BYTES = 64 * 1024 * 1024
interface SourceRow { id: string; project_id: string; document_id: string; kind: PaperSourceKind; target_id: string; content_json: string }
interface Fingerprint { hash: string; title: string; locator: string; metadata: string; pdf?: Buffer; bytes?: Buffer; path?: string; format?: string }
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

function changed(): never { throw new Error('PAPER_SOURCE_CHANGED: 来源在提取期间发生变化，请重新检查后刷新。') }
function memoryConflict(): never { throw new Error('PAPER_MEMORY_CONFLICT: 论文工作记忆已更新，请保留草稿并重新加载，不能覆盖较新版本。') }
function publicData(value: unknown): unknown {
  if (typeof value === 'string') return publicText(value)
  if (Array.isArray(value)) return value.map(publicData)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [publicText(key), /key|token|password|secret|credential|env/i.test(key) ? '[redacted]' : publicData(item)]))
  return value
}
function safeMetrics(value: Record<string, number | string>): Record<string, number | string> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/key|token|password|secret|credential|env/i.test(key)).slice(0, 100).map(([key, metric]) => [publicText(key).slice(0, 100), typeof metric === 'number' ? metric : publicText(String(metric)).slice(0, 1000)]))
}

/** Explicit, local paper working memory. Source text is evidence data, never instructions. */
export class PaperContextService {
  constructor(
    private readonly db: Db,
    private readonly documents: DocumentService,
    private readonly references: ReferenceService,
    private readonly experiments: ExperimentService,
    private readonly notes: NoteService,
    private readonly figures: FigureService,
    private readonly assertAvailable: (projectId: string) => void
  ) {}

  private project(projectId: string): string {
    parsePaperTarget({ projectId, documentId: 'validation' })
    this.assertAvailable(projectId)
    const project = this.db.get<{ root_path: string }>('SELECT root_path FROM projects WHERE id = ?', projectId)
    if (!project) throw new Error('项目不存在或已删除。')
    return project.root_path
  }

  private requireDocument(projectId: string, documentId: string): void {
    parsePaperTarget({ projectId, documentId })
    this.project(projectId)
    if (!this.db.get('SELECT id FROM documents WHERE id = ? AND project_id = ?', documentId, projectId)) throw new Error('文档不存在或不属于当前项目。')
    this.documents.get(projectId, documentId)
  }

  private memory(projectId: string, documentId: string): PaperMemory {
    const row = this.db.get<{ content_json: string }>('SELECT content_json FROM paper_memories WHERE project_id = ? AND document_id = ?', projectId, documentId)
    return row ? parsePaperMemory(JSON.parse(row.content_json)) : emptyPaperMemory(documentId)
  }

  private rows(projectId: string, documentId: string): SourceRow[] {
    return this.db.all<SourceRow>('SELECT * FROM paper_context_sources WHERE project_id = ? AND document_id = ? ORDER BY kind, id', projectId, documentId)
  }

  /** Fingerprint only registered content, not mtime, logs, environment or arbitrary workspace files. */
  private fingerprint(projectId: string, kind: PaperSourceKind, targetId: string): Fingerprint {
    parsePaperTarget({ projectId, documentId: targetId })
    const root = this.project(projectId)
    let title: string, locator: string, metadata: string, pdf: Buffer | undefined, bytes: Buffer | undefined, path: string | undefined, format: string | undefined
    if (kind === 'manuscript') {
      this.requireDocument(projectId, targetId)
      const doc = this.documents.get(projectId, targetId)
      if (!doc.relativePath.replaceAll('\\', '/').startsWith('manuscripts/')) throw new Error('文稿不在 manuscripts 目录。')
      bytes = readMcpFile(root, doc.relativePath, doc.format === 'docx' ? 6 * 1024 * 1024 : 2 * 1024 * 1024)
      title = doc.title; locator = `document:${doc.id}`; path = doc.relativePath; format = doc.format
      metadata = JSON.stringify({ title, path, format, bytes: sha(bytes) })
    } else if (kind === 'reference') {
      const ref = this.references.get(projectId, targetId)
      if (ref.projectId !== projectId) throw new Error('文献不属于当前项目。')
      title = ref.title; locator = `reference:${ref.id}`
      if (ref.pdfRelativePath) pdf = readMcpFile(root, ref.pdfRelativePath, PDF_BYTES)
      metadata = JSON.stringify({ title, authors: ref.authors, year: ref.year, venue: ref.venue, doi: ref.doi, url: ref.url, abstract: ref.abstract, notes: ref.notes, tags: ref.tags, bibtex: ref.bibtex, pdfPath: ref.pdfRelativePath, pdfHash: pdf ? sha(pdf) : '' })
    } else if (kind === 'note') {
      const note = this.notes.get(projectId, targetId)
      if (note.projectId !== projectId || note.deletedAt) throw new Error('笔记已删除或不属于当前项目。')
      title = note.title; locator = `note:${note.id}`
      metadata = JSON.stringify({ title, body: note.body })
    } else if (kind === 'run') {
      if (!this.db.get('SELECT r.id FROM experiment_runs r JOIN experiments e ON e.id = r.experiment_id WHERE r.id = ? AND r.project_id = ? AND e.project_id = ?', targetId, projectId, projectId)) throw new Error('实验运行不存在或不属于当前项目。')
      const run = this.experiments.getRun(targetId)
      if (run.projectId !== projectId) throw new Error('实验运行不属于当前项目。')
      title = `Run ${run.id}`; locator = `run:${run.id}`
      metadata = JSON.stringify({ experimentId: run.experimentId, status: run.status, exitCode: run.exitCode, startedAt: run.startedAt, finishedAt: run.finishedAt, metrics: safeMetrics(run.metrics), artifactDir: run.artifactDir })
    } else if (kind === 'figure') {
      const figure = this.figures.get(projectId, targetId)
      if (figure.projectId !== projectId) throw new Error('图表不属于当前项目。')
      const bytes = readMcpFile(root, figure.filePath, 32 * 1024 * 1024)
      const source = figure.sourcePath ? readMcpFile(root, figure.sourcePath, 2 * 1024 * 1024) : undefined
      title = figure.name; locator = `figure:${figure.id}`
      metadata = JSON.stringify({ title, caption: figure.caption, experimentId: figure.experimentId, format: figure.format, path: figure.filePath, bytes: sha(bytes), sourcePath: figure.sourcePath ?? '', source: source?.toString('utf8') ?? '' })
    } else throw new Error('不支持的论文来源类型。')
    return { hash: sha(metadata), title: publicText(title).slice(0, 1000), locator, metadata, pdf, bytes, path, format }
  }

  async get(projectId: string, documentId: string): Promise<PaperSnapshot> {
    return this.snapshot(projectId, documentId)
  }

  private snapshot(projectId: string, documentId: string): PaperSnapshot {
    this.requireDocument(projectId, documentId)
    const warnings: string[] = []
    const sources: PaperSnapshot['sources'] = this.rows(projectId, documentId).map(row => {
      const source = JSON.parse(row.content_json) as PaperSource
      try {
        const current = this.fingerprint(projectId, row.kind, row.target_id)
        if (current.hash === source.hash) return { ...source, status: 'current' as const }
        warnings.push(`来源已变化：${source.title}；旧快照不用于上下文，请刷新并复核相关章节。`)
        return { ...source, status: 'changed' as const }
      } catch {
        // Do not leak machine paths or raw parser errors into model context.
        const error = '来源已缺失、移入回收站或无法安全读取；旧快照不用于上下文。'
        warnings.push(`${source.kind}:${source.targetId}：${error}`)
        return { ...source, status: 'missing' as const, error }
      }
    })
    this.requireDocument(projectId, documentId)
    return { memory: this.memory(projectId, documentId), sources, active: this.db.scalar<string>('SELECT document_id FROM paper_context_active WHERE project_id = ?', projectId) === documentId, warnings }
  }

  async save(projectId: string, rawMemory: unknown): Promise<PaperSnapshot> {
    const input = parsePaperMemory(rawMemory)
    this.requireDocument(projectId, input.documentId)
    this.db.transaction(() => {
      this.requireDocument(projectId, input.documentId)
      const current = this.memory(projectId, input.documentId)
      if (current.revision !== input.revision) memoryConflict()
      if (input.revision >= Number.MAX_SAFE_INTEGER) throw new Error('论文记忆修订号已达到上限。')
      const saved = { ...input, revision: input.revision + 1 }
      this.db.run('INSERT INTO paper_memories (project_id,document_id,revision,content_json,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET revision=excluded.revision, content_json=excluded.content_json, updated_at=excluded.updated_at WHERE paper_memories.project_id=excluded.project_id', projectId, input.documentId, saved.revision, JSON.stringify(saved), nowIso())
    })
    return this.get(projectId, input.documentId)
  }

  async activate(projectId: string, documentId: string): Promise<PaperSnapshot> {
    this.requireDocument(projectId, documentId)
    this.db.run('INSERT INTO paper_context_active (project_id,document_id) VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET document_id=excluded.document_id', projectId, documentId)
    return this.get(projectId, documentId)
  }

  async deactivate(projectId: string): Promise<void> {
    this.project(projectId)
    this.db.run('DELETE FROM paper_context_active WHERE project_id = ?', projectId)
  }

  private async checkDocx(bytes: Buffer): Promise<void> {
    const zip = await JSZip.loadAsync(bytes, { createFolders: false })
    const files = Object.values(zip.files)
    if (files.length > 2000) throw new Error('文稿压缩条目超过上限。')
    let total = 0
    for (const file of files) {
      if (file.dir) continue
      const size = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
      if (!Number.isSafeInteger(size) || size! < 0 || size! > 8 * 1024 * 1024) throw new Error('文稿压缩成员超过上限。')
      total += size!
      if (total > 24 * 1024 * 1024) throw new Error('文稿解压总量超过上限。')
    }
  }

  private async capture(projectId: string, kind: PaperSourceKind, targetId: string, id = newId('paper_source')): Promise<PaperSource> {
    const before = this.fingerprint(projectId, kind, targetId)
    let text = '', coverage = '', truncated = false
    if (kind === 'manuscript') {
      if (before.format === 'docx') {
        await this.checkDocx(before.bytes!)
        text = (await mammoth.extractRawText({ buffer: before.bytes! })).value
      } else text = before.bytes!.toString('utf8')
      coverage = before.format === 'docx'
        ? 'DOCX raw paragraph text; original heading styles/chapter hierarchy not preserved; standalone headings inferred conservatively; not semantic verification'
        : 'LaTeX manuscript source text; section commands available; not semantic verification'
    } else if (kind === 'reference') {
      const ref = this.references.get(projectId, targetId)
      text = [`# ${ref.title}`, `Authors: ${ref.authors}; Year: ${ref.year}; Venue: ${ref.venue}`, `DOI: ${ref.doi}`, `URL: ${ref.url}`, '## Abstract', ref.abstract, '## Reference notes', ref.notes].join('\n')
      coverage = 'metadata, abstract and reference notes only; PDF not attached'
      if (before.pdf) {
        const data = this.references.readPdf(projectId, targetId)
        if (data.base64.length > Math.ceil(PDF_BYTES / 3) * 4) throw new Error('PDF 超过 64 MiB 上限。')
        const bytes = Buffer.from(data.base64, 'base64')
        if (sha(bytes) !== sha(before.pdf)) changed()
        let page = 1, offset = 0, totalPages = 0
        const captured = new Set<number>(), noText = new Set<number>()
        while (page <= 100 && text.length < MAX_TEXT) {
          const result = await extractPdfPages(bytes, { startPage: page, pageCount: Math.min(10, 101 - page), pageOffset: offset, maxChars: Math.min(30_000, MAX_TEXT - text.length) })
          totalPages = result.totalPages
          for (const item of result.pages) {
            captured.add(item.page)
            text += `\n\n## PDF page ${item.page} offset ${item.offset}\n${item.text}`
          }
          result.noTextPages.forEach(number => noText.add(number))
          if (result.nextPage === null) break
          if (result.nextPage === page && result.nextOffset <= offset) throw new Error('PDF 提取没有进展。')
          page = result.nextPage; offset = result.nextOffset
          if (text.length >= MAX_TEXT || page > 100) truncated = true
        }
        if (text.length >= MAX_TEXT) truncated = true
        coverage = `metadata + PDF text layer pages ${[...captured].join(',') || 'none'} of ${totalPages || '?'}; limit 100 pages / 200000 characters; no OCR; ${noText.size ? `no text on pages ${[...noText].join(',')}; scanned content not extracted; ` : ''}images, equations and table structure not verified`
      }
    } else {
      const metadata = JSON.parse(before.metadata) as Record<string, unknown>
      if (kind === 'note') { text = `# ${String(metadata.title)}\n${String(metadata.body)}`; coverage = 'explicitly linked active project note' }
      else if (kind === 'run') { text = `# ${before.title}\n${JSON.stringify(metadata, null, 2)}`; coverage = 'registered run status, metrics and artifact-directory metadata only; no logs or environment; no artifact contents verified' }
      else {
        if (typeof metadata.source === 'string' && metadata.source) metadata.source = publicData(JSON.parse(metadata.source))
        text = `# ${before.title}\n${JSON.stringify(publicData(metadata), null, 2)}`
        coverage = 'registered figure metadata and structured source when present; file SHA checked; no visual interpretation or scientific verification'
      }
    }
    // Redact BEFORE truncation so a private-key block spanning the boundary cannot leak.
    text = publicText(text)
    if (text.length > MAX_TEXT) truncated = true
    text = text.slice(0, MAX_TEXT)
    if (this.fingerprint(projectId, kind, targetId).hash !== before.hash) changed()
    return { id, kind, targetId, title: before.title, locator: before.locator, hash: before.hash, capturedAt: nowIso(), text, coverage: publicText(coverage).slice(0, 6000), truncated, sections: splitPaperSections(text) }
  }

  private store(projectId: string, documentId: string, sources: Array<{ source: PaperSource; previous?: SourceRow }>): void {
    this.db.transaction(() => {
      this.requireDocument(projectId, documentId)
      const rows = this.rows(projectId, documentId)
      const additions = sources.filter(({ source }) => !rows.some(row => row.kind === source.kind && row.target_id === source.targetId)).length
      if (rows.length + additions > MAX_SOURCES) throw new Error('每篇论文最多关联 100 个来源（含文稿）。')
      for (const { source, previous } of sources) {
        const current = rows.find(row => row.kind === source.kind && row.target_id === source.targetId)
        if (current?.content_json !== previous?.content_json || current?.id !== previous?.id) changed()
        if (this.fingerprint(projectId, source.kind, source.targetId).hash !== source.hash) changed()
      }
      for (const { source } of sources) {
        this.db.run('INSERT INTO paper_context_sources (id,project_id,document_id,kind,target_id,content_json) VALUES (?,?,?,?,?,?) ON CONFLICT(document_id,kind,target_id) DO UPDATE SET content_json=excluded.content_json', source.id, projectId, documentId, source.kind, source.targetId, JSON.stringify(source))
      }
    })
  }

  async link(input: PaperSourceInput): Promise<PaperSnapshot> {
    const { projectId, documentId, kind, targetId } = input
    this.requireDocument(projectId, documentId)
    if (!['reference', 'run', 'note', 'figure'].includes(kind)) throw new Error('仅可显式关联文献、运行、笔记或图表。')
    parsePaperTarget({ projectId, documentId: targetId })
    const rows = this.rows(projectId, documentId)
    const previous = rows.find(row => row.kind === kind && row.target_id === targetId)
    if (!previous && rows.length >= MAX_SOURCES) throw new Error('每篇论文最多关联 100 个来源（含文稿）。')
    const source = await this.capture(projectId, kind, targetId, previous?.id)
    this.store(projectId, documentId, [{ source, previous }])
    return this.get(projectId, documentId)
  }

  async unlink(projectId: string, documentId: string, sourceId: string): Promise<PaperSnapshot> {
    this.requireDocument(projectId, documentId)
    parsePaperTarget({ projectId, documentId: sourceId })
    const row = this.db.get<SourceRow>('SELECT * FROM paper_context_sources WHERE project_id = ? AND document_id = ? AND id = ?', projectId, documentId, sourceId)
    if (!row) throw new Error('论文来源不存在或不属于当前文稿。')
    if (row.kind === 'manuscript') throw new Error('主文稿来源不能解除关联。')
    this.db.run('DELETE FROM paper_context_sources WHERE id = ? AND project_id = ? AND document_id = ?', sourceId, projectId, documentId)
    return this.get(projectId, documentId)
  }

  async refresh(projectId: string, documentId: string): Promise<PaperSnapshot> {
    this.requireDocument(projectId, documentId)
    const prepared: Array<{ source: PaperSource; previous?: SourceRow }> = []
    const warnings: string[] = []
    const rows = this.rows(projectId, documentId)
    const targets = [...rows]
    if (!rows.some(row => row.kind === 'manuscript')) targets.push({ id: newId('paper_source'), project_id: projectId, document_id: documentId, kind: 'manuscript', target_id: documentId, content_json: '' })
    for (const row of targets) {
      try { prepared.push({ source: await this.capture(projectId, row.kind, row.target_id, row.id), previous: rows.find(item => item.id === row.id) }) }
      catch (error) {
        if (error instanceof Error && error.message.startsWith('PAPER_SOURCE_CHANGED:')) throw error
        warnings.push(`无法刷新 ${row.kind}:${row.target_id}；旧快照保留但不可作为当前证据。`)
      }
    }
    this.store(projectId, documentId, prepared)
    const snapshot = await this.get(projectId, documentId)
    snapshot.warnings.push(...warnings)
    return snapshot
  }

  async compose(input: PaperContextInput): Promise<PaperContextResult> {
    const { projectId, documentId, query, chapter } = input
    this.requireDocument(projectId, documentId)
    if (typeof query !== 'string' || query.length > 2000 || typeof chapter !== 'string' || chapter.length > 200 || query.includes('\0') || chapter.includes('\0')) throw new Error('论文上下文 query/chapter 无效或超过上限。')
    const previous = this.rows(projectId, documentId).find(row => row.kind === 'manuscript')
    const warnings: string[] = []
    try {
      const fingerprint = this.fingerprint(projectId, 'manuscript', documentId)
      if (!previous || (JSON.parse(previous.content_json) as PaperSource).hash !== fingerprint.hash) {
        const source = await this.capture(projectId, 'manuscript', documentId, previous?.id)
        this.store(projectId, documentId, [{ source, previous }])
        if (previous) warnings.push('主文稿内容已更新；请复核当前章节与工作记忆的一致性。')
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('PAPER_SOURCE_CHANGED:')) throw error
      warnings.push('主文稿无法安全读取或索引；没有将不可读取的内容作为证据。')
    }
    const snapshot = this.snapshot(projectId, documentId)
    const memory = snapshot.memory
    const safeMemory: PaperMemory = {
      ...memory,
      question: publicText(memory.question), hypothesis: publicText(memory.hypothesis),
      contribution: publicText(memory.contribution), scope: publicText(memory.scope), terms: publicText(memory.terms),
      decisions: memory.decisions.map(item => ({ ...item, text: publicText(item.text), chapter: publicText(item.chapter) })),
      issues: memory.issues.map(item => ({ ...item, text: publicText(item.text), chapter: publicText(item.chapter) }))
    }
    const current = snapshot.sources.filter(source => source.status === 'current')
    const extraWarnings = [...new Set([...snapshot.warnings, ...warnings])].slice(0, 100).map(value => publicText(value).slice(0, 500))
    return buildPaperContext(safeMemory, current, publicText(query), publicText(chapter), extraWarnings)
  }

  async context(projectId: string, query: string): Promise<string> {
    this.project(projectId)
    const documentId = this.db.scalar<string>('SELECT document_id FROM paper_context_active WHERE project_id = ?', projectId)
    if (!documentId) return ''
    if (typeof query !== 'string') throw new Error('论文上下文 query 必须为文本。')
    const result = await this.compose({ projectId, documentId, query: query.slice(0, 2000), chapter: '' })
    this.project(projectId)
    if (this.db.scalar<string>('SELECT document_id FROM paper_context_active WHERE project_id = ?', projectId) !== documentId) return ''
    return result.text
  }
}
