import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, FilePlus2, FileText, Import, Upload, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import type { DocumentFormat, DocumentRecord } from '@shared/types'
import { api, formatError, relativeTime } from '../lib/api'
import { useAppStore } from '../store/app'
import { AgentEntry } from '../components/AgentEntry'
import { Badge, Button, EmptyState, Field, Input, Modal, PageHeader } from '../components/Ui'

export function WritingPage(): ReactNode {
  const navigate = useNavigate()
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [format, setFormat] = useState<DocumentFormat>('docx')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => {
    if (!activeProjectId) return
    setLoading(true)
    try {
      setDocuments(await api.documents.list(activeProjectId))
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId])

  const create = async (): Promise<void> => {
    if (!activeProjectId || !title.trim()) return
    setBusy(true)
    try {
      const document = await api.documents.create({ projectId: activeProjectId, title: title.trim(), format })
      setCreateOpen(false)
      setTitle('')
      await load()
      navigate(`/write/${document.id}`)
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setBusy(false)
    }
  }

  const importFile = async (): Promise<void> => {
    if (!activeProjectId) return
    setBusy(true)
    try {
      const document = await api.documents.import(activeProjectId)
      if (document) {
        await load()
        navigate(`/write/${document.id}`)
      }
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setBusy(false)
    }
  }

  const docx = documents.filter((document) => document.format === 'docx')
  const latex = documents.filter((document) => document.format === 'latex')

  return (
    <div className="page">
      <PageHeader
        eyebrow="MANUSCRIPTS"
        title="论文工作台"
        subtitle="一个项目可以维护多份文稿。DOCX 适合与合作者往返修改，LaTeX 适合精确排版与投稿。"
        actions={(
          <>
            <Button onClick={() => navigate('/writing-quality')}><FileText />检查与修订</Button>
            <Button onClick={() => void importFile()} disabled={busy}><Upload />导入文档</Button>
            <Button onClick={() => { setFormat('latex'); setCreateOpen(true) }}><FilePlus2 />新建 LaTeX</Button>
            <Button variant="primary" onClick={() => { setFormat('docx'); setCreateOpen(true) }}><FilePlus2 />新建 DOCX</Button>
          </>
        )}
      />

      <AgentEntry
        placeholder="例如：基于已有 run 写 Methods 与 Results，并核对每个数字"
        suggestions={[
          { label: '生成论文初稿', prompt: '请基于当前项目的实验 run 与文献库生成论文初稿，先写 Methods 和 Results，并确保每个性能数字都能追溯到 run ID。' },
          { label: '审稿体检', prompt: '请以严格审稿人的标准检查当前文稿：不受支持的论断、缺失引用、不可复现细节与图表问题。' }
        ]}
      />

      {documents.length === 0 && !loading ? (
        <div className="card">
          <EmptyState
            icon={<FileText />}
            title="还没有文稿"
            text="可以从空白模板开始，或让流水线在实验完成后自动生成论文初稿。"
            action={<Button variant="primary" onClick={() => { setFormat('docx'); setCreateOpen(true) }}>创建第一份文稿</Button>}
          />
        </div>
      ) : (
        <div className="doc-columns">
          <section className="card card-pad">
            <div className="section-head">
              <div>
                <h2 className="section-title"><span className="doc-icon docx" style={{ width: 26, height: 30, display: 'inline-grid', fontSize: 8 }}>DOCX</span>Word 文稿</h2>
                <div className="card-sub">所见即所得编辑，自动版本快照。</div>
              </div>
              <Badge tone="blue">{docx.length}</Badge>
            </div>
            <div className="doc-list">
              {docx.map((document) => (
                <button key={document.id} className="card doc-card" style={{ textAlign: 'left' }} onClick={() => navigate(`/write/${document.id}`)}>
                  <div className="doc-icon docx">DOCX</div>
                  <div className="list-main">
                    <div className="list-title">{document.title}</div>
                    <div className="list-sub">{document.wordCount.toLocaleString()} 词 · {relativeTime(document.updatedAt)}</div>
                  </div>
                  <ArrowRight size={15} className="muted" />
                </button>
              ))}
              {docx.length === 0 ? <div className="small muted" style={{ padding: '14px 2px' }}>还没有 Word 文稿。</div> : null}
            </div>
          </section>

          <section className="card card-pad">
            <div className="section-head">
              <div>
                <h2 className="section-title"><span className="doc-icon latex" style={{ width: 26, height: 30, display: 'inline-grid', fontSize: 8 }}>TEX</span>LaTeX 文稿</h2>
                <div className="card-sub">源码编辑、编译日志与 PDF 预览。</div>
              </div>
              <Badge tone="accent">{latex.length}</Badge>
            </div>
            <div className="doc-list">
              {latex.map((document) => (
                <button key={document.id} className="card doc-card" style={{ textAlign: 'left' }} onClick={() => navigate(`/write/${document.id}`)}>
                  <div className="doc-icon latex">TEX</div>
                  <div className="list-main">
                    <div className="list-title">{document.title}</div>
                    <div className="list-sub">{document.wordCount.toLocaleString()} 词 · {relativeTime(document.updatedAt)}</div>
                  </div>
                  <ArrowRight size={15} className="muted" />
                </button>
              ))}
              {latex.length === 0 ? <div className="small muted" style={{ padding: '14px 2px' }}>还没有 LaTeX 文稿。</div> : null}
            </div>
          </section>
        </div>
      )}

      <div className="card card-pad mt-6" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div className="empty-icon" style={{ margin: 0 }}><Workflow size={20} /></div>
        <div className="grow">
          <div className="card-title">实验完成后再生成论文</div>
          <div className="card-sub">运行「实验优先」流水线，等结果与图表落盘后，智能体会复用同一套证据生成 DOCX 与 LaTeX。</div>
        </div>
        <Button variant="primary" onClick={() => navigate('/pipeline')}>打开流水线<ArrowRight size={14} /></Button>
      </div>

      {createOpen ? (
        <Modal
          title={format === 'docx' ? '新建 DOCX 文稿' : '新建 LaTeX 文稿'}
          subtitle={format === 'docx' ? '适合与导师、合作者用 Word 往返修改。' : '适合精确排版、公式与投稿模板。'}
          onClose={() => setCreateOpen(false)}
          footer={(
            <>
              <Button onClick={() => setCreateOpen(false)}>取消</Button>
              <Button variant="primary" disabled={busy || !title.trim()} onClick={() => void create()}>{busy ? '创建中…' : '创建文稿'}</Button>
            </>
          )}
        >
          <Field label="文稿标题">
            <Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：Long-context RAG under distribution shift" />
          </Field>
          <div className="row">
            <button className={`btn ${format === 'docx' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFormat('docx')}>DOCX</button>
            <button className={`btn ${format === 'latex' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFormat('latex')}>LaTeX</button>
            <span className="small muted">会创建带基础章节结构的草稿。</span>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
