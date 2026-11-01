import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ChevronRight, KeyRound, Search, SquarePen } from 'lucide-react'
import { useAppStore } from '../store/app'

const TITLES: Record<string, string> = { '/': '研究工作台', '/library': '文献资料', '/writing': '论文写作', '/experiments': '实验与分析', '/figures': '科研绘图', '/pipeline': '一键研究流程', '/skills': '科研技能', '/settings': '模型与设置', '/knowledge': '项目知识库与阅读记录', '/writing-quality': '写作质量与规范改写', '/backups': '备份与恢复', '/setup': '使用准备检查', '/mcp': 'MCP 工具连接' }

export function Topbar({ onCommandPalette }: { onCommandPalette: () => void }): ReactNode {
  const location = useLocation()
  const navigate = useNavigate()
  const project = useAppStore((s) => s.projects.find((p) => p.id === s.activeProjectId))
  const chats = useAppStore((s) => s.chats)
  const activeChatId = useAppStore((s) => s.activeChatId)
  const agentState = useAppStore((s) => s.agentState)
  const providers = useAppStore((s) => s.providers)
  const selection = useAppStore((s) => s.modelSelection)
  const setChatModel = useAppStore((s) => s.setChatModel)
  const newChat = useAppStore((s) => s.newChat)
  const title = location.pathname === '/agent' ? chats.find((c) => c.id === activeChatId)?.title ?? '研究助手' : location.pathname.startsWith('/notes') ? '研究笔记' : TITLES[location.pathname] ?? '编辑器'
  const running = ['running', 'starting'].includes(agentState?.status ?? '')
  const hasKey = providers.find((p) => p.id === selection.providerId)?.hasApiKey
  const value = selection.providerId && selection.modelId ? `${selection.providerId}::${selection.modelId}` : ''
  const selectionExists = providers.some((p) => p.models.some((m) => `${p.id}::${m.id}` === value))

  return <header className="topbar"><div className="crumbs"><span className="crumb-project">{project?.name ?? 'ResearchPilot'}</span><ChevronRight size={13} className="sep" /><span className="current truncate">{title}</span></div><div className="topbar-spacer" /><select className="topbar-model" value={value} disabled={running} onChange={(e) => { const [providerId, modelId] = e.target.value.split('::'); if (providerId && modelId) void setChatModel(providerId, modelId) }} aria-label="当前研究模型">{!selectionExists && <option value={value}>选择研究模型</option>}{providers.map((p) => <optgroup key={p.id} label={p.name}>{p.models.map((m) => <option key={`${p.id}::${m.id}`} value={`${p.id}::${m.id}`} disabled={!p.hasApiKey}>{m.label || m.id}{!p.hasApiKey ? '（未配置）' : ''}</option>)}</optgroup>)}</select>{!hasKey && <button className="topbar-icon danger" title="配置模型 API Key" aria-label="配置模型 API Key" onClick={() => navigate('/settings')}><KeyRound size={16} /></button>}<button className="topbar-command" onClick={onCommandPalette} aria-label="搜索功能与命令"><Search size={15} /><span>搜索</span><kbd>Ctrl K</kbd></button><button className="topbar-icon" disabled={running} aria-label="新建研究任务" title="新建研究任务（Ctrl N）" onClick={() => { void newChat().then(() => navigate('/agent')) }}><SquarePen size={17} /></button><div className="status-pill" title={agentState?.lastError || '研究助手状态'}><span className={`status-dot ${running ? 'running' : agentState?.status === 'error' ? 'error' : 'idle'}`} /><span>{running ? '研究进行中' : agentState?.status === 'error' ? '需要检查' : '就绪'}</span></div></header>
}
