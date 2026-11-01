import { accessSync, constants, lstatSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { Project } from '../../shared/types'
import type { ProjectHealth, ProjectHealthError } from '../../shared/project-health'
import { PROJECT_DIRS } from '../lib/paths'

type RegisteredProject = Pick<Project, 'id' | 'name' | 'rootPath'>
interface ProjectRegistry {
  list(): Project[]
  get(id: string): Project
}

function pathError(code: string, path: string, reason: string): Error {
  return Object.assign(new Error(`${code}: ${reason}（${path}）`), { code })
}

/** Checks metadata only: never mkdir, follow a link, or create a write-test file. */
export function assertProjectRootAvailable(project: Pick<Project, 'rootPath'>): void {
  const root = project.rootPath
  if (!root || !isAbsolute(root)) throw pathError('EINVAL', root, '项目目录必须是已配置的绝对路径')
  const resolved = resolve(root)
  const ancestors: string[] = []
  for (let current = resolved; ; current = dirname(current)) {
    ancestors.push(current)
    if (current === parse(current).root) break
  }
  for (const path of ancestors.reverse()) {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) throw pathError('ELOOP', path, '项目目录或其父目录是链接，拒绝自动初始化')
    if (!info.isDirectory()) throw pathError('ENOTDIR', path, '配置路径不是目录')
  }
  accessSync(resolved, constants.R_OK | constants.W_OK | constants.X_OK)
}

/** Reject existing links along a managed path before recursive mkdir/write can follow them. */
export function assertProjectPathSafe(project: Pick<Project, 'rootPath'>, relativePath: string, kind: 'directory' | 'file'): void {
  assertProjectRootAvailable(project)
  const root = resolve(project.rootPath)
  const target = resolve(root, relativePath)
  const rel = relative(root, target)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw pathError('EINVAL', target, '受管路径超出项目目录')
  const segments = rel.split(sep).filter(Boolean)
  let current = root
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    let info: ReturnType<typeof lstatSync>
    try { info = lstatSync(current) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (info.isSymbolicLink()) throw pathError('ELOOP', current, '受管项目路径是链接，拒绝自动写入')
    const directory = index < segments.length - 1 || kind === 'directory'
    if (directory && !info.isDirectory()) throw pathError('ENOTDIR', current, '受管项目路径不是目录')
    if (!directory && !info.isFile()) throw pathError('EINVAL', current, '受管项目文件不是普通文件')
    if (!directory && info.nlink > 1) throw pathError('EMLINK', current, '受管项目文件存在硬链接，拒绝自动写入')
  }
}

export function projectHealthError(error: unknown): ProjectHealthError {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code.slice(0, 80) : 'PROJECT_UNAVAILABLE'
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '项目目录检查或初始化失败。'
  return { code, message: message.slice(0, 2000) }
}

/** Session-local diagnostics; registered projects remain visible even when their roots disappear. */
export class ProjectHealthService {
  private readonly failures = new Map<string, ProjectHealthError>()

  constructor(
    private readonly projects: ProjectRegistry,
    private readonly prepareProject: (project: Project) => void
  ) {}

  initializeAll(): ProjectHealth[] {
    return this.projects.list().map(project => this.prepare(project))
  }

  /** Read-only checks do not silently retry writes or clear an earlier preparation failure. */
  list(): ProjectHealth[] {
    return this.projects.list().map(project => this.inspect(project))
  }

  retry(projectId: string): ProjectHealth {
    return this.prepare(this.projects.get(projectId))
  }

  /** Call at execution boundaries, without changing ProjectService.get's record-only semantics. */
  assertAvailable(projectId: string): void {
    const project = this.projects.get(projectId)
    const health = this.inspect(project)
    if (!health.available) throw pathError(health.error!.code, project.rootPath, health.error!.message)
  }

  /** Bridge initialization failures are also visible in the health list, not console-only. */
  recordFailure(project: RegisteredProject, error: unknown): ProjectHealth {
    const failure = projectHealthError(error)
    this.failures.set(project.id, failure)
    return this.result(project, failure)
  }

  private inspect(project: RegisteredProject): ProjectHealth {
    try { assertProjectRootAvailable(project) } catch (error) { return this.recordFailure(project, error) }
    return this.result(project, this.failures.get(project.id) ?? null)
  }

  private prepare(project: Project): ProjectHealth {
    try {
      assertProjectRootAvailable(project)
      // ensureProjectLayout writes only these fixed managed targets. Preflight existing
      // entries so that a junction/symlink cannot redirect startup into another directory.
      for (const dir of PROJECT_DIRS) assertProjectPathSafe(project, dir, 'directory')
      for (const file of ['AGENTS.md', '.research/manifest.json', '.research/bridge.json', '.research/bin/research-cli.ps1', '.research/bin/research.cmd', '.research/bin/research.sh']) {
        assertProjectPathSafe(project, file, 'file')
      }
      this.prepareProject(project)
      this.failures.delete(project.id)
      return this.result(project, null)
    } catch (error) { return this.recordFailure(project, error) }
  }

  private result(project: RegisteredProject, error: ProjectHealthError | null): ProjectHealth {
    return { projectId: project.id, projectName: project.name, rootPath: project.rootPath, available: error === null, checkedAt: new Date().toISOString(), error }
  }
}
