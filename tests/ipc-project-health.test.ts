import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { IPC } from '../src/shared/ipc'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let SettingsService: any, SshService: any, SkillService: any, AgentService: any, ExperimentRunner: any, setAccountPaths: any

const handlers = new Map<string, (...args: any[]) => Promise<any>>()
let registerIpc: typeof import('../src/main/ipc').registerIpc
let unavailable = false
let writes: string[] = []
let dialogHook = () => {}
const health = () => ({ projectId: 'p', projectName: 'Project', rootPath: 'C:/project', available: !unavailable, checkedAt: '', error: unavailable ? { code: 'ENOENT', message: 'missing root' } : null })
const assertAvailable = () => { if (unavailable) throw new Error('ENOENT: missing root') }
const operation = (name: string) => (..._args: any[]) => { writes.push(name); return {} }
const services = {
  projectHealth: { list: () => [health()], assertAvailable, retry: () => { writes.push('retry'); return health() } },
  projects: { get: () => ({ id: 'p', rootPath: 'C:/project' }), list: () => [], overview: () => ({}) },
  documents: { list: () => [], create: async (_input: unknown, guard?: () => void) => { await Promise.resolve(); guard?.(); writes.push('document'); return {} }, importFile: operation('import') },
  notes: { list: () => ({ items: [], total: 0 }), create: operation('note') },
  references: { list: () => [] },
  experiments: { get: () => ({ projectId: 'p' }), create: operation('experiment'), saveCode: operation('code') },
  runner: { start: operation('run'), runningCount: () => 0 },
  figures: { list: () => [], createStructured: operation('figure') },
  chats: { list: () => [] }, agent: { send: operation('send'), isRunning: () => false },
  pipeline: { start: operation('pipeline'), continue: operation('continue'), projectIdForRun: () => 'p', isRunning: () => false },
  evidence: { generate: operation('evidence') }, skills: { create: operation('skill') },
  bridge: { syncProject: operation('sync'), isBusy: () => false },
  backups: { restoreCopy: () => ({ projectId: 'p', warnings: [] as string[] }) },
  settings: { get: () => ({ pythonPath: '' }) }, mcp: { list: () => [] }
}
const electron = {
  ipcMain: { removeHandler: (name: string) => handlers.delete(name), handle: (name: string, fn: any) => handlers.set(name, fn) },
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  dialog: { showOpenDialog: async () => { dialogHook(); return { canceled: false, filePaths: ['fixture.docx'] } } }
}
before(async () => {
  ;(globalThis as any).__ipcTestElectron = electron
  const result = await build({ stdin: { contents: "export { SettingsService } from './src/main/services/settings'; export { SshService } from './src/main/services/ssh'; export { registerIpc } from './src/main/ipc'; export { SkillService } from './src/main/services/skills'; export { AgentService } from './src/main/services/agent'; export { ExperimentRunner } from './src/main/services/experiment-runner'; export { setAccountPaths } from './src/main/lib/paths'", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, tsconfig: resolve('tsconfig.node.json'), plugins: [{ name: 'electron-test', setup(build) { build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' })); build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'module.exports = globalThis.__ipcTestElectron', loader: 'js' })) } }] })
  const module = { exports: {} as any }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  ;({ registerIpc, SkillService, AgentService, ExperimentRunner, SshService, SettingsService, setAccountPaths } = module.exports)
})
function setup() {
  unavailable = false; writes = []; dialogHook = () => {}
  registerIpc(services as never, { authorize: () => () => {} } as never, () => true)
}
async function invoke(channel: string, input?: unknown) {
  const handler = handlers.get(channel)
  assert.ok(handler, `missing IPC handler: ${channel}`)
  return handler({}, input)
}

test('clarification settings normalize old/invalid values and agent persona plus every prompt carry current mode', async () => {
  setAccountPaths({ dataRoot: 'test-profile', workspaceRoot: 'test-workspace' })
  try {
    let saved = '{}'
    const settings = new SettingsService({ get: () => ({ value_json: saved }), run: (_sql: string, _key: string, value: string) => { saved = value } })
    assert.equal(settings.get().researchClarification, 'balanced')
    assert.equal(settings.update({ researchClarification: 'minimal' }).researchClarification, 'minimal')
    saved = '{"researchClarification":"unknown"}'
    assert.equal(settings.get().researchClarification, 'balanced')
    const agent = new AgentService({}, {}, settings, {}, {})
    settings.update({ researchClarification: 'guided' })
    assert.match(agent.persona({ name: 'p', rootPath: 'root' }), /先问清楚/)
    const blocks = await agent.promptBlocks('test', [])
    assert.ok(blocks.some((block: any) => block.type === 'text' && block.text.includes('先问清楚')))
    assert.ok(blocks.some((block: any) => block.type === 'text' && block.text.includes('审批')))
  } finally { setAccountPaths(null) }
})

test('IPC rejects unavailable project file writes and execution while database-only reading and notes stay usable', async () => {
  setup(); unavailable = true
  for (const [channel, input] of [
    [IPC.documentCreate, { projectId: 'p' }], [IPC.experimentCreate, { projectId: 'p' }],
    [IPC.experimentSaveCode, { id: 'exp', code: 'print(1)' }], [IPC.experimentRun, 'exp'],
    [IPC.figureCreateStructured, { projectId: 'p' }], [IPC.chatSend, { projectId: 'p' }],
    [IPC.pipelineStart, { projectId: 'p' }], [IPC.pipelineRunStage, 'run'], [IPC.evidenceGenerate, 'p'],
    [IPC.skillCreate, { projectId: 'p', scope: 'project' }], [IPC.skillCopyBuiltin, { projectId: 'p', targetScope: 'project' }], [IPC.skillImportContent, { projectId: 'p', targetScope: 'project' }]
  ] as const) await assert.rejects(invoke(channel, input), /ENOENT/)
  assert.deepEqual(writes, [])
  assert.deepEqual(await invoke(IPC.documentList, 'p'), [])
  assert.deepEqual(await invoke(IPC.referenceList, { projectId: 'p' }), [])
  await invoke(IPC.noteCreate, { projectId: 'p', title: 'Local note', body: '' })
  assert.deepEqual(writes, ['note'])
})

test('IPC checks again after file dialogs and during delayed document creation', async () => {
  setup(); dialogHook = () => { unavailable = true }
  await assert.rejects(invoke(IPC.documentImport, 'p'), /ENOENT/)
  assert.deepEqual(writes, [])
  setup()
  const pending = invoke(IPC.documentCreate, { projectId: 'p' })
  unavailable = true
  await assert.rejects(pending, /ENOENT/)
  assert.deepEqual(writes, [])
})

test('health diagnostics are read only and explicit retry syncs only an available project', async () => {
  setup(); unavailable = true
  const list = await invoke('project:health')
  assert.equal(list[0].available, false)
  assert.deepEqual(writes, [])
  assert.equal((await invoke('project:retry', 'p')).available, false)
  assert.deepEqual(writes, ['retry'])
  unavailable = false
  assert.equal((await invoke('project:retry', 'p')).available, true)
  assert.deepEqual(writes, ['retry', 'retry', 'sync'])
})

test('a restored copy remains visible with a warning when initialization fails', async () => {
  setup(); unavailable = true
  const result = await invoke(IPC.backupRestoreCopy, 'preview-token')
  assert.equal(result.projectId, 'p')
  assert.ok(result.warnings.some((text: string) => text.includes('ENOENT')))
  assert.deepEqual(writes, ['retry'])
})

test('skill listing never creates missing project directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'rp-skills-health-'))
  const missing = join(root, 'missing')
  try {
    setAccountPaths({ dataRoot: join(root, 'profile'), workspaceRoot: root })
    const skills = new SkillService({ get: () => ({ root_path: missing }) })
    skills.list('p')
    assert.equal(existsSync(missing), false)
  } finally { setAccountPaths(null); rmSync(root, { recursive: true, force: true }) }
})

test('agent checks availability again after asynchronous chat resolution before storing attachments', async () => {
  setup()
  const agent = new AgentService({}, {}, {}, { get: () => ({ id: 'p', rootPath: 'unused' }) }, {})
  agent.resolveChatConfig = async () => { unavailable = true; return { chat: {}, provider: {}, modelId: '' } }
  const pending = agent.send({ projectId: 'p', text: 'test' }, assertAvailable)
  await assert.rejects(pending, /ENOENT/)
})

test('remote download rechecks after connect and directory reads before local mkdir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rp-download-health-'))
  try {
    for (const boundary of ['connect', 'readdir']) {
      let available = true, closed = false, reads = 0
      const local = join(root, boundary)
      const ssh = new SshService({})
      ssh.connect = async () => {
        if (boundary === 'connect') available = false
        return { sftp: { readdir: (_path: string, done: any) => { available = false; done(null, reads++ ? [] : [{ filename: 'nested', attrs: { size: 0 }, longname: 'drwx' }]) } } }
      }
      ssh.close = () => { closed = true }
      await assert.rejects(ssh.downloadDirectory('host', '/remote', local, () => { if (!available) throw new Error('ENOENT: missing root') }), /ENOENT/)
      assert.equal(existsSync(boundary === 'connect' ? local : join(local, 'nested')), false)
      assert.equal(closed, true)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('run artifact completion never recreates a project root removed during execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'rp-run-health-'))
  const projectRoot = join(root, 'project')
  mkdirSync(projectRoot)
  const runner = new ExperimentRunner({ get: () => ({ root_path: projectRoot }) }, {}, { get: () => ({ projectId: 'p' }), getRun: () => ({ command: 'fixture' }) }, {})
  renameSync(projectRoot, join(root, 'moved'))
  try {
    runner.writeArtifacts(join(projectRoot, 'experiments', 'run'), 'exp', 'run', '', '', {}, { status: 'succeeded', exitCode: 0, environment: 'local', startedAt: '' })
    assert.equal(existsSync(projectRoot), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('restored projects are prepared and bridge-synced before reporting the restore result', async () => {
  setup()
  const result = await invoke(IPC.backupRestoreCopy, 'preview-token')
  assert.equal(result.projectId, 'p')
  assert.deepEqual(writes, ['retry', 'sync'])
})
