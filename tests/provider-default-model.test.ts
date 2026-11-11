import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { Db } from '../src/main/lib/db'
import type { ProviderInput } from '../src/shared/types'
import type { ProviderService as ProviderServiceType } from '../src/main/services/providers'
import type { SettingsService as SettingsServiceType } from '../src/main/services/settings'

const root = resolve(import.meta.dirname, '..')
let ProviderService: new (db: Db, settings: SettingsServiceType) => ProviderServiceType
let SettingsService: new (db: Db) => SettingsServiceType

before(async () => {
  const bundle = await build({
    stdin: { contents: "export { ProviderService } from './src/main/services/providers'; export { SettingsService } from './src/main/services/settings'", resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    tsconfig: resolve(root, 'tsconfig.node.json'),
    plugins: [{ name: 'provider-test-boundaries', setup(builder) {
      builder.onResolve({ filter: /\/lib\/secrets$/ }, () => ({ path: 'secrets', namespace: 'test' }))
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }))
      builder.onLoad({ filter: /^secrets$/, namespace: 'test' }, () => ({ contents: 'export const encryptSecret = value => `encrypted:${value}`; export const decryptSecret = value => value.slice(10)', loader: 'js' }))
      builder.onLoad({ filter: /^electron$/, namespace: 'test' }, () => ({ contents: 'export const app = { isPackaged: false, getPath: () => "/fixture/documents" }; export const net = {}; export const session = {}', loader: 'js' }))
    } }]
  })
  const module = { exports: {} as { ProviderService: typeof ProviderService; SettingsService: typeof SettingsService } }
  new Function('require', 'module', 'exports', bundle.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports)
  ;({ ProviderService, SettingsService } = module.exports)
})

function input(id = 'gateway', patch: Partial<ProviderInput> = {}): ProviderInput {
  return {
    id, name: id, kind: 'custom', protocol: 'openai-completions', baseUrl: 'https://gateway.example/v1',
    apiKey: 'fixture-key', models: [{ id: 'first', label: 'First' }, { id: 'chosen', label: 'Chosen' }], ...patch
  }
}

function fixture(path = ':memory:') {
  const db = new Db(path)
  const settings = new SettingsService(db)
  settings.update({ defaultProviderId: '', defaultModelId: '' })
  return { db, settings, service: new ProviderService(db, settings) }
}

function selection(settings: SettingsServiceType) {
  const { defaultProviderId, defaultModelId } = settings.get()
  return [defaultProviderId, defaultModelId]
}

type Element = { type: unknown; props: { children?: unknown; footer?: unknown; value?: string; disabled?: boolean; 'aria-label'?: string; onClick?: () => void | Promise<void>; onChange?: (event: { target: { value: string } }) => void | Promise<void> } }
const settingsBundle = build({
  entryPoints: [resolve(root, 'src/renderer/src/pages/Settings.tsx')],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
  tsconfig: resolve(root, 'tsconfig.web.json'),
  plugins: [{ name: 'settings-ui-boundaries', setup(builder) {
    builder.onResolve({ filter: /^(\.\.\/lib\/api|\.\.\/store\/app|\.\.\/components\/Ui)$/ }, args => ({ path: args.path, external: true }))
  } }]
})

async function settingsHarness() {
  const f = fixture()
  const provider = f.service.upsert(input('gateway', { isDefault: true, defaultModelId: 'chosen' }))
  const store = { settings: f.settings.get(), providers: [provider], sshHosts: [], projects: [], refreshProviders: async () => {}, refreshBootstrap: async () => {}, bootstrap: null }
  f.db.close()
  const calls: ProviderInput[] = []
  const slots: unknown[] = []
  let cursor = 0
  const require = createRequire(import.meta.url)
  const hooks = {
    ...require('react'),
    useState: (value: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], (next: unknown) => { slots[index] = next }] },
    useRef: (value: unknown) => { const index = cursor++; return slots[index] ??= { current: value } },
    useEffect: () => { cursor++ }
  }
  const module = { exports: {} as { SettingsPage: () => Element } }
  new Function('require', 'module', 'exports', (await settingsBundle).outputFiles[0]!.text)((name: string) => {
    if (name === 'react') return hooks
    if (name === '../store/app') return { useAppStore: (select: (state: typeof store) => unknown) => select(store) }
    if (name === '../lib/api') return { api: { providers: { upsert: async (value: ProviderInput) => { calls.push(value) } } }, formatError: String, formatNumber: String, relativeTime: String }
    if (name === '../components/Ui') return Object.fromEntries(['Badge', 'Button', 'Field', 'Input', 'Modal', 'PageHeader', 'Select', 'Textarea'].map(type => [type, type]))
    if (name === 'sonner') return { toast: { success: () => {}, error: () => {} } }
    return require(name)
  }, module, module.exports)
  const render = () => { cursor = 0; return module.exports.SettingsPage() }
  const all = (node: unknown): Element[] => {
    if (Array.isArray(node)) return node.flatMap(child => all(child))
    if (!node || typeof node !== 'object' || !('props' in node)) return []
    const element = node as Element
    return [element, ...all(element.props.children ?? null), ...all(element.props.footer ?? null)]
  }
  const textOf = (node: unknown): string => Array.isArray(node) ? node.map(textOf).join('') : node && typeof node === 'object' && 'props' in node ? textOf((node as Element).props.children) : typeof node === 'string' ? node : ''
  const select = (label: string) => { const element = all(render()).find(item => item.type === 'Select' && item.props['aria-label'] === label); assert.ok(element, `Missing select ${label}`); return element }
  const click = async (label: string) => { const element = all(render()).find(item => item.type === 'Button' && textOf(item) === label); assert.ok(element, `Missing button ${label}`); await element.props.onClick!(); await new Promise<void>(done => setImmediate(done)) }
  return { calls, select, click }
}

test('Settings exposes a global default selector that submits the selected non-first model', async () => {
  const ui = await settingsHarness()
  const select = ui.select('全局默认模型')
  assert.equal(select.props.value, JSON.stringify(['gateway', 'chosen']))
  await select.props.onChange!({ target: { value: JSON.stringify(['gateway', 'chosen']) } })
  assert.equal(ui.calls[0].defaultModelId, 'chosen')
  assert.equal(ui.calls[0].isDefault, true)
})

test('editing the active provider exposes and saves its preferred global model', async () => {
  const ui = await settingsHarness()
  await ui.click('编辑')
  const select = ui.select('提供方默认模型')
  assert.equal(select.props.value, 'chosen')
  await select.props.onChange!({ target: { value: 'first' } })
  await ui.click('保存所选模型')
  assert.equal(ui.calls[0].defaultModelId, 'first')
  assert.equal(ui.calls[0].isDefault, true)
})

test('explicit non-first default model and encrypted key survive a database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-provider-default-'))
  const path = join(dir, 'app.sqlite')
  const f = fixture(path)
  try {
    f.service.upsert(input('gateway', { isDefault: true, defaultModelId: 'chosen' }))
    assert.deepEqual(selection(f.settings), ['gateway', 'chosen'])
    assert.equal(f.service.apiKey('gateway'), 'fixture-key')
    f.db.close()
    const reopened = new Db(path)
    try {
      const settings = new SettingsService(reopened)
      assert.deepEqual(selection(settings), ['gateway', 'chosen'])
      assert.equal(new ProviderService(reopened, settings).get('gateway').isDefault, true)
    } finally { reopened.close() }
  } finally {
    if (f.db.raw.isOpen) f.db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('selecting a multi-model default requires an explicit model without mutating rows or settings', () => {
  const f = fixture()
  try {
    assert.throws(() => f.service.upsert(input('gateway', { isDefault: true })), /默认模型|选择模型/)
    assert.deepEqual(f.service.list(), [])
    assert.deepEqual(selection(f.settings), ['', ''])
  } finally { f.db.close() }
})

for (const isDefault of [true, undefined]) {
  test(`editing the default provider retains a valid selected model (isDefault=${isDefault})`, () => {
    const f = fixture()
    try {
      f.service.upsert(input('gateway', { isDefault: true, defaultModelId: 'chosen' }))
      f.service.upsert(input('gateway', { name: 'Renamed', apiKey: undefined, isDefault, models: [{ id: 'new-first', label: 'New first' }, { id: 'chosen', label: 'Chosen' }] }))
      assert.deepEqual(selection(f.settings), ['gateway', 'chosen'])
      assert.equal(f.service.apiKey('gateway'), 'fixture-key')
    } finally { f.db.close() }
  })
}

test('an invalid explicit model is rejected before changing the previous default or provider', () => {
  const f = fixture()
  try {
    f.service.upsert(input('original', { isDefault: true, defaultModelId: 'chosen' }))
    f.service.upsert(input('other'))
    assert.throws(() => f.service.upsert(input('other', { name: 'Changed', isDefault: true, defaultModelId: 'missing' })), /默认模型|模型不存在/)
    assert.equal(f.service.get('other').name, 'other')
    assert.equal(f.service.get('original').isDefault, true)
    assert.deepEqual(selection(f.settings), ['original', 'chosen'])
  } finally { f.db.close() }
})

test('removing the selected model requires an explicit replacement when several models remain', () => {
  const f = fixture()
  try {
    f.service.upsert(input('gateway', { isDefault: true, defaultModelId: 'chosen' }))
    const models = [{ id: 'first', label: 'First' }, { id: 'replacement', label: 'Replacement' }]
    assert.throws(() => f.service.upsert(input('gateway', { models })), /默认模型|选择模型/)
    assert.deepEqual(selection(f.settings), ['gateway', 'chosen'])
    f.service.upsert(input('gateway', { models, defaultModelId: 'replacement' }))
    assert.deepEqual(selection(f.settings), ['gateway', 'replacement'])
  } finally { f.db.close() }
})

test('a provider with one model has an unambiguous natural default', () => {
  const f = fixture()
  try {
    f.service.upsert(input('only', { models: [{ id: 'sole', label: 'Sole' }], isDefault: true }))
    assert.deepEqual(selection(f.settings), ['only', 'sole'])
  } finally { f.db.close() }
})

test('changing the global model does not depend on provider model ordering', () => {
  const f = fixture()
  try {
    f.service.upsert(input('gateway', { isDefault: true, defaultModelId: 'chosen' }))
    f.service.upsert(input('gateway', { isDefault: true, defaultModelId: 'first' }))
    assert.deepEqual(selection(f.settings), ['gateway', 'first'])
    assert.deepEqual(f.service.get('gateway').models.map(model => model.id), ['first', 'chosen'])
  } finally { f.db.close() }
})

test('deleting a non-default provider preserves the explicit default model', () => {
  const f = fixture()
  try {
    f.service.upsert(input('gateway', { isDefault: true, defaultModelId: 'chosen' }))
    f.service.upsert(input('other'))
    f.service.delete('other')
    assert.deepEqual(selection(f.settings), ['gateway', 'chosen'])
    assert.equal(f.service.get('gateway').isDefault, true)
  } finally { f.db.close() }
})

test('deleting the last provider clears the persisted default pair', () => {
  const f = fixture()
  try {
    f.service.upsert(input('gateway', { isDefault: true, defaultModelId: 'chosen' }))
    f.service.delete('gateway')
    assert.deepEqual(selection(f.settings), ['', ''])
    assert.equal(f.service.defaultProvider(), undefined)
  } finally { f.db.close() }
})

test('deleting the default provider does not choose the first of several remaining models', () => {
  const f = fixture()
  try {
    f.service.upsert(input('gateway', { isDefault: true, defaultModelId: 'chosen' }))
    f.service.upsert(input('other'))
    f.service.delete('gateway')
    assert.deepEqual(selection(f.settings), ['', ''])
    assert.equal(f.service.get('other').isDefault, false)
    assert.equal(f.service.defaultProvider(), undefined)
  } finally { f.db.close() }
})

test('deleting the default provider can select a sole remaining provider and model', () => {
  const f = fixture()
  try {
    f.service.upsert(input('gateway', { isDefault: true, defaultModelId: 'chosen' }))
    f.service.upsert(input('other', { models: [{ id: 'sole', label: 'Sole' }] }))
    f.service.delete('gateway')
    assert.deepEqual(selection(f.settings), ['other', 'sole'])
    assert.equal(f.service.get('other').isDefault, true)
  } finally { f.db.close() }
})

test('saving a multi-model provider without choosing a default does not implicitly select it', () => {
  const f = fixture()
  try {
    f.service.upsert(input())
    assert.deepEqual(selection(f.settings), ['', ''])
    assert.equal(f.service.get('gateway').isDefault, false)
    assert.equal(f.service.defaultProvider(), undefined)
  } finally { f.db.close() }
})

test('settings default-pair updates validate membership and synchronize provider flags', () => {
  const f = fixture()
  try {
    f.service.upsert(input('gateway', { isDefault: true, defaultModelId: 'chosen' }))
    f.service.upsert(input('other'))
    f.settings.update({ defaultProviderId: 'other', defaultModelId: 'chosen' })
    assert.deepEqual(selection(f.settings), ['other', 'chosen'])
    assert.equal(f.service.get('gateway').isDefault, false)
    assert.equal(f.service.get('other').isDefault, true)
    for (const patch of [
      { defaultProviderId: 'missing', defaultModelId: 'chosen' },
      { defaultProviderId: 'other', defaultModelId: 'missing' },
      { defaultProviderId: 'other', defaultModelId: '' },
      { defaultProviderId: '', defaultModelId: 'chosen' }
    ]) {
      assert.throws(() => f.settings.update(patch), /默认模型|提供方|模型不存在/)
      assert.deepEqual(selection(f.settings), ['other', 'chosen'])
    }
    f.settings.update({ defaultProviderId: '', defaultModelId: '' })
    assert.deepEqual(selection(f.settings), ['', ''])
    assert.equal(f.service.list().some(provider => provider.isDefault), false)
  } finally { f.db.close() }
})

test('unrelated settings patches do not validate the initial not-yet-seeded default', () => {
  const db = new Db(':memory:')
  try {
    const settings = new SettingsService(db)
    assert.equal(settings.update({ pythonPath: 'python-fixture' }).pythonPath, 'python-fixture')
  } finally { db.close() }
})

test('unsetting the selected default clears settings without selecting another provider', () => {
  const f = fixture()
  try {
    f.service.upsert(input('gateway', { isDefault: true, defaultModelId: 'chosen' }))
    f.service.upsert(input('gateway', { isDefault: false }))
    assert.deepEqual(selection(f.settings), ['', ''])
    assert.equal(f.service.get('gateway').isDefault, false)
  } finally { f.db.close() }
})
