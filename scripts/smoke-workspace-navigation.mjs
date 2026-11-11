import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'

// Independent expectations deliberately do not import the navigation implementation.
const workspaces = [
  { label: '工作台', path: '/', pages: [['/', '概览'], ['/research', '研究探索'], ['/pipeline', '研究流程']] },
  { label: '助手', path: '/agent', pages: [['/agent', '对话'], ['/skills', '技能库']] },
  { label: '文献', path: '/library', pages: [['/library', '文献库'], ['/notes', '笔记'], ['/knowledge', '知识检索']] },
  { label: '实验', path: '/experiments', pages: [['/experiments', '实验与分析'], ['/methods', '方法复用'], ['/figures', '绘图']] },
  { label: '写作', path: '/writing', pages: [['/writing', '稿件'], ['/writing-quality', '检查与润色']] },
  { label: '设置', path: '/settings', pages: [['/settings', '模型与偏好'], ['/mcp', '工具连接'], ['/setup', '环境检查'], ['/backups', '备份与恢复']] }
]
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const results = join(root, 'test-results')
await mkdir(results, { recursive: true })
const runDir = await mkdtemp(join(results, 'workspace-navigation-'))
const env = { ...process.env, RESEARCHPILOT_USER_DATA: join(runDir, 'profile'), RESEARCHPILOT_WORKSPACE_ROOT: join(runDir, 'workspace') }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const checks = [], errors = [], consoleErrors = [], layouts = [], screenshots = [], resizes = []
let app, page, failure
const record = name => { checks.push(name); console.log(`PASS ${name}`) }

class WorkspaceNavigation {
  constructor(page) { this.page = page }
  get sidebar() { return this.page.getByRole('complementary', { name: '主导航', exact: true }) }
  parent(workspace) { return this.sidebar.getByRole('link', { name: workspace.label, exact: true }) }
  nav(workspace) { return this.page.getByRole('navigation', { name: `${workspace.label}内导航`, exact: true }) }

  async assertState(workspace, path, activePath = path) {
    await this.page.waitForFunction(({ path, parent, activePath }) => {
      const sidebar = [...document.querySelectorAll('.sidebar a[aria-current="page"]')]
      const current = [...document.querySelectorAll('.workspace-nav a[aria-current="page"]')]
      return location.hash === `#${path}` && sidebar.length === 1 && current.length === 1 &&
        sidebar[0].getAttribute('href') === `#${parent}` && current[0].getAttribute('href') === `#${activePath}`
    }, { path, parent: workspace.path, activePath })
    assert.equal(new URL(this.page.url()).hash, `#${path}`)
    assert.equal(await this.parent(workspace).getAttribute('aria-current'), 'page')
    assert.equal(await this.sidebar.locator('a[aria-current="page"]').count(), 1)
    assert.equal(await this.page.locator('.workspace-nav a[aria-current="page"]').count(), 1)
    const nav = this.nav(workspace)
    assert.equal(await nav.getAttribute('class'), 'workspace-nav')
    assert.deepEqual(await nav.getByRole('link').allTextContents(), workspace.pages.map(([, label]) => label))
    assert.deepEqual(await nav.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href'))), workspace.pages.map(([route]) => `#${route}`))
    assert.equal(await nav.locator('a[aria-current="page"]').getAttribute('href'), `#${activePath}`)
    await this.page.waitForFunction(() => document.querySelector('.main-shell > main')?.textContent.trim().length > 0)
  }

  async open(workspace, path = workspace.path) {
    await this.parent(workspace).click()
    await this.assertState(workspace, workspace.path)
    if (path !== workspace.path) {
      const label = workspace.pages.find(([route]) => route === path)?.[1]
      assert.ok(label, `Unknown route ${path}`)
      await this.nav(workspace).getByRole('link', { name: label, exact: true }).click()
      await this.assertState(workspace, path)
    }
  }

  async allRoutes(context) {
    const visited = new Set()
    for (const workspace of workspaces) {
      await this.open(workspace)
      // Include each group's landing link: opening the parent alone is not enough.
      for (const [path, label] of workspace.pages) {
        await this.nav(workspace).getByRole('link', { name: label, exact: true }).click()
        await this.assertState(workspace, path)
        visited.add(path)
      }
    }
    assert.equal(visited.size, 17)
    record(`${context}: all six sidebar parents and all 17 subnavigation links are clickable with unique, correct aria-current states`)
  }
}

async function assertSidebar(navigation) {
  const main = navigation.sidebar.getByRole('navigation', { name: '工作区', exact: true })
  assert.equal(await main.getAttribute('class'), 'side-main-nav')
  assert.equal(await main.getByRole('link').count(), 5)
  assert.deepEqual(await main.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('aria-label'))), workspaces.slice(0, 5).map(workspace => workspace.label))
  assert.deepEqual(await main.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href'))), workspaces.slice(0, 5).map(workspace => `#${workspace.path}`))
  assert.equal(await navigation.sidebar.getByRole('link').count(), 6, 'Sidebar must not duplicate individual tool links')
  assert.equal(await navigation.sidebar.locator('.sidebar-bottom').getByRole('link', { name: '设置', exact: true }).count(), 1)
  for (const workspace of workspaces) assert.equal(await navigation.parent(workspace).isVisible(), true, `${workspace.label} must stay accessible`)
}

async function assertLayout(context, selector) {
  const metrics = await page.evaluate(selector => {
    const measure = element => {
      if (!element) return null
      const { x, y, width, height, right, bottom } = element.getBoundingClientRect()
      return { x, y, width, height, right, bottom, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: measure(document.documentElement), body: measure(document.body),
      shell: measure(document.querySelector('.main-shell')), content: measure(document.querySelector('.main-shell > main')),
      nav: measure(document.querySelector('.workspace-nav')), panel: selector ? measure(document.querySelector(selector)) : null
    }
  }, selector)
  layouts.push({ context, ...metrics })
  const { width, height } = metrics.viewport
  for (const name of ['document', 'body', 'shell']) {
    const box = metrics[name]
    assert.ok(box && box.width > 0, `${context}: missing ${name}`)
    assert.ok(box.scrollWidth <= box.clientWidth + 1, `${context}: ${name} horizontal overflow: ${JSON.stringify(box)}`)
    assert.ok(box.x >= -1 && box.right <= width + 1, `${context}: ${name} outside viewport`)
  }
  assert.ok(metrics.nav.height >= 40 && metrics.nav.bottom <= height, `${context}: subnavigation must remain on screen`)
  if (selector) {
    const panel = metrics.panel, content = metrics.content
    assert.ok(panel && panel.width >= 300 && panel.height >= 250, `${context}: usable panel size: ${JSON.stringify(panel)}`)
    assert.ok(Math.abs(panel.width - content.width) <= 2 && Math.abs(panel.height - content.height) <= 2, `${context}: flush panel must fill remaining content, not overlap the new subnavigation`)
    assert.ok(panel.y >= metrics.nav.bottom - 1 && panel.bottom <= height + 1, `${context}: panel extends outside available vertical space`)
  }
}

async function resize(width, height) {
  // Try the actual Electron window first. Its production minWidth can clamp compact sizes.
  const actual = await app.evaluate(({ BrowserWindow }, { width, height }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setContentSize(width, height)
    return window.getContentSize()
  }, { width, height })
  const fallback = actual[0] !== width || actual[1] !== height
  if (fallback) await page.setViewportSize({ width, height })
  await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, { width, height })
  resizes.push({ requested: [width, height], electronContentSize: actual, mode: fallback ? 'Playwright CSS viewport (Electron minimum/window bounds)' : 'Electron window' })
}

async function screenshot(name) {
  const path = join(runDir, name)
  await page.screenshot({ path })
  screenshots.push(path)
}

try {
  app = await electron.launch({ executablePath: require('electron'), args: [root, '--disable-background-networking'], cwd: root, env, timeout: 60000 })
  // Local IPC/bridge traffic is allowed; external Chromium requests are blocked, not mocked with provider responses.
  await app.evaluate(({ session }) => {
    globalThis.navigationExternalRequests = []
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      const url = new URL(details.url)
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      if (!local) globalThis.navigationExternalRequests.push(`${url.protocol}//${url.host}`)
      callback({ cancel: !local })
    })
  })
  page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.locator('.research-home').waitFor({ timeout: 60000 })
  assert.equal(new URL(page.url()).protocol, 'file:', 'Smoke must use the built local renderer, not a development server')
  const bootstrap = await page.evaluate(() => window.researchpilot.bootstrap())
  assert.equal(bootstrap.projects.length, 1)
  const providers = await page.evaluate(() => window.researchpilot.providers.list())
  assert.equal(providers.some(provider => provider.hasApiKey), false, 'Isolated profile must not have real provider credentials')
  const navigation = new WorkspaceNavigation(page)
  await resize(1440, 900)
  await assertSidebar(navigation)
  record('Reduced sidebar has exactly 工作台/助手/文献/实验/写作 and bottom 设置, without duplicated tool links')
  await navigation.allRoutes('Desktop')

  const literature = workspaces[2], assistant = workspaces[1]
  await navigation.open(literature)
  await page.evaluate(projectId => window.researchpilot.references.upsert({ projectId, title: '导航验证 · 合成文献（非研究证据）', authors: '本地界面测试', year: '2026', abstract: '仅用于隔离环境中的导航验证，不是外部文献或真实研究结果。' }), bootstrap.activeProjectId)
  // Remount the library so the synthetic local reference is loaded through normal UI state.
  await navigation.open(workspaces[4])
  await navigation.open(literature)
  await page.getByText('导航验证 · 合成文献（非研究证据）', { exact: true }).waitFor()
  await assertLayout('Desktop library')
  await screenshot('01-desktop-library.png')
  await navigation.open(workspaces[5])
  await page.getByRole('heading', { level: 1 }).waitFor()
  await assertLayout('Desktop settings')
  await screenshot('02-desktop-settings.png')
  record('Desktop library and settings screenshots show reduced sidebar and grouped navigation')

  await navigation.open(assistant)
  await page.locator('.composer-box textarea').waitFor()
  await assertLayout('Desktop assistant', '.agent-page')
  await navigation.open(literature, '/notes')
  await page.getByRole('heading', { name: '研究笔记', exact: true }).waitFor()
  await assertLayout('Desktop notes index', '.notes-workspace')
  await page.getByTestId('notes-new').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '笔记标题', exact: true }).fill('导航验证 · 本地合成笔记')
  await dialog.getByRole('button', { name: '创建笔记', exact: true }).click()
  await page.getByTestId('note-editor').waitFor()
  const noteId = await page.getByTestId('note-editor').getAttribute('data-note-id')
  assert.ok(noteId)
  await navigation.assertState(literature, `/notes/${encodeURIComponent(noteId)}`, '/notes')
  assert.equal(await page.getByRole('textbox', { name: '笔记标题', exact: true }).inputValue(), '导航验证 · 本地合成笔记')
  await assertLayout('Desktop nested note', '.notes-workspace')
  await page.getByRole('button', { name: '返回笔记列表', exact: true }).click()
  await navigation.assertState(literature, '/notes')
  record('Assistant and notes fill available desktop space; UI-created /notes/:id retains 文献 and 笔记 active states')

  // The UI emits canonical links. Exercise copied/deep-linked variants through the
  // actual HashRouter, then verify its rendered navigation recovers to canonical links.
  for (const workspace of workspaces) {
    for (const [canonical, label] of workspace.pages) {
      if (canonical === '/') continue
      for (const variant of [`${canonical}/`, canonical.toUpperCase(), `${canonical.toUpperCase()}/`]) {
        await page.evaluate(path => { window.location.hash = `#${path}` }, variant)
        await navigation.assertState(workspace, variant, canonical)
        await navigation.nav(workspace).getByRole('link', { name: label, exact: true }).click()
        await navigation.assertState(workspace, canonical)
      }
    }
  }
  const nestedVariant = `/Notes/${encodeURIComponent(noteId)}/`
  await page.evaluate(path => { window.location.hash = `#${path}` }, nestedVariant)
  await navigation.assertState(literature, nestedVariant, '/notes')
  await page.getByTestId('note-editor').waitFor()
  assert.equal(await page.getByRole('textbox', { name: '笔记标题', exact: true }).inputValue(), '导航验证 · 本地合成笔记')
  await navigation.nav(literature).getByRole('link', { name: '笔记', exact: true }).click()
  await navigation.assertState(literature, '/notes')
  record('48 case/trailing-slash route variants and nested /Notes/:id/ retain correct navigation and clickable canonical links')

  for (const [query, label, workspace, path] of [
    ['备份', '设置 / 备份与恢复', workspaces[5], '/backups'],
    ['润色', '写作 / 检查与润色', workspaces[4], '/writing-quality']
  ]) {
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog')
    await palette.getByRole('textbox').fill(query)
    const result = palette.getByRole('button', { name: label, exact: true })
    await result.waitFor()
    assert.equal(await result.isVisible(), true)
    await result.click()
    await palette.waitFor({ state: 'hidden' })
    await navigation.assertState(workspace, path)
    record(`Ctrl+K search ${query} finds ${label} and navigates to ${path}`)
  }

  for (const width of [800, 560]) {
    await resize(width, 720)
    await assertSidebar(navigation)
    await navigation.allRoutes(`${width}x720`)
    await navigation.open(assistant)
    await page.locator('.composer-box textarea').waitFor()
    await assertLayout(`${width}x720 assistant`, '.agent-page')
    await navigation.open(literature, '/notes')
    await page.getByRole('heading', { name: '研究笔记', exact: true }).waitFor()
    await assertLayout(`${width}x720 notes`, '.notes-workspace')
    await navigation.open(workspaces[5], '/backups')
    await assertLayout(`${width}x720 settings navigation`)
    await screenshot(`03-compact-${width}.png`)
    record(`${width}x720 sidebar stays accessible; agent/notes and main shell have no horizontal overflow`)
  }
  const externalRequests = await app.evaluate(() => globalThis.navigationExternalRequests)
  assert.deepEqual(externalRequests, [], 'Navigation must not attempt external network requests')
  const state = await page.evaluate(() => window.researchpilot.chat.state())
  assert.equal(['running', 'starting'].includes(state.status), false)
  assert.deepEqual(errors, [], 'Renderer JavaScript exceptions')
  assert.deepEqual(consoleErrors, [], 'Renderer console errors')
  record('No renderer exceptions, console errors, running provider tasks, or external network requests')
} catch (error) {
  failure = error.stack ?? String(error)
  if (page) await screenshot('failure.png').catch(() => {})
  console.error(failure)
  process.exitCode = 1
} finally {
  const externalRequests = app ? await app.evaluate(() => globalThis.navigationExternalRequests ?? []).catch(() => []) : []
  await writeFile(join(runDir, 'report.json'), JSON.stringify({ checks, errors, consoleErrors, failure, externalRequests, layouts, resizes, screenshots, runDir }, null, 2))
  console.log(`Artifacts: ${runDir}`)
  await app?.close()
}
