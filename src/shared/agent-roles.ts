import type { Provider } from './types'
export const AGENT_ROLES = [
  { id: 'writing', label: '写作 Agent', description: '文献综合、论文写作、期刊修订与审阅。' },
  { id: 'figures', label: '绘图 Agent', description: '图形设计、图注和可编辑科研图表。' },
  { id: 'engineering', label: '工程与实验 Agent', description: '研究设计、代码实现、实验执行与分析。' }
] as const
export type AgentRole = typeof AGENT_ROLES[number]['id']
export interface RoleModel { providerId: string; modelId: string }
export type AgentRoleModels = Partial<Record<AgentRole, RoleModel>>
export function normalizeAgentRoles(value: unknown): AgentRoleModels {
  const result: AgentRoleModels = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const { id } of AGENT_ROLES) {
    const route = (value as Record<string, unknown>)[id]
    if (!route || typeof route !== 'object' || Array.isArray(route)) continue
    const { providerId, modelId } = route as Record<string, unknown>
    if (typeof providerId === 'string' && providerId.trim() && providerId.length <= 256 && typeof modelId === 'string' && modelId.trim() && modelId.length <= 256) result[id] = { providerId, modelId }
  }
  return result
}
export function resolveAgentRole(role: AgentRole, routes: AgentRoleModels | undefined, providers: Provider[]): RoleModel | null {
  const route = routes?.[role]
  if (!route) return null
  const provider = providers.find(item => item.id === route.providerId)
  if (!provider?.hasApiKey || !provider.models.some(model => model.id === route.modelId)) throw new Error(`${AGENT_ROLES.find(item => item.id === role)!.label}的提供方、密钥或模型不可用，请重新配置；不会静默改用其他模型。`)
  return route
}
export function roleForStage(stage: string): AgentRole {
  return stage === 'figures' ? 'figures' : ['hypothesis', 'design', 'execute', 'execution', 'analysis'].includes(stage) ? 'engineering' : 'writing'
}
export function roleForCategory(category: string | undefined): AgentRole {
  return category === 'figures' ? 'figures' : ['design', 'statistics', 'data', 'computing'].includes(category ?? '') ? 'engineering' : 'writing'
}
