import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowLeft, BookOpen, Check, ChevronRight, Download, FileText, Link2, PanelRight, Plus, RotateCcw, Save, Search, Star, Trash2 } from 'lucide-react'
import { NOTE_CONFLICT, NOTE_LIMITS, noteLink, type NoteFilter, type NoteRecord, type NoteSummary } from '@shared/notes'
import { api, formatError, relativeTime } from '../lib/api'
import { noteExportFilename, noteMarkdown, notesDrafts, NotesContext, safeNoteUrl } from '../lib/notes-drafts'
import { useAppStore } from '../store/app'
import { Button, Field, Input, Modal } from '../components/Ui'
import './notes.css'

const templates = [
  { id: 'blank', name: '空白笔记', description: '从一个想法开始。', body: '' },
  { id: 'brief', name: '研究简报', description: '梳理问题、已有证据与下一步。', body: '## 研究问题\n\n\n## 背景与动机\n\n\n## 已有证据\n\n\n## 方法与计划\n\n\n## 待验证的问题\n\n- [ ] \n\n## 下一步\n\n- [ ] \n' },
  { id: 'reading', name: '阅读笔记', description: '记录来源、方法和自己的判断。', body: '## 文献来源\n\n标题：\n作者：\n年份：\n链接 / DOI：\n\n## 核心问题\n\n\n## 方法\n\n\n## 关键发现与证据\n\n\n## 局限与疑问\n\n\n## 对当前研究的启发\n\n' },
  { id: 'experiment', name: '实验日志', description: '保留设置、观察与可复现线索。', body: '## 实验目标\n\n\n## 假设\n\n\n## 环境与设置\n\n日期：\n代码 / 版本：\n数据集：\n参数与随机种子：\n\n## 操作记录\n\n\n## 观察与结果\n\n\n## 结论与局限\n\n\n## 下一步\n\n- [ ] \n' }
] as const

type TemplateId = typeof templates[number]['id']
const filterLabels: Record<NoteFilter, string> = { all: '全部', pinned: '收藏', trash: '回收站' }

function exportMarkdown(title: string, body: string): void {
  const url = URL.createObjectURL(new Blob([noteMarkdown(title, body)], { type: 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = noteExportFilename(title)
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // Electron's download handler consumes the URL asynchronously.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function useDraftChanges(): void {
  const [, render] = useState(0)
  useEffect(() => notesDrafts.subscribe(() => render(value => value + 1)), [])
}

export function NotesPage(): ReactNode {
  const projectId = useAppStore(state => state.activeProjectId)
  return <NotesWorkspace key={projectId} projectId={projectId} />
}

function NotesWorkspace({ projectId }: { projectId: string }): ReactNode {
  const { noteId = '' } = useParams<{ noteId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const routeContext = useRef(new NotesContext())
  const routeIdentity = useRef(location.key)
  // Invalidate on render, before any pending create can finish after navigation.
  if (routeIdentity.current !== location.key) {
    routeIdentity.current = location.key
    routeContext.current.invalidate()
  }
  const project = useAppStore(state => state.projects.find(item => item.id === projectId))
  const projectLoading = useAppStore(state => state.projectLoading)
  const [filter, setFilter] = useState<NoteFilter>('all')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<NoteSummary[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [moreLoading, setMoreLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [version, setVersion] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [template, setTemplate] = useState<TemplateId>('blank')
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const mounted = useRef(false)
  const listRequest = useRef(0)
  const createLock = useRef(false)
  const moreLock = useRef(false)
  useDraftChanges()
  const current = (): boolean => mounted.current && useAppStore.getState().activeProjectId === projectId
  const refresh = (): void => { if (current()) setVersion(value => value + 1) }

  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++listRequest.current; routeContext.current.invalidate() }
  }, [])

  useEffect(() => {
    const request = ++listRequest.current
    let cancelled = false
    setLoading(true)
    setListError('')
    setMoreLoading(false)
    moreLock.current = false
    const timer = window.setTimeout(() => {
      if (!projectId) { setItems([]); setLoading(false); return }
      void api.notes.list(projectId, { filter, query, limit: 100 }).then(result => {
        if (cancelled || !current() || request !== listRequest.current) return
        setItems(result.items)
        setTotal(result.total)
        setHasMore(result.hasMore)
      }).catch(error => {
        if (!cancelled && current() && request === listRequest.current) setListError(formatError(error))
      }).finally(() => {
        if (!cancelled && current() && request === listRequest.current) setLoading(false)
      })
    }, query ? 180 : 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [projectId, filter, query, version])

  const loadMore = async (): Promise<void> => {
    if (loading || moreLock.current || !hasMore || !current()) return
    moreLock.current = true
    setMoreLoading(true)
    const request = listRequest.current
    try {
      const result = await api.notes.list(projectId, { filter, query, limit: 100, offset: items.length })
      if (!current() || request !== listRequest.current) return
      setItems(previous => [...previous, ...result.items.filter(item => !previous.some(existing => existing.id === item.id))])
      setTotal(result.total)
      setHasMore(result.hasMore)
    } catch (error) {
      if (current() && request === listRequest.current) setListError(formatError(error))
    } finally {
      if (current() && request === listRequest.current) { moreLock.current = false; setMoreLoading(false) }
    }
  }

  const create = async (): Promise<void> => {
    if (createLock.current || !current() || !projectId || projectLoading || !title.trim()) return
    const routeToken = routeContext.current.capture()
    createLock.current = true
    setCreating(true)
    setCreateError('')
    try {
      const note = await api.notes.create({ projectId, title: title.trim(), body: templates.find(item => item.id === template)!.body })
      notesDrafts.load(note)
      if (!current()) return
      setCreateOpen(false)
      setTitle('')
      refresh()
      // The create succeeded locally, but a later navigation owns the current view.
      if (!routeContext.current.isCurrent(routeToken)) return
      setQuery('')
      setFilter('all')
      navigate(`/notes/${encodeURIComponent(note.id)}`)
    } catch (error) {
      if (current()) setCreateError(formatError(error))
    } finally {
      createLock.current = false
      if (current()) setCreating(false)
    }
  }

  const openCreate = (): void => { setTitle(''); setTemplate('blank'); setCreateError(''); setCreateOpen(true) }

  return <div className={`notes-workspace${noteId ? ' has-selection' : ''}`} data-testid="notes-page">
    <aside className="notes-index" aria-label="项目笔记">
      <div className="notes-index-head"><div><h1>研究笔记</h1><p title={project?.name}>{project?.name ?? '当前项目'}</p></div><Button size="sm" aria-label="新建笔记" data-testid="notes-new" disabled={!projectId || projectLoading || creating} onClick={openCreate}><Plus size={15} /></Button></div>
      <label className="notes-search"><Search size={15} /><input aria-label="搜索笔记" data-testid="notes-search" placeholder="搜索标题与正文" maxLength={NOTE_LIMITS.query} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="notes-filters" aria-label="笔记筛选">{(['all', 'pinned', 'trash'] as NoteFilter[]).map(value => <button type="button" key={value} aria-pressed={filter === value} data-testid={`notes-filter-${value}`} onClick={() => setFilter(value)}>{value === 'pinned' ? <Star size={13} /> : value === 'trash' ? <Trash2 size={13} /> : <FileText size={13} />}{filterLabels[value]}</button>)}</div>
      <div className="notes-list-heading"><span>{filterLabels[filter]}笔记</span><span>{loading ? '…' : total}</span></div>
      <div className="notes-list" aria-label="笔记列表" aria-busy={loading}>
        {listError ? <div className="notes-inline-error" role="alert">{listError}<Button size="sm" onClick={refresh}>重试</Button></div> : null}
        {loading ? <p className="notes-list-message" role="status">正在读取笔记…</p> : items.length ? items.map(note => {
          const scope = { projectId, id: note.id }
          const dirty = notesDrafts.isModified(scope)
          return <button type="button" className={`notes-list-row${note.id === noteId ? ' selected' : ''}`} key={note.id} data-testid="notes-row" data-note-id={note.id} aria-current={note.id === noteId ? 'page' : undefined} onClick={() => navigate(`/notes/${encodeURIComponent(note.id)}`)}>
            <span className="notes-row-title"><FileText size={14} /><span>{dirty ? notesDrafts.get(scope)?.title || '未命名笔记' : note.title}</span>{note.pinned ? <Star size={12} fill="currentColor" aria-label="已收藏" /> : null}{dirty ? <span className="notes-draft-dot" title="未保存" aria-label="未保存" /> : null}</span>
            <span className="notes-row-snippet">{note.snippet || '还没有正文'}</span><span className="notes-row-date">{note.deletedAt ? '移入回收站 ' : '编辑于 '}{relativeTime(note.deletedAt ?? note.updatedAt)}</span>
          </button>
        }) : !listError ? <div className="notes-list-empty"><FileText size={22} /><strong>{query ? '没有匹配的笔记' : filter === 'trash' ? '回收站为空' : filter === 'pinned' ? '还没有收藏' : '还没有笔记'}</strong><p>{query ? '换个关键词，搜索已保存的标题与正文。' : filter === 'trash' ? '移入回收站的笔记可以恢复。' : filter === 'pinned' ? '打开笔记，点击星标即可收藏。' : '新建一页，记录问题、证据与想法。'}</p>{filter === 'all' && !query ? <Button size="sm" onClick={openCreate} disabled={!projectId}>新建笔记</Button> : null}</div> : null}
        {!loading && hasMore ? <button type="button" className="notes-load-more" disabled={moreLoading} onClick={() => void loadMore()}>{moreLoading ? '正在读取…' : '加载更多'}</button> : null}
      </div>
      <div className="notes-index-foot">保存在本机，按项目独立管理。<br />编辑后请手动保存。</div>
    </aside>
    <main className="notes-document-area">
      {noteId ? <NoteEditor key={`${projectId}:${noteId}`} projectId={projectId} noteId={noteId} onChanged={refresh} /> : <div className="notes-welcome">
        <BookOpen size={28} strokeWidth={1.4} /><h2>给研究留一页空间</h2><p>记录阅读时的疑问、实验中的观察，<br />用页面链接把证据与想法连起来。</p><Button variant="primary" onClick={openCreate} disabled={!projectId || projectLoading}><Plus size={15} />新建笔记</Button><span>选择左侧笔记继续编辑</span>
      </div>}
    </main>
    {createOpen ? <Modal title="新建笔记" subtitle="选择一个起点。模板只有结构，不会生成研究数据。" onClose={() => { if (!creating) setCreateOpen(false) }} footer={<><Button disabled={creating} onClick={() => setCreateOpen(false)}>取消</Button><Button data-testid="notes-create-confirm" variant="primary" disabled={creating || !title.trim() || projectLoading} onClick={() => void create()}>{creating ? '正在创建…' : '创建笔记'}</Button></>}>
      <Field label="笔记标题"><Input autoFocus data-testid="notes-create-title" value={title} maxLength={NOTE_LIMITS.title} placeholder="为这页笔记起个名字" onChange={event => setTitle(event.target.value)} disabled={creating} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void create() }} /></Field>
      <fieldset className="notes-templates"><legend>模板</legend>{templates.map(item => <label key={item.id} className={template === item.id ? 'selected' : ''}><input type="radio" name="note-template" value={item.id} data-testid={`notes-template-${item.id}`} checked={template === item.id} disabled={creating} onChange={() => setTemplate(item.id)} /><span><strong>{item.name}</strong><small>{item.description}</small></span></label>)}</fieldset>
      {createError ? <p role="alert" className="notes-error-text">{createError}</p> : null}
    </Modal> : null}
  </div>
}

function NoteEditor({ projectId, noteId, onChanged }: { projectId: string; noteId: string; onChanged: () => void }): ReactNode {
  const navigate = useNavigate()
  const projectLoading = useAppStore(state => state.projectLoading)
  const [note, setNote] = useState<NoteRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [notice, setNotice] = useState('')
  const [action, setAction] = useState('')
  const [preview, setPreview] = useState(true)
  const [confirm, setConfirm] = useState<'reload' | 'trash' | null>(null)
  const [linkPicker, setLinkPicker] = useState(false)
  const [backlinks, setBacklinks] = useState<NoteSummary[]>([])
  const [backlinksError, setBacklinksError] = useState('')
  const [backlinksLoading, setBacklinksLoading] = useState(true)
  const [backlinksVersion, setBacklinksVersion] = useState(0)
  const mounted = useRef(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const selection = useRef({ start: 0, end: 0 })
  const scope = { projectId, id: noteId }
  useDraftChanges()
  const draft = notesDrafts.get(scope)
  const dirty = notesDrafts.isModified(scope)
  const busy = notesDrafts.isBusy(scope)
  const readOnly = !!note?.deletedAt || projectLoading || action === 'reload'
  const current = (): boolean => mounted.current && useAppStore.getState().activeProjectId === projectId

  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError('')
    void api.notes.get(projectId, noteId).then(result => {
      if (cancelled || !current()) return
      notesDrafts.load(result)
      setNote(result)
    }).catch(cause => {
      if (!cancelled && current()) setLoadError(formatError(cause))
    }).finally(() => { if (!cancelled && current()) setLoading(false) })
    return () => { cancelled = true }
  }, [loadAttempt])

  useEffect(() => {
    let cancelled = false
    setBacklinksLoading(true)
    setBacklinksError('')
    void api.notes.backlinks(projectId, noteId).then(result => {
      if (!cancelled && current()) setBacklinks(result)
    }).catch(cause => {
      if (!cancelled && current()) setBacklinksError(formatError(cause))
    }).finally(() => { if (!cancelled && current()) setBacklinksLoading(false) })
    return () => { cancelled = true }
  }, [backlinksVersion])

  const save = async (): Promise<void> => {
    const submitted = notesDrafts.get(scope)
    if (!submitted || !note || readOnly || !current() || !notesDrafts.isModified(scope) || conflict || !submitted.title.trim()) return
    const release = notesDrafts.acquire(scope)
    if (!release) return
    setAction('save'); setError(''); setNotice('')
    try {
      const result = await api.notes.update({ ...scope, title: submitted.title, body: submitted.body, expectedRevision: submitted.revision })
      notesDrafts.saved(result, submitted)
      if (!current()) return
      setNote(result)
      setNotice(notesDrafts.isModified(scope) ? '已保存提交的版本；新修改尚未保存。' : '已保存到本机')
      onChanged()
      setBacklinksVersion(value => value + 1)
    } catch (cause) {
      if (!current()) return
      const message = formatError(cause)
      const isConflict = message.includes(NOTE_CONFLICT)
      setConflict(isConflict)
      setError(isConflict ? '这页笔记已在别处更新，未覆盖任何内容。你的草稿仍保留在这里；可先导出，再重新加载已保存版本。' : message)
    } finally { release(); if (current()) setAction('') }
  }
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      if (!event.repeat && !event.isComposing) void saveRef.current()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const mutate = async (kind: 'pin' | 'trash' | 'restore' | 'reload'): Promise<void> => {
    if (!note || !current() || projectLoading) return
    const release = notesDrafts.acquire(scope)
    if (!release) return
    setAction(kind); setError(''); setNotice('')
    try {
      const result = kind === 'pin' ? await api.notes.setPinned(projectId, noteId, !note.pinned)
        : kind === 'trash' ? await api.notes.trash(projectId, noteId)
          : kind === 'restore' ? await api.notes.restore(projectId, noteId)
            : await api.notes.get(projectId, noteId)
      if (kind === 'reload') {
        // Never discard current editor text after its owner has unmounted.
        if (!current()) return
        notesDrafts.reload(result)
      } else notesDrafts.metadataUpdated(result)
      if (!current()) return
      setNote(result)
      setConfirm(null)
      if (kind === 'reload') setConflict(false)
      setNotice(kind === 'reload' ? '已重新加载。被替换的未保存草稿可在下方导出。' : kind === 'trash' ? '已移入回收站，可以恢复。' : kind === 'restore' ? '笔记已恢复。' : result.pinned ? '已收藏' : '已取消收藏')
      onChanged()
      setBacklinksVersion(value => value + 1)
    } catch (cause) { if (current()) setError(formatError(cause)) }
    finally { release(); if (current()) setAction('') }
  }

  const insertLink = (target: NoteSummary): void => {
    const currentDraft = notesDrafts.get(scope)
    if (!currentDraft || readOnly || busy || target.projectId !== projectId) return
    const insertion = noteLink(target.id, target.title)
    const { start, end } = selection.current
    const body = `${currentDraft.body.slice(0, start)}${insertion}${currentDraft.body.slice(end)}`
    if (body.length > NOTE_LIMITS.body) { setError('插入后超出正文长度限制，请先缩短正文。'); setLinkPicker(false); return }
    notesDrafts.edit(scope, { body })
    setLinkPicker(false)
    window.requestAnimationFrame(() => {
      bodyRef.current?.focus()
      bodyRef.current?.setSelectionRange(start + insertion.length, start + insertion.length)
    })
  }

  if (loading) return <div className="notes-document-message" role="status">正在打开笔记…</div>
  if (loadError || !note || !draft) return <div className="notes-document-message"><FileText size={25} /><h2>无法打开这页笔记</h2><p role="alert">{loadError || '笔记不存在或不属于当前项目。'}</p><div><Button onClick={() => navigate('/notes')}>返回笔记</Button><Button onClick={() => setLoadAttempt(value => value + 1)}>重试</Button></div></div>

  return <article className="notes-document" data-testid="note-editor" data-note-id={noteId}>
    <header className="notes-document-toolbar"><button type="button" className="notes-breadcrumb" onClick={() => navigate('/notes')} aria-label="返回笔记列表"><ArrowLeft size={14} /><span>笔记</span><ChevronRight size={12} /><span>{note.title}</span></button>
      <div className="notes-document-actions">
        <button type="button" className="notes-tool" aria-label={note.pinned ? '取消收藏' : '收藏笔记'} aria-pressed={note.pinned} title={note.pinned ? '取消收藏' : '收藏笔记'} data-testid="note-pin" disabled={busy || readOnly} onClick={() => void mutate('pin')}><Star size={16} fill={note.pinned ? 'currentColor' : 'none'} /></button>
        <button type="button" className="notes-tool" aria-label="导出 Markdown" title="导出当前编辑内容为 Markdown" data-testid="note-export" onClick={() => exportMarkdown(draft.title, draft.body)}><Download size={16} /></button>
        <button type="button" className="notes-tool" aria-label="显示预览" title="切换预览" aria-pressed={preview} data-testid="note-preview-toggle" onClick={() => setPreview(value => !value)}><PanelRight size={16} /></button>
        {!note.deletedAt ? <button type="button" className="notes-tool" aria-label="移入回收站" title="移入回收站" data-testid="note-trash" disabled={busy || projectLoading} onClick={() => setConfirm('trash')}><Trash2 size={15} /></button> : null}
        <Button size="sm" variant="primary" data-testid="note-save" disabled={busy || readOnly || !dirty || !draft.title.trim() || conflict} onClick={() => void save()}><Save size={14} />{action === 'save' ? '保存中…' : '保存'}</Button>
      </div>
    </header>
    {note.deletedAt ? <div className="notes-trash-banner"><Trash2 size={16} /><span>这页笔记在回收站中。恢复后可继续编辑。</span><Button size="sm" data-testid="note-restore" disabled={busy || projectLoading} onClick={() => void mutate('restore')}><RotateCcw size={14} />恢复笔记</Button></div> : null}
    {error ? <div className="notes-editor-alert" role="alert" data-testid="note-error"><span>{error}</span>{conflict ? <Button size="sm" data-testid="note-conflict-reload" disabled={busy} onClick={() => setConfirm('reload')}>重新加载已保存版本</Button> : null}</div> : null}
    <div className="notes-document-scroll">
      <div className="notes-title-block"><div className="notes-page-symbol"><FileText size={27} strokeWidth={1.3} /></div><input className="notes-title-input" aria-label="笔记标题" data-testid="note-title" placeholder="未命名笔记" maxLength={NOTE_LIMITS.title} value={draft.title} readOnly={readOnly} onChange={event => { notesDrafts.edit(scope, { title: event.target.value }); setNotice('') }} />
        <div className="notes-document-meta"><span data-testid="note-save-status" className={dirty ? 'notes-unsaved' : ''}>{dirty ? '有未保存的修改' : <><Check size={12} />已保存</>}</span><span>编辑于 {relativeTime(note.updatedAt)}</span><span>Ctrl / ⌘ S 保存</span></div>
        <p className="notes-draft-hint">{dirty ? '草稿在切换笔记时保留；关闭应用或重新加载前请保存。' : 'Markdown 编辑。笔记不会自动加入知识库，也不会自动发送给模型。'}</p>
      </div>
      <div className={`notes-writing-surface${preview ? ' with-preview' : ''}`}>
        <section className="notes-source" aria-label="Markdown 编辑器"><div className="notes-pane-head"><span>正文 <small>Markdown</small></span><button type="button" data-testid="note-insert-link" disabled={readOnly || busy} onClick={() => { selection.current = { start: bodyRef.current?.selectionStart ?? draft.body.length, end: bodyRef.current?.selectionEnd ?? draft.body.length }; setLinkPicker(true) }}><Link2 size={14} />插入页面链接</button></div>
          <textarea ref={bodyRef} aria-label="笔记正文" data-testid="note-body" className="notes-body-input" placeholder="写下问题、证据与想法…\n\n用 ## 添加小标题，用 - [ ] 记录待办。" spellCheck={false} maxLength={NOTE_LIMITS.body} value={draft.body} readOnly={readOnly} onChange={event => { notesDrafts.edit(scope, { body: event.target.value }); setNotice('') }} />
          <div className="notes-editor-count">{draft.body.length.toLocaleString()} / {NOTE_LIMITS.body.toLocaleString()} 字符</div>
        </section>
        {preview ? <section className="notes-preview" aria-label="笔记预览" data-testid="note-preview"><div className="notes-pane-head"><span>预览</span><span>当前草稿</span></div><div className="notes-markdown"><h1>{draft.title || '未命名笔记'}</h1>{draft.body ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeNoteUrl} components={{
          a: ({ href, children }) => {
            const safe = safeNoteUrl(href ?? '')
            if (!safe) return <span className="notes-blocked-link" title="仅支持当前项目笔记链接和 HTTPS 链接">{children}</span>
            if (safe.startsWith('research-note:')) return <button type="button" className="notes-page-link" data-note-link={safe.slice('research-note:'.length)} onClick={() => navigate(`/notes/${encodeURIComponent(safe.slice('research-note:'.length))}`)}><FileText size={13} />{children}</button>
            return <a href={safe} onClick={event => { event.preventDefault(); void api.openExternal(safe).catch(cause => { if (current()) setError(formatError(cause)) }) }} onAuxClick={event => event.preventDefault()}>{children}</a>
          },
          img: ({ alt }) => <span className="notes-image-placeholder">[图片：{alt || '未命名'}；预览不加载外部图片]</span>
        }}>{draft.body}</ReactMarkdown> : <p className="notes-preview-empty">正文预览会显示在这里。</p>}</div></section> : null}
      </div>
      <section className="notes-backlinks" aria-label="反向链接" data-testid="note-backlinks"><div className="notes-backlinks-head"><h2><Link2 size={14} />链接到此页</h2><Button size="sm" variant="ghost" disabled={backlinksLoading} onClick={() => setBacklinksVersion(value => value + 1)}>刷新</Button></div>{backlinksLoading ? <p role="status">正在读取链接…</p> : backlinksError ? <p role="alert">{backlinksError}</p> : backlinks.length ? <ul>{backlinks.map(source => <li key={source.id}><button type="button" onClick={() => navigate(`/notes/${encodeURIComponent(source.id)}`)}><FileText size={14} /><span>{source.title}</span><ChevronRight size={12} /></button></li>)}</ul> : <p>还没有其他笔记链接到此页。在另一页插入页面链接并保存后，会显示在这里。</p>}</section>
      {draft.recovery ? <div className="notes-recovery" data-testid="note-recovery"><span>重新加载前的未保存草稿仍保留在本次会话内。</span><Button size="sm" onClick={() => exportMarkdown(`${draft.recovery!.title} - 恢复草稿`, draft.recovery!.body)}><Download size={13} />导出恢复草稿</Button></div> : null}
      {notice ? <p className="notes-notice" role="status">{notice}</p> : null}
    </div>
    {confirm ? <Modal title={confirm === 'reload' ? '重新加载已保存版本？' : '移入回收站？'} onClose={() => { if (!busy) setConfirm(null) }} footer={<><Button disabled={busy} onClick={() => setConfirm(null)}>取消</Button><Button variant={confirm === 'trash' ? 'danger' : 'primary'} data-testid="note-confirm-action" disabled={busy} onClick={() => void mutate(confirm)}>{busy ? '处理中…' : confirm === 'trash' ? '移入回收站' : '确认重新加载'}</Button></>}>
      <p>{confirm === 'reload' ? '编辑器将显示最新保存版本。当前未保存内容会保留为可导出的恢复草稿，不会强制覆盖已保存内容。' : '笔记可以随时从回收站恢复。未保存的修改仅保留在本次会话的草稿中；你也可以先导出 Markdown。'}</p>
      {error && !conflict ? <p role="alert" className="notes-error-text">{error}</p> : null}
    </Modal> : null}
    {linkPicker ? <NoteLinkPicker projectId={projectId} excludeId={noteId} onPick={insertLink} onClose={() => setLinkPicker(false)} /> : null}
  </article>
}

function NoteLinkPicker({ projectId, excludeId, onPick, onClose }: { projectId: string; excludeId: string; onPick: (note: NoteSummary) => void; onClose: () => void }): ReactNode {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<NoteSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    const timer = window.setTimeout(() => {
      void api.notes.list(projectId, { filter: 'all', query, limit: 100 }).then(result => {
        if (cancelled || useAppStore.getState().activeProjectId !== projectId) return
        setItems(result.items.filter(item => item.id !== excludeId))
        setHasMore(result.hasMore)
      }).catch(cause => { if (!cancelled) setError(formatError(cause)) }).finally(() => { if (!cancelled) setLoading(false) })
    }, query ? 180 : 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [query, attempt])
  return <Modal title="链接到项目中的笔记" subtitle="链接使用固定页面 ID；修改标题不会破坏链接。" onClose={onClose}>
    <Input autoFocus aria-label="搜索链接目标" data-testid="note-link-search" value={query} maxLength={NOTE_LIMITS.query} placeholder="搜索标题或正文" onChange={event => setQuery(event.target.value)} />
    <div className="notes-link-results" data-testid="note-link-results">{loading ? <p role="status">正在查找…</p> : error ? <div role="alert">{error}<Button size="sm" onClick={() => setAttempt(value => value + 1)}>重试</Button></div> : items.length ? items.map(item => <button type="button" key={item.id} data-testid="note-link-option" data-note-id={item.id} onClick={() => onPick(item)}><FileText size={15} /><span>{item.title}</span><Plus size={14} /></button>) : <p>没有可链接的其他笔记。先创建一页，或换个关键词。</p>}</div>
    {hasMore ? <p className="notes-picker-hint">显示前 100 条结果，请输入更具体的关键词。</p> : null}
  </Modal>
}
