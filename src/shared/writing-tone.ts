import { checkRewritePreservation } from './writing-quality'

export const TONE_SKILL = 'lieflat-less-ai-tone'
export const TONE_VERSION = '53160078a04926d98de57a233549612d1b89bdc9'
export interface ToneEdit { before: string; after: string; reason: string; rule: string }
export interface ToneDetection { status: 'completed' | 'unavailable'; reason: string; metrics: unknown; candidates: unknown }
export interface ToneReviewInput { projectId: string; text: string; protectedTerms: string; context: string }
export interface ToneReview {
  sourceHash: string; createdAt: string; skillVersion: string
  summary: string; retained: string[]; edits: ToneEdit[]; detection: ToneDetection
  providerId: string; modelId: string
}
export const ACADEMIC_TONE_GUIDANCE = '依据 lieflat-less-ai-tone 的学术适配：删除无信息的套话和重复宣告，保持术语一致；保留数字、单位、引用、否定、限定条件与因果力度。不为文风强加口语、打乱章节、制造句长参差或删去正常的对照论述。X级已否决规则不执行，C级结构指标只报告，H级留待人审。不把文风统计称为AI率或科学质量评分。'

function protectedRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let offset = 0
  let fence: { char: string; length: number; start: number } | null = null
  for (const line of text.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker && !fence) fence = { char: marker[0], length: marker.length, start: offset }
    else if (marker && fence && marker[0] === fence.char && marker.length >= fence.length) {
      ranges.push({ start: fence.start, end: offset + line.length }); fence = null
    }
    if (/^(?:\s{0,3}(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s)|\s*\||\s{4}|\t)/.test(line)) ranges.push({ start: offset, end: offset + line.length })
    offset += line.length + 1
  }
  if (fence) ranges.push({ start: fence.start, end: text.length })
  for (const m of text.matchAll(/`+[^`\n]+`+|\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|“[^”]*”|「[^」]*」|"[^"\n]+"/g)) ranges.push({ start: m.index, end: m.index + m[0].length })
  return ranges
}

function assertPreserved(before: string, after: string, terms: string[]): void {
  const report = checkRewritePreservation(before, after, terms)
  for (const term of terms.filter(Boolean)) {
    if (before.split(term).length !== after.split(term).length) throw new Error('修改改变了指定术语的出现次数。')
  }
  const markers = (text: string): string[] => text.match(/\[[^\]\n]+\]|\\(?:cite\w*|ref|eqref)\{[^}]+\}/g) ?? []
  if (report.original.truncated || report.revised.truncated || report.inventoryTruncated || report.missingNumbers.length || report.addedNumbers.length || report.missingCitations.length || report.addedCitations.length || report.missingTerms.length || JSON.stringify(markers(before)) !== JSON.stringify(markers(after))) throw new Error('修改改变了数字、引用或指定术语，不能自动采用。')
}

export function validateToneEdits(text: string, value: unknown, terms: string[]): ToneEdit[] {
  if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new Error('请提供不超过20,000字符的原文。')
  if (!Array.isArray(value) || value.length > 40) throw new Error('建议必须为最多40项的数组。')
  const protectedSpans = protectedRanges(text)
  const used: Array<{ start: number; end: number }> = []
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || !['before', 'after', 'reason', 'rule'].every(k => typeof raw[k] === 'string')) throw new Error('建议字段不完整。')
    const edit = raw as ToneEdit
    if (!edit.before || edit.before === edit.after || !edit.reason.trim() || edit.reason.length > 2000 || edit.rule.length > 160 || edit.before.length > 3000 || edit.after.length > 3000) throw new Error('建议为空或超出局部修改范围。')
    if (!/^(?:A|B|F|语义)(?:\s|$)/u.test(edit.rule)) throw new Error('该规则不能自动改写。')
    const start = text.indexOf(edit.before), end = start + edit.before.length
    if (start < 0 || text.indexOf(edit.before, start + 1) >= 0) throw new Error('建议原句必须在原文中唯一定位。')
    if ([10, 13, 8232, 8233].some(code => (edit.before + edit.after).includes(String.fromCharCode(code))) || /[#`$\\|<>]/.test(edit.after) || protectedSpans.some(r => start < r.end && end > r.start)) throw new Error('修改涉及受保护的结构、公式、代码或引语。')
    const lineStart = text.lastIndexOf('\n', start - 1) + 1
    const nextBreak = text.indexOf('\n', end)
    const lineEnd = nextBreak < 0 ? text.length : nextBreak
    const changedLine = text.slice(lineStart, start) + edit.after + text.slice(end, lineEnd)
    if (/^(?:\s{0,3}(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s)|\s{4}|\t)/.test(changedLine) || /^\s*(?:[-*_]\s*){3,}$/.test(changedLine)) throw new Error('修改会引入新的段落结构。')
    for (const term of terms.filter(Boolean)) {
      for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + 1)) {
        if (start < at + term.length && end > at && (start > at || end < at + term.length)) throw new Error('修改截断了指定术语。')
      }
    }
    if (used.some(r => start < r.end && end > r.start)) throw new Error('建议范围重叠，需重新检查。')
    assertPreserved(edit.before, edit.after, terms)
    used.push({ start, end })
    return { before: edit.before, after: edit.after, reason: edit.reason, rule: edit.rule }
  })
}

export function applyToneEdits(current: string, original: string, edits: ToneEdit[], terms: string[] = []): string {
  if (current !== original) throw new Error('原文已变化，请重新检查后采用建议。')
  const validated = validateToneEdits(original, edits, terms)
  let revised = original
  for (const edit of [...validated].sort((a, b) => original.indexOf(b.before) - original.indexOf(a.before))) {
    const start = original.indexOf(edit.before)
    revised = revised.slice(0, start) + edit.after + revised.slice(start + edit.before.length)
  }
  const originalLines = original.split('\n')
  for (const [index, line] of revised.split('\n').entries()) {
    if (line === originalLines[index]) continue
    if (!line.trim() || /^(?:\s{0,3}(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s)|\s{4}|\t)/.test(line) || /^\s*(?:[-*_]\s*){3,}$/.test(line)) throw new Error('组合修改改变了段落结构。')
  }
  assertPreserved(original, revised, terms)
  return revised
}
