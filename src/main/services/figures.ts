import { spawn, spawnSync } from 'node:child_process'
import { existsSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, relative } from 'node:path'
import type { Figure, FigureRenderInput } from '@shared/types'
import { FIGURE_LIMITS, validateFigureSpec, type FigureArtifact, type FigureReadResult, type FigureSpec, type FigureStructuredInput } from '../../shared/figure-spec'
import { figureToSvg } from '../../shared/lib/figure-layout'
import { ensureFigureDir, figurePath, readFigureFile } from '../lib/figure-files'
import { figureToPptx } from '../lib/figure-pptx'
import type { Db } from '../lib/db'
import { emitEvent } from '../lib/events'
import { newId, nowIso, truncate } from '../lib/util'
import type { SettingsService } from './settings'

interface FigureRow {
  id: string
  project_id: string
  experiment_id: string
  name: string
  caption: string
  file_path: string
  format: string
  created_at: string
}

function mapFigure(row: FigureRow): Figure {
  return {
    id: row.id,
    projectId: row.project_id,
    experimentId: row.experiment_id,
    name: row.name,
    caption: row.caption,
    filePath: row.file_path,
    format: row.format,
    createdAt: row.created_at,
    modelKind: 'raster'
  }
}

const RUNNER = `import os
import runpy
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

code_path = sys.argv[1]
target = os.environ["RESEARCHPILOT_FIGURE_PATH"]
runpy.run_path(code_path, run_name="__main__")

if not os.path.exists(target):
    figures = plt.get_fignums()
    if not figures:
        raise SystemExit("绘图脚本没有生成图形，也没有保存到 RESEARCHPILOT_FIGURE_PATH。")
    for index, number in enumerate(figures):
        figure = plt.figure(number)
        figure.savefig(target, dpi=300, bbox_inches="tight", facecolor="white")
print("RESEARCHPILOT_FIGURE:" + target)
`

export class FigureService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService
  ) {}

  private projectRoot(projectId: string): string {
    const row = this.db.get<{ root_path: string }>('SELECT root_path FROM projects WHERE id = ?', projectId)
    if (!row) throw new Error('项目不存在。')
    return row.root_path
  }

  private enrich(row: FigureRow): Figure {
    const figure = mapFigure(row)
    if (row.format !== 'svg') return figure
    const root = this.projectRoot(row.project_id)
    const sourcePath = `${dirname(row.file_path).replaceAll('\\', '/')}/figure.json`
    // Only generated native bundles are editable. Corrupt/legacy files do not become models.
    try {
      const spec = validateFigureSpec(JSON.parse(readFigureFile(root, sourcePath, FIGURE_LIMITS.sourceBytes).toString('utf8')))
      return { ...figure, modelKind: spec.kind, sourcePath, pptxPath: `${dirname(row.file_path).replaceAll('\\', '/')}/figure.pptx`, provenance: spec.provenance, updatedAt: statSync(figurePath(root, sourcePath)).mtime.toISOString() }
    } catch { return figure }
  }

  list(projectId: string): Figure[] {
    this.projectRoot(projectId)
    return this.db.all<FigureRow>('SELECT * FROM figures WHERE project_id = ? ORDER BY created_at DESC', projectId).map(row => this.enrich(row))
  }

  get(projectId: string, id: string): Figure {
    const row = this.db.get<FigureRow>('SELECT * FROM figures WHERE id = ? AND project_id = ?', id, projectId)
    if (!row) throw new Error('图表不存在。')
    return this.enrich(row)
  }

  private artifactPath(figure: Figure, artifact: FigureArtifact): string {
    if (!['preview', 'source', 'pptx'].includes(artifact)) throw new Error('不支持的图表文件类型。')
    const path = artifact === 'source' ? figure.sourcePath : artifact === 'pptx' ? figure.pptxPath : figure.filePath
    if (!path) throw new Error('此图为 Python 栅格图，无结构化源模型或可编辑 PowerPoint。')
    return path
  }

  read(projectId: string, id: string, artifact: FigureArtifact = 'preview'): FigureReadResult {
    const figure = this.get(projectId, id)
    const path = this.artifactPath(figure, artifact)
    const mimeTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    const mimeType = mimeTypes[extname(path).toLowerCase()]
    if (!mimeType) throw new Error('不支持的图表文件类型。')
    // Regenerate SVG from the validated model: edited-on-disk SVG cannot inject active content.
    const bytes = artifact === 'preview' && figure.modelKind !== 'raster'
      ? Buffer.from(figureToSvg(this.getStructured(projectId, id)))
      : readFigureFile(this.projectRoot(projectId), path)
    if (mimeType === 'image/svg+xml' && figure.modelKind === 'raster') throw new Error('无法预览没有有效结构化源的 SVG。')
    return { base64: bytes.toString('base64'), fileName: basename(path), mimeType }
  }

  async open(projectId: string, id: string, artifact: FigureArtifact = 'preview'): Promise<void> {
    const figure = this.get(projectId, id)
    const abs = figurePath(this.projectRoot(projectId), this.artifactPath(figure, artifact))
    if (!existsSync(abs)) throw new Error('图表文件不存在。')
    const { shell } = await import('electron')
    shell.showItemInFolder(abs)
  }

  delete(projectId: string, id: string): void {
    const figure = this.get(projectId, id)
    const root = this.projectRoot(projectId)
    const abs = figurePath(root, figure.filePath)
    if (existsSync(abs)) {
      const trash = `.research/trash/${newId('deleted')}`
      ensureFigureDir(root, trash)
      // Keep immutable source revisions; move current preview to recoverable trash.
      renameSync(abs, figurePath(root, `${trash}/${basename(abs)}`))
    }
    this.db.run('DELETE FROM figures WHERE id = ? AND project_id = ?', id, projectId)
  }

  getStructured(projectId: string, id: string): FigureSpec {
    const figure = this.get(projectId, id)
    if (!figure.sourcePath) throw new Error('此图没有结构化可编辑模型。')
    return validateFigureSpec(JSON.parse(readFigureFile(this.projectRoot(projectId), figure.sourcePath, FIGURE_LIMITS.sourceBytes).toString('utf8')))
  }

  private async writeStructured(root: string, id: string, spec: FigureSpec): Promise<string> {
    const json = `${JSON.stringify(spec, null, 2)}\n`
    if (Buffer.byteLength(json, 'utf8') > FIGURE_LIMITS.sourceBytes) throw new Error('结构化图表源超过大小限制。')
    const pptx = await figureToPptx(spec)
    // Build an immutable revision completely before the database points to it. A failed
    // write/save cannot mix old JSON with new SVG/PPTX, even with concurrent saves.
    const folder = `figures/${id}/revisions/${newId('rev')}`
    ensureFigureDir(root, folder)
    writeFileSync(figurePath(root, `${folder}/figure.json`), json, { encoding: 'utf8', flag: 'wx' })
    writeFileSync(figurePath(root, `${folder}/figure.svg`), figureToSvg(spec), { encoding: 'utf8', flag: 'wx' })
    writeFileSync(figurePath(root, `${folder}/figure.pptx`), pptx, { flag: 'wx' })
    return `${folder}/figure.svg`
  }

  async createStructured(input: FigureStructuredInput): Promise<Figure> {
    const root = this.projectRoot(input.projectId)
    const spec = validateFigureSpec(input.spec)
    const name = input.name?.trim() || spec.title
    if (name.length > 160 || (input.caption?.length ?? 0) > 2000) throw new Error('图表名称或图注过长。')
    if (input.experimentId && !this.db.get('SELECT id FROM experiments WHERE id = ? AND project_id = ?', input.experimentId, input.projectId)) throw new Error('实验不属于此项目。')
    const id = newId('fig')
    const path = await this.writeStructured(root, id, spec)
    this.db.run('INSERT INTO figures (id, project_id, experiment_id, name, caption, file_path, format, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, input.projectId, input.experimentId ?? '', name, input.caption ?? '', path, 'svg', nowIso())
    const figure = this.get(input.projectId, id)
    emitEvent({ type: 'figure-created', projectId: input.projectId, figure })
    return figure
  }

  async saveStructured(projectId: string, id: string, input: FigureSpec): Promise<Figure> {
    const figure = this.get(projectId, id)
    if (!figure.sourcePath) throw new Error('栅格图不能转换为可编辑模型；请新建结构化图表。')
    const spec = validateFigureSpec(input)
    const path = await this.writeStructured(this.projectRoot(projectId), newId('fig'), spec)
    // The ID is never used as a path segment; both caller IDs and DB paths are untrusted.
    this.get(projectId, id) // reject if removed while export was being built
    this.db.run('UPDATE figures SET file_path = ?, name = ? WHERE id = ? AND project_id = ?', path, spec.title, id, projectId)
    const saved = this.get(projectId, id)
    emitEvent({ type: 'figure-created', projectId, figure: saved })
    return saved
  }

  async exportPptx(projectId: string, id: string): Promise<Figure> {
    const figure = this.get(projectId, id)
    if (!figure.sourcePath || !figure.pptxPath) throw new Error('此图没有结构化可编辑模型。')
    // Every successful save already built the corresponding PPT. Downloading never
    // renames/revises a figure; save again if its PPT was removed outside the app.
    readFigureFile(this.projectRoot(projectId), figure.pptxPath)
    return figure
  }

  async render(input: FigureRenderInput, options: { timeoutMs?: number } = {}): Promise<Figure> {
    const projectId = input.projectId
    const root = this.projectRoot(projectId)
    if (typeof input.code !== 'string' || !input.code.trim() || input.code.length > 500_000) throw new Error('绘图脚本不能为空或超过大小限制。')
    const folder = `figures/${newId('raster')}`
    const dir = ensureFigureDir(root, folder)
    const codePath = figurePath(root, `${folder}/plot.py`)
    const runnerPath = figurePath(root, `${folder}/render.py`)
    const outputPath = figurePath(root, `${folder}/figure.png`)
    writeFileSync(codePath, input.code, { encoding: 'utf8', flag: 'wx' })
    writeFileSync(runnerPath, RUNNER, { encoding: 'utf8', flag: 'wx' })

    const { detectPackages, resolvePythonLaunch } = await import('./experiment-runner')
    const detected = detectPackages(input.code)
    const launch = resolvePythonLaunch(this.settings, [...new Set(['matplotlib', ...detected])])
    const args = [...launch.prefixArgs, runnerPath, codePath]
    const env = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      MPLBACKEND: 'Agg',
      RESEARCHPILOT_FIGURE_PATH: outputPath,
      RESEARCHPILOT_FIGURE_DIR: dir,
      RESEARCHPILOT_PROJECT_ROOT: root
    }

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(launch.command, args, { cwd: dir, env, windowsHide: true })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (code: number | null): void => {
        if (settled) return
        settled = true
        resolve({ code, stdout, stderr })
      }
      const timer = setTimeout(() => {
        stderr += '\nResearchPilot: 绘图超时，已终止。\n'
        if (child.pid && process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        else child.kill('SIGKILL')
        finish(-1)
      }, options.timeoutMs ?? 600_000)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = truncate(stdout + chunk.toString('utf8'), 200_000)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = truncate(stderr + chunk.toString('utf8'), 200_000)
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        stderr += `\nResearchPilot: 无法启动 Python：${error.message}\n`
        finish(-1)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        finish(code)
      })
    })

    if (result.code !== 0 || !existsSync(outputPath)) {
      throw new Error(`绘图失败（退出码 ${result.code ?? 'unknown'}）\n${result.stdout}\n${result.stderr}`.trim())
    }

    const id = newId('fig')
    const createdAt = nowIso()
    const bytes = readFigureFile(root, `${folder}/figure.png`)
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('绘图脚本必须输出有效的 PNG 栅格图。')
    const relativeFilePath = relative(root, outputPath).replaceAll('\\', '/')
    this.db.run(
      'INSERT INTO figures (id, project_id, experiment_id, name, caption, file_path, format, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      projectId,
      input.experimentId ?? '',
      input.name.trim() || '未命名图表',
      input.caption ?? '',
      relativeFilePath,
      'png',
      createdAt
    )
    const figure = this.get(projectId, id)
    emitEvent({ type: 'figure-created', projectId, figure })
    return figure
  }
}
