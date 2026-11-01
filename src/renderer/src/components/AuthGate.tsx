import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { AuthStatus, AuthUser } from '@shared/auth'
import { api, formatError } from '../lib/api'
import { Button, Spinner } from './Ui'

interface AuthContextValue {
  status: AuthStatus
  user: AuthUser | null
}

const AuthContext = createContext<AuthContextValue | null>(null)

/** Compatibility hook for local-workspace-scoped caches; there is no user login. */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthGate')
  return context
}

/** Wait only for main-process workspace readiness; never collect credentials. */
export function AuthGate({ children }: { children: ReactNode }): ReactNode {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [error, setError] = useState('')

  const update = useCallback((next: AuthStatus): void => {
    setStatus(next)
    setError('')
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try { update(await api.auth.status()) } catch (cause) { setError(formatError(cause)) }
  }, [update])

  useEffect(() => {
    // Subscribe first so readiness revocation cannot be missed between the initial read and subscription.
    let active = true
    let changed = false
    const unsubscribe = api.auth.onChanged((next) => { changed = true; if (active) update(next) })
    void api.auth.status().then((next) => { if (active && !changed) update(next) }).catch((cause) => { if (active && !changed) setError(formatError(cause)) })
    return () => { active = false; unsubscribe() }
  }, [update])

  if (!status?.ready || !status.user) return <main className="boot-screen" aria-live="polite">
    {error ? <div className="card card-pad"><h1>无法连接本地工作区</h1><p role="alert">{error}</p><Button onClick={() => void refresh()}>重试</Button></div>
      : <Spinner label={status ? '本地工作区尚未就绪或正在关闭…' : '正在打开本地工作区…'} />}
  </main>

  return <AuthContext.Provider value={{ status, user: status.user }}>{children}</AuthContext.Provider>
}
