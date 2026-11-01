import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { BookOpen, ChevronDown, Download, ExternalLink, FilePlus2, Loader2, Paperclip, Plus, Search, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import type { CrossrefResult, Reference, ReferenceReadingDraft, PdfFulltextResult } from '@shared/types'
import { referenceReadingPrompt } from '@shared/reference-reading'
import { api, formatError, relativeTime } from '../lib/api'
import { PdfReader } from '../components/PdfReader'
import { useAppStore } from '../store/app'
import { Button, EmptyState, Field, Input, Modal, PageHeader, Textarea } from '../components/Ui'
import './research-management.css'

function emptyForm(): ReferenceForm {
  return { title: '', authors: '', year: '', venue: '', doi: '', url: '', abstract: '', notes: '', tags: '' }
}

interface ReferenceForm {
  title: string
  authors: string
  year: string
  venue: string
  doi: string
  url: string
  abstract: string
  notes: string
  tags: string
}

export function LibraryPage(): ReactNode {
  const navigate = useNavigate()
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const modelSelection = useAppStore((state) => state.modelSelection)
  const provider = useAppStore((state) => state.providers.find(item => item.id === state.modelSelection.providerId))
  const agentState = useAppStore((state) => state.agentState)
  const pendingSend = useAppStore((state) => state.pendingSend)
  const agentBusy = !!pendingSend || agentState?.status === 'running' || agentState?.status === 'starting'
  const [readingDraft, setReadingDraft] = useState<ReferenceReadingDraft | null>(null)
  const [draftLoading, setDraftLoading] = useState(false)
  const [draftError, setDraftError] = useState('')
  const [draftRefresh, setDraftRefresh] = useState(0)
  const [readingStarting, setReadingStarting] = useState(false)
  const projectRef = useRef(activeProjectId)
  projectRef.current = activeProjectId
  const loadVersion = useRef(0)
  const [references, setReferences] = useState<Reference[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [doiOpen, setDoiOpen] = useState(false)
  const [bibtexOpen, setBibtexOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [selected, setSelected] = useState<Reference | null>(null)
  const [selectedBaseline, setSelectedBaseline] = useState<Reference | null>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const importMenu = useRef<HTMLDetailsElement>(null)
  const [pdf, setPdf] = useState<Reference | null>(null)
  const [fulltext, setFulltext] = useState<PdfFulltextResult | null>(null)
  const [fulltextBusy, setFulltextBusy] = useState(false)
  const fulltextToken = useRef(0)
  const extractFulltext = async (startPage = 1, pageOffset = 0): Promise<void> => {
    if (!selected?.pdfRelativePath || fulltextBusy) return
    const id = selected.id, projectId = activeProjectId, token = ++fulltextToken.current
    setFulltextBusy(true)
    try {
      const result = await api.references.fulltext(projectId, id, startPage, pageOffset)
      if (token === fulltextToken.current && projectRef.current === projectId && selectedRef.current?.id === id) setFulltext(result)
    } catch (error) { if (token === fulltextToken.current) toast.error(formatError(error)) }
    finally { if (token === fulltextToken.current) setFulltextBusy(false) }
  }
  useEffect(() => { ++fulltextToken.current; setFulltext(null); setFulltextBusy(false); return () => { ++fulltextToken.current } }, [activeProjectId, selected?.id])
  const dirty = !!selected && JSON.stringify(selected) !== JSON.stringify(selectedBaseline)
  const selectReference = (reference: Reference | null): void => {
    if (reference?.id === selected?.id) return
    if (dirty && !window.confirm('当前文献有未保存的修改。放弃修改并切换？')) return
    setSelected(reference)
    setSelectedBaseline(reference)
  }
  const askAssistant = (): void => {
    useAppStore.getState().seedPrompt('请调研本项目方向的文献，核对真实来源，整理证据、冲突与可验证的研究 gap，并把可用文献加入文献库。')
    navigate('/agent')
  }
  const openImport = (open: () => void): void => {
    if (importMenu.current) importMenu.current.open = false
    open()
  }

  const [form, setForm] = useState<ReferenceForm>(emptyForm())
  const [doi, setDoi] = useState('')
  const [bibtex, setBibtex] = useState('')
  const [externalQuery, setExternalQuery] = useState('')
  const [external, setExternal] = useState<CrossrefResult[]>([])
  const [busy, setBusy] = useState('')

  const load = async (value = query): Promise<void> => {
    if (!activeProjectId) return
    const version = ++loadVersion.current
    setLoading(true)
    try {
      const rows = await api.references.list(activeProjectId, value)
      if (projectRef.current === activeProjectId && version === loadVersion.current) setReferences(rows)
    } catch (error) {
      if (projectRef.current === activeProjectId && version === loadVersion.current) toast.error(formatError(error))
    } finally {
      if (projectRef.current === activeProjectId && version === loadVersion.current) setLoading(false)
    }
  }

  useEffect(() => {
    setReferences([]); setSelected(null); setSelectedBaseline(null); setPdf(null); setQuery('')
    setAddOpen(false); setDoiOpen(false); setBibtexOpen(false); setSearchOpen(false)
    void load('')
    return () => { loadVersion.current += 1 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId])

  useEffect(() => {
    if (!selected || selected.projectId !== activeProjectId) return
    void api.knowledge.read({ projectId: activeProjectId, referenceId: selected.id }).catch((error) => toast.error(`阅读记录未保存：${formatError(error)}`))
  }, [activeProjectId, selected?.id])

  useEffect(() => {
    let current = true
    setReadingDraft(null); setDraftError(''); setDraftLoading(false)
    if (!selected || selected.projectId !== activeProjectId) return
    setDraftLoading(true)
    void api.references.getReadingDraft(activeProjectId, selected.id).then(draft => {
      if (current) setReadingDraft(draft)
    }).catch(error => {
      if (current) setDraftError(formatError(error))
    }).finally(() => { if (current) setDraftLoading(false) })
    return () => { current = false }
  }, [activeProjectId, selected?.id, selectedBaseline?.updatedAt, draftRefresh])

  useEffect(() => api.onEvent(event => {
    if (event.type === 'reference-reading-draft' && event.projectId === projectRef.current && event.referenceId === selectedRef.current?.id) setDraftRefresh(value => value + 1)
  }), [])

  const addDoi = async (): Promise<void> => {
    if (!activeProjectId || !doi.trim()) return
    setBusy('doi')
    try {
      const reference = await api.references.addDoi(activeProjectId, doi.trim())
      setDoi('')
      setDoiOpen(false)
      toast.success(`已加入：${reference.title}`)
      await load()
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setBusy('')
    }
  }

  const addManual = async (): Promise<void> => {
    if (!activeProjectId || !form.title.trim()) return
    setBusy('manual')
    try {
      await api.references.upsert({
        projectId: activeProjectId,
        title: form.title.trim(),
        authors: form.authors,
        year: form.year,
        venue: form.venue,
        doi: form.doi,
        url: form.url,
        abstract: form.abstract,
        notes: form.notes,
        tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
      })
      setAddOpen(false)
      setForm(emptyForm())
      toast.success('文献已保存')
      await load()
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setBusy('')
    }
  }

  const importBibtex = async (): Promise<void> => {
    if (!activeProjectId || !bibtex.trim()) return
    setBusy('bibtex')
    try {
      const imported = await api.references.importBibtex(activeProjectId, bibtex)
      setBibtex('')
      setBibtexOpen(false)
      toast.success(`导入了 ${imported.length} 条文献`)
      await load()
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setBusy('')
    }
  }

  const runSearch = async (): Promise<void> => {
    if (!externalQuery.trim()) return
    setBusy('search')
    try {
      setExternal(await api.references.crossref(externalQuery.trim(), 15))
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setBusy('')
    }
  }

  const addExternal = async (result: CrossrefResult): Promise<void> => {
    if (!activeProjectId) return
    setBusy(result.doi || result.title)
    try {
      await api.references.upsert({
        projectId: activeProjectId,
        title: result.title,
        authors: result.authors,
        year: result.year,
        venue: result.venue,
        doi: result.doi,
        url: result.url,
        abstract: result.abstract
      })
      toast.success('已加入文献库')
      await load()
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setBusy('')
    }
  }

  const generateReadingDraft = async (): Promise<void> => {
    if (!selected || !activeProjectId || selected.projectId !== activeProjectId || dirty || readingStarting || agentBusy) return
    if (!selected.abstract.trim()) { toast.error('暂无摘要，请先补充并保存。PDF 全文尚未解析。'); return }
    if (!provider?.hasApiKey || !modelSelection.modelId) { toast.error('请先在模型设置中选择并配置提供方。'); return }
    setReadingStarting(true)
    try {
      // One locked store operation creates a dedicated chat, retains the selected model,
      // and actually sends; it does not consume another conversation's unsent draft.
      const sent = await useAppStore.getState().send(referenceReadingPrompt(selected), [], true)
      if (!sent) { toast.error('摘记任务未发送，请检查模型配置或等待当前任务结束后重试。'); return }
      if (projectRef.current !== activeProjectId) return
      toast.success('阅读摘记任务已发送；保存草稿时需要你确认')
      navigate('/agent')
    } catch (error) {
      toast.error(formatError(error))
    } finally { setReadingStarting(false) }
  }

  const copyReadingDraft = async (): Promise<void> => {
    if (!readingDraft || readingDraft.referenceId !== selected?.id || readingDraft.projectId !== activeProjectId) return
    try {
      await navigator.clipboard.writeText(readingDraft.content)
      toast.success('AI 草稿已复制；人工笔记未改动，请核查后自行粘贴采用')
    } catch (error) { toast.error(`复制失败，可选中草稿文字手动复制：${formatError(error)}`) }
  }

  const saveSelected = async (): Promise<void> => {
    if (!activeProjectId || !selected) return
    setBusy('save')
    try {
      const next = await api.references.upsert({
        ...selected,
        projectId: activeProjectId,
        tags: selected.tags
      })
      if (projectRef.current !== activeProjectId) return
      if (selectedRef.current?.id === selected.id) {
        setSelectedBaseline(next)
        if (selectedRef.current === selected) setSelected(next)
      }
      toast.success('已保存；摘要与笔记已更新到项目知识库')
      await load()
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setBusy('')
    }
  }

  const attachPdf = async (): Promise<void> => {
    if (!activeProjectId || !selected) return
    try {
      const next = await api.references.attachPdf(activeProjectId, selected.id)
      if (next && projectRef.current === activeProjectId) {
        setSelected((current) => current?.id === selected.id ? { ...current, pdfRelativePath: next.pdfRelativePath } : current)
        setSelectedBaseline((current) => current?.id === selected.id ? { ...current, pdfRelativePath: next.pdfRelativePath } : current)
        toast.success('PDF 已关联')
        await load()
      }
    } catch (error) {
      toast.error(formatError(error))
    }
  }

  const openPdf = (): void => {
    if (activeProjectId && selected?.pdfRelativePath) setPdf(selected)
  }

  const remove = async (): Promise<void> => {
    if (!activeProjectId || !selected) return
    if (!window.confirm(`删除文献「${selected.title}」？`)) return
    try {
      await api.references.remove(activeProjectId, selected.id)
      if (projectRef.current !== activeProjectId) return
      if (selectedRef.current?.id === selected.id) { setSelected(null); setSelectedBaseline(null) }
      toast.success('已删除')
      await load()
    } catch (error) {
      toast.error(formatError(error))
    }
  }

  return (
    <div className="page research-management library-page">
      <PageHeader
        title="文献库"
        subtitle="查看来源、阅读摘要，把研究判断留在笔记里。"
        actions={(
          <>
            <details className="research-menu" ref={importMenu}>
              <summary className="btn btn-secondary" data-testid="reference-add-menu"><Plus />添加文献<ChevronDown /></summary>
              <div className="research-menu-items">
                <Button onClick={() => openImport(() => setDoiOpen(true))}><Plus />通过 DOI 添加</Button>
                <Button onClick={() => openImport(() => setSearchOpen(true))}><Search />在线检索（Crossref）</Button>
                <Button onClick={() => openImport(() => setBibtexOpen(true))}><Download />导入 BibTeX</Button>
                <Button onClick={() => openImport(() => setAddOpen(true))}><FilePlus2 />手动录入</Button>
              </div>
            </details>
            <Button variant="primary" onClick={askAssistant}>让助手检索</Button>
          </>
        )}
      />
      <div className="toolbar research-toolbar">
        <div className="search-box">
          <Search />
          <input className="input" aria-label="搜索文献" value={query} onChange={(event) => { setQuery(event.target.value); void load(event.target.value) }} placeholder="搜索标题、作者、笔记或标签…" />
        </div>
        <span className="small muted" role="status">{loading ? '检索中…' : `${references.length} 条${query ? '匹配' : ''}文献`}</span>
        <Button variant="ghost" onClick={() => navigate('/knowledge')}>阅读记录</Button>
      </div>
      <div className={`reference-layout${selected ? ' has-selection' : ''}`}>
        <section className="reference-list" aria-label="文献列表">
          {references.length === 0 && !loading ? (
            <EmptyState icon={<BookOpen />} title={query ? '没有匹配的文献' : '还没有收录文献'} text={query ? '换一个关键词，或清空搜索查看全部文献。' : '助手检索到的真实来源会收录在这里。也可以通过「添加文献」导入已有资料。'} action={query ? <Button onClick={() => { setQuery(''); void load('') }}>清空搜索</Button> : <Button onClick={askAssistant}>让助手检索</Button>} />
          ) : references.map((reference) => (
            <button type="button" key={reference.id} className={`ref-card reference-row${selected?.id === reference.id ? ' active' : ''}`} data-testid="reference-row" aria-pressed={selected?.id === reference.id} onClick={() => selectReference(reference)}>
              <div className="reference-row-main">
                <div className="ref-title">{reference.title}</div>
                <div className="ref-meta">{reference.authors || '作者待补充'}{reference.venue ? ` · ${reference.venue}` : ''}</div>
                <div className="reference-doi">{reference.doi ? `DOI ${reference.doi}` : '未提供 DOI'}{reference.tags.length ? <span className="reference-tags">{reference.tags.slice(0, 3).join(' / ')}</span> : null}</div>
                {reference.notes ? <p className="reference-note-preview">笔记：{reference.notes}</p> : null}
              </div>
              <div className="reference-row-end"><span>{reference.year || '年份待补充'}</span>{reference.pdfRelativePath ? <span className="row"><Paperclip size={13} />PDF</span> : null}<span>{relativeTime(reference.updatedAt)}</span></div>
            </button>
          ))}
        </section>
        {selected ? (
          <aside className="reference-reader" data-testid="reference-detail" aria-label="文献详情" key={selected.id}>
            <div className="row-between"><span className="small muted">文献详情</span><Button variant="ghost" aria-label="关闭文献详情" onClick={() => selectReference(null)}><X /></Button></div>
            <h2>{selected.title}</h2>
            <p className="reference-citation">{selected.authors || '作者待补充'}<br />{[selected.year, selected.venue].filter(Boolean).join(' · ') || '出版信息待补充'}</p>
            <dl className="research-provenance">
              <div><dt>DOI</dt><dd>{selected.doi || '未提供'}</dd></div>
              <div><dt>来源链接</dt><dd>{selected.url || '未提供'}</dd></div>
              <div><dt>本地附件</dt><dd>{selected.pdfRelativePath || '未关联 PDF'}</dd></div>
            </dl>
            <div className="row wrap"><Button size="sm" onClick={() => void attachPdf()}><Paperclip />关联 PDF</Button>{selected.pdfRelativePath ? <Button size="sm" onClick={() => void openPdf()}><ExternalLink />查看 PDF</Button> : null}{selected.doi || /^https?:\/\//i.test(selected.url) ? <Button size="sm" onClick={() => void api.openExternal(selected.doi ? `https://doi.org/${selected.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')}` : selected.url).catch(error => toast.error(formatError(error)))}><ExternalLink />访问来源</Button> : null}</div>
            <section className="reference-abstract"><h3>摘要</h3><p>{selected.abstract || '暂无摘要，可在「编辑资料」中补充。'}</p>{selected.pdfRelativePath && <Button size="sm" disabled={fulltextBusy} onClick={() => void extractFulltext()}>{fulltextBusy ? '正在提取…' : '提取全文页'}</Button>}</section>
            <section className="reference-reading" aria-label="AI 阅读摘记">
              <div className="row-between wrap"><h3>AI 阅读摘记</h3><Button size="sm" variant="ghost" disabled={draftLoading} onClick={() => setDraftRefresh(value => value + 1)}>刷新草稿</Button></div>
              <p className="small muted">仅以已保存的标题和摘要为论文依据，不含 PDF 全文。点击后发送给 {provider?.name || '未选择提供方'} / {modelSelection.modelId || '未选择模型'}；助手可读取已有笔记作为背景，但不能据此编造论文结论。在独立对话中生成，保存需确认，原笔记不会被覆盖。</p>
              <Button data-testid="reference-generate-reading" disabled={!selected.abstract.trim() || dirty || readingStarting || agentBusy || !provider?.hasApiKey || !modelSelection.modelId} onClick={() => void generateReadingDraft()}>{readingStarting ? <><Loader2 className="spin" />发送中…</> : 'AI 生成阅读摘记'}</Button>
              {!selected.abstract.trim() ? <p className="small muted">暂无摘要，请在「编辑资料与标签」中补充并保存。关联 PDF 仍不能生成全文摘记。</p> : dirty ? <p className="small muted">请先保存修改，再发送已登记摘要。</p> : agentBusy ? <p className="small muted">当前有任务执行中，请等待完成。可在助手对话中查看进度与确认请求。</p> : !provider?.hasApiKey || !modelSelection.modelId ? <p className="small muted">请先在模型设置中选择并配置提供方。</p> : null}
              {draftLoading ? <p className="small muted" role="status">正在读取已保存的 AI 草稿…</p> : draftError ? <p className="small muted" role="alert">草稿读取失败：{draftError}</p> : readingDraft?.referenceId === selected.id && readingDraft.projectId === activeProjectId ? <div className="reference-reading-draft" data-testid="reference-reading-draft">
                <div className="row-between wrap"><strong>AI 草稿 · 待核查</strong><span className="small muted">{relativeTime(readingDraft.createdAt)}</span></div>
                <p className="small muted">{readingDraft.modelLabel} · 仅摘要（abstract-only）<br />来源：{readingDraft.referenceId}<br /><time dateTime={readingDraft.createdAt}>{new Date(readingDraft.createdAt).toLocaleString()}</time></p>
                {readingDraft.sourceChanged ? <p role="alert" className="small">来源标题或摘要已变化，这份草稿可能过期。请重新生成后核查。</p> : null}
                <details><summary className="small muted">来源版本</summary><code className="small">{readingDraft.sourceHash}</code></details>
                <pre className="reference-reading-content">{readingDraft.content}</pre>
                <Button size="sm" onClick={() => void copyReadingDraft()}>复制草稿</Button><p className="small muted">核查后可自行粘贴到笔记。复制不会改动或保存人工笔记。</p>
              </div> : <p className="small muted">尚无已保存的 AI 摘记。生成失败、取消或拒绝保存时不会显示虚构结果。</p>}
            </section>
            <Field label="研究笔记" hint="由你编辑与保存；AI 草稿单独存放。保存后同步到项目知识库。"><Textarea aria-label="研究笔记" value={selected.notes} onChange={(event) => setSelected({ ...selected, notes: event.target.value })} placeholder="核查 AI 草稿后粘贴采用，或补充自己的判断与批注…" /></Field>
            <details className="research-disclosure">
              <summary>编辑资料与标签</summary>
              <div className="research-disclosure-body">
                <Field label="标题"><Input value={selected.title} onChange={(event) => setSelected({ ...selected, title: event.target.value })} /></Field>
                <Field label="作者"><Input value={selected.authors} onChange={(event) => setSelected({ ...selected, authors: event.target.value })} /></Field>
                <div className="grid-2"><Field label="年份"><Input value={selected.year} onChange={(event) => setSelected({ ...selected, year: event.target.value })} /></Field><Field label="期刊/会议"><Input value={selected.venue} onChange={(event) => setSelected({ ...selected, venue: event.target.value })} /></Field></div>
                <Field label="DOI"><Input value={selected.doi} onChange={(event) => setSelected({ ...selected, doi: event.target.value })} /></Field>
                <Field label="URL"><Input value={selected.url} onChange={(event) => setSelected({ ...selected, url: event.target.value })} /></Field>
                <Field label="标签"><Input value={selected.tags.join(', ')} onChange={(event) => setSelected({ ...selected, tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) })} /></Field>
                <Field label="摘要"><Textarea value={selected.abstract} onChange={(event) => setSelected({ ...selected, abstract: event.target.value })} /></Field>
                <details><summary>BibTeX</summary><pre className="reference-bibtex">{selected.bibtex || '暂无 BibTeX'}</pre></details>
                <Button variant="danger" size="sm" onClick={() => void remove()}><Trash2 />删除文献</Button>
              </div>
            </details>
            <div className="reference-save"><span className="small muted" role="status">{dirty ? '有未保存的修改' : '已保存'}</span><Button variant="primary" disabled={busy === 'save' || !selected.title.trim()} onClick={() => void saveSelected()}>{busy === 'save' ? '保存中…' : '保存修改'}</Button></div>
          </aside>
        ) : null}
      </div>

      {doiOpen ? (
        <Modal
          title="通过 DOI 添加"
          subtitle="从 Crossref 拉取真实的标题、作者、年份和期刊信息。"
          onClose={() => setDoiOpen(false)}
          footer={(
            <>
              <Button onClick={() => setDoiOpen(false)}>取消</Button>
              <Button variant="primary" disabled={!doi.trim() || busy === 'doi'} onClick={() => void addDoi()}>
                {busy === 'doi' ? '获取中…' : '获取并添加'}
              </Button>
            </>
          )}
        >
          <Field label="DOI">
            <Input autoFocus value={doi} onChange={(event) => setDoi(event.target.value)} placeholder="10.1145/xxxxx 或 https://doi.org/..." onKeyDown={(event) => { if (event.key === 'Enter') void addDoi() }} />
          </Field>
        </Modal>
      ) : null}

      {addOpen ? (
        <Modal
          title="手动录入文献"
          size="wide"
          onClose={() => setAddOpen(false)}
          footer={(
            <>
              <Button onClick={() => setAddOpen(false)}>取消</Button>
              <Button variant="primary" disabled={!form.title.trim() || busy === 'manual'} onClick={() => void addManual()}>
                {busy === 'manual' ? '保存中…' : '保存文献'}
              </Button>
            </>
          )}
        >
          <div className="grid-2">
            <Field label="标题"><Input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></Field>
            <Field label="作者"><Input value={form.authors} onChange={(event) => setForm({ ...form, authors: event.target.value })} placeholder="用逗号分隔" /></Field>
            <Field label="年份"><Input value={form.year} onChange={(event) => setForm({ ...form, year: event.target.value })} /></Field>
            <Field label="期刊/会议"><Input value={form.venue} onChange={(event) => setForm({ ...form, venue: event.target.value })} /></Field>
            <Field label="DOI"><Input value={form.doi} onChange={(event) => setForm({ ...form, doi: event.target.value })} /></Field>
            <Field label="URL"><Input value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} /></Field>
          </div>
          <Field label="标签" hint="用逗号分隔"><Input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} /></Field>
          <Field label="摘要"><Textarea value={form.abstract} onChange={(event) => setForm({ ...form, abstract: event.target.value })} /></Field>
          <Field label="笔记"><Textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></Field>
        </Modal>
      ) : null}

      {bibtexOpen ? (
        <Modal
          title="导入 BibTeX"
          subtitle="粘贴一个或多个 BibTeX 条目。"
          size="wide"
          onClose={() => setBibtexOpen(false)}
          footer={(
            <>
              <Button onClick={() => setBibtexOpen(false)}>取消</Button>
              <Button variant="primary" disabled={!bibtex.trim() || busy === 'bibtex'} onClick={() => void importBibtex()}>
                {busy === 'bibtex' ? '导入中…' : '导入'}
              </Button>
            </>
          )}
        >
          <Textarea style={{ minHeight: 260, fontFamily: 'var(--font-mono)', fontSize: 13 }} value={bibtex} onChange={(event) => setBibtex(event.target.value)} placeholder="@article{...}" />
        </Modal>
      ) : null}

      {searchOpen ? (
        <Modal
          title="在线检索文献"
          subtitle="通过 Crossref 检索元数据。加入前请确认标题与年份。"
          size="wide"
          onClose={() => setSearchOpen(false)}
          footer={<Button onClick={() => setSearchOpen(false)}>关闭</Button>}
        >
          <div className="toolbar">
            <div className="search-box">
              <Search />
              <input className="input" autoFocus value={externalQuery} onChange={(event) => setExternalQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch() }} placeholder="例如：retrieval augmented generation long context" />
            </div>
            <Button variant="primary" disabled={!externalQuery.trim() || busy === 'search'} onClick={() => void runSearch()}>
              {busy === 'search' ? <Loader2 className="spin" /> : <Search />}检索
            </Button>
          </div>
          <div className="list">
            {external.map((result, index) => (
              <div className="list-row" key={`${result.doi || result.title}-${index}`}>
                <div className="list-main">
                  <div className="list-title">{result.title}</div>
                  <div className="list-sub">{result.authors || '作者未知'} · {result.year || '—'} · {result.venue || result.doi}</div>
                </div>
                <Button size="sm" disabled={busy === (result.doi || result.title)} onClick={() => void addExternal(result)}>
                  {busy === (result.doi || result.title) ? '添加中…' : '加入'}
                </Button>
              </div>
            ))}
            {external.length === 0 && busy !== 'search' ? <div className="small muted" style={{ padding: '18px 0' }}>输入关键词并检索。</div> : null}
          </div>
        </Modal>
      ) : null}

      {fulltext && <Modal title="PDF 全文页提取" subtitle={`共 ${fulltext.totalPages} 页；本批 ${fulltext.pages.map(page => page.page).join('、')} 页。仅本地处理，不自动发送模型。`} size="wide" onClose={() => { ++fulltextToken.current; setFulltext(null); setFulltextBusy(false) }} footer={<><Button disabled={fulltextBusy} onClick={() => void extractFulltext()}>从首页重读</Button>{fulltext.nextPage !== null && <Button variant="primary" disabled={fulltextBusy} onClick={() => void extractFulltext(fulltext.nextPage!, fulltext.nextOffset)}>{fulltextBusy ? '正在提取…' : '继续读取'}</Button>}</>}>
        <p className="small muted">{fulltext.limitation}</p><p className="small">本次是否覆盖全部文字页：{fulltext.complete ? '是' : '否，仅当前批次/有未提取页'}；无文字页：{fulltext.noTextPages.join('、') || '本批未发现'}</p><details><summary>原文件 SHA-256</summary><code style={{ overflowWrap: 'anywhere' }}>{fulltext.sha256}</code></details>
        {fulltext.pages.map(page => <section key={`${page.page}:${page.offset}`}><h3>PDF 第 {page.page} 页 · 字符 {page.offset}–{page.offset + page.text.length}</h3><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'var(--font-ui)', lineHeight: 1.8 }}>{page.text || '此页未提取到文字层，需要视觉/OCR核对。'}</pre></section>)}
      </Modal>}
      {pdf && pdf.projectId === activeProjectId ? <PdfReader key={`${pdf.projectId}:${pdf.id}`} reference={pdf} onClose={() => setPdf(null)} /> : null}
    </div>
  )
}
