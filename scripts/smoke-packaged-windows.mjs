import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'

// No installer, dev Electron, repository launch argument, real credentials, or profile cleanup.
// Default: static preflight only. --intermediate explicitly labels a non-final executable run.
// Use --final-build-ready only after the rebuild owner explicitly announces final-build-ready.
const args = process.argv.slice(2)
const allowed = ['--preflight', '--intermediate', '--final-build-ready']
assert.ok(args.length <= 1 && args.every(arg => allowed.includes(arg)), `Usage: node scripts/smoke-packaged-windows.mjs [${allowed.join(' | ')}]`)
const mode = args[0]?.slice(2) ?? 'preflight'

async function run() {
  const root = resolve(import.meta.dirname, '..')
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  const executable = join(root, 'release', `v${version}`, 'win-unpacked', 'ResearchPilot.exe')
  const resources = join(dirname(executable), 'resources')
  const packagedApp = join(resources, 'app')
  const results = join(root, 'test-results')
  await mkdir(results, { recursive: true })
  const runDir = await mkdtemp(join(results, `packaged-${mode}-`))
  const profile = join(runDir, 'profile')
  const workspace = join(runDir, 'synthetic-projects')
  const database = join(profile, 'researchpilot.db')
  const reportPath = join(runDir, 'report.json')
  const checks = [], errors = [], consoleErrors = [], screenshots = [], mcp = []
  const report = { mode, finalReleaseValidation: mode === 'final-build-ready', executable, packagedApp, profile, workspace, runDir, checks, errors, consoleErrors, screenshots, mcp, startedAt: new Date().toISOString() }
  let app, page, failure, defaultBefore, defaultRoots, packageBefore
  const record = name => { checks.push(name); console.log(`PASS [${mode}] ${name}`) }
  const screenshot = async name => {
    const file = join(runDir, name)
    await page.screenshot({ path: file, fullPage: true })
    screenshots.push(file)
  }
  const inside = (base, target) => {
    const rel = relative(resolve(base), resolve(target))
    assert.ok(!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`), `Path outside isolated/packaged root: ${target}`)
  }
  const equalPath = (actual, expected) => assert.equal(resolve(actual).toLowerCase(), resolve(expected).toLowerCase())
  const artifactIdentity = async () => {
    const files = [executable, join(packagedApp, 'package.json'), join(packagedApp, 'out', 'main', 'index.js'), join(packagedApp, 'out', 'renderer', 'index.html')]
    const identities = []
    for (const file of files) {
      const info = await stat(file)
      identities.push({ path: file, bytes: info.size, modifiedAt: info.mtime.toISOString(), sha256: createHash('sha256').update(await readFile(file)).digest('hex') })
    }
    return identities
  }
  // Metadata-only snapshots: no default-profile database, credentials, or document content is read.
  // Keep just digests/counts in artifacts, never a listing of personal file names.
  const snapshotDefaults = async roots => {
    const snapshots = []
    for (const directory of roots) {
      const entries = []
      async function walk(file) {
        let info
        try { info = await lstat(file) } catch (error) { if (error.code === 'ENOENT') return; throw error }
        entries.push([relative(directory, file), info.size, info.mtimeMs, info.isDirectory(), info.isSymbolicLink()])
        assert.ok(entries.length < 100000, 'Default-location metadata snapshot exceeds safety limit')
        if (info.isDirectory() && !info.isSymbolicLink()) {
          for (const name of (await readdir(file)).sort()) await walk(join(file, name))
        }
      }
      await walk(directory)
      snapshots.push({ path: directory, count: entries.length, digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex') })
    }
    return snapshots
  }
  try {
    assert.ok(isAbsolute(executable) && executable.endsWith(`${sep}win-unpacked${sep}ResearchPilot.exe`))
    equalPath(await realpath(executable), executable)
    const manifest = JSON.parse(await readFile(join(packagedApp, 'package.json'), 'utf8'))
    assert.equal(manifest.version, version)
    assert.equal(manifest.name, 'researchpilot')
    packageBefore = await artifactIdentity()
    report.packageIdentity = packageBefore
    const skillRoot = join(resources, 'skills')
    const builtinFiles = []
    for (const entry of await readdir(skillRoot, { withFileTypes: true })) {
      const file = entry.isDirectory() ? join(skillRoot, entry.name, 'SKILL.md') : join(skillRoot, entry.name)
      if (!existsSync(file) || (!entry.isDirectory() && !entry.name.endsWith('.md'))) continue
      const text = await readFile(file, 'utf8')
      if (/^---\r?\n[\s\S]*?\r?\n---/.test(text) && /^name:\s*[a-z0-9-]+\s*$/m.test(text)) builtinFiles.push(file)
    }
    assert.equal(builtinFiles.length, 107, 'Packaged built-in skill count')
    const toneFiles = ['SKILL.md', 'DETECT.md', 'RESEARCH.md', 'LICENSE', 'ATTRIBUTION.md', 'references/academic-adaptation.md', 'references/semantic-criteria.md', 'scripts/detect.py', 'scripts/report.py', 'templates/revision-record.json', 'evals/cases.json']
    for (const name of toneFiles) {
      const file = join(skillRoot, 'lieflat-less-ai-tone', ...name.split('/'))
      assert.ok((await stat(file)).size > 0, `Missing/empty packaged tone resource: ${name}`)
    }
    assert.match(await readFile(join(skillRoot, 'lieflat-less-ai-tone', 'LICENSE'), 'utf8'), /CC BY-NC 4\.0/)
    assert.match(await readFile(join(skillRoot, 'lieflat-less-ai-tone', 'ATTRIBUTION.md'), 'utf8'), /53160078a04926d98de57a233549612d1b89bdc9/)
    for (const file of ['mcp/server.mjs', 'bridge/research-cli.ps1', 'bridge/research.cmd', 'bridge/research.sh', 'LICENSE.md', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md']) assert.ok((await stat(join(resources, ...file.split('/')))).size > 0)
    report.builtinSkillCount = builtinFiles.length
    report.toneFiles = toneFiles
    record(`Unpacked ${version} executable and resources exist; exactly 107 builtins include tone license, attribution, adaptation, and scripts`)
    const compared = []
    async function comparePackagedFiles(source, target) {
      for (const entry of await readdir(source, { withFileTypes: true })) {
        const localFile = join(source, entry.name), packagedFile = join(target, entry.name)
        if (entry.isDirectory()) await comparePackagedFiles(localFile, packagedFile)
        else if (entry.isFile() && !entry.name.endsWith('.map')) {
          const hash = data => createHash('sha256').update(data).digest('hex')
          const sha256 = hash(await readFile(localFile))
          assert.equal(hash(await readFile(packagedFile)), sha256, `Packaged file differs from current build/resource: ${localFile}`)
          compared.push({ path: relative(root, localFile), sha256 })
        }
      }
    }
    await comparePackagedFiles(join(root, 'out'), join(packagedApp, 'out'))
    for (const name of ['skills', 'mcp', 'bridge', 'agent-plugin']) await comparePackagedFiles(join(root, 'resources', name), join(resources, name))
    compared.sort((a, b) => a.path.localeCompare(b.path))
    report.buildResourceComparison = { files: compared.length, mismatches: 0, manifestSha256: createHash('sha256').update(JSON.stringify(compared)).digest('hex'), scope: 'Current out/ build outputs and resources/{skills,mcp,bridge,agent-plugin}; source maps excluded' }
    record(`${compared.length} packaged files match SHA-256 of current build outputs and source resources`)

    await mkdir(profile)
    await mkdir(workspace)
    inside(runDir, profile)
    inside(runDir, workspace)
    // Seed settings and an inert synthetic project at schema version zero; the app owns migrations.
    // The renderer automatically creates a first project if none exists. Seeding one prevents
    // that race and guarantees settings are asserted before our separate UI create action.
    const seedProjectId = 'proj-packaged-smoke-seed'
    const seedProjectRoot = join(workspace, 'seeded-synthetic-project')
    await mkdir(seedProjectRoot)
    const seed = new DatabaseSync(database)
    try {
      seed.exec(`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          root_path TEXT NOT NULL UNIQUE, archived INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )`)
      seed.prepare('INSERT INTO app_settings (key, value_json) VALUES (?, ?)').run('app', JSON.stringify({ workspaceRoot: workspace, telemetry: false }))
      seed.prepare('INSERT INTO app_settings (key, value_json) VALUES (?, ?)').run('activeProjectId', JSON.stringify(seedProjectId))
      const stamp = new Date().toISOString()
      seed.prepare('INSERT INTO projects (id, name, description, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(seedProjectId, 'Packaged synthetic seed', 'Isolated local fixture, not research evidence.', seedProjectRoot, stamp, stamp)
      assert.equal(JSON.parse(seed.prepare('SELECT value_json FROM app_settings WHERE key = ?').get('app').value_json).workspaceRoot, workspace)
      assert.equal(seed.prepare('SELECT root_path FROM projects WHERE id = ?').get(seedProjectId).root_path, seedProjectRoot)
      assert.equal(seed.prepare('PRAGMA user_version').get().user_version, 0)
    } finally { seed.close() }
    record('Fresh isolated SQLite settings and synthetic project preseeded and read back before app launch')

    if (mode === 'preflight') {
      report.status = 'preflight-passed-awaiting-final-build-ready'
      console.log('No application launched. Final executable validation awaits explicit final-build-ready.')
      return
    }
    console.log(mode === 'intermediate' ? 'INTERMEDIATE PACKAGE ONLY — NOT final release validation.' : 'FINAL PACKAGED RUN — caller supplied explicit final-build-ready gate.')
    const home = process.env.USERPROFILE
    assert.ok(home && process.env.APPDATA, 'Windows profile environment is unavailable')
    defaultRoots = [...new Map([
      join(process.env.APPDATA, 'researchpilot'), join(process.env.APPDATA, 'ResearchPilot'),
      join(home, 'Documents', 'ResearchPilot'),
      ...[process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial].filter(Boolean).map(dir => join(dir, 'Documents', 'ResearchPilot'))
    ].map(dir => [dir.toLowerCase(), dir])).values()]
    defaultBefore = await snapshotDefaults(defaultRoots)
    report.defaultLocationsBefore = defaultBefore
    const env = { ...process.env }
    const removedEnvironmentNames = []
    for (const name of Object.keys(env)) {
      if (/^(RESEARCHPILOT_|ELECTRON_RUN_AS_NODE$|ELECTRON_RENDERER_URL$|ELECTRON_START_URL$|VITE_|NODE_OPTIONS$|NODE_PATH$)/i.test(name) || /(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|SECRET)/i.test(name)) {
        delete env[name]
        removedEnvironmentNames.push(name)
      }
    }
    report.clearedEnvironmentNames = removedEnvironmentNames
    const launchArgs = [`--user-data-dir=${profile}`, '--disable-background-networking', '--disable-component-update']
    report.launchArgs = launchArgs
    app = await electron.launch({ executablePath: executable, args: launchArgs, cwd: runDir, env, timeout: 60000 })
    report.runtime = await app.evaluate(({ app }) => ({
      isPackaged: app.isPackaged, appPath: app.getAppPath(), version: app.getVersion(),
      userData: app.getPath('userData'), documents: app.getPath('documents'), name: app.getName(),
      executable: process.execPath, resources: process.resourcesPath, argv: process.argv
    }))
    assert.equal(report.runtime.isPackaged, true)
    assert.equal(report.runtime.version, version)
    equalPath(report.runtime.executable, executable)
    equalPath(report.runtime.appPath, packagedApp)
    equalPath(report.runtime.resources, resources)
    equalPath(report.runtime.userData, profile)
    assert.ok(report.runtime.argv.includes(`--user-data-dir=${profile}`))
    assert.ok(!report.runtime.argv.some(arg => resolve(arg).toLowerCase() === root.toLowerCase()), 'Repository must not be an app launch argument')
    // A redirected Documents directory not covered by our prelaunch snapshot is a fail, not a false no-touch claim.
    assert.ok(defaultRoots.some(dir => resolve(dir).toLowerCase() === join(report.runtime.documents, 'ResearchPilot').toLowerCase()), 'Unexpected redirected Documents path; no complete prelaunch baseline')
    record(`Actual ResearchPilot.exe reports isPackaged=true, packaged app path, version ${version}, and isolated --user-data-dir`)
    await app.evaluate(({ session }) => {
      globalThis.packagedSmokeExternalRequests = []
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(details.url).hostname)
        if (!local) globalThis.packagedSmokeExternalRequests.push(new URL(details.url).origin)
        callback({ cancel: !local })
      })
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    await page.waitForFunction(() => typeof window.researchpilot?.bootstrap === 'function', undefined, { timeout: 60000 })
    assert.equal(new URL(page.url()).protocol, 'file:')
    const initial = await page.evaluate(() => window.researchpilot.bootstrap())
    assert.equal(initial.version, version)
    assert.equal(initial.projects.length, 1, 'Only the preseeded synthetic project may exist before explicit creation')
    assert.equal(initial.projects[0].id, seedProjectId)
    equalPath(initial.projects[0].rootPath, seedProjectRoot)
    equalPath(initial.settings.workspaceRoot, workspace)
    equalPath((await page.evaluate(() => window.researchpilot.settings.get())).workspaceRoot, workspace)
    assert.equal(initial.providers.some(provider => provider.hasApiKey), false, 'No real keys permitted')
    await page.locator('.sidebar').waitFor({ timeout: 60000 })
    const navigation = new PackagedNavigation(page)
    await navigation.assertSidebar()
    await navigation.open('设置', '/settings')
    await page.getByRole('button', { name: '工作区', exact: true }).click()
    equalPath(await page.getByRole('textbox', { name: /^项目默认根目录/ }).inputValue(), workspace)
    await screenshot('01-isolated-settings-before-create.png')
    record('Before UI project creation, bootstrap/API/Settings UI confirm isolated root, only seeded project, and no API keys')
    await page.getByRole('button', { name: '新建研究项目', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: '项目名称', exact: true }).fill(`Packaged ${version} synthetic smoke`)
    await dialog.getByRole('button', { name: '创建项目', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.locator('.research-home').waitFor({ timeout: 60000 })
    const bootstrap = await page.evaluate(() => window.researchpilot.bootstrap())
    assert.equal(bootstrap.projects.length, 2)
    const project = bootstrap.projects.find(item => item.id !== seedProjectId)
    assert.ok(project)
    inside(workspace, project.rootPath)
    assert.notEqual(resolve(project.rootPath).toLowerCase(), workspace.toLowerCase())
    report.syntheticProject = { id: project.id, rootPath: project.rootPath }
    assert.ok(existsSync(join(project.rootPath, '.research', 'manifest.json')))
    await screenshot('02-packaged-home.png')
    record('UI-created synthetic project stays inside the verified isolated workspace')
    await navigation.assertAllRoutes()
    record('Five new primary navigation links plus bottom Settings and all 17 grouped routes work in the packaged UI')

    const skills = await page.evaluate(id => window.researchpilot.skills.list(id), project.id)
    const builtins = skills.filter(skill => skill.scope === 'builtin')
    assert.equal(builtins.length, 107)
    for (const skill of builtins) inside(skillRoot, skill.path)
    const tone = builtins.find(skill => skill.name === 'lieflat-less-ai-tone')
    assert.ok(tone)
    assert.equal(tone.resources.scripts, 2)
    assert.ok(tone.resources.references >= 2)
    await navigation.open('助手', '/skills')
    await page.waitForFunction(() => document.querySelectorAll('.skill-row').length === 107)
    await page.getByLabel('搜索科研技能').fill('lieflat-less-ai-tone')
    await page.waitForFunction(() => document.querySelectorAll('.skill-row').length === 1)
    await screenshot('03-packaged-tone-skill.png')
    record('Runtime skill API and actual UI discover all 107 packaged builtins including lieflat-less-ai-tone')

    report.sharp = await app.evaluate(async ({ app }, outputPath) => {
      // Playwright's evaluated VM may not provide an ESM dynamic-import callback.
      // Node's builtin accessor is the supported fallback, still in the packaged main process.
      let module, loader = 'dynamic-import'
      try { module = await import('node:module') } catch (error) {
        if (!String(error).includes('dynamic import callback') || typeof process.getBuiltinModule !== 'function') throw error
        module = process.getBuiltinModule('module')
        loader = 'process.getBuiltinModule (VM has no dynamic-import callback)'
      }
      const { createRequire } = module
      const { join, relative, isAbsolute } = process.getBuiltinModule('path')
      const { writeFile } = process.getBuiltinModule('fs/promises')
      const require = createRequire(join(app.getAppPath(), 'package.json'))
      const modulePath = require.resolve('sharp')
      const rel = relative(app.getAppPath(), modulePath)
      if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('sharp resolved outside packaged application')
      const sharp = require('sharp')
      const png = await sharp({ create: { width: 32, height: 24, channels: 4, background: { r: 31, g: 97, b: 143, alpha: 1 } } }).png().toBuffer()
      const metadata = await sharp(png).metadata()
      await writeFile(outputPath, png)
      return { loader, modulePath, versions: sharp.versions, bytes: png.length, signature: [...png.subarray(0, 8)], metadata: { width: metadata.width, height: metadata.height, format: metadata.format } }
    }, join(runDir, 'native-sharp.png'))
    assert.deepEqual(report.sharp.signature, [137, 80, 78, 71, 13, 10, 26, 10])
    assert.deepEqual(report.sharp.metadata, { width: 32, height: 24, format: 'png' })
    assert.ok(report.sharp.versions.vips)
    inside(packagedApp, report.sharp.modulePath)
    record('Native sharp resolves from packaged app node_modules and creates/reads an actual 32x24 PNG in the packaged main process')

    const servers = await page.evaluate(id => window.researchpilot.mcp.list(id), project.id)
    assert.deepEqual(servers.map(server => server.id).sort(), ['artifacts', 'evidence', 'writing'])
    for (const server of servers) {
      const state = await page.evaluate(input => window.researchpilot.mcp.test(input), { projectId: project.id, serverId: server.id })
      mcp.push({ id: state.id, status: state.status, lastTestOk: state.lastTestOk, discoveredTools: state.discoveredTools, expectedTools: server.tools.map(tool => tool.name), testSummary: state.testSummary, lastError: state.lastError })
      assert.equal(state.lastTestOk, true, `${server.id}: ${state.lastError}`)
      assert.equal(state.status, 'connected')
      assert.deepEqual([...state.discoveredTools].sort(), server.tools.map(tool => tool.name).sort())
      record(`Packaged ${server.id} MCP: real stdio initialize/listTools/diagnostic call succeeded (${state.discoveredTools.length} tools)`)
    }
    await navigation.open('设置', '/mcp')
    await page.getByRole('heading', { level: 1 }).waitFor()
    await screenshot('04-packaged-mcp.png')
    const listed = await page.evaluate(id => window.researchpilot.mcp.list(id), project.id)
    assert.equal(listed.filter(server => server.lastTestOk === true && server.status === 'connected').length, 3)
    const current = await page.evaluate(() => window.researchpilot.bootstrap())
    for (const item of current.projects) inside(workspace, item.rootPath)
    equalPath(current.settings.workspaceRoot, workspace)
    assert.equal(current.providers.some(provider => provider.hasApiKey), false)
    assert.ok(!['running', 'starting'].includes((await page.evaluate(() => window.researchpilot.chat.state())).status))
    report.externalRequests = await app.evaluate(() => globalThis.packagedSmokeExternalRequests)
    assert.deepEqual(report.externalRequests, [], 'Unexpected external Chromium requests (blocked)')
    assert.deepEqual(errors, [], 'Renderer exceptions')
    assert.deepEqual(consoleErrors, [], 'Renderer console errors')
    record('No configured keys, model tasks, external Chromium requests, renderer exceptions, or console errors')
  } catch (error) {
    failure = error.stack ?? String(error)
    if (page && !page.isClosed()) await screenshot('failure.png').catch(() => {})
    console.error(failure)
    process.exitCode = 1
  } finally {
    if (app) {
      try { await app.close(); report.applicationClosed = true } catch (error) { failure ??= `Application cleanup failed: ${error}`; process.exitCode = 1 }
    }
    if (defaultBefore) {
      try {
        report.defaultLocationsAfter = await snapshotDefaults(defaultRoots)
        assert.deepEqual(report.defaultLocationsAfter, defaultBefore, 'Default profile/workspace metadata changed; investigate without deleting any files')
        record('Default ResearchPilot profile/workspace metadata unchanged after isolated app shutdown (no real files deleted)')
      } catch (error) { failure ??= error.stack ?? String(error); console.error(String(error)); process.exitCode = 1 }
    }
    if (packageBefore) {
      try {
        assert.deepEqual(await artifactIdentity(), packageBefore, 'Package changed during smoke; results invalid, rerun after final-build-ready')
        record('Executable and packaged entrypoint identities remained stable throughout this run')
      } catch (error) { failure ??= error.stack ?? String(error); console.error(String(error)); process.exitCode = 1 }
    }
    report.failure = failure
    report.status = failure ? 'failed' : mode === 'preflight' ? 'preflight-passed-awaiting-final-build-ready' : 'passed'
    report.finishedAt = new Date().toISOString()
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`REPORT ${reportPath}`)
    if (mode !== 'final-build-ready') console.log('Final packaged release validation remains pending explicit final-build-ready.')
  }
}

class PackagedNavigation {
  static workspaces = [
    ['工作台', '/', [['/', '概览'], ['/research', '研究探索'], ['/pipeline', '研究流程']]],
    ['助手', '/agent', [['/agent', '对话'], ['/skills', '技能库']]],
    ['文献', '/library', [['/library', '文献库'], ['/notes', '笔记'], ['/knowledge', '知识检索']]],
    ['实验', '/experiments', [['/experiments', '实验与分析'], ['/methods', '方法复用'], ['/figures', '绘图']]],
    ['写作', '/writing', [['/writing', '稿件'], ['/writing-quality', '检查与润色']]],
    ['设置', '/settings', [['/settings', '模型与偏好'], ['/mcp', '工具连接'], ['/setup', '环境检查'], ['/backups', '备份与恢复']]]
  ]
  constructor(page) { this.page = page }
  get sidebar() { return this.page.getByRole('complementary', { name: '主导航', exact: true }) }
  async assertSidebar() {
    const primary = this.sidebar.getByRole('navigation', { name: '工作区', exact: true })
    assert.equal(await primary.getByRole('link').count(), 5)
    assert.deepEqual(await primary.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('aria-label'))), PackagedNavigation.workspaces.slice(0, 5).map(([name]) => name))
    assert.equal(await this.sidebar.getByRole('link').count(), 6)
    assert.equal(await this.sidebar.locator('.sidebar-bottom').getByRole('link', { name: '设置', exact: true }).count(), 1)
  }
  async open(name, target) {
    const [, parent, children] = PackagedNavigation.workspaces.find(([label]) => label === name)
    await this.sidebar.getByRole('link', { name, exact: true }).click()
    const nav = this.page.getByRole('navigation', { name: `${name}内导航`, exact: true })
    if (target !== parent) await nav.getByRole('link', { name: children.find(([path]) => path === target)[1], exact: true }).click()
    await this.page.waitForFunction(({ parent, target }) => location.hash === `#${target}` && document.querySelector('.sidebar a[aria-current="page"]')?.getAttribute('href') === `#${parent}` && document.querySelector('.workspace-nav a[aria-current="page"]')?.getAttribute('href') === `#${target}`, { parent, target })
    assert.equal(await this.sidebar.locator('a[aria-current="page"]').count(), 1)
    assert.equal(await nav.locator('a[aria-current="page"]').count(), 1)
  }
  async assertAllRoutes() {
    let count = 0
    for (const [name, , children] of PackagedNavigation.workspaces) {
      for (const [path] of children) { await this.open(name, path); count++ }
    }
    assert.equal(count, 17)
  }
}

if (process.platform !== 'win32') {
  console.log('SKIP packaged Windows smoke: requires Windows and ResearchPilot.exe; no application launched.')
} else {
  await run()
}
