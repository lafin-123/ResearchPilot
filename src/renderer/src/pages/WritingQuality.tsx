import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, BookOpen, CheckCheck, Download, FileText, Plus, ScanText, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { DocumentRecord } from '@shared/types'
import {
  analyzeWriting, buildRewritePrompt, checkRewritePreservation, compareTexts,
  DEFAULT_REWRITE_CONSTRAINTS, REPORT_ORIGIN_LABELS, WRITING_LIMITATIONS, WRITING_LIMITS,
  type PreservedItem, type ReportOrigin, type RewriteConstraints, type RewritePreservationReport,
  type SimilarityReport, type SimilaritySource, type TextSpan, type WritingAnalysis, type WritingCategory
} from '@shared/writing-quality'
import { api, formatError } from '../lib/api'
import { useAuth } from '../components/AuthGate'
import { writingSessionCache } from '../lib/writing-session'
import { useAppStore } from '../store/app'
import { Badge, Button, Field, Input, Modal, PageHeader, Select, Textarea } from '../components/Ui'
import './writing-quality.css'

interface SourceDraft extends SimilaritySource { id: string; label: string }
interface ReviewSnapshot {
  text: string
  sources: string
  origin: ReportOrigin
  analysis: WritingAnalysis
  similarity: SimilarityReport
}
interface RevisionSnapshot { original: string; revised: string; terms: string; report: RewritePreservationReport }
const CATEGORY_LABELS: Record<WritingCategory, string> = {
  cliche: '套语与泛化', intensifier: '空泛强调', repetition: '重复表达', 'long-sentence': '长句', citation: '引用线索'
}

function Inventory({ items, empty }: { items: PreservedItem[]; empty: string }): ReactNode {
  if (!items.length) return <p className="wq-muted">{empty}</p>
  return <ul className="wq-inventory">{items.map((item) => <li key={item.value}><code>{item.value}</code>{item.count > 1 ? <span> × {item.count}</span> : null}</li>)}</ul>
}

export function WritingQualityPage(): ReactNode {
  const { user } = useAuth()
  const projectId = useAppStore((state) => state.activeProjectId)
  return <WritingQualityWorkspace key={`${user?.id ?? ''}:${projectId}`} accountId={user?.id ?? ''} projectId={projectId} />
}

function WritingQualityWorkspace({ accountId, projectId }: { accountId: string; projectId: string }): ReactNode {
  const navigate = useNavigate()
  const [restored] = useState(() => writingSessionCache.read(accountId, projectId))
  const newChat = useAppStore((state) => state.newChat)
  const seedPrompt = useAppStore((state) => state.seedPrompt)
  const providers = useAppStore((state) => state.providers)
  const modelSelection = useAppStore((state) => state.modelSelection)
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [documentId, setDocumentId] = useState(restored?.documentId ?? '')
  const [documentsLoading, setDocumentsLoading] = useState(false)
  const [documentsError, setDocumentsError] = useState('')
  const [draft, setDraft] = useState(restored?.draft ?? '')
  const [sources, setSources] = useState<SourceDraft[]>(restored?.sources ?? [])
  const [review, setReview] = useState<ReviewSnapshot | null>(null)
  const [filter, setFilter] = useState<'all' | WritingCategory>('all')
  const [constraints, setConstraints] = useState<RewriteConstraints>(restored?.constraints ?? { ...DEFAULT_REWRITE_CONSTRAINTS })
  const [includeSources, setIncludeSources] = useState(restored?.includeSources ?? false)
  const [revised, setRevised] = useState(restored?.revised ?? '')
  const [revisionTitle, setRevisionTitle] = useState(restored?.revisionTitle ?? '修订稿')
  const [saveOpen, setSaveOpen] = useState(false)
  const [savedRevision, setSavedRevision] = useState<DocumentRecord | null>(null)
  const savingRef = useRef(false)
  const [revision, setRevision] = useState<RevisionSnapshot | null>(null)
  const [busy, setBusy] = useState<'load' | 'prepare' | 'save' | ''>('')
  const [pendingImport, setPendingImport] = useState<DocumentRecord | null>(null)
  const [confirmPrepare, setConfirmPrepare] = useState(false)
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const resultsRef = useRef<HTMLElement>(null)
  const requestVersion = useRef(0)
  const nextSource = useRef(1 + Math.max(0, ...(restored?.sources ?? []).map((source) => Number(source.id.replace(/\D/g, '')) || 0)))
  const sourceSignature = useMemo(() => JSON.stringify(sources), [sources])
  const stale = !!review && (review.text !== draft || review.sources !== sourceSignature || review.origin !== constraints.reportOrigin)
  const revisionStale = !!revision && (revision.original !== draft || revision.revised !== revised || revision.terms !== constraints.protectedTerms)
  const currentProvider = providers.find((provider) => provider.id === modelSelection.providerId)
  const matchingFindings = review?.analysis.findings.filter((finding) => filter === 'all' || finding.category === filter) ?? []
  const hasSources = sources.some((source) => source.text.trim())

  useEffect(() => {
    let cancelled = false
    requestVersion.current += 1
    setDocuments([])
    setDocumentsError('')
    setPendingImport(null)
    setConfirmPrepare(false)
    setBusy('')
    setDocumentsLoading(!!projectId)
    if (projectId) {
      void api.documents.list(projectId).then((list) => {
        if (!cancelled) setDocuments(list)
      }).catch((error) => {
        if (!cancelled) setDocumentsError(formatError(error))
      }).finally(() => {
        if (!cancelled) setDocumentsLoading(false)
      })
    }
    return () => { cancelled = true; requestVersion.current += 1 }
  }, [projectId])

  useEffect(() => {
    writingSessionCache.save(accountId, projectId, { documentId, draft, sources, constraints, includeSources, revised, revisionTitle })
  }, [accountId, projectId, documentId, draft, sources, constraints, includeSources, revised, revisionTitle])

  const clearSession = (): void => {
    if (!window.confirm('清空本项目的写作草稿、来源文本和改稿？已保存文稿不会删除。')) return
    setDraft(''); setSources([]); setRevised(''); setDocumentId(''); setReview(null); setRevision(null)
    setConstraints({ ...DEFAULT_REWRITE_CONSTRAINTS }); setIncludeSources(false); setRevisionTitle('修订稿'); setSavedRevision(null)
    writingSessionCache.remove(accountId, projectId)
  }

  const saveRevision = async (): Promise<void> => {
    if (!projectId || !revised.trim() || !revisionTitle.trim() || savingRef.current) return
    savingRef.current = true
    const version = ++requestVersion.current
    setBusy('save')
    try {
      const saved = await api.documents.create({ projectId, title: revisionTitle.trim(), format: 'docx', markdown: revised })
      if (version !== requestVersion.current || useAppStore.getState().activeProjectId !== projectId) return
      setSavedRevision(saved); setDocuments((current) => [...current, saved]); setSaveOpen(false)
      toast.success('修订稿已另存为新 DOCX，原文未修改。')
    } catch (error) { if (version === requestVersion.current) toast.error(formatError(error)) }
    finally { savingRef.current = false; if (version === requestVersion.current) setBusy('') }
  }

  const loadDocument = async (document: DocumentRecord): Promise<void> => {
    if (!projectId || busy) return
    const version = ++requestVersion.current
    setPendingImport(null)
    setBusy('load')
    try {
      const result = await api.documents.readText(projectId, document.id)
      if (requestVersion.current !== version || useAppStore.getState().activeProjectId !== projectId) return
      setDraft(result.text)
      setRevisionTitle(`${document.title} — 修订稿`)
      setSavedRevision(null)
      setReview(null)
      setRevision(null)
      setRevised('')
      if (result.text.length > WRITING_LIMITS.maxTextChars) toast.warning('已载入全文；本地检查只处理前 40,000 字符。建议选取要检查的段落。')
      else toast.success('已载入已保存的文稿文本，未修改原文件')
    } catch (error) {
      if (requestVersion.current === version) toast.error(formatError(error))
    } finally {
      if (requestVersion.current === version) setBusy('')
    }
  }

  const runReview = (): void => {
    if (!draft.trim()) return
    try {
      setReview({ text: draft, sources: sourceSignature, origin: constraints.reportOrigin, analysis: analyzeWriting(draft), similarity: compareTexts(draft, sources) })
      setFilter('all')
      requestAnimationFrame(() => resultsRef.current?.focus())
    } catch (error) { toast.error(formatError(error)) }
  }

  const locate = (span: TextSpan): void => {
    const textarea = draftRef.current
    if (!textarea || stale) return
    textarea.focus()
    textarea.setSelectionRange(span.start, span.end)
    textarea.scrollIntoView({ block: 'center', behavior: 'auto' })
  }

  const updateSource = (id: string, patch: Partial<Pick<SourceDraft, 'label' | 'text'>>): void => {
    setSources((current) => current.map((source) => source.id === id ? { ...source, ...patch } : source))
  }

  const prepareRewrite = async (): Promise<void> => {
    if (!projectId || busy) return
    const version = ++requestVersion.current
    setBusy('prepare')
    try {
      const prompt = buildRewritePrompt(draft, constraints, sources, includeSources)
      if (!await newChat()) return
      if (requestVersion.current !== version || useAppStore.getState().activeProjectId !== projectId) return
      seedPrompt(prompt)
      setConfirmPrepare(false)
      navigate('/agent')
      toast.success('已放入新会话草稿。请审阅并自行发送；尚未执行 AI 改写。')
    } catch (error) { if (requestVersion.current === version) toast.error(formatError(error)) }
    finally { if (requestVersion.current === version) setBusy('') }
  }

  const downloadReport = (): void => {
    if (!review || stale) return
    const payload = {
      version: 1,
      reportOrigin: REPORT_ORIGIN_LABELS[review.origin],
      reportOriginNote: '仅标记用户提供的报告来源。未接入或执行外部平台检测。',
      localAnalysis: review.analysis,
      suppliedTextComparison: review.similarity,
      ...(revision && !revisionStale ? { manualRevisionCheck: revision.report } : {}),
      privacy: '由用户操作在本机下载；包含有界原文摘录、数字与引用标记，不含原文全文或对照文本正文。',
      aiRewriteExecuted: false
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'researchpilot-writing-review.json'
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }

  const runRevisionCheck = (): void => {
    const terms = constraints.protectedTerms.split(/[,，;；\n]+/u).map((value) => value.trim()).filter(Boolean)
    setRevision({ original: draft, revised, terms: constraints.protectedTerms, report: checkRewritePreservation(draft, revised, terms) })
  }

  return (
    <div className="page wq-page">
      <PageHeader
        title="写作质量与来源对照"
        subtitle="把模糊表达改具体，把来源归属留清楚。先检查原文，再准备可审阅的修订。"
        actions={<><Button onClick={clearSession} disabled={!!busy}>清空本项目草稿</Button><Button onClick={downloadReport} disabled={!review || stale}><Download aria-hidden="true" />下载本地报告</Button></>}
      />
      <div className="wq-boundary" role="note">
        <ShieldCheck size={21} aria-hidden="true" />
        <div><strong>本地检查，不是检测通过承诺</strong><p>不判断 AI 作者身份，不连接知网 / 维普查重数据库，不提供通过率。只检查表达线索并对照你提供的文本；重合不等于抄袭，未重合也不证明原创。</p></div>
      </div>

      <div className="wq-workbench">
        <section className="wq-manuscript" aria-labelledby="wq-draft-heading">
          <div className="wq-section-heading"><h2 id="wq-draft-heading"><FileText size={18} aria-hidden="true" />待修订原文</h2><span className="wq-muted">本次应用会话内按项目保留</span></div>
          <div className="wq-import">
            <Field label="从当前项目载入已保存的文稿">
              <Select value={documentId} disabled={!!busy || documentsLoading} onChange={(event) => setDocumentId(event.target.value)}>
                <option value="">{documentsLoading ? '正在读取文稿列表…' : documents.length ? '选择文稿，或在下方粘贴' : '暂无文稿，可直接粘贴文本'}</option>
                {documents.map((item) => <option key={item.id} value={item.id}>{item.title} ({item.format})</option>)}
              </Select>
            </Field>
            <Button disabled={!documentId || !!busy || documentsLoading} onClick={() => {
              const selected = documents.find((item) => item.id === documentId)
              if (!selected) return
              if (draft.trim()) setPendingImport(selected)
              else void loadDocument(selected)
            }}>{busy === 'load' ? '载入中…' : '载入文本'}</Button>
          </div>
          {documentsError ? <p className="wq-error" role="alert">文稿列表读取失败：{documentsError}。仍可粘贴文本进行检查。</p> : null}
          <div className="wq-origin">
            <Field label="报告来源（仅标签）">
              <Select value={constraints.reportOrigin} onChange={(event) => setConstraints((current) => ({ ...current, reportOrigin: event.target.value as ReportOrigin, ...(event.target.value !== 'local' ? { goal: 'ethical-paraphrase' as const } : {}) }))}>
                {Object.entries(REPORT_ORIGIN_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
            </Field>
            {constraints.reportOrigin !== 'local' ? <p className="wq-muted">请粘贴报告中被标记的段落，并在下方提供原始来源。平台标签不会导入报告、读取平台结果或改变本地规则。</p> : null}
          </div>
          <label htmlFor="wq-draft" className="wq-label">原文 / 报告标记段落</label>
          <textarea
            ref={draftRef} id="wq-draft" className="textarea wq-draft" value={draft} disabled={busy === 'load'}
            onChange={(event) => setDraft(event.target.value)} aria-describedby="wq-draft-help"
            placeholder="粘贴需要检查的真实段落，保留数字、引用标记与必要上下文。不会自动生成或替换原文。"
            spellCheck={false}
          />
          <p id="wq-draft-help" className="wq-muted">{draft.length.toLocaleString()} 字符。本地检查最多前 40,000 字符；改写草稿最多 20,000 字符。载入操作不会写回文件。切换页面后草稿仍保留；刷新或关闭应用会清空内存，请及时另存改稿。</p>
          {draft.length > WRITING_LIMITS.maxTextChars ? <p className="wq-warning" role="status">当前文本超出范围。仅分析前 40,000 字符，末尾可能是未完整句子；其余内容未检查。</p> : null}

          <details className="wq-sources" open={sources.length > 0 || undefined}>
            <summary><BookOpen size={16} aria-hidden="true" />用户提供的对照文本{sources.length ? `（${sources.length} / ${WRITING_LIMITS.maxSources}）` : '（可选）'}</summary>
            <p className="wq-muted">粘贴你有权使用的来源原文，并写明作者、年份或页码。最多 6 份，每份检查前 40,000 字符。来源不会自动发送给模型，也不会把正文写入下载报告。</p>
            {sources.map((source, index) => (
              <fieldset key={source.id} className="wq-source">
                <legend>对照文本 {index + 1}</legend>
                <div className="wq-source-head">
                  <Field label="来源与定位"><Input value={source.label} maxLength={120} onChange={(event) => updateSource(source.id, { label: event.target.value })} placeholder="例如：作者，年份，方法部分第 2 段" /></Field>
                  <Button variant="ghost" aria-label={`移除对照文本 ${index + 1}`} onClick={() => setSources((current) => current.filter((item) => item.id !== source.id))}><Trash2 size={16} aria-hidden="true" /></Button>
                </div>
                <Field label="来源原文"><Textarea rows={5} value={source.text} onChange={(event) => updateSource(source.id, { text: event.target.value })} placeholder="仅比较你粘贴的文本，不会检索互联网或其他项目文件。" spellCheck={false} /></Field>
                <p className="wq-muted">{source.text.length.toLocaleString()} 字符{source.text.length > WRITING_LIMITS.maxSourceChars ? '；超出部分不参与比较。' : ''}</p>
              </fieldset>
            ))}
            <Button size="sm" disabled={sources.length >= WRITING_LIMITS.maxSources} onClick={() => {
              const number = nextSource.current++
              setSources((current) => [...current, { id: `source-${number}`, label: '', text: '' }])
            }}><Plus size={15} aria-hidden="true" />添加对照文本</Button>
          </details>
          <div className="wq-run"><Button variant="primary" onClick={runReview} disabled={!draft.trim() || !!busy}><ScanText aria-hidden="true" />运行本地检查与对照</Button><span className="wq-muted">不调用模型，不发送文本</span></div>
        </section>

        <section className="wq-review" ref={resultsRef} tabIndex={-1} aria-labelledby="wq-review-heading">
          <div className="wq-section-heading"><h2 id="wq-review-heading">逐项审阅</h2>{review ? <Badge tone="blue">本地规则结果</Badge> : null}</div>
          <div aria-live="polite" className="wq-status">{review ? stale ? '输入已修改，以下结果来自上次检查。请重新运行后定位或导出。' : `检查完成，显示 ${review.analysis.findings.length} 条建议。规则命中不是质量评分。` : '粘贴原文后运行检查，结果会显示在这里。'}</div>
          {!review ? <div className="wq-empty"><ScanText size={30} aria-hidden="true" /><h3>从具体句子开始</h3><p>检查套语、空泛强调、重复表达、长句和引用占位符。每条提示保留原句位置与修改方向，不把文风当成 AI 判定。</p></div> : <>
            {review.analysis.input.truncated ? <p className="wq-warning">检查范围：前 {review.analysis.input.analyzedCharacters.toLocaleString()} 字符，不代表全文。</p> : null}
            <p className="wq-muted">已检查 {review.analysis.input.analyzedCharacters.toLocaleString()} 字符，启发式分句 {review.analysis.metrics.sentences} 句。识别 {review.analysis.metrics.citationMarkers} 处引用标记、{review.analysis.metrics.numberTokens} 个数值项。</p>
            <Field label="查看建议类型"><Select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">全部建议</option>{Object.entries(CATEGORY_LABELS).map(([category, label]) => <option key={category} value={category}>{label}（{review.analysis.findingCounts[category as WritingCategory]}）</option>)}</Select></Field>
            {matchingFindings.length ? <ol className="wq-findings">{matchingFindings.map((finding) => <li key={finding.id}>
              <div className="wq-finding-head"><span className="wq-category">{CATEGORY_LABELS[finding.category]}</span>{finding.span ? <button className="wq-locate" disabled={stale} onClick={() => locate(finding.span!)} aria-label={`定位${finding.title}，字符 ${finding.span.start + 1} 至 ${finding.span.end}`}>字符 {finding.span.start + 1}–{finding.span.end}</button> : null}</div>
              <h3>{finding.title}</h3>
              {finding.excerpt ? <blockquote>{finding.excerpt}{finding.span && finding.span.end - finding.span.start > finding.excerpt.length ? '…' : ''}</blockquote> : null}
              <p>{finding.explanation}</p><p className="wq-suggestion">{finding.suggestion}</p>
            </li>)}</ol> : <div className="wq-no-findings">该范围内没有命中所选规则。这不代表没有写作、引用或原创性问题。</div>}
            {review.analysis.omittedFindings ? <p className="wq-warning">为控制报告长度，另有 {review.analysis.omittedFindings} 条提示未展示。请按段落检查。</p> : null}
            <details className="wq-preservation"><summary>修订时需要保留的数字与引用</summary><h3>数值原样清单</h3><Inventory items={review.analysis.preservation.numbers} empty="未识别到数值项，请人工检查符号和单位。" /><h3>引用标记原样清单</h3><Inventory items={review.analysis.preservation.citations} empty="未识别到已支持格式的引用，不代表无需引用。" />{review.analysis.preservation.numbersTruncated || review.analysis.preservation.citationsTruncated ? <p className="wq-warning">清单仅展示前 160 个不同项目，请分段核对。</p> : null}<ul className="wq-notes">{review.analysis.preservation.hints.map((hint) => <li key={hint}>{hint}</li>)}</ul></details>
          </>}
        </section>
      </div>

      {review ? <section className="wq-comparison" aria-labelledby="wq-comparison-heading">
        <div className="wq-section-heading"><h2 id="wq-comparison-heading">来源对照：只针对所给文本</h2>{stale ? <Badge tone="gold">结果待更新</Badge> : null}</div>
        <p className="wq-muted">连续 8 个词项的精确窗口对照，忽略大小写与标点；中文按单字计。显示重合窗口数量而非查重比例，不分析语义来源或数据库覆盖。</p>
        {!review.similarity.sources.length ? <p className="wq-no-findings">尚未添加对照文本，因此没有执行来源比较。添加来源后重新运行，不会自动检索其他文档。</p> : <div className="wq-comparison-list">{review.similarity.sources.map((source, index) => <article key={`${source.id}-${index}`}>
          <div className="wq-source-result-head"><h3>{source.label}</h3><span>{source.status === 'empty' ? '来源为空，未比较' : source.status === 'too-short' ? '原文或来源不足 8 词项' : `重合窗口 ${source.sharedWindows} 个`}</span></div>
          <p className="wq-muted">来源检查 {source.input.analyzedCharacters.toLocaleString()} 字符{source.input.truncated ? '（已截断，超出部分未检查）' : ''}。结果仅展示原文片段与来源位置，不复制来源正文。</p>
          {source.matches.length ? <ul className="wq-matches">{source.matches.map((match) => <li key={match.draftSpan.start}><blockquote>{match.draftExcerpt}{match.excerptTruncated ? '…' : ''}</blockquote><div><button className="wq-locate" disabled={stale} onClick={() => locate(match.draftSpan)}>定位原文 {match.draftSpan.start + 1}–{match.draftSpan.end}</button><span className="wq-muted">来源字符 {match.sourceSpan.start + 1}–{match.sourceSpan.end}；{match.tokenCount} 词项</span></div></li>)}</ul> : source.status === 'compared' ? <p className="wq-muted">未发现满足本规则的连续词项重合，不能据此判定原创或排除语义改写。</p> : null}
          {source.matchesTruncated ? <p className="wq-warning">仅展示前 8 处代表性匹配。请分段审阅其余内容。</p> : null}
          {source.sharedWindows > 0 ? <p className="wq-suggestion">先判断是直接引语、必要术语还是转述。合理引用保留归属；需要改写时理解原意后重新组织论证，不只替换同义词。</p> : null}
        </article>)}</div>}
      </section> : null}

      <section className="wq-rewrite" aria-labelledby="wq-rewrite-heading">
        <div className="wq-section-heading"><h2 id="wq-rewrite-heading">准备有约束的 AI 修订</h2><Badge>尚未执行改写</Badge></div>
        <p className="wq-lead">先确认你要表达的意思。下面的约束会和原文一起放入新会话，供你审阅后发送给所选模型；此页面不会生成示例改写冒充真实结果。</p>
        <div className="wq-two-fields">
          <Field label="修订目标"><Select value={constraints.goal} onChange={(event) => setConstraints((current) => ({ ...current, goal: event.target.value as RewriteConstraints['goal'] }))}><option value="clarity">学术表达：具体、简洁，减少套语</option><option value="ethical-paraphrase">规范转述：重组论证，保留来源归属</option></Select></Field>
          <Field label="输出语言"><Select value={constraints.outputLanguage} onChange={(event) => setConstraints((current) => ({ ...current, outputLanguage: event.target.value as RewriteConstraints['outputLanguage'] }))}><option value="original">保持原文语言</option><option value="zh">中文</option><option value="en">English</option></Select></Field>
        </div>
        <Field label="预期意思与上下文" hint="说明这段支持什么主张、已有证据与适用条件。每项最多 2,000 字符。"><Textarea rows={3} maxLength={WRITING_LIMITS.maxConstraintChars} value={constraints.context} onChange={(event) => setConstraints((current) => ({ ...current, context: event.target.value }))} placeholder="例如：这是讨论段；只报告关联，不声称因果；样本仅来自单中心。" /></Field>
        <div className="wq-two-fields">
          <Field label="不可替换的术语" hint="用逗号、分号或换行分隔。数字和引用默认必须保留。"><Textarea rows={3} maxLength={WRITING_LIMITS.maxConstraintChars} value={constraints.protectedTerms} onChange={(event) => setConstraints((current) => ({ ...current, protectedTerms: event.target.value }))} placeholder="方法名称、量表、数据集名称、专有缩写" /></Field>
          <Field label="其他修订要求" hint="例如篇幅、目标读者或期刊语气；不要求检测通过。"><Textarea rows={3} maxLength={WRITING_LIMITS.maxConstraintChars} value={constraints.instructions} onChange={(event) => setConstraints((current) => ({ ...current, instructions: event.target.value }))} placeholder="例如：保留局限段；先给出改稿，再解释每项修改。" /></Field>
        </div>
        <div className="wq-preserve-contract"><CheckCheck size={18} aria-hidden="true" /><p><strong>固定保留约束：</strong>主张、数值与单位、样本量、统计结果、引用归属、否定与不确定性。不得补造研究结果或文献；来源不足时列出待核验项。</p></div>
        <label className="wq-consent"><input type="checkbox" checked={includeSources} disabled={!hasSources} onChange={(event) => setIncludeSources(event.target.checked)} /><span>我选择把所给来源的前 {WRITING_LIMITS.maxPromptSourceChars.toLocaleString()} 字符 / 份加入可编辑的改写请求（最多 6 份）。发送前仍可移除。</span></label>
        <p className="wq-muted">默认只附来源标签、重合位置与本地提示，不附来源正文。没有来源正文时，模型不能验证其含义；请自行补充必要且有权分享的片段。</p>
        {!currentProvider?.hasApiKey ? <p className="wq-warning">当前模型未配置可用凭据。可以准备草稿；实际发送与改写需要在设置中配置服务。已配置的 Key 也可能过期，本页不会测试或声称调用成功。</p> : <p className="wq-muted">实际改写使用当前所选模型（{modelSelection.modelId || '未选择'}）。已配置凭据不代表服务可用；只有你发送后才会发起模型调用。</p>}
        <div className="wq-run"><Button variant="primary" onClick={() => setConfirmPrepare(true)} disabled={!draft.trim() || draft.length > WRITING_LIMITS.maxRewriteChars || !projectId || !!busy}>准备改写草稿<ArrowRight size={16} aria-hidden="true" /></Button><span className="wq-muted">新建会话，不自动发送</span></div>
        {!projectId ? <p className="wq-warning">本地检查无需项目；准备 AI 请求前请先选择一个项目。</p> : null}
        {draft.length > WRITING_LIMITS.maxRewriteChars ? <p className="wq-warning">原文超过 20,000 字符，请只保留本次要修订的段落。不会静默截断改写内容。</p> : null}
      </section>

      <section className="wq-manual" aria-labelledby="wq-manual-heading">
        <div className="wq-section-heading"><h2 id="wq-manual-heading">核对真实修订稿</h2><span className="wq-muted">可选，手动粘贴</span></div>
        <p className="wq-lead">把你或模型实际完成的修订稿放在这里，核对数字、引用标记和指定术语是否改变。这里只做精确文本清单比较，不验证科学含义。</p>
        <Field label="实际修订后的文本"><Textarea rows={5} value={revised} onChange={(event) => setRevised(event.target.value)} placeholder="尚无修订结果。请粘贴真实改稿，不会自动填充。" spellCheck={false} /></Field>
        <div className="row wrap"><Button onClick={runRevisionCheck} disabled={!draft.trim() || !revised.trim()}><CheckCheck size={16} aria-hidden="true" />核对前后保留项</Button><Button variant="primary" disabled={!revised.trim() || !projectId || !!busy} onClick={() => setSaveOpen(true)}>另存修订稿为 DOCX</Button>{savedRevision ? <Button onClick={() => navigate(`/write/${savedRevision.id}`)}>打开已保存修订稿</Button> : null}</div>
        {revision ? <div className="wq-revision-result" aria-live="polite">
          {revisionStale ? <p className="wq-warning">原文、修订稿或术语已改变，请重新核对。</p> : null}
          {revision.report.original.truncated || revision.report.revised.truncated || revision.report.inventoryTruncated ? <p className="wq-warning">输入或保留项清单超出限制，以下不是完整核对。请分段检查。</p> : null}
          <div className="wq-two-fields"><div><h3>减少或变化的数字项</h3><Inventory items={revision.report.missingNumbers} empty="未发现已识别数值项减少。" /><h3>减少或变化的引用</h3><Inventory items={revision.report.missingCitations} empty="未发现已识别引用标记减少。" /></div><div><h3>新增或变化的数字项</h3><Inventory items={revision.report.addedNumbers} empty="未发现已识别数值项新增。" /><h3>新增或变化的引用</h3><Inventory items={revision.report.addedCitations} empty="未发现已识别引用标记新增。" /></div></div>
          <h3>未保留的指定术语</h3><p>{revision.report.missingTerms.length ? revision.report.missingTerms.join('、') : '未发现原文中已出现的指定术语被移除。'}</p>
          <p className="wq-muted">{revision.report.limitations.join(' ')}</p>
        </div> : null}
      </section>
      <details className="wq-method"><summary>方法、隐私与适用边界</summary><ul>{WRITING_LIMITATIONS.map((item) => <li key={item}>{item}</li>)}<li>分析和对照在本地进行，输入仅在当前应用会话的内存中按工作区及项目隔离保存。切换页面不会丢失；刷新或关闭应用后清空。另存修订稿、下载报告或发送智能体消息才会形成对应持久记录。</li><li>下载报告包含有界原文摘录、数字、引用与来源标签，可能仍含敏感信息；不含对照文本正文。请自行决定如何保存和分享。</li><li>数字、引用格式、文本截断及标点归一化都可能产生遗漏或误报。LaTeX 的命令和参考文献区也可能被当作普通正文，请优先检查需要修订的段落。</li></ul></details>

      {saveOpen ? <Modal title="另存修订稿" subtitle="创建独立的文字版 DOCX，不覆盖原文，不保留原稿复杂版式、图片或公式排版。" onClose={() => { if (!savingRef.current) setSaveOpen(false) }} footer={<><Button disabled={!!busy} onClick={() => setSaveOpen(false)}>取消</Button><Button variant="primary" disabled={!!busy || !revisionTitle.trim()} onClick={() => void saveRevision()}>{busy === 'save' ? '正在保存…' : '创建新文稿'}</Button></>}><Field label="修订稿标题"><Input autoFocus value={revisionTitle} maxLength={160} onChange={(event) => setRevisionTitle(event.target.value)} /></Field><p>只保存你在“实际修订后的文本”中输入的内容，不自动生成改稿。保存不代表通过事实、引用或平台查重验证。</p>{!revision || revisionStale ? <p className="wq-warning">尚未核对当前改稿的数字与引用，建议返回检查后再保存。</p> : null}</Modal> : null}
      {pendingImport ? <Modal title="替换当前粘贴的原文？" subtitle="载入所选文稿会替换当前原文和修订核对结果，不会修改磁盘上的文稿。" onClose={() => setPendingImport(null)} footer={<><Button onClick={() => setPendingImport(null)}>保留当前文本</Button><Button variant="primary" onClick={() => void loadDocument(pendingImport)}>载入并替换</Button></>}><p>将载入：{pendingImport.title}</p></Modal> : null}
      {confirmPrepare ? <Modal title="准备可编辑的改写请求" subtitle="此操作只新建会话并填入草稿，不调用模型。" onClose={() => { if (!busy) setConfirmPrepare(false) }} footer={<><Button disabled={!!busy} onClick={() => setConfirmPrepare(false)}>返回修改约束</Button><Button variant="primary" disabled={!!busy} onClick={() => void prepareRewrite()}>{busy === 'prepare' ? '正在准备…' : '放入新会话草稿'}</Button></>}>
        <p>请求将包含当前原文、你的修订约束、数字 / 引用保留清单和本地提示。{includeSources && hasSources ? '你已选择附带每份来源的前 2,000 字符。' : '不附来源正文，仅附标签及位置。'}</p>
        <p>本操作新建独立会话，不修改其他会话。返回本页时原文、来源与修订约束仍保留；刷新或关闭应用会清空内存。进入智能体后请先审阅，只有点击发送，文本才会交给当前模型服务商。</p>
        <p className="wq-muted">不会替换文稿，不承诺检测通过，不把草稿准备状态当作 AI 改写成功。</p>
      </Modal> : null}
    </div>
  )
}
