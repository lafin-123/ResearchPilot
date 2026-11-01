import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { buildDocx, parseMarkdown, type ResolvedDocxImage } from '../src/main/lib/docx-build'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1sAAAAASUVORK5CYII=', 'base64')
const raster: ResolvedDocxImage = { data: png, type: 'png', width: 1, height: 1 }

async function inspectDocx(markdown: string, resolveImage?: (src: string) => Promise<ResolvedDocxImage | undefined>) {
  const zip = await JSZip.loadAsync(await buildDocx({ title: 'Manuscript', markdown, resolveImage }))
  const xml = await zip.file('word/document.xml')!.async('string')
  const rels = await zip.file('word/_rels/document.xml.rels')!.async('string')
  return { zip, xml, rels }
}

function extent(xml: string): [number, number] {
  const match = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml)
  assert.ok(match, 'DOCX must contain an actual DrawingML image extent')
  return [Number(match[1]), Number(match[2])]
}

test('standalone Markdown figures are parsed independently of surrounding paragraphs', () => {
  assert.deepEqual(parseMarkdown('Result before.\n![Figure 1. Response (mg/L)](figures/result.svg)\nResult after.'), [
    { type: 'paragraph', text: 'Result before.' },
    { type: 'image', src: 'figures/result.svg', caption: 'Figure 1. Response (mg/L)' },
    { type: 'paragraph', text: 'Result after.' }
  ])
  assert.deepEqual(parseMarkdown('![Figure \\[A\\]](<figures/result (final).png> "Plot title")'), [
    { type: 'image', src: 'figures/result (final).png', caption: 'Figure [A]' }
  ])
})

test('DOCX embeds trusted image bytes, caption, relationship and accessibility text', async () => {
  const sources: string[] = []
  const { zip, xml, rels } = await inspectDocx('## Results\n\n![Figure 1. **Observed** response & uncertainty (mg/L)](figures/observed.svg)', async (src) => {
    sources.push(src)
    // Service rasterizes generated SVG; builder only receives compatible PNG.
    return raster
  })
  assert.deepEqual(sources, ['figures/observed.svg'])
  const media = Object.keys(zip.files).filter((name) => /^word\/media\/.*\.png$/.test(name))
  assert.equal(media.length, 1)
  assert.deepEqual(await zip.file(media[0]!)!.async('nodebuffer'), png)
  assert.match(xml, /<w:drawing>/)
  assert.match(xml, /<a:blip r:embed="[^"]+"/)
  assert.match(xml, /Figure 1\. /)
  assert.match(xml, /Observed/)
  assert.match(xml, /response &amp; uncertainty \(mg\/L\)/)
  assert.match(xml, /<w:keepNext\/>/)
  assert.match(rels, /relationships\/image/)
  assert.doesNotMatch(rels, /TargetMode="External"/)
  assert.doesNotMatch(xml, /!\[Figure/)
  // Source pixel units must be converted to EMU, without gratuitous upscaling.
  assert.deepEqual(extent(xml), [9525, 9525])
})

test('large figures fit A4 content width, preserve aspect ratio, and bound portrait height', async () => {
  const wide = await inspectDocx('![Wide result](figures/wide.png)', async () => ({ ...raster, width: 2400, height: 1200 }))
  const [width, height] = extent(wide.xml)
  assert.ok(width <= 9026 * 635, 'image must fit A4 minus one-inch left and right margins')
  assert.ok(Math.abs(width / height - 2) < 0.001)
  const tall = await inspectDocx('![Tall result](figures/tall.png)', async () => ({ ...raster, width: 600, height: 2400 }))
  const [tallWidth, tallHeight] = extent(tall.xml)
  assert.equal(tallHeight, 720 * 9525)
  assert.equal(tallWidth * 4, tallHeight)
})

test('multiple figures retain manuscript order with captions after their drawings', async () => {
  const { xml } = await inspectDocx('Before.\n\n![First caption](figures/one.png)\n\nBetween.\n\n![Second caption](figures/two.png)\n\nAfter.', async () => raster)
  assert.equal((xml.match(/<w:drawing>/g) ?? []).length, 2)
  const first = xml.indexOf('<w:drawing>')
  const second = xml.indexOf('<w:drawing>', first + 1)
  assert.ok(xml.indexOf('Before.') < first)
  assert.ok(xml.indexOf('First caption</w:t>') > first)
  assert.ok(xml.indexOf('Between.') < second)
  assert.ok(xml.indexOf('Second caption</w:t>') > second)
  assert.ok(xml.indexOf('After.') > second)
})

test('remote URLs, absolute paths and traversal never reach the image resolver', async () => {
  const forbidden = [
    'https://example.test/image.png', 'http://localhost/image.png', '//example.test/image.png',
    'file:///C:/secret.png', 'data:image/png;base64,AAAA', 'C:/secret.png', 'C:\\secret.png',
    '/tmp/secret.png', '../secret.png', 'figures/../../secret.png', 'figures\\..\\secret.png',
    'figures/%2e%2e/secret.png', 'figures/image.png?url=https://example.test', 'figures/image.png#fragment'
  ]
  let resolverCalls = 0
  for (const src of forbidden) {
    await assert.rejects(buildDocx({
      title: 'Unsafe image', markdown: `![Figure](${src})`,
      resolveImage: async () => { resolverCalls += 1; return raster }
    }), /project-relative local path/)
  }
  assert.equal(resolverCalls, 0)
})

test('missing image resolver, missing project image and resolver failure stop export', async () => {
  const options = { title: 'Missing figure', markdown: '![Required result](figures/missing.png)' }
  await assert.rejects(buildDocx(options), /no project image resolver/)
  await assert.rejects(buildDocx({ ...options, resolveImage: async () => undefined }), /image not found or not permitted/)
  await assert.rejects(buildDocx({ ...options, resolveImage: async () => { throw new Error('Project containment violation') } }), /Project containment violation/)
})

test('invalid raster payloads or dimensions fail rather than creating broken image placeholders', async () => {
  const invalid = [
    { ...raster, data: Buffer.alloc(0) },
    { ...raster, data: Buffer.from('<svg></svg>') },
    { ...raster, type: 'jpg' as const },
    { ...raster, width: 0 }, { ...raster, height: -1 },
    { ...raster, width: Number.NaN }, { ...raster, height: Number.POSITIVE_INFINITY }
  ]
  for (const image of invalid) {
    await assert.rejects(buildDocx({ title: 'Invalid raster', markdown: '![Figure](figures/test.png)', resolveImage: async () => image }), /Cannot embed DOCX image/)
  }
})

test('inline images fail explicitly but code samples remain literal', async () => {
  await assert.rejects(buildDocx({ title: 'Inline', markdown: 'See ![Figure](figures/test.png) here.', resolveImage: async () => raster }), /standalone Markdown images/)
  await assert.rejects(buildDocx({ title: 'Table image', markdown: '| Figure |\n| --- |\n| ![Figure](figures/test.png) |', resolveImage: async () => raster }), /standalone Markdown images/)
  const { xml } = await inspectDocx('```markdown\n![Example](figures/example.png)\n```')
  assert.match(xml, /!\[Example\]/)
  assert.doesNotMatch(xml, /<w:drawing>/)
})

test('image-free exports preserve DOI references, units, headings, lists and Markdown tables', async () => {
  const { zip, xml } = await inspectDocx('# Actual paper\n\n## Methods\n\nMeasured in mg/L and µmol·m⁻²·s⁻¹. DOI: https://doi.org/10.1234/example.\n\n- Independent replicate\n\n| Method | Error (mg/L) |\n| --- | ---: |\n| Baseline | 0.42 |\n| Observed | 0.23 |')
  assert.match(xml, /Actual paper/)
  assert.match(xml, /Methods/)
  assert.match(xml, /µmol·m⁻²·s⁻¹/)
  assert.match(xml, /https:\/\/doi.org\/10\.1234\/example/)
  assert.match(xml, /<w:tbl>/)
  assert.match(xml, /0\.42/)
  assert.match(xml, /0\.23/)
  assert.equal(Object.keys(zip.files).filter((name) => /^word\/media\/.+/.test(name)).length, 0)
})

test('long table columns use a fixed page-bounded DXA grid and matching cell widths', async () => {
  const headers = Array.from({ length: 12 }, (_, index) => `Measurement ${index + 1}`)
  const row = headers.map((_, index) => `Long result ${index} with mg/L and source units`)
  const markdown = `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n| ${row.join(' | ')} |\n| short row |`
  const { xml } = await inspectDocx(markdown)
  assert.match(xml, /<w:tblLayout w:type="fixed"/)
  assert.match(xml, /<w:tblW w:type="dxa" w:w="9026"/)
  const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"/g)].map((match) => Number(match[1]))
  assert.equal(widths.length, 12)
  assert.equal(widths.reduce((sum, width) => sum + width, 0), 9026)
  const cellWidths = [...xml.matchAll(/<w:tcW w:type="dxa" w:w="(\d+)"/g)].map((match) => Number(match[1]))
  assert.deepEqual(cellWidths, [...widths, ...widths, ...widths])
  assert.match(xml, /Long result 11 with mg\/L and source units/)
})
