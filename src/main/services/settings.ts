import type { AppSettings, ModelInfo } from '@shared/types'
import { normalizeClarification } from '../../shared/research-interaction'
import { normalizeAgentRoles } from '../../shared/agent-roles'
import type { Db } from '../lib/db'
import { defaultWorkspaceRoot } from '../lib/paths'
import { parseJson } from '../lib/util'

const SETTINGS_KEY = 'app'
const ACTIVE_PROJECT_KEY = 'activeProjectId'

export function defaultSettings(): AppSettings {
  return {
    workspaceRoot: defaultWorkspaceRoot(),
    pythonPath: '',
    latexCommand: '',
    defaultProviderId: 'deepseek-official',
    defaultModelId: 'deepseek-flash',
    maxConcurrentRuns: 2,
    reasoningEffort: '',
    maxOutputTokens: 0,
    telemetry: false,
    researchClarification: 'balanced'
  }
}

export class SettingsService {
  constructor(private readonly db: Db) {}

  get(): AppSettings {
    const row = this.db.get<{ value_json: string }>('SELECT value_json FROM app_settings WHERE key = ?', SETTINGS_KEY)
    const next = { ...defaultSettings(), ...parseJson<Partial<AppSettings>>(row?.value_json, {}) }
    next.researchClarification = normalizeClarification(next.researchClarification)
    next.agentRoleModels = normalizeAgentRoles(next.agentRoleModels)
    return next
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.get(), ...patch }
    const changesDefault = Object.hasOwn(patch, 'defaultProviderId') || Object.hasOwn(patch, 'defaultModelId')
    if (changesDefault) {
      if (typeof next.defaultProviderId !== 'string' || typeof next.defaultModelId !== 'string') throw new Error('默认提供方与默认模型必须是有效 ID。')
      if (next.defaultProviderId || next.defaultModelId) {
        if (!next.defaultProviderId || !next.defaultModelId) throw new Error('请同时选择默认提供方与默认模型，或同时清空。')
        const provider = this.db.get<{ models_json: string }>('SELECT models_json FROM providers WHERE id = ?', next.defaultProviderId)
        if (!provider) throw new Error('默认模型的提供方不存在。')
        if (!parseJson<ModelInfo[]>(provider.models_json, []).some(model => model.id === next.defaultModelId)) throw new Error('默认模型不在提供方的已选模型列表中。')
      }
    }
    next.researchClarification = normalizeClarification(next.researchClarification)
    next.agentRoleModels = normalizeAgentRoles(next.agentRoleModels)
    if (!next.workspaceRoot || typeof next.workspaceRoot !== 'string') next.workspaceRoot = defaultWorkspaceRoot()
    next.maxConcurrentRuns = Math.max(1, Math.min(8, Number(next.maxConcurrentRuns) || 2))
    next.maxOutputTokens = Math.max(0, Math.min(1_000_000, Number(next.maxOutputTokens) || 0))
    if (!['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(next.reasoningEffort)) next.reasoningEffort = ''
    this.db.run(
      'INSERT INTO app_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
      SETTINGS_KEY,
      JSON.stringify(next)
    )
    if (changesDefault) this.db.run('UPDATE providers SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END', next.defaultProviderId)
    return next
  }

  getActiveProjectId(): string {
    return this.db.get<{ value_json: string }>('SELECT value_json FROM app_settings WHERE key = ?', ACTIVE_PROJECT_KEY)?.value_json?.replace(/^"|"$/g, '') ?? ''
  }

  setActiveProjectId(projectId: string): void {
    this.db.run(
      'INSERT INTO app_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
      ACTIVE_PROJECT_KEY,
      JSON.stringify(projectId)
    )
  }
}
