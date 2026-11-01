import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, RefreshCw, Settings2, X } from 'lucide-react'
import { Button, PageHeader } from '../components/Ui'
import { api, formatError } from '../lib/api'
import { assessReadiness, loadReadiness, loadingReadiness, ReadinessRequestGuard, REQUIRED_MCP, type ReadinessData } from '../lib/readiness'
import { useAppStore } from '../store/app'
import './setup.css'

/** Shared read-only check used by setup, home and pipeline. No provider calls. */
export function useDeliveryReadiness() {
  const projectId = useAppStore(state => state.activeProjectId)
  const selection = useAppStore(state => state.modelSelection)
  const bootstrap = useAppStore(state => state.bootstrap)
  const providers = useAppStore(state => state.providers)
  // A new scope makes previous data unusable immediately, before the effect runs.
  const guard = useMemo(() => new ReadinessRequestGuard(), [projectId, bootstrap, providers])
  const [loaded, setLoaded] = useState<{ guard: ReadinessRequestGuard; data: ReadinessData } | null>(null)
  const refresh = useCallback(() => loadReadiness(guard, () => api.bootstrap(), () => api.mcp.list(projectId || undefined), data => setLoaded({ guard, data }), formatError), [guard, projectId])
  useEffect(() => {
    void refresh()
    const onFocus = (): void => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { guard.invalidate(); window.removeEventListener('focus', onFocus) }
  }, [guard, refresh])
  const data = loaded?.guard === guard ? loaded.data : loadingReadiness()
  return { ...assessReadiness(projectId, data, selection), data, refresh }
}
export type ReadinessView = ReturnType<typeof useDeliveryReadiness>

export function PipelinePreflight({ readiness }: { readiness: ReadinessView }): ReactNode {
  return <section className="readiness-preflight" aria-label="流水线启动检查" data-testid="pipeline-preflight" aria-busy={readiness.loading}>
    <div className="row-between"><strong>启动前检查</strong><Button size="sm" disabled={readiness.loading} onClick={() => void readiness.refresh()}><RefreshCw size={13} />重新检查</Button></div>
    {readiness.issues.length ? <ul>{readiness.issues.map(issue => <li key={issue.id} data-testid={`readiness-${issue.id}`}><span>{issue.text}</span><Link to={issue.to}>{issue.action}</Link></li>)}</ul> : <p>必要配置已齐备。启动时仍由后端检查；这不保证模型推理或实验成功。</p>}
    <p className="readiness-fineprint">启动将调用所选模型，可能产生费用。模型真实调用测试请在<Link to="/settings">设置</Link>中主动执行；此处不自动测试。</p>
    <div className="readiness-links"><Link to="/library">先整理文献</Link><Link to="/notes">先写研究笔记</Link></div>
  </section>
}

// Renderer-memory only; scoped to workspace + project. No localStorage or persisted dismissal.
const dismissedBanners = new Set<string>()
export function ReadinessBanner({ readiness }: { readiness: ReadinessView }): ReactNode {
  const projectId = useAppStore(state => state.activeProjectId)
  const workspace = useAppStore(state => state.settings?.workspaceRoot ?? '')
  const key = JSON.stringify([workspace, projectId])
  const [, rerender] = useState(0)
  if (dismissedBanners.has(key)) return null
  return <aside className="readiness-banner" data-testid="readiness-banner" aria-label="首次使用准备">
    <Settings2 size={17} aria-hidden="true" />
    <div><strong>{readiness.loading ? '正在检查研究流程准备情况' : readiness.failed ? '准备情况暂时无法确认' : readiness.canStartPipeline ? '研究流程配置已齐备' : '开始前，检查研究流程所需配置'}</strong><p>{readiness.failed ? '读取失败不代表服务未配置，可重新检查。本地阅读与笔记不受模型配置限制。' : '配置模型、启用 MCP、指定 Python；也可以先整理文献和笔记。配置齐备不等于模型已通过真实推理测试。'}</p></div>
    <div className="readiness-banner-actions"><Link className="btn btn-sm" to="/setup">查看准备清单</Link>{readiness.failed && <Button size="sm" onClick={() => void readiness.refresh()}>重试</Button>}<Button variant="ghost" size="sm" aria-label="本次会话不再显示准备提示" title="本次会话不再显示" onClick={() => { dismissedBanners.add(key); rerender(value => value + 1) }}><X size={14} /></Button></div>
  </aside>
}

export function SetupPage(): ReactNode {
  const readiness = useDeliveryReadiness()
  const project = useAppStore(state => state.projects.find(item => item.id === state.activeProjectId))
  const [retrying, setRetrying] = useState('')
  const [retryError, setRetryError] = useState('')
  const retryGuard = useMemo(() => new ReadinessRequestGuard(), [project?.id])
  useEffect(() => { setRetrying(''); setRetryError(''); return () => retryGuard.invalidate() }, [retryGuard])
  const retryProject = async (id: string): Promise<void> => {
    const token = retryGuard.begin()
    setRetrying(id); setRetryError('')
    try {
      const result = await api.projects.retry(id)
      if (!retryGuard.isCurrent(token)) return
      if (!result.available) setRetryError(`${result.error?.code}: ${result.error?.message}`)
      await readiness.refresh()
    } catch (error) { if (retryGuard.isCurrent(token)) setRetryError(formatError(error)) }
    finally { if (retryGuard.isCurrent(token)) setRetrying('') }
  }
  const bootstrap = readiness.data.bootstrap.status === 'ready' ? readiness.data.bootstrap.data : null
  const servers = readiness.data.mcp.status === 'ready' ? readiness.data.mcp.data : null
  return <div className="page setup-page" data-testid="setup-page">
    <PageHeader title="准备你的研究工作区" subtitle="无需注册账号。先使用本地资料与笔记，按需配置智能体和完整研究流程。" actions={<Button disabled={readiness.loading} onClick={() => void readiness.refresh()}><RefreshCw size={14} />{readiness.loading ? '正在检查…' : '重新检查'}</Button>} />
    <p className="setup-context">当前项目：{project?.name ?? '尚未选择'}。这里只读取本地设置，不发送模型请求，不自动安装软件。</p>
    {readiness.failed && <div className="alert alert-danger" role="alert">准备情况读取失败，不能确认完整流程可启动。下方保留具体原因；请重新检查。</div>}
    {retryError && <div className="alert alert-danger" role="alert">{retryError}</div>}
    <section aria-label="项目目录诊断" data-testid="project-health-list">
      <h2>项目目录状态</h2>
      <p>目录缺失或无权访问不会阻止其他项目启动。数据库中的文献与笔记仍保留；文件写入、实验和智能体执行会被拒绝。不会自动重建丢失目录或改绑路径。</p>
      {bootstrap?.projectHealth?.map(health => <div className="card card-pad mb-2" key={health.projectId} data-testid={`project-health-${health.projectId}`}>
        <div className="row-between"><strong>{health.projectName} · {health.available ? '可用' : '不可用'}</strong><Button size="sm" disabled={!!retrying} onClick={() => void retryProject(health.projectId)}>{retrying === health.projectId ? '正在重试…' : '重试初始化'}</Button></div>
        <p className="backup-path">{health.rootPath}</p>
        {health.error && <p role="status">{health.error.code}：{health.error.message}</p>}
      </div>)}
    </section>
    <ol className="setup-checklist">
      <li><div className="setup-step-heading"><h2>配置所选模型</h2><span>{readiness.modelConfigured ? '已配置 · 推理未核验' : bootstrap ? '需要配置' : '尚未确认'}</span></div>
        <p>{readiness.provider?.name ?? '未选择有效提供方'} / {readiness.selection.modelId || '未选择模型'}。按当前选择检查；仅在没有选择时使用默认模型，不会借用其他提供方的密钥。</p>
        <p>保存 API Key 和模型列表不代表模型在线。真实测试需你在设置中点击“真实调用测试”，可能使用少量额度；测试结果以设置页为准。更换当前模型请前往智能体页。</p>
        <div className="readiness-links"><Link className="btn btn-sm" to="/settings">配置模型 / 真实调用测试</Link><Link to="/agent">更换当前模型</Link></div>
      </li>
      <li><div className="setup-step-heading"><h2>启用内置 MCP 工具</h2><span>{readiness.mcpEnabled ? '三个服务已启用' : servers ? '需要启用' : '尚未确认'}</span></div>
        <ul className="setup-mcp-list">{REQUIRED_MCP.map(required => { const server = servers?.find(item => item.id === required.id); return <li key={required.id}><strong>{required.name}</strong><span>{server ? server.enabled ? '已启用' : '未启用' : '尚未读取'}</span></li> })}</ul>
        <p>启用只表示允许智能体使用；不等于连接成功。MCP 页面可主动运行当前项目的只读连接测试，不调用付费模型。</p>
        <Link className="btn btn-sm" to="/mcp">配置 / 测试 MCP</Link>
      </li>
      <li><div className="setup-step-heading"><h2>为完整流程指定 Python</h2><span>{readiness.pythonReady ? '指定解释器可运行' : bootstrap ? '需要配置' : '尚未确认'}</span></div>
        <p>{bootstrap ? readiness.pythonConfigured ? `已保存路径：${bootstrap.settings.pythonPath}` : '尚未保存明确的本地 Python 解释器路径。' : '正在读取本地环境状态。'}</p>
        <p>{bootstrap ? `Python 检测：${bootstrap.pythonAvailable ? '可运行' : '不可用'}；uv：${bootstrap.uvAvailable ? '已检测到' : '未检测到'}。` : ''}完整流程要求显式配置可用的 Python 3.10+。uv 或自动检测不能代替该路径；解释器可运行也不代表实验依赖包已齐备。</p>
        <Link className="btn btn-sm" to="/settings">设置 Python</Link>
      </li>
    </ol>
    <section className="setup-local" aria-labelledby="setup-local-title"><CheckCircle2 size={18} aria-hidden="true" /><div><h2 id="setup-local-title">不必等配置完成</h2><p>本地文献整理、已有资料阅读和研究笔记不需要模型密钥、MCP 或 Python。在线检索需要网络，AI 阅读需要你配置的模型。</p><div className="readiness-links"><Link className="btn btn-sm" to="/library">打开文献库</Link><Link className="btn btn-sm" to="/notes">打开研究笔记</Link></div></div></section>
    <PipelinePreflight readiness={readiness} />
    <div className="readiness-links setup-footer"><Link to="/">返回研究工作台</Link><Link to="/pipeline">查看研究流程</Link></div>
  </div>
}
