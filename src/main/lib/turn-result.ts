export function turnFailure(events: readonly unknown[]): string | null {
  for (const raw of [...events].reverse()) {
    if (!raw || typeof raw !== 'object') continue
    const event = raw as { type?: string; data?: { reason?: unknown } }
    if (event.type !== 'turn/end') continue
    const reason = event.data?.reason
    const value = typeof reason === 'string' ? { kind: reason } : reason && typeof reason === 'object' ? reason as { kind?: string; error?: { message?: string; code?: string }; failure?: { message?: string; code?: string } } : {}
    if (value.kind === 'error') return value.error?.message || value.failure?.message || value.error?.code || value.failure?.code || '模型请求失败，未完成研究阶段。'
    if (value.kind === 'cancelled' || value.kind === 'aborted') return '模型任务已停止，阶段未完成。'
    if (value.kind === 'max-tokens') return '模型达到输出上限，阶段尚未完成。请检查已有产物后重试。'
    return null
  }
  return null
}
