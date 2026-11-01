export function proxyEnvFromResolution(resolution: string): NodeJS.ProcessEnv {
  const first = resolution.split(';')[0]?.trim() || 'DIRECT'
  if (first === 'DIRECT') return {}
  const match = first.match(/^(PROXY|HTTPS)\s+([^\s/@]+:\d+)$/i)
  if (!match) throw new Error('系统为模型配置了不受支持的代理类型。请使用 HTTP/HTTPS 代理或配置 HTTPS_PROXY。')
  const proxy = `${match[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`
  return { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NODE_USE_ENV_PROXY: '1', NO_PROXY: 'localhost,127.0.0.1,::1,[::1]' }
}
