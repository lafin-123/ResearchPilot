import { create } from 'zustand'
import { toast } from 'sonner'
import type {
  AgentPublicState,
  AgentUsage,
  AppEvent,
  AppSettings,
  ApprovalRequest,
  AttachmentDraft,
  BootstrapData,
  Chat,
  ChatMessage,
  Project,
  Provider,
  SshHost
} from '@shared/types'
import { api, formatError } from '../lib/api'

interface ModelSelection {
  providerId: string
  modelId: string
}

interface ComposerDraft {
  text: string
  attachments: AttachmentDraft[]
}

const EMPTY_DRAFT: ComposerDraft = { text: '', attachments: [] }
const draftKey = (projectId: string, chatId: string): string => JSON.stringify([projectId, chatId])
const isRunning = (state: AgentPublicState | null): boolean => state?.status === 'running' || state?.status === 'starting'

function composerView(drafts: Record<string, ComposerDraft>, projectId: string, chatId: string) {
  const draft = drafts[draftKey(projectId, chatId)] ?? EMPTY_DRAFT
  return { composerDraft: draft.text, composerAttachments: draft.attachments }
}

interface AppState {
  ready: boolean
  bootError: string
  bootstrap: BootstrapData | null
  settings: AppSettings | null
  projects: Project[]
  providers: Provider[]
  sshHosts: SshHost[]
  activeProjectId: string
  agentState: AgentPublicState | null
  streaming: { sessionId: string; chatId: string; text: string; reasoning: string; active: boolean } | null
  usage: AgentUsage | null
  chats: Chat[]
  activeChatId: string
  messages: ChatMessage[]
  modelSelection: ModelSelection
  assistantOpen: boolean
  approvals: ApprovalRequest[]
  composerDraft: string
  composerAttachments: AttachmentDraft[]
  composerDrafts: Record<string, ComposerDraft>
  pendingSend: { projectId: string; chatId: string } | null
  projectLoading: boolean
  experimentVersion: number
  figureVersion: number
  pipelineVersion: number

  init: () => Promise<void>
  refreshBootstrap: () => Promise<void>
  refreshProviders: () => Promise<void>
  setActiveProject: (projectId: string) => Promise<void>
  openProject: (projectId: string) => Promise<void>
  setAssistantOpen: (open: boolean) => void
  loadChats: () => Promise<void>
  selectChat: (chatId: string) => Promise<void>
  newChat: () => Promise<boolean>
  send: (text: string, attachments?: AttachmentDraft[], newConversation?: boolean) => Promise<boolean>
  stopAgent: () => Promise<void>
  setChatModel: (providerId: string, modelId: string) => Promise<void>
  respondApproval: (id: string, approved: boolean, remember: boolean) => Promise<void>
  seedPrompt: (text: string) => void
  setComposerText: (text: string) => void
  addComposerAttachments: (projectId: string, chatId: string, items: AttachmentDraft[]) => void
  removeComposerAttachment: (path: string) => void
  goToRunningChat: () => Promise<void>
  handleEvent: (event: AppEvent) => void
}

function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((item) => item.id === message.id)
  if (index === -1) return [...messages, message].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const next = messages.slice()
  next[index] = message
  return next
}

let initPromise: Promise<void> | undefined
// Invalidate reads on intent, not completion (including A -> B -> A navigation).
let projectEpoch = 0
let chatEpoch = 0
let bootstrapEpoch = 0

export const useAppStore = create<AppState>()((set, get) => ({
  ready: false,
  bootError: '',
  bootstrap: null,
  settings: null,
  projects: [],
  providers: [],
  sshHosts: [],
  activeProjectId: '',
  agentState: null,
  streaming: null,
  usage: null,
  chats: [],
  activeChatId: '',
  messages: [],
  modelSelection: { providerId: '', modelId: '' },
  assistantOpen: false,
  approvals: [],
  composerDraft: '',
  composerAttachments: [],
  composerDrafts: {},
  pendingSend: null,
  projectLoading: false,
  experimentVersion: 0,
  figureVersion: 0,
  pipelineVersion: 0,

  init: async () => {
    if (initPromise) return initPromise
    const context = projectEpoch
    initPromise = (async () => {
      try {
        let bootstrap = await api.bootstrap()
        if (bootstrap.projects.length === 0) {
          await api.projects.create({ name: '我的研究', description: '从第一个研究任务开始。' })
          bootstrap = await api.bootstrap()
        } else if (!bootstrap.activeProjectId) {
          await api.projects.setActive(bootstrap.projects[0]!.id)
          bootstrap = await api.bootstrap()
        }
        const state = await api.chat.state()
        if (context !== projectEpoch) return
        set({
          ready: true,
          bootstrap,
          settings: bootstrap.settings,
          projects: bootstrap.projects,
          providers: bootstrap.providers,
          sshHosts: bootstrap.sshHosts,
          activeProjectId: bootstrap.activeProjectId,
          agentState: state,
          modelSelection: {
            providerId: bootstrap.settings.defaultProviderId,
            modelId: bootstrap.settings.defaultModelId
          }
        })
        if (bootstrap.activeProjectId) await get().loadChats()
      } catch (error) {
        set({ ready: true, bootError: formatError(error) })
      }
    })()
    try {
      await initPromise
    } finally {
      initPromise = undefined
    }
  },

  refreshBootstrap: async () => {
    const request = ++bootstrapEpoch
    const context = projectEpoch
    const bootstrap = await api.bootstrap()
    if (request !== bootstrapEpoch || context !== projectEpoch) return
    const projectChanged = bootstrap.activeProjectId !== get().activeProjectId
    if (projectChanged) {
      ++projectEpoch
      ++chatEpoch
    }
    set((state) => ({
      bootstrap,
      settings: bootstrap.settings,
      projects: bootstrap.projects,
      providers: bootstrap.providers,
      sshHosts: bootstrap.sshHosts,
      ...(projectChanged ? {
        activeProjectId: bootstrap.activeProjectId,
        activeChatId: '', chats: [], messages: [], streaming: null, usage: null, approvals: [],
        ...composerView(state.composerDrafts, bootstrap.activeProjectId, '')
      } : {})
    }))
    if (projectChanged && bootstrap.activeProjectId) await get().loadChats()
  },

  refreshProviders: async () => {
    const providers = await api.providers.list()
    const current = get()
    set({
      providers,
      bootstrap: current.bootstrap ? { ...current.bootstrap, providers, hasDeepSeekKey: providers.some((provider) => provider.hasApiKey) } : current.bootstrap
    })
  },

  setActiveProject: async (projectId: string) => {
    await get().openProject(projectId)
  },

  openProject: async (projectId: string) => {
    if (!get().projects.some((item) => item.id === projectId)) return
    const request = ++projectEpoch
    ++chatEpoch
    set({ projectLoading: true })
    try {
      await api.projects.setActive(projectId)
      if (request !== projectEpoch) return
      set((state) => ({
        activeProjectId: projectId,
        projectLoading: false,
        chats: [],
        activeChatId: '',
        messages: [],
        streaming: null,
        usage: null,
        approvals: [],
        ...composerView(state.composerDrafts, projectId, '')
      }))
      await get().loadChats()
    } catch (error) {
      if (request === projectEpoch) toast.error(formatError(error))
    } finally {
      if (request === projectEpoch) set({ projectLoading: false })
    }
  },

  setAssistantOpen: (open) => set({ assistantOpen: open }),

  loadChats: async () => {
    const projectId = get().activeProjectId
    if (!projectId || get().projectLoading) return
    const context = projectEpoch
    const request = ++chatEpoch
    const current = (): boolean => context === projectEpoch && request === chatEpoch && projectId === get().activeProjectId
    try {
      const chats = await api.chat.list(projectId)
      if (!current()) return
      const chat = chats.find((item) => item.id === get().activeChatId) ?? chats[0]
      set({ chats })
      if (chat) {
        await get().selectChat(chat.id)
      } else {
        const settings = get().settings
        set((state) => ({
          activeChatId: '', messages: [], streaming: null, usage: null,
          ...composerView(state.composerDrafts, projectId, ''),
          ...(settings ? { modelSelection: { providerId: settings.defaultProviderId, modelId: settings.defaultModelId } } : {})
        }))
      }
    } catch (error) {
      if (current()) toast.error(formatError(error))
    }
  },

  selectChat: async (chatId: string) => {
    const projectId = get().activeProjectId
    const chat = get().chats.find((item) => item.id === chatId && item.projectId === projectId)
    if (!chat || get().projectLoading) return
    const context = projectEpoch
    const request = ++chatEpoch
    const current = (): boolean => context === projectEpoch && request === chatEpoch && projectId === get().activeProjectId && chatId === get().activeChatId
    set((state) => ({
      activeChatId: chatId,
      messages: [], streaming: null, usage: null,
      ...composerView(state.composerDrafts, projectId, chatId),
      modelSelection: { providerId: chat.providerId, modelId: chat.modelId }
    }))
    try {
      const messages = await api.chat.messages(chatId)
      if (!current()) return
      // Events arriving during the history read are newer than its snapshot.
      set((state) => ({ messages: state.messages.reduce(upsertMessage, messages) }))
    } catch (error) {
      if (current()) toast.error(formatError(error))
    }
  },

  newChat: async () => {
    const projectId = get().activeProjectId
    if (!projectId || get().projectLoading) return false
    const context = projectEpoch
    const request = ++chatEpoch
    const current = (): boolean => context === projectEpoch && request === chatEpoch && projectId === get().activeProjectId
    try {
      const selection = get().modelSelection
      let chat = await api.chat.create(projectId)
      if (!current()) return false
      if (selection.providerId && selection.modelId) {
        chat = await api.chat.setModel(chat.id, selection.providerId, selection.modelId)
      }
      if (!current()) return false
      set((state) => ({
        chats: [chat, ...state.chats],
        activeChatId: chat.id,
        messages: [],
        streaming: null,
        usage: null,
        ...composerView(state.composerDrafts, projectId, chat.id),
        modelSelection: { providerId: chat.providerId, modelId: chat.modelId }
      }))
      return true
    } catch (error) {
      if (current()) toast.error(formatError(error))
      return false
    }
  },

  send: async (text: string, attachments?: AttachmentDraft[], newConversation = false) => {
    const initial = get()
    if (initial.pendingSend || initial.projectLoading || isRunning(initial.agentState)) return false
    if (!text.trim() && !attachments?.length) return false
    const projectId = initial.activeProjectId
    if (!projectId) {
      toast.error('请先创建或选择一个项目。')
      return false
    }
    const selection = initial.modelSelection
    if (!initial.providers.find((provider) => provider.id === selection.providerId)?.hasApiKey) {
      toast.error('当前选择的模型尚未配置 API Key，请在设置中配置或切换模型。')
      return false
    }
    const context = projectEpoch
    let request = chatEpoch
    let chatId = initial.activeChatId
    let key = draftKey(projectId, chatId)
    const draft = initial.composerDrafts[key]
    const consumesDraft = !newConversation && draft?.text.trim() === text.trim() && JSON.stringify(draft.attachments) === JSON.stringify(attachments ?? [])
    const queued = attachments?.map((attachment) => ({ ...attachment }))
    const current = (): boolean => context === projectEpoch && request === chatEpoch && projectId === get().activeProjectId && chatId === get().activeChatId
    // Acquired before the first await: two Enter/click handlers cannot both dispatch.
    set({ pendingSend: { projectId, chatId } })
    try {
      if (!chatId || newConversation) {
        let chat = await api.chat.create(projectId)
        if (!current()) return false
        if (selection.providerId && selection.modelId) {
          chat = await api.chat.setModel(chat.id, selection.providerId, selection.modelId)
          if (!current()) return false
        }
        const previousKey = key
        chatId = chat.id
        key = draftKey(projectId, chatId)
        request = ++chatEpoch
        set((state) => {
          const drafts = { ...state.composerDrafts }
          if (!newConversation && drafts[previousKey]) {
            drafts[key] = drafts[previousKey]!
            delete drafts[previousKey]
          }
          return {
            chats: [chat, ...state.chats], activeChatId: chat.id,
            messages: [], streaming: null, usage: null,
            composerDrafts: drafts, ...composerView(drafts, projectId, chat.id),
            pendingSend: { projectId, chatId }
          }
        })
      }
      const currentChat = get().chats.find((chat) => chat.id === chatId)
      if (currentChat && selection.providerId && (currentChat.providerId !== selection.providerId || currentChat.modelId !== selection.modelId)) {
        await api.chat.setModel(chatId, selection.providerId, selection.modelId)
        if (!current()) return false
      }
      const result = await api.chat.send({ projectId, chatId, text, attachments: queued })
      set((state) => {
        const drafts = { ...state.composerDrafts }
        // Do not erase text/attachments edited while IPC was pending, or another chat's draft.
        if (consumesDraft && drafts[key] === draft) delete drafts[key]
        return {
          composerDrafts: drafts,
          ...composerView(drafts, state.activeProjectId, state.activeChatId),
          ...(current() ? { messages: upsertMessage(state.messages, result.userMessage) } : {}),
          ...(state.activeProjectId === projectId ? {
            chats: state.chats.map((chat) => (chat.id === result.chat.id ? result.chat : chat))
          } : {})
        }
      })
      return true
    } catch (error) {
      toast.error(formatError(error))
      return false
    } finally {
      set({ pendingSend: null })
    }
  },

  stopAgent: async () => {
    try {
      await api.chat.stop()
    } catch (error) {
      toast.error(formatError(error))
    }
  },

  setChatModel: async (providerId: string, modelId: string) => {
    set({ modelSelection: { providerId, modelId } })
    const chatId = get().activeChatId
    if (!chatId) return
    try {
      const chat = await api.chat.setModel(chatId, providerId, modelId)
      set((state) => ({
        chats: state.chats.map((item) => (item.id === chat.id ? chat : item))
      }))
    } catch (error) {
      toast.error(formatError(error))
    }
  },

  respondApproval: async (id, approved, remember) => {
    set((state) => ({ approvals: state.approvals.filter((item) => item.id !== id) }))
    try {
      await api.approvals.respond({ id, approved, remember })
    } catch (error) {
      toast.error(formatError(error))
    }
  },

  seedPrompt: (text) => get().setComposerText(text),

  setComposerText: (text) => set((state) => {
    const key = draftKey(state.activeProjectId, state.activeChatId)
    const draft = state.composerDrafts[key] ?? EMPTY_DRAFT
    return { composerDraft: text, composerDrafts: { ...state.composerDrafts, [key]: { ...draft, text } } }
  }),

  addComposerAttachments: (projectId, chatId, items) => set((state) => {
    const key = draftKey(projectId, chatId)
    const draft = state.composerDrafts[key] ?? EMPTY_DRAFT
    const attachments = [...draft.attachments]
    for (const item of items) {
      if (attachments.length >= 10) break
      if (!attachments.some((existing) => existing.path === item.path)) attachments.push(item)
    }
    const drafts = { ...state.composerDrafts, [key]: { ...draft, attachments } }
    return { composerDrafts: drafts, ...composerView(drafts, state.activeProjectId, state.activeChatId) }
  }),

  removeComposerAttachment: (path) => set((state) => {
    const key = draftKey(state.activeProjectId, state.activeChatId)
    const draft = state.composerDrafts[key] ?? EMPTY_DRAFT
    const attachments = draft.attachments.filter((item) => item.path !== path)
    return { composerAttachments: attachments, composerDrafts: { ...state.composerDrafts, [key]: { ...draft, attachments } } }
  }),

  goToRunningChat: async () => {
    const running = get().agentState
    if (!isRunning(running) || !running?.chatId) return
    if (get().activeProjectId !== running.projectId) {
      const expected = projectEpoch + 1
      await get().openProject(running.projectId)
      if (projectEpoch !== expected || get().activeProjectId !== running.projectId) return
    }
    await get().selectChat(running.chatId)
  },

  handleEvent: (event) => {
    switch (event.type) {
      case 'agent-status': {
        set((state) => ({
          agentState: event.state,
          ...(['idle', 'stopped', 'error'].includes(event.state.status)
            && event.state.projectId === state.activeProjectId
            && event.state.chatId === state.activeChatId ? { streaming: null } : {})
        }))
        break
      }
      case 'chat-message': {
        if (event.projectId !== get().activeProjectId || event.chatId !== get().activeChatId) break
        set((state) => ({
          messages: upsertMessage(state.messages, event.message),
          ...(event.message.role === 'assistant' || event.message.role === 'user' ? { streaming: null } : {})
        }))
        break
      }
      case 'agent-stream': {
        if (event.projectId !== get().activeProjectId) break
        const chat = get().chats.find((item) => item.dshSessionId === event.sessionId && item.projectId === event.projectId)
        if (!chat || chat.id !== get().activeChatId) break
        const frame = event.frame as { type?: string; chunk?: Record<string, unknown> }
        if (frame.type === 'start') {
          set({ streaming: { sessionId: event.sessionId, chatId: chat.id, text: '', reasoning: '', active: true } })
          break
        }
        if (frame.type === 'end') {
          set((state) => ({
            streaming: state.streaming && state.streaming.sessionId === event.sessionId
              ? { ...state.streaming, active: false }
              : state.streaming
          }))
          break
        }
        if (frame.type !== 'chunk' || !frame.chunk) break
        const chunk = frame.chunk
        if (chunk.type === 'usage' && chunk.usage) {
          set({ usage: chunk.usage as AgentUsage })
          break
        }
        if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') break
        const text = typeof chunk.text === 'string' ? chunk.text : ''
        if (!text) break
        set((state) => {
          const current = state.streaming && state.streaming.sessionId === event.sessionId
            ? state.streaming
            : { sessionId: event.sessionId, chatId: chat.id, text: '', reasoning: '', active: true }
          return {
            streaming: chunk.type === 'text-delta'
              ? { ...current, text: current.text + text }
              : { ...current, reasoning: current.reasoning + text }
          }
        })
        break
      }
      case 'experiment-update': {
        set((state) => ({ experimentVersion: state.experimentVersion + 1 }))
        break
      }
      case 'figure-created': {
        set((state) => ({ figureVersion: state.figureVersion + 1 }))
        break
      }
      case 'pipeline-update': {
        set((state) => ({ pipelineVersion: state.pipelineVersion + 1 }))
        break
      }
      case 'project-updated': {
        set((state) => ({
          projects: state.projects.some((project) => project.id === event.project.id)
            ? state.projects.map((project) => (project.id === event.project.id ? event.project : project))
            : [event.project, ...state.projects]
        }))
        break
      }
      case 'approval-request': {
        set((state) => ({ approvals: [...state.approvals, event.request] }))
        break
      }
      case 'notice': {
        const notify = event.level === 'error' ? toast.error : event.level === 'warning' ? toast.warning : event.level === 'success' ? toast.success : toast.info
        notify(event.message)
        break
      }
    }
  }
}))
