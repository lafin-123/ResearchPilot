import type { NoteCreateInput, NoteListOptions, NoteListResult, NoteRecord, NoteSummary, NoteUpdateInput } from '../../shared/notes'
import { NOTE_CONFLICT, NOTE_LIMITS, parseNoteCreateInput, parseNoteLinks, parseNoteListOptions, parseNoteUpdateInput, validateNoteId } from '../../shared/notes'
import type { Db } from '../lib/db'
import { newId, nowIso } from '../lib/util'

interface NoteRow {
  id: string
  project_id: string
  title: string
  body: string
  pinned: number
  revision: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}
type SummaryRow = Omit<NoteRow, 'body'> & { snippet: string }
const SUMMARY_COLUMNS = 'n.id, n.project_id, n.title, n.pinned, n.revision, n.created_at, n.updated_at, n.deleted_at, substr(n.body, 1, 240) AS snippet'

function metadata(row: Omit<NoteRow, 'body'>): Omit<NoteRecord, 'body'> {
  return {
    id: row.id, projectId: row.project_id, title: row.title, pinned: row.pinned === 1,
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at
  }
}
function record(row: NoteRow): NoteRecord { return { ...metadata(row), body: row.body } }
function summary(row: SummaryRow): NoteSummary {
  return { ...metadata(row), snippet: row.snippet.replace(/\s+/g, ' ').trim().slice(0, NOTE_LIMITS.snippet) }
}
function conflict(): never { throw new Error(`${NOTE_CONFLICT}: 笔记已在其他位置更新，请先保留本地草稿并重新加载，不能覆盖较新版本。`) }

/** SQLite-only project pages; no automatic RAG indexing, model calls or filesystem mirrors. */
export class NoteService {
  constructor(private readonly db: Db) {}

  private requireProject(projectId: string): void {
    validateNoteId(projectId, 'projectId')
    if (!this.db.get('SELECT id FROM projects WHERE id = ?', projectId)) throw new Error('项目不存在或已删除。')
  }

  private requireNote(projectId: string, id: string): NoteRow {
    this.requireProject(projectId)
    validateNoteId(id)
    const row = this.db.get<NoteRow>('SELECT * FROM project_notes WHERE project_id = ? AND id = ?', projectId, id)
    if (!row) throw new Error('笔记不存在或不属于当前项目。')
    return row
  }

  private requireActive(row: NoteRow): void {
    if (row.deleted_at !== null) throw new Error('笔记已移入回收站，请先恢复后再编辑。')
  }

  list(projectId: string, options?: NoteListOptions): NoteListResult {
    this.requireProject(projectId)
    const { query, filter, limit, offset } = parseNoteListOptions(options)
    const where = `n.project_id = ? AND n.deleted_at IS ${filter === 'trash' ? 'NOT ' : ''}NULL${filter === 'pinned' ? ' AND n.pinned = 1' : ''}`
      + (query ? ' AND (instr(lower(n.title), lower(?)) > 0 OR instr(lower(n.body), lower(?)) > 0)' : '')
    const params: Array<string | number> = query ? [projectId, query, query] : [projectId]
    // Reading count and page in one snapshot keeps pagination metadata consistent.
    return this.db.transaction(() => {
      const total = this.db.scalar<number>(`SELECT COUNT(*) FROM project_notes n WHERE ${where}`, ...params) ?? 0
      const items = this.db.all<SummaryRow>(`SELECT ${SUMMARY_COLUMNS} FROM project_notes n WHERE ${where} ORDER BY n.pinned DESC, n.updated_at DESC, n.id ASC LIMIT ? OFFSET ?`, ...params, limit, offset).map(summary)
      return { items, total, hasMore: offset + items.length < total }
    })
  }

  get(projectId: string, id: string): NoteRecord { return record(this.requireNote(projectId, id)) }

  create(input: NoteCreateInput): NoteRecord {
    const { projectId, title, body } = parseNoteCreateInput(input)
    this.requireProject(projectId)
    return this.db.transaction(() => {
      const id = newId('note')
      const now = nowIso()
      this.db.run('INSERT INTO project_notes (id, project_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, projectId, title, body, now, now)
      this.replaceLinks(projectId, id, body)
      return this.get(projectId, id)
    })
  }

  update(input: NoteUpdateInput): NoteRecord {
    const { projectId, id, title, body, expectedRevision } = parseNoteUpdateInput(input)
    return this.db.transaction(() => {
      const current = this.requireNote(projectId, id)
      if (current.revision !== expectedRevision) conflict()
      this.requireActive(current)
      if (current.title === title && current.body === body) return record(current)
      const result = this.db.prepare('UPDATE project_notes SET title = ?, body = ?, revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL')
        .run(title, body, nowIso(), projectId, id, expectedRevision)
      if (Number(result.changes) !== 1) conflict()
      this.replaceLinks(projectId, id, body)
      return this.get(projectId, id)
    })
  }

  setPinned(projectId: string, id: string, pinned: boolean): NoteRecord {
    if (typeof pinned !== 'boolean') throw new Error('笔记 pinned 必须是布尔值。')
    return this.db.transaction(() => {
      const current = this.requireNote(projectId, id)
      this.requireActive(current)
      if ((current.pinned === 1) === pinned) return record(current)
      this.db.run('UPDATE project_notes SET pinned = ?, revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ?', pinned ? 1 : 0, nowIso(), projectId, id)
      return this.get(projectId, id)
    })
  }

  trash(projectId: string, id: string): NoteRecord {
    return this.db.transaction(() => {
      const current = this.requireNote(projectId, id)
      if (current.deleted_at !== null) return record(current)
      const now = nowIso()
      this.db.run('UPDATE project_notes SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ?', now, now, projectId, id)
      // Keep edges during soft deletion: active queries hide them, and restore
      // reactivates links in either direction without changing any page ID/body.
      return this.get(projectId, id)
    })
  }

  restore(projectId: string, id: string): NoteRecord {
    return this.db.transaction(() => {
      const current = this.requireNote(projectId, id)
      if (current.deleted_at === null) return record(current)
      this.db.run('UPDATE project_notes SET deleted_at = NULL, revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ?', nowIso(), projectId, id)
      return this.get(projectId, id)
    })
  }

  /** Up to 1000 active source pages; a trashed target has no visible backlinks. */
  backlinks(projectId: string, id: string): NoteSummary[] {
    const target = this.requireNote(projectId, id)
    if (target.deleted_at !== null) return []
    return this.db.all<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM note_links l JOIN project_notes n ON n.project_id = l.project_id AND n.id = l.source_id
       WHERE l.project_id = ? AND l.target_id = ? AND n.deleted_at IS NULL
       ORDER BY n.pinned DESC, n.updated_at DESC, n.id ASC LIMIT ?`, projectId, id, NOTE_LIMITS.list
    ).map(summary)
  }

  /** Called only inside the same transaction as the body write. */
  private replaceLinks(projectId: string, sourceId: string, body: string): void {
    this.db.run('DELETE FROM note_links WHERE project_id = ? AND source_id = ?', projectId, sourceId)
    const insert = this.db.prepare(`INSERT INTO note_links (project_id, source_id, target_id)
      SELECT project_id, ?, id FROM project_notes WHERE project_id = ? AND id = ?`)
    for (const targetId of parseNoteLinks(body)) insert.run(sourceId, projectId, targetId)
  }
}
