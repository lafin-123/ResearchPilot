import { AGENT_ROLES, type AgentRole } from '../../../shared/agent-roles'
import type { AppSettings, Provider } from '../../../shared/types'
import type { ResearchOperation } from '../../../shared/research-workflows'

type ModelSettings = Pick<AppSettings, 'defaultProviderId' | 'defaultModelId' | 'agentRoleModels'>
export interface EffectiveModel {
  available: boolean
  providerId: string
  providerName: string
  modelId: string
  source: AgentRole | 'default' | 'unloaded'
  reason: string
}

// Mirror native routing, not the current chat selection. A configured but invalid
// role is terminal: only an absent role can fall through to writing/default.
function resolveModel(settings: ModelSettings | null, providers: Provider[], roles: AgentRole[]): EffectiveModel {
  if (!settings) return { available: false, providerId: '', providerName: '', modelId: '', source: 'unloaded', reason: '设置尚未载入' }
  const source = roles.find(role => settings.agentRoleModels?.[role]) ?? 'default'
  const route = source === 'default'
    ? { providerId: settings.defaultProviderId, modelId: settings.defaultModelId }
    : settings.agentRoleModels![source]!
  const provider = providers.find(item => item.id === route.providerId)
  const reason = !route.providerId || !route.modelId ? '未配置提供方或模型'
    : !provider ? '提供方不存在'
    : !provider.hasApiKey ? '未配置 API Key'
    : !provider.models.some(model => model.id === route.modelId) ? '模型 ID 不在提供方配置中' : ''
  return { ...route, source, providerName: provider?.name ?? '', available: !reason, reason }
}

export function effectiveResearchModel(settings: ModelSettings | null, providers: Provider[], operation: ResearchOperation): EffectiveModel {
  const role = operation === 'method' ? 'engineering' : operation === 'review' ? 'reviewer'
    : operation === 'supervisor' || operation === 'perspectives' ? 'coordinator' : 'writing'
  return resolveModel(settings, providers, role === 'writing' ? ['writing'] : [role, 'writing'])
}

export function effectiveToneModel(settings: ModelSettings | null, providers: Provider[]): EffectiveModel {
  return resolveModel(settings, providers, ['writing'])
}

export function formatEffectiveModel(model: EffectiveModel): string {
  const source = model.source === 'default' ? '全局默认' : model.source === 'unloaded' ? '设置未载入'
    : `${AGENT_ROLES.find(role => role.id === model.source)!.label}配置`
  const provider = model.providerName ? `${model.providerName} (${model.providerId})` : model.providerId || '未配置提供方'
  return `${provider} / ${model.modelId || '未配置模型'} · 来源：${source}${model.available ? '' : ` · 配置不可用：${model.reason}`}`
}
