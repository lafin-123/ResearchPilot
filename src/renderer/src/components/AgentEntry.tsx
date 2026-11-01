import { useState, type ReactNode } from 'react'
import { ArrowUp, Sparkles } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/app'

interface Suggestion {
  label: string
  prompt: string
}

export function AgentEntry({
  placeholder,
  suggestions
}: {
  placeholder: string
  suggestions: Suggestion[]
}): ReactNode {
  const navigate = useNavigate()
  const project = useAppStore((state) => state.projects.find((item) => item.id === state.activeProjectId))
  const seedPrompt = useAppStore((state) => state.seedPrompt)
  const [text, setText] = useState('')

  const handOff = (value: string): void => {
    const prompt = value.trim()
    if (!prompt) return
    seedPrompt(prompt)
    navigate('/agent')
  }

  return (
    <div className="agent-entry">
      <form
        className="agent-entry-row"
        onSubmit={(event) => {
          event.preventDefault()
          handOff(text)
        }}
      >
        <span className="agent-entry-label">
          <Sparkles size={14} />
          <span>ResearchPilot</span>
          {project ? <span className="agent-entry-project">· {project.name}</span> : null}
        </span>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={placeholder}
          aria-label="交给智能体的任务"
        />
        <button type="submit" className="agent-entry-send" disabled={!text.trim()} title="交给智能体">
          <ArrowUp size={13} />
          <span>交给智能体</span>
        </button>
      </form>
      {suggestions.length > 0 ? (
        <div className="agent-entry-suggestions">
          {suggestions.map((item) => (
            <button key={item.label} type="button" onClick={() => handOff(item.prompt)}>
              {item.label}
              <span aria-hidden="true">→</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
