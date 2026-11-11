import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { navigateWorkspace } from './workspace-navigation.mjs'

// Runs against built out/ through the real Electron/preload/DSH stack. No real
// provider, user profile, API credential, or renderer/backend mock is used.
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const results = join(root, 'test-results')
await mkdir(results, { recursive: true })
const runDir = await mkdtemp(join(results, 'model-switch-'))
const reportPath = join(runDir, 'report.json')
const providerId = 'model-switch-fixture'
const otherProviderId = 'model-switch-other-fixture'
const modelA = 'test-a', modelB = 'test-b'
const syntheticKey = 'synthetic-model-switch-not-a-real-key'
const otherSyntheticKey = 'synthetic-other-model-switch-not-a-real-key'
const marker = 'COLOR_732'
const firstPrompt = `This is a synthetic UI test. Remember the marker ${marker}. Reply briefly without tools or reading files.`
const secondPrompt = 'SECOND_TURN_946: What marker did I give you? Continue this same conversation without tools.'
const thirdPrompt = 'OTHER_PROVIDER_TURN_581: Continue this same synthetic conversation without tools.'
const answerA = 'FIXTURE_A_COLOR_732_ACK'
const answerB = 'FIXTURE_B_CONTEXT_RETAINED'
const answerOther = 'FIXTURE_OTHER_CONTEXT_RETAINED'
const draft = '未发送草稿：切换模型时必须保留，DRAFT_219。'
const checks = [], errors = [], fixtureErrors = [], requests = [], screenshots = []
const report = { startedAt: new Date().toISOString(), ok: false, runDir, reportPath, checks, errors, fixtureErrors, requests, screenshots }
const record = name => { checks.push(name); console.log(`PASS ${name}`) }
const selection = (id, model) => JSON.stringify([id, model])
const env = {
  ...process.env,
  RESEARCHPILOT_USER_DATA: join(runDir, 'profile'),
  RESEARCHPILOT_WORKSPACE_ROOT: join(runDir, 'workspace'),
  DSH_TELEMETRY_DISABLED: '1'
}
// Inspect names only, never read or report inherited credentials. In particular,
// prevent a system proxy from forwarding the synthetic loopback credentials.
for (const name of Object.keys(env)) {
  if (/API[_-]?KEY|TOKEN|SECRET|PASSWORD|PROXY|BASE_URL|API_BASE/i.test(name) ||
      ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS', 'DSH_HOME'].includes(name)) delete env[name]
}
env.NO_PROXY = '127.0.0.1,localhost'
let app, page, chat, projectId, releaseFirstReply, gateTimer, firstReplyGated = false
let fixtureBaseUrl, otherBaseUrl
const blockedRequests = []

function deadline(promise, label, timeout = 90000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: ${timeout}ms deadline exceeded`)), timeout) })
  ]).finally(() => clearTimeout(timer))
}

// This Playwright build does not await async waitForFunction predicates. Poll
// real IPC on the Node side instead, with an explicit bounded condition deadline.
async function waitForCondition(condition, label, timeout = 90000) {
  return deadline((async () => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const result = await condition()
      if (result) return result
      await new Promise(resolveTick => setTimeout(resolveTick, 100))
    }
    throw new Error(`${label}: condition not met within ${timeout}ms`)
  })(), label, timeout)
}

function textOf(message) {
  if (typeof message?.content === 'string') return message.content
  return JSON.stringify(message?.content ?? '')
}

const server = createServer(async (req, res) => {
  try {
    const other = req.url === '/other/v1/chat/completions'
    assert.equal(req.method, 'POST', 'Fixture only accepts inference POST')
    assert.ok(other || req.url === '/v1/chat/completions', `Unexpected fixture path: ${req.url}`)
    assert.equal(req.headers.authorization, `Bearer ${other ? otherSyntheticKey : syntheticKey}`)
    let body = ''
    for await (const chunk of req) {
      body += chunk.toString('utf8')
      assert.ok(Buffer.byteLength(body) < 4 * 1024 * 1024, 'Fixture request exceeds limit')
    }
    const payload = JSON.parse(body)
    assert.ok([modelA, modelB].includes(payload.model), `Unexpected fixture model: ${payload.model}`)
    assert.ok(Array.isArray(payload.messages), 'Expected OpenAI-compatible messages')
    const entry = {
      index: requests.length, at: new Date().toISOString(),
      providerId: other ? otherProviderId : providerId,
      path: req.url, model: payload.model, stream: payload.stream === true,
      // Only synthetic requests enter this isolated fixture. Never record headers.
      payload
    }
    requests.push(entry)
    const answer = other ? answerOther : payload.model === modelA ? answerA : answerB
    const id = `model-switch-response-${entry.index}`
    const created = Math.floor(Date.now() / 1000)
    if (payload.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      const chunk = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: payload.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
      chunk({ role: 'assistant', content: '' })
      if (!firstReplyGated && !other && payload.model === modelA && payload.messages.some(message => message.role === 'user' && textOf(message).includes(marker))) {
        firstReplyGated = true
        entry.firstReplyGated = true
        await new Promise((resolveGate, rejectGate) => {
          releaseFirstReply = () => { clearTimeout(gateTimer); resolveGate() }
          gateTimer = setTimeout(() => rejectGate(new Error('First reply gate was not released within 85 seconds')), 85000)
        })
      }
      chunk({ content: answer })
      chunk({}, 'stop')
      res.end('data: [DONE]\n\n')
    } else {
      // DSH can issue nonstreaming title/summary requests in addition to turns.
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id, object: 'chat.completion', created, model: payload.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Synthetic model-switch fixture summary.' } }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }))
    }
    entry.completed = true
  } catch (error) {
    fixtureErrors.push(error instanceof Error ? error.stack : String(error))
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Synthetic model-switch fixture failed validation' } }))
  }
})
server.requestTimeout = 100000
server.headersTimeout = 15000

class ChatJourney {
  constructor(page) { this.page = page }
  get composer() { return this.page.locator('.agent-page .composer-box') }
  get model() { return this.composer.getByRole('combobox', { name: '本轮模型', exact: true }) }
  get input() { return this.composer.getByRole('textbox') }
  get send() { return this.composer.getByRole('button', { name: '发送（Enter）', exact: true }) }
  async ready() {
    await this.model.waitFor()
    assert.equal(await this.model.count(), 1)
    assert.equal(await this.page.locator('.topbar').getByRole('combobox', { name: '本轮模型', exact: true }).count(), 0, 'Chat model selection must live in the composer, not the top bar')
  }
  async unlocked() {
    await this.page.waitForFunction(() => {
      const select = document.querySelector('.agent-page .composer-box select[aria-label="本轮模型"]')
      return !!select && !select.disabled
    }, undefined, { timeout: 30000 })
  }
  async choose(id, model) {
    await this.unlocked()
    await this.model.selectOption(selection(id, model))
    await this.page.waitForFunction(({ value }) => {
      const select = document.querySelector('.agent-page .composer-box select[aria-label="本轮模型"]')
      return select?.value === value && !select.disabled
    }, { value: selection(id, model) }, { timeout: 90000 })
    assert.equal(await this.model.inputValue(), selection(id, model))
  }
  async submit(text) {
    await this.input.fill(text)
    assert.equal(await this.send.isEnabled(), true)
    await this.send.click()
  }
  async reply(answer, model, expectedProvider = providerId) {
    const state = await waitForCondition(async () => this.page.evaluate(async ({ answer, model, expectedProvider, projectId }) => {
      const api = window.researchpilot
      const state = await api.chat.state()
      if (state.status === 'error') return state
      if (state.status !== 'idle' || !state.chatId) return false
      const messages = await api.chat.messages(state.chatId)
      const chat = (await api.chat.list(projectId)).find(item => item.id === state.chatId)
      const select = document.querySelector('.agent-page .composer-box select[aria-label="本轮模型"]')
      if (chat?.providerId === expectedProvider && chat?.modelId === model && !select?.disabled && messages.some(message => message.role === 'assistant' && message.content.includes(answer))) return state
      return false
    }, { answer, model, expectedProvider, projectId }), `Wait for ${expectedProvider}/${model} idle reply`)
    assert.equal(state.status, 'idle', `Agent did not complete normally: ${JSON.stringify(state)}`)
    assert.equal(state.modelId, model, 'Runtime must actually switch model, not just the UI label')
    assert.equal(state.providerId, expectedProvider)
    await this.page.waitForFunction(answer => {
      const bubbles = [...document.querySelectorAll('.agent-page .bubble.assistant')]
      const metadata = [...document.querySelectorAll('.agent-page .msg-meta')]
      return bubbles.filter(element => element.textContent.trim() === answer).length === 1 &&
        metadata.every(element => !element.textContent.includes('同步中'))
    }, answer, { timeout: 10000 })
    assert.equal(await this.page.locator('.agent-page .bubble.assistant').evaluateAll((elements, answer) => elements.filter(element => element.textContent.trim() === answer).length, answer), 1, 'Completed assistant answer must be displayed exactly once')
    assert.equal(await this.page.locator('.agent-page .msg-meta').filter({ hasText: '同步中' }).count(), 0, 'Completed reply must not retain a syncing streaming placeholder')
    await this.page.waitForFunction(() => {
      const select = document.querySelector('.agent-page .composer-box select[aria-label="本轮模型"]')
      return !!select && !select.disabled
    }, undefined, { timeout: 30000 })
    assert.equal(await this.model.isEnabled(), true, 'Model selector must unlock after reply')
    return state
  }
}

async function snapshot() {
  return deadline(page.evaluate(async projectId => {
    const api = window.researchpilot
    const state = await api.chat.state()
    const chats = await api.chat.list(projectId)
    return { state, chats, messages: state.chatId ? await api.chat.messages(state.chatId) : [], agentEvents: window.modelSwitchAgentEvents ?? [] }
  }, projectId), 'Read chat state')
}

async function screenshot(name) {
  const path = join(runDir, name)
  await page.screenshot({ path, fullPage: true, timeout: 30000 })
  screenshots.push(path)
}

async function launch() {
  app = await electron.launch({ executablePath: require('electron'), args: [root, '--disable-background-networking'], cwd: root, env, timeout: 60000 })
  await deadline(app.evaluate(({ session }, allowed) => {
    globalThis.modelSwitchBlockedRequests = []
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      const permitted = allowed.includes(details.url)
      if (!permitted) globalThis.modelSwitchBlockedRequests.push(details.url)
      callback({ cancel: !permitted })
    })
  }, [`${fixtureBaseUrl}/chat/completions`, `${otherBaseUrl}/chat/completions`]), 'Install fixture-only Electron network guard')
  page = await app.firstWindow({ timeout: 60000 })
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.research-home').waitFor({ timeout: 60000 })
  assert.equal(new URL(page.url()).protocol, 'file:', 'Use built local renderer, never a development server')
  await observeAgentEvents()
}

async function observeAgentEvents() {
  await page.evaluate(() => {
    window.modelSwitchAgentEvents = []
    window.researchpilot.onEvent(event => {
      if (event.type === 'agent-status') window.modelSwitchAgentEvents.push({ at: new Date().toISOString(), state: event.state })
    })
  })
}

async function closeApp() {
  if (!app) return
  blockedRequests.push(...await deadline(app.evaluate(() => globalThis.modelSwitchBlockedRequests ?? []), 'Collect blocked requests', 15000))
  await deadline(app.close(), 'Close Electron', 45000)
  app = undefined
}

function assertContext(entry, expectedHistory, label) {
  assert.ok(entry, `${label}: no actual streaming fixture request for the selected model/provider`)
  const actual = entry.payload.messages
  let previousIndex = -1
  for (const [role, text] of expectedHistory) {
    const index = actual.findIndex((message, index) => index > previousIndex && message.role === role && textOf(message).includes(text))
    assert.ok(index > previousIndex, `${label}: actual request missing ordered ${role} context ${JSON.stringify(text)}; request index ${entry.index}`)
    previousIndex = index
  }
}

try {
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  fixtureBaseUrl = `http://127.0.0.1:${server.address().port}/v1`
  otherBaseUrl = `http://127.0.0.1:${server.address().port}/other/v1`
  await launch()
  const configured = await deadline(page.evaluate(async ({ providerId, otherProviderId, fixtureBaseUrl, otherBaseUrl, syntheticKey, otherSyntheticKey, modelA, modelB }) => {
    const api = window.researchpilot
    const before = await api.providers.list()
    if (before.some(provider => provider.hasApiKey)) throw new Error('Isolated profile unexpectedly contains provider credentials')
    // Reversed order deliberately catches any "first model wins" default bug.
    const models = [{ id: modelB, label: 'Synthetic B' }, { id: modelA, label: 'Synthetic A' }]
    await api.providers.upsert({ id: otherProviderId, name: 'Other synthetic supplier', kind: 'custom', protocol: 'openai-completions', baseUrl: otherBaseUrl, apiKey: otherSyntheticKey, models, isDefault: false })
    const provider = await api.providers.upsert({ id: providerId, name: 'Synthetic model-switch supplier', kind: 'custom', protocol: 'openai-completions', baseUrl: fixtureBaseUrl, apiKey: syntheticKey, models, defaultModelId: modelA, isDefault: true })
    const bootstrap = await api.bootstrap()
    await api.settings.update({ telemetry: false, agentRoleModels: {}, reasoningEffort: '', maxOutputTokens: 256 })
    return { provider, projectId: bootstrap.activeProjectId, settings: bootstrap.settings, chats: await api.chat.list(bootstrap.activeProjectId) }
  }, { providerId, otherProviderId, fixtureBaseUrl, otherBaseUrl, syntheticKey, otherSyntheticKey, modelA, modelB }), 'Configure synthetic providers')
  projectId = configured.projectId
  assert.ok(projectId)
  assert.equal(configured.chats.length, 0, 'Test must start without existing chats')
  assert.equal(configured.provider.hasApiKey, true)
  assert.equal(configured.settings.defaultProviderId, providerId)
  assert.equal(configured.settings.defaultModelId, modelA)
  assert.equal(resolve(configured.settings.workspaceRoot), resolve(env.RESEARCHPILOT_WORKSPACE_ROOT))
  report.configuration = { projectId, providerId, otherProviderId, fixtureBaseUrl, otherBaseUrl, models: [modelA, modelB], profile: env.RESEARCHPILOT_USER_DATA, workspace: env.RESEARCHPILOT_WORKSPACE_ROOT }
  record('Real preload configures isolated synthetic suppliers and explicit default A despite reversed model list')

  await page.reload()
  await page.locator('.research-home').waitFor({ timeout: 60000 })
  await observeAgentEvents()
  await navigateWorkspace(page, '/settings')
  const globalDefault = page.getByRole('combobox', { name: '全局默认模型', exact: true })
  // Optional only for older builds; the composer journey below is mandatory.
  if (await globalDefault.count()) {
    assert.equal(await globalDefault.inputValue(), selection(providerId, modelA))
    for (const model of [modelB, modelA]) {
      await globalDefault.selectOption(selection(providerId, model))
      await waitForCondition(() => page.evaluate(async ({ providerId, model }) => {
        const { settings } = await window.researchpilot.bootstrap()
        const select = document.querySelector('select[aria-label="全局默认模型"]')
        return settings.defaultProviderId === providerId && settings.defaultModelId === model && select?.value === JSON.stringify([providerId, model]) && !select.disabled
      }, { providerId, model }), 'Save global default model UI', 30000)
    }
    report.settingsDefaultUi = 'passed: B then A persisted through real settings UI'
    record('Settings global default UI saves explicit B then A, not model-list order')
  } else report.settingsDefaultUi = 'not available in this build; mandatory composer tests continue'

  await navigateWorkspace(page, '/agent')
  let ui = new ChatJourney(page)
  await ui.ready()
  assert.equal(await ui.model.inputValue(), selection(providerId, modelA))
  assert.equal(await ui.model.isEnabled(), true)
  await ui.submit(firstPrompt)
  await waitForCondition(() => page.evaluate(async () => {
    const state = await window.researchpilot.chat.state()
    if (state.status === 'error') return true
    const model = document.querySelector('.agent-page .composer-box select[aria-label="本轮模型"]')
    return ['starting', 'running'].includes(state.status) && model?.disabled
  }), 'First turn enters busy state')
  const busy = await snapshot()
  report.busy = busy
  assert.ok(['starting', 'running'].includes(busy.state.status), `First turn failed before reply: ${JSON.stringify(busy.state)}`)
  assert.equal(await ui.model.isDisabled(), true, 'Cannot switch the model while a turn is starting/running')
  // Wait on the local server condition, not a fixed delay. DSH may still be starting.
  await deadline((async () => {
    while (!releaseFirstReply) {
      const state = await page.evaluate(() => window.researchpilot.chat.state())
      assert.notEqual(state.status, 'error', `DSH startup failed: ${JSON.stringify(state)}`)
      if (fixtureErrors.length) throw new Error(fixtureErrors.join('\n'))
      await new Promise(resolveTick => setTimeout(resolveTick, 100))
    }
  })(), 'Wait for gated first fixture request')
  assert.equal(await ui.model.isDisabled(), true, 'Selector must remain locked until fixture delivers the reply')
  await screenshot('01-busy-model-a.png')
  releaseFirstReply()
  const stateA = await ui.reply(answerA, modelA)
  const first = await snapshot()
  chat = first.chats.find(item => item.id === stateA.chatId)
  assert.ok(chat?.id && chat.dshSessionId, 'First real reply must create a persistent chat and DSH session')
  assert.equal(first.chats.length, 1)
  assert.equal(stateA.sessionId, chat.dshSessionId)
  assert.ok(first.messages.some(message => message.role === 'user' && message.content === firstPrompt))
  assert.ok(first.messages.some(message => message.role === 'assistant' && message.content.includes(answerA)))
  report.firstTurn = first
  record('Model A replies once over real SSE with no syncing placeholder; selector locks while busy and unlocks after idle')

  await ui.input.fill(draft)
  const visibleBefore = await page.locator('.agent-page .chat-messages .msg').filter({ has: page.locator('.msg-meta').filter({ hasText: / · \d\d:\d\d$/ }) }).allTextContents()
  await ui.choose(providerId, modelB)
  const switched = await snapshot()
  const switchedChat = switched.chats.find(item => item.id === chat.id)
  assert.equal(switched.chats.length, 1, 'Model switch must not create another chat')
  assert.equal(switched.state.chatId, chat.id)
  assert.equal(switched.state.sessionId, chat.dshSessionId)
  assert.equal(switchedChat?.dshSessionId, chat.dshSessionId)
  assert.equal(switchedChat?.providerId, providerId)
  assert.equal(switchedChat?.modelId, modelB)
  assert.deepEqual(switched.messages, first.messages, 'Switch must preserve exact persisted messages, IDs, and timestamps')
  assert.deepEqual(await page.locator('.agent-page .chat-messages .msg').filter({ has: page.locator('.msg-meta').filter({ hasText: / · \d\d:\d\d$/ }) }).allTextContents(), visibleBefore, 'Switch must preserve rendered conversation')
  assert.equal(await ui.input.inputValue(), draft, 'Switch must preserve unsent composer draft')
  report.afterSwitch = switched
  await screenshot('02-model-b-history-and-draft.png')
  record('JSON selector switches A to B without changing chat/session/history or the unsent draft')

  const requestStartB = requests.length
  await ui.submit(secondPrompt)
  const stateB = await ui.reply(answerB, modelB)
  assert.equal(stateB.chatId, chat.id)
  assert.equal(stateB.sessionId, chat.dshSessionId)
  const requestB = requests.slice(requestStartB).find(entry => entry.providerId === providerId && entry.model === modelB && entry.stream && entry.payload.messages.some(message => message.role === 'user' && textOf(message).includes('SECOND_TURN_946')))
  assertContext(requestB, [['user', marker], ['assistant', answerA], ['user', 'SECOND_TURN_946']], 'Model B turn')
  const second = await snapshot()
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages, 'Second turn must append, not rewrite history')
  report.secondTurn = second
  report.contextRequestB = requestB.index
  await screenshot('03-model-b-context-reply.png')
  record('Actual model-B streaming payload includes first user marker, first assistant answer, and second user in order; B reply displays exactly once without syncing placeholder')

  await closeApp()
  await launch()
  const restartedBootstrap = await page.evaluate(() => window.researchpilot.bootstrap())
  assert.equal(restartedBootstrap.activeProjectId, projectId)
  assert.equal(restartedBootstrap.settings.defaultModelId, modelA, 'Per-chat B must not overwrite the global default A')
  await navigateWorkspace(page, '/agent')
  ui = new ChatJourney(page)
  await ui.ready()
  assert.equal(await ui.model.inputValue(), selection(providerId, modelB), 'Restart must restore the chat-specific B selection')
  const restored = await page.evaluate(async ({ projectId, chatId }) => ({ chats: await window.researchpilot.chat.list(projectId), messages: await window.researchpilot.chat.messages(chatId) }), { projectId, chatId: chat.id })
  assert.equal(restored.chats.length, 1)
  assert.equal(restored.chats[0].id, chat.id)
  assert.equal(restored.chats[0].dshSessionId, chat.dshSessionId)
  assert.equal(restored.chats[0].modelId, modelB)
  assert.deepEqual(restored.messages, second.messages)
  await page.locator('.agent-page .bubble.assistant').filter({ hasText: answerA }).first().waitFor()
  await page.locator('.agent-page .bubble.assistant').filter({ hasText: answerB }).first().waitFor()
  report.afterRestart = restored
  await screenshot('04-restarted-model-b.png')
  record('Real Electron restart preserves chat-specific B, exact messages, same chat/session, and independent global default A')

  // Cross-supplier extension uses the same model ID on a different endpoint/key.
  await ui.input.fill(draft)
  await ui.choose(otherProviderId, modelB)
  const otherSelected = await page.evaluate(async ({ projectId, chatId }) => ({ chats: await window.researchpilot.chat.list(projectId), messages: await window.researchpilot.chat.messages(chatId) }), { projectId, chatId: chat.id })
  assert.equal(otherSelected.chats.length, 1)
  assert.equal(otherSelected.chats[0].id, chat.id)
  assert.equal(otherSelected.chats[0].dshSessionId, chat.dshSessionId)
  assert.equal(otherSelected.chats[0].providerId, otherProviderId)
  assert.deepEqual(otherSelected.messages, second.messages)
  assert.equal(await ui.input.inputValue(), draft)
  const requestStartOther = requests.length
  await ui.submit(thirdPrompt)
  const stateOther = await ui.reply(answerOther, modelB, otherProviderId)
  assert.equal(stateOther.chatId, chat.id)
  assert.equal(stateOther.sessionId, chat.dshSessionId)
  const requestOther = requests.slice(requestStartOther).find(entry => entry.providerId === otherProviderId && entry.model === modelB && entry.stream && entry.payload.messages.some(message => message.role === 'user' && textOf(message).includes('OTHER_PROVIDER_TURN_581')))
  assertContext(requestOther, [['user', marker], ['assistant', answerA], ['user', 'SECOND_TURN_946'], ['assistant', answerB], ['user', 'OTHER_PROVIDER_TURN_581']], 'Other supplier turn after restart')
  report.contextRequestOther = requestOther.index
  report.otherSupplierTurn = await snapshot()
  await screenshot('05-other-supplier-context-reply.png')
  record('Different supplier with identical model ID uses its own endpoint/key and retains full real DSH context after restart')

  await closeApp()
  assert.deepEqual(blockedRequests, [], 'No non-fixture Electron network attempts')
  assert.deepEqual(errors, [], 'No renderer exceptions')
  assert.deepEqual(fixtureErrors, [], 'No fixture protocol errors')
  assert.ok(requests.filter(entry => entry.stream).every(entry => entry.completed), 'All streamed fixture requests must finish')
  record('No renderer exceptions, real-provider requests, or fixture errors; all local SSE replies finish')
  report.ok = true
} catch (error) {
  report.failure = error instanceof Error ? error.stack : String(error)
  console.error(report.failure)
  if (page && !page.isClosed()) {
    await screenshot('failure.png').catch(() => {})
    report.failureUi = (await deadline(page.locator('body').innerText(), 'Capture failure UI', 10000).catch(() => '')).slice(0, 16000)
    report.failureState = await snapshot().catch(error => ({ error: String(error) }))
    await deadline(page.evaluate(() => window.researchpilot.chat.stop()), 'Stop failed smoke task', 15000).catch(() => {})
  }
  process.exitCode = 1
} finally {
  clearTimeout(gateTimer)
  releaseFirstReply?.()
  try { await closeApp(); report.appClosed = true }
  catch (error) { errors.push(`Electron cleanup: ${String(error)}`); report.ok = false; process.exitCode = 1 }
  server.closeAllConnections()
  await new Promise(resolveClose => server.close(resolveClose))
  report.serverClosed = !server.listening
  report.blockedRequests = blockedRequests
  report.requestsByModel = Object.fromEntries([modelA, modelB].map(model => [model, requests.filter(entry => entry.model === model).map(entry => entry.index)]))
  report.finishedAt = new Date().toISOString()
  await writeFile(reportPath, JSON.stringify(report, null, 2))
  console.log(`Report: ${reportPath}`)
  for (const path of screenshots) console.log(`Screenshot: ${path}`)
}
