import assert from 'node:assert/strict'
import test from 'node:test'

test('research workspace validates source locators and outline evidence without manufacturing citations', async () => {
  const { createResearchWorkspace, parseWorkspace, applyResearchOutput } = await import('../src/shared/research-workflows')
  const workspace = createResearchWorkspace('brainstorm', 'Retrieval evaluation')
  workspace.evidence.push({ id: 'source-a', referenceId: 'ref-a', title: 'Source', locator: 'reference:ref-a#abstract', quote: 'Actual abstract excerpt.', coverage: 'abstract', hash: 'a'.repeat(64) })
  assert.equal(parseWorkspace(workspace).topic, 'Retrieval evaluation')
  assert.throws(() => applyResearchOutput(workspace, 'outline', { outline: [{ id: 'a', title: 'Methods', evidenceIds: ['invented'] }] }), /来源/)
  const next = applyResearchOutput(workspace, 'outline', { outline: [{ id: 'a', title: 'Methods', evidenceIds: ['source-a'] }] })
  assert.equal(next.outline[0].title, 'Methods')
  assert.equal(workspace.outline.length, 0)
  assert.throws(() => parseWorkspace({ ...workspace, topic: '' }))
})

test('method tool schema rejects unknown or invalid inputs and verification requires real completed runs', async () => {
  const { validateMethodInput, methodVerification } = await import('../src/shared/research-workflows')
  const fields = [{ name: 'scale', type: 'number', required: true }]
  assert.deepEqual(validateMethodInput(fields, { scale: 3 }), { scale: 3 })
  assert.throws(() => validateMethodInput(fields, { scale: '3' }))
  assert.throws(() => validateMethodInput(fields, { scale: 3, unknown: 1 }))
  assert.equal(methodVerification([]).ready, false)
  assert.equal(methodVerification([{ inputHash: 'a', runId: 'r1', status: 'succeeded', checksPassed: true }, { inputHash: 'b', runId: 'r2', status: 'failed', checksPassed: true }]).ready, false)
  assert.equal(methodVerification([{ inputHash: 'a', runId: 'r1', status: 'succeeded', checksPassed: true }, { inputHash: 'b', runId: 'r2', status: 'succeeded', checksPassed: true }]).ready, true)
})
