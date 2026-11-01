import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { shell } from 'electron'
import type { Experiment, ExperimentInput, ExperimentRun, ExperimentStatus } from '@shared/types'
import type { Db } from '../lib/db'
import { ensureDir, relativePath } from '../lib/paths'
import { newId, nowIso, parseJson, slugify } from '../lib/util'
import { ensureFigureDir, figurePath } from '../lib/figure-files'

interface ExperimentRow {
  id: string
  project_id: string
  name: string
  description: string
  language: 'python'
  entry_file: string
  env_kind: 'local' | 'ssh'
  ssh_host_id: string
  status: ExperimentStatus
  last_run_id: string
  created_at: string
  updated_at: string
}

interface RunRow {
  id: string
  experiment_id: string
  project_id: string
  status: ExperimentStatus
  exit_code: number | null
  command: string
  started_at: string
  finished_at: string
  stdout: string
  stderr: string
  metrics_json: string
  artifact_dir: string
  env_json: string
}

interface ProjectRow {
  id: string
  root_path: string
}

export function mapExperiment(row: ExperimentRow): Experiment {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    language: row.language,
    entryFile: row.entry_file,
    envKind: row.env_kind,
    sshHostId: row.ssh_host_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunId: row.last_run_id
  }
}

export function mapRun(row: RunRow): ExperimentRun {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    projectId: row.project_id,
    status: row.status,
    exitCode: row.exit_code,
    command: row.command,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stdout: row.stdout,
    stderr: row.stderr,
    metrics: parseJson<Record<string, number | string>>(row.metrics_json, {}),
    artifactDir: row.artifact_dir
  }
}

const DEFAULT_EXPERIMENT = `"""ResearchPilot experiment.

Write the smallest reproducible experiment that tests one claim.
Outputs should be written to os.environ["RESEARCHPILOT_RUN_DIR"].
Emit metrics as JSON on a line prefixed with RESEARCHPILOT_METRIC:.
"""
import json
import os
import random

import numpy as np

RUN_DIR = os.environ.get("RESEARCHPILOT_RUN_DIR", ".")
SEED = 42
random.seed(SEED)
np.random.seed(SEED)


def main() -> None:
    # TODO: implement the experiment. Keep baselines, seeds and metrics explicit.
    values = np.random.normal(size=200)
    result = {
        "metric": "mean",
        "value": float(values.mean()),
        "n": int(values.size),
        "seed": SEED,
    }
    print("RESEARCHPILOT_METRIC:" + json.dumps(result, ensure_ascii=False))
    with open(os.path.join(RUN_DIR, "metrics.json"), "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    print("Experiment finished. Artifacts in", RUN_DIR)


if __name__ == "__main__":
    main()
`

export class ExperimentService {
  constructor(private readonly db: Db) {}

  private projectRoot(projectId: string): string {
    const row = this.db.get<ProjectRow>('SELECT id, root_path FROM projects WHERE id = ?', projectId)
    if (!row) throw new Error('项目不存在。')
    return row.root_path
  }

  list(projectId: string): Experiment[] {
    return this.db
      .all<ExperimentRow>('SELECT * FROM experiments WHERE project_id = ? ORDER BY updated_at DESC', projectId)
      .map(mapExperiment)
  }

  get(id: string): Experiment {
    const row = this.db.get<ExperimentRow>('SELECT * FROM experiments WHERE id = ?', id)
    if (!row) throw new Error('实验不存在。')
    return mapExperiment(row)
  }

  create(input: ExperimentInput): Experiment {
    const root = this.projectRoot(input.projectId)
    const id = newId('exp')
    const folder = `${slugify(input.name, 'experiment').slice(0, 24)}-${id.slice(-12)}`
    const relativeDir = `experiments/${folder}`
    ensureFigureDir(root, 'experiments')
    const experimentDir = figurePath(root, relativeDir)
    mkdirSync(experimentDir) // Fresh exclusive directory; never reuse an attacker-prepared source folder.
    const codePath = figurePath(root, `${relativeDir}/main.py`)
    writeFileSync(codePath, input.code ?? DEFAULT_EXPERIMENT, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    ensureFigureDir(root, `${relativeDir}/runs`)
    const timestamp = nowIso()
    this.db.run(
      `INSERT INTO experiments (id, project_id, name, description, language, entry_file, env_kind, ssh_host_id, status, last_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'python', ?, ?, ?, 'idle', '', ?, ?)`,
      id,
      input.projectId,
      input.name.trim() || '未命名实验',
      input.description?.trim() ?? '',
      relativePath(root, codePath),
      input.envKind ?? 'local',
      input.sshHostId ?? '',
      timestamp,
      timestamp
    )
    return this.get(id)
  }

  update(id: string, patch: { name?: string; description?: string; envKind?: 'local' | 'ssh'; sshHostId?: string }): Experiment {
    const current = this.get(id)
    this.db.run(
      'UPDATE experiments SET name = ?, description = ?, env_kind = ?, ssh_host_id = ?, updated_at = ? WHERE id = ?',
      patch.name?.trim() || current.name,
      patch.description ?? current.description,
      patch.envKind ?? current.envKind,
      patch.sshHostId ?? current.sshHostId,
      nowIso(),
      id
    )
    return this.get(id)
  }

  delete(id: string): void {
    const experiment = this.get(id)
    const root = this.projectRoot(experiment.projectId)
    const folder = dirname(join(root, experiment.entryFile))
    if (existsSync(folder)) {
      const trash = ensureDir(join(root, '.research', 'trash'))
      try {
        renameSync(folder, join(trash, `${experiment.id}-${folder.split(/[\\/]/).pop()}`))
      } catch {
        // Keep files when the move fails.
      }
    }
    this.db.run('DELETE FROM experiments WHERE id = ?', id)
  }

  readCode(id: string): string {
    const experiment = this.get(id)
    const root = this.projectRoot(experiment.projectId)
    const abs = join(root, experiment.entryFile)
    return existsSync(abs) ? readFileSync(abs, 'utf8') : ''
  }

  saveCode(id: string, code: string): Experiment {
    const experiment = this.get(id)
    const root = this.projectRoot(experiment.projectId)
    const abs = join(root, experiment.entryFile)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, code, 'utf8')
    this.db.run('UPDATE experiments SET updated_at = ? WHERE id = ?', nowIso(), id)
    return this.get(id)
  }

  experimentDir(id: string): string {
    const experiment = this.get(id)
    return dirname(join(this.projectRoot(experiment.projectId), experiment.entryFile))
  }

  createRun(experiment: Experiment, command: string, artifactDir: string, env: Record<string, string>, id = newId('run')): ExperimentRun {
    if (!experiment.sshHostId && experiment.envKind === 'ssh') throw new Error('该实验标记为远程运行，但未选择 SSH 主机。')
    const startedAt = nowIso()
    this.db.run(
      `INSERT INTO experiment_runs (id, experiment_id, project_id, status, exit_code, command, started_at, finished_at, stdout, stderr, metrics_json, artifact_dir, env_json)
       VALUES (?, ?, ?, 'running', NULL, ?, ?, '', '', '', '{}', ?, ?)`,
      id,
      experiment.id,
      experiment.projectId,
      command,
      startedAt,
      artifactDir,
      JSON.stringify(env)
    )
    this.db.run('UPDATE experiments SET status = ?, last_run_id = ?, updated_at = ? WHERE id = ?', 'running', id, nowIso(), experiment.id)
    return this.getRun(id)
  }

  updateRun(
    id: string,
    patch: Partial<{
      status: ExperimentStatus
      exitCode: number | null
      stdout: string
      stderr: string
      metrics: Record<string, number | string>
      finishedAt: string
    }>
  ): ExperimentRun {
    const current = this.getRun(id)
    this.db.run(
      'UPDATE experiment_runs SET status = ?, exit_code = ?, stdout = ?, stderr = ?, metrics_json = ?, finished_at = ? WHERE id = ?',
      patch.status ?? current.status,
      patch.exitCode === undefined ? current.exitCode : patch.exitCode,
      patch.stdout ?? current.stdout,
      patch.stderr ?? current.stderr,
      JSON.stringify(patch.metrics ?? current.metrics),
      patch.finishedAt ?? current.finishedAt,
      id
    )
    const run = this.getRun(id)
    if (patch.status && patch.status !== 'running' && patch.status !== 'queued') {
      this.db.run('UPDATE experiments SET status = ?, updated_at = ? WHERE id = ?', patch.status, nowIso(), run.experimentId)
    }
    return run
  }

  getRun(id: string): ExperimentRun {
    const row = this.db.get<RunRow>('SELECT * FROM experiment_runs WHERE id = ?', id)
    if (!row) throw new Error('实验运行不存在。')
    return mapRun(row)
  }

  runs(experimentId: string): ExperimentRun[] {
    return this.db
      .all<RunRow>('SELECT * FROM experiment_runs WHERE experiment_id = ? ORDER BY started_at DESC LIMIT 100', experimentId)
      .map(mapRun)
  }

  markInterrupted(): void {
    const timestamp = nowIso()
    this.db.run(
      "UPDATE experiment_runs SET status = 'failed', finished_at = ?, stderr = stderr || char(10) || '[ResearchPilot] 应用退出，运行被中断。' WHERE status IN ('running','queued')",
      timestamp
    )
    this.db.run("UPDATE experiments SET status = 'failed' WHERE status IN ('running','queued')")
  }

  recentRuns(projectId: string, limit = 10): ExperimentRun[] {
    return this.db
      .all<RunRow>('SELECT * FROM experiment_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?', projectId, limit)
      .map(mapRun)
  }

  openArtifact(runId: string): void {
    const run = this.getRun(runId)
    const experiment = this.get(run.experimentId)
    const root = this.projectRoot(experiment.projectId)
    const abs = join(root, run.artifactDir)
    shell.showItemInFolder(abs)
  }
}
