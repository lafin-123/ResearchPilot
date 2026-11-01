import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AlertTriangle, FolderPlus } from 'lucide-react'
import { toast } from 'sonner'
import { api, formatError } from './lib/api'
import { useAppStore } from './store/app'
import { Sidebar } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { ApprovalModal } from './components/ApprovalModal'
import { CommandPalette } from './components/CommandPalette'
import { Button, Field, Input, Spinner, Textarea } from './components/Ui'
import { LibraryPage } from './pages/Library'
import { WritingPage } from './pages/Writing'
const EditorPage = lazy(() => import('./pages/Editor').then((module) => ({ default: module.EditorPage })))
import { ExperimentsPage } from './pages/Experiments'
import { FiguresPage } from './pages/Figures'
import { PipelinePage } from './pages/Pipeline'
import { AgentPage } from './pages/Agent'
import { SettingsPage } from './pages/Settings'
import { SkillsPage } from './pages/Skills'
import { DashboardPage } from './pages/Dashboard'
import { WritingQualityPage } from './pages/WritingQuality'
import { McpPage } from './pages/Mcp'
import { KnowledgePage } from './pages/Knowledge'
import { NotesPage } from './pages/Notes'
import { BackupsPage } from './pages/Backups'
import { SetupPage } from './pages/Setup'

function Welcome(): ReactNode {
  const refreshBootstrap = useAppStore((state) => state.refreshBootstrap)
  const openProject = useAppStore((state) => state.openProject)
  const settings = useAppStore((state) => state.settings)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  const create = async (): Promise<void> => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const project = await api.projects.create({ name: name.trim(), description: description.trim() })
      await refreshBootstrap()
      await openProject(project.id)
      toast.success('项目已创建')
      navigate('/')
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="welcome">
      <div className="welcome-form-wrap" style={{ minHeight: '100vh', width: '100%' }}>
        <div className="welcome-form">
          <div className="brand" style={{ padding: '0 0 28px' }}>
            <div className="brand-mark">R</div>
            <div>
              <div className="brand-name" style={{ fontSize: 15 }}>ResearchPilot</div>
              <div className="brand-sub">Research OS</div>
            </div>
          </div>
          <div className="home-kicker">GET STARTED</div>
          <h2 style={{ marginTop: 6 }}>创建研究项目</h2>
          <div className="sub">一个项目 = 一条从文献、实验到论文的完整研究链。</div>
          <Field label="项目名称">
            <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：长上下文检索中的鲁棒性" />
          </Field>
          <Field label="研究目标" hint="可选。智能体会把它作为项目的默认上下文。">
            <Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="研究问题、目标会议/期刊、当前阶段…" />
          </Field>
          <Button variant="primary" style={{ width: '100%', padding: '9px 16px' }} disabled={busy || !name.trim()} onClick={() => void create()}>
            {busy ? '正在创建…' : <><FolderPlus size={15} />创建项目</>}
          </Button>
          <div className="small muted" style={{ marginTop: 12 }}>
            工作区：{settings?.workspaceRoot ?? '—'}（可在设置中修改）
          </div>
          <div className="divider" />
          <div className="stack small muted">
            <div>1. 配置模型 API Key</div>
            <div>2. 让智能体先跑通实验</div>
            <div>3. 基于真实结果生成论文</div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function App(): ReactNode {
  const ready = useAppStore((state) => state.ready)
  const bootError = useAppStore((state) => state.bootError)
  const projects = useAppStore((state) => state.projects)
  const init = useAppStore((state) => state.init)
  const handleEvent = useAppStore((state) => state.handleEvent)
  const newChat = useAppStore((state) => state.newChat)
  const navigate = useNavigate()
  const location = useLocation()
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    const unsubscribe = api.onEvent(handleEvent)
    return unsubscribe
  }, [handleEvent])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
      if (event.key.toLowerCase() === 'n') {
        if (event.repeat || event.isComposing || ['running', 'starting'].includes(useAppStore.getState().agentState?.status ?? '')) return
        event.preventDefault()
        void newChat().then(() => navigate('/agent'))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [navigate, newChat])

  if (!ready) {
    return <div className="boot-screen"><Spinner label="正在启动 ResearchPilot…" /></div>
  }

  if (bootError) {
    return (
      <div className="boot-screen">
        <div className="card card-pad" style={{ maxWidth: 520 }}>
          <div className="row" style={{ color: 'var(--danger)' }}><AlertTriangle />启动失败</div>
          <p className="mt-2">{bootError}</p>
          <Button variant="primary" onClick={() => window.location.reload()}>重试</Button>
        </div>
      </div>
    )
  }

  // Retired account deep links remain safe even before the first research project is created.
  if (location.pathname === '/account') return <Navigate to="/settings" replace />

  if (projects.length === 0) return <Welcome />

  if (location.pathname.startsWith('/write/')) {
    return (
      <>
        <Routes>
          <Route path="/write/:documentId" element={<Suspense fallback={<Spinner label="正在加载论文编辑器…" />}><EditorPage /></Suspense>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <ApprovalModal />
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </>
    )
  }

  return (
    <>
      <div className="app-shell">
        <Sidebar />
        <div className="main-shell">
          <Topbar onCommandPalette={() => setPaletteOpen(true)} />
          <main className={location.pathname.startsWith('/write/') || location.pathname === '/agent' || location.pathname === '/notes' || location.pathname.startsWith('/notes/') ? 'content content-flush' : 'content'}>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/writing" element={<WritingPage />} />
              <Route path="/write/:documentId" element={<Suspense fallback={<Spinner label="正在加载论文编辑器…" />}><EditorPage /></Suspense>} />
              <Route path="/experiments" element={<ExperimentsPage />} />
              <Route path="/figures" element={<FiguresPage />} />
              <Route path="/pipeline" element={<PipelinePage />} />
              <Route path="/agent" element={<AgentPage />} />
              <Route path="/account" element={<Navigate to="/settings" replace />} />
              <Route path="/writing-quality" element={<WritingQualityPage />} />
              <Route path="/mcp" element={<McpPage />} />
              <Route path="/knowledge" element={<KnowledgePage />} />
              <Route path="/notes" element={<NotesPage />} />
              <Route path="/notes/:noteId" element={<NotesPage />} />
              <Route path="/skills" element={<SkillsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/backups" element={<BackupsPage />} />
              <Route path="/setup" element={<SetupPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </div>
      <ApprovalModal />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  )
}
