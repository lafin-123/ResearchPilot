import { createHash } from 'node:crypto'
import { PDF_ANNOTATION_LIMITS, parsePdfAnnotationCreate, parsePdfAnnotationUpdate, parsePdfScope, pdfId, type PdfAnnotation, type PdfAnnotationCreate, type PdfAnnotationUpdate, type PdfOpenResult, type PdfScope } from '../../shared/pdf-annotations'
import type { Db } from '../lib/db'
import { newId, nowIso } from '../lib/util'
import type { ReferenceService } from './references'

interface Row {
  id: string; project_id: string; reference_id: string; fingerprint: string; page: number
  quote: string; comment: string; color: PdfAnnotation['color']; rects_json: string
  revision: number; created_at: string; updated_at: string
}
function map(row: Row): PdfAnnotation {
  return { id: row.id, projectId: row.project_id, referenceId: row.reference_id, fingerprint: row.fingerprint, page: row.page, quote: row.quote, comment: row.comment, color: row.color, rects: JSON.parse(row.rects_json), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at }
}
const WHERE = 'project_id = ? AND reference_id = ? AND fingerprint = ?'
/** Never writes to PDFs. Re-read through ReferenceService's scoped, capped, link-safe file reader on every operation. */
export class PdfAnnotationService {
  constructor(private readonly db: Db, private readonly references: ReferenceService) {}

  private read(projectId: string, referenceId: string): Omit<PdfOpenResult, 'annotations'> {
    const data = this.references.readPdf(pdfId(projectId), pdfId(referenceId))
    const bytes = Buffer.from(data.base64, 'base64')
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('关联文件不是有效的 PDF。')
    return { ...data, fingerprint: createHash('sha256').update(bytes).digest('hex') }
  }

  private verify(input: unknown): PdfScope {
    const scope = parsePdfScope(input)
    if (this.read(scope.projectId, scope.referenceId).fingerprint !== scope.fingerprint) throw new Error('PDF 已被替换或修改。请关闭并重新打开阅读器；旧标注不会套用到新文件。')
    return scope
  }

  private rows(scope: PdfScope): PdfAnnotation[] {
    return this.db.all<Row>(`SELECT * FROM pdf_annotations WHERE ${WHERE} ORDER BY page, created_at, id`, scope.projectId, scope.referenceId, scope.fingerprint).map(map)
  }

  open(projectId: string, referenceId: string): PdfOpenResult {
    const data = this.read(projectId, referenceId)
    return { ...data, annotations: this.rows({ projectId, referenceId, fingerprint: data.fingerprint }) }
  }

  list(input: PdfScope): PdfAnnotation[] { return this.rows(this.verify(input)) }

  create(input: PdfAnnotationCreate): PdfAnnotation {
    const value = parsePdfAnnotationCreate(input)
    const scope = this.verify({ projectId: value.projectId, referenceId: value.referenceId, fingerprint: value.fingerprint })
    const count = this.db.scalar<number>(`SELECT count(*) FROM pdf_annotations WHERE ${WHERE}`, scope.projectId, scope.referenceId, scope.fingerprint) ?? 0
    if (count >= PDF_ANNOTATION_LIMITS.count) throw new Error('此 PDF 已达 2000 条标注上限。')
    const id = newId(); const now = nowIso()
    this.db.run('INSERT INTO pdf_annotations (id, project_id, reference_id, fingerprint, page, quote, comment, color, rects_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)', id, scope.projectId, scope.referenceId, scope.fingerprint, value.page, value.quote, value.comment, value.color, JSON.stringify(value.rects), now, now)
    return this.get(scope, id)
  }

  private get(scope: PdfScope, id: string): PdfAnnotation {
    const row = this.db.get<Row>(`SELECT * FROM pdf_annotations WHERE ${WHERE} AND id = ?`, scope.projectId, scope.referenceId, scope.fingerprint, pdfId(id))
    if (!row) throw new Error('标注不存在或不属于此 PDF。')
    return map(row)
  }

  update(input: PdfAnnotationUpdate): PdfAnnotation {
    const value = parsePdfAnnotationUpdate(input)
    const scope = this.verify({ projectId: value.projectId, referenceId: value.referenceId, fingerprint: value.fingerprint })
    const previous = this.get(scope, value.id)
    if (!previous.rects.length && !value.comment) throw new Error('页面批注不能为空。')
    if (previous.revision !== value.expectedRevision) throw new Error('标注已被其他窗口修改，请重新打开阅读器后再编辑。')
    this.db.run(`UPDATE pdf_annotations SET comment = ?, color = ?, revision = revision + 1, updated_at = ? WHERE ${WHERE} AND id = ?`, value.comment, value.color, nowIso(), scope.projectId, scope.referenceId, scope.fingerprint, value.id)
    return this.get(scope, value.id)
  }

  remove(input: PdfScope, id: string): void {
    const scope = this.verify(input)
    this.get(scope, id)
    this.db.run(`DELETE FROM pdf_annotations WHERE ${WHERE} AND id = ?`, scope.projectId, scope.referenceId, scope.fingerprint, id)
  }
}
