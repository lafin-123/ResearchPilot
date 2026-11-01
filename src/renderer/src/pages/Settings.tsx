import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Database, FolderOpen, KeyRound, Laptop, Loader2, Plus, Server, Settings2, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { AppSettings, ModelInfo, Provider, ProviderInput, SshHost, SshHostInput, UsageSummary } from '@shared/types'
import { api, formatError, formatNumber, relativeTime } from '../lib/api'
import { CLARIFICATION_OPTIONS, normalizeClarification } from '@shared/research-interaction'
import { AGENT_ROLES, normalizeAgentRoles } from '@shared/agent-roles'
import { PROVIDER_PRESETS, type ProviderPreset } from '../lib/provider-presets'
import { useAppStore } from '../store/app'
import { Badge, Button, Field, Input, Modal, PageHeader, Select, Textarea } from '../components/Ui'

type Tab = 'models' | 'environment' | 'ssh' | 'workspace' | 'about'

interface ProviderDraft {
  id?: string
  presetKey: string
  name: string
  kind: 'deepseek' | 'custom'
  protocol: Provider['protocol']
  baseUrl: string
  apiKey: string
  modelsText: string
  modelMetadata?: ModelInfo[]
  modelMode?: 'upstream' | 'manual'
  isDefault: boolean
}

function providerDraft(provider?: Provider): ProviderDraft {
  return {
    id: provider?.id,
    presetKey: '',
    name: provider?.name ?? '',
    kind: provider?.kind ?? 'custom',
    protocol: provider?.protocol ?? 'openai-completions',
    baseUrl: provider?.baseUrl ?? '',
    apiKey: '',
    modelsText: provider ? provider.models.map((model) => `${model.id}${model.label && model.label !== model.id ? ` | ${model.label}` : ''}`).join('\n') : '',
    modelMetadata: provider?.models ?? [],
    modelMode: 'upstream',
    isDefault: provider?.isDefault ?? false
  }
}

function presetDraft(preset: ProviderPreset): ProviderDraft {
  return {
    presetKey: preset.key,
    name: preset.name,
    kind: preset.kind,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    apiKey: '',
    modelsText: '',
    modelMetadata: [],
    modelMode: 'upstream',
    isDefault: false
  }
}

function parseModels(text: string): ModelInfo[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [id, label] = line.split('|').map((part) => part.trim())
    return { id, label: label || id }
  }).filter((model) => Boolean(model.id))
}

function modelsText(models: ModelInfo[]): string {
  return models.map((model) => `${model.id}${model.label && model.label !== model.id ? ` | ${model.label}` : ''}`).join('\n')
}

const PROTOCOL_LABEL: Record<Provider['protocol'], string> = {
  deepseek: 'DeepSeek',
  'openai-completions': 'OpenAI Chat',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages'
}

function isLocalEndpoint(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(url)
}

export function SettingsPage(): ReactNode {
  const settings = useAppStore((state) => state.settings)
  const providers = useAppStore((state) => state.providers)
  const sshHosts = useAppStore((state) => state.sshHosts)
  const projects = useAppStore((state) => state.projects)
  const refreshProviders = useAppStore((state) => state.refreshProviders)
  const refreshBootstrap = useAppStore((state) => state.refreshBootstrap)
  const bootstrap = useAppStore((state) => state.bootstrap)
  const [tab, setTab] = useState<Tab>('models')
  const [draft, setDraft] = useState<ProviderDraft | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const [modelQuery, setModelQuery] = useState('')
  const [discoveryError, setDiscoveryError] = useState('')
  const providerLock = useRef(false)
  const draftModels = (value: ProviderDraft): ModelInfo[] => parseModels(value.modelsText).map(model => ({ ...value.modelMetadata?.find(item => item.id === model.id), ...model }))
  useEffect(() => { setModelQuery(''); setDiscoveryError('') }, [draft?.id, draft?.presetKey, draft === null])
  const [sshDraft, setSshDraft] = useState<SshHostInput | null>(null)
  const [form, setForm] = useState<AppSettings | null>(settings)
  const [busy, setBusy] = useState('')
  const [appInfo, setAppInfo] = useState<{ version: string; electron: string; node: string; chrome: string; platform: string } | null>(null)
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const selectedPreset = draft ? PROVIDER_PRESETS.find((preset) => preset.key === draft.presetKey) : undefined

  useEffect(() => {
    if (tab !== 'models') return
    void api.usage.summary().then(setUsage).catch(() => undefined)
  }, [tab, providers])

  useEffect(() => setForm(settings), [settings])
  useEffect(() => { void api.appInfo().then(setAppInfo).catch(() => undefined) }, [])

  const saveSettings = async (): Promise<void> => {
    if (!form) return
    setBusy('settings')
    try {
      await api.settings.update(form)
      await refreshBootstrap()
      toast.success('设置已保存')
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setBusy('')
    }
  }

  const saveProvider = async (): Promise<void> => {
    if (!draft || providerLock.current) return
    if (!parseModels(draft.modelsText).length && draft.modelMode !== 'manual') {
      await discoverModels()
      return
    }
    const models = draftModels(draft)
    if (!models.length) {
      toast.error('请从上游选择模型，或在手动入口添加模型。')
      return
    }
    providerLock.current = true; setDiscoveryError('')
    const input: ProviderInput = {
      id: draft.id,
      name: draft.name.trim() || '模型提供方',
      kind: draft.kind,
      protocol: draft.kind === 'deepseek' ? 'deepseek' : draft.protocol,
      baseUrl: draft.kind === 'deepseek' ? draft.baseUrl || 'https://api.deepseek.com' : draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim() || (draft.presetKey === 'ollama' ? 'local' : undefined),
      models,
      isDefault: draft.isDefault
    }
    setBusy('provider')
    try {
      await api.providers.upsert(input)
      await refreshProviders()
      await refreshBootstrap()
      setDraft(null)
      toast.success('模型提供方已保存')
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      providerLock.current = false
      setBusy('')
    }
  }

  const testProvider = async (provider?: Provider): Promise<void> => {
    if (providerLock.current) return
    providerLock.current = true
    setBusy(provider?.id ?? 'draft')
    try {
      const result = draft
        ? await api.providers.test({
            id: draft.id,
            provider: {
              name: draft.name,
              kind: draft.kind,
              protocol: draft.kind === 'deepseek' ? 'deepseek' : draft.protocol,
              baseUrl: draft.baseUrl,
              models: draftModels(draft),
              isDefault: draft.isDefault
            },
            apiKey: draft.apiKey.trim() || (draft.presetKey === 'ollama' ? 'local' : '')
          })
        : provider
          ? await api.providers.test({ id: provider.id })
          : { ok: false, message: '没有可测试的提供方。', models: [] }
      if (result.ok) toast.success(result.message)
      else toast.error(result.message)
      if (draft && result.models.length) setDraft({ ...draft, modelsText: modelsText(result.models) })
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      providerLock.current = false
      setBusy('')
    }
  }

  const discoverModels = async (): Promise<void> => {
    if (!draft || providerLock.current) return
    providerLock.current = true
    setBusy('discover'); setDiscoveryError('')
    try {
      const models = await api.providers.discoverModels({
        id: draft.id,
        apiKey: draft.apiKey.trim() || (draft.presetKey === 'ollama' ? 'local' : undefined),
        provider: {
          name: draft.name,
          kind: draft.kind,
          protocol: draft.kind === 'deepseek' ? 'deepseek' : draft.protocol,
          baseUrl: draft.baseUrl,
          models: [],
          isDefault: draft.isDefault
        }
      })
      if (draftRef.current !== draft) return
      if (models.length) {
        const current = parseModels(draft.modelsText)
        const next = current.length ? current.filter(model => models.some(item => item.id === model.id)) : models
        setDraft({ ...draft, modelMetadata: models, modelMode: 'upstream', modelsText: modelsText(next) })
        toast.success(`已获取 ${models.length} 个上游模型，请选择后保存`)
      } else {
        setDiscoveryError('上游没有返回可用模型列表。可重试，或切换手动填写；不会自动调用付费推理。')
      }
    } catch (error) {
      if (draftRef.current === draft) setDiscoveryError(formatError(error))
    } finally {
      providerLock.current = false
      setBusy('')
    }
  }

  const setDefault = async (provider: Provider): Promise<void> => {
    setBusy(provider.id)
    try {
      await api.providers.upsert({
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        models: provider.models,
        isDefault: true
      })
      await refreshProviders()
      await refreshBootstrap()
      toast.success(`默认模型：${provider.name} · ${provider.models[0]?.label ?? provider.models[0]?.id}`)
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setBusy('')
    }
  }

  const removeProvider = async (provider: Provider): Promise<void> => {
    if (!window.confirm(`删除提供方「${provider.name}」？已配置的密钥会一并删除。`)) return
    try {
      await api.providers.remove(provider.id)
      await refreshProviders()
      await refreshBootstrap()
      toast.success('已删除')
    } catch (error) {
      toast.error(formatError(error))
    }
  }

  const chooseWorkspace = async (): Promise<void> => {
    if (!form) return
    const chosen = await api.chooseDirectory()
    if (chosen) setForm({ ...form, workspaceRoot: chosen })
  }

  const saveSsh = async (): Promise<void> => {
    if (!sshDraft) return
    if (!sshDraft.name.trim() || !sshDraft.host.trim() || !sshDraft.username.trim()) {
      toast.error('名称、主机和用户名不能为空。')
      return
    }
    setBusy('ssh')
    try {
      await api.ssh.upsert(sshDraft)
      await refreshBootstrap()
      setSshDraft(null)
      toast.success('SSH 主机已保存')
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setBusy('')
    }
  }

  const testSsh = async (host: SshHost): Promise<void> => {
    setBusy(host.id)
    try {
      const result = await api.ssh.test(host.id)
      toast.success(`连接成功：${result.message}`)
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setBusy('')
    }
  }

  const chooseKey = async (): Promise<void> => {
    if (!sshDraft) return
    const path = await api.chooseFile([{ name: 'SSH Private Key', extensions: ['*'] }])
    if (path) setSshDraft({ ...sshDraft, keyPath: path })
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="CONFIGURATION"
        title="设置"
        subtitle="模型 API、本地实验环境、远程算力与工作区。密钥只保存在系统安全存储中，不会进入项目文件。"
      />

      <div className="settings-layout">
        <nav className="settings-nav">
          <button className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}><KeyRound size={14} /> 模型与 API</button>
          <button className={tab === 'environment' ? 'active' : ''} onClick={() => setTab('environment')}><Settings2 size={14} /> 运行环境</button>
          <button className={tab === 'ssh' ? 'active' : ''} onClick={() => setTab('ssh')}><Server size={14} /> SSH 主机</button>
          <button className={tab === 'workspace' ? 'active' : ''} onClick={() => setTab('workspace')}><FolderOpen size={14} /> 工作区</button>
          <button className={tab === 'about' ? 'active' : ''} onClick={() => setTab('about')}><ShieldCheck size={14} /> 关于与安全</button>
        </nav>

        <div className="stack">
          {tab === 'models' ? (
            <>
              <div className="card card-pad">
                <div className="section-head">
                  <div>
                    <h2 className="section-title"><KeyRound size={17} />模型提供方</h2>
                    <div className="card-sub">内置 ChatGPT / OpenAI、Anthropic Claude、Gemini、OpenRouter、Kimi、GLM、通义千问与 DeepSeek 预设，也支持任意兼容网关。一个提供方只使用一种协议。</div>
                  </div>
                  <Button variant="primary" onClick={() => setDraft(providerDraft())}><Plus />添加提供方</Button>
                </div>
                <div className="stack">
                  {providers.map((provider) => (
                    <div className="card provider-card" key={provider.id}>
                      <div className="provider-mark">{provider.name.slice(0, 2).toUpperCase()}</div>
                      <div className="grow">
                        <div className="row wrap">
                          <div className="card-title">{provider.name}</div>
                          {provider.isDefault ? <Badge tone="accent">默认</Badge> : null}
                          <Badge tone={provider.hasApiKey ? 'ok' : 'gold'}>{isLocalEndpoint(provider.baseUrl) ? '本地端点' : provider.hasApiKey ? 'Key 已配置' : '缺少 Key'}</Badge>
                          <Badge tone="neutral">{PROTOCOL_LABEL[provider.protocol]}</Badge>
                        </div>
                        <div className="card-sub">{provider.baseUrl || '使用官方端点'}</div>
                        <div className="provider-models">
                          {provider.models.map((model) => <span key={model.id} className="badge badge-neutral">{model.label || model.id}</span>)}
                        </div>
                      </div>
                      <div className="row">
                        <Button size="sm" variant="ghost" disabled={!provider.hasApiKey || busy === provider.id} onClick={() => void testProvider(provider)}>
                          {busy === provider.id ? <Loader2 className="spin" /> : null}真实调用
                        </Button>
                        {!provider.isDefault ? <Button size="sm" variant="ghost" onClick={() => void setDefault(provider)}>设为默认</Button> : null}
                        <Button size="sm" variant="ghost" onClick={() => setDraft(providerDraft(provider))}>编辑</Button>
                        <Button size="sm" variant="ghost" onClick={() => void removeProvider(provider)}><Trash2 /></Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              {usage ? (
                <div className="card card-pad">
                  <div className="section-head">
                    <div>
                      <h2 className="section-title"><Database size={17} />Token 用量</h2>
                      <div className="card-sub">统计所有项目已完成的模型请求；实时用量显示在对话输入框上方。</div>
                    </div>
                    <Badge tone="neutral">{formatNumber(usage.requests)} 次请求</Badge>
                  </div>
                  <div className="usage-grid">
                    <div className="stat-card"><div className="label">INPUT</div><div className="value">{formatNumber(usage.inputTokens)}</div><div className="note">输入 token</div></div>
                    <div className="stat-card"><div className="label">OUTPUT</div><div className="value">{formatNumber(usage.outputTokens)}</div><div className="note">输出 token</div></div>
                    <div className="stat-card"><div className="label">CACHE</div><div className="value">{formatNumber(usage.cacheReadTokens)}</div><div className="note">缓存命中</div></div>
                    <div className="stat-card"><div className="label">REASONING</div><div className="value">{formatNumber(usage.reasoningTokens)}</div><div className="note">推理 token</div></div>
                  </div>
                  {usage.byModel.length > 0 ? (
                    <div className="usage-models">
                      {usage.byModel.slice(0, 6).map((bucket) => (
                        <div className="usage-model-row" key={`${bucket.providerId}:${bucket.modelId}`}>
                          <span className="usage-model-name">{providers.find((provider) => provider.id === bucket.providerId)?.name ?? bucket.providerId}</span>
                          <span className="mono muted">{bucket.modelId}</span>
                          <span className="usage-model-numbers">{formatNumber(bucket.inputTokens)} in / {formatNumber(bucket.outputTokens)} out · {bucket.requests} 次</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="alert alert-info">
                <ShieldCheck />
                <div>
                  API Key 使用 Windows 凭据保护（DPAPI）加密保存。智能体运行时通过环境变量注入，不会写入会话记录、提示词或项目目录。
                </div>
              </div>
              {form ? (
                <div className="card card-pad">
                  <div className="section-head">
                    <div>
                      <h2 className="section-title">生成参数</h2>
                      <div className="card-sub">全局默认值，仅对支持该参数的模型生效。修改后下一次任务会重建运行时。</div>
                    </div>
                  </div>
                  <div className="grid-2">
                    <Field label="推理强度" hint="留空由模型决定；部分模型仅支持 medium/high。">
                      <Select value={form.reasoningEffort} onChange={(event) => setForm({ ...form, reasoningEffort: event.target.value as AppSettings['reasoningEffort'] })}>
                        <option value="">自动</option>
                        <option value="minimal">Minimal</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="xhigh">Extra High</option>
                        <option value="max">Max</option>
                      </Select>
                    </Field>
                    <Field label="最大输出 Token" hint="0 表示使用模型默认上限，最大 1,000,000。">
                      <Input type="number" min={0} max={1000000} value={form.maxOutputTokens} onChange={(event) => setForm({ ...form, maxOutputTokens: Number(event.target.value) || 0 })} />
                    </Field>
                  </div>
                  <Field label="科研问询方式" hint="偏好问题可默认，科学关键缺口仍需确认；不影响执行审批。">
                    <Select aria-label="科研问询方式" value={normalizeClarification(form.researchClarification)} onChange={event => setForm({ ...form, researchClarification: normalizeClarification(event.target.value) })}>
                      {CLARIFICATION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}：{option.description}</option>)}
                    </Select>
                  </Field>
                  <p className="small muted">仅指导模型如何澄清，不保证模型完全遵循。采样单位、数据权限、矛盾证据不能猜测；技能准备时可以为单次任务覆盖此偏好。</p>
                  <section aria-label="多Agent模型配置"><h3 className="section-title">分角色 Agent</h3><p className="small muted">分别配置写作、绘图与工程的提供方/模型；提供方可以使用不同 API 地址和 Key。流水线按阶段串行交接、独立角色会话，不并发覆盖稿件。未配置角色时沿用流程所选模型。</p>
                    {AGENT_ROLES.map(role => { const route = form.agentRoleModels?.[role.id]; const options = providers.flatMap(provider => provider.models.map(model => ({ provider, model }))); return <Field key={role.id} label={role.label} hint={role.description}><Select aria-label={role.label} value={route ? JSON.stringify([route.providerId, route.modelId]) : ''} onChange={event => { const routes = normalizeAgentRoles(form.agentRoleModels); if (!event.target.value) delete routes[role.id]; else { const [providerId, modelId] = JSON.parse(event.target.value); routes[role.id] = { providerId, modelId } }; setForm({ ...form, agentRoleModels: routes }) }}><option value="">沿用当前任务模型</option>{route && !options.some(item => item.provider.id === route.providerId && item.model.id === route.modelId) && <option value={JSON.stringify([route.providerId, route.modelId])}>配置已失效，请重新选择</option>}{options.map(({ provider, model }) => <option key={JSON.stringify([provider.id, model.id])} value={JSON.stringify([provider.id, model.id])} disabled={!provider.hasApiKey}>{provider.name} / {model.label || model.id}{!provider.hasApiKey ? '（未配置Key）' : ''}</option>)}</Select></Field> })}
                  </section>
                  <Button variant="primary" size="sm" disabled={busy === 'settings'} onClick={() => void saveSettings()}>{busy === 'settings' ? '保存中…' : '保存生成参数'}</Button>
                </div>
              ) : null}
              <div className="alert alert-warn">
                <ShieldCheck />
                <div>
                  <strong>模型服务接入说明：</strong>当前版本通过官方 API Key 接入 ChatGPT / Claude。订阅账号 OAuth 登录尚未开放：dsh 明确不提供 OpenAI OAuth，Claude OAuth 还需要单独的真实账号联调，暂不把未验证流程放进安装包。
                </div>
              </div>
            </>
          ) : null}

          {tab === 'environment' && form ? (
            <>
              <div className="card card-pad">
                <div className="section-head">
                  <h2 className="section-title"><Laptop size={17} />本地 Python</h2>
                  <Badge tone={bootstrap?.pythonAvailable ? 'ok' : 'gold'}>{bootstrap?.pythonAvailable ? '检测到 Python' : '未检测到 Python'}</Badge>
                </div>
                <Field label="Python 解释器路径" hint="留空时自动使用 uv。指定后直接使用该解释器，需自行保证 numpy / pandas / matplotlib 等依赖可用。">
                  <Input value={form.pythonPath} onChange={(event) => setForm({ ...form, pythonPath: event.target.value })} placeholder="例如：C:\\Python312\\python.exe" />
                </Field>
                <div className="alert alert-info">
                  <Database />
                  <div>{bootstrap?.uvAvailable ? '已检测到 uv。未指定解释器时，会用 uv 临时环境运行科学计算依赖，首次运行可能需要下载 Python 与包。' : '未检测到 uv。请安装 Python 3.10+ 或 uv。'}</div>
                </div>
              </div>
              <div className="card card-pad">
                <div className="section-head">
                  <h2 className="section-title">LaTeX 编译器</h2>
                  <Badge tone={bootstrap?.latexAvailable ? 'ok' : 'gold'}>{bootstrap?.latexAvailable ? '可用' : '未检测到'}</Badge>
                </div>
                <Field label="编译命令" hint="留空自动检测 xelatex / pdflatex / latexmk。中文论文建议 XeLaTeX + ctex。">
                  <Input value={form.latexCommand} onChange={(event) => setForm({ ...form, latexCommand: event.target.value })} placeholder="xelatex" />
                </Field>
                <div className="alert alert-warn">
                  <ShieldCheck />
                  <div>当前环境：{bootstrap?.latexAvailable ? '检测到可用的 TeX 编译器。' : '未检测到 TeX。请安装 TeX Live 或 MiKTeX；否则只能编辑 .tex 源码，无法生成 PDF 预览。'}</div>
                </div>
              </div>
              <div className="card card-pad">
                <div className="section-head"><h2 className="section-title">并发与执行</h2></div>
                <Field label="最大并发实验数">
                  <Input type="number" min={1} max={8} value={form.maxConcurrentRuns} onChange={(event) => setForm({ ...form, maxConcurrentRuns: Number(event.target.value) })} />
                </Field>
                <Button variant="primary" disabled={busy === 'settings'} onClick={() => void saveSettings()}>{busy === 'settings' ? '保存中…' : '保存运行环境设置'}</Button>
              </div>
            </>
          ) : null}

          {tab === 'ssh' ? (
            <>
              <div className="card card-pad">
                <div className="section-head">
                  <div>
                    <h2 className="section-title"><Server size={17} />SSH 远程算力</h2>
                    <div className="card-sub">将实验代码上传到远程主机执行，并下载运行产物。首次连接会记录主机指纹。</div>
                  </div>
                  <Button variant="primary" onClick={() => setSshDraft({ name: '', host: '', port: 22, username: '', authKind: 'key', keyPath: '', workspacePath: '~/researchpilot', password: '' })}><Plus />添加主机</Button>
                </div>
                {sshHosts.length === 0 ? (
                  <div className="small muted" style={{ padding: '14px 2px' }}>还没有 SSH 主机。添加后可在实验台选择远程执行。</div>
                ) : (
                  <div className="stack">
                    {sshHosts.map((host) => (
                      <div className="card provider-card" key={host.id}>
                        <div className="provider-mark"><Server size={16} /></div>
                        <div className="grow">
                          <div className="card-title">{host.name}</div>
                          <div className="card-sub">{host.username}@{host.host}:{host.port} · {host.authKind === 'key' ? '私钥' : '密码'} · {host.workspacePath}</div>
                          <div className="tiny muted mt-2">更新于 {relativeTime(host.updatedAt)}</div>
                        </div>
                        <div className="row">
                          <Button size="sm" variant="ghost" disabled={busy === host.id} onClick={() => void testSsh(host)}>{busy === host.id ? <Loader2 className="spin" /> : null}测试</Button>
                          <Button size="sm" variant="ghost" onClick={() => setSshDraft({ ...host, password: '', passphrase: '' })}>编辑</Button>
                          <Button size="sm" variant="ghost" onClick={async () => {
                            if (!window.confirm(`删除 SSH 主机「${host.name}」？`)) return
                            try {
                              await api.ssh.remove(host.id)
                              await refreshBootstrap()
                              toast.success('已删除')
                            } catch (error) { toast.error(formatError(error)) }
                          }}><Trash2 /></Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="alert alert-warn">
                <ShieldCheck />
                <div>SSH 操作由智能体发起时会在执行前请求你的批准。主机指纹变化会直接拒绝连接，防止中间人攻击。</div>
              </div>
            </>
          ) : null}

          {tab === 'workspace' && form ? (
            <>
              <div className="card card-pad">
                <div className="section-head"><h2 className="section-title"><FolderOpen size={17} />工作区</h2></div>
                <Field label="项目默认根目录" hint="新建项目会放在这里；已有项目位置不变。">
                  <div className="row">
                    <Input value={form.workspaceRoot} onChange={(event) => setForm({ ...form, workspaceRoot: event.target.value })} />
                    <Button onClick={() => void chooseWorkspace()}>选择</Button>
                  </div>
                </Field>
                <Button variant="primary" disabled={busy === 'settings'} onClick={() => void saveSettings()}>保存工作区设置</Button>
              </div>
              <div className="card card-pad">
                <div className="section-head"><h2 className="section-title">已有项目</h2><Badge tone="neutral">{projects.length}</Badge></div>
                <div className="list">
                  {projects.map((project) => (
                    <div className="list-row" key={project.id}>
                      <div className="list-main">
                        <div className="list-title">{project.name}</div>
                        <div className="list-sub mono">{project.rootPath}</div>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => void api.projects.reveal(project.id)}><FolderOpen /></Button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}

          {tab === 'about' ? (
            <>
              <div className="card card-pad">
                <div className="section-head"><h2 className="section-title"><ShieldCheck size={17} />安全模型</h2></div>
                <div className="stack small">
                  <div><strong>API Key</strong>：使用系统安全存储（Windows DPAPI）加密，主进程按需解密并通过子进程环境注入。</div>
                  <div><strong>Agent 运行时</strong>：DeepSeek Harness 以独立子进程运行，工作区限制在项目目录（workspace-write 沙箱）。</div>
                  <div><strong>高风险动作</strong>：实验运行、SSH 命令、任意 Python 绘图由 Research Bridge 请求用户批准；内置工作区命令在沙箱内自动执行。</div>
                  <div><strong>本地数据</strong>：项目文件保存在工作区目录，元数据保存在 SQLite；删除项目默认只删索引，不删文件。</div>
                  <div><strong>来源与证据</strong>：文献必须来自 Crossref/真实 DOI，实验结果必须来自 run ID。</div>
                </div>
              </div>
              <div className="card card-pad">
                <div className="section-head"><h2 className="section-title">版本与致谢</h2></div>
                <div className="stack small">
                  <div className="row-between"><span className="muted">ResearchPilot</span><span>{appInfo?.version ?? '0.1.0'}</span></div>
                  <div className="row-between"><span className="muted">Electron / Node / Chromium</span><span>{appInfo?.electron} / {appInfo?.node} / {appInfo?.chrome}</span></div>
                  <div className="row-between"><span className="muted">平台</span><span>{appInfo?.platform}</span></div>
                  <div className="divider" />
                  <div><strong>DeepSeek Harness</strong>：MIT License，作为 Agent 运行时、工具与会话基础设施。应用内保留了其许可证声明。</div>
                  <div><strong>@docx-editor.dev</strong>：Apache-2.0，DOCX WYSIWYG 编辑核心。</div>
                  <div><strong>Crossref</strong>：用于 DOI 元数据查询。</div>
                  <div className="muted">ResearchPilot 不是 DeepSeek 官方产品。请遵守你所接入模型服务的使用条款。</div>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {draft ? (
        <Modal
          title={draft.id ? '编辑模型提供方' : '添加模型提供方'}
          subtitle="获取模型只读取列表；真实调用测试会请求列表第一项模型并使用少量额度。应用使用系统代理，模型是否可用以推理结果为准。"
          size="wide"
          onClose={() => { if (!busy) { setDraft(null); setDiscoveryError(''); setModelQuery('') } }}
          footer={(
            <>
              <Button onClick={() => void testProvider()} disabled={!!busy || !parseModels(draft.modelsText).length}>{busy === 'draft' ? <Loader2 className="spin" /> : null}真实调用测试</Button>
              <Button onClick={() => void discoverModels()} disabled={!!busy}>{busy === 'discover' ? '发现中…' : '获取模型'}</Button>
              <div className="grow" />
              <Button onClick={() => setDraft(null)} disabled={!!busy}>取消</Button>
              <Button variant="primary" disabled={!!busy} onClick={() => void saveProvider()}>{busy === 'provider' ? '保存中…' : !parseModels(draft.modelsText).length && draft.modelMode !== 'manual' ? '获取模型并继续' : '保存所选模型'}</Button>
            </>
          )}
        >
          <fieldset disabled={busy === 'discover' || busy === 'provider' || busy === 'draft'} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {!draft.id ? (
            <Field label="快速配置" hint={selectedPreset ? selectedPreset.description : '选择服务商，预填协议与端点；模型从上游获取，也可手动补充。'}>
              <div className="preset-chips">
                {PROVIDER_PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    className={`preset-chip${draft.presetKey === preset.key ? ' active' : ''}`}
                    onClick={() => setDraft(presetDraft(preset))}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </Field>
          ) : null}
          <div className="grid-2">
            <Field label="提供方类型">
              <Select value={draft.kind} onChange={(event) => {
                const kind = event.target.value as 'deepseek' | 'custom'
                setDraft({
                  ...draft,
                  kind,
                  protocol: kind === 'deepseek' ? 'deepseek' : 'openai-completions',
                  baseUrl: kind === 'deepseek' ? 'https://api.deepseek.com' : draft.baseUrl,
                  modelsText: '', modelMetadata: [], modelMode: 'upstream'
                })
              }}>
                <option value="deepseek">DeepSeek 官方</option>
                <option value="custom">第三方 / 兼容 API</option>
              </Select>
            </Field>
            <Field label="显示名称"><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：OpenAI" /></Field>
          </div>
          {draft.kind === 'custom' ? (
            <div className="grid-2">
              <Field label="API 协议">
                <Select value={draft.protocol} onChange={(event) => setDraft({ ...draft, protocol: event.target.value as Provider['protocol'], modelMetadata: [], modelsText: draft.modelMode === 'manual' ? draft.modelsText : '' })}>
                  <option value="openai-completions">OpenAI Chat Completions</option>
                  <option value="openai-responses">OpenAI Responses</option>
                  <option value="anthropic-messages">Anthropic Messages</option>
                </Select>
              </Field>
              <Field label="基础 URL"><Input value={draft.baseUrl} onChange={(event) => { setDiscoveryError(''); setDraft({ ...draft, baseUrl: event.target.value, modelMetadata: [], modelsText: draft.modelMode === 'manual' ? draft.modelsText : '' }) }} placeholder="https://gateway.example.com/v1" /></Field>
            </div>
          ) : null}
          <Field
            label="API Key"
            hint={selectedPreset?.key === 'openai' ? '使用 platform.openai.com 的 API Key；ChatGPT 订阅账号不能直接作为 API Key。' : '只写不读。留空表示保留已保存的 Key；新增提供方需要填写。'}
          >
            <Input type="password" autoComplete="new-password" value={draft.apiKey} onChange={(event) => { setDiscoveryError(''); setDraft({ ...draft, apiKey: event.target.value, modelMetadata: [], modelsText: draft.modelMode === 'manual' ? draft.modelsText : '' }) }} placeholder={selectedPreset?.keyHint ?? 'sk-...'} />
          </Field>
          <section aria-label="上游模型选择" className="provider-model-picker">
            <div className="row wrap"><Button onClick={() => void discoverModels()} disabled={!!busy}>{busy === 'discover' ? '正在获取…' : '获取上游模型'}</Button><Button variant="ghost" onClick={() => setDraft({ ...draft, modelMode: draft.modelMode === 'manual' ? 'upstream' : 'manual' })}>{draft.modelMode === 'manual' ? '返回上游选择' : '手动填写模型（可选）'}</Button></div>
            <p className="small muted">只向当前填写的端点查询模型列表，不发推理请求。支持兼容 OpenAI / Responses / Anthropic 协议的服务；不兼容或无列表接口时保留手动入口。</p>
            {discoveryError && <div className="alert alert-danger" role="alert">{discoveryError}</div>}
            {draft.modelMode === 'manual' ? <Field label="手动模型列表" hint="每行 model-id 或 model-id | 显示名称。已有上游元数据按相同ID保留。"><Textarea style={{ minHeight: 150, fontFamily: 'var(--font-mono)', fontSize: 12 }} value={draft.modelsText} onChange={event => setDraft({ ...draft, modelsText: event.target.value })} /></Field> : <>
              <Field label="筛选上游模型"><Input value={modelQuery} onChange={event => setModelQuery(event.target.value)} placeholder="搜索模型名称或 ID" /></Field>
              <div className="row wrap"><span className="small">已选择 {parseModels(draft.modelsText).length} / {draft.modelMetadata?.length ?? 0}</span><Button size="sm" onClick={() => setDraft({ ...draft, modelsText: modelsText(draft.modelMetadata ?? []) })}>全选</Button><Button size="sm" onClick={() => setDraft({ ...draft, modelsText: '' })}>清空选择</Button></div>
              <div style={{ maxHeight: 280, overflow: 'auto', marginTop: 10 }}>
                {(draft.modelMetadata ?? []).filter(model => `${model.id} ${model.label}`.toLowerCase().includes(modelQuery.toLowerCase())).map(model => <label className="provider-model-option" key={model.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                  <input type="checkbox" checked={parseModels(draft.modelsText).some(item => item.id === model.id)} onChange={event => { const selected = draftModels(draft).filter(item => item.id !== model.id); setDraft({ ...draft, modelsText: modelsText(event.target.checked ? [...selected, model] : selected) }) }} />
                  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><strong>{model.label}</strong> <span className="small muted">{model.id}</span><br/><span className="tiny muted">上下文 {model.contextWindow?.toLocaleString() ?? '上游未提供'} · 输出上限 {model.maxOutput?.toLocaleString() ?? '上游未提供'} · 视觉 {model.capabilities?.vision === undefined ? '未知' : model.capabilities.vision ? '上游声明支持' : '上游声明不支持'} · 工具 {model.capabilities?.tools === undefined ? '未知' : model.capabilities.tools ? '上游声明支持' : '上游声明不支持'} · 推理 {model.capabilities?.reasoning === undefined ? '未知' : model.capabilities.reasoning ? '上游声明支持' : '上游声明不支持'}</span></span>
                </label>)}
                {!draft.modelMetadata?.length && <p className="small muted">填写 URL 与 Key 后获取模型，不需要先写模型 ID。</p>}
              </div>
              <p className="tiny muted">能力来自上游声明，未做实际能力测试；名称不能证明上下文、视觉或工具调用能力。</p>
            </>}
          </section>
          <label className="checkbox-row">
            <input type="checkbox" checked={draft.isDefault} onChange={(event) => setDraft({ ...draft, isDefault: event.target.checked })} />
            设为默认提供方与新会话首选模型
          </label>
          </fieldset>
        </Modal>
      ) : null}

      {sshDraft ? (
        <Modal
          title={sshDraft.id ? '编辑 SSH 主机' : '添加 SSH 主机'}
          subtitle="支持密码或私钥认证。首次连接后会固定主机指纹。"
          size="wide"
          onClose={() => setSshDraft(null)}
          footer={(
            <>
              <Button onClick={() => setSshDraft(null)}>取消</Button>
              <Button variant="primary" disabled={busy === 'ssh'} onClick={() => void saveSsh()}>{busy === 'ssh' ? '保存中…' : '保存主机'}</Button>
            </>
          )}
        >
          <div className="grid-2">
            <Field label="名称"><Input value={sshDraft.name} onChange={(event) => setSshDraft({ ...sshDraft, name: event.target.value })} placeholder="GPU server" /></Field>
            <Field label="主机"><Input value={sshDraft.host} onChange={(event) => setSshDraft({ ...sshDraft, host: event.target.value })} /></Field>
            <Field label="用户名"><Input value={sshDraft.username} onChange={(event) => setSshDraft({ ...sshDraft, username: event.target.value })} /></Field>
            <Field label="端口"><Input type="number" value={sshDraft.port ?? 22} onChange={(event) => setSshDraft({ ...sshDraft, port: Number(event.target.value) })} /></Field>
          </div>
          <Field label="认证方式">
            <Select value={sshDraft.authKind} onChange={(event) => setSshDraft({ ...sshDraft, authKind: event.target.value as 'password' | 'key' })}>
              <option value="key">私钥</option>
              <option value="password">密码</option>
            </Select>
          </Field>
          {sshDraft.authKind === 'key' ? (
            <>
              <Field label="私钥路径">
                <div className="row">
                  <Input value={sshDraft.keyPath ?? ''} onChange={(event) => setSshDraft({ ...sshDraft, keyPath: event.target.value })} placeholder="C:\\Users\\...\\.ssh\\id_ed25519" />
                  <Button onClick={() => void chooseKey()}>选择</Button>
                </div>
              </Field>
              <Field label="私钥密码（可选）"><Input type="password" value={sshDraft.passphrase ?? ''} onChange={(event) => setSshDraft({ ...sshDraft, passphrase: event.target.value })} /></Field>
            </>
          ) : (
            <Field label="密码" hint="使用系统安全存储加密；留空保留已保存密码。"><Input type="password" value={sshDraft.password ?? ''} onChange={(event) => setSshDraft({ ...sshDraft, password: event.target.value })} /></Field>
          )}
          <Field label="远程工作目录" hint="研究项目会同步到这个目录下。建议使用绝对路径或 ~/researchpilot。">
            <Input value={sshDraft.workspacePath ?? ''} onChange={(event) => setSshDraft({ ...sshDraft, workspacePath: event.target.value })} />
          </Field>
        </Modal>
      ) : null}
    </div>
  )
}
