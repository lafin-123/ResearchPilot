import { useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { applyToneEdits, type ToneDetection, type ToneReview } from '@shared/writing-tone'
import { checkRewritePreservation } from '@shared/writing-quality'
import { api, formatError } from '../lib/api'
import { effectiveToneModel, formatEffectiveModel } from '../lib/effective-model'
import { useAppStore } from '../store/app'
import { Button } from './Ui'

interface Props {
  projectId: string; text: string; protectedTerms: string; context: string
  disabled: boolean; revisionText: string
  onAdopt(text: string): void
}
interface Snapshot { text: string; signature: string; report: ToneReview }
interface Operation { id: string; cancelled: boolean; settled: boolean; stopPromise?: Promise<void> }

function ToneModelProvenance(): ReactNode {
  const settings = useAppStore(state => state.settings)
  const providers = useAppStore(state => state.providers)
  return <p className="wq-muted" data-testid="tone-model-provenance" style={{ overflowWrap: 'anywhere' }}>下次生成建议：{formatEffectiveModel(effectiveToneModel(settings, providers))}；非运行中模型，不受聊天选择影响；脚本检测与采用后的复测均为本地执行。</p>
}

export function WritingTonePanel(props: Props): ReactNode {
  const { projectId, text, protectedTerms, context, disabled, revisionText, onAdopt } = props
  const revisionCurrent = useRef(revisionText)
  revisionCurrent.current = revisionText
  const signature = JSON.stringify({ projectId, text, protectedTerms, context })
  const current = useRef(signature)
  current.current = signature
  const live = useRef(true)
  const running = useRef(false)
  const active = useRef<Operation | null>(null)
  const [busy, setBusy] = useState('')
  const [stopping, setStopping] = useState(false)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [local, setLocal] = useState<{ signature: string; result: ToneDetection } | null>(null)
  const [adopted, setAdopted] = useState<{ text: string; after: ToneDetection; preservation: ReturnType<typeof checkRewritePreservation> } | null>(null)
  const adoptedMatches = !!adopted && adopted.text === revisionText
  const stale = !!snapshot && snapshot.signature !== signature
  const valid = !!projectId && !!text.trim() && text.length <= 20000 && !disabled && !busy
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      const operation = active.current
      if (running.current && operation && !operation.settled && !operation.cancelled) {
        // Issue scoped cancellation now; never defer cleanup until a later mount owns the service.
        requestStop(operation)
      }
    }
  }, [])

  function requestStop(operation: Operation): void {
    operation.cancelled = true
    operation.stopPromise = api.writingTone.stop(operation.id).catch(error => {
      operation.cancelled = false
      if (live.current) { setStopping(false); toast.error(formatError(error)) }
    })
  }
  const stop = (): void => {
    const operation = active.current
    if (!operation || operation.cancelled || operation.settled) return
    setStopping(true)
    requestStop(operation)
  }
  const wasCancelled = (operation: Operation): boolean => {
    if (!operation.cancelled) return false
    if (live.current) toast.info('润色检查已停止，未应用本次结果。原文和修订稿未改动。')
    return true
  }
  const finish = async (operation: Operation): Promise<void> => {
    operation.settled = true
    // Do not admit new work until both the original request and stop IPC settle.
    await operation.stopPromise
    active.current = null; running.current = false
    if (live.current) { setBusy(''); setStopping(false) }
  }

  const run = async (kind: 'inspect' | 'review'): Promise<void> => {
    if (!valid || running.current) return
    if (kind === 'review' && !window.confirm('将当前原文、术语与上下文发送给设置中的写作角色模型（未单独配置时用默认模型），生成修改建议。不会发送对照来源正文，也不会覆盖文稿。继续？')) return
    const operation: Operation = { id: crypto.randomUUID(), cancelled: false, settled: false }
    active.current = operation
    running.current = true; setBusy(kind)
    const captured = signature
    try {
      const input = { projectId, text, protectedTerms, context }
      if (kind === 'inspect') {
        const result = await api.writingTone.inspect(input, operation.id)
        if (wasCancelled(operation)) return
        if (live.current && current.current === captured) setLocal({ signature: captured, result })
      } else {
        const report = await api.writingTone.review(input, operation.id)
        if (wasCancelled(operation)) return
        if (live.current && current.current === captured) {
          setSnapshot({ text, signature: captured, report }); setAdopted(null)
          setLocal({ signature: captured, result: report.detection })
        }
      }
      if (live.current && current.current !== captured) toast.warning('原文或约束已变化，本次旧结果未应用，请重新检查。')
    } catch (error) { if (!wasCancelled(operation) && live.current) toast.error(formatError(error)) }
    finally { await finish(operation) }
  }

  const adopt = async (): Promise<void> => {
    if (!snapshot || stale || !valid || running.current || !snapshot.report.edits.length) return
    if (revisionText.trim() && !window.confirm('用这些建议生成的修订稿替换下方尚未另存的修订文本？原文不变。')) return
    const previousRevision = revisionText
    const operation: Operation = { id: crypto.randomUUID(), cancelled: false, settled: false }
    active.current = operation
    running.current = true; setBusy('adopt')
    const captured = signature
    try {
      const terms = protectedTerms.split(/[,，;；\n]+/u).map(t => t.trim()).filter(Boolean)
      const revised = applyToneEdits(text, snapshot.text, snapshot.report.edits, terms)
      const after = await api.writingTone.inspect({ projectId, text: revised, protectedTerms, context }, operation.id)
      if (wasCancelled(operation) || !live.current) return
      if (current.current !== captured || revisionCurrent.current !== previousRevision) { toast.warning('原文、约束或修订稿已变化，未采用旧建议。'); return }
      setAdopted({ text: revised, after, preservation: checkRewritePreservation(text, revised, terms) })
      onAdopt(revised)
      toast.success('建议已应用到独立修订文本，原文未改动。请核对科学含义后另存。')
    } catch (error) { if (!wasCancelled(operation) && live.current) toast.error(formatError(error)) }
    finally { await finish(operation) }
  }

  const download = (): void => {
    if (!snapshot || stale) return
    const record = { version: 1, skill: 'lieflat-less-ai-tone', status: adopted ? 'adopted' : 'proposed', original: snapshot.text, ...snapshot.report, ...(adopted ? { revised: adopted.text, afterDetection: adopted.after, preservation: adopted.preservation } : {}), semanticAnnotation: '本界面提供局部编辑审阅，未执行上游完整逐候选封闭标签标注。' }
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = 'academic-tone-revision.json'
    document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <section className="wq-rewrite" aria-labelledby="tone-heading">
    <div className="wq-section-heading"><h2 id="tone-heading">学术表达去套路 · 内置技能</h2><span className="wq-muted">lieflat-less-ai-tone</span></div>
    <p>先定位套话、重复宣告和机械句式，再查看具体建议。采用只生成独立修订文本，不改动原文；数字、引用、指定术语及受保护结构发生变化的建议会被拒绝。</p>
    <p className="wq-muted">使用下方填写的“不可替换的术语”和“预期意思与上下文”。脚本统计需要 Python 3.10+ 和至少500汉字；短文和英文可用模型审阅，但不生成脚本指标。</p>
    <ToneModelProvenance/>
    <div className="row wrap">
      <Button disabled={!valid} onClick={() => void run('inspect')}>{busy === 'inspect' ? '检测中…' : '仅运行内置脚本（本地）'}</Button>
      <Button variant="primary" disabled={!valid} onClick={() => void run('review')}>{busy === 'review' ? '正在生成建议…' : '用内置技能生成建议…'}</Button>
      <Button disabled={!snapshot || stale || !!busy} onClick={download}>导出修改记录（含原文）</Button>
      {busy ? <Button disabled={stopping} onClick={stop}>{stopping ? '正在停止…' : '停止检查'}</Button> : null}
    </div>
    {!projectId ? <p className="wq-warning">请选择项目后运行内置技能；上方通用检查仍可使用。</p> : null}
    {text.length > 20000 ? <p className="wq-warning">本次最多20,000字符，请分章节处理，不会截断原文。</p> : null}
    {local ? <div aria-live="polite">
      {local.signature !== signature ? <p className="wq-warning">输入已变化，本地结果待更新。</p> : null}
      <p>{local.result.status === 'completed' ? '上游脚本检测和候选抽取已完成；原始结果保留，命中不等于需要修改。' : local.result.reason}</p>
      {local.result.status === 'completed' ? <details><summary>查看原始指标与候选</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(local.result, null, 2)}</pre></details> : null}
    </div> : null}
    {snapshot ? <div aria-live="polite">
      {stale ? <p className="wq-warning">原文或约束已变化，请重新生成建议。旧建议不能采用。</p> : null}
      <p style={{ whiteSpace: 'pre-wrap' }}>{snapshot.report.summary}</p>
      <p className="wq-muted" style={{ overflowWrap: 'anywhere' }}>本次报告实际模型：{snapshot.report.providerId} / {snapshot.report.modelId}；建议 {snapshot.report.edits.length} 处。以下为局部编辑建议，不是完整逐候选语义标注。</p>
      <ol className="wq-findings">{snapshot.report.edits.map((edit, index) => <li key={index}>
        <strong>{edit.rule}</strong><blockquote>{edit.before}</blockquote><p>{edit.after || '删除该冗余片段'}</p><p className="wq-muted">{edit.reason}</p>
      </li>)}</ol>
      {snapshot.report.retained.length ? <details><summary>保留项与待人审内容</summary><ul>{snapshot.report.retained.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : null}
      <Button variant="primary" disabled={!valid || stale || !snapshot.report.edits.length || adoptedMatches} onClick={() => void adopt()}>{busy === 'adopt' ? '复测中…' : adoptedMatches ? '已采用到独立修订稿' : '按这些建议生成修订稿'}</Button>
      {adopted && !adoptedMatches ? <p className="wq-warning">下方修订文本已改变，之前的复测仅对应导出记录中的版本；可以重新采用建议。</p> : null}
      {adopted ? <p>{adopted.after.status === 'completed' ? '改后脚本复测完成，数字、引用与指定术语文本核对通过。' : `改后脚本未执行：${adopted.after.reason}`} 科学含义仍需人工核对；修改记录可导出，修订稿可在下方另存。</p> : null}
    </div> : null}
    <p className="wq-muted">原作者 shiujan · CC BY-NC 4.0 · 固定版本 5316007。学术适配不以文风判断作者，不追求标点清零或机械改变句长。当前报告保存在本页面内存，离开页面前可导出。</p>
  </section>
}
