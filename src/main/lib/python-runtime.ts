import { spawnSync } from 'node:child_process'

const probes = new Map<string, { checkedAt: number; available: boolean }>()

export function supportedPythonVersion(output: string): boolean {
  const version = output.match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/)
  return Boolean(version && Number(version[1]) === 3 && Number(version[2]) >= 10)
}

export function pythonCommandAvailable(command: string): boolean {
  if (!command.trim()) return false
  const cached = probes.get(command)
  if (cached && Date.now() - cached.checkedAt < 30_000) return cached.available
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 4000, windowsHide: true, shell: false })
  const available = result.status === 0 && supportedPythonVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  probes.set(command, { checkedAt: Date.now(), available })
  return available
}
