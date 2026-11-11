import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { navigateWorkspace } from './workspace-navigation.mjs'

// Run the existing out/ build; never rebuild while packaging may be using it.
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
await mkdir(join(root, 'test-results'), { recursive: true })
const runDir = await mkdtemp(join(root, 'test-results', 'tone-stop-'))
const reportPath = join(runDir, 'report.json')
const screenshots = Object.fromEntries(['pending', 'stopped', 'retry', 'navigation-pending', 'reopened', 'navigation-retry', 'failure'].map(name => [name, join(runDir, `writing-tone-${name}.png`)]))
const tracePath = join(runDir, 'trace.zip')
const profilePath = join(runDir, 'profile')
const workspaceRoot = join(runDir, 'workspace')
const modelId = 'tone-stop-smoke-fixture'
const syntheticKey = 'synthetic-tone-stop-not-a-real-key'
const draft = '说白了，本合成短文仅用于停止检查测试，记录 n=42 与引用 [3]，不代表真实研究。'
const editedDraft = `${draft}\n等待模型时人工补充的原文：保留限定条件，不推断真实效果。`
const manualRevision = '人工独立修订稿：合成记录 n=42 [3]，不得被模型建议自动覆盖。'
const editedRevision = `${manualRevision}\n等待模型时人工追加的修订内容必须保留。`
const navigationDraft = `${editedDraft}\n离开页面前追加的原文也必须恢复。`
const navigationRevision = `${editedRevision}\n离开页面前追加的人工修订也必须恢复。`
const summary = '合成重试成功：短文未运行脚本统计；仅建议删除无信息起手式，保留数字与引用。'
const checks = [], errors = [], fixtureErrors = [], requests = [], dialogs = []
const pendingResponses = new Set()
const sockets = new Set()
const report = { startedAt: new Date().toISOString(), ok: false, runDir, reportPath, screenshots, tracePath, checks, errors, fixtureErrors, requests, dialogs }
const record = name => { checks.push(name); console.log(`PASS ${name}`) }
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const firstRequest = deferred()
const firstClosed = deferred()
const navigationRequest = deferred()
const navigationClosed = deferred()
const bounded = async (promise, label, timeout = 15000) => {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout)
    })])
  } finally { clearTimeout(timer) }
}
const env = { ...process.env, RESEARCHPILOT_USER_DATA: profilePath, RESEARCHPILOT_WORKSPACE_ROOT: workspaceRoot }
for (const key of Object.keys(env)) {
  if (/API[_-]?KEY|TOKEN|SECRET|PASSWORD/i.test(key) || ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS'].includes(key)) delete env[key]
}
let app, page, tracing = false
let cleaningUp = false
const server = createServer(async (req, res) => {
  pendingResponses.add(res)
  let entry
  res.once('close', () => {
    pendingResponses.delete(res)
    if (!entry) return
    entry.closed = true
    entry.responseEnded = res.writableEnded
    entry.closedDuringCleanup = cleaningUp
    if (entry.sequence === 1) firstClosed.resolve(entry)
    if (entry.sequence === 3) navigationClosed.resolve(entry)
  })
  try {
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(req.headers.authorization, `Bearer ${syntheticKey}`)
    let body = ''
    for await (const chunk of req) {
      body += chunk.toString('utf8')
      assert.ok(Buffer.byteLength(body) < 2 * 1024 * 1024, 'Fixture request exceeds limit')
    }
    const payload = JSON.parse(body)
    assert.equal(payload.model, modelId)
    assert.equal(payload.stream, false)
    const prompt = payload.messages?.[0]?.content
    assert.equal(typeof prompt, 'string')
    const expectedDraft = requests.length === 0 ? draft : requests.length === 3 ? navigationDraft : editedDraft
    assert.ok(prompt.includes(JSON.stringify(expectedDraft)), 'Model receives the exact current synthetic original')
    assert.ok(prompt.includes('"status":"unavailable"'), 'Short draft bypasses Python detection')
    assert.ok(prompt.includes('至少500汉字'), 'Unavailable detection explains the short-text threshold')
    assert.ok(!prompt.includes(manualRevision), 'Manual revision is not sent for original-text review')
    entry = { sequence: requests.length + 1, method: req.method, path: req.url, model: payload.model, currentDraftMatched: true, pythonBypassed: true, responseSent: false, closed: false }
    requests.push(entry)
    assert.ok(entry.sequence <= 4, 'Expect two deferred requests, each followed by one successful retry')
    if (entry.sequence === 1 || entry.sequence === 3) {
      // Intentionally send neither headers nor body. Stop or component unmount
      // must abort the live HTTP request; cleanup destroys it on any failure.
      const arrival = entry.sequence === 1 ? firstRequest : navigationRequest
      arrival.resolve(entry)
      return
    }
    const content = { summary, retained: [], edits: [{ before: '说白了，', after: '', reason: '删除无信息起手式，不改动合成记录、数值、引用或人工补充。', rule: 'A 起手式' }] }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    entry.responseSent = true
    res.end(JSON.stringify({ id: 'tone-stop-retry', object: 'chat.completion', model: modelId, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }] }))
  } catch (error) {
    fixtureErrors.push(String(error))
    if (!res.destroyed) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Synthetic fixture validation failed' } }))
    }
  }
})
server.on('connection', socket => {
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
})

try {
  assert.ok((navigationDraft.match(/[一-鿿]/gu) ?? []).length < 500)
  await bounded(new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  }), 'Fixture startup')
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  report.fixtureBaseUrl = baseUrl
  app = await electron.launch({ executablePath: require('electron'), args: [root, '--disable-background-networking'], cwd: root, env, timeout: 60000 })
  const runtime = await app.evaluate(({ app, session }, { baseUrl }) => {
    globalThis.toneStopBlockedRequests = []
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      const allowed = details.url === `${baseUrl}/chat/completions`
      if (!allowed) globalThis.toneStopBlockedRequests.push(details.url)
      callback({ cancel: !allowed })
    })
    return { version: app.getVersion(), userData: app.getPath('userData'), packaged: app.isPackaged }
  }, { baseUrl })
  assert.equal(runtime.version, '0.9.0')
  assert.equal(runtime.packaged, false, 'Use the existing out/ app so isolation overrides are honored')
  assert.equal(resolve(runtime.userData), resolve(profilePath))
  report.runtime = runtime
  await app.context().tracing.start({ screenshots: true, snapshots: true, sources: false })
  tracing = true
  page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForSelector('.research-home', { timeout: 60000 })
  const configured = await page.evaluate(async ({ baseUrl, syntheticKey, modelId }) => {
    const api = window.researchpilot
    if (typeof api.writingTone?.stop !== 'function') throw new Error('Current built app lacks writingTone.stop; no automatic rebuild is performed')
    const provider = await api.providers.upsert({ id: 'tone-stop-smoke-fixture', name: 'Synthetic loopback stop fixture', kind: 'custom', protocol: 'openai-completions', baseUrl, apiKey: syntheticKey, models: [{ id: modelId, label: modelId }], isDefault: true })
    const settings = await api.settings.update({ defaultProviderId: provider.id, defaultModelId: modelId, agentRoleModels: {}, telemetry: false })
    const bootstrap = await api.bootstrap()
    return { provider, settings, activeProjectId: bootstrap.activeProjectId }
  }, { baseUrl, syntheticKey, modelId })
  assert.ok(configured.activeProjectId)
  assert.equal(configured.provider.isDefault, true)
  assert.equal(configured.provider.hasApiKey, true)
  assert.equal(configured.provider.baseUrl, baseUrl)
  assert.equal(configured.settings.defaultProviderId, configured.provider.id)
  assert.equal(configured.settings.defaultModelId, modelId)
  assert.deepEqual(configured.settings.agentRoleModels, {})
  assert.equal(resolve(configured.settings.workspaceRoot), resolve(workspaceRoot))
  report.configuration = { projectId: configured.activeProjectId, providerId: configured.provider.id, modelId, profilePath, workspaceRoot, realProviderUsed: false }
  record('Built 0.9.0 app exposes stop and uses isolated profile/workspace with synthetic loopback provider via preload')

  await navigateWorkspace(page, '/writing-quality')
  const tone = page.getByRole('region', { name: '学术表达去套路 · 内置技能', exact: true })
  const original = page.getByRole('textbox', { name: '原文 / 报告标记段落', exact: true })
  const revised = page.getByRole('textbox', { name: '实际修订后的文本', exact: true })
  const generate = tone.getByRole('button', { name: '用内置技能生成建议…', exact: true })
  const inspect = tone.getByRole('button', { name: '仅运行内置脚本（本地）', exact: true })
  const exportRecord = tone.getByRole('button', { name: '导出修改记录（含原文）', exact: true })
  const stop = tone.getByRole('button', { name: '停止检查', exact: true })
  const adopt = tone.getByRole('button', { name: '按这些建议生成修订稿', exact: true })
  const acceptGeneration = async () => {
    const waitingForDialog = page.waitForEvent('dialog')
    const clicking = generate.click()
    // Observe both promises even when a dialog or click fails.
    clicking.catch(() => {})
    const dialog = await bounded(waitingForDialog, 'Model consent dialog')
    assert.equal(dialog.type(), 'confirm')
    assert.match(dialog.message(), /发送.*写作角色模型/)
    dialogs.push({ type: dialog.type(), message: dialog.message(), accepted: true })
    await dialog.accept()
    await clicking
  }
  const assertNoResults = async () => {
    assert.equal(await tone.locator('ol > li').count(), 0, 'Cancelled operation must not display suggestions')
    assert.equal(await adopt.count(), 0, 'Cancelled operation must not offer revision adoption')
    assert.equal(await exportRecord.isDisabled(), true, 'Cancelled operation must not create an exportable report')
    assert.equal(await tone.getByText(summary, { exact: true }).count(), 0)
  }
  await tone.waitFor()
  await original.fill(draft)
  await revised.fill(manualRevision)
  await acceptGeneration()
  await bounded(firstRequest.promise, 'Deferred model HTTP request')
  await stop.waitFor()
  assert.equal(await stop.isEnabled(), true)
  assert.equal(await tone.getByRole('button', { name: '正在生成建议…', exact: true }).isDisabled(), true)
  assert.equal(await inspect.isDisabled(), true)
  assert.equal(await exportRecord.isDisabled(), true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].responseSent, false)
  assert.equal(requests[0].closed, false)
  assert.equal(pendingResponses.size, 1)
  record('Confirmed generation reaches a real deferred HTTP request; busy controls disable and stop is available')

  await original.fill(editedDraft)
  await revised.fill(editedRevision)
  await assertNoResults()
  await page.setViewportSize({ width: 1500, height: 1200 })
  await tone.evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: screenshots.pending, fullPage: true })
  record('Original and manual revision remain editable while model review is pending')

  const stopStarted = Date.now()
  await stop.click()
  await generate.waitFor()
  await page.waitForFunction(() => {
    const region = document.querySelector('[aria-labelledby="tone-heading"]')
    return [...(region?.querySelectorAll('button') ?? [])].some(button => button.textContent === '用内置技能生成建议…' && !button.disabled)
  })
  const closed = await bounded(firstClosed.promise, 'Cancelled HTTP response closure')
  assert.equal(closed.responseSent, false)
  assert.equal(closed.responseEnded, false, 'Pending response must close without model output')
  assert.equal(closed.closedDuringCleanup, false, 'Stop itself must close the pending request, not test teardown')
  assert.equal(await generate.isEnabled(), true)
  assert.equal(await inspect.isEnabled(), true)
  assert.equal(await stop.count(), 0)
  assert.equal(await tone.getByRole('button', { name: '正在停止…', exact: true }).count(), 0)
  await page.getByText('润色检查已停止，未应用本次结果。原文和修订稿未改动。', { exact: true }).waitFor()
  await assertNoResults()
  assert.equal(await original.inputValue(), editedDraft)
  assert.equal(await revised.inputValue(), editedRevision)
  assert.equal(requests.length, 1)
  assert.equal(pendingResponses.size, 0)
  report.stop = { elapsedMs: Date.now() - stopStarted, controlsUnblocked: true, pendingRequestClosedBeforeCleanup: true, noModelResponseSent: true, noSuggestionsApplied: true, originalEditsPreserved: true, manualRevisionEditsPreserved: true }
  await tone.evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: screenshots.stopped, fullPage: true })
  record('Stop aborts pending HTTP, unblocks controls, applies no results, and preserves both in-flight manual edits')

  await acceptGeneration()
  await tone.getByText(summary, { exact: true }).waitFor()
  await generate.waitFor()
  assert.equal(await generate.isEnabled(), true)
  assert.equal(await inspect.isEnabled(), true)
  assert.equal(await exportRecord.isEnabled(), true)
  assert.equal(await adopt.isEnabled(), true)
  assert.equal(await stop.count(), 0)
  assert.equal(await tone.locator('ol > li').count(), 1)
  assert.equal(await tone.locator('blockquote').innerText(), '说白了，')
  await tone.getByText('A 起手式', { exact: true }).waitFor()
  await tone.getByText('删除该冗余片段', { exact: true }).waitFor()
  await tone.getByText(/上游检测适用于至少500汉字/).waitFor()
  assert.equal(await original.inputValue(), editedDraft)
  assert.equal(await revised.inputValue(), editedRevision)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].responseSent, true)
  assert.equal(dialogs.length, 2)
  report.retry = { success: true, suggestionCount: 1, shortTextPythonBypassed: true, usesEditedOriginal: true, originalEditsPreserved: true, manualRevisionEditsPreserved: true, adoptionNotInvoked: true }
  record('Retry succeeds with immediate valid JSON and one suggestion, without overwriting either text field')

  await tone.evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: screenshots.retry, fullPage: true })

  // A second deferred review exercises real route unmount/remount. Do not call
  // stop from the test: leaving the page itself must cancel the orphaned IPC.
  await acceptGeneration()
  await bounded(navigationRequest.promise, 'Navigation deferred model request')
  await stop.waitFor()
  assert.equal(requests.length, 3)
  assert.equal(requests[2].responseSent, false)
  assert.equal(requests[2].closed, false)
  assert.equal(pendingResponses.size, 1)
  await original.fill(navigationDraft)
  await revised.fill(navigationRevision)
  await tone.evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: screenshots['navigation-pending'], fullPage: true })
  const navigationStarted = Date.now()
  await navigateWorkspace(page, '/')
  await page.locator('.research-home').waitFor()
  assert.equal(await tone.count(), 0, 'Navigating away must unmount the tone panel')
  await navigateWorkspace(page, '/writing-quality')
  await tone.waitFor()
  const navigationCancelled = await bounded(navigationClosed.promise, 'Unmounted review HTTP closure')
  assert.equal(navigationCancelled.responseSent, false)
  assert.equal(navigationCancelled.responseEnded, false)
  assert.equal(navigationCancelled.closedDuringCleanup, false, 'Route unmount must cancel the request before teardown')
  assert.equal(pendingResponses.size, 0)
  assert.equal(await generate.isEnabled(), true)
  assert.equal(await inspect.isEnabled(), true)
  assert.equal(await stop.count(), 0)
  await assertNoResults()
  assert.equal(await original.inputValue(), navigationDraft, 'Reopening restores in-flight original edits')
  assert.equal(await revised.inputValue(), navigationRevision, 'Reopening restores in-flight manual revision edits')
  assert.equal(requests.length, 3, 'Reopening alone must not restart generation')
  report.navigation = { elapsedMs: Date.now() - navigationStarted, panelUnmounted: true, pendingRequestClosedBeforeCleanup: true, noModelResponseSent: true, noSuggestionsApplied: true, controlsUnblocked: true, originalEditsRestored: true, manualRevisionEditsRestored: true, automaticRestart: false }
  await tone.evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: screenshots.reopened, fullPage: true })
  record('Navigating away cancels deferred review; reopening restores both edits with no orphaned request or suggestions')

  await acceptGeneration()
  await tone.getByText(summary, { exact: true }).waitFor()
  await generate.waitFor()
  assert.equal(await generate.isEnabled(), true)
  assert.equal(await inspect.isEnabled(), true)
  assert.equal(await exportRecord.isEnabled(), true)
  assert.equal(await adopt.isEnabled(), true)
  assert.equal(await stop.count(), 0)
  assert.equal(await tone.locator('ol > li').count(), 1)
  assert.equal(await tone.locator('blockquote').innerText(), '说白了，')
  await tone.getByText('A 起手式', { exact: true }).waitFor()
  await tone.getByText(/上游检测适用于至少500汉字/).waitFor()
  assert.equal(await original.inputValue(), navigationDraft)
  assert.equal(await revised.inputValue(), navigationRevision)
  assert.equal(requests.length, 4)
  assert.equal(requests[3].responseSent, true)
  assert.equal(dialogs.length, 4)
  assert.equal(await page.getByText(/已有润色检查执行中/).count(), 0, 'Reopened review must not encounter orphaned busy service')
  report.navigationRetry = { success: true, suggestionCount: 1, shortTextPythonBypassed: true, usesRestoredOriginal: true, originalEditsPreserved: true, manualRevisionEditsPreserved: true, adoptionNotInvoked: true, orphanedBusyError: false }
  await tone.evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: screenshots['navigation-retry'], fullPage: true })
  record('Retry after route remount succeeds with one suggestion and preserves restored original/manual revision')

  report.blockedExternalRequests = await app.evaluate(() => globalThis.toneStopBlockedRequests)
  assert.deepEqual(report.blockedExternalRequests, [])
  assert.deepEqual(fixtureErrors, [])
  assert.deepEqual(errors, [])
  record('Stop, retry, route-remount screenshots captured with no external HTTP or renderer errors')
  report.ok = true
} catch (error) {
  report.failure = error instanceof Error ? error.stack : String(error)
  if (page && !page.isClosed()) {
    await bounded(page.screenshot({ path: screenshots.failure, fullPage: true }), 'Failure screenshot', 5000).catch(() => {})
    report.failureUi = (await bounded(page.locator('body').innerText(), 'Failure UI', 5000).catch(() => '')).slice(0, 16000)
  }
  console.error(report.failure)
  process.exitCode = 1
} finally {
  cleaningUp = true
  // Destroy deferred responses BEFORE app shutdown: a failed stop assertion must
  // never leave an active model IPC lease or HTTP server holding the process open.
  for (const res of pendingResponses) res.destroy()
  server.closeAllConnections()
  for (const socket of sockets) socket.destroy()
  try {
    await bounded(new Promise(resolve => server.close(resolve)), 'Fixture shutdown', 5000)
    report.serverClosed = !server.listening
    if (tracing) await bounded(app.context().tracing.stop({ path: tracePath }), 'Trace save', 10000)
  } catch (error) {
    errors.push(`Artifact/server cleanup: ${String(error)}`)
    report.ok = false
    process.exitCode = 1
  } finally {
    try {
      if (app) await bounded(app.close(), 'Electron shutdown', 10000)
      report.appClosed = true
    } catch (error) {
      errors.push(`Electron cleanup: ${String(error)}`)
      report.ok = false
      process.exitCode = 1
      // Only terminate the Electron child launched by this test, never packaging
      // or an unrelated user instance.
      app?.process()?.kill()
    }
    report.pendingResponsesAfterCleanup = pendingResponses.size
    report.finishedAt = new Date().toISOString()
    await writeFile(reportPath, JSON.stringify(report, null, 2))
    console.log(`Report: ${reportPath}`)
    console.log(`Stopped screenshot: ${screenshots.stopped}`)
    console.log(`Retry screenshot: ${screenshots.retry}`)
    console.log(`Navigation retry screenshot: ${screenshots['navigation-retry']}`)
  }
}
