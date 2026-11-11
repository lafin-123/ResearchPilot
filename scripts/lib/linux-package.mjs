import { createReadStream } from 'node:fs'
import { readdir, lstat, readlink, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { posix, join, dirname, relative } from 'node:path'
import { createHash } from 'node:crypto'
import * as tar from 'tar'
import JSZip from 'jszip'

export function assertSafeArchivePath(path) {
  if (typeof path !== 'string' || !path || /[\\\x00-\x1f\x7f:]/.test(path) || path.startsWith('/') ||
    path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error(`Unsafe archive path: ${JSON.stringify(path)}`)
  return path
}

export function assertSafeLink(path, target) {
  assertSafeArchivePath(path)
  if (!target || /[\\\x00-\x1f\x7f:]/.test(target) || target.startsWith('/')) throw new Error(`Unsafe symlink: ${path}`)
  const resolved = posix.normalize(posix.join(posix.dirname(path), target))
  assertSafeArchivePath(resolved)
  return resolved
}

export function isLinuxX64Elf(b) {
  return b.length >= 20 && b.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
    b[4] === 2 && b[5] === 1 && b.readUInt16LE(18) === 62
}

export function shouldRemoveNativePath(path) {
  const p = path.replaceAll('\\', '/')
  const segments = p.split('/')
  return segments.some((s, i) => {
    // This pure-JS wrapper is statically imported by the cross-platform subprocess
    // module; only its Win32 native operations are lazy. Do not prune the package
    // by name, but still inspect every child segment and binary suffix normally.
    if (s === 'dsh-win32-process' && segments[i - 1] === '@deepseek-ai') return false
    return s === '.bin' || /(?:^|-)(?:win32|darwin|freebsd|openbsd|android)(?:-|$)/.test(s) ||
      /(?:^|-)(?:linux)(?:musl)?-(?:arm|arm64|ia32|ppc64|riscv64|s390x|loong64)(?:-|$)/.test(s) ||
      /linuxmusl|linux-x64-musl/.test(s) || /^(?:libreoffice-kit|dsh-experimental-speech-to-text-sensevoice)|^sherpa-onnx-/.test(s)
  }) || /\.(?:exe|dll|dylib|pdb|lib)$/i.test(p)
}

export function linuxMode(path, type) {
  if (type === 'Directory') return 0o755
  if (type === 'SymbolicLink' || type === 'Link') return 0o777
  if (/(?:^|\/)chrome-sandbox$/.test(path)) return 0o4755
  if (/(?:^|\/)(?:researchpilot|electron|chrome_crashpad_handler|spawn-helper|landlock-run|rg)$/.test(path) || /\.sh$/.test(path)) return 0o755
  return 0o644
}

export function debianControl(version, installedSize) {
  if (!/^\d+\.\d+\.\d+(?:[+~.-][a-zA-Z0-9.+~-]+)?$/.test(version) || !Number.isSafeInteger(installedSize) || installedSize < 0) throw new Error('Invalid Debian package metadata')
  return `Package: researchpilot\nVersion: ${version}\nArchitecture: amd64\nMaintainer: ResearchPilot maintainers <lafin-123@users.noreply.github.com>\nInstalled-Size: ${installedSize}\nSection: science\nPriority: optional\nHomepage: https://github.com/lafin-123/ResearchPilot\nLicense: PolyForm-Noncommercial-1.0.0\nDepends: libc6 (>= 2.35), libgtk-3-0 | libgtk-3-0t64, libnss3, libnspr4, libatk1.0-0 | libatk1.0-0t64, libatk-bridge2.0-0 | libatk-bridge2.0-0t64, libcups2 | libcups2t64, libdrm2, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxrandr2, libgbm1, libxkbcommon0, libasound2 | libasound2t64, libsecret-1-0, libstdc++6 (>= 12), libgcc-s1, ca-certificates, xdg-utils\nDescription: ResearchPilot research desktop workbench\n Papers, experiments and research workflows. Ubuntu 22.04+ (glibc 2.35+)\n or a compatible modern Debian-family x86-64 desktop is required.\n Noncommercial use under PolyForm-Noncommercial-1.0.0; bundled third-party\n software retains its own licenses.\n`
}

export function createArArchive(members) {
  const chunks = [Buffer.from('!<arch>\n')]
  for (const { name, data } of members) {
    if (!/^[a-zA-Z0-9.-]{1,15}$/.test(name) || !Buffer.isBuffer(data)) throw new Error('Invalid ar member')
    const fields = [name + '/', '0', '0', '0', '100644', String(data.length)]
    const widths = [16, 12, 6, 6, 8, 10]
    if (fields.some((v, i) => v.length > widths[i])) throw new Error('ar field overflow')
    chunks.push(Buffer.from(fields.map((v, i) => v.padEnd(widths[i], ' ')).join('') + '`\n'), data)
    if (data.length % 2) chunks.push(Buffer.from('\n'))
  }
  return Buffer.concat(chunks)
}

export function readArArchive(buffer) {
  if (buffer.subarray(0, 8).toString() !== '!<arch>\n') throw new Error('Invalid ar signature')
  const members = []
  let offset = 8
  while (offset < buffer.length) {
    if (offset + 60 > buffer.length) throw new Error('Truncated ar header')
    const h = buffer.subarray(offset, offset + 60).toString('ascii')
    if (h.slice(58) !== '`\n') throw new Error('Invalid ar header terminator')
    const name = h.slice(0, 16).trim().replace(/\/$/, '')
    if (!/^[a-zA-Z0-9.-]{1,15}$/.test(name)) throw new Error('Invalid ar name')
    if (!/^\d+ *$/.test(h.slice(48, 58))) throw new Error('Invalid ar size')
    const size = Number(h.slice(48, 58).trim())
    offset += 60
    if (offset + size + size % 2 > buffer.length) throw new Error('Truncated ar payload')
    members.push({ name, data: buffer.subarray(offset, offset + size) })
    offset += size
    if (size % 2 && buffer[offset++] !== 10) throw new Error('Invalid ar padding')
  }
  return members
}

export async function walkFiles(root, prefix = '') {
  const result = []
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name
    assertSafeArchivePath(path)
    const stat = await lstat(join(root, path))
    if (stat.isSymbolicLink()) {
      const target = await readlink(join(root, path))
      const resolved = assertSafeLink(path, target)
      // Do not follow links when walking, and require targets to exist in this payload.
      await lstat(join(root, resolved))
    } else if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Unsupported payload type: ${path}`)
    result.push({ path, stat })
    if (stat.isDirectory()) result.push(...await walkFiles(root, path))
  }
  return result
}

export async function createPosixTar(root, output) {
  const files = await walkFiles(root)
  await tar.c({ cwd: root, file: output, gzip: { level: 9 }, noMtime: true, portable: false,
    onWriteEntry(entry) {
      entry.stat.mode = linuxMode(entry.path.replace(/\/$/, ''), entry.type)
      entry.stat.uid = 0; entry.stat.gid = 0
      entry.stat.atime = undefined; entry.stat.ctime = undefined
      entry.myuser = 'root'; entry.myuid = 0
    }, noDirRecurse: true,
  }, files.map(f => f.path))
}

export async function validateTar(file) {
  const entries = []
  const seen = new Set()
  let validationError
  await tar.t({ file, strict: true, onReadEntry(entry) {
    try {
    const path = entry.path.replace(/\/$/, '')
    assertSafeArchivePath(path)
    if (seen.has(path)) throw new Error(`Duplicate archive member: ${path}`)
    seen.add(path)
    if (!['File', 'Directory', 'SymbolicLink', 'Link'].includes(entry.type)) throw new Error(`Unexpected tar type: ${entry.type}`)
    if (entry.type === 'SymbolicLink') assertSafeLink(path, entry.linkpath)
    if (entry.type === 'Link') assertSafeArchivePath(entry.linkpath)
    if (entry.uid !== 0 || entry.gid !== 0) throw new Error(`Non-root archive ownership: ${path}`)
    if (entry.mode !== linuxMode(path, entry.type)) throw new Error(`Incorrect POSIX mode: ${path}: ${entry.mode?.toString(8)}`)
    entries.push({ path, mode: entry.mode, uid: entry.uid, gid: entry.gid, size: entry.size, type: entry.type, linkpath: entry.linkpath })
    } catch (error) { validationError ??= error }
  } })
  if (validationError) throw validationError
  for (const e of entries) {
    if (e.type === 'SymbolicLink' && !seen.has(assertSafeLink(e.path, e.linkpath))) throw new Error(`Dangling archive link: ${e.path}`)
    if (e.type === 'Link' && !seen.has(e.linkpath)) throw new Error(`Dangling hardlink: ${e.path}`)
  }
  return entries
}

export async function extractElectronZip(archive, destination) {
  const zip = await JSZip.loadAsync(await readFile(archive), { checkCRC32: true })
  const entries = Object.values(zip.files)
  for (const e of entries) {
    assertSafeArchivePath((e.unsafeOriginalName ?? e.name).replace(/\/$/, ''))
    const type = Number(e.unixPermissions ?? 0) & 0o170000
    if (type && type !== 0o100000 && type !== 0o040000) throw new Error(`Unsupported zip entry: ${e.name}`)
  }
  // Refuse a nonempty extraction directory, including any pre-existing planted links.
  await mkdir(destination, { recursive: true })
  if ((await readdir(destination)).length) throw new Error('Zip destination must be empty')
  for (const e of entries) {
    const path = join(destination, e.name)
    if (e.dir) await mkdir(path, { recursive: true })
    else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, await e.async('nodebuffer'), { flag: 'wx' }) }
  }
}

export async function pruneNativePackages(root) {
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const absolute = join(directory, name)
      const rel = relative(root, absolute).replaceAll('\\', '/')
      if (shouldRemoveNativePath(rel)) { await rm(absolute, { recursive: true, force: true }); continue }
      if ((await lstat(absolute)).isDirectory()) await visit(absolute)
    }
  }
  await visit(root)
}

export async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
