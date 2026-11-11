import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Provider } from '../src/shared/types'
import type { AgentRoleModels } from '../src/shared/agent-roles'
import { resolveAgentRole } from '../src/shared/agent-roles'
import { effectiveResearchModel, effectiveToneModel, formatEffectiveModel } from '../src/renderer/src/lib/effective-model'

const provider = (id: string, modelId: string, hasApiKey = true): Provider => ({
  id, name: `${id} API`, kind: 'custom', protocol: 'openai-completions', baseUrl: 'https://example.com/v1',
  models: [{ id: modelId, label: 'Friendly label, not the model ID' }], hasApiKey,
  isDefault: false, createdAt: '', updatedAt: ''
})
const providers = [provider('global', 'global-exact'), provider('writer', 'writer-exact'), provider('mentor', 'mentor-exact'), provider('reviewer', 'review-exact'), provider('engineer', 'code-exact')]
const settings = (agentRoleModels: AgentRoleModels = {}) => ({ defaultProviderId: 'global', defaultModelId: 'global-exact', agentRoleModels })
const roles: AgentRoleModels = {
  writing: { providerId: 'writer', modelId: 'writer-exact' },
  coordinator: { providerId: 'mentor', modelId: 'mentor-exact' },
  reviewer: { providerId: 'reviewer', modelId: 'review-exact' },
  engineering: { providerId: 'engineer', modelId: 'code-exact' }
}

for (const [operation, role] of [
  ['supervisor', 'coordinator'], ['perspectives', 'coordinator'], ['round', 'writing'],
  ['outline', 'writing'], ['draft', 'writing'], ['review', 'reviewer'], ['method', 'engineering']
] as const) {
  test(`${operation} matches the native coordinator's ${role} route`, () => {
    const cfg = settings(roles)
    const actual = effectiveResearchModel(cfg, providers, operation)
    assert.equal(actual.available, true)
    assert.equal(actual.source, role)
    assert.equal(actual.providerId, roles[role]!.providerId)
    assert.equal(actual.modelId, roles[role]!.modelId)
    const backend = resolveAgentRole(role, cfg.agentRoleModels, providers) ?? resolveAgentRole('writing', cfg.agentRoleModels, providers) ?? cfg
    assert.equal(actual.modelId, 'modelId' in backend ? backend.modelId : cfg.defaultModelId)
  })
}

test('unconfigured research roles fall back to writing, then the exact global default', () => {
  for (const operation of ['supervisor', 'perspectives', 'review', 'method'] as const) {
    assert.equal(effectiveResearchModel(settings({ writing: roles.writing }), providers, operation).source, 'writing')
    assert.equal(effectiveResearchModel(settings({ writing: roles.writing }), providers, operation).modelId, 'writer-exact')
    assert.equal(effectiveResearchModel(settings(), providers, operation).source, 'default')
    assert.equal(effectiveResearchModel(settings(), providers, operation).modelId, 'global-exact')
  }
})

test('tone uses only writing or global default, not coordinator/reviewer/chat selection', () => {
  assert.equal(effectiveToneModel(settings(roles), providers).source, 'writing')
  const cfg = { ...settings({ coordinator: roles.coordinator, reviewer: roles.reviewer }), modelSelection: roles.engineering }
  assert.equal(effectiveToneModel(cfg, providers).modelId, 'global-exact')
  assert.equal(effectiveToneModel(cfg, providers).source, 'default')
})

for (const [reason, badProviders, route] of [
  ['missing provider', providers, { providerId: 'deleted', modelId: 'writer-exact' }],
  ['missing key', providers.map(p => p.id === 'mentor' ? { ...p, hasApiKey: false } : p), roles.coordinator!],
  ['missing exact model', providers, { providerId: 'mentor', modelId: 'removed-model' }],
  ['empty model', providers, { providerId: 'mentor', modelId: '' }]
] as const) {
  test(`invalid configured route (${reason}) is unavailable, never falls back`, () => {
    const actual = effectiveResearchModel(settings({ ...roles, coordinator: route }), badProviders, 'supervisor')
    assert.equal(actual.available, false)
    assert.equal(actual.source, 'coordinator')
    assert.equal(actual.providerId, route.providerId)
    assert.equal(actual.modelId, route.modelId)
    assert.match(formatEffectiveModel(actual), /配置不可用/)
  })
}

test('invalid writing fallback stops research and tone even with a valid default', () => {
  const cfg = settings({ writing: { providerId: 'writer', modelId: 'removed' } })
  for (const actual of [effectiveResearchModel(cfg, providers, 'review'), effectiveToneModel(cfg, providers)]) {
    assert.equal(actual.available, false)
    assert.equal(actual.source, 'writing')
    assert.equal(actual.modelId, 'removed')
  }
  assert.equal(effectiveResearchModel(settings({ ...cfg.agentRoleModels, reviewer: roles.reviewer }), providers, 'review').available, true)
})

test('missing/invalid defaults never silently select the first provider or model', () => {
  for (const cfg of [
    { defaultProviderId: '', defaultModelId: '' },
    { defaultProviderId: 'deleted', defaultModelId: 'global-exact' },
    { defaultProviderId: 'global', defaultModelId: 'removed' }
  ]) {
    const actual = effectiveToneModel(cfg, providers)
    assert.equal(actual.available, false)
    assert.equal(actual.source, 'default')
    assert.equal(actual.providerId, cfg.defaultProviderId)
    assert.equal(actual.modelId, cfg.defaultModelId)
  }
  assert.equal(effectiveToneModel(settings(), providers.map(p => ({ ...p, hasApiKey: false }))).available, false)
  assert.equal(effectiveToneModel(null, providers).available, false)
})

test('format shows provider identity, exact model ID and role/default provenance', () => {
  const role = formatEffectiveModel(effectiveToneModel(settings(roles), providers))
  assert.match(role, /writer API \(writer\).*writer-exact/)
  assert.match(role, /写作 Agent/)
  assert.ok(!role.includes('Friendly label'))
  assert.match(formatEffectiveModel(effectiveToneModel(settings(), providers)), /全局默认/)
  assert.match(formatEffectiveModel(effectiveToneModel(null, providers)), /配置不可用/)
})

test('research and tone render next-invocation provenance from saved store configuration', async () => {
  const root = resolve(import.meta.dirname, '..')
  const state = { activeProjectId: 'project', settings: settings(roles), providers, modelSelection: { providerId: 'chat-only', modelId: 'chat-only-model' } }
  Object.assign(globalThis, { __modelProvenanceState: state })
  const load = async (path: string) => {
    const bundle = await build({
      entryPoints: [resolve(root, path)], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
      tsconfig: resolve(root, 'tsconfig.web.json'), loader: { '.css': 'empty' },
      plugins: [{ name: 'renderer-stubs', setup(builder) {
        builder.onResolve({ filter: /\/store\/app$/ }, () => ({ path: 'store', namespace: 'test' }))
        builder.onResolve({ filter: /\/lib\/api$/ }, () => ({ path: 'api', namespace: 'test' }))
        builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'store'
          ? 'export const useAppStore = selector => selector(globalThis.__modelProvenanceState)'
          : 'export const api = {}; export const formatError = String', loader: 'js' }))
      } }]
    })
    const module = { exports: {} as Record<string, import('react').ComponentType<any>> }
    new Function('require', 'module', 'exports', bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports)
    return module.exports
  }
  try {
    const { ResearchPage } = await load('src/renderer/src/pages/Research.tsx')
    const { WritingTonePanel } = await load('src/renderer/src/components/WritingTonePanel.tsx')
    const research = (kind = 'brainstorm') => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ResearchPage, { kind })))
    const tone = () => renderToStaticMarkup(createElement(WritingTonePanel, { projectId: 'project', text: '', protectedTerms: '', context: '', disabled: false, revisionText: '', onAdopt() {} }))
    const before = research()
    assert.match(before, /下次调用/)
    for (const modelId of ['mentor-exact', 'writer-exact', 'review-exact']) assert.ok(before.includes(modelId), modelId)
    assert.match(research('method'), /code-exact/)
    assert.match(tone(), /下次生成建议/)
    assert.match(tone(), /writer-exact/)
    state.settings = settings({ writing: { providerId: 'global', modelId: 'global-exact' } })
    assert.match(tone(), /global-exact/)
    assert.ok(!tone().includes('writer-exact'))
    assert.ok(!research().includes('chat-only-model'))
    state.providers = providers.filter(p => p.id !== 'global')
    assert.match(research(), /配置不可用/)
    assert.match(tone(), /配置不可用/)
  } finally { Reflect.deleteProperty(globalThis, '__modelProvenanceState') }
})

test('fresh saved settings/providers change next invocation without mutating previous results', () => {
  const cfg = settings(roles)
  const before = effectiveToneModel(cfg, providers)
  const nextProviders = [...providers, provider('new', 'new-exact')]
  const saved = effectiveToneModel(settings({ writing: { providerId: 'new', modelId: 'new-exact' } }), nextProviders)
  assert.equal(saved.modelId, 'new-exact')
  assert.equal(saved.providerId, 'new')
  assert.equal(before.modelId, 'writer-exact')
  assert.equal(effectiveToneModel(cfg, providers.filter(p => p.id !== 'writer')).available, false)
})
