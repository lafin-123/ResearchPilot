import { join } from 'node:path'
import type { AuthStatus, AuthUser } from '../../shared/auth'

export interface LocalWorkspaceScope {
  user: AuthUser
  dataRoot: string
  databasePath: string
  workspaceRoot: string
}

export interface LocalSessionLifecycle {
  activate(scope: LocalWorkspaceScope): Promise<void>
  deactivate(): Promise<void>
  changed?(status: AuthStatus): void
}

/** Internal workspace readiness, not an account or a login boundary. No account files are opened. */
export class LocalSessionService {
  private state: 'new' | 'initializing' | 'ready' | 'closed' = 'new'
  private initialization: Promise<AuthStatus> | null = null
  private closing: Promise<void> | null = null
  private activeCalls = 0
  private drained: (() => void) | null = null
  private readonly user: AuthUser = { id: 'local-default', name: '本地工作区' }

  constructor(
    private readonly userDataRoot: string,
    private readonly workspaceRoot: string,
    private readonly lifecycle: LocalSessionLifecycle
  ) {}

  status(): AuthStatus {
    const ready = this.isAuthorized()
    return { mode: 'local', ready, user: ready ? { ...this.user } : null }
  }

  private isClosed(): boolean {
    return this.state === 'closed'
  }

  isAuthorized(): boolean {
    return this.state === 'ready'
  }

  /** Trusted IPC calls retain the workspace until their asynchronous work has settled. */
  authorize(): () => void {
    if (!this.isAuthorized()) throw new Error('本地工作区尚未就绪或正在关闭。')
    this.activeCalls += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeCalls -= 1
      if (this.activeCalls === 0) { this.drained?.(); this.drained = null }
    }
  }

  initialize(): Promise<AuthStatus> {
    if (this.state === 'closed') return Promise.reject(new Error('本地工作区已关闭，请重启应用。'))
    if (this.initialization) return this.initialization
    this.state = 'initializing'
    this.initialization = Promise.resolve().then(async () => {
      if (this.isClosed()) throw new Error('本地工作区初始化已取消。')
      // Preserve the original roots exactly. Legacy account files and subaccount trees are never read or migrated.
      await this.lifecycle.activate({
        user: { ...this.user },
        dataRoot: this.userDataRoot,
        databasePath: join(this.userDataRoot, 'researchpilot.db'),
        workspaceRoot: this.workspaceRoot
      })
      if (this.isClosed()) throw new Error('本地工作区初始化已取消。')
      this.state = 'ready'
      const status = this.status()
      this.lifecycle.changed?.(status)
      return status
    }).catch((error: unknown) => {
      this.revoke()
      throw error
    })
    return this.initialization
  }

  /** Deny new IPC and bridge work immediately, including during a pending initialization. */
  revoke(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.lifecycle.changed?.(this.status())
  }

  /** Callers stop background jobs first; teardown then waits for all in-flight IPC leases. */
  close(): Promise<void> {
    this.revoke()
    if (this.closing) return this.closing
    this.closing = (async () => {
      await this.initialization?.catch(() => undefined)
      if (this.activeCalls > 0) await new Promise<void>((resolve) => { this.drained = resolve })
      await this.lifecycle.deactivate()
    })()
    return this.closing
  }
}
