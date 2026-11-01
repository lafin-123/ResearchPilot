import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const results = join(root, 'test-results')
await mkdir(results, { recursive: true })
const runDir = await mkdtemp(join(results, 'recovery-'))
const env = { ...process.env, RESEARCHPILOT_USER_DATA: join(runDir, 'profile'), RESEARCHPILOT_WORKSPACE_ROOT: join(runDir, 'workspace') }
delete env.ELECTRON_RUN_AS_NODE
const checks = [], errors = []
let app, page
const record = name => { checks.push(name); console.log(`PASS ${name}`) }
async function launch() {
  app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env, timeout: 60000 })
  page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForSelector('.research-home', { timeout: 60000 })
}
const navigate = async path => { await page.locator(`.sidebar a[href="#${path}"]`).click() }
try {
  await launch()
  const initial = await page.evaluate(() => window.researchpilot.bootstrap())
  const projectId = initial.activeProjectId
  const source = initial.projects.find(p => p.id === projectId)
  assert.equal(initial.projectHealth.find(p => p.projectId === projectId).available, true)
  await navigate('/setup')
  await page.getByTestId('readiness-python-path').waitFor()
  await page.getByTestId('project-health-list').waitFor()
  await page.screenshot({ path: join(runDir, '01-setup.png'), fullPage: true })
  record('First-use checklist reads local configuration and displays project health without model calls')
  const seeded = await page.evaluate(async id => {
    const api = window.researchpilot
    const reference = await api.references.upsert({ projectId: id, title: '隔离备份测试来源', abstract: 'Synthetic local fixture; not scientific evidence.', notes: '原始人工笔记不覆盖' })
    const note = await api.notes.create({ projectId: id, title: '恢复测试笔记', body: '跨重启保留的研究记录' })
    const document = await api.documents.create({ projectId: id, title: '备份测试文稿', format: 'latex' })
    await api.documents.saveText(id, document.id, 'Original manuscript fixture; preserve exactly.')
    const experiment = await api.experiments.create({ projectId: id, name: '不执行的测试代码', code: 'raise Exception("must not execute during restore")\n' })
    return { reference, note, document, experiment }
  }, projectId)
  const backupPath = join(runDir, 'research.rpbackup')
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, backupPath)
  await navigate('/backups')
  await page.getByTestId('backup-export').click()
  await page.getByTestId('backup-export-result').waitFor()
  assert.ok((await readFile(backupPath)).length > 100)
  await page.getByTestId('backup-inspect').click()
  await page.getByTestId('backup-confirm-restore').waitFor()
  assert.equal((await page.evaluate(() => window.researchpilot.projects.list())).length, 1)
  await app.evaluate(({ ipcMain }) => {
    // Test-host-only failure injection; renderer's contextBridge API is immutable.
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('app:bootstrap')
    assertHandler(original)
    function assertHandler(handler) { if (typeof handler !== 'function') throw new Error('Bootstrap handler unavailable for test injection') }
    handlers.set('app:bootstrap', (...args) => { handlers.set('app:bootstrap', original); throw new Error('Synthetic project-list refresh failure') })
  })
  await page.getByTestId('backup-confirm-restore').click()
  await page.getByTestId('backup-restore-result').waitFor()
  await page.getByRole('alert').filter({ hasText: '资料已成功恢复，但项目列表刷新失败' }).waitFor()
  await page.getByRole('button', { name: '重新读取项目列表' }).click()
  await page.getByRole('button', { name: '重新读取项目列表' }).waitFor({ state: 'hidden' })
  record('Successful restore remains clearly successful when only the subsequent project-list refresh fails')
  const after = await page.evaluate(() => window.researchpilot.bootstrap())
  const restored = after.projects.find(p => p.id !== projectId)
  assert.ok(restored)
  assert.notEqual(restored.rootPath, source.rootPath)
  assert.ok(existsSync(join(restored.rootPath, '.research', 'bridge.json')))
  const verify = await page.evaluate(async ({ id, originalId }) => {
    const api = window.researchpilot
    const notes = await api.notes.list(id)
    return { notes, note: await api.notes.get(id, notes.items[0].id), references: await api.references.list(id), experiments: await api.experiments.list(id), sourceNotes: await api.notes.list(originalId) }
  }, { id: restored.id, originalId: projectId })
  assert.equal(verify.references[0].notes, seeded.reference.notes)
  assert.equal(verify.note.body, seeded.note.body)
  assert.notEqual(verify.notes.items[0].id, seeded.note.id)
  assert.equal(verify.experiments[0].status, 'idle')
  assert.equal(verify.sourceNotes.items[0].id, seeded.note.id)
  await page.screenshot({ path: join(runDir, '02-backup-restored.png'), fullPage: true })
  record('UI exports, inspects and explicitly restores a separate project with remapped records and initialized bridge')
  record('Restoration preserves source notes and never executes archived experiment code')
  await app.close(); app = null
  await rename(source.rootPath, `${source.rootPath}-temporarily-moved`)
  await launch()
  const missing = await page.evaluate(() => window.researchpilot.bootstrap())
  assert.equal(missing.projects.length, 2)
  assert.equal(missing.projectHealth.find(p => p.projectId === projectId).error.code, 'ENOENT')
  assert.equal(missing.projectHealth.find(p => p.projectId === restored.id).available, true)
  assert.equal(existsSync(source.rootPath), false)
  await navigate('/setup')
  await page.getByTestId(`project-health-${projectId}`).getByText(/不可用/).waitFor()
  await page.getByTestId(`project-health-${projectId}`).getByRole('button', { name: '重试初始化' }).click()
  await page.getByRole('alert').filter({ hasText: 'ENOENT' }).waitFor()
  assert.equal(existsSync(source.rootPath), false)
  const blocked = await page.evaluate(async ({ id, experimentId }) => {
    const api = window.researchpilot
    const actions = [() => api.documents.create({ projectId: id, title: 'blocked', format: 'latex' }), () => api.experiments.run(experimentId), () => api.chat.send({ projectId: id, text: 'must not call model' })]
    const failures = []
    for (const action of actions) { try { await action(); failures.push('NOT BLOCKED') } catch (e) { failures.push(String(e)) } }
    const note = await api.notes.create({ projectId: id, title: '离线数据库笔记', body: 'Root unavailable; DB remains usable.' })
    return { failures, note }
  }, { id: projectId, experimentId: seeded.experiment.id })
  assert.ok(blocked.failures.every(text => text.includes('ENOENT')), JSON.stringify(blocked))
  assert.ok(blocked.note.id)
  assert.equal(existsSync(source.rootPath), false)
  await page.screenshot({ path: join(runDir, '03-missing-project.png'), fullPage: true })
  record('Missing registered root survives restart without recreation; healthy project and database-only notes remain usable')
  record('Document writes, experiment execution and chat dispatch fail closed before any model call')
  await rename(`${source.rootPath}-temporarily-moved`, source.rootPath)
  await page.getByTestId(`project-health-${projectId}`).getByRole('button', { name: '重试初始化' }).click()
  await page.waitForFunction(async id => (await window.researchpilot.projects.health()).find(p => p.projectId === id)?.available, projectId)
  const recovered = await page.evaluate(id => window.researchpilot.projects.health().then(items => items.find(p => p.projectId === id)), projectId)
  assert.equal(recovered.available, true)
  await page.screenshot({ path: join(runDir, '04-recovered.png'), fullPage: true })
  record('Restoring the original directory plus explicit retry recovers project access and resynchronizes bridge')
  await app.close(); app = null
  await launch()
  const persistent = await page.evaluate(async id => {
    const api = window.researchpilot
    const notes = await api.notes.list(id)
    return { health: await api.projects.health(), note: await api.notes.get(id, notes.items[0].id) }
  }, restored.id)
  assert.ok(persistent.health.every(p => p.available))
  assert.equal(persistent.note.body, seeded.note.body)
  await navigate('/backups')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 720))
  assert.ok(await page.getByTestId('backup-inspect').isVisible())
  await page.screenshot({ path: join(runDir, '05-narrow-backups.png'), fullPage: true })
  assert.deepEqual(errors, [])
  record('Restored data and project health survive another restart; backup controls render at 960px width without renderer errors')
  await writeFile(join(runDir, 'report.json'), JSON.stringify({ status: 'passed', checks, errors, runDir, createdAt: new Date().toISOString() }, null, 2))
  console.log(`REPORT ${runDir}`)
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(runDir, 'failure.png'), fullPage: true }).catch(() => {})
  await writeFile(join(runDir, 'report.json'), JSON.stringify({ status: 'failed', checks, errors, error: String(error.stack ?? error), runDir }, null, 2))
  console.error(`FAILED ${runDir}`, error)
  process.exitCode = 1
} finally { if (app) await app.close().catch(() => {}) }
