import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'
import { validateFigureSpec, type ChartFigureSpec, type DiagramFigureSpec } from '../src/shared/figure-spec'
import { buildFigureScene, figureToSvg } from '../src/shared/lib/figure-layout'
import { figureToPptx } from '../src/main/lib/figure-pptx'
import { figurePath } from '../src/main/lib/figure-files'
import { FigureService } from '../src/main/services/figures'
import { Db } from '../src/main/lib/db'
import type { SettingsService } from '../src/main/services/settings'

const chart: ChartFigureSpec = { version: 1, kind: 'chart', chartType: 'bar', title: 'Measured response', provenance: { sourceLabel: 'TEST FIXTURE ONLY — not research evidence', isDemo: true }, xLabel: 'Condition', yLabel: 'Response (units)', labels: ['A', 'B', 'C'], series: [{ name: 'Measured', values: [-2, 0, 4] }, { name: 'Replicate', values: [1, 2, 3] }] }
const diagram: DiagramFigureSpec = { version: 1, kind: 'diagram', title: 'Proposed method', provenance: { sourceLabel: 'Test diagram, not evidence', isDemo: true }, nodes: [{ id: 'input', label: 'Input', shape: 'roundRect', x: 10, y: 140, width: 220, height: 90 }, { id: 'analysis', label: 'Analysis', shape: 'rect', x: 400, y: 140, width: 220, height: 90 }], edges: [{ id: 'process', from: 'input', to: 'analysis', label: 'process' }] }
const pptMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

test('bounded schema accepts canonical model and rejects missing provenance, NaN, unknown types, ragged data and excessive budgets', () => {
  assert.deepEqual(validateFigureSpec(chart), chart)
  const cases = [
    { ...chart, version: 2 }, { ...chart, title: '' }, { ...chart, provenance: undefined }, { ...chart, provenance: { sourceLabel: '', isDemo: false } },
    { ...chart, provenance: { sourceLabel: 'test', isDemo: 'false' } }, { ...chart, chartType: 'heatmap' }, { ...chart, extra: '<svg>' },
    { ...chart, series: [{ name: 'X', values: [1, NaN, 3] }] }, { ...chart, series: [{ name: 'X', values: [1, Infinity, 3] }] },
    { ...chart, series: [{ name: 'X', values: [1, '2', 3] }] }, { ...chart, series: [{ name: 'X', values: [1, 2] }] },
    { ...chart, series: [{ name: 'X', values: [1, 2, 1e13] }] }, { ...chart, series: Array.from({ length: 4 }, (_, i) => ({ name: String(i), values: [1, 2, 3] })) },
    { ...chart, labels: Array.from({ length: 201 }, (_, i) => String(i)) }, { ...chart, xValues: [1, 2, 3] },
    { ...chart, labels: ['A', 'A', 'B'] }, { ...chart, title: 'bad\x00text' }, { ...chart, title: '\ud800' },
    { ...diagram, nodes: [{ ...diagram.nodes[0], x: 900 }] }, { ...diagram, nodes: [{ ...diagram.nodes[0], label: 'a'.repeat(120), width: 80, height: 50 }] },
    { ...diagram, edges: [{ id: 'e', from: 'input', to: 'missing' }] }, { ...diagram, edges: [{ id: 'e', from: 'input', to: 'input' }] },
    { ...diagram, nodes: [diagram.nodes[0], diagram.nodes[0]] }, { ...diagram, edges: Array(81).fill(diagram.edges[0]) }, { ...diagram, series: [] }
  ]
  for (const candidate of cases) assert.throws(() => validateFigureSpec(candidate), /FigureSpec/)
})

test('SVG text is XML escaped, with no active user markup and visible demo provenance', () => {
  const svg = figureToSvg(validateFigureSpec({ ...chart, title: '<script>alert(1)</script> & "quote"' }))
  assert.ok(svg.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(svg.includes('NOT EVIDENCE'))
  assert.ok(!svg.includes('<script>'))
  assert.ok(!svg.includes('foreignObject'))
})

for (const type of ['bar', 'line', 'scatter'] as const) test(`${type} PowerPoint contains a native editable chart and numeric embedded workbook`, async () => {
  const { labels, ...rest } = chart
  const spec: ChartFigureSpec = type === 'scatter' ? { ...rest, chartType: type, xValues: [0, 2, 9] } : { ...chart, chartType: type }
  const zip = await JSZip.loadAsync(await figureToPptx(spec))
  const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
  assert.match(slide, /<c:chart /)
  assert.doesNotMatch(slide, /<p:pic>/)
  const xml = await zip.file(Object.keys(zip.files).find(name => /^ppt\/charts\/chart\d+\.xml$/.test(name))!)!.async('string')
  assert.match(xml, new RegExp(`<c:${type}Chart>`))
  assert.match(xml, /<c:externalData /)
  assert.match(xml, /<c:v>-2<\/c:v>/)
  assert.match(xml, /<c:v>0<\/c:v>/)
  assert.equal((xml.match(/<c:ser>/g) ?? []).length, 2)
  if (type === 'bar') assert.match(xml, /<c:crosses val="autoZero"/)
  if (type === 'scatter') { assert.match(xml, /<c:xVal>/); assert.match(xml, /<c:v>9<\/c:v>/); assert.match(xml, /<a:ln><a:noFill\/><\/a:ln>/) }
  const embeds = Object.keys(zip.files).filter(name => name.endsWith('.xlsx'))
  assert.equal(embeds.length, 1)
  const workbook = await JSZip.loadAsync(await zip.file(embeds[0])!.async('nodebuffer'))
  const sheet = await workbook.file('xl/worksheets/sheet1.xml')!.async('string')
  assert.match(sheet, /<v>-2<\/v>/)
  assert.match(sheet, /<v>0<\/v>/)
  const strings = await workbook.file('xl/sharedStrings.xml')!.async('string')
  assert.match(strings, /Measured/)
  assert.match(strings, /Replicate/)
  const theme = await zip.file('ppt/theme/theme1.xml')!.async('string')
  assert.match(theme, /<a:accent1><a:srgbClr val="2A78D6"\/><\/a:accent1>/)
})

test('scale edge cases preserve zero baselines, finite geometry and exact scatter x data', async () => {
  for (const values of [[0, 0, 0], [-10, -5, -2], [2, 3, 4]]) {
    const spec = validateFigureSpec({ ...chart, series: [{ name: 'Values', values }] })
    const scene = buildFigureScene(spec)
    for (const mark of scene) for (const value of Object.values(mark)) if (typeof value === 'number') assert.ok(Number.isFinite(value))
    const bars = scene.filter(mark => mark.type === 'rect' && mark.tip)
    assert.equal(bars.length, 3)
    if (values.every(v => v === 0)) for (const bar of bars) assert.equal(bar.type === 'rect' ? bar.height : NaN, 0)
    const zip = await JSZip.loadAsync(await figureToPptx(spec))
    const xml = await zip.file(Object.keys(zip.files).find(name => /^ppt\/charts\/chart\d+\.xml$/.test(name))!)!.async('string')
    if (values.every(v => v >= 0)) assert.match(xml, /<c:min val="0"/)
    if (values.every(v => v < 0)) assert.match(xml, /<c:max val="0"/)
    if (values.every(v => v === 0)) assert.doesNotMatch(xml, /<c:max val="0"/)
  }
  const dense = validateFigureSpec({ ...chart, labels: Array.from({ length: 200 }, (_, i) => String(i)), series: ['One', 'Two', 'Three'].map(name => ({ name, values: Array.from({ length: 200 }, (_, i) => i) })) })
  const denseBars = buildFigureScene(dense).filter(mark => mark.type === 'rect' && mark.tip)
  assert.equal(denseBars.length, 600)
  for (const bar of denseBars) if (bar.type === 'rect') { assert.ok(bar.width > 0); assert.ok(bar.x >= 110 && bar.x + bar.width <= 1040) }
  const { labels, ...rest } = chart
  const scatter = validateFigureSpec({ ...rest, chartType: 'scatter', xValues: [-8, 0, 12], series: ['One', 'Two', 'Three'].map(name => ({ name, values: [-4, 0, 7] })) })
  const zip = await JSZip.loadAsync(await figureToPptx(scatter))
  const xml = await zip.file(Object.keys(zip.files).find(name => /^ppt\/charts\/chart\d+\.xml$/.test(name))!)!.async('string')
  assert.equal((xml.match(/<c:ser>/g) ?? []).length, 3)
  assert.match(xml, /<c:legend>/)
  for (const value of [-8, 0, 12]) assert.ok(xml.includes(`<c:v>${value}</c:v>`))
  assert.throws(() => validateFigureSpec({ ...chart, title: 'one\ntwo\nthree' }), /FigureSpec/)
  assert.throws(() => validateFigureSpec({ ...chart, title: '长'.repeat(100) }), /two lines/)
})

test('diagram PowerPoint consists of separate editable shapes, text, edge and source labels; no image', async () => {
  const zip = await JSZip.loadAsync(await figureToPptx(diagram))
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string')
  for (const name of ['node-input', 'node-analysis', 'node-label-input', 'node-label-analysis', 'edge-process', 'edge-label-process']) assert.ok(xml.includes(`name="${name}"`), name)
  assert.match(xml, /txBox="1"/)
  assert.match(xml, /NOT EVIDENCE/)
  assert.match(xml, /<a:tailEnd type="triangle"/)
  assert.doesNotMatch(xml, /<p:pic>|<c:chart /)
  assert.equal(Object.keys(zip.files).filter(name => /^ppt\/media\/.+/.test(name)).length, 0)
})

test('path guard rejects traversal, absolute paths, ADS, symlinks and junctions', t => {
  const root = mkdtempSync(join(tmpdir(), 'rp-figure-path-'))
  const outside = mkdtempSync(join(tmpdir(), 'rp-figure-outside-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })
  mkdirSync(join(root, 'figures'))
  assert.equal(figurePath(root, 'figures/safe.svg'), join(root, 'figures', 'safe.svg'))
  for (const path of ['../outside.svg', 'figures/../../out', '/absolute', 'C:\\absolute', 'figures/test:stream', 'figures/../test', 'figures/foo.']) assert.throws(() => figurePath(root, path))
  symlinkSync(outside, join(root, 'figures', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => figurePath(root, 'figures/linked/output.svg'), /symlink|junction/)
})

test('FigureService create/edit/export keeps source, SVG and native PPT consistent, MIME-aware and project scoped', async t => {
  const root = mkdtempSync(join(tmpdir(), 'rp-figure-service-'))
  const db = new Db(join(root, 'state.sqlite'))
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  for (const id of ['p1', 'p2']) {
    const folder = join(root, id); mkdirSync(folder)
    db.run('INSERT INTO projects (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)', id, id, folder, '2026-01-01', '2026-01-01')
  }
  const service = new FigureService(db, {} as SettingsService)
  const created = await service.createStructured({ projectId: 'p1', spec: chart })
  assert.equal(created.modelKind, 'chart')
  assert.ok(created.sourcePath && created.pptxPath)
  assert.equal(created.provenance?.isDemo, true)
  assert.deepEqual(service.getStructured('p1', created.id), chart)
  for (const [artifact, mimeType] of [['preview', 'image/svg+xml'], ['source', 'application/json'], ['pptx', pptMime]] as const) assert.equal(service.read('p1', created.id, artifact).mimeType, mimeType)
  assert.throws(() => service.getStructured('p2', created.id), /不存在/)
  await assert.rejects(service.saveStructured('p2', created.id, chart), /不存在/)
  await assert.rejects(service.exportPptx('p2', created.id), /不存在/)
  assert.throws(() => service.read('p2', created.id), /不存在/)
  await assert.rejects(service.saveStructured('p1', created.id, { ...chart, provenance: { ...chart.provenance, sourceLabel: '' } }), /FigureSpec/)
  assert.equal(service.get('p1', created.id).filePath, created.filePath)
  const changed = { ...chart, title: 'Updated source title', series: [{ name: 'Measured', values: [10, 20, 30] }] }
  const saved = await service.saveStructured('p1', created.id, changed)
  assert.notEqual(saved.filePath, created.filePath)
  assert.deepEqual(service.getStructured('p1', created.id), changed)
  const zip = await JSZip.loadAsync(Buffer.from(service.read('p1', created.id, 'pptx').base64, 'base64'))
  assert.match(await zip.file(Object.keys(zip.files).find(name => /^ppt\/charts\/chart\d+\.xml$/.test(name))!)!.async('string'), /<c:v>30<\/c:v>/)
  // Raw SVG edits never become renderer markup, even when the file is modified outside the app.
  writeFileSync(join(root, 'p1', saved.filePath), '<svg onload="alert(1)"></svg>')
  assert.doesNotMatch(Buffer.from(service.read('p1', created.id).base64, 'base64').toString(), /onload/)
  const exported = await service.exportPptx('p1', created.id)
  assert.ok(readFileSync(join(root, 'p1', exported.pptxPath!)).length > 1000)
  db.run('UPDATE figures SET file_path = ? WHERE id = ?', '../outside.png', created.id)
  assert.throws(() => service.read('p1', created.id), /traversal|Invalid/)
  assert.throws(() => service.delete('p1', created.id), /traversal|Invalid/)
  const rasterId = 'raster'
  db.run('INSERT INTO figures (id,project_id,name,file_path,format,created_at) VALUES (?,?,?,?,?,?)', rasterId, 'p1', 'Legacy raster', 'figures/legacy.png', 'png', '2026-01-01')
  assert.equal(service.get('p1', rasterId).modelKind, 'raster')
  await assert.rejects(service.exportPptx('p1', rasterId), /结构化/)
})
