import type { AppSettings } from '@shared/types'
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
