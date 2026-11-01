import type { AgentUsage, UsageBucket, UsageSummary } from '@shared/types'
import type { Db } from '../lib/db'
import { newId, nowIso } from '../lib/util'

interface UsageRow {
  provider_id: string
  model_id: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  reasoning_tokens: number
  requests: number
}

export class UsageService {
  constructor(private readonly db: Db) {}

  record(input: {
    projectId: string
    chatId: string
    providerId: string
    modelId: string
    usage: AgentUsage
    createdAt?: string
  }): void {
    this.db.run(
      `INSERT INTO usage_events
       (id, project_id, chat_id, provider_id, model_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('usage'),
      input.projectId,
      input.chatId,
      input.providerId,
      input.modelId,
      input.usage.inputTokens,
      input.usage.outputTokens,
      input.usage.cacheReadTokens ?? 0,
      input.usage.cacheWriteTokens ?? 0,
      input.usage.reasoningTokens ?? 0,
      input.createdAt ?? nowIso()
    )
  }

  summary(projectId?: string): UsageSummary {
    const where = projectId ? 'WHERE project_id = ?' : ''
    const params = projectId ? [projectId] : []
    const totals = this.db.get<{
      input_tokens: number | null
      output_tokens: number | null
      cache_read_tokens: number | null
      reasoning_tokens: number | null
      requests: number
    }>(
      `SELECT SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens, SUM(reasoning_tokens) AS reasoning_tokens,
              COUNT(*) AS requests
       FROM usage_events ${where}`,
      ...params
    )
    const rows = this.db.all<UsageRow>(
      `SELECT provider_id, model_id, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens, SUM(reasoning_tokens) AS reasoning_tokens,
              COUNT(*) AS requests
       FROM usage_events ${where}
       GROUP BY provider_id, model_id
       ORDER BY SUM(input_tokens) + SUM(output_tokens) DESC
       LIMIT 20`,
      ...params
    )
    const byModel: UsageBucket[] = rows.map((row) => ({
      providerId: row.provider_id,
      modelId: row.model_id,
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      cacheReadTokens: row.cache_read_tokens ?? 0,
      reasoningTokens: row.reasoning_tokens ?? 0,
      requests: row.requests
    }))
    return {
      inputTokens: totals?.input_tokens ?? 0,
      outputTokens: totals?.output_tokens ?? 0,
      cacheReadTokens: totals?.cache_read_tokens ?? 0,
      reasoningTokens: totals?.reasoning_tokens ?? 0,
      requests: totals?.requests ?? 0,
      byModel
    }
  }
}
