import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import type { ToneDetection, ToneReview } from '../src/shared/writing-tone'

const source = '# 结果\n\n说白了，本研究观察到相关性，n=42，差值2.1 [3]。\n\n这意味着需要进一步验证。'

test('tone edits are exact, minimal, preserve scientific tokens and reject stale originals', async () => {
  const { validateToneEdits, applyToneEdits } = await import('../src/shared/writing-tone')
  const edits = validateToneEdits(source, [{ before: '说白了，本研究观察到相关性，n=42，差值2.1 [3]。', after: '本研究观察到相关性，n=42，差值2.1 [3]。', reason: '删去不承担信息的起手式', rule: 'A 起手式' }], ['相关性'])
  assert.equal(edits.length, 1)
  assert.equal(applyToneEdits(source, source, edits), source.replace('说白了，', ''))
  assert.throws(() => applyToneEdits(source + '新编辑', source, edits), /原文已变化/)
  assert.throws(() => validateToneEdits(source, [{ ...edits[0], after: edits[0].after.replace('42', '43') }], []), /数字|引用|术语/)
  assert.throws(() => validateToneEdits(source, [{ ...edits[0], after: edits[0].after.replace('[3]', '[4]') }], []), /数字|引用|术语/)
  assert.throws(() => validateToneEdits(source, [{ ...edits[0], after: edits[0].after.replace('相关性', '因果') }], ['相关性']), /数字|引用|术语/)
})

test('tone edits reject ambiguous, overlapping, structural and excluded-rule changes', async () => {
  const { validateToneEdits } = await import('../src/shared/writing-tone')
  const edit = { before: '重复', after: '改写', reason: '原因', rule: 'A' }
  assert.throws(() => validateToneEdits('重复重复', [edit], []), /唯一/)
  assert.throws(() => validateToneEdits(source, [{ ...edit, before: '# 结果', after: '# 发现' }], []), /结构/)
  assert.throws(() => validateToneEdits(source, [{ ...edit, before: '这意味着', rule: 'X 已否决' }], []), /规则/)
  assert.throws(() => validateToneEdits('```python\nx = value\n```', [{ ...edit, before: 'value' }], []), /结构/)
  assert.throws(() => validateToneEdits('$x=y$', [{ ...edit, before: 'x=y' }], []), /结构/)
  assert.throws(() => validateToneEdits('一段文字', [{ ...edit, before: '一段' }, { ...edit, before: '段文' }], []), /重叠/)
  assert.throws(() => validateToneEdits(source, [{ ...edit, before: '不存在' }], []), /唯一/)
  assert.deepEqual(validateToneEdits(source, [], []), [])
})

test('protected terms and paragraph structure survive every local edit', async () => {
  const { validateToneEdits, applyToneEdits } = await import('../src/shared/writing-tone')
  const edit = { before: 'PCR检测需要PCR试剂。', after: 'PCR检测需要PC试剂。', reason: '调整', rule: 'A 起手式' }
  assert.throws(() => validateToneEdits(edit.before, [edit], ['PCR']), /术语/)
  assert.throws(() => validateToneEdits(edit.before, [{ ...edit, before: 'R试剂', after: '试剂' }], ['PCR']), /术语/)
  const combined = [{ ...edit, before: '说明', after: '*' }, { ...edit, before: '结果', after: ' 结果' }]
  assert.throws(() => applyToneEdits('说明结果。', '说明结果。', combined), /结构/)
  for (const after of ['* 结果段落。', '    结果段落。', '结果\r段落。', '结果 段落。']) {
    const patch = { ...edit, before: '结果段落。', after }
    assert.throws(() => validateToneEdits(patch.before, [patch], []), /结构/)
    assert.throws(() => applyToneEdits(patch.before, patch.before, [patch]), /结构/)
  }
})

test('native research draft prompts use academic tone guidance without claiming detection', async () => {
  const { researchPrompt, createResearchWorkspace } = await import('../src/shared/research-workflows')
  const prompt = researchPrompt(createResearchWorkspace('brainstorm', '研究主题'), 'draft')
  assert.match(prompt, /lieflat-less-ai-tone/)
  assert.match(prompt, /脚本未执行/)
})

test('built-in tone skill participates in prepared academic requests', async () => {
  const { buildRewritePrompt, DEFAULT_REWRITE_CONSTRAINTS } = await import('../src/shared/writing-quality')
  const prompt = buildRewritePrompt(source, { ...DEFAULT_REWRITE_CONSTRAINTS })
  assert.match(prompt, /lieflat-less-ai-tone/)
  assert.match(prompt, /academic-adaptation/)
  assert.match(prompt, /先.*建议/)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const detection: ToneDetection = { status: 'completed', reason: '', metrics: { fixture: true }, candidates: [] }
const report: ToneReview = {
  sourceHash: 'fixture', createdAt: '', skillVersion: '', summary: '建议删除起手式', retained: [],
  edits: [{ before: '说白了，', after: '', reason: '删除起手式', rule: 'A 起手式' }],
  detection, providerId: 'fixture', modelId: 'fixture'
}
const require = createRequire(import.meta.url)
const panelBundle = build({
  entryPoints: [resolve('src/renderer/src/components/WritingTonePanel.tsx')],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
  tsconfig: resolve('tsconfig.web.json'),
  plugins: [{ name: 'panel-boundaries', setup(builder) {
    builder.onResolve({ filter: /^(\.\.\/lib\/api|\.\/Ui)$/ }, args => ({ path: args.path, external: true }))
  } }]
})

type Element = { type: unknown; props: { children?: unknown; disabled?: boolean; onClick?: () => void } }
async function panelHarness() {
  // Execute the real component and event handlers with deterministic hook storage;
  // no DOM emulator or model/Python execution is needed for these state transitions.
  const slots: unknown[] = []
  const cleanups: Array<() => void> = []
  const operationIds: Array<string | undefined> = []
  const stoppedIds: Array<string | undefined> = []
  let cursor = 0
  const messages: Array<{ kind: string; text: string }> = []
  const inspections: ReturnType<typeof deferred<ToneDetection>>[] = []
  const reviews: ReturnType<typeof deferred<ToneReview>>[] = []
  const stops: ReturnType<typeof deferred<void>>[] = []
  const adopted: string[] = []
  const api = { writingTone: {
    inspect: (_input: unknown, operationId?: string) => { operationIds.push(operationId); const pending = deferred<ToneDetection>(); inspections.push(pending); return pending.promise },
    review: (_input: unknown, operationId?: string) => { operationIds.push(operationId); const pending = deferred<ToneReview>(); reviews.push(pending); return pending.promise },
    stop: (operationId?: string) => { stoppedIds.push(operationId); const pending = deferred<void>(); stops.push(pending); return pending.promise }
  } }
  const props = { projectId: 'p', text: source, protectedTerms: '', context: '', disabled: false, revisionText: '', onAdopt: (text: string) => { adopted.push(text) } }
  const hooks = {
    ...require('react'),
    useRef: (value: unknown) => { const index = cursor++; return slots[index] ??= { current: value } },
    useState: (value: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], (next: unknown) => { slots[index] = next }] },
    useEffect: (effect: () => void | (() => void)) => { const index = cursor++; if (!(index in slots)) { slots[index] = true; const cleanup = effect(); if (cleanup) cleanups.push(cleanup) } }
  }
  const module = { exports: {} as { WritingTonePanel: (value: typeof props) => Element } }
  new Function('require', 'module', 'exports', (await panelBundle).outputFiles[0].text)((name: string) => {
    if (name === 'react') return hooks
    if (name === './Ui') return { Button: 'button' }
    if (name === '../lib/api') return { api, formatError: (error: unknown) => error instanceof Error ? error.message : String(error) }
    if (name === 'sonner') return { toast: Object.fromEntries(['success', 'warning', 'error', 'info'].map(kind => [kind, (text: string) => messages.push({ kind, text })])) }
    return require(name)
  }, module, module.exports)
  const render = () => { cursor = 0; return module.exports.WritingTonePanel(props) }
  const textOf = (node: unknown): string => {
    if (Array.isArray(node)) return node.map(textOf).join('')
    if (node && typeof node === 'object' && 'props' in node) return textOf((node as Element).props.children)
    return typeof node === 'string' ? node : ''
  }
  const buttons = (node: unknown = render()): Element[] => {
    if (Array.isArray(node)) return node.flatMap(child => buttons(child))
    if (!node || typeof node !== 'object' || !('props' in node)) return []
    const element = node as Element
    return [...(element.type === 'button' ? [element] : []), ...buttons(element.props.children ?? null)]
  }
  const button = (label: RegExp) => buttons().find(element => label.test(textOf(element)))
  const click = (label: RegExp) => { const element = button(label); assert.ok(element, `Missing button ${label}`); assert.ok(!element.props.disabled, `Disabled button ${label}`); element.props.onClick!() }
  return { props, inspections, reviews, stops, adopted, messages, render, textOf, button, click, operationIds, stoppedIds,
    unmount: () => { for (const cleanup of cleanups.splice(0)) cleanup() } }
}

async function settle() {
  // Let the component's promise continuations and finally blocks finish.
  await new Promise<void>(done => setImmediate(done))
}

for (const kind of ['inspect', 'review', 'adopt'] as const) {
  test(`panel can stop ${kind}, keeps pending work busy and preserves edits without applying late results`, async () => {
    const previousWindow = globalThis.window
    Object.assign(globalThis, { window: { confirm: () => true } })
    try {
      const panel = await panelHarness()
      if (kind === 'adopt') {
        panel.click(/用内置技能生成建议/)
        panel.reviews[0].resolve(report)
        await settle()
        panel.click(/按这些建议生成修订稿/)
      } else panel.click(kind === 'inspect' ? /仅运行内置脚本/ : /用内置技能生成建议/)
      panel.click(/停止检查/)
      assert.equal(panel.stops.length, 1)
      assert.ok(panel.button(/正在停止/)?.props.disabled)
      panel.props.text += '\n用户在运行期间的原文编辑'
      panel.props.revisionText = '用户在运行期间的修订编辑'
      const preserved = { ...panel.props }
      panel.render()
      panel.stops[0].resolve()
      await settle()
      assert.ok(panel.button(/正在停止/), 'Stop acknowledgement must not reset busy while the operation is still pending')
      assert.ok(panel.button(/仅运行内置脚本|检测中/)?.props.disabled)
      assert.ok(panel.button(/用内置技能生成建议|正在生成建议/)?.props.disabled)
      if (kind === 'review') panel.reviews[0].resolve(report)
      else panel.inspections[0].resolve(detection)
      await settle()
      assert.equal(panel.button(/停止检查|正在停止/), undefined)
      assert.equal(panel.button(/仅运行内置脚本/)?.props.disabled, false)
      assert.deepEqual(panel.props, preserved)
      assert.deepEqual(panel.adopted, [])
      assert.equal(panel.messages.some(item => item.kind === 'success'), false)
      assert.ok(panel.messages.some(item => /已停止/.test(item.text)), 'Cancellation is reported as stopped, not success')
      if (kind !== 'adopt') assert.ok(!panel.textOf(panel.render()).includes(report.summary), 'A cancelled review must not replace the current report')
    } finally { Object.assign(globalThis, { window: previousWindow }) }
  })
}

for (const kind of ['inspect', 'review', 'adopt'] as const) {
  test(`unmount immediately cancels only the panel-owned pending ${kind}`, async () => {
    const previousWindow = globalThis.window
    Object.assign(globalThis, { window: { confirm: () => true } })
    try {
      const idle = await panelHarness()
      idle.render(); idle.unmount()
      assert.equal(idle.stops.length, 0, 'An idle panel must not cancel another panel’s singleton operation')
      const panel = await panelHarness()
      panel.props.revisionText = '保留用户修订'
      if (kind === 'adopt') {
        panel.click(/用内置技能生成建议/)
        panel.reviews[0].resolve(report)
        await settle()
        panel.click(/按这些建议生成修订稿/)
      } else panel.click(kind === 'inspect' ? /仅运行内置脚本/ : /用内置技能生成建议/)
      panel.unmount()
      assert.equal(panel.stops.length, 1, 'Cleanup must issue stop synchronously, not after the original request settles')
      const ownedId = panel.operationIds.at(-1)
      assert.equal(typeof ownedId, 'string')
      assert.ok(ownedId)
      assert.equal(panel.stoppedIds[0], ownedId)
      const remounted = await panelHarness()
      remounted.click(/仅运行内置脚本/)
      assert.notEqual(remounted.operationIds[0], ownedId, 'Remounts must use distinct owners')
      panel.stops[0].resolve()
      if (kind === 'review') panel.reviews[0].resolve(report)
      else panel.inspections[0].resolve(detection)
      await settle()
      assert.equal(panel.stops.length, 1, 'Settling old promises must not send another stop to the remounted panel')
      assert.deepEqual(panel.messages, [])
      assert.deepEqual(panel.adopted, [])
      assert.equal(panel.props.revisionText, '保留用户修订')
      remounted.inspections[0].resolve(detection)
      await settle()
    } finally { Object.assign(globalThis, { window: previousWindow }) }
  })
}

test('unmount while stop acknowledgement is pending does not send a duplicate singleton stop', async () => {
  const panel = await panelHarness()
  panel.click(/仅运行内置脚本/)
  panel.click(/停止检查/)
  panel.inspections[0].reject(new Error('润色检查已停止。'))
  await settle()
  panel.unmount()
  assert.equal(panel.stops.length, 1)
  panel.stops[0].resolve()
  await settle()
})

test('unmount after a request settles does not stop unrelated work', async () => {
  const panel = await panelHarness()
  panel.click(/仅运行内置脚本/)
  panel.inspections[0].resolve(detection)
  await settle()
  panel.unmount()
  assert.equal(panel.stops.length, 0)
})

test('cancelled adoption never overwrites an unchanged revision, even if the recheck resolves first', async () => {
  const previousWindow = globalThis.window
  Object.assign(globalThis, { window: { confirm: () => true } })
  try {
    const panel = await panelHarness()
    panel.props.revisionText = '保留已有修订稿'
    panel.click(/用内置技能生成建议/)
    panel.reviews[0].resolve(report)
    await settle()
    panel.click(/按这些建议生成修订稿/)
    panel.click(/停止检查/)
    panel.inspections[0].resolve(detection)
    await settle()
    assert.deepEqual(panel.adopted, [])
    assert.equal(panel.messages.some(item => item.kind === 'success'), false)
    assert.ok(panel.button(/正在停止/), 'A delayed stop IPC must not be allowed to cancel a newer request')
    assert.ok(panel.button(/仅运行内置脚本/)?.props.disabled)
    panel.stops[0].resolve()
    await settle()
    assert.equal(panel.button(/仅运行内置脚本/)?.props.disabled, false)
    assert.equal(panel.props.revisionText, '保留已有修订稿')
  } finally { Object.assign(globalThis, { window: previousWindow }) }
})

test('panel reports service cancellation as stopped, not an error or successful detection', async () => {
  const panel = await panelHarness()
  panel.click(/仅运行内置脚本/)
  panel.click(/停止检查/)
  panel.stops[0].resolve()
  panel.inspections[0].reject(new Error('润色检查已停止。'))
  await settle()
  assert.deepEqual(panel.messages.map(item => item.kind), ['info'])
  assert.ok(!panel.textOf(panel.render()).includes('上游脚本检测和候选抽取已完成'))
  assert.equal(panel.button(/仅运行内置脚本/)?.props.disabled, false)
})

test('panel reports a stop failure and retains busy until the original request settles', async () => {
  const panel = await panelHarness()
  panel.click(/仅运行内置脚本/)
  panel.click(/停止检查/)
  panel.stops[0].reject(new Error('停止请求失败'))
  await settle()
  assert.ok(panel.messages.some(item => item.kind === 'error' && /停止请求失败/.test(item.text)))
  assert.ok(panel.button(/仅运行内置脚本|检测中/)?.props.disabled)
  assert.equal(panel.button(/停止检查/)?.props.disabled, false, 'A failed stop can be retried')
  panel.inspections[0].reject(new Error('检测失败'))
  await settle()
  assert.equal(panel.button(/仅运行内置脚本/)?.props.disabled, false)
})

test('preload stop invokes the authorized writing-tone IPC handler', async () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  let stopped = 0
  let stoppedId: string | undefined
  const requested: Array<{ kind: string; input: unknown; operationId: string | undefined }> = []
  let leases = 0
  let releases = 0
  let trusted = true
  let exposed: { writingTone: {
    stop(operationId?: string): Promise<void>
    inspect(input: unknown, operationId?: string): Promise<unknown>
    review(input: unknown, operationId?: string): Promise<unknown>
  } } | undefined
  const electron = {
    ipcMain: { removeHandler: (name: string) => handlers.delete(name), handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler) },
    ipcRenderer: { invoke: (name: string, ...args: unknown[]) => { const handler = handlers.get(name); assert.ok(handler, `Missing handler: ${name}`); return handler({}, ...args) } },
    contextBridge: { exposeInMainWorld: (_name: string, value: typeof exposed) => { exposed = value } }
  }
  const bundle = await build({
    entryPoints: [resolve('src/main/ipc.ts'), resolve('src/preload/index.ts')],
    outdir: 'unused', bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    tsconfig: resolve('tsconfig.node.json')
  })
  let registerIpc!: typeof import('../src/main/ipc').registerIpc
  for (const file of bundle.outputFiles) {
    const module = { exports: {} as { registerIpc?: typeof registerIpc } }
    new Function('require', 'module', 'exports', file.text)((name: string) => name === 'electron' ? electron : require(name), module, module.exports)
    if (module.exports.registerIpc) registerIpc = module.exports.registerIpc
  }
  registerIpc({ writingTone: {
    stop: (operationId?: string) => { stopped++; stoppedId = operationId },
    inspect: (input: unknown, operationId?: string) => { requested.push({ kind: 'inspect', input, operationId }) },
    review: (input: unknown, operationId?: string) => { requested.push({ kind: 'review', input, operationId }) }
  } } as never,
    { authorize: () => { leases++; return () => { releases++ } } } as never, () => trusted)
  assert.ok(exposed)
  await exposed.writingTone.stop()
  assert.equal(stopped, 1)
  assert.equal(leases, 1)
  assert.equal(releases, 1)
  await exposed.writingTone.inspect({ text: source }, 'owned-inspect')
  await exposed.writingTone.review({ text: source }, 'owned-review')
  await exposed.writingTone.stop('owned-review')
  assert.equal(stoppedId, 'owned-review')
  assert.deepEqual(requested, [
    { kind: 'inspect', input: { text: source }, operationId: 'owned-inspect' },
    { kind: 'review', input: { text: source }, operationId: 'owned-review' }
  ])
  trusted = false
  await assert.rejects(exposed.writingTone.stop(), /拒绝来自非应用窗口/)
  assert.equal(stopped, 2)
})
