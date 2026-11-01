/** A local overlay only: coordinates refer to the displayed, intrinsically rotated PDF page. */
export interface PdfRect { x: number; y: number; width: number; height: number }
export type PdfAnnotationColor = 'yellow' | 'green' | 'rose'
export interface PdfScope { projectId: string; referenceId: string; fingerprint: string }
export interface PdfAnnotation extends PdfScope {
  id: string
  page: number
  quote: string
  comment: string
  color: PdfAnnotationColor
  rects: PdfRect[]
  revision: number
  createdAt: string
  updatedAt: string
}
export interface PdfAnnotationCreate extends PdfScope {
  page: number; quote: string; comment: string; color: PdfAnnotationColor; rects: PdfRect[]
}
export interface PdfAnnotationUpdate extends PdfScope {
  id: string; comment: string; color: PdfAnnotationColor; expectedRevision: number
}
export interface PdfOpenResult { base64: string; fileName: string; fingerprint: string; annotations: PdfAnnotation[] }
export const PDF_ANNOTATION_LIMITS = { text: 4000, rects: 100, page: 10000, count: 2000 } as const
const scopeKeys = ['projectId', 'referenceId', 'fingerprint']
function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) throw new Error('PDF 标注参数无效。')
  return input as Record<string, unknown>
}
export function pdfId(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$(?![\s\S])/.test(input)) throw new Error('PDF 标注标识无效。')
  return input
}
function scope(value: Record<string, unknown>): PdfScope {
  if (typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$(?![\s\S])/.test(value.fingerprint)) throw new Error('PDF 文件指纹无效。')
  return { projectId: pdfId(value.projectId), referenceId: pdfId(value.referenceId), fingerprint: value.fingerprint }
}
export function parsePdfScope(input: unknown): PdfScope { return scope(object(input, scopeKeys)) }
function text(input: unknown): string {
  if (typeof input !== 'string' || input.length > PDF_ANNOTATION_LIMITS.text || input.includes('\0')) throw new Error('摘录或批注不能超过 4000 字符或包含空字符。')
  return input.trim()
}
function color(input: unknown): PdfAnnotationColor {
  if (input !== 'yellow' && input !== 'green' && input !== 'rose') throw new Error('标注颜色无效。')
  return input
}
export function parsePdfAnnotationCreate(input: unknown): PdfAnnotationCreate {
  const value = object(input, [...scopeKeys, 'page', 'quote', 'comment', 'color', 'rects'])
  if (!Number.isInteger(value.page) || (value.page as number) < 1 || (value.page as number) > PDF_ANNOTATION_LIMITS.page) throw new Error('PDF 页码无效。')
  if (!Array.isArray(value.rects) || value.rects.length > PDF_ANNOTATION_LIMITS.rects) throw new Error('单次标注最多包含 100 个文本区域，请缩小选区。')
  const rects = value.rects.map(item => {
    const r = object(item, ['x', 'y', 'width', 'height'])
    if (![r.x, r.y, r.width, r.height].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) || !(r.width as number > 0) || !(r.height as number > 0) || (r.x as number) + (r.width as number) > 1.000001 || (r.y as number) + (r.height as number) > 1.000001) throw new Error('PDF 标注区域必须位于页面内。')
    return { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number }
  })
  const quote = text(value.quote); const comment = text(value.comment)
  if (rects.length ? !quote : (!comment || !!quote)) throw new Error('高亮需要所选原文；无选区时请输入页面批注。')
  return { ...scope(value), page: value.page as number, quote, comment, rects, color: color(value.color) }
}
export function parsePdfAnnotationUpdate(input: unknown): PdfAnnotationUpdate {
  const value = object(input, [...scopeKeys, 'id', 'comment', 'color', 'expectedRevision'])
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1) throw new Error('标注版本无效。')
  return { ...scope(value), id: pdfId(value.id), comment: text(value.comment), color: color(value.color), expectedRevision: value.expectedRevision as number }
}

/** Clip DOM selection rectangles to the page and normalize, so zoom never changes stored positions. */
export function normalizePdfRects(rects: Array<{ left: number; top: number; right: number; bottom: number }>, page: { left: number; top: number; width: number; height: number }): PdfRect[] {
  if (![page.left, page.top, page.width, page.height].every(Number.isFinite) || page.width <= 0 || page.height <= 0) return []
  const result: PdfRect[] = []
  for (const rect of rects) {
    if (![rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)) continue
    const left = Math.max(page.left, rect.left); const top = Math.max(page.top, rect.top)
    const right = Math.min(page.left + page.width, rect.right); const bottom = Math.min(page.top + page.height, rect.bottom)
    if (right <= left || bottom <= top) continue
    const normalized = { x: (left - page.left) / page.width, y: (top - page.top) / page.height, width: (right - left) / page.width, height: (bottom - top) / page.height }
    if (!result.some(r => Math.abs(r.x - normalized.x) < 0.00001 && Math.abs(r.y - normalized.y) < 0.00001 && Math.abs(r.width - normalized.width) < 0.00001 && Math.abs(r.height - normalized.height) < 0.00001)) result.push(normalized)
  }
  return result
}

export function annotationMarkdown(source: { title: string; doi: string }, annotation: PdfAnnotation): string {
  // Quote untrusted PDF text rather than constructing executable links or HTML.
  const escape = (text: string): string => text.replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, '\\$&')
  return `## ${escape(source.title.replace(/[\r\n]+/g, ' '))} — 第 ${annotation.page} 页\n\n来源 DOI：${escape(source.doi || '未提供')}\n\nPDF SHA-256：\`${annotation.fingerprint}\`\n\n${annotation.quote ? annotation.quote.split('\n').map(line => `> ${escape(line)}`).join('\n') + '\n\n' : ''}批注：${escape(annotation.comment || '（无）')}\n`
}
