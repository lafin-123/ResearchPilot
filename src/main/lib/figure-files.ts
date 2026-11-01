import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Lexical + existing-ancestor checks. Reject traversal, alternate streams, links/junctions and hardlinked files. */
export function figurePath(root: string, path: string): string {
  if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || /[:\x00-\x1f]/.test(path)) throw new Error('Invalid figure path')
  const segments = path.split(/[\\/]/)
  if (segments.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw new Error('Figure path traversal is not allowed')
  const base = resolve(root); const target = resolve(base, ...segments)
  const rel = relative(base, target)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Figure path escapes project workspace')
  // Check the root's ancestors too: a project stored beneath a junction must not bypass this guard.
  const ancestors: string[] = []
  let current = target
  for (;;) {
    ancestors.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const entry of ancestors.reverse()) {
    let stat
    try { stat = lstatSync(entry) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error('Figure symlinks and junctions are not allowed')
    if (entry !== target && !stat.isDirectory()) throw new Error('Figure path ancestor is not a directory')
    if (stat.isFile() && stat.nlink > 1) throw new Error('Hardlinked figure files are not allowed')
  }
  const actualRoot = realpathSync(base)
  if (process.platform === 'win32' ? actualRoot.toLowerCase() !== base.toLowerCase() : actualRoot !== base) throw new Error('Project workspace resolves through a link')
  return target
}

export function ensureFigureDir(root: string, path: string): string {
  const target = figurePath(root, path)
  mkdirSync(target, { recursive: true })
  figurePath(root, path)
  return target
}

export function readFigureFile(root: string, path: string, maxBytes = 32 * 1024 * 1024): Buffer {
  const target = figurePath(root, path)
  const stat = lstatSync(target)
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('Figure file is not a regular file or exceeds size limit')
  return readFileSync(target)
}
