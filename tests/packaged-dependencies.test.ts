import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
// Runtime contracts auto-installed only as peers by npm in DSH 0.2.1-rc.2.
// Explicit application ownership is necessary for electron-builder's collector.
const runtimePeers = ['cordis-plugin-group', 'dsh-anonymous-user-id', 'dsh-attachment', 'dsh-bash-local',
  'dsh-compaction', 'dsh-deepseek-account', 'dsh-fs', 'dsh-jobs', 'dsh-llm-deepseek',
  'dsh-output-retention', 'dsh-ptc-runtime', 'dsh-sandbox', 'dsh-scope', 'dsh-session-persistence',
  'dsh-session-query', 'dsh-session-telemetry', 'dsh-session-title-llm', 'dsh-shell', 'dsh-spill',
  'dsh-util-time', 'dsh-util-workspace-path', 'dsh-workflow'].map(name => `@deepseek-ai/${name}`)

test('all DSH runtime peer contracts survive production collector pruning and clean npm ci', () => {
  const pkg = read(join(root, 'package.json'))
  const lock = read(join(root, 'package-lock.json'))
  for (const name of runtimePeers) {
    const installed = read(join(root, 'node_modules', name, 'package.json'))
    assert.equal(pkg.dependencies[name], installed.version, `${name} must be a pinned production dependency`)
    assert.equal(lock.packages[''].dependencies[name], installed.version)
    assert.notEqual(lock.packages[`node_modules/${name}`].peer, true, `${name} cannot remain peer-only`)
  }
})

test('DSH boot peer-only group plugin is explicitly owned by the application production graph', () => {
  const pkg = read(join(root, 'package.json'))
  const lock = read(join(root, 'package-lock.json'))
  const boot = read(join(root, 'node_modules/@deepseek-ai/dsh-app-boot/package.json'))
  const group = read(join(root, 'node_modules/@deepseek-ai/cordis-plugin-group/package.json'))
  assert.ok(boot.peerDependencies['@deepseek-ai/cordis-plugin-group'])
  assert.equal(boot.dependencies['@deepseek-ai/cordis-plugin-group'], undefined)
  // npm auto-installs peers, but electron-builder's npm collector only follows
  // _dependencies. A peer:true lock entry alone is not a packaging guarantee.
  assert.equal(pkg.dependencies['@deepseek-ai/cordis-plugin-group'], group.version)
  assert.equal(lock.packages[''].dependencies['@deepseek-ai/cordis-plugin-group'], group.version)
  assert.notEqual(lock.packages['node_modules/@deepseek-ai/cordis-plugin-group'].peer, true)
})

test('import audit detects missing peers and permits legitimate dependency hoisting', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'packaged-dependency-test-'))
  const artifact = join(fixture, 'artifact')
  const put = async (base: string, file: string, text: string) => {
    const target = join(base, file)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, text)
  }
  const manifest = (name: string) => JSON.stringify({ name, type: 'module', main: 'index.js' })
  try {
    for (const base of [fixture, artifact]) {
      for (const entry of ['dsh-app-boot/lib/index.js', 'dsh-sdk-client/lib/index.js', 'dsh/lib/bin.js']) {
        await put(base, `node_modules/@deepseek-ai/${entry}`, entry.startsWith('dsh-app-boot') ? "import 'fixture-contract'; export * from './local.js'" : '')
      }
      await put(base, 'node_modules/@deepseek-ai/dsh-app-boot/lib/local.js', 'export const local = true')
      for (const bundle of ['dsh-base', 'dsh-sdk-app']) await put(base, `node_modules/@deepseek-ai/${bundle}/package.json`, '{"dependencies":{}}')
      await put(base, 'package.json', '{"type":"module"}')
    }
    await put(fixture, 'node_modules/fixture-contract/package.json', manifest('fixture-contract'))
    await put(fixture, 'node_modules/fixture-contract/index.js', 'export const contract = true')
    const audit = () => spawnSync(process.execPath, ['--experimental-import-meta-resolve', join(root, 'scripts/validate-packaged-dependencies.mjs'), '--app-root', artifact, '--compare-root', fixture], { cwd: root, encoding: 'utf8', timeout: 60000 })
    const red = audit()
    assert.equal(red.status, 1)
    assert.ok(JSON.parse(red.stdout).unresolved.some((edge: { specifier: string; reason: string }) => edge.specifier === 'fixture-contract' && edge.reason.includes('outside artifact')))
    // Source has a nested copy but electron-builder can relocate it to the artifact root.
    await put(fixture, 'node_modules/@deepseek-ai/dsh-app-boot/node_modules/fixture-contract/package.json', manifest('fixture-contract'))
    await put(fixture, 'node_modules/@deepseek-ai/dsh-app-boot/node_modules/fixture-contract/index.js', 'export const contract = true')
    await put(artifact, 'node_modules/fixture-contract/package.json', manifest('fixture-contract'))
    await put(artifact, 'node_modules/fixture-contract/index.js', 'export const contract = true')
    const green = audit()
    assert.equal(green.status, 0, green.stdout + green.stderr)
    assert.deepEqual(JSON.parse(green.stdout).unresolved, [])
    await rm(join(artifact, 'node_modules/@deepseek-ai/dsh-app-boot/lib/local.js'))
    const missing = audit()
    assert.equal(missing.status, 1)
    assert.ok(JSON.parse(missing.stdout).unresolved.some((edge: { specifier: string }) => edge.specifier === './local.js'))
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

test('bounded boot import audit rejects packages resolving outside the artifact', t => {
  const app = process.env.PACKAGED_APP_ROOT
  if (!app) { t.skip('Set PACKAGED_APP_ROOT to gate a built artifact'); return }
  assert.ok(existsSync(join(app, 'package.json')), `Missing packaged app: ${app}`)
  const result = spawnSync(process.execPath, ['--experimental-import-meta-resolve',
    join(root, 'scripts/validate-packaged-dependencies.mjs'), '--app-root', app,
    '--compare-root', root], { cwd: root, encoding: 'utf8', timeout: 60000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const report = JSON.parse(result.stdout)
  assert.ok(report.filesChecked > 10)
  assert.deepEqual(report.unresolved, [])
})

test('Linux production staging installs the same corrected manifest and lock without lifecycle scripts', () => {
  const script = readFileSync(join(root, 'scripts/package-linux.mjs'), 'utf8')
  assert.match(script, /writeFile\(join\(project, 'package\.json'\), JSON\.stringify\(\{ \.\.\.pkg, version \}/)
  assert.match(script, /writeFile\(join\(project, 'package-lock\.json'\), lock\)/)
  assert.match(script, /'ci'.*'--omit=dev'.*'--ignore-scripts'/)
  assert.match(script, /metadata\.lockSha256 !== lockSha256/)
})
