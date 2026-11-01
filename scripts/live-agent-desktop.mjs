import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const key = process.env.RESEARCHPILOT_API_KEY?.trim()
if (!key) throw new Error('RESEARCHPILOT_API_KEY must be supplied in environment, never saved in code.')
const model = process.env.RESEARCHPILOT_MODEL || 'gpt-5.6-sol'
const baseUrl = process.env.RESEARCHPILOT_API_BASE || 'https://nova1api.duckdns.org/v1'
const results = join(root, 'test-results')
await mkdir(results, { recursive: true })
const runDir = await mkdtemp(join(results, 'live-agent-'))
const env = { ...process.env, RESEARCHPILOT_USER_DATA: join(runDir, 'profile'), RESEARCHPILOT_WORKSPACE_ROOT: join(runDir, 'workspace'), DSH_TELEMETRY_DISABLED: '1' }
delete env.RESEARCHPILOT_API_KEY
delete env.ELECTRON_RUN_AS_NODE
// Exercise the app's system-proxy resolution rather than hiding missing support in test environment.
for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'NODE_USE_ENV_PROXY', 'https_proxy', 'http_proxy']) delete env[name]
const redact = (text) => String(text).split(key).join('[REDACTED]').replace(/sk-[a-zA-Z0-9_-]{8,}/g, '[REDACTED]')
const report = { baseUrl, model, startedAt: new Date().toISOString(), checks: [], approvals: [], phases: [] }
let app, page, project, experiment
const record = (name, details) => { report.checks.push({ name, ...details }); console.log('PASS', name, details ? JSON.stringify(details) : '') }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function runPrompt(text, phase, allowed) {
  const chat = await page.evaluate(async ({ projectId, model }) => { const chat = await window.researchpilot.chat.create(projectId); return window.researchpilot.chat.setModel(chat.id, 'nova-live-test', model) }, { projectId: project.id, model })
  await page.evaluate(({ projectId, chatId, text }) => window.researchpilot.chat.send({ projectId, chatId, text }), { projectId: project.id, chatId: chat.id, text })
  const started = Date.now()
  let state
  while (Date.now() - started < 360_000) {
    const approvals = await page.evaluate(() => window.__liveApprovals.splice(0))
    for (const request of approvals) {
      const approved = Boolean(allowed?.(request))
      report.approvals.push({ phase, title: request.title, details: redact(request.details), approved })
      console.log('APPROVAL', approved ? 'ALLOW' : 'DENY', redact(request.title), redact(request.details).slice(0, 900))
      await page.evaluate(({ id, approved }) => window.researchpilot.approvals.respond({ id, approved, remember: false }), { id: request.id, approved })
    }
    state = await page.evaluate(() => window.researchpilot.chat.state())
    if (['idle', 'error', 'stopped'].includes(state.status)) break
    await sleep(1200)
  }
  if (!state || !['idle', 'error', 'stopped'].includes(state.status)) {
    await page.evaluate(() => window.researchpilot.chat.stop())
    throw new Error(`${phase}: bounded 6-minute deadline reached; stopped actual agent`)
  }
  const messages = await page.evaluate((id) => window.researchpilot.chat.messages(id), chat.id)
  const safeMessages = messages.map((message) => ({ role: message.role, kind: message.kind, content: redact(message.content), tool: message.tool ? { name: message.tool.name, status: message.tool.status, arguments: redact(message.tool.arguments), result: redact(message.tool.result) } : undefined }))
  await writeFile(join(runDir, `${phase}-messages.json`), JSON.stringify(safeMessages, null, 2))
  report.phases.push({ phase, status: state.status, durationMs: Date.now() - started, error: redact(state.lastError || ''), tools: messages.filter((m) => m.tool).map((m) => ({ name: m.tool.name, status: m.tool.status })), chatId: chat.id })
  console.log('PHASE', JSON.stringify(report.phases.at(-1)))
  if (state.status === 'error') throw new Error(`${phase}: ${redact(state.lastError)}`)
  return safeMessages
}
try {
  app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env, timeout: 60000 })
  page = await app.firstWindow()
  await page.waitForSelector('.research-home', { timeout: 60000 })
  await page.evaluate(() => { window.__liveApprovals = []; window.researchpilot.onEvent((event) => { if (event.type === 'approval-request') window.__liveApprovals.push(event.request) }) })
  const models = await page.evaluate(({ apiKey, baseUrl }) => window.researchpilot.providers.discoverModels({ apiKey, provider: { name: 'Nova gateway', kind: 'custom', protocol: 'openai-responses', baseUrl, models: [] } }), { apiKey: key, baseUrl })
  assert.ok(models.some((m) => m.id === model))
  await page.evaluate(({ apiKey, baseUrl, model }) => window.researchpilot.providers.upsert({ id: 'nova-live-test', name: 'Nova · 真实模型测试', kind: 'custom', protocol: 'openai-responses', baseUrl, apiKey, models: [{ id: model, label: model }], isDefault: true }), { apiKey: key, baseUrl, model })
  const connection = await page.evaluate(() => window.researchpilot.providers.test({ id: 'nova-live-test' }))
  if (!connection.ok) throw new Error(connection.message)
  record('Application provider performs a real authenticated inference using system proxy', { modelCount: models.length, message: connection.message })
  const pythonProbe = spawnSync('uv', ['python', 'find', '--no-python-downloads'], { encoding: 'utf8', windowsHide: true })
  assert.equal(pythonProbe.status, 0, 'An existing Python is required; this test does not download scientific packages')
  await page.evaluate((pythonPath) => window.researchpilot.settings.update({ pythonPath, maxOutputTokens: 12000, reasoningEffort: '', telemetry: false }), pythonProbe.stdout.trim())
  project = await page.evaluate(() => window.researchpilot.projects.create({ name: '真实模型：固定种子 Monte Carlo 验证', description: '隔离的合成 Monte Carlo 科研工具链验证，不含私人资料、不支持真实世界经验结论。' }))
  await page.evaluate((id) => window.researchpilot.projects.setActive(id), project.id)
  const mcpList = await page.evaluate((id) => window.researchpilot.mcp.list(id), project.id)
  report.mcp = mcpList
  const script = `import csv, json, math, os, random\nfrom pathlib import Path\nrng = random.Random(20261022)\nout = Path(os.environ['RESEARCHPILOT_RUN_DIR'])\nout.mkdir(parents=True, exist_ok=True)\nrows=[]\nfor seed in range(30):\n    draws=[rng.random() for _ in range(200)]\n    for method, values in [('uniform',draws), ('antithetic', [v for u in draws[:100] for v in (u, 1-u)])]:\n        estimate=sum(x*x for x in values)/len(values)\n        rows.append({'unit_id':str(seed),'group':method,'value':estimate,'abs_error':abs(estimate-1/3)})\nwith (out/'comparison.csv').open('w',newline='',encoding='utf-8') as f:\n    w=csv.DictWriter(f,fieldnames=['unit_id','group','value','abs_error']);w.writeheader();w.writerows(rows)\nsummary={m:sum(r['abs_error'] for r in rows if r['group']==m)/30 for m in ['uniform','antithetic']}\nmetrics={'seed':20261022,'replications':30,'samples_per_replication':200,'uniform_mae':summary['uniform'],'antithetic_mae':summary['antithetic']}\n(out/'metrics.json').write_text(json.dumps(metrics,indent=2),encoding='utf-8')\nprint('RESEARCHPILOT_METRIC:'+json.dumps(metrics))\n`
  experiment = await page.evaluate(({ projectId, code }) => window.researchpilot.experiments.create({ projectId, name: 'Monte Carlo integral paired smoke', description: 'Fixed-seed synthetic simulation, 30 replications, 200 draws per estimate.', code }), { projectId: project.id, code: script })
  const first = await runPrompt('这是授权的真实模型连通性验证。只回复 REAL_AGENT_READY，不使用工具、不读取文件。', '01-real-agent')
  assert.ok(first.some((m) => m.role === 'assistant' && m.content.includes('REAL_AGENT_READY')))
  record('Actual desktop agent streamed a real model response')
  const original = '综上所述，本研究具有重要意义。我们在 30 次配对重复中比较了两种 Monte Carlo 估计方法，每次使用 200 个样本。该结果仅适用于当前合成仿真设置，不代表实际应用中的普遍优势 [1]。'
  const revisionMessages = await runPrompt(`请规范润色以下测试段落：去掉空泛套话，结构更清晰；保留数字 30、200 和引用标记 [1]，保留合成仿真及外推限制，不增加新数据或来源，不作 AI 检测或查重通过承诺。引用标记 [1] 是测试占位符，应原样保留而不是声称已核验来源。只输出修改后的段落，不调用工具。原文：${original}`, '01b-real-writing')
  const revised = revisionMessages.filter((m) => m.role === 'assistant' && m.kind === 'text').map((m) => m.content).join('\n')
  assert.ok(revised && revised !== original)
  for (const marker of ['30', '200', '[1]']) assert.ok(revised.includes(marker), `Revision must preserve ${marker}`)
  assert.match(revised, /合成|仿真/)
  await writeFile(join(runDir, 'real-writing-comparison.md'), `# 真实模型修订示例\n\n这是合成测试文本，不代表真实查重报告。引用 [1] 仅为占位标记，未核实来源。\n\n## 原文\n${original}\n\n## 模型实际返回\n${revised}\n\n## 自动检查\n保留了 30、200、[1] 和仿真范围表述；不意味着任何平台检测通过。\n`)
  record('Real model revised a paragraph while preserving numeric and citation markers')

  for (const server of mcpList) {
    const test = await page.evaluate(({ serverId, projectId }) => window.researchpilot.mcp.test({ serverId, projectId }), { serverId: server.id, projectId: project.id })
    assert.equal(test.lastTestOk, true, test.lastError)
    await page.evaluate(({ serverId }) => window.researchpilot.mcp.configure({ serverId, enabled: true }), { serverId: server.id })
  }
  record('All three MCP servers completed real stdio initialize, list and tool invocation')
  const manuscript = await page.evaluate((projectId) => window.researchpilot.documents.create({ projectId, title: '真实模型写作诊断测试', format: 'docx', markdown: '# 写作诊断测试\n\n本文具有重要意义，并显著提升了性能。该表述仅用于诊断测试，没有真实数据支持，不能作为科研结论。' }), project.id)
  const check = await runPrompt(`只使用内置 ResearchPilot MCP 的只读工具列出当前项目的实验记录，并对文稿 ID ${manuscript.id} 运行写作质量诊断。不得调用 shell、网页、写文件或外部服务。最后简述工具返回，不编造测量结果。`, '02-mcp-tools')
  assert.ok(check.some((m) => m.tool?.name?.includes('mcp__') && m.tool.status !== 'failed'), 'Real model must actually call an MCP tool')
  record('Real model used actual bundled MCP tools')

  const allowedRun = (request) => /实验/.test(request.title || '') && (request.details || '').includes(experiment.id) && !/工具：pwsh|工具：bash/.test(request.title || '')
  await runPrompt(`请执行且仅执行已有实验 ${experiment.id}（${experiment.name}）。代码由测试方提供、仅使用 Python 标准库，是固定种子合成 Monte Carlo 仿真。请先使用 MCP 读取实验记录，然后只通过 MCP 工具 mcp__rp_artifacts__experiment_run（experimentId=${experiment.id}, timeoutSeconds=60）运行一次，等待真实运行完成，再通过 MCP 读取 run 产物 metrics.json，报告实际 run ID 和 MAE。不调用 shell，不修改代码、不安装依赖、不访问外网，不把模拟结果说成现实世界研究结论。执行会请求一次桌面批准。`, '03-experiment', allowedRun)
  const runs = await page.evaluate((id) => window.researchpilot.experiments.runs(id), experiment.id)
  const run = runs.find((r) => r.status === 'succeeded')
  assert.ok(run, 'Actual experiment must succeed; a model saying it ran is not sufficient')
  const csv = await readFile(join(project.rootPath, run.artifactDir, 'comparison.csv'), 'utf8')
  assert.equal(csv.trim().split(/\r?\n/).length, 61)
  report.experiment = { id: experiment.id, runId: run.id, status: run.status, metrics: run.metrics, csvSha256: createHash('sha256').update(csv).digest('hex') }
  record('Real model triggered a real local experiment and 60 measurement rows were produced', report.experiment)
  const spec = { version: 1, kind: 'chart', chartType: 'bar', title: 'Monte Carlo 仿真：平均绝对误差', provenance: { sourceLabel: `实际执行的合成仿真 ${run.id} ${run.artifactDir}/comparison.csv；不代表真实世界结论`, isDemo: false }, xLabel: '估计方法', yLabel: '平均绝对误差', labels: ['Uniform', 'Antithetic'], series: [{ name: '30 次独立重复的平均绝对误差', values: [Number(run.metrics.uniform_mae), Number(run.metrics.antithetic_mae)] }] }
  await writeFile(join(project.rootPath, 'figures', 'verified-input.json'), JSON.stringify(spec, null, 2))
  const allowFigure = (request) => /图表/.test(request.title || '') && request.details.includes('verified-input.json') && !/工具：pwsh|工具：bash/.test(request.title || '')
  await runPrompt(`请使用 MCP 工具 mcp__rp_artifacts__figure_create_from_spec 读取 figures/verified-input.json 并创建原生可编辑图表，参数 experimentId=${experiment.id}, name="Monte Carlo simulation", caption="固定种子合成 Monte Carlo，30 次重复，每次 200 个样本；只报告该仿真，不作实际应用结论。"。文件由实际 run ${run.id} 的结果生成，数据不可改动。只用 MCP，不调用 shell。随后用 figure_inspect 验证图表记录并报告实际 JSON/SVG/PPTX 路径，不要用图片冒充原生编辑对象。禁止其他写入和外部请求。`, '04-editable-figure', allowFigure)
  const figures = await page.evaluate((id) => window.researchpilot.figures.list(id), project.id)
  assert.ok(figures.some((f) => f.pptxPath && f.sourcePath))
  report.figures = figures.map((f) => ({ id: f.id, name: f.name, sourcePath: f.sourcePath, pptxPath: f.pptxPath }))
  record('Real agent created JSON, SVG and editable PPT from executed measurements')
  await page.reload(); await page.waitForSelector('.sidebar'); await page.locator('.sidebar a[href="#/figures"]').click()
  await page.getByText('Monte Carlo simulation', { exact: true }).first().waitFor()
  await page.screenshot({ path: join(runDir, 'live-result.png') })
  report.ok = true
} catch (error) {
  report.ok = false; report.error = redact(error.message); console.error('LIVE_ERROR', report.error)
  if (page) {
    await page.evaluate(() => window.researchpilot?.chat.stop()).catch(() => {})
    await page.screenshot({ path: join(runDir, 'failure.png') }).catch(() => {})
  }
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  if (project) report.project = { id: project.id, rootPath: project.rootPath }
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log('REPORT_DIR', runDir)
  await app?.close()
}
