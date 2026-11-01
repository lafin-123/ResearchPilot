import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmSync, writeSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, parse, relative, resolve, sep } from 'node:path'
import type { Db } from '../lib/db'
import { BACKUP_LIMITS, BACKUP_WARNINGS, backupId } from '../../shared/backups'
import type { BackupExportResult, BackupPreview, BackupRestoreResult, BackupSummary } from '../../shared/backups'
import { parseNoteLinks } from '../../shared/notes'
import { parsePdfAnnotationCreate } from '../../shared/pdf-annotations'

// Deliberately not ZIP: bounded length-prefixed JSON and uncompressed bytes. No archive
// extractor, decompressor, SQL, script, renderer-supplied path or configuration is executed.
const MAGIC = Buffer.from('RPBACK01')
const TABLES = {
  projects: 'id name description archived created_at updated_at',
  documents: 'id project_id title format file_name relative_path position word_count created_at updated_at',
  document_versions: 'id document_id label relative_path size created_at',
  reference_items: 'id project_id title authors year venue doi url abstract tags_json notes pdf_relative_path bibtex created_at updated_at',
  experiments: 'id project_id name description language entry_file created_at updated_at',
  experiment_runs: 'id experiment_id project_id status exit_code started_at finished_at metrics_json artifact_dir',
  figures: 'id project_id experiment_id name caption file_path format created_at',
  project_notes: 'id project_id title body pinned revision created_at updated_at deleted_at',
  note_links: 'project_id source_id target_id',
  reference_activity: 'id project_id reference_id title kind channel created_at',
  reference_reading_drafts: 'id project_id reference_id source_hash source_coverage content model_label created_at',
  pdf_annotations: 'id project_id reference_id fingerprint page quote comment color rects_json revision created_at updated_at'
} as const

type Table = keyof typeof TABLES
type Cell = string | number | null
type Row = Record<string, Cell>
type Records = Record<Table, Row[]>
interface Metadata { createdAt: string; records: Records }
interface FileEntry { path: string; size: number; sha256: string }
interface Manifest { version: 1; metadata: string; metadataSha256: string; files: FileEntry[] }
interface Bundle { manifest: Manifest; metadata: Metadata; files: Buffer[]; digest: string }
interface BackupOptions { workspaceRoot: () => string; assertIdle: () => void }
const NUMBERS = new Set(['archived', 'position', 'word_count', 'size', 'pinned', 'revision', 'page', 'exit_code'])
const NULLABLE = new Set(['exit_code', 'deleted_at'])
const ROOTS = new Set(['manuscripts', 'references', 'experiments', 'figures', 'data', 'exports'])
const EXTENSIONS = new Set(['.pdf', '.docx', '.tex', '.bib', '.md', '.txt', '.csv', '.tsv', '.json', '.jsonl', '.xlsx', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pptx', '.py', '.ipynb', '.r', '.m', '.eps', '.tif', '.tiff', '.npy', '.npz', '.parquet'])
const DENIED = /(?:^|[._-])(?:secret|secrets|credential|credentials|password|passwords|token|tokens|keys?|apikey|auth|accounts?|bridge|config|settings|environment|env|stdout|stderr|logs?|session|sessions|dsh|id_rsa|id_ed25519)(?:[._-]|$)/i
const DENIED_DIRS = new Set(['node_modules', '__pycache__', 'venv', 'site-packages', 'skills', 'bin', 'dist', 'build'])
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const HASH = /^[a-f0-9]{64}$/

class BackupError extends Error {}
function fail(message: string): never { throw new BackupError(message) }
function sha(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('备份结构无效。')
  const result = value as Record<string, unknown>
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) fail('备份包含未知或缺失的字段。')
  return result
}
function text(value: unknown, max = BACKUP_LIMITS.metadataBytes): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail('备份文本字段无效。')
  return value
}
function identifier(value: unknown): string {
  const id = text(value, 128)
  if (!ID.test(id) || /\s/.test(id)) fail('备份记录 ID 无效。')
  return id
}
function portablePath(value: unknown): string {
  const path = text(value, 1024)
  const parts = path.split('/')
  if (parts.length < 2 || !ROOTS.has(parts[0]) || parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /[\\:\x00-\x1f<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) fail('备份文件路径不安全。')
  if (parts.some(part => DENIED.test(part) || DENIED_DIRS.has(part.toLowerCase())) || !EXTENSIONS.has(extname(path).toLowerCase()) || ['agents.md', 'claude.md', 'sitecustomize.py', 'usercustomize.py'].includes(basename(path).toLowerCase())) fail('备份包含不允许的文件类型或配置文件。')
  return path
}
function allowedPath(path: string): boolean { try { portablePath(path); return true } catch { return false } }

/** Refuse junctions/symlinks in every ancestor, including the project/workspace root. */
function noLinks(path: string): void {
  const full = resolve(path)
  let current = parse(full).root
  for (const segment of relative(current, full).split(sep).filter(Boolean)) {
    current = join(current, segment)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) fail('备份拒绝符号链接或目录联接。')
  }
  if (resolve(realpathSync(full)).toLowerCase() !== full.toLowerCase()) fail('备份路径解析发生变化。')
}
function sourcePath(root: string, path: string): string {
  // Historical document versions are the sole explicitly selected hidden-path exception.
  if (!path.startsWith('.research/history/')) portablePath(path)
  else if (!/^\.research\/history\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.(docx|tex)$/.test(path)) fail('文稿历史路径不安全。')
  const full = resolve(root, path)
  if (!relative(resolve(root), full) || relative(resolve(root), full).startsWith('..') || relative(resolve(root), full).includes(':')) fail('备份文件超出项目目录。')
  noLinks(full)
  return full
}
function readRegular(path: string, max: number): Buffer {
  noLinks(path)
  const before = lstatSync(path)
  if (!before.isFile() || before.nlink !== 1 || before.size > max) fail('备份文件不安全、过大或不是普通文件。')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) fail('备份读取期间文件发生变化。')
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!n) fail('备份文件读取不完整。')
      offset += n
    }
    const after = fstatSync(fd)
    noLinks(path)
    const named = lstatSync(path)
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || named.ino !== opened.ino || named.dev !== opened.dev || named.nlink !== 1) fail('备份读取期间文件发生变化，请关闭外部编辑器后重试。')
    return bytes
  } finally { closeSync(fd) }
}
function summary(bundle: Bundle): BackupSummary {
  return {
    counts: Object.fromEntries(Object.entries(bundle.metadata.records).map(([table, rows]) => [table, rows.length])),
    fileCount: bundle.manifest.files.length,
    totalBytes: bundle.manifest.files.reduce((sum, file) => sum + file.size, 0),
    warnings: [...BACKUP_WARNINGS]
  }
}

function validateMetadata(raw: unknown, paths: Set<string>): Metadata {
  const outer = object(raw, ['createdAt', 'records'])
  const createdAt = text(outer.createdAt, 64)
  if (!Number.isFinite(Date.parse(createdAt))) fail('备份时间无效。')
  const records = object(outer.records, Object.keys(TABLES)) as unknown as Records
  let count = 0
  const ids = new Set<string>()
  for (const table of Object.keys(TABLES) as Table[]) {
    const rows = records[table]
    if (!Array.isArray(rows) || (count += rows.length) > BACKUP_LIMITS.rows) fail('备份记录数量超出限制。')
    for (const row of rows) {
      object(row, TABLES[table].split(' '))
      for (const [key, value] of Object.entries(row)) {
        if (value === null && NULLABLE.has(key)) continue
        if (NUMBERS.has(key)) {
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || (key !== 'exit_code' && value < 0)) fail('备份数值字段无效。')
        } else text(value)
      }
      if ('id' in row) {
        const id = identifier(row.id)
        if (ids.has(id)) fail('备份包含重复记录 ID。')
        ids.add(id)
      }
    }
  }
  if (records.projects.length !== 1) fail('备份必须且只能包含一个项目。')
  const project = records.projects[0]
  if (!text(project.name, 500).trim() || text(project.description).length > 200000) fail('备份项目描述无效。')
  const tableIds = new Map<Table, Set<Cell>>((Object.keys(TABLES) as Table[]).map(table => [table, new Set(records[table].map(row => row.id))]))
  const scoped = (table: Table, id: Cell): boolean => tableIds.get(table)!.has(id)
  const requiredFile = (value: Cell, optional = false): void => {
    if (optional && value === '') return
    const path = portablePath(value)
    if (!paths.has(path)) fail('备份缺少已登记的研究文件。')
  }
  for (const table of Object.keys(TABLES) as Table[]) for (const row of records[table]) {
    if ('project_id' in row && row.project_id !== project.id) fail('备份包含其他项目的数据。')
    if ('document_id' in row && !scoped('documents', row.document_id)) fail('备份文稿版本关系无效。')
    if (['reference_reading_drafts', 'pdf_annotations'].includes(table) && !scoped('reference_items', row.reference_id)) fail('备份文献关系无效。')
    if (table === 'experiment_runs' && !scoped('experiments', row.experiment_id)) fail('备份实验关系无效。')
    if (table === 'figures' && row.experiment_id !== '' && !scoped('experiments', row.experiment_id)) fail('备份图表实验关系无效。')
    if (table === 'note_links' && (!scoped('project_notes', row.source_id) || !scoped('project_notes', row.target_id))) fail('备份笔记链接关系无效。')
    if (table === 'documents') {
      if (!['docx', 'latex'].includes(String(row.format)) || basename(String(row.relative_path)) !== row.file_name) fail('备份文稿格式无效。')
      requiredFile(row.relative_path)
    }
    if (table === 'document_versions') requiredFile(row.relative_path)
    if (table === 'reference_items') { requiredFile(row.pdf_relative_path, true); if (!Array.isArray(JSON.parse(String(row.tags_json)))) fail('备份文献标签无效。') }
    if (table === 'experiments') { requiredFile(row.entry_file); if (row.language !== 'python' || !String(row.entry_file).endsWith('.py')) fail('备份实验代码类型无效。') }
    if (table === 'figures') requiredFile(row.file_path)
    if (table === 'experiment_runs') {
      if (!['idle', 'queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(row.status))) fail('备份实验状态无效。')
      if (row.artifact_dir) portablePath(`${row.artifact_dir}/placeholder.txt`)
      const metrics = JSON.parse(String(row.metrics_json))
      if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics) || Object.values(metrics).some(v => typeof v !== 'number' && typeof v !== 'string')) fail('备份实验指标无效。')
    }
    if (table === 'project_notes') {
      if (!text(row.title, 200).trim() || text(row.body, 200000).length > 200000 || ![0, 1].includes(Number(row.pinned)) || Number(row.revision) < 1) fail('备份笔记无效。')
    }
    if (table === 'reference_reading_drafts' && (!HASH.test(String(row.source_hash)) || row.source_coverage !== 'abstract-only' || !text(row.content, 40000))) fail('备份阅读草稿无效。')
    if (table === 'pdf_annotations') {
      if (!HASH.test(String(row.fingerprint)) || Number(row.page) < 1 || Number(row.page) > 10000 || Number(row.revision) < 1 || !['yellow', 'green', 'rose'].includes(String(row.color))) fail('备份 PDF 批注无效。')
      text(row.quote, 4000); text(row.comment, 4000)
      parsePdfAnnotationCreate({ projectId: row.project_id, referenceId: row.reference_id, fingerprint: row.fingerprint, page: row.page, quote: row.quote, comment: row.comment, color: row.color, rects: JSON.parse(String(row.rects_json)) })
    }
  }
  return { createdAt, records }
}

export class BackupService {
  private pending: { token: string; path: string; digest: string; expires: number } | undefined
  private busy = false
  constructor(private readonly db: Db, private readonly options: BackupOptions) {}

  dispose(): void { this.pending = undefined }

  private operation<T>(fn: () => T): T {
    if (this.busy) fail('备份操作正在进行，请稍后重试。')
    this.busy = true
    try {
      try { this.options.assertIdle() } catch { fail('后台任务正在运行或工作区尚未就绪，请停止任务后再备份/恢复。') }
      if (this.db.scalar<number>("SELECT COUNT(*) FROM experiment_runs WHERE status IN ('running','queued')")) fail('实验正在运行或排队，请停止后再备份/恢复。')
      return fn()
    } catch (error) {
      if (error instanceof BackupError) throw error
      // OS/SQLite errors can contain local paths, credentials and research contents.
      throw new BackupError('备份操作未完成。请检查文件完整性、可用空间及本地目录权限；现有项目不会被覆盖。')
    } finally { this.busy = false }
  }

  private collect(projectId: string): Bundle {
    backupId(projectId)
    const project = this.db.get<{ root_path: string }>('SELECT root_path FROM projects WHERE id = ?', projectId)
    if (!project) fail('项目不存在。')
    const root = project.root_path
    noLinks(root)
    const records = {} as Records
    this.db.transaction(() => {
      let count = 0
      let metadataBytes = 0
      for (const table of Object.keys(TABLES) as Table[]) {
        const where = table === 'projects' ? 'id = ?' : table === 'document_versions' ? 'document_id IN (SELECT id FROM documents WHERE project_id = ?)' : 'project_id = ?'
        const size = this.db.scalar<number>(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, projectId) ?? 0
        if ((count += size) > BACKUP_LIMITS.rows) fail('项目记录数量超出备份限制。')
        const lengths = TABLES[table].split(' ').map(column => `COALESCE(length(CAST(${column} AS BLOB)), 0)`).join(' + ')
        metadataBytes += this.db.scalar<number>(`SELECT COALESCE(SUM(${lengths}), 0) FROM ${table} WHERE ${where}`, projectId) ?? 0
        if (metadataBytes > BACKUP_LIMITS.metadataBytes) fail('项目元数据超出备份限制。')
        records[table] = this.db.all<Row>(`SELECT ${TABLES[table].split(' ').join(', ')} FROM ${table} WHERE ${where}`, projectId)
      }
    })
    const selections = new Map<string, string>()
    const select = (source: string, target = source): void => {
      portablePath(target)
      if (selections.has(target) && selections.get(target) !== source) fail('备份文件路径冲突。')
      selections.set(target, source)
      if (selections.size > BACKUP_LIMITS.files) fail('项目文件数量超过 5000 个。')
    }
    for (const row of records.documents) select(String(row.relative_path))
    for (const row of records.document_versions) {
      const source = String(row.relative_path)
      const target = `manuscripts/backup-history/${identifier(row.id)}${extname(source)}`
      select(source, target)
      row.relative_path = target
    }
    for (const row of records.reference_items) if (row.pdf_relative_path) select(String(row.pdf_relative_path))
    for (const row of records.experiments) select(String(row.entry_file))
    for (const row of records.figures) select(String(row.file_path))
    let visited = 0
    const walk = (dir: string, depth = 0): void => {
      if (depth > 24) fail('项目目录嵌套过深。')
      noLinks(join(root, dir))
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        if (++visited > 20000) fail('项目目录条目超出备份扫描限制。')
        if (entry.name.startsWith('.') || DENIED.test(entry.name) || DENIED_DIRS.has(entry.name.toLowerCase())) continue
        const path = `${dir}/${entry.name}`
        if (entry.isSymbolicLink()) fail('研究目录含符号链接，已停止备份。')
        if (entry.isDirectory()) walk(path, depth + 1)
        else if (allowedPath(path)) select(path)
      }
    }
    for (const dir of ROOTS) if (existsSync(join(root, dir))) walk(dir)
    const manifest: Manifest = { version: 1, metadata: '', metadataSha256: '', files: [] }
    const files: Buffer[] = []
    let total = 0
    const casePaths = new Set<string>()
    for (const [target, source] of selections) {
      if (casePaths.has(target.toLowerCase())) fail('备份含大小写冲突文件。')
      casePaths.add(target.toLowerCase())
      const bytes = readRegular(sourcePath(root, source), BACKUP_LIMITS.bytes - total)
      total += bytes.length
      manifest.files.push({ path: target, size: bytes.length, sha256: sha(bytes) })
      files.push(bytes)
    }
    // A second pass detects external edits during collection; UI mutations cannot
    // interleave with this synchronous operation. This is not a filesystem snapshot.
    for (let i = 0; i < manifest.files.length; i++) {
      const file = manifest.files[i]
      if (sha(readRegular(sourcePath(root, selections.get(file.path)!), file.size)) !== file.sha256) fail('项目文件在备份期间发生变化，请关闭外部编辑器后重试。')
    }
    const metadata = validateMetadata({ createdAt: new Date().toISOString(), records }, new Set(manifest.files.map(f => f.path)))
    manifest.metadata = JSON.stringify(metadata)
    if (Buffer.byteLength(manifest.metadata) > BACKUP_LIMITS.metadataBytes) fail('项目元数据超出备份限制。')
    manifest.metadataSha256 = sha(manifest.metadata)
    return { manifest, metadata, files, digest: '' }
  }

  /** destination comes only from the native save dialog, never IPC arguments. Never overwrite. */
  exportProject(projectId: string, destination: string): BackupExportResult {
    return this.operation(() => {
      const bundle = this.collect(projectId)
      noLinks(dirname(destination))
      const manifestBytes = Buffer.from(JSON.stringify(bundle.manifest))
      if (manifestBytes.length > BACKUP_LIMITS.metadataBytes * 2) fail('备份清单过大。')
      const header = Buffer.alloc(12)
      MAGIC.copy(header); header.writeUInt32LE(manifestBytes.length, 8)
      if (header.length + manifestBytes.length + summary(bundle).totalBytes > BACKUP_LIMITS.bytes) fail('备份总大小超过 256 MiB。')
      let fd: number | undefined
      let owned = false
      try {
        fd = openSync(destination, 'wx', 0o600); owned = true
        for (const buffer of [header, manifestBytes, ...bundle.files]) {
          let offset = 0
          while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset)
        }
        fsyncSync(fd); closeSync(fd); fd = undefined
        // Verify exactly what was written before reporting success.
        this.readBundle(destination)
        return { path: destination, ...summary(bundle) }
      } catch (error) {
        if (fd !== undefined) closeSync(fd)
        if (owned) rmSync(destination, { force: true })
        throw error
      }
    })
  }

  private readBundle(path: string): Bundle {
    const bytes = readRegular(path, BACKUP_LIMITS.bytes)
    if (bytes.length < 12 || !bytes.subarray(0, 8).equals(MAGIC)) fail('不是支持的 ResearchPilot 项目备份。')
    const length = bytes.readUInt32LE(8)
    if (length < 2 || length > BACKUP_LIMITS.metadataBytes * 2 || 12 + length > bytes.length) fail('备份清单长度无效。')
    const raw = object(JSON.parse(bytes.subarray(12, 12 + length).toString('utf8')), ['version', 'metadata', 'metadataSha256', 'files'])
    if (raw.version !== 1) fail('备份格式版本不受支持，请使用匹配的应用版本。')
    const metadataText = text(raw.metadata)
    if (Buffer.byteLength(metadataText) > BACKUP_LIMITS.metadataBytes || !HASH.test(String(raw.metadataSha256)) || sha(metadataText) !== raw.metadataSha256) fail('备份元数据校验失败。')
    if (!Array.isArray(raw.files) || raw.files.length > BACKUP_LIMITS.files) fail('备份文件数量无效。')
    const paths = new Set<string>()
    const cases = new Set<string>()
    const files: Buffer[] = []
    let offset = 12 + length
    for (const entry of raw.files) {
      const file = object(entry, ['path', 'size', 'sha256'])
      const path = portablePath(file.path)
      if (cases.has(path.toLowerCase())) fail('备份含重复或大小写冲突文件。')
      cases.add(path.toLowerCase()); paths.add(path)
      if (typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > bytes.length - offset || !HASH.test(String(file.sha256))) fail('备份文件长度或校验值无效。')
      const content = bytes.subarray(offset, offset + file.size)
      if (sha(content) !== file.sha256) fail('备份文件 SHA-256 校验失败，已拒绝恢复。')
      files.push(content); offset += file.size
    }
    if (offset !== bytes.length) fail('备份包含多余或未登记的内容。')
    for (const path of paths) {
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) if (cases.has(parts.slice(0, i).join('/').toLowerCase())) fail('备份文件和目录路径冲突。')
    }
    const metadata = validateMetadata(JSON.parse(metadataText), paths)
    return { manifest: raw as unknown as Manifest, metadata, files, digest: sha(bytes) }
  }

  /** A new preview invalidates the previous one. Tokens are private, expiring and single-use. */
  inspect(path: string): BackupPreview {
    this.pending = undefined
    return this.operation(() => {
      const bundle = this.readBundle(path)
      const token = randomUUID()
      this.pending = { token, path, digest: bundle.digest, expires: Date.now() + BACKUP_LIMITS.tokenLifetimeMs }
      return { token, projectName: String(bundle.metadata.records.projects[0].name), createdAt: bundle.metadata.createdAt, ...summary(bundle) }
    })
  }

  restoreCopy(token: string): BackupRestoreResult {
    return this.operation(() => {
      const pending = this.pending
      this.pending = undefined
      if (!pending || typeof token !== 'string' || token !== pending.token || pending.expires < Date.now()) fail('备份预览已过期，请重新选择并检查备份。')
      const bundle = this.readBundle(pending.path)
      if (bundle.digest !== pending.digest) fail('备份在预览后已发生变化，请重新检查。')
      const workspace = resolve(this.options.workspaceRoot())
      // Do not create/reuse untrusted user-provided project paths or restore old roots.
      noLinks(workspace)
      const root = mkdtempSync(join(workspace, 'restored-'))
      const records = bundle.metadata.records
      const ids = new Map<string, string>()
      for (const [table, rows] of Object.entries(records)) for (const row of rows) if (typeof row.id === 'string') ids.set(row.id, `${table === 'projects' ? 'proj' : table === 'project_notes' ? 'note' : table.slice(0, 12)}_${randomUUID().replaceAll('-', '')}`)
      const projectId = ids.get(String(records.projects[0].id))!
      const name = `${records.projects[0].name}（恢复副本）`
      try {
        for (const dir of ROOTS) mkdirSync(join(root, dir))
        for (let i = 0; i < bundle.manifest.files.length; i++) {
          const path = join(root, bundle.manifest.files[i].path)
          mkdirSync(dirname(path), { recursive: true })
          noLinks(dirname(path))
          writeFileSync(path, bundle.files[i], { flag: 'wx', mode: 0o600 })
          if (sha(readRegular(path, bundle.manifest.files[i].size)) !== bundle.manifest.files[i].sha256) fail('恢复文件校验失败。')
        }
        // This marker is generated locally; never copied from the archive.
        mkdirSync(join(root, '.research'))
        writeFileSync(join(root, '.research', 'manifest.json'), JSON.stringify({ version: 1, projectId, name, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
        this.db.transaction(() => {
          for (const table of Object.keys(TABLES) as Table[]) {
            if (table === 'note_links') continue // Derive graph from restored bodies, not archive-supplied edges.
            for (const original of records[table]) {
              const row: Row = { ...original }
              for (const key of ['id', 'project_id', 'document_id', 'experiment_id', 'reference_id']) if (typeof row[key] === 'string' && row[key]) {
                const previous = String(row[key])
                if (!ids.has(previous)) ids.set(previous, `source_${randomUUID().replaceAll('-', '')}`)
                row[key] = ids.get(previous)!
              }
              if (table === 'projects') { row.root_path = root; row.name = name; row.archived = 0; row.updated_at = new Date().toISOString() }
              if (table === 'experiments') { row.env_kind = 'local'; row.ssh_host_id = ''; row.status = 'idle'; row.last_run_id = '' }
              if (table === 'experiment_runs' && ['running', 'queued'].includes(String(row.status))) row.status = 'cancelled'
              if (table === 'project_notes') row.body = String(row.body).replace(/research-note:([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?=\))/g, (match, id: string) => ids.has(id) ? `research-note:${ids.get(id)}` : match)
              const keys = Object.keys(row)
              this.db.run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map(key => row[key]))
            }
          }
          for (const note of this.db.all<Row>('SELECT id, body FROM project_notes WHERE project_id = ?', projectId)) for (const target of parseNoteLinks(String(note.body))) {
            if (this.db.get('SELECT id FROM project_notes WHERE project_id = ? AND id = ?', projectId, target)) this.db.run('INSERT OR IGNORE INTO note_links (project_id, source_id, target_id) VALUES (?, ?, ?)', projectId, note.id, target)
          }
        })
      } catch (error) {
        // Only this invocation's exclusively-created directory is eligible for cleanup.
        rmSync(root, { recursive: true, force: true })
        throw error
      }
      return { projectId, rootPath: root, name, ...summary(bundle) }
    })
  }
}
