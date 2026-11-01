import PptxGenJS from 'pptxgenjs'
import JSZip from 'jszip'
import { FIGURE_COLORS, figureSourceLabel, validateFigureSpec, wrapFigureText, type FigureSpec } from '../../shared/figure-spec'
import { edgeEndpoints, FIGURE_INK } from '../../shared/lib/figure-layout'

/** Native chart/shape generation. SVG is a preview only and never a slide image. */
export async function figureToPptx(input: FigureSpec): Promise<Buffer> {
  const spec = validateFigureSpec(input)
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'RESEARCH_FIGURE', width: 12, height: 7.2 })
  pptx.layout = 'RESEARCH_FIGURE'
  pptx.author = 'ResearchPilot'
  pptx.subject = figureSourceLabel(spec)
  pptx.title = spec.title
  pptx.theme = { headFontFace: 'Arial', bodyFontFace: 'Arial' }
  pptx.defineSlideMaster({
    title: 'FigureFrame', background: { color: 'FFFFFF' },
    objects: [
      { placeholder: { text: '', options: { name: 'figureTitle', type: 'title', x: 0.6, y: 0.2, w: 10.8, h: 0.8, margin: 0, fontSize: 24, bold: true, color: 'tx1' } } },
      { placeholder: { text: '', options: { name: 'figureSource', type: 'body', x: 0.6, y: 6.28, w: 10.8, h: 0.72, margin: 0, fontSize: 10, color: 'tx2' } } }
    ]
  })
  pptx.addSection({ title: 'Scientific figure' })
  const slide = pptx.addSlide({ masterName: 'FigureFrame', sectionTitle: 'Scientific figure' })
  slide.addText(spec.title, { placeholder: 'figureTitle' })
  slide.addText(figureSourceLabel(spec), { placeholder: 'figureSource' })
  slide.addNotes([
    'ResearchPilot structured figure v1. All chart data and diagram elements are editable.',
    figureSourceLabel(spec),
    spec.kind === 'chart' ? 'Use PowerPoint Chart Design > Edit Data to edit the embedded workbook. SVG preview and PPT are independent renderings of the saved JSON.' : 'Nodes, node labels, edge lines and edge labels are independent native PowerPoint objects. Edge lines do not auto-route after moving a node.',
    'Provenance is user-declared; it is not automatically verified evidence.'
  ].join('\n'))
  if (spec.kind === 'chart') {
    const data: PptxGenJS.OptsChartData[] = spec.chartType === 'scatter'
      ? [{ name: spec.xLabel || 'X', values: [...spec.xValues!] }, ...spec.series.map(s => ({ name: s.name, values: [...s.values] }))]
      : spec.series.map(s => ({ name: s.name, labels: [...spec.labels!], values: [...s.values] }))
    const values = spec.series.flatMap(s => s.values)
    slide.addChart(pptx.ChartType[spec.chartType], data, {
      x: 0.65, y: 1.12, w: 10.7, h: 5.05,
      objectName: `chart-${spec.chartType}`,
      showLegend: spec.series.length > 1, legendPos: 't', legendFontSize: 11, legendColor: FIGURE_INK.primary, legendFontFace: '+mn-lt',
      showTitle: spec.series.length === 1, title: spec.series[0].name, titleFontFace: '+mn-lt', titleFontSize: 13, titleColor: FIGURE_INK.primary,
      chartColors: [...FIGURE_COLORS].slice(0, spec.series.length),
      showValue: false, showLabel: false,
      catAxisTitle: spec.xLabel, showCatAxisTitle: Boolean(spec.xLabel), catAxisTitleFontSize: 12, catAxisTitleFontFace: '+mn-lt', catAxisTitleColor: FIGURE_INK.primary,
      valAxisTitle: spec.yLabel, showValAxisTitle: Boolean(spec.yLabel), valAxisTitleFontSize: 12, valAxisTitleFontFace: '+mn-lt', valAxisTitleColor: FIGURE_INK.primary,
      catAxisLabelColor: FIGURE_INK.secondary, catAxisLabelFontFace: '+mn-lt', catAxisLabelFontSize: 10,
      valAxisLabelColor: FIGURE_INK.secondary, valAxisLabelFontFace: '+mn-lt', valAxisLabelFontSize: 10,
      catAxisLabelFrequency: String(Math.max(1, Math.ceil(values.length / spec.series.length / 12))),
      catAxisLineShow: false, valAxisLineShow: false, catAxisMajorTickMark: 'none', valAxisMajorTickMark: 'none',
      catGridLine: { style: 'none' }, valGridLine: { color: FIGURE_INK.grid, size: 0.5, style: 'solid' },
      chartArea: { fill: { color: 'FFFFFF' }, border: { color: 'FFFFFF', pt: 0 } }, plotArea: { fill: { color: 'FFFFFF' }, border: { color: 'FFFFFF', pt: 0 } },
      barDir: 'col', barGrouping: 'clustered', barGapWidthPct: 250, barOverlapPct: -10,
      ...(spec.chartType === 'bar' && Math.min(...values) >= 0 ? { valAxisMinVal: 0 } : {}),
      ...(spec.chartType === 'bar' && Math.max(...values) <= 0 && Math.min(...values) < 0 ? { valAxisMaxVal: 0 } : {}),
      lineSize: spec.chartType === 'scatter' ? 0 : 1.5, lineDataSymbol: 'circle', lineDataSymbolSize: 6,
      lineDataSymbolLineColor: 'FFFFFF', lineDataSymbolLineSize: 1.5, lineSmooth: false
    })
  } else {
    const nodeById = new Map(spec.nodes.map(n => [n.id, n]))
    for (const edge of spec.edges) {
      const [x1, y1, x2, y2] = edgeEndpoints(nodeById.get(edge.from)!, nodeById.get(edge.to)!)
      slide.addShape(pptx.ShapeType.line, {
        x: 1 + Math.min(x1, x2) / 100, y: 1.3 + Math.min(y1, y2) / 100,
        w: Math.abs(x2 - x1) / 100, h: Math.abs(y2 - y1) / 100,
        flipH: x2 < x1, flipV: y2 < y1,
        line: { color: FIGURE_INK.secondary, width: 1.5, beginArrowType: 'none', endArrowType: 'triangle' },
        objectName: `edge-${edge.id}`
      })
    }
    for (const node of spec.nodes) {
      slide.addShape(pptx.ShapeType[node.shape], {
        x: 1 + node.x / 100, y: 1.3 + node.y / 100, w: node.width / 100, h: node.height / 100,
        fill: { color: 'bg2' }, line: { color: 'accent1', width: 1.5 }, objectName: `node-${node.id}`
      })
      const inset = node.shape === 'diamond' ? 0.5 : node.shape === 'ellipse' ? 0.7 : 1
      const lines = wrapFigureText(node.label, node.width * inset - 20)
      slide.addText(lines.join('\n'), {
        x: 1 + (node.x + node.width * (1 - inset) / 2 + 10) / 100,
        y: 1.3 + (node.y + node.height * (1 - inset) / 2 + 6) / 100,
        w: (node.width * inset - 20) / 100, h: (node.height * inset - 12) / 100,
        isTextBox: true, margin: 0, fontSize: 14.4, color: 'tx1', align: 'center', valign: 'middle', breakLine: false,
        objectName: `node-label-${node.id}`, fit: 'resize'
      })
    }
    for (const edge of spec.edges) if (edge.label) {
      const [x1, y1, x2, y2] = edgeEndpoints(nodeById.get(edge.from)!, nodeById.get(edge.to)!)
      const lines = wrapFigureText(edge.label, 180, 15)
      const height = (lines.length * 18 + 12) / 100
      slide.addText(lines.join('\n'), {
        x: Math.max(0.6, Math.min(9.52, 1 + (x1 + x2) / 200 - 0.94)), y: 1.3 + (y1 + y2) / 200 - height / 2, w: 1.88, h: height,
        isTextBox: true, margin: 0.02, fontSize: 10.8, color: 'tx2', fill: { color: 'bg1' }, align: 'center', valign: 'middle',
        objectName: `edge-label-${edge.id}`
      })
    }
  }
  const buffer = await pptx.write({ outputType: 'nodebuffer', compression: true }) as Buffer
  // PptxGenJS themes expose fonts only. Complete the palette with fixed validated colors.
  // No user strings are interpolated into this OOXML transform.
  const zip = await JSZip.loadAsync(buffer)
  const themeFile = zip.file('ppt/theme/theme1.xml')
  if (!themeFile) throw new Error('PowerPoint theme was not generated')
  const colors: Record<string, string> = { dk1: '182A42', lt1: 'FFFFFF', dk2: '53657A', lt2: 'F4F7FB', accent1: FIGURE_COLORS[0], accent2: FIGURE_COLORS[1], accent3: FIGURE_COLORS[2], accent4: '53657A', accent5: 'DFE6EF', accent6: '182A42', hlink: '2453D4', folHlink: '53657A' }
  const theme = (await themeFile.async('string')).replace(/<a:clrScheme\b[^>]*>[\s\S]*?<\/a:clrScheme>/, `<a:clrScheme name="ResearchPilot">${Object.entries(colors).map(([key, color]) => `<a:${key}><a:srgbClr val="${color}"/></a:${key}>`).join('')}</a:clrScheme>`)
  zip.file('ppt/theme/theme1.xml', theme)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
