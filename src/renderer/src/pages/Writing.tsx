import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { FilePlus2, FileText, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type { DocumentFormat, DocumentRecord } from '@shared/types'
import { api, formatError, relativeTime } from '../lib/api'
import { useAppStore } from '../store/app'
import { AgentEntry } from '../components/AgentEntry'
import { PaperContextPanel } from '../components/PaperContextPanel'
import { ManuscriptReader } from '../components/ManuscriptReader'
import { Button, EmptyState, Field, Input, Modal, PageHeader, Select } from '../components/Ui'
import './writing-workspace.css'

const selectedManuscripts = new Map<string, string>()

export function WritingPage(): ReactNode {
  const navigate = useNavigate()
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [format, setFormat] = useState<DocumentFormat>('docx')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [contextBusy, setContextBusy] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const loadVersion = useRef(0)
  const actionVersion = useRef(0)
  const mounted = useRef(true)
  const currentProject = (projectId: string): boolean => mounted.current && useAppStore.getState().activeProjectId === projectId

  const load = async (): Promise<void> => {
    if (!activeProjectId) return
    const projectId = activeProjectId
    const version = ++loadVersion.current
    setLoading(true)
    setListError('')
    try {
      const result = await api.documents.list(projectId)
      if (currentProject(projectId) && version === loadVersion.current) setDocuments(result)
    } catch (error) {
      if (currentProject(projectId) && version === loadVersion.current) setListError(formatError(error))
    } finally {
      if (currentProject(projectId) && version === loadVersion.current) setLoading(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; loadVersion.current++; actionVersion.current++ }
  }, [])

  useEffect(() => {
    setDocuments([])
    setListError('')
    setCreateOpen(false)
    setBusy(false)
    setContextBusy(false)
    setSelectedId(selectedManuscripts.get(activeProjectId) ?? '')
    if (!activeProjectId) { setLoading(false); return }
    void load()
    return () => { actionVersion.current++; loadVersion.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId])

  const create = async (): Promise<void> => {
    if (!activeProjectId || !title.trim()) return
    const action = actionVersion.current
    const current = (): boolean => action === actionVersion.current && currentProject(activeProjectId)
    setBusy(true)
    try {
      const document = await api.documents.create({ projectId: activeProjectId, title: title.trim(), format })
      if (!current()) return
      setCreateOpen(false)
      setTitle('')
      await load()
      if (current()) navigate(`/write/${document.id}`)
    } catch (error) {
      if (current()) toast.error(formatError(error))
    } finally {
      if (current()) setBusy(false)
    }
  }

  const importFile = async (): Promise<void> => {
    if (!activeProjectId) return
    const action = actionVersion.current
    const current = (): boolean => action === actionVersion.current && currentProject(activeProjectId)
    setBusy(true)
    try {
      const document = await api.documents.import(activeProjectId)
      if (document && current()) {
        await load()
        if (current()) navigate(`/write/${document.id}`)
      }
    } catch (error) {
      if (current()) toast.error(formatError(error))
    } finally {
      if (current()) setBusy(false)
    }
  }

  const selected = documents.find(document => document.id === selectedId && document.projectId === activeProjectId) ?? documents.find(document => document.projectId === activeProjectId)
  const chooseDocument = (id: string): void => {
    selectedManuscripts.set(activeProjectId, id)
    setSelectedId(id)
  }

  return (
    <div className="page writing-desk">
      <PageHeader
        title="写作"
        subtitle="围绕当前稿件阅读、修改，让研究记忆在旁边提供依据。"
        actions={(
          <>
            <Button onClick={() => navigate('/writing-quality')}><FileText />检查与修订</Button>
            <Button onClick={() => void importFile()} disabled={busy}><Upload />导入文档</Button>
            <Button onClick={() => { setFormat('latex'); setCreateOpen(true) }}><FilePlus2 />新建 LaTeX</Button>
            <Button variant="primary" onClick={() => { setFormat('docx'); setCreateOpen(true) }}><FilePlus2 />新建 DOCX</Button>
          </>
        )}
      />

      {listError ? <div className="writing-list-error" role="alert"><h2>稿件列表暂时无法读取</h2><p>{listError}</p><Button onClick={() => void load()} disabled={loading}>重新读取稿件</Button></div> : null}
      {documents.length === 0 && !loading && !listError ? <div className="writing-empty-state">
        <EmptyState icon={<FileText />} title="从一份稿件开始" text="导入已有论文，或创建新稿件。正文在这里，研究记忆在旁边。" action={<Button variant="primary" onClick={() => { setFormat('docx'); setCreateOpen(true) }}>创建第一份文稿</Button>} />
        <Button variant="ghost" onClick={() => navigate('/pipeline')}>先从研究流程开始</Button>
      </div> : listError && !documents.length ? null : <>
        <div className="writing-document-bar">
          <label className="writing-document-choice"><span>当前稿件</span><Select aria-label="当前稿件" value={selected?.id ?? ''} disabled={loading || contextBusy} onChange={event => chooseDocument(event.target.value)}>
            {!selected ? <option value="">{loading ? '读取稿件…' : '选择稿件'}</option> : null}
            {documents.map(document => <option key={document.id} value={document.id}>{document.title} · {document.format === 'docx' ? 'Word' : 'LaTeX'}</option>)}
          </Select></label>
          <span className="writing-document-meta">{selected ? `${selected.wordCount.toLocaleString()} 词 · ${relativeTime(selected.updatedAt)}` : ''}</span>
        </div>
        {selected ? <div className="writing-desk-layout">
          <ManuscriptReader key={`${activeProjectId}:${selected.id}`} projectId={activeProjectId} document={selected}/>
          <aside className="writing-context-rail" aria-label="研究辅助栏"><PaperContextPanel key={activeProjectId} projectId={activeProjectId} documents={documents} documentId={selected.id} onDocumentChange={chooseDocument} onBusyChange={setContextBusy}/></aside>
        </div> : <p className="small muted" role="status">正在读取稿件…</p>}
      </>}
      <details className="writing-assistant-entry"><summary>和助手讨论这篇论文</summary><AgentEntry
        placeholder="例如：核对结果章节的数字与证据是否一致"
        suggestions={[
          { label: '准备章节草稿', prompt: '请先核对当前论文上下文和项目证据，再准备可审阅的章节草稿，不直接覆盖文稿。' },
          { label: '审阅当前稿件', prompt: '请检查当前稿件的不受支持论断、引用缺口、方法与结果的一致性，逐项注明位置。' }
        ]}
      /></details>

      {createOpen ? (
        <Modal title={format === 'docx' ? '新建 DOCX 文稿' : '新建 LaTeX 文稿'} subtitle={format === 'docx' ? '适合与导师、合作者用 Word 往返修改。' : '适合精确排版、公式与投稿模板。'} onClose={() => setCreateOpen(false)} footer={<><Button onClick={() => setCreateOpen(false)}>取消</Button><Button variant="primary" disabled={busy || !title.trim()} onClick={() => void create()}>{busy ? '创建中…' : '创建文稿'}</Button></>}>
          <Field label="文稿标题"><Input autoFocus value={title} onChange={event => setTitle(event.target.value)} placeholder="论文题目" /></Field>
          <div className="row"><button className={`btn ${format === 'docx' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFormat('docx')}>DOCX</button><button className={`btn ${format === 'latex' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFormat('latex')}>LaTeX</button></div>
        </Modal>
      ) : null}
    </div>
  )
}
