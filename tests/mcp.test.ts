import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, linkSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Db } from '../src/main/lib/db'
import { ProjectService } from '../src/main/services/projects'
import { DocumentService } from '../src/main/services/documents'
import { ReferenceService } from '../src/main/services/references'
import { ExperimentService } from '../src/main/services/experiments'
import { FigureService } from '../src/main/services/figures'
import { EvidenceService } from '../src/main/services/evidence'
import { ApprovalService } from '../src/main/services/approvals'
import { BridgeService } from '../src/main/services/bridge'
import { McpService, mcpChildEnvironment } from '../src/main/services/mcp'
import { getBridgeEndpoint } from '../src/main/lib/bridge-state'
import { setEventWindowProvider } from '../src/main/lib/events'
import type { ApprovalRequest } from '../src/shared/types'
import { BUNDLED_MCP_SERVERS, type McpServerId } from '../src/shared/mcp'
import { buildDocx } from '../src/main/lib/docx-build'

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const serverPath = join(repo, 'resources/mcp/server.mjs')
const sentence = 'The controlled study measured improved performance across independent experimental samples and repeated trials. '

test('native fulltext tool reads linked PDF pages with locators and guideline fetch is approval gated', async () => {
  const f = await fixture()
  try {
    const { annotationFixturePdf } = await import('../scripts/pdf-fixture.mjs')
    const path = join(f.root, 'text-layer.pdf')
    writeFileSync(path, annotationFixturePdf())
    f.refs.attachPdf('p', f.ref.id, path)
    const evidence = await f.connect('evidence')
    const text = await call(evidence.client, 'reference_fulltext', { id: f.ref.id, startPage: 1, pageCount: 2, maxChars: 20000 })
    assert.equal(text.error, false)
    assert.equal(text.value.totalPages, 2)
    assert.equal(text.value.complete, true)
    assert.match(text.value.pages[0].text, /reproducible experiment/)
    assert.match(text.value.pages[0].locator, /pdf-page=1/)
    assert.equal((await call(evidence.client, 'reference_fulltext', { id: 'foreign' })).error, true)
    const requested = captureApproval()
    const pending = call(evidence.client, 'journal_guidelines_fetch', { url: 'https://journal.example/authors' })
    const approval = await requested
    f.approvals.respond({ id: approval.id, approved: false, remember: false })
    const denied = await pending
    assert.equal(denied.error, true)
    assert.match(denied.text, /拒绝/)
  } finally { await f.cleanup() }
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'research-mcp-'))
  const workspace = join(root, 'project')
  for (const dir of ['manuscripts', 'data', 'exports', 'figures/editable', 'experiments/exp/runs/run']) mkdirSync(join(workspace, dir), { recursive: true })
  const db = new Db(join(root, 'account.sqlite'))
  const stamp = new Date().toISOString()
  for (const [id, path] of [['p', workspace], ['other', join(root, 'other')]]) {
    mkdirSync(path, { recursive: true })
    db.run('INSERT INTO projects (id,name,description,root_path,created_at,updated_at) VALUES (?,?,?,?,?,?)', id, id, '', path, stamp, stamp)
  }
  const settings = { get: () => ({ workspaceRoot: root, pythonPath: process.execPath }) } as never
  const docs = new DocumentService(db, settings)
  const experiments = new ExperimentService(db)
  const refs = new ReferenceService(db)
  const figures = new FigureService(db, settings)
  const projects = new ProjectService(db, settings, docs, experiments)
  function document(id: string, text: string, projectId = 'p', path = `manuscripts/${id}.tex`, format = 'latex'): void {
    if (format === 'latex' && projectId === 'p') writeFileSync(join(workspace, path), text)
    db.run('INSERT INTO documents (id,project_id,title,format,file_name,relative_path,position,word_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, projectId, id, format, `${id}.tex`, path, 0, 25, stamp, stamp)
  }
  document('draft', `\\section{Results}\n${sentence.repeat(3)}Our method is always the best. TODO add evidence. Accuracy improved by 12.5%.`)
  document('source', `${sentence}Local source unique material.`)
  document('foreign', 'PRIVATE_OTHER_PROJECT', 'other')
  document('word', '', 'p', 'manuscripts/word.docx', 'docx')
  writeFileSync(join(workspace, 'manuscripts/word.docx'), await buildDocx({ title: 'Word fixture', markdown: '# Test\n\nA genuine Word manuscript with & characters and 42 samples.' }))
  document('large', 'x'.repeat(2 * 1024 * 1024 + 1))
  const ref = refs.upsert({ projectId: 'p', title: 'Controlled study', authors: 'A. Researcher', year: '2026', doi: '10.0000/test', abstract: 'A local abstract.', notes: 'Evidence location: section 3.' })
  refs.upsert({ projectId: 'other', title: 'PRIVATE_OTHER_PROJECT' })
  writeFileSync(join(workspace, 'experiments/exp/main.py'), 'print("fixture")\n')
  db.run('INSERT INTO experiments (id,project_id,name,entry_file,created_at,updated_at,last_run_id,status) VALUES (?,?,?,?,?,?,?,?)', 'exp', 'p', 'Example', 'experiments/exp/main.py', stamp, stamp, 'run', 'succeeded')
  db.run('INSERT INTO experiments (id,project_id,name,created_at,updated_at) VALUES (?,?,?,?,?)', 'foreign-exp', 'other', 'Other', stamp, stamp)
  for (const [id, experimentId, projectId] of [['run', 'exp', 'p'], ['foreign-run', 'foreign-exp', 'other']]) {
    db.run('INSERT INTO experiment_runs (id,experiment_id,project_id,status,exit_code,command,started_at,finished_at,stdout,stderr,metrics_json,artifact_dir,env_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, experimentId, projectId, 'succeeded', 0, 'SECRET_COMMAND_VALUE', stamp, stamp, 'SECRET_STDOUT_VALUE', '', JSON.stringify({ accuracy: 0.81, api_key: 'SECRET_METRIC_VALUE' }), 'experiments/exp/runs/run', JSON.stringify({ secret: 'SECRET_ENV_VALUE' }))
  }
  writeFileSync(join(workspace, 'experiments/exp/runs/run/manifest.json'), JSON.stringify({ runId: 'run', experimentId: 'exp', command: 'SECRET_COMMAND_VALUE', environment: 'python fixture', seeds: [42], startedAt: stamp, finishedAt: stamp }))
  writeFileSync(join(workspace, 'experiments/exp/runs/run/metrics.json'), JSON.stringify({ accuracy: 0.81 }))
  writeFileSync(join(workspace, 'data/evidence.txt'), 'Verified local evidence.\napi_key=SECRET_INLINE_VALUE\n')
  writeFileSync(join(workspace, 'data/secret.txt'), 'SECRET_FILE_VALUE')
  writeFileSync(join(root, 'outside.txt'), 'PRIVATE_OUTSIDE_VALUE')
  const source = { version: 1, kind: 'diagram', title: 'Test diagram', provenance: { sourceLabel: 'Test fixture only', isDemo: true }, nodes: [{ id: 'sample', label: 'Test fixture', shape: 'rect', x: 20, y: 20, width: 200, height: 70 }], edges: [] }
  writeFileSync(join(workspace, 'figures/editable/figure.json'), JSON.stringify(source))
  writeFileSync(join(workspace, 'figures/editable/figure.svg'), '<svg/>')
  const zip = new JSZip()
  zip.file('ppt/slides/slide1.xml', '<p:sld><p:sp/><p:sp/><p:cxnSp/></p:sld>')
  writeFileSync(join(workspace, 'figures/editable/figure.pptx'), await zip.generateAsync({ type: 'nodebuffer' }))
  db.run('INSERT INTO figures (id,project_id,name,file_path,format,created_at) VALUES (?,?,?,?,?,?)', 'fig', 'p', 'Test fixture', 'figures/editable/figure.svg', 'svg', stamp)
  db.run('INSERT INTO figures (id,project_id,name,file_path,format,created_at) VALUES (?,?,?,?,?,?)', 'raster', 'p', 'Raster fixture', 'figures/raster.png', 'png', stamp)
  let authorized = true
  const approvals = new ApprovalService()
  const bridge = new BridgeService(projects, docs, refs, experiments, {} as never, figures, {} as never, approvals, settings, new EvidenceService(db), () => authorized)
  await bridge.start()
  const mcp = new McpService(db, projects, bridge, { serverPath, executable: process.execPath })
  const clients: Array<{ client: Client; transport: StdioClientTransport }> = []
  async function connect(serverId: McpServerId, grantOverride: Record<string, string> = {}) {
    const grant = bridge.issueMcpGrant('p', serverId)
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath, '--server', serverId], cwd: repo, env: { ...mcpChildEnvironment(grant), ...grantOverride }, stderr: 'pipe' })
    let stderr = ''
    transport.stderr?.on('data', chunk => { stderr += String(chunk) })
    const client = new Client({ name: 'researchpilot-real-protocol-test', version: '1.0.0' }, { capabilities: {} })
    clients.push({ client, transport })
    await client.connect(transport, { timeout: 5000 })
    return { client, grant, stderr: () => stderr }
  }
  return { root, workspace, db, refs, ref, bridge, mcp, approvals, connect, document, authorize: (value: boolean) => { authorized = value }, cleanup: async () => {
    setEventWindowProvider(() => [])
    for (const { client, transport } of clients) { await client.close().catch(() => undefined); await transport.close().catch(() => undefined) }
    await mcp.close(); await bridge.stop(); db.close(); rmSync(root, { recursive: true, force: true })
  } }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, { timeout: 8000 })
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  return { error: result.isError === true, text, value: result.isError ? null : JSON.parse(text) }
}

test('real bundled stdio initializes, discovers the exact bounded tool catalog and executes read-only tools across all three groups against a real project bridge', async () => {
  const f = await fixture()
  try {
    const evidence = await f.connect('evidence')
    const writing = await f.connect('writing')
    const artifacts = await f.connect('artifacts')
    for (const [index, connection] of [evidence, writing, artifacts].entries()) {
      assert.match(connection.client.getServerVersion()!.name, /^researchpilot-/)
      const listed = await connection.client.listTools()
      assert.deepEqual(listed.tools.map(tool => tool.name), BUNDLED_MCP_SERVERS[index].tools.map(tool => tool.name))
      for (const tool of listed.tools) {
        const action = BUNDLED_MCP_SERVERS[index].tools.find(item => item.name === tool.name)!.approvalRequired === true
        assert.equal(tool.annotations?.readOnlyHint, !action)
        assert.equal(tool.annotations?.destructiveHint, action)
        assert.equal(tool.annotations?.openWorldHint, Boolean(BUNDLED_MCP_SERVERS[index].tools.find(item => item.name === tool.name)!.openWorld) || tool.name === 'experiment_run')
      }
    }
    const inventory = await call(evidence.client, 'workspace_inventory')
    assert.equal(inventory.value.counts.documents, 4)
    assert.equal(inventory.value.counts.references, 1)
    assert.doesNotMatch(inventory.text, /PRIVATE_OTHER_PROJECT/)
    assert.equal((await call(evidence.client, 'reference_search', { query: 'Controlled' })).value.total, 1)
    assert.equal((await call(evidence.client, 'reference_read', { id: f.ref.id })).value.abstract, 'A local abstract.')
    const excerpt = await call(evidence.client, 'evidence_read', { path: 'data/evidence.txt', maxChars: 500 })
    assert.match(excerpt.text, /Verified local evidence/)
    assert.doesNotMatch(excerpt.text, /SECRET_INLINE_VALUE/)
    assert.equal(excerpt.value.sha256, createHash('sha256').update(readFileSync(join(f.workspace, 'data/evidence.txt'))).digest('hex'))
    assert.equal((await call(writing.client, 'manuscript_list', { limit: 1 })).value.items.length, 1)
    assert.match((await call(writing.client, 'manuscript_read', { id: 'word' })).value.text, /genuine Word manuscript with & characters and 42 samples/)
    assert.equal((await call(writing.client, 'manuscript_read', { id: 'draft', offset: 5, maxChars: 8 })).value.text.length, 8)
    const audit = await call(writing.client, 'manuscript_audit', { id: 'draft' })
    assert.equal(audit.error, false)
    assert.ok(audit.value.analysis.findings.length > 0)
    const similar = await call(writing.client, 'local_similarity', { id: 'draft', sourceIds: ['source'] })
    assert.equal(similar.error, false)
    assert.ok(similar.value.comparison.sources[0].sharedWindows > 0)
    assert.doesNotMatch(similar.text, /Local source unique material/)
    const runs = await call(artifacts.client, 'experiment_runs')
    assert.equal(runs.value.items[0].metrics.accuracy, 0.81)
    assert.doesNotMatch(runs.text, /SECRET_|PRIVATE_OTHER_PROJECT/)
    const report = await call(artifacts.client, 'run_reproducibility', { runId: 'run' })
    assert.equal(report.error, false)
    assert.deepEqual(report.value.manifest.seeds, [42])
    assert.ok(report.value.files.find((item: { path: string }) => item.path.endsWith('metrics.json')).sha256.length === 64)
    assert.doesNotMatch(report.text, /SECRET_COMMAND_VALUE/)
    assert.equal((await call(artifacts.client, 'figure_list')).value.total, 2)
    const inspected = await call(artifacts.client, 'figure_inspect', { id: 'fig' })
    assert.equal(inspected.value.sourceValidated, true)
    assert.equal(inspected.value.pptxInspected, true)
    assert.equal(inspected.value.nativeShapes, 3)
    assert.equal(inspected.value.editableElementsFound, true)
    assert.equal((await call(artifacts.client, 'figure_inspect', { id: 'raster' })).value.editableElementsFound, false)
    assert.equal(evidence.stderr() + writing.stderr() + artifacts.stderr(), '')
  } finally { await f.cleanup() }
})

test('scoped MCP cannot escape project, call another group, run commands, fetch remote references, or read sensitive files', async () => {
  const f = await fixture()
  try {
    const evidence = await f.connect('evidence')
    const writing = await f.connect('writing')
    const artifacts = await f.connect('artifacts')
    const attempts: Array<[Client, string, Record<string, unknown>]> = [
      [evidence.client, 'refs.search', { query: 'send to internet' }], [evidence.client, 'ssh.exec', { command: 'whoami' }],
      [evidence.client, 'manuscript_read', { id: 'draft' }], [evidence.client, 'workspace_inventory', { projectId: 'other' }],
      [evidence.client, 'workspace_inventory', { limit: 999 }], [evidence.client, 'evidence_read', { path: '../outside.txt' }],
      [evidence.client, 'evidence_read', { path: '.research/bridge.json' }], [evidence.client, 'evidence_read', { path: 'data/secret.txt' }],
      [evidence.client, 'evidence_read', { path: 'data/../manuscripts/draft.tex' }], [evidence.client, 'evidence_read', { path: 'data/evidence.txt:stream' }],
      [writing.client, 'manuscript_read', { id: 'foreign' }], [writing.client, 'manuscript_read', { id: 'large' }],
      [writing.client, 'local_similarity', { id: 'draft', sourceIds: ['foreign'] }], [writing.client, 'local_similarity', { id: 'draft', sourceIds: ['draft'] }],
      [artifacts.client, 'experiment_runs', { experimentId: 'foreign-exp' }], [artifacts.client, 'run_reproducibility', { runId: 'foreign-run' }]
    ]
    for (const [client, tool, args] of attempts) assert.equal((await call(client, tool, args)).error, true, `${tool} ${JSON.stringify(args)}`)
    const scopedPost = (payload: unknown, url = evidence.grant.url) => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${evidence.grant.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    assert.equal((await scopedPost({ projectId: 'other', serverId: 'evidence', tool: 'workspace_inventory', params: {} })).status, 400)
    assert.equal((await scopedPost({ projectId: 'p', serverId: 'writing', tool: 'manuscript_read', params: { id: 'draft' } })).status, 400)
    assert.equal((await scopedPost({ projectId: 'p', method: 'ssh.exec', params: {} }, `${getBridgeEndpoint()!.url}/rpc`)).status, 401)
    f.bridge.revokeMcpGrant(evidence.grant.token)
    assert.equal((await call(evidence.client, 'workspace_inventory')).error, true)
    f.authorize(false)
    assert.equal((await call(writing.client, 'manuscript_list')).error, true)
  } finally { await f.cleanup() }
})

test('MCP rejects symlink/junction and hardlink evidence files even when lexically inside the project', async () => {
  const f = await fixture()
  try {
    const evidence = await f.connect('evidence')
    linkSync(join(f.root, 'outside.txt'), join(f.workspace, 'data/hardlink.txt'))
    assert.equal((await call(evidence.client, 'evidence_read', { path: 'data/hardlink.txt' })).error, true)
    mkdirSync(join(f.root, 'outside-directory')); writeFileSync(join(f.root, 'outside-directory/evidence.txt'), 'PRIVATE_OUTSIDE_VALUE')
    symlinkSync(join(f.root, 'outside-directory'), join(f.workspace, 'data/linked'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal((await call(evidence.client, 'evidence_read', { path: 'data/linked/evidence.txt' })).error, true)
  } finally { await f.cleanup() }
})

test('per-account config, truthful diagnostics, secret-free patch expressions and revocation are real', async () => {
  const f = await fixture()
  let secondDb: Db | undefined
  let second: McpService | undefined
  try {
    assert.ok(f.mcp.list('p').every(server => !server.enabled && server.status === 'disconnected' && server.lastTestOk === null))
    await f.mcp.configure({ serverId: 'writing', enabled: true })
    assert.match(f.mcp.signature(), /writing/)
    const config = f.mcp.harnessConfiguration('p')
    assert.equal(config.entries.length, 1)
    assert.doesNotMatch(JSON.stringify(config.entries), /"RESEARCHPILOT_MCP_TOKEN":"[a-f0-9]{64}"/)
    assert.ok(Object.values(config.env).some(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)))
    assert.match(JSON.stringify(config.entries), /__jsExpr/)
    const before = await f.mcp.test({ serverId: 'writing', projectId: 'p' })
    assert.equal(before.status, 'connected', before.lastError)
    assert.equal(before.lastTestOk, true)
    assert.equal(before.discoveredTools.length, BUNDLED_MCP_SERVERS.find(server => server.id === 'writing')!.tools.length)
    await f.mcp.disconnect({ serverId: 'writing', projectId: 'p' })
    assert.equal(f.mcp.list('p').find(server => server.id === 'writing')!.status, 'disconnected')
    await f.mcp.configure({ serverId: 'writing', enabled: false })
    assert.ok(f.mcp.list('p').every(server => !server.enabled))
    await assert.rejects(f.mcp.configure({ serverId: 'external' as McpServerId, enabled: true }), /仅支持/)
    await assert.rejects(f.mcp.configure({ serverId: 'writing', enabled: 'yes' as never }), /布尔/)
    secondDb = new Db(join(f.root, 'other-account.sqlite'))
    second = new McpService(secondDb, {} as never, f.bridge, { serverPath, executable: process.execPath })
    assert.ok(second.list().every(server => !server.enabled))
    const failed = new McpService(f.db, { get: () => ({}) } as never, f.bridge, { serverPath: join(f.root, 'missing.mjs'), executable: process.execPath })
    assert.equal((await failed.test({ serverId: 'evidence', projectId: 'p' })).status, 'error')
    await failed.close()
    await f.mcp.close()
    await assert.rejects(f.mcp.test({ serverId: 'writing', projectId: 'p' }), /关闭/)
  } finally { await second?.close(); secondDb?.close(); await f.cleanup() }
})

function captureApproval(): Promise<ApprovalRequest> {
  return new Promise(resolve => {
    setEventWindowProvider(() => [{ isDestroyed: () => false, webContents: { send: (_channel: string, event: { type: string; request: ApprovalRequest }) => { if (event.type === 'approval-request') resolve(event.request) } } }] as never)
  })
}

test('native MCP actions are denied without effects, reject changed source after approval, and create a real editable bundle only after approval', async () => {
  const f = await fixture()
  try {
    const { client } = await f.connect('artifacts')
    const count = () => f.db.scalar<number>('SELECT COUNT(*) FROM figures WHERE project_id = ?', 'p')
    const runCount = () => f.db.scalar<number>('SELECT COUNT(*) FROM experiment_runs WHERE project_id = ?', 'p')
    let requested = captureApproval()
    let pending = call(client, 'experiment_run', { experimentId: 'exp', timeoutSeconds: 30 })
    let approval = await requested
    assert.match(approval.details, /SHA-256/)
    assert.match(approval.description, /不是操作系统沙箱/)
    f.approvals.respond({ id: approval.id, approved: false, remember: true })
    assert.equal((await pending).error, true)
    assert.equal(runCount(), 1)

    requested = captureApproval()
    pending = call(client, 'experiment_run', { experimentId: 'exp', timeoutSeconds: 30 })
    approval = await requested
    writeFileSync(join(f.workspace, 'experiments/exp/main.py'), 'print("changed after approval requested")\n')
    f.approvals.respond({ id: approval.id, approved: true, remember: true })
    assert.match((await pending).text, /发生变化/)
    assert.equal(runCount(), 1)

    requested = captureApproval()
    pending = call(client, 'figure_create_from_spec', { path: 'figures/editable/figure.json', experimentId: 'exp' })
    approval = await requested
    f.approvals.respond({ id: approval.id, approved: false })
    assert.equal((await pending).error, true)
    assert.equal(count(), 2)

    const originalSpec = readFileSync(join(f.workspace, 'figures/editable/figure.json'), 'utf8')
    requested = captureApproval()
    pending = call(client, 'figure_create_from_spec', { path: 'figures/editable/figure.json', experimentId: 'exp' })
    approval = await requested
    writeFileSync(join(f.workspace, 'figures/editable/figure.json'), originalSpec.replace('Test diagram', 'Changed diagram'))
    f.approvals.respond({ id: approval.id, approved: true, remember: true })
    assert.match((await pending).text, /发生变化/)
    assert.equal(count(), 2)

    requested = captureApproval()
    pending = call(client, 'figure_create_from_spec', { path: 'figures/editable/figure.json', experimentId: 'exp', name: 'Approved native fixture' })
    approval = await requested
    f.approvals.respond({ id: approval.id, approved: true, remember: true })
    const created = await pending
    assert.equal(created.error, false, created.text)
    assert.equal(count(), 3)
    assert.ok(created.value.sourcePath.endsWith('figure.json'))
    assert.ok(created.value.pptxPath.endsWith('figure.pptx'))
    const inspected = await call(client, 'figure_inspect', { id: created.value.id })
    assert.equal(inspected.value.editableElementsFound, true)

    requested = captureApproval()
    pending = call(client, 'figure_create_from_spec', { path: 'figures/editable/figure.json', experimentId: 'exp', name: 'Approved native fixture' })
    approval = await requested // remember:true must never silently allow repeated native mutations.
    f.approvals.respond({ id: approval.id, approved: false })
    assert.equal((await pending).error, true)
    assert.equal(count(), 3)

    requested = captureApproval()
    pending = call(client, 'figure_create_from_spec', { path: 'figures/editable/figure.json', experimentId: 'exp' })
    approval = await requested
    f.authorize(false)
    f.approvals.respond({ id: approval.id, approved: true })
    assert.equal((await pending).error, true)
    assert.equal(count(), 3)
  } finally { await f.cleanup() }
})

test('cancelling an MCP native action cancels its pending approval without creating artifacts', async () => {
  const f = await fixture()
  try {
    const { client } = await f.connect('artifacts')
    const controller = new AbortController()
    const requested = captureApproval()
    const pending = client.callTool({ name: 'figure_create_from_spec', arguments: { path: 'figures/editable/figure.json', experimentId: 'exp' } }, { signal: controller.signal, timeout: 8000 })
    const approval = await requested
    controller.abort()
    await assert.rejects(pending)
    // Let the actual stdio cancellation notification reach the HTTP request before a late UI answer.
    await new Promise(resolve => setTimeout(resolve, 100))
    f.approvals.respond({ id: approval.id, approved: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(f.db.scalar<number>('SELECT COUNT(*) FROM figures WHERE project_id = ?', 'p'), 2)
    assert.equal(f.bridge.isBusy(), false)
  } finally { await f.cleanup() }
})

test('packaged-style resource runs standalone outside node_modules using Electron as Node', async () => {
  const f = await fixture()
  let client: Client | undefined
  let transport: StdioClientTransport | undefined
  try {
    const isolated = join(f.root, 'packaged-resources', 'mcp')
    mkdirSync(isolated, { recursive: true })
    const isolatedServer = join(isolated, 'server.mjs')
    copyFileSync(serverPath, isolatedServer)
    const electron = createRequire(import.meta.url)('electron') as string
    const grant = f.bridge.issueMcpGrant('p', 'evidence')
    transport = new StdioClientTransport({ command: electron, args: [isolatedServer, '--server', 'evidence'], cwd: isolated, env: mcpChildEnvironment(grant), stderr: 'pipe' })
    let stderr = ''
    transport.stderr?.on('data', value => { stderr += String(value) })
    client = new Client({ name: 'packaged-electron-fixture', version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport, { timeout: 8000 })
    assert.equal((await client.listTools()).tools.length, BUNDLED_MCP_SERVERS.find(server => server.id === 'evidence')!.tools.length)
    assert.equal((await call(client, 'workspace_inventory')).value.counts.documents, 4)
    assert.doesNotMatch(stderr, new RegExp(grant.token))
  } finally { await client?.close().catch(() => undefined); await transport?.close().catch(() => undefined); await f.cleanup() }
})

test('full-pipeline native writes require per-call consent, register real objects, and cannot alter run evidence or other projects', async () => {
  const f = await fixture()
  try {
    const artifacts = await f.connect('artifacts'), writing = await f.connect('writing'), evidence = await f.connect('evidence')
    async function decide(client: Client, tool: string, args: Record<string, unknown>, approved: boolean) {
      const requested = captureApproval()
      const pending = call(client, tool, args)
      const approval = await requested
      f.approvals.respond({ id: approval.id, approved, remember: true })
      return { approval, result: await pending }
    }
    const denied = await decide(artifacts.client, 'project_artifact_write', { path: 'exports/pipeline/test/literature.json', content: '{"version":1}' }, false)
    assert.equal(denied.result.error, true)
    assert.equal(existsSync(join(f.workspace, 'exports/pipeline')), false)
    assert.match(denied.approval.details, /SHA-256/)
    const saved = await decide(artifacts.client, 'project_artifact_write', { path: 'exports/pipeline/test/literature.json', content: '{"version":1,"note":"actual local artifact"}' }, true)
    assert.equal(saved.result.error, false, saved.result.text)
    assert.equal((await call(artifacts.client, 'artifact_read', { path: saved.result.value.path })).value.text, '{"version":1,"note":"actual local artifact"}')
    // Remember requested by the UI must not allow subsequent writes without a fresh approval.
    assert.equal((await decide(artifacts.client, 'project_artifact_write', { path: 'exports/pipeline/test/literature.json', content: '{"version":2}' }, false)).result.error, true)
    const before = f.db.scalar<number>('SELECT COUNT(*) FROM experiments')
    assert.equal((await decide(artifacts.client, 'experiment_create', { name: 'Denied', code: 'print(1)' }, false)).result.error, true)
    assert.equal(f.db.scalar<number>('SELECT COUNT(*) FROM experiments'), before)
    const created = await decide(artifacts.client, 'experiment_create', { name: 'Native source', description: 'No execution', code: 'print("agent source fixture")\n' }, true)
    assert.equal(created.result.error, false, created.result.text)
    assert.equal(created.result.value.executed, false)
    assert.equal((await call(artifacts.client, 'artifact_read', { path: created.result.value.entryFile })).value.text, 'print("agent source fixture")\n')
    assert.equal(f.db.scalar<number>('SELECT COUNT(*) FROM experiment_runs'), 2)
    assert.equal((await decide(writing.client, 'manuscript_write', { title: 'Native draft', markdown: '# Native draft\n\n' + sentence.repeat(10) }, false)).result.error, true)
    const doc = await decide(writing.client, 'manuscript_write', { title: 'Native draft', markdown: '# Native draft\n\n' + sentence.repeat(10) }, true)
    assert.equal(doc.result.error, false, doc.result.text)
    assert.ok(doc.result.value.wordCount > 100)
    assert.match((await call(writing.client, 'manuscript_read', { id: doc.result.value.id })).value.text, /controlled study/)
    assert.equal((await call(writing.client, 'manuscript_write', { id: 'foreign', markdown: 'must not write' })).error, true)
    for (const tool of ['literature_search', 'reference_add_doi']) {
      const args = tool === 'literature_search' ? { query: 'denied network query' } : { doi: '10.1234/denied' }
      assert.equal((await decide(evidence.client, tool, args, false)).result.error, true)
      assert.equal(f.refs.list('p').length, 1)
    }
    const spec = JSON.parse(readFileSync(join(f.workspace, 'figures/editable/figure.json'), 'utf8'))
    assert.equal((await call(artifacts.client, 'figure_create_spec', { spec, experimentId: 'foreign-exp' })).error, true)
    const figure = await decide(artifacts.client, 'figure_create_spec', { spec, experimentId: created.result.value.id, caption: 'Test-only provenance, not research.' }, true)
    assert.equal(figure.result.error, false, figure.result.text)
    assert.equal((await call(artifacts.client, 'figure_inspect', { id: figure.result.value.id })).value.editableElementsFound, true)
  } finally { await f.cleanup() }
})

test('native artifact paths, links, bounds and approval-time changes fail closed', async () => {
  const f = await fixture()
  try {
    const { client } = await f.connect('artifacts')
    for (const path of ['../outside.txt', 'exports/../outside.txt', '.research/bridge.json', 'exports/.config.json', 'exports/api-token.json', 'experiments/exp/main.py', 'experiments/exp/runs/run/metrics.json', 'figures/editable/figure.json', 'exports/test.py', 'exports/test.json:stream', 'exports/test.verification.json']) {
      assert.equal((await call(client, 'project_artifact_write', { path, content: '{}' })).error, true, path)
    }
    assert.equal((await call(client, 'project_artifact_write', { path: 'exports/oversize.txt', content: 'x'.repeat(80_001) })).error, true)
    assert.equal((await call(client, 'figure_create_spec', { spec: { title: 'x'.repeat(128_001) }, experimentId: 'exp' })).error, true)
    assert.equal((await call(client, 'artifact_read', { path: 'experiments/exp/runs/run/manifest.json' })).error, true)
    mkdirSync(join(f.root, 'outside-dir'))
    symlinkSync(join(f.root, 'outside-dir'), join(f.workspace, 'exports/linked'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal((await call(client, 'project_artifact_write', { path: 'exports/linked/written.json', content: '{}' })).error, true)
    assert.equal(existsSync(join(f.root, 'outside-dir/written.json')), false)
    linkSync(join(f.root, 'outside.txt'), join(f.workspace, 'exports/hardlinked.txt'))
    assert.equal((await call(client, 'project_artifact_write', { path: 'exports/hardlinked.txt', content: 'must not overwrite' })).error, true)
    writeFileSync(join(f.workspace, 'exports/change.txt'), 'original')
    const requested = captureApproval()
    const pending = call(client, 'project_artifact_write', { path: 'exports/change.txt', content: 'approved stale content' })
    const approval = await requested
    writeFileSync(join(f.workspace, 'exports/change.txt'), 'human change')
    f.approvals.respond({ id: approval.id, approved: true })
    assert.match((await pending).text, /发生变化/)
    assert.equal(readFileSync(join(f.workspace, 'exports/change.txt'), 'utf8'), 'human change')
    const revokedRequest = captureApproval()
    const revokedWrite = call(client, 'project_artifact_write', { path: 'exports/revoked.txt', content: 'must not write' })
    const revokedApproval = await revokedRequest
    f.authorize(false)
    f.approvals.respond({ id: revokedApproval.id, approved: true })
    assert.equal((await revokedWrite).error, true)
    assert.equal(existsSync(join(f.workspace, 'exports/revoked.txt')), false)
  } finally { await f.cleanup() }
})

test('agent plugin delegates only exact bundled native actions to bridge approval and still gates unknown tools', async () => {
  const previous = { url: process.env.RESEARCHPILOT_BRIDGE_URL, token: process.env.RESEARCHPILOT_BRIDGE_TOKEN, project: process.env.RESEARCHPILOT_PROJECT_ID }
  try {
    process.env.RESEARCHPILOT_BRIDGE_URL = 'http://127.0.0.1:1'
    process.env.RESEARCHPILOT_BRIDGE_TOKEN = 'test-only-not-used'
    process.env.RESEARCHPILOT_PROJECT_ID = 'p'
    const plugin = await import(pathToFileURL(join(repo, 'resources/agent-plugin/index.mjs')).href)
    const handlers = new Map<string, Function>()
    plugin.apply({ on: (name: string, handler: Function) => handlers.set(name, handler) })
    const gate = handlers.get('tools/pre-execute')!
    for (const server of BUNDLED_MCP_SERVERS) for (const tool of server.tools) {
      let nextCalled = false
      await gate({ name: `mcp__${server.namespace}__${tool.name}`, arguments: {} }, () => { nextCalled = true })
      assert.equal(nextCalled, true, `${server.namespace}/${tool.name} routes to its scoped native handler`)
    }
    for (const name of ['pwsh', 'write', 'mcp__rp_artifacts__arbitrary_write', 'mcp__foreign__experiment_create', 'mcp__rp_evidence__literature_search_extra', 'mcp__rp_evidence__reference_save_reading_draft_extra', 'mcp__foreign__reference_save_reading_draft']) {
      let nextCalled = false
      const result = await gate({ name, arguments: {} }, () => { nextCalled = true })
      assert.equal(nextCalled, false, name)
      assert.equal(result.kind, 'ask')
    }
  } finally {
    for (const [key, value] of [['RESEARCHPILOT_BRIDGE_URL', previous.url], ['RESEARCHPILOT_BRIDGE_TOKEN', previous.token], ['RESEARCHPILOT_PROJECT_ID', previous.project]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value
    }
  }
})

test('MCP process environment does not inherit provider secrets, proxy auth or Node code injection', () => {
  const env = mcpChildEnvironment({ url: 'http://127.0.0.1:1234/mcp', token: 'a'.repeat(64), projectId: 'p', serverId: 'writing' }, { PATH: 'os-path', OPENAI_API_KEY: 'do-not-inherit', NODE_OPTIONS: '--require attacker.js', HTTP_PROXY: 'http://user:password@host', DSH_HOME: 'other', RESEARCHPILOT_BRIDGE_TOKEN: 'general-token' })
  assert.equal(env.PATH, 'os-path')
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  assert.ok(!JSON.stringify(env).includes('do-not-inherit'))
  assert.ok(!JSON.stringify(env).includes('general-token'))
  for (const key of ['NODE_OPTIONS', 'HTTP_PROXY', 'DSH_HOME']) assert.equal(env[key], undefined)
})
