/** Local project pages. These are not automatically indexed or sent to an assistant. */
export interface NoteRecord {
  id: string
  projectId: string
  title: string
  body: string
  pinned: boolean
  revision: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export type NoteSummary = Omit<NoteRecord, 'body'> & { snippet: string }
export type NoteFilter = 'all' | 'pinned' | 'trash'
export interface NoteListOptions {
  query?: string
  filter?: NoteFilter
  limit?: number
  offset?: number
}
export interface NoteListResult {
  items: NoteSummary[]
  total: number
  hasMore: boolean
}
export interface NoteTarget { projectId: string; id: string }
export interface NoteCreateInput { projectId: string; title: string; body?: string }
export interface NoteUpdateInput extends NoteTarget { title: string; body: string; expectedRevision: number }

export const NOTE_LIMITS = Object.freeze({ title: 200, body: 200_000, query: 200, snippet: 240, list: 1000, defaultList: 100, id: 128 })
export const NOTE_CONFLICT = 'NOTE_CONFLICT'
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$(?![\s\S])/

export function validateNoteId(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`笔记参数 ${field} 无效。`)
  return value
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('笔记参数必须是对象。')
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('笔记参数包含未知字段。')
  return value as Record<string, unknown>
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    throw new Error(`笔记 ${field} 必须是长度不超过 ${max} 的文本，且不能包含空字符。`)
  }
  return value
}

function title(value: unknown): string {
  const result = text(value, 'title', NOTE_LIMITS.title).trim()
  if (!result || /[\r\n]/.test(result)) throw new Error('笔记标题不能为空或包含换行。')
  return result
}

export function parseNoteTarget(input: unknown): NoteTarget {
  const value = object(input, ['projectId', 'id'])
  return { projectId: validateNoteId(value.projectId, 'projectId'), id: validateNoteId(value.id) }
}

export function parseNoteCreateInput(input: unknown): Required<NoteCreateInput> {
  const value = object(input, ['projectId', 'title', 'body'])
  return { projectId: validateNoteId(value.projectId, 'projectId'), title: title(value.title), body: value.body === undefined ? '' : text(value.body, 'body', NOTE_LIMITS.body) }
}

export function parseNoteUpdateInput(input: unknown): NoteUpdateInput {
  const value = object(input, ['projectId', 'id', 'title', 'body', 'expectedRevision'])
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1) throw new Error('笔记 expectedRevision 必须是正整数。')
  return {
    projectId: validateNoteId(value.projectId, 'projectId'), id: validateNoteId(value.id),
    title: title(value.title), body: text(value.body, 'body', NOTE_LIMITS.body), expectedRevision: value.expectedRevision as number
  }
}

export function parseNoteListOptions(input: unknown = {}): Required<NoteListOptions> {
  const value = object(input, ['query', 'filter', 'limit', 'offset'])
  const filter = value.filter === undefined ? 'all' : value.filter
  if (!['all', 'pinned', 'trash'].includes(filter as string)) throw new Error('笔记筛选条件无效。')
  const limit = value.limit === undefined ? NOTE_LIMITS.defaultList : value.limit
  const offset = value.offset === undefined ? 0 : value.offset
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > NOTE_LIMITS.list) throw new Error(`笔记 limit 必须是 1 到 ${NOTE_LIMITS.list} 的整数。`)
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error('笔记 offset 必须是非负整数。')
  return { query: value.query === undefined ? '' : text(value.query, 'query', NOTE_LIMITS.query).trim(), filter: filter as NoteFilter, limit: limit as number, offset: offset as number }
}

export function parseNoteListInput(input: unknown): { projectId: string; options: Required<NoteListOptions> } {
  const value = object(input, ['projectId', 'options'])
  return { projectId: validateNoteId(value.projectId, 'projectId'), options: parseNoteListOptions(value.options) }
}

export function parseNotePinInput(input: unknown): NoteTarget & { pinned: boolean } {
  const value = object(input, ['projectId', 'id', 'pinned'])
  if (typeof value.pinned !== 'boolean') throw new Error('笔记 pinned 必须是布尔值。')
  return { projectId: validateNoteId(value.projectId, 'projectId'), id: validateNoteId(value.id), pinned: value.pinned }
}

/** Canonical explicit links never depend on a mutable/ambiguous page title. */
export function noteLink(id: string, label: string): string {
  validateNoteId(id)
  const safeLabel = text(label, 'label', NOTE_LIMITS.title).replace(/[\r\n]+/g, ' ').replace(/[\\[\]`*_<>!]/g, '\\$&')
  return `[${safeLabel || '笔记'}](research-note:${id})`
}

function escapedAt(text: string, index: number): boolean {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) slashes++
  return slashes % 2 === 1
}

/**
 * Parse only canonical [label](research-note:ID) links, not raw URLs, images,
 * title guesses or reference-style Markdown. Ignore fenced/indented and inline
 * code. This deliberately small Markdown subset has no file/network capability.
 */
export function parseNoteLinks(body: string): string[] {
  text(body, 'body', NOTE_LIMITS.body)
  let fence: { marker: string; length: number } | undefined
  const masked = body.split(/(?<=\n)/).map(line => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*?)[\r\n]*$/.exec(line)
    if (fence) {
      if (match && match[1][0] === fence.marker && match[1].length >= fence.length && !match[2].trim()) fence = undefined
      return line.replace(/[^\r\n]/g, ' ')
    }
    if (match && !(match[1][0] === '`' && match[2].includes('`'))) {
      fence = { marker: match[1][0], length: match[1].length }
      return line.replace(/[^\r\n]/g, ' ')
    }
    return /^(?: {4}|\t)/.test(line) ? line.replace(/[^\r\n]/g, ' ') : line
  }).join('')
  // Index equal-length backtick runs once rather than repeatedly searching a
  // large body for an absent closing delimiter.
  const runs = [...masked.matchAll(/`+/g)]
  const next = new Map<number, number>()
  const closes = new Map<number, number>()
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]
    const closing = next.get(run[0].length)
    if (closing !== undefined) closes.set(index, closing)
    next.set(run[0].length, index)
  }
  const parts: string[] = []
  let cursor = 0
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]
    if (escapedAt(masked, run.index!)) continue
    const closingIndex = closes.get(index)
    if (closingIndex === undefined) continue
    const closing = runs[closingIndex]
    parts.push(masked.slice(cursor, run.index), ' ')
    cursor = closing.index! + closing[0].length
    index = closingIndex
  }
  parts.push(masked.slice(cursor))
  const prose = parts.join('').replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
  const ids = new Set<string>()
  const links = /\[((?:\\[^\r\n]|[^\[\]\\\r\n])*)\]\(research-note:([A-Za-z0-9][A-Za-z0-9_-]{0,127})\)/g
  for (const match of prose.matchAll(links)) {
    const start = match.index!
    if (escapedAt(prose, start) || (prose[start - 1] === '!' && !escapedAt(prose, start - 1))) continue
    ids.add(match[2])
  }
  return [...ids]
}
