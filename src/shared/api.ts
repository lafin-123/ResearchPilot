import type {
  AgentPublicState,
  AppEvent,
  AppSettings,
  ApprovalDecision,
  AttachmentDraft,
  BootstrapData,
  Chat,
  ChatMessage,
  ChatSendInput,
  ChatSendResult,
  CrossrefResult,
  DocumentCreateInput,
  DocumentFormat,
  DocumentRecord,
  DocumentVersion,
  Experiment,
  ExperimentInput,
  ExperimentRun,
  Figure,
  FigureRenderInput,
  LatexCompileResult,
  ModelInfo,
  PipelineRun,
  PipelineSnapshot,
  PipelineStartInput,
  Project,
  ProjectOverview,
  Provider,
  ProviderInput,
  Reference,
  ReferenceInput,
  ReferenceReadingDraft,
  SkillDetail,
  SkillDiscoveryResult,
  SkillInput,
  SkillInstallResult,
  SkillRecord,
  SkillScope,
  SshHost,
  SshHostInput,
  UsageSummary
} from './types'

import type { KnowledgeSearchInput, KnowledgeSearchResult, KnowledgeStatus, ReferenceActivity } from './knowledge'
import type { McpConfigureInput, McpServerState, McpTestInput } from './mcp'
import type { AuthStatus } from './auth'
import type { NoteCreateInput, NoteListOptions, NoteListResult, NoteRecord, NoteSummary, NoteUpdateInput } from './notes'
import type { FigureSpec, FigureStructuredInput, FigureArtifact, FigureReadResult } from './figure-spec'

import type { PdfAnnotation, PdfAnnotationCreate, PdfAnnotationUpdate, PdfOpenResult, PdfScope } from './pdf-annotations'

import type { BackupExportResult, BackupPreview, BackupRestoreResult } from './backups'

export interface ResearchPilotApi {
  backups: {
    exportProject(projectId: string): Promise<BackupExportResult | null>
    inspect(): Promise<BackupPreview | null>
    restoreCopy(token: string): Promise<BackupRestoreResult>
  }
  pdfAnnotations: {
    open(projectId: string, referenceId: string): Promise<PdfOpenResult>
    list(scope: PdfScope): Promise<PdfAnnotation[]>
    create(input: PdfAnnotationCreate): Promise<PdfAnnotation>
    update(input: PdfAnnotationUpdate): Promise<PdfAnnotation>
    remove(scope: PdfScope, id: string): Promise<void>
  }

  auth: {
    status(): Promise<AuthStatus>
    onChanged(listener: (status: AuthStatus) => void): () => void
  }

  bootstrap(): Promise<BootstrapData>
  chooseDirectory(): Promise<string | null>
  chooseFile(filters?: Array<{ name: string; extensions: string[] }>): Promise<string | null>
  chooseAttachments(): Promise<AttachmentDraft[]>
  inspectAttachments(paths: string[]): Promise<AttachmentDraft[]>
  openPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  appInfo(): Promise<{ version: string; electron: string; node: string; chrome: string; platform: string }>

  projects: {
    health(): Promise<import('./project-health').ProjectHealth[]>
    retry(projectId: string): Promise<import('./project-health').ProjectHealth>
    list(): Promise<Project[]>
    create(input: { name: string; description?: string }): Promise<Project>
    update(input: { id: string; name?: string; description?: string; archived?: boolean }): Promise<Project>
    remove(input: { id: string; deleteFiles?: boolean }): Promise<void>
    overview(projectId: string): Promise<ProjectOverview>
    setActive(projectId: string): Promise<void>
    reveal(projectId: string): Promise<void>
  }

  notes: {
    list(projectId: string, options?: NoteListOptions): Promise<NoteListResult>
    create(input: NoteCreateInput): Promise<NoteRecord>
    get(projectId: string, id: string): Promise<NoteRecord>
    update(input: NoteUpdateInput): Promise<NoteRecord>
    setPinned(projectId: string, id: string, pinned: boolean): Promise<NoteRecord>
    trash(projectId: string, id: string): Promise<NoteRecord>
    restore(projectId: string, id: string): Promise<NoteRecord>
    backlinks(projectId: string, id: string): Promise<NoteSummary[]>
  }

  documents: {
    list(projectId: string): Promise<DocumentRecord[]>
    create(input: DocumentCreateInput): Promise<DocumentRecord>
    import(projectId: string): Promise<DocumentRecord | null>
    read(projectId: string, id: string): Promise<{ base64: string; updatedAt: string; fileName: string }>
    readText(projectId: string, id: string): Promise<{ text: string; format: DocumentFormat }>
    save(projectId: string, id: string, base64: string): Promise<DocumentRecord>
    saveText(projectId: string, id: string, text: string): Promise<DocumentRecord>
    versions(projectId: string, id: string): Promise<DocumentVersion[]>
    restore(projectId: string, id: string, versionId: string): Promise<DocumentRecord>
    remove(projectId: string, id: string): Promise<void>
    compile(projectId: string, id: string): Promise<LatexCompileResult>
    readPdf(projectId: string, id: string): Promise<{ base64: string; fileName: string }>
    reveal(projectId: string, id: string): Promise<void>
  }

  references: {
    fulltext(projectId: string, id: string, startPage?: number, pageOffset?: number): Promise<import('./types').PdfFulltextResult>
    list(projectId: string, query?: string): Promise<Reference[]>
    getReadingDraft(projectId: string, id: string): Promise<ReferenceReadingDraft | null>
    upsert(input: ReferenceInput & { id?: string }): Promise<Reference>
    remove(projectId: string, id: string): Promise<void>
    crossref(query: string, rows?: number): Promise<CrossrefResult[]>
    addDoi(projectId: string, doi: string): Promise<Reference>
    importBibtex(projectId: string, text: string): Promise<Reference[]>
    attachPdf(projectId: string, id: string): Promise<Reference | null>
    readPdf(projectId: string, id: string): Promise<{ base64: string; fileName: string }>
  }

  knowledge: {
    search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult>
    sync(projectId: string): Promise<KnowledgeStatus>
    status(projectId: string): Promise<KnowledgeStatus>
    activity(input: { projectId: string; limit?: number }): Promise<ReferenceActivity[]>
    read(input: { projectId: string; referenceId: string }): Promise<void>
  }

  experiments: {
    list(projectId: string): Promise<Experiment[]>
    create(input: ExperimentInput): Promise<Experiment>
    update(input: { id: string; name?: string; description?: string; envKind?: 'local' | 'ssh'; sshHostId?: string }): Promise<Experiment>
    remove(id: string): Promise<void>
    readCode(id: string): Promise<string>
    saveCode(id: string, code: string): Promise<Experiment>
    run(id: string): Promise<ExperimentRun>
    stop(runId: string): Promise<void>
    runs(experimentId: string): Promise<ExperimentRun[]>
    runGet(runId: string): Promise<ExperimentRun>
    openArtifact(runId: string): Promise<void>
  }

  figures: {
    list(projectId: string): Promise<Figure[]>
    remove(projectId: string, id: string): Promise<void>
    render(input: FigureRenderInput): Promise<Figure>
    createStructured(input: FigureStructuredInput): Promise<Figure>
    getStructured(projectId: string, id: string): Promise<FigureSpec>
    saveStructured(projectId: string, id: string, spec: FigureSpec): Promise<Figure>
    exportPptx(projectId: string, id: string): Promise<Figure>
    read(projectId: string, id: string, artifact?: FigureArtifact): Promise<FigureReadResult>
    open(projectId: string, id: string, artifact?: FigureArtifact): Promise<void>
  }

  chat: {
    list(projectId: string): Promise<Chat[]>
    create(projectId: string): Promise<Chat>
    messages(chatId: string): Promise<ChatMessage[]>
    setModel(chatId: string, providerId: string, modelId: string): Promise<Chat>
    send(input: ChatSendInput): Promise<ChatSendResult>
    stop(): Promise<void>
    state(): Promise<AgentPublicState>
    remove(id: string): Promise<void>
  }

  providers: {
    list(): Promise<Provider[]>
    upsert(input: ProviderInput): Promise<Provider>
    remove(id: string): Promise<void>
    test(input: { id?: string; apiKey?: string; provider?: ProviderInput }): Promise<{ ok: boolean; message: string; models: ModelInfo[] }>
    discoverModels(input: { id?: string; apiKey?: string; provider?: ProviderInput }): Promise<ModelInfo[]>
  }

  ssh: {
    list(): Promise<SshHost[]>
    upsert(input: SshHostInput): Promise<SshHost>
    remove(id: string): Promise<void>
    test(id: string): Promise<{ fingerprint: string; message: string }>
  }

  skills: {
    list(projectId: string): Promise<SkillRecord[]>
    get(projectId: string, scope: SkillScope, name: string): Promise<SkillDetail>
    create(input: SkillInput): Promise<SkillRecord>
    update(input: Omit<SkillInput, 'scope'> & { scope: 'project' | 'global' }): Promise<SkillRecord>
    remove(projectId: string, scope: 'project' | 'global', name: string): Promise<void>
    copyBuiltin(projectId: string, name: string, targetScope: 'project' | 'global'): Promise<SkillRecord>
    importSkill(projectId: string, targetScope: 'project' | 'global', kind: 'file' | 'folder'): Promise<SkillRecord | null>
    importContent(input: { projectId: string; targetScope: 'project' | 'global'; content: string }): Promise<SkillRecord>
    discoverFolder(projectId: string): Promise<SkillDiscoveryResult | null>
    discoverGit(projectId: string, url: string): Promise<SkillDiscoveryResult>
    installDiscovered(input: { projectId: string; cacheId: string; targetScope: 'project' | 'global'; names: string[] }): Promise<SkillInstallResult>
    openScope(projectId: string, scope: SkillScope): Promise<void>
    reveal(projectId: string, scope: SkillScope, name: string): Promise<void>
  }

  mcp: {
    list(projectId?: string): Promise<McpServerState[]>
    configure(input: McpConfigureInput): Promise<McpServerState[]>
    test(input: McpTestInput): Promise<McpServerState>
    disconnect(input: McpTestInput): Promise<void>
  }

  settings: {
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<AppSettings>
  }

  pipeline: {
    get(projectId: string): Promise<PipelineSnapshot>
    start(input: PipelineStartInput): Promise<PipelineRun>
    runStage(runId: string): Promise<PipelineRun>
    cancel(runId: string): Promise<PipelineRun>
    reset(projectId: string): Promise<PipelineSnapshot>
  }

  approvals: {
    respond(decision: ApprovalDecision): Promise<void>
  }

  usage: {
    summary(projectId?: string): Promise<UsageSummary>
  }

  evidence: {
    generate(projectId: string): Promise<{ path: string; relativePath: string; warnings: number }>
  }

  onEvent(listener: (event: AppEvent) => void): () => void
}
