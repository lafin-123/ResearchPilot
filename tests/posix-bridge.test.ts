import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const repo = resolve('.')
const source = join(repo, 'resources/bridge/research.sh')
const bash = (process.platform === 'win32'
  ? [join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe'), 'bash']
  : ['bash']).find(command => spawnSync(command, ['--noprofile', '--norc', '-c', 'exit 0'], { windowsHide: true }).status === 0)
const executable = { skip: bash ? false : 'Bash is unavailable (install Git Bash on Windows)' }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rp-posix bridge-'))
  const project = join(root, 'project with spaces')
  const bin = join(project, '.research/bin')
  const cwd = join(project, 'experiments/nested')
  mkdirSync(bin, { recursive: true }); mkdirSync(cwd, { recursive: true })
  const script = join(bin, 'research')
  copyFileSync(source, script); chmodSync(script, 0o755)
  const configPath = join(project, '.research/bridge.json')
  const config = { port: 32123, token: 'fixture-private-token', projectId: 'project "quoted" \\ path 科研 $(touch INJECTED)' }
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  const capture = join(root, 'curl-call.json')
  const mock = join(root, 'mock-curl.cjs')
  // Both paths are mocked: the old shell curl and Node's curl child process. No network.
  writeFileSync(mock, `const fs = require('node:fs');
function curl(args, options = {}) {
  fs.writeFileSync(process.env.POSIX_TEST_CAPTURE, JSON.stringify({ args, input: options.input || '' }));
  return { status: Number(process.env.POSIX_TEST_CURL_STATUS || 0),
    stdout: process.env.POSIX_TEST_RESPONSE || '{"ok":true,"result":{"fixture":true}}',
    stderr: process.env.POSIX_TEST_CURL_STDERR || '' };
}
if (require.main === module) {
  const result = curl(process.argv.slice(2), { input: fs.readFileSync(0, 'utf8') });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.status;
} else {
  require('node:child_process').spawnSync = (command, args, options) => {
    if (command !== 'curl') throw new Error('Unexpected child process');
    return curl(args, options);
  };
}
`)
  const mockBin = join(root, 'mock-bin'); mkdirSync(mockBin)
  writeFileSync(join(mockBin, 'curl'), '#!/bin/sh\nunset NODE_OPTIONS\nexec "$POSIX_TEST_NODE" "$POSIX_TEST_CURL" "$@"\n')
  chmodSync(join(mockBin, 'curl'), 0o755)
  const env = {
    ...process.env,
    PATH: `${mockBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
    NODE_OPTIONS: `--require "${mock.replaceAll('\\', '/')}"`,
    POSIX_TEST_NODE: process.execPath.replaceAll('\\', '/'), POSIX_TEST_CURL: mock.replaceAll('\\', '/'),
    POSIX_TEST_BIN: mockBin, POSIX_TEST_CAPTURE: capture, POSIX_TEST_RESPONSE: '', POSIX_TEST_CURL_STATUS: '', POSIX_TEST_CURL_STDERR: ''
  }
  const run = (args: string[], overrides: Record<string, string> = {}, workdir = cwd) => {
    rmSync(capture, { force: true })
    return spawnSync(bash!, ['--noprofile', '--norc', '-c', 'export PATH="$(cygpath -u "$POSIX_TEST_BIN" 2>/dev/null || printf "%s" "$POSIX_TEST_BIN"):$PATH"; exec "$@"', 'posix-bridge-test', script.replaceAll('\\', '/'), ...args], {
      cwd: workdir, env: { ...env, ...overrides }, encoding: 'utf8', windowsHide: true, timeout: 15000
    })
  }
  return { root, project, configPath, config, capture, run,
    call: () => JSON.parse(readFileSync(capture, 'utf8')) as { args: string[]; input: string },
    cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function request(call: { args: string[]; input: string }) {
  const index = call.args.findIndex(arg => ['--data', '--data-binary', '--data-raw'].includes(arg))
  assert.notEqual(index, -1, 'curl must receive a JSON request body')
  const body = JSON.parse(call.args[index + 1])
  assert.ok(!call.args.some(arg => arg.includes('fixture-private-token')), 'token must not be exposed in process arguments')
  assert.equal(call.input, 'Authorization: Bearer fixture-private-token\n')
  return body
}

const routes = [
  ['status'], ['docs', 'list'], ['docs', 'read'], ['docs', 'create'], ['docs', 'write'], ['docs', 'compile'],
  ['refs', 'list'], ['refs', 'search'], ['refs', 'add'], ['refs', 'export'],
  ['exps', 'list'], ['exps', 'create'], ['exps', 'run'], ['exps', 'status'], ['exps', 'logs'],
  ['figs', 'list'], ['figs', 'create'], ['figs', 'get'], ['figs', 'update'], ['figs', 'export'], ['figs', 'render'],
  ['ssh', 'list'], ['ssh', 'exec'], ['evidence', 'report']
]

test('extensionless POSIX CLI dispatches the actual Windows command set from nested directories', executable, () => {
  const f = fixture()
  try {
    for (const args of routes) {
      const result = f.run(args)
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
      const call = f.call(), body = request(call)
      assert.equal(body.method, args.join('.'))
      assert.equal(body.projectId, f.config.projectId)
      assert.deepEqual(body.params, args.join('.') === 'docs.create' ? { format: 'docx' } : {})
      assert.equal(call.args.at(-1), `http://127.0.0.1:${f.config.port}/rpc`)
      assert.deepEqual(JSON.parse(result.stdout), { fixture: true })
      assert.ok(!result.stdout.includes(f.config.token) && !result.stderr.includes(f.config.token))
    }
  } finally { f.cleanup() }
})

test('options preserve literal arguments and Windows aliases, defaults and value types', executable, () => {
  const f = fixture()
  try {
    const literal = 'A "quote", backslash \\, newline\n科研; $(touch INJECTED) `touch INJECTED` & *'
    const result = f.run(['exps', 'create', '--name', literal, '--code-file', 'experiments/code with spaces.py', '--spec-file', 'spec.json', '--ssh-host-id', 'host', '--experiment-id', 'exp', '--document-id', 'doc', '--run-id', 'run', '--timeout', '90', '--rows', '12', '--port', '22', '--remote'])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(request(f.call()).params, { name: literal, codeFile: 'experiments/code with spaces.py', specFile: 'spec.json', sshHostId: 'host', experimentId: 'exp', documentId: 'doc', runId: 'run', timeout: 90, rows: 12, port: 22, remote: true })
    assert.equal(existsSync(join(f.project, 'experiments/nested/INJECTED')), false)
    const ssh = f.run(['ssh', 'exec', '--host', 'local', '--command', literal])
    assert.equal(ssh.status, 0, ssh.stderr)
    assert.equal(request(f.call()).params.command, literal)
    assert.equal(f.run(['docs', 'create', '--format', 'latex']).status, 0)
    assert.deepEqual(request(f.call()).params, { format: 'latex' })
    assert.equal(f.run(['refs', 'list', '--query', literal]).status, 0)
    assert.equal(request(f.call()).params.query, literal)
    assert.equal(f.run(['docs', 'read', '--id', '', '--__proto__', 'literal', '--constructor', 'literal']).status, 0)
    const unusual = request(f.call()).params
    assert.equal(unusual.id, '')
    assert.equal(Object.hasOwn(unusual, '__proto__'), true)
    assert.equal(unusual.__proto__, 'literal')
  } finally { f.cleanup() }
})

test('help and invalid commands do not require a project or contact the bridge', executable, () => {
  const f = fixture()
  try {
    for (const args of [[], ['help'], ['--help']]) {
      const result = f.run(args, {}, f.root)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /research|ResearchPilot/)
      assert.equal(existsSync(f.capture), false)
    }
    for (const args of [['docs'], ['docs list'], ['docs', 'delete'], ['status; touch INJECTED']]) {
      assert.notEqual(f.run(args).status, 0)
      assert.equal(existsSync(f.capture), false)
    }
  } finally { f.cleanup() }
})

test('config lookup uses JSON, stops at the nearest project, and fails closed without exposing tokens', executable, () => {
  const f = fixture()
  try {
    assert.notEqual(f.run(['status'], {}, f.root).status, 0)
    assert.equal(existsSync(f.capture), false)
    writeFileSync(f.configPath, JSON.stringify(f.config)) // compact JSON is equally valid
    assert.equal(f.run(['status']).status, 0)
    assert.equal(request(f.call()).projectId, f.config.projectId)
    writeFileSync(f.configPath, '﻿' + JSON.stringify(f.config))
    assert.equal(f.run(['status']).status, 0)
    for (const config of ['{ "token": "fixture-private-token",',
      JSON.stringify({ ...f.config, port: '32123; touch INJECTED' }),
      JSON.stringify({ ...f.config, port: 65536 }), JSON.stringify({ ...f.config, token: 'bad\r\nX-Header: injected' }),
      JSON.stringify({ ...f.config, projectId: null }), JSON.stringify({ ...f.config, token: '' })]) {
      writeFileSync(f.configPath, config)
      const result = f.run(['status'])
      assert.notEqual(result.status, 0)
      assert.equal(existsSync(f.capture), false)
      assert.ok(!result.stderr.includes(f.config.token))
    }
    writeFileSync(f.configPath, JSON.stringify(f.config))
    const nearer = join(f.project, 'experiments/.research'); mkdirSync(nearer)
    writeFileSync(join(nearer, 'bridge.json'), '{broken')
    assert.notEqual(f.run(['status']).status, 0)
    assert.equal(existsSync(f.capture), false)
  } finally { f.cleanup() }
})

test('RPC strings/null print naturally; protocol, bridge and curl failures return nonzero without token logs', executable, () => {
  const f = fixture()
  try {
    for (const [response, expected] of [[{ ok: true, result: 'literal output' }, 'literal output\n'], [{ ok: true, result: null }, 'null\n']] as const) {
      const result = f.run(['status'], { POSIX_TEST_RESPONSE: JSON.stringify(response) })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.replaceAll('\r\n', '\n'), expected)
    }
    for (const overrides of [
      { POSIX_TEST_RESPONSE: JSON.stringify({ ok: false, error: 'approval denied' }) },
      { POSIX_TEST_RESPONSE: JSON.stringify({ ok: false, error: `redact ${f.config.token}` }) },
      { POSIX_TEST_RESPONSE: 'invalid json' }, { POSIX_TEST_RESPONSE: '{}' },
      { POSIX_TEST_CURL_STATUS: '22', POSIX_TEST_CURL_STDERR: `do not print ${f.config.token}` }
    ]) {
      const result = f.run(['status'], overrides)
      assert.notEqual(result.status, 0)
      assert.ok(!result.stdout.includes(f.config.token) && !result.stderr.includes(f.config.token))
    }
    assert.equal(f.run(['exps', 'run', '--timeout', 'not-a-number']).status, 1)
    assert.equal(existsSync(f.capture), false)
  } finally { f.cleanup() }
})

async function layoutHarness(platform: 'linux' | 'darwin' | 'win32') {
  // Match the existing esbuild test harness: run real filesystem logic with Electron stubbed.
  const bundle = await build({ stdin: { contents: "export { ensureProjectLayout } from './src/main/lib/paths'; export { ProjectHealthService } from './src/main/services/project-health'", resolveDir: repo, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, define: { 'process.platform': JSON.stringify(platform) }, tsconfig: join(repo, 'tsconfig.node.json') })
  const module = { exports: {} as typeof import('../src/main/lib/paths') & typeof import('../src/main/services/project-health') }
  const require = createRequire(import.meta.url)
  const chmods: Array<{ path: string; mode: number }> = []
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)((name: string) => {
    if (name === 'electron') return { app: { isPackaged: false, getAppPath: () => repo } }
    if (name === 'node:fs') return { ...require(name), chmodSync: (path: string, mode: number) => { chmods.push({ path, mode }); chmodSync(path, mode) } }
    return require(name)
  }, module, module.exports)
  return { ...module.exports, chmods }
}

test('managed layout copies extensionless research on Linux/macOS only and applies executable permissions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rp-posix-layout-'))
  try {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const { ensureProjectLayout, chmods } = await layoutHarness(platform)
      const rootPath = join(root, platform); mkdirSync(rootPath)
      ensureProjectLayout({ rootPath, id: 'p', name: 'Project', createdAt: '' } as never)
      const bin = join(rootPath, '.research/bin')
      for (const entry of ['research-cli.ps1', 'research.cmd', 'research.sh']) assert.ok(existsSync(join(bin, entry)))
      assert.equal(existsSync(join(bin, 'research')), platform !== 'win32')
      if (platform !== 'win32') {
        assert.equal(readFileSync(join(bin, 'research'), 'utf8'), readFileSync(source, 'utf8'))
        assert.ok(chmods.some(call => call.path === join(bin, 'research') && call.mode === 0o755))
        if (process.platform !== 'win32') assert.equal(statSync(join(bin, 'research')).mode & 0o777, 0o755)
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('managed layout preflights the extensionless launcher before writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rp-posix-guard-'))
  try {
    const { ProjectHealthService } = await layoutHarness('linux')
    const bin = join(root, '.research/bin'); mkdirSync(bin, { recursive: true })
    const outside = join(root, 'outside'); writeFileSync(outside, 'unchanged')
    linkSync(outside, join(bin, 'research'))
    const project = { id: 'p', name: 'p', rootPath: root } as never
    let prepared = false
    const health = new ProjectHealthService({ list: () => [project], get: () => project }, () => { prepared = true })
    assert.equal(health.retry('p').error?.code, 'EMLINK')
    assert.equal(prepared, false)
    assert.equal(readFileSync(outside, 'utf8'), 'unchanged')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
