import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Db } from '../src/main/lib/db'
import { FigureService } from '../src/main/services/figures'
import { PipelineService, STAGE_ARTIFACTS, stageHandoffPath, validateStageHandoff, type StageHandoff } from '../src/main/services/pipeline'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'research-gates-'))
  const db = new Db(join(root, 'test.db'))
  const timestamp = new Date().toISOString()
  db.run('INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES(?,?,?,?,?)', 'project', 'Test', root, timestamp, timestamp)
  const agent = { isRunning: () => false, validateSelection: (providerId: string, modelId: string) => ({ provider: { id: providerId }, modelId }), send: async () => {}, waitForActive: async () => 'I finished everything', stop: async () => {} }
  const chats = { create: (_project: string, provider: string, model: string) => {
    db.run('INSERT OR IGNORE INTO chats(id,project_id,title,dsh_session_id,provider_id,model_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', 'chat', 'project', 'test', 'session', provider, model, timestamp, timestamp)
    return { id: 'chat' }
  } }
  const documents = { list: () => [], create: async () => { throw new Error('No fixture documents') } }
  const projects = { get: () => ({ id: 'project', rootPath: root }) }
  const references = { list: () => [{ id: 'ref-actual' }], writeBibtexFile: () => '' }
  const settings = { get: () => ({ defaultProviderId: 'default-provider', defaultModelId: 'default-model' }) }
  const pipeline = new PipelineService(db, agent as never, chats as never, documents as never, projects as never, references as never, settings as never)
  const put = (file: string, content: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content) }
  const handoff = (runId: string, stepId: string, stage: string, patch: Partial<StageHandoff> = {}) => {
    const data: StageHandoff = { version: 1, runId, stepId, stage, status: 'ready', artifacts: STAGE_ARTIFACTS[stage]!, referenceIds: [], experimentIds: [], runIds: [], figureIds: [], documentIds: [], blockers: [], ...patch }
    put(stageHandoffPath(runId, stage), JSON.stringify(data))
    return data
  }
  const settle = async () => {
    // Await the tracked loop, not polling or sleeping.
    await (pipeline as unknown as { activeLoop?: Promise<void> }).activeLoop
  }
  return { root, db, agent, chats, documents, projects, references, settings, pipeline, put, handoff, settle, timestamp, cleanup: () => { db.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('configured writing role uses a distinct chat and role model', async () => {
  const f = fixture()
  let selected = ''
  try {
    const original = f.settings.get
    f.agent.validateSelection = (providerId: string, modelId: string) => {
      if (providerId === 'default-provider') throw new Error('default has no key')
      return { provider: { id: providerId }, modelId }
    }
    f.settings.get = () => ({ ...original(), agentRoleModels: { writing: { providerId: 'writer-api', modelId: 'writer-model' }, figures: { providerId: 'plot-api', modelId: 'plot-model' }, engineering: { providerId: 'code-api', modelId: 'code-model' } } }) as never
    let chatIndex = 0
    f.chats.create = (_project: string, provider: string, model: string) => {
      const id = `role-chat-${++chatIndex}`
      f.db.run('INSERT INTO chats(id,project_id,title,dsh_session_id,provider_id,model_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', id, 'project', 'role fixture', id, provider, model, f.timestamp, f.timestamp)
      return { id }
    }
    f.agent.send = async (input?: any) => { selected = input.chatId; assert.deepEqual(input.modelOverride, { providerId: 'writer-api', modelId: 'writer-model' }) }
    const pipeline = new PipelineService(f.db, f.agent as never, f.chats as never, f.documents as never, f.projects as never, f.references as never, f.settings as never)
    const run = pipeline.start({ projectId: 'project', topic: 'role test', formats: ['docx'], autoRun: false })
    await (pipeline as unknown as { activeLoop?: Promise<void> }).activeLoop
    const config = JSON.parse(f.db.get<{ config_json: string }>('SELECT config_json FROM pipeline_runs WHERE id = ?', run.id)!.config_json)
    assert.ok(config.roleChats.writing)
    assert.equal(selected, config.roleChats.writing)
    assert.notEqual(selected, run.chatId)
    assert.equal(f.db.get<{ provider_id: string }>('SELECT provider_id FROM chats WHERE id = ?', selected)!.provider_id, 'writer-api')
  } finally { f.cleanup() }
})

test('handoff requires nonempty real artifacts, exact execution identity and no blockers', () => {
  const f = fixture()
  try {
    const input = { root: f.root, runId: 'pipe', stepId: 'step', stage: 'hypothesis', startedAt: f.timestamp }
    assert.throws(() => validateStageHandoff(input))
    f.put('experiments/plan.md', 'Real falsifiable plan with sampling unit, baseline and declared endpoint.'.repeat(2))
    f.handoff('pipe', 'step', 'hypothesis')
    const result = validateStageHandoff(input)
    assert.match(result.hashes['experiments/plan.md']!, /^[a-f0-9]{64}$/)
    f.handoff('pipe', 'wrong-step', 'hypothesis')
    assert.throws(() => validateStageHandoff(input), /不匹配/)
    f.handoff('pipe', 'step', 'hypothesis', { blockers: ['data unavailable'] })
    assert.throws(() => validateStageHandoff(input), /阻塞/)
    f.handoff('pipe', 'step', 'hypothesis')
    f.put('experiments/plan.md', '')
    assert.throws(() => validateStageHandoff(input), /为空/)
  } finally { f.cleanup() }
})

test('handoff cannot use a directory junction pointing outside the project', () => {
  const f = fixture()
  const outside = mkdtempSync(join(tmpdir(), 'research-outside-'))
  try {
    writeFileSync(join(outside, 'plan.md'), 'outside evidence '.repeat(10))
    symlinkSync(outside, join(f.root, 'experiments'), 'junction')
    f.handoff('pipe', 'step', 'hypothesis')
    assert.throws(() => validateStageHandoff({ root: f.root, runId: 'pipe', stepId: 'step', stage: 'hypothesis', startedAt: f.timestamp }), /项目内/)
  } finally { f.cleanup(); rmSync(outside, { recursive: true, force: true }) }
})

test('fluent agent completion without artifacts fails; explicit model selection is preserved', async () => {
  const f = fixture()
  try {
    const run = f.pipeline.start({ projectId: 'project', topic: 'test', formats: ['docx'], autoRun: true, providerId: 'chosen', modelId: 'selected' })
    await f.settle()
    const result = f.pipeline.get('project').run!
    assert.equal(result.status, 'failed')
    assert.equal(result.steps[0]!.status, 'failed')
    assert.equal(result.steps[1]!.status, 'pending')
    assert.equal(result.steps[0]!.output, 'I finished everything')
    assert.deepEqual({ ...f.db.get('SELECT provider_id,model_id FROM chats WHERE id=?', run.chatId) }, { provider_id: 'chosen', model_id: 'selected' })
  } finally { f.cleanup() }
})

test('retry returns to failed stage, validates artifacts and pauses without skipping', async () => {
  const f = fixture()
  try {
    const run = f.pipeline.start({ projectId: 'project', topic: 'test', formats: ['docx'], autoRun: false })
    await f.settle()
    let calls = 0
    f.agent.send = async () => {
      calls++
      const step = f.pipeline.get('project').run!.steps.find((item) => item.status === 'running')!
      assert.equal(step.stage, 'literature')
      for (const file of STAGE_ARTIFACTS.literature!) f.put(file, 'Inspected local references, question, screening rules and evidence gaps.'.repeat(2))
      f.handoff(run.id, step.id, step.stage, { referenceIds: ['ref-actual'] })
    }
    await f.pipeline.continue(run.id)
    await f.settle()
    assert.equal(calls, 1)
    const result = f.pipeline.get('project').run!
    assert.equal(result.status, 'paused')
    assert.equal(result.steps[0]!.status, 'completed')
    assert.equal(result.steps[1]!.status, 'pending')
    const receipt = JSON.parse(readFileSync(join(f.root, `exports/pipeline/${run.id}/literature.verification.json`), 'utf8'))
    assert.equal(Object.keys(receipt.hashes).length, 2)
  } finally { f.cleanup() }
})

test('execution evidence rejects failed runs even with a ready handoff', async () => {
  const f = fixture()
  try {
    const run = f.pipeline.start({ projectId: 'project', topic: 'test', formats: ['docx'], autoRun: false })
    await f.settle()
    f.db.run("UPDATE pipeline_steps SET status='completed' WHERE run_id=? AND position<3", run.id)
    f.db.run("UPDATE pipeline_steps SET status='pending' WHERE run_id=? AND stage='execute'", run.id)
    f.db.run('INSERT INTO experiments(id,project_id,name,entry_file,created_at,updated_at) VALUES(?,?,?,?,?,?)', 'exp', 'project', 'actual', 'experiments/main.py', f.timestamp, f.timestamp)
    f.db.run('INSERT INTO experiment_runs(id,experiment_id,project_id,status,exit_code,started_at,metrics_json,artifact_dir) VALUES(?,?,?,?,?,?,?,?)', 'run-bad', 'exp', 'project', 'failed', 1, f.timestamp, '{"accuracy":0.9}', 'experiments/runs/run-bad')
    f.agent.send = async () => {
      const step = f.pipeline.get('project').run!.steps.find((item) => item.status === 'running')!
      f.put('exports/experiment-log.md', 'Do not accept this fake completion of a failed actual run.'.repeat(2))
      f.put('experiments/runs/run-bad/metrics.json', '{"accuracy":0.9}')
      f.handoff(run.id, step.id, step.stage, { runIds: ['run-bad'], artifacts: ['exports/experiment-log.md', 'experiments/runs/run-bad/metrics.json'] })
    }
    await f.pipeline.continue(run.id)
    await f.settle()
    const result = f.pipeline.get('project').run!
    assert.equal(result.status, 'failed')
    assert.match(result.steps[3]!.error, /未成功/)
    assert.equal(result.steps[4]!.status, 'pending')
  } finally { f.cleanup() }
})

test('cancellation during an agent response stays cancelled and cannot become completed', async () => {
  const f = fixture()
  try {
    let release!: (value: string) => void
    const blocked = new Promise<string>((resolve) => { release = resolve })
    f.agent.waitForActive = () => blocked
    f.agent.stop = async () => { release('Completed after cancellation') }
    const run = f.pipeline.start({ projectId: 'project', topic: 'test', formats: ['docx'], autoRun: true })
    await Promise.resolve()
    assert.equal(f.pipeline.isRunning(), true)
    await f.pipeline.cancel(run.id)
    await f.settle()
    const result = f.pipeline.get('project').run!
    assert.equal(result.status, 'cancelled')
    assert.equal(result.steps[0]!.status, 'failed')
    assert.equal(result.steps[1]!.status, 'pending')
    assert.equal(f.pipeline.isRunning(), false)
    await assert.rejects(f.pipeline.continue(run.id), /已结束/)
    await f.pipeline.stop()
    const restarted = new PipelineService(f.db, f.agent as never, f.chats as never, f.documents as never, f.projects as never, f.references as never, f.settings as never)
    assert.equal(restarted.get('project').run!.status, 'cancelled')
    await assert.rejects(restarted.continue(run.id), /已结束/)
  } finally { f.cleanup() }
})

test('graceful shutdown preserves completed stages and resumes the interrupted stage after restart', async () => {
  const f = fixture()
  let reopened: Db | undefined
  const response = deferred<string>()
  try {
    f.agent.send = async () => {
      const run = f.pipeline.get('project').run!
      const step = run.steps.find((item) => item.status === 'running')!
      for (const file of STAGE_ARTIFACTS[step.stage]!) f.put(file, 'Verified local evidence, sources, limitations and a falsifiable research plan.'.repeat(2))
      f.handoff(run.id, step.id, step.stage, { referenceIds: ['ref-actual'] })
    }
    const run = f.pipeline.start({ projectId: 'project', topic: 'test', formats: ['docx'], autoRun: false })
    await f.settle()
    const completed = f.pipeline.get('project').run!.steps[0]!
    assert.equal(completed.status, 'completed')
    const waiting = deferred<void>()
    f.agent.waitForActive = () => { waiting.resolve(); return response.promise }
    f.agent.stop = async () => {}
    await f.pipeline.continue(run.id)
    await waiting.promise
    const interruptedId = f.pipeline.get('project').run!.steps[1]!.id
    let stopped = false
    const stopping = f.pipeline.stop().then(() => { stopped = true })
    await Promise.resolve()
    assert.equal(stopped, false, 'stop must await the active loop, not only agent.stop')
    const interrupted = f.pipeline.get('project').run!
    assert.equal(interrupted.status, 'failed')
    assert.equal(interrupted.steps[1]!.status, 'failed')
    assert.match(interrupted.steps[1]!.error, /关闭.*中断/)
    response.resolve('Late successful response with valid artifacts')
    await stopping
    assert.deepEqual(f.pipeline.get('project').run, interrupted, 'late response must not alter interruption state')
    assert.equal(f.pipeline.isRunning(), false)
    assert.equal(existsSync(join(f.root, `exports/pipeline/${run.id}/hypothesis.verification.json`)), false)

    reopened = new Db(join(f.root, 'test.db'))
    const restarted = new PipelineService(reopened, f.agent as never, f.chats as never, f.documents as never, f.projects as never, f.references as never, f.settings as never)
    assert.deepEqual(restarted.get('project').run!.steps[0], completed)
    assert.equal(restarted.get('project').run!.steps[1]!.id, interruptedId)
    const stages: string[] = []
    f.agent.send = async () => {
      const step = restarted.get('project').run!.steps.find((item) => item.status === 'running')!
      stages.push(step.stage)
      assert.equal(step.id, interruptedId)
      f.put('experiments/plan.md', 'Rechecked the interrupted plan and its baseline, metrics and falsifiable hypothesis.'.repeat(2))
      f.handoff(run.id, step.id, step.stage)
    }
    f.agent.waitForActive = async () => 'Resumed hypothesis'
    await restarted.continue(run.id)
    await (restarted as unknown as { activeLoop?: Promise<void> }).activeLoop
    const result = restarted.get('project').run!
    assert.equal(result.id, run.id)
    assert.deepEqual(stages, ['hypothesis'])
    assert.equal(result.status, 'paused')
    assert.deepEqual(result.steps[0], completed)
    assert.equal(result.steps[1]!.status, 'completed')
    assert.ok(result.steps.slice(2).every((step) => step.status === 'pending'))
  } finally { response.resolve('cleanup'); await f.pipeline.stop(); reopened?.close(); f.cleanup() }
})

test('shutdown while send is pending does not start waiting for a late agent response', async () => {
  const f = fixture()
  const sending = deferred<void>()
  try {
    let waits = 0
    f.agent.send = () => sending.promise
    f.agent.waitForActive = async () => { waits++; return 'Late response' }
    f.agent.stop = async () => { sending.resolve() }
    f.pipeline.start({ projectId: 'project', topic: 'test', formats: ['docx'], autoRun: true })
    await f.pipeline.stop()
    const result = f.pipeline.get('project').run!
    assert.equal(result.status, 'failed')
    assert.match(result.steps[0]!.error, /关闭.*中断/)
    assert.equal(waits, 0)
    assert.equal(f.pipeline.isRunning(), false)
  } finally { sending.resolve(); await f.pipeline.stop(); f.cleanup() }
})

for (const boundary of ['send', 'wait'] as const) {
  test(`shutdown preserves interruption when agent ${boundary} rejects late`, async () => {
    const f = fixture()
    const blocked = deferred<string>()
    const entered = deferred<void>()
    let waits = 0
    try {
      f.agent.send = async () => {
        if (boundary === 'send') { entered.resolve(); await blocked.promise }
      }
      f.agent.waitForActive = () => {
        waits++
        entered.resolve()
        return blocked.promise
      }
      f.agent.stop = async () => { blocked.reject(new Error('Late transport error')) }
      f.pipeline.start({ projectId: 'project', topic: 'test', formats: ['docx'], autoRun: true })
      await entered.promise
      await f.pipeline.stop()
      const result = f.pipeline.get('project').run!
      assert.equal(result.status, 'failed')
      assert.equal(result.steps[0]!.status, 'failed')
      assert.match(result.steps[0]!.error, /关闭.*中断/)
      assert.equal(result.steps[0]!.output, '')
      assert.ok(result.steps.slice(1).every((step) => step.status === 'pending'))
      assert.equal(waits, boundary === 'send' ? 0 : 1)
      assert.equal(f.pipeline.isRunning(), false)
    } finally { blocked.resolve('cleanup'); await f.pipeline.stop(); f.cleanup() }
  })
}

for (const fails of [false, true]) {
  test(`shutdown during document creation ignores late ${fails ? 'failure' : 'success'} and sends no agent request`, async () => {
    const f = fixture()
    const creating = deferred<void>()
    const document = deferred<{ id: string }>()
    try {
      const run = f.pipeline.start({ projectId: 'project', topic: 'test', formats: ['docx', 'latex'], autoRun: true })
      await f.settle()
      f.db.run("UPDATE pipeline_steps SET status='completed' WHERE run_id=? AND position<6", run.id)
      let creates = 0
      let sends = 0
      let bibtexWrites = 0
      // The default fixture always rejects; this test models an in-flight document creation.
      f.documents.create = (async () => { creates++; creating.resolve(); return document.promise }) as typeof f.documents.create
      f.references.writeBibtexFile = () => { bibtexWrites++; return '' }
      f.agent.send = async () => { sends++ }
      await f.pipeline.continue(run.id)
      await creating.promise
      const stopping = f.pipeline.stop()
      const interrupted = f.pipeline.get('project').run!
      if (fails) document.reject(new Error('Late document error'))
      else document.resolve({ id: 'created-before-shutdown' })
      await stopping
      assert.deepEqual(f.pipeline.get('project').run, interrupted)
      assert.equal(interrupted.status, 'failed')
      assert.match(interrupted.steps[6]!.error, /关闭.*中断/)
      assert.equal(interrupted.steps[7]!.status, 'pending')
      assert.equal(creates, 1, 'do not create the second document after shutdown')
      assert.equal(sends, 0)
      assert.equal(bibtexWrites, 0)
      assert.equal(f.pipeline.isRunning(), false)
    } finally { document.resolve({ id: 'cleanup' }); await f.pipeline.stop(); f.cleanup() }
  })
}

test('final manual stage completes immediately after a valid evidence gate', async () => {
  const f = fixture()
  try {
    const run = f.pipeline.start({ projectId: 'project', topic: 'test', formats: ['docx'], autoRun: false })
    await f.settle()
    // Reduce this fixture to a single real literature gate to exercise the final-stage transition.
    f.db.run("DELETE FROM pipeline_steps WHERE run_id=? AND stage<>'literature'", run.id)
    f.agent.send = async () => {
      const step = f.pipeline.get('project').run!.steps[0]!
      for (const path of STAGE_ARTIFACTS.literature!) f.put(path, 'Evidence from inspected local sources; limitations and gaps documented.'.repeat(2))
      f.handoff(run.id, step.id, step.stage, { referenceIds: ['ref-actual'] })
    }
    await f.pipeline.continue(run.id)
    await f.settle()
    assert.equal(f.pipeline.get('project').run!.status, 'completed')
  } finally { f.cleanup() }
})

test('document creation failure is caught, reported and leaves later stages pending', async () => {
  const f = fixture()
  try {
    const run = f.pipeline.start({ projectId: 'project', topic: 'test', formats: ['docx'], autoRun: true })
    await f.settle()
    f.db.run("UPDATE pipeline_steps SET status='completed' WHERE run_id=? AND position<6", run.id)
    f.documents.create = async () => { throw new Error('disk full fixture') }
    await f.pipeline.continue(run.id)
    await f.settle()
    const result = f.pipeline.get('project').run!
    assert.equal(result.status, 'failed')
    assert.equal(result.steps[6]!.status, 'failed')
    assert.match(result.steps[6]!.error, /disk full/)
    assert.equal(result.steps[7]!.status, 'pending')
    assert.equal(f.pipeline.isRunning(), false)
  } finally { f.cleanup() }
})

test('interrupted persisted runs recover to retryable failures on service restart', async () => {
  const f = fixture()
  try {
    const run = f.pipeline.start({ projectId: 'project', topic: 'test', formats: ['docx'], autoRun: true })
    await f.settle()
    f.db.run("UPDATE pipeline_runs SET status='running' WHERE id=?", run.id)
    f.db.run("UPDATE pipeline_steps SET status='running' WHERE run_id=? AND stage='literature'", run.id)
    const restarted = new PipelineService(f.db, f.agent as never, f.chats as never, f.documents as never, f.projects as never, f.references as never, f.settings as never)
    assert.equal(restarted.get('project').run!.status, 'failed')
    assert.match(restarted.get('project').run!.steps[0]!.error, /重启/)
  } finally { f.cleanup() }
})

test('analysis requires exact audit outputs in a cited successful run, not handwritten passed exports', async () => {
  const f = fixture()
  try {
    const run = f.pipeline.start({ projectId: 'project', topic: 'test', formats: ['docx'], autoRun: false })
    await f.settle()
    f.db.run("UPDATE pipeline_steps SET status='completed' WHERE run_id=? AND position<4", run.id)
    f.db.run('INSERT INTO experiments(id,project_id,name,entry_file,created_at,updated_at) VALUES(?,?,?,?,?,?)', 'analysis-exp', 'project', 'audit fixture', 'experiments/audit/main.py', f.timestamp, f.timestamp)
    f.db.run('INSERT INTO experiment_runs(id,experiment_id,project_id,status,exit_code,started_at,metrics_json,artifact_dir) VALUES(?,?,?,?,?,?,?,?)', 'analysis-run', 'analysis-exp', 'project', 'succeeded', 0, f.timestamp, '{"checked":2}', 'experiments/audit/runs/analysis-run')
    f.put('experiments/audit/main.py', '# Synthetic unit-test source fixture; not a scientific computation\n')
    f.put('experiments/audit/runs/analysis-run/metrics.json', '{"checked":2}')
    const report = JSON.stringify({ version: 1, status: 'passed', blockers: [], checks: ['synthetic unit-test fixture only'], inputSha256: 'fixture' })
    let includeEmitted = false
    f.agent.send = async () => {
      const step = f.pipeline.get('project').run!.steps.find(item => item.status === 'running')!
      f.put('exports/analysis.md', 'Synthetic fixture verifies matching audit outputs, not scientific validity.'.repeat(2))
      const artifacts = [...STAGE_ARTIFACTS.analysis!, 'experiments/audit/main.py', 'experiments/audit/runs/analysis-run/metrics.json']
      for (const name of ['data-audit', 'statistical-analysis']) {
        f.put(`exports/${name}.json`, report)
        if (includeEmitted) {
          const source = `experiments/audit/runs/analysis-run/${name}.json`
          f.put(source, report)
          artifacts.push(source)
        }
      }
      f.handoff(run.id, step.id, step.stage, { runIds: ['analysis-run'], experimentIds: ['analysis-exp'], artifacts })
    }
    await f.pipeline.continue(run.id); await f.settle()
    assert.equal(f.pipeline.get('project').run!.status, 'failed')
    assert.match(f.pipeline.get('project').run!.steps[4]!.error, /逐字节一致/)
    includeEmitted = true
    await f.pipeline.continue(run.id); await f.settle()
    assert.equal(f.pipeline.get('project').run!.status, 'paused')
    assert.equal(f.pipeline.get('project').run!.steps[4]!.status, 'completed')
  } finally { f.cleanup() }
})

test('review gate rejects mechanical reports masquerading as completed human scientific review', () => {
  const f = fixture()
  try {
    f.db.run('INSERT INTO experiments(id,project_id,name,entry_file,created_at,updated_at) VALUES(?,?,?,?,?,?)', 'audit-exp', 'project', 'audit fixture', 'experiments/audit/main.py', f.timestamp, f.timestamp)
    f.db.run('INSERT INTO experiment_runs(id,experiment_id,project_id,status,exit_code,started_at,metrics_json,artifact_dir) VALUES(?,?,?,?,?,?,?,?)', 'audit-run', 'audit-exp', 'project', 'succeeded', 0, f.timestamp, '{"checks":2}', 'experiments/audit/runs/audit-run')
    f.put('experiments/audit/main.py', '# Synthetic unit-test audit fixture only\n')
    f.put('exports/review-report.md', 'Mechanical fixture checks only; scientific support and full-text review remain unresolved.'.repeat(2))
    function reports(humanReviewRequired: boolean) {
      const artifacts = [...STAGE_ARTIFACTS.review!, 'experiments/audit/main.py']
      for (const name of ['citation-audit', 'reproducibility']) {
        const report = JSON.stringify({ version: 1, status: 'passed', blockers: [], scope: 'mechanical', humanReviewRequired })
        const source = `experiments/audit/runs/audit-run/${name}.json`
        f.put(`exports/${name}.json`, report); f.put(source, report); artifacts.push(source)
      }
      f.handoff('pipe', 'step', 'review', { experimentIds: ['audit-exp'], runIds: ['audit-run'], artifacts })
    }
    const verify = () => (f.pipeline as unknown as { verifyEvidence(row: unknown, step: unknown): string }).verifyEvidence({ id: 'pipe', project_id: 'project', formats_json: '[]' }, { id: 'step', stage: 'review', started_at: f.timestamp })
    reports(false)
    assert.throws(verify, /humanReviewRequired/)
    reports(true)
    assert.match(verify(), /产物门禁通过/)
  } finally { f.cleanup() }
})

test('real FigureService revisions satisfy evidence gate; demo revision is rejected', async () => {
  const f = fixture()
  try {
    const run = f.pipeline.start({ projectId: 'project', topic: 'test', formats: ['docx'], autoRun: false })
    await f.settle()
    f.db.run("UPDATE pipeline_steps SET status='completed' WHERE run_id=? AND position<5", run.id)
    f.db.run('INSERT INTO experiments(id,project_id,name,entry_file,created_at,updated_at) VALUES(?,?,?,?,?,?)', 'exp', 'project', 'actual', 'experiments/main.py', f.timestamp, f.timestamp)
    const artifact = 'experiments/runs/run-real/metrics.json'
    f.put(artifact, '{"conditionA":1,"conditionB":2}')
    f.db.run('INSERT INTO experiment_runs(id,experiment_id,project_id,status,exit_code,started_at,metrics_json,artifact_dir) VALUES(?,?,?,?,?,?,?,?)', 'run-real', 'exp', 'project', 'succeeded', 0, f.timestamp, '{"conditionA":1,"conditionB":2}', 'experiments/runs/run-real')
    const figures = new FigureService(f.db, {} as never)
    const spec = { version: 1 as const, kind: 'chart' as const, chartType: 'bar' as const, title: 'Fixture results', provenance: { sourceLabel: `run-real ${artifact}`, isDemo: true }, xLabel: 'Condition', yLabel: 'Response (fixture units)', labels: ['A', 'B'], series: [{ name: 'Measured fixture', values: [1, 2] }] }
    let figure = await figures.createStructured({ projectId: 'project', experimentId: 'exp', caption: 'Synthetic test fixture only; not scientific evidence.', spec })
    f.agent.send = async () => {
      const step = f.pipeline.get('project').run!.steps.find((item) => item.status === 'running')!
      f.put('exports/figure-evidence.md', 'Figure evidence fixture with actual model and native export files.'.repeat(2))
      f.handoff(run.id, step.id, step.stage, { runIds: ['run-real'], figureIds: [figure.id], artifacts: ['exports/figure-evidence.md', artifact, figure.filePath, figure.sourcePath!, figure.pptxPath!] })
    }
    await f.pipeline.continue(run.id); await f.settle()
    assert.equal(f.pipeline.get('project').run!.status, 'failed')
    assert.match(f.pipeline.get('project').run!.steps[5]!.error, /非演示/)
    // Synthetic fixture deliberately toggles this declaration solely to exercise the success branch.
    figure = await figures.saveStructured('project', figure.id, { ...spec, provenance: { ...spec.provenance, isDemo: false } })
    await f.pipeline.continue(run.id); await f.settle()
    assert.equal(f.pipeline.get('project').run!.status, 'paused')
    assert.equal(f.pipeline.get('project').run!.steps[5]!.status, 'completed')
    assert.match(figure.pptxPath!, /revisions/)
    assert.ok(readFileSync(join(f.root, figure.pptxPath!)).length > 1000)
  } finally { f.cleanup() }
})
