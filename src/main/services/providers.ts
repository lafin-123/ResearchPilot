import type { ModelInfo, Provider, ProviderInput } from '@shared/types'
import type { Db } from '../lib/db'
import { decryptSecret, encryptSecret } from '../lib/secrets'
import { newId, nowIso, parseJson, slugify } from '../lib/util'
import { discoverProviderModels, normalizeProviderBase, testProviderInference } from '../lib/provider-http'
import { requestViaSystemProxy } from '../lib/network'
import type { SettingsService } from './settings'

interface ProviderRow {
  id: string
  name: string
  kind: 'deepseek' | 'custom'
  protocol: Provider['protocol']
  base_url: string
  api_key_enc: string
  models_json: string
  is_default: number
  created_at: string
  updated_at: string
}

const DEEPSEEK_MODELS: ModelInfo[] = [
  { id: 'deepseek-flash', label: 'DeepSeek V4 Flash', contextWindow: 1_000_000, maxOutput: 131_072 },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 1_000_000, maxOutput: 131_072 }
]

function mapProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    protocol: row.protocol,
    baseUrl: row.base_url,
    models: parseJson<ModelInfo[]>(row.models_json, []),
    isDefault: row.is_default === 1,
    hasApiKey: Boolean(row.api_key_enc),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class ProviderService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService
  ) {}

  seed(): void {
    const count = this.db.scalar<number>('SELECT COUNT(*) FROM providers') ?? 0
    if (count > 0) return
    const timestamp = nowIso()
    this.db.run(
      `INSERT INTO providers (id, name, kind, protocol, base_url, api_key_enc, models_json, is_default, created_at, updated_at)
       VALUES ('deepseek-official', 'DeepSeek', 'deepseek', 'deepseek', 'https://api.deepseek.com', '', ?, 1, ?, ?)`,
      JSON.stringify(DEEPSEEK_MODELS),
      timestamp,
      timestamp
    )
  }

  list(): Provider[] {
    return this.db.all<ProviderRow>('SELECT * FROM providers ORDER BY is_default DESC, created_at ASC').map(mapProvider)
  }

  get(id: string): Provider {
    const row = this.db.get<ProviderRow>('SELECT * FROM providers WHERE id = ?', id)
    if (!row) throw new Error('模型提供方不存在。')
    return mapProvider(row)
  }

  getRow(id: string): ProviderRow {
    const row = this.db.get<ProviderRow>('SELECT * FROM providers WHERE id = ?', id)
    if (!row) throw new Error('模型提供方不存在。')
    return row
  }

  apiKey(id: string): string {
    const row = this.getRow(id)
    return row.api_key_enc ? decryptSecret(row.api_key_enc) : ''
  }

  hasAnyKey(): boolean {
    return this.list().some((provider) => provider.hasApiKey)
  }

  upsert(input: ProviderInput): Provider {
    const name = input.name.trim()
    if (!name) throw new Error('提供方名称不能为空。')
    if (!input.models.length) throw new Error('至少添加一个模型。')
    const existing = input.id ? this.db.get<ProviderRow>('SELECT * FROM providers WHERE id = ?', input.id) : undefined
    const baseUrl = normalizeProviderBase(input.baseUrl ?? existing?.base_url ?? (input.kind === 'deepseek' ? 'https://api.deepseek.com' : ''), input.protocol)
    let id = input.id ?? (input.kind === 'deepseek' ? 'deepseek-official' : slugify(name, 'provider'))
    if (!/^[a-z][a-z0-9-]*$/.test(id)) id = `p-${id.replace(/[^a-z0-9-]/g, '-')}`
    const keyEnc = input.apiKey ? encryptSecret(input.apiKey) : existing?.api_key_enc ?? ''
    const timestamp = nowIso()
    if (existing) {
      this.db.run(
        `UPDATE providers SET name = ?, kind = ?, protocol = ?, base_url = ?, api_key_enc = ?, models_json = ?, is_default = ?, updated_at = ? WHERE id = ?`,
        name,
        input.kind,
        input.protocol,
        baseUrl,
        keyEnc,
        JSON.stringify(input.models),
        input.isDefault === undefined ? existing.is_default : input.isDefault ? 1 : 0,
        timestamp,
        id
      )
    } else {
      this.db.run(
        `INSERT INTO providers (id, name, kind, protocol, base_url, api_key_enc, models_json, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        name,
        input.kind,
        input.protocol,
        baseUrl,
        keyEnc,
        JSON.stringify(input.models),
        input.isDefault ? 1 : 0,
        timestamp,
        timestamp
      )
    }
    if (input.isDefault) {
      this.db.run('UPDATE providers SET is_default = 0 WHERE id <> ?', id)
      const provider = this.get(id)
      this.settings.update({ defaultProviderId: provider.id, defaultModelId: provider.models[0]?.id ?? '' })
    }
    if (!this.db.scalar<number>('SELECT COUNT(*) FROM providers WHERE is_default = 1')) {
      this.db.run('UPDATE providers SET is_default = 1 WHERE id = ?', id)
    }
    return this.get(id)
  }

  delete(id: string): void {
    const provider = this.get(id)
    if (provider.isDefault && this.list().length > 1) throw new Error('不能删除当前默认提供方，请先切换默认模型。')
    this.db.run('DELETE FROM providers WHERE id = ?', id)
    const next = this.list()[0]
    if (next) {
      this.db.run('UPDATE providers SET is_default = 1 WHERE id = ?', next.id)
      this.settings.update({ defaultProviderId: next.id, defaultModelId: next.models[0]?.id ?? '' })
    }
  }

  private preview(input: { id?: string; apiKey?: string; provider?: ProviderInput }): { provider: Provider; key: string } {
    const existing = input.id ? this.get(input.id) : undefined
    if (!input.provider && !existing) throw new Error('缺少提供方信息。')
    const draft = input.provider
    const provider: Provider = draft ? {
      id: existing?.id ?? 'preview', name: draft.name, kind: draft.kind, protocol: draft.protocol,
      baseUrl: draft.baseUrl ?? '', models: draft.models, isDefault: false,
      hasApiKey: Boolean(input.apiKey || draft.apiKey || existing?.hasApiKey), createdAt: nowIso(), updatedAt: nowIso()
    } : existing!
    const key = input.apiKey || draft?.apiKey || (existing ? this.apiKey(existing.id) : '')
    return { provider, key }
  }

  async test(input: { id?: string; apiKey?: string; provider?: ProviderInput }): Promise<{ ok: boolean; message: string; models: ModelInfo[] }> {
    const { provider, key } = this.preview(input)
    return testProviderInference(provider, key, requestViaSystemProxy)
  }

  async discoverModels(input: { id?: string; apiKey?: string; provider?: ProviderInput }): Promise<ModelInfo[]> {
    const { provider, key } = this.preview(input)
    const result = await discoverProviderModels(provider, key, requestViaSystemProxy)
    if (!result.ok) throw new Error(result.message)
    return result.models
  }

  defaultProvider(): Provider | undefined {
    return this.list().find((provider) => provider.isDefault) ?? this.list()[0]
  }

  dshProviderId(provider: Provider): string {
    return provider.kind === 'deepseek' ? 'deepseek-official' : provider.id
  }
}
