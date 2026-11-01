import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import { validateFigureSpec } from '../src/shared/figure-spec'
import { RESEARCH_SKILLS } from '../src/shared/research-skills'
import { figureToPptx } from '../src/main/lib/figure-pptx'
import JSZip from 'jszip'

const skills = resolve(import.meta.dirname, '../resources/skills')
const packages = ['data-audit', 'statistical-analysis', 'reproducibility', 'citation-audit', 'scientific-diagram', 'editable-presentation', 'research-planning', 'peer-review', 'grant-proposal']
const candidates = [process.env.RESEARCHPILOT_TEST_PYTHON, 'python', 'python3'].filter(Boolean) as string[]
let python = candidates.find((command) => spawnSync(command, ['-I', '-c', 'import sys; assert sys.version_info >= (3, 9)'], { windowsHide: true }).status === 0)
if (!python) {
  const probe = spawnSync('uv', ['python', 'find', '--no-python-downloads'], { encoding: 'utf8', windowsHide: true })
  if (probe.status === 0) python = probe.stdout.trim()
}
function run(pkg: string, script: string, args: string[]) {
  return spawnSync(python!, ['-I', join(skills, pkg, 'scripts', script), ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
}
function temp() { const root = mkdtempSync(join(tmpdir(), 'skill-evals-')); return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) } }

test('bundled discovery matches the complete research catalog and packages contain actionable resources', () => {
  const found = readdirSync(skills, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  assert.equal(found.length, RESEARCH_SKILLS.length)
  assert.ok(found.length >= 100)
  for (const name of found) {
    const text = readFileSync(join(skills, name, 'SKILL.md'), 'utf8')
    const front = yaml.load(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)![1]!) as Record<string, unknown>
    assert.equal(front.name, name)
    assert.ok(typeof front.description === 'string' && front.description.length > 30)
    if (packages.includes(name)) {
      assert.ok(text.length > 700)
      assert.ok(readdirSync(join(skills, name, 'evals')).length)
      assert.ok(readdirSync(join(skills, name, 'templates')).length)
    }
  }
})

test('structured figure templates validate and remain explicitly demonstration-only', () => {
  for (const [name, template] of [['scientific-diagram', 'method-diagram.json'], ['editable-presentation', 'chart-spec.json']]) {
    const spec = validateFigureSpec(JSON.parse(readFileSync(join(skills, name!, 'templates', template!), 'utf8')))
    assert.equal(spec.provenance.isDemo, true)
  }
})

test('data audit eval cases block malformed/leaky inputs without mutating source', { skip: !python }, () => {
  const f = temp()
  try {
    const cases = JSON.parse(readFileSync(join(skills, 'data-audit/evals/cases.json'), 'utf8')) as Array<{ input: string; args: string[]; name: string; expect: string }>
    for (const item of cases) {
      const input = join(f.root, 'input.csv'), output = join(f.root, 'audit.json')
      writeFileSync(input, item.input)
      const result = run('data-audit', 'audit_data.py', [input, ...item.args, '--out', output])
      assert.equal(result.status, item.name === 'clean' ? 0 : 1, result.stderr)
      assert.equal(readFileSync(input, 'utf8'), item.input)
      const report = JSON.parse(readFileSync(output, 'utf8'))
      assert.equal(report.version, 1)
      if (item.name !== 'clean') assert.ok(report.blockers.length)
    }
  } finally { f.cleanup() }
})

test('statistics uses matched IDs, deterministic paired intervals and rejects pseudoreplication', { skip: !python }, () => {
  const f = temp()
  try {
    const input = join(f.root, 'comparison.csv'), output = join(f.root, 'stats.json')
    writeFileSync(input, 'unit_id,group,value\na,baseline,1\nb,baseline,2\na,proposed,3\nb,proposed,4\n')
    const args = [input, '--control', 'baseline', '--treatment', 'proposed', '--unit', 'participant', '--resamples', '1000', '--paired', '--out', output]
    assert.equal(run('statistical-analysis', 'compare_groups.py', args).status, 0)
    const first = readFileSync(output, 'utf8'), report = JSON.parse(first)
    assert.equal(report.difference, 2)
    assert.deepEqual(report.ci95, [2, 2])
    assert.equal(run('statistical-analysis', 'compare_groups.py', args).status, 0)
    assert.equal(readFileSync(output, 'utf8'), first)
    writeFileSync(input, 'unit_id,group,value\na,baseline,1\na,baseline,2\na,proposed,3\nb,proposed,4\n')
    assert.equal(run('statistical-analysis', 'compare_groups.py', args).status, 1)
  } finally { f.cleanup() }
})

test('reproducibility verifies hashes but never executes the recorded command', { skip: !python }, () => {
  const f = temp()
  try {
    const source = join(f.root, 'artifact.txt'), manifest = join(f.root, 'manifest.json'), output = join(f.root, 'report.json')
    writeFileSync(source, 'real artifact')
    writeFileSync(manifest, JSON.stringify({ command: 'DO NOT EXECUTE THIS COMMAND', environment: 'test Python standard library', samplingUnit: 'participant', seeds: [42], files: [{ path: 'artifact.txt', sha256: createHash('sha256').update('real artifact').digest('hex') }] }))
    assert.equal(run('reproducibility', 'verify_manifest.py', [manifest, '--root', f.root, '--out', output]).status, 0)
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).rerunExecuted, false)
    writeFileSync(source, 'modified')
    assert.equal(run('reproducibility', 'verify_manifest.py', [manifest, '--root', f.root, '--out', output]).status, 1)
    assert.match(readFileSync(output, 'utf8'), /Hash mismatch/)
  } finally { f.cleanup() }
})

test('citation audit distinguishes local key matching from reviewed sentence support', { skip: !python }, () => {
  const f = temp()
  try {
    const manuscript = join(f.root, 'draft.txt'), references = join(f.root, 'refs.json'), claims = join(f.root, 'claims.json'), output = join(f.root, 'audit.json')
    writeFileSync(manuscript, 'A measured difference was observed [@ref1].')
    writeFileSync(references, JSON.stringify([{ id: 'ref1', title: 'Real local source fixture', doi: '10.0000/test-fixture' }]))
    const mapping = [{ claim: 'A measured difference was observed', sourceId: 'ref1', quote: 'Measured difference', locator: 'p. 2', supportReviewed: false }]
    writeFileSync(claims, JSON.stringify(mapping))
    const args = [manuscript, '--references', references, '--claims', claims, '--out', output]
    assert.equal(run('citation-audit', 'audit_citations.py', args).status, 1)
    mapping[0]!.supportReviewed = true
    writeFileSync(claims, JSON.stringify(mapping))
    assert.equal(run('citation-audit', 'audit_citations.py', args).status, 0)
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).networkUsed, false)
  } finally { f.cleanup() }
})

test('editability checker accepts native data chart and rejects an image-only slide', { skip: !python }, async () => {
  const f = temp()
  try {
    const path = join(f.root, 'native.pptx'), output = join(f.root, 'editability.json')
    const spec = validateFigureSpec(JSON.parse(readFileSync(join(skills, 'editable-presentation/templates/chart-spec.json'), 'utf8')))
    writeFileSync(path, await figureToPptx(spec))
    assert.equal(run('editable-presentation', 'check_editable.py', [path, '--expect', 'chart', '--out', output]).status, 0)
    const report = JSON.parse(readFileSync(output, 'utf8'))
    assert.ok(report.nativeCharts > 0 && report.embeddedWorkbooks > 0)
    const fake = new JSZip()
    fake.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:pic/></p:spTree></p:cSld></p:sld>')
    writeFileSync(path, await fake.generateAsync({ type: 'nodebuffer' }))
    assert.equal(run('editable-presentation', 'check_editable.py', [path, '--expect', 'chart', '--out', output]).status, 1)
    assert.match(readFileSync(output, 'utf8'), /picture is insufficient/)
  } finally { f.cleanup() }
})
