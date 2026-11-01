import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { toast } from 'sonner'
import type { Reference } from '@shared/types'
import { annotationMarkdown, normalizePdfRects, PDF_ANNOTATION_LIMITS, type PdfAnnotation, type PdfAnnotationColor, type PdfRect } from '@shared/pdf-annotations'
import { api, base64ToBytes, formatError } from '../lib/api'
import { Button, Modal } from './Ui'
import './pdf-reader.css'

GlobalWorkerOptions.workerSrc = workerUrl
const colors: Array<{ value: PdfAnnotationColor; label: string }> = [{ value: 'yellow', label: '浅黄' }, { value: 'green', label: '浅绿' }, { value: 'rose', label: '浅粉' }]
interface SelectionDraft { page: number; quote: string; rects: PdfRect[] }

export function PdfReader({ reference, onClose }: { reference: Reference; onClose: () => void }): ReactNode {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [fingerprint, setFingerprint] = useState('')
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([])
  const [page, setPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [zoom, setZoom] = useState(0.8)
  const [size, setSize] = useState({ width: 612, height: 792 })
  const [loading, setLoading] = useState(true)
  const [rendering, setRendering] = useState(false)
  const [noText, setNoText] = useState(false)
  const [error, setError] = useState('')
  const [pageError, setPageError] = useState('')
  const [draft, setDraft] = useState<SelectionDraft | null>(null)
  const [comment, setComment] = useState('')
  const [color, setColor] = useState<PdfAnnotationColor>('yellow')
  const [selectedId, setSelectedId] = useState('')
  const [editingId, setEditingId] = useState('')
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  const renderSequence = useRef<Promise<void>>(Promise.resolve())
  const dirty = !!draft || !!comment || !!editingId
  const scope = { projectId: reference.projectId, referenceId: reference.id, fingerprint }
  const selected = annotations.find(item => item.id === selectedId)
  const clearDraft = (): void => { setDraft(null); setComment(''); setEditingId(''); window.getSelection()?.removeAllRanges() }
  const discardDraft = (): boolean => !dirty || window.confirm('有尚未保存的 PDF 标注。放弃这些修改？')
  const close = (): void => { if (!busy && discardDraft()) onClose() }

  useEffect(() => {
    alive.current = true
    let cancelled = false
    let task: ReturnType<typeof getDocument> | undefined
    void (async () => {
      try {
        const opened = await api.pdfAnnotations.open(reference.projectId, reference.id)
        if (cancelled) return
        // Data-only parsing: no viewer annotation/action layer, no scripting manager or remote PDF URL.
        task = getDocument({ data: base64ToBytes(opened.base64), useWorkerFetch: false, useWasm: false, useSystemFonts: true, disableAutoFetch: true, disableStream: true, enableXfa: false, maxImageSize: 32_000_000, canvasMaxAreaInBytes: 64 * 1024 * 1024 })
        const pdf = await task.promise
        if (cancelled) return
        if (pdf.numPages > PDF_ANNOTATION_LIMITS.page) throw new Error('此 PDF 超过 10000 页，暂不支持标注。')
        setFingerprint(opened.fingerprint); setAnnotations(opened.annotations); setDocument(pdf)
      } catch (err) { if (!cancelled) setError(formatError(err)) }
      finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true; alive.current = false; void task?.destroy().catch(() => undefined) }
  }, [reference.projectId, reference.id])

  useEffect(() => {
    if (!document) return
    let cancelled = false
    let render: RenderTask | undefined
    let layer: TextLayer | undefined
    setRendering(true); setPageError(''); setNoText(false)
    // Serialize cancellation before reusing a canvas; rapid page/zoom changes must not race.
    const work = renderSequence.current.catch(() => undefined).then(async () => {
      if (cancelled) return
      const canvas = canvasRef.current; const text = textRef.current
      if (!canvas || !text) return
      text.replaceChildren()
      const pdfPage = await document.getPage(page)
      if (cancelled) return
      const viewport = pdfPage.getViewport({ scale: zoom })
      if (viewport.width * viewport.height > 16_000_000) throw new Error('此页面尺寸过大，请降低缩放比例。')
      setSize({ width: viewport.width, height: viewport.height })
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)))
      canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法创建 PDF 画布。')
      render = pdfPage.render({ canvas, canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
      await render.promise
      if (cancelled) return
      const content = await pdfPage.getTextContent()
      if (cancelled) return
      setNoText(!content.items.some(item => 'str' in item && item.str.trim()))
      text.style.setProperty('--total-scale-factor', String(viewport.scale))
      layer = new TextLayer({ textContentSource: content, container: text, viewport })
      await layer.render()
    }).catch(err => { if (!cancelled) setPageError(formatError(err)) }).finally(() => { if (!cancelled) setRendering(false) })
    renderSequence.current = work
    return () => { cancelled = true; render?.cancel(); layer?.cancel() }
  }, [document, page, zoom])

  const changePage = (next: number): void => {
    if (!document || !Number.isInteger(next) || next < 1 || next > document.numPages || busy) { setPageInput(String(page)); return }
    if (next !== page && !discardDraft()) { setPageInput(String(page)); return }
    if (next !== page) clearDraft()
    setPage(next); setPageInput(String(next))
  }
  const captureSelection = (): void => {
    if (rendering || pageError || busy || editingId) return
    const selection = window.getSelection(); const layer = textRef.current; const container = pageRef.current
    if (!selection || selection.isCollapsed || !selection.rangeCount || !layer || !container) return
    const range = selection.getRangeAt(0)
    if (!layer.contains(range.startContainer) || !layer.contains(range.endContainer)) return
    const quote = selection.toString().trim()
    if (!quote) return
    const rects = normalizePdfRects(Array.from(range.getClientRects()), container.getBoundingClientRect())
    if (quote.length > PDF_ANNOTATION_LIMITS.text || rects.length > PDF_ANNOTATION_LIMITS.rects) { toast.error('选区过长，请缩小到 4000 字符、100 个文本区域以内。'); return }
    if (!rects.length) return
    setDraft({ page, quote, rects }); setSelectedId('')
  }
  const save = async (): Promise<void> => {
    if (!fingerprint || busy || (!editingId && !draft && !comment.trim())) return
    setBusy(true)
    try {
      const existing = annotations.find(item => item.id === editingId)
      const saved = existing ? await api.pdfAnnotations.update({ ...scope, id: existing.id, comment, color, expectedRevision: existing.revision }) : await api.pdfAnnotations.create({ ...scope, page: draft?.page ?? page, quote: draft?.quote ?? '', rects: draft?.rects ?? [], comment, color })
      if (!alive.current) return
      setAnnotations(items => [...items.filter(item => item.id !== saved.id), saved].sort((a, b) => a.page - b.page || a.createdAt.localeCompare(b.createdAt)))
      setSelectedId(saved.id); clearDraft(); toast.success('标注已保存到本机；原 PDF 未修改')
    } catch (err) { if (alive.current) toast.error(formatError(err)) }
    finally { if (alive.current) setBusy(false) }
  }
  const selectAnnotation = (annotation: PdfAnnotation, edit = false): void => {
    if (busy || !discardDraft()) return
    clearDraft(); setSelectedId(annotation.id); setPage(annotation.page); setPageInput(String(annotation.page))
    if (edit) { setEditingId(annotation.id); setComment(annotation.comment); setColor(annotation.color) }
    // Page is navigated even for comments without a geometric anchor.
    requestAnimationFrame(() => pageRef.current?.scrollIntoView({ block: 'start', inline: 'nearest' }))
  }
  const remove = async (annotation: PdfAnnotation): Promise<void> => {
    if (busy || !window.confirm(`删除第 ${annotation.page} 页的这条标注？此操作不能撤销。`)) return
    setBusy(true)
    try {
      await api.pdfAnnotations.remove(scope, annotation.id)
      if (!alive.current) return
      setAnnotations(items => items.filter(item => item.id !== annotation.id))
      if (selectedId === annotation.id) setSelectedId('')
      if (editingId === annotation.id) clearDraft()
    } catch (err) { if (alive.current) toast.error(formatError(err)) }
    finally { if (alive.current) setBusy(false) }
  }
  const note = async (create: boolean): Promise<void> => {
    if (!selected || busy) return
    const body = annotationMarkdown(reference, selected)
    if (create && !window.confirm('将当前选中标注创建为一篇新的研究笔记？包含来源、页码、摘录和批注，不会覆盖现有笔记。')) return
    setBusy(true)
    try {
      if (create) { await api.notes.create({ projectId: reference.projectId, title: `${reference.title.replace(/[\r\n]+/g, ' ')} · p.${selected.page}`.slice(0, 200), body }); toast.success('已创建新的研究笔记') }
      else { await navigator.clipboard.writeText(body); toast.success('已复制摘录、批注和来源页码') }
    } catch (err) { toast.error(formatError(err)) }
    finally { if (alive.current) setBusy(false) }
  }

  return <Modal title={reference.title} subtitle="原文阅读与标注 · 仅本机保存，不改写原 PDF" size="wide" onClose={close}>
    <div className="pdf-reader" data-testid="pdf-reader">
      <div className="pdf-reader-toolbar">
        <Button size="sm" disabled={!document || page <= 1 || busy} onClick={() => changePage(page - 1)}>上一页</Button>
        <label>第 <input data-testid="pdf-page-number" aria-label="PDF 页码" type="number" min={1} max={document?.numPages ?? 1} value={pageInput} disabled={!document || busy} onChange={event => setPageInput(event.target.value)} onBlur={() => changePage(Number(pageInput))} onKeyDown={event => { if (event.key === 'Enter') changePage(Number(pageInput)) }} /> / {document?.numPages ?? '—'} 页</label>
        <Button size="sm" disabled={!document || page >= document.numPages || busy} onClick={() => changePage(page + 1)}>下一页</Button>
        <label>缩放 <select aria-label="PDF 缩放" data-testid="pdf-zoom" value={zoom} disabled={!document || busy} onChange={event => { window.getSelection()?.removeAllRanges(); setZoom(Number(event.target.value)) }}>{[0.6, 0.8, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}</select></label>
        <span className="pdf-reader-hint">选中原文后添加高亮；也可直接写页面批注</span>
      </div>
      {loading ? <div role="status" className="pdf-reader-message">正在读取本地 PDF…</div> : error ? <div role="alert" className="pdf-reader-message">无法打开 PDF：{error}</div> : <div className="pdf-reader-layout">
        <div className="pdf-reader-paper-area">
          {pageError ? <div role="alert" className="pdf-reader-message">页面无法呈现：{pageError}</div> : null}
          {noText ? <div className="pdf-reader-message" data-testid="pdf-no-text">本页没有可选文字，可能是扫描页。可添加页面批注；此阅读器不提供 OCR。</div> : null}
          {rendering ? <div role="status" className="pdf-render-status">正在绘制第 {page} 页…</div> : null}
          <div ref={pageRef} className="pdf-reader-page" data-testid="pdf-page" data-page={page} aria-label={`PDF 第 ${page} 页`} style={{ width: size.width, height: size.height, visibility: rendering || pageError ? 'hidden' : 'visible' }} onMouseUp={captureSelection} onKeyUp={captureSelection}>
            <canvas ref={canvasRef} data-testid="pdf-canvas" style={{ width: size.width, height: size.height }} />
            <div className="pdf-highlight-layer" aria-hidden="true">{annotations.filter(item => item.page === page).flatMap(item => item.rects.map((rect, index) => <div key={`${item.id}-${index}`} data-testid="pdf-highlight" className={`pdf-highlight ${item.color} ${item.id === selectedId ? 'selected' : ''}`} style={rectStyle(rect)} />))}{draft?.page === page ? draft.rects.map((rect, index) => <div key={`draft-${index}`} className={`pdf-highlight ${color} draft`} style={rectStyle(rect)} />) : null}</div>
            <div ref={textRef} className="textLayer pdf-text-layer" data-testid="pdf-text-layer" tabIndex={0} aria-label="可选择的 PDF 原文" />
          </div>
        </div>
        <aside className="pdf-annotations" aria-label="PDF 标注">
          <section className="pdf-annotation-editor">
            <strong>{editingId ? '编辑标注' : draft ? `所选原文 · 第 ${draft.page} 页` : `页面批注 · 第 ${page} 页`}</strong>
            {draft ? <blockquote data-testid="pdf-selection-quote">{draft.quote}</blockquote> : null}
            <label className="pdf-comment-label" htmlFor="pdf-comment">批注{draft ? '（可选）' : ''}</label>
            <textarea id="pdf-comment" data-testid="pdf-comment" value={comment} disabled={busy} maxLength={4000} rows={3} placeholder="记录疑问、方法或与课题的联系…" onChange={event => setComment(event.target.value)} />
            <div className="pdf-annotation-actions"><label>颜色 <select aria-label="标注颜色" value={color} disabled={busy} onChange={event => setColor(event.target.value as PdfAnnotationColor)}>{colors.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><Button size="sm" data-testid="pdf-save-annotation" disabled={busy || !fingerprint || rendering || !!pageError || (!draft && !comment.trim() && !editingId)} onClick={() => void save()}>{busy ? '处理中…' : editingId ? '保存修改' : '保存标注'}</Button>{dirty ? <Button size="sm" disabled={busy} onClick={() => { if (discardDraft()) clearDraft() }}>取消</Button> : null}</div>
          </section>
          <div className="pdf-annotation-list-head"><strong>全部标注（{annotations.length}）</strong><span>点击定位原文页</span></div>
          <div className="pdf-annotation-list" data-testid="pdf-annotation-list">{annotations.length ? annotations.map(annotation => <article key={annotation.id} data-testid="pdf-annotation-item" data-annotation-id={annotation.id} className={`pdf-annotation-item ${annotation.id === selectedId ? 'selected' : ''}`}>
            <button className="pdf-annotation-locator" disabled={busy} onClick={() => selectAnnotation(annotation)}><span className={`pdf-color-dot ${annotation.color}`} />第 {annotation.page} 页 · {annotation.rects.length ? '文本高亮' : '页面批注'}{annotation.quote ? <blockquote>{annotation.quote}</blockquote> : null}{annotation.comment ? <p>{annotation.comment}</p> : null}</button>
            <div className="pdf-annotation-item-actions"><button disabled={busy} onClick={() => selectAnnotation(annotation, true)}>编辑批注</button><button disabled={busy} onClick={() => void remove(annotation)}>删除</button></div>
          </article>) : <p className="pdf-empty">尚无标注。选中左侧原文，或为当前页写一条批注，再点击保存。</p>}</div>
          <div className="pdf-note-actions"><Button size="sm" disabled={!selected || busy} onClick={() => void note(false)}>复制为阅读笔记</Button><Button size="sm" data-testid="pdf-create-note" disabled={!selected || busy} onClick={() => void note(true)}>新建研究笔记</Button><p>仅导出选中的已保存标注，包含来源、DOI、页码、摘录和批注。</p></div>
        </aside>
      </div>}
    </div>
  </Modal>
}
function rectStyle(rect: PdfRect): CSSProperties { return { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` } }
