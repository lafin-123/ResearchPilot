import { useState, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { BookOpen, ChartNoAxesCombined, FileText, FlaskConical, FolderOpen, LayoutDashboard, MessageSquare, Network, Plus, Settings, Sparkles, SquarePen, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { api, formatError } from '../lib/api'
import { useAppStore } from '../store/app'
import { Button, Field, Input, Modal, Textarea } from './Ui'

const TOOLS = [
  { to: '/notes', label: '研究笔记', icon: SquarePen },
  { to: '/library', label: '文献资料', icon: BookOpen },
  { to: '/knowledge', label: '项目知识与阅读', icon: Network },
  { to: '/experiments', label: '实验与分析', icon: FlaskConical },
  { to: '/figures', label: '科研绘图', icon: ChartNoAxesCombined },
  { to: '/writing', label: '论文写作', icon: FileText },
  { to: '/writing-quality', label: '写作质量与改写', icon: SquarePen },
  { to: '/mcp', label: 'MCP 工具连接', icon: Network },
  { to: '/setup', label: '使用准备检查', icon: Settings },
  { to: '/backups', label: '备份与恢复', icon: FolderOpen }
]

export function Sidebar(): ReactNode {
  const navigate = useNavigate()
  const location = useLocation()
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
        <nav className="side-main-nav">
          <NavLink to="/" end aria-label="研究工作台" className={({ isActive }) => `tool-link${isActive ? ' active' : ''}`}><LayoutDashboard size={17} /><span>研究工作台</span></NavLink>
          <NavLink to="/agent" aria-label="研究助手" className={({ isActive }) => `tool-link${isActive ? ' active' : ''}`}><MessageSquare size={17} /><span>研究助手</span>{running && <span className="status-dot running" />}</NavLink>
          <NavLink to="/pipeline" aria-label="一键研究流程" className={({ isActive }) => `tool-link${isActive ? ' active' : ''}`}><Workflow size={17} /><span>一键研究流程</span></NavLink>
        </nav>
        <div className="side-section"><div className="side-section-head">研究空间</div>{TOOLS.map((item) => <NavLink key={item.to} to={item.to} aria-label={item.label} className={({ isActive }) => `tool-link${isActive ? ' active' : ''}`}><item.icon size={17} /><span>{item.label}</span>{item.to === '/figures' && <span className="nav-tag">PPT</span>}</NavLink>)}<NavLink to="/skills" aria-label="科研技能" className={({ isActive }) => `tool-link${isActive ? ' active' : ''}`}><Sparkles size={17} /><span>科研技能</span></NavLink></div>
        <div className="side-section recent-section"><div className="side-section-head"><span>最近会话</span><span className="side-count">{chats.length}</span></div><div className="side-task-list">{chats.slice(0, 7).map((chat) => <button key={chat.id} className={`side-task${location.pathname === '/agent' && chat.id === activeChatId ? ' active' : ''}`} onClick={() => { void selectChat(chat.id); navigate('/agent') }}><MessageSquare size={13} /><span className="side-task-title">{chat.title}</span></button>)}{chats.length === 0 && <div className="side-task-empty">暂无会话</div>}</div></div>
      </div>
      <div className="sidebar-bottom"><div className="side-utilities"><button onClick={() => { void api.projects.reveal(activeProjectId).catch((e) => toast.error(formatError(e))) }} title="打开项目文件夹" aria-label="打开项目文件夹"><FolderOpen size={16} /></button><NavLink to="/settings" aria-label="模型与设置"><Settings size={16} /><span>模型与设置</span></NavLink><span className="side-version">v{bootstrap?.version ?? '0.3.0'}</span></div><div className="side-status"><span className={`status-dot ${hasKey ? 'idle' : 'error'}`} /><span>{hasKey ? '模型已配置' : '等待连接模型'}</span></div></div>
    </aside>
    {createOpen && <Modal title="创建研究项目" subtitle="文献、实验、绘图与论文集中保存，各项目独立管理。" onClose={() => { if (!busy) setCreateOpen(false) }} footer={<><Button disabled={busy} onClick={() => setCreateOpen(false)}>取消</Button><Button variant="primary" disabled={busy || !name.trim()} onClick={() => void createProject()}>{busy ? '创建中…' : '创建项目'}</Button></>}><Field label="项目名称"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：长文档检索的鲁棒性研究" /></Field><Field label="研究目标" hint="可选，作为研究助手的项目上下文。"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="研究问题、数据来源、目标期刊…" /></Field></Modal>}
  </>
}
