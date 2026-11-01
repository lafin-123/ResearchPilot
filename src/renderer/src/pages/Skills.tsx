import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import '../styles/skills-pipeline.css'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy, Eye, FileText, FolderOpen, Globe, Pencil, Plus, Search, Sparkles, Trash2, Upload, MessageSquare, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { SkillDetail, SkillDiscoveryResult, SkillRecord, SkillScope } from '@shared/types'
import { api, formatError } from '../lib/api'
import { RESEARCH_CATEGORIES, researchSkill, effectiveResearchSkills, filterResearchSkills, buildSkillTask, type SkillTaskFields } from '@shared/research-skills'
import { CLARIFICATION_OPTIONS, normalizeClarification } from '@shared/research-interaction'
import { AGENT_ROLES, resolveAgentRole, roleForCategory } from '@shared/agent-roles'
import { useAppStore } from '../store/app'
import { Badge, Button, EmptyState, Field, Input, Modal, PageHeader, Select, Textarea } from '../components/Ui'

type EditableScope = 'project' | 'global'
type Filter = 'all' | SkillScope

interface Draft {
  editing: boolean
  scope: EditableScope
  name: string
  description: string
  whenToUse: string
  body: string
}

const SCOPE_LABEL: Record<SkillScope, string> = {
  builtin: '内置',
  project: '项目',
  global: '全局'
}

const SCOPE_TONE: Record<SkillScope, 'blue' | 'accent' | 'gold'> = {
  builtin: 'blue',
  project: 'accent',
  global: 'gold'
}

const BODY_TEMPLATE = `# Skill instructions

Describe the workflow the agent should follow.

## When to use

Explain the trigger conditions.

## Steps

1. ...
2. ...

## Quality checklist

- [ ] ...
`

function skillLabel(skill: SkillRecord): string {
  return researchSkill(skill.name)?.label ?? skill.name
}

function skillDescription(skill: SkillRecord): string {
  const meta = researchSkill(skill.name)
  return skill.scope === 'builtin' && meta ? `${meta.output}；${meta.limit}。` : skill.description
}

function skillWhen(skill: SkillRecord): string {
  return skill.scope === 'builtin' ? researchSkill(skill.name)?.input ?? skill.whenToUse : skill.whenToUse
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}

export function SkillsPage(): ReactNode {
  const navigate = useNavigate()
  const seedPrompt = useAppStore((state) => state.seedPrompt)
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const settings = useAppStore((state) => state.settings)
  const scope = useMemo(() => ({ projectId: activeProjectId }), [activeProjectId])
  const currentScope = useRef(scope)
  currentScope.current = scope
  const request = useRef(0)
  useEffect(() => { currentScope.current = scope; return () => { if (currentScope.current === scope) currentScope.current = { projectId: '' } } }, [scope])
  const [loadError, setLoadError] = useState('')
  const [task, setTask] = useState<SkillRecord | null>(null)
  const [taskFields, setTaskFields] = useState<SkillTaskFields>({})
  const [taskMode, setTaskMode] = useState('default')
  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [goal, setGoal] = useState('all')
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<SkillDetail | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importScope, setImportScope] = useState<EditableScope>('project')
  const [importText, setImportText] = useState('')
  const [gitUrl, setGitUrl] = useState('')
  const [discovery, setDiscovery] = useState<SkillDiscoveryResult | null>(null)
  const [selectedNames, setSelectedNames] = useState<string[]>([])
  const [busy, setBusy] = useState('')

  const load = async (): Promise<void> => {
    if (currentScope.current !== scope) return
    if (!activeProjectId) return
    const token = ++request.current
    setLoading(true); setLoadError('')
    try {
      const next = await api.skills.list(activeProjectId)
      if (currentScope.current === scope && request.current === token) setSkills(next)
    } catch (error) {
      if (currentScope.current === scope && request.current === token) setLoadError(formatError(error))
    } finally {
      if (currentScope.current === scope && request.current === token) setLoading(false)
    }
  }

  useEffect(() => {
    setSkills([])
    setTask(null)
    setTaskFields({})
    setTaskMode('default')
    setBusy('')
    setPreview(null)
    setDraft(null)
    setDiscovery(null)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId])

  const effectiveSkills = useMemo(() => effectiveResearchSkills(skills), [skills])

  const visible = useMemo(() => filterResearchSkills(
    (filter === 'all' ? effectiveSkills : skills).filter(skill => filter === 'all' || skill.scope === filter), query, goal
  ), [effectiveSkills, filter, query, skills, goal])

  const builtinFileCount = useMemo(() => skills.filter((skill) => skill.scope === 'builtin').reduce((sum, skill) => sum + 1 + skill.resources.references + skill.resources.templates + skill.resources.scripts + skill.resources.evals + skill.resources.assets, 0), [skills])

  const counts = useMemo(() => ({
    all: effectiveSkills.length,
    builtin: skills.filter((skill) => skill.scope === 'builtin').length,
    project: skills.filter((skill) => skill.scope === 'project').length,
    global: skills.filter((skill) => skill.scope === 'global').length
  }), [effectiveSkills, skills])

  const previewToken = useRef(0)
  const openPreview = async (skill: SkillRecord): Promise<void> => {
    if (currentScope.current !== scope) return
    if (!activeProjectId) return
    try {
      const token = ++previewToken.current
      const result = await api.skills.get(activeProjectId, skill.scope, skill.name)
      if (currentScope.current === scope && previewToken.current === token) setPreview(result)
    } catch (error) {
      if (currentScope.current === scope) toast.error(formatError(error))
    }
  }

  const openNew = (): void => {
    setDraft({ editing: false, scope: 'project', name: '', description: '', whenToUse: '', body: BODY_TEMPLATE })
  }

  const openEdit = async (skill: SkillRecord): Promise<void> => {
    if (!activeProjectId || !skill.editable) return
    try {
      const detail = await api.skills.get(activeProjectId, skill.scope, skill.name)
      if (currentScope.current !== scope) return
      setDraft({
        editing: true,
        scope: skill.scope === 'global' ? 'global' : 'project',
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        body: stripFrontmatter(detail.content)
      })
    } catch (error) {
      if (currentScope.current === scope) toast.error(formatError(error))
    }
  }

  const saveDraft = async (): Promise<void> => {
    if (!activeProjectId || !draft) return
    if (!draft.name.trim() || !draft.description.trim() || !draft.body.trim()) {
      toast.error('名称、描述和正文都不能为空。')
      return
    }
    setBusy('save')
    try {
      if (draft.editing) {
        await api.skills.update({
          projectId: activeProjectId,
          scope: draft.scope,
          name: draft.name,
          description: draft.description,
          whenToUse: draft.whenToUse,
          body: draft.body
        })
        toast.success('技能已保存')
      } else {
        await api.skills.create({
          projectId: activeProjectId,
          scope: draft.scope,
          name: draft.name,
          description: draft.description,
          whenToUse: draft.whenToUse,
          body: draft.body
        })
        toast.success('技能已创建，智能体下次加载时会发现它')
      }
      if (currentScope.current !== scope) return
      setDraft(null)
      await load()
    } catch (error) {
      if (currentScope.current === scope) toast.error(formatError(error))
    } finally {
      if (currentScope.current === scope) setBusy('')
    }
  }

  const removeSkill = async (skill: SkillRecord): Promise<void> => {
    if (!activeProjectId || !skill.editable) return
    if (!window.confirm(`删除技能「${skill.name}」？文件会移入回收目录。`)) return
    try {
      await api.skills.remove(activeProjectId, skill.scope as EditableScope, skill.name)
      toast.success('已删除')
      await load()
    } catch (error) {
      if (currentScope.current === scope) toast.error(formatError(error))
    }
  }

  const copyBuiltin = async (skill: SkillRecord, targetScope: EditableScope): Promise<void> => {
    if (currentScope.current !== scope) return
    if (!activeProjectId) return
    setBusy(`${skill.name}-${targetScope}`)
    try {
      await api.skills.copyBuiltin(activeProjectId, skill.name, targetScope)
      if (currentScope.current !== scope) return
      toast.success(`已复制到${targetScope === 'project' ? '项目' : '全局'}技能`)
      await load()
    } catch (error) {
      if (currentScope.current === scope) toast.error(formatError(error))
    } finally {
      if (currentScope.current === scope) setBusy('')
    }
  }

  const importFrom = async (kind: 'file' | 'folder'): Promise<void> => {
    if (currentScope.current !== scope) return
    if (!activeProjectId) return
    setBusy('import')
    try {
      const imported = await api.skills.importSkill(activeProjectId, importScope, kind)
      if (currentScope.current !== scope) return
      if (imported) {
        toast.success(`已导入技能 ${imported.name}`)
        setImportOpen(false)
        await load()
      }
    } catch (error) {
      if (currentScope.current === scope) toast.error(formatError(error))
    } finally {
      if (currentScope.current === scope) setBusy('')
    }
  }

  const scanFolder = async (): Promise<void> => {
    if (currentScope.current !== scope) return
    if (!activeProjectId) return
    setBusy('scan')
    try {
      const result = await api.skills.discoverFolder(activeProjectId)
      if (currentScope.current !== scope) return
      if (result) {
        setDiscovery(result)
        setSelectedNames(result.skills.map((skill) => skill.name))
        toast.success('发现 ' + result.skills.length + ' 个技能')
      }
    } catch (error) {
      if (currentScope.current === scope) toast.error(formatError(error))
    } finally {
      if (currentScope.current === scope) setBusy('')
    }
  }

  const scanGit = async (): Promise<void> => {
    if (!activeProjectId || !gitUrl.trim()) return
    setBusy('scan')
    try {
      const result = await api.skills.discoverGit(activeProjectId, gitUrl.trim())
      if (currentScope.current !== scope) return
      setDiscovery(result)
      setSelectedNames(result.skills.map((skill) => skill.name))
      toast.success('发现 ' + result.skills.length + ' 个技能')
    } catch (error) {
      if (currentScope.current === scope) toast.error(formatError(error))
    } finally {
      if (currentScope.current === scope) setBusy('')
    }
  }

  const installSelected = async (): Promise<void> => {
    if (!activeProjectId || !discovery || selectedNames.length === 0) return
    setBusy('install-selected')
    try {
      const result = await api.skills.installDiscovered({ projectId: activeProjectId, cacheId: discovery.cacheId, targetScope: importScope, names: selectedNames })
      if (currentScope.current !== scope) return
      const skipped = result.skipped.length
      toast.success('安装了 ' + result.installed.length + ' 个技能' + (skipped ? '，跳过 ' + skipped + ' 个' : ''))
      setImportOpen(false)
      setDiscovery(null)
      setSelectedNames([])
      await load()
    } catch (error) {
      if (currentScope.current === scope) toast.error(formatError(error))
    } finally {
      if (currentScope.current === scope) setBusy('')
    }
  }

  const toggleAllDiscovered = (checked: boolean): void => {
    setSelectedNames(checked ? (discovery?.skills.map((skill) => skill.name) ?? []) : [])
  }

  const importPaste = async (): Promise<void> => {
    if (!activeProjectId || !importText.trim()) return
    setBusy('paste')
    try {
      const imported = await api.skills.importContent({ projectId: activeProjectId, targetScope: importScope, content: importText })
      if (currentScope.current !== scope) return
      toast.success(`已导入技能 ${imported.name}`)
      setImportOpen(false)
      setImportText('')
      await load()
    } catch (error) {
      if (currentScope.current === scope) toast.error(formatError(error))
    } finally {
      if (currentScope.current === scope) setBusy('')
    }
  }

  const openScope = async (targetScope: SkillScope): Promise<void> => {
    if (currentScope.current !== scope) return
    if (!activeProjectId) return
    try {
      await api.skills.openScope(activeProjectId, targetScope)
    } catch (error) {
      if (currentScope.current === scope) toast.error(formatError(error))
    }
  }

  const reveal = async (skill: SkillRecord): Promise<void> => {
    if (currentScope.current !== scope) return
    if (!activeProjectId) return
    try {
      await api.skills.reveal(activeProjectId, skill.scope, skill.name)
    } catch (error) {
      if (currentScope.current === scope) toast.error(formatError(error))
    }
  }

  const prepareTask = (skill: SkillRecord): void => {
    if (!activeProjectId || currentScope.current !== scope) return
    ++previewToken.current
    setTask(skill); setTaskFields({}); setTaskMode('default'); setPreview(null)
  }
  const placeTask = async (): Promise<void> => {
    if (!task || !activeProjectId || currentScope.current !== scope || busy) return
    const existing = useAppStore.getState().composerDraft
    const role = roleForCategory(researchSkill(task.name)?.category)
    let route
    try { route = resolveAgentRole(role, settings?.agentRoleModels, useAppStore.getState().providers) }
    catch (error) { toast.error(formatError(error)); return }
    if (!route && existing.trim() && !window.confirm('智能体输入框已有草稿，替换为这个技能的任务提示？')) return
    const prompt = buildSkillTask(task, taskFields, taskMode === 'default' ? settings?.researchClarification : taskMode)
    setBusy('prepare-task')
    try {
      if (route) {
        const chat = await api.chat.create(activeProjectId)
        if (currentScope.current !== scope) return
        await api.chat.setModel(chat.id, route.providerId, route.modelId)
        if (currentScope.current !== scope) return
        await useAppStore.getState().loadChats()
        if (currentScope.current !== scope) return
        await useAppStore.getState().selectChat(chat.id)
        if (currentScope.current !== scope || useAppStore.getState().activeChatId !== chat.id) return
      }
      seedPrompt(route ? `协作角色：${AGENT_ROLES.find(item => item.id === role)!.label}。本次使用独立会话，请先读取明确共享的项目证据。\n\n${prompt}` : prompt)
      setTask(null); navigate('/agent')
      toast.success('任务已放入草稿，检查并发送后才会开始')
    } catch (error) { if (currentScope.current === scope) toast.error(formatError(error)) }
    finally { if (currentScope.current === scope) setBusy('') }
  }

  return (
    <div className="page research-skills-page">
      <PageHeader
        eyebrow="研究工具箱"
        title="科研技能库"
        subtitle="按研究任务选择方法，查看输入与交付物。补充信息可以跳过，准备任务不会自动发送。"
        actions={(
          <>
            <Button onClick={() => setImportOpen(true)}><Upload />导入技能</Button>
            <Button variant="primary" onClick={openNew}><Plus />新建技能</Button>
          </>
        )}
      />

      <div className="research-capability-note">
        <ShieldCheck size={19} aria-hidden="true" />
        <div><strong>本地技能，明确交付</strong><p>从应用资源中发现 {counts.builtin} 个内置包、{builtinFileCount} 个文件。查看说明、复用模板，再决定是否运行脚本。项目同名技能优先于全局和内置版本。</p></div>
      </div>
      <div className="skills-workspace">
      <nav className="research-goals" aria-label="按研究任务筛选">
        {RESEARCH_CATEGORIES.map((item) => <button key={item.id} className={goal === item.id ? 'active' : ''} aria-pressed={goal === item.id} onClick={() => setGoal(item.id)}>{item.label}<span>{filterResearchSkills(effectiveSkills, '', item.id).length}</span></button>)}
      </nav>
      <div className="skills-results">

      <div className="toolbar">
        <div className="search-box">
          <Search />
          <input className="input" aria-label="搜索科研技能" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能名称、描述或触发条件…" />
        </div>
        <div className="skill-tabs">
          {(['all', 'builtin', 'project', 'global'] as Filter[]).map((scope) => (
            <button key={scope} className={`skill-tab${filter === scope ? ' active' : ''}`} onClick={() => setFilter(scope)}>
              {scope === 'all' ? '全部' : SCOPE_LABEL[scope]} <span>{counts[scope]}</span>
            </button>
          ))}
        </div>
        <Button variant="ghost" onClick={() => void openScope('project')}><FolderOpen />项目技能目录</Button>
        <Button variant="ghost" onClick={() => void openScope('global')}><Globe />全局技能目录</Button>
      </div>

      <div className="skills-result-count" role="status">{loading ? '正在读取本地技能…' : `显示 ${visible.length} 个技能`}</div>
      {loadError && <div className="alert alert-danger" role="alert">{loadError}<Button size="sm" onClick={() => void load()}>重新读取</Button></div>}
      {visible.length === 0 && !loading && !loadError ? (
        <div className="card">
          <EmptyState
            icon={<Sparkles />}
            title={query ? '没有匹配的技能' : '还没有安装技能'}
            text={query ? '换个关键词，或切换到“全部”。' : '新建一个技能，或导入包含 SKILL.md 的目录。内置技能始终可用。'}
            action={<Button variant="primary" onClick={openNew}>新建技能</Button>}
          />
        </div>
      ) : (
        <div className="skill-list">
          {visible.map((skill) => (
            <article className="skill-row" key={`${skill.scope}:${skill.name}`}>
              <div className="skill-mark"><Sparkles size={15} /></div>
              <div className="skill-main">
                <div className="row wrap">
                  <span className="skill-name" style={{ fontFamily: 'var(--font-ui)' }}>{skillLabel(skill)}</span>
                  <span className="tiny muted mono">{skill.name}</span>
                  <Badge tone={SCOPE_TONE[skill.scope]}>{SCOPE_LABEL[skill.scope]}</Badge>
                  {skill.builtinCopy ? <Badge tone="neutral">内置副本</Badge> : null}
                  {skill.scope !== 'builtin' && skill.overridesBuiltin ? <Badge tone="neutral">覆盖同名内置</Badge> : null}
                </div>
                <div className="skill-desc">{skillDescription(skill)}</div>
                {skillWhen(skill) ? <div className="skill-when">输入：{skillWhen(skill)}</div> : null}
                <details className="skill-resource-details"><summary>资源与文件</summary><div className="skill-path mono">{skill.relativePath}</div>
                {(skill.resources.references + skill.resources.templates + skill.resources.scripts + skill.resources.evals + skill.resources.assets) > 0 ? (
                  <div className="skill-resources">
                    {skill.resources.references > 0 ? `参考 ${skill.resources.references}` : ''}
                    {skill.resources.templates > 0 ? ` · 模板 ${skill.resources.templates}` : ''}
                    {skill.resources.scripts > 0 ? ` · 脚本 ${skill.resources.scripts}` : ''}
                    {skill.resources.evals > 0 ? ` · 评测 ${skill.resources.evals}` : ''}
                    {skill.resources.assets > 0 ? ` · 资源 ${skill.resources.assets}` : ''}
                  </div>
                ) : null}</details>
              </div>
              <div className="skill-actions">
                <button className="btn btn-primary btn-sm" disabled={!activeProjectId} onClick={() => prepareTask(skill)}><MessageSquare />准备任务</button>
                <button className="btn btn-ghost btn-sm" onClick={() => void openPreview(skill)}><Eye />查看</button>
                <details className="skill-more-actions"><summary>更多操作</summary>
                {skill.scope === 'builtin' ? (
                  <>
                    <button className="btn btn-secondary btn-sm" disabled={busy === `${skill.name}-project`} onClick={() => void copyBuiltin(skill, 'project')}><Copy />复制到项目</button>
                    <button className="btn btn-ghost btn-sm" disabled={busy === `${skill.name}-global`} onClick={() => void copyBuiltin(skill, 'global')}><Globe />复制到全局</button>
                  </>
                ) : (
                  <>
                    <button className="btn btn-ghost btn-sm" onClick={() => void openEdit(skill)}><Pencil />编辑</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => void reveal(skill)}><FolderOpen />位置</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => void removeSkill(skill)}><Trash2 /></button>
                  </>
                )}</details>
              </div>
            </article>
          ))}
        </div>
      )}

      </div></div>
      {task && <Modal title={`准备任务：${skillLabel(task)}`} subtitle="所有补充字段均可跳过；只放入助手草稿，不发送、不执行。" onClose={() => { if (!busy) setTask(null) }} footer={<><Button disabled={!!busy} onClick={() => setTask(null)}>取消</Button><Button variant="primary" disabled={!!busy} onClick={() => void placeTask()}>放入助手草稿</Button></>}>
        <fieldset disabled={!!busy} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <p className="skill-task-delivery">交付：{researchSkill(task.name)?.output ?? task.description}</p>
        <Field label="目标（可选）"><Textarea value={taskFields.goal ?? ''} maxLength={10000} onChange={e => setTaskFields({ ...taskFields, goal: e.target.value })} placeholder="留空时先盘点项目资料，提出保守且可审阅的初稿。" /></Field>
        <Field label="输入说明（可选）"><Textarea value={taskFields.inputs ?? ''} maxLength={10000} onChange={e => setTaskFields({ ...taskFields, inputs: e.target.value })} placeholder="例如：待核对全文、数据路径、已提供的作者指南。" /></Field>
        <Field label="输出要求（可选）"><Input value={taskFields.output ?? ''} maxLength={10000} onChange={e => setTaskFields({ ...taskFields, output: e.target.value })} placeholder="例如：差异表、修订草稿；可留空。" /></Field>
        <Field label="本次问询方式"><Select value={taskMode} onChange={e => setTaskMode(e.target.value)}><option value="default">沿用设置（{CLARIFICATION_OPTIONS.find(o => o.value === normalizeClarification(settings?.researchClarification))?.label}）</option>{CLARIFICATION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></Field>
        <p className="small">角色：{AGENT_ROLES.find(role => role.id === roleForCategory(researchSkill(task.name)?.category))?.label}。{settings?.agentRoleModels?.[roleForCategory(researchSkill(task.name)?.category)] ? '已配置独立模型，将新建会话，原草稿保留。' : '未单独配置，沿用当前任务模型。'}</p>
        <p className="small muted">偏好可以默认，科学关键输入不能猜测。执行代码、联网、外发或覆盖文件仍需审批。全文缺失不冒充已核对，期刊规则需实际指南。</p>
        </fieldset>
      </Modal>}
      {preview ? (
        <Modal
          title={preview.name}
          subtitle={`${SCOPE_LABEL[preview.scope]}技能 · ${preview.relativePath}`}
          size="wide"
          onClose={() => setPreview(null)}
          footer={(
            <>
              <Button onClick={() => setPreview(null)}>关闭</Button>
              <Button variant="primary" onClick={() => prepareTask(preview)}><MessageSquare />准备任务</Button>
              {preview.scope === 'builtin' ? <Button onClick={() => void copyBuiltin(preview, 'project').then(() => setPreview(null))}><Copy />复制到项目</Button> : null}
            </>
          )}
        >
          <div className="stack small">
            <div><span className="muted">描述：</span>{preview.description}</div>
            {preview.whenToUse ? <div><span className="muted">触发：</span>{preview.whenToUse}</div> : null}
            <div className="divider" />
            <div className="markdown skill-preview">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(preview.content)}</ReactMarkdown>
            </div>
          </div>
        </Modal>
      ) : null}

      {draft ? (
        <Modal
          title={draft.editing ? '编辑技能' : '新建技能'}
          subtitle="SKILL.md 会被智能体在需要时加载。名称使用小写字母、数字和连字符。"
          size="wide"
          onClose={() => setDraft(null)}
          footer={(
            <>
              <Button onClick={() => setDraft(null)}>取消</Button>
              <Button variant="primary" disabled={busy === 'save'} onClick={() => void saveDraft()}>{busy === 'save' ? '保存中…' : draft.editing ? '保存修改' : '创建技能'}</Button>
            </>
          )}
        >
          <div className="grid-2">
            <Field label="名称" hint="创建后不可修改，例如 paper-writing">
              <Input value={draft.name} disabled={draft.editing} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="my-research-skill" />
            </Field>
            <Field label="安装位置">
              <Select value={draft.scope} disabled={draft.editing} onChange={(event) => setDraft({ ...draft, scope: event.target.value as EditableScope })}>
                <option value="project">当前项目（推荐）</option>
                <option value="global">全局（所有项目）</option>
              </Select>
            </Field>
          </div>
          <Field label="描述" hint="给智能体看的简短说明：这个技能做什么。">
            <Input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="Systematic literature search and evidence synthesis." />
          </Field>
          <Field label="触发条件（whenToUse）">
            <Input value={draft.whenToUse} onChange={(event) => setDraft({ ...draft, whenToUse: event.target.value })} placeholder="当用户要求文献综述、研究 gap 或 baseline 选择时使用。" />
          </Field>
          <Field label="正文（Markdown）">
            <Textarea style={{ minHeight: 300, fontFamily: 'var(--font-mono)', fontSize: 11.5 }} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
          </Field>
        </Modal>
      ) : null}

      {importOpen ? (
        <Modal
          title="导入技能"
          subtitle="兼容 Claude Code / nature-skills 的 SKILL.md 结构：可扫描整个仓库并批量安装，也可导入单个技能或粘贴内容。Git 安装需要本机有 git。"
          size="wide"
          onClose={() => { setImportOpen(false); setDiscovery(null) }}
          footer={(
            <>
              <Button onClick={() => { setImportOpen(false); setDiscovery(null) }}>取消</Button>
              {discovery ? (
                <Button variant="primary" disabled={busy === 'install-selected' || selectedNames.length === 0} onClick={() => void installSelected()}>
                  {busy === 'install-selected' ? '安装中…' : '安装选中 (' + selectedNames.length + ')'}
                </Button>
              ) : (
                <Button variant="primary" disabled={!importText.trim() || busy === 'paste'} onClick={() => void importPaste()}>{busy === 'paste' ? '导入中…' : '导入粘贴内容'}</Button>
              )}
            </>
          )}
        >
          <Field label="安装到">
            <Select value={importScope} onChange={(event) => setImportScope(event.target.value as EditableScope)}>
              <option value="project">当前项目（推荐）</option>
              <option value="global">全局（所有项目）</option>
            </Select>
          </Field>
          <div className="row wrap" style={{ marginBottom: 10 }}>
            <Button onClick={() => void importFrom('file')} disabled={busy === 'import'}><FileText />从 .md 文件导入</Button>
            <Button onClick={() => void importFrom('folder')} disabled={busy === 'import'}><FolderOpen />从单个技能目录导入</Button>
            <span className="tiny muted">单个目录必须包含 SKILL.md；资源文件会一起复制。</span>
          </div>
          <div className="divider" />
          <div className="field-label" style={{ marginBottom: 6 }}>批量安装外部技能包</div>
          <div className="row wrap" style={{ marginBottom: 8 }}>
            <Input value={gitUrl} onChange={(event) => setGitUrl(event.target.value)} placeholder="https://github.com/Yuan1z0825/nature-skills.git" style={{ flex: 1, minWidth: 250 }} />
            <Button onClick={() => void scanGit()} disabled={busy === 'scan' || !gitUrl.trim()}>{busy === 'scan' ? '扫描中…' : '扫描 Git 仓库'}</Button>
            <Button onClick={() => void scanFolder()} disabled={busy === 'scan'}>扫描本机多技能目录</Button>
          </div>
          <div className="field-hint" style={{ marginBottom: 10 }}>
            递归发现所有 SKILL.md，保留 references / assets / scripts。安装 nature-skills 等仓库时，依赖 shared skill 的条目请一并勾选。
          </div>
          {discovery ? (
            <div className="discovery-panel">
              <div className="discovery-head">
                <span>发现 {discovery.skills.length} 个技能 · {discovery.sourceLabel}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => toggleAllDiscovered(selectedNames.length !== discovery.skills.length)}>
                  {selectedNames.length === discovery.skills.length ? '取消全选' : '全选'}
                </button>
              </div>
              <div className="discovery-list">
                {discovery.skills.map((skill) => (
                  <label className="discovery-item" key={skill.name}>
                    <input
                      type="checkbox"
                      checked={selectedNames.includes(skill.name)}
                      onChange={(event) => setSelectedNames((current) => event.target.checked ? [...current, skill.name] : current.filter((name) => name !== skill.name))}
                    />
                    <span className="discovery-main">
                      <span className="discovery-name">{skill.name}</span>
                      <span className="discovery-desc">{skill.description}</span>
                      <span className="discovery-meta">{skill.relativePath} · 参考 {skill.resources.references} · 模板 {skill.resources.templates} · 脚本 {skill.resources.scripts}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          <div className="divider" />
          <Field label="或粘贴 SKILL.md 内容" hint="必须包含 name 和 description 的 YAML frontmatter。">
            <Textarea style={{ minHeight: 200, fontFamily: 'var(--font-mono)', fontSize: 11.5 }} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="粘贴 SKILL.md，必须包含 name 和 description frontmatter" />
          </Field>
        </Modal>
      ) : null}
    </div>
  )
}
