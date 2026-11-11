import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import vm from 'node:vm'

async function storage(platform: string, backend: string, available = true) {
  const result = await build({ entryPoints: ['src/main/lib/secrets.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, define: { 'process.platform': JSON.stringify(platform) }, plugins: [{ name: 'mock-electron', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }))
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `export const safeStorage = { isEncryptionAvailable: () => ${available}, getSelectedStorageBackend: () => ${JSON.stringify(backend)}, encryptString: s => Buffer.from(s), decryptString: b => b.toString() }` }))
  } }] })
  const module = { exports: {} as typeof import('../src/main/lib/secrets') }
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, Buffer, require: () => undefined })
  return module.exports
}

test('Linux rejects basic_text fallback rather than claiming protected secret storage', async () => {
  const secrets = await storage('linux', 'basic_text')
  assert.equal(secrets.isSecretStorageAvailable(), false)
  assert.throws(() => secrets.encryptSecret('synthetic-key'), /安全存储不可用/)
  assert.throws(() => secrets.decryptSecret('enc:v1:c3ludGhldGlj'), /安全存储不可用/)
})

test('system encryption remains available on Windows and secure Linux backends', async () => {
  for (const [platform, backend] of [['win32', 'unknown'], ['linux', 'gnome_libsecret'], ['linux', 'kwallet6']]) {
    const secrets = await storage(platform, backend)
    assert.equal(secrets.isSecretStorageAvailable(), true)
    assert.equal(secrets.decryptSecret(secrets.encryptSecret('synthetic-key')), 'synthetic-key')
  }
})

test('unavailable system storage never encrypts and empty values need no keyring', async () => {
  const secrets = await storage('linux', 'gnome_libsecret', false)
  assert.equal(secrets.isSecretStorageAvailable(), false)
  assert.equal(secrets.encryptSecret(''), '')
  assert.equal(secrets.decryptSecret(''), '')
  assert.throws(() => secrets.encryptSecret('synthetic-key'), /安全存储不可用/)
})
