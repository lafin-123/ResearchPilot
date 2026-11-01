import { net, session } from 'electron'
import { proxyEnvFromResolution } from './proxy-env'

export async function requestViaSystemProxy(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const target = input instanceof URL ? input.toString() : input
  try { return await net.fetch(target, init) } catch (error) {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (method !== 'GET' || init?.signal?.aborted || !/ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ECONNRESET/.test(error instanceof Error ? error.message : String(error))) throw error
    return net.fetch(target, init)
  }
}

export async function getProviderProxyEnv(url: string): Promise<NodeJS.ProcessEnv> {
  const parsed = new URL(url)
  if (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return {}
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) return { NODE_USE_ENV_PROXY: '1', NO_PROXY: process.env.NO_PROXY || 'localhost,127.0.0.1,::1,[::1]' }
  return proxyEnvFromResolution(await session.defaultSession.resolveProxy(parsed.toString()))
}
