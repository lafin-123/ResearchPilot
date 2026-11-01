import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
await mkdir(join(root, 'test-results'), { recursive: true })
const runDir = await mkdtemp(join(root, 'test-results', 'provider-discovery-'))
const requests = [], checks = [], errors = []
const server = createServer((req, res) => {
  requests.push({ method: req.method, path: req.url })
  if (req.method !== 'GET' || req.url !== '/v1/models') { res.writeHead(400); res.end('Unexpected inference request'); return }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ data: [{ id: 'fixture-model-a', display_name: 'Fixture Model A', context_window: 64000, max_output_tokens: 4096, capabilities: { vision: true, tools: false } }, { id: 'fixture-model-b' }] }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/v1`
const env = { ...process.env, RESEARCHPILOT_USER_DATA: join(runDir, 'profile'), RESEARCHPILOT_WORKSPACE_ROOT: join(runDir, 'workspace') }
delete env.ELECTRON_RUN_AS_NODE
let app, page
const record = name => { checks.push(name); console.log(`PASS ${name}`) }
try {
  app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env, timeout: 60000 })
  page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForSelector('.research-home', { timeout: 60000 })
  await page.locator('.sidebar a[href="#/settings"]').click()
  await page.getByRole('button', { name: '添加提供方', exact: true }).click()
  await page.getByLabel('显示名称', { exact: true }).fill('Local discovery fixture')
  await page.getByLabel('基础 URL', { exact: true }).fill(url)
  await page.locator('.modal input[type="password"]').fill('synthetic-test-key-not-real')
  await page.getByRole('button', { name: '获取模型并继续', exact: true }).click()
  await page.locator('.provider-model-option').filter({ hasText: 'Fixture Model A' }).waitFor()
  assert.equal(await page.locator('.provider-model-option').count(), 2)
  assert.match(await page.locator('.provider-model-option').first().textContent(), /64,000/)
  assert.match(await page.locator('.provider-model-option').last().textContent(), /上游未提供/)
  assert.ok(requests.every(r => r.method === 'GET' && r.path === '/v1/models'))
  record('URL and key discover upstream models without handwritten IDs or inference')
  await page.locator('.provider-model-option').filter({ hasText: 'fixture-model-b' }).locator('input').uncheck()
  await page.screenshot({ path: join(runDir, '01-upstream-selection.png'), fullPage: true })
  await page.getByRole('button', { name: '保存所选模型', exact: true }).click()
  await page.waitForFunction(async () => (await window.researchpilot.providers.list()).some(p => p.name === 'Local discovery fixture'))
  const saved = await page.evaluate(async () => (await window.researchpilot.providers.list()).find(p => p.name === 'Local discovery fixture'))
  assert.equal(saved.models.length, 1)
  assert.equal(saved.models[0].id, 'fixture-model-a')
  assert.equal(saved.models[0].contextWindow, 64000)
  assert.deepEqual(saved.models[0].capabilities, { vision: true, tools: false })
  record('Selection persists upstream context and capabilities without guessing unknowns')
  await page.getByRole('button', { name: '添加提供方', exact: true }).click()
  await page.getByLabel('显示名称', { exact: true }).fill('Manual fixture')
  await page.getByLabel('基础 URL', { exact: true }).fill(url)
  await page.locator('.modal input[type="password"]').fill('synthetic-manual-key')
  await page.getByRole('button', { name: '手动填写模型（可选）', exact: true }).click()
  await page.getByLabel('手动模型列表', { exact: false }).fill('custom-id | Custom model')
  await page.getByRole('button', { name: '保存所选模型', exact: true }).click()
  await page.waitForFunction(async () => (await window.researchpilot.providers.list()).some(p => p.name === 'Manual fixture'))
  record('Manual model input remains an optional fallback')
  assert.deepEqual(errors, [])
  assert.equal(requests.length, 1)
  await writeFile(join(runDir, 'report.json'), JSON.stringify({ status: 'passed', checks, errors, requests, createdAt: new Date().toISOString() }, null, 2))
  console.log(`REPORT ${runDir}`)
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(runDir, 'failure.png'), fullPage: true }).catch(() => {})
  await writeFile(join(runDir, 'report.json'), JSON.stringify({ status: 'failed', checks, errors, error: String(error.stack ?? error) }, null, 2))
  console.error(runDir, error); process.exitCode = 1
} finally { if (app) await app.close().catch(() => {}); await new Promise(resolve => server.close(resolve)) }
