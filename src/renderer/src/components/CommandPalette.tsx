import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Beaker,
  FileText,
  FolderOpen,
  MessageSquarePlus
} from 'lucide-react'
import { useAppStore } from '../store/app'
import { PRIMARY_WORKSPACES, SETTINGS_WORKSPACE } from '../lib/workspace-navigation'

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
      ...[...PRIMARY_WORKSPACES, SETTINGS_WORKSPACE].flatMap(workspace => workspace.pages.map(page => ({
        id: page.path, group: '导航', label: `${workspace.label} / ${page.label}`, icon: <FileText />,
        keywords: `${workspace.label} ${page.keywords}`, run: go(page.path)
      }))),
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
