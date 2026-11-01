import type { RewriteConstraints } from '../../../shared/writing-quality'

export interface WritingSessionDraft {
  documentId: string
  draft: string
  sources: Array<{ id: string; label: string; text: string }>
  constraints: RewriteConstraints
  includeSources: boolean
  revised: string
  revisionTitle: string
}

/** Memory only. Keys include the authenticated account and project, never browser storage. */
export class WritingSessionCache {
  private entries = new Map<string, WritingSessionDraft>()
  private key(accountId: string, projectId: string): string { return JSON.stringify([accountId, projectId]) }
  read(accountId: string, projectId: string): WritingSessionDraft | undefined {
    const value = this.entries.get(this.key(accountId, projectId))
    return value ? structuredClone(value) : undefined
  }
  save(accountId: string, projectId: string, value: WritingSessionDraft): void {
    if (!accountId || !projectId) return
    this.entries.set(this.key(accountId, projectId), structuredClone(value))
  }
  remove(accountId: string, projectId: string): void { this.entries.delete(this.key(accountId, projectId)) }
  clear(): void { this.entries.clear() }
}
export const writingSessionCache = new WritingSessionCache()
