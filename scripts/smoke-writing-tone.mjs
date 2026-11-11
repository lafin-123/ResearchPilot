import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { navigateWorkspace } from './workspace-navigation.mjs'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
await mkdir(join(root, 'test-results'), { recursive: true })
const runDir = await mkdtemp(join(root, 'test-results', 'tone-'))
const screenshotPath = join(runDir, 'writing-tone.png')
const reportPath = join(runDir, 'report.json')
const discoverPython = () => {
  const options = { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 }
  const probe = candidate => execFileSync(candidate, ['-I', '-c', 'import sys; assert sys.version_info >= (3, 10); print(sys.executable)'], options).trim()
  if (process.env.RESEARCHPILOT_TEST_PYTHON) return probe(process.env.RESEARCHPILOT_TEST_PYTHON)
  try { return probe(execFileSync('uv', ['python', 'find', '--offline'], options).trim()) }
  catch { return probe('python') }
}
let pythonPath
const modelId = 'tone-smoke-fixture'
const syntheticKey = 'synthetic-tone-smoke-not-a-real-key'
const summary = '合成测试诊断：脚本统计已完成；模型夹具仅建议删除无信息起手式，不改变研究内容。'
const draft = [
  '说白了，本研究使用完全合成的观测记录检查科研写作流程，样本标记为 n=42，参考位置为 [3]。这些文字只用于桌面功能测试，不代表真实受试者、临床结果或已经完成的科学研究。研究问题限定为文本中的数值与引用能否在局部编辑后保持一致。',
  '数据构造阶段采用固定规则生成观测顺序，并将处理条件与记录编号分别保存。分析前先明确变量含义，再核对缺失记录与重复记录。由于此处没有实际测量过程，任何关于误差来源的描述都只是方法示范，不能用于推断真实系统的性能。',
  '研究设计将预处理和结果解释分开。预处理仅整理字段名称，不根据结果选择性删除观测。解释阶段明确区分样本内部变化与总体规律，避免把单次观察扩展为普遍结论。所有假设均需在独立数据上重新检验，当前材料不构成经验性证据。',
  '为评估记录的一致性，分析者应先检查原始字段，再比较整理后的字段。若出现无法解释的差异，应返回数据来源而不是直接替换异常内容。处理日志需要保留修改依据，使后续审阅者能够理解每个步骤的目的，并判断该步骤是否适合研究问题。',
  '结果陈述应同时说明适用范围和局限。本段不报告显著性水平，也不声称某种方法优于其他方法。合成材料只能验证软件是否按既定规则传递文本，无法支持关于治疗效果、社会行为或自然机制的判断。相关结论必须等待真实研究提供证据。',
  '讨论部分关注可重复操作与人工核对之间的边界。自动工具可以帮助发现重复表达，但不能替代对科学含义的判断。若局部建议涉及否定关系、因果力度或必要术语，审阅者应保留原句并解释理由，而不是为了形式整齐而改变论证方向。',
  '复核时先确认原文保持不变，再检查独立修订文本是否只包含被接受的修改。引用位置应与相应论断保持关联，数值应与原始记录一致。对于无法自动验证的内容，报告应明确标注需要人工判断，不把文风统计解释为真实性或学术质量的证明。',
  '最后，本合成草稿仅用于隔离环境中的功能验证，不包含用户稿件或真实凭据。测试完成后保留截图与结构化检查结果，以便核对界面状态和操作顺序。任何进一步研究都应重新定义问题、收集合法数据并执行独立审查，不能复用这里的示范文字作为研究发现。'
].join('\n\n')
const expectedRevision = draft.slice('说白了，'.length)
const checks = [], errors = [], requests = [], fixtureErrors = []
const report = { startedAt: new Date().toISOString(), ok: false, runDir, screenshotPath, reportPath, checks, errors, requests, fixtureErrors }
const record = (name) => { checks.push(name); console.log(`PASS ${name}`) }
const env = { ...process.env, RESEARCHPILOT_USER_DATA: join(runDir, 'profile'), RESEARCHPILOT_WORKSPACE_ROOT: join(runDir, 'workspace') }
for (const key of Object.keys(env)) {
  if (/API[_-]?KEY|TOKEN|SECRET|PASSWORD/i.test(key) || ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS'].includes(key)) delete env[key]
}
let app, page, baseUrl
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST', 'Fixture only accepts inference POST')
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
    // The real service serializes the synthetic manuscript and local detector output into its prompt.
    assert.ok(prompt.includes(JSON.stringify(draft)), 'Model request must contain the exact synthetic draft')
    assert.ok(prompt.includes('"status":"completed"'), 'Model request must contain completed local detection')
    requests.push({ method: req.method, path: req.url, model: payload.model, syntheticDraftMatched: true, completedDetection: true })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id: 'tone-smoke-response', object: 'chat.completion', model: modelId, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ summary, retained: [], edits: [{ before: '说白了，', after: '', reason: '删除不承载科学信息的口语起手式，保留样本数、引用及其余全部文字。', rule: 'A 起手式' }] }) } }] }))
  } catch (error) {
    fixtureErrors.push(String(error))
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Synthetic fixture validation failed' } }))
  }
})

try {
  pythonPath = discoverPython()
  assert.ok((draft.match(/[一-鿿]/gu) ?? []).length > 500)
  report.draftCharacters = draft.length
  report.chineseCharacters = (draft.match(/[一-鿿]/gu) ?? []).length
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  report.fixtureBaseUrl = baseUrl
  app = await electron.launch({ executablePath: require('electron'), args: [root, '--disable-background-networking'], cwd: root, env, timeout: 60000 })
  // Block non-fixture HTTP(S) in Electron's network session; no external model or dev server is used.
  await app.evaluate(({ session }, baseUrl) => {
    globalThis.toneSmokeBlockedRequests = []
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      const allowed = details.url === `${baseUrl}/chat/completions`
      if (!allowed) globalThis.toneSmokeBlockedRequests.push(details.url)
      callback({ cancel: !allowed })
    })
  }, baseUrl)
  page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForSelector('.research-home', { timeout: 60000 })
  const configured = await page.evaluate(async ({ baseUrl, syntheticKey, modelId, pythonPath }) => {
    const api = window.researchpilot
    if (!api.writingTone?.inspect || !api.writingTone?.review) throw new Error('Built out/ is stale: writingTone preload API missing; rebuild required')
    const provider = await api.providers.upsert({ id: 'tone-smoke-fixture', name: 'Synthetic loopback tone fixture', kind: 'custom', protocol: 'openai-completions', baseUrl, apiKey: syntheticKey, models: [{ id: modelId, label: modelId }], isDefault: true })
    const settings = await api.settings.update({ defaultProviderId: provider.id, defaultModelId: modelId, agentRoleModels: {}, pythonPath, telemetry: false })
    const bootstrap = await api.bootstrap()
    return { provider, settings, activeProjectId: bootstrap.activeProjectId }
  }, { baseUrl, syntheticKey, modelId, pythonPath })
  assert.ok(configured.activeProjectId)
  assert.equal(configured.provider.isDefault, true)
  assert.equal(configured.provider.hasApiKey, true)
  assert.equal(configured.provider.baseUrl, baseUrl)
  assert.equal(configured.settings.defaultProviderId, configured.provider.id)
  assert.equal(configured.settings.defaultModelId, modelId)
  assert.equal(configured.settings.pythonPath, pythonPath)
  assert.equal(resolve(configured.settings.workspaceRoot), resolve(env.RESEARCHPILOT_WORKSPACE_ROOT))
  assert.deepEqual(configured.settings.agentRoleModels, {})
  report.configuration = { projectId: configured.activeProjectId, providerId: configured.provider.id, modelId, pythonPath, workspaceRoot: configured.settings.workspaceRoot, profilePath: env.RESEARCHPILOT_USER_DATA }
  record('Real preload APIs configure isolated workspace, synthetic default provider/model, and real Python')

  await navigateWorkspace(page, '/writing-quality')
  const tone = page.getByRole('region', { name: '学术表达去套路 · 内置技能', exact: true })
  await tone.waitFor()
  const original = page.getByRole('textbox', { name: '原文 / 报告标记段落', exact: true })
  const revised = page.getByRole('textbox', { name: '实际修订后的文本', exact: true })
  await original.fill(draft)
  assert.equal(await revised.inputValue(), '')
  await tone.getByRole('button', { name: '仅运行内置脚本（本地）', exact: true }).click()
  await tone.getByText('上游脚本检测和候选抽取已完成；原始结果保留，命中不等于需要修改。', { exact: true }).waitFor({ timeout: 60000 })
  await tone.getByText('查看原始指标与候选', { exact: true }).click()
  const localDetection = JSON.parse(await tone.locator('pre').innerText())
  assert.equal(localDetection.status, 'completed')
  assert.ok(localDetection.metrics)
  assert.ok(localDetection.candidates)
  assert.equal(requests.length, 0, 'Local inspection must not call the model fixture')
  report.localDetection = localDetection
  await tone.getByText('查看原始指标与候选', { exact: true }).click()
  record('UI local inspect completes real Python metrics/candidate extraction without model HTTP')

  const dialogPromise = page.waitForEvent('dialog')
  const clickPromise = tone.getByRole('button', { name: '用内置技能生成建议…', exact: true }).click()
  const dialog = await dialogPromise
  assert.equal(dialog.type(), 'confirm')
  assert.match(dialog.message(), /发送.*写作角色模型/)
  report.modelConsentDialog = { type: dialog.type(), message: dialog.message(), accepted: true }
  await dialog.accept()
  await clickPromise
  await tone.getByText(summary, { exact: true }).waitFor({ timeout: 60000 })
  assert.equal(await tone.locator('ol > li').count(), 1)
  assert.equal(await tone.locator('blockquote').innerText(), '说白了，')
  await tone.getByText('A 起手式', { exact: true }).waitFor()
  await tone.getByText('删除该冗余片段', { exact: true }).waitFor()
  assert.equal(requests.length, 1)
  assert.deepEqual(fixtureErrors, [])
  assert.equal(await original.inputValue(), draft)
  assert.equal(await revised.inputValue(), '')
  record('Confirmed model review uses loopback fixture and displays one A 起手式 deletion suggestion')

  const adopt = tone.getByRole('button', { name: '按这些建议生成修订稿', exact: true })
  await original.fill(`${draft}\n原文变化验证。`)
  await tone.getByText('原文或约束已变化，请重新生成建议。旧建议不能采用。', { exact: true }).waitFor()
  assert.equal(await adopt.isDisabled(), true)
  assert.equal(await revised.inputValue(), '')
  assert.equal(requests.length, 1)
  report.staleSuggestionsDisabled = true
  record('Changing original marks suggestions stale and disables adoption without modifying revision')

  await original.fill(draft)
  await tone.getByText('原文或约束已变化，请重新生成建议。旧建议不能采用。', { exact: true }).waitFor({ state: 'hidden' })
  assert.equal(await adopt.isEnabled(), true)
  await adopt.click()
  await tone.getByRole('button', { name: '已采用到独立修订稿', exact: true }).waitFor({ timeout: 60000 })
  await tone.getByText(/改后脚本复测完成，数字、引用与指定术语文本核对通过/).waitFor()
  const actualOriginal = await original.inputValue()
  const actualRevision = await revised.inputValue()
  assert.equal(actualOriginal, draft, 'Original manuscript must be byte-for-byte unchanged')
  assert.equal(actualRevision, expectedRevision, 'Only the exact leading prefix may be removed')
  assert.ok(!actualRevision.includes('说白了，'))
  assert.ok(actualRevision.includes('n=42'))
  assert.ok(actualRevision.includes('[3]'))
  assert.equal(requests.length, 1, 'Adoption/retest must not make another model request')
  report.preservation = { originalUnchanged: actualOriginal === draft, revisionExactlyPrefixRemoved: actualRevision === expectedRevision, removedPrefix: '说白了，', n42Retained: actualRevision.includes('n=42'), citation3Retained: actualRevision.includes('[3]'), originalCharacters: actualOriginal.length, revisedCharacters: actualRevision.length, postAdoptionDetectionCompleted: true }
  record('Restored-original adoption leaves original unchanged, removes only prefix in revision, retains n=42 and [3], and completes Python retest')

  await revised.fill('')
  await adopt.waitFor()
  assert.equal(await adopt.isEnabled(), true, 'Clearing the adopted revision must allow adoption again')
  await adopt.click()
  await tone.getByRole('button', { name: '已采用到独立修订稿', exact: true }).waitFor({ timeout: 60000 })
  assert.equal(await revised.inputValue(), expectedRevision)
  assert.equal(await original.inputValue(), draft)
  report.clearRevisionReadopt = true
  record('Clearing the adopted revision re-enables adoption and regenerates the exact independent revision')

  // Hold only the delivery of a real completed Python IPC result. This makes concurrent
  // user edits deterministic without replacing the preload API, detector, or model service.
  const armInspectDelivery = () => app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const originalHandler = handlers.get('writing-tone:inspect')
    if (!originalHandler) throw new Error('Cannot gate real writing-tone inspect IPC handler')
    const gate = { completed: false }
    gate.completedPromise = new Promise(resolve => { gate.markCompleted = resolve })
    gate.deliveryPromise = new Promise(resolve => { gate.release = resolve })
    gate.restore = () => { handlers.set('writing-tone:inspect', originalHandler); gate.release() }
    globalThis.toneSmokeInspectGate = gate
    handlers.set('writing-tone:inspect', async (...args) => {
      try {
        const result = await originalHandler(...args)
        gate.completed = true
        gate.markCompleted({ status: result.status })
        await gate.deliveryPromise
        return result
      } catch (error) {
        gate.markCompleted({ error: String(error) })
        throw error
      }
    })
  })
  const context = page.getByRole('textbox', { name: /^预期意思与上下文/ })
  const terms = page.getByRole('textbox', { name: /^不可替换的术语/ })
  report.pendingEditPreservation = []
  for (const target of ['original', 'context', 'protectedTerms', 'revision']) {
    const previousRevision = `人工保留的合成修订稿：${target}，n=42 [3]。`
    const editedRevision = `${previousRevision}等待复测时新增的人工内容。`
    await revised.fill(previousRevision)
    await adopt.waitFor()
    assert.equal(await adopt.isEnabled(), true)
    await armInspectDelivery()
    try {
      const confirmPromise = page.waitForEvent('dialog')
      const adoptionClick = adopt.click()
      const overwriteDialog = await confirmPromise
      assert.equal(overwriteDialog.type(), 'confirm')
      assert.match(overwriteDialog.message(), /替换下方尚未另存的修订文本/)
      await overwriteDialog.accept()
      await adoptionClick
      const realResult = await app.evaluate(() => globalThis.toneSmokeInspectGate.completedPromise)
      assert.equal(realResult.status, 'completed', 'Pending test still executes the real Python detector')
      await tone.getByRole('button', { name: '复测中…', exact: true }).waitFor()
      if (target === 'original') await original.fill(`${draft}\n等待复测期间人工新增原文。`)
      if (target === 'context') await context.fill('等待复测期间人工修改上下文，只报告合成观测。')
      if (target === 'protectedTerms') await terms.fill('观测记录')
      if (target === 'revision') await revised.fill(editedRevision)
      await app.evaluate(() => globalThis.toneSmokeInspectGate.restore())
      await tone.getByRole('button', { name: '复测中…', exact: true }).waitFor({ state: 'hidden' })
      await page.getByText('原文、约束或修订稿已变化，未采用旧建议。', { exact: true }).last().waitFor()
      assert.equal(await revised.inputValue(), target === 'revision' ? editedRevision : previousRevision, 'Pending adoption must not overwrite preserved/manual revision')
      assert.equal(await original.inputValue(), target === 'original' ? `${draft}\n等待复测期间人工新增原文。` : draft)
      if (target === 'context') assert.equal(await context.inputValue(), '等待复测期间人工修改上下文，只报告合成观测。')
      if (target === 'protectedTerms') assert.equal(await terms.inputValue(), '观测记录')
      assert.equal(requests.length, 1)
      report.pendingEditPreservation.push({ target, realPythonCompleted: true, manualRevisionPreserved: true, currentInputPreserved: true, staleAdoptionRejected: true, overwriteConfirmed: true })
      record(`Pending adoption preserves ${target} edits and manual revision after real Python completion`)
    } finally {
      await app.evaluate(() => globalThis.toneSmokeInspectGate?.restore())
    }
    await original.fill(draft)
    await context.fill('')
    await terms.fill('')
  }
  // Leave the final screenshot in a successful adopted state after all race regressions.
  await revised.fill('')
  await adopt.click()
  await tone.getByRole('button', { name: '已采用到独立修订稿', exact: true }).waitFor({ timeout: 60000 })
  assert.equal(await revised.inputValue(), expectedRevision)
  assert.equal(await original.inputValue(), draft)
  assert.equal(requests.length, 1)

  await page.setViewportSize({ width: 1500, height: 1200 })
  await tone.evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: screenshotPath, fullPage: true })
  report.blockedExternalRequests = await app.evaluate(() => globalThis.toneSmokeBlockedRequests)
  assert.deepEqual(report.blockedExternalRequests, [])
  assert.deepEqual(errors, [])
  assert.deepEqual(fixtureErrors, [])
  record('Screenshot captured; no renderer exceptions or external HTTP(S) requests')
  report.ok = true
} catch (error) {
  report.failure = error instanceof Error ? error.stack : String(error)
  if (page && !page.isClosed()) {
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
    report.failureUi = (await page.locator('body').innerText().catch(() => '')).slice(0, 16000)
  }
  console.error(report.failure)
  process.exitCode = 1
} finally {
  try { await app?.close(); report.appClosed = true }
  catch (error) { errors.push(`Electron cleanup: ${String(error)}`); report.ok = false; process.exitCode = 1 }
  finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    report.serverClosed = !server.listening
    report.finishedAt = new Date().toISOString()
    await writeFile(reportPath, JSON.stringify(report, null, 2))
    console.log(`Report: ${reportPath}`)
    console.log(`Screenshot: ${screenshotPath}`)
  }
}
