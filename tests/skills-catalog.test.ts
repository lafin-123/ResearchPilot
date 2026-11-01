import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'

const root = resolve('resources/skills')
const catalog = () => import('../src/shared/research-skills')
const interaction = () => import('../src/shared/research-interaction')

test('actual bundled skills meet the minimum requested count before catalog integration', () => {
  assert.ok(readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).length >= 100)
})

test('at least 100 distinct catalog entries match actual bundled skill directories', async () => {
  const { RESEARCH_SKILLS } = await catalog()
  assert.ok(RESEARCH_SKILLS.length >= 100)
  assert.equal(new Set(RESEARCH_SKILLS.map(s => s.name)).size, RESEARCH_SKILLS.length)
  const directories = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
  assert.deepEqual(RESEARCH_SKILLS.map(s => s.name).sort(), directories)
  for (const skill of RESEARCH_SKILLS) {
    const text = readFileSync(join(root, skill.name, 'SKILL.md'), 'utf8')
    const meta = yaml.load(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)![1]) as Record<string, unknown>
    assert.equal(meta.name, skill.name)
    assert.ok(skill.label && skill.input && skill.output && skill.limit && skill.steps.length >= 3, skill.name)
    assert.ok(text.length > 700, skill.name)
    assert.ok(existsSync(join(root, skill.name, 'templates')), skill.name)
    assert.ok(existsSync(join(root, skill.name, 'evals')), skill.name)
    if (!skill.legacy) {
      assert.ok(text.includes(skill.steps[0]), skill.name)
      const template = JSON.parse(readFileSync(join(root, skill.name, 'templates/workbook.json'), 'utf8'))
      assert.equal(template.skill, skill.name)
      assert.equal(template.status, 'draft')
      const cases = JSON.parse(readFileSync(join(root, skill.name, 'evals/cases.json'), 'utf8'))
      assert.equal(cases.length, 3)
      assert.ok(cases.some((c: {kind: string}) => c.kind === 'missing-input'))
      assert.ok(cases.some((c: {kind: string}) => c.kind === 'unsafe-or-inapplicable'))
    }
  }
})

test('catalog searches Chinese, English and keywords; custom skills survive categories and overrides', async () => {
  const { RESEARCH_SKILLS, filterResearchSkills, effectiveResearchSkills } = await catalog()
  const records = RESEARCH_SKILLS.map(s => ({ name: s.name, scope: 'builtin', description: '', whenToUse: '' })) as any[]
  assert.ok(filterResearchSkills(records, '全文', 'all').some(s => s.name === 'fulltext-claim-check'))
  assert.ok(filterResearchSkills(records, 'journal', 'all').some(s => s.name === 'journal-revision'))
  assert.ok(filterResearchSkills(records, '森林图', 'all').length)
  const custom = { name: 'my-method', scope: 'project', description: '自定义方法', whenToUse: '' }
  const overridden = { ...records[0], scope: 'project' }
  const effective = effectiveResearchSkills([...records, custom, overridden])
  assert.equal(effective.filter(s => s.name === overridden.name).length, 1)
  assert.equal(effective.find(s => s.name === overridden.name)?.scope, 'project')
  assert.deepEqual(filterResearchSkills(effective, '自定义', 'custom'), [custom])
  assert.deepEqual(filterResearchSkills(effective, 'no-such-skill-xyz', 'all'), [])
})

test('clarification defaults and all modes retain scientific blockers and operation approval', async () => {
  const { normalizeClarification, clarificationInstruction, CLARIFICATION_OPTIONS } = await interaction()
  assert.equal(normalizeClarification(undefined), 'balanced')
  assert.equal(normalizeClarification('invalid'), 'balanced')
  for (const option of CLARIFICATION_OPTIONS) {
    assert.equal(normalizeClarification(option.value), option.value)
    const text = clarificationInstruction(option.value)
    assert.match(text, /审批/)
    assert.match(text, /采样单位/)
    assert.match(text, /不.*编造/)
    assert.match(text, /全文/)
  }
  assert.match(clarificationInstruction('minimal'), /默认/)
  assert.match(clarificationInstruction('guided'), /集中/)
})

test('empty optional task fields work and modes are visible in prepared draft', async () => {
  const { buildSkillTask, RESEARCH_SKILLS } = await catalog()
  const skill = { name: 'journal-revision', scope: 'builtin', path: 'C:/skills/journal-revision/SKILL.md', description: 'test', whenToUse: '' } as any
  const text = buildSkillTask(skill, {}, 'minimal')
  assert.match(text, /journal-revision/)
  assert.match(text, /少打断/)
  assert.match(text, /可选/)
  assert.match(text, /审批/)
  assert.match(buildSkillTask(skill, { goal: '保留主要结论', inputs: '全文已提供', output: '修改表' }, 'guided'), /保留主要结论/)
  assert.ok(RESEARCH_SKILLS.find(s => s.name === 'fulltext-claim-check')?.limit.includes('全文'))
})
