import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Beaker,
  BookOpen,
  Bot,
  ChartNoAxesCombined,
  FileText,
  FlaskConical,
  FolderOpen,
  MessageSquarePlus,
  Settings,
  Sparkles,
  Workflow
} from 'lucide-react'
import { useAppStore } from '../store/app'

interface Item {
  id: string
  group: string
  label: string
  icon: ReactNode
  keywords: string
  run: () => void
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const navigate = useNavigate()
  const newChat = useAppStore((state) => state.newChat)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => { onClose(); navigate(to) }
    return [
      { id: 'home', group: '导航', label: '研究工作台', icon: <Beaker />, keywords: 'home dashboard 首页 工作台', run: go('/') },
      { id: 'agent', group: '导航', label: '研究助手', icon: <Bot />, keywords: 'agent chat 对话 任务', run: go('/agent') },
      { id: 'library', group: '导航', label: '文献库', icon: <BookOpen />, keywords: 'library references 文献', run: go('/library') },
      { id: 'writing', group: '导航', label: '论文工作台', icon: <FileText />, keywords: 'paper writing 论文 文档', run: go('/writing') },
      { id: 'experiments', group: '导航', label: '实验台', icon: <FlaskConical />, keywords: 'experiment runs 实验', run: go('/experiments') },
      { id: 'figures', group: '导航', label: '图表库', icon: <ChartNoAxesCombined />, keywords: 'figures plots 图表', run: go('/figures') },
      { id: 'pipeline', group: '导航', label: '研究流水线', icon: <Workflow />, keywords: 'pipeline workflow 流水线', run: go('/pipeline') },
      { id: 'skills', group: '导航', label: '技能', icon: <Sparkles />, keywords: 'skills 技能 安装', run: go('/skills') },
      { id: 'notes', group: '导航', label: '研究笔记与页面关联', icon: <FileText />, keywords: 'notes 笔记 收藏 链接 回收站', run: go('/notes') },
      { id: 'knowledge', group: '导航', label: '项目知识库与阅读记录', icon: <BookOpen />, keywords: 'RAG 共享上下文 阅读 记录 检索 知识库', run: go('/knowledge') },
      { id: 'writing-quality', group: '导航', label: '写作质量与规范改写', icon: <FileText />, keywords: '降重 查重 重复 知网 维普 style similarity', run: go('/writing-quality') },
      { id: 'mcp', group: '导航', label: 'MCP 工具连接', icon: <Workflow />, keywords: 'mcp 工具 连接', run: go('/mcp') },
      { id: 'settings', group: '导航', label: '设置', icon: <Settings />, keywords: 'settings api key 设置', run: go('/settings') },
      {
        id: 'new-chat',
        group: '操作',
        label: '新建智能体会话',
        icon: <MessageSquarePlus />,
        keywords: 'new chat 新对话 助手',
        run: async () => { await newChat(); onClose(); navigate('/agent') }
      },
      {
        id: 'new-experiment',
        group: '操作',
        label: '前往实验台新建实验',
        icon: <Beaker />,
        keywords: 'new experiment 新建实验',
        run: go('/experiments')
      },
      {
        id: 'reveal',
        group: '操作',
        label: '打开项目目录',
        icon: <FolderOpen />,
        keywords: 'open folder 目录',
        run: async () => {
          const state = useAppStore.getState()
          if (state.activeProjectId) await window.researchpilot.projects.reveal(state.activeProjectId)
          onClose()
        }
      }
    ]
  }, [navigate, newChat, onClose])

  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase()
    if (!value) return items
    return items.filter((item) => `${item.label} ${item.keywords}`.toLowerCase().includes(value))
  }, [items, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    setTimeout(() => inputRef.current?.focus(), 20)
  }, [open])

  useEffect(() => setIndex(0), [query])

  if (!open) return null

  const execute = (item: Item | undefined): void => {
    if (!item) return
    void item.run()
  }

  return (
    <div className="cmdk-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="cmdk" role="dialog" aria-modal="true">
        <input
          ref={inputRef}
          className="cmdk-input"
          value={query}
          placeholder="搜索命令或跳转…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); onClose() }
            if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((current) => Math.min(current + 1, filtered.length - 1)) }
            if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((current) => Math.max(current - 1, 0)) }
            if (event.key === 'Enter') { event.preventDefault(); execute(filtered[index]) }
          }}
        />
        <div className="cmdk-list">
          {filtered.length === 0 ? <div className="cmdk-empty">没有匹配的命令</div> : null}
          {filtered.map((item, itemIndex) => (
            <div key={item.id}>
              {filtered[itemIndex - 1]?.group !== item.group ? <div className="cmdk-group">{item.group}</div> : null}
              <button
                className={`cmdk-item${itemIndex === index ? ' active' : ''}`}
                onMouseEnter={() => setIndex(itemIndex)}
                onClick={() => execute(item)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
