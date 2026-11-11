import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { _electron as electron } from 'playwright-core'
import { navigateWorkspace } from './workspace-navigation.mjs'

// Run only AFTER the parent confirms a complete build, including AgentService
// paper-context injection: node scripts/smoke-paper-context.mjs
// Real Electron + preload + registered sources + DSH HTTP. Only the provider is
// a loopback fixture. No production service, renderer API, or IPC is replaced.
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const results = join(root, 'test-results')
await mkdir(results, { recursive: true })
const runDir = await mkdtemp(join(results, 'paper-context-'))
const reportPath = join(runDir, 'report.json')
const providerId = 'paper-context-fixture'
const modelId = 'paper-context-selected'
const syntheticKey = 'synthetic-paper-context-not-a-real-key'
const markers = {
  manuscript: 'DOCX_ORIGINAL_714', manuscriptUpdated: 'DOCX_USER_EDIT_829',
  reference: 'REFERENCE_OLD_271', referenceUpdated: 'REFERENCE_UPDATED_482',
  note: 'NOTE_OLD_391', noteUpdated: 'NOTE_UPDATED_593', run: 'RUN_SYNTHETIC_634',
  foreign: 'FOREIGN_PROJECT_PRIVATE_916', turn: 'ACTIVE_MEMORY_REQUEST_527'
}
const memoryFields = {
  question: 'Can synthetic Results accuracy remain traceable? QUESTION_MEMORY_714',
  hypothesis: 'The synthetic workflow preserves n=42 and accuracy=0.91. HYPOTHESIS_MEMORY_715',
  contribution: 'A software-only source trace, not a scientific finding. CONTRIBUTION_MEMORY_716',
  scope: 'Synthetic software test only; no real participants or generalization. SCOPE_MEMORY_717',
  terms: 'accuracy; n=42; Results; TERMS_MEMORY_718'
}
const accepted = 'Keep n=42 and the limited synthetic scope. ACCEPTED_DECISION_719'
const rejected = 'Do not claim clinical effectiveness. REJECTED_DECISION_720'
const unresolved = 'Uncertainty bounds have not been measured. OPEN_ISSUE_721'
const query = 'Results synthetic accuracy sample trace'
const chapter = 'Results'
const markdown = `# Synthetic paper-context manuscript\n\n## Methods\n\nSoftware fixture only, no real research subjects.\n\n## Results\n\nSynthetic accuracy=0.91 with n=42. ${markers.manuscript}. Numbers are software fixture data, not scientific evidence.\n\n## Limitations\n\nNo generalization or effectiveness claim is supported.\n`
const referenceAbstract = marker => `Results synthetic accuracy=0.91, sample n=42. ${marker}. Synthetic bibliographic fixture only, not a published finding.`
const noteBody = marker => `## Results\nSynthetic accuracy sample trace n=42; ${marker}. Author note only, not independent evidence.`
const turnPrompt = `${markers.turn}: Results synthetic accuracy sample trace. Reply briefly without tools or file changes. This is a synthetic software test.`
const answer = 'PAPER_CONTEXT_LOCAL_FIXTURE_ACK_528'
const checks = [], errors = [], fixtureErrors = [], requests = [], screenshots = [], blockedRequests = []
const report = {
  startedAt: new Date().toISOString(), ok: false, runDir, reportPath,
  checks, errors, fixtureErrors, requests, screenshots, blockedRequests,
  limits: [
    'Local lexical/chapter matching, not vector retrieval or scientific fact verification.',
    'DOCX body text only; this test does not verify tables, images, equations, or page layout.',
    'Synthetic reference has no PDF; PDF text-layer extraction and OCR are not exercised. No OCR is provided by this workflow.',
    'Run coverage is registered status/metrics/artifact-directory metadata, not artifact contents, logs, or environment.',
    'Loopback provider configuration and Electron network guard are not an OS-level network sandbox.',
    'Project backup service is intentionally outside this smoke journey.'
  ]
}
const record = name => { checks.push(name); console.log(`PASS ${name}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const env = {
  ...process.env,
  RESEARCHPILOT_USER_DATA: join(runDir, 'profile'),
  RESEARCHPILOT_WORKSPACE_ROOT: join(runDir, 'workspace'),
  DSH_TELEMETRY_DISABLED: '1'
}
for (const name of Object.keys(env)) {
  if (/API[_-]?KEY|TOKEN|SECRET|PASSWORD|PROXY|BASE_URL|API_BASE/i.test(name) ||
      ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS', 'DSH_HOME'].includes(name)) delete env[name]
}
env.NO_PROXY = '127.0.0.1,localhost'
let app, page, fixtureBaseUrl, projectId, document, reference, note, experiment, run
let expectedDocBase64, savedMemory

function deadline(promise, label, timeout = 60000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: ${timeout}ms deadline exceeded`)), timeout) })
  ]).finally(() => clearTimeout(timer))
}

// Poll real IPC on the host: this Playwright version does not await asynchronous
// waitForFunction predicates. Never use an unbounded loop or waitForTimeout.
async function until(condition, label) {
  return deadline((async () => {
    const end = Date.now() + 60000
    while (Date.now() < end) {
      const value = await condition()
      if (value) return value
      await new Promise(resolveTick => setTimeout(resolveTick, 100))
    }
    throw new Error(`${label}: condition not met within 60000ms`)
  })(), label)
}

function api(group, method, ...args) {
  return deadline(page.evaluate(async ({ group, method, args }) => {
    const target = window.researchpilot[group]
    if (typeof target?.[method] !== 'function') throw new Error(`Built preload API missing: ${group}.${method}; complete rebuild required`)
    return target[method](...args)
  }, { group, method, args }), `Preload ${group}.${method}`)
}

function discoverPython() {
  const options = { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 }
  const probe = candidate => execFileSync(candidate, ['-I', '-c', 'import sys; assert sys.version_info >= (3, 10); print(sys.executable)'], options).trim()
  if (process.env.RESEARCHPILOT_TEST_PYTHON) return probe(process.env.RESEARCHPILOT_TEST_PYTHON)
  try { return probe(execFileSync('uv', ['python', 'find', '--offline'], options).trim()) }
  catch { return probe('python') }
}

const textOf = message => typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '')
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(req.headers.authorization, `Bearer ${syntheticKey}`)
    let body = ''
    for await (const chunk of req) {
      body += chunk.toString('utf8')
      assert.ok(Buffer.byteLength(body) < 4 * 1024 * 1024, 'Fixture request exceeds limit')
    }
    const payload = JSON.parse(body)
    assert.equal(payload.model, modelId, 'Explicit default model must win over first model in list')
    assert.ok(Array.isArray(payload.messages))
    // All inputs in this fresh profile are synthetic. Never record auth headers.
    const entry = { index: requests.length, model: payload.model, stream: payload.stream === true, payload }
    requests.push(entry)
    const id = `paper-context-response-${entry.index}`
    const created = Math.floor(Date.now() / 1000)
    if (payload.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      const chunk = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: modelId, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
      chunk({ role: 'assistant', content: '' })
      chunk({ content: answer })
      chunk({}, 'stop')
      res.end('data: [DONE]\n\n')
    } else {
      // Plain completions cover DSH auxiliary title/summary calls too.
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id, object: 'chat.completion', created, model: modelId, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: answer } }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } }))
    }
    entry.completed = true
  } catch (error) {
    fixtureErrors.push(error instanceof Error ? error.stack : String(error))
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Synthetic paper-context fixture validation failed' } }))
  }
})
server.requestTimeout = 60000
server.headersTimeout = 15000

async function launch() {
  app = await electron.launch({ executablePath: require('electron'), args: [root, '--disable-background-networking'], cwd: root, env, timeout: 60000 })
  await deadline(app.evaluate(({ session }, allowed) => {
    globalThis.paperContextSmokeBlockedRequests = []
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      const permitted = details.url === allowed
      if (!permitted) globalThis.paperContextSmokeBlockedRequests.push(details.url)
      callback({ cancel: !permitted })
    })
  }, `${fixtureBaseUrl}/chat/completions`), 'Install loopback-only Electron network guard')
  page = await app.firstWindow({ timeout: 60000 })
  page.setDefaultTimeout(30000)
  page.setDefaultNavigationTimeout(60000)
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.research-home').waitFor({ timeout: 60000 })
  assert.equal(new URL(page.url()).protocol, 'file:', 'Must use built renderer, not development server')
  await page.setViewportSize({ width: 1500, height: 1100 })
}

async function closeApp() {
  if (!app) return
  blockedRequests.push(...await deadline(app.evaluate(() => globalThis.paperContextSmokeBlockedRequests ?? []), 'Collect blocked requests', 10000))
  await deadline(app.close(), 'Close Electron', 45000)
  app = undefined
}

async function screenshot(name, locator) {
  const path = join(runDir, name)
  // The workbench scrolls inside its own pane. A screenshot of an oversized
  // panel can include blank offscreen areas, so frame the relevant UI in a
  // normal viewport and finish finite entrance animations before capture.
  if (locator) await locator.evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path, fullPage: false, animations: 'disabled', timeout: 30000 })
  screenshots.push(path)
}

async function confirmAction(action, expectedMessage) {
  const dialogPromise = page.waitForEvent('dialog', { timeout: 30000 })
  const clicking = action()
  // Attach a rejection handler immediately while the native dialog is open.
  clicking.catch(() => {})
  const dialog = await dialogPromise
  assert.equal(dialog.type(), 'confirm')
  assert.match(dialog.message(), expectedMessage)
  await dialog.accept()
  await clicking
}

class PaperJourney {
  constructor(page) { this.page = page }
  get panel() { return this.page.getByRole('region', { name: '论文上下文', exact: true }) }
  get preview() { return this.panel.locator('.paper-preview') }
  button(name) { return this.panel.getByRole('button', { name, exact: true }) }
  field(name) { return this.panel.getByRole('textbox', { name, exact: true }) }
  async idle() {
    await this.panel.locator('.paper-context-body[aria-busy="false"]').waitFor({ timeout: 60000 })
    assert.equal(await this.panel.getByRole('alert').count(), 0, 'Panel must not contain an error')
  }
  async open() {
    await navigateWorkspace(this.page, '/writing')
    await this.panel.waitFor()
    const select = this.page.getByRole('combobox', { name: '当前稿件', exact: true })
    await select.locator(`option[value="${document.id}"]`).waitFor({ state: 'attached' })
    await this.idle()
    await select.selectOption(document.id)
    await this.idle()
    await this.button('编辑记忆').waitFor()
    assert.equal(await this.panel.locator('textarea:visible').count(), 0, 'Memory opens as a summary, not a form')
  }
  async editMemory() {
    await this.button('编辑记忆').click()
    await this.field('主要问题').waitFor()
  }
  async details(name) {
    const summary = this.panel.locator('summary').filter({ hasText: name })
    assert.equal(await summary.count(), 1)
    if (!await summary.evaluate(element => element.parentElement.open)) await summary.click()
  }
  async link(kind, targetId) {
    await this.details(/^来源与证据/)
    await this.panel.getByRole('combobox', { name: '来源类型', exact: true }).selectOption(kind)
    await this.button('读取列表').click()
    await this.idle()
    await this.panel.getByRole('combobox', { name: '项目来源', exact: true }).selectOption(targetId)
    await this.button('关联来源').click()
    await this.idle()
  }
  async compose() {
    await this.details(/^章节写作$/)
    await this.field('章节').fill(chapter)
    await this.field('写作任务').fill(query)
    await this.button('预览上下文').click()
    await this.idle()
    await this.preview.waitFor()
    await this.details(/^完整上下文$/)
    return this.preview.locator('pre').innerText()
  }
}

const snapshot = () => api('paperContext', 'get', projectId, document.id)
const compose = () => api('paperContext', 'compose', { projectId, documentId: document.id, query, chapter })

// These are metadata/content fingerprints, NOT hashes of the redacted excerpts.
// Recompute against actual source bytes/records to catch a merely plausible hash.
function expectedHashes(docBase64, ref, currentNote, currentRun) {
  return new Map([
    [document.id, sha(JSON.stringify({ title: document.title, path: document.relativePath, format: document.format, bytes: sha(Buffer.from(docBase64, 'base64')) }))],
    [ref.id, sha(JSON.stringify({ title: ref.title, authors: ref.authors, year: ref.year, venue: ref.venue, doi: ref.doi, url: ref.url, abstract: ref.abstract, notes: ref.notes, tags: ref.tags, bibtex: ref.bibtex, pdfPath: ref.pdfRelativePath, pdfHash: '' }))],
    [currentNote.id, sha(JSON.stringify({ title: currentNote.title, body: currentNote.body }))],
    [currentRun.id, sha(JSON.stringify({ experimentId: currentRun.experimentId, status: currentRun.status, exitCode: currentRun.exitCode, startedAt: currentRun.startedAt, finishedAt: currentRun.finishedAt, metrics: currentRun.metrics, artifactDir: currentRun.artifactDir }))]
  ])
}

function assertTrace(context, currentSnapshot, expectedMarkers) {
  assert.equal(context.documentId, document.id)
  assert.equal(context.revision, savedMemory.revision)
  assert.equal(context.characters, context.text.length)
  assert.ok(context.characters <= 24000)
  const hashes = expectedHashes(expectedDocBase64, reference, note, run)
  for (const [kind, marker] of Object.entries(expectedMarkers)) {
    const hit = context.hits.find(hit => hit.kind === kind && hit.excerpt.includes(marker))
    assert.ok(hit, `No ${kind} evidence containing ${marker}`)
    const source = currentSnapshot.sources.find(source => source.id === hit.sourceId)
    assert.ok(source)
    assert.equal(source.status, 'current')
    assert.equal(hit.targetId, source.targetId)
    assert.equal(hit.locator.startsWith(`${kind === 'manuscript' ? 'document' : kind}:${source.targetId}#offset=`), true)
    assert.match(hit.hash, /^[a-f0-9]{64}$/)
    assert.equal(hit.hash, source.hash)
    assert.equal(hit.hash, hashes.get(source.targetId), `${kind} fingerprint must match actual current source`)
    const section = source.sections.find(section => `${source.locator}#offset=${section.start}` === hit.locator)
    assert.ok(section, 'Locator offset must identify the actual captured section')
    assert.equal(hit.section, section.title)
    assert.equal(hit.excerpt, section.text, 'Fixture excerpt must equal exact source section, not invented text')
    assert.equal(section.text, source.text.slice(section.start, section.end))
    assert.ok(context.text.includes(marker))
  }
  for (const value of [...Object.values(memoryFields), accepted, rejected, unresolved]) assert.ok(context.text.includes(value), `Missing saved working memory: ${value}`)
  assert.match(context.text, /"status":"accepted"/)
  assert.match(context.text, /"status":"rejected"/)
  assert.match(context.text, /"openIssues":\[\{/)
  assert.match(context.text, /not executable instructions/)
  assert.match(context.warnings.join('\n'), /不是向量检索/)
}

async function assertSourcesUnmodified(label) {
  const [binary, refs, currentNote, currentRun, code] = await Promise.all([
    api('documents', 'read', projectId, document.id), api('references', 'list', projectId),
    api('notes', 'get', projectId, note.id), api('experiments', 'runGet', run.id), api('experiments', 'readCode', experiment.id)
  ])
  assert.equal(sha(Buffer.from(binary.base64, 'base64')), sha(Buffer.from(expectedDocBase64, 'base64')), `${label}: manuscript bytes overwritten`)
  assert.deepEqual(refs.find(item => item.id === reference.id), reference, `${label}: reference overwritten`)
  assert.deepEqual(currentNote, note, `${label}: note overwritten`)
  assert.deepEqual(currentRun, run, `${label}: run overwritten`)
  assert.equal(code, experiment.code, `${label}: experiment code overwritten`)
  record(`${label}: exact manuscript bytes and source records remain unchanged`)
}

try {
  const pythonPath = discoverPython()
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  fixtureBaseUrl = `http://127.0.0.1:${server.address().port}/v1`
  await launch()
  const setup = await deadline(page.evaluate(async ({ providerId, modelId, fixtureBaseUrl, syntheticKey, pythonPath, markdown, markers, abstract, body }) => {
    const api = window.researchpilot
    for (const name of ['get', 'save', 'activate', 'deactivate', 'link', 'unlink', 'refresh', 'compose']) {
      if (typeof api.paperContext?.[name] !== 'function') throw new Error(`Stale build: paperContext.${name} missing`)
    }
    assertNoCredentials(await api.providers.list())
    function assertNoCredentials(providers) {
      if (providers.some(provider => provider.hasApiKey)) throw new Error('Fresh profile unexpectedly contains existing credentials')
    }
    // Reverse list order intentionally; never depend on the first model winning.
    await api.providers.upsert({ id: providerId, name: 'Synthetic paper-context loopback', kind: 'custom', protocol: 'openai-completions', baseUrl: fixtureBaseUrl, apiKey: syntheticKey, models: [{ id: 'paper-context-unused-first', label: 'Unused first model' }, { id: modelId, label: 'Selected fixture model' }], defaultModelId: modelId, isDefault: true })
    const settings = await api.settings.update({ defaultProviderId: providerId, defaultModelId: modelId, agentRoleModels: {}, pythonPath, telemetry: false, reasoningEffort: '', maxOutputTokens: 256 })
    const bootstrap = await api.bootstrap()
    const projectId = bootstrap.activeProjectId
    if (!projectId) throw new Error('No isolated project')
    const document = await api.documents.create({ projectId, title: 'Synthetic paper-context DOCX', format: 'docx', markdown })
    const reference = await api.references.upsert({ projectId, title: 'Synthetic traceability reference', authors: 'Fixture Author', year: '2026', venue: 'Not a real publication', abstract, notes: 'Synthetic source only; no PDF attached.', tags: ['synthetic'] })
    const note = await api.notes.create({ projectId, title: 'Synthetic Results note', body })
    const code = `print('RESEARCHPILOT_METRIC:{"accuracy":0.91,"n":42,"fixture":"Results synthetic accuracy ${markers.run}"}')\nprint('RUN_LOG_NOT_EVIDENCE_635')\n`
    const experiment = await api.experiments.create({ projectId, name: 'Synthetic paper-context run', description: 'Software fixture only; no external packages or network.', envKind: 'local', code })
    const run = await api.experiments.run(experiment.id)
    return { settings, projectId, document, reference, note, experiment: { ...experiment, code }, run }
  }, { providerId, modelId, fixtureBaseUrl, syntheticKey, pythonPath, markdown, markers, abstract: referenceAbstract(markers.reference), body: noteBody(markers.note) }), 'Create synthetic sources through real preload')
  ;({ projectId, document, reference, note, experiment, run } = setup)
  assert.equal(setup.settings.defaultProviderId, providerId)
  assert.equal(setup.settings.defaultModelId, modelId)
  assert.equal(resolve(setup.settings.workspaceRoot), resolve(env.RESEARCHPILOT_WORKSPACE_ROOT))
  assert.equal(document.format, 'docx')
  run = await until(async () => {
    const current = await api('experiments', 'runGet', run.id)
    return ['succeeded', 'failed', 'cancelled'].includes(current.status) ? current : false
  }, 'Wait for real synthetic Python run')
  assert.equal(run.status, 'succeeded', `Synthetic run failed: ${run.stderr}`)
  assert.equal(run.metrics.accuracy, 0.91)
  assert.equal(run.metrics.n, 42)
  expectedDocBase64 = (await api('documents', 'read', projectId, document.id)).base64
  assert.equal(Buffer.from(expectedDocBase64, 'base64').subarray(0, 2).toString(), 'PK', 'Actual DOCX must be a ZIP container')
  assert.ok((await api('documents', 'readText', projectId, document.id)).text.includes(markers.manuscript))
  report.configuration = { projectId, documentId: document.id, referenceId: reference.id, noteId: note.id, runId: run.id, providerId, modelId, pythonPath, profile: env.RESEARCHPILOT_USER_DATA, workspace: env.RESEARCHPILOT_WORKSPACE_ROOT, fixtureBaseUrl }
  record('Real preload creates isolated DOCX from Markdown, reference, note, and successful Python run with explicit non-first default model')

  // Refresh bootstrap/store through the actual built app, not private store hooks.
  await page.reload()
  await page.locator('.research-home').waitFor({ timeout: 60000 })
  let ui = new PaperJourney(page)
  await ui.open()
  await ui.editMemory()
  for (const [key, label] of [['question', '主要问题'], ['hypothesis', '假设'], ['contribution', '贡献'], ['scope', '适用范围'], ['terms', '术语']]) await ui.field(label).fill(memoryFields[key])
  await ui.details(/^决定与问题/)
  for (const [index, value, status] of [[1, accepted, 'accepted'], [2, rejected, 'rejected']]) {
    await ui.button('添加决定').click()
    await ui.field(`决定 ${index}`).fill(value)
    await ui.field(`决定 ${index} 章节`).fill(chapter)
    await ui.panel.getByRole('combobox', { name: `决定 ${index} 状态`, exact: true }).selectOption(status)
  }
  await ui.button('添加问题').click()
  await ui.field('问题 1').fill(unresolved)
  await ui.field('问题 1 章节').fill(chapter)
  assert.equal(await ui.panel.getByRole('checkbox', { name: '已解决', exact: true }).isChecked(), false)
  await ui.details(/^章节写作$/)
  assert.equal(await ui.button('预览上下文').isDisabled(), true, 'Unsaved memory cannot be composed')
  await ui.button('保存记忆').click()
  await ui.idle()
  await ui.panel.getByText('记忆已保存。', { exact: true }).waitFor()
  savedMemory = (await snapshot()).memory
  for (const [key, value] of Object.entries(memoryFields)) assert.equal(savedMemory[key], value)
  assert.deepEqual(savedMemory.decisions.map(item => [item.text, item.status, item.chapter]), [[accepted, 'accepted', chapter], [rejected, 'rejected', chapter]])
  assert.deepEqual(savedMemory.issues.map(item => [item.text, item.chapter, item.resolved]), [[unresolved, chapter, false]])
  assert.equal(savedMemory.revision, 1)
  // Saving deliberately keeps the editor open; the user returns to the summary.
  await ui.button('返回摘要').click()
  await ui.field('主要问题').waitFor({ state: 'hidden' })
  for (const [kind, targetId] of [['reference', reference.id], ['note', note.id], ['run', run.id]]) await ui.link(kind, targetId)
  await ui.button('设为当前论文').click()
  await ui.idle()
  await ui.panel.getByText('助手当前论文', { exact: true }).waitFor()
  assert.equal((await snapshot()).active, true)
  record('Writing panel saves question/hypothesis/scope/terms, accepted and rejected decisions, unresolved issue; links reference/note/run and activates paper')

  const initialUiText = await ui.compose()
  const initial = await compose(), initialSnapshot = await snapshot()
  assertTrace(initial, initialSnapshot, { manuscript: markers.manuscript, reference: markers.reference, note: markers.note, run: markers.run })
  assert.equal(initialUiText, initial.text, 'Rendered complete context must match preload compose contract')
  assert.equal(initialSnapshot.sources.length, 4)
  assert.ok(initialSnapshot.sources.every(source => source.status === 'current'))
  assert.ok(!initial.text.includes('RUN_LOG_NOT_EVIDENCE_635'))
  report.initial = { context: initial, snapshot: initialSnapshot }
  // Expand evidence cards and assert the UI itself displays source text and trace.
  const evidenceCards = await ui.preview.locator('details.paper-source').all()
  assert.equal(evidenceCards.length, initial.hits.length)
  for (const [index, details] of evidenceCards.entries()) {
    await details.locator('summary').click()
    assert.equal(await details.locator('dd').nth(0).innerText(), initial.hits[index].locator)
    assert.equal(await details.locator('dd').nth(1).innerText(), initial.hits[index].hash)
    assert.equal(await details.locator('.paper-evidence').innerText(), initial.hits[index].excerpt)
  }
  await screenshot('01-memory-and-source-trace.png', ui.panel)
  await screenshot('01b-evidence-locators-and-hashes.png', ui.preview)
  await assertSourcesUnmodified('Compose and source linking')
  assert.equal(requests.length, 0, 'Local preview must not call any model')
  record('Results UI/API agree on actual source text, metadata fingerprints and section-offset locators; no model request or run-log evidence')

  reference = await api('references', 'upsert', { id: reference.id, projectId, title: reference.title, abstract: referenceAbstract(markers.referenceUpdated) })
  note = await api('notes', 'update', { projectId, id: note.id, title: note.title, body: noteBody(markers.noteUpdated), expectedRevision: note.revision })
  const changedUiText = await ui.compose()
  const changed = await compose(), changedSnapshot = await snapshot()
  for (const id of [reference.id, note.id]) {
    assert.equal(changedSnapshot.sources.find(source => source.targetId === id)?.status, 'changed')
    assert.equal(changed.hits.some(hit => hit.targetId === id), false)
  }
  for (const marker of [markers.reference, markers.note, markers.referenceUpdated, markers.noteUpdated]) {
    assert.ok(!changed.text.includes(marker), `Unrefreshed evidence leaked ${marker}`)
    assert.ok(!changedUiText.includes(marker), `Unrefreshed UI evidence leaked ${marker}`)
  }
  assert.match(changed.warnings.join('\n'), /来源已变化/)
  assert.match(changedUiText, /来源已变化/)
  await ui.button('检查状态').click()
  await ui.idle()
  assert.equal(await ui.panel.locator('article.paper-source').filter({ hasText: '已变化' }).count(), 2)
  report.changed = { context: changed, snapshot: changedSnapshot }
  await screenshot('02-stale-sources-excluded.png', ui.panel.locator('article.paper-source').filter({ hasText: '已变化' }).first())
  await assertSourcesUnmodified('Changed-source exclusion')
  record('Preload reference/note mutations produce UI/API changed warnings and exclude both stale and unrefreshed current markers')

  await confirmAction(() => ui.button('更新快照').click(), /不写入或修改任何来源文件/)
  await ui.idle()
  const refreshedUiText = await ui.compose()
  const refreshed = await compose(), refreshedSnapshot = await snapshot()
  assertTrace(refreshed, refreshedSnapshot, { manuscript: markers.manuscript, reference: markers.referenceUpdated, note: markers.noteUpdated, run: markers.run })
  assert.equal(refreshedUiText, refreshed.text)
  assert.ok(!refreshed.text.includes(markers.reference))
  assert.ok(!refreshed.text.includes(markers.note))
  assert.ok(!refreshed.warnings.some(warning => warning.includes('来源已变化')))
  for (const id of [reference.id, note.id]) assert.notEqual(refreshedSnapshot.sources.find(source => source.targetId === id)?.hash, initialSnapshot.sources.find(source => source.targetId === id)?.hash)
  report.refreshed = { context: refreshed, snapshot: refreshedSnapshot }
  await assertSourcesUnmodified('Explicit UI refresh')
  record('Confirmed UI snapshot refresh adopts updated reference/note markers and fingerprints without overwriting source content')

  // Simulate an author DOCX edit through the public binary-save preload API.
  // Modify only our unique plain ASCII marker inside the real document XML.
  const zip = await JSZip.loadAsync(Buffer.from(expectedDocBase64, 'base64'))
  const xml = await zip.file('word/document.xml').async('string')
  assert.equal(xml.split(markers.manuscript).length - 1, 1, 'Marker must occur once in DOCX body XML')
  zip.file('word/document.xml', xml.replace(markers.manuscript, markers.manuscriptUpdated))
  expectedDocBase64 = (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64')
  await api('documents', 'save', projectId, document.id, expectedDocBase64)
  const editedUiText = await ui.compose() // First compose must carry automatic update warning.
  assert.match(editedUiText, /主文稿内容已更新/)
  assert.ok(editedUiText.includes(markers.manuscriptUpdated))
  assert.ok(!editedUiText.includes(markers.manuscript))
  assert.match(await ui.preview.innerText(), /主文稿内容已更新/)
  const edited = await compose(), editedSnapshot = await snapshot()
  assertTrace(edited, editedSnapshot, { manuscript: markers.manuscriptUpdated, reference: markers.referenceUpdated, note: markers.noteUpdated, run: markers.run })
  assert.notEqual(editedSnapshot.sources.find(source => source.kind === 'manuscript')?.hash, initialSnapshot.sources.find(source => source.kind === 'manuscript')?.hash)
  assert.deepEqual(editedSnapshot.memory, savedMemory, 'Manuscript indexing must not silently change author memory revision')
  assert.ok((await api('documents', 'versions', projectId, document.id)).length >= 1, 'Author save must preserve a document version')
  report.manuscriptEdit = { firstUiContext: editedUiText, context: edited, snapshot: editedSnapshot }
  await screenshot('03-docx-auto-version-warning.png', ui.preview)
  await assertSourcesUnmodified('Automatic manuscript reindex')
  record('Author DOCX save automatically reindexes with visible version-consistency warning, new hash and preserved saved memory')

  // Deliberately mismatched IDs must fail across IPC, not just UI filtering.
  const foreign = await api('projects', 'create', { name: 'Synthetic foreign project boundary' })
  const foreignDoc = await api('documents', 'create', { projectId: foreign.id, title: 'Foreign synthetic DOCX', format: 'docx', markdown: `# Results\n${markers.foreign}` })
  const foreignNote = await api('notes', 'create', { projectId: foreign.id, title: 'Foreign synthetic note', body: markers.foreign })
  const foreignRef = await api('references', 'upsert', { projectId: foreign.id, title: 'Foreign synthetic reference', abstract: markers.foreign })
  // Project creation selects it in persisted settings; restore the original
  // selection explicitly without navigating away or replacing the panel/store.
  await api('projects', 'setActive', projectId)
  const rejectedCalls = [
    ['get', [projectId, foreignDoc.id]],
    ['save', [projectId, { ...savedMemory, documentId: foreignDoc.id }]],
    ['activate', [projectId, foreignDoc.id]],
    ['refresh', [projectId, foreignDoc.id]],
    ['compose', [{ projectId, documentId: foreignDoc.id, query, chapter }]],
    ['link', [{ projectId, documentId: document.id, kind: 'note', targetId: foreignNote.id }]],
    ['link', [{ projectId, documentId: document.id, kind: 'reference', targetId: foreignRef.id }]],
    ['unlink', [foreign.id, foreignDoc.id, editedSnapshot.sources[0].id]]
  ]
  for (const [method, args] of rejectedCalls) await assert.rejects(() => api('paperContext', method, ...args), /不存在|不属于|无效|不可用/)
  assert.deepEqual((await snapshot()).memory, savedMemory)
  assert.equal((await snapshot()).active, true)
  assert.ok(!(await compose()).text.includes(markers.foreign))
  report.crossProjectRejected = rejectedCalls.map(([method]) => method)
  record('Cross-project get/save/activate/refresh/compose/link/unlink calls reject over real preload; active paper and memory unchanged')

  // Prepare revalidates a fresh compose. A manuscript-update warning belongs to
  // the indexing turn only, so acknowledge it with a stable current UI preview.
  const handoffUiText = await ui.compose()
  assert.equal(handoffUiText, edited.text)
  const chatsBefore = await api('chat', 'list', projectId)
  const requestsBeforePrepare = requests.length
  await ui.button('准备章节写作').click()
  const composer = page.locator('.agent-page .composer-box')
  const input = composer.getByRole('textbox')
  await input.waitFor()
  await until(async () => (await input.inputValue()).includes('untrusted_paper_draft'), 'Wait for seeded unsent paper draft')
  const preparedPrompt = await input.inputValue()
  const envelope = /<untrusted_paper_draft>\n([\s\S]*?)\n<\/untrusted_paper_draft>/.exec(preparedPrompt)
  assert.ok(envelope)
  const prepared = JSON.parse(envelope[1])
  assert.equal(prepared.documentId, document.id)
  assert.equal(prepared.revision, savedMemory.revision)
  assert.equal(prepared.chapter, chapter)
  assert.equal(prepared.query, query)
  assert.equal(prepared.context, handoffUiText, 'newChat handoff must preserve the exact freshly revalidated preview')
  const chatsAfter = await api('chat', 'list', projectId)
  assert.equal(chatsAfter.length, chatsBefore.length + 1)
  const preparedChat = chatsAfter.find(chat => !chatsBefore.some(before => before.id === chat.id))
  assert.ok(preparedChat)
  assert.deepEqual(await api('chat', 'messages', preparedChat.id), [], 'Prepare must not store or send any message')
  assert.equal(requests.length, requestsBeforePrepare)
  assert.equal((await snapshot()).active, true)
  assert.deepEqual((await snapshot()).memory, savedMemory)
  assert.equal(await composer.getByRole('combobox', { name: '本轮模型', exact: true }).inputValue(), JSON.stringify([providerId, modelId]))
  report.handoff = { chatId: preparedChat.id, prepared, unsent: true, modelRequests: requests.length }
  await screenshot('04-unsent-new-chat-handoff.png')
  await assertSourcesUnmodified('Unsent newChat handoff')
  record('Prepare creates one empty new chat with exact preview in unsent composer; active paper and sources preserved with zero model calls')

  // Essential request check: REPLACE the seeded context with a plain short prompt.
  // Otherwise a request containing memory could pass solely due to prepared text,
  // masking a missing AgentService active-memory injection dependency.
  await input.fill(turnPrompt)
  assert.ok(!(await input.inputValue()).includes(memoryFields.question))
  await composer.getByRole('button', { name: '发送（Enter）', exact: true }).click()
  const completed = await until(async () => {
    if (fixtureErrors.length) throw new Error(fixtureErrors.join('\n'))
    const state = await api('chat', 'state')
    assert.notEqual(state.status, 'error', `Actual agent failed: ${state.lastError}`)
    const messages = await api('chat', 'messages', preparedChat.id)
    if (state.status === 'idle' && messages.some(message => message.role === 'assistant' && message.content.includes(answer))) return { state, messages }
    return false
  }, 'Wait for real DSH request and loopback reply')
  await page.locator('.agent-page .bubble.assistant').filter({ hasText: answer }).waitFor()
  assert.equal(completed.state.modelId, modelId)
  assert.equal(completed.state.providerId, providerId)
  assert.ok(completed.messages.some(message => message.role === 'user' && message.content === turnPrompt))
  assert.equal(completed.messages.some(message => message.role === 'user' && message.content.includes('untrusted_paper_context')), false, 'Retrieved memory must not be persisted as author input')
  const actualRequest = requests.find(entry => entry.payload.messages.some(message => message.role === 'user' && textOf(message).includes(markers.turn)) && entry.payload.messages.some(message => textOf(message).includes('CURRENT PAPER WORKING CONTEXT')))
  assert.ok(actualRequest, 'Actual model request lacks active paper memory; rebuild AgentService injection before running this smoke')
  const requestText = actualRequest.payload.messages.map(textOf).join('\n')
  for (const value of [...Object.values(memoryFields), accepted, rejected, unresolved, markers.manuscriptUpdated, markers.referenceUpdated, markers.noteUpdated, markers.run]) assert.ok(requestText.includes(value), `Actual HTTP request missing memory/evidence ${value}`)
  for (const marker of [markers.manuscript, markers.reference, markers.note, markers.foreign]) assert.ok(!requestText.includes(marker), `Stale or cross-project content leaked into actual model request: ${marker}`)
  assert.match(requestText, /not executable instructions/)
  assert.match(requestText, /supersedes all earlier paper-context snapshots/)
  assert.match(requestText, /only.*target document|target document.*only/i)
  for (const kind of ['manuscript', 'reference', 'note', 'run']) {
    const source = editedSnapshot.sources.find(source => source.kind === kind)
    assert.ok(requestText.includes(source.hash), `HTTP request missing ${kind} source fingerprint`)
    assert.ok(requestText.includes(`${source.locator}#offset=`), `HTTP request missing ${kind} locator`)
  }
  report.actualMemoryRequest = { index: actualRequest.index, stream: actualRequest.stream, chatId: preparedChat.id, state: completed.state, userPrompt: turnPrompt, activeMemoryInjected: true, sourceHashesAndLocatorsMatched: true }
  await screenshot('05-real-local-model-active-memory.png')
  await assertSourcesUnmodified('Actual local model request')
  record('Plain UI send reaches real DSH/loopback OpenAI request with automatically injected active memory, decisions/issues and current source traces, not a seeded-context false positive')

  await closeApp()
  await launch()
  const restarted = await deadline(page.evaluate(() => window.researchpilot.bootstrap()), 'Read restarted bootstrap')
  assert.equal(restarted.activeProjectId, projectId)
  assert.equal(restarted.settings.defaultModelId, modelId)
  const restoredSnapshot = await snapshot()
  assert.equal(restoredSnapshot.active, true)
  assert.deepEqual(restoredSnapshot.memory, savedMemory)
  assert.deepEqual(restoredSnapshot.sources, editedSnapshot.sources, 'Restart must preserve exact captured source text, IDs, hashes, timestamps and status')
  ui = new PaperJourney(page)
  await ui.open()
  await ui.panel.getByText('助手当前论文', { exact: true }).waitFor()
  await ui.editMemory()
  assert.equal(await ui.field('主要问题').inputValue(), memoryFields.question)
  await ui.details(/^决定与问题/)
  assert.equal(await ui.field('决定 1').inputValue(), accepted)
  assert.equal(await ui.panel.getByRole('combobox', { name: '决定 1 状态', exact: true }).inputValue(), 'accepted')
  assert.equal(await ui.panel.getByRole('combobox', { name: '决定 2 状态', exact: true }).inputValue(), 'rejected')
  assert.equal(await ui.field('问题 1').inputValue(), unresolved)
  assert.equal(await ui.panel.getByRole('checkbox', { name: '已解决', exact: true }).isChecked(), false)
  const restartUiText = await ui.compose()
  const restartContext = await compose()
  assertTrace(restartContext, restoredSnapshot, { manuscript: markers.manuscriptUpdated, reference: markers.referenceUpdated, note: markers.noteUpdated, run: markers.run })
  assert.equal(restartUiText, restartContext.text)
  assert.deepEqual(await api('chat', 'messages', preparedChat.id), completed.messages)
  report.restart = { snapshot: restoredSnapshot, context: restartContext, activeMemoryPersisted: true, exactChatMessagesPreserved: true }
  await screenshot('06-restarted-active-paper-memory.png', ui.panel)
  await assertSourcesUnmodified('Real Electron restart')
  record('Real Electron restart restores active paper, exact memory/decision/issue ledger, current source fingerprints and persisted chat messages')

  await closeApp()
  assert.deepEqual(errors, [], 'No renderer errors')
  assert.deepEqual(fixtureErrors, [], 'No fixture protocol errors')
  assert.deepEqual(blockedRequests, [], 'No non-fixture Electron network requests')
  assert.ok(requests.length > 0)
  assert.ok(requests.every(entry => entry.completed), 'All local fixture requests must complete')
  report.ok = true
} catch (error) {
  report.failure = error instanceof Error ? error.stack : String(error)
  console.error(report.failure)
  if (page && !page.isClosed()) {
    await screenshot('failure.png').catch(() => {})
    report.failureUi = (await deadline(page.locator('body').innerText(), 'Capture failure UI', 10000).catch(() => '')).slice(0, 18000)
    report.failureState = await api('chat', 'state').catch(error => ({ error: String(error) }))
    await api('chat', 'stop').catch(() => {})
    if (run?.id) await api('experiments', 'stop', run.id).catch(() => {})
  }
  process.exitCode = 1
} finally {
  try { await closeApp(); report.appClosed = true }
  catch (error) { errors.push(`Electron cleanup: ${String(error)}`); report.ok = false; process.exitCode = 1 }
  server.closeAllConnections()
  await new Promise(resolveClose => server.close(resolveClose))
  report.serverClosed = !server.listening
  report.finishedAt = new Date().toISOString()
  await writeFile(reportPath, JSON.stringify(report, null, 2))
  console.log(`Report: ${reportPath}`)
  for (const path of screenshots) console.log(`Screenshot: ${path}`)
}
