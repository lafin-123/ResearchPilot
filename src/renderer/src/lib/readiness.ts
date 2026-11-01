import type { BootstrapData, Provider } from '../../../shared/types'
import { AGENT_ROLES, resolveAgentRole } from '../../../shared/agent-roles'
import type { McpServerId, McpServerState } from '../../../shared/mcp'

export interface ReadinessSelection { providerId: string; modelId: string }
export interface ReadinessIssue { id: string; text: string; to: string; action: string }
export type ReadinessResource<T> = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; data: T }
export interface ReadinessData {
  bootstrap: ReadinessResource<BootstrapData>
  mcp: ReadinessResource<McpServerState[]>
}
export const REQUIRED_MCP: ReadonlyArray<{ id: McpServerId; name: string }> = [
  { id: 'evidence', name: '文献与证据' },
  { id: 'writing', name: '文稿与表达' },
  { id: 'artifacts', name: '实验与图表' }
]
export const loadingReadiness = (): ReadinessData => ({ bootstrap: { status: 'loading' }, mcp: { status: 'loading' } })

/** A selected provider never borrows another provider's key or default model. */
export function resolveReadinessSelection(bootstrap: BootstrapData | null, selection: ReadinessSelection): ReadinessSelection {
  if (selection.providerId || selection.modelId) return selection
  return { providerId: bootstrap?.settings.defaultProviderId ?? '', modelId: bootstrap?.settings.defaultModelId ?? '' }
}

export function modelReadiness(providers: Provider[], selection: ReadinessSelection): { configured: boolean; provider?: Provider; issues: ReadinessIssue[] } {
  const provider = providers.find(item => item.id === selection.providerId)
  const issues: ReadinessIssue[] = []
  const issue = (id: string, text: string): void => { issues.push({ id, text, to: '/settings', action: '配置模型' }) }
  if (!provider) issue('provider', '未选择有效的模型提供方。请配置提供方，并在智能体页选择模型。')
  else {
    if (!provider.hasApiKey) issue('api-key', `所选提供方「${provider.name}」尚未配置 API Key。`)
    if (!selection.modelId || !provider.models.some(model => model.id === selection.modelId)) issue('model', `请选择属于「${provider.name}」的有效模型；获取模型列表不代表推理成功。`)
  }
  return { configured: issues.length === 0, provider, issues }
}

export function assessReadiness(projectId: string, data: ReadinessData, selected: ReadinessSelection) {
  const bootstrap = data.bootstrap.status === 'ready' ? data.bootstrap.data : null
  const selection = resolveReadinessSelection(bootstrap, selected)
  const model = modelReadiness(bootstrap?.providers ?? [], selection)
  const issues: ReadinessIssue[] = []
  const projectHealth = bootstrap?.projectHealth?.find(item => item.projectId === projectId)
  const projectAvailable = projectHealth?.available !== false
  if (!projectAvailable) issues.push({ id: 'project-unavailable', text: `项目目录不可用（${projectHealth?.error?.code ?? 'UNKNOWN'}）：${projectHealth?.error?.message ?? ''}。请恢复原目录或检查权限后明确重试。`, to: '/setup', action: '检查项目目录' })
  if (!projectId) issues.push({ id: 'project', text: '请先选择一个本地项目。', to: '/projects', action: '选择项目' })
  if (data.bootstrap.status !== 'ready') {
    issues.push({ id: 'bootstrap', text: data.bootstrap.status === 'error' ? `环境状态读取失败：${data.bootstrap.error}` : '正在读取模型与 Python 环境状态。', to: '/setup', action: '查看准备情况' })
  } else {
    const routes = bootstrap!.settings.agentRoleModels
    const allRolesConfigured = AGENT_ROLES.every(role => routes?.[role.id])
    if (!allRolesConfigured) issues.push(...model.issues)
    for (const role of AGENT_ROLES) if (routes?.[role.id]) {
      try { resolveAgentRole(role.id, routes, bootstrap!.providers) }
      catch (error) { issues.push({ id: `role-${role.id}`, text: String(error instanceof Error ? error.message : error), to: '/settings', action: '配置角色模型' }) }
    }
    if (!bootstrap!.settings.pythonPath.trim()) issues.push({ id: 'python-path', text: '完整流程需要在设置中明确指定本地 Python 3.10+；自动检测到 Python 或 uv 不能替代此设置。', to: '/settings', action: '设置 Python' })
    else if (!bootstrap!.pythonAvailable) issues.push({ id: 'python-unavailable', text: '已配置的 Python 无法运行。请检查解释器路径及版本，再重新检查。', to: '/settings', action: '检查 Python' })
  }
  const servers = data.mcp.status === 'ready' ? data.mcp.data : []
  if (data.mcp.status !== 'ready') issues.push({ id: 'mcp-load', text: data.mcp.status === 'error' ? `MCP 状态读取失败：${data.mcp.error}` : '正在读取当前项目的 MCP 设置。', to: '/mcp', action: '查看 MCP' })
  else for (const required of REQUIRED_MCP) {
    const server = servers.find(item => item.id === required.id)
    if (!server?.enabled) issues.push({ id: `mcp-${required.id}`, text: server ? `尚未启用「${required.name}」MCP。` : `未读取到「${required.name}」MCP 服务。`, to: '/mcp', action: '启用 MCP' })
  }
  return {
    selection, provider: model.provider,
    modelConfigured: !!bootstrap && model.configured,
    // Neither a key, model catalog nor MCP diagnostic proves model inference.
    inferenceVerified: false as const,
    pythonConfigured: !!bootstrap?.settings.pythonPath.trim(),
    pythonReady: !!bootstrap?.settings.pythonPath.trim() && !!bootstrap.pythonAvailable,
    uvAvailable: bootstrap?.uvAvailable ?? null,
    mcpEnabled: data.mcp.status === 'ready' && REQUIRED_MCP.every(required => servers.some(server => server.id === required.id && server.enabled)),
    localFeaturesAvailable: !!projectId,
    canDiscuss: !!projectId && projectAvailable && !!bootstrap && model.configured,
    canStartPipeline: issues.length === 0,
    issues,
    loading: data.bootstrap.status === 'loading' || data.mcp.status === 'loading',
    failed: data.bootstrap.status === 'error' || data.mcp.status === 'error'
  }
}
export type DeliveryReadiness = ReturnType<typeof assessReadiness>

/** Latest request wins, including A -> B -> A navigation and unmount. No I/O here. */
export class ReadinessRequestGuard {
  private generation = 0
  begin(): number { return ++this.generation }
  invalidate(): void { this.generation += 1 }
  isCurrent(token: number): boolean { return token === this.generation }
}

/** Reads only local configuration; never calls discovery, MCP test or model inference. */
export async function loadReadiness(
  guard: ReadinessRequestGuard,
  readBootstrap: () => Promise<BootstrapData>,
  readMcp: () => Promise<McpServerState[]>,
  publish: (data: ReadinessData) => void,
  errorText: (error: unknown) => string = String
): Promise<void> {
  const token = guard.begin()
  publish(loadingReadiness())
  const resource = async <T,>(read: () => Promise<T>): Promise<ReadinessResource<T>> => {
    try { return { status: 'ready', data: await read() } }
    catch (error) { return { status: 'error', error: errorText(error) } }
  }
  const [bootstrap, mcp] = await Promise.all([resource(readBootstrap), resource(readMcp)])
  if (guard.isCurrent(token)) publish({ bootstrap, mcp })
}
