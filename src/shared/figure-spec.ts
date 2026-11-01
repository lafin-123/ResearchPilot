/** Portable, bounded figure source. No HTML, SVG, Python, URLs or file paths are executable here. */
export interface FigureProvenance {
  /** Citation, dataset identifier, run/artifact path, or an explicit description of a proposed method. */
  sourceLabel: string
  /** Demonstration data must never be represented as research evidence. */
  isDemo: boolean
}

interface FigureBase {
  version: 1
  title: string
  provenance: FigureProvenance
}

export interface FigureSeries {
  name: string
  values: number[]
}

export interface ChartFigureSpec extends FigureBase {
  kind: 'chart'
  chartType: 'bar' | 'line' | 'scatter'
  xLabel: string
  yLabel: string
  /** Required for bar/line; line categories are equally spaced, not a continuous x axis. */
  labels?: string[]
  /** Required for scatter. Shared numeric x coordinates for every series. */
  xValues?: number[]
  series: FigureSeries[]
}

export interface FigureNode {
  id: string
  label: string
  shape: 'rect' | 'roundRect' | 'ellipse' | 'diamond'
  /** Coordinates in a 1000 × 440 content canvas, excluding the title/source. */
  x: number
  y: number
  width: number
  height: number
}

export interface FigureEdge {
  id: string
  from: string
  to: string
  label?: string
}

export interface DiagramFigureSpec extends FigureBase {
  kind: 'diagram'
  nodes: FigureNode[]
  edges: FigureEdge[]
}

export type FigureSpec = ChartFigureSpec | DiagramFigureSpec
export interface FigureStructuredInput {
  projectId: string
  name?: string
  caption?: string
  experimentId?: string
  spec: FigureSpec
}
export type FigureArtifact = 'preview' | 'source' | 'pptx'
export interface FigureReadResult { base64: string; fileName: string; mimeType: string }

export const FIGURE_LIMITS = { series: 3, rows: 200, nodes: 40, edges: 80, sourceBytes: 256_000, width: 1000, height: 440 } as const
// Fixed categorical order, validated all-pairs on white. Third hue uses table + direct-label contrast relief.
export const FIGURE_COLORS = ['2A78D6', 'EB6834', '1BAF7A'] as const

function fail(path: string, reason: string): never { throw new Error(`FigureSpec ${path}: ${reason}`) }
function record(value: unknown, path: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object')
  const obj = value as Record<string, unknown>
  for (const key of Object.keys(obj)) if (!keys.includes(key)) fail(`${path}.${key}`, 'unknown field')
  return obj
}
function text(value: unknown, path: string, max: number, optional = false, multiline = false): string {
  if (typeof value !== 'string') fail(path, 'expected text')
  const result = value.trim()
  if ((!optional && !result) || result.length > max) fail(path, `expected ${optional ? '0' : '1'}–${max} characters`)
  if ((!multiline && /[\r\n\t]/.test(result)) || (multiline && /\t/.test(result))) fail(path, 'line breaks/tabs are only supported in node labels')
  // XML 1.0 control characters and lone surrogates are not valid in SVG/OOXML.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/u.test(result) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(result)) fail(path, 'invalid text characters')
  return result
}
function number(value: unknown, path: string, min = -1e12, max = 1e12): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path, `expected a finite number in [${min}, ${max}]`)
  return value
}
function list(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(path, `expected ${min}–${max} items`)
  return value
}
function identifier(value: unknown, path: string): string {
  const result = text(value, path, 40)
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(result)) fail(path, 'use a letter followed by letters, numbers, _ or -')
  return result
}
function unique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, 'duplicate identifiers or names')
}

/** Wrap plain text deterministically, including CJK. Shared by SVG and PowerPoint. */
export function wrapFigureText(value: string, width: number, fontSize = 20): string[] {
  const max = Math.max(1, width / (fontSize * 0.57))
  const lines: string[] = []
  for (const paragraph of value.split(/\r?\n/)) {
    let line = ''; let units = 0
    for (const char of paragraph) {
      const step = /[^\x00-\xff]/.test(char) ? 1.8 : 1
      if (units + step > max && line) { lines.push(line.trim()); line = ''; units = 0 }
      line += char; units += step
    }
    lines.push(line.trim())
  }
  return lines
}

/** Returns a fresh canonical value; never trusts IPC/bridge TypeScript annotations. */
export function validateFigureSpec(value: unknown): FigureSpec {
  const obj = record(value, '$', ['version', 'kind', 'title', 'provenance', 'chartType', 'xLabel', 'yLabel', 'labels', 'xValues', 'series', 'nodes', 'edges'])
  if (obj.version !== 1) fail('version', 'only version 1 is supported')
  const title = text(obj.title, 'title', 100)
  if (wrapFigureText(title, 1080, 34).length > 2) fail('title', 'title must fit two lines; shorten the title')
  const p = record(obj.provenance, 'provenance', ['sourceLabel', 'isDemo'])
  if (typeof p.isDemo !== 'boolean') fail('provenance.isDemo', 'an explicit boolean is required')
  const provenance = { sourceLabel: text(p.sourceLabel, 'provenance.sourceLabel', 240), isDemo: p.isDemo }
  if (obj.kind === 'chart') {
    if ('nodes' in obj || 'edges' in obj) fail('chart', 'diagram fields are not allowed')
    if (!['bar', 'line', 'scatter'].includes(String(obj.chartType))) fail('chartType', 'supported: bar, line, scatter')
    const chartType = obj.chartType as ChartFigureSpec['chartType']
    const xLabel = text(obj.xLabel, 'xLabel', 80, true)
    const yLabel = text(obj.yLabel, 'yLabel', 80, true)
    let labels: string[] | undefined; let xValues: number[] | undefined
    if (chartType === 'scatter') {
      if ('labels' in obj) fail('labels', 'scatter uses numeric xValues, not category labels')
      xValues = list(obj.xValues, 'xValues', 2, FIGURE_LIMITS.rows).map((v, i) => number(v, `xValues[${i}]`))
    } else {
      if ('xValues' in obj) fail('xValues', 'bar/line use equally spaced category labels; choose scatter for numeric x spacing')
      labels = list(obj.labels, 'labels', 2, FIGURE_LIMITS.rows).map((v, i) => text(v, `labels[${i}]`, 60))
      unique(labels, 'labels')
    }
    const size = (labels ?? xValues)!.length
    const series = list(obj.series, 'series', 1, FIGURE_LIMITS.series).map((v, i) => {
      const s = record(v, `series[${i}]`, ['name', 'values'])
      return { name: text(s.name, `series[${i}].name`, 48), values: list(s.values, `series[${i}].values`, size, size).map((n, j) => number(n, `series[${i}].values[${j}]`)) }
    })
    unique(series.map(s => s.name), 'series')
    return { version: 1, kind: 'chart', title, provenance, chartType, xLabel, yLabel, ...(labels ? { labels } : { xValues }), series }
  }
  if (obj.kind === 'diagram') {
    for (const key of ['chartType', 'xLabel', 'yLabel', 'labels', 'xValues', 'series']) if (key in obj) fail(key, 'chart fields are not allowed in a diagram')
    const nodes = list(obj.nodes, 'nodes', 1, FIGURE_LIMITS.nodes).map((v, i): FigureNode => {
      const n = record(v, `nodes[${i}]`, ['id', 'label', 'shape', 'x', 'y', 'width', 'height'])
      const id = identifier(n.id, `nodes[${i}].id`)
      const label = text(n.label, `nodes[${i}].label`, 120, false, true)
      if (!['rect', 'roundRect', 'ellipse', 'diamond'].includes(String(n.shape))) fail(`nodes[${i}].shape`, 'unsupported shape')
      const shape = n.shape as FigureNode['shape']
      const x = number(n.x, `nodes[${i}].x`, 0, FIGURE_LIMITS.width)
      const y = number(n.y, `nodes[${i}].y`, 0, FIGURE_LIMITS.height)
      const width = number(n.width, `nodes[${i}].width`, 80, 600)
      const height = number(n.height, `nodes[${i}].height`, 50, 300)
      if (x + width > FIGURE_LIMITS.width || y + height > FIGURE_LIMITS.height) fail(`nodes[${i}]`, 'node extends beyond 1000 × 440 canvas')
      const inset = shape === 'diamond' ? 0.5 : shape === 'ellipse' ? 0.7 : 1
      if (wrapFigureText(label, width * inset - 20).length * 24 > height * inset - 12) fail(`nodes[${i}].label`, 'text does not fit; enlarge this node or shorten its label')
      return { id, label, shape, x, y, width, height }
    })
    unique(nodes.map(n => n.id), 'nodes')
    const ids = new Set(nodes.map(n => n.id))
    const edges = list(obj.edges, 'edges', 0, FIGURE_LIMITS.edges).map((v, i): FigureEdge => {
      const e = record(v, `edges[${i}]`, ['id', 'from', 'to', 'label'])
      const id = identifier(e.id, `edges[${i}].id`)
      const from = identifier(e.from, `edges[${i}].from`); const to = identifier(e.to, `edges[${i}].to`)
      if (!ids.has(from) || !ids.has(to)) fail(`edges[${i}]`, 'edge endpoints must name existing nodes')
      if (from === to) fail(`edges[${i}]`, 'self edges are not supported')
      return { id, from, to, ...(e.label === undefined ? {} : { label: text(e.label, `edges[${i}].label`, 40, true) }) }
    })
    unique(edges.map(e => e.id), 'edges')
    return { version: 1, kind: 'diagram', title, provenance, nodes, edges }
  }
  return fail('kind', 'supported: chart, diagram')
}

export function figureSourceLabel(spec: FigureSpec): string {
  return `${spec.provenance.isDemo ? 'DEMO / 示例 — NOT EVIDENCE / 非研究证据 · ' : 'Source / 来源: '}${spec.provenance.sourceLabel}`
}
