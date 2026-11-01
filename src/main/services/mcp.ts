import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { BUNDLED_MCP_SERVERS, MCP_LIMITS, MCP_VERSION, mcpDefinition, type McpBridgeGrant, type McpConfigureInput, type McpServerId, type McpServerState, type McpTestInput } from '../../shared/mcp'
import type { Db } from '../lib/db'
import { bundledResource } from '../lib/paths'
import type { ProjectService } from './projects'
import type { BridgeService } from './bridge'

const KEY = 'bundled-mcp-v1'
interface Connection { client: Client; transport: StdioClientTransport; grant: McpBridgeGrant; state: McpServerState; closing: boolean }
interface McpRuntimePaths { serverPath: string; executable: string }

/** Minimal child environment: no provider keys, proxy credentials, NODE_OPTIONS or arbitrary loaders. */
export function mcpChildEnvironment(grant: McpBridgeGrant, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'PATH', 'Path', 'PATHEXT']) if (inherited[key]) env[key] = inherited[key]!
  return { ...env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1', RESEARCHPILOT_MCP_URL: grant.url, RESEARCHPILOT_MCP_TOKEN: grant.token, RESEARCHPILOT_MCP_PROJECT: grant.projectId }
}

export class McpService {
  private readonly connections = new Map<McpServerId, Connection>()
  private readonly lastStates = new Map<McpServerId, McpServerState>()
  private readonly runtimeTokens = new Set<string>()
  private closed = false
  private readonly paths: McpRuntimePaths

  constructor(private readonly db: Db, private readonly projects: ProjectService, private readonly bridge: BridgeService, paths?: McpRuntimePaths) {
    this.paths = paths ?? { serverPath: bundledResource('mcp', 'server.mjs'), executable: process.execPath }
  }

  private enabled(): McpServerId[] {
    try {
      const row = this.db.get<{ value_json: string }>('SELECT value_json FROM app_settings WHERE key = ?', KEY)
      const value = JSON.parse(row?.value_json ?? '[]') as unknown
      if (!Array.isArray(value)) return []
      return BUNDLED_MCP_SERVERS.filter(item => value.includes(item.id)).map(item => item.id)
    } catch { return [] }
  }
  signature(): string { return JSON.stringify([MCP_VERSION, ...this.enabled()]) }
  private initial(serverId: McpServerId, projectId = ''): McpServerState {
    return { ...mcpDefinition(serverId), enabled: this.enabled().includes(serverId), status: 'disconnected', projectId, discoveredTools: [], lastTestAt: '', lastTestOk: null, lastError: '', testSummary: '' }
  }
  list(projectId = ''): McpServerState[] {
    if (projectId) this.projects.get(projectId)
    const enabled = this.enabled()
    return BUNDLED_MCP_SERVERS.map(definition => {
      const state = this.connections.get(definition.id)?.state ?? this.lastStates.get(definition.id)
      return { ...(state && (!projectId || state.projectId === projectId) ? state : this.initial(definition.id, projectId)), enabled: enabled.includes(definition.id) }
    })
  }

  async configure(input: McpConfigureInput): Promise<McpServerState[]> {
    if (!input || typeof input.enabled !== 'boolean') throw new Error('启用状态必须为布尔值。')
    const server = mcpDefinition(input.serverId)
    const enabled = new Set(this.enabled())
    if (input.enabled) enabled.add(server.id)
    else {
      enabled.delete(server.id)
      this.bridge.revokeMcpServer(server.id)
      await this.disconnect({ serverId: server.id, projectId: '' })
    }
    this.db.run('INSERT INTO app_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json', KEY, JSON.stringify([...enabled]))
    return this.list()
  }

  /** Uses loader expression nodes so bearer values never enter the patch YAML. */
  harnessConfiguration(projectId: string): { entries: unknown[]; env: NodeJS.ProcessEnv } {
    this.projects.get(projectId)
    for (const token of this.runtimeTokens) this.bridge.revokeMcpGrant(token)
    this.runtimeTokens.clear()
    const enabled = this.enabled()
    if (enabled.length && !existsSync(this.paths.serverPath)) throw new Error('内置 MCP 程序缺失，请重新构建或安装 ResearchPilot。')
    const env: NodeJS.ProcessEnv = {}
    const entries = enabled.map(id => {
      const definition = mcpDefinition(id)
      const grant = this.bridge.issueMcpGrant(projectId, id)
      this.runtimeTokens.add(grant.token)
      const key = `RESEARCHPILOT_MCP_${id.toUpperCase()}_TOKEN`
      env[key] = grant.token
      return {
        id: `researchpilot-mcp-${id}`, name: '@deepseek-ai/dsh-mcp-client',
        config: {
          serverName: definition.namespace, transport: 'stdio', command: this.paths.executable,
          args: [this.paths.serverPath, '--server', id], cwd: dirname(this.paths.serverPath),
          env: { ...mcpChildEnvironment({ ...grant, token: '' }), NODE_OPTIONS: '', NODE_PATH: '', NODE_USE_ENV_PROXY: '0', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', RESEARCHPILOT_BRIDGE_TOKEN: '', RESEARCHPILOT_MCP_TOKEN: { __jsExpr: `process.env.${key}` } },
          toolCallTimeoutMs: definition.tools.some(tool => tool.approvalRequired) ? MCP_LIMITS.actionTimeoutMs + 3000 : MCP_LIMITS.timeoutMs + 3000, failOnStartupError: true, reconnect: { enabled: false }
        }
      }
    })
    return { entries, env }
  }

  async test(input: McpTestInput): Promise<McpServerState> {
    if (this.closed) throw new Error('MCP 服务已关闭，请重新登录。')
    if (!input || typeof input.projectId !== 'string' || !input.projectId) throw new Error('请先选择项目。')
    const definition = mcpDefinition(input.serverId)
    this.projects.get(input.projectId)
    if (this.connections.get(input.serverId)?.state.status === 'connecting') throw new Error('该服务正在测试，请等待完成。')
    // Diagnostic sessions are single-project, independent from the Agent's own stdio processes.
    for (const [serverId, item] of this.connections) if (item.grant.projectId !== input.projectId || serverId === input.serverId) await this.disconnect({ serverId, projectId: item.grant.projectId })
    const state = this.initial(input.serverId, input.projectId)
    state.status = 'connecting'
    this.lastStates.set(input.serverId, state)
    let connection: Connection | undefined
    try {
      if (!existsSync(this.paths.serverPath)) throw new Error('内置 MCP 程序缺失，请运行构建或重新安装。')
      const grant = this.bridge.issueMcpGrant(input.projectId, input.serverId)
      const transport = new StdioClientTransport({ command: this.paths.executable, args: [this.paths.serverPath, '--server', input.serverId], cwd: dirname(this.paths.serverPath), env: mcpChildEnvironment(grant), stderr: 'pipe', maxBufferSize: 1024 * 1024 })
      const client = new Client({ name: 'ResearchPilot-diagnostics', version: MCP_VERSION }, { capabilities: {} })
      connection = { client, transport, grant, state, closing: false }
      this.connections.set(input.serverId, connection)
      transport.stderr?.on('data', () => { /* drain without recording secrets or arbitrary subprocess output */ })
      client.onclose = () => {
        if (connection!.closing) return
        state.status = 'disconnected'; state.lastError = '诊断连接已关闭；请重新测试。'
        this.bridge.revokeMcpGrant(grant.token)
        if (this.connections.get(input.serverId) === connection) this.connections.delete(input.serverId)
      }
      client.onerror = () => { state.lastError = 'MCP 传输错误，请重新测试。' }
      await client.connect(transport, { timeout: MCP_LIMITS.timeoutMs })
      const listed = await client.listTools(undefined, { timeout: MCP_LIMITS.timeoutMs })
      const names = listed.tools.map(tool => tool.name)
      const expected = definition.tools.map(tool => tool.name)
      if (names.length !== expected.length || expected.some(name => !names.includes(name))) throw new Error('实际工具目录与内置清单不一致。')
      state.discoveredTools = names
      const result = await client.callTool({ name: definition.testTool, arguments: {} }, { timeout: MCP_LIMITS.timeoutMs })
      if (result.isError) throw new Error(result.content.filter(block => block.type === 'text').map(block => block.text).join(' ').slice(0, 300) || '项目范围工具调用失败。')
      if (connection.closing || this.closed || this.connections.get(input.serverId) !== connection) throw new Error('MCP 测试已取消。')
      state.status = 'connected'; state.lastTestOk = true; state.lastError = ''; state.lastTestAt = new Date().toISOString()
      state.testSummary = `已完成 stdio 初始化、发现 ${names.length} 个工具，并成功调用 ${definition.testTool}。诊断连接仍在运行；智能体使用独立连接。`
    } catch (error) {
      if (connection) {
        connection.closing = true
        this.bridge.revokeMcpGrant(connection.grant.token)
        await connection.client.close().catch(() => undefined)
        await connection.transport.close().catch(() => undefined)
        if (this.connections.get(input.serverId) === connection) this.connections.delete(input.serverId)
      }
      state.status = 'error'; state.lastTestOk = false; state.lastTestAt = new Date().toISOString()
      const message = error instanceof Error ? error.message : '测试失败。'
      state.lastError = message.replace(/[a-f0-9]{48,}/gi, '[redacted]').slice(0, 300)
      state.testSummary = '测试没有通过；不要把启用设置视为连接成功。'
    }
    return { ...state, enabled: this.enabled().includes(input.serverId) }
  }

  async disconnect(input: McpTestInput): Promise<void> {
    mcpDefinition(input.serverId)
    const connection = this.connections.get(input.serverId)
    if (!connection || (input.projectId && connection.grant.projectId !== input.projectId)) return
    connection.closing = true
    this.bridge.revokeMcpGrant(connection.grant.token)
    this.connections.delete(input.serverId)
    connection.state.status = 'disconnected'
    connection.state.testSummary = '诊断连接已关闭；上次测试记录仅作参考。'
    await connection.client.close().catch(() => undefined)
    await connection.transport.close().catch(() => undefined)
  }

  async close(): Promise<void> {
    this.closed = true
    for (const token of this.runtimeTokens) this.bridge.revokeMcpGrant(token)
    this.runtimeTokens.clear()
    await Promise.all([...this.connections].map(([serverId, connection]) => this.disconnect({ serverId, projectId: connection.grant.projectId })))
    this.lastStates.clear()
  }
}
