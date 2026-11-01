import type { ApprovalDecision, ApprovalRequest } from '@shared/types'
import { emitEvent } from '../lib/events'
import { newId } from '../lib/util'

interface Pending {
  request: ApprovalRequest
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
  remember: boolean
}

export class ApprovalService {
  private pending = new Map<string, Pending>()
  private remembered = new Set<string>()

  async request(input: Omit<ApprovalRequest, 'id' | 'createdAt'>, options: { signal?: AbortSignal; remember?: boolean } = {}): Promise<{ approved: boolean; request: ApprovalRequest }> {
    const key = `${input.title}\n${input.details}`
    if (options.signal?.aborted) return { approved: false, request: { ...input, id: newId('appr'), createdAt: new Date().toISOString() } }
    if (options.remember !== false && this.remembered.has(key)) {
      return {
        approved: true,
        request: { ...input, id: newId('appr'), createdAt: new Date().toISOString() }
      }
    }
    const request: ApprovalRequest = { ...input, id: newId('appr'), createdAt: new Date().toISOString() }
    emitEvent({ type: 'approval-request', request })
    return new Promise((resolve) => {
      const settle = (approved: boolean): void => {
        clearTimeout(timer)
        this.pending.delete(request.id)
        options.signal?.removeEventListener('abort', cancel)
        resolve({ approved, request })
      }
      const cancel = (): void => settle(false)
      const timer = setTimeout(() => settle(false), 5 * 60 * 1000)
      this.pending.set(request.id, { request, timer, remember: options.remember !== false, resolve: settle })
      options.signal?.addEventListener('abort', cancel, { once: true })
      if (options.signal?.aborted) cancel()
    })
  }

  respond(decision: ApprovalDecision): void {
    const pending = this.pending.get(decision.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(decision.id)
    if (decision.approved && decision.remember && pending.remember) this.remembered.add(`${pending.request.title}\n${pending.request.details}`)
    pending.resolve(decision.approved)
  }

  cancelAll(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.resolve(false)
      this.pending.delete(id)
    }
  }
}
