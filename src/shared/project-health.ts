/** Availability is independent of the registered project record; no path is relinked automatically. */
export interface ProjectHealthError {
  code: string
  message: string
}

export interface ProjectHealth {
  projectId: string
  projectName: string
  rootPath: string
  available: boolean
  checkedAt: string
  error: ProjectHealthError | null
}

export interface ProjectSyncResult {
  projectId: string
  rootPath: string
  ok: boolean
  error: ProjectHealthError | null
}
