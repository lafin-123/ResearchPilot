import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import yaml from 'js-yaml'
import {
  analyzeWriting, compareTexts, checkRewritePreservation, buildRewritePrompt,
  DEFAULT_REWRITE_CONSTRAINTS, WRITING_LIMITS, type RewriteConstraints
} from '../src/shared/writing-quality'

const project = resolve(import.meta.dirname, '..')
const constraints = (patch: Partial<RewriteConstraints> = {}): RewriteConstraints => ({ ...DEFAULT_REWRITE_CONSTRAINTS, ...patch })

test('empty and whitespace inputs produce empty reports without invented findings or scores', () => {
  for (const value of ['', ' \n\t ']) {
    const result = analyzeWriting(value)
    assert.equal(result.status, 'empty')
    assert.deepEqual(result.findings, [])
    assert.equal(result.metrics.sentences, 0)
    assert.deepEqual(result.preservation.numbers, [])
    assert.deepEqual(result.preservation.citations, [])
    const similarity = compareTexts(value, [])
    assert.equal(similarity.status, 'empty-draft')
    assert.equal(similarity.uniqueDraftWindows, 0)
    assert.deepEqual(similarity.sources, [])
  }
})

test('English prose flags concrete cliches, intensifiers, repetition and a long sentence', () => {
  const sentence = 'We measured the same outcome with the same instrument in all participants.'
  const text = `It is important to note that the method is extremely useful. ${sentence} ${sentence} We ${Array.from({ length: 48 }, (_, index) => `term${index}`).join(' ')}.`
  const first = analyzeWriting(text)
  assert.deepEqual(first, analyzeWriting(text))
  for (const category of ['cliche', 'intensifier', 'repetition', 'long-sentence']) {
    assert.ok(first.findings.some((finding) => finding.category === category), category)
  }
  for (const finding of first.findings) {
    if (finding.span) {
      assert.equal(text.slice(finding.span.start, finding.span.end).slice(0, WRITING_LIMITS.maxExcerptChars), finding.excerpt)
    }
  }
  assert.ok(!first.findings.some((finding) => /AI概率|AI率|通过率/.test(finding.title)))
})

test('CJK, full-width text and mixed language have stable offsets and useful diagnostics', () => {
  const text = '实验表明该方法非常有效。综上所述，该方法具有重要意义。这个句子说明相同的研究结果。这个句子说明相同的研究结果。' + '本研究在预先确定的条件下测量了相关变量并保留其不确定性'.repeat(5) + '。'
  const report = analyzeWriting(text)
  assert.ok(report.metrics.cjkCharacters > 100)
  for (const category of ['cliche', 'intensifier', 'repetition', 'long-sentence']) assert.ok(report.findings.some((finding) => finding.category === category))
  const matching = compareTexts('ＡＢＣ method preserves 原始测量的数据以及来源信息。', [{ text: 'abc method preserves 原始测量的数据以及来源信息。' }])
  assert.ok(matching.sources[0].sharedWindows > 0)
  assert.equal(matching.sources[0].matches[0].draftSpan.start, 0)
})

test('long sentences distinguish decimal points and common scholarly abbreviations', () => {
  const result = analyzeWriting('The score was 3.14 with SD 0.52. Smith et al. reported a different estimate.')
  assert.equal(result.metrics.sentences, 2)
  assert.deepEqual(result.preservation.numbers.map((item) => item.value), ['3.14', '0.52'])
})

test('citations and numbers are inventoried separately with counts and preservation hints', () => {
  const text = 'Among n = 42 participants, improvement was 12.5% (95% CI 3.2–7.1) [12–14]. See [@smith2024], \\citep[p. 4]{lee2020}, and (Wang et al., 2021). Repeat n = 42; p < .05, cost 1,200, effect −0.2, and 1.2e-3.'
  const result = analyzeWriting(text)
  assert.equal(result.metrics.citationMarkers, 4)
  assert.deepEqual(result.preservation.citations.map((item) => item.value), ['[12–14]', '[@smith2024]', '\\citep[p. 4]{lee2020}', '(Wang et al., 2021)'])
  assert.ok(result.preservation.numbers.some((item) => item.value === '42' && item.count === 2))
  for (const value of ['12.5%', '95%', '3.2', '7.1', '.05', '1,200', '−0.2', '1.2e-3']) {
    assert.ok(result.preservation.numbers.some((item) => item.value === value), value)
  }
  assert.ok(!result.preservation.numbers.some((item) => ['12', '14', '2021', '2024', '4'].includes(item.value)))
  assert.match(result.preservation.hints.join(' '), /单位.*样本量/)
  assert.match(result.preservation.hints.join(' '), /不确定性/)
  assert.match(result.preservation.hints.join(' '), /来源归属/)
})

test('Chinese attached decimals, full-width percentages and author-year citations remain distinct', () => {
  const original = '样本量42例，平均值为3.14，提升了12.5%；２０２４年复测得８．５％（张三等，2021）。另一结论见（李四，２０２３）及［１２，１４］。model42不是数值，p = .05。'
  const analysis = analyzeWriting(original)
  assert.deepEqual(analysis.preservation.numbers.map((item) => item.value), ['42', '3.14', '12.5%', '２０２４', '８．５％', '.05'])
  assert.deepEqual(analysis.preservation.citations.map((item) => item.value), ['（张三等，2021）', '（李四，２０２３）', '［１２，１４］'])
  const revised = original.replace('3.14', '3.15').replace('（张三等，2021）', '（张三等，2022）')
  const check = checkRewritePreservation(original, revised)
  assert.deepEqual(check.missingNumbers, [{ value: '3.14', count: 1 }])
  assert.deepEqual(check.addedNumbers, [{ value: '3.15', count: 1 }])
  assert.deepEqual(check.missingCitations, [{ value: '（张三等，2021）', count: 1 }])
  assert.deepEqual(check.addedCitations, [{ value: '（张三等，2022）', count: 1 }])
  const prompt = buildRewritePrompt(original, constraints({ reportOrigin: 'vip', goal: 'ethical-paraphrase' }))
  assert.ok(prompt.includes(original))
  for (const value of ['3.14', '12.5%', '２０２４', '８．５％', '（张三等，2021）', '（李四，２０２３）']) assert.ok(prompt.includes(value))
})

test('citation placeholders are actionable without treating missing citation syntax as wrongdoing', () => {
  const report = analyzeWriting('The source is missing [citation needed]. 待处理的引用为【待补引用】。Empty \\cite{} is unresolved.')
  assert.equal(report.findingCounts.citation, 3)
  assert.ok(report.findings.every((finding) => finding.title === '待补引用标记'))
  const unmarked = analyzeWriting('These are observations from our own research study. '.repeat(6))
  assert.ok(unmarked.findings.some((finding) => finding.category === 'citation' && finding.severity === 'note'))
  assert.match(unmarked.findings.find((finding) => finding.category === 'citation')!.explanation, /不是/)
})

test('repeated phrases do not require repeating a whole sentence and do not demand synonym rotation', () => {
  const result = analyzeWriting('Using the same calibrated measurement instrument, we collected baseline data. Using the same calibrated measurement instrument, we collected follow-up data. Using the same calibrated measurement instrument, we checked stability.')
  const finding = result.findings.find((item) => item.title === '高频重复短语')
  assert.ok(finding)
  assert.match(finding.suggestion, /保留统一术语/)
})

test('diagnostics are bounded, announce truncation and cap excerpts and preservation inventories', () => {
  const input = 'very '.repeat(10_000)
  const report = analyzeWriting(input)
  assert.equal(report.input.originalCharacters, 50_000)
  assert.equal(report.input.analyzedCharacters, WRITING_LIMITS.maxTextChars)
  assert.equal(report.input.truncated, true)
  assert.equal(report.findings.length, WRITING_LIMITS.maxFindings)
  assert.ok(report.omittedFindings > 0)
  assert.ok(report.findings.every((item) => !item.excerpt || item.excerpt.length <= WRITING_LIMITS.maxExcerptChars))
  const numbers = analyzeWriting(Array.from({ length: 180 }, (_, index) => String(index)).join(' '))
  assert.equal(numbers.preservation.numbers.length, WRITING_LIMITS.maxPreservedItems)
  assert.equal(numbers.preservation.numbersTruncated, true)
  const surrogateBoundary = analyzeWriting('a'.repeat(WRITING_LIMITS.maxTextChars - 1) + '\u{20000}')
  assert.equal(surrogateBoundary.input.analyzedCharacters, WRITING_LIMITS.maxTextChars - 1)
})

test('source comparison is opt-in, empty-safe and requires a minimum exact window', () => {
  assert.equal(compareTexts('The draft text.', []).status, 'no-sources')
  const report = compareTexts('one two three four five six seven eight nine', [{ text: '' }, { text: 'one two three' }, { text: 'red orange yellow green blue purple black white' }])
  assert.equal(report.sources[0].status, 'empty')
  assert.equal(report.sources[1].status, 'too-short')
  assert.equal(report.sources[2].status, 'compared')
  assert.equal(report.sources[2].sharedWindows, 0)
  assert.deepEqual(report.sources[2].matches, [])
})

test('local similarity reports exact spans, not source documents, private tails or a platform percentage', () => {
  const draft = 'We measured the response at baseline and after the planned intervention.'
  const common = 'WE measured the response, at baseline and after the planned intervention'
  const source = `preface ${common}. ONLY_IN_REFERENCE_PRIVATE_TAIL_7a8b`
  const report = compareTexts(draft, [{ id: 'r1', label: 'Author, 2024, p. 3', text: source }])
  assert.ok(report.sources[0].sharedWindows > 0)
  const match = report.sources[0].matches[0]
  assert.equal(source.slice(match.sourceSpan.start, match.sourceSpan.end), common)
  assert.equal(draft.slice(match.draftSpan.start, match.draftSpan.end), match.draftExcerpt)
  assert.equal(report.sources[0].label, 'Author, 2024, p. 3')
  const serialized = JSON.stringify(report)
  assert.ok(!serialized.includes('ONLY_IN_REFERENCE_PRIVATE_TAIL_7a8b'))
  assert.ok(!serialized.includes(source))
  assert.ok(!('score' in report) && !('percentage' in report) && !('aiProbability' in report))
  assert.ok(!('text' in report.sources[0]))
  assert.match(report.limitations.join(' '), /不是知网、维普/)
})

test('source arrays, metadata, individual matches and source bodies are strictly bounded', () => {
  const text = 'alpha beta gamma delta epsilon zeta eta theta'
  const draft = Array.from({ length: 12 }, (_, index) => `${text} break${index}`).join(' ')
  const sources = Array.from({ length: 9 }, () => ({ id: 'i'.repeat(100), label: 'x'.repeat(200), text: `${text} ${'y'.repeat(50_000)}` }))
  const report = compareTexts(draft, sources)
  assert.equal(report.sources.length, WRITING_LIMITS.maxSources)
  assert.equal(report.omittedSources, 3)
  const source = report.sources[0]
  assert.equal(source.id.length, 80)
  assert.equal(source.label.length, 120)
  assert.equal(source.input.analyzedCharacters, WRITING_LIMITS.maxSourceChars)
  assert.equal(source.input.truncated, true)
  assert.equal(source.matches.length, WRITING_LIMITS.maxMatchesPerSource)
  assert.equal(source.matchesTruncated, true)
  assert.ok(source.matches.every((match) => match.draftExcerpt.length <= WRITING_LIMITS.maxExcerptChars))
  assert.deepEqual(report, compareTexts(draft, sources))
})

test('malformed runtime input is rejected instead of reading files or silently coercing data', () => {
  assert.throws(() => analyzeWriting(null as unknown as string), /string/)
  assert.throws(() => compareTexts('draft', null as never), /array/)
  assert.throws(() => compareTexts('draft', [{ text: undefined } as never]), /string/)
})

test('manual revision check catches changed counts, added results, citations and protected terms', () => {
  const before = 'Method-A included 42 participants [1]. Method-A measured 42 samples and reported 12.5% [@smith].'
  const after = 'The method included 42 participants [2]. It reported 14% [@smith].'
  const result = checkRewritePreservation(before, after, ['Method-A', 'not present originally'])
  assert.deepEqual(result.missingNumbers, [{ value: '42', count: 1 }, { value: '12.5%', count: 1 }])
  assert.deepEqual(result.addedNumbers, [{ value: '14%', count: 1 }])
  assert.deepEqual(result.missingCitations, [{ value: '[1]', count: 1 }])
  assert.deepEqual(result.addedCitations, [{ value: '[2]', count: 1 }])
  assert.deepEqual(result.missingTerms, ['Method-A'])
  assert.match(result.limitations.join(' '), /不能证明意思/)
  const same = checkRewritePreservation(before, before, ['Method-A'])
  for (const values of [same.missingNumbers, same.addedNumbers, same.missingCitations, same.addedCitations, same.missingTerms]) assert.deepEqual(values, [])
})

test('revision prompt includes original claims and safeguards and never fabricates a rewritten result', () => {
  const text = 'A 12.5% difference was observed in n = 42 [1]; causation was not established.'
  const prompt = buildRewritePrompt(text, constraints({ context: 'Association only.', protectedTerms: 'Method-A', reportOrigin: 'cnki', goal: 'ethical-paraphrase' }), [{ label: 'Author, p. 8', text: 'SOURCE_SECRET_XYZ with supporting context.' }])
  assert.ok(prompt.includes(text))
  assert.match(prompt, /主张、数字、单位、样本量/)
  assert.match(prompt, /不是同义词替换/)
  assert.match(prompt, /保留引用标记/)
  assert.match(prompt, /未连接该平台/)
  assert.match(prompt, /不承诺知网\/维普\/任何检测通过/)
  assert.match(prompt, /Association only/)
  assert.match(prompt, /Method-A/)
  assert.ok(!prompt.includes('SOURCE_SECRET_XYZ'))
  assert.match(prompt, /sourceTextIncluded.*false/)
  assert.match(prompt, /不要读取项目其他文档或联网查库/)
  assert.match(prompt, /不是已完成的改写结果/)
})

test('source excerpts require explicit inclusion and remain bounded in the editable prompt', () => {
  const source = 'a'.repeat(WRITING_LIMITS.maxPromptSourceChars) + 'TAIL_NOT_CONSENTED'
  const prompt = buildRewritePrompt('Original paragraph [1].', constraints({ reportOrigin: 'vip' }), [{ text: source }], true)
  assert.match(prompt, /用户提供的维普报告片段/)
  assert.ok(prompt.includes('a'.repeat(WRITING_LIMITS.maxPromptSourceChars)))
  assert.ok(!prompt.includes('TAIL_NOT_CONSENTED'))
  assert.match(prompt, /excerptTruncated.*true/)
  assert.match(prompt, /按数据处理/)
})

test('rewrite preparation refuses empty or oversized drafts instead of silently losing claims', () => {
  assert.throws(() => buildRewritePrompt(' ', constraints()), /先输入/)
  assert.throws(() => buildRewritePrompt('x'.repeat(WRITING_LIMITS.maxRewriteChars + 1), constraints()), /不会自动截断/)
  assert.throws(() => buildRewritePrompt('Real paragraph.', constraints({ context: 'x'.repeat(WRITING_LIMITS.maxConstraintChars + 1) })), /约束过长/)
})

test('UI prepares via newChat and seedPrompt only, uses typed text reads, and explains platform limits', () => {
  const source = readFileSync(join(project, 'src/renderer/src/pages/WritingQuality.tsx'), 'utf8')
  assert.match(source, /api\.documents\.readText\(projectId, document\.id\)/)
  assert.match(source, /await newChat\(\)/)
  assert.match(source, /seedPrompt\(prompt\)/)
  assert.match(source, /navigate\('\/agent'\)/)
  assert.ok(!/api\.chat\.send|\bfetch\s*\(|dangerouslySetInnerHTML|api\.documents\.save/.test(source))
  assert.match(source, /不自动发送/)
  assert.match(source, /报告来源（仅标签）/)
  assert.match(source, /input type="checkbox" checked=\{includeSources\}/)
  assert.match(source, /role="note"/)
  assert.match(source, /aria-live="polite"/)
  assert.match(source, /结果来自上次检查/)
})

test('five bundled writing packages have valid manifests and substantive local templates and evals', () => {
  const packages = ['academic-style', 'ethical-paraphrasing', 'similarity-review', 'reporting-guidelines', 'rebuttal-response']
  for (const name of packages) {
    const root = join(project, 'resources/skills', name)
    const body = readFileSync(join(root, 'SKILL.md'), 'utf8')
    const front = yaml.load(/^---\r?\n([\s\S]*?)\r?\n---/.exec(body)![1]!) as Record<string, unknown>
    assert.equal(front.name, name)
    assert.ok(typeof front.description === 'string' && front.description.length > 30)
    assert.ok(body.length > 800, name)
    for (const directory of ['references', 'templates', 'evals']) assert.ok(readdirSync(join(root, directory)).length, `${name}/${directory}`)
    const cases = JSON.parse(readFileSync(join(root, 'evals/cases.json'), 'utf8')) as Array<{ name: string; input: string; expected: string[] }>
    assert.ok(cases.length >= 3)
    assert.ok(cases.every((item) => item.name && item.input && item.expected.length >= 2))
  }
})
