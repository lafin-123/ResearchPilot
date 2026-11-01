import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Project } from '@shared/types'
import type { Db } from '../lib/db'
import { ensureDir, relativePath } from '../lib/paths'

interface ExperimentRow {
  id: string
  name: string
  status: string
  last_run_id: string
}

interface RunRow {
  id: string
  experiment_id: string
  status: string
  command: string
  started_at: string
  finished_at: string
  metrics_json: string
  artifact_dir: string
}

interface FigureRow {
  id: string
  experiment_id: string
  name: string
  caption: string
  file_path: string
}

interface DocumentRow {
  title: string
  format: string
  relative_path: string
  word_count: number
}

interface ReferenceRow {
  title: string
  doi: string
  year: string
}

export interface EvidenceReportResult {
  path: string
  relativePath: string
  warnings: number
}

function stripRoot(path: string, root: string): string {
  return relativePath(root, path)
}

export class EvidenceService {
  constructor(private readonly db: Db) {}

  generate(project: Project): EvidenceReportResult {
    const experiments = this.db.all<ExperimentRow>(
      'SELECT id, name, status, last_run_id FROM experiments WHERE project_id = ? ORDER BY updated_at DESC',
      project.id
    )
    const runs = this.db.all<RunRow>(
      'SELECT id, experiment_id, status, command, started_at, finished_at, metrics_json, artifact_dir FROM experiment_runs WHERE project_id = ? ORDER BY started_at DESC',
      project.id
    )
    const figures = this.db.all<FigureRow>(
      'SELECT id, experiment_id, name, caption, file_path FROM figures WHERE project_id = ? ORDER BY created_at DESC',
      project.id
    )
    const documents = this.db.all<DocumentRow>(
      'SELECT title, format, relative_path, word_count FROM documents WHERE project_id = ? ORDER BY position ASC',
      project.id
    )
    const references = this.db.all<ReferenceRow>(
      "SELECT title, doi, year FROM reference_items WHERE project_id = ? AND doi <> '' ORDER BY updated_at DESC LIMIT 30",
      project.id
    )

    const warnings: string[] = []
    const runsByExperiment = new Map<string, RunRow[]>()
    for (const run of runs) {
      const list = runsByExperiment.get(run.experiment_id) ?? []
      list.push(run)
      runsByExperiment.set(run.experiment_id, list)
    }

    const lines: string[] = [
      `# 证据追溯报告：${project.name}`,
      '',
      `- 生成时间：${new Date().toISOString()}`,
      `- 项目工作区：\`${project.rootPath}\``,
      `- 实验：${experiments.length} 个，运行：${runs.length} 次`,
      `- 图表：${figures.length} 张，文稿：${documents.length} 份，带 DOI 的文献：${references.length} 条`,
      '',
      '## 实验与运行',
      ''
    ]

    if (experiments.length === 0) lines.push('_没有实验记录。_', '')
    if (experiments.length === 0) warnings.push('项目中还没有实验记录，任何论文结论都缺少实验支撑。')

    for (const experiment of experiments) {
      const experimentRuns = runsByExperiment.get(experiment.id) ?? []
      lines.push(`### ${experiment.name}`, '', `- 实验 ID：\`${experiment.id}\``, `- 当前状态：${experiment.status}`, `- 运行次数：${experimentRuns.length}`, '')
      if (experimentRuns.length === 0) warnings.push(`实验「${experiment.name}」还没有运行记录。`)
      for (const run of experimentRuns.slice(0, 5)) {
        const metrics = (() => {
          try {
            const parsed = JSON.parse(run.metrics_json) as Record<string, unknown>
            return Object.keys(parsed).length > 0 ? JSON.stringify(parsed, null, 2) : ''
          } catch {
            return ''
          }
        })()
        lines.push(
          `#### Run \`${run.id}\``,
          '',
          `- 状态：${run.status}`,
          `- 时间：${run.started_at} → ${run.finished_at || '未结束'}`,
          `- 命令：\`${run.command || '—'}\``,
          `- 产物：\`${run.artifact_dir ? stripRoot(run.artifact_dir, project.rootPath) : '—'}\``
        )
        if (metrics) {
          lines.push('', '```json', metrics, '```')
        } else {
          lines.push('- 指标：**缺失**')
          warnings.push(`Run ${run.id} 没有 metrics 指标。`)
        }
        if (run.status === 'failed') warnings.push(`Run ${run.id} 执行失败，相关结论不能直接使用。`)
        lines.push('')
      }
      if (experimentRuns.length > 5) lines.push(`_其余 ${experimentRuns.length - 5} 次运行未展开。_`, '')
    }

    lines.push('## 图表', '')
    if (figures.length === 0) lines.push('_没有图表。_', '')
    for (const figure of figures) {
      lines.push(`- **${figure.name}** — \`${stripRoot(figure.file_path, project.rootPath)}\`${figure.experiment_id ? `（实验 \`${figure.experiment_id}\`）` : ''}`)
      if (!figure.experiment_id) warnings.push(`图表「${figure.name}」没有关联到任何实验 run。`)
    }
    lines.push('')

    lines.push('## 文稿', '')
    if (documents.length === 0) lines.push('_没有文稿。_', '')
    for (const document of documents) {
      lines.push(`- **${document.title}**（${document.format.toUpperCase()}，${document.word_count} 词）— \`${document.relative_path}\``)
    }
    if (documents.length > 0 && runs.length === 0) warnings.push('已有文稿，但项目中没有任何实验运行记录。')
    lines.push('')

    lines.push('## 文献 DOI 索引', '')
    if (references.length === 0) lines.push('_文献库中没有带 DOI 的条目。_', '')
    for (const reference of references) {
      lines.push(`- ${reference.title}${reference.year ? ` (${reference.year})` : ''} — \`${reference.doi}\``)
    }
    lines.push('')

    lines.push('## 追溯性检查', '')
    if (warnings.length === 0) {
      lines.push('- [x] 未发现明显的产物断链。')
    } else {
      for (const warning of warnings) lines.push(`- [ ] ${warning}`)
    }
    lines.push('', '> 本报告只能验证产物之间的结构关系，无法自动判断论文中的每个数字是否都来自对应 run。送审前仍需人工核对。', '')

    const exportsDir = ensureDir(join(project.rootPath, 'exports'))
    const target = join(exportsDir, 'evidence-report.md')
    writeFileSync(target, lines.join('\n'), 'utf8')
    return { path: target, relativePath: relativePath(project.rootPath, target), warnings: warnings.length }
  }
}
