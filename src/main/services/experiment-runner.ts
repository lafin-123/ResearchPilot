import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import type { Experiment, ExperimentRun } from '@shared/types'
import { assertProjectRootAvailable } from './project-health'
import { emitEvent } from '../lib/events'
import { accountDataRoot, ensureDir, projectPath, relativePath } from '../lib/paths'
import { newId, truncate } from '../lib/util'
import { pythonCommandAvailable } from '../lib/python-runtime'
import { detectPackages } from '../lib/python-packages'
export { detectPackages } from '../lib/python-packages'
import type { ExperimentService } from './experiments'
import type { SettingsService } from './settings'
import type { SshService } from './ssh'

interface RunningLocal {
  kind: 'local'
  child: ChildProcess
  runId: string
  stdout: string
  stderr: string
  cancelled: boolean
  timer: NodeJS.Timeout | null
}

interface RunningRemote {
  kind: 'remote'
  runId: string
  stdout: string
  stderr: string
  cancelled: boolean
}

type Running = RunningLocal | RunningRemote

const OUTPUT_LIMIT = 2_000_000
const METRIC_PATTERN = /RESEARCHPILOT_METRIC:\s*(\{[^\n]*\})/g

export function commandExists(command: string): boolean {
  if (!command) return false
  if (command.includes('/') || command.includes('\\')) return existsSync(command)
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  return spawnSync(lookup, [command], { stdio: 'ignore', shell: false }).status === 0
}

export interface PythonLaunch {
  command: string
  prefixArgs: string[]
  label: string
}

export function resolvePythonLaunch(settings: SettingsService, packages: string[] = []): PythonLaunch {
  const configured = settings.get().pythonPath.trim()
  if (configured) {
    if (!pythonCommandAvailable(configured)) throw new Error('配置的 Python 解释器不可用或版本低于 3.10。请在设置中填写实际解释器路径。')
    return { command: configured, prefixArgs: [], label: configured }
  }
  if (commandExists('uv')) {
    const args = ['run', '--no-project', '--python', '3.12']
    for (const name of packages) args.push('--with', name)
    args.push('python')
    return { command: 'uv', prefixArgs: args, label: `uv (${packages.join(', ') || 'base'})` }
  }
  for (const candidate of ['python', 'python3', 'py']) {
    if (pythonCommandAvailable(candidate)) return { command: candidate, prefixArgs: [], label: candidate }
  }
  throw new Error('未找到可用的 Python。请安装 Python 3.10+，或在设置中填写解释器路径。')
}

function parseMetrics(stdout: string, artifactDir: string): Record<string, number | string> {
  const metrics: Record<string, number | string> = {}
  for (const match of stdout.matchAll(METRIC_PATTERN)) {
    try {
      const parsed = JSON.parse(match[1] ?? '{}') as Record<string, unknown>
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'number' || typeof value === 'string') metrics[key] = value
        else if (typeof value === 'boolean') metrics[key] = value ? 'true' : 'false'
        else if (value !== null && value !== undefined) metrics[key] = JSON.stringify(value)
      }
    } catch {
      // A metric line that is not valid JSON is ordinary experiment output.
    }
  }
  const metricsFile = join(artifactDir, 'metrics.json')
  if (existsSync(metricsFile)) {
    try {
      const parsed = JSON.parse(readFileSync(metricsFile, 'utf8')) as Record<string, unknown>
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'number' || typeof value === 'string') metrics[key] = value
        else if (typeof value === 'boolean') metrics[key] = value ? 'true' : 'false'
      }
    } catch {
      // Ignore malformed metrics.json.
    }
  }
  return metrics
}

export class ExperimentRunner {
  private running = new Map<string, Running>()

  constructor(
    private readonly db: import('../lib/db').Db,
    private readonly settings: SettingsService,
    private readonly experiments: ExperimentService,
    private readonly ssh: SshService
  ) {}

  isRunning(runId: string): boolean {
    return this.running.has(runId)
  }

  runningCount(): number {
    return this.running.size
  }

  private projectRoot(projectId: string): string {
    const row = this.db.get<{ root_path: string }>('SELECT root_path FROM projects WHERE id = ?', projectId)
    if (!row) throw new Error('项目不存在。')
    assertProjectRootAvailable({ rootPath: row.root_path })
    return row.root_path
  }

  private artifactDir(experiment: Experiment, runId: string): { abs: string; relative: string } {
    const root = this.projectRoot(experiment.projectId)
    const expDir = this.experiments.experimentDir(experiment.id)
    const abs = join(expDir, 'runs', runId)
    ensureDir(abs)
    return { abs, relative: relativePath(root, abs) }
  }

  async start(experimentId: string): Promise<ExperimentRun> {
    const experiment = this.experiments.get(experimentId)
    const max = this.settings.get().maxConcurrentRuns
    if (this.running.size >= max) {
      throw new Error(`已有 ${this.running.size} 个实验在运行，达到并发上限 ${max}。请等待或调高设置中的并发上限。`)
    }

    const runId = newId('run')
    const artifact = this.artifactDir(experiment, runId)
    const root = this.projectRoot(experiment.projectId)
    const expDir = this.experiments.experimentDir(experiment.id)
    const entryAbs = join(root, experiment.entryFile)
    if (!existsSync(entryAbs)) throw new Error('实验代码文件不存在，请先保存代码。')

    if (experiment.envKind === 'ssh' && experiment.sshHostId) {
      return this.startRemote(experiment, runId, artifact, expDir, entryAbs)
    }
    return this.startLocal(experiment, runId, artifact, expDir, entryAbs)
  }

  private startLocal(
    experiment: Experiment,
    runId: string,
    artifact: { abs: string; relative: string },
    expDir: string,
    entryAbs: string
  ): ExperimentRun {
    const configured = this.settings.get().pythonPath.trim()
    const packages = detectPackages(this.experiments.readCode(experiment.id), Boolean(configured && pythonCommandAvailable(configured)))
    const launch = resolvePythonLaunch(this.settings, packages)
    const args = [...launch.prefixArgs, entryAbs]
    const env = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      MPLBACKEND: 'Agg',
      RESEARCHPILOT_RUN_DIR: artifact.abs,
      RESEARCHPILOT_EXPERIMENT_DIR: expDir,
      RESEARCHPILOT_PROJECT_ROOT: this.projectRoot(experiment.projectId),
      UV_CACHE_DIR: join(accountDataRoot(), 'uv-cache')
    }
    const command = `${launch.command} ${args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`
    const run = this.experiments.createRun(experiment, command, artifact.relative, {
      PYTHONUNBUFFERED: '1',
      MPLBACKEND: 'Agg',
      RESEARCHPILOT_RUN_DIR: artifact.abs
    }, runId)
    emitEvent({ type: 'experiment-update', projectId: experiment.projectId, run })

    const child = spawn(launch.command, args, { cwd: expDir, env, windowsHide: true })
    const state: RunningLocal = { kind: 'local', child, runId, stdout: '', stderr: '', cancelled: false, timer: null }
    this.running.set(runId, state)

    const persist = (force = false): void => {
      if (!force && state.timer !== null) return
      const update = (): void => {
        state.timer = null
        const current = this.experiments.updateRun(runId, {
          stdout: truncate(state.stdout, OUTPUT_LIMIT),
          stderr: truncate(state.stderr, OUTPUT_LIMIT)
        })
        emitEvent({ type: 'experiment-update', projectId: experiment.projectId, run: current })
      }
      state.timer = setTimeout(update, force ? 0 : 700)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      state.stdout = truncate(state.stdout + chunk.toString('utf8'), OUTPUT_LIMIT)
      persist()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      state.stderr = truncate(state.stderr + chunk.toString('utf8'), OUTPUT_LIMIT)
      persist()
    })
    child.on('error', (error) => {
      state.stderr += `\nResearchPilot: 无法启动进程：${error.message}\n`
      this.finishLocal(experiment, runId, state, null, artifact.abs)
    })
    child.on('close', (code) => {
      this.finishLocal(experiment, runId, state, code, artifact.abs)
    })

    return run
  }

  private finishLocal(experiment: Experiment, runId: string, state: RunningLocal, code: number | null, artifactAbs: string): void {
    if (!this.running.has(runId)) return
    if (state.timer) clearTimeout(state.timer)
    this.running.delete(runId)
    const status = state.cancelled ? 'cancelled' : code === 0 ? 'succeeded' : 'failed'
    const metrics = parseMetrics(state.stdout + '\n' + state.stderr, artifactAbs)
    const run = this.experiments.updateRun(runId, {
      status,
      exitCode: code,
      stdout: truncate(state.stdout, OUTPUT_LIMIT),
      stderr: truncate(state.stderr, OUTPUT_LIMIT),
      metrics,
      finishedAt: new Date().toISOString()
    })
    this.writeArtifacts(artifactAbs, experiment.id, runId, run.stdout, run.stderr, metrics, { status, exitCode: code, environment: 'local', startedAt: run.startedAt })
    emitEvent({ type: 'experiment-update', projectId: experiment.projectId, run })
  }

  private async startRemote(
    experiment: Experiment,
    runId: string,
    artifact: { abs: string; relative: string },
    expDir: string,
    entryAbs: string
  ): Promise<ExperimentRun> {
    const host = this.ssh.get(experiment.sshHostId)
    const remoteHomeResult = await this.ssh.exec(host.id, 'printf %s "$HOME"', { timeoutMs: 20_000 })
    const remoteHome = remoteHomeResult.stdout.trim()
    this.projectRoot(experiment.projectId)
    if (remoteHomeResult.exitCode !== 0 || !remoteHome) throw new Error('无法读取远程 HOME 目录。')
    const base = (host.workspacePath || '~/researchpilot').replace(/^~/, remoteHome)
    const expFolder = basename(expDir)
    const remoteDir = `${base}/projects/${experiment.projectId}/experiments/${expFolder}`
    const remoteRunDir = `${remoteDir}/runs/${runId}`
    const entryRelative = relative(expDir, entryAbs).split('\\').join('/')
    const command = `cd ${this.ssh.quote(remoteDir)} && mkdir -p ${this.ssh.quote(remoteRunDir)} && RESEARCHPILOT_RUN_DIR=${this.ssh.quote(remoteRunDir)} RESEARCHPILOT_EXPERIMENT_DIR=${this.ssh.quote(remoteDir)} PYTHONUNBUFFERED=1 MPLBACKEND=Agg python3 ${this.ssh.quote(entryRelative)}`

    const run = this.experiments.createRun(experiment, `ssh ${host.name}: ${command}`, artifact.relative, {
      remoteDir,
      remoteRunDir,
      host: host.name
    }, runId)
    emitEvent({ type: 'experiment-update', projectId: experiment.projectId, run })

    const state: RunningRemote = { kind: 'remote', runId, stdout: '', stderr: '', cancelled: false }
    this.running.set(runId, state)
    mkdirSync(artifact.abs, { recursive: true })

    void (async () => {
      let exitCode: number | null = null
      try {
        await this.ssh.uploadDirectory(host.id, expDir, remoteDir)
        const result = await this.ssh.exec(host.id, command, {
          timeoutMs: 24 * 60 * 60 * 1000,
          onData: (chunk, stream) => {
            if (stream === 'stdout') state.stdout = truncate(state.stdout + chunk, OUTPUT_LIMIT)
            else state.stderr = truncate(state.stderr + chunk, OUTPUT_LIMIT)
          }
        })
        exitCode = result.exitCode
        if (exitCode !== 0) state.stderr += result.stderr
        try {
          this.projectRoot(experiment.projectId)
          await this.ssh.downloadDirectory(host.id, remoteRunDir, artifact.abs, () => { this.projectRoot(experiment.projectId) })
        } catch (downloadError) {
          state.stderr += `\nResearchPilot: 远程产物下载失败：${downloadError instanceof Error ? downloadError.message : String(downloadError)}\n`
        }
      } catch (error) {
        state.stderr += `\n${error instanceof Error ? error.message : String(error)}\n`
        exitCode = -1
      } finally {
        this.running.delete(runId)
        const status = state.cancelled ? 'cancelled' : exitCode === 0 ? 'succeeded' : 'failed'
        const metrics = parseMetrics(state.stdout + '\n' + state.stderr, artifact.abs)
        const finalRun = this.experiments.updateRun(runId, {
          status,
          exitCode,
          stdout: truncate(state.stdout, OUTPUT_LIMIT),
          stderr: truncate(state.stderr, OUTPUT_LIMIT),
          metrics,
          finishedAt: new Date().toISOString()
        })
        this.writeArtifacts(artifact.abs, experiment.id, runId, finalRun.stdout, finalRun.stderr, metrics, { status, exitCode, environment: 'ssh', startedAt: finalRun.startedAt })
        emitEvent({ type: 'experiment-update', projectId: experiment.projectId, run: finalRun })
      }
    })()

    return run
  }

  private writeArtifacts(
    artifactDir: string,
    experimentId: string,
    runId: string,
    stdout: string,
    stderr: string,
    metrics: Record<string, number | string>,
    meta: { status: string; exitCode: number | null; environment: string; startedAt: string }
  ): void {
    try {
      this.projectRoot(this.experiments.get(experimentId).projectId)
      mkdirSync(artifactDir, { recursive: true })
      writeFileSync(join(artifactDir, 'stdout.txt'), stdout, 'utf8')
      writeFileSync(join(artifactDir, 'stderr.txt'), stderr, 'utf8')
      writeFileSync(join(artifactDir, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8')
      const rawSeeds = metrics.seeds ?? metrics.seed
      const seeds = Array.isArray(rawSeeds) ? rawSeeds : rawSeeds === undefined ? [] : [rawSeeds]
      writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify({
        experimentId,
        runId,
        command: this.experiments.getRun(runId).command,
        environment: meta.environment,
        startedAt: meta.startedAt,
        finishedAt: new Date().toISOString(),
        status: meta.status,
        exitCode: meta.exitCode,
        seeds
      }, null, 2), 'utf8')
    } catch {
      // Artifact writing is best-effort; the run record still carries logs and metrics.
    }
  }

  stop(runId: string): void {
    const state = this.running.get(runId)
    if (!state) throw new Error('该运行已结束。')
    if (state.kind === 'remote') throw new Error('远程实验暂不支持中途停止，请等待其完成或登录远程主机终止。')
    state.cancelled = true
    const pid = state.child.pid
    if (!pid) return
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    } else {
      state.child.kill('SIGTERM')
      setTimeout(() => {
        if (!state.child.killed) state.child.kill('SIGKILL')
      }, 3000)
    }
  }

  async waitForRun(runId: string, timeoutMs = 15 * 60 * 1000): Promise<ExperimentRun> {
    const started = Date.now()
    for (;;) {
      const run = this.experiments.getRun(runId)
      if (run.status !== 'running' && run.status !== 'queued') return run
      if (Date.now() - started > timeoutMs) return run
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  async runAndWait(experimentId: string, timeoutMs = 15 * 60 * 1000): Promise<ExperimentRun> {
    const run = await this.start(experimentId)
    return this.waitForRun(run.id, timeoutMs)
  }

  shutdown(): void {
    for (const state of this.running.values()) {
      if (state.kind === 'local') {
        state.cancelled = true
        const pid = state.child.pid
        if (pid && process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
        else state.child.kill('SIGKILL')
      }
    }
    this.running.clear()
  }
}
