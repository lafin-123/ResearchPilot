import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { DocxEditor } from '@docx-editor.dev/react'
import { zhCN } from '@docx-editor.dev/i18n'
import CodeMirror from '@uiw/react-codemirror'
import { StreamLanguage } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { EditorView } from '@codemirror/view'
import { ArrowLeft, Clock3, FileText, FolderOpen, Loader2, Play, Save, Terminal, X } from 'lucide-react'
import { toast } from 'sonner'
import type { DocumentRecord, DocumentVersion, LatexCompileResult } from '@shared/types'
import { api, base64ToBlobUrl, base64ToBytes, bytesToBase64, formatError, relativeTime } from '../lib/api'
import { useAppStore } from '../store/app'
import { Badge, Button, EmptyState, IconButton, Modal, Spinner } from '../components/Ui'

type DocxRef = ComponentRef<typeof DocxEditor>

export function EditorPage(): ReactNode {
  const { documentId = '' } = useParams()
  const navigate = useNavigate()
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const latexAvailable = useAppStore((state) => state.bootstrap?.latexAvailable ?? false)
  const agentRunning = useAppStore((state) => state.agentState?.status === 'running' || state.agentState?.status === 'starting')

  const [document, setDocument] = useState<DocumentRecord | null>(null)
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [versions, setVersions] = useState<DocumentVersion[]>([])
  const [versionOpen, setVersionOpen] = useState(false)
  const [compileResult, setCompileResult] = useState<LatexCompileResult | null>(null)
  const [compiling, setCompiling] = useState(false)
  const [pdfUrl, setPdfUrl] = useState('')
  const [pdfError, setPdfError] = useState('')
  const [showLog, setShowLog] = useState(false)
  const docxRef = useRef<DocxRef | null>(null)
  const ignoreDocxUntilRef = useRef(0)
  const pdfUrlRef = useRef('')

  const setPdf = useCallback((base64: string) => {
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current)
    const url = base64ToBlobUrl(base64)
    pdfUrlRef.current = url
    setPdfUrl(url)
    setPdfError('')
  }, [])

  useEffect(() => {
    return () => {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current)
    }
  }, [])

  useEffect(() => {
    if (!activeProjectId || !documentId) return
    let cancelled = false
    setLoading(true)
    setLoadError('')
    setDirty(false)
    setCompileResult(null)
    setShowLog(false)
    setPdfUrl('')
    setPdfError('')
    if (pdfUrlRef.current) {
      URL.revokeObjectURL(pdfUrlRef.current)
      pdfUrlRef.current = ''
    }
    void (async () => {
      try {
        const docs = await api.documents.list(activeProjectId)
        const found = docs.find((item) => item.id === documentId)
        if (!found) throw new Error('文档不存在或已被删除。')
        if (cancelled) return
        setDocument(found)
        if (found.format === 'docx') {
          const data = await api.documents.read(activeProjectId, found.id)
          if (!cancelled) { setBytes(base64ToBytes(data.base64)); ignoreDocxUntilRef.current = Date.now() + 1500 }
        } else {
          const data = await api.documents.readText(activeProjectId, found.id)
          if (!cancelled) setSource(data.text)
          try {
            const pdf = await api.documents.readPdf(activeProjectId, found.id)
            if (!cancelled) setPdf(pdf.base64)
          } catch {
            if (!cancelled) setPdfError('尚未编译 PDF。点击「编译」生成预览。')
          }
        }
      } catch (error) {
        if (!cancelled) setLoadError(formatError(error))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [activeProjectId, documentId, setPdf])

  const save = useCallback(async (manual = false): Promise<boolean> => {
    if (!activeProjectId || !document || saving) return false
    setSaving(true)
    try {
      let next: DocumentRecord
      if (document.format === 'docx') {
        const buffer = await docxRef.current?.save()
        if (!buffer) throw new Error('编辑器尚未就绪，无法保存。')
        next = await api.documents.save(activeProjectId, document.id, bytesToBase64(buffer))
        ignoreDocxUntilRef.current = Date.now() + 800
      } else {
        next = await api.documents.saveText(activeProjectId, document.id, source)
      }
      setDocument(next)
      setDirty(false)
      if (manual) toast.success('已保存')
      return true
    } catch (error) {
      toast.error(formatError(error))
      return false
    } finally {
      setSaving(false)
    }
  }, [activeProjectId, document, saving, source])

  useEffect(() => {
    if (!dirty) return
    const timer = setTimeout(() => { void save(false) }, 20_000)
    return () => clearTimeout(timer)
  }, [dirty, save, source])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void save(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [save])

  const compile = async (): Promise<void> => {
    if (!activeProjectId || !document || document.format !== 'latex') return
    setCompiling(true)
    setShowLog(true)
    try {
      if (dirty) {
        const saved = await save(false)
        if (!saved) return
      }
      const result = await api.documents.compile(activeProjectId, document.id)
      setCompileResult(result)
      if (result.ok) {
        const pdf = await api.documents.readPdf(activeProjectId, document.id)
        setPdf(pdf.base64)
        toast.success(`编译成功（${(result.durationMs / 1000).toFixed(1)}s）`)
      } else {
        toast.error('LaTeX 编译失败，请查看日志。')
      }
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setCompiling(false)
    }
  }

  const openVersions = async (): Promise<void> => {
    if (!activeProjectId || !document) return
    try {
      setVersions(await api.documents.versions(activeProjectId, document.id))
      setVersionOpen(true)
    } catch (error) {
      toast.error(formatError(error))
    }
  }

  const restore = async (versionId: string): Promise<void> => {
    if (!activeProjectId || !document) return
    if (!window.confirm('恢复到该版本？当前状态会先保存为一个新快照。')) return
    try {
      const next = await api.documents.restore(activeProjectId, document.id, versionId)
      setDocument(next)
      setVersionOpen(false)
      setDirty(false)
      if (next.format === 'docx') {
        const data = await api.documents.read(activeProjectId, next.id)
        setBytes(base64ToBytes(data.base64))
        ignoreDocxUntilRef.current = Date.now() + 1500
      } else {
        const data = await api.documents.readText(activeProjectId, next.id)
        setSource(data.text)
        setPdfError('版本已恢复，请重新编译。')
        setPdfUrl('')
      }
      toast.success('已恢复版本')
    } catch (error) {
      toast.error(formatError(error))
    }
  }

  const back = async (): Promise<void> => {
    if (dirty) await save(false)
    navigate('/writing')
  }

  const latexExtensions = useMemo(() => [StreamLanguage.define(stex), EditorView.lineWrapping], [])

  if (loading) {
    return <div className="editor-loading"><Spinner label="正在打开文档…" /></div>
  }

  if (loadError || !document) {
    return (
      <div className="page">
        <EmptyState
          icon={<FileText />}
          title="无法打开文档"
          text={loadError || '文档不存在。'}
          action={<Button onClick={() => navigate('/writing')}>返回论文工作台</Button>}
        />
      </div>
    )
  }

  const isDocx = document.format === 'docx'

  return (
    <div className="editor-page">
      <div className="editor-topbar">
        <IconButton label="返回" onClick={() => void back()}><ArrowLeft /></IconButton>
        <div className={`doc-icon ${isDocx ? 'docx' : 'latex'}`} style={{ width: 30, height: 34, fontSize: 8 }}>{isDocx ? 'DOCX' : 'TEX'}</div>
        <div style={{ minWidth: 0 }}>
          <div className="editor-title">{document.title}</div>
          <div className="tiny muted">
            {dirty ? '有未保存修改' : '已保存'} · {document.wordCount.toLocaleString()} 词 · {saving ? '保存中…' : relativeTime(document.updatedAt)}
          </div>
        </div>
        <div className="row" style={{ marginLeft: 'auto' }}>
          {!isDocx ? <Badge tone={latexAvailable ? 'accent' : 'gold'}>{latexAvailable ? 'LaTeX 可用' : '未检测到 TeX'}</Badge> : <Badge tone="blue">Word</Badge>}
          <Button size="sm" variant="ghost" onClick={() => void api.documents.reveal(activeProjectId, document.id)}><FolderOpen />目录</Button>
          <Button size="sm" variant="ghost" onClick={() => void openVersions()}><Clock3 />版本</Button>
          {!isDocx ? (
            <Button size="sm" variant="secondary" disabled={compiling} onClick={() => void compile()}>
              {compiling ? <Loader2 className="spin" /> : <Play />}编译
            </Button>
          ) : null}
          <Button size="sm" variant="primary" disabled={saving || (!dirty && !isDocx)} onClick={() => void save(true)}>
            {saving ? <Loader2 className="spin" /> : <Save />}保存
          </Button>
        </div>
      </div>

      <div className="editor-body">
        {isDocx ? (
          bytes ? (
            <div className="docx-host">
              <DocxEditor
                ref={docxRef}
                document={bytes}
                title={document.title}
                chrome
                menu={false}
                colorMode="light"
                i18n={zhCN}
                locale="zh-CN"
                onSave={() => void save(true)}
                onChange={() => { if (Date.now() >= ignoreDocxUntilRef.current) setDirty(true) }}
              />
            </div>
          ) : (
            <div className="editor-loading"><Spinner label="正在载入 Word 文档…" /></div>
          )
        ) : (
          <div className="latex-split">
            <div className="latex-code">
              <CodeMirror
                value={source}
                height="100%"
                extensions={latexExtensions}
                onChange={(value) => { setSource(value); setDirty(true) }}
                basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
                theme="light"
              />
            </div>
            <div className="latex-preview">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', color: 'var(--ink-3)', borderBottom: '1px solid var(--line)', fontSize: 11 }}>
                <span>PDF 预览</span>
                {compileResult ? <span className="tiny" style={{ color: '#a9b6ac' }}>{compileResult.ok ? `编译成功 · ${compileResult.command}` : '编译失败'}</span> : <span className="tiny" style={{ color: '#a9b6ac' }}>{pdfUrl ? '已有 PDF' : '尚未编译'}</span>}
                <div style={{ marginLeft: 'auto' }} className="row">
                  {compileResult ? <button className="btn btn-ghost btn-sm" style={{ color: 'var(--ink-3)' }} onClick={() => setShowLog(!showLog)}><Terminal size={13} />日志</button> : null}
                  {agentRunning ? <Badge tone="gold">智能体运行中</Badge> : null}
                </div>
              </div>
              {pdfUrl ? (
                <iframe className="pdf-frame" src={`${pdfUrl}#toolbar=1&view=FitH`} title="LaTeX PDF" />
              ) : (
                <div className="editor-loading" style={{ color: 'var(--muted)', flex: 1 }}>
                  <FileText size={30} />
                  <div>{pdfError || '点击顶部「编译」生成 PDF。'}</div>
                  {!latexAvailable ? (
                    <div className="small" style={{ maxWidth: 360, textAlign: 'center', color: 'var(--muted-2)' }}>
                      未检测到 LaTeX 编译器。请安装 TeX Live 或 MiKTeX（中文建议 XeLaTeX + ctex），并在设置中指定命令。
                    </div>
                  ) : null}
                </div>
              )}
              {showLog && compileResult ? (
                <div className="compile-log">
                  <div className="row-between" style={{ marginBottom: 6 }}>
                    <span>{compileResult.ok ? '编译日志' : '错误日志'} · {(compileResult.durationMs / 1000).toFixed(1)}s</span>
                    <button className="btn btn-ghost btn-sm" style={{ color: '#c9d5cb' }} onClick={() => setShowLog(false)}><X size={12} />关闭</button>
                  </div>
                  {compileResult.log}
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {versionOpen ? (
        <Modal
          title="版本历史"
          subtitle="每次保存前都会生成一个快照，最多保留 40 个版本。"
          onClose={() => setVersionOpen(false)}
          footer={<Button onClick={() => setVersionOpen(false)}>关闭</Button>}
        >
          {versions.length === 0 ? (
            <EmptyState icon={<Clock3 />} title="还没有历史版本" text="保存一次后就会产生可回滚的快照。" />
          ) : (
            <div>
              {versions.map((version) => (
                <div className="version-row" key={version.id}>
                  <div className="grow">
                    <div>{version.label}</div>
                    <div className="tiny muted">{new Date(version.createdAt).toLocaleString('zh-CN')} · {Math.round(version.size / 1024)} KB</div>
                  </div>
                  <Button size="sm" onClick={() => void restore(version.id)}>恢复</Button>
                </div>
              ))}
            </div>
          )}
        </Modal>
      ) : null}
    </div>
  )
}

