import { useEffect, useMemo, useState, type ReactNode } from 'react'
import '../styles/skills-pipeline.css'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, CheckCircle2, Circle, CircleStop, Loader2, MessageSquare, Play, RefreshCw, Workflow, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import type { DocumentFormat, PipelineRun, PipelineSnapshot, PipelineStep } from '@shared/types'
import { api, formatError, relativeTime } from '../lib/api'
import { useAppStore } from '../store/app'
import { Badge, Button, EmptyState, Field, Input, PageHeader, StatusBadge } from '../components/Ui'
import { ReadinessRequestGuard } from '../lib/readiness'
import { PipelinePreflight, useDeliveryReadiness } from './Setup'

function StageIcon({ status }: { status: PipelineStep['status'] }): ReactNode {
  if (status === 'completed') return <CheckCircle2 size={15} />
  if (status === 'running') return <Loader2 size={15} className="spin" />
  if (status === 'failed') return <XCircle size={15} />
  if (status === 'skipped') return <Circle size={15} />
  return <span className="tiny">•</span>
}

export function PipelinePage(): ReactNode {
  const navigate = useNavigate()
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const project = useAppStore((state) => state.projects.find((item) => item.id === state.activeProjectId))
  const pipelineVersion = useAppStore((state) => state.pipelineVersion)
  const agentState = useAppStore((state) => state.agentState)
  const selectChat = useAppStore((state) => state.selectChat)
  const readiness = useDeliveryReadiness()
  const modelSelection = readiness.selection
  const selectedProvider = readiness.provider
  const [snapshot, setSnapshot] = useState<PipelineSnapshot | null>(null)
  const [topic, setTopic] = useState('')
  const [formats, setFormats] = useState<DocumentFormat[]>(['docx'])
  const [autoRun, setAutoRun] = useState(false)
  const [busy, setBusy] = useState('')
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const actionScope = useMemo(() => new ReadinessRequestGuard(), [activeProjectId])
  useEffect(() => () => actionScope.invalidate(), [actionScope])

  const generateEvidence = async (): Promise<void> => {
    if (!activeProjectId) return
    setBusy('evidence')
    try {
      const result = await api.evidence.generate(activeProjectId)
      toast.success(`证据报告已生成：${result.relativePath}${result.warnings ? `，${result.warnings} 条待核对` : ''}`)
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setBusy('')
    }
  }

  const run = snapshot?.run ?? null
  const running = run?.status === 'running'
  const agentRunning = agentState?.status === 'running' || agentState?.status === 'starting'

  useEffect(() => {
    setSnapshot(null)
    setBusy('')
    setTopic(project?.description || project?.name || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId])

  useEffect(() => {
    let active = true
    setLoadError('')
    if (activeProjectId) void api.pipeline.get(activeProjectId).then(next => {
      if (active) setSnapshot(next)
    }).catch(error => {
      if (active) { setSnapshot(null); setLoadError(formatError(error)) }
    })
    return () => { active = false }
  }, [activeProjectId, pipelineVersion, reload])

  useEffect(() => {
    if (project && !topic) setTopic(project.description || project.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project])

  const completed = run?.steps.filter((step) => step.status === 'completed').length ?? 0
  const total = snapshot?.stages.length ?? 8
  const nextStage = useMemo(() => run?.steps.find((step) => step.status === 'pending'), [run])
  const nextStageMeta = snapshot?.stages.find((stage) => stage.id === nextStage?.stage)

  const start = async (): Promise<void> => {
    if (!activeProjectId || !snapshot || !topic.trim() || busy || agentRunning || running || !readiness.canStartPipeline) return
    const token = actionScope.begin()
    setBusy('start')
    try {
      const started = await api.pipeline.start({ projectId: activeProjectId, topic: topic.trim(), formats, autoRun, ...modelSelection })
      if (!actionScope.isCurrent(token)) return
      setSnapshot((current) => current ? { ...current, run: started } : current)
      toast.success(autoRun ? '流水线已启动，将自动推进到需要确认的步骤' : '流水线已启动，完成首阶段后会暂停')
    } catch (error) {
      if (actionScope.isCurrent(token)) { toast.error(formatError(error)); void readiness.refresh() }
    } finally {
      if (actionScope.isCurrent(token)) setBusy('')
    }
  }

  const canContinue = !readiness.loading && !readiness.failed && readiness.pythonReady && readiness.mcpEnabled
  const continueRun = async (): Promise<void> => {
    if (!run || busy || agentRunning || !canContinue) return
    setBusy('continue')
    try {
      await api.pipeline.runStage(run.id)
      toast.success('继续执行下一阶段')
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setBusy('')
    }
  }

  const cancel = async (): Promise<void> => {
    if (!run) return
    if (!window.confirm('停止当前流水线？当前阶段会被标记为失败，已生成产物会保留。')) return
    setBusy('cancel')
    try {
      await api.pipeline.cancel(run.id)
      toast.success('流水线已停止')
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setBusy('')
    }
  }

  const reset = async (): Promise<void> => {
    if (!activeProjectId) return
    if (!window.confirm('清除流水线记录并重新规划？文稿、实验和图表产物不会被删除。')) return
    try {
      const next = await api.pipeline.reset(activeProjectId)
      setSnapshot(next)
    } catch (error) {
      toast.error(formatError(error))
    }
  }

  const openChat = async (): Promise<void> => {
    if (!run) return
    await selectChat(run.chatId)
    navigate('/agent')
  }

  return (
    <div className="page research-pipeline-page">
      <PageHeader
        eyebrow="研究协议"
        title="产物通过，研究才推进"
        subtitle="从文献到审阅，每阶段都核验实际文件、证据记录与来源。智能体说“完成”不会自动通过门禁。"
        actions={(
          <>
            <Button onClick={() => void generateEvidence()} disabled={!!busy || !activeProjectId}><CheckCircle2 />证据报告</Button>
            {run?.status === 'paused' || run?.status === 'failed' ? <Button variant="primary" disabled={!!busy || agentRunning || !canContinue} onClick={() => void continueRun()}><Play />{run.status === 'failed' ? '重试未通过阶段' : '继续下一阶段'}</Button> : null}
            {run && (running || run.status === 'paused') ? <Button variant="danger" onClick={() => void cancel()} disabled={!!busy}><CircleStop />停止</Button> : null}
            {run && run.status !== 'running' ? <Button onClick={() => void reset()} disabled={!!busy}><RefreshCw />重新规划</Button> : null}
          </>
        )}
      />

      <div className="research-capability-note">
        <CheckCircle2 size={19} aria-hidden="true" />
        <div><strong>门禁检查结构证据，不替代科学判断</strong><p>成功 run、非空产物和 SHA-256 记录是最低要求。演示图和旧版图片不算原生可编辑交付；数据不足时停止，不补造结果。</p></div>
      </div>
      <PipelinePreflight readiness={readiness} />
      {loadError && <div className="alert alert-danger" role="alert">流水线记录加载失败：{loadError}<Button size="sm" onClick={() => setReload(value => value + 1)}>重试加载</Button></div>}
      <div className="pipeline-grid">
        <section className="card card-pad">
          {run ? (
            <>
              <div className="row-between">
                <div>
                  <div className="small muted">当前研究</div>
                  <h2 className="section-title">{run.topic.split('\n')[0].slice(0, 110)}{run.topic.split('\n')[0].length > 110 ? '…' : ''}</h2>
                  {run.topic.length > 110 ? <details className="mt-2"><summary className="small muted">查看完整研究要求</summary><p style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.8, fontWeight: 400 }}>{run.topic}</p></details> : null}
                  <div className="card-sub">{run.status === 'paused' ? `已完成 ${completed}/${total}，下一步：${nextStageMeta?.label ?? '—'}` : run.status === 'completed' ? '全部阶段已完成' : `当前阶段：${snapshot?.stages.find((stage) => stage.id === run.currentStage)?.label ?? '—'}`}</div>
                </div>
                <StatusBadge status={run.status} />
              </div>
              <p className="research-gate-progress">{completed} / {total} 个阶段已通过产物门禁</p>
              <div className="pipeline-stages mt-4">
                {snapshot?.stages.map((stage, index) => {
                  const step = run.steps.find((item) => item.stage === stage.id)
                  const status = step?.status ?? 'pending'
                  return (
                    <div className={`stage-row ${status}`} key={stage.id}>
                      <div className="stage-index"><StageIcon status={status} /></div>
                      <div>
                        <div className="stage-name">{index + 1}. {stage.label} <span className="tiny muted">· {stage.skill}</span></div>
                        <div className="stage-desc">{stage.description}</div>
                        {step?.error ? <div className="alert alert-danger mt-2">{step.error}</div> : null}
                        {step?.output ? (
                          <details className="mt-2">
                            <summary className="small muted" style={{ cursor: 'pointer' }}>阶段产出</summary>
                            <div className="stage-output">{step.output}</div>
                          </details>
                        ) : null}
                      </div>
                      <div className="stack" style={{ alignItems: 'flex-end', gap: 4 }}>
                        <StatusBadge status={status} />
                        {step?.finishedAt ? <span className="tiny muted">{relativeTime(step.finishedAt)}</span> : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          ) : (
            <EmptyState
              icon={<Workflow />}
              title={loadError ? '暂时无法读取流水线' : !snapshot ? '正在读取流水线…' : '还没有运行流水线'}
              text={loadError ? '请重试加载，现有记录不会被当作空记录。' : '在右侧填写研究主题，选择产出格式。流水线会先做文献和实验，最后才生成论文。'}
            />
          )}
        </section>

        <aside className="pipeline-side">
          {!run || run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed' ? (
            <div className="card card-pad">
              <div className="section-head">
                <h2 className="section-title"><Play size={17} />开始新的研究</h2>
              </div>
              <Field label="研究主题" hint="越具体越好。包含任务、数据、比较对象和期待的贡献。">
                <Input value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="例如：在长文档问答中比较稀疏检索与稠密检索的鲁棒性" />
              </Field>
              <Field label="论文产出">
                <div className="row wrap">
                  <label className="checkbox-row">
                    <input type="checkbox" checked={formats.includes('docx')} onChange={(event) => setFormats(event.target.checked ? [...formats, 'docx'] : formats.filter((item) => item !== 'docx'))} />
                    DOCX
                  </label>
                  <label className="checkbox-row">
                    <input type="checkbox" checked={formats.includes('latex')} onChange={(event) => setFormats(event.target.checked ? [...formats, 'latex'] : formats.filter((item) => item !== 'latex'))} />
                    LaTeX
                  </label>
                </div>
              </Field>
              <label className="checkbox-row" style={{ marginBottom: 14 }}>
                <input type="checkbox" checked={autoRun} onChange={(event) => setAutoRun(event.target.checked)} />
                自动推进（危险操作仍会请求确认）
              </label>
              <Button variant="primary" style={{ width: '100%' }} disabled={!activeProjectId || !topic.trim() || !!busy || agentRunning || !snapshot || !readiness.canStartPipeline} onClick={() => void start()}>
                {busy === 'start' ? '启动中…' : agentRunning ? '智能体正在运行' : <><Play size={15} />启动流水线</>}
              </Button>
              <div className="field-hint mt-2">开始前需在 MCP 工具连接中启用三个内置服务，并在设置中指定本地 Python。图表、可编辑 PPT 与文稿由流程生成；未具备条件会明确停止，不要求用户手工补造结果。</div>
              <div className="field-hint mt-2">已配置角色使用各自提供方/模型和独立会话；未配置角色沿用所选模型：{selectedProvider?.name ?? '未选择提供方'} / {modelSelection.modelId || '未选择模型'}。未勾选自动推进时，核验产物后暂停。</div>
              {!readiness.canStartPipeline && !selectedProvider?.hasApiKey ? <div className="alert alert-warn mt-2">请检查所选模型或角色配置中的 API Key；不会静默切换提供方。</div> : null}
            </div>
          ) : null}

          {run ? (
            <>
              <div className="card card-pad">
                <div className="section-head"><h2 className="section-title">运行信息</h2></div>
                <div className="stack small">
                  <div className="row-between"><span className="muted">主题</span><span className="truncate" style={{ maxWidth: 200 }}>{run.topic}</span></div>
                  <div className="row-between"><span className="muted">产出</span><span>{run.formats.map((format) => format.toUpperCase()).join(' + ')}</span></div>
                  <div className="row-between"><span className="muted">自动推进</span><span>{run.autoRun ? '开启' : '关闭'}</span></div>
                  <div className="row-between"><span className="muted">开始时间</span><span>{relativeTime(run.createdAt)}</span></div>
                  <div className="row-between"><span className="muted">当前阶段</span><span>{snapshot?.stages.find((stage) => stage.id === run.currentStage)?.label ?? '—'}</span></div>
                </div>
                <div className="row mt-4">
                  <Button size="sm" onClick={() => void openChat()}><MessageSquare />查看智能体会话</Button>
                  {run.status === 'paused' ? <Button size="sm" variant="primary" onClick={() => void continueRun()} disabled={!!busy || agentRunning || !canContinue}><ArrowRight />继续</Button> : null}
                </div>
              </div>

              <div className="card card-pad">
                <div className="card-title">产物位置</div>
                <div className="stack small muted mt-2">
                  <span className="mono">references/research-brief.md</span>
                  <span className="mono">experiments/plan.md</span>
                  <span className="mono">exports/experiment-log.md</span>
                  <span className="mono">exports/analysis.md</span>
                  <span className="mono">exports/data-audit.json</span>
                  <span className="mono">exports/statistical-analysis.json</span>
                  <span className="mono">exports/pipeline/{run.id}/</span>
                  <span className="mono">figures/：JSON + SVG + PPTX</span>
                  <span className="mono">manuscripts/ · exports/review-report.md</span>
                </div>
              </div>

              <div className="alert alert-warn">
                <Workflow />
                <div>阶段失败会停在原处；检查错误与交接清单后可重试，不会跳过缺失证据写论文。通过门禁仅表示结构检查通过，不保证统计或科学结论正确。</div>
              </div>
            </>
          ) : (
            <div className="card card-pad">
              <div className="card-title">安全与证据</div>
              <div className="card-sub mt-2">实验、远程 SSH、任意 Python 绘图及外部文献检索均请求批准。结构化图表通过受限 JSON 生成原生可编辑 PPTX，不执行其中的代码。</div>
              <div className="row wrap mt-4">
                <Badge tone="accent">证据优先</Badge>
                <Badge tone="gold">需要审批</Badge>
                <Badge tone="neutral">本地优先</Badge>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
