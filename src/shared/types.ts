export type DocumentFormat = 'docx' | 'latex'
export type ExperimentStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type PipelineStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type AgentStatus = 'unconfigured' | 'starting' | 'idle' | 'running' | 'stopped' | 'error'
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system'
export type MessageKind = 'text' | 'tool' | 'status' | 'error'

export interface Project {
  id: string
  name: string
  description: string
  rootPath: string
  createdAt: string
  updatedAt: string
  archived: boolean
}

export interface ProjectStats {
  documents: number
  references: number
  experiments: number
  figures: number
  runs: number
}

export interface ProjectOverview {
  project: Project
  stats: ProjectStats
  recentRuns: ExperimentRun[]
  documents: DocumentRecord[]
}

export interface DocumentRecord {
  id: string
  projectId: string
  title: string
  format: DocumentFormat
  fileName: string
  relativePath: string
  position: number
  createdAt: string
  updatedAt: string
  wordCount: number
}

export interface DocumentVersion {
  id: string
  documentId: string
  label: string
  createdAt: string
  size: number
}

export interface DocumentCreateInput {
  projectId: string
  title: string
  format: DocumentFormat
  markdown?: string
  template?: 'ieee' | 'neurips' | 'acm' | 'blank'
}

export interface LatexCompileResult {
  ok: boolean
  command: string | null
  durationMs: number
  log: string
  pdfRelativePath?: string
}

export interface Reference {
  id: string
  projectId: string
  title: string
  authors: string
  year: string
  venue: string
  doi: string
  url: string
  abstract: string
  tags: string[]
  notes: string
  pdfRelativePath: string
  bibtex: string
  createdAt: string
  updatedAt: string
}

export interface ReferenceReadingDraft {
  id: string
  projectId: string
  referenceId: string
  sourceHash: string
  sourceCoverage: 'abstract-only'
  content: string
  modelLabel: string
  createdAt: string
  status: 'ai-draft'
  sourceChanged: boolean
}

export interface ReferenceReadingDraftInput {
  referenceId: string
  sourceHash: string
  sourceCoverage: 'abstract-only'
  content: string
}

export interface ReferenceInput {
  projectId: string
  title: string
  authors?: string
  year?: string
  venue?: string
  doi?: string
  url?: string
  abstract?: string
  tags?: string[]
  notes?: string
  bibtex?: string
}

export interface Experiment {
  id: string
  projectId: string
  name: string
  description: string
  language: 'python'
  entryFile: string
  envKind: 'local' | 'ssh'
  sshHostId: string
  status: ExperimentStatus
  createdAt: string
  updatedAt: string
  lastRunId: string
}

export interface ExperimentRun {
  id: string
  experimentId: string
  projectId: string
  status: ExperimentStatus
  exitCode: number | null
  command: string
  startedAt: string
  finishedAt: string
  stdout: string
  stderr: string
  metrics: Record<string, number | string>
  artifactDir: string
}

export interface ExperimentInput {
  projectId: string
  name: string
  description?: string
  envKind?: 'local' | 'ssh'
  sshHostId?: string
  code?: string
}

export interface Figure {
  id: string
  projectId: string
  experimentId: string
  name: string
  caption: string
  filePath: string
  format: string
  createdAt: string
  /** Legacy Python plots are raster-only and have no editable model. */
  modelKind?: 'chart' | 'diagram' | 'raster'
  sourcePath?: string
  pptxPath?: string
  provenance?: import('./figure-spec').FigureProvenance
  updatedAt?: string
}

export interface Chat {
  id: string
  projectId: string
  title: string
  dshSessionId: string
  providerId: string
  modelId: string
  createdAt: string
  updatedAt: string
}

export interface ToolActivity {
  callId: string
  name: string
  arguments: string
  status: 'running' | 'succeeded' | 'failed'
  result?: string
  isError?: boolean
}

export interface AttachmentDraft {
  name: string
  path: string
  size: number
  mimeType: string
  kind: 'image' | 'file'
}

export interface ChatAttachment {
  name: string
  relativePath: string
  size: number
  mimeType: string
  kind: 'image' | 'file'
}

export interface ChatMessage {
  id: string
  chatId: string
  projectId: string
  role: MessageRole
  kind: MessageKind
  content: string
  tool?: ToolActivity
  attachments?: ChatAttachment[]
  createdAt: string
}

export interface PdfFulltextResult {
  sha256: string
  totalPages: number
  pages: Array<{ page: number; text: string; offset: number; totalCharacters: number; truncated: boolean }>
  noTextPages: number[]
  nextPage: number | null
  nextOffset: number
  complete: boolean
  coverage: string
  limitation: string
}

export interface ModelInfo {
  metadataSource?: 'upstream' | 'manual'
  capabilities?: { vision?: boolean; tools?: boolean; reasoning?: boolean }
  id: string
  label: string
  contextWindow?: number
  maxOutput?: number
}

export interface Provider {
  id: string
  name: string
  kind: 'deepseek' | 'custom'
  protocol: 'deepseek' | 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  baseUrl: string
  models: ModelInfo[]
  isDefault: boolean
  hasApiKey: boolean
  createdAt: string
  updatedAt: string
}

export interface ProviderInput {
  id?: string
  name: string
  kind: 'deepseek' | 'custom'
  protocol: Provider['protocol']
  baseUrl?: string
  apiKey?: string
  models: ModelInfo[]
  isDefault?: boolean
}

export interface SshHost {
  id: string
  name: string
  host: string
  port: number
  username: string
  authKind: 'password' | 'key'
  keyPath: string
  workspacePath: string
  hasPassword: boolean
  createdAt: string
  updatedAt: string
}

export interface SshHostInput {
  id?: string
  name: string
  host: string
  port?: number
  username: string
  authKind: 'password' | 'key'
  keyPath?: string
  password?: string
  passphrase?: string
  workspacePath?: string
}

export interface AppSettings {
  researchClarification?: import('./research-interaction').ResearchClarification
  agentRoleModels?: import('./agent-roles').AgentRoleModels
  workspaceRoot: string
  pythonPath: string
  latexCommand: string
  defaultProviderId: string
  defaultModelId: string
  maxConcurrentRuns: number
  reasoningEffort: '' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxOutputTokens: number
  telemetry: boolean
}

export interface AgentPublicState {
  status: AgentStatus
  projectId: string
  chatId: string
  providerId: string
  modelId: string
  sessionId: string
  lastError: string
}

export interface ChatSendInput {
  modelOverride?: { providerId: string; modelId: string }
  projectId: string
  chatId?: string
  text: string
  attachments?: AttachmentDraft[]
}

export interface ChatSendResult {
  chat: Chat
  userMessage: ChatMessage
}

export interface PipelineStage {
  id: string
  label: string
  description: string
  skill: string
  prompt: string
  format?: DocumentFormat
}

export interface PipelineStep {
  id: string
  runId: string
  stage: string
  position: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  prompt: string
  output: string
  error: string
  startedAt: string
  finishedAt: string
}

export interface PipelineRun {
  id: string
  projectId: string
  title: string
  topic: string
  status: PipelineStatus
  currentStage: string
  autoRun: boolean
  formats: DocumentFormat[]
  chatId: string
  steps: PipelineStep[]
  createdAt: string
  updatedAt: string
}

export interface PipelineSnapshot {
  stages: PipelineStage[]
  run: PipelineRun | null
}

export interface PipelineStartInput {
  projectId: string
  topic: string
  formats: DocumentFormat[]
  autoRun: boolean
  providerId?: string
  modelId?: string
}

export interface ApprovalRequest {
  id: string
  origin: 'agent' | 'pipeline' | 'app'
  title: string
  description: string
  risk: 'low' | 'medium' | 'high'
  details: string
  createdAt: string
}

export interface ApprovalDecision {
  id: string
  approved: boolean
  remember: boolean
}

export type AppEvent =
  | { type: 'agent-status'; state: AgentPublicState }
  | { type: 'chat-message'; projectId: string; chatId: string; message: ChatMessage }
  | { type: 'experiment-update'; projectId: string; run: ExperimentRun }
  | { type: 'figure-created'; projectId: string; figure: Figure }
  | { type: 'pipeline-update'; projectId: string; run: PipelineRun }
  | { type: 'approval-request'; request: ApprovalRequest }
  | { type: 'project-updated'; project: Project }
  | { type: 'reference-reading-draft'; projectId: string; referenceId: string }
  | { type: 'agent-stream'; projectId: string; sessionId: string; frame: AgentStreamFrame }
  | { type: 'notice'; level: 'info' | 'success' | 'warning' | 'error'; message: string }

export interface BootstrapData {
  projectHealth?: import('./project-health').ProjectHealth[]
  version: string
  settings: AppSettings
  projects: Project[]
  providers: Provider[]
  sshHosts: SshHost[]
  activeProjectId: string
  hasDeepSeekKey: boolean
  latexAvailable: boolean
  uvAvailable: boolean
  pythonAvailable: boolean
}

export interface CrossrefResult {
  title: string
  authors: string
  year: string
  venue: string
  doi: string
  url: string
  abstract: string
}

export interface DirEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size?: number
}

export interface FigureRenderInput {
  projectId: string
  name: string
  code: string
  experimentId?: string
  caption?: string
}

export type SkillScope = 'builtin' | 'project' | 'global'

export interface SkillResources {
  references: number
  templates: number
  scripts: number
  evals: number
  assets: number
}

export interface SkillRecord {
  name: string
  description: string
  whenToUse: string
  scope: SkillScope
  path: string
  relativePath: string
  editable: boolean
  builtinCopy: boolean
  overridesBuiltin: boolean
  resources: SkillResources
}

export interface SkillDetail extends SkillRecord {
  content: string
}

export interface SkillInput {
  projectId: string
  scope: 'project' | 'global'
  name: string
  description: string
  whenToUse: string
  body: string
}

export interface AgentUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface UsageBucket {
  providerId: string
  modelId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  requests: number
}

export interface UsageSummary {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  requests: number
  byModel: UsageBucket[]
}

export type AgentStreamFrame = {
  type: string
  [key: string]: unknown
}

export interface SkillDiscovery {
  name: string
  description: string
  whenToUse: string
  sourcePath: string
  relativePath: string
  resources: SkillResources
}

export interface SkillDiscoveryResult {
  cacheId: string
  sourceLabel: string
  skills: SkillDiscovery[]
}

export interface SkillInstallResult {
  installed: SkillRecord[]
  skipped: Array<{ name: string; reason: string }>
}
