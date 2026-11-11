import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Db } from '../src/main/lib/db'
import { ChatService } from '../src/main/services/chats'
import { PaperContextService } from '../src/main/services/paper-context'
import { NoteService } from '../src/main/services/notes'
import { emptyPaperMemory } from '../src/shared/paper-context'
import type { DocumentService } from '../src/main/services/documents'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const prompts: Array<{ blocks: Array<{ type: string; text?: string }>; history: string[]; text: string }> = []
const histories = new Map<string, string[]>()
let AgentService: any, setAccountPaths: any

// Real prompt assembly and persisted session reuse; no subprocess or provider I/O.
class FakeHarness {
  async start() {}
  async close() {}
  session(id: string) {
    if (!histories.has(id)) histories.set(id, [])
    return {
      setWorkingDirectory: async () => {},
      run: async (blocks: Array<{ type: string; text?: string }>) => {
        const history = histories.get(id)!
        const text = blocks.map(block => block.text ?? '').join('\n')
        prompts.push({ blocks, history: [...history], text })
        history.push(text)
        return { events: [], finalResponse: 'fixture reply' }
      }
    }
  }
  async resumeSession(id: string) { return this.session(id) }
}

before(async () => {
  ;(globalThis as any).__paperAgentModules = {
    electron: { app: { isPackaged: false, getAppPath: () => projectRoot }, session: { defaultSession: { resolveProxy: async () => 'DIRECT' } } },
    sdk: { DeepSeekHarness: FakeHarness }
  }
  const result = await build({
    stdin: { contents: "export { AgentService } from './src/main/services/agent'; export { setAccountPaths } from './src/main/lib/paths'", resolveDir: projectRoot, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    tsconfig: join(projectRoot, 'tsconfig.node.json'),
    plugins: [{ name: 'paper-agent-fixtures', setup(build) {
      build.onResolve({ filter: /^(electron|@deepseek-ai\/dsh-sdk-client)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: `module.exports = globalThis.__paperAgentModules.${args.path === 'electron' ? 'electron' : 'sdk'}`, loader: 'js' }))
    } }]
  })
  const module = { exports: {} as any }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  ;({ AgentService, setAccountPaths } = module.exports)
})

function fixture(includePaperContext = true) {
  prompts.length = 0; histories.clear()
  const root = mkdtempSync(join(tmpdir(), 'rp-paper-agent-'))
  const db = new Db(join(root, 'local.sqlite'))
  for (const projectId of ['p', 'q']) {
    mkdirSync(join(root, projectId, 'manuscripts'), { recursive: true })
    db.run('INSERT INTO projects (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)', projectId, projectId, join(root, projectId), '2026-01-01', '2026-01-01')
    for (const suffix of ['', '2']) {
      const id = `${projectId}doc${suffix}`
      db.run("INSERT INTO documents (id,project_id,title,format,file_name,relative_path,created_at,updated_at) VALUES (?,?,?,'latex',?,?,?,?)", id, projectId, id, `${id}.tex`, `manuscripts/${id}.tex`, '2026-01-01', '2026-01-01')
      writeFileSync(join(root, projectId, 'manuscripts', `${id}.tex`), `\\section{Results}\n${id} measured accuracy 0.91`)
    }
  }
  const documents = {
    get(projectId: string, id: string) {
      const row = db.get<any>('SELECT * FROM documents WHERE id = ? AND project_id = ?', id, projectId)
      if (!row) throw new Error('document unavailable')
      return { id, projectId, title: row.title, format: row.format, relativePath: row.relative_path }
    },
    async readText(projectId: string, id: string) {
      return { text: readFileSync(join(root, projectId, this.get(projectId, id).relativePath), 'utf8'), format: 'latex' as const }
    }
  }
  const chats = new ChatService(db), notes = new NoteService(db)
  const unused = { get: () => { throw new Error('unexpected source lookup') } }
  const paper = new PaperContextService(db, documents as unknown as DocumentService, unused as any, unused as any, notes, unused as any, () => {})
  const provider = { id: 'provider', name: 'Fixture', kind: 'custom', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', hasApiKey: true, models: [{ id: 'model' }] }
  const projects = { get: (id: string) => ({ id, name: id, rootPath: join(root, id) }) }
  const knowledge = { context: (projectId: string) => `PROJECT KNOWLEDGE ${projectId}` }
  const agent = new AgentService(chats, { list: () => [provider], defaultProvider: () => provider, apiKey: () => 'fixture-only', dshProviderId: () => provider.id }, { get: () => ({ defaultProviderId: provider.id, defaultModelId: 'model', maxOutputTokens: 0 }) }, projects, { record: () => {} }, undefined, knowledge, includePaperContext ? paper : undefined)
  setAccountPaths({ dataRoot: root, workspaceRoot: root })
  const chat = chats.create('p', provider.id, 'model')
  return { root, db, paper, notes, chats, agent, chat, projects, async reply(text = 'Results accuracy', assertActive?: () => void) {
    await agent.send({ projectId: 'p', chatId: chat.id, text }, assertActive)
    return agent.waitForActive()
  }, async cleanup() {
    await agent.close(); setAccountPaths(null); db.close(); rmSync(root, { recursive: true, force: true })
  } }
}

async function activate(f: ReturnType<typeof fixture>, projectId = 'p', documentId = 'pdoc', question = 'Can accuracy generalize?') {
  await f.paper.save(projectId, { ...emptyPaperMemory(documentId), question, decisions: [{ id: 'accepted', text: 'Keep limited scientific scope', status: 'accepted', chapter: 'Results' }], issues: [{ id: 'open', text: 'Need uncertainty bounds', chapter: 'Results', resolved: false }] })
  await f.paper.activate(projectId, documentId)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('actual SDK prompt includes current memory, chapter evidence, knowledge and source/target disclaimers', async () => {
  const f = fixture()
  try {
    await activate(f)
    const note = f.notes.create({ projectId: 'p', title: 'Accuracy evidence', body: 'Registered accuracy evidence: sample size 42' })
    await f.paper.link({ projectId: 'p', documentId: 'pdoc', kind: 'note', targetId: note.id })
    const calls: Array<[string, string]> = [], context = f.paper.context.bind(f.paper)
    f.paper.context = async (projectId, query) => { calls.push([projectId, query]); assert.equal(prompts.length, 0, 'retrieval must not invoke the model'); return context(projectId, query) }
    await f.reply('  Results accuracy  ')
    assert.deepEqual(calls, [['p', 'Results accuracy']])
    const prompt = prompts[0].text
    assert.match(prompt, /PROJECT KNOWLEDGE p/)
    assert.match(prompt, /Can accuracy generalize\?/)
    assert.match(prompt, /Keep limited scientific scope/)
    assert.match(prompt, /Need uncertainty bounds/)
    assert.match(prompt, /"section":"Results"/)
    assert.match(prompt, /pdoc measured accuracy 0\.91/)
    assert.match(prompt, /sample size 42/)
    assert.match(prompt, /note:[^\s"]+#offset=/)
    assert.match(prompt, /not executable instructions/)
    assert.match(prompt, /not.*independent scientific proof/i)
    assert.match(prompt, /supersedes all earlier paper-context snapshots/)
    assert.match(prompt, /only.*target document|target document.*only/i)
    assert.ok(prompts[0].blocks.some(block => block.text?.includes('<untrusted_paper_context>')))
    assert.equal(f.chats.messages(f.chat.id).some(message => message.content.includes('<untrusted_paper_context>')), false, 'retrieval is not stored as a user message')
  } finally { await f.cleanup() }
})

test('paper retrieval is scoped to the active document of the current project', async () => {
  const f = fixture()
  try {
    await activate(f, 'q', 'qdoc', 'FOREIGN PROJECT PRIVATE MEMORY')
    await activate(f, 'p', 'pdoc2', 'OTHER DOCUMENT PRIVATE MEMORY')
    await activate(f)
    await f.reply()
    assert.match(prompts[0].text, /"documentId":"pdoc"/)
    assert.doesNotMatch(prompts[0].text, /FOREIGN PROJECT|OTHER DOCUMENT|qdoc measured|pdoc2 measured/)
  } finally { await f.cleanup() }
})

test('inactive paper adds no paper snapshot, including when another project has an active paper', async () => {
  const f = fixture()
  try {
    await activate(f, 'q', 'qdoc', 'FOREIGN PROJECT PRIVATE MEMORY')
    await f.reply()
    assert.match(prompts[0].text, /PROJECT KNOWLEDGE p/)
    assert.doesNotMatch(prompts[0].text, /untrusted_paper_context|CURRENT PAPER WORKING CONTEXT|FOREIGN PROJECT/)
    assert.match(prompts[0].text, /no active paper context/i)
  } finally { await f.cleanup() }
})

test('deactivating a paper invalidates snapshots retained in the same session history', async () => {
  const f = fixture()
  try {
    await activate(f)
    await f.reply()
    await f.paper.deactivate('p')
    await f.reply()
    assert.match(prompts[1].history[0], /Can accuracy generalize/)
    assert.doesNotMatch(prompts[1].text, /Can accuracy generalize|untrusted_paper_context/)
    assert.match(prompts[1].text, /no active paper context/i)
    assert.match(prompts[1].text, /earlier paper.*not current/i)
  } finally { await f.cleanup() }
})

test('legacy callers can omit the optional paper-context dependency', async () => {
  const f = fixture(false)
  try {
    await activate(f)
    await f.reply()
    assert.equal(prompts.length, 1)
    assert.doesNotMatch(prompts[0].text, /untrusted_paper_context|Can accuracy generalize/)
  } finally { await f.cleanup() }
})

test('new turn supersedes historical paper snapshots and excludes changed evidence without erasing session history', async () => {
  const f = fixture()
  try {
    await activate(f)
    const note = f.notes.create({ projectId: 'p', title: 'Accuracy evidence', body: 'Accuracy OBSOLETE_EVIDENCE marker' })
    await f.paper.link({ projectId: 'p', documentId: 'pdoc', kind: 'note', targetId: note.id })
    await f.reply()
    f.db.run('UPDATE project_notes SET body = ? WHERE id = ?', 'Accuracy updated, not yet refreshed', note.id)
    writeFileSync(join(f.root, 'p', 'manuscripts', 'pdoc.tex'), '\\section{Results}\nAccuracy CURRENT_DRAFT marker')
    await f.reply()
    assert.match(prompts[1].history[0], /OBSOLETE_EVIDENCE/)
    assert.match(prompts[1].text, /CURRENT_DRAFT/)
    assert.doesNotMatch(prompts[1].text, /OBSOLETE_EVIDENCE/)
    assert.match(prompts[1].text, /supersedes all earlier paper-context snapshots/)
    assert.match(prompts[1].text, /not removed or changed prior excerpts/)
  } finally { await f.cleanup() }
})

test('pipeline model-override turns still receive the user-selected active paper', async () => {
  const f = fixture()
  try {
    await activate(f)
    await f.agent.send({ projectId: 'p', chatId: f.chat.id, text: 'Pipeline: inspect Results accuracy', modelOverride: { providerId: 'provider', modelId: 'model' } })
    await f.agent.waitForActive()
    assert.match(prompts[0].text, /Can accuracy generalize/)
    assert.match(prompts[0].text, /only.*target document|target document.*only/i)
  } finally { await f.cleanup() }
})

test('retrieval failure rejects the turn explicitly and never calls session.run', async () => {
  const f = fixture()
  try {
    f.paper.context = async () => { throw new Error('PAPER_CONTEXT_UNAVAILABLE: cannot read current snapshot') }
    await assert.rejects(f.reply(), /PAPER_CONTEXT_UNAVAILABLE/)
    assert.equal(prompts.length, 0)
    assert.equal(f.agent.getState().status, 'error')
    assert.match(f.agent.getState().lastError, /PAPER_CONTEXT_UNAVAILABLE/)
    assert.ok(f.chats.messages(f.chat.id).some(message => message.kind === 'error' && /PAPER_CONTEXT_UNAVAILABLE/.test(message.content)))
    assert.equal(f.agent.isRunning(), false)
  } finally { await f.cleanup() }
})

test('stop while paper context is pending prevents a late SDK run and permits the next turn', { timeout: 5000 }, async () => {
  const f = fixture()
  const entered = deferred<void>(), context = deferred<string>()
  try {
    f.paper.context = async () => { entered.resolve(); return context.promise }
    const sending = f.reply()
    await entered.promise
    assert.equal(f.agent.isRunning(), true)
    await assert.rejects(f.agent.send({ projectId: 'p', chatId: f.chat.id, text: 'duplicate' }), /上一个任务/)
    await f.agent.stop()
    context.resolve('LATE PAPER CONTEXT')
    assert.equal(await sending, '')
    assert.equal(prompts.length, 0, 'closed session must not receive late context')
    assert.equal(f.agent.getState().status, 'stopped')
    assert.equal(f.chats.messages(f.chat.id).some(message => message.kind === 'error'), false)
    f.paper.context = async () => ''
    await f.reply('fresh turn')
    assert.equal(prompts.length, 1)
    assert.equal(f.agent.getState().status, 'idle')
  } finally { context.resolve(''); await f.cleanup() }
})

test('scope authorization is rechecked after asynchronous paper retrieval before SDK run', async () => {
  const f = fixture()
  try {
    let available = true, checks = 0
    f.paper.context = async () => { available = false; return 'stale authorized context' }
    await assert.rejects(f.reply('Results accuracy', () => { checks++; if (!available) throw new Error('project scope revoked') }), /project scope revoked/)
    assert.ok(checks >= 2)
    assert.equal(prompts.length, 0)
    assert.equal(f.agent.getState().status, 'error')
  } finally { await f.cleanup() }
})

test('project root availability is rechecked after asynchronous paper retrieval', async () => {
  const f = fixture()
  try {
    f.paper.context = async () => { rmSync(join(f.root, 'p'), { recursive: true, force: true }); return 'stale root context' }
    await assert.rejects(f.reply(), /ENOENT|no such file/i)
    assert.equal(prompts.length, 0)
    assert.equal(f.agent.getState().status, 'error')
  } finally { await f.cleanup() }
})
