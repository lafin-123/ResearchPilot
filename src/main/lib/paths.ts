import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { app } from 'electron'
import type { Project } from '@shared/types'

export const PROJECT_DIRS = [
  'manuscripts',
  'references',
  'experiments',
  'figures',
  'data',
  'exports',
  '.research',
  '.research/bin',
  '.research/history',
  '.agents',
  '.agents/skills'
] as const

export function bundledResource(...segments: string[]): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return join(base, ...(app.isPackaged ? segments : ['resources', ...segments]))
}

let accountPaths: { dataRoot: string; workspaceRoot: string } | null = null

/** Set only by the main-process local workspace lifecycle, never from renderer input. */
export function setAccountPaths(paths: { dataRoot: string; workspaceRoot: string } | null): void {
  accountPaths = paths
}

export function accountDataRoot(): string {
  if (!accountPaths) throw new Error('本地工作区尚未就绪或正在关闭。')
  return accountPaths.dataRoot
}

export function defaultWorkspaceRoot(): string {
  if (accountPaths) return accountPaths.workspaceRoot
  if (!app.isPackaged && process.env.RESEARCHPILOT_WORKSPACE_ROOT) return resolve(process.env.RESEARCHPILOT_WORKSPACE_ROOT)
  return join(app.getPath('documents'), 'ResearchPilot')
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true })
  return path
}

export function projectPath(project: Project, ...segments: string[]): string {
  return resolve(project.rootPath, ...segments)
}

export function assertInside(root: string, target: string): string {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(target)
  const comparison = process.platform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget
  const rootComparison = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot
  if (comparison !== rootComparison && !comparison.startsWith(rootComparison + sep)) {
    throw new Error('目标路径超出项目工作区，已拒绝访问。')
  }
  return resolvedTarget
}

export function relativePath(root: string, target: string): string {
  return relative(root, target).split(sep).join('/')
}

export function absoluteFromRelative(root: string, relativeFilePath: string): string {
  return assertInside(root, resolve(root, relativeFilePath))
}

export function readBridgeConfig(root: string): { port: number; token: string; projectId: string } | undefined {
  const file = join(root, '.research', 'bridge.json')
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { port: number; token: string; projectId: string }
  } catch {
    return undefined
  }
}

export function writeBridgeConfig(root: string, config: { port: number; token: string; projectId: string }): void {
  ensureDir(join(root, '.research'))
  writeFileSync(join(root, '.research', 'bridge.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

const MANAGED_AGENTS = `# ResearchPilot workspace

This is a ResearchPilot project. The agent is expected to behave like a careful research collaborator.

## Ground rules

- Evidence before prose. Do not describe results that were not produced by an executed experiment or a cited source.
- Experiments come before paper writing. The default workflow is literature review → hypothesis → experiment design → execution → analysis → figures → manuscript → review.
- Keep every artifact inside this project. Manuscripts live in \`manuscripts/\`, experiment code and outputs in \`experiments/\`, figures in \`figures/\`, references in \`references/\`.
- Use the ResearchPilot bridge for structured actions instead of ad-hoc file edits where a command exists:

  \`research status\`
  \`research docs list\`
  \`research refs search --query "topic"\`
  \`research exps create --name "name" --code-file exp.py\`
  \`research exps run --id <id>\`
  \`research figs render --name "figure-name" --code-file plot.py\`

- Report uncertainty explicitly. A missing result is a finding, not something to invent.
- Save long-form outputs as files in the workspace so the user can inspect them, then summarize them in chat.
`

export function ensureProjectLayout(project: Project): void {
  for (const dir of PROJECT_DIRS) ensureDir(join(project.rootPath, dir))

  const manifestPath = join(project.rootPath, '.research', 'manifest.json')
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, `${JSON.stringify({ version: 1, projectId: project.id, name: project.name, createdAt: project.createdAt }, null, 2)}\n`, 'utf8')
  }

  const bridgeSource = bundledResource('bridge')
  const bridgeTarget = join(project.rootPath, '.research', 'bin')
  if (existsSync(bridgeSource)) {
    for (const entry of ['research-cli.ps1', 'research.cmd', 'research.sh']) {
      const source = join(bridgeSource, entry)
      const target = join(bridgeTarget, entry)
      if (existsSync(source)) {
        try {
          cpSync(source, target)
          if (entry.endsWith('.sh')) chmodSync(target, 0o755)
        } catch {
          // Best-effort; the bridge can still be used through HTTP directly.
        }
      }
    }
  }

  const agentsPath = join(project.rootPath, 'AGENTS.md')
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, MANAGED_AGENTS, 'utf8')
  }
}
