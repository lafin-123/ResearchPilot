import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Project, ProjectOverview } from '@shared/types'
import type { Db } from '../lib/db'
import { emitEvent } from '../lib/events'
import { ensureDir, ensureProjectLayout } from '../lib/paths'
import { newId, nowIso, slugify } from '../lib/util'
import type { SettingsService } from './settings'
import type { DocumentService } from './documents'
import type { ExperimentService } from './experiments'

interface ProjectRow {
  id: string
  name: string
  description: string
  root_path: string
  archived: number
  created_at: string
  updated_at: string
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rootPath: row.root_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1
  }
}

export class ProjectService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly documents: DocumentService,
    private readonly experiments: ExperimentService
  ) {}

  list(): Project[] {
    return this.db
      .all<ProjectRow>('SELECT * FROM projects WHERE archived = 0 ORDER BY updated_at DESC')
      .map(mapProject)
  }

  get(id: string): Project {
    const row = this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id)
    if (!row) throw new Error('项目不存在或已删除。')
    return mapProject(row)
  }

  create(input: { name: string; description?: string; workspaceRoot?: string }): Project {
    const name = input.name.trim()
    if (!name) throw new Error('项目名称不能为空。')
    const workspaceRoot = input.workspaceRoot?.trim() || this.settings.get().workspaceRoot
    ensureDir(workspaceRoot)
    const id = newId('proj')
    let rootPath = join(workspaceRoot, `${slugify(name, 'project')}-${id.slice(-6)}`)
    let suffix = 2
    while (existsSync(rootPath)) {
      rootPath = join(workspaceRoot, `${slugify(name, 'project')}-${id.slice(-6)}-${suffix}`)
      suffix += 1
    }
    ensureDir(rootPath)
    const timestamp = nowIso()
    this.db.run(
      'INSERT INTO projects (id, name, description, root_path, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      id,
      name,
      input.description?.trim() ?? '',
      rootPath,
      timestamp,
      timestamp
    )
    const project = this.get(id)
    ensureProjectLayout(project)
    this.settings.setActiveProjectId(id)
    emitEvent({ type: 'project-updated', project })
    return project
  }

  update(id: string, patch: { name?: string; description?: string; archived?: boolean }): Project {
    const current = this.get(id)
    const nextName = patch.name?.trim() || current.name
    this.db.run(
      'UPDATE projects SET name = ?, description = ?, archived = ?, updated_at = ? WHERE id = ?',
      nextName,
      patch.description ?? current.description,
      patch.archived === undefined ? (current.archived ? 1 : 0) : patch.archived ? 1 : 0,
      nowIso(),
      id
    )
    const project = this.get(id)
    emitEvent({ type: 'project-updated', project })
    return project
  }

  delete(id: string, deleteFiles = false): void {
    const project = this.get(id)
    if (deleteFiles) {
      const root = project.rootPath
      const marker = join(root, '.research', 'manifest.json')
      if (!existsSync(marker)) throw new Error('项目目录缺少 ResearchPilot 标记，拒绝删除文件。')
      rmSync(root, { recursive: true, force: true })
    }
    this.db.run('DELETE FROM projects WHERE id = ?', id)
    if (this.settings.getActiveProjectId() === id) {
      const next = this.db.get<{ id: string }>('SELECT id FROM projects WHERE archived = 0 ORDER BY updated_at DESC LIMIT 1')
      this.settings.setActiveProjectId(next?.id ?? '')
    }
  }

  overview(id: string): ProjectOverview {
    const project = this.get(id)
    const documents = this.documents.list(id)
    const stats = {
      documents: documents.length,
      references: this.db.scalar<number>('SELECT COUNT(*) FROM reference_items WHERE project_id = ?', id) ?? 0,
      experiments: this.db.scalar<number>('SELECT COUNT(*) FROM experiments WHERE project_id = ?', id) ?? 0,
      figures: this.db.scalar<number>('SELECT COUNT(*) FROM figures WHERE project_id = ?', id) ?? 0,
      runs: this.db.scalar<number>('SELECT COUNT(*) FROM experiment_runs WHERE project_id = ?', id) ?? 0
    }
    return {
      project,
      stats,
      documents,
      recentRuns: this.experiments.recentRuns(id, 5)
    }
  }
}
