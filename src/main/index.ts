import { app, BrowserWindow, dialog, Menu, screen, session, shell, type BrowserWindow as BrowserWindowType } from 'electron'
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { registerAuthIpc, registerIpc, type Services } from './ipc'
import { IPC } from '../shared/ipc'
import { LocalSessionService, type LocalWorkspaceScope } from './services/auth'
import { Db } from './lib/db'
import { setEventWindowProvider } from './lib/events'
import { defaultWorkspaceRoot, ensureProjectLayout, setAccountPaths } from './lib/paths'
import { AgentService } from './services/agent'
import { ApprovalService } from './services/approvals'
import { BridgeService } from './services/bridge'
import { ChatService } from './services/chats'
import { DocumentService } from './services/documents'
import { EvidenceService } from './services/evidence'
import { ExperimentRunner } from './services/experiment-runner'
import { ExperimentService } from './services/experiments'
import { FigureService } from './services/figures'
import { PipelineService } from './services/pipeline'
import { ProjectService } from './services/projects'
import { ProviderService } from './services/providers'
import { ReferenceService } from './services/references'
import { SettingsService } from './services/settings'
import { SshService } from './services/ssh'
import { SkillService } from './services/skills'
import { UsageService } from './services/usage'
import { McpService } from './services/mcp'
import { KnowledgeService } from './services/knowledge'
import { NoteService } from './services/notes'
import { PdfAnnotationService } from './services/pdf-annotations'
import { BackupService } from './services/backups'
import { ProjectHealthService } from './services/project-health'

let mainWindow: BrowserWindowType | null = null
let db: Db | null = null
let services: Services | null = null
let localSession: LocalSessionService | null = null

// Test/dev overrides cannot change packaged app data locations. Set before Chromium initializes its profile.
if (!app.isPackaged && process.env.RESEARCHPILOT_USER_DATA) {
  const isolatedData = resolve(process.env.RESEARCHPILOT_USER_DATA)
  mkdirSync(isolatedData, { recursive: true })
  app.setPath('userData', isolatedData)
}

function trustedSender(event: Electron.IpcMainInvokeEvent): boolean {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) return false
  try {
    const actual = new URL(event.senderFrame.url)
    const expected = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
      ? new URL(process.env.ELECTRON_RENDERER_URL)
      : pathToFileURL(join(__dirname, '../renderer/index.html'))
    return actual.origin === expected.origin && actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname
  } catch { return false }
}

function createWindow(): BrowserWindowType {
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const window = new BrowserWindow({
    width: Math.min(1480, workArea.width),
    height: Math.min(940, workArea.height),
    minWidth: Math.min(900, workArea.width),
    minHeight: Math.min(600, workArea.height),
    center: true,
    show: false,
    backgroundColor: '#f5f2ea',
    title: 'ResearchPilot',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  })

  window.once('ready-to-show', () => window.show())
  if (!app.isPackaged) setTimeout(() => { if (!window.isDestroyed() && !window.isVisible()) window.show() }, 4000)
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('[renderer] did-fail-load', code, description, url)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] render-process-gone', details)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (url !== current) {
      event.preventDefault()
      if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    }
  })
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      window.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

async function activateWorkspace(scope: LocalWorkspaceScope): Promise<void> {
  setAccountPaths({ dataRoot: scope.dataRoot, workspaceRoot: scope.workspaceRoot })
  try {
    db = new Db(scope.databasePath)

    const settings = new SettingsService(db)
    const providers = new ProviderService(db, settings)
    providers.seed()
    const chats = new ChatService(db)
    const documents = new DocumentService(db, settings)
    const experiments = new ExperimentService(db)
    const ssh = new SshService(db)
    const knowledge = new KnowledgeService(db)
    const notes = new NoteService(db)
    const references = new ReferenceService(db, knowledge)
    const pdfAnnotations = new PdfAnnotationService(db, references)
    const figures = new FigureService(db, settings)
    const runner = new ExperimentRunner(db, settings, experiments, ssh)
    const projects = new ProjectService(db, settings, documents, experiments)
    const projectHealth = new ProjectHealthService(projects, ensureProjectLayout)
    const usage = new UsageService(db)
    const evidence = new EvidenceService(db)
    const approvals = new ApprovalService()
    const bridge = new BridgeService(projects, documents, references, experiments, runner, figures, ssh, approvals, settings, evidence, () => localSession?.isAuthorized() ?? false, projectHealth)
    const mcp = new McpService(db, projects, bridge)
    const agent = new AgentService(chats, providers, settings, projects, usage, mcp, knowledge)
    const pipeline = new PipelineService(db, agent, chats, documents, projects, references, settings)
    const skills = new SkillService(db)
    const backups = new BackupService(db, { workspaceRoot: () => settings.get().workspaceRoot, assertIdle: () => {
      if (agent.isRunning() || runner.runningCount() || pipeline.isRunning() || bridge.isBusy()) throw new Error('请等待或停止当前研究任务后再进行备份恢复。')
    } })

    const current: Services = { settings, providers, projects, documents, references, experiments, runner, figures, chats, agent, ssh, approvals, bridge, pipeline, skills, usage, evidence, mcp, knowledge, notes, pdfAnnotations, backups, projectHealth }
    services = current
    projectHealth.initializeAll()
    if (!settings.getActiveProjectId()) {
      const first = projects.list()[0]
      if (first) settings.setActiveProjectId(first.id)
    }
    experiments.markInterrupted()
    await bridge.start()
    registerIpc(current, localSession!, trustedSender)
  } catch (error) {
    // Startup failures revoke the readiness gate before any partial service cleanup.
    localSession?.revoke()
    throw error
  }
}

async function deactivateWorkspace(): Promise<void> {
  const current = services
  services = null
  try {
    if (current) {
      current.backups.dispose()
      current.approvals.cancelAll()
      current.runner.shutdown()
      const results = await Promise.allSettled([current.mcp.close(), current.bridge.stop(), current.pipeline.stop(), current.agent.close()])
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
  } finally {
    db?.close()
    db = null
    setAccountPaths(null)
  }
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId('com.researchpilot.desktop')
  Menu.setApplicationMenu(null)
  setEventWindowProvider(() => localSession?.isAuthorized() && mainWindow ? [mainWindow] : [])

  localSession = new LocalSessionService(app.getPath('userData'), defaultWorkspaceRoot(), {
    activate: activateWorkspace,
    deactivate: deactivateWorkspace,
    changed: (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.authChanged, status)
    }
  })
  registerAuthIpc(localSession, trustedSender)
  await localSession.initialize()

  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https: http://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-src blob:; worker-src 'self' blob:"
          ]
        }
      })
    })
  }

  mainWindow = createWindow()
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

if (!app.isPackaged && !app.commandLine.hasSwitch('remote-debugging-port')) {
  app.commandLine.appendSwitch('remote-debugging-port', '0')
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(bootstrap).catch((error) => {
    console.error(error)
    dialog.showErrorBox('ResearchPilot 启动失败', error instanceof Error ? error.message : String(error))
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && localSession?.isAuthorized()) {
      mainWindow = createWindow()
      mainWindow.on('closed', () => { mainWindow = null })
    }
  })

  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    localSession?.revoke()
    services?.approvals.cancelAll()
    services?.runner.shutdown()
    // Cancel long-running work before waiting for IPC leases, so pending approval/chat calls can settle.
    Promise.allSettled([services?.mcp.close(), services?.bridge.stop(), services?.pipeline.stop(), services?.agent.close()])
      .then(() => localSession?.close())
      .catch((error) => console.error('[workspace] shutdown failed', error))
      .finally(() => app.quit())
  })

  app.on('will-quit', () => {
    localSession?.revoke()
    localSession = null
  })
}
