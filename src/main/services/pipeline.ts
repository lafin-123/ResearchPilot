import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  DocumentFormat,
  PipelineRun,
  PipelineSnapshot,
  PipelineStage,
  PipelineStartInput,
  PipelineStatus,
  PipelineStep
} from '@shared/types'
import { validateFigureSpec } from '../../shared/figure-spec'
import type { Db } from '../lib/db'
import { emitEvent } from '../lib/events'
import { newId, nowIso, parseJson, truncate } from '../lib/util'
import type { AgentService } from './agent'
import type { ChatService } from './chats'
import type { DocumentService } from './documents'
import type { ProjectService } from './projects'
import type { ReferenceService } from './references'
import type { SettingsService } from './settings'
import { AGENT_ROLES, normalizeAgentRoles, roleForStage, type AgentRoleModels } from '../../shared/agent-roles'

interface StageDefinition extends PipelineStage {
  buildPrompt: (context: { topic: string; formats: DocumentFormat[]; previous: string; documentIds: Record<string, string> }) => string
}

const STAGES: StageDefinition[] = [
  {
    id: 'literature',
    label: '文献调研',
    description: '界定问题、检索证据、建立文献矩阵并写出可实验的 gap。',
    skill: 'literature-review',
    prompt: '',
    buildPrompt: ({ topic }) => `Execute the literature stage for the research project on: "${topic}".

Load the literature-review skill first. Then:
1. Clarify the question, scope, inclusion/exclusion criteria.
2. Search the local library first. External searches are optional and require the user's permission; this stage can work entirely from supplied sources.
3. Record an evidence matrix at references/evidence-matrix.md and a precise research gap.
4. Save the handoff as references/research-brief.md.
5. Do not design the final experiment yet, but name candidate baselines and metrics.

Use native tools only (no shell): mcp__rp_evidence__workspace_inventory and reference_search first, then literature_search({query,limit}) with approval when new sources are needed; reference_add_doi({doi}) registers only actual Crossref metadata. Use reference_read for each selected ID. Crossref metadata is not full text: quote only available abstracts, label title-only records and unavailable support honestly. Write the evidence matrix and brief with mcp__rp_artifacts__project_artifact_write({path,content}). Narrow a broad topic into a feasible, original, explicitly scoped numerical simulation or analytical experiment when real datasets are unavailable; disclose this choice and do not call it empirical real-world validation.

Finish with a concise summary and the path of the brief. Never fabricate citations.`
  },
  {
    id: 'hypothesis',
    label: '假设与方案',
    description: '把 gap 转成可证伪假设、baseline、指标与成功标准。',
    skill: 'experiment-design',
    prompt: '',
    buildPrompt: ({ topic, previous }) => `Execute the hypothesis stage for: "${topic}".

Previous stage summary:
${previous || '(none)'}

Load the experiment-design skill. Turn the gap into:
- falsifiable hypotheses and null hypotheses;
- primary/secondary metrics and success criteria defined before seeing results;
- strongest baselines and required datasets/splits;
- seeds, repetitions, compute budget and risks.

Read the research brief using mcp__rp_artifacts__artifact_read. Save experiments/plan.md with mcp__rp_artifacts__project_artifact_write({path,content}). Budget local runs below 60 seconds and use Python standard library when dependencies are unavailable. For a numerical simulation explicitly state the data-generating assumptions, estimand and limits of external validity. Do not run the final experiment yet. Finish with a short summary.`
  },
  {
    id: 'design',
    label: '实验设计',
    description: '编写协议与最小 smoke test，确保结果可复现。',
    skill: 'experiment-design',
    prompt: '',
    buildPrompt: ({ topic, previous }) => `Execute the experiment-design stage for: "${topic}".

Previous stage summary:
${previous || '(none)'}

Load the experiment-design skill. Read experiments/plan.md using artifact_read and:
1. Author the complete real experimental Python code yourself, including proposed method, fair baselines, deterministic seeds, repetitions, and raw per-unit observations. This must compute results, not print precomputed or invented numbers. Use standard library only unless installed dependencies are known.
2. Register inline code with mcp__rp_artifacts__experiment_create({name,description,code}). It creates a new source file and returns the actual experiment ID/path; no shell or code-file staging.
3. Run a bounded cheap smoke test with experiment_run({experimentId,timeoutSeconds:60}); approval is mandatory. Put outputs in os.environ['RESEARCHPILOT_RUN_DIR']; project input root is RESEARCHPILOT_PROJECT_ROOT. Emit one flat numeric object on a RESEARCHPILOT_METRIC: line, including a scalar seed. Save all seeds/configuration/raw observations separately, never overwrite the runner's manifest.json.
4. Inspect experiment_runs, run_reproducibility, and artifact_read for actual metrics, stdout/stderr and outputs. If fixing code, create a new experiment; never claim a failed run passed.

Finish with the experiment ID, code path and smoke-test evidence. Save exports/design-check.md with verified code paths, input contract, test command, expected metrics and any budget/approval blockers. A deferred smoke run must be disclosed, not reported as successful.`
  },
  {
    id: 'execute',
    label: '实验执行',
    description: '运行主实验与 baseline，收集 run ID、指标、日志与产物。',
    skill: 'experiment-design',
    prompt: '',
    buildPrompt: ({ topic, previous }) => `Execute the experiment execution stage for: "${topic}".

Previous stage summary:
${previous || '(none)'}

Load the experiment-design skill. Now run the planned experiments:
1. Check the smoke test passed and fix defects before scaling.
2. Run baselines and the proposed method under identical conditions.
3. Use native workspace_inventory/experiment_runs to discover actual IDs, experiment_create({name,description,code}) for your own complete implementation, and experiment_run({experimentId,timeoutSeconds:60}) for each approved run. No shell, SSH, package installation or seed artifacts supplied by a test harness. Keep each run below its 30–120 second bound; a compact standard-library numerical experiment is legitimate if explicitly scoped as simulation, not real-world evidence.
4. Record run IDs, seeds, n, metrics, failures and artifact paths.
5. Do not fabricate anything. Report negative results honestly.

Create a concise evidence log at exports/experiment-log.md. Finish with the run IDs and headline numbers (with uncertainty).`
  },
  {
    id: 'analysis',
    label: '结果分析',
    description: '对比 baseline、量化不确定性、做消融与稳健性检查。',
    skill: 'statistical-analysis',
    prompt: '',
    buildPrompt: ({ topic, previous }) => `Execute the analysis stage for: "${topic}".

Previous stage summary:
${previous || '(none)'}

Load data-audit and statistical-analysis for methodology. Use artifact_read to inspect actual immutable run observations and the experiment log. Author and register a separate analysis experiment via experiment_create, then execute it via experiment_run; do not calculate headline numbers in prose or manufacture a passed audit. Its code must read the actual earlier run artifact through RESEARCHPILOT_PROJECT_ROOT, audit the dataset, and compute comparisons, effect sizes and uncertainty under the declared sampling design. For paired simulations use independent seed/replicate as the paired unit, not pooled outcomes across budgets. Preserve missingness, unique observation IDs, and separate pairing IDs. Save actual computed audit/statistical reports in that analysis run directory, then read them with artifact_read and copy their exact contents to exports/data-audit.json and exports/statistical-analysis.json using project_artifact_write. Reports require version:1,status:'passed',blockers:[] ONLY for checks actually executed and passed; include input paths/hashes, analysis run ID, method, units, sample size and limitations. Unsupported designs must block, not be coerced into an inappropriate test.
Then:
- compare methods against baselines under identical conditions;
- quantify uncertainty, seeds and sample size;
- run ablations/robustness checks where feasible;
- check for leakage, unfair tuning, silent failures and missing artifacts;
- state which hypothesis is supported, contradicted, or unresolved.

Save the analysis to exports/analysis.md with a claims–evidence table. Every number must cite a run ID. Finish with the strongest and weakest claims.`
  },
  {
    id: 'figures',
    label: '图表制作',
    description: '以真实 run 为来源，保留 JSON、SVG 与原生可编辑 PPTX。',
    skill: 'editable-presentation',
    prompt: '',
    buildPrompt: ({ topic, previous }) => `Execute the figures stage for: "${topic}".

Previous stage summary:
${previous || '(none)'}

Load plotting, scientific-diagram and editable-presentation. Read exports/analysis.md and the run artifacts. Make at least one structured, native editable figure supporting a main claim; add additional figures only when justified. Preserve a project-local FigureSpec JSON, its SVG preview and PPTX export. A PNG embedded on a slide is NOT an editable chart. Mark provenance.isDemo=false only for actual measured data; sourceLabel must identify the run ID and real artifact path. Do not substitute random/demo values or remove uncertainty to fit a supported chart.

Use mcp__rp_artifacts__figure_create_spec({spec,experimentId,name,caption}) with the inline FigureSpec object you construct from actual analysis outputs; no pre-seeded spec file or shell. Use figure_inspect and artifact_read on the returned registered source path to verify native objects and values. FigureSpec has 1–3 series, 2–200 rows, no error bars/log axes. Preserve uncertainty honestly: a three-series estimate/lower/upper interval figure for one estimand, or separate figures plus explicit CI tables. Do not silently omit uncertainty or treat category spacing as numeric/log spacing. Native exporter creates JSON/SVG/PPTX together.

Legacy Python rendering is available with approval when the supported schema cannot express the figure, but it does not meet the native-editable gate. State this limitation instead of claiming an image is editable.
Save exports/figure-evidence.md with figure IDs, source run IDs, captions, units, uncertainty interpretation, JSON/SVG/PPTX paths and visual/editability checks. Finish with any figures you could not produce honestly.`
  },
  {
    id: 'paper',
    label: '论文生成',
    description: '基于证据生成 DOCX / LaTeX 论文并检查数字与引用。',
    skill: 'paper-writing',
    prompt: '',
    buildPrompt: ({ topic, formats, previous, documentIds }) => `Execute the manuscript stage for: "${topic}".

Previous stage summary:
${previous || '(none)'}

Requested formats: ${formats.join(', ') || 'docx, latex'}.

Load the paper-writing skill. Read:
- references/research-brief.md
- experiments/plan.md
- exports/experiment-log.md
- exports/analysis.md
- the figure records

Build a claims–evidence map at exports/claims-evidence.md first. Include actual registered chart previews as standalone Markdown images ![caption](figures/.../figure.svg) using returned project-relative paths; the document service embeds their verified structured rendering. Keep separate editable PPTX deliverables and report uncertainty in captions/tables. Then write a complete manuscript with abstract, introduction, related work, method, experimental setup, results, discussion, limitations, conclusion, and real citations. Every empirical number must trace to a run ID; every citation must exist in the project library or a verified DOI. Label anything unverified as TODO rather than inventing it.

For each requested format:
${formats.includes('docx') ? `- DOCX document id: ${documentIds.docx ?? '(none)'}. Use mcp__rp_writing__manuscript_write({id,markdown}) with the complete manuscript. This creates an actual DOCX through the native document service.` : ''}
${formats.includes('latex') ? `- LaTeX document id: ${documentIds.latex ?? '(none)'}. Use manuscript_write({id,markdown}) with complete TeX source in markdown. Native tool does not compile TeX; disclose that compilation remains unverified, do not invoke shell.` : ''}

Finish with the document IDs, compile status, word counts, and a list of unresolved evidence gaps.`
  },
  {
    id: 'review',
    label: '审稿与修订',
    description: '审计主张、数字、引用与可复现性，并完成修订。',
    skill: 'peer-review',
    prompt: '',
    buildPrompt: ({ topic, previous, documentIds }) => `Execute the review stage for: "${topic}".

Previous stage summary:
${previous || '(none)'}

Load peer-review, citation-audit and reproducibility for methodology, but do not call shell scripts. Use native manuscript_read, reference_read, run_reproducibility, figure_inspect and artifact_read. Author a registered review/audit Python experiment with experiment_create and execute with experiment_run. It must mechanically compare actual manuscript source/numbers/citation IDs and DOI strings against retrieved records and actual run data, check file hashes/metadata and report discrepancies. Save real emitted JSON in its run directory, read it, then copy exact audit output to exports/citation-audit.json and exports/reproducibility.json using project_artifact_write. Mechanical reports may use version=1,status='passed',blockers=[] only for checks performed and passed; include scope='mechanical', source paths, audit run ID and humanReviewRequired=true. A local reference/DOI match is NOT full-text authenticity, sentence support or human review. Do not set supportReviewed=true or claim a human reviewed it. Record full-text/source-support and scientific validity as unresolved human checks in limitations, with quotes only from genuinely available abstracts. Unsupported factual source claims must be removed or qualified rather than waved through. Reproducibility metadata inventory is not a rerun; if claiming a rerun, actually run the experiment and compare outputs.
Act as a rigorous reviewer. Audit the manuscript and its evidence:
1. Every empirical claim must trace to a run ID.
2. Every citation must exist and support the sentence.
3. Abstract numbers must match the results tables and figures.
4. Baselines must be fair; limitations must be honest.
5. Check reproducibility: seeds, n, compute, code and artifact paths.
6. Check LaTeX compile logs or DOCX structure.

Write a review report to exports/review-report.md with severity-ranked findings. Then revise the manuscript using the paper-writing skill:
${documentIds.docx ? `- DOCX id: ${documentIds.docx}` : ''}
${documentIds.latex ? `- LaTeX id: ${documentIds.latex}` : ''}

Do not "fix" a missing result by inventing one. Finish with the remaining risks and the final artifact paths.`
  }
]

export const STAGE_ARTIFACTS: Record<string, string[]> = {
  literature: ['references/research-brief.md', 'references/evidence-matrix.md'],
  hypothesis: ['experiments/plan.md'],
  design: ['exports/design-check.md'],
  execute: ['exports/experiment-log.md'],
  analysis: ['exports/analysis.md', 'exports/data-audit.json', 'exports/statistical-analysis.json'],
  figures: ['exports/figure-evidence.md'],
  paper: ['exports/claims-evidence.md'],
  review: ['exports/review-report.md', 'exports/citation-audit.json', 'exports/reproducibility.json']
}

export interface StageHandoff {
  version: 1
  runId: string
  stepId: string
  stage: string
  status: 'ready'
  artifacts: string[]
  referenceIds: string[]
  experimentIds: string[]
  runIds: string[]
  figureIds: string[]
  documentIds: string[]
  blockers: string[]
}

export function stageHandoffPath(runId: string, stage: string): string {
  return `exports/pipeline/${runId}/${stage}.json`
}

// Resolve actual paths as well as lexical paths: a symlink outside the project is not evidence.
export function evidenceFile(root: string, file: string): string {
  const absolute = realpathSync(resolve(root, file))
  const rel = relative(realpathSync(root), absolute)
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`证据文件必须位于当前项目内：${file}`)
  }
  const emptyRunLog = /^experiments\/[^/]+\/runs\/[^/]+\/(?:stdout|stderr)\.txt$/.test(file.replaceAll('\\', '/'))
  if (!statSync(absolute).isFile() || (statSync(absolute).size === 0 && !emptyRunLog)) throw new Error(`证据文件为空或不是文件：${file}`)
  return absolute
}

export function validateStageHandoff(input: { root: string; runId: string; stepId: string; stage: string; startedAt: string }): { handoff: StageHandoff; hashes: Record<string, string> } {
  let path: string
  try { path = evidenceFile(input.root, stageHandoffPath(input.runId, input.stage)) }
  catch { throw new Error(`阶段未产生有效交接产物：${stageHandoffPath(input.runId, input.stage)}。请检查智能体是否实际调用原生工具并写入所需文件；空回复或文字声明不能完成阶段。`) }
  if (statSync(path).size > 1024 * 1024) throw new Error('阶段交接 JSON 不得超过 1 MB。')
  if (statSync(path).mtimeMs + 2000 < Date.parse(input.startedAt)) throw new Error('阶段交接记录早于本次执行，请重新核验后生成。')
  const data: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''))
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('阶段交接必须是 JSON 对象。')
  const handoff = data as StageHandoff
  if (handoff.version !== 1 || handoff.runId !== input.runId || handoff.stepId !== input.stepId || handoff.stage !== input.stage || handoff.status !== 'ready') {
    throw new Error('阶段交接的 version、runId、stepId、stage 或 status 不匹配。')
  }
  for (const key of ['artifacts', 'referenceIds', 'experimentIds', 'runIds', 'figureIds', 'documentIds', 'blockers'] as const) {
    if (!Array.isArray(handoff[key]) || handoff[key].some((value) => typeof value !== 'string' || !value.trim()) || handoff[key].length > 200) {
      throw new Error(`阶段交接字段 ${key} 必须是最多 200 个非空字符串的数组。`)
    }
  }
  if (handoff.blockers.length) throw new Error(`仍有未解决的阻塞：${handoff.blockers.join('；')}`)
  const required = STAGE_ARTIFACTS[input.stage]
  if (!required) throw new Error('未知阶段，不能验证证据。')
  for (const file of required) {
    if (!handoff.artifacts.includes(file)) throw new Error(`阶段交接缺少必需产物：${file}`)
  }
  const hashes: Record<string, string> = {}
  for (const file of handoff.artifacts) {
    if (isAbsolute(file)) throw new Error(`请使用项目相对路径：${file}`)
    const abs = evidenceFile(input.root, file)
    if (required.includes(file) && statSync(abs).size < 40) throw new Error(`必需产物内容不足：${file}`)
    hashes[file] = createHash('sha256').update(readFileSync(abs)).digest('hex')
  }
  return { handoff, hashes }
}

interface RunRow {
  id: string
  project_id: string
  title: string
  topic: string
  status: PipelineStatus
  current_stage: string
  auto_run: number
  formats_json: string
  chat_id: string
  config_json: string
  created_at: string
  updated_at: string
}

interface StepRow {
  id: string
  run_id: string
  project_id: string
  stage: string
  position: number
  status: PipelineStep['status']
  prompt: string
  output: string
  error: string
  started_at: string
  finished_at: string
}

function mapStep(row: StepRow): PipelineStep {
  return {
    id: row.id,
    runId: row.run_id,
    stage: row.stage,
    position: row.position,
    status: row.status,
    prompt: row.prompt,
    output: row.output,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  }
}

export class PipelineService {
  private activeRunId = ''
  private activeLoop: Promise<void> | undefined

  isRunning(): boolean {
    return Boolean(this.activeRunId)
  }

  private launch(runId: string): void {
    this.activeLoop = this.runLoop(runId)
  }

  async stop(): Promise<void> {
    const runId = this.activeRunId
    const loop = this.activeLoop
    try {
      if (runId && this.isRunRunning(runId)) {
        // Teardown interrupts work; only an explicit cancel makes the run terminal.
        const unfinished = this.db.get<StepRow>(
          "SELECT * FROM pipeline_steps WHERE run_id = ? AND status IN ('running', 'pending') ORDER BY position ASC LIMIT 1",
          runId
        )
        this.updateRunStatus(runId, { status: 'failed', currentStage: unfinished?.stage })
        if (unfinished) this.updateStep(unfinished.id, { status: 'failed', error: '应用关闭中断了执行。请检查已有产物后重试本阶段。', finishedAt: nowIso() })
        await this.agent.stop()
      }
    } finally {
      await loop
    }
  }

  private isRunRunning(runId: string): boolean {
    return this.db.get<RunRow>('SELECT * FROM pipeline_runs WHERE id = ?', runId)?.status === 'running'
  }

  constructor(
    private readonly db: Db,
    private readonly agent: AgentService,
    private readonly chats: ChatService,
    private readonly documents: DocumentService,
    private readonly projects: ProjectService,
    private readonly references: ReferenceService,
    private readonly settings: SettingsService
  ) {
    // No in-memory executor survives a service restart. Preserve artifacts but make interrupted work retryable.
    const timestamp = nowIso()
    this.db.run("UPDATE pipeline_steps SET status = 'failed', error = '应用重启中断了执行。请检查已有产物后重试本阶段。', finished_at = ? WHERE status = 'running'", timestamp)
    this.db.run("UPDATE pipeline_runs SET status = 'failed', updated_at = ? WHERE status = 'running'", timestamp)
  }

  stages(): PipelineStage[] {
    return STAGES.map(({ buildPrompt: _buildPrompt, ...stage }) => ({ ...stage, prompt: stage.description }))
  }

  get(projectId: string): PipelineSnapshot {
    const row = this.db.get<RunRow>(
      'SELECT * FROM pipeline_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1',
      projectId
    )
    return { stages: this.stages(), run: row ? this.mapRun(row) : null }
  }

  private mapRun(row: RunRow): PipelineRun {
    const steps = this.db
      .all<StepRow>('SELECT * FROM pipeline_steps WHERE run_id = ? ORDER BY position ASC', row.id)
      .map(mapStep)
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      topic: row.topic,
      status: row.status,
      currentStage: row.current_stage,
      autoRun: row.auto_run === 1,
      formats: parseJson<DocumentFormat[]>(row.formats_json, ['docx', 'latex']),
      chatId: row.chat_id,
      steps,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private updateRunStatus(runId: string, patch: { status?: PipelineStatus; currentStage?: string }): PipelineRun {
    const current = this.db.get<RunRow>('SELECT * FROM pipeline_runs WHERE id = ?', runId)
    if (!current) throw new Error('流水线不存在。')
    this.db.run(
      'UPDATE pipeline_runs SET status = ?, current_stage = ?, updated_at = ? WHERE id = ?',
      patch.status ?? current.status,
      patch.currentStage ?? current.current_stage,
      nowIso(),
      runId
    )
    const run = this.mapRun(this.db.get<RunRow>('SELECT * FROM pipeline_runs WHERE id = ?', runId)!)
    emitEvent({ type: 'pipeline-update', projectId: run.projectId, run })
    return run
  }

  private updateStep(stepId: string, patch: Partial<Pick<PipelineStep, 'status' | 'output' | 'error' | 'startedAt' | 'finishedAt'>>): void {
    const current = this.db.get<StepRow>('SELECT * FROM pipeline_steps WHERE id = ?', stepId)
    if (!current) throw new Error('流水线步骤不存在。')
    this.db.run(
      'UPDATE pipeline_steps SET status = ?, output = ?, error = ?, started_at = ?, finished_at = ? WHERE id = ?',
      patch.status ?? current.status,
      patch.output ?? current.output,
      patch.error ?? current.error,
      patch.startedAt ?? current.started_at,
      patch.finishedAt ?? current.finished_at,
      stepId
    )
    const run = this.db.get<RunRow>('SELECT * FROM pipeline_runs WHERE id = ?', current.run_id)
    if (run) emitEvent({ type: 'pipeline-update', projectId: run.project_id, run: this.mapRun(run) })
  }

  start(input: PipelineStartInput): PipelineRun {
    if (this.activeRunId || this.agent.isRunning()) throw new Error('已有智能体或流水线正在运行，请等待其完成。')
    const project = this.projects.get(input.projectId)
    const topic = input.topic.trim()
    if (!topic) throw new Error('请填写研究主题。')
    const existing = this.get(input.projectId).run
    if (existing && (existing.status === 'running' || existing.status === 'paused')) {
      throw new Error('当前项目已有进行中的流水线，请先继续或取消它。')
    }
    const settings = this.settings.get()
    const roleModels = normalizeAgentRoles(settings.agentRoleModels)
    const allRolesConfigured = AGENT_ROLES.every(role => roleModels[role.id])
    const fallback = allRolesConfigured ? roleModels.writing! : { providerId: input.providerId || settings.defaultProviderId, modelId: input.modelId || settings.defaultModelId }
    const selection = this.agent.validateSelection(fallback.providerId, fallback.modelId)
    for (const route of Object.values(roleModels)) this.agent.validateSelection(route.providerId, route.modelId)
    const chat = this.chats.create(
      project.id,
      selection.provider.id,
      selection.modelId,
      `流水线：${topic.slice(0, 24)}`
    )
    const roleChats: Record<string, string> = {}
    for (const role of AGENT_ROLES) {
      const route = roleModels[role.id]
      if (route) roleChats[role.id] = this.chats.create(project.id, route.providerId, route.modelId, `${role.label}：${topic.slice(0, 20)}`).id
    }
    const id = newId('pipe')
    const timestamp = nowIso()
    const formats = input.formats.length ? input.formats : (['docx', 'latex'] as DocumentFormat[])
    this.db.run(
      `INSERT INTO pipeline_runs (id, project_id, title, topic, status, current_stage, auto_run, formats_json, chat_id, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
      id,
      project.id,
      `研究流水线：${topic.slice(0, 60)}`,
      topic,
      STAGES[0]!.id,
      input.autoRun ? 1 : 0,
      JSON.stringify(formats),
      chat.id,
      JSON.stringify({ roleModels, roleChats }),
      timestamp,
      timestamp
    )
    for (const [index, stage] of STAGES.entries()) {
      this.db.run(
        `INSERT INTO pipeline_steps (id, run_id, project_id, stage, position, status, prompt, output, error, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, 'pending', '', '', '', '', '')`,
        newId('step'),
        id,
        project.id,
        stage.id,
        index
      )
    }
    const run = this.mapRun(this.db.get<RunRow>('SELECT * FROM pipeline_runs WHERE id = ?', id)!)
    emitEvent({ type: 'pipeline-update', projectId: project.id, run })
    this.launch(id)
    return run
  }

  projectIdForRun(runId: string): string {
    const row = this.db.get<{ project_id: string }>('SELECT project_id FROM pipeline_runs WHERE id = ?', runId)
    if (!row) throw new Error('流水线不存在。')
    return row.project_id
  }

  async continue(runId: string): Promise<PipelineRun> {
    if (this.activeRunId || this.agent.isRunning()) throw new Error('已有智能体或流水线正在运行。')
    const row = this.db.get<RunRow>('SELECT * FROM pipeline_runs WHERE id = ?', runId)
    if (!row) throw new Error('流水线不存在。')
    if (row.status === 'completed' || row.status === 'cancelled') throw new Error('流水线已结束，请重新规划。')
    // Retry failed/interrupted steps first; never silently skip them and complete later stages.
    this.db.run("UPDATE pipeline_steps SET status = 'pending' WHERE run_id = ? AND status IN ('failed', 'running')", runId)
    this.updateRunStatus(runId, { status: 'running' })
    this.launch(runId)
    return this.mapRun(this.db.get<RunRow>('SELECT * FROM pipeline_runs WHERE id = ?', runId)!)
  }

  private async runLoop(runId: string): Promise<void> {
    if (this.activeRunId) return
    this.activeRunId = runId
    try {
      for (;;) {
        const row = this.db.get<RunRow>('SELECT * FROM pipeline_runs WHERE id = ?', runId)
        if (!row || row.status !== 'running') return
        const pending = this.db.get<StepRow>(
          "SELECT * FROM pipeline_steps WHERE run_id = ? AND status = 'pending' ORDER BY position ASC LIMIT 1",
          runId
        )
        if (!pending) {
          const incomplete = this.db.get<{ id: string }>("SELECT id FROM pipeline_steps WHERE run_id = ? AND status <> 'completed' LIMIT 1", runId)
          this.updateRunStatus(runId, incomplete ? { status: 'failed' } : { status: 'completed', currentStage: '' })
          return
        }
        const stage = STAGES.find((item) => item.id === pending.stage)
        if (!stage) {
          this.updateStep(pending.id, { status: 'failed', error: '未知流水线阶段。', finishedAt: nowIso() })
          this.updateRunStatus(runId, { status: 'failed' })
          return
        }
        this.updateStep(pending.id, { status: 'running', startedAt: nowIso() })
        this.updateRunStatus(runId, { status: 'running', currentStage: stage.id })
        const previousSteps = this.db
          .all<StepRow>("SELECT * FROM pipeline_steps WHERE run_id = ? AND status = 'completed' ORDER BY position ASC", runId)
          .map((step) => `[${step.stage}]\n${truncate(step.output || '(no text output)', 3500)}`)
          .join('\n\n')
        if (!this.isRunRunning(runId)) return
        const documentIds = stage.id === 'paper' || stage.id === 'review'
          ? await this.ensurePaperDocuments(runId, row.project_id, row.topic, parseJson<DocumentFormat[]>(row.formats_json, ['docx', 'latex']))
          : {}
        if (!this.isRunRunning(runId)) return
        const attemptStartedAt = nowIso()
        const prompt = stage.buildPrompt({
          topic: row.topic,
          formats: parseJson<DocumentFormat[]>(row.formats_json, ['docx', 'latex']),
          previous: previousSteps,
          documentIds
        }) + this.handoffPrompt(runId, pending.id, stage.id) + `\n\nCURRENT EXECUTION ATTEMPT: ${attemptStartedAt}. Previous failed attempt: ${pending.error || '(none)'}. If files/handoff already exist, inspect and reuse valid research outputs, but you MUST rewrite the stage handoff via project_artifact_write during THIS execution after checking them. A previous attempt's handoff will be rejected even if content is identical. Do not merely summarize earlier completion. Include this execution timestamp in your final verification summary.`
        const startedAt = attemptStartedAt
        this.updateStep(pending.id, { status: 'running', output: '', error: '', startedAt })
        this.db.run('UPDATE pipeline_steps SET prompt = ? WHERE id = ?', prompt, pending.id)
        try {
          if (!this.isRunRunning(runId)) return
          const role = roleForStage(stage.id)
          const config = parseJson<{ roleModels?: AgentRoleModels; roleChats?: Record<string, string> }>(row.config_json, {})
          const route = config.roleModels?.[role]
          if (route) this.agent.validateSelection(route.providerId, route.modelId)
          const chatId = config.roleChats?.[role] || row.chat_id
          const rolePrompt = route ? `当前协作角色：${AGENT_ROLES.find(item => item.id === role)!.label}。你使用独立角色会话，按下面已有产物和交接摘要继续；不要假定其他角色的未提供内容，也不要覆盖其他角色的原始证据。\n\n` : ''
          await this.agent.send({ projectId: row.project_id, chatId, text: rolePrompt + prompt, ...(route ? { modelOverride: route } : {}) })
          if (!this.isRunRunning(runId)) return
          const finalResponse = await this.agent.waitForActive()
          if (!this.isRunRunning(runId)) return
          this.updateStep(pending.id, { output: finalResponse || '（智能体未返回文本。）' })
          const gate = this.verifyEvidence(row, { ...pending, started_at: startedAt })
          this.updateStep(pending.id, {
            status: 'completed',
            output: `${finalResponse || '（无文本输出；产物门禁已通过。）'}\n\n${gate}`,
            finishedAt: nowIso()
          })
        } catch (error) {
          if (!this.isRunRunning(runId)) return
          const message = error instanceof Error ? error.message : String(error)
          this.updateStep(pending.id, { status: 'failed', error: message, finishedAt: nowIso() })
          this.updateRunStatus(runId, { status: 'failed' })
          emitEvent({ type: 'notice', level: 'error', message: `流水线阶段「${stage.label}」失败：${message}` })
          return
        }
        const latest = this.db.get<RunRow>('SELECT * FROM pipeline_runs WHERE id = ?', runId)
        if (!latest || latest.status !== 'running') return
        const hasPending = this.db.get<{ id: string }>("SELECT id FROM pipeline_steps WHERE run_id = ? AND status = 'pending' LIMIT 1", runId)
        if (!hasPending) {
          this.updateRunStatus(runId, { status: 'completed', currentStage: '' })
          return
        }
        if (latest.auto_run !== 1) {
          this.updateRunStatus(runId, { status: 'paused' })
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 600))
      }
    } catch (error) {
      const row = this.db.get<RunRow>('SELECT * FROM pipeline_runs WHERE id = ?', runId)
      if (row?.status === 'running') {
        const message = error instanceof Error ? error.message : String(error)
        const current = this.db.get<StepRow>("SELECT * FROM pipeline_steps WHERE run_id = ? AND status = 'running'", runId)
        if (current) this.updateStep(current.id, { status: 'failed', error: message, finishedAt: nowIso() })
        this.updateRunStatus(runId, { status: 'failed' })
      }
    } finally {
      this.activeRunId = ''
    }
  }

  private handoffPrompt(runId: string, stepId: string, stage: string): string {
    const sample: StageHandoff = {
      version: 1, runId, stepId, stage, status: 'ready',
      artifacts: STAGE_ARTIFACTS[stage] ?? [], referenceIds: [], experimentIds: [], runIds: [], figureIds: [], documentIds: [], blockers: []
    }
    return `\n\nNATIVE EXECUTION CONTRACT\nUse only project-scoped mcp__rp_evidence__, mcp__rp_artifacts__, mcp__rp_writing__ capabilities for the pipeline. Do not call pwsh/bash, raw HTTP, generic write/edit or the research CLI; native tools do not depend on a shell. All writes, Crossref requests and Python runs require their individual desktop approval; never bypass denial. If a required server/tool or configured Python is unavailable, report a blocker instead. Read planning, source code, stdout and outputs with artifact_read. Write every Markdown/JSON stage deliverable and the final handoff with project_artifact_write({path,content}); it cannot write Python or run artifacts. Register all agent-authored study/analysis/audit code with experiment_create, execute with experiment_run. Actual result/audit JSON must originate in successful run outputs, never be invented as passed. Simulation outputs are actual computed results but not real-world measurements; disclose scope.\n\nARTIFACT GATE (enforced by the application, text alone never completes a stage)\nWrite ${stageHandoffPath(runId, stage)} using project_artifact_write after checking all deliverables. Schema:\n${JSON.stringify(sample, null, 2)}\nUse actual project IDs, not placeholders. Include every required artifact plus the actual source data files, code, metrics and figure/manuscript files relied upon, using project-relative paths. Literature requires verified local reference IDs; design requires registered experiment IDs and their code; execute and later stages require succeeded run IDs with numerical metrics and nonempty artifact files. Figures require native JSON/SVG/PPTX with non-demo provenance identifying a cited run and source artifact. Paper/review require the requested document IDs. JSON audit reports require version=1, status="passed", blockers=[]; analysis/review JSON must be byte-identical to a listed JSON file in a cited succeeded analysis/audit run directory, with that experiment ID and source code listed. Review reports explicitly require scope="mechanical", humanReviewRequired=true. A generated inventory is not a successful rerun. Do not mark ready when checks failed. List blockers and stop instead. On a retry re-read existing artifacts and regenerate the handoff; never claim old files are new results.\n`
  }

  private verifyEvidence(row: RunRow, step: StepRow): string {
    const root = this.projects.get(row.project_id).rootPath
    const { handoff, hashes } = validateStageHandoff({ root, runId: row.id, stepId: step.id, stage: step.stage, startedAt: step.started_at })
    const fail = (message: string): never => { throw new Error(`产物门禁未通过：${message}`) }
    const file = (path: string): string => {
      try { return evidenceFile(root, path) } catch { return fail(`文件缺失、为空或不在项目中：${path}`) }
    }
    const listed = (path: string): void => {
      const abs = file(path)
      if (!handoff.artifacts.some((item) => file(item) === abs)) fail(`交接清单未列出证据文件：${path}`)
    }
    for (const id of handoff.referenceIds) {
      if (!this.references.list(row.project_id).some((item) => item.id === id)) fail(`文献不在当前项目中：${id}`)
    }
    if (step.stage === 'literature' && !handoff.referenceIds.length) fail('至少需要一条真实的项目文献；缺少来源时不能通过调研阶段。')
    for (const id of handoff.experimentIds) {
      const experiment = this.db.get<{ entry_file: string }>('SELECT entry_file FROM experiments WHERE id = ? AND project_id = ?', id, row.project_id)
      if (!experiment) fail(`实验不在当前项目中：${id}`)
      listed(experiment!.entry_file)
    }
    if (step.stage === 'design' && !handoff.experimentIds.length) fail('实验设计必须提供已登记的实验及代码。')
    const needsRuns = ['execute', 'analysis', 'figures', 'paper', 'review'].includes(step.stage)
    if (needsRuns && !handoff.runIds.length) fail('至少需要一个已成功运行并有指标的 run ID。')
    const acceptedRuns = new Map<string, { experimentId: string; dir: string }>()
    for (const id of handoff.runIds) {
      const run = this.db.get<{ status: string; exit_code: number | null; artifact_dir: string; metrics_json: string; experiment_id: string }>(
        'SELECT status, exit_code, artifact_dir, metrics_json, experiment_id FROM experiment_runs WHERE id = ? AND project_id = ?', id, row.project_id
      )
      if (!run || run.status !== 'succeeded' || run.exit_code !== 0) fail(`run 不存在、未成功或退出码非零：${id}`)
      const metrics = parseJson<Record<string, unknown>>(run!.metrics_json, {})
      if (!Object.values(metrics).some((value) => typeof value === 'number' && Number.isFinite(value))) fail(`run 缺少可核验的数值指标：${id}`)
      if (!run!.artifact_dir) fail(`run 没有产物目录：${id}`)
      const dir = realpathSync(resolve(root, run!.artifact_dir))
      const artifacts = handoff.artifacts.filter((item) => {
        const rel = relative(dir, file(item))
        return rel && !rel.startsWith('..') && !isAbsolute(rel)
      })
      if (!artifacts.length) fail(`交接清单必须列出 run ${id} 目录内的实际产物。`)
      acceptedRuns.set(id, { experimentId: run!.experiment_id, dir })
    }
    for (const id of handoff.figureIds) {
      const figure = this.db.get<{ file_path: string; experiment_id: string; caption: string }>('SELECT file_path, experiment_id, caption FROM figures WHERE id = ? AND project_id = ?', id, row.project_id)
      if (!figure) fail(`图表不在当前项目中：${id}`)
      listed(figure!.file_path)
      if (!figure!.caption.trim()) fail(`图表缺少独立图注：${id}`)
      const source = join(dirname(file(figure!.file_path)), 'figure.json')
      const pptx = join(dirname(source), 'figure.pptx')
      listed(source)
      listed(pptx)
      const spec = validateFigureSpec(JSON.parse(readFileSync(file(source), 'utf8')))
      if (!['chart', 'diagram'].includes(spec.kind ?? '') || spec.provenance?.isDemo !== false) fail(`图表必须是非演示的结构化模型：${id}`)
      const sourceLabel = spec.provenance?.sourceLabel ?? ''
      const matchingRun = [...acceptedRuns].find(([runId, run]) => sourceLabel.includes(runId) && run.experimentId === figure!.experiment_id)
      if (!matchingRun) fail(`图表来源必须指向清单中同一实验的真实 run ID：${id}`)
      if (!handoff.artifacts.some((artifact) => {
        const rel = relative(matchingRun![1].dir, file(artifact))
        return rel && !rel.startsWith('..') && !isAbsolute(rel) && sourceLabel.includes(artifact)
      })) fail(`图表 sourceLabel 必须写明已列出的真实 run 产物相对路径：${id}`)
    }
    if (step.stage === 'figures' && !handoff.figureIds.length) fail('至少需要一份原生可编辑 JSON/SVG/PPTX 图表；旧版图片不满足此条件。')
    const documents = this.documents.list(row.project_id)
    for (const id of handoff.documentIds) {
      const document = documents.find((item) => item.id === id)
      if (!document || document.wordCount < 100) fail(`文稿不存在或仍是空模板：${id}`)
      listed(document!.relativePath)
    }
    if (step.stage === 'paper' || step.stage === 'review') {
      for (const format of parseJson<DocumentFormat[]>(row.formats_json, ['docx', 'latex'])) {
        if (!documents.some((doc) => doc.format === format && handoff.documentIds.includes(doc.id))) fail(`缺少 ${format} 文稿证据。`)
      }
    }
    for (const artifact of STAGE_ARTIFACTS[step.stage] ?? []) {
      if (!artifact.endsWith('.json')) continue
      const report = JSON.parse(readFileSync(file(artifact), 'utf8')) as { version?: number; status?: string; blockers?: unknown[]; scope?: string; humanReviewRequired?: boolean }
      if (report.version !== 1 || report.status !== 'passed' || !Array.isArray(report.blockers) || report.blockers.length) fail(`${artifact} 仍有阻塞或缺少通过标记。`)
      if (step.stage === 'analysis' || step.stage === 'review') {
        const emittedByRun = [...acceptedRuns.values()].some(run => handoff.experimentIds.includes(run.experimentId) && handoff.artifacts.some(source => {
          if (source === artifact || hashes[source] !== hashes[artifact] || !source.toLowerCase().endsWith('.json')) return false
          const rel = relative(run.dir, file(source))
          return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel))
        }))
        if (!emittedByRun) fail(`${artifact} 必须与已列出的成功分析/审计 run 内 JSON 产物逐字节一致，并列出该实验代码；不得手填通过报告。`)
        if (step.stage === 'review' && (report.scope !== 'mechanical' || report.humanReviewRequired !== true)) fail(`${artifact} 必须明确 scope=mechanical 和 humanReviewRequired=true；机械检查不能冒充人工科学/全文支持审查。`)
      }
    }
    const receiptPath = `exports/pipeline/${row.id}/${step.stage}.verification.json`
    const target = resolve(root, receiptPath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify({ version: 1, runId: row.id, stepId: step.id, stage: step.stage, verifiedAt: nowIso(), hashes, runIds: handoff.runIds, figureIds: handoff.figureIds, limitation: 'Structural checks only; scientific validity and citation support require human review.' }, null, 2), 'utf8')
    return `产物门禁通过：核验 ${Object.keys(hashes).length} 个文件并保存 SHA-256。记录：${receiptPath}。这不等于人工确认科学结论。`
  }

  private async ensurePaperDocuments(runId: string, projectId: string, topic: string, formats: DocumentFormat[]): Promise<Record<string, string>> {
    const existing = this.documents.list(projectId)
    const find = (title: string) => existing.find((doc) => doc.title === title)?.id ?? ''
    const result: Record<string, string> = {}
    if (!this.isRunRunning(runId)) return result
    if (formats.includes('docx') || formats.length === 0) {
      result.docx = find(`${topic} — Manuscript`) || (await this.documents.create({
        projectId,
        title: `${topic} — Manuscript`,
        format: 'docx'
      })).id
    }
    if (!this.isRunRunning(runId)) return result
    if (formats.includes('latex') || formats.length === 0) {
      result.latex = find(`${topic} — LaTeX`) || (await this.documents.create({
        projectId,
        title: `${topic} — LaTeX`,
        format: 'latex'
      })).id
    }
    if (!this.isRunRunning(runId)) return result
    try {
      this.references.writeBibtexFile(projectId)
    } catch {
      // A missing or unwritable bibliography must not block manuscript generation.
    }
    return result
  }

  async cancel(runId: string): Promise<PipelineRun> {
    const row = this.db.get<RunRow>('SELECT * FROM pipeline_runs WHERE id = ?', runId)
    if (!row) throw new Error('流水线不存在。')
    this.updateRunStatus(runId, { status: 'cancelled' })
    const running = this.db.get<StepRow>("SELECT * FROM pipeline_steps WHERE run_id = ? AND status = 'running'", runId)
    if (running) this.updateStep(running.id, { status: 'failed', error: '用户取消。', finishedAt: nowIso() })
    if (this.activeRunId === runId) await this.agent.stop()
    return this.mapRun(this.db.get<RunRow>('SELECT * FROM pipeline_runs WHERE id = ?', runId)!)
  }

  reset(projectId: string): PipelineSnapshot {
    const row = this.db.get<RunRow>('SELECT id, status FROM pipeline_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1', projectId)
    if (row?.status === 'running') throw new Error('流水线正在运行，请先取消。')
    this.db.run('DELETE FROM pipeline_runs WHERE project_id = ?', projectId)
    return this.get(projectId)
  }
}
