import type { Chat, ChatAttachment, ChatMessage, MessageKind, MessageRole, ToolActivity } from '@shared/types'
import type { Db } from '../lib/db'
import { newId, nowIso, sessionId } from '../lib/util'

interface ChatRow {
  id: string
  project_id: string
  title: string
  dsh_session_id: string
  provider_id: string
  model_id: string
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  chat_id: string
  project_id: string
  role: MessageRole
  kind: MessageKind
  content: string
  meta_json: string
  created_at: string
}

function mapChat(row: ChatRow): Chat {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    dshSessionId: row.dsh_session_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapMessage(row: MessageRow): ChatMessage {
  let tool: ToolActivity | undefined
  let attachments: ChatAttachment[] | undefined
  try {
    const meta = JSON.parse(row.meta_json) as { tool?: ToolActivity; attachments?: ChatAttachment[] }
    tool = meta.tool
    if (Array.isArray(meta.attachments) && meta.attachments.length > 0) attachments = meta.attachments
  } catch {
    tool = undefined
    attachments = undefined
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    projectId: row.project_id,
    role: row.role,
    kind: row.kind,
    content: row.content,
    tool,
    attachments,
    createdAt: row.created_at
  }
}

export class ChatService {
  constructor(private readonly db: Db) {}

  list(projectId: string): Chat[] {
    return this.db.all<ChatRow>('SELECT * FROM chats WHERE project_id = ? ORDER BY updated_at DESC', projectId).map(mapChat)
  }

  get(id: string): Chat {
    const row = this.db.get<ChatRow>('SELECT * FROM chats WHERE id = ?', id)
    if (!row) throw new Error('会话不存在。')
    return mapChat(row)
  }

  create(projectId: string, providerId: string, modelId: string, title = '新对话'): Chat {
    const id = newId('chat')
    const timestamp = nowIso()
    this.db.run(
      'INSERT INTO chats (id, project_id, title, dsh_session_id, provider_id, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      projectId,
      title,
      sessionId(),
      providerId,
      modelId,
      timestamp,
      timestamp
    )
    return this.get(id)
  }

  setModel(chatId: string, providerId: string, modelId: string): Chat {
    this.get(chatId)
    this.db.run('UPDATE chats SET provider_id = ?, model_id = ?, updated_at = ? WHERE id = ?', providerId, modelId, nowIso(), chatId)
    return this.get(chatId)
  }

  ensure(projectId: string, chatId: string | undefined, providerId: string, modelId: string): Chat {
    if (chatId) {
      const chat = this.get(chatId)
      if (chat.projectId !== projectId) throw new Error('会话不属于当前项目。')
      return chat
    }
    return this.create(projectId, providerId, modelId)
  }

  messages(chatId: string): ChatMessage[] {
    return this.db
      .all<MessageRow>('SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC', chatId)
      .map(mapMessage)
  }

  messageCount(chatId: string): number {
    return this.db.scalar<number>('SELECT COUNT(*) FROM chat_messages WHERE chat_id = ?', chatId) ?? 0
  }

  isSessionStarted(chatId: string): boolean {
    return (this.db.scalar<number>('SELECT session_started FROM chats WHERE id = ?', chatId) ?? 0) === 1
  }

  markSessionStarted(chatId: string): void {
    this.db.run('UPDATE chats SET session_started = 1 WHERE id = ?', chatId)
  }

  addMessage(input: {
    chatId: string
    projectId: string
    role: MessageRole
    kind: MessageKind
    content: string
    tool?: ToolActivity
    attachments?: ChatAttachment[]
    id?: string
    createdAt?: string
  }): ChatMessage {
    const id = input.id ?? newId('msg')
    const timestamp = input.createdAt ?? nowIso()
    this.db.run(
      'INSERT OR REPLACE INTO chat_messages (id, chat_id, project_id, role, kind, content, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      input.chatId,
      input.projectId,
      input.role,
      input.kind,
      input.content,
      JSON.stringify({
        ...(input.tool ? { tool: input.tool } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {})
      }),
      timestamp
    )
    this.db.run('UPDATE chats SET updated_at = ? WHERE id = ?', timestamp, input.chatId)
    if (input.role === 'user') {
      const count = this.db.scalar<number>("SELECT COUNT(*) FROM chat_messages WHERE chat_id = ? AND role = 'user'", input.chatId) ?? 0
      if (count === 1) {
        const fallback = input.attachments?.[0]?.name ?? '附件任务'
        const title = input.content.replace(/\s+/g, ' ').trim().slice(0, 32) || fallback
        this.db.run('UPDATE chats SET title = ? WHERE id = ?', title, input.chatId)
      }
    }
    return mapMessage(this.db.get<MessageRow>('SELECT * FROM chat_messages WHERE id = ?', id)!)
  }

  updateTool(input: {
    chatId: string
    projectId: string
    callId: string
    name: string
    arguments: string
    status: ToolActivity['status']
    result?: string
    isError?: boolean
  }): ChatMessage {
    const id = `tool-${input.callId}`
    const existing = this.db.get<MessageRow>('SELECT * FROM chat_messages WHERE id = ?', id)
    let previous: ToolActivity | undefined
    try {
      previous = existing ? (JSON.parse(existing.meta_json) as { tool?: ToolActivity }).tool : undefined
    } catch {
      previous = undefined
    }
    const tool: ToolActivity = {
      callId: input.callId,
      name: input.name || previous?.name || 'tool',
      arguments: input.arguments || previous?.arguments || '',
      status: input.status,
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.isError === undefined ? {} : { isError: input.isError })
    }
    if (existing) {
      this.db.run(
        'UPDATE chat_messages SET content = ?, meta_json = ? WHERE id = ?',
        input.result ?? existing.content,
        JSON.stringify({ tool }),
        id
      )
      return mapMessage(this.db.get<MessageRow>('SELECT * FROM chat_messages WHERE id = ?', id)!)
    }
    return this.addMessage({
      id,
      chatId: input.chatId,
      projectId: input.projectId,
      role: 'tool',
      kind: 'tool',
      content: input.result ?? '',
      tool
    })
  }

  delete(id: string): void {
    this.get(id)
    this.db.run('DELETE FROM chats WHERE id = ?', id)
  }
}
