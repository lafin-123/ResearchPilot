import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, extname, join } from 'node:path'
import mammoth from 'mammoth'
import type { AttachmentDraft, ChatAttachment, Project } from '@shared/types'
import { ensureDir, relativePath } from '../lib/paths'
import { newId } from '../lib/util'

const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.tex': 'text/x-tex',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.py': 'text/x-python',
  '.ipynb': 'application/x-ipynb+json',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
  '.bib': 'text/x-bibtex'
}

function mimeFor(path: string): string {
  const ext = extname(path).toLowerCase()
  return IMAGE_TYPES[ext] ?? MIME_TYPES[ext] ?? 'application/octet-stream'
}

export function describeAttachment(path: string): AttachmentDraft | null {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return null
    const mimeType = mimeFor(path)
    return {
      name: basename(path),
      path,
      size: stat.size,
      mimeType,
      kind: mimeType.startsWith('image/') ? 'image' : 'file'
    }
  } catch {
    return null
  }
}

export function inspectAttachments(paths: string[]): AttachmentDraft[] {
  return paths.map(describeAttachment).filter((item): item is AttachmentDraft => item !== null)
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim()
  return (cleaned || 'attachment').slice(0, 120)
}

export interface StoredAttachment extends ChatAttachment {
  absolutePath: string
}

export function storeAttachments(project: Project, drafts: AttachmentDraft[]): StoredAttachment[] {
  const dir = ensureDir(join(project.rootPath, 'data', 'attachments'))
  return drafts.map((draft) => {
    if (!existsSync(draft.path)) throw new Error(`附件不存在：${draft.name}`)
    const stat = statSync(draft.path)
    if (!stat.isFile()) throw new Error(`附件不是文件：${draft.name}`)
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`附件超过 64MB：${draft.name}`)
    const mimeType = draft.mimeType || mimeFor(draft.path)
    const target = join(dir, `${newId('att')}-${safeFileName(draft.name)}`)
    copyFileSync(draft.path, target)
    return {
      name: draft.name,
      relativePath: relativePath(project.rootPath, target),
      absolutePath: target,
      size: stat.size,
      mimeType,
      kind: mimeType.startsWith('image/') ? 'image' : 'file'
    }
  })
}

export function readImageAttachment(attachment: StoredAttachment): { data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' } | null {
  if (attachment.kind !== 'image') return null
  const mimeType = attachment.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) return null
  if (attachment.size > 15 * 1024 * 1024) return null
  return { data: readFileSync(attachment.absolutePath).toString('base64'), mimeType }
}

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.tex', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.py', '.r', '.bib', '.ipynb', '.log', '.xml', '.html', '.css', '.js', '.ts'])

export async function extractAttachmentText(attachment: StoredAttachment): Promise<string> {
  if (attachment.kind === 'image') return ''
  const ext = extname(attachment.name).toLowerCase()
  try {
    if (TEXT_EXTENSIONS.has(ext)) {
      return readFileSync(attachment.absolutePath, 'utf8').slice(0, 120_000)
    }
    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: attachment.absolutePath })
      return result.value.slice(0, 120_000)
    }
    if (ext === '.pdf') {
      const converted = spawnSync('pdftotext', ['-l', '40', attachment.absolutePath, '-'], {
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true
      })
      return converted.status === 0 ? (converted.stdout ?? '').slice(0, 120_000) : ''
    }
  } catch {
    return ''
  }
  return ''
}
