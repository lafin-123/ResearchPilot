import assert from 'node:assert/strict'
import { before, beforeEach, test } from 'node:test'
import type { AgentPublicState, AppEvent, AttachmentDraft, BootstrapData, Chat, ChatMessage, ChatSendInput, ChatSendResult, Project, Provider } from '../src/shared/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const chat = (id: string, projectId = 'p1'): Chat => ({ id, projectId, title: id, dshSessionId: `session-${id}`, providerId: 'provider', modelId: 'model', createdAt: '', updatedAt: '' })
const message = (id: string, chatId = 'a', projectId = 'p1'): ChatMessage => ({ id, chatId, projectId, role: 'user', kind: 'text', content: id, createdAt: id })
const attachment: AttachmentDraft = { path: 'C:/draft.pdf', name: 'draft.pdf', kind: 'file', mimeType: 'application/pdf', size: 42 }
const a = chat('a'), b = chat('b'), c = chat('c', 'p2')
const running = (target = a): AgentPublicState => ({ status: 'running', projectId: target.projectId, chatId: target.id, sessionId: target.dshSessionId, providerId: 'provider', modelId: 'model', lastError: '' })
const mockApi = {
  bootstrap: async (): Promise<BootstrapData> => { throw new Error('Unexpected bootstrap') },
  projects: { setActive: async (_id: string): Promise<void> => {} },
  settings: { update: async (patch: { defaultProviderId?: string; defaultModelId?: string }) => ({ defaultProviderId: patch.defaultProviderId ?? 'provider', defaultModelId: patch.defaultModelId ?? 'model' }) },
  chat: {
    list: async (projectId: string): Promise<Chat[]> => projectId === 'p1' ? [a, b] : [c],
    messages: async (_id: string): Promise<ChatMessage[]> => [],
    create: async (projectId: string): Promise<Chat> => chat('created', projectId),
    setModel: async (id: string, providerId: string, modelId: string): Promise<Chat> => ({ ...chat(id), providerId, modelId }),
    send: async (input: ChatSendInput): Promise<ChatSendResult> => ({ chat: chat(input.chatId!, input.projectId), userMessage: message('sent', input.chatId, input.projectId) })
  }
}
const defaults = { ...mockApi.chat }
let store: typeof import('../src/renderer/src/store/app').useAppStore
let initial: ReturnType<typeof store.getState>
before(async () => {
  // api.ts captures window.researchpilot at module evaluation, so install IPC first.
  Object.defineProperty(globalThis, 'window', { value: { researchpilot: mockApi }, configurable: true })
  store = (await import('../src/renderer/src/store/app')).useAppStore
  initial = store.getState()
})
beforeEach(() => {
  Object.assign(mockApi.chat, defaults)
  mockApi.projects.setActive = async () => {}
  store.setState({
    ...initial,
    activeProjectId: 'p1', activeChatId: 'a', chats: [a, b],
    projects: [{ id: 'p1' }, { id: 'p2' }] as Project[],
    providers: [{ id: 'provider', hasApiKey: true, models: [{ id: 'model', label: 'Model' }, { id: 'other', label: 'Other' }] }] as Provider[],
    modelSelection: { providerId: 'provider', modelId: 'model' }
  }, true)
})

test('selecting before a chat exists persists the explicit default for a restart', async () => {
  store.setState({ activeChatId: '', chats: [] })
  await store.getState().setChatModel('provider', 'other')
  assert.equal(store.getState().settings?.defaultModelId, 'other')
  assert.equal(store.getState().modelSelection.modelId, 'other')
  assert.equal(store.getState().modelChanging, false)
})

test('changing the model persists the same chat without clearing messages or the draft', async () => {
  store.setState({ messages: [message('history')] })
  store.getState().setComposerText('continue the same discussion')
  const pending = deferred<Chat>()
  mockApi.chat.setModel = () => pending.promise
  const request = store.getState().setChatModel('provider', 'other')
  assert.equal(store.getState().modelChanging, true)
  assert.equal(store.getState().modelSelection.modelId, 'model')
  assert.equal(await store.getState().send('must wait'), false)
  pending.resolve({ ...a, modelId: 'other' })
  await request
  assert.equal(store.getState().modelChanging, false)
  assert.equal(store.getState().activeChatId, a.id)
  assert.equal(store.getState().chats[0].dshSessionId, a.dshSessionId)
  assert.equal(store.getState().modelSelection.modelId, 'other')
  assert.deepEqual(store.getState().messages.map(m => m.id), ['history'])
  assert.equal(store.getState().composerDraft, 'continue the same discussion')
})

test('failed model persistence leaves the confirmed selection unchanged', async () => {
  mockApi.chat.setModel = async () => { throw new Error('save failed') }
  await store.getState().setChatModel('provider', 'other')
  assert.equal(store.getState().modelSelection.modelId, 'model')
  assert.equal(store.getState().chats[0].modelId, 'model')
  assert.equal(store.getState().modelChanging, false)
})

test('late model save updates only its originating chat after navigation', async () => {
  const pending = deferred<Chat>()
  mockApi.chat.setModel = () => pending.promise
  const request = store.getState().setChatModel('provider', 'other')
  await store.getState().selectChat('b')
  pending.resolve({ ...a, modelId: 'other' })
  await request
  assert.equal(store.getState().activeChatId, 'b')
  assert.equal(store.getState().modelSelection.modelId, 'model')
  assert.equal(store.getState().chats.find(c => c.id === 'a')?.modelId, 'other')
})

test('model changes are rejected while a reply is running or a send is pending', async () => {
  let calls = 0
  mockApi.chat.setModel = async (...args) => { calls++; return defaults.setModel(...args) }
  store.setState({ agentState: running() })
  await store.getState().setChatModel('provider', 'other')
  store.setState({ agentState: null, pendingSend: { projectId: 'p1', chatId: 'a' } })
  await store.getState().setChatModel('provider', 'other')
  assert.equal(calls, 0)
  assert.equal(store.getState().modelSelection.modelId, 'model')
})

test('older chat lists cannot replace a confirmed model change', async () => {
  const list = deferred<Chat[]>()
  mockApi.chat.list = () => list.promise
  const loading = store.getState().loadChats()
  await store.getState().setChatModel('provider', 'other')
  list.resolve([a, b])
  await loading
  assert.equal(store.getState().modelSelection.modelId, 'other')
  assert.equal(store.getState().chats[0].modelId, 'other')
})

test('model confirmation after project roundtrip reconciles the active chat', async () => {
  const saved = deferred<Chat>()
  mockApi.chat.setModel = () => saved.promise
  const switching = store.getState().setChatModel('provider', 'other')
  await store.getState().openProject('p2')
  await store.getState().openProject('p1')
  saved.resolve({ ...a, modelId: 'other' })
  await switching
  assert.equal(store.getState().activeChatId, 'a')
  assert.equal(store.getState().modelSelection.modelId, 'other')
})

test('new chat preparation blocks competing model changes and sends', async () => {
  const created = deferred<Chat>()
  mockApi.chat.create = () => created.promise
  let switches = 0
  mockApi.chat.setModel = async (...args) => { switches++; return defaults.setModel(...args) }
  const creating = store.getState().newChat()
  await store.getState().setChatModel('provider', 'other')
  assert.equal(await store.getState().send('blocked'), false)
  assert.equal(switches, 0)
  created.resolve(chat('created'))
  await creating
  assert.equal(store.getState().modelSelection.modelId, 'model')
  assert.equal(store.getState().pendingSend, null)
})

test('model save in one project does not invalidate another project chat list', async () => {
  const saved = deferred<Chat>()
  const list = deferred<Chat[]>()
  mockApi.chat.setModel = () => saved.promise
  const switching = store.getState().setChatModel('provider', 'other')
  mockApi.chat.list = id => id === 'p2' ? list.promise : Promise.resolve([a, b])
  const navigating = store.getState().openProject('p2')
  await Promise.resolve(); await Promise.resolve()
  saved.resolve({ ...a, modelId: 'other' })
  await switching
  list.resolve([c])
  await navigating
  assert.equal(store.getState().activeProjectId, 'p2')
  assert.equal(store.getState().activeChatId, 'c')
})

test('preparing a default-model chat without a key does not require a redundant model update', async () => {
  store.setState({ providers: [{ id: 'provider', hasApiKey: false, models: [{ id: 'model', label: 'Model' }] }] as Provider[] })
  mockApi.chat.setModel = async () => { throw new Error('No key for model validation') }
  assert.equal(await store.getState().newChat(), true)
  assert.equal(store.getState().activeChatId, 'created')
})

test('late stream frames cannot recreate an answer after the turn is stored and idle', () => {
  store.setState({ agentState: { ...running(), status: 'idle' }, messages: [{ ...message('answer'), role: 'assistant', content: 'finished' }] })
  store.getState().handleEvent({ type: 'agent-stream', projectId: 'p1', sessionId: a.dshSessionId, frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'finished' } } } as AppEvent)
  assert.equal(store.getState().streaming, null)
  assert.equal(store.getState().messages.length, 1)
})

test('explicit dedicated task sends once with selected model and preserves original composer draft', async () => {
  store.getState().seedPrompt('unsent human message')
  store.getState().addComposerAttachments('p1', 'a', [attachment])
  const sends: ChatSendInput[] = []
  const models: string[] = []
  mockApi.chat.setModel = async (id, providerId, modelId) => { models.push(`${id}/${providerId}/${modelId}`); return { ...chat(id), providerId, modelId } }
  mockApi.chat.send = async (input) => { sends.push(input); return defaults.send(input) }
  assert.equal(await store.getState().send('Generate a reading draft now', [], true), true)
  assert.equal(store.getState().activeChatId, 'created')
  assert.deepEqual(models, ['created/provider/model'])
  assert.equal(sends.length, 1)
  assert.equal(sends[0].chatId, 'created')
  assert.equal(sends[0].text, 'Generate a reading draft now')
  await store.getState().selectChat('a')
  assert.equal(store.getState().composerDraft, 'unsent human message')
  assert.equal(store.getState().composerAttachments[0].path, attachment.path)
})

test('navigation cancels dedicated task preparation without sending or consuming another draft', async () => {
  const created = deferred<Chat>()
  let sends = 0
  mockApi.chat.create = () => created.promise
  mockApi.chat.send = async input => { sends++; return defaults.send(input) }
  store.getState().seedPrompt('keep this')
  const pending = store.getState().send('reading task', [], true)
  assert.equal(await store.getState().send('duplicate', [], true), false)
  await store.getState().selectChat('b')
  created.resolve(chat('created'))
  assert.equal(await pending, false)
  assert.equal(sends, 0)
  await store.getState().selectChat('a')
  assert.equal(store.getState().composerDraft, 'keep this')
})

test('latest selection wins even when older history completes last', async () => {
  const old = deferred<ChatMessage[]>()
  mockApi.chat.messages = async (id) => id === 'a' ? old.promise : [message('b-history', 'b')]
  const pending = store.getState().selectChat('a')
  await store.getState().selectChat('b')
  old.resolve([message('old')])
  await pending
  assert.equal(store.getState().activeChatId, 'b')
  assert.deepEqual(store.getState().messages.map((m) => m.id), ['b-history'])
})

test('A -> B -> A selection uses the newest A history, not merely matching IDs', async () => {
  const old = deferred<ChatMessage[]>()
  let calls = 0
  mockApi.chat.messages = async (id) => {
    if (id !== 'a') return []
    return ++calls === 1 ? old.promise : [message('latest')]
  }
  const pending = store.getState().selectChat('a')
  await store.getState().selectChat('b')
  await store.getState().selectChat('a')
  old.resolve([message('stale')])
  await pending
  assert.deepEqual(store.getState().messages.map((m) => m.id), ['latest'])
})

test('selection invalidates an older list response in the same project', async () => {
  const old = deferred<Chat[]>()
  mockApi.chat.list = async () => old.promise
  const pending = store.getState().loadChats()
  await store.getState().selectChat('b')
  old.resolve([a])
  await pending
  assert.equal(store.getState().activeChatId, 'b')
  assert.deepEqual(store.getState().chats, [a, b])
})

test('navigation during send preparation cancels dispatch and preserves source draft', async () => {
  const model = deferred<Chat>()
  let calls = 0
  store.setState({ modelSelection: { providerId: 'provider', modelId: 'changed' } })
  store.getState().seedPrompt('do not move')
  mockApi.chat.setModel = async () => model.promise
  mockApi.chat.send = async (input) => { calls++; return defaults.send(input) }
  const pending = store.getState().send('do not move')
  await store.getState().selectChat('b')
  store.getState().seedPrompt('B draft')
  model.resolve({ ...a, modelId: 'changed' })
  assert.equal(await pending, false)
  assert.equal(calls, 0)
  assert.equal(store.getState().composerDraft, 'B draft')
  await store.getState().selectChat('a')
  assert.equal(store.getState().composerDraft, 'do not move')
})

test('send completion after a project switch cannot insert an old project message', async () => {
  const result = deferred<ChatSendResult>()
  mockApi.chat.send = async () => result.promise
  store.getState().seedPrompt('A draft')
  const pending = store.getState().send('A draft')
  await store.getState().openProject('p2')
  store.getState().seedPrompt('C draft')
  result.resolve({ chat: a, userMessage: message('old project') })
  await pending
  assert.equal(store.getState().activeProjectId, 'p2')
  assert.equal(store.getState().activeChatId, 'c')
  assert.equal(store.getState().composerDraft, 'C draft')
  assert.deepEqual(store.getState().messages, [])
  assert.deepEqual(store.getState().chats, [c])
})

test('project switch invalidates an old list response', async () => {
  const old = deferred<Chat[]>()
  mockApi.chat.list = async (id) => id === 'p1' ? old.promise : [c]
  const pending = store.getState().loadChats()
  await store.getState().openProject('p2')
  old.resolve([a, b])
  await pending
  assert.equal(store.getState().activeProjectId, 'p2')
  assert.equal(store.getState().activeChatId, 'c')
  assert.deepEqual(store.getState().chats, [c])
})

test('project switch invalidates history already requested by loadChats', async () => {
  const old = deferred<ChatMessage[]>()
  const requested = deferred<void>()
  mockApi.chat.messages = async (id) => {
    if (id === 'a') { requested.resolve(); return old.promise }
    return [message('new-project', 'c', 'p2')]
  }
  const pending = store.getState().loadChats()
  await requested.promise
  await store.getState().openProject('p2')
  old.resolve([message('old-project')])
  await pending
  assert.deepEqual(store.getState().messages.map((m) => m.id), ['new-project'])
})

test('project intent invalidates old reads before setActive finishes', async () => {
  const old = deferred<ChatMessage[]>()
  const switching = deferred<void>()
  mockApi.chat.messages = async (id) => id === 'a' ? old.promise : []
  mockApi.projects.setActive = async () => switching.promise
  const read = store.getState().selectChat('a')
  const change = store.getState().openProject('p2')
  old.resolve([message('stale')])
  await read
  assert.deepEqual(store.getState().messages, [])
  assert.equal(await store.getState().send('blocked during switch'), false)
  switching.resolve()
  await change
})

test('latest openProject intent wins out-of-order setActive completions', async () => {
  const old = deferred<void>()
  mockApi.projects.setActive = async (id) => { if (id === 'p2') await old.promise }
  const pending = store.getState().openProject('p2')
  await store.getState().openProject('p1')
  old.resolve()
  await pending
  assert.equal(store.getState().activeProjectId, 'p1')
  assert.equal(store.getState().activeChatId, 'a')
  assert.equal(store.getState().projectLoading, false)
})

test('late bootstrap cannot restore a project selected before navigation', async () => {
  const old = deferred<BootstrapData>()
  mockApi.bootstrap = async () => old.promise
  const pending = store.getState().refreshBootstrap()
  await store.getState().openProject('p2')
  old.resolve({ activeProjectId: 'p1' } as BootstrapData)
  await pending
  assert.equal(store.getState().activeProjectId, 'p2')
})

test('newChat completion cannot steal selection or install a different project chat', async () => {
  const create = deferred<Chat>()
  mockApi.chat.create = async () => create.promise
  const pending = store.getState().newChat()
  await store.getState().openProject('p2')
  create.resolve(chat('late'))
  assert.equal(await pending, false)
  assert.equal(store.getState().activeChatId, 'c')
  assert.deepEqual(store.getState().chats, [c])
})

test('history read merges events delivered while it was pending', async () => {
  const history = deferred<ChatMessage[]>()
  mockApi.chat.messages = async () => history.promise
  const pending = store.getState().selectChat('a')
  store.getState().handleEvent({ type: 'chat-message', projectId: 'p1', chatId: 'a', message: message('live') })
  history.resolve([message('history')])
  await pending
  assert.deepEqual(store.getState().messages.map((m) => m.id), ['history', 'live'])
})

test('inactive chat/project stream never contaminates active usage or text', () => {
  const stream = (target: Chat, chunk: object): AppEvent => ({ type: 'agent-stream', projectId: target.projectId, sessionId: target.dshSessionId, frame: { type: 'chunk', chunk } } as AppEvent)
  store.getState().handleEvent(stream(a, { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }))
  store.getState().handleEvent(stream(b, { type: 'usage', usage: { inputTokens: 999, outputTokens: 999 } }))
  store.getState().handleEvent(stream(b, { type: 'text-delta', text: 'wrong chat' }))
  store.getState().handleEvent(stream({ ...a, projectId: 'p2' }, { type: 'usage', usage: { inputTokens: 999 } }))
  assert.equal(store.getState().usage?.inputTokens, 10)
  assert.equal(store.getState().streaming, null)
  store.getState().handleEvent(stream(a, { type: 'text-delta', text: 'correct' }))
  assert.equal(store.getState().streaming?.text, 'correct')
})

test('drafts isolate text and attachments by project/chat and survive view unsubscription', async () => {
  const unsubscribe = store.subscribe(() => {})
  store.getState().setComposerText('  draft A  ')
  store.getState().addComposerAttachments('p1', 'a', [attachment])
  unsubscribe() // No component owns or clears the draft on unmount.
  await store.getState().selectChat('b')
  assert.equal(store.getState().composerDraft, '')
  assert.deepEqual(store.getState().composerAttachments, [])
  store.getState().seedPrompt('handoff B')
  await store.getState().openProject('p2')
  store.getState().seedPrompt('handoff C')
  await store.getState().openProject('p1')
  assert.equal(store.getState().composerDraft, '  draft A  ')
  assert.deepEqual(store.getState().composerAttachments, [attachment])
  await store.getState().selectChat('b')
  assert.equal(store.getState().composerDraft, 'handoff B')
  await store.getState().openProject('p2')
  assert.equal(store.getState().composerDraft, 'handoff C')
})

test('attachment picker completion updates its originating scope, with dedup and limit', async () => {
  await store.getState().selectChat('b')
  store.getState().addComposerAttachments('p1', 'a', [attachment, attachment])
  assert.deepEqual(store.getState().composerAttachments, [])
  await store.getState().selectChat('a')
  assert.deepEqual(store.getState().composerAttachments, [attachment])
  store.getState().addComposerAttachments('p1', 'a', Array.from({ length: 15 }, (_, i) => ({ ...attachment, path: String(i) })))
  assert.equal(store.getState().composerAttachments.length, 10)
  store.getState().removeComposerAttachment(attachment.path)
  assert.equal(store.getState().composerAttachments.length, 9)
})

test('double send before any backend status event makes exactly one IPC call', async () => {
  const result = deferred<ChatSendResult>()
  let calls = 0
  mockApi.chat.send = async () => { calls++; return result.promise }
  store.getState().seedPrompt('hello')
  const first = store.getState().send('hello', [])
  assert.deepEqual(store.getState().pendingSend, { projectId: 'p1', chatId: 'a' })
  assert.equal(await store.getState().send('hello', []), false)
  assert.equal(calls, 1)
  result.resolve({ chat: a, userMessage: message('sent') })
  assert.equal(await first, true)
  assert.equal(store.getState().composerDraft, '')
  assert.equal(store.getState().pendingSend, null)
})

test('pending guard covers chat creation and failed first send preserves the migrated draft', async () => {
  store.setState({ activeChatId: '', chats: [] })
  store.getState().seedPrompt('  unsent  ')
  store.getState().addComposerAttachments('p1', '', [attachment])
  const created = deferred<Chat>()
  let creates = 0, sends = 0
  mockApi.chat.create = async () => { creates++; return created.promise }
  mockApi.chat.send = async () => { sends++; throw new Error('offline') }
  const first = store.getState().send('unsent', [attachment])
  assert.equal(await store.getState().send('unsent', [attachment]), false)
  created.resolve(chat('created'))
  assert.equal(await first, false)
  assert.equal(creates, 1)
  assert.equal(sends, 1)
  assert.equal(store.getState().activeChatId, 'created')
  assert.equal(store.getState().composerDraft, '  unsent  ')
  assert.deepEqual(store.getState().composerAttachments, [attachment])
})

test('failed send preserves exact draft and never overwrites the newly selected chat', async () => {
  const result = deferred<ChatSendResult>()
  mockApi.chat.send = async () => result.promise
  store.getState().seedPrompt('  preserve whitespace  ')
  store.getState().addComposerAttachments('p1', 'a', [attachment])
  const pending = store.getState().send('preserve whitespace', [attachment])
  await store.getState().selectChat('b')
  store.getState().seedPrompt('B untouched')
  result.reject(new Error('offline'))
  assert.equal(await pending, false)
  assert.equal(store.getState().composerDraft, 'B untouched')
  await store.getState().selectChat('a')
  assert.equal(store.getState().composerDraft, '  preserve whitespace  ')
  assert.deepEqual(store.getState().composerAttachments, [attachment])
  assert.equal(store.getState().pendingSend, null)
})

test('successful send clears only the originating unchanged draft and cannot install old messages', async () => {
  const result = deferred<ChatSendResult>()
  mockApi.chat.send = async () => result.promise
  store.getState().seedPrompt('A')
  const pending = store.getState().send('A')
  await store.getState().selectChat('b')
  store.getState().seedPrompt('B')
  result.resolve({ chat: a, userMessage: message('sent-to-a') })
  assert.equal(await pending, true)
  assert.equal(store.getState().composerDraft, 'B')
  assert.deepEqual(store.getState().messages, [])
  await store.getState().selectChat('a')
  assert.equal(store.getState().composerDraft, '')
})

test('successful send does not erase draft edits made while IPC is pending', async () => {
  const result = deferred<ChatSendResult>()
  mockApi.chat.send = async () => result.promise
  store.getState().seedPrompt('first')
  const pending = store.getState().send('first')
  store.getState().seedPrompt('next thought')
  result.resolve({ chat: a, userMessage: message('sent') })
  await pending
  assert.equal(store.getState().composerDraft, 'next thought')
})

test('global running guard blocks dispatch and running-chat navigation restores its draft', async () => {
  let calls = 0
  mockApi.chat.send = async (input) => { calls++; return defaults.send(input) }
  store.getState().seedPrompt('A draft')
  store.setState({ agentState: running(a) })
  await store.getState().selectChat('b')
  store.getState().seedPrompt('B draft')
  assert.equal(await store.getState().send('B draft'), false)
  assert.equal(calls, 0)
  await store.getState().goToRunningChat()
  assert.equal(store.getState().activeChatId, 'a')
  assert.equal(store.getState().composerDraft, 'A draft')
  store.setState({ agentState: running(c) })
  await store.getState().goToRunningChat()
  assert.equal(store.getState().activeProjectId, 'p2')
  assert.equal(store.getState().activeChatId, 'c')
})
