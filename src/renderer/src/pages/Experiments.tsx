import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { python } from '@codemirror/lang-python'
import { CircleStop, FlaskConical, FolderOpen, Play, Plus, Save, Server, Terminal, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Experiment, ExperimentRun } from '@shared/types'
import { api, formatError, formatNumber, relativeTime } from '../lib/api'
import { useAppStore } from '../store/app'
import { experimentDrafts, ExperimentContext, type ExperimentDraft, type ExperimentScope } from '../lib/experiment-drafts'
import { useNavigate } from 'react-router-dom'
import './research-management.css'
import { Badge, Button, EmptyState, Field, Input, Modal, PageHeader, Select, StatusBadge, Textarea } from '../components/Ui'

const DEFAULT_CODE = `"""A small, reproducible experiment.

Outputs go to os.environ["RESEARCHPILOT_RUN_DIR"].
Emit metrics as JSON lines prefixed with RESEARCHPILOT_METRIC:.
"""
import json
import os
import random

import numpy as np

RUN_DIR = os.environ.get("RESEARCHPILOT_RUN_DIR", ".")
SEED = 42
random.seed(SEED)
np.random.seed(SEED)


def emit(**values):
    print("RESEARCHPILOT_METRIC:" + json.dumps(values, ensure_ascii=False))


def main():
    values = np.random.normal(size=200)
    result = {"metric": "mean", "value": float(values.mean()), "n": len(values), "seed": SEED}
    emit(**result)
    with open(os.path.join(RUN_DIR, "metrics.json"), "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)


if __name__ == "__main__":
    main()
`

type Tab = 'code' | 'run' | 'history'

export function ExperimentsPage(): ReactNode {
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  return <ExperimentWorkspace key={activeProjectId} activeProjectId={activeProjectId} />
}

function ExperimentWorkspace({ activeProjectId }: { activeProjectId: string }): ReactNode {
  const navigate = useNavigate()
  const askAssistant = (analyze = false): void => {
    useAppStore.getState().seedPrompt(analyze ? '请分析当前项目最近实验的真实日志与指标，判断结果是否支持假设，说明数据来源并给出下一步实验建议。' : '请基于当前研究假设设计可复现实验，明确 baseline、指标、随机种子与停止条件，创建脚本并先做最小规模验证。')
    navigate('/agent')
  }
  const sshHosts = useAppStore((state) => state.sshHosts)
  const experimentVersion = useAppStore((state) => state.experimentVersion)
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState<ExperimentDraft | null>(null)
  const [, refreshDraftIndicators] = useState(0)
  const [runs, setRuns] = useState<ExperimentRun[]>([])
  const [runsLoaded, setRunsLoaded] = useState(false)
  const [runsError, setRunsError] = useState('')
  const [runsAttempt, setRunsAttempt] = useState(0)
  const [selectedRun, setSelectedRun] = useState<ExperimentRun | null>(null)
  const [tab, setTab] = useState<Tab>('run')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [envKind, setEnvKind] = useState<'local' | 'ssh'>('local')
  const [sshHostId, setSshHostId] = useState('')
  const [autoCreateCode, setAutoCreateCode] = useState(DEFAULT_CODE)

  const [creating, setCreating] = useState(false)
  const [updatingEnvironment, setUpdatingEnvironment] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [codeError, setCodeError] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [createEnvKind, setCreateEnvKind] = useState<'local' | 'ssh'>('local')
  const [createSshHostId, setCreateSshHostId] = useState('')
  const context = useRef(new ExperimentContext())
  const mounted = useRef(false)
  const selectedIdRef = useRef('')
  const actionLock = useRef(false)
  const createLock = useRef(false)
  const listRequest = useRef(0)
  const runsRequest = useRef(0)

  const selected = experiments.find((experiment) => experiment.id === selectedId) ?? null
  const activeRun = runs.find((run) => run.status === 'running' || run.status === 'queued')
  const running = !!activeRun || (!runsLoaded && selected?.status === 'running')
  const modified = !!draft && draft.code !== draft.savedCode
  const busy = saving || starting || removing || updatingEnvironment
  const pythonExtensions = useMemo(() => [python()], [])
  const scope = (experimentId: string): ExperimentScope => ({ projectId: activeProjectId, experimentId })
  const isMounted = (): boolean => mounted.current && useAppStore.getState().activeProjectId === activeProjectId
  const isCurrent = (token: number): boolean => isMounted() && context.current.isCurrent(token)

  useLayoutEffect(() => {
    mounted.current = true
    const unsubscribe = experimentDrafts.subscribe(() => {
      if (!isMounted()) return
      refreshDraftIndicators((value) => value + 1)
      if (selectedIdRef.current) setDraft(experimentDrafts.get(scope(selectedIdRef.current)))
    })
    return () => {
      unsubscribe()
      mounted.current = false
      context.current.invalidate()
    }
  }, [])

  const selectExperiment = (id: string): void => {
    if (selectedIdRef.current === id) return
    context.current.invalidate()
    selectedIdRef.current = id
    setSelectedId(id)
    const next = experiments.find((experiment) => experiment.id === id)
    setEnvKind(next?.envKind ?? 'local')
    setSshHostId(next?.sshHostId ?? '')
    setDraft(id ? experimentDrafts.get(scope(id)) : null)
    setCodeError(false)
    setLoading(false)
    setRuns([])
    setRunsLoaded(false)
    setRunsError('')
    setSelectedRun(null)
    setTab('run')
  }

  const loadExperiments = async (token: number): Promise<void> => {
    if (!activeProjectId || !isCurrent(token)) return
    const request = ++listRequest.current
    const list = await api.experiments.list(activeProjectId)
    if (!isCurrent(token) || request !== listRequest.current) return
    setExperiments(list)
    if (!list.some((experiment) => experiment.id === selectedIdRef.current)) {
      selectExperiment(list[0]?.id ?? '')
    }
  }

  useEffect(() => {
    const token = context.current.capture()
    void loadExperiments(token).catch((error) => { if (isCurrent(token)) toast.error(formatError(error)) })
    // List updates do not reload code; drafts are independently scoped below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experimentVersion])

  useEffect(() => {
    if (!selectedId) return
    const token = context.current.capture()
    let cancelled = false
    const cached = experimentDrafts.get(scope(selectedId))
    if (cached) {
      setDraft(cached)
      return
    }
    setLoading(true)
    setCodeError(false)
    void api.experiments.readCode(selectedId).then((nextCode) => {
      if (!cancelled && isCurrent(token)) setDraft(experimentDrafts.load(scope(selectedId), nextCode))
    }).catch((error) => {
      if (!cancelled && isCurrent(token)) {
        setCodeError(true)
        toast.error(formatError(error))
      }
    }).finally(() => {
      if (!cancelled && isCurrent(token)) setLoading(false)
    })
    return () => { cancelled = true }
    // Run updates deliberately never read or replace editor code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, loadAttempt])

  useEffect(() => {
    if (!selected) return
    setEnvKind(selected.envKind)
    setSshHostId(selected.sshHostId)
  }, [selected?.id, selected?.envKind, selected?.sshHostId])

  useEffect(() => {
    if (!selectedId) return
    const token = context.current.capture()
    const request = ++runsRequest.current
    let cancelled = false
    void api.experiments.runs(selectedId).then((nextRuns) => {
      if (cancelled || !isCurrent(token) || request !== runsRequest.current) return
      setRuns(nextRuns)
      setRunsLoaded(true)
      setRunsError('')
      setSelectedRun((current) => nextRuns.find((run) => run.id === current?.id) ?? nextRuns[0] ?? null)
    }).catch((error) => {
      if (!cancelled && isCurrent(token) && request === runsRequest.current) setRunsError(formatError(error))
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, experimentVersion, runsAttempt])

  const createExperiment = async (): Promise<void> => {
    const token = context.current.capture()
    if (!activeProjectId || !name.trim() || createLock.current || !isCurrent(token)) return
    createLock.current = true
    setCreating(true)
    try {
      const experiment = await api.experiments.create({
        projectId: activeProjectId,
        name: name.trim(),
        description: description.trim(),
        envKind: createEnvKind,
        sshHostId: createEnvKind === 'ssh' ? createSshHostId : '',
        code: autoCreateCode
      })
      if (!isCurrent(token)) return
      ++listRequest.current
      setExperiments((current) => [...current.filter((item) => item.id !== experiment.id), experiment])
      experimentDrafts.load(scope(experiment.id), autoCreateCode)
      setCreateOpen(false)
      setName('')
      setDescription('')
      selectExperiment(experiment.id)
      toast.success('实验已创建')
    } catch (error) {
      if (isCurrent(token)) toast.error(formatError(error))
    } finally {
      createLock.current = false
      if (isMounted()) setCreating(false)
    }
  }

  const saveCode = async (runAfterSave = false): Promise<void> => {
    const token = context.current.capture()
    if (!selected || !draft || loading || actionLock.current || (runAfterSave && running) || !isCurrent(token) || selectedIdRef.current !== selected.id) return
    const target = scope(selected.id)
    const snapshot = draft.code
    actionLock.current = true
    setSaving(true)
    setStarting(runAfterSave)
    try {
      await api.experiments.saveCode(target.experimentId, snapshot)
      // Update only the original draft's baseline, even if its editor is no longer mounted.
      const nextDraft = experimentDrafts.saved(target, snapshot)
      if (!isCurrent(token)) return
      setDraft(nextDraft)
      setSaving(false)
      if (runAfterSave) {
        // Never start the old experiment after selection/project/route navigation during save.
        const run = await api.experiments.run(target.experimentId)
        if (!isCurrent(token)) return
        ++runsRequest.current
        setSelectedRun(run)
        setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)])
        setTab('run')
        toast.success('实验已启动')
      } else {
        toast.success('代码已保存')
      }
      await loadExperiments(token)
    } catch (error) {
      if (isCurrent(token)) toast.error(formatError(error))
    } finally {
      actionLock.current = false
      if (isMounted()) {
        setSaving(false)
        setStarting(false)
      }
    }
  }

  const stopRun = async (): Promise<void> => {
    const token = context.current.capture()
    if (!activeRun || activeRun.experimentId !== selectedIdRef.current || !isCurrent(token)) return
    try {
      await api.experiments.stop(activeRun.id)
    } catch (error) {
      if (isCurrent(token)) toast.error(formatError(error))
    }
  }

  const openArtifacts = async (): Promise<void> => {
    const token = context.current.capture()
    if (!selectedRun || selectedRun.experimentId !== selectedIdRef.current || !isCurrent(token)) return
    try {
      await api.experiments.openArtifact(selectedRun.id)
    } catch (error) {
      if (isCurrent(token)) toast.error(formatError(error))
    }
  }

  const changeEnvironment = async (nextKind: 'local' | 'ssh', nextHost = sshHostId): Promise<void> => {
    const token = context.current.capture()
    if (!selected || actionLock.current || !isCurrent(token) || selectedIdRef.current !== selected.id) return
    actionLock.current = true
    setUpdatingEnvironment(true)
    try {
      const updated = await api.experiments.update({ id: selected.id, envKind: nextKind, sshHostId: nextKind === 'ssh' ? nextHost : '' })
      if (!isCurrent(token)) return
      setExperiments((current) => current.map((experiment) => (experiment.id === updated.id ? updated : experiment)))
    } catch (error) {
      if (isCurrent(token)) toast.error(formatError(error))
    } finally {
      actionLock.current = false
      if (isMounted()) setUpdatingEnvironment(false)
    }
  }

  const removeExperiment = async (): Promise<void> => {
    const token = context.current.capture()
    if (!selected || actionLock.current || !isCurrent(token) || selectedIdRef.current !== selected.id) return
    if (!window.confirm(`删除实验「${selected.name}」？${modified ? '未保存的修改将丢失。' : ''}目录会移入回收区。`)) return
    const target = scope(selected.id)
    actionLock.current = true
    setRemoving(true)
    try {
      await api.experiments.remove(target.experimentId)
      experimentDrafts.remove(target)
      if (!isCurrent(token)) return
      toast.success('实验已删除')
      await loadExperiments(token)
    } catch (error) {
      if (isCurrent(token)) toast.error(formatError(error))
    } finally {
      actionLock.current = false
      if (isMounted()) setRemoving(false)
    }
  }

  const revertCode = (): void => {
    if (!selected || !modified || actionLock.current) return
    if (!window.confirm('放弃当前实验未保存的修改，恢复到上次加载或保存的代码？')) return
    setDraft(experimentDrafts.revert(scope(selected.id)))
  }

  return (
    <div className="page research-management experiments-page">
      <PageHeader
        title="实验台"
        subtitle="查看运行进度、真实指标与产物；实验设计和脚本交给助手。"
        actions={<><Button onClick={() => setCreateOpen(true)}><Plus />新建实验</Button><Button variant="primary" onClick={() => askAssistant()}>让助手设计实验</Button></>}
      />

      {experiments.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<FlaskConical />}
            title="还没有实验"
            text="助手创建并运行实验后，进度、日志、指标与产物会出现在这里。也可以新建一个实验，使用自己的脚本。"
            action={<Button onClick={() => askAssistant()}>让助手设计实验</Button>}
          />
        </div>
      ) : (
        <div className="experiment-layout">
          <aside className="exp-list" aria-label="实验列表">
            <div className="research-list-heading">实验 <span>{experiments.length}</span></div>
            {experiments.map((experiment) => (
              <button
                key={experiment.id}
                className={`exp-item${experiment.id === selectedId ? ' active' : ''}`}
                aria-pressed={experiment.id === selectedId}
                onClick={() => selectExperiment(experiment.id)}
              >
                <div className="exp-name">{experiment.name}{experimentDrafts.isModified(scope(experiment.id)) ? <span className="tiny muted"> · 未保存</span> : null}</div>
                <div className="exp-meta">
                  <StatusBadge status={experiment.status} />
                  <span>{experiment.envKind === 'ssh' ? 'SSH' : '本地'}</span>
                  <span>{relativeTime(experiment.updatedAt)}</span>
                </div>
              </button>
            ))}
          </aside>

          {selected ? (
            <section className="exp-workspace">
              <div className="exp-head">
                <div className="grow">
                  <h2 className="exp-title">{selected.name}</h2>
                  <div className="exp-sub">{selected.description || '实验代码保存在项目工作区，运行产物按 run ID 归档。'}</div>
                  <div className="row wrap mt-2">
                    <StatusBadge status={activeRun?.status ?? selected.status} />
                    <Badge tone="neutral">{selected.envKind === 'ssh' ? <><Server size={13} /> SSH 远程</> : '本地 Python'}</Badge>
                    <span className="tiny muted mono">{selected.entryFile}</span>
                  </div>
                </div>
                <div className="row">
                  <Button size="sm" variant="ghost" onClick={() => askAssistant(true)}>让助手分析</Button>
                  {running ? (
                    <Button size="sm" variant="danger" onClick={() => void stopRun()} disabled={!activeRun}><CircleStop />停止</Button>
                  ) : (
                    <Button size="sm" variant="primary" onClick={() => void saveCode(true)} disabled={busy || !draft || loading}>
                      {starting ? '启动中…' : <><Play />运行实验</>}
                    </Button>
                  )}
                </div>
              </div>

              {codeError ? <div className="alert alert-warning" role="alert">代码加载失败，保存与运行暂不可用。<Button size="sm" onClick={() => setLoadAttempt((value) => value + 1)}>重试加载</Button></div> : null}
              {runsError ? <div className="alert alert-warning" role="alert">运行记录未能更新：{runsError}<Button size="sm" onClick={() => setRunsAttempt((value) => value + 1)}>重试</Button></div> : null}
              {activeRun && selectedRun?.id !== activeRun.id ? <div className="research-running-notice">另一次运行正在进行。<Button size="sm" onClick={() => { setSelectedRun(activeRun); setTab('run') }}>查看当前运行</Button></div> : null}
              {modified && tab !== 'code' ? <div className="research-running-notice">代码有未保存的修改；下次运行会先保存。<Button size="sm" onClick={() => setTab('code')}>查看修改</Button></div> : null}
              <div className="exp-tabs">
                <button className={`exp-tab${tab === 'run' ? ' active' : ''}`} aria-pressed={tab === 'run'} onClick={() => setTab('run')}>运行结果</button>
                <button className={`exp-tab${tab === 'history' ? ' active' : ''}`} aria-pressed={tab === 'history'} onClick={() => setTab('history')}>运行历史 ({runs.length})</button>
                <button className={`exp-tab${tab === 'code' ? ' active' : ''}`} data-testid="experiment-code-tab" aria-pressed={tab === 'code'} onClick={() => setTab('code')}>代码与配置{modified ? ' · 未保存' : ''}</button>
              </div>

              {tab === 'code' ? (
                <>
                  <div className="research-code-toolbar row wrap">
                    <span className="small muted" data-testid="experiment-draft-status" role="status">{draft ? modified ? '已修改 · 未保存' : '已保存' : codeError ? '代码加载失败' : '加载代码中…'}</span>
                    <div className="grow" />
                    <Button size="sm" data-testid="experiment-revert" onClick={revertCode} disabled={!modified || busy || running}>还原</Button>
                    <Button size="sm" onClick={() => void saveCode()} disabled={busy || running || !draft || loading}>{saving ? '保存中…' : <><Save />保存</>}</Button>
                  </div>
                  <div className="research-environment row wrap">
                    <label className="row small">执行环境<select className="select" aria-label="执行环境" disabled={busy || running} value={envKind} onChange={(event) => void changeEnvironment(event.target.value as 'local' | 'ssh')}><option value="local">本地 Python</option><option value="ssh">SSH 远程</option></select></label>
                    {envKind === 'ssh' ? <select className="select" aria-label="SSH 主机" disabled={busy || running} value={sshHostId} onChange={(event) => void changeEnvironment('ssh', event.target.value)}><option value="">选择 SSH 主机…</option>{sshHosts.map((host) => <option key={host.id} value={host.id}>{host.name} ({host.username}@{host.host})</option>)}</select> : <span className="small muted">使用设置中的 Python；未配置时使用 uv。</span>}
                    {envKind === 'ssh' && sshHosts.length === 0 ? <span className="small" role="alert">请先在设置中添加 SSH 主机。</span> : null}
                  </div>
                  {running ? <p className="small muted">运行期间代码与配置只读；仍可查看日志、产物和历史。</p> : null}
                  <div className="code-surface" data-testid="experiment-editor">
                    {codeError ? <div className="row small muted" role="alert">代码加载失败，未启用保存或运行。<Button size="sm" onClick={() => setLoadAttempt((value) => value + 1)}>重试</Button></div> : null}
                    <CodeMirror
                      key={selectedId}
                      value={draft?.code ?? ''}
                      editable={!!draft && !running}
                      height="440px"
                      extensions={pythonExtensions}
                      onChange={(value) => {
                        if (selectedIdRef.current === selected.id && isMounted()) setDraft(experimentDrafts.edit(scope(selected.id), value))
                      }}
                      basicSetup={{ lineNumbers: true, foldGutter: true }}
                      theme="light"
                    />
                  </div>
                  <div className="alert alert-info">
                    <Terminal />
                    <div>
                      将产物写入 <code>os.environ["RESEARCHPILOT_RUN_DIR"]</code>，用 <code>RESEARCHPILOT_METRIC:{"{...}"}</code> 输出指标。这样智能体和你都能在运行结果中看到可追溯数据。
                      <div className="tiny muted mt-2">未保存的代码仅保留在本次应用会话内；切换实验或页面不会丢失，刷新或关闭应用后会清除。</div>
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => void removeExperiment()} disabled={busy || running}><Trash2 />删除实验</Button>
                </>
              ) : null}

              {tab === 'run' ? (
                selectedRun ? (
                  <div className="stack research-run-results" data-testid="experiment-results">
                    <div className="row wrap">
                      <StatusBadge status={selectedRun.status} />
                      <span className="small muted">run {selectedRun.id.slice(-10)} · {new Date(selectedRun.startedAt).toLocaleString('zh-CN')}</span>
                      {selectedRun.exitCode !== null ? <Badge tone={selectedRun.exitCode === 0 ? 'neutral' : 'danger'}>exit {selectedRun.exitCode}</Badge> : null}
                      <div className="grow" />
                      <Button size="sm" onClick={() => void openArtifacts()}><FolderOpen />产物目录</Button>
                    </div>
                    <section className="research-run-section" aria-label="本次运行指标">
                      <h3>记录的指标</h3>
                      {Object.keys(selectedRun.metrics).length > 0 ? <table className="research-metrics-table"><thead><tr><th scope="col">指标</th><th scope="col">值</th></tr></thead><tbody>{Object.entries(selectedRun.metrics).map(([key, value]) => <tr key={key}><th scope="row">{key}</th><td>{formatNumber(value)}</td></tr>)}</tbody></table> : <p className="small muted">本次运行尚未上报指标。日志与产物仍可查看。</p>}
                    </section>
                    <section className="research-run-section" aria-label="运行日志">
                      <h3>运行日志</h3>
                      <div className="terminal" tabIndex={0} aria-label="标准输出与错误日志">
                        {selectedRun.stdout || '(暂无 stdout)'}
                        {selectedRun.stderr ? <div className="err">{selectedRun.stderr}</div> : null}
                      </div>
                    </section>
                    <details className="research-disclosure"><summary>运行来源与命令</summary><dl className="research-provenance"><div><dt>运行 ID</dt><dd>{selectedRun.id}</dd></div><div><dt>命令</dt><dd>{selectedRun.command || '未记录'}</dd></div><div><dt>产物目录</dt><dd>{selectedRun.artifactDir || '未记录'}</dd></div><div><dt>结束时间</dt><dd>{selectedRun.finishedAt ? new Date(selectedRun.finishedAt).toLocaleString('zh-CN') : '尚未结束'}</dd></div></dl></details>
                  </div>
                ) : (
                  <EmptyState icon={<Play />} title={!runsLoaded ? '正在读取运行记录' : '还没有运行结果'} text={!runsLoaded ? '读取完成后将在这里显示日志和指标。' : '助手运行实验后，结果会显示在这里；也可以点击「运行实验」。'} />
                )
              ) : null}

              {tab === 'history' ? (
                <div className="card card-pad">
                  {runs.length === 0 ? (
                    <EmptyState icon={<Play />} title="还没有运行记录" />
                  ) : (
                    runs.map((run) => (
                      <button type="button" key={run.id} className={`run-row${selectedRun?.id === run.id ? ' active' : ''}`} onClick={() => { setSelectedRun(run); setTab('run') }}>
                        <div className="list-main">
                          <div className="list-title">run {run.id.slice(-10)}</div>
                          <div className="list-sub">{new Date(run.startedAt).toLocaleString('zh-CN')} · {Object.entries(run.metrics).slice(0, 2).map(([key, value]) => `${key}=${formatNumber(value)}`).join(' · ') || '无指标'}</div>
                        </div>
                        <StatusBadge status={run.status} />
                        <span className="tiny muted">exit {run.exitCode ?? '—'}</span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </section>
          ) : (
            <div className="card"><EmptyState title="选择一个实验" text="从左侧选择实验查看运行结果、日志和历史。" /></div>
          )}
        </div>
      )}

      {createOpen ? (
        <Modal
          title="新建实验"
          subtitle="先用最小可复现脚本验证流程，再扩大规模。"
          size="wide"
          onClose={() => { if (!createLock.current) setCreateOpen(false) }}
          footer={(
            <>
              <Button disabled={creating} onClick={() => setCreateOpen(false)}>取消</Button>
              <Button variant="primary" disabled={!name.trim() || creating} onClick={() => void createExperiment()}>{creating ? '创建中…' : '创建实验'}</Button>
            </>
          )}
        >
          <div className="grid-2">
            <Field label="实验名称"><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：Baseline vs Ours on split A" /></Field>
            <Field label="执行环境">
              <Select value={createEnvKind} onChange={(event) => setCreateEnvKind(event.target.value as 'local' | 'ssh')}>
                <option value="local">本地 Python</option>
                <option value="ssh">SSH 远程</option>
              </Select>
            </Field>
          </div>
          {createEnvKind === 'ssh' ? (
            <Field label="SSH 主机">
              <Select value={createSshHostId} onChange={(event) => setCreateSshHostId(event.target.value)}>
                <option value="">选择主机…</option>
                {sshHosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
              </Select>
            </Field>
          ) : null}
          <Field label="说明"><Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="假设、baseline、指标、随机种子…" /></Field>
          <Field label="初始代码" hint="可以直接使用模板，稍后在编辑器中修改。">
            <Textarea style={{ minHeight: 220, fontFamily: 'var(--font-mono)', fontSize: 13 }} value={autoCreateCode} onChange={(event) => setAutoCreateCode(event.target.value)} />
          </Field>
        </Modal>
      ) : null}

      {loading ? <div className="tiny muted">加载实验代码…</div> : null}
    </div>
  )
}
