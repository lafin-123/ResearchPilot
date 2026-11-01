import { randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'

export function nowIso(): string {
  return new Date().toISOString()
}

export function newId(prefix?: string): string {
  const id = randomUUID()
  return prefix ? `${prefix}_${id.replaceAll('-', '')}` : id
}

export function sessionId(): string {
  return `session-${randomUUID().replaceAll('-', '')}`
}

export function slugify(value: string, fallback = 'item'): string {
  const ascii = value
    .normalize('NFKD')
    .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  return ascii.slice(0, 48) || fallback
}

export function fileStem(fileName: string): string {
  return basename(fileName, extname(fileName))
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1'
}

export function fromBool(value: boolean): number {
  return value ? 1 : 0
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function wordCount(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const latin = (text.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g) ?? []).length
  return cjk + latin
}
