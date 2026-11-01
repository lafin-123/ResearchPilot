export interface ExperimentScope {
  projectId: string
  experimentId: string
}

export interface ExperimentDraft {
  code: string
  savedCode: string
}

const scopeKey = (scope: ExperimentScope): string => JSON.stringify([scope.projectId, scope.experimentId])

/** Renderer-memory only. Route unmounts retain drafts; the logout renderer reload clears them. */
export class ExperimentDrafts {
  private readonly drafts = new Map<string, ExperimentDraft>()
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  get(scope: ExperimentScope): ExperimentDraft | null {
    return this.drafts.get(scopeKey(scope)) ?? null
  }

  isModified(scope: ExperimentScope): boolean {
    const draft = this.get(scope)
    return !!draft && draft.code !== draft.savedCode
  }

  load(scope: ExperimentScope, code: string): ExperimentDraft {
    // A late read must never replace a draft already loaded or edited.
    const current = this.get(scope)
    if (current) return current
    const draft = { code, savedCode: code }
    this.drafts.set(scopeKey(scope), draft)
    this.changed()
    return draft
  }

  edit(scope: ExperimentScope, code: string): ExperimentDraft | null {
    const current = this.get(scope)
    if (!current) return null
    const draft = { ...current, code }
    this.drafts.set(scopeKey(scope), draft)
    this.changed()
    return draft
  }

  saved(scope: ExperimentScope, savedCode: string): ExperimentDraft | null {
    const current = this.get(scope)
    if (!current) return null
    // Typing while a save is pending remains modified against the exact saved snapshot.
    const draft = { ...current, savedCode }
    this.drafts.set(scopeKey(scope), draft)
    this.changed()
    return draft
  }

  revert(scope: ExperimentScope): ExperimentDraft | null {
    const current = this.get(scope)
    return current ? this.edit(scope, current.savedCode) : null
  }

  remove(scope: ExperimentScope): void {
    this.drafts.delete(scopeKey(scope))
    this.changed()
  }
}

/** Invalidate synchronously on selection and unmount, including A -> B -> A navigation. */
export class ExperimentContext {
  private generation = 0

  capture(): number {
    return this.generation
  }

  invalidate(): void {
    this.generation += 1
  }

  isCurrent(token: number): boolean {
    return token === this.generation
  }
}

export const experimentDrafts = new ExperimentDrafts()
