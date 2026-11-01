import test from 'node:test'
import assert from 'node:assert/strict'

test('role routes resolve distinct providers/models and reject invalid routes without falling back', async () => {
  const { normalizeAgentRoles, roleForStage, resolveAgentRole } = await import('../src/shared/agent-roles')
  const providers = [{ id: 'write-api', hasApiKey: true, models: [{ id: 'writer' }] }, { id: 'plot-api', hasApiKey: true, models: [{ id: 'plotter' }] }, { id: 'code-api', hasApiKey: true, models: [{ id: 'coder' }] }] as any
  const routes = normalizeAgentRoles({ writing: { providerId: 'write-api', modelId: 'writer' }, figures: { providerId: 'plot-api', modelId: 'plotter' }, engineering: { providerId: 'code-api', modelId: 'coder' } })
  assert.equal(resolveAgentRole('writing', routes, providers)?.providerId, 'write-api')
  assert.equal(resolveAgentRole('figures', routes, providers)?.modelId, 'plotter')
  assert.equal(roleForStage('execute'), 'engineering')
  assert.equal(roleForStage('execution'), 'engineering')
  assert.equal(roleForStage('paper'), 'writing')
  assert.equal(roleForStage('figures'), 'figures')
  assert.equal(resolveAgentRole('writing', {}, providers), null)
  assert.throws(() => resolveAgentRole('writing', { writing: { providerId: 'missing', modelId: 'x' } }, providers), /不可用/)
  assert.deepEqual(normalizeAgentRoles({ writing: { providerId: 4, modelId: 'x' } }), {})
})
