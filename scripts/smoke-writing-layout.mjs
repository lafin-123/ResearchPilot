import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { navigateWorkspace } from './workspace-navigation.mjs'

// Launch only after the parent confirms the complete production build is ready.
// Real Electron, renderer, preload, DOCX conversion and local memory service.
// No provider is configured, no model is called, and no application API is replaced.
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const results = join(root, 'test-results')
await mkdir(results, { recursive: true })
const runDir = await mkdtemp(join(results, 'writing-layout-'))
const reportPath = join(runDir, 'report.json')
const checks = [], errors = [], blockedRequests = [], screenshots = [], metrics = [], assertionFailures = []
const report = {
  startedAt: new Date().toISOString(), ok: false, runDir, reportPath,
  checks, errors, blockedRequests, screenshots, metrics, assertionFailures,
  limits: [
    'Synthetic academic demonstration only; no empirical research results or verified bibliographic claims.',
    'DOCX body reader only; tables, equations, images and fidelity of Word pagination are not tested.',
    'Rapid selection exercises real request scope without artificial IPC delays; not every scheduler interleaving is guaranteed.',
    'Electron HTTP guard is not an OS-level network sandbox. No external provider or real credentials are configured.'
  ]
}
const title = '面向可追溯科研写作的证据协同工作流'
const secondTitle = '研究笔记到章节草稿的映射规范'
const headings = ['摘要', '研究方法', '结果', '讨论', '局限']
const paragraphs = [
  '科研写作需要同时维护正文、证据来源与作者的写作取舍。本文以可追溯性为线索，构建正文阅读、章节定位和研究记忆协同呈现的工作流。本文为界面与流程演示稿，不包含真实受试者、实验测量或已验证的效果结论。',
  '工作流将已保存文稿作为阅读基准，将研究问题、适用范围和写作决定保存在独立的论文记忆中。作者先阅读章节，再按需检查来源与证据；只有明确进入编辑模式时，才修改正文或记忆。来源快照记录定位与校验信息，用于回看材料，不替代学术判断。',
  '本节仅展示材料如何组织，不报告性能提升或统计显著性。演示稿把摘要、研究方法、结果、讨论与局限分为可定位章节；研究记忆同时保留已接受和已拒绝的表述方案，使作者能够复查写作边界。是否改善真实协作效率，仍需独立研究验证。',
  '正文与研究记忆承担不同职责。正文呈现作者准备交流的论证，记忆解释写作时应保留的限制、术语和未决问题。两者并列展示，有助于作者在阅读具体段落时回看约束，而不把草拟中的决定误当成证据已经成立。',
  '讨论还需区分来源可访问与主张可信。来源快照能够指出材料来自哪里、何时采集以及是否发生变化，但不能自动判断研究设计是否充分。引用应回到原始材料核对，缺少证据的论断应保留为问题，而非补写成结论。',
  '在协作场景中，作者可以先接受术语统一和适用范围说明，再拒绝缺少测量依据的推广表述。这样的决定应随章节阅读保持可见，同时避免常驻的大表单挤占正文空间。后续评估将关注任务完成过程，而不是以界面演示代替有效性研究。',
  '本稿仅用于软件演示，未开展用户实验、定量比较或外部文献核验。示例材料不能支持因果推断、普遍适用性或临床有效性主张；正式研究应补充伦理审查、数据来源、评价协议与独立复现。'
]
const markdown = `# ${title}\n\n## 摘要\n\n${paragraphs[0]}\n\n## 研究方法\n\n${paragraphs[1]}\n\n## 结果\n\n${paragraphs[2]}\n\n## 讨论\n\n${paragraphs.slice(3, 6).join('\n\n')}\n\n## 局限\n\n${paragraphs[6]}\n`
const secondBody = '本规范演示如何区分研究笔记、章节草稿与正式结论。它不属于第一份论文，也不提供实证结果。'
const memoryFields = {
  question: '如何让正文阅读始终伴随可回看的证据与写作边界？',
  hypothesis: '把来源与取舍放在正文旁边，可能减少上下文切换；尚未开展实证评估。',
  contribution: '提出正文优先、记忆按需编辑的可追溯写作流程。',
  scope: '软件演示稿；不报告真实实验或效果结论。',
  terms: '正文阅读；来源快照；写作决定；可追溯性'
}
const accepted = '统一使用“来源快照”，不将正文循环当作独立证据。'
const rejected = '不采用“显著提升科研效率”的无测量依据表述。'
const issue = '真实协作场景的评价协议仍待设计。'
const revisedScope = '仅限软件流程演示；真实效果仍需独立评估。'
const sha = value => createHash('sha256').update(value).digest('hex')
const record = name => { checks.push(name); console.log(`PASS ${name}`) }
const env = {
  ...process.env,
  RESEARCHPILOT_USER_DATA: join(runDir, 'profile'),
  RESEARCHPILOT_WORKSPACE_ROOT: join(runDir, 'workspace'),
  DSH_TELEMETRY_DISABLED: '1'
}
for (const key of Object.keys(env)) {
  if (/API[_-]?KEY|TOKEN|SECRET|PASSWORD|PROXY|BASE_URL|API_BASE/i.test(key) ||
      ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS', 'DSH_HOME'].includes(key)) delete env[key]
}
let app, page, projectId, document, secondDocument, reference, savedMemory
const originals = new Map()

function deadline(promise, label, timeout = 60000) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: ${timeout}ms deadline exceeded`)), timeout)
  })]).finally(() => clearTimeout(timer))
}
async function until(condition, label, timeout = 60000) {
  return deadline((async () => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const value = await condition()
      if (value) return value
      await new Promise(resolveTick => setTimeout(resolveTick, 75))
    }
    throw new Error(`${label}: condition not met`)
  })(), label, timeout)
}
function api(group, method, ...args) {
  return deadline(page.evaluate(async ({ group, method, args }) => {
    const target = window.researchpilot[group]
    if (typeof target?.[method] !== 'function') throw new Error(`Stale built preload: ${group}.${method}`)
    return target[method](...args)
  }, { group, method, args }), `Preload ${group}.${method}`)
}

class WritingJourney {
  constructor(page) { this.page = page }
  get reader() { return this.page.getByRole('region', { name: '文稿阅读区', exact: true }) }
  get panel() { return this.page.getByRole('region', { name: '论文上下文', exact: true }) }
  get select() { return this.page.getByRole('combobox', { name: '当前稿件', exact: true }) }
  get article() { return this.reader.locator('.manuscript-paper') }
  field(name) { return this.panel.getByRole('textbox', { name, exact: true }) }
  button(name) { return this.panel.getByRole('button', { name, exact: true }) }
  async idle() {
    await this.panel.locator('.paper-context-body[aria-busy="false"]').waitFor({ timeout: 60000 })
    assert.equal(await this.panel.getByRole('alert').count(), 0)
  }
  async choose(id, expectedTitle) {
    await this.idle()
    await this.select.selectOption(id)
    await this.idle()
    await this.article.getByRole('heading', { name: expectedTitle, level: 1, exact: true }).waitFor()
    assert.equal(await this.reader.getByRole('alert').count(), 0)
  }
  async details(name, open = true) {
    const summary = this.panel.locator('summary').filter({ hasText: name })
    assert.equal(await summary.count(), 1, `Unique disclosure ${name}`)
    if (await summary.evaluate(element => element.parentElement.open) !== open) await summary.click()
  }
  async summary() {
    const returning = this.button('返回摘要')
    if (await returning.isVisible()) await returning.click()
    await this.details(/^章节写作$/, false)
    await this.details(/^来源与证据/, false)
    await this.details(/^更多与隐私$/, false)
    assert.equal(await this.panel.locator('textarea:visible').count(), 0)
  }
}

async function capture(name) {
  const path = join(runDir, name)
  await page.screenshot({ path, fullPage: false, animations: 'disabled', timeout: 30000 })
  screenshots.push(path)
  return path
}
async function scrollTop() {
  await page.locator('.content').evaluate(element => element.scrollTo({ top: 0, left: 0, behavior: 'instant' }))
}
async function assertOriginals(label) {
  for (const doc of [document, secondDocument]) {
    const current = await api('documents', 'read', projectId, doc.id)
    assert.equal(sha(Buffer.from(current.base64, 'base64')), originals.get(doc.id).hash, `${label}: original ${doc.title} bytes changed`)
    assert.equal((await api('documents', 'readText', projectId, doc.id)).text, originals.get(doc.id).text, `${label}: original extracted text changed`)
    assert.deepEqual(await api('documents', 'versions', projectId, doc.id), originals.get(doc.id).versions, `${label}: reading created an unexpected saved version`)
  }
}
async function layoutMetrics(width) {
  return page.evaluate(width => {
    const rect = selector => {
      const element = document.querySelector(selector)
      if (!element) throw new Error(`Missing metric element: ${selector}`)
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }
    }
    const selectors = ['html', 'body', '.app-shell', '.content', '.writing-desk', '.writing-desk-layout', '.manuscript-workspace', '.writing-context-rail', '.paper-context']
    return {
      viewport: width, reader: rect('.manuscript-workspace'), rail: rect('.writing-context-rail'), sidebar: rect('.sidebar'),
      visibleContextTextareas: [...document.querySelectorAll('.paper-context textarea')].filter(element => element.getClientRects().length > 0).length,
      overflows: selectors.map(selector => {
        const element = document.querySelector(selector)
        return { selector, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }
      }).filter(item => item.scrollWidth > item.clientWidth + 1)
    }
  }, width)
}

try {
  app = await electron.launch({ executablePath: require('electron'), args: [root, '--disable-background-networking'], cwd: root, env, timeout: 60000 })
  await deadline(app.evaluate(({ session }) => {
    globalThis.writingLayoutBlockedRequests = []
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      globalThis.writingLayoutBlockedRequests.push(details.url)
      callback({ cancel: true })
    })
  }), 'Install no-network guard')
  page = await app.firstWindow({ timeout: 60000 })
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.research-home').waitFor({ timeout: 60000 })
  assert.equal(new URL(page.url()).protocol, 'file:')
  await page.setViewportSize({ width: 1440, height: 1000 })

  const setup = await deadline(page.evaluate(async ({ title, secondTitle, markdown, secondBody, memoryFields, accepted, rejected, issue }) => {
    const api = window.researchpilot
    if ((await api.providers.list()).some(item => item.hasApiKey)) throw new Error('Isolated profile unexpectedly contains credentials')
    const bootstrap = await api.bootstrap()
    const projectId = bootstrap.activeProjectId
    if (!projectId) throw new Error('No isolated default project')
    await api.projects.update({ id: projectId, name: '科研写作工作流演示', description: '合成学术材料，仅用于软件界面与流程演示。' })
    const document = await api.documents.create({ projectId, title, format: 'docx', markdown })
    const secondDocument = await api.documents.create({ projectId, title: secondTitle, format: 'docx', markdown: `# ${secondTitle}\n\n## 摘要\n\n${secondBody}\n\n## 研究方法\n\n来源只用于示范材料映射，不作为独立科学证据。` })
    const initial = await api.paperContext.get(projectId, document.id)
    const memory = { ...initial.memory, ...memoryFields,
      decisions: [
        { id: 'decision_wording', text: accepted, status: 'accepted', chapter: '研究方法' },
        { id: 'decision_claim', text: rejected, status: 'rejected', chapter: '讨论' }
      ], issues: [{ id: 'issue_evaluation', text: issue, chapter: '局限', resolved: false }]
    }
    const saved = await api.paperContext.save(projectId, memory)
    const secondInitial = await api.paperContext.get(projectId, secondDocument.id)
    await api.paperContext.save(projectId, { ...secondInitial.memory, question: '如何区分笔记材料与章节草稿？', scope: '另一份独立的演示规范；不属于主论文。' })
    const reference = await api.references.upsert({ projectId, title: '证据记录与章节映射说明（演示材料）', authors: '演示材料编写组', year: '2026', venue: '未发表的合成示例', abstract: '研究方法：来源定位与章节映射仅演示工作流；不提供实证结果，不是真实出版物。', notes: '合成说明材料，未附 PDF，不能当作真实文献引用。', tags: ['演示材料'] })
    await api.paperContext.link({ projectId, documentId: document.id, kind: 'reference', targetId: reference.id })
    await api.paperContext.activate(projectId, document.id)
    return { projectId, document, secondDocument, reference, savedMemory: saved.memory }
  }, { title, secondTitle, markdown, secondBody, memoryFields, accepted, rejected, issue }), 'Seed Chinese demonstration DOCX and saved memory')
  ;({ projectId, document, secondDocument, reference, savedMemory } = setup)
  report.configuration = { projectId, documentId: document.id, secondDocumentId: secondDocument.id, referenceId: reference.id, profile: env.RESEARCHPILOT_USER_DATA, workspace: env.RESEARCHPILOT_WORKSPACE_ROOT }
  for (const doc of [document, secondDocument]) {
    const binary = await api('documents', 'read', projectId, doc.id)
    assert.equal(Buffer.from(binary.base64, 'base64').subarray(0, 2).toString(), 'PK')
    originals.set(doc.id, { hash: sha(Buffer.from(binary.base64, 'base64')), text: (await api('documents', 'readText', projectId, doc.id)).text, versions: await api('documents', 'versions', projectId, doc.id) })
  }
  record('Real preload creates Chinese demonstration DOCX, saved accepted/rejected decisions, open issue and linked reference without credentials')
  await page.reload()
  await page.locator('.research-home').waitFor({ timeout: 60000 })
  await navigateWorkspace(page, '/writing')
  const ui = new WritingJourney(page)
  await ui.choose(document.id, title)
  await ui.summary()
  await scrollTop()
  const desktop = await layoutMetrics(1440)
  metrics.push(desktop)
  await capture('01-desktop-reader-and-memory.png')
  assert.equal(desktop.visibleContextTextareas, 0, 'Default context is summary-only')
  assert.ok(desktop.reader.width > desktop.rail.width, 'Reader must dominate the memory rail')
  assert.ok(desktop.rail.x >= desktop.reader.right, 'Desktop memory rail is to the right of the manuscript')
  assert.deepEqual(desktop.overflows, [], 'Desktop must have no horizontal overflow')
  for (const text of [memoryFields.question, memoryFields.contribution, memoryFields.scope, accepted, rejected, issue]) {
    assert.ok((await ui.panel.innerText()).includes(text), `Saved summary missing ${text}`)
  }
  await assertOriginals('Default reader')
  record('1440×1000 default reader is wider than right summary rail, shows saved memory and no context textareas or horizontal overflow')

  const articleText = await ui.article.innerText()
  report.reader = { titleOccurrences: articleText.split(title).length - 1, chapterTitles: await ui.reader.getByRole('navigation', { name: '文稿章节' }).getByRole('button').allTextContents() }
  // Collect independent reader assertions, but fail the overall run at the end.
  // This preserves responsive/editor evidence even if a reader regression exists.
  const readerCheck = async (name, action) => {
    try { await action() }
    catch (error) {
      assertionFailures.push({ check: name, error: error instanceof Error ? error.stack : String(error) })
      console.error(`FAIL ${name}: ${String(error)}`)
    }
  }
  await readerCheck('reader-title-not-duplicated', async () => {
    assert.equal(report.reader.titleOccurrences, 1, 'Saved title must appear once, not duplicated from extracted DOCX text')
  })
  await readerCheck('reader-each-original-paragraph-once', async () => {
    for (const paragraph of paragraphs) assert.equal(articleText.split(paragraph).length - 1, 1, 'Each original paragraph must be rendered exactly once')
  })
  for (const heading of headings) await readerCheck(`reader-chapter-${heading}`, async () => {
    assert.equal(await ui.article.getByRole('heading', { name: heading, level: 2, exact: true }).count(), 1, `One ${heading} heading in article`)
    assert.equal(await ui.reader.getByRole('navigation', { name: '文稿章节' }).getByRole('button', { name: heading, exact: true }).count(), 1, `One ${heading} outline entry`)
  })
  await readerCheck('reader-navigation-scrolls-without-changing-text', async () => {
    const beforeScroll = await page.locator('.content').evaluate(element => element.scrollTop)
    const chapterButton = ui.reader.getByRole('navigation', { name: '文稿章节' }).getByRole('button', { name: '讨论', exact: true })
    await chapterButton.click()
    assert.equal(await chapterButton.getAttribute('aria-current'), 'location')
    await until(async () => (await page.locator('.content').evaluate(element => element.scrollTop)) > beforeScroll + 50, 'Chapter navigation scrolls the actual reading pane')
    const targetBox = await ui.article.getByRole('heading', { name: '讨论', exact: true }).boundingBox()
    assert.ok(targetBox && targetBox.y >= 0 && targetBox.y < 1000, 'Target chapter is in the viewport')
    assert.equal(await ui.article.innerText(), articleText, 'Chapter navigation must not duplicate or alter displayed prose')
    await assertOriginals('Chapter navigation')
  })
  if (assertionFailures.length) await capture('reader-assertion-failure.png')
  else record('All five Chinese chapter headings navigate and scroll; title and every original paragraph appear exactly once without file changes')

  await scrollTop()
  await ui.reader.getByRole('button', { name: '打开编辑器', exact: true }).click()
  await page.waitForURL(url => url.hash === `#/write/${document.id}`, { timeout: 60000 })
  await page.locator('.editor-title').filter({ hasText: title }).waitFor({ timeout: 60000 })
  await page.locator('.docx-host').waitFor({ timeout: 60000 })
  await until(async () => (await page.locator('.docx-host').innerText()).replace(/\s+/g, '').includes(paragraphs[0].replace(/\s+/g, '')), 'Native DOCX editor renders the original saved manuscript across visual line wraps', 90000)
  assert.ok((await page.locator('.docx-host').innerText()).includes(title))
  await assertOriginals('Opened native editor without editing')
  await page.locator('.editor-topbar').getByRole('button', { name: '返回', exact: true }).click()
  await ui.choose(document.id, title)
  assert.equal(await ui.article.innerText(), articleText)
  await assertOriginals('Return from native editor')
  record('Native DOCX editor opens the original title/body; return preserves reader content, exact bytes and document versions')

  // Exercise rapid real selections without mocking IPC, preload or app state.
  // The final manuscript and memory must agree even if preceding reads finish late.
  for (let index = 0; index < 3; index++) {
    await ui.idle()
    await ui.select.selectOption(secondDocument.id)
    await ui.idle()
    await ui.select.selectOption(document.id)
  }
  await ui.choose(secondDocument.id, secondTitle)
  await ui.article.getByText(secondBody, { exact: true }).waitFor()
  assert.ok(!(await ui.article.innerText()).includes(paragraphs[0]))
  assert.ok((await ui.panel.innerText()).includes('如何区分笔记材料与章节草稿？'))
  assert.ok(!(await ui.panel.innerText()).includes(memoryFields.question))
  assert.equal((await api('paperContext', 'get', projectId, document.id)).active, true, 'Reading another manuscript must not silently change active assistant context')
  await ui.choose(document.id, title)
  assert.equal(await ui.article.innerText(), articleText)
  assert.ok((await ui.panel.innerText()).includes(memoryFields.question))
  await assertOriginals('Rapid manuscript switching')
  record('Current-manuscript dropdown switches and restores real reader/memory scope; active assistant paper is not silently rebound')

  await ui.button('编辑记忆').click()
  await ui.field('主要问题').waitFor()
  for (const [key, label] of [['question', '主要问题'], ['hypothesis', '假设'], ['contribution', '贡献'], ['scope', '适用范围'], ['terms', '术语']]) assert.equal(await ui.field(label).inputValue(), memoryFields[key])
  assert.equal(await ui.panel.locator('.paper-memory-fields textarea:visible').count(), 5)
  await ui.details(/^决定与问题/)
  assert.equal(await ui.field('决定 1').inputValue(), accepted)
  assert.equal(await ui.panel.getByRole('combobox', { name: '决定 2 状态', exact: true }).inputValue(), 'rejected')
  assert.equal(await ui.field('问题 1').inputValue(), issue)
  await ui.field('适用范围').fill(revisedScope)
  await ui.button('保存记忆').click()
  await ui.idle()
  await ui.panel.getByText('记忆已保存。', { exact: true }).waitFor()
  assert.equal(await ui.field('适用范围').isVisible(), true, 'Actual behavior: saving leaves the editor open')
  savedMemory = (await api('paperContext', 'get', projectId, document.id)).memory
  assert.equal(savedMemory.revision, 2)
  assert.equal(savedMemory.scope, revisedScope)
  assert.deepEqual(savedMemory.decisions.map(item => item.text), [accepted, rejected])
  assert.equal(savedMemory.issues[0].text, issue)
  await ui.summary()
  assert.ok((await ui.panel.innerText()).includes(revisedScope))
  await assertOriginals('Memory-only save')
  record('Edit memory reveals all five fields and ledger; save persists revision without changing DOCX; explicit return restores summary')

  await ui.details(/^来源与证据/)
  await ui.button('检查状态').click()
  await ui.idle()
  const sourceCard = ui.panel.locator('article.paper-source').filter({ hasText: reference.title })
  assert.equal(await sourceCard.count(), 1)
  await sourceCard.locator('summary').filter({ hasText: '定位与校验' }).click()
  assert.ok((await sourceCard.innerText()).includes(reference.id))
  await ui.panel.getByRole('combobox', { name: '来源类型', exact: true }).selectOption('reference')
  await ui.button('读取列表').click()
  await ui.idle()
  await ui.panel.getByRole('combobox', { name: '项目来源', exact: true }).selectOption(reference.id)
  assert.equal(await ui.button('关联来源').isEnabled(), true)
  await ui.details(/^章节写作$/)
  await ui.field('章节').fill('研究方法')
  await ui.field('写作任务').fill('检查来源快照与证据定位，保留演示范围。')
  await ui.button('预览上下文').click()
  await ui.idle()
  const evidence = ui.panel.locator('.paper-preview details.paper-source').filter({ hasText: reference.title }).first()
  await evidence.locator('summary').click()
  assert.ok((await evidence.locator('.paper-evidence').innerText()).includes('不是真实出版物'))
  assert.match(await evidence.locator('dd').nth(1).innerText(), /^[a-f0-9]{64}$/)
  assert.equal(await ui.button('准备章节写作').isEnabled(), true)
  await ui.details(/^更多与隐私$/)
  const exportPath = join(runDir, 'paper-memory-export.json')
  // Electron downloads are native session events; this Playwright Electron
  // transport does not surface the page-level download event consistently.
  await app.evaluate(({ session }, exportPath) => {
    globalThis.writingLayoutExport = { state: 'waiting' }
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(exportPath)
      globalThis.writingLayoutExport = { state: 'progressing', fileName: item.getFilename() }
      item.once('done', (_event, state) => { globalThis.writingLayoutExport = { state, fileName: item.getFilename(), savePath: item.getSavePath() } })
    })
  }, exportPath)
  await ui.button('导出 JSON').click()
  await until(async () => {
    const state = await app.evaluate(() => globalThis.writingLayoutExport)
    if (['cancelled', 'interrupted'].includes(state?.state)) throw new Error(`Native export ${state.state}`)
    return state?.state === 'completed' ? state : false
  }, 'Native Electron JSON export completes')
  const exported = JSON.parse(await readFile(exportPath, 'utf8'))
  assert.deepEqual(exported.memory, savedMemory)
  assert.ok(exported.sources.some(source => source.targetId === reference.id))
  report.exportPath = exportPath
  await assertOriginals('Source review and export')
  record('Sources/link picker, locator/hash review, chapter preview, prepare action and More/JSON export remain accessible without a model call')

  await ui.summary()
  for (const width of [1000, 600]) {
    await page.setViewportSize({ width, height: 1000 })
    await scrollTop()
    const measured = await layoutMetrics(width)
    metrics.push(measured)
    assert.equal(measured.visibleContextTextareas, 0)
    assert.deepEqual(measured.overflows, [], `${width}px must not overflow horizontally`)
    assert.ok(measured.rail.y >= measured.reader.bottom - 1, `${width}px memory rail must stack after reader`)
    assert.ok(Math.abs(measured.rail.x - measured.reader.x) < 2, `${width}px stacked reader and rail align`)
    assert.ok(measured.reader.right <= width + 1)
    await capture(`02-responsive-${width}.png`)
    await ui.panel.scrollIntoViewIfNeeded()
    await capture(`03-responsive-${width}-memory.png`)
    record(`${width}px layout stacks memory below reader with no horizontal overflow and no default context textareas`)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await scrollTop()
  await capture('04-desktop-saved-summary.png')
  await assertOriginals('Completed visual journey')
  assert.deepEqual(errors, [], 'No renderer errors')
  blockedRequests.push(...await app.evaluate(() => globalThis.writingLayoutBlockedRequests ?? []))
  assert.deepEqual(blockedRequests, [], 'No external HTTP/WebSocket calls')
  record('Complete local journey preserves exact original DOCX bytes and text, with no renderer errors or external requests')
  assert.deepEqual(assertionFailures, [], 'Independent reader assertions must all pass; failures were collected, not waived')
  report.ok = true
} catch (error) {
  report.failure = error instanceof Error ? error.stack : String(error)
  console.error(report.failure)
  if (page && !page.isClosed()) {
    await capture('failure.png').catch(() => {})
    report.failureUi = (await deadline(page.locator('body').innerText(), 'Capture failure UI', 10000).catch(() => '')).slice(0, 18000)
  }
  process.exitCode = 1
} finally {
  if (app) {
    try {
      const blocked = await app.evaluate(() => globalThis.writingLayoutBlockedRequests ?? [])
      for (const url of blocked) if (!blockedRequests.includes(url)) blockedRequests.push(url)
      await deadline(app.close(), 'Close Electron', 45000)
      report.appClosed = true
    } catch (error) { errors.push(`Electron cleanup: ${String(error)}`); report.ok = false; process.exitCode = 1 }
  }
  report.finishedAt = new Date().toISOString()
  await writeFile(reportPath, JSON.stringify(report, null, 2))
  console.log(`Report: ${reportPath}`)
  for (const path of screenshots) console.log(`Screenshot: ${path}`)
}
