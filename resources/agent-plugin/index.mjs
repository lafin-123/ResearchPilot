/**
 * ResearchPilot agent transport plugin.
 *
 * The SDK child process only exposes committed session events. This plugin
 * relays live assistant-stream frames to the desktop and gates high-risk tool
 * calls through a user approval prompt. Read-only tools stay frictionless.
 */
export const name = 'researchpilot-agent-bridge'

const GATED_TOOLS = new Set([
  'pwsh',
  'bash',
  'write',
  'edit',
  'subagent',
  'subagent_fork',
  'workflow',
  'interrupt_agent',
  'job_kill'
])

// All unknown/external MCP tools are gated. Only exact, shipped read-only capabilities
// bypass the prompt; do not trust a server's self-reported readOnly annotation.
const READ_ONLY_MCP = new Set([
  ...['workspace_inventory', 'reference_search', 'reference_read', 'reference_fulltext', 'evidence_read'].map(name => `mcp__rp_evidence__${name}`),
  ...['manuscript_list', 'manuscript_read', 'manuscript_audit', 'local_similarity'].map(name => `mcp__rp_writing__${name}`),
  ...['experiment_runs', 'run_reproducibility', 'figure_list', 'figure_inspect', 'artifact_read'].map(name => `mcp__rp_artifacts__${name}`)
])

// These exact native capabilities perform their own mandatory, scoped desktop approval.
const BRIDGE_APPROVED_MCP = new Set([
  ...['experiment_run', 'figure_create_from_spec', 'project_artifact_write', 'experiment_create', 'figure_create_spec'].map(name => `mcp__rp_artifacts__${name}`),
  ...['literature_search', 'journal_guidelines_fetch', 'reference_add_doi', 'reference_save_reading_draft'].map(name => `mcp__rp_evidence__${name}`),
  'mcp__rp_writing__manuscript_write'
])

function summarize(exec) {
  const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
  const command = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : ''
  if (command) return command.length > 1600 ? `${command.slice(0, 1600)}\n…` : command
  const path = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : ''
  if (path) return path
  try {
    const text = JSON.stringify(args)
    return text.length > 800 ? `${text.slice(0, 800)}…` : text
  } catch {
    return ''
  }
}

export function apply(ctx) {
  const base = process.env.RESEARCHPILOT_BRIDGE_URL
  const token = process.env.RESEARCHPILOT_BRIDGE_TOKEN
  const projectId = process.env.RESEARCHPILOT_PROJECT_ID

  if (!base || !token || !projectId) return

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  }

  async function post(path, payload, signal) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectId, ...payload }),
      signal
    })
    if (!response.ok) return undefined
    return response.json().catch(() => undefined)
  }

  // Preserve frame order per runtime. A failed bridge call must not break the
  // agent loop; the committed session events remain the source of truth.
  let streamQueue = Promise.resolve()
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const sessionId = String(agent.session.id)
    streamQueue = streamQueue
      .then(() => post('/agent/stream', { sessionId, frame }))
      .catch(() => undefined)
  })

  // High-risk calls become an `ask` and flow through the approval service.
  // Returning `next()` for read-only tools keeps search and file inspection
  // fast while shell, edits and delegated agents remain user-gated.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = String(exec.name)
    const unknownMcp = toolName.startsWith('mcp__') && !READ_ONLY_MCP.has(toolName) && !BRIDGE_APPROVED_MCP.has(toolName)
    if (!GATED_TOOLS.has(toolName) && !unknownMcp) return next()
    const summary = summarize(exec)
    return {
      kind: 'ask',
      reason: summary
        ? `ResearchPilot requires confirmation before ${toolName}: ${summary}`
        : `ResearchPilot requires confirmation before running ${toolName}.`,
      displayReason: {
        en: 'This operation can change workspace files, run code, or start another agent. Confirm it matches your intent.',
        zh: '该操作可能修改工作区文件、执行代码或启动子智能体。请确认它与你的意图一致。'
      }
    }
  })

  // Terminal approval answerer: ask the desktop UI and fail closed when the
  // bridge is unavailable. This must not call next() or another answerer may
  // silently grant an operation the user did not see.
  ctx.on('approval/request', async (request) => {
    const sessionId = String(request.agent.session.id)
    try {
      const result = await post('/agent/approval', {
        sessionId,
        toolName: request.toolName,
        callId: request.callId,
        reason: request.reason,
        details: request.reason,
        displayReason: request.displayReason
      }, request.signal)
      if (result && result.decision === 'allowed-once') return 'allowed-once'
      if (result && result.decision === 'rejected') return 'rejected'
      return 'unavailable'
    } catch {
      return 'unavailable'
    }
  })
}
