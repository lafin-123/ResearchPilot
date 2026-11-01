import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import type { DocumentRecord, Project } from '@shared/types'
import { FIGURE_LIMITS, validateFigureSpec, type FigureSpec } from '../../shared/figure-spec'
import { buildDocx } from '../lib/docx-build'
import { assertInside, ensureDir, writeBridgeConfig } from '../lib/paths'
import { setBridgeEndpoint } from '../lib/bridge-state'
import { emitEvent } from '../lib/events'
import type { ApprovalService } from './approvals'
import type { DocumentService } from './documents'
import type { EvidenceService } from './evidence'
import type { ExperimentRunner } from './experiment-runner'
import type { ExperimentService } from './experiments'
import type { FigureService } from './figures'
import type { ProjectService } from './projects'
import { searchCrossref } from './references'
import type { ReferenceService } from './references'
import type { SettingsService } from './settings'
import type { SshService } from './ssh'
import { MCP_LIMITS, isMcpAction, mcpDefinition, validateMcpArguments, type McpBridgeGrant, type McpServerId } from '../../shared/mcp'
import { McpToolService, mcpArtifactPath, readMcpFile, writeMcpArtifact } from './mcp-tools'
import { figurePath } from '../lib/figure-files'
import { fetchJournalGuidelines } from '../lib/research-sources'
import type { ProjectSyncResult } from '../../shared/project-health'
import { assertProjectPathSafe, assertProjectRootAvailable, projectHealthError, type ProjectHealthService } from './project-health'

type Params = Record<string, unknown>

interface RpcBody {
  method?: string
  params?: Params
  projectId?: string
}

const MAX_BODY = 4 * 1024 * 1024
// Read-only record/file queries stay usable for diagnosis; file readers retain their own path guards.
const READ_ONLY_RPC_METHODS = new Set(['status', 'docs.list', 'docs.read', 'refs.list', 'refs.search', 'exps.list', 'exps.status', 'exps.logs', 'figs.list', 'figs.get', 'ssh.list'])

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少参数 ${name}。`)
  return value
}

export class BridgeService {
  private server: Server | undefined
  private token = ''
  private port = 0
  private epoch = 0
  private readonly requests = new Set<Promise<void>>()
  private readonly mcpGrants = new Map<string, { projectId: string; serverId: McpServerId }>()
  private readonly mcpRequests = new Map<AbortController, string>()
  private readonly mcpExperiments = new Set<string>()

  /** Read-only MCP capabilities never receive the general bridge bearer token. */
  issueMcpGrant(projectId: string, serverId: McpServerId): McpBridgeGrant {
    if (!this.isAuthorized() || !this.server || !this.token) throw new Error('请先登录并启动项目桥接。')
    this.projects.get(projectId)
    mcpDefinition(serverId)
    if (this.mcpGrants.size >= 32) throw new Error('MCP 连接过多，请先断开旧连接。')
    const token = randomBytes(32).toString('hex')
    this.mcpGrants.set(token, { projectId, serverId })
    return { url: `http://127.0.0.1:${this.port}/mcp`, token, projectId, serverId }
  }

  revokeMcpGrant(token: string): void {
    this.mcpGrants.delete(token)
    for (const [controller, requestToken] of this.mcpRequests) if (requestToken === token) controller.abort()
  }
  revokeMcpServer(serverId: McpServerId): void {
    for (const [token, grant] of this.mcpGrants) if (grant.serverId === serverId) this.revokeMcpGrant(token)
  }

  isBusy(): boolean {
    return this.requests.size > 0
  }

  constructor(
    private readonly projects: ProjectService,
    private readonly documents: DocumentService,
    private readonly references: ReferenceService,
    private readonly experiments: ExperimentService,
    private readonly runner: ExperimentRunner,
    private readonly figures: FigureService,
    private readonly ssh: SshService,
    private readonly approvals: ApprovalService,
    private readonly settings: SettingsService,
    private readonly evidence: EvidenceService,
    private readonly isAuthorized: () => boolean = () => false,
    private readonly projectHealth?: ProjectHealthService
  ) {}

  async start(): Promise<ProjectSyncResult[]> {
    if (this.server) return this.syncAllProjects()
    this.epoch += 1
    this.token = randomBytes(24).toString('hex')
    this.server = createServer((request, response) => {
      const task = this.handle(request, response)
      this.requests.add(task)
      void task.finally(() => this.requests.delete(task))
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address()
        if (typeof address === 'object' && address) this.port = address.port
        resolve()
      })
    })
    setBridgeEndpoint({ url: `http://127.0.0.1:${this.port}`, token: this.token })
    return this.syncAllProjects()
  }

  syncAllProjects(): ProjectSyncResult[] {
    return this.projects.list().map(project => {
      try {
        this.syncProject(project)
        return { projectId: project.id, rootPath: project.rootPath, ok: true, error: null }
      } catch (error) {
        return { projectId: project.id, rootPath: project.rootPath, ok: false, error: projectHealthError(error) }
      }
    })
  }

  /** Direct calls still fail explicitly (e.g. newly-created projects); batch startup isolates failures. */
  syncProject(project: Project): void {
    if (!this.port) return
    try {
      assertProjectRootAvailable(project)
      this.projectHealth?.assertAvailable(project.id)
      assertProjectPathSafe(project, '.research', 'directory')
      assertProjectPathSafe(project, '.research/bridge.json', 'file')
      ensureDir(join(project.rootPath, '.research'))
      writeBridgeConfig(project.rootPath, { port: this.port, token: this.token, projectId: project.id })
    } catch (error) {
      this.projectHealth?.recordFailure(project, error)
      throw error
    }
  }

  private assertProjectAvailable(projectId: string): void {
    if (this.projectHealth) this.projectHealth.assertAvailable(projectId)
    else assertProjectRootAvailable(this.projects.get(projectId))
  }

  private json(response: ServerResponse, status: number, payload: unknown): void {
    if (response.destroyed || response.writableEnded) return
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(`${JSON.stringify(payload)}\n`)
  }

  private async readBody(request: IncomingMessage): Promise<RpcBody> {
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.byteLength
      if (size > MAX_BODY) throw new Error('请求体过大。')
      chunks.push(buffer)
    }
    if (chunks.length === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcBody
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const epoch = this.epoch
    const assertSession = (): void => {
      if (!this.isAuthorized() || epoch !== this.epoch || !this.token) {
        throw new Error('登录会话已失效，请重新登录后重试。')
      }
    }
    try {
      if (request.method === 'GET' && request.url === '/health') {
        this.json(response, 200, { ok: true, name: 'ResearchPilot', port: this.port })
        return
      }
      if (request.method === 'POST' && request.url === '/mcp') {
        await this.handleMcp(request, response, assertSession)
        return
      }
      if (request.method !== 'POST' || !['/rpc', '/agent/stream', '/agent/approval'].includes(request.url ?? '')) {
        this.json(response, 404, { ok: false, error: '未知接口。' })
        return
      }
      if (!this.isAuthorized()) {
        this.json(response, 401, { ok: false, error: '请先登录 ResearchPilot。' })
        return
      }
      const authorization = request.headers.authorization ?? ''
      if (!this.token || authorization !== `Bearer ${this.token}`) {
        this.json(response, 401, { ok: false, error: '桥接令牌无效。' })
        return
      }
      const body = await this.readBody(request) as RpcBody & { sessionId?: string; toolName?: string; callId?: string; reason?: string; details?: string; displayReason?: unknown; frame?: unknown }
      assertSession()
      const projectId = body.projectId ?? ''
      if (!projectId) throw new Error('缺少项目 ID。')
      this.projects.get(projectId)

      if (request.url === '/agent/stream') {
        if (!body.sessionId || !body.frame) throw new Error('缺少流式会话或帧。')
        emitEvent({ type: 'agent-stream', projectId, sessionId: body.sessionId, frame: body.frame as import('@shared/types').AgentStreamFrame })
        this.json(response, 200, { ok: true })
        return
      }

      if (request.url === '/agent/approval') {
        this.assertProjectAvailable(projectId)
        const toolName = asString(body.toolName, 'tool')
        const risky = ['pwsh', 'bash', 'write', 'edit', 'subagent', 'workflow'].includes(toolName)
        const displayReason = body.displayReason && typeof body.displayReason === 'object'
          ? body.displayReason as { zh?: unknown; en?: unknown }
          : undefined
        const description = asString(displayReason?.zh) || body.reason || '该工具操作需要你的确认。'
        const detailText = asString(body.details) || body.reason || ''
        const decision = await this.approvals.request({
          origin: 'agent',
          title: `智能体请求执行工具：${toolName}`,
          description,
          risk: risky ? 'high' : 'medium',
          details: [toolName, detailText].filter(Boolean).join(String.fromCharCode(10))
        })
        assertSession()
        if (decision.approved) this.assertProjectAvailable(projectId)
        this.json(response, 200, { ok: true, decision: decision.approved ? 'allowed-once' : 'rejected' })
        return
      }

      const method = asString(body.method)
      const assertOperation = (): void => {
        assertSession()
        if (!READ_ONLY_RPC_METHODS.has(method)) this.assertProjectAvailable(projectId)
      }
      assertOperation()
      const result = await this.dispatch(method, body.params ?? {}, projectId, assertOperation)
      assertSession()
      this.json(response, 200, { ok: true, result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.json(response, 400, { ok: false, error: message })
    }
  }

  private async handleMcp(request: IncomingMessage, response: ServerResponse, assertSession: () => void): Promise<void> {
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, '')
    const grant = this.mcpGrants.get(token)
    if (!this.isAuthorized() || !grant) { this.json(response, 401, { ok: false, error: 'MCP 会话无效或已撤销。' }); return }
    const controller = new AbortController()
    const cancel = (): void => { if (!response.writableEnded) controller.abort() }
    response.once('close', cancel)
    const timer = setTimeout(() => controller.abort(), MCP_LIMITS.actionTimeoutMs)
    this.mcpRequests.set(controller, token)
    try {
      const body = await this.readBody(request) as RpcBody & { tool?: string; serverId?: string }
      const assertScope = (): void => {
        controller.signal.throwIfAborted()
        assertSession()
        if (body.projectId !== grant.projectId || body.serverId !== grant.serverId || !this.mcpGrants.has(token)) throw new Error('MCP 项目或服务范围不匹配。')
      }
      assertScope()
      const name = asString(body.tool)
      const args = validateMcpArguments(grant.serverId, name, body.params ?? {})
      const mutatesProject = isMcpAction(grant.serverId, name) && !['literature_search', 'journal_guidelines_fetch'].includes(name)
      const assertOperation = (): void => {
        assertScope()
        if (mutatesProject) this.assertProjectAvailable(grant.projectId)
      }
      assertOperation()
      const result = isMcpAction(grant.serverId, name)
        ? await this.dispatchMcpAction(name, args, grant.projectId, assertOperation, controller.signal)
        : await new McpToolService({ projects: this.projects, documents: this.documents, references: this.references, experiments: this.experiments, figures: this.figures }).call(grant.serverId, name, args, grant.projectId, controller.signal)
      assertScope()
      if (Buffer.byteLength(JSON.stringify(result)) > MCP_LIMITS.responseBytes) throw new Error('工具结果超过上限，请减少返回数量。')
      this.json(response, 200, { ok: true, result })
    } catch (error) {
      // Only bounded validation messages leave this endpoint; never leak paths, tokens or file contents via logs.
      const message = error instanceof Error ? error.message : 'MCP 工具调用失败。'
      const safe = /ENOENT|EACCES|EPERM|ENOTDIR|SyntaxError|Unexpected token|JSON at position/i.test(message) ? '项目文件不可读、缺失或格式无效。' : message.slice(0, 300)
      this.json(response, 400, { ok: false, error: safe.replaceAll(token, '[redacted]') })
    } finally { clearTimeout(timer); response.off('close', cancel); this.mcpRequests.delete(controller) }
  }

  private async dispatchMcpAction(name: string, args: Params, projectId: string, assertScope: () => void, signal: AbortSignal): Promise<unknown> {
    const project = this.projects.get(projectId)
    const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
    const approve = async (title: string, description: string, details: string, risk: 'medium' | 'high' = 'medium'): Promise<void> => {
      const decision = await this.approvals.request({ origin: 'agent', title, description, details: `项目：${project.name} (${projectId})\n${details}`, risk }, { signal, remember: false })
      assertScope()
      if (!decision.approved) throw new Error('用户拒绝了 MCP 操作。')
    }
    if (name === 'project_artifact_write') {
      const path = mcpArtifactPath(project.rootPath, String(args.path), true)
      const content = String(args.content)
      if (Buffer.byteLength(content, 'utf8') > 240_000) throw new Error('产物内容超过 240 KB 上限。')
      if (path.toLowerCase().endsWith('.json')) JSON.parse(content)
      const before = existsSync(figurePath(project.rootPath, path)) ? hash(readMcpFile(project.rootPath, path)) : null
      await approve(`MCP 写入项目产物：${path}`, '仅写入当前项目的受限文本产物，不执行代码。覆盖已有文件时将检查确认期间内容未变化。', `路径：${path}\n内容 SHA-256：${hash(Buffer.from(content))}\n替换已有文件：${before ? '是' : '否'}\n内容预览：\n${content.slice(0, 4000)}`)
      const current = existsSync(figurePath(project.rootPath, path)) ? hash(readMcpFile(project.rootPath, path)) : null
      if (current !== before) throw new Error('产物在确认期间发生变化，请重新检查并授权。')
      return writeMcpArtifact(project.rootPath, path, content)
    }
    if (name === 'experiment_create') {
      const code = requiredString(args.code, 'code'), experimentName = requiredString(args.name, 'name')
      figurePath(project.rootPath, 'experiments')
      const codeSha256 = hash(Buffer.from(code))
      await approve(`MCP 创建本地实验：${experimentName}`, '将智能体编写的 Python 源代码登记为新实验。本次仅创建，不运行；运行需要另一次确认。', `名称：${experimentName}\n代码 SHA-256：${codeSha256}\n代码预览（最多 4000 字符）：\n${code.slice(0, 4000)}`, 'high')
      figurePath(project.rootPath, 'experiments')
      const experiment = this.experiments.create({ projectId, name: experimentName, description: asString(args.description), code, envKind: 'local' })
      return { id: experiment.id, name: experiment.name, entryFile: experiment.entryFile, envKind: experiment.envKind, codeSha256, executed: false }
    }
    if (name === 'journal_guidelines_fetch') {
      const url = requiredString(args.url, 'url')
      await approve('MCP 获取期刊作者指南', '只向指定公网HTTPS地址请求指南，不携带项目内容、API Key或浏览器登录信息。网页内容仅作为来源资料，不执行脚本。', `URL：${url}\n重定向不自动跟随；最大 2 MiB。`)
      const result = await fetchJournalGuidelines(url, { signal })
      assertScope()
      return result
    }
    if (name === 'literature_search') {
      const query = requiredString(args.query, 'query')
      await approve('MCP 向 Crossref 检索文献', '仅将检索词发送至 Crossref；返回真实书目元数据，不代表已阅读全文或核实科学主张。', `检索词：${query}\n上限：${args.limit ?? 10}`)
      const items = await searchCrossref(query, Number(args.limit ?? 10), signal)
      assertScope()
      return { provider: 'Crossref', query, retrievedAt: new Date().toISOString(), items: items.map(item => ({ ...item, abstract: item.abstract.slice(0, 12_000) })), limitation: 'Bibliographic metadata only. Missing abstracts/full text remain unknown; never infer paper results from a title.' }
    }
    if (name === 'reference_add_doi') {
      const doi = requiredString(args.doi, 'doi').trim().replace(/^https?:\/\/doi\.org\//i, '')
      if (!/^10\.\d{4,9}\/[^\s<>"#?]+$/i.test(doi)) throw new Error('DOI 格式无效。')
      await approve('MCP 从 Crossref 添加 DOI', '将 DOI 发送至 Crossref 并仅登记服务实际返回的元数据。来源真实性和句子支持仍需分别检查。', `DOI：${doi}`)
      const ref = await this.references.addFromDoi(projectId, doi, signal, assertScope)
      return { id: ref.id, title: ref.title, authors: ref.authors, year: ref.year, doi: ref.doi, abstract: ref.abstract.slice(0, 12_000), provider: 'Crossref', retrievedAt: new Date().toISOString(), bibliographicResolution: true, fullTextReviewed: false }
    }
    if (name === 'reference_save_reading_draft') {
      const referenceId = requiredString(args.referenceId, 'referenceId')
      const sourceHash = requiredString(args.sourceHash, 'sourceHash')
      const content = requiredString(args.content, 'content')
      const ref = this.references.get(projectId, referenceId)
      if (args.sourceCoverage !== 'abstract-only' || !ref.abstract.trim()) throw new Error('仅支持已有摘要的 abstract-only 阅读摘记；PDF 全文尚未解析。')
      if (sourceHash !== this.references.getReadingSourceHash(projectId, referenceId)) throw new Error('文献标题或摘要已变化，请重新读取后生成摘记。')
      await approve(`MCP 保存 AI 阅读摘记：${ref.title}`, '单独保存为 AI 草稿，不覆盖研究笔记。仅基于登记摘要，未读取 PDF 全文；请核查内容后再复制采用。', `来源：${referenceId}\n覆盖范围：abstract-only\n来源 SHA-256：${sourceHash}\n内容 SHA-256：${hash(Buffer.from(content))}\n内容预览（最多 4000 字符）：\n${content.slice(0, 4000)}`)
      const draft = this.references.saveReadingDraft(projectId, { referenceId, sourceHash, content, sourceCoverage: 'abstract-only' })
      emitEvent({ type: 'reference-reading-draft', projectId, referenceId })
      return draft
    }
    if (name === 'manuscript_write') {
      const markdown = requiredString(args.markdown, 'markdown')
      const document = args.id ? this.documents.get(projectId, String(args.id)) : undefined
      const title = document?.title || requiredString(args.title, 'title')
      figurePath(project.rootPath, document?.relativePath || 'manuscripts')
      const previousHash = document ? hash(readMcpFile(project.rootPath, document.relativePath, 16 * 1024 * 1024)) : null
      await approve(`MCP 写入文稿：${title}`, '以提交的内容创建或替换项目文稿。DOCX 由原生转换器生成；不执行 Shell，不编译 TeX。', `文稿 ID：${document?.id || '(新建 DOCX)'}\n内容 SHA-256：${hash(Buffer.from(markdown))}\n内容预览：\n${markdown.slice(0, 4000)}`)
      figurePath(project.rootPath, document?.relativePath || 'manuscripts')
      if (document && hash(readMcpFile(project.rootPath, document.relativePath, 16 * 1024 * 1024)) !== previousHash) throw new Error('文稿在确认期间发生变化，请重新检查并授权。')
      const result = document
        ? document.format === 'docx' ? await this.documents.writeMarkdown(projectId, document.id, markdown, assertScope) : this.documents.saveText(projectId, document.id, markdown)
        : await this.documents.create({ projectId, title, format: 'docx', markdown }, assertScope)
      assertScope()
      return { id: result.id, title: result.title, format: result.format, path: result.relativePath, wordCount: result.wordCount, compiled: false }
    }
    if (name === 'experiment_run') {
      const experiment = this.resolveExperiment(projectId, { id: args.experimentId })
      if (experiment.envKind !== 'local') throw new Error('MCP 快速运行仅支持已有本地实验，不支持 SSH。')
      const pythonPath = this.settings.get().pythonPath.trim()
      if (!pythonPath) throw new Error('请先在设置中指定已安装的本地 Python；此工具不自动安装解释器或依赖。')
      if (!experiment.entryFile.replaceAll('\\', '/').startsWith('experiments/')) throw new Error('实验入口不在项目 experiments 目录。')
      if (this.mcpExperiments.has(experiment.id) || this.experiments.runs(experiment.id).some(run => ['running', 'queued'].includes(run.status))) throw new Error('该实验已有运行或待确认请求，请等待完成。')
      this.mcpExperiments.add(experiment.id)
      let runId = ''
      let timer: NodeJS.Timeout | undefined
      const stop = (): void => {
        if (!runId) return
        try { this.runner.stop(runId) } catch { /* already completed */ }
      }
      try {
        const before = readMcpFile(project.rootPath, experiment.entryFile, 512 * 1024)
        const codeHash = hash(before)
        const seconds = Number(args.timeoutSeconds ?? 60)
        const decision = await this.approvals.request({ origin: 'agent', title: `MCP 运行本地实验：${experiment.name}`, description: '将在应用的本地 Python 中执行已注册代码（不是操作系统沙箱）。代码可能读写文件或联网；仅在你确认代码可信时允许。不会自动安装依赖。', risk: 'high', details: `项目：${project.name} (${projectId})\n实验：${experiment.id}\n入口：${experiment.entryFile}\nPython：${pythonPath}\n代码 SHA-256：${codeHash}\n执行上限：${seconds} 秒\n代码预览（最多 4000 字符）：\n${before.toString('utf8').slice(0, 4000)}` }, { signal, remember: false })
        assertScope()
        if (!decision.approved) throw new Error('用户拒绝了 MCP 实验运行。')
        const current = this.resolveExperiment(projectId, { id: experiment.id })
        if (current.envKind !== 'local' || current.entryFile !== experiment.entryFile || this.settings.get().pythonPath.trim() !== pythonPath || hash(readMcpFile(project.rootPath, current.entryFile, 512 * 1024)) !== codeHash) throw new Error('实验代码、环境或入口在确认期间发生变化；请重新检查并授权。')
        if (this.experiments.runs(experiment.id).some(run => ['running', 'queued'].includes(run.status))) throw new Error('该实验已由其他操作启动，请勿重复运行。')
        assertScope()
        const started = await this.runner.start(experiment.id)
        runId = started.id
        signal.addEventListener('abort', stop, { once: true })
        if (signal.aborted) stop()
        timer = setTimeout(stop, seconds * 1000)
        const run = await this.runner.waitForRun(runId, (seconds + 5) * 1000)
        assertScope()
        return { id: run.id, experimentId: run.experimentId, status: run.status, exitCode: run.exitCode, startedAt: run.startedAt, finishedAt: run.finishedAt, artifactDir: run.artifactDir, codeSha256: codeHash, note: 'Read experiment_runs/run_reproducibility for bounded metrics and provenance. A successful process exit is not scientific validation.' }
      } finally { if (timer) clearTimeout(timer); signal.removeEventListener('abort', stop); this.mcpExperiments.delete(experiment.id) }
    }
    if (name === 'figure_create_from_spec' || name === 'figure_create_spec') {
      const experiment = this.resolveExperiment(projectId, { id: args.experimentId })
      const path = name === 'figure_create_from_spec' ? String(args.path).replaceAll('\\', '/') : ''
      if (path && (!path.startsWith('figures/') || !path.toLowerCase().endsWith('.json') || path.split('/').some(part => part.startsWith('.')))) throw new Error('图表源必须是 figures 目录下的非隐藏 JSON 文件。')
      const before = path ? readMcpFile(project.rootPath, path, FIGURE_LIMITS.sourceBytes) : Buffer.from(JSON.stringify(args.spec))
      if (before.length > FIGURE_LIMITS.sourceBytes) throw new Error('图表源超过大小上限。')
      const sourceHash = hash(before)
      const spec = validateFigureSpec(JSON.parse(before.toString('utf8').replace(/^﻿/, '')))
      const decision = await this.approvals.request({ origin: 'agent', title: `MCP 创建可编辑图表：${asString(args.name) || spec.title}`, description: '将从已验证的声明式 JSON 创建并登记结构化图表，写入 JSON、SVG 与原生 PPTX。不会执行脚本或访问网络。请核对数据来源和关联实验。', risk: 'medium', details: `项目：${project.name} (${projectId})\n实验：${experiment.id}\n源文件：${path}\n源 SHA-256：${sourceHash}\n类型：${spec.kind}\n来源：${spec.provenance.sourceLabel}\n演示数据：${spec.provenance.isDemo ? '是' : '否'}` }, { signal, remember: false })
      assertScope()
      if (!decision.approved) throw new Error('用户拒绝了 MCP 图表创建。')
      this.resolveExperiment(projectId, { id: experiment.id })
      if (path && hash(readMcpFile(project.rootPath, path, FIGURE_LIMITS.sourceBytes)) !== sourceHash) throw new Error('图表源在确认期间发生变化，请重新检查并授权。')
      const figure = await this.figures.createStructured({ projectId, name: asString(args.name) || undefined, caption: asString(args.caption), experimentId: experiment.id, spec })
      assertScope()
      return { id: figure.id, name: figure.name, experimentId: figure.experimentId, modelKind: figure.modelKind, filePath: figure.filePath, sourcePath: figure.sourcePath, pptxPath: figure.pptxPath, sourceSha256: sourceHash }
    }
    throw new Error('此 MCP 动作未被允许。')
  }

  private async dispatch(method: string, params: Params, projectId: string, assertSession: () => void): Promise<unknown> {
    assertSession()
    switch (method) {
      case 'status': {
        const project = this.projects.get(projectId)
        return {
          project: { id: project.id, name: project.name, root: project.rootPath },
          counts: {
            documents: this.documents.list(projectId).length,
            references: this.references.list(projectId).length,
            experiments: this.experiments.list(projectId).length,
            figures: this.figures.list(projectId).length
          },
          runningExperiments: this.runner.runningCount(),
          commands: {
            docs: ['docs list', 'docs read --id <id>', 'docs create --title <title> --format latex|docx', 'docs write --id <id> --file <path>'],
            refs: ['refs list', 'refs search --query <query>', 'refs add --doi <doi>'],
            exps: ['exps list', 'exps create --name <name> --code-file <path>', 'exps run --id <id> --timeout 3600', 'exps status --id <id>'],
            figs: ['figs list', 'figs create --spec-file <project-relative.json>', 'figs get --id <id>', 'figs update --id <id> --spec-file <project-relative.json>', 'figs export --id <id> --format pptx', 'figs render --name <name> --code-file <path> (legacy raster)']
          }
        }
      }

      case 'docs.list':
        return this.documents.list(projectId)
      case 'docs.read': {
        const doc = this.resolveDocument(projectId, params)
        const text = doc.format === 'latex' ? this.documents.readSource(projectId, doc.id) : (await this.documents.readText(projectId, doc.id)).text
        return { document: doc, text }
      }
      case 'docs.create': {
        const title = requiredString(params.title, 'title')
        const format = params.format === 'latex' ? 'latex' : 'docx'
        return this.documents.create({ projectId, title, format }, assertSession)
      }
      case 'docs.write':
        return this.writeDocument(projectId, params, assertSession)
      case 'docs.compile': {
        const doc = this.resolveDocument(projectId, params)
        return this.documents.compile(projectId, doc.id)
      }

      case 'refs.list':
        return this.references.list(projectId, asString(params.query))
      case 'refs.search': {
        const query = requiredString(params.query, 'query')
        const approval = await this.approvals.request({ origin: 'agent', title: '向 Crossref 检索文献', description: '此操作会将检索词发送至外部 Crossref 服务；可改用本地文献库。', risk: 'medium', details: query })
        assertSession()
        if (!approval.approved) throw new Error('用户拒绝了外部文献检索。')
        return searchCrossref(query, Math.min(100, Math.max(1, Number(params.rows) || 10)))
      }
      case 'refs.add': {
        const doi = asString(params.doi)
        if (doi) {
          const approval = await this.approvals.request({ origin: 'agent', title: '从 Crossref 获取 DOI 元数据', description: '此操作会将 DOI 发送至外部 Crossref 服务。', risk: 'medium', details: doi })
          assertSession()
          if (!approval.approved) throw new Error('用户拒绝了外部 DOI 查询。')
          return this.references.addFromDoi(projectId, doi, undefined, assertSession)
        }
        return this.references.upsert({
          projectId,
          title: requiredString(params.title, 'title'),
          authors: asString(params.authors),
          year: asString(params.year),
          venue: asString(params.venue),
          doi: asString(params.doi),
          url: asString(params.url),
          abstract: asString(params.abstract),
          notes: asString(params.notes)
        })
      }
      case 'refs.export':
        return { path: this.references.writeBibtexFile(projectId) }

      case 'exps.list':
        return this.experiments.list(projectId)
      case 'exps.create': {
        const name = requiredString(params.name, 'name')
        const code = this.readCodeParam(projectId, params)
        return this.experiments.create({
          projectId,
          name,
          description: asString(params.description),
          envKind: params.remote === true ? 'ssh' : 'local',
          sshHostId: asString(params.sshHostId),
          code
        })
      }
      case 'exps.run': {
        const experiment = this.resolveExperiment(projectId, params)
        const remote = experiment.envKind === 'ssh'
        const approval = await this.approvals.request({
          origin: 'agent',
          title: `运行实验：${experiment.name}`,
          description: remote ? '该实验将在远程 SSH 主机上执行。' : '该实验将在本地 Python 环境中执行。',
          risk: remote ? 'high' : 'medium',
          details: [
            `实验 ID：${experiment.id}`,
            `代码：${experiment.entryFile}`,
            remote ? `SSH 主机：${experiment.sshHostId}` : '执行位置：本地项目工作区'
          ].join('\n')
        })
        assertSession()
        if (!approval.approved) throw new Error('用户拒绝了运行实验的请求。')
        const timeoutMs = Math.max(30_000, Math.min(24 * 60 * 60 * 1000, Number(params.timeout) * 1000 || 15 * 60 * 1000))
        return this.runner.runAndWait(experiment.id, timeoutMs)
      }
      case 'exps.status': {
        if (typeof params.runId === 'string' && params.runId) return this.resolveRun(projectId, params.runId)
        const experiment = this.resolveExperiment(projectId, params)
        if (!experiment.lastRunId) return null
        return this.experiments.getRun(experiment.lastRunId)
      }
      case 'exps.logs': {
        const run = typeof params.runId === 'string'
          ? this.resolveRun(projectId, params.runId)
          : this.resolveRun(projectId, this.resolveExperiment(projectId, params).lastRunId)
        return { stdout: run.stdout, stderr: run.stderr, metrics: run.metrics, status: run.status }
      }

      case 'figs.list':
        return this.figures.list(projectId)
      case 'figs.get':
        return this.figures.getStructured(projectId, requiredString(params.id, 'id'))
      case 'figs.create':
        return this.figures.createStructured({
          projectId,
          name: asString(params.name) || undefined,
          caption: asString(params.caption),
          experimentId: asString(params.experimentId),
          spec: this.readSpecParam(projectId, params)
        })
      case 'figs.update':
        return this.figures.saveStructured(projectId, requiredString(params.id, 'id'), this.readSpecParam(projectId, params))
      case 'figs.export': {
        if (params.format !== undefined && params.format !== 'pptx') throw new Error('结构化图表目前支持原生可编辑 pptx 导出；SVG 预览会随保存生成。')
        return this.figures.exportPptx(projectId, requiredString(params.id, 'id'))
      }
      case 'evidence.report':
        return this.evidence.generate(this.projects.get(projectId))
      case 'figs.render': {
        const name = requiredString(params.name, 'name')
        const code = this.readCodeParam(projectId, params)
        const approval = await this.approvals.request({
          origin: 'agent',
          title: `渲染图表：${name}`,
          description: '将在本地 Python 环境中执行绘图脚本。',
          risk: 'medium',
          details: code.slice(0, 4000)
        })
        assertSession()
        if (!approval.approved) throw new Error('用户拒绝了渲染图表的请求。')
        return this.figures.render({
          projectId,
          name,
          code,
          experimentId: asString(params.experimentId),
          caption: asString(params.caption)
        })
      }

      case 'ssh.list':
        return this.ssh.list()
      case 'ssh.exec': {
        const hostParam = requiredString(params.host, 'host')
        const host = this.ssh.list().find((item) => item.id === hostParam || item.name === hostParam)
        if (!host) throw new Error('SSH 主机不存在。')
        const command = requiredString(params.command, 'command')
        const approval = await this.approvals.request({
          origin: 'agent',
          title: `SSH 远程命令：${host.name}`,
          description: '该命令将在远程主机上执行。',
          risk: 'high',
          details: `主机：${host.username}@${host.host}:${host.port}\n命令：${command.slice(0, 4000)}`
        })
        assertSession()
        if (!approval.approved) throw new Error('用户拒绝了远程命令。')
        return this.ssh.exec(host.id, command, { timeoutMs: Math.min(30 * 60 * 1000, Number(params.timeout) * 1000 || 5 * 60 * 1000) })
      }

      default:
        throw new Error(`未知桥接方法：${method}`)
    }
  }

  private resolveDocument(projectId: string, params: Params): DocumentRecord {
    const id = asString(params.id) || asString(params.documentId)
    if (id) return this.documents.get(projectId, id)
    const title = asString(params.title)
    if (!title) throw new Error('请提供文档 id 或 title。')
    const found = this.documents.list(projectId).find((doc) => doc.title === title || doc.title.includes(title))
    if (!found) throw new Error(`未找到文档：${title}`)
    return found
  }

  private resolveExperiment(projectId: string, params: Params) {
    const id = asString(params.id) || asString(params.experimentId)
    if (id) {
      const experiment = this.experiments.get(id)
      if (experiment.projectId !== projectId) throw new Error('实验不属于当前项目。')
      return experiment
    }
    const name = asString(params.name)
    if (!name) throw new Error('请提供实验 id 或 name。')
    const found = this.experiments.list(projectId).find((experiment) => experiment.name === name || experiment.name.includes(name))
    if (!found) throw new Error(`未找到实验：${name}`)
    return found
  }

  private readCodeParam(projectId: string, params: Params): string {
    if (typeof params.code === 'string' && params.code.trim()) return params.code
    const file = asString(params.codeFile) || asString(params.file)
    if (!file) throw new Error('请提供 code 或 codeFile。')
    const project = this.projects.get(projectId)
    const abs = assertInside(project.rootPath, isAbsolute(file) ? file : resolve(project.rootPath, file))
    if (!existsSync(abs)) throw new Error(`代码文件不存在：${file}`)
    return readFileSync(abs, 'utf8')
  }

  private resolveRun(projectId: string, id: string) {
    const run = this.experiments.getRun(id)
    if (run.projectId !== projectId) throw new Error('运行记录不属于当前项目。')
    return run
  }

  private readSpecParam(projectId: string, params: Params): FigureSpec {
    let spec = params.spec
    if (typeof params.specFile === 'string' && params.specFile) {
      const root = this.projects.get(projectId).rootPath
      const path = assertInside(root, isAbsolute(params.specFile) ? params.specFile : resolve(root, params.specFile))
      if (!existsSync(path)) throw new Error('图表 spec JSON 文件不存在。')
      const realPath = assertInside(realpathSync(root), realpathSync(path))
      if (!statSync(realPath).isFile() || statSync(realPath).size > MAX_BODY) throw new Error('图表 spec 必须是小于 4 MB 的 JSON 文件。')
      const text = readFileSync(realPath, 'utf8')
      if (Buffer.byteLength(text) > MAX_BODY) throw new Error('图表 spec JSON 过大。')
      spec = JSON.parse(text.replace(/^﻿/, ''))
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('请提供 spec 对象或 --spec-file JSON 路径。')
    // FigureService validates the complete declarative schema; no script is evaluated.
    return spec as FigureSpec
  }

  private async writeDocument(projectId: string, params: Params, assertSession: () => void): Promise<DocumentRecord> {
    const doc = this.resolveDocument(projectId, params)
    let content = typeof params.content === 'string' ? params.content : ''
    const file = asString(params.file)
    const project = this.projects.get(projectId)
    const abs = file ? assertInside(project.rootPath, isAbsolute(file) ? file : resolve(project.rootPath, file)) : ''
    if (abs) {
      if (!existsSync(abs)) throw new Error(`内容文件不存在：${file}`)
      if (doc.format === 'docx' && abs.toLowerCase().endsWith('.docx')) {
        const base64 = readFileSync(abs).toString('base64')
        return this.documents.saveBinary(projectId, doc.id, base64)
      }
      content = readFileSync(abs, 'utf8')
    }
    if (!content) throw new Error('请提供 content 或 file。')
    if (params.mode === 'append') {
      const current = doc.format === 'latex' ? this.documents.readSource(projectId, doc.id) : (await this.documents.readText(projectId, doc.id)).text
      content = `${current.trimEnd()}\n\n${content}`
    }
    assertSession()
    if (doc.format === 'latex') {
      return this.documents.saveText(projectId, doc.id, content)
    }
    const buffer = await buildDocx({ title: doc.title, markdown: content })
    assertSession()
    return this.documents.saveBinary(projectId, doc.id, buffer.toString('base64'))
  }

  async stop(): Promise<void> {
    this.epoch += 1
    this.mcpGrants.clear()
    for (const controller of this.mcpRequests.keys()) controller.abort()
    this.token = ''
    this.port = 0
    setBridgeEndpoint({ url: '', token: '' })
    this.approvals.cancelAll()
    const server = this.server
    this.server = undefined
    server?.close()
    server?.closeAllConnections()
    await Promise.allSettled([...this.requests])
  }
}
