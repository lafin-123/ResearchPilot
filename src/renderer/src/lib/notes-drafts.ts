export interface NoteScope {
  projectId: string
  id: string
}

export interface NoteSnapshot extends NoteScope {
  title: string
  body: string
  revision: number
}

export interface NoteDraft {
  title: string
  body: string
  savedTitle: string
  savedBody: string
  revision: number
  recovery: { title: string; body: string } | null
}

const key = (scope: NoteScope): string => JSON.stringify([scope.projectId, scope.id])
const changed = (draft: NoteDraft): boolean => draft.title !== draft.savedTitle || draft.body !== draft.savedBody

/** Memory only: route changes retain drafts, renderer reload/logout clears them. */
export class NotesDrafts {
  private readonly drafts = new Map<string, NoteDraft>()
  private readonly locks = new Set<string>()
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  get(scope: NoteScope): NoteDraft | null {
    return this.drafts.get(key(scope)) ?? null
  }

  isModified(scope: NoteScope): boolean {
    const draft = this.get(scope)
    return !!draft && changed(draft)
  }

  hasModified(projectId?: string): boolean {
    return [...this.drafts.entries()].some(([scopeKey, draft]) => changed(draft) && (!projectId || JSON.parse(scopeKey)[0] === projectId))
  }

  /** Fresh reads may refresh clean notes, but never rebase or replace unsaved edits. */
  load(note: NoteSnapshot): NoteDraft {
    const current = this.get(note)
    if (current && (changed(current) || current.revision > note.revision)) return current
    const draft = {
      title: note.title, body: note.body, savedTitle: note.title, savedBody: note.body,
      revision: note.revision, recovery: current?.recovery ?? null
    }
    this.drafts.set(key(note), draft)
    this.notify()
    return draft
  }

  edit(scope: NoteScope, patch: Partial<Pick<NoteDraft, 'title' | 'body'>>): void {
    const current = this.get(scope)
    if (!current) return
    this.drafts.set(key(scope), { ...current, ...patch })
    this.notify()
  }

  /** Acknowledge only the submitted snapshot; typing during IPC remains unsaved. */
  saved(note: NoteSnapshot, submitted: NoteDraft): void {
    const current = this.get(note)
    if (!current || current.revision !== submitted.revision) return
    this.drafts.set(key(note), {
      ...current,
      title: current.title === submitted.title ? note.title : current.title,
      body: current.body === submitted.body ? note.body : current.body,
      savedTitle: note.title, savedBody: note.body, revision: note.revision
    })
    this.notify()
  }

  /** Pin/trash/restore must not silently authorize overwriting a remote content change. */
  metadataUpdated(note: NoteSnapshot): void {
    const current = this.get(note)
    if (!current || !changed(current)) { this.load(note); return }
    if (note.title !== current.savedTitle || note.body !== current.savedBody || note.revision < current.revision) return
    this.drafts.set(key(note), { ...current, revision: note.revision })
    this.notify()
  }

  /** Called only after explicit confirmation; keep a recoverable copy of the discarded editor. */
  reload(note: NoteSnapshot): void {
    const current = this.get(note)
    this.drafts.set(key(note), {
      title: note.title, body: note.body, savedTitle: note.title, savedBody: note.body,
      revision: note.revision,
      recovery: current && changed(current) ? { title: current.title, body: current.body } : current?.recovery ?? null
    })
    this.notify()
  }

  isBusy(scope: NoteScope): boolean { return this.locks.has(key(scope)) }

  /** Shared across route remounts so two handlers cannot send duplicate mutations. */
  acquire(scope: NoteScope): (() => void) | null {
    const scopeKey = key(scope)
    if (this.locks.has(scopeKey)) return null
    this.locks.add(scopeKey)
    this.notify()
    return () => { this.locks.delete(scopeKey); this.notify() }
  }
}

/** Invalidate on navigation intent as well as unmount (including A -> B -> A). */
export class NotesContext {
  private generation = 0
  capture(): number { return this.generation }
  invalidate(): void { this.generation += 1 }
  isCurrent(token: number): boolean { return token === this.generation }
}

/** ReactMarkdown's URL transform is deliberately narrower than its default. */
export function safeNoteUrl(url: string): string {
  if (/^research-note:[A-Za-z0-9_-]{1,128}$/.test(url)) return url
  if (!/^https:\/\//i.test(url)) return ''
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : ''
  } catch { return '' }
}

export function noteMarkdown(title: string, body: string): string {
  // A title is plain text; escape Markdown punctuation to keep it a single heading.
  const heading = title.replace(/[\r\n]+/g, ' ').replace(/([\\`*_{}\[\]()#+.!<>|~-])/g, '\\$1')
  return `# ${heading || '未命名笔记'}\n\n${body}\n`
}

export function noteExportFilename(title: string): string {
  const stem = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 100)
  return `${stem || 'research-note'}.md`
}

export interface NotesUnloadEvent {
  preventDefault(): void
  returnValue: string | boolean
}

/** No route ownership: switching elsewhere must not remove the unsaved-close warning. */
export function warnForUnsavedNotes(drafts: NotesDrafts, event: NotesUnloadEvent): void {
  if (!drafts.hasModified()) return
  event.preventDefault()
  event.returnValue = ''
}

export const notesDrafts = new NotesDrafts()

// The lazy notes module is evaluated once per renderer. Memory drafts and their
// close warning have the same lifetime, including after the Notes route unmounts.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', event => warnForUnsavedNotes(notesDrafts, event))
}
