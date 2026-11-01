import { createHash } from 'node:crypto'
import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CrossrefResult, Reference, ReferenceInput, ReferenceReadingDraft, ReferenceReadingDraftInput } from '@shared/types'
import type { Db } from '../lib/db'
import { ensureDir, relativePath } from '../lib/paths'
import { newId, nowIso, parseJson, slugify } from '../lib/util'
import { KnowledgeService } from './knowledge'
import { figurePath, readFigureFile } from '../lib/figure-files'
import { requestViaSystemProxy } from '../lib/network'
import type { ReferenceReadChannel } from '../../shared/knowledge'

interface ReferenceRow {
  id: string
  project_id: string
  title: string
  authors: string
  year: string
  venue: string
  doi: string
  url: string
  abstract: string
  tags_json: string
  notes: string
  pdf_relative_path: string
  bibtex: string
  created_at: string
  updated_at: string
}

interface ReadingDraftRow {
  id: string
  project_id: string
  reference_id: string
  source_hash: string
  source_coverage: 'abstract-only'
  content: string
  model_label: string
  created_at: string
}

interface ProjectRow {
  id: string
  root_path: string
}

function mapReference(row: ReferenceRow): Reference {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    authors: row.authors,
    year: row.year,
    venue: row.venue,
    doi: row.doi,
    url: row.url,
    abstract: row.abstract,
    tags: parseJson<string[]>(row.tags_json, []),
    notes: row.notes,
    pdfRelativePath: row.pdf_relative_path,
    bibtex: row.bibtex,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function crossrefToResult(item: Record<string, unknown>): CrossrefResult {
  const title = Array.isArray(item.title) ? String(item.title[0] ?? '') : String(item.title ?? '')
  const authors = Array.isArray(item.author)
    ? item.author
        .map((author) => {
          const record = author as Record<string, unknown>
          return [record.given, record.family].filter(Boolean).join(' ')
        })
        .filter(Boolean)
        .join(', ')
    : ''
  const issued = item.issued as Record<string, unknown> | undefined
  const dateParts = issued?.['date-parts'] as number[][] | undefined
  const year = dateParts?.[0]?.[0] ? String(dateParts[0][0]) : ''
  const venue = Array.isArray(item['container-title']) ? String(item['container-title'][0] ?? '') : ''
  return {
    title: title.replace(/<[^>]+>/g, ''),
    authors,
    year,
    venue,
    doi: String(item.DOI ?? ''),
    url: String(item.URL ?? ''),
    abstract: String(item.abstract ?? '').replace(/<[^>]+>/g, '')
  }
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await requestViaSystemProxy(url, {
    redirect: 'error',
    headers: { 'User-Agent': 'ResearchPilot/0.7 (research desktop app)', Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new Error(`Crossref 请求失败：HTTP ${response.status}`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Crossref 返回为空。')
  const chunks: Uint8Array[] = []; let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 2 * 1024 * 1024) throw new Error('Crossref 元数据超过大小上限。')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

export async function searchCrossref(query: string, rows = 10, signal?: AbortSignal): Promise<CrossrefResult[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(trimmed)}&rows=${Math.min(Math.max(rows, 1), 25)}&select=title,author,issued,container-title,DOI,URL,abstract`
  const payload = (await fetchJson(url, signal)) as { message?: { items?: Record<string, unknown>[] } }
  return (payload.message?.items ?? []).map(crossrefToResult).filter((item) => item.title)
}

export async function lookupDoi(doi: string, signal?: AbortSignal): Promise<CrossrefResult> {
  const clean = doi.trim().replace(/^https?:\/\/doi\.org\//i, '')
  if (!/^10\.\d{4,9}\/[^\s<>"#?]+$/i.test(clean) || clean.length > 300) throw new Error('DOI 格式无效。')
  const payload = (await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(clean)}`, signal)) as { message?: Record<string, unknown> }
  if (!payload.message) throw new Error('未找到该 DOI。')
  const result = crossrefToResult(payload.message)
  if (!result.title || result.doi.toLowerCase() !== clean.toLowerCase()) throw new Error('Crossref 返回的 DOI 与请求不匹配。')
  return result
}

function toBibtex(reference: { title: string; authors: string; year: string; venue: string; doi: string; url: string }): string {
  const key = slugify(reference.authors.split(',')[0] ?? 'ref', 'ref').replaceAll('-', '') + reference.year
  const fields = [
    `  title = {${reference.title}}`,
    reference.authors ? `  author = {${reference.authors}}` : '',
    reference.year ? `  year = {${reference.year}}` : '',
    reference.venue ? `  journal = {${reference.venue}}` : '',
    reference.doi ? `  doi = {${reference.doi}}` : '',
    reference.url ? `  url = {${reference.url}}` : ''
  ].filter(Boolean)
  return `@article{${key},\n${fields.join(',\n')}\n}`
}

export function parseBibtex(text: string): Array<Partial<ReferenceInput> & { title: string }> {
  const results: Array<Partial<ReferenceInput> & { title: string }> = []
  const entryPattern = /@\w+\s*\{[^,]*,/g
  let match: RegExpExecArray | null
  while ((match = entryPattern.exec(text)) !== null) {
    // The entry ends at its balanced outer brace, not at the title field's first closing brace.
    const start = entryPattern.lastIndex
    let end = start
    let depth = 1
    let quoted = false
    for (; end < text.length; end++) {
      const char = text[end]
      if (char === '\\') { end++; continue }
      if (char === '"') { quoted = !quoted; continue }
      if (quoted) continue
      if (char === '{') depth++
      if (char === '}' && --depth === 0) break
    }
    if (depth !== 0) break
    entryPattern.lastIndex = end + 1
    const body = text.slice(start, end)
    const field = (name: string): string => {
      const result = new RegExp(`${name}\\s*=\\s*[{"]([\\s\\S]*?)[}"]\\s*,?`, 'i').exec(body)
      return result?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
    }
    const title = field('title')
    if (!title) continue
    results.push({
      title,
      authors: field('author').replace(/\s+and\s+/g, ', '),
      year: field('year'),
      venue: field('journal') || field('booktitle'),
      doi: field('doi'),
      url: field('url'),
      abstract: field('abstract'),
      bibtex: `@article{${slugify(title)},\n${body.trim()}\n}`
    })
  }
  return results
}

export class ReferenceService {
  private readonly knowledge: KnowledgeService
  constructor(private readonly db: Db, knowledge?: KnowledgeService) { this.knowledge = knowledge ?? new KnowledgeService(db) }

  recordRead(projectId: string, id: string, channel: ReferenceReadChannel): void {
    this.knowledge.recordRead(projectId, id, channel)
  }

  private projectRoot(projectId: string): string {
    const row = this.db.get<ProjectRow>('SELECT id, root_path FROM projects WHERE id = ?', projectId)
    if (!row) throw new Error('项目不存在。')
    return row.root_path
  }

  list(projectId: string, query = ''): Reference[] {
    const rows = query.trim()
      ? this.db.all<ReferenceRow>(
          'SELECT * FROM reference_items WHERE project_id = ? AND (title LIKE ? OR authors LIKE ? OR notes LIKE ? OR tags_json LIKE ?) ORDER BY updated_at DESC',
          projectId,
          `%${query.trim()}%`,
          `%${query.trim()}%`,
          `%${query.trim()}%`,
          `%${query.trim()}%`
        )
      : this.db.all<ReferenceRow>('SELECT * FROM reference_items WHERE project_id = ? ORDER BY updated_at DESC', projectId)
    return rows.map(mapReference)
  }

  get(projectId: string, id: string): Reference {
    const row = this.db.get<ReferenceRow>('SELECT * FROM reference_items WHERE id = ? AND project_id = ?', id, projectId)
    if (!row) throw new Error('文献不存在。')
    return mapReference(row)
  }

  getReadingSourceHash(projectId: string, id: string): string {
    const reference = this.get(projectId, id)
    // Only these registered fields are evidence for the abstract-only reading task.
    // Human notes and attached (unparsed) PDFs are intentionally excluded.
    return createHash('sha256').update(JSON.stringify(['abstract-only-v1', reference.id, reference.title, reference.abstract])).digest('hex')
  }

  getReadingDraft(projectId: string, id: string): ReferenceReadingDraft | null {
    const sourceHash = this.getReadingSourceHash(projectId, id)
    const row = this.db.get<ReadingDraftRow>('SELECT * FROM reference_reading_drafts WHERE project_id = ? AND reference_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', projectId, id)
    return row ? {
      id: row.id, projectId: row.project_id, referenceId: row.reference_id,
      sourceHash: row.source_hash, sourceCoverage: row.source_coverage, content: row.content,
      modelLabel: row.model_label, createdAt: row.created_at, status: 'ai-draft', sourceChanged: row.source_hash !== sourceHash
    } : null
  }

  /** Called only after explicit MCP write approval; never writes human-authored notes. */
  saveReadingDraft(projectId: string, input: ReferenceReadingDraftInput): ReferenceReadingDraft {
    const reference = this.get(projectId, input.referenceId)
    if (!reference.abstract.trim()) throw new Error('文献暂无摘要；请补充摘要后再生成阅读摘记。关联 PDF 不代表已解析全文。')
    if (input.sourceCoverage !== 'abstract-only') throw new Error('目前仅支持 abstract-only 阅读摘记，不支持 PDF 全文。')
    if (typeof input.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceHash) || input.sourceHash !== this.getReadingSourceHash(projectId, input.referenceId)) throw new Error('文献标题或摘要已变化；请重新读取文献后生成摘记。')
    if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 40_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(input.content)) throw new Error('阅读摘记内容为空、含无效字符或超过 40000 字符。')
    this.db.run(
      'INSERT INTO reference_reading_drafts (id, project_id, reference_id, source_hash, source_coverage, content, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      newId('reading'), projectId, reference.id, input.sourceHash, 'abstract-only', input.content.trim(), 'AI 生成（模型见生成会话）', nowIso()
    )
    return this.getReadingDraft(projectId, reference.id)!
  }

  upsert(input: ReferenceInput & { id?: string }): Reference {
    const projectId = input.projectId
    this.projectRoot(projectId)
    const title = input.title.trim()
    if (!title) throw new Error('文献标题不能为空。')
    const tags = JSON.stringify(input.tags ?? [])
    const timestamp = nowIso()
    if (input.id) {
      const current = this.get(projectId, input.id)
      this.db.run(
        `UPDATE reference_items SET title = ?, authors = ?, year = ?, venue = ?, doi = ?, url = ?, abstract = ?, tags_json = ?, notes = ?, bibtex = ?, updated_at = ? WHERE id = ? AND project_id = ?`,
        title,
        input.authors ?? current.authors,
        input.year ?? current.year,
        input.venue ?? current.venue,
        input.doi ?? current.doi,
        input.url ?? current.url,
        input.abstract ?? current.abstract,
        input.tags ? tags : JSON.stringify(current.tags),
        input.notes ?? current.notes,
        input.bibtex || current.bibtex || toBibtex({
          title,
          authors: input.authors ?? current.authors,
          year: input.year ?? current.year,
          venue: input.venue ?? current.venue,
          doi: input.doi ?? current.doi,
          url: input.url ?? current.url
        }),
        timestamp,
        input.id,
        projectId
      )
      this.knowledge.indexReference(projectId, input.id)
      if (input.notes !== undefined && input.notes !== current.notes) this.knowledge.recordActivity(projectId, input.id, 'note_updated')
      return this.get(projectId, input.id)
    }
    const id = newId('ref')
    const bibtex = input.bibtex || toBibtex({
      title,
      authors: input.authors ?? '',
      year: input.year ?? '',
      venue: input.venue ?? '',
      doi: input.doi ?? '',
      url: input.url ?? ''
    })
    this.db.run(
      `INSERT INTO reference_items (id, project_id, title, authors, year, venue, doi, url, abstract, tags_json, notes, pdf_relative_path, bibtex, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
      id,
      projectId,
      title,
      input.authors ?? '',
      input.year ?? '',
      input.venue ?? '',
      input.doi ?? '',
      input.url ?? '',
      input.abstract ?? '',
      tags,
      input.notes ?? '',
      bibtex,
      timestamp,
      timestamp
    )
    this.knowledge.indexReference(projectId, id)
    this.knowledge.recordActivity(projectId, id, 'created')
    return this.get(projectId, id)
  }

  async addFromDoi(projectId: string, doi: string, signal?: AbortSignal, assertActive: () => void = () => {}): Promise<Reference> {
    const metadata = await lookupDoi(doi, signal)
    signal?.throwIfAborted()
    assertActive()
    const existing = this.db.get<ReferenceRow>(
      'SELECT * FROM reference_items WHERE project_id = ? AND doi = ? LIMIT 1',
      projectId,
      metadata.doi
    )
    if (existing) return mapReference(existing)
    const ref = this.upsert({
      projectId,
      title: metadata.title,
      authors: metadata.authors,
      year: metadata.year,
      venue: metadata.venue,
      doi: metadata.doi,
      url: metadata.url,
      abstract: metadata.abstract
    })
    this.knowledge.recordActivity(projectId, ref.id, 'imported', 'doi')
    return ref
  }

  importBibtex(projectId: string, text: string): Reference[] {
    const entries = parseBibtex(text)
    return entries.map((entry) => {
      const ref = this.upsert({ projectId, ...entry, title: entry.title })
      this.knowledge.recordActivity(projectId, ref.id, 'imported', 'bibtex')
      return ref
    })
  }

  attachPdf(projectId: string, id: string, sourcePath: string): Reference {
    const reference = this.get(projectId, id)
    const root = this.projectRoot(projectId)
    ensureDir(figurePath(root, 'references/pdfs'))
    const target = figurePath(root, `references/pdfs/${reference.id}-${slugify(reference.title, 'paper')}.pdf`)
    copyFileSync(sourcePath, target)
    this.db.run(
      'UPDATE reference_items SET pdf_relative_path = ?, updated_at = ? WHERE id = ? AND project_id = ?',
      relativePath(root, target),
      nowIso(),
      id,
      projectId
    )
    this.knowledge.indexReference(projectId, id)
    this.knowledge.recordActivity(projectId, id, 'pdf_attached')
    return this.get(projectId, id)
  }

  readPdf(projectId: string, id: string): { base64: string; fileName: string } {
    const reference = this.get(projectId, id)
    if (!reference.pdfRelativePath) throw new Error('该文献尚未关联 PDF。')
    const bytes = readFigureFile(this.projectRoot(projectId), reference.pdfRelativePath, 64 * 1024 * 1024)
    this.recordRead(projectId, id, 'pdf_read')
    return { base64: bytes.toString('base64'), fileName: reference.pdfRelativePath.split(/[\\/]/).pop() ?? 'paper.pdf' }
  }

  delete(projectId: string, id: string): void {
    this.get(projectId, id)
    this.knowledge.recordActivity(projectId, id, 'deleted')
    this.db.run('DELETE FROM reference_items WHERE project_id = ? AND id = ?', projectId, id)
  }

  exportBibtex(projectId: string): string {
    return this.list(projectId).map((reference) => reference.bibtex || toBibtex(reference)).join('\n\n')
  }

  writeBibtexFile(projectId: string): string {
    const root = this.projectRoot(projectId)
    const target = join(root, 'manuscripts', 'references.bib')
    writeFileSync(target, `${this.exportBibtex(projectId)}\n`, 'utf8')
    return target
  }
}
