import { app, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import type { AppSettings, ApprovalDecision, DocumentCreateInput, ExperimentInput, FigureRenderInput, PipelineStartInput, ProviderInput, ReferenceInput, SkillInput, SkillScope, SshHostInput } from '@shared/types'
import { IPC } from '@shared/ipc'
import { emitEvent } from './lib/events'
import { commandExists } from './services/experiment-runner'
import { pythonCommandAvailable } from './lib/python-runtime'
import { inspectAttachments } from './services/attachments'
import { searchCrossref } from './services/references'
import { extractPdfPages } from './lib/research-sources'
import type { KnowledgeService } from './services/knowledge'
import type { KnowledgeSearchInput } from '@shared/knowledge'
import type { AgentService } from './services/agent'
import type { ApprovalService } from './services/approvals'
import type { BridgeService } from './services/bridge'
import type { ChatService } from './services/chats'
import type { DocumentService } from './services/documents'
import type { NoteService } from './services/notes'
import { parseNoteCreateInput, parseNoteListInput, parseNotePinInput, parseNoteTarget, parseNoteUpdateInput } from '@shared/notes'
import type { ExperimentRunner } from './services/experiment-runner'
import type { ExperimentService } from './services/experiments'
import type { FigureService } from './services/figures'
import type { PipelineService } from './services/pipeline'
import type { ProjectService } from './services/projects'
import type { ProviderService } from './services/providers'
import type { ReferenceService } from './services/references'
import type { SettingsService } from './services/settings'
import type { SshService } from './services/ssh'
import type { SkillService } from './services/skills'
import type { UsageService } from './services/usage'
import type { EvidenceService } from './services/evidence'
import type { LocalSessionService } from './services/auth'
import type { McpService } from './services/mcp'
import type { McpConfigureInput, McpTestInput } from '@shared/mcp'
import type { FigureSpec, FigureStructuredInput, FigureArtifact } from '@shared/figure-spec'

import type { PdfAnnotationService } from './services/pdf-annotations'
import type { PdfAnnotationCreate, PdfAnnotationUpdate, PdfScope } from '@shared/pdf-annotations'

import type { BackupService } from './services/backups'
import { backupId } from '@shared/backups'
import type { ProjectHealthService } from './services/project-health'

export interface Services {
  projectHealth: ProjectHealthService
  backups: BackupService
  pdfAnnotations: PdfAnnotationService
  settings: SettingsService
  providers: ProviderService
  projects: ProjectService
  documents: DocumentService
  notes: NoteService
  references: ReferenceService
  knowledge: KnowledgeService
  experiments: ExperimentService
  runner: ExperimentRunner
  figures: FigureService
  chats: ChatService
  agent: AgentService
  ssh: SshService
  skills: SkillService
  approvals: ApprovalService
  bridge: BridgeService
  pipeline: PipelineService
  usage: UsageService
  evidence: EvidenceService
  mcp: McpService
}

type TrustedSender = (event: Electron.IpcMainInvokeEvent) => boolean
let authorizeCall: ((event: Electron.IpcMainInvokeEvent) => () => void) | null = null

function handle<TArgs extends unknown[], TResult>(
  channel: string,
  fn: (...args: TArgs) => TResult | Promise<TResult>
): void {
  // The readiness guard rejects new work during initialization and teardown; leases retain in-flight work.
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (event, ...args: TArgs) => {
    let release: (() => void) | undefined
    try {
      if (!authorizeCall) throw new Error('本地工作区尚未就绪或正在关闭。')
      release = authorizeCall(event)
      return await fn(...args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(message)
    } finally { release?.() }
  })
}

export function registerAuthIpc(localSession: LocalSessionService, isTrusted: TrustedSender): void {
  ipcMain.handle(IPC.authStatus, (event) => {
    if (!isTrusted(event)) throw new Error('拒绝来自非应用窗口的请求。')
    return localSession.status()
  })
}

export function registerIpc(services: Services, localSession: LocalSessionService, isTrusted: TrustedSender): void {
  authorizeCall = (event) => {
    if (!isTrusted(event)) throw new Error('拒绝来自非应用窗口的请求。')
    return localSession.authorize()
  }
  const { settings, providers, projects, documents, references, experiments, runner, figures, chats, agent, ssh, approvals, bridge, pipeline, skills, usage, evidence, projectHealth } = services
  const assertProject = (projectId: string): void => projectHealth.assertAvailable(projectId)
  const projectWrite = <T>(projectId: string, action: () => T): T => { assertProject(projectId); return action() }
  const experimentWrite = <T>(id: string, action: () => T): T => projectWrite(experiments.get(id).projectId, action)
  const skillWrite = <T>(projectId: string, scope: string, action: () => T): T => scope === 'project' ? projectWrite(projectId, action) : action()
  const prepareProject = (projectId: string) => {
    let health = projectHealth.retry(projectId)
    if (health.available) {
      try { bridge.syncProject(projects.get(projectId)) }
      catch (error) { health = projectHealth.recordFailure(projects.get(projectId), error) }
    }
    return health
  }
  handle('project:health', () => projectHealth.list())
  handle('project:retry', (projectId: string) => {
    if (agent.isRunning() || runner.runningCount() || pipeline.isRunning() || bridge.isBusy()) throw new Error('请先停止正在运行的研究任务后重试项目初始化。')
    return prepareProject(projectId)
  })

  handle(IPC.bootstrap, async () => {
    const appSettings = settings.get()
    const list = projects.list()
    const activeProjectId = settings.getActiveProjectId() || list[0]?.id || ''
    if (activeProjectId && !list.some((project) => project.id === activeProjectId)) settings.setActiveProjectId('')
    const resolvedActive = settings.getActiveProjectId() || list[0]?.id || ''
    return {
      version: app.getVersion(),
      settings: appSettings,
      projects: list,
      projectHealth: projectHealth.list(),
      providers: providers.list(),
      sshHosts: ssh.list(),
      activeProjectId: resolvedActive,
      hasDeepSeekKey: providers.list().some((provider) => provider.hasApiKey),
      latexAvailable: documents.latexAvailable(),
      uvAvailable: commandExists('uv'),
      pythonAvailable: appSettings.pythonPath.trim() ? pythonCommandAvailable(appSettings.pythonPath.trim()) : ['python', 'python3', 'py'].some(pythonCommandAvailable)
    }
  })

  handle(IPC.mcpList, (projectId?: string) => services.mcp.list(projectId))
  handle(IPC.mcpConfigure, (input: McpConfigureInput) => {
    if (agent.isRunning()) throw new Error('智能体正在运行，请先停止后再修改 MCP 设置。')
    return services.mcp.configure(input)
  })
  handle(IPC.mcpTest, (input: McpTestInput) => services.mcp.test(input))
  handle(IPC.mcpDisconnect, (input: McpTestInput) => services.mcp.disconnect(input))

  handle(IPC.chooseDirectory, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  handle(IPC.chooseFile, async (filters?: Array<{ name: string; extensions: string[] }>) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: filters?.length ? filters : [{ name: '所有文件', extensions: ['*'] }]
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  handle(IPC.chooseAttachments, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择要交给智能体的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '研究资料', extensions: ['pdf', 'docx', 'md', 'txt', 'csv', 'json', 'jsonl', 'yaml', 'yml', 'xlsx', 'py', 'ipynb', 'tex', 'bib', 'png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? [] : inspectAttachments(result.filePaths)
  })

  handle(IPC.inspectAttachments, async (paths: string[]) => inspectAttachments(paths))

  handle(IPC.openPath, async (path: string) => {
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })

  handle(IPC.openExternal, async (url: string) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('仅允许打开 HTTP(S) 链接。')
    await shell.openExternal(url)
  })

  handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    node: process.versions.node ?? '',
    chrome: process.versions.chrome ?? '',
    platform: process.platform
  }))

  handle(IPC.backupExportProject, async (projectId: string) => {
    backupId(projectId)
    projects.get(projectId)
    const choice = await dialog.showSaveDialog({ title: '导出项目研究资料备份（不含密钥和聊天）', defaultPath: `researchpilot-${new Date().toISOString().slice(0, 10)}.rpbackup`, filters: [{ name: 'ResearchPilot 项目备份', extensions: ['rpbackup'] }] })
    if (choice.canceled || !choice.filePath) return null
    // Service uses exclusive creation even if the native dialog allowed replacement.
    return services.backups.exportProject(projectId, choice.filePath)
  })
  handle(IPC.backupInspect, async () => {
    services.backups.dispose()
    const choice = await dialog.showOpenDialog({ title: '检查项目备份（下一步确认后恢复为副本）', properties: ['openFile'], filters: [{ name: 'ResearchPilot 项目备份', extensions: ['rpbackup'] }] })
    if (choice.canceled || !choice.filePaths[0]) return null
    return services.backups.inspect(choice.filePaths[0])
  })
  handle(IPC.backupRestoreCopy, (token: string) => {
    const restored = services.backups.restoreCopy(token)
    const project = projects.get(restored.projectId)
    const health = prepareProject(project.id)
    emitEvent({ type: 'project-updated', project })
    return health.available ? restored : { ...restored, warnings: [...restored.warnings, `资料已恢复，但项目初始化未完成（${health.error?.code}）：${health.error?.message}。请在使用准备检查中重试。`] }
  })

  handle(IPC.projectList, () => projects.list())
  handle(IPC.projectCreate, async (input: { name: string; description?: string }) => {
    const project = projects.create(input)
    bridge.syncProject(project)
    return project
  })
  handle(IPC.projectUpdate, (input: { id: string; name?: string; description?: string; archived?: boolean }) => projects.update(input.id, input))
  handle(IPC.projectDelete, async (input: { id: string; deleteFiles?: boolean }) => {
    if (input.deleteFiles) {
      const result = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['取消', '永久删除项目文件'],
        defaultId: 0,
        cancelId: 0,
        title: '删除项目',
        message: '这会永久删除项目目录中的全部文件。',
        detail: '会话数据库记录也会被删除，但应用级设置与模型密钥会保留。'
      })
      if (result.response !== 1) return
    }
    if (agent.isRunning()) throw new Error('智能体正在运行，请先停止后再删除项目。')
    projects.delete(input.id, input.deleteFiles)
  })
  handle(IPC.projectOverview, (projectId: string) => projects.overview(projectId))
  handle(IPC.projectSetActive, (projectId: string) => {
    if (agent.isRunning()) throw new Error('智能体正在运行，请先停止后再切换项目。')
    projects.get(projectId)
    settings.setActiveProjectId(projectId)
  })
  handle(IPC.projectReveal, async (projectId: string) => {
    const project = projects.get(projectId)
    const error = await shell.openPath(project.rootPath)
    if (error) throw new Error(error)
  })

  // Validate the untrusted IPC payload before calling any notes operation.
  handle(IPC.noteList, (input: unknown) => {
    const { projectId, options } = parseNoteListInput(input)
    return services.notes.list(projectId, options)
  })
  handle(IPC.noteCreate, (input: unknown) => services.notes.create(parseNoteCreateInput(input)))
  handle(IPC.noteGet, (input: unknown) => {
    const { projectId, id } = parseNoteTarget(input)
    return services.notes.get(projectId, id)
  })
  handle(IPC.noteUpdate, (input: unknown) => services.notes.update(parseNoteUpdateInput(input)))
  handle(IPC.noteSetPinned, (input: unknown) => {
    const { projectId, id, pinned } = parseNotePinInput(input)
    return services.notes.setPinned(projectId, id, pinned)
  })
  handle(IPC.noteTrash, (input: unknown) => {
    const { projectId, id } = parseNoteTarget(input)
    return services.notes.trash(projectId, id)
  })
  handle(IPC.noteRestore, (input: unknown) => {
    const { projectId, id } = parseNoteTarget(input)
    return services.notes.restore(projectId, id)
  })
  handle(IPC.noteBacklinks, (input: unknown) => {
    const { projectId, id } = parseNoteTarget(input)
    return services.notes.backlinks(projectId, id)
  })

  handle(IPC.documentList, (projectId: string) => documents.list(projectId))
  handle(IPC.documentCreate, (input: DocumentCreateInput) => projectWrite(input.projectId, () => documents.create(input, () => assertProject(input.projectId))))
  handle(IPC.documentImport, async (projectId: string) => {
    assertProject(projectId)
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Word / LaTeX', extensions: ['docx', 'tex'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return projectWrite(projectId, () => documents.importFile(projectId, result.filePaths[0]))
  })
  handle(IPC.documentRead, (input: { projectId: string; id: string }) => documents.readBinary(input.projectId, input.id))
  handle(IPC.documentReadText, (input: { projectId: string; id: string }) => documents.readText(input.projectId, input.id))
  handle(IPC.documentSave, (input: { projectId: string; id: string; base64: string }) => {
    if (!input.base64 || input.base64.length > 80_000_000) throw new Error('文档内容异常或超过大小限制。')
    return projectWrite(input.projectId, () => documents.saveBinary(input.projectId, input.id, input.base64))
  })
  handle(IPC.documentSaveText, (input: { projectId: string; id: string; text: string }) => projectWrite(input.projectId, () => documents.saveText(input.projectId, input.id, input.text)))
  handle(IPC.documentVersions, (input: { projectId: string; id: string }) => documents.versions(input.projectId, input.id))
  handle(IPC.documentRestore, (input: { projectId: string; id: string; versionId: string }) => projectWrite(input.projectId, () => documents.restore(input.projectId, input.id, input.versionId)))
  handle(IPC.documentDelete, (input: { projectId: string; id: string }) => projectWrite(input.projectId, () => documents.delete(input.projectId, input.id)))
  handle(IPC.documentCompileLatex, (input: { projectId: string; id: string }) => projectWrite(input.projectId, () => documents.compile(input.projectId, input.id)))
  handle(IPC.documentReadPdf, (input: { projectId: string; id: string }) => documents.readPdf(input.projectId, input.id))
  handle(IPC.documentReveal, (input: { projectId: string; id: string }) => documents.reveal(input.projectId, input.id))

  handle(IPC.referenceList, (input: { projectId: string; query?: string }) => references.list(input.projectId, input.query))
  handle(IPC.referenceGetReadingDraft, (input: { projectId: string; id: string }) => references.getReadingDraft(input.projectId, input.id))
  handle(IPC.referenceUpsert, (input: ReferenceInput & { id?: string }) => references.upsert(input))
  handle(IPC.referenceDelete, (input: { projectId: string; id: string }) => references.delete(input.projectId, input.id))
  handle(IPC.referenceCrossref, (input: { query: string; rows?: number }) => searchCrossref(input.query, input.rows ?? 10))
  handle(IPC.referenceAddDoi, (input: { projectId: string; doi: string }) => projectWrite(input.projectId, () => references.addFromDoi(input.projectId, input.doi, undefined, () => assertProject(input.projectId))))
  handle(IPC.referenceImportBibtex, (input: { projectId: string; text: string }) => references.importBibtex(input.projectId, input.text))
  handle(IPC.referenceAttachPdf, async (input: { projectId: string; id: string }) => {
    assertProject(input.projectId)
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    return projectWrite(input.projectId, () => references.attachPdf(input.projectId, input.id, result.filePaths[0]))
  })
  handle('reference:fulltext', async (input: { projectId: string; id: string; startPage?: number; pageOffset?: number }) => {
    const data = references.readPdf(input.projectId, input.id)
    return extractPdfPages(Buffer.from(data.base64, 'base64'), { startPage: input.startPage ?? 1, pageOffset: input.pageOffset ?? 0, pageCount: 3, maxChars: 20000 })
  })
  handle(IPC.referenceReadPdf, (input: { projectId: string; id: string }) => references.readPdf(input.projectId, input.id))
  handle(IPC.pdfAnnotationOpen, (input: { projectId: string; referenceId: string }) => services.pdfAnnotations.open(input?.projectId, input?.referenceId))
  handle(IPC.pdfAnnotationList, (input: PdfScope) => services.pdfAnnotations.list(input))
  handle(IPC.pdfAnnotationCreate, (input: PdfAnnotationCreate) => services.pdfAnnotations.create(input))
  handle(IPC.pdfAnnotationUpdate, (input: PdfAnnotationUpdate) => services.pdfAnnotations.update(input))
  handle(IPC.pdfAnnotationDelete, (input: { scope: PdfScope; id: string }) => services.pdfAnnotations.remove(input?.scope, input?.id))

  handle(IPC.knowledgeSearch, (input: KnowledgeSearchInput) => services.knowledge.search(input))
  handle(IPC.knowledgeSync, (projectId: string) => services.knowledge.sync(projectId))
  handle(IPC.knowledgeStatus, (projectId: string) => services.knowledge.status(projectId))
  handle(IPC.knowledgeActivity, (input: { projectId: string; limit?: number }) => services.knowledge.activity(input))
  handle(IPC.knowledgeRead, (input: { projectId: string; referenceId: string }) => services.knowledge.recordRead(input.projectId, input.referenceId, 'reference_view'))

  handle(IPC.experimentList, (projectId: string) => experiments.list(projectId))
  handle(IPC.experimentCreate, (input: ExperimentInput) => projectWrite(input.projectId, () => experiments.create(input)))
  handle(IPC.experimentUpdate, (input: { id: string; name?: string; description?: string; envKind?: 'local' | 'ssh'; sshHostId?: string }) => experiments.update(input.id, input))
  handle(IPC.experimentDelete, (id: string) => experimentWrite(id, () => experiments.delete(id)))
  handle(IPC.experimentReadCode, (id: string) => experiments.readCode(id))
  handle(IPC.experimentSaveCode, (input: { id: string; code: string }) => experimentWrite(input.id, () => experiments.saveCode(input.id, input.code)))
  handle(IPC.experimentRun, (id: string) => experimentWrite(id, () => runner.start(id)))
  handle(IPC.experimentStop, (runId: string) => runner.stop(runId))
  handle(IPC.experimentRuns, (experimentId: string) => experiments.runs(experimentId))
  handle(IPC.experimentRunGet, (runId: string) => experiments.getRun(runId))
  handle(IPC.experimentOpenArtifact, (runId: string) => experiments.openArtifact(runId))

  handle(IPC.figureList, (projectId: string) => figures.list(projectId))
  handle(IPC.figureDelete, (input: { projectId: string; id: string }) => projectWrite(input.projectId, () => figures.delete(input.projectId, input.id)))
  handle(IPC.figureRender, (input: FigureRenderInput) => projectWrite(input.projectId, () => figures.render(input)))
  handle(IPC.figureCreateStructured, (input: FigureStructuredInput) => projectWrite(input.projectId, () => figures.createStructured(input)))
  handle(IPC.figureGetStructured, (input: { projectId: string; id: string }) => figures.getStructured(input.projectId, input.id))
  handle(IPC.figureSaveStructured, (input: { projectId: string; id: string; spec: FigureSpec }) => projectWrite(input.projectId, () => figures.saveStructured(input.projectId, input.id, input.spec)))
  handle(IPC.figureExportPptx, (input: { projectId: string; id: string }) => figures.exportPptx(input.projectId, input.id))
  handle(IPC.figureRead, (input: { projectId: string; id: string; artifact?: FigureArtifact }) => figures.read(input.projectId, input.id, input.artifact))
  handle(IPC.figureOpen, (input: { projectId: string; id: string; artifact?: FigureArtifact }) => figures.open(input.projectId, input.id, input.artifact))

  handle(IPC.chatList, (projectId: string) => chats.list(projectId))
  handle(IPC.chatCreate, (projectId: string) => {
    const appSettings = settings.get()
    const provider = providers.defaultProvider()
    return chats.create(projectId, provider?.id ?? appSettings.defaultProviderId, appSettings.defaultModelId || provider?.models[0]?.id || '')
  })
  handle(IPC.chatMessages, (chatId: string) => chats.messages(chatId))
  handle(IPC.chatSetModel, (input: { chatId: string; providerId: string; modelId: string }) => chats.setModel(input.chatId, input.providerId, input.modelId))
  handle(IPC.chatSend, (input: Parameters<AgentService['send']>[0]) => projectWrite(input.projectId, () => agent.send(input, () => assertProject(input.projectId))))
  handle(IPC.chatStop, () => agent.stop())
  handle(IPC.chatAgentState, () => agent.getState())
  handle(IPC.chatDelete, (id: string) => chats.delete(id))

  handle(IPC.providerList, () => providers.list())
  handle(IPC.providerUpsert, (input: ProviderInput) => providers.upsert(input))
  handle(IPC.providerDelete, (id: string) => providers.delete(id))
  handle(IPC.providerTest, (input: { id?: string; apiKey?: string; provider?: ProviderInput }) => providers.test(input))
  handle(IPC.providerModelsDiscover, (input: { id?: string; apiKey?: string; provider?: ProviderInput }) => providers.discoverModels(input))

  handle(IPC.sshList, () => ssh.list())
  handle(IPC.sshUpsert, (input: SshHostInput) => ssh.upsert(input))
  handle(IPC.sshDelete, (id: string) => ssh.delete(id))
  handle(IPC.sshTest, (id: string) => ssh.test(id))

  handle(IPC.skillList, (projectId: string) => skills.list(projectId))
  handle(IPC.skillGet, (input: { projectId: string; scope: SkillScope; name: string }) => skills.get(input.projectId, input.scope, input.name))
  handle(IPC.skillCreate, (input: SkillInput) => skillWrite(input.projectId, input.scope, () => skills.create(input)))
  handle(IPC.skillUpdate, (input: SkillInput) => skillWrite(input.projectId, input.scope, () => skills.update(input)))
  handle(IPC.skillDelete, (input: { projectId: string; scope: 'project' | 'global'; name: string }) => skillWrite(input.projectId, input.scope, () => skills.remove(input.projectId, input.scope, input.name)))
  handle(IPC.skillCopyBuiltin, (input: { projectId: string; name: string; targetScope: 'project' | 'global' }) => skillWrite(input.projectId, input.targetScope, () => skills.copyBuiltin(input.projectId, input.name, input.targetScope)))
  handle(IPC.skillImport, async (input: { projectId: string; targetScope: 'project' | 'global'; kind: 'file' | 'folder' }) => {
    const result = await dialog.showOpenDialog({
      properties: input.kind === 'folder' ? ['openDirectory'] : ['openFile'],
      filters: input.kind === 'file' ? [{ name: 'Skill Markdown', extensions: ['md'] }] : undefined
    })
    if (result.canceled || !result.filePaths[0]) return null
    return skillWrite(input.projectId, input.targetScope, () => skills.importSkill(input.projectId, input.targetScope, result.filePaths[0]))
  })
  handle(IPC.skillImportContent, (input: { projectId: string; targetScope: 'project' | 'global'; content: string }) => skillWrite(input.projectId, input.targetScope, () => skills.importContent(input.projectId, input.targetScope, input.content)))
  handle(IPC.skillDiscoverFolder, async (input: { projectId: string }) => {
    projects.get(input.projectId)
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    return skills.discoverPath(result.filePaths[0], result.filePaths[0])
  })
  handle(IPC.skillDiscoverGit, (input: { projectId: string; url: string }) => {
    projects.get(input.projectId)
    return skills.discoverGit(input.url)
  })
  handle(IPC.skillInstallDiscovered, (input: { projectId: string; cacheId: string; targetScope: 'project' | 'global'; names: string[] }) => skillWrite(input.projectId, input.targetScope, () => skills.installDiscovered(input)))
  handle(IPC.skillOpenScope, (input: { projectId: string; scope: SkillScope }) => skills.openScope(input.projectId, input.scope))
  handle(IPC.skillReveal, (input: { projectId: string; scope: SkillScope; name: string }) => skills.reveal(input.projectId, input.scope, input.name))

  handle(IPC.settingsGet, () => settings.get())
  handle(IPC.settingsUpdate, (patch: Partial<AppSettings>) => {
    const next = settings.update(patch)
    if (patch.workspaceRoot && !existsSync(next.workspaceRoot)) throw new Error('工作区目录不存在。')
    emitEvent({ type: 'notice', level: 'success', message: '设置已保存。' })
    return next
  })

  handle(IPC.pipelineGet, (projectId: string) => pipeline.get(projectId))
  const preflightPipeline = (): void => {
    const missing = services.mcp.list().filter((server) => !server.enabled).map((server) => server.name)
    if (missing.length) throw new Error(`请先在 MCP 工具连接中启用完整科研流程所需服务：${missing.join('、')}。`)
    const python = settings.get().pythonPath.trim()
    if (!python || !pythonCommandAvailable(python)) throw new Error('完整科研流程需要在设置中指定可用的本地 Python 3.10+；不会自动安装解释器或依赖。')
  }
  handle(IPC.pipelineStart, (input: PipelineStartInput) => { assertProject(input.projectId); preflightPipeline(); return pipeline.start(input) })
  handle(IPC.pipelineRunStage, (runId: string) => { assertProject(pipeline.projectIdForRun(runId)); preflightPipeline(); return pipeline.continue(runId) })
  handle(IPC.pipelineCancel, (runId: string) => pipeline.cancel(runId))
  handle(IPC.pipelineReset, (projectId: string) => pipeline.reset(projectId))

  handle(IPC.approvalRespond, (decision: ApprovalDecision) => approvals.respond(decision))
  handle(IPC.usageSummary, (projectId?: string) => usage.summary(projectId))
  handle(IPC.evidenceGenerate, (projectId: string) => projectWrite(projectId, () => evidence.generate(projects.get(projectId))))
}
