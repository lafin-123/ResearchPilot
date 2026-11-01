import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { BookOpen, FileCheck2, FlaskConical, Plug, RefreshCw, ShieldCheck, Unplug } from 'lucide-react'
import { toast } from 'sonner'
import type { McpServerId, McpServerState } from '@shared/mcp'
import { api, formatError } from '../lib/api'
import { useAppStore } from '../store/app'
import { Badge, Button, EmptyState, PageHeader } from '../components/Ui'
import './mcp.css'

const ICON = { evidence: BookOpen, writing: FileCheck2, artifacts: FlaskConical }
const STATUS = { disconnected: '未连接', connecting: '正在测试', connected: '诊断连接在线', error: '测试失败' }

export function McpPage(): ReactNode {
  const projectId = useAppStore(state => state.activeProjectId)
  const projects = useAppStore(state => state.bootstrap?.projects ?? [])
  const project = projects.find(item => item.id === projectId)
  const [servers, setServers] = useState<McpServerState[]>([])
  const [selected, setSelected] = useState<McpServerId>('evidence')
  const [busy, setBusy] = useState<McpServerId | ''>('')
  const [error, setError] = useState('')
  const scope = useRef(projectId)
  scope.current = projectId
  const load = useCallback(async () => {
    const requestedProject = projectId
    try {
      const result = await api.mcp.list(projectId || undefined)
      if (scope.current === requestedProject) { setServers(result); setError('') }
    } catch (cause) { if (scope.current === requestedProject) setError(formatError(cause)) }
  }, [projectId])
  useEffect(() => { setServers([]); setBusy(''); void load(); const timer = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 5000); return () => clearInterval(timer) }, [load])
  const server = servers.find(item => item.id === selected)

  async function configure(item: McpServerState): Promise<void> {
    setBusy(item.id)
    try { await api.mcp.configure({ serverId: item.id, enabled: !item.enabled }); await load(); toast.success(item.enabled ? '已停用：后续智能体不再加载此 MCP' : '已启用：下次智能体请求时加载') }
    catch (cause) { toast.error(formatError(cause)) }
    finally { setBusy('') }
  }
  async function test(item: McpServerState): Promise<void> {
    setBusy(item.id)
    const requestedProject = projectId
    setServers(current => current.map(row => row.id === item.id ? { ...row, status: 'connecting' } : row))
    try {
      const result = await api.mcp.test({ serverId: item.id, projectId })
      if (scope.current !== requestedProject) return
      setServers(current => current.map(row => row.id === item.id ? result : row))
      if (result.lastTestOk) toast.success('真实 stdio 工具调用测试通过')
      else toast.error(result.lastError || 'MCP 测试未通过')
    } catch (cause) { toast.error(formatError(cause)); await load() }
    finally { if (scope.current === requestedProject) setBusy('') }
  }
  async function disconnect(item: McpServerState): Promise<void> {
    setBusy(item.id)
    try { await api.mcp.disconnect({ serverId: item.id, projectId }); await load() }
    catch (cause) { toast.error(formatError(cause)) }
    finally { setBusy('') }
  }

  return <div className="page mcp-page">
    <PageHeader title="本地 MCP 工具" subtitle="让智能体通过明确的工具读取项目证据。只启动随应用打包的程序，不导入任意命令或远程服务。" actions={<Button onClick={() => void load()} disabled={Boolean(busy)}><RefreshCw size={14} />刷新状态</Button>} />
    <div className="mcp-scope"><ShieldCheck size={19} /><div><strong>{project ? `当前数据范围：${project.name}` : '请先创建或选择项目'}</strong><p>设置保存在当前本地工作区；每个连接仅授权一个项目。Crossref 检索仅在确认后发送检索词或 DOI；智能体调用结果可能进入你所选模型提供方的上下文。</p></div></div>
    {error && <div className="mcp-error" role="alert">{error}<Button size="sm" onClick={() => void load()}>重试加载</Button></div>}
    <div className="mcp-workbench">
      <nav className="mcp-server-list" aria-label="内置 MCP 服务">
        {servers.map(item => { const Icon = ICON[item.id]; return <button key={item.id} className={`mcp-server-row ${selected === item.id ? 'selected' : ''}`} aria-current={selected === item.id ? 'page' : undefined} onClick={() => setSelected(item.id)}>
          <Icon size={21} /><span><strong>{item.name}</strong><small>{item.enabled ? '智能体已启用' : '智能体未启用'}</small><small>{STATUS[item.status]}</small></span><span className={`mcp-state-dot ${item.status}`} aria-hidden="true" />
        </button> })}
        <p className="mcp-side-note">{servers.reduce((sum, item) => sum + item.tools.filter(tool => !tool.approvalRequired).length, 0)} 项只读工具和 {servers.reduce((sum, item) => sum + item.tools.filter(tool => tool.approvalRequired).length, 0)} 项逐次确认操作。启用不代表已连接；连接测试只调用只读工具。写入、外部检索和运行代码均须另外确认。</p>
      </nav>
      {server ? <section className="mcp-detail" aria-labelledby="mcp-detail-title">
        <div className="mcp-detail-head"><div><h2 id="mcp-detail-title">{server.name}</h2><p>{server.description}</p></div><Badge tone={server.status === 'connected' ? 'ok' : server.status === 'error' ? 'danger' : 'neutral'}>{STATUS[server.status]}</Badge></div>
        <div className="mcp-config-line"><label className="mcp-enable"><input type="checkbox" checked={server.enabled} disabled={Boolean(busy)} onChange={() => void configure(server)} /><span><strong>允许智能体使用此服务</strong><small>下次智能体请求重新加载。测试连接不改变此设置。</small></span></label>
          <div className="mcp-buttons"><Button variant="primary" disabled={!projectId || Boolean(busy)} onClick={() => void test(server)}><Plug size={14} />{busy === server.id && server.status === 'connecting' ? '正在调用工具…' : '连接并测试'}</Button>{(server.status === 'connected' || server.status === 'connecting') && <Button disabled={busy !== '' && server.status !== 'connecting'} onClick={() => void disconnect(server)}><Unplug size={14} />断开</Button>}</div>
        </div>
        <div className={`mcp-test-record ${server.lastTestOk === false ? 'failed' : ''}`} aria-live="polite">
          <strong>{server.status === 'connecting' ? '初始化 → 发现工具 → 项目范围工具调用' : server.lastTestAt ? `上次测试：${new Date(server.lastTestAt).toLocaleString()}` : '还没有测试记录'}</strong>
          <p>{server.testSummary || '测试会验证 MCP 协议握手、实际工具目录和一次只读调用。不需要模型密钥，也不会请求外部服务。'}</p>
          {server.lastError && <p className="mcp-error-text">{server.lastError}</p>}
        </div>
        <h3 className="mcp-tools-title">工具目录 <span>{server.discoveredTools.length ? '已从进程发现' : '内置定义，尚未验证连接'}</span></h3>
        <div className="mcp-tools">{server.tools.map(tool => <details key={tool.name} className="mcp-tool"><summary><span><strong>{tool.title}</strong><code>{tool.name}</code>{tool.approvalRequired && <Badge tone="gold">每次确认</Badge>}</span><Badge tone={server.discoveredTools.includes(tool.name) ? 'ok' : 'neutral'}>{server.discoveredTools.includes(tool.name) ? '已发现' : '待验证'}</Badge></summary><div><p>{tool.description}</p><code className="mcp-call-name">mcp__{server.namespace}__{tool.name}</code><pre aria-label={`${tool.title} 参数定义`}>{JSON.stringify(tool.inputSchema, null, 2)}</pre></div></details>)}</div>
        <details className="mcp-usage"><summary>使用方式与边界</summary><ol><li>选择项目，点击“连接并测试”，确认真实工具调用通过。</li><li>勾选“允许智能体使用此服务”，然后在智能体中要求使用上方工具名称。例如先列出文稿，再对返回的文稿 ID 进行表达检查。</li><li>只读工具仅访问当前连接项目。原生操作经逐次确认后支持 Crossref 检索与 DOI 登记、阶段产物写入、实验创建与运行、声明式图表和文稿写入；不依赖 Shell/SSH，不提供任意 URL 请求或通用文件写入。</li><li>实验代码由本地应用运行，不是操作系统沙箱；代码可能读写文件或联网。确认前核对代码及哈希，不要运行不可信实验。取消或超时会请求停止该次运行。</li><li>文本片段最多 40,000 字符，列表最多 50 条。文稿重合检查仅对你指定的本地来源，不是全网查重、AI 检测或学术结论核验。</li><li>关闭应用会撤销授权并关闭诊断进程。此页的在线状态只代表诊断连接；智能体使用独立进程。</li></ol></details>
      </section> : <EmptyState icon={<Plug />} title={error ? '暂时无法读取 MCP 设置' : '正在读取本地服务'} text="服务目录来自主进程，连接状态不会根据配置推测。" />}
    </div>
  </div>
}
