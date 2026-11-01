import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { ResearchPilotApi } from '../shared/api'
import type { AppEvent } from '../shared/types'
import type { AuthStatus } from '../shared/auth'

const api: ResearchPilotApi = {
  backups: {
    exportProject: (projectId) => ipcRenderer.invoke(IPC.backupExportProject, projectId),
    inspect: () => ipcRenderer.invoke(IPC.backupInspect),
    restoreCopy: (token) => ipcRenderer.invoke(IPC.backupRestoreCopy, token)
  },
  pdfAnnotations: {
    open: (projectId, referenceId) => ipcRenderer.invoke(IPC.pdfAnnotationOpen, { projectId, referenceId }),
    list: (scope) => ipcRenderer.invoke(IPC.pdfAnnotationList, scope),
    create: (input) => ipcRenderer.invoke(IPC.pdfAnnotationCreate, input),
    update: (input) => ipcRenderer.invoke(IPC.pdfAnnotationUpdate, input),
    remove: (scope, id) => ipcRenderer.invoke(IPC.pdfAnnotationDelete, { scope, id })
  },
  auth: {
    status: () => ipcRenderer.invoke(IPC.authStatus),
    onChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, status: AuthStatus): void => listener(status)
      ipcRenderer.on(IPC.authChanged, wrapped)
      return () => ipcRenderer.removeListener(IPC.authChanged, wrapped)
    }
  },
  bootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  chooseDirectory: () => ipcRenderer.invoke(IPC.chooseDirectory),
  chooseFile: (filters) => ipcRenderer.invoke(IPC.chooseFile, filters),
  chooseAttachments: () => ipcRenderer.invoke(IPC.chooseAttachments),
  inspectAttachments: (paths) => ipcRenderer.invoke(IPC.inspectAttachments, paths),
  openPath: (path) => ipcRenderer.invoke(IPC.openPath, path),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),

  projects: {
    health: () => ipcRenderer.invoke('project:health'),
    retry: (projectId) => ipcRenderer.invoke('project:retry', projectId),
    list: () => ipcRenderer.invoke(IPC.projectList),
    create: (input) => ipcRenderer.invoke(IPC.projectCreate, input),
    update: (input) => ipcRenderer.invoke(IPC.projectUpdate, input),
    remove: (input) => ipcRenderer.invoke(IPC.projectDelete, input),
    overview: (projectId) => ipcRenderer.invoke(IPC.projectOverview, projectId),
    setActive: (projectId) => ipcRenderer.invoke(IPC.projectSetActive, projectId),
    reveal: (projectId) => ipcRenderer.invoke(IPC.projectReveal, projectId)
  },

  notes: {
    list: (projectId, options) => ipcRenderer.invoke(IPC.noteList, { projectId, options }),
    create: (input) => ipcRenderer.invoke(IPC.noteCreate, input),
    get: (projectId, id) => ipcRenderer.invoke(IPC.noteGet, { projectId, id }),
    update: (input) => ipcRenderer.invoke(IPC.noteUpdate, input),
    setPinned: (projectId, id, pinned) => ipcRenderer.invoke(IPC.noteSetPinned, { projectId, id, pinned }),
    trash: (projectId, id) => ipcRenderer.invoke(IPC.noteTrash, { projectId, id }),
    restore: (projectId, id) => ipcRenderer.invoke(IPC.noteRestore, { projectId, id }),
    backlinks: (projectId, id) => ipcRenderer.invoke(IPC.noteBacklinks, { projectId, id })
  },

  documents: {
    list: (projectId) => ipcRenderer.invoke(IPC.documentList, projectId),
    create: (input) => ipcRenderer.invoke(IPC.documentCreate, input),
    import: (projectId) => ipcRenderer.invoke(IPC.documentImport, projectId),
    read: (projectId, id) => ipcRenderer.invoke(IPC.documentRead, { projectId, id }),
    readText: (projectId, id) => ipcRenderer.invoke(IPC.documentReadText, { projectId, id }),
    save: (projectId, id, base64) => ipcRenderer.invoke(IPC.documentSave, { projectId, id, base64 }),
    saveText: (projectId, id, text) => ipcRenderer.invoke(IPC.documentSaveText, { projectId, id, text }),
    versions: (projectId, id) => ipcRenderer.invoke(IPC.documentVersions, { projectId, id }),
    restore: (projectId, id, versionId) => ipcRenderer.invoke(IPC.documentRestore, { projectId, id, versionId }),
    remove: (projectId, id) => ipcRenderer.invoke(IPC.documentDelete, { projectId, id }),
    compile: (projectId, id) => ipcRenderer.invoke(IPC.documentCompileLatex, { projectId, id }),
    readPdf: (projectId, id) => ipcRenderer.invoke(IPC.documentReadPdf, { projectId, id }),
    reveal: (projectId, id) => ipcRenderer.invoke(IPC.documentReveal, { projectId, id })
  },

  references: {
    fulltext: (projectId, id, startPage, pageOffset) => ipcRenderer.invoke('reference:fulltext', { projectId, id, startPage, pageOffset }),
    list: (projectId, query) => ipcRenderer.invoke(IPC.referenceList, { projectId, query }),
    getReadingDraft: (projectId, id) => ipcRenderer.invoke(IPC.referenceGetReadingDraft, { projectId, id }),
    upsert: (input) => ipcRenderer.invoke(IPC.referenceUpsert, input),
    remove: (projectId, id) => ipcRenderer.invoke(IPC.referenceDelete, { projectId, id }),
    crossref: (query, rows) => ipcRenderer.invoke(IPC.referenceCrossref, { query, rows }),
    addDoi: (projectId, doi) => ipcRenderer.invoke(IPC.referenceAddDoi, { projectId, doi }),
    importBibtex: (projectId, text) => ipcRenderer.invoke(IPC.referenceImportBibtex, { projectId, text }),
    attachPdf: (projectId, id) => ipcRenderer.invoke(IPC.referenceAttachPdf, { projectId, id }),
    readPdf: (projectId, id) => ipcRenderer.invoke(IPC.referenceReadPdf, { projectId, id })
  },

  knowledge: {
    search: (input) => ipcRenderer.invoke(IPC.knowledgeSearch, input),
    sync: (projectId) => ipcRenderer.invoke(IPC.knowledgeSync, projectId),
    status: (projectId) => ipcRenderer.invoke(IPC.knowledgeStatus, projectId),
    activity: (input) => ipcRenderer.invoke(IPC.knowledgeActivity, input),
    read: (input) => ipcRenderer.invoke(IPC.knowledgeRead, input)
  },

  experiments: {
    list: (projectId) => ipcRenderer.invoke(IPC.experimentList, projectId),
    create: (input) => ipcRenderer.invoke(IPC.experimentCreate, input),
    update: (input) => ipcRenderer.invoke(IPC.experimentUpdate, input),
    remove: (id) => ipcRenderer.invoke(IPC.experimentDelete, id),
    readCode: (id) => ipcRenderer.invoke(IPC.experimentReadCode, id),
    saveCode: (id, code) => ipcRenderer.invoke(IPC.experimentSaveCode, { id, code }),
    run: (id) => ipcRenderer.invoke(IPC.experimentRun, id),
    stop: (runId) => ipcRenderer.invoke(IPC.experimentStop, runId),
    runs: (experimentId) => ipcRenderer.invoke(IPC.experimentRuns, experimentId),
    runGet: (runId) => ipcRenderer.invoke(IPC.experimentRunGet, runId),
    openArtifact: (runId) => ipcRenderer.invoke(IPC.experimentOpenArtifact, runId)
  },

  figures: {
    list: (projectId) => ipcRenderer.invoke(IPC.figureList, projectId),
    remove: (projectId, id) => ipcRenderer.invoke(IPC.figureDelete, { projectId, id }),
    render: (input) => ipcRenderer.invoke(IPC.figureRender, input),
    createStructured: (input) => ipcRenderer.invoke(IPC.figureCreateStructured, input),
    getStructured: (projectId, id) => ipcRenderer.invoke(IPC.figureGetStructured, { projectId, id }),
    saveStructured: (projectId, id, spec) => ipcRenderer.invoke(IPC.figureSaveStructured, { projectId, id, spec }),
    exportPptx: (projectId, id) => ipcRenderer.invoke(IPC.figureExportPptx, { projectId, id }),
    read: (projectId, id, artifact) => ipcRenderer.invoke(IPC.figureRead, { projectId, id, artifact }),
    open: (projectId, id, artifact) => ipcRenderer.invoke(IPC.figureOpen, { projectId, id, artifact })
  },

  chat: {
    list: (projectId) => ipcRenderer.invoke(IPC.chatList, projectId),
    create: (projectId) => ipcRenderer.invoke(IPC.chatCreate, projectId),
    messages: (chatId) => ipcRenderer.invoke(IPC.chatMessages, chatId),
    setModel: (chatId, providerId, modelId) => ipcRenderer.invoke(IPC.chatSetModel, { chatId, providerId, modelId }),
    send: (input) => ipcRenderer.invoke(IPC.chatSend, input),
    stop: () => ipcRenderer.invoke(IPC.chatStop),
    state: () => ipcRenderer.invoke(IPC.chatAgentState),
    remove: (id) => ipcRenderer.invoke(IPC.chatDelete, id)
  },

  providers: {
    list: () => ipcRenderer.invoke(IPC.providerList),
    upsert: (input) => ipcRenderer.invoke(IPC.providerUpsert, input),
    remove: (id) => ipcRenderer.invoke(IPC.providerDelete, id),
    test: (input) => ipcRenderer.invoke(IPC.providerTest, input),
    discoverModels: (input) => ipcRenderer.invoke(IPC.providerModelsDiscover, input)
  },

  ssh: {
    list: () => ipcRenderer.invoke(IPC.sshList),
    upsert: (input) => ipcRenderer.invoke(IPC.sshUpsert, input),
    remove: (id) => ipcRenderer.invoke(IPC.sshDelete, id),
    test: (id) => ipcRenderer.invoke(IPC.sshTest, id)
  },

  skills: {
    list: (projectId) => ipcRenderer.invoke(IPC.skillList, projectId),
    get: (projectId, scope, name) => ipcRenderer.invoke(IPC.skillGet, { projectId, scope, name }),
    create: (input) => ipcRenderer.invoke(IPC.skillCreate, input),
    update: (input) => ipcRenderer.invoke(IPC.skillUpdate, input),
    remove: (projectId, scope, name) => ipcRenderer.invoke(IPC.skillDelete, { projectId, scope, name }),
    copyBuiltin: (projectId, name, targetScope) => ipcRenderer.invoke(IPC.skillCopyBuiltin, { projectId, name, targetScope }),
    importSkill: (projectId, targetScope, kind) => ipcRenderer.invoke(IPC.skillImport, { projectId, targetScope, kind }),
    importContent: (input) => ipcRenderer.invoke(IPC.skillImportContent, input),
    discoverFolder: (projectId) => ipcRenderer.invoke(IPC.skillDiscoverFolder, { projectId }),
    discoverGit: (projectId, url) => ipcRenderer.invoke(IPC.skillDiscoverGit, { projectId, url }),
    installDiscovered: (input) => ipcRenderer.invoke(IPC.skillInstallDiscovered, input),
    openScope: (projectId, scope) => ipcRenderer.invoke(IPC.skillOpenScope, { projectId, scope }),
    reveal: (projectId, scope, name) => ipcRenderer.invoke(IPC.skillReveal, { projectId, scope, name })
  },

  mcp: {
    list: (projectId) => ipcRenderer.invoke(IPC.mcpList, projectId),
    configure: (input) => ipcRenderer.invoke(IPC.mcpConfigure, input),
    test: (input) => ipcRenderer.invoke(IPC.mcpTest, input),
    disconnect: (input) => ipcRenderer.invoke(IPC.mcpDisconnect, input)
  },

  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch)
  },

  pipeline: {
    get: (projectId) => ipcRenderer.invoke(IPC.pipelineGet, projectId),
    start: (input) => ipcRenderer.invoke(IPC.pipelineStart, input),
    runStage: (runId) => ipcRenderer.invoke(IPC.pipelineRunStage, runId),
    cancel: (runId) => ipcRenderer.invoke(IPC.pipelineCancel, runId),
    reset: (projectId) => ipcRenderer.invoke(IPC.pipelineReset, projectId)
  },

  approvals: {
    respond: (decision) => ipcRenderer.invoke(IPC.approvalRespond, decision)
  },

  usage: {
    summary: (projectId) => ipcRenderer.invoke(IPC.usageSummary, projectId)
  },

  evidence: {
    generate: (projectId) => ipcRenderer.invoke(IPC.evidenceGenerate, projectId)
  },

  onEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AppEvent): void => listener(payload)
    ipcRenderer.on(IPC.event, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC.event, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('researchpilot', api)
