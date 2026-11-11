import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ChevronRight, KeyRound, Search, SquarePen } from 'lucide-react'
import { useAppStore } from '../store/app'
import { pageForPath, workspaceForPath } from '../lib/workspace-navigation'

export function Topbar({ onCommandPalette }: { onCommandPalette: () => void }): ReactNode {
  const location = useLocation()
  const navigate = useNavigate()
  const project = useAppStore(s => s.projects.find(p => p.id === s.activeProjectId))
  const chats = useAppStore(s => s.chats)
  const activeChatId = useAppStore(s => s.activeChatId)
  const agentState = useAppStore(s => s.agentState)
  const providers = useAppStore(s => s.providers)
  const newChat = useAppStore(s => s.newChat)
  const pendingSend = useAppStore(s => s.pendingSend)
  const modelChanging = useAppStore(s => s.modelChanging)
  const title = location.pathname === '/agent' ? chats.find(c => c.id === activeChatId)?.title ?? '助手' : workspaceForPath(location.pathname)?.label ?? pageForPath(location.pathname)?.label ?? '编辑器'
  const running = ['running', 'starting'].includes(agentState?.status ?? '')
  const hasKey = providers.some(provider => provider.hasApiKey)

  return <header className="topbar">
    <div className="crumbs"><span className="crumb-project">{project?.name ?? 'ResearchPilot'}</span><ChevronRight size={13} className="sep" /><span className="current truncate">{title}</span></div>
    <div className="topbar-spacer" />
    {!hasKey && <button className="topbar-icon danger" title="配置模型 API Key" aria-label="配置模型 API Key" onClick={() => navigate('/settings')}><KeyRound size={16} /></button>}
    <button className="topbar-command" onClick={onCommandPalette} aria-label="搜索功能与命令"><Search size={15} /><span>搜索</span><kbd>Ctrl K</kbd></button>
    <button className="topbar-icon" disabled={running || !!pendingSend || modelChanging} aria-label="新建研究任务" title="新建研究任务（Ctrl N）" onClick={() => { void newChat().then(created => { if (created) navigate('/agent') }) }}><SquarePen size={17} /></button>
    <div className="status-pill" title={agentState?.lastError || '研究助手状态'}><span className={`status-dot ${running ? 'running' : agentState?.status === 'error' ? 'error' : 'idle'}`} /><span>{running ? '研究进行中' : agentState?.status === 'error' ? '需要检查' : '就绪'}</span></div>
  </header>
}
