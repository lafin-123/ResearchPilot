import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proxyEnvFromResolution } from '../src/main/lib/proxy-env'

test('HTTP system proxy is forwarded to the model runtime with loopback excluded', () => {
  const env = proxyEnvFromResolution('PROXY 127.0.0.1:7897; DIRECT')
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897')
  assert.equal(env.NODE_USE_ENV_PROXY, '1')
  assert.match(env.NO_PROXY!, /127\.0\.0\.1/)
})
test('DIRECT stays direct and unsupported proxies are never silently downgraded', () => {
  assert.deepEqual(proxyEnvFromResolution('DIRECT; PROXY localhost:8080'), {})
  assert.throws(() => proxyEnvFromResolution('SOCKS5 localhost:1080'), /不受支持/)
  assert.throws(() => proxyEnvFromResolution('PROXY user:pass@host:8080'), /不受支持/)
})
