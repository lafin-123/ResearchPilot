import test from 'node:test'
import assert from 'node:assert/strict'
import { WritingSessionCache, type WritingSessionDraft } from '../src/renderer/src/lib/writing-session'
import { DEFAULT_REWRITE_CONSTRAINTS } from '../src/shared/writing-quality'
const sample = (): WritingSessionDraft => ({ documentId: 'doc-a', draft: '原文30例 [1]', sources: [{id:'source-1',label:'作者',text:'授权原文'}], constraints: {...DEFAULT_REWRITE_CONSTRAINTS, protectedTerms:'专有术语'}, includeSources:false, revised:'实际改稿30例 [1]', revisionTitle:'修订稿' })
test('writing roundtrip restores original, sources and constraints without alias mutations', () => {
  const cache = new WritingSessionCache(); const state=sample();cache.save('user','project',state)
  state.sources[0].text='changed'
  const restored=cache.read('user','project')!; assert.equal(restored.sources[0].text,'授权原文'); assert.equal(restored.draft,'原文30例 [1]')
  restored.constraints.protectedTerms='changed';assert.equal(cache.read('user','project')!.constraints.protectedTerms,'专有术语')
})
test('writing draft separation includes both account and project and clear removes memory', () => {
  const cache=new WritingSessionCache();cache.save('a','p',sample());assert.equal(cache.read('b','p'),undefined);assert.equal(cache.read('a','q'),undefined)
  cache.save('a','q',sample());cache.remove('a','p');assert.equal(cache.read('a','p'),undefined);assert.ok(cache.read('a','q'));cache.clear();assert.equal(cache.read('a','q'),undefined)
})
