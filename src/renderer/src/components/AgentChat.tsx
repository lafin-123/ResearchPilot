import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, Bot, ChevronDown, CircleStop, FileText, Image as ImageIcon, KeyRound, MessageSquarePlus, Paperclip, Sparkles, Wrench, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import type { ChatMessage, ToolActivity } from '@shared/types'
import { api, formatBytes, formatError } from '../lib/api'
import { useAppStore } from '../store/app'
import { IconButton, StatusBadge } from './Ui'

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function ToolCard({ tool }: { tool: ToolActivity }): ReactNode {
  return (
    <details className="tool-card" open={tool.status === 'failed'}>
      <summary className="tool-head">
        <Wrench size={13} />
        <span className="tool-name">{tool.name}</span>
        <span className="tool-status">
          <span className={`status-dot ${tool.status === 'running' ? 'running' : tool.status === 'failed' ? 'error' : 'idle'}`} />
          {tool.status === 'running' ? '执行中' : tool.status === 'failed' ? '失败' : '完成'}
          <ChevronDown size={12} />
        </span>
      </summary>
      <div className="tool-detail">
        {tool.arguments ? (
          <>
            <div className="tiny muted" style={{ marginBottom: 4 }}>参数</div>
            <pre>{prettyJson(tool.arguments)}</pre>
          </>
        ) : null}
        {tool.result ? (
          <>
            <div className="tiny muted" style={{ margin: '8px 0 4px' }}>结果</div>
            <pre>{prettyJson(tool.result)}</pre>
          </>
        ) : null}
      </div>
    </details>
  )
}

function MessageView({ message }: { message: ChatMessage }): ReactNode {
  if (message.kind === 'tool' && message.tool) {
    return (
      <div className="msg">
        <div className="msg-body" style={{ maxWidth: '100%', width: '100%' }}>
          <div className="msg-meta">工具活动 · {new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
          <ToolCard tool={message.tool} />
        </div>
      </div>
    )
  }

  if (message.kind === 'status') {
    return <div className="system-note">{message.content}</div>
  }

  const isUser = message.role === 'user'
  const isError = message.kind === 'error'
  return (
    <div className={`msg ${isUser ? 'user' : ''}`}>
      <div className="msg-body">
        <div className="msg-meta">
          {isUser ? '你' : isError ? '系统' : 'ResearchPilot'} · {new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        </div>
        {isError ? (
          <div className="bubble error">{message.content}</div>
        ) : isUser ? (
          <>
            {message.content ? <div className="bubble user" style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div> : null}
            {message.attachments?.length ? (
              <div className="msg-attachments">
                {message.attachments.map((attachment) => (
                  <span className="msg-attachment" key={attachment.relativePath}>
                    {attachment.kind === 'image' ? <ImageIcon size={12} /> : <FileText size={12} />}
                    <span>{attachment.name}</span>
                    <span className="muted">{formatBytes(attachment.size)}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className="bubble assistant markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}

const SUGGESTIONS = [
  '帮我把这个研究方向拆成可执行的实验计划',
  '检索相关文献，找出还没有被解决的 gap',
  '分析最近的实验运行，判断结果是否支持假设',
  '基于已有实验证据，开始生成论文初稿'
]

export function ChatPanel({ variant = 'dock' }: { variant?: 'dock' | 'page' }): ReactNode {
  const navigate = useNavigate()
  const messages = useAppStore((state) => state.messages)
  const streaming = useAppStore((state) => state.streaming)
  const usage = useAppStore((state) => state.usage)
  const agentState = useAppStore((state) => state.agentState)
  const pendingSend = useAppStore((state) => state.pendingSend)
  const projectLoading = useAppStore((state) => state.projectLoading)
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const goToRunningChat = useAppStore((state) => state.goToRunningChat)
  const providers = useAppStore((state) => state.providers)
  const activeChatId = useAppStore((state) => state.activeChatId)
  const modelSelection = useAppStore((state) => state.modelSelection)
  const send = useAppStore((state) => state.send)
  const stop = useAppStore((state) => state.stopAgent)
  const text = useAppStore((state) => state.composerDraft)
  const attachments = useAppStore((state) => state.composerAttachments)
  const setText = useAppStore((state) => state.setComposerText)
  const addAttachments = useAppStore((state) => state.addComposerAttachments)
  const removeAttachment = useAppStore((state) => state.removeComposerAttachment)
  const globallyRunning = agentState?.status === 'running' || agentState?.status === 'starting'
  const matchesChat = agentState?.projectId === activeProjectId && agentState?.chatId === activeChatId
  const running = globallyRunning && matchesChat
  const busy = globallyRunning || Boolean(pendingSend) || projectLoading
  const [dragging, setDragging] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const hasKey = Boolean(providers.find((provider) => provider.id === modelSelection.providerId)?.hasApiKey)

  useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [messages, running, streaming?.text, streaming?.reasoning])

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`
  }, [text])

  const doSend = async (): Promise<void> => {
    // Read the current scope at dispatch time; the store owns clearing on success.
    const state = useAppStore.getState()
    await send(state.composerDraft.trim(), state.composerAttachments)
  }

  const pickAttachments = async (): Promise<void> => {
    const { activeProjectId: projectId, activeChatId: chatId } = useAppStore.getState()
    try {
      addAttachments(projectId, chatId, await api.chooseAttachments())
    } catch (error) {
      toast.error(formatError(error))
    }
  }

  const handleDrop = async (event: DragEvent<HTMLDivElement>): Promise<void> => {
    event.preventDefault()
    setDragging(false)
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => (file as File & { path?: string }).path)
      .filter((path): path is string => Boolean(path))
    if (paths.length === 0) {
      toast.error('无法读取拖入文件的路径，请使用附件按钮选择文件。')
      return
    }
    const { activeProjectId: projectId, activeChatId: chatId } = useAppStore.getState()
    try {
      addAttachments(projectId, chatId, await api.inspectAttachments(paths))
    } catch (error) {
      toast.error(formatError(error))
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className={`chat-scroll ${variant === 'page' ? 'page-mode' : ''}`} ref={scrollRef}>
        <div className="chat-messages">
          {!hasKey ? (
            <div className="alert alert-warn">
              <KeyRound />
              <div>
                <strong>还没有配置模型 API Key。</strong>
                <div className="mt-2">
                  支持 ChatGPT / OpenAI、Anthropic Claude、Gemini、OpenRouter、Kimi、GLM、通义千问、DeepSeek 或任意兼容网关。密钥会通过系统安全存储加密。
                </div>
                <button className="btn btn-secondary btn-sm mt-2" onClick={() => navigate('/settings')}>前往配置</button>
              </div>
            </div>
          ) : null}

          {messages.length === 0 ? (
            <div className="chat-empty">
              <div className="chat-empty-mark"><Sparkles size={22} /></div>
              <h3>从研究问题开始</h3>
              <p>我会先检索文献、形成可验证假设，再执行实验，最后才生成论文。所有结论都要有证据。</p>
              <div className="suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} className="suggestion" onClick={() => { setText(suggestion); textareaRef.current?.focus() }}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((message) => <MessageView key={message.id} message={message} />)}
            </>
          )}
          {streaming && streaming.chatId === activeChatId && (streaming.text || streaming.reasoning || streaming.active) ? (
            <div className="msg">
              <div className="msg-body" style={{ maxWidth: '100%' }}>
                <div className="msg-meta">ResearchPilot · {streaming.active ? '生成中' : '同步中'}</div>
                {streaming.reasoning ? (
                  <details className="reasoning-card">
                    <summary>思考过程</summary>
                    <div>{streaming.reasoning}</div>
                  </details>
                ) : null}
                <div className="bubble assistant markdown">
                  {streaming.text ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{streaming.text}</ReactMarkdown> : <span className="stream-wait">正在组织回答…</span>}
                  {streaming.active ? <span className="stream-cursor" /> : null}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="chat-composer">
        {usage ? (
          <div className="usage-line">
            <span>上下文 {formatTokens(usage.inputTokens)}</span>
            <span>输出 {formatTokens(usage.outputTokens)}</span>
            {usage.cacheReadTokens ? <span>缓存命中 {formatTokens(usage.cacheReadTokens)}</span> : null}
            {usage.reasoningTokens ? <span>推理 {formatTokens(usage.reasoningTokens)}</span> : null}
          </div>
        ) : null}
        {globallyRunning && !matchesChat ? (
          <div className="running-note">
            <span>另一个会话正在执行任务；当前草稿会保留。</span>
            <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => void goToRunningChat()}>查看运行中的会话</button>
          </div>
        ) : null}
        {pendingSend?.projectId === activeProjectId && pendingSend.chatId === activeChatId ? (
          <div className="running-note" role="status">正在提交任务…</div>
        ) : null}
        {running ? (
          <div className="running-note">
            <span className="running-dots"><i /><i /><i /></span>
            <span>正在执行研究任务，工具调用会实时显示。</span>
            <button className="btn btn-danger btn-sm" style={{ marginLeft: 'auto' }} onClick={() => void stop()}>
              <CircleStop size={13} />
              停止
            </button>
          </div>
        ) : null}
        <div
          className={`composer-box${dragging ? ' dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
          }}
          onDrop={(event) => void handleDrop(event)}
        >
          {dragging ? <div className="drop-hint">松开以添加 PDF、图片或数据文件</div> : null}
          {attachments.length > 0 ? (
            <div className="composer-attachments">
              {attachments.map((attachment) => (
                <span className="attachment-chip" key={attachment.path}>
                  {attachment.kind === 'image' ? <ImageIcon size={12} /> : <FileText size={12} />}
                  <span className="attachment-chip-name">{attachment.name}</span>
                  <span className="attachment-chip-size">{formatBytes(attachment.size)}</span>
                  <button
                    type="button"
                    title="移除附件"
                    onClick={() => removeAttachment(attachment.path)}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            value={text}
            placeholder={hasKey ? '描述研究任务，或拖入 PDF / 图片 / 数据…  Enter 发送' : '请先在设置中配置 API Key'}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void doSend()
              }
            }}
          />
          <div className="composer-actions">
            <button className="btn btn-ghost btn-sm composer-attach" title="添加附件" onClick={() => void pickAttachments()} disabled={running}>
              <Paperclip size={13} />
              <span>附件</span>
            </button>
            <span className="composer-hint">
              {matchesChat && agentState?.status === 'error' ? '上次运行出错，可重新发送。' : '实验与远程命令需要你的确认。'}
            </span>
            <button className="btn btn-primary btn-sm" style={{ width: 30, height: 28, padding: 0 }} title="发送（Enter）" disabled={(!text.trim() && attachments.length === 0) || busy || !hasKey} onClick={() => void doSend()}>
              <ArrowUp size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function AssistantDock(): ReactNode {
  const navigate = useNavigate()
  const chats = useAppStore((state) => state.chats)
  const activeChatId = useAppStore((state) => state.activeChatId)
  const selectChat = useAppStore((state) => state.selectChat)
  const newChat = useAppStore((state) => state.newChat)
  const agentState = useAppStore((state) => state.agentState)
  const providers = useAppStore((state) => state.providers)
  const modelSelection = useAppStore((state) => state.modelSelection)
  const setChatModel = useAppStore((state) => state.setChatModel)
  const setAssistantOpen = useAppStore((state) => state.setAssistantOpen)
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const pendingSend = useAppStore((state) => state.pendingSend)
  const running = agentState?.status === 'running' || agentState?.status === 'starting'
  const matchesChat = agentState?.projectId === activeProjectId && agentState?.chatId === activeChatId

  const currentValue = modelSelection.providerId && modelSelection.modelId ? `${modelSelection.providerId}::${modelSelection.modelId}` : ''

  return (
    <aside className="assistant-dock">
      <div className="assistant-head">
        <div className="assistant-title-row">
          <div className="assistant-title"><Sparkles size={16} />研究助手</div>
          <div style={{ marginLeft: 'auto' }}>
            <StatusBadge status={matchesChat ? agentState?.status ?? 'idle' : 'idle'} />
          </div>
          <button className="btn btn-ghost btn-icon" title="收起" onClick={() => setAssistantOpen(false)}>
            <X />
          </button>
        </div>
        <div className="assistant-controls">
          <select
            className="chat-select"
            value={activeChatId}
            onChange={(event) => void selectChat(event.target.value)}
            title="会话"
          >
            {chats.length === 0 ? <option value="">新会话</option> : null}
            {chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.title}</option>)}
          </select>
          <button className="btn btn-ghost btn-icon" title="新建会话" onClick={() => void newChat()}>
            <MessageSquarePlus />
          </button>
          <IconButton label="全部会话" onClick={() => navigate('/agent')}>
            <Bot />
          </IconButton>
        </div>
        <div className="assistant-controls">
          <select
            className="model-select"
            value={currentValue}
            disabled={running || Boolean(pendingSend)}
            onChange={(event) => {
              const [providerId, modelId] = event.target.value.split('::')
              if (providerId && modelId) void setChatModel(providerId, modelId)
            }}
            title="模型"
          >
            {currentValue && !optionsVisible(providers, currentValue) ? <option value={currentValue}>当前模型</option> : null}
            {providers.map((provider) => (
              <optgroup key={provider.id} label={provider.hasApiKey ? provider.name : `${provider.name}（未配置 Key）`}>
                {provider.models.map((model) => (
                  <option key={`${provider.id}::${model.id}`} value={`${provider.id}::${model.id}`}>
                    {model.label || model.id}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/settings')}>模型设置</button>
        </div>
      </div>
      <ChatPanel variant="dock" />
    </aside>
  )
}

function optionsVisible(providers: ReturnType<typeof useAppStore.getState>['providers'], value: string): boolean {
  return providers.some((provider) => provider.models.some((model) => `${provider.id}::${model.id}` === value))
}

export function AgentPage(): ReactNode {
  return (
    <div className="agent-page">
      <ChatPanel variant="page" />
    </div>
  )
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + 'M'
  if (value >= 1_000) return (value / 1_000).toFixed(value >= 10_000 ? 0 : 1) + 'k'
  return String(value)
}
