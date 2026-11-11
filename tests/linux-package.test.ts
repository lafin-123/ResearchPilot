import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import {
  assertSafeArchivePath, assertSafeLink, createArArchive, readArArchive,
  linuxMode, isLinuxX64Elf, shouldRemoveNativePath, debianControl,
  createPosixTar, validateTar, extractElectronZip, pruneNativePackages, sha256,
} from '../scripts/lib/linux-package.mjs'
import JSZip from 'jszip'

const elf = () => {
  const b = Buffer.alloc(64)
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  b.writeUInt16LE(62, 18)
  return b
}

test('Linux ELF validation rejects PE, Mach-O, 32-bit and wrong CPU binaries', () => {
  assert.equal(isLinuxX64Elf(elf()), true)
  for (const b of [Buffer.from('MZ'), Buffer.alloc(64), Buffer.from(elf())]) {
    if (b[0] === 0x7f) b.writeUInt16LE(183, 18)
    assert.equal(isLinuxX64Elf(b), false)
  }
  const b = elf(); b[4] = 1
  assert.equal(isLinuxX64Elf(b), false)
})

test('archive paths and links cannot escape payload or use Windows separators', () => {
  for (const p of ['/etc/passwd', '../outside', 'a/../../bad', 'C:/bad', 'a\\bad', 'a\nfile', 'a//b', './a', '']) {
    assert.throws(() => assertSafeArchivePath(p))
  }
  assert.doesNotThrow(() => assertSafeArchivePath('opt/ResearchPilot/resources/app/package.json'))
  assert.doesNotThrow(() => assertSafeLink('app/lib/alias.so', '../target.so'))
  for (const target of ['/etc/passwd', '../../../outside', 'C:/x', '..\\x']) {
    assert.throws(() => assertSafeLink('app/lib/alias.so', target))
  }
})

test('Linux pruning keeps mandatory glibc x64 natives and drops other platforms and optional large tools', () => {
  for (const p of ['node-pty/prebuilds/win32-x64/pty.node', 'node-pty/prebuilds/linux-arm64/pty.node',
    '@img/sharp-linuxmusl-x64/lib/sharp.node', '@napi-rs/canvas-linux-x64-musl/package.json',
    '@koromix/koffi-darwin-x64/koffi.node', '@deepseek-ai/libreoffice-kit-linux-x64/package.json',
    'anything/native.exe', 'anything/native.dll', 'thing/prebuilds/darwin-x64/pty.node', '.bin/foo.cmd']) {
    assert.equal(shouldRemoveNativePath(p), true, p)
  }
  for (const p of ['node-pty/prebuilds/linux-x64/pty.node', '@img/sharp-linux-x64/lib/sharp.node',
    '@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.17.3', '@deepseek-ai/node-addon-system-linux-x64/index.node',
    'node-addon-require-builtin-linux-x64-gnu/index.node', '@koromix/koffi-linux-x64/koffi.node',
    '@napi-rs/canvas-linux-x64-gnu/skia.node', '@vscode/ripgrep-linux-x64/bin/rg']) {
    assert.equal(shouldRemoveNativePath(p), false, p)
  }
})

test('Linux pruning retains statically imported pure-JS Win32 wrappers, not foreign binaries inside them', async () => {
  const retained = ['@deepseek-ai/dsh-win32-process', '@deepseek-ai/dsh-sandbox-windows-acl']
  for (const name of retained) {
    for (const p of [name, `${name}/package.json`, `${name}/lib/index.js`, `nested/node_modules/${name}/lib/index.js`]) {
      assert.equal(shouldRemoveNativePath(p), false, p)
    }
    for (const suffix of ['native.exe', 'native.dll', 'prebuilds/win32-x64/native.node', 'prebuilds/darwin-x64/native.node']) {
      assert.equal(shouldRemoveNativePath(`${name}/${suffix}`), true, `${name}/${suffix}`)
    }
  }
  assert.equal(shouldRemoveNativePath('@deepseek-ai/dsh-win32-process-other/lib/index.js'), true)
  const root = await mkdtemp(join(tmpdir(), 'linux-js-wrapper-test-'))
  try {
    for (const name of retained) {
      await mkdir(join(root, name, 'lib'), { recursive: true })
      await writeFile(join(root, name, 'lib', 'index.js'), 'export const lazy = true\n')
      await writeFile(join(root, name, 'native.exe'), 'MZ')
    }
    await pruneNativePackages(root)
    for (const name of retained) {
      await access(join(root, name, 'lib', 'index.js'))
      await assert.rejects(access(join(root, name, 'native.exe')))
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Debian control uses real noncommercial metadata and compatible Ubuntu dependencies', () => {
  const c = debianControl('0.9.0', 123)
  assert.match(c, /Package: researchpilot\nVersion: 0\.9\.0\nArchitecture: amd64/)
  assert.match(c, /lafin-123@users\.noreply\.github\.com/)
  assert.match(c, /libc6 \(>= 2\.35\)/)
  assert.match(c, /libasound2 \| libasound2t64/)
  assert.match(c, /PolyForm-Noncommercial-1\.0\.0/)
  assert.throws(() => debianControl('0.9.0\nInjected: yes', 2))
})

test('POSIX modes are explicit, not inherited from Windows', () => {
  assert.equal(linuxMode('opt/ResearchPilot/chrome-sandbox', 'File'), 0o4755)
  assert.equal(linuxMode('opt/ResearchPilot/researchpilot', 'File'), 0o755)
  assert.equal(linuxMode('node_modules/node-pty/prebuilds/linux-x64/spawn-helper', 'File'), 0o755)
  assert.equal(linuxMode('node_modules/@vscode/ripgrep-linux-x64/bin/rg', 'File'), 0o755)
  assert.equal(linuxMode('node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/glibc/landlock-run', 'File'), 0o755)
  assert.equal(linuxMode('usr/bin/researchpilot', 'File'), 0o755)
  assert.equal(linuxMode('a', 'Directory'), 0o755)
  assert.equal(linuxMode('a', 'SymbolicLink'), 0o777)
  assert.equal(linuxMode('out/main/index.js', 'File'), 0o644)
})

test('standard Debian ar has validated ASCII headers, exact ordering, sizes and even padding', () => {
  const parts = [{ name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', data: Buffer.from('abc') }, { name: 'data.tar.gz', data: Buffer.from('de') }]
  const a = createArArchive(parts)
  assert.equal(a.subarray(0, 8).toString(), '!<arch>\n')
  assert.deepEqual(readArArchive(a).map(({ name, data }) => [name, data.toString()]),
    parts.map(({ name, data }) => [name, data.toString()]))
  assert.throws(() => readArArchive(a.subarray(0, a.length - 1)))
  const bad = Buffer.from(a); bad[66] = 0
  assert.throws(() => readArArchive(bad))
  assert.throws(() => createArArchive([{ name: '../bad', data: Buffer.alloc(0) }]))
})

test('tar payload round-trip validates root ownership and setuid sandbox without executing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-package-test-'))
  try {
    const src = join(root, 'payload')
    await mkdir(join(src, 'opt', 'ResearchPilot'), { recursive: true })
    await writeFile(join(src, 'opt', 'ResearchPilot', 'researchpilot'), elf())
    await writeFile(join(src, 'opt', 'ResearchPilot', 'chrome-sandbox'), elf())
    const output = join(root, 'data.tar.gz')
    await createPosixTar(src, output)
    const entries = await validateTar(output)
    assert.equal(entries.find(e => e.path === 'opt/ResearchPilot/chrome-sandbox')?.mode, 0o4755)
    assert.equal(entries.find(e => e.path === 'opt/ResearchPilot/researchpilot')?.mode, 0o755)
    assert.ok(entries.every(e => e.uid === 0 && e.gid === 0))
    const second = join(root, 'again.tar.gz')
    await createPosixTar(src, second)
    assert.deepEqual(await readFile(second), await readFile(output))
    const unsafe = join(root, 'unsafe.tar.gz')
    await tar.c({ cwd: src, file: unsafe, gzip: true, prefix: '../outside' }, ['opt'])
    await assert.rejects(validateTar(unsafe))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('pruning removes foreign native payloads without removing Linux pty and hashes the result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-prune-test-'))
  try {
    for (const platform of ['linux-x64', 'darwin-x64', 'win32-x64']) {
      await mkdir(join(root, 'node-pty', 'prebuilds', platform), { recursive: true })
      await writeFile(join(root, 'node-pty', 'prebuilds', platform, 'pty.node'), elf())
    }
    await pruneNativePackages(root)
    await access(join(root, 'node-pty', 'prebuilds', 'linux-x64', 'pty.node'))
    await assert.rejects(access(join(root, 'node-pty', 'prebuilds', 'darwin-x64')))
    await assert.rejects(access(join(root, 'node-pty', 'prebuilds', 'win32-x64')))
    assert.match(await sha256(join(root, 'node-pty', 'prebuilds', 'linux-x64', 'pty.node')), /^[0-9a-f]{64}$/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Electron zip extraction rejects unsafe names and symlinks before writing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-zip-test-'))
  try {
    const zip = new JSZip()
    zip.file('../escape', 'bad')
    const archive = join(root, 'input.zip')
    await writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }))
    await assert.rejects(extractElectronZip(archive, join(root, 'expanded')))
    const linked = new JSZip()
    linked.file('malicious', '../../outside', { unixPermissions: 0o120777 })
    await writeFile(archive, await linked.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }))
    await assert.rejects(extractElectronZip(archive, join(root, 'linked')))
    const safe = new JSZip(); safe.file('electron', elf())
    await writeFile(archive, await safe.generateAsync({ type: 'nodebuffer' }))
    await extractElectronZip(archive, join(root, 'safe'))
    assert.deepEqual(await readFile(join(root, 'safe', 'electron')), elf())
  } finally { await rm(root, { recursive: true, force: true }) }
})
