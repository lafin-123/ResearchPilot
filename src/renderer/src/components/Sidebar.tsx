import { useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { BookOpen, FileText, FlaskConical, FolderOpen, LayoutDashboard, MessageSquare, Network, Plus, Settings, SquarePen } from 'lucide-react'
import { toast } from 'sonner'
import { api, formatError } from '../lib/api'
import { useAppStore } from '../store/app'
import { Button, Field, Input, Modal, Textarea } from './Ui'
import { PRIMARY_WORKSPACES, workspaceForPath } from '../lib/workspace-navigation'

const WORKSPACE_ICONS = { home: LayoutDashboard, assistant: MessageSquare, literature: BookOpen, experiments: FlaskConical, writing: FileText }

export function Sidebar(): ReactNode {
  const navigate = useNavigate()
  const location = useLocation()
  const activeWorkspace = workspaceForPath(location.pathname)
  const projects = useAppStore((s) => s.projects)
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  const openProject = useAppStore((s) => s.openProject)
  const refreshBootstrap = useAppStore((s) => s.refreshBootstrap)
  const chats = useAppStore((s) => s.chats)
  const activeChatId = useAppStore((s) => s.activeChatId)
  const selectChat = useAppStore((s) => s.selectChat)
  const newChat = useAppStore((s) => s.newChat)
  const providers = useAppStore((s) => s.providers)
  const bootstrap = useAppStore((s) => s.bootstrap)
  const running = useAppStore((s) => ['running', 'starting'].includes(s.agentState?.status ?? ''))
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const hasKey = providers.some((p) => p.hasApiKey)

  const startTask = async (): Promise<void> => {
    await newChat()
    navigate('/agent')
  }
  const createProject = async (): Promise<void> => {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      const created = await api.projects.create({ name: name.trim(), description: description.trim() })
      await refreshBootstrap()
      await openProject(created.id)
      setCreateOpen(false)
      setName('')
      setDescription('')
      navigate('/')
      toast.success('项目已创建')
    } catch (error) { toast.error(formatError(error)) } finally { setBusy(false) }
  }

  return <>
    <aside className="sidebar" aria-label="主导航">
      <button className="sidebar-brand" onClick={() => navigate('/')} aria-label="ResearchPilot 首页"><div className="brand-mark"><Network size={18} strokeWidth={1.6} /></div><div><div className="brand-name">ResearchPilot</div><div className="brand-sub">科研工作空间</div></div></button>
      <div className="workspace-select"><span className="workspace-avatar"><FolderOpen size={16} /></span><select value={activeProjectId} disabled={running} onChange={(e) => { if (e.target.value) void openProject(e.target.value).then(() => navigate('/')) }} aria-label="切换研究项目">{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><button className="icon-mini" title="新建研究项目" aria-label="新建研究项目" disabled={running} onClick={() => setCreateOpen(true)}><Plus size={15} /></button></div>
      <button className="side-new" aria-label="新建研究任务 Ctrl N" title="新建研究任务（Ctrl N）" onClick={() => void startTask()} disabled={!activeProjectId || running}><SquarePen size={16} /><span>新建研究任务</span><kbd>Ctrl N</kbd></button>
      <div className="sidebar-scroll">
        <nav className="side-main-nav" aria-label="工作区">
          {PRIMARY_WORKSPACES.map(workspace => {
            const Icon = WORKSPACE_ICONS[workspace.id as keyof typeof WORKSPACE_ICONS]
            const active = activeWorkspace?.id === workspace.id
            return <Link key={workspace.id} to={workspace.path} aria-label={workspace.label} aria-current={active ? 'page' : undefined} className={`tool-link${active ? ' active' : ''}`}><Icon size={17} /><span>{workspace.label}</span>{workspace.id === 'assistant' && running && <span className="status-dot running" />}</Link>
          })}
        </nav>
        <div className="side-section recent-section"><div className="side-section-head"><span>最近会话</span><span className="side-count">{chats.length}</span></div><div className="side-task-list">{chats.slice(0, 7).map((chat) => <button key={chat.id} className={`side-task${location.pathname === '/agent' && chat.id === activeChatId ? ' active' : ''}`} onClick={() => { void selectChat(chat.id); navigate('/agent') }}><MessageSquare size={13} /><span className="side-task-title">{chat.title}</span></button>)}{chats.length === 0 && <div className="side-task-empty">暂无会话</div>}</div></div>
      </div>
      <div className="sidebar-bottom"><div className="side-utilities"><button onClick={() => { void api.projects.reveal(activeProjectId).catch((e) => toast.error(formatError(e))) }} title="打开项目文件夹" aria-label="打开项目文件夹"><FolderOpen size={16} /></button><Link to="/settings" aria-label="设置" aria-current={activeWorkspace?.id === 'settings' ? 'page' : undefined} className={activeWorkspace?.id === 'settings' ? 'active' : ''}><Settings size={16} /><span>设置</span></Link><span className="side-version">v{bootstrap?.version ?? '0.3.0'}</span></div><div className="side-status"><span className={`status-dot ${hasKey ? 'idle' : 'error'}`} /><span>{hasKey ? '模型已配置' : '等待连接模型'}</span></div></div>
    </aside>
    {createOpen && <Modal title="创建研究项目" subtitle="文献、实验、绘图与论文集中保存，各项目独立管理。" onClose={() => { if (!busy) setCreateOpen(false) }} footer={<><Button disabled={busy} onClick={() => setCreateOpen(false)}>取消</Button><Button variant="primary" disabled={busy || !name.trim()} onClick={() => void createProject()}>{busy ? '创建中…' : '创建项目'}</Button></>}><Field label="项目名称"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：长文档检索的鲁棒性研究" /></Field><Field label="研究目标" hint="可选，作为研究助手的项目上下文。"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="研究问题、数据来源、目标期刊…" /></Field></Modal>}
  </>
}
