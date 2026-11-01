import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { Client, type SFTPWrapper } from 'ssh2'
import type { SshHost, SshHostInput } from '@shared/types'
import type { Db } from '../lib/db'
import { decryptSecret, encryptSecret } from '../lib/secrets'
import { newId, nowIso } from '../lib/util'

interface SshRow {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth_kind: 'password' | 'key'
  key_path: string
  password_enc: string
  passphrase_enc: string
  host_fingerprint: string
  workspace_path: string
  created_at: string
  updated_at: string
}

function mapHost(row: SshRow): SshHost {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authKind: row.auth_kind,
    keyPath: row.key_path,
    workspacePath: row.workspace_path,
    hasPassword: Boolean(row.password_enc),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

interface OpenConnection {
  client: Client
  sftp: SFTPWrapper
  fingerprint: string
}

export interface ExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export class SshService {
  constructor(private readonly db: Db) {}

  list(): SshHost[] {
    return this.db.all<SshRow>('SELECT * FROM ssh_hosts ORDER BY name ASC').map(mapHost)
  }

  get(id: string): SshHost {
    const row = this.db.get<SshRow>('SELECT * FROM ssh_hosts WHERE id = ?', id)
    if (!row) throw new Error('SSH 主机不存在。')
    return mapHost(row)
  }

  private getRow(id: string): SshRow {
    const row = this.db.get<SshRow>('SELECT * FROM ssh_hosts WHERE id = ?', id)
    if (!row) throw new Error('SSH 主机不存在。')
    return row
  }

  upsert(input: SshHostInput): SshHost {
    const name = input.name.trim()
    const host = input.host.trim()
    const username = input.username.trim()
    if (!name || !host || !username) throw new Error('SSH 名称、主机与用户名不能为空。')
    const id = input.id ?? newId('ssh')
    const existing = input.id ? this.getRow(input.id) : undefined
    const timestamp = nowIso()
    const passwordEnc = input.password ? encryptSecret(input.password) : existing?.password_enc ?? ''
    const passphraseEnc = input.passphrase ? encryptSecret(input.passphrase) : existing?.passphrase_enc ?? ''
    if (input.id) {
      this.db.run(
        `UPDATE ssh_hosts SET name = ?, host = ?, port = ?, username = ?, auth_kind = ?, key_path = ?, password_enc = ?, passphrase_enc = ?, workspace_path = ?, updated_at = ? WHERE id = ?`,
        name,
        host,
        input.port ?? 22,
        username,
        input.authKind,
        input.keyPath ?? '',
        passwordEnc,
        passphraseEnc,
        input.workspacePath ?? '~/researchpilot',
        timestamp,
        id
      )
    } else {
      this.db.run(
        `INSERT INTO ssh_hosts (id, name, host, port, username, auth_kind, key_path, password_enc, passphrase_enc, host_fingerprint, workspace_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
        id,
        name,
        host,
        input.port ?? 22,
        username,
        input.authKind,
        input.keyPath ?? '',
        passwordEnc,
        passphraseEnc,
        input.workspacePath ?? '~/researchpilot',
        timestamp,
        timestamp
      )
    }
    return this.get(id)
  }

  delete(id: string): void {
    this.get(id)
    this.db.run('DELETE FROM ssh_hosts WHERE id = ?', id)
  }

  private connect(id: string): Promise<OpenConnection> {
    const row = this.getRow(id)
    const password = row.password_enc ? decryptSecret(row.password_enc) : undefined
    const passphrase = row.passphrase_enc ? decryptSecret(row.passphrase_enc) : undefined
    let privateKey: Buffer | undefined
    if (row.auth_kind === 'key') {
      const keyPath = expandHome(row.key_path)
      if (!keyPath || !existsSync(keyPath)) throw new Error(`SSH 私钥不存在：${row.key_path}`)
      privateKey = readFileSync(keyPath)
    } else if (!password) {
      throw new Error('该 SSH 主机缺少密码。')
    }

    return new Promise<OpenConnection>((resolve, reject) => {
      const client = new Client()
      let fingerprint = ''
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        client.end()
        reject(error)
      }
      client
        .on('ready', () => {
          if (!row.host_fingerprint) {
            this.db.run('UPDATE ssh_hosts SET host_fingerprint = ?, updated_at = ? WHERE id = ?', fingerprint, nowIso(), id)
          }
          client.sftp((error, sftp) => {
            if (error) {
              fail(new Error(`SSH SFTP 初始化失败：${error.message}`))
              return
            }
            settled = true
            resolve({ client, sftp, fingerprint })
          })
        })
        .on('error', (error: Error) => {
          fail(new Error(`SSH 连接失败：${error.message}`))
        })
        .on('close', () => {
          if (!settled) fail(new Error('SSH 连接在就绪前关闭。'))
        })

      client.connect({
        host: row.host,
        port: row.port,
        username: row.username,
        ...(privateKey ? { privateKey } : {}),
        ...(passphrase ? { passphrase } : {}),
        ...(password ? { password } : {}),
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
        hostVerifier: (key: Buffer) => {
          fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
          if (row.host_fingerprint && row.host_fingerprint !== fingerprint) {
            fail(new Error(`SSH 主机指纹已变化，拒绝连接。\n期望 ${row.host_fingerprint}\n实际 ${fingerprint}`))
            return false
          }
          return true
        }
      })
    })
  }

  private close(connection: OpenConnection): void {
    try {
      connection.client.end()
    } catch {
      // Already closed.
    }
  }

  async test(id: string): Promise<{ fingerprint: string; message: string }> {
    const connection = await this.connect(id)
    try {
      const result = await this.execOnConnection(connection, 'uname -a || echo windows', 20_000)
      return { fingerprint: connection.fingerprint, message: result.stdout.trim() || '连接成功' }
    } finally {
      this.close(connection)
    }
  }

  private execOnConnection(
    connection: OpenConnection,
    command: string,
    timeoutMs: number,
    onData?: (chunk: string, stream: 'stdout' | 'stderr') => void
  ): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      connection.client.exec(command, (error, stream) => {
        if (error) {
          reject(new Error(`远程命令启动失败：${error.message}`))
          return
        }
        let stdout = ''
        let stderr = ''
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          try {
            stream.close()
          } catch {
            // Ignore.
          }
          reject(new Error(`远程命令超时（${Math.round(timeoutMs / 1000)}s）。`))
        }, timeoutMs)
        stream.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8')
          stdout += text
          onData?.(text, 'stdout')
        })
        stream.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8')
          stderr += text
          onData?.(text, 'stderr')
        })
        stream.on('close', (code: number | null) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ exitCode: code, stdout, stderr })
        })
        stream.on('error', (streamError: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(new Error(`远程命令流失败：${streamError.message}`))
        })
      })
    })
  }

  async exec(
    id: string,
    command: string,
    options: { timeoutMs?: number; onData?: (chunk: string, stream: 'stdout' | 'stderr') => void } = {}
  ): Promise<ExecResult & { fingerprint: string }> {
    const connection = await this.connect(id)
    try {
      const result = await this.execOnConnection(connection, command, options.timeoutMs ?? 120_000, options.onData)
      return { ...result, fingerprint: connection.fingerprint }
    } finally {
      this.close(connection)
    }
  }

  private remoteMkdir(sftp: SFTPWrapper, remoteDir: string): Promise<void> {
    const parts = remoteDir.replace(/^~/, homedir()).split('/').filter(Boolean)
    let current = remoteDir.startsWith('/') ? '' : '.'
    let chain = Promise.resolve()
    for (const part of parts) {
      current = current ? `${current}/${part}` : `/${part}`
      const target = current
      chain = chain.then(() => new Promise<void>((resolve) => {
        sftp.mkdir(target, (error) => {
          if (error && (error as { code?: number }).code !== 4) {
            // 4 = SFTP failure for an existing directory; other errors are reported by the next write.
          }
          resolve()
        })
      }))
    }
    return chain
  }

  private uploadFile(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private downloadFile(sftp: SFTPWrapper, remotePath: string, localPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  async uploadDirectory(id: string, localDir: string, remoteDir: string): Promise<void> {
    const connection = await this.connect(id)
    try {
      const walk = async (dir: string): Promise<void> => {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (['runs', '__pycache__', '.venv', 'node_modules', '.git'].includes(entry.name)) continue
          const localPath = join(dir, entry.name)
          const remotePath = `${remoteDir}/${entry.name}`
          if (entry.isDirectory()) {
            await new Promise<void>((resolve) => connection.sftp.mkdir(remotePath, () => resolve()))
            await walk(localPath)
          } else if (entry.isFile() && statSync(localPath).size < 50 * 1024 * 1024) {
            await this.uploadFile(connection.sftp, localPath, remotePath)
          }
        }
      }
      await this.remoteMkdir(connection.sftp, remoteDir)
      await walk(localDir)
    } finally {
      this.close(connection)
    }
  }

  async downloadDirectory(id: string, remoteDir: string, localDir: string, assertActive: () => void = () => {}): Promise<void> {
    const connection = await this.connect(id)
    try {
      assertActive()
      mkdirSync(localDir, { recursive: true })
      const walk = async (remote: string, local: string): Promise<void> => {
        const entries = await new Promise<Array<{ filename: string; attrs: { size: number }; longname: string }>>((resolve, reject) => {
          connection.sftp.readdir(remote, (error, list) => {
            if (error) reject(error)
            else resolve(list as Array<{ filename: string; attrs: { size: number }; longname: string }>)
          })
        })
        for (const entry of entries) {
          if (entry.filename === '.' || entry.filename === '..') continue
          const isDirectory = entry.longname.startsWith('d')
          const remotePath = `${remote}/${entry.filename}`
          const localPath = join(local, entry.filename)
          assertActive()
          if (isDirectory) {
            mkdirSync(localPath, { recursive: true })
            await walk(remotePath, localPath)
          } else if (entry.attrs.size < 100 * 1024 * 1024) {
            await this.downloadFile(connection.sftp, remotePath, localPath)
          }
        }
      }
      await walk(remoteDir, localDir)
    } finally {
      this.close(connection)
    }
  }

  remoteProjectDir(host: SshHost, projectId: string, experimentFolder: string): string {
    const base = host.workspacePath || '~/researchpilot'
    return `${base}/projects/${projectId}/experiments/${experimentFolder}`
  }

  quote(value: string): string {
    return shellQuote(value)
  }
}
