import assert from 'node:assert/strict'
import test from 'node:test'
import { ExperimentContext, ExperimentDrafts } from '../src/renderer/src/lib/experiment-drafts'

const scope = (projectId = 'project-a', experimentId = 'experiment-a') => ({ projectId, experimentId })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('drafts are isolated by both project and experiment, including delimiter-containing IDs', () => {
  const drafts = new ExperimentDrafts()
  const scopes = [scope(), scope('project-b'), scope('project-a', 'experiment-b'), scope('a:b', 'c'), scope('a', 'b:c')]
  scopes.forEach((target, index) => {
    drafts.load(target, `saved-${index}`)
    drafts.edit(target, `draft-${index}`)
  })
  scopes.forEach((target, index) => assert.deepEqual(drafts.get(target), { code: `draft-${index}`, savedCode: `saved-${index}` }))
})

test('selection and ordinary route remounts retain modified and empty-string drafts', () => {
  const drafts = new ExperimentDrafts()
  const firstMount = new ExperimentContext()
  drafts.load(scope(), 'original')
  drafts.edit(scope(), '')
  firstMount.invalidate()
  drafts.load(scope('project-a', 'experiment-b'), 'other code')
  firstMount.invalidate()
  const nextMount = new ExperimentContext()
  assert.equal(nextMount.isCurrent(nextMount.capture()), true)
  assert.deepEqual(drafts.load(scope(), 'new disk contents'), { code: '', savedCode: 'original' })
  // A renderer reload creates fresh module memory, not a persisted draft store.
  assert.equal(new ExperimentDrafts().get(scope()), null)
})

test('a stale selection read cannot become the newly selected editor contents', async () => {
  const drafts = new ExperimentDrafts()
  const context = new ExperimentContext()
  const pending = deferred<string>()
  const token = context.capture()
  let visible = 'loading'
  const oldLoad = pending.promise.then((code) => {
    if (context.isCurrent(token)) visible = drafts.load(scope(), code).code
  })
  context.invalidate()
  visible = drafts.load(scope('project-a', 'experiment-b'), 'B code').code
  drafts.edit(scope('project-a', 'experiment-b'), 'B unsaved')
  visible = drafts.get(scope('project-a', 'experiment-b'))!.code
  pending.resolve('A code')
  await oldLoad
  assert.equal(visible, 'B unsaved')
  assert.equal(drafts.get(scope()), null)
})

test('A -> B -> A and unmount invalidate old operations even when the IDs match again', () => {
  const context = new ExperimentContext()
  const firstA = context.capture()
  context.invalidate()
  const b = context.capture()
  context.invalidate()
  const nextA = context.capture()
  assert.equal(context.isCurrent(firstA), false)
  assert.equal(context.isCurrent(b), false)
  assert.equal(context.isCurrent(nextA), true)
  context.invalidate()
  assert.equal(context.isCurrent(nextA), false)
})

test('late duplicate reads never overwrite an existing modified draft', () => {
  const drafts = new ExperimentDrafts()
  drafts.load(scope(), 'initial')
  drafts.edit(scope(), 'unsaved')
  drafts.load(scope(), 'late read')
  assert.deepEqual(drafts.get(scope()), { code: 'unsaved', savedCode: 'initial' })
})

test('successful save records its snapshot without discarding typing during the save', () => {
  const drafts = new ExperimentDrafts()
  drafts.load(scope(), 'original')
  drafts.edit(scope(), 'submitted')
  const submitted = drafts.get(scope())!.code
  drafts.edit(scope(), 'typed while saving')
  drafts.saved(scope(), submitted)
  assert.equal(drafts.isModified(scope()), true)
  assert.deepEqual(drafts.get(scope()), { code: 'typed while saving', savedCode: 'submitted' })
  drafts.revert(scope())
  assert.equal(drafts.isModified(scope()), false)
  assert.deepEqual(drafts.get(scope()), { code: 'submitted', savedCode: 'submitted' })
})

test('failed save leaves the original baseline and revert affects only its experiment', async () => {
  const drafts = new ExperimentDrafts()
  drafts.load(scope(), 'original')
  drafts.edit(scope(), 'unsaved')
  drafts.load(scope('project-b'), 'other')
  drafts.edit(scope('project-b'), 'other unsaved')
  await assert.rejects(Promise.reject(new Error('save failed')))
  assert.deepEqual(drafts.get(scope()), { code: 'unsaved', savedCode: 'original' })
  drafts.revert(scope())
  assert.equal(drafts.get(scope())?.code, 'original')
  assert.equal(drafts.get(scope('project-b'))?.code, 'other unsaved')
})

test('navigation during save suppresses the subsequent run but updates the original saved baseline', async () => {
  const drafts = new ExperimentDrafts()
  const context = new ExperimentContext()
  drafts.load(scope(), 'original')
  drafts.edit(scope(), 'submitted')
  const pending = deferred<void>()
  const token = context.capture()
  let runCalls = 0
  const operation = pending.promise.then(() => {
    drafts.saved(scope(), 'submitted')
    if (!context.isCurrent(token)) return
    runCalls += 1
  })
  context.invalidate()
  drafts.load(scope('project-b'), 'project B')
  pending.resolve()
  await operation
  assert.equal(runCalls, 0)
  assert.deepEqual(drafts.get(scope()), { code: 'submitted', savedCode: 'submitted' })
  assert.equal(drafts.get(scope('project-b'))?.code, 'project B')
})

test('a remounted editor is notified about a pending save; deleted drafts are not resurrected', () => {
  const drafts = new ExperimentDrafts()
  drafts.load(scope(), 'original')
  drafts.edit(scope(), 'submitted')
  let notifications = 0
  const unsubscribe = drafts.subscribe(() => { notifications += 1 })
  drafts.saved(scope(), 'submitted')
  assert.equal(notifications, 1)
  drafts.remove(scope())
  assert.equal(drafts.saved(scope(), 'late save'), null)
  assert.equal(drafts.get(scope()), null)
  unsubscribe()
  drafts.load(scope(), 'fresh')
  assert.equal(notifications, 2)
})
