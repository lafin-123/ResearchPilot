/** Stable local workspace identity for in-memory renderer caches; not a login account. */
export interface AuthUser {
  id: string
  name: string
}

/** The auth namespace is retained only as a compatibility name for workspace readiness. */
export interface AuthStatus {
  ready: boolean
  user: AuthUser | null
  mode: 'local'
}
