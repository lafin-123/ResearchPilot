import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, BookOpen, Check, ChevronRight, FileText, FlaskConical, Layers3, MessageSquare, Network, Play, Presentation, ShieldCheck, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import type { PipelineSnapshot, ProjectOverview } from '@shared/types'
import type { NoteSummary } from '@shared/notes'
import { api, formatError, relativeTime } from '../lib/api'
import { useAppStore } from '../store/app'
import { Button, StatusBadge } from '../components/Ui'
import { ReadinessRequestGuard } from '../lib/readiness'
import { ReadinessBanner, useDeliveryReadiness } from './Setup'

const STARTERS = [
  { title: '探索一个研究方向', detail: '检索文献，识别证据与研究空白', icon: BookOpen, prompt: '请对以下研究方向进行系统文献调研：\n\n请记录可核验的 DOI、检索式与筛选标准，给出证据矩阵和可验证的研究问题。不要编造文献。' },
  { title: '设计可复现实验', detail: '假设、对照、指标与执行计划', icon: FlaskConical, prompt: '请为以下问题设计最小可复现实验：\n\n先明确数据来源、基线、指标、随机种子与统计检验。运行前说明资源需求，保存实验计划。' },
  { title: '生成科研绘图', detail: '数据图与示意图，配套可编辑 PPT', icon: Network, prompt: '请根据我的真实研究资料创建科研图表或方法示意图。先确认数据来源和图的用途，使用结构化绘图 API，同时生成 SVG、JSON 源文件与原生可编辑 PPTX；不得把整张图片嵌入 PPT 冒充可编辑。' },
  { title: '核查论文与引文', detail: '逐条检查主张、数据与引用', icon: ShieldCheck, prompt: '请检查当前项目的论文和引用：建立主张—证据映射，核对 DOI 与元数据、统计表述和复现材料。输出按严重程度排序的检查报告；没有证据的部分明确标注待验证。' }
]

export function DashboardPage(): ReactNode {
  const navigate = useNavigate()
  const projectId = useAppStore((s) => s.activeProjectId)
  const project = useAppStore((s) => s.projects.find((p) => p.id === s.activeProjectId))
  const chats = useAppStore((s) => s.chats)
  const readiness = useDeliveryReadiness()
  const agentState = useAppStore((s) => s.agentState)
  const newChat = useAppStore((s) => s.newChat)
  const seedPrompt = useAppStore((s) => s.seedPrompt)
  const send = useAppStore((s) => s.send)
  const selectChat = useAppStore((s) => s.selectChat)
  const experimentVersion = useAppStore((s) => s.experimentVersion)
  const figureVersion = useAppStore((s) => s.figureVersion)
  const pipelineVersion = useAppStore((s) => s.pipelineVersion)
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [notesTotal, setNotesTotal] = useState<number | null>(null)
  const [notesError, setNotesError] = useState('')
  const [overview, setOverview] = useState<ProjectOverview | null>(null)
  const [pipeline, setPipeline] = useState<PipelineSnapshot | null>(null)
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const actionScope = useMemo(() => new ReadinessRequestGuard(), [projectId])
  useEffect(() => { setBusy(false); return () => actionScope.invalidate() }, [actionScope])
  const selection = readiness.selection
  const running = ['starting', 'running'].includes(agentState?.status ?? '') || pipeline?.run?.status === 'running'

  useEffect(() => {
    let active = true
    setOverview(null)
    setPipeline(null)
    setLoadError('')
    if (projectId) void Promise.all([api.projects.overview(projectId), api.pipeline.get(projectId)])
      .then(([next, flow]) => { if (active) { setOverview(next); setPipeline(flow) } })
      .catch((error) => { if (active) setLoadError(formatError(error)) })
    return () => { active = false }
  }, [projectId, experimentVersion, figureVersion, pipelineVersion, reload])

  useEffect(() => {
    let active = true
    setNotes([]); setNotesTotal(null); setNotesError('')
    if (projectId) void api.notes.list(projectId, { limit: 4 }).then((result) => {
      if (active) { setNotes(result.items); setNotesTotal(result.total) }
    }).catch((error) => { if (active) setNotesError(formatError(error)) })
    return () => { active = false }
  }, [projectId, reload])

  const start = async (full: boolean): Promise<void> => {
    if (!topic.trim() || busy || running || (full ? !readiness.canStartPipeline : !readiness.canDiscuss)) return
    const token = actionScope.begin()
    setBusy(true)
    try {
      if (full) {
        await api.pipeline.start({ projectId, topic: topic.trim(), formats: ['docx'], autoRun: true, providerId: selection.providerId, modelId: selection.modelId })
        if (!actionScope.isCurrent(token)) return
        toast.success('研究流程已启动；需要审批的操作仍会暂停等待确认。')
        navigate('/pipeline')
      } else {
        if (!await newChat() || !actionScope.isCurrent(token)) return
        if (await send(topic.trim()) && actionScope.isCurrent(token)) navigate('/agent')
      }
    } catch (error) {
      if (actionScope.isCurrent(token)) { toast.error(formatError(error)); void readiness.refresh() }
    } finally {
      if (actionScope.isCurrent(token)) setBusy(false)
    }
  }

  const prepare = async (prompt: string): Promise<void> => {
    if (running || busy) return
    const token = actionScope.begin()
    setBusy(true)
    try {
      if (!await newChat() || !actionScope.isCurrent(token)) return
      seedPrompt(prompt)
      navigate('/agent')
    } finally { if (actionScope.isCurrent(token)) setBusy(false) }
  }

  const currentOverview = overview?.project.id === projectId ? overview : null
  const currentRun = pipeline?.run?.projectId === projectId ? pipeline.run : null
  const recentDocuments = [...(currentOverview?.documents ?? [])]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 4)
  const recentChats = chats.filter((chat) => chat.projectId === projectId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 3)
  const assets = [
    { label: '研究笔记', count: notesTotal, to: '/notes', icon: FileText },
    { label: '文献资料', count: currentOverview?.stats.references, to: '/library', icon: BookOpen },
    { label: '实验记录', count: currentOverview?.stats.experiments, to: '/experiments', icon: FlaskConical },
    { label: '科研图表', count: currentOverview?.stats.figures, to: '/figures', icon: Presentation },
    { label: '论文文稿', count: currentOverview?.stats.documents, to: '/writing', icon: FileText }
  ]

  return (
    <div className="research-home">
      <section className="research-launch" aria-labelledby="research-title">
        <div className="launch-heading">
          <h1 id="research-title">开始一项新研究</h1>
          <p>描述你的问题，或先与研究助手讨论。</p>
        </div>
        <div className="research-input">
          <div className="home-heading"><span className="project-context"><Layers3 size={14} />{project?.name ?? '研究工作台'}</span><span className="local-note"><ShieldCheck size={13} />本地项目</span></div>
          <label className="sr-only" htmlFor="research-topic">你的研究问题</label>
          <textarea id="research-topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="描述你的研究问题、数据和目标。例如：比较稀疏检索与稠密检索在长文档问答中的表现…" maxLength={12000} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void start(true) } }} />
          <div className="research-input-actions"><span><ShieldCheck size={13} />实验与远程操作需审批</span><div className="row"><Button disabled={!topic.trim() || !readiness.canDiscuss || busy || running} onClick={() => void start(false)}>先与助手讨论</Button><Button variant="primary" disabled={!topic.trim() || !readiness.canStartPipeline || busy || running} onClick={() => void start(true)}><Play size={14} />{busy ? '正在启动…' : running ? '任务执行中' : '一键开始研究'}</Button></div></div>
        </div>
        <div className="launch-footnote"><span>{readiness.canStartPipeline ? '资料不足时会停下来，不编造结果。' : <Link to="/setup">完整流程暂不可启动：查看准备条件</Link>}</span><span>Ctrl + Enter 开始</span></div>
      </section>

      <ReadinessBanner readiness={readiness} />
      {loadError && <div className="alert alert-danger" role="alert">工作台数据加载失败：{loadError}<Button size="sm" onClick={() => setReload((n) => n + 1)}>重新加载</Button></div>}

      <section className="starter-section" aria-labelledby="starter-title">
        <div className="section-heading"><h2 id="starter-title">也可以从这些任务开始</h2><button className="text-link" onClick={() => navigate('/skills')}>全部科研技能<ChevronRight size={13} /></button></div>
        <div className="research-starters">{STARTERS.map((item) => <button key={item.title} className="research-starter" onClick={() => void prepare(item.prompt)} disabled={busy || running}><item.icon size={17} strokeWidth={1.6} /><span className="starter-copy"><strong>{item.title}</strong><span>{item.detail}</span></span></button>)}</div>
      </section>

      <div className="research-bottom">
        <div className="workspace-recent">
          <section className="research-activity" aria-labelledby="recent-notes-title">
            <div className="section-heading"><h2 id="recent-notes-title">收藏与最近笔记</h2><Link className="text-link" to="/notes">全部笔记<ChevronRight size={13} /></Link></div>
            {notes.filter((note) => note.projectId === projectId).map((note) => <Link className="activity-row workspace-document" key={note.id} to={`/notes/${encodeURIComponent(note.id)}`}><span className="activity-icon"><FileText size={17} /></span><span className="activity-main"><strong>{note.title}</strong><span>{note.pinned ? '已收藏 · ' : ''}更新于 {relativeTime(note.updatedAt)}</span></span><ChevronRight size={14} /></Link>)}
            {notesError ? <p role="alert" className="small muted">笔记加载失败：{notesError}</p> : !notes.length ? <p className="small muted">记录研究问题、阅读摘记和实验过程，并把相关笔记连接起来。</p> : null}
          </section>
          <section className="research-activity" aria-labelledby="recent-documents-title">
            <div className="section-heading"><h2 id="recent-documents-title">最近编辑的文稿</h2><Link className="text-link" to="/writing">全部文稿<ChevronRight size={13} /></Link></div>
            {recentDocuments.map((document) => (
              <Link className="activity-row workspace-document" key={document.id} to={`/write/${encodeURIComponent(document.id)}`}>
                <span className="activity-icon"><FileText size={17} /></span>
                <span className="activity-main"><strong title={document.title}>{document.title}</strong><span>{document.format === 'docx' ? 'DOCX' : 'LaTeX'} · 更新于 {relativeTime(document.updatedAt)}</span></span>
                <ChevronRight size={14} />
              </Link>
            ))}
            {!recentDocuments.length && (
              <div className="activity-empty"><FileText size={18} /><div>
                <strong>{loadError ? '暂时无法读取文稿' : !currentOverview && projectId ? '正在加载文稿…' : '还没有文稿'}</strong>
                <p>{loadError ? '请重新加载工作台数据，或前往论文工作台。' : !currentOverview && projectId ? '正在读取当前项目的文稿列表。' : '在论文工作台创建或导入文稿，之后可从这里继续编辑。'}</p>
              </div></div>
            )}
          </section>
          <section className="research-activity" aria-labelledby="recent-research-title">
            <div className="section-heading"><h2 id="recent-research-title">最近研究</h2><Link className="text-link" to="/pipeline">查看研究流程<ArrowRight size={13} /></Link></div>
            {currentRun ? <Link className="activity-row" to="/pipeline"><span className="activity-icon"><Workflow size={17} /></span><span className="activity-main"><strong>{currentRun.topic}</strong><span>{pipeline?.stages.find((s) => s.id === currentRun.currentStage)?.label ?? '研究流程'} · {relativeTime(currentRun.updatedAt)}</span></span><StatusBadge status={currentRun.status} /></Link> : null}
            {recentChats.map((chat) => <button className="activity-row" key={chat.id} onClick={() => { void selectChat(chat.id).then(() => navigate('/agent')) }}><span className="activity-icon"><MessageSquare size={17} /></span><span className="activity-main"><strong>{chat.title}</strong><span>研究会话 · {relativeTime(chat.updatedAt)}</span></span><ChevronRight size={14} /></button>)}
            {!currentRun && !recentChats.length && <div className="activity-empty"><MessageSquare size={18} /><div><strong>还没有研究记录</strong><p>开始后，可在这里继续之前的会话与研究流程。</p></div></div>}
          </section>
        </div>
        <aside className="project-resources" aria-labelledby="project-pages-title">
          <div className="section-heading"><h2 id="project-pages-title">项目页面</h2></div>
          <nav className="workspace-page-links" aria-label="当前项目页面">
            {assets.map((asset) => <Link key={asset.to} to={asset.to}><asset.icon size={16} /><span>{asset.label}</span><strong aria-label={`${asset.count ?? '—'} 项`}>{asset.count ?? '—'}</strong><ChevronRight size={13} /></Link>)}
          </nav>
          <p className="workspace-local-copy">本地工作区，无需账号。模型请求会发送至你配置的服务。</p>
          <div className="environment-note"><Check size={13} /><span>{readiness.pythonReady ? '指定的 Python 可运行；实验依赖仍需核对' : '本地资料阅读与笔记不依赖 Python'}</span></div>
        </aside>
      </div>
    </div>
  )
}
