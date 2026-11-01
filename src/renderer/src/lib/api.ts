export const api = window.researchpilot

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
      .replace(/^Error invoking remote method '[^']+': Error: /, '')
      .replace(/^Error: /, '')
  }
  return String(error)
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function bytesToBase64(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < view.length; index += chunk) {
    binary += String.fromCharCode(...view.subarray(index, index + chunk))
  }
  return btoa(binary)
}

export function base64ToBlobUrl(base64: string, mime = 'application/pdf'): string {
  const bytes = base64ToBytes(base64)
  const blob = new Blob([new Uint8Array(bytes)], { type: mime })
  return URL.createObjectURL(blob)
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function relativeTime(iso: string): string {
  if (!iso) return '—'
  const time = new Date(iso).getTime()
  const delta = Date.now() - time
  if (Number.isNaN(time)) return '—'
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

export function formatNumber(value: number | string): string {
  if (typeof value === 'string') return value
  if (Number.isInteger(value)) return value.toLocaleString('zh-CN')
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 6 })
}
