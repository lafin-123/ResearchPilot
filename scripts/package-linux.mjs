#!/usr/bin/env node
// Cross-package Linux x64 on any host. Never executes Linux binaries or npm lifecycle scripts.
// node scripts/package-linux.mjs [--prepare-only] [--version 0.9.0]
// node scripts/package-linux.mjs --resume release/linux-build-... [--prepare-only]
import { cp, mkdir, mkdtemp, readFile, writeFile, rename, rm, stat, open } from 'node:fs/promises'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { downloadArtifact } from '@electron/get'
import {
  extractElectronZip, pruneNativePackages, walkFiles, isLinuxX64Elf, shouldRemoveNativePath,
  debianControl, createPosixTar, validateTar, createArArchive, readArArchive, sha256,
} from './lib/linux-package.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const release = join(repo, 'release')
const args = process.argv.slice(2)
const prepareOnly = args.includes('--prepare-only')
function option(name) { const i = args.indexOf(name); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${name} value`); return args[i + 1] }
for (let i = 0; i < args.length; i++) {
  if (['--resume', '--version'].includes(args[i])) { i++; continue }
  if (args[i] !== '--prepare-only') throw new Error(`Unknown argument: ${args[i]}`)
}
const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
const version = option('--version') ?? pkg.version
const electronVersion = pkg.devDependencies.electron
// Validate metadata before writing anything.
debianControl(version, 0)
if (!/^\d+\.\d+\.\d+$/.test(electronVersion)) throw new Error('Electron version must be pinned exactly')
const lock = await readFile(join(repo, 'package-lock.json'))
const lockSha256 = createHash('sha256').update(lock).digest('hex')
await mkdir(release, { recursive: true })
let stage
let metadata
if (option('--resume')) {
  stage = resolve(repo, option('--resume'))
  if (dirname(stage) !== release || !/^linux-build-[a-zA-Z0-9-]+$/.test(relative(release, stage))) throw new Error('Resume must name a release/linux-build-* staging directory')
  metadata = JSON.parse(await readFile(join(stage, 'prepared.json'), 'utf8'))
  if (metadata.version !== version || metadata.electronVersion !== electronVersion || metadata.lockSha256 !== lockSha256) throw new Error('Prepared metadata differs from current version/Electron/lock; create a fresh staging directory')
} else {
  stage = await mkdtemp(join(release, 'linux-build-'))
  console.log(`STAGING=${stage}`)
  const project = join(stage, 'project')
  await mkdir(project)
  await writeFile(join(project, 'package.json'), JSON.stringify({ ...pkg, version }, null, 2) + '\n')
  await writeFile(join(project, 'package-lock.json'), lock)
  const runtime = join(stage, 'runtime')
  const downloadRoot = join(stage, 'downloads')
  await mkdir(downloadRoot)
  await mkdir(join(downloadRoot, 'tmp'))
  const [, archive] = await Promise.all([
    runNpmCi(project),
    downloadArtifact({ version: electronVersion, artifactName: 'electron', platform: 'linux', arch: 'x64',
      cacheRoot: join(downloadRoot, 'cache'), tempDirectory: join(downloadRoot, 'tmp'),
      unsafelyDisableChecksums: false,
      mirrorOptions: { mirror: 'https://github.com/electron/electron/releases/download/', customDir: `v${electronVersion}` },
    }),
  ])
  console.log(`Electron checksum verified by @electron/get: ${archive}`)
  await extractElectronZip(archive, runtime)
  await pruneNativePackages(join(project, 'node_modules'))
  metadata = { version, electronVersion, lockSha256, electronZipSha256: await sha256(archive), preparedAt: new Date().toISOString() }
  // Validate the binaries already at preparation time; fail early on incomplete optional npm installs.
  await validateNatives(join(project, 'node_modules'))
  await assertElf(join(runtime, 'electron'))
  await writeFile(join(stage, 'prepared.json'), JSON.stringify(metadata, null, 2) + '\n')
}
console.log(`PREPARED=${stage}`)
if (prepareOnly) {
  console.log('Preparation complete. Resume after the final app build with --resume and this staging directory.')
} else {
  if (pkg.version !== version) throw new Error('Final packaging requires root package.json to match --version')
  await packageArtifacts()
}

async function runNpmCi(project) {
  console.log('Installing Linux-only production packages in isolated staging (lifecycle scripts disabled).')
  const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const commandArgs = [npmCli, 'ci', '--prefix', project, '--omit=dev', '--ignore-scripts', '--os=linux', '--cpu=x64', '--libc=glibc', '--include=optional', '--no-audit', '--no-fund']
  await new Promise((res, rej) => {
    const child = spawn(process.execPath, commandArgs, { cwd: repo, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_os: 'linux', npm_config_cpu: 'x64', npm_config_libc: 'glibc' } })
    child.once('error', rej)
    child.once('exit', code => code === 0 ? res() : rej(new Error(`Isolated npm ci failed (${code})`)))
  })
}

async function assertElf(file) {
  const fd = await open(file, 'r')
  try {
    const b = Buffer.alloc(64)
    const { bytesRead } = await fd.read(b, 0, b.length, 0)
    if (!isLinuxX64Elf(b.subarray(0, bytesRead))) throw new Error(`Expected x64 ELF: ${file}`)
  } finally { await fd.close() }
}

async function validateNatives(root) {
  const files = (await walkFiles(root)).filter(f => f.stat.isFile())
  const required = [
    ['sharp', /^@img\/sharp-linux-x64\/.*\.node$/],
    ['sharp libvips', /^@img\/sharp-libvips-linux-x64\/.*\.so(?:\.|$)/],
    ['system addon', /^@deepseek-ai\/node-addon-system-linux-x64\/.*\.node$/],
    ['landlock sandbox helper', /^@deepseek-ai\/node-addon-system-linux-x64\/bin\/landlock-run$/],
    ['builtin addon', /^node-addon-require-builtin-linux-x64-gnu\/.*\.node$/],
    ['ripgrep', /^@vscode\/ripgrep-linux-x64\/.*\/rg$/],
    ['koffi', /^@koromix\/koffi-linux-x64\/.*\.node$/],
    ['canvas', /^@napi-rs\/canvas-linux-x64-gnu\/.*\.node$/],
    ['node-pty', /^node-pty\/prebuilds\/linux-x64\/.*\.node$/],
  ]
  const natives = []
  for (const [label, match] of required) {
    const found = files.filter(f => match.test(f.path))
    if (!found.length) throw new Error(`Missing mandatory Linux native package: ${label}`)
    for (const f of found) { await assertElf(join(root, f.path)); natives.push(f.path) }
  }
  for (const f of files) {
    if (shouldRemoveNativePath(f.path)) throw new Error(`Foreign platform binary retained: ${f.path}`)
    if (/\.node$|\.so(?:\.|$)|(?:^|\/)(?:spawn-helper|landlock-run)$/.test(f.path)) await assertElf(join(root, f.path))
  }
  console.log(`Validated mandatory Linux x64 ELF natives: ${natives.length}`)
  return natives
}

async function packageArtifacts() {
  const buildRoot = await mkdtemp(join(stage, 'package-'))
  const payload = join(buildRoot, 'deb-root')
  const app = join(payload, 'opt', 'ResearchPilot')
  // A resume never overwrites a previous payload; prevents stale files from leaking in.
  await mkdir(payload)
  await mkdir(dirname(app), { recursive: true })
  await cp(join(stage, 'runtime'), app, { recursive: true, errorOnExist: true, force: false })
  await rename(join(app, 'electron'), join(app, 'researchpilot'))
  await rm(join(app, 'resources', 'default_app.asar'), { force: true })
  const appRoot = join(app, 'resources', 'app')
  await mkdir(appRoot, { recursive: true })
  await cp(join(stage, 'project', 'node_modules'), join(appRoot, 'node_modules'), { recursive: true, verbatimSymlinks: true })
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: pkg.name, version, description: pkg.description,
    main: pkg.main, author: pkg.author, license: pkg.license, homepage: pkg.homepage, dependencies: pkg.dependencies }, null, 2) + '\n')
  for (const required of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html', 'resources/mcp/server.mjs']) {
    if (!(await stat(join(repo, required))).isFile()) throw new Error(`Missing built app file: ${required}`)
  }
  await cp(join(repo, 'out'), join(appRoot, 'out'), { recursive: true, filter: source => !source.endsWith('.map') })
  for (const name of ['skills', 'bridge', 'agent-plugin', 'mcp']) await cp(join(repo, 'resources', name), join(app, 'resources', name), { recursive: true })
  for (const name of ['LICENSE.md', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md']) await cp(join(repo, name), join(app, 'resources', name))
  await cp(join(repo, 'resources', 'icon.png'), join(app, 'researchpilot.png'))
  const installReadme = `ResearchPilot ${version} - Linux x86-64\n\nRequires Ubuntu 22.04+ or compatible glibc 2.35+ Linux desktop.\nThe optional POSIX research bridge CLI additionally requires system Node.js 24+ and curl on PATH.\nDebian package: sudo apt install ./ResearchPilot-${version}-linux-x64.deb\nLaunch ResearchPilot from the applications menu or run researchpilot as your normal user.\n\nPortable tar: tar -xzf ResearchPilot-${version}-linux-x64.tar.gz\ncd ResearchPilot\n./researchpilot\nInstall the shared-library dependencies listed in the Debian package control file first.\nDo not run the desktop app as root and do not disable Chromium's sandbox.\nThe portable archive preserves execute bits. If your distribution disables unprivileged\nuser namespaces, use the Debian installer (root-owned setuid chrome-sandbox), or ask\nyour administrator to configure Chromium sandbox support for your environment.\n\nPolyForm-Noncommercial-1.0.0. See resources/LICENSE.md and\nresources/THIRD_PARTY_NOTICES.md for application and third-party licensing.\nThis package was cross-built on Windows; Linux runtime/install testing is still required.\n`
  await writeFile(join(app, 'README-LINUX.txt'), installReadme)
  const desktopDir = join(payload, 'usr', 'share', 'applications')
  await mkdir(desktopDir, { recursive: true })
  await writeFile(join(desktopDir, 'researchpilot.desktop'), '[Desktop Entry]\nType=Application\nName=ResearchPilot\nComment=Research papers, experiments and workflows\nExec=/opt/ResearchPilot/researchpilot %U\nIcon=researchpilot\nTerminal=false\nCategories=Education;Science;\nStartupWMClass=researchpilot\n')
  const iconDir = join(payload, 'usr', 'share', 'icons', 'hicolor', '1024x1024', 'apps')
  await mkdir(iconDir, { recursive: true })
  await cp(join(repo, 'resources', 'icon.png'), join(iconDir, 'researchpilot.png'))
  // A tiny launcher avoids host symlink privileges; absolute path is intentional after installation.
  await mkdir(join(payload, 'usr', 'bin'), { recursive: true })
  await writeFile(join(payload, 'usr', 'bin', 'researchpilot'), '#!/bin/sh\nexec /opt/ResearchPilot/researchpilot "$@"\n')
  const docDir = join(payload, 'usr', 'share', 'doc', 'researchpilot')
  await mkdir(docDir, { recursive: true })
  await cp(join(repo, 'LICENSE.md'), join(docDir, 'copyright'))
  await writeFile(join(docDir, 'README-LINUX'), installReadme)
  for (const name of ['researchpilot', 'chrome-sandbox', 'chrome_crashpad_handler', 'libffmpeg.so', 'libvk_swiftshader.so', 'libvulkan.so.1']) await assertElf(join(app, name))
  const natives = await validateNatives(join(appRoot, 'node_modules'))
  const payloadFiles = await walkFiles(payload)
  for (const { path } of payloadFiles) {
    if (/(?:^|\/)(?:\.env(?:\..*)?|\.git|test-results|\.npmrc|\.ssh|credentials\.json)(?:\/|$)/i.test(path)) throw new Error(`Forbidden payload path: ${path}`)
  }
  const installedSize = Math.ceil(payloadFiles.reduce((sum, f) => sum + (f.stat.isFile() ? f.stat.size : 0), 0) / 1024)
  const controlRoot = join(buildRoot, 'control')
  await mkdir(controlRoot)
  await writeFile(join(controlRoot, 'control'), debianControl(version, installedSize))
  const dataTar = join(buildRoot, 'data.tar.gz')
  const controlTar = join(buildRoot, 'control.tar.gz')
  const portableRoot = join(buildRoot, 'portable')
  await mkdir(portableRoot)
  // Reuse files through a second tar root, without applying the Debian /opt prefix.
  await cp(app, join(portableRoot, 'ResearchPilot'), { recursive: true, verbatimSymlinks: true })
  const tarFile = join(release, `ResearchPilot-${version}-linux-x64.tar.gz`)
  const debFile = join(release, `ResearchPilot-${version}-linux-x64.deb`)
  for (const f of [tarFile, debFile]) { try { await stat(f); throw new Error(`Refusing to overwrite artifact: ${f}`) } catch (e) { if (e.code !== 'ENOENT') throw e } }
  console.log('Creating deterministic root-owned POSIX tar payloads (gzip level 9).')
  await createPosixTar(controlRoot, controlTar)
  await createPosixTar(payload, dataTar)
  await createPosixTar(portableRoot, tarFile)
  const dataEntries = await validateTar(dataTar)
  const controlEntries = await validateTar(controlTar)
  const portableEntries = await validateTar(tarFile)
  if (!controlEntries.some(e => e.path === 'control') || !dataEntries.some(e => e.path === 'usr/share/applications/researchpilot.desktop')) throw new Error('Missing Debian metadata')
  const ar = createArArchive([{ name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', data: await readFile(controlTar) }, { name: 'data.tar.gz', data: await readFile(dataTar) }])
  await writeFile(debFile, ar, { flag: 'wx' })
  const debMembers = readArArchive(await readFile(debFile))
  if (debMembers.map(m => m.name).join(',') !== 'debian-binary,control.tar.gz,data.tar.gz' || debMembers[0].data.toString() !== '2.0\n') throw new Error('Invalid Debian container')
  const artifacts = []
  for (const path of [debFile, tarFile]) artifacts.push({ path, bytes: (await stat(path)).size, sha256: await sha256(path) })
  const bundledSources = []
  for (const base of ['out', 'resources/skills', 'resources/bridge', 'resources/agent-plugin', 'resources/mcp']) {
    for (const f of await walkFiles(join(repo, base))) {
      if (f.stat.isFile() && !f.path.endsWith('.map')) {
        const sourceHash = await sha256(join(repo, base, f.path))
        const bundledPath = base === 'out' ? join(appRoot, base, f.path) : join(app, base, f.path)
        if (sourceHash !== await sha256(bundledPath)) throw new Error(`Source changed while packaging: ${base}/${f.path}`)
        bundledSources.push({ path: `${base}/${f.path}`, sha256: sourceHash })
      }
    }
  }
  const validation = { ...metadata, artifacts, bundledSources, dataEntries: dataEntries.length, controlEntries: controlEntries.length,
    portableEntries: portableEntries.length, requiredLinuxElf: natives, platform: 'linux', architecture: 'x64',
    sandboxMode: '4755 root:root', linuxRuntimeTested: false, linuxInstallTested: false }
  await writeFile(join(buildRoot, 'validation.json'), JSON.stringify(validation, null, 2) + '\n')
  await writeFile(join(stage, 'validation.json'), JSON.stringify({ ...validation, buildRoot }, null, 2) + '\n')
  console.log(JSON.stringify({ ...validation, bundledSources: `${bundledSources.length} source hashes in validation.json` }, null, 2))
}
