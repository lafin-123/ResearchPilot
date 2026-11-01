import { FIGURE_COLORS, figureSourceLabel, wrapFigureText, type FigureNode, type FigureSpec } from '../figure-spec'

export const FIGURE_CANVAS = { width: 1200, height: 720, left: 100, top: 130 } as const
export const FIGURE_INK = { primary: '182A42', secondary: '53657A', grid: 'DFE6EF', surface: 'FFFFFF', node: 'F4F7FB' } as const
export type FigureMark =
  | { type: 'text'; x: number; y: number; text: string; size: number; anchor?: 'start' | 'middle' | 'end'; bold?: boolean; rotate?: number }
  | { type: 'rect'; x: number; y: number; width: number; height: number; fill: string; stroke?: string; radius?: number; tip?: string }
  | { type: 'ellipse'; x: number; y: number; rx: number; ry: number; fill: string; stroke?: string; tip?: string }
  | { type: 'line'; x: number; y: number; x2: number; y2: number; color: string; width: number; arrow?: boolean; dash?: boolean }
  | { type: 'path'; d: string; fill: string; stroke?: string; width?: number; tip?: string }

export function edgeEndpoints(from: FigureNode, to: FigureNode): [number, number, number, number] {
  const fx = from.x + from.width / 2; const fy = from.y + from.height / 2
  const tx = to.x + to.width / 2; const ty = to.y + to.height / 2
  const dx = tx - fx; const dy = ty - fy
  const bound = (node: FigureNode): number => {
    const xx = Math.abs(dx) / (node.width / 2); const yy = Math.abs(dy) / (node.height / 2)
    const denominator = node.shape === 'ellipse' ? Math.hypot(xx, yy) : node.shape === 'diamond' ? xx + yy : Math.max(xx, yy)
    return denominator ? 1 / denominator : 0
  }
  const a = bound(from); const b = bound(to)
  return [fx + dx * a, fy + dy * a, tx - dx * b, ty - dy * b]
}

function domain(values: number[], zero = false): [number, number] {
  let min = Math.min(...values, ...(zero ? [0] : [])); let max = Math.max(...values, ...(zero ? [0] : []))
  if (zero && min === 0 && max === 0) return [0, 1]
  if (min === max) { const pad = Math.abs(min) * 0.1 || 1; min -= pad; max += pad }
  const padding = (max - min) * 0.08
  return [zero && min === 0 ? 0 : min - padding, zero && max === 0 ? 0 : max + padding]
}
export function figureNumber(value: number): string {
  if (value !== 0 && (Math.abs(value) >= 1e6 || Math.abs(value) < 0.001)) return value.toExponential(2)
  return Number(value.toPrecision(4)).toLocaleString('en-US', { maximumFractionDigits: 5 })
}

export function buildFigureScene(spec: FigureSpec): FigureMark[] {
  const m: FigureMark[] = []
  const text = (value: string, x: number, y: number, size = 18, anchor: 'start' | 'middle' | 'end' = 'start', bold = false): void => { m.push({ type: 'text', text: value, x, y, size, anchor, bold }) }
  wrapFigureText(spec.title, 1080, 30).forEach((line, i) => text(line, 60, 50 + i * 36, 30, 'start', true))
  wrapFigureText(figureSourceLabel(spec), 1080, 15).forEach((line, i) => text(line, 60, 651 + i * 19, 15))
  if (spec.kind === 'diagram') {
    const ox = FIGURE_CANVAS.left; const oy = FIGURE_CANVAS.top
    const nodes = new Map(spec.nodes.map(node => [node.id, node]))
    for (const edge of spec.edges) {
      const [x, y, x2, y2] = edgeEndpoints(nodes.get(edge.from)!, nodes.get(edge.to)!)
      m.push({ type: 'line', x: x + ox, y: y + oy, x2: x2 + ox, y2: y2 + oy, color: FIGURE_INK.secondary, width: 2, arrow: true })
    }
    for (const node of spec.nodes) {
      const { width, height, shape, label } = node; const x = node.x + ox; const y = node.y + oy
      if (shape === 'ellipse') m.push({ type: 'ellipse', x: x + width / 2, y: y + height / 2, rx: width / 2, ry: height / 2, fill: FIGURE_INK.node, stroke: FIGURE_COLORS[0] })
      else if (shape === 'diamond') m.push({ type: 'path', d: `M${x + width / 2},${y} L${x + width},${y + height / 2} L${x + width / 2},${y + height} L${x},${y + height / 2} Z`, fill: FIGURE_INK.node, stroke: FIGURE_COLORS[0], width: 2 })
      else m.push({ type: 'rect', x, y, width, height, fill: FIGURE_INK.node, stroke: FIGURE_COLORS[0], radius: shape === 'roundRect' ? 12 : 0 })
      const inset = shape === 'diamond' ? 0.5 : shape === 'ellipse' ? 0.7 : 1
      const lines = wrapFigureText(label, width * inset - 20)
      lines.forEach((line, i) => text(line, x + width / 2, y + height / 2 + (i - (lines.length - 1) / 2) * 24 + 7, 20, 'middle'))
    }
    // Labels drawn last, backed by a surface patch, never raw SVG from input.
    for (const edge of spec.edges) if (edge.label) {
      const [x, y, x2, y2] = edgeEndpoints(nodes.get(edge.from)!, nodes.get(edge.to)!)
      const lines = wrapFigureText(edge.label, 180, 15); const cx = Math.max(154, Math.min(1046, (x + x2) / 2 + ox)); const cy = (y + y2) / 2 + oy
      m.push({ type: 'rect', x: cx - 94, y: cy - lines.length * 9 - 6, width: 188, height: lines.length * 18 + 12, fill: 'FFFFFF', radius: 4 })
      lines.forEach((line, i) => text(line, cx, cy + (i - (lines.length - 1) / 2) * 18 + 5, 15, 'middle'))
    }
    return m
  }
  const left = 110; const right = 1040; const top = 155; const bottom = 540
  const [ymin, ymax] = domain(spec.series.flatMap(s => s.values), spec.chartType === 'bar')
  const sy = (v: number): number => bottom - (v - ymin) / (ymax - ymin) * (bottom - top)
  for (let i = 0; i <= 5; i++) {
    const value = ymin + (ymax - ymin) * i / 5; const y = sy(value)
    m.push({ type: 'line', x: left, y, x2: right, y2: y, color: FIGURE_INK.grid, width: 1 })
    text(figureNumber(value), left - 14, y + 5, 15, 'end')
  }
  m.push({ type: 'text', x: 29, y: (top + bottom) / 2, text: spec.yLabel, size: 18, anchor: 'middle', rotate: -90 })
  text(spec.xLabel, (left + right) / 2, 605, 18, 'middle')
  const count = spec.series[0].values.length
  const [xmin, xmax] = spec.chartType === 'scatter' ? domain(spec.xValues!) : [0, count - 1]
  const sx = (i: number): number => spec.chartType === 'bar' ? left + (i + 0.5) * (right - left) / count : left + ((spec.xValues?.[i] ?? i) - xmin) / (xmax - xmin) * (right - left)
  if (spec.chartType === 'scatter') for (let i = 0; i <= 5; i++) {
    const v = xmin + (xmax - xmin) * i / 5
    text(figureNumber(v), left + i * (right - left) / 5, bottom + 27, 15, 'middle')
  }
  else spec.labels!.forEach((label, i) => {
    if (i % Math.max(1, Math.ceil(count / 10)) !== 0 && i !== count - 1) return
    const clipped = label.length > 12 ? `${label.slice(0, 11)}…` : label
    text(clipped, sx(i), bottom + 27, 14, 'middle')
  })
  spec.series.forEach((series, s) => {
    const color = FIGURE_COLORS[s]
    const band = (right - left) / count
    const gap = Math.min(2, band * 0.08)
    const barWidth = Math.min(24, (band * 0.75 - gap * (spec.series.length - 1)) / spec.series.length)
    const group = spec.series.length * barWidth + (spec.series.length - 1) * gap
    if (spec.chartType === 'line') m.push({ type: 'path', d: series.values.map((v, i) => `${i ? 'L' : 'M'}${sx(i)},${sy(v)}`).join(' '), fill: 'none', stroke: color, width: 2 })
    series.values.forEach((value, i) => {
      const x = sx(i); const y = sy(value)
      const tip = `${series.name} · ${spec.labels?.[i] ?? figureNumber(spec.xValues![i])}: ${value}`
      if (spec.chartType === 'bar') m.push({ type: 'rect', x: x - group / 2 + s * (barWidth + gap), y: Math.min(sy(0), y), width: barWidth, height: Math.abs(sy(0) - y), fill: color, radius: Math.min(2, barWidth / 2), tip })
      else if (s === 1) m.push({ type: 'rect', x: x - 4, y: y - 4, width: 8, height: 8, fill: color, stroke: 'FFFFFF', tip })
      else if (s === 2) m.push({ type: 'path', d: `M${x},${y - 6} L${x + 6},${y + 5} L${x - 6},${y + 5} Z`, fill: color, stroke: 'FFFFFF', width: 2, tip })
      else m.push({ type: 'ellipse', x, y, rx: 5, ry: 5, fill: color, stroke: 'FFFFFF', tip })
    })
    // Series names are directly labeled at their final mark with leader lines when close.
    const lastY = sy(series.values[count - 1]); const labelY = top + s * 32
    m.push({ type: 'line', x: sx(count - 1) + 8, y: lastY, x2: right + 17, y2: labelY, color, width: 1 })
    text(series.name.length > 14 ? `${series.name.slice(0, 13)}…` : series.name, right + 22, labelY + 5, 14)
    if (spec.series.length >= 2) {
      m.push({ type: 'rect', x: 110 + s * 330, y: 105, width: 13, height: 13, fill: color, radius: 2 })
      text(series.name, 131 + s * 330, 117, 15)
    } else text(series.name, 110, 117, 15)
  })
  return m
}

export function escapeFigureXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Export only a generated allowlist of primitives; never interpolate SVG/HTML source. */
export function figureToSvg(spec: FigureSpec): string {
  const output = buildFigureScene(spec).map(mark => {
    const tip = 'tip' in mark && mark.tip ? `<title>${escapeFigureXml(mark.tip)}</title>` : ''
    switch (mark.type) {
      case 'text': return `<text x="${mark.x}" y="${mark.y}" font-size="${mark.size}" text-anchor="${mark.anchor ?? 'start'}" font-weight="${mark.bold ? 600 : 400}"${mark.rotate ? ` transform="rotate(${mark.rotate} ${mark.x} ${mark.y})"` : ''}>${escapeFigureXml(mark.text)}</text>`
      case 'rect': return `<rect x="${mark.x}" y="${mark.y}" width="${mark.width}" height="${mark.height}" rx="${mark.radius ?? 0}" fill="#${mark.fill}" stroke="${mark.stroke ? '#' + mark.stroke : 'none'}" stroke-width="2">${tip}</rect>`
      case 'ellipse': return `<ellipse cx="${mark.x}" cy="${mark.y}" rx="${mark.rx}" ry="${mark.ry}" fill="#${mark.fill}" stroke="${mark.stroke ? '#' + mark.stroke : 'none'}" stroke-width="2">${tip}</ellipse>`
      case 'line': return `<line x1="${mark.x}" y1="${mark.y}" x2="${mark.x2}" y2="${mark.y2}" stroke="#${mark.color}" stroke-width="${mark.width}"${mark.arrow ? ' marker-end="url(#arrow)"' : ''}/>`
      case 'path': return `<path d="${mark.d}" fill="${mark.fill === 'none' ? 'none' : '#' + mark.fill}" stroke="${mark.stroke ? '#' + mark.stroke : 'none'}" stroke-width="${mark.width ?? 2}" stroke-linejoin="round">${tip}</path>`
    }
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720" role="img" aria-labelledby="title desc"><title id="title">${escapeFigureXml(spec.title)}</title><desc id="desc">${escapeFigureXml(figureSourceLabel(spec))}</desc><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#53657A"/></marker></defs><rect width="1200" height="720" fill="white"/><g font-family="Arial, sans-serif" fill="#182A42">${output}</g></svg>`
}
