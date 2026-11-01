import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { shell } from 'electron'
import mammoth from 'mammoth'
import type {
  DocumentCreateInput,
  DocumentFormat,
  DocumentRecord,
  DocumentVersion,
  LatexCompileResult,
  Project
} from '@shared/types'
import type { Db } from '../lib/db'
import { buildDocx } from '../lib/docx-build'
import { createHash } from 'node:crypto'
import { figurePath } from '../lib/figure-files'
import { resolveManuscriptImage } from '../lib/manuscript-images'
import { compileLatex, detectLatexCommand, latexTemplate } from '../lib/latex'
import { absoluteFromRelative, assertInside, ensureDir, projectPath, relativePath } from '../lib/paths'
import { newId, nowIso, slugify, stripMarkdown, wordCount } from '../lib/util'
import type { SettingsService } from './settings'

interface DocumentRow {
  id: string
  project_id: string
  title: string
  format: DocumentFormat
  file_name: string
  relative_path: string
  position: number
  word_count: number
  created_at: string
  updated_at: string
}

interface VersionRow {
  id: string
  document_id: string
  label: string
  relative_path: string
  size: number
  created_at: string
}

interface ProjectRow {
  id: string
  root_path: string
}

function mapDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    format: row.format,
    fileName: row.file_name,
    relativePath: row.relative_path,
    position: row.position,
    wordCount: row.word_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class DocumentService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService
  ) {}

  private projectRoot(projectId: string): string {
    const row = this.db.get<ProjectRow>('SELECT id, root_path FROM projects WHERE id = ?', projectId)
    if (!row) throw new Error('项目不存在。')
    return row.root_path
  }

  list(projectId: string): DocumentRecord[] {
    return this.db
      .all<DocumentRow>('SELECT * FROM documents WHERE project_id = ? ORDER BY position ASC, created_at ASC', projectId)
      .map(mapDocument)
  }

  get(projectId: string, id: string): DocumentRecord {
    const row = this.db.get<DocumentRow>('SELECT * FROM documents WHERE id = ? AND project_id = ?', id, projectId)
    if (!row) throw new Error('文档不存在。')
    return mapDocument(row)
  }

  private nextPosition(projectId: string): number {
    return (this.db.scalar<number>('SELECT COALESCE(MAX(position), -1) + 1 FROM documents WHERE project_id = ?', projectId) ?? 0)
  }

  private uniqueFileName(root: string, title: string, extension: string): string {
    const base = slugify(title, 'document')
    let candidate = `${base}${extension}`
    let index = 2
    const dir = join(root, 'manuscripts')
    while (existsSync(join(dir, candidate))) {
      candidate = `${base}-${index}${extension}`
      index += 1
    }
    return candidate
  }

  private async extractText(absPath: string, format: DocumentFormat): Promise<string> {
    if (format === 'latex') return stripMarkdown(readFileSync(absPath, 'utf8').replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?(?:\{[^}]*\})?/g, ' '))
    const result = await mammoth.extractRawText({ path: absPath })
    return result.value
  }

  async create(input: DocumentCreateInput, assertActive: () => void = () => {}): Promise<DocumentRecord> {
    assertActive()
    const root = this.projectRoot(input.projectId)
    const title = input.title.trim() || '未命名文稿'
    const format = input.format
    const id = newId('doc')
    const timestamp = nowIso()
    const extension = format === 'docx' ? '.docx' : '.tex'
    const fileName = this.uniqueFileName(root, title, extension)
    const target = figurePath(root, `manuscripts/${fileName}`)
    ensureDir(join(root, 'manuscripts'))

    const markdown = input.markdown ?? this.defaultMarkdown(title)
    let text = markdown
    if (format === 'docx') {
      const buffer = await buildDocx({ title, markdown, resolveImage: (source) => resolveManuscriptImage(root, source) })
      text = (await mammoth.extractRawText({ buffer })).value
      assertActive()
      figurePath(root, `manuscripts/${fileName}`)
      writeFileSync(target, buffer, { flag: 'wx' })
    } else {
      assertActive()
      writeFileSync(target, latexTemplate(title, { abstract: '本文档由 ResearchPilot 创建。请在实验完成后写入有证据支持的摘要与结论。' }), { encoding: 'utf8', flag: 'wx' })
    }
    this.db.run(
      'INSERT INTO documents (id, project_id, title, format, file_name, relative_path, position, word_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      input.projectId,
      title,
      format,
      fileName,
      relativePath(root, target),
      this.nextPosition(input.projectId),
      wordCount(text),
      timestamp,
      timestamp
    )
    return this.get(input.projectId, id)
  }

  private defaultMarkdown(title: string): string {
    return `# ${title}

## Abstract

在这里写下研究问题、方法、实验设计、主要结果与贡献。所有数值必须来自已执行的实验。

## Introduction

TODO: 研究背景、缺口与贡献。

## Related Work

TODO: 基于文献库建立相关工作脉络。

## Method

TODO: 方法、假设与可复现的实验设计。

## Experimental Setup

TODO: 数据集、baseline、指标、超参数与随机种子。

## Results

TODO: 插入真实实验运行产生的表格与图表。

## Discussion and Limitations

TODO: 有效性威胁、失败案例与适用范围。

## Conclusion

TODO: 总结主要发现。
`
  }

  readBinary(projectId: string, id: string): { base64: string; updatedAt: string; fileName: string } {
    const doc = this.get(projectId, id)
    if (doc.format !== 'docx') throw new Error('该文档不是 DOCX。')
    const root = this.projectRoot(projectId)
    const abs = absoluteFromRelative(root, doc.relativePath)
    return { base64: readFileSync(abs).toString('base64'), updatedAt: doc.updatedAt, fileName: doc.fileName }
  }

  async readText(projectId: string, id: string): Promise<{ text: string; format: DocumentFormat }> {
    const doc = this.get(projectId, id)
    const abs = absoluteFromRelative(this.projectRoot(projectId), doc.relativePath)
    if (doc.format === 'latex') return { text: readFileSync(abs, 'utf8'), format: 'latex' }
    return { text: await this.extractText(abs, doc.format), format: doc.format }
  }

  readSource(projectId: string, id: string): string {
    const doc = this.get(projectId, id)
    if (doc.format !== 'latex') throw new Error('该文档不是 LaTeX。')
    return readFileSync(absoluteFromRelative(this.projectRoot(projectId), doc.relativePath), 'utf8')
  }

  private snapshot(projectId: string, doc: DocumentRecord, label: string): void {
    const root = this.projectRoot(projectId)
    const current = absoluteFromRelative(root, doc.relativePath)
    if (!existsSync(current)) return
    const dir = ensureDir(projectPath({ rootPath: root } as Project, '.research', 'history', doc.id))
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(dir, `${stamp}${extname(doc.fileName)}`)
    copyFileSync(current, target)
    this.db.run(
      'INSERT INTO document_versions (id, document_id, label, relative_path, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      newId('ver'),
      doc.id,
      label,
      relativePath(root, target),
      readFileSync(target).byteLength,
      nowIso()
    )
    const versions = this.db.all<VersionRow>(
      'SELECT * FROM document_versions WHERE document_id = ? ORDER BY created_at DESC',
      doc.id
    )
    for (const stale of versions.slice(40)) {
      this.db.run('DELETE FROM document_versions WHERE id = ?', stale.id)
    }
  }

  async saveBinary(projectId: string, id: string, base64: string): Promise<DocumentRecord> {
    const doc = this.get(projectId, id)
    if (doc.format !== 'docx') throw new Error('该文档不是 DOCX。')
    const root = this.projectRoot(projectId)
    const abs = absoluteFromRelative(root, doc.relativePath)
    this.snapshot(projectId, doc, '保存前自动快照')
    writeFileSync(abs, Buffer.from(base64, 'base64'))
    const text = await this.extractText(abs, doc.format)
    this.db.run('UPDATE documents SET word_count = ?, updated_at = ? WHERE id = ?', wordCount(text), nowIso(), id)
    return this.get(projectId, id)
  }

  async writeMarkdown(projectId: string, id: string, markdown: string, assertActive: () => void = () => {}): Promise<DocumentRecord> {
    if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > 300_000) throw new Error('文稿正文必须为非空文本且不超过 300,000 字符。')
    assertActive()
    const doc = this.get(projectId, id)
    if (doc.format !== 'docx') throw new Error('原生 Markdown 成稿工具当前只写入 DOCX。')
    const root = this.projectRoot(projectId)
    const path = figurePath(root, doc.relativePath)
    const hash = (value: Buffer): string => createHash('sha256').update(value).digest('hex')
    const before = hash(readFileSync(path))
    const buffer = await buildDocx({ title: doc.title, markdown, resolveImage: (source) => resolveManuscriptImage(root, source) })
    const extracted = await mammoth.extractRawText({ buffer })
    assertActive()
    const current = this.get(projectId, id)
    if (current.relativePath !== doc.relativePath || current.updatedAt !== doc.updatedAt || hash(readFileSync(figurePath(root, current.relativePath))) !== before) throw new Error('文稿在生成期间发生变化，请重新检查后写入。')
    figurePath(root, `.research/history/${doc.id}`)
    this.snapshot(projectId, doc, '智能体写稿前快照')
    const temporary = figurePath(root, `${doc.relativePath}.${newId('pending')}.tmp`)
    writeFileSync(temporary, buffer, { flag: 'wx' })
    assertActive()
    renameSync(temporary, figurePath(root, doc.relativePath))
    this.db.run('UPDATE documents SET word_count = ?, updated_at = ? WHERE id = ? AND project_id = ?', wordCount(extracted.value), nowIso(), id, projectId)
    return this.get(projectId, id)
  }

  saveText(projectId: string, id: string, text: string): DocumentRecord {
    const doc = this.get(projectId, id)
    if (doc.format !== 'latex') throw new Error('该文档不是 LaTeX。')
    const root = this.projectRoot(projectId)
    this.snapshot(projectId, doc, '保存前自动快照')
    writeFileSync(absoluteFromRelative(root, doc.relativePath), text, 'utf8')
    this.db.run('UPDATE documents SET word_count = ?, updated_at = ? WHERE id = ?', wordCount(stripMarkdown(text)), nowIso(), id)
    return this.get(projectId, id)
  }

  versions(projectId: string, id: string): DocumentVersion[] {
    this.get(projectId, id)
    return this.db
      .all<VersionRow>('SELECT * FROM document_versions WHERE document_id = ? ORDER BY created_at DESC', id)
      .map((row) => ({
        id: row.id,
        documentId: row.document_id,
        label: row.label,
        createdAt: row.created_at,
        size: row.size
      }))
  }

  async restore(projectId: string, id: string, versionId: string): Promise<DocumentRecord> {
    const doc = this.get(projectId, id)
    const version = this.db.get<VersionRow>('SELECT * FROM document_versions WHERE id = ? AND document_id = ?', versionId, id)
    if (!version) throw new Error('版本不存在。')
    const root = this.projectRoot(projectId)
    const source = absoluteFromRelative(root, version.relative_path)
    if (!existsSync(source)) throw new Error('版本文件已丢失。')
    const target = absoluteFromRelative(root, doc.relativePath)
    this.snapshot(projectId, doc, `恢复 ${version.created_at} 版本前快照`)
    copyFileSync(source, target)
    const text = await this.extractText(target, doc.format)
    this.db.run('UPDATE documents SET word_count = ?, updated_at = ? WHERE id = ?', wordCount(text), nowIso(), id)
    return this.get(projectId, id)
  }

  delete(projectId: string, id: string): void {
    const doc = this.get(projectId, id)
    const root = this.projectRoot(projectId)
    const abs = absoluteFromRelative(root, doc.relativePath)
    if (existsSync(abs)) {
      const trashDir = ensureDir(join(root, '.research', 'trash'))
      try {
        renameSync(abs, join(trashDir, `${doc.id}-${doc.fileName}`))
      } catch {
        // Keep the file when moving it fails; the database row is still removed.
      }
    }
    this.db.run('DELETE FROM documents WHERE id = ?', id)
  }

  importFile(projectId: string, sourcePath: string): Promise<DocumentRecord> {
    const extension = extname(sourcePath).toLowerCase()
    if (extension !== '.docx' && extension !== '.tex') throw new Error('仅支持导入 .docx 或 .tex 文件。')
    const root = this.projectRoot(projectId)
    const id = newId('doc')
    const format: DocumentFormat = extension === '.docx' ? 'docx' : 'latex'
    const baseName = sourcePath.split(/[\\/]/).pop() ?? `import${extension}`
    const title = baseName.replace(/\.(docx|tex)$/i, '')
    const fileName = this.uniqueFileName(root, title, extension)
    const target = join(ensureDir(join(root, 'manuscripts')), fileName)
    copyFileSync(sourcePath, target)
    const timestamp = nowIso()
    this.db.run(
      'INSERT INTO documents (id, project_id, title, format, file_name, relative_path, position, word_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      projectId,
      title,
      format,
      fileName,
      relativePath(root, target),
      this.nextPosition(projectId),
      0,
      timestamp,
      timestamp
    )
    return this.extractText(target, format).then((text) => {
      this.db.run('UPDATE documents SET word_count = ? WHERE id = ?', wordCount(text), id)
      return this.get(projectId, id)
    })
  }

  async compile(projectId: string, id: string): Promise<LatexCompileResult> {
    const doc = this.get(projectId, id)
    if (doc.format !== 'latex') throw new Error('仅 LaTeX 文档支持编译。')
    const root = this.projectRoot(projectId)
    const abs = absoluteFromRelative(root, doc.relativePath)
    const result = await compileLatex({ texFilePath: abs, preferredCommand: this.settings.get().latexCommand })
    return result
  }

  readPdf(projectId: string, id: string): { base64: string; fileName: string } {
    const doc = this.get(projectId, id)
    if (doc.format !== 'latex') throw new Error('仅 LaTeX 文档支持 PDF 预览。')
    const root = this.projectRoot(projectId)
    const abs = absoluteFromRelative(root, doc.relativePath.replace(/\.tex$/i, '.pdf'))
    if (!existsSync(abs)) throw new Error('尚未生成 PDF，请先编译。')
    return { base64: readFileSync(abs).toString('base64'), fileName: abs.split(/[\\/]/).pop() ?? 'paper.pdf' }
  }

  reveal(projectId: string, id: string): void {
    const doc = this.get(projectId, id)
    shell.showItemInFolder(absoluteFromRelative(this.projectRoot(projectId), doc.relativePath))
  }

  latexAvailable(): boolean {
    return detectLatexCommand(this.settings.get().latexCommand) !== null
  }

  assertDocPath(projectId: string, relative: string): string {
    return assertInside(this.projectRoot(projectId), join(this.projectRoot(projectId), relative))
  }
}
