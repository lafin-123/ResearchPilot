import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Db } from '../src/main/lib/db'
import { ChatService } from '../src/main/services/chats'
import { IPC } from '../src/shared/ipc'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const handlers = new Map<string, (...args: any[]) => Promise<any>>()
const logs = new Map<string, string[]>()
const launches: any[] = []
const prompts: any[] = []
const resumes: string[] = []
let failResume = false
let AgentService: any, registerIpc: any, setAccountPaths: any

// The fake subprocess retains canonical history independently of UI/SQLite messages.
// Its route is fixed by initialize, matching dsh-sdk-jsonrpc-server.createSession.
class ScriptedHarness {
  closed = false
  constructor(readonly options: any) { launches.push(this) }
  async start() {}
  async close() { this.closed = true }
  session(id: string) {
    assert.equal(logs.has(id), false, 'must not recreate an existing session')
    logs.set(id, [])
    return this.handle(id)
  }
  async resumeSession(id: string) {
    resumes.push(id)
    if (failResume || !logs.has(id)) throw new Error('persisted history unavailable')
    return this.handle(id)
  }
  handle(id: string) {
    return {
      setWorkingDirectory: async () => {},
      run: async (blocks: any[], options: any) => {
        assert.equal(this.closed, false)
        const history = logs.get(id)!
        const text = blocks.map(block => block.text ?? '').join('\n')
        prompts.push({ id, provider: this.options.provider, model: this.options.model, history: [...history], text })
        history.push(text, `reply-${prompts.length}`)
        options.onNotification({ method: 'session.event', params: { sessionId: id, event: {
          type: 'assistant/message', seq: history.length, time: Date.now(),
          data: { message: { content: [{ type: 'text', text: history.at(-1) }] } }
        } } })
        return { events: [], finalResponse: history.at(-1) }
      }
    }
  }
}

before(async () => {
  const electron = {
    app: { isPackaged: false, getAppPath: () => projectRoot },
    ipcMain: { removeHandler: (name: string) => handlers.delete(name), handle: (name: string, fn: any) => handlers.set(name, fn) },
    session: { defaultSession: { resolveProxy: async () => 'DIRECT' } }
  }
  ;(globalThis as any).__modelSwitchModules = { electron, sdk: { DeepSeekHarness: ScriptedHarness } }
  const result = await build({
    stdin: { contents: "export { AgentService } from './src/main/services/agent'; export { registerIpc } from './src/main/ipc'; export { setAccountPaths } from './src/main/lib/paths'", resolveDir: projectRoot, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    tsconfig: join(projectRoot, 'tsconfig.node.json'),
    plugins: [{ name: 'model-switch-fixtures', setup(build) {
      build.onResolve({ filter: /^(electron|@deepseek-ai\/dsh-sdk-client)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: `module.exports = globalThis.__modelSwitchModules.${args.path === 'electron' ? 'electron' : 'sdk'}`, loader: 'js' }))
    } }]
  })
  const module = { exports: {} as any }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  ;({ AgentService, registerIpc, setAccountPaths } = module.exports)
})

function fixture() {
  logs.clear(); launches.length = 0; prompts.length = 0; resumes.length = 0; failResume = false
  const root = mkdtempSync(join(tmpdir(), 'rp-model-switch-'))
  const db = new Db(join(root, 'local.sqlite'))
  db.run('INSERT INTO projects (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)', 'p', 'Project', root, '2026-01-01', '2026-01-01')
  const chats = new ChatService(db)
  const providers = [
    { id: 'a', name: 'A', kind: 'custom', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', hasApiKey: true, models: [{ id: 'a1' }, { id: 'a2' }] },
    { id: 'b', name: 'B', kind: 'custom', protocol: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1/v1', hasApiKey: true, models: [{ id: 'b1' }] }
  ]
  const config = { defaultProviderId: 'a', defaultModelId: 'a1', maxOutputTokens: 0 }
  const providerService = { list: () => providers, defaultProvider: () => providers[0], apiKey: () => 'fixture-only', dshProviderId: (p: any) => p.id }
  const settings = { get: () => config }
  const project = { id: 'p', name: 'Project', rootPath: root }
  const agent = new AgentService(chats, providerService, settings, { get: () => project }, { record: () => {} })
  const services: any = { chats, agent, providers: providerService, settings, pipeline: { isRunning: () => false } }
  setAccountPaths({ dataRoot: root, workspaceRoot: root })
  registerIpc(services, { authorize: () => () => {} }, () => true)
  const invoke = (channel: string, input?: any) => handlers.get(channel)!({}, input)
  return { chats, agent, services, providers, config, invoke, async cleanup() {
    await this.agent.close(); setAccountPaths(null); db.close(); rmSync(root, { recursive: true, force: true })
  } }
}

async function reply(f: ReturnType<typeof fixture>, chatId: string, text: string) {
  await f.agent.send({ projectId: 'p', chatId, text })
  return f.agent.waitForActive()
}

test('same chat switches model and provider, retains persisted context and resumes after service restart', async () => {
  const f = fixture()
  try {
    const original = await f.invoke(IPC.chatCreate, 'p')
    await reply(f, original.id, 'Remember marker 314159')
    const firstMessages = f.chats.messages(original.id)
    assert.equal(firstMessages.length, 2)
    for (const [providerId, modelId] of [['a', 'a2'], ['b', 'b1'], ['a', 'a1']]) {
      const before = f.chats.messages(original.id)
      const beforeChat = f.chats.get(original.id)
      const changed = await f.invoke(IPC.chatSetModel, { chatId: original.id, providerId, modelId })
      assert.equal(changed.id, original.id)
      assert.equal(changed.dshSessionId, original.dshSessionId)
      assert.equal(changed.title, beforeChat.title)
      assert.equal(changed.createdAt, beforeChat.createdAt)
      assert.equal(f.chats.isSessionStarted(original.id), true)
      assert.deepEqual(f.chats.messages(original.id), before)
      await reply(f, original.id, `Continue with ${modelId}`)
      assert.equal(prompts.at(-1).provider, providerId)
      assert.equal(prompts.at(-1).model, modelId)
      assert.match(prompts.at(-1).history[0], /marker 314159/)
      assert.equal(f.agent.getState().modelId, modelId)
    }
    assert.equal(launches.length, 4)
    assert.ok(launches.slice(0, -1).every(harness => harness.closed))
    assert.deepEqual(resumes, Array(3).fill(original.dshSessionId))
    assert.deepEqual(f.chats.messages(original.id).slice(0, 2), firstMessages)
    await f.agent.close()
    const restarted = new AgentService(f.chats, { list: () => f.providers, apiKey: () => 'fixture', dshProviderId: (p: any) => p.id }, { get: () => f.config }, { get: () => ({ id: 'p', name: 'Project', rootPath: launches[0].options.cwd }) }, { record: () => {} })
    f.agent = restarted
    await reply(f, original.id, 'Continue after restart')
    assert.match(prompts.at(-1).history[0], /marker 314159/)
    assert.equal(prompts.at(-1).history.length, 8)
    assert.equal(f.chats.list('p').length, 1)
  } finally { await f.cleanup() }
})

test('unchanged model reuses the live runtime and cached session', async () => {
  const f = fixture()
  try {
    const chat = f.chats.create('p', 'a', 'a1')
    await reply(f, chat.id, 'first turn')
    await reply(f, chat.id, 'second turn')
    assert.equal(launches.length, 1)
    assert.deepEqual(resumes, [])
    assert.match(prompts[1].history[0], /first turn/)
    assert.equal(f.chats.messages(chat.id).length, 4)
  } finally { await f.cleanup() }
})

test('IPC rejects invalid or unconfigured model routes without mutating session or messages', async () => {
  const f = fixture()
  try {
    const chat = f.chats.create('p', 'a', 'a1')
    f.chats.addMessage({ chatId: chat.id, projectId: 'p', role: 'user', kind: 'text', content: 'keep me' })
    const snapshot = f.chats.get(chat.id), messages = f.chats.messages(chat.id)
    for (const [providerId, modelId] of [['missing', 'a1'], ['a', 'b1'], ['a', '']]) {
      await assert.rejects(f.invoke(IPC.chatSetModel, { chatId: chat.id, providerId, modelId }), /提供方|模型/)
      assert.deepEqual(f.chats.get(chat.id), snapshot)
      assert.deepEqual(f.chats.messages(chat.id), messages)
    }
    f.providers[1].hasApiKey = false
    await assert.rejects(f.invoke(IPC.chatSetModel, { chatId: chat.id, providerId: 'b', modelId: 'b1' }), /API Key/)
    assert.deepEqual(f.chats.get(chat.id), snapshot)
    // A stale saved route must also fail at send time instead of silently using a default.
    f.chats.setModel(chat.id, 'a', 'deleted-model')
    await assert.rejects(f.agent.send({ projectId: 'p', chatId: chat.id, text: 'stale selection' }), /模型/)
    assert.deepEqual(f.chats.messages(chat.id), messages)
    assert.equal(launches.length, 0)
  } finally { await f.cleanup() }
})

test('model switches are blocked during pending send preparation, active turns and pipeline runs', async () => {
  const f = fixture()
  try {
    const chat = f.chats.create('p', 'a', 'a1')
    const selection = { chatId: chat.id, providerId: 'a', modelId: 'a2' }
    const sending = f.agent.send({ projectId: 'p', chatId: chat.id, text: 'pending preparation' })
    assert.equal(f.agent.isRunning(), true, 'pending send must reserve the agent before its first await')
    const blocked = f.invoke(IPC.chatSetModel, selection)
    const duplicate = f.agent.send({ projectId: 'p', chatId: chat.id, text: 'duplicate send' })
    await assert.rejects(blocked, /运行|完成|停止/)
    await assert.rejects(duplicate, /上一个任务/)
    await sending
    await f.agent.waitForActive()
    f.agent.active = { chatId: chat.id, promise: Promise.resolve('') }
    await assert.rejects(f.invoke(IPC.chatSetModel, selection), /运行|完成|停止/)
    f.agent.active = undefined
    f.services.pipeline.isRunning = () => true
    await assert.rejects(f.invoke(IPC.chatSetModel, selection), /运行|完成|停止/)
    f.services.pipeline.isRunning = () => false
    f.services.research = { isRunning: () => true }
    await assert.rejects(f.invoke(IPC.chatSetModel, selection), /运行|完成|停止/)
    f.services.research.isRunning = () => false
    f.services.methods = { isRunning: () => true }
    await assert.rejects(f.invoke(IPC.chatSetModel, selection), /运行|完成|停止/)
    assert.equal(f.chats.get(chat.id).modelId, 'a1')
  } finally { await f.cleanup() }
})

test('absent default is explicit for multi-model providers, but a sole model remains unambiguous', async () => {
  const f = fixture()
  try {
    f.config.defaultModelId = ''
    await assert.rejects(f.agent.send({ projectId: 'p', text: 'must choose' }), /模型/)
    assert.equal(f.agent.isRunning(), false)
    assert.equal(f.chats.list('p').length, 0)
    const blank = await f.invoke(IPC.chatCreate, 'p')
    assert.equal(blank.modelId, '', 'chat creation must not silently pin the first of multiple models')
    f.config.defaultProviderId = 'b'
    const single = await f.invoke(IPC.chatCreate, 'p')
    assert.equal(single.providerId, 'b')
    assert.equal(single.modelId, 'b1')
  } finally { await f.cleanup() }
})

test('failed resume never creates a replacement session or resets existing history', async () => {
  const f = fixture()
  try {
    const chat = f.chats.create('p', 'a', 'a1')
    await reply(f, chat.id, 'retained history')
    const before = f.chats.messages(chat.id)
    await f.invoke(IPC.chatSetModel, { chatId: chat.id, providerId: 'a', modelId: 'a2' })
    failResume = true
    await assert.rejects(reply(f, chat.id, 'resume failure'), /无法恢复历史会话/)
    assert.deepEqual(f.chats.messages(chat.id).slice(0, 2), before)
    assert.equal(f.chats.get(chat.id).dshSessionId, chat.dshSessionId)
    assert.equal(logs.size, 1)
    assert.equal(prompts.length, 1)
  } finally { await f.cleanup() }
})

test('installed SDK resume forwards initialized route rather than the stored route', async () => {
  // Exercise the installed JSON-RPC server, not the application fake, without any provider I/O.
  const { HarnessSdkJsonRpcServer } = await import('@deepseek-ai/dsh-sdk-jsonrpc-server')
  const calls: any[] = []
  const ctx: any = {
    on: () => () => {},
    get: () => ({ listProviders: () => [{ id: 'selected-provider' }], resolveCallConfig: async () => {} }),
    agents: { resume: async (options: any) => { calls.push(options); return { agent: {} } } }
  }
  const server = new HarnessSdkJsonRpcServer(ctx, { notify: () => {} } as any)
  await server.initialize({ cwd: projectRoot, provider: 'selected-provider', model: 'selected-model' })
  await server.resume({ sessionId: 'original-persisted-session' })
  assert.deepEqual(calls, [{ resumeSessionId: 'original-persisted-session', agentOptions: { provider: 'selected-provider', model: 'selected-model' } }])
})
