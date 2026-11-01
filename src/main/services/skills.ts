import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { shell } from 'electron'
import yaml from 'js-yaml'
import type { SkillDetail, SkillDiscovery, SkillDiscoveryResult, SkillInput, SkillInstallResult, SkillRecord, SkillScope } from '@shared/types'
import type { Db } from '../lib/db'
import { accountDataRoot, bundledResource, ensureDir } from '../lib/paths'
import { newId } from '../lib/util'

interface SkillMeta {
  name: string
  description: string
  whenToUse: string
  path: string
  relativePath: string
  resources: { references: number; templates: number; scripts: number; evals: number; assets: number }
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  let count = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(join(dir, entry.name))
    else if (entry.isFile()) count += 1
  }
  return count
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function parseFrontmatter(filePath: string): { meta: Record<string, unknown>; body: string } | null {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return null
  try {
    const meta = yaml.load(match[1] ?? '') as Record<string, unknown>
    if (!meta || typeof meta !== 'object') return null
    return { meta, body: match[2] ?? '' }
  } catch {
    return null
  }
}

function readSkill(filePath: string, root: string): SkillMeta | null {
  const parsed = parseFrontmatter(filePath)
  if (!parsed) return null
  const name = String(parsed.meta.name ?? '')
  const description = String(parsed.meta.description ?? '')
  if (!NAME_PATTERN.test(name) || !description.trim()) return null
  const baseDir = filePath.endsWith('SKILL.md') ? dirname(filePath) : null
  return {
    name,
    description,
    whenToUse: String(parsed.meta.whenToUse ?? ''),
    path: filePath,
    relativePath: relative(root, filePath).replaceAll(String.fromCharCode(92), '/'),
    resources: {
      references: baseDir ? countFiles(join(baseDir, 'references')) : 0,
      templates: baseDir ? countFiles(join(baseDir, 'templates')) : 0,
      scripts: baseDir ? countFiles(join(baseDir, 'scripts')) : 0,
      evals: baseDir ? countFiles(join(baseDir, 'evals')) : 0,
      assets: baseDir ? countFiles(join(baseDir, 'assets')) : 0
    }
  }
}

export class SkillService {
  private discoveries = new Map<string, { root: string; sources: Map<string, string>; label: string }>()

  constructor(private readonly db: Db) {}

  private projectRoot(projectId: string): string {
    const row = this.db.get<{ root_path: string }>('SELECT root_path FROM projects WHERE id = ?', projectId)
    if (!row) throw new Error('项目不存在。')
    return row.root_path
  }

  private builtinRoot(): string {
    return bundledResource('skills')
  }

  private globalRoot(): string {
    return ensureDir(join(accountDataRoot(), 'dsh-home', 'skills'))
  }

  private projectSkillsRoot(projectId: string): string {
    return join(this.projectRoot(projectId), '.agents', 'skills')
  }

  private rootFor(projectId: string, scope: SkillScope): string {
    if (scope === 'builtin') return this.builtinRoot()
    if (scope === 'global') return this.globalRoot()
    return this.projectSkillsRoot(projectId)
  }

  private scan(root: string, scope: SkillScope): Array<SkillMeta & { scope: SkillScope }> {
    if (!existsSync(root)) return []
    const entries = readdirSync(root, { withFileTypes: true })
    const found: Array<SkillMeta & { scope: SkillScope }> = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(root, entry.name)
      let file: string | null = null
      if (entry.isDirectory()) {
        const candidate = join(full, 'SKILL.md')
        if (existsSync(candidate)) file = candidate
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        file = full
      }
      if (!file) continue
      const meta = readSkill(file, root)
      if (meta) found.push({ ...meta, scope })
    }
    return found
  }

  list(projectId: string): SkillRecord[] {
    const builtin = this.scan(this.builtinRoot(), 'builtin')
    const project = this.scan(this.projectSkillsRoot(projectId), 'project')
    const global = this.scan(this.globalRoot(), 'global')
    const builtinNames = new Set(builtin.map((item) => item.name))
    const toRecord = (item: SkillMeta & { scope: SkillScope }): SkillRecord => ({
      name: item.name,
      description: item.description,
      whenToUse: item.whenToUse,
      scope: item.scope,
      path: item.path,
      relativePath: item.relativePath,
      editable: item.scope !== 'builtin',
      builtinCopy: item.scope !== 'builtin' && builtinNames.has(item.name),
      overridesBuiltin: item.scope !== 'builtin' && builtinNames.has(item.name),
      resources: item.resources
    })
    return [...builtin.map(toRecord), ...project.map(toRecord), ...global.map(toRecord)]
  }

  get(projectId: string, scope: SkillScope, name: string): SkillDetail {
    const root = this.rootFor(projectId, scope)
    const found = this.scan(root, scope).find((item) => item.name === name)
    if (!found) throw new Error('技能不存在。')
    const record = this.list(projectId).find((item) => item.scope === scope && item.name === name)
    if (!record) throw new Error('技能不存在。')
    return { ...record, content: readFileSync(found.path, 'utf8') }
  }

  private validateName(name: string): string {
    const trimmed = name.trim()
    if (!NAME_PATTERN.test(trimmed)) throw new Error('技能名称只能使用小写字母、数字和连字符，例如 paper-writing。')
    return trimmed
  }

  private normalizeBody(body: string): string {
    const text = body.replace(/^\uFEFF/, '').trim()
    if (!text) throw new Error('技能内容不能为空。')
    const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text)
    return (match?.[1] ?? text).trim()
  }

  private serialize(input: { name: string; description: string; whenToUse: string; body: string }): string {
    const front = yaml.dump({
      name: input.name,
      description: input.description.trim(),
      whenToUse: input.whenToUse.trim(),
      'user-invocable': true
    }, { lineWidth: 120 })
    return `---\n${front}---\n\n${this.normalizeBody(input.body)}\n`
  }

  private targetPath(projectId: string, scope: 'project' | 'global', name: string): string {
    return join(this.rootFor(projectId, scope), name)
  }

  create(input: SkillInput): SkillRecord {
    const name = this.validateName(input.name)
    if (!input.description.trim()) throw new Error('技能描述不能为空。')
    const target = this.targetPath(input.projectId, input.scope, name)
    if (existsSync(target)) throw new Error(`技能 ${name} 已存在。`)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), this.serialize({ name, description: input.description, whenToUse: input.whenToUse, body: input.body }), 'utf8')
    return this.findRecord(input.projectId, input.scope, name)
  }

  update(input: SkillInput): SkillRecord {
    const name = this.validateName(input.name)
    const current = this.get(input.projectId, input.scope, name)
    if (!current.editable) throw new Error('内置技能为只读，请先复制到项目或全局技能目录再编辑。')
    writeFileSync(current.path, this.serialize({ name, description: input.description, whenToUse: input.whenToUse, body: input.body }), 'utf8')
    return this.findRecord(input.projectId, input.scope, name)
  }

  remove(projectId: string, scope: 'project' | 'global', name: string): void {
    const skill = this.get(projectId, scope, name)
    const target = skill.path.endsWith('SKILL.md') ? dirname(skill.path) : skill.path
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const trash = scope === 'project'
      ? join(this.projectRoot(projectId), '.research', 'trash', 'skills')
      : join(accountDataRoot(), 'skill-trash')
    ensureDir(trash)
    renameSync(target, join(trash, `${name}-${stamp}`))
  }

  copyBuiltin(projectId: string, name: string, targetScope: 'project' | 'global'): SkillRecord {
    const source = this.get(projectId, 'builtin', name)
    const target = this.targetPath(projectId, targetScope, name)
    if (existsSync(target)) throw new Error(`目标位置已有技能 ${name}。`)
    const sourceDir = source.path.endsWith('SKILL.md') ? join(source.path, '..') : null
    if (sourceDir) {
      cpSync(sourceDir, target, { recursive: true })
    } else {
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'SKILL.md'), source.content, 'utf8')
    }
    return this.findRecord(projectId, targetScope, name)
  }

  importSkill(projectId: string, targetScope: 'project' | 'global', sourcePath: string): SkillRecord {
    if (!existsSync(sourcePath)) throw new Error('导入路径不存在。')
    const stat = statSync(sourcePath)
    if (stat.isDirectory()) {
      const skillFile = join(sourcePath, 'SKILL.md')
      const meta = readSkill(skillFile, sourcePath)
      if (!meta) throw new Error('目录中没有有效的 SKILL.md（需要 name 和 description frontmatter）。')
      const target = this.targetPath(projectId, targetScope, meta.name)
      if (existsSync(target)) throw new Error(`技能 ${meta.name} 已存在。`)
      cpSync(sourcePath, target, { recursive: true })
      return this.findRecord(projectId, targetScope, meta.name)
    }
    const content = readFileSync(sourcePath, 'utf8')
    return this.importContent(projectId, targetScope, content)
  }

  importContent(projectId: string, targetScope: 'project' | 'global', content: string): SkillRecord {
    const parsed = parseFrontmatterFromText(content)
    if (!parsed) throw new Error('内容缺少 YAML frontmatter（至少需要 name 和 description）。')
    const name = this.validateName(String(parsed.meta.name ?? ''))
    const description = String(parsed.meta.description ?? '')
    if (!description.trim()) throw new Error('frontmatter 缺少 description。')
    const target = this.targetPath(projectId, targetScope, name)
    if (existsSync(target)) throw new Error(`技能 ${name} 已存在。`)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), content, 'utf8')
    return this.findRecord(projectId, targetScope, name)
  }

  private findRecord(projectId: string, scope: SkillScope, name: string): SkillRecord {
    const record = this.list(projectId).find((item) => item.scope === scope && item.name === name)
    if (!record) throw new Error('技能写入失败。')
    return record
  }

  discoverPath(sourceRoot: string, label: string): SkillDiscoveryResult {
    if (!existsSync(sourceRoot)) throw new Error('扫描目录不存在。')
    const skills: SkillDiscovery[] = []
    const sources = new Map<string, string>()
    const skipped = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env', '.next', 'dist', 'build', 'tests', 'test'])
    const walk = (dir: string, depth: number): void => {
      if (depth > 6) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || skipped.has(entry.name)) continue
        const full = join(dir, entry.name)
        const skillFile = join(full, 'SKILL.md')
        if (existsSync(skillFile)) {
          const meta = readSkill(skillFile, sourceRoot)
          if (meta && !sources.has(meta.name)) {
            sources.set(meta.name, skillFile)
            skills.push({
              name: meta.name,
              description: meta.description,
              whenToUse: meta.whenToUse,
              sourcePath: full,
              relativePath: meta.relativePath,
              resources: meta.resources
            })
          }
          continue
        }
        walk(full, depth + 1)
      }
    }
    walk(sourceRoot, 0)
    skills.sort((a, b) => a.name.localeCompare(b.name))
    const cacheId = newId('skillsrc')
    this.discoveries.set(cacheId, { root: sourceRoot, sources, label })
    return { cacheId, sourceLabel: label, skills }
  }

  discoverGit(url: string): SkillDiscoveryResult {
    const normalized = url.trim()
    if (!normalized.startsWith('https://') || /\s/.test(normalized)) throw new Error('仅支持 https Git 仓库地址。')
    const cacheParent = ensureDir(join(accountDataRoot(), 'skill-cache'))
    const target = join(cacheParent, newId('repo'))
    const result = spawnSync('git', ['clone', '--depth', '1', normalized, target], {
      windowsHide: true,
      timeout: 180_000,
      encoding: 'utf8'
    })
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('未找到 git。请先安装 Git，或下载仓库后使用“扫描本机多技能目录”。')
      }
      throw new Error('克隆仓库失败：' + result.error.message)
    }
    if (result.status !== 0) {
      throw new Error('克隆仓库失败：' + (result.stderr || result.stdout || 'git exited with status ' + result.status).slice(-800))
    }
    return this.discoverPath(target, normalized)
  }

  installDiscovered(input: { projectId: string; cacheId: string; targetScope: 'project' | 'global'; names: string[] }): SkillInstallResult {
    const cached = this.discoveries.get(input.cacheId)
    if (!cached) throw new Error('扫描结果已过期，请重新扫描。')
    const installed: SkillRecord[] = []
    const skipped: Array<{ name: string; reason: string }> = []
    for (const name of input.names) {
      const skillFile = cached.sources.get(name)
      if (!skillFile) {
        skipped.push({ name, reason: '扫描结果中不存在该技能' })
        continue
      }
      const target = this.targetPath(input.projectId, input.targetScope, name)
      if (existsSync(target)) {
        skipped.push({ name, reason: '目标位置已存在同名技能' })
        continue
      }
      try {
        cpSync(dirname(skillFile), target, { recursive: true })
        installed.push(this.findRecord(input.projectId, input.targetScope, name))
      } catch (error) {
        skipped.push({ name, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return { installed, skipped }
  }

  openScope(projectId: string, scope: SkillScope): void {
    void shell.openPath(this.rootFor(projectId, scope))
  }

  reveal(projectId: string, scope: SkillScope, name: string): void {
    const skill = this.get(projectId, scope, name)
    shell.showItemInFolder(skill.path)
  }

  skillFolderLabel(scope: SkillScope): string {
    if (scope === 'builtin') return '应用内置'
    if (scope === 'global') return '全局用户技能'
    return '当前项目'
  }
}

function parseFrontmatterFromText(text: string): { meta: Record<string, unknown>; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ''))
  if (!match) return null
  try {
    const meta = yaml.load(match[1] ?? '') as Record<string, unknown>
    if (!meta || typeof meta !== 'object') return null
    return { meta, body: match[2] ?? '' }
  } catch {
    return null
  }
}
