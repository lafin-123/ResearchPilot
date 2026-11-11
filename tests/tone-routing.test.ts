import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { Db } from '../src/main/lib/db'
import { PipelineService, STAGE_ARTIFACTS } from '../src/main/services/pipeline'

const root = resolve(import.meta.dirname, '..')
const skill = readFileSync(resolve(root, 'resources/skills/paper-writing/SKILL.md'), 'utf8')
let persona: string

// Exercise the real persona without launching Electron or a model runtime.
before(async () => {
  const bundle = await build({
    entryPoints: [resolve(root, 'src/main/services/agent.ts')],
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    tsconfig: resolve(root, 'tsconfig.node.json'),
    plugins: [{ name: 'electron-stub', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }))
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'module.exports = {}', loader: 'js' }))
    } }]
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports)
  const { AgentService } = module.exports as {
    AgentService: new (...args: unknown[]) => { persona(project: { name: string; rootPath: string }): string }
  }
  const agent = new AgentService({}, {}, { get: () => ({ researchClarification: 'minimal' }) }, {}, {})
  persona = agent.persona({ name: 'Tone routing fixture', rootPath: root })
})

function assertToneRouting(text: string): void {
  assert.ok(text.includes('lieflat-less-ai-tone'), 'select the bundled tone skill explicitly')
  assert.ok(text.includes('lieflat-less-ai-tone/references/academic-adaptation.md'), 'load its academic adaptation explicitly')
}

function assertTonePolicy(text: string): void {
  const requirements: Array<[RegExp, string]> = [
    [/existing manuscripts[^\n]*diagnos[^\n]*propos[^\n]*user accepts[^\n]*before[^\n]*revis/i, 'diagnose/propose existing manuscripts and wait for acceptance before revision'],
    [/new drafts[^\n]*same writing task/i, 'limit automatic check/revise to new drafts within the same writing task'],
    [/preserve[^\n]*original[^\n]*traceable/i, 'preserve originals and traceable change records'],
    [/Python[^\n]*unavailable[^\n]*do not claim[^\n]*script/i, 'never claim script execution when Python is unavailable'],
    [/style statistics[^\n]*not[^\n]*AI probability/i, 'style statistics are not AI probability'],
    [/preserve[^\n]*data[^\n]*citations[^\n]*negation[^\n]*causal[^\n]*structure/i, 'preserve scientific meaning and structure']
  ]
  for (const [pattern, message] of requirements) assert.ok(pattern.test(text), message)
}

async function captureStagePrompt(stage: 'literature' | 'paper' | 'review'): Promise<string> {
  const db = new Db(':memory:')
  const timestamp = new Date().toISOString()
  const topic = 'Tone routing fixture'
  db.run('INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES(?,?,?,?,?)', 'project', topic, root, timestamp, timestamp)
  let prompt = ''
  const agent = {
    isRunning: () => false,
    validateSelection: (providerId: string, modelId: string) => ({ provider: { id: providerId }, modelId }),
    send: async (input: { text: string }) => {
      prompt = input.text
      // Stop before any model call, write or artifact verification.
      throw new Error('Prompt captured; no execution requested')
    }
  }
  const chats = { create: () => {
    db.run('INSERT INTO chats(id,project_id,title,dsh_session_id,provider_id,model_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', 'chat', 'project', topic, 'session', 'provider', 'model', timestamp, timestamp)
    return { id: 'chat' }
  } }
  const documents = { list: () => [
    { id: 'docx-fixture', title: `${topic} — Manuscript`, format: 'docx' },
    { id: 'latex-fixture', title: `${topic} — LaTeX`, format: 'latex' }
  ] }
  const pipeline = new PipelineService(db, agent as never, chats as never, documents as never,
    { get: () => ({ id: 'project', rootPath: root }) } as never,
    { writeBibtexFile: () => '' } as never,
    { get: () => ({ defaultProviderId: 'provider', defaultModelId: 'model' }) } as never)
  const settle = () => (pipeline as unknown as { activeLoop: Promise<void> }).activeLoop
  try {
    const run = pipeline.start({ projectId: 'project', topic, formats: ['docx', 'latex'], autoRun: false })
    await settle()
    if (stage !== 'literature') {
      db.run("UPDATE pipeline_steps SET status='completed' WHERE run_id=?", run.id)
      db.run("UPDATE pipeline_steps SET status='pending' WHERE run_id=? AND stage=?", run.id, stage)
      await pipeline.continue(run.id)
      await settle()
    }
    assert.ok(prompt.includes(`Execute the ${stage === 'paper' ? 'manuscript' : stage} stage`), 'capture the requested real pipeline prompt')
    return prompt
  } finally { db.close() }
}

test('default writing and polishing routing explicitly selects the tone skill and academic adaptation', () => {
  assertToneRouting(persona)
  assert.ok(/writing and polishing[^\n]*lieflat-less-ai-tone/i.test(persona), 'make tone review the default for writing and polishing')
})

test('default agent tone policy retains consent, provenance and scientific safeguards even in minimal mode', () => {
  assertTonePolicy(persona)
})

for (const stage of ['paper', 'review'] as const) {
  test(`${stage} pipeline prompt loads tone guidance with consent and scientific safeguards`, async () => {
    const prompt = await captureStagePrompt(stage)
    assertToneRouting(prompt)
    assertTonePolicy(prompt)
    assert.ok(prompt.includes('docx-fixture') && prompt.includes('latex-fixture'), 'retain both document routes')
    assert.ok(prompt.includes('project_artifact_write'), 'retain native traceability route')
    assert.ok(!prompt.includes('Then revise the manuscript'), 'do not retain an unconditional revision instruction')
  })
}

test('paper-writing skill makes academic tone review part of its native workflow', () => {
  assertToneRouting(skill)
  assertTonePolicy(skill)
  assert.ok(/tone[^\n]*takes precedence/i.test(skill), 'resolve legacy rewrite/script instructions in favor of the native tone policy')
})

test('tone routing is not injected into unrelated literature stage', async () => {
  const prompt = await captureStagePrompt('literature')
  assert.ok(!prompt.includes('lieflat-less-ai-tone'))
})

test('tone prompt integration does not introduce paper or review artifact gates', () => {
  assert.deepEqual(STAGE_ARTIFACTS.paper, ['exports/claims-evidence.md'])
  assert.deepEqual(STAGE_ARTIFACTS.review, ['exports/review-report.md', 'exports/citation-audit.json', 'exports/reproducibility.json'])
})
