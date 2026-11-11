#!/usr/bin/env node
// Intermediate runtime validation, not final UI/release or installer validation.
// Launches ONLY the supplied packaged executable with a fresh preseeded profile.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile, stat, lstat, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { _electron as electron } from 'playwright-core'

assert.equal(process.platform, 'win32', 'Requires Windows packaged executable')
assert.equal(process.argv.length, 3, 'Usage: node scripts/smoke-packaged-agent.mjs PATH_TO_ResearchPilot.exe')
const root = resolve(import.meta.dirname, '..')
const executable = resolve(process.argv[2])
assert.equal(executable.split(sep).at(-1), 'ResearchPilot.exe')
const packagedApp = join(dirname(executable), 'resources', 'app')
const version = JSON.parse(await readFile(join(packagedApp, 'package.json'), 'utf8')).version
const results = join(root, 'test-results')
await mkdir(results, { recursive: true })
const runDir = await mkdtemp(join(results, 'packaged-agent-'))
const profile = join(runDir, 'profile'), workspace = join(runDir, 'workspace')
const report = { mode: 'intermediate-runtime-only', finalReleaseValidation: false, executable, packagedApp, version, runDir, profile, workspace, checks: [], requests: [], fixtureErrors: [], rendererErrors: [], startedAt: new Date().toISOString() }
const record = name => { report.checks.push(name); console.log(`PASS ${name}`) }
const inside = (base, file) => { const rel = relative(resolve(base), resolve(file)); assert.ok(!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`), `Path escaped root: ${file}`) }
const providerId = 'packaged-agent-fixture', modelId = 'packaged-agent-model'
const syntheticKey = 'synthetic-packaged-agent-not-a-real-key'
const prompt = 'PACKAGED_AGENT_PROMPT_837: Synthetic packaging validation. Reply briefly without tools or reading files.'
const answer = 'PACKAGED_AGENT_SSE_BOOT_OK_837'
const stamp = new Date().toISOString(), projectId = 'proj-packaged-agent-seed'
let app, page, baseline

function deadline(promise, label, timeout = 90000) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: deadline exceeded (${timeout}ms)`)), timeout) })]).finally(() => clearTimeout(timer))
}
async function metadataSnapshot(dirs) {
  const snapshots = []
  for (const dir of dirs) {
    const entries = []
    async function walk(file) {
      let info
      try { info = await lstat(file) } catch (error) { if (error.code === 'ENOENT') return; throw error }
      entries.push([relative(dir, file), info.size, info.mtimeMs, info.isDirectory(), info.isSymbolicLink()])
      assert.ok(entries.length < 100000, 'Metadata snapshot exceeds safety bound')
      if (info.isDirectory() && !info.isSymbolicLink()) for (const name of (await readdir(file)).sort()) await walk(join(file, name))
    }
    await walk(dir)
    snapshots.push({ path: dir, count: entries.length, digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex') })
  }
  return snapshots
}
const defaultRoots = [...new Map([
  join(process.env.APPDATA, 'researchpilot'), join(process.env.APPDATA, 'ResearchPilot'),
  join(process.env.USERPROFILE, 'Documents', 'ResearchPilot'),
  ...[process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial].filter(Boolean).map(dir => join(dir, 'Documents', 'ResearchPilot')),
].map(dir => [dir.toLowerCase(), dir])).values()]
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(req.headers.authorization, `Bearer ${syntheticKey}`)
    let body = ''
    for await (const chunk of req) { body += chunk.toString('utf8'); assert.ok(Buffer.byteLength(body) < 4 * 1024 * 1024) }
    const payload = JSON.parse(body)
    assert.equal(payload.model, modelId)
    assert.ok(Array.isArray(payload.messages))
    const request = { model: payload.model, stream: payload.stream === true, userPromptPresent: payload.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('PACKAGED_AGENT_PROMPT_837')) }
    report.requests.push(request)
    const id = `packaged-fixture-${report.requests.length}`, created = Math.floor(Date.now() / 1000)
    if (payload.stream === true) {
      assert.ok(request.userPromptPresent, 'Streaming request must contain real submitted chat prompt')
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: modelId, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      chunk({ role: 'assistant', content: '' }); chunk({ content: answer }); chunk({}, 'stop')
      res.end('data: [DONE]\n\n')
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id, object: 'chat.completion', created, model: modelId, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Synthetic packaged smoke title' } }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }))
    }
    request.completed = true
  } catch (error) {
    report.fixtureErrors.push(String(error))
    if (!res.headersSent) res.writeHead(500)
    res.end('synthetic fixture validation failed')
  }
})
server.requestTimeout = 90000
server.headersTimeout = 15000
try {
  const audit = spawnSync(process.execPath, ['--experimental-import-meta-resolve', join(root, 'scripts/validate-packaged-dependencies.mjs'), '--app-root', packagedApp, '--compare-root', root], { encoding: 'utf8', timeout: 60000, cwd: root })
  assert.equal(audit.status, 0, audit.stdout + audit.stderr)
  report.dependencyAudit = JSON.parse(audit.stdout)
  record(`Packaged static boot/plugin graph: ${report.dependencyAudit.filesChecked} files, ${report.dependencyAudit.importsChecked} imports; none resolve outside artifact`)
  report.identities = []
  for (const file of [executable, join(packagedApp, 'package.json'), join(packagedApp, 'out/main/index.js')]) report.identities.push({ path: file, bytes: (await stat(file)).size, sha256: createHash('sha256').update(await readFile(file)).digest('hex') })
  await mkdir(profile); await mkdir(workspace)
  const projectRoot = join(workspace, 'synthetic-project')
  await mkdir(projectRoot)
  const seed = new DatabaseSync(join(profile, 'researchpilot.db'))
  try {
    seed.exec(`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', root_path TEXT NOT NULL UNIQUE, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    seed.prepare('INSERT INTO app_settings VALUES (?, ?)').run('app', JSON.stringify({ workspaceRoot: workspace, telemetry: false }))
    seed.prepare('INSERT INTO app_settings VALUES (?, ?)').run('activeProjectId', JSON.stringify(projectId))
    seed.prepare('INSERT INTO projects (id,name,description,root_path,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(projectId, 'Packaged runtime fixture', 'Synthetic local smoke; not research evidence.', projectRoot, stamp, stamp)
    assert.equal(JSON.parse(seed.prepare('SELECT value_json FROM app_settings WHERE key = ?').get('app').value_json).workspaceRoot, workspace)
    assert.equal(seed.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId).root_path, projectRoot)
  } finally { seed.close() }
  baseline = await metadataSnapshot(defaultRoots)
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (/API[_-]?KEY|TOKEN|SECRET|PASSWORD|PROXY|BASE_URL|API_BASE/i.test(name) || /^(RESEARCHPILOT_|DSH_|ELECTRON_RUN_AS_NODE$|ELECTRON_RENDERER_URL$|ELECTRON_START_URL$|NODE_OPTIONS$|NODE_PATH$|VITE_)/i.test(name)) delete env[name]
  env.NO_PROXY = '127.0.0.1,localhost'
  env.DSH_TELEMETRY_DISABLED = '1'
  const args = [`--user-data-dir=${profile}`, '--disable-background-networking', '--disable-component-update']
  app = await electron.launch({ executablePath: executable, args, cwd: runDir, env, timeout: 60000 })
  report.runtime = await app.evaluate(({ app }) => ({ isPackaged: app.isPackaged, executable: process.execPath, appPath: app.getAppPath(), userData: app.getPath('userData'), resources: process.resourcesPath, documents: app.getPath('documents'), argv: process.argv, version: app.getVersion() }))
  assert.equal(report.runtime.isPackaged, true)
  assert.equal(resolve(report.runtime.executable), executable)
  assert.equal(resolve(report.runtime.appPath), packagedApp)
  assert.equal(resolve(report.runtime.userData), profile)
  assert.equal(report.runtime.version, version)
  assert.ok(report.runtime.argv.includes(`--user-data-dir=${profile}`))
  assert.ok(!report.runtime.argv.some(arg => resolve(arg).toLowerCase() === root.toLowerCase()), 'Repository must not be an app launch argument')
  inside(runDir, report.runtime.userData)
  assert.ok(defaultRoots.some(dir => resolve(dir).toLowerCase() === join(report.runtime.documents, 'ResearchPilot').toLowerCase()), 'Unexpected redirected Documents path')
  record('Actual packaged ResearchPilot.exe isPackaged=true, packaged app path, isolated --user-data-dir; no repository launch argument')
  await app.evaluate(({ session }) => {
    globalThis.packagedAgentBlocked = []
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(details.url).hostname)
      if (!local) globalThis.packagedAgentBlocked.push(new URL(details.url).origin)
      callback({ cancel: !local })
    })
  })
  page = await app.firstWindow()
  page.on('pageerror', error => report.rendererErrors.push(error.message))
  await page.waitForFunction(() => typeof window.researchpilot?.bootstrap === 'function', undefined, { timeout: 60000 })
  assert.equal(new URL(page.url()).protocol, 'file:')
  const initial = await page.evaluate(() => window.researchpilot.bootstrap())
  assert.equal(initial.projects.length, 1)
  assert.equal(initial.projects[0].id, projectId)
  assert.equal(resolve(initial.settings.workspaceRoot), workspace)
  assert.equal(initial.providers.some(provider => provider.hasApiKey), false)
  record('Preseeded isolated project/settings loaded before any provider configuration')
  await page.evaluate(async ({ providerId, modelId, baseUrl, syntheticKey }) => {
    await window.researchpilot.providers.upsert({ id: providerId, name: 'Packaged local fixture', kind: 'custom', protocol: 'openai-completions', baseUrl, apiKey: syntheticKey, models: [{ id: modelId, label: 'Synthetic model' }], defaultModelId: modelId, isDefault: true })
    await window.researchpilot.settings.update({ telemetry: false, agentRoleModels: {}, reasoningEffort: '', maxOutputTokens: 256 })
    window.packagedAgentStates = []
    window.researchpilot.onEvent(event => { if (event.type === 'agent-status') window.packagedAgentStates.push(event.state) })
  }, { providerId, modelId, baseUrl, syntheticKey })
  const sent = await deadline(page.evaluate(input => window.researchpilot.chat.send(input), { projectId, text: prompt }), 'Packaged SDK start and send')
  report.chatId = sent.chat.id
  const state = await deadline((async () => {
    const end = Date.now() + 90000
    while (Date.now() < end) {
      const snapshot = await page.evaluate(async chatId => ({ state: await window.researchpilot.chat.state(), messages: await window.researchpilot.chat.messages(chatId) }), sent.chat.id)
      if (snapshot.state.status === 'error') throw new Error(`Packaged agent error: ${JSON.stringify(snapshot.state)}`)
      if (snapshot.state.status === 'idle' && snapshot.messages.some(message => message.role === 'assistant' && message.content.includes(answer))) return snapshot
      await new Promise(tick => setTimeout(tick, 100))
    }
    throw new Error('Packaged agent never reached idle with SSE answer')
  })(), 'Packaged SSE reply')
  assert.ok(report.requests.some(request => request.stream && request.userPromptPresent && request.completed))
  assert.equal(state.state.modelId, modelId)
  assert.equal(state.state.providerId, providerId)
  report.result = { state: state.state, assistantReply: state.messages.filter(message => message.role === 'assistant').map(message => message.content) }
  assert.deepEqual(report.fixtureErrors, [])
  assert.deepEqual(report.rendererErrors, [])
  report.agentStates = await page.evaluate(() => window.packagedAgentStates)
  report.blockedExternalRequests = await app.evaluate(() => globalThis.packagedAgentBlocked)
  assert.deepEqual(report.blockedExternalRequests, [])
  const homeManifest = JSON.parse(await readFile(join(profile, 'dsh-home/profiles/sdk/package.json'), 'utf8'))
  assert.ok(homeManifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-sdk-app'))
  record('Real packaged DSH SDK booted sdk profile, issued loopback streaming POST with submitted prompt, persisted expected assistant reply, and returned idle')
  await page.screenshot({ path: join(runDir, 'packaged-agent.png'), fullPage: true })
  report.ok = true
} catch (error) {
  report.failure = error.stack ?? String(error)
  console.error(report.failure)
  process.exitCode = 1
  if (page && !page.isClosed()) {
    report.lastState = await page.evaluate(() => window.researchpilot.chat.state()).catch(String)
    await page.screenshot({ path: join(runDir, 'failure.png'), fullPage: true }).catch(() => {})
  }
} finally {
  if (app) {
    try { await deadline(app.close(), 'Close isolated packaged app', 45000); report.applicationClosed = true } catch (error) { report.failure ??= String(error); report.ok = false; process.exitCode = 1 }
  }
  server.closeAllConnections()
  await new Promise(done => server.close(done))
  if (baseline) {
    try { assert.deepEqual(await metadataSnapshot(defaultRoots), baseline); record('Default ResearchPilot profile/workspace metadata unchanged; isolated smoke files retained') }
    catch (error) { report.failure ??= String(error); report.ok = false; process.exitCode = 1 }
  }
  if (report.identities?.length) {
    try {
      for (const identity of report.identities) assert.equal(createHash('sha256').update(await readFile(identity.path)).digest('hex'), identity.sha256, `Artifact changed during smoke: ${identity.path}`)
      record('Executable and packaged entrypoint identities remained stable throughout smoke')
    } catch (error) { report.failure ??= String(error); report.ok = false; process.exitCode = 1 }
  }
  report.finishedAt = new Date().toISOString()
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`REPORT ${join(runDir, 'report.json')}`)
}
