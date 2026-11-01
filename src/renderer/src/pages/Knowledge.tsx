import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { BookOpen, RefreshCw, Search } from 'lucide-react'
import type { KnowledgeSearchResult, KnowledgeStatus, ReferenceActivity } from '@shared/knowledge'
import { KNOWLEDGE_LIMITS } from '@shared/knowledge'
import { api, formatError } from '../lib/api'
import { useAppStore } from '../store/app'
import { Button, EmptyState, Input, PageHeader } from '../components/Ui'

const activityNames: Record<ReferenceActivity['kind'], string> = { created: '加入文献', imported: '导入文献', read: '阅读', note_updated: '更新笔记', pdf_attached: '关联 PDF', deleted: '删除文献' }
const channels: Record<string, string> = { reference_view: '文献详情', pdf_read: 'PDF 预览', mcp_read: '智能体 MCP 读取', doi: 'DOI', bibtex: 'BibTeX' }
const fields = { title: '标题', abstract: '摘要', notes: '笔记' }

export function KnowledgePage(): ReactNode {
  const projectId = useAppStore(state => state.activeProjectId)
  return projectId ? <ProjectKnowledge key={projectId} projectId={projectId} /> : <EmptyState title="先选择一个项目" text="知识索引与阅读记录始终限定在当前项目。" />
}

function ProjectKnowledge({ projectId }: { projectId: string }): ReactNode {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<KnowledgeStatus | null>(null)
  const [history, setHistory] = useState<ReferenceActivity[]>([])
  const [result, setResult] = useState<KnowledgeSearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)

  async function refresh(): Promise<void> {
    const id = ++generation.current
    setBusy(true); setError('')
    try {
      const [next, activities] = await Promise.all([api.knowledge.status(projectId), api.knowledge.activity({ projectId })])
      if (id !== generation.current) return
      setStatus(next); setHistory(activities)
    } catch (error) { if (id === generation.current) setError(formatError(error)) }
    finally { if (id === generation.current) setBusy(false) }
  }
  useEffect(() => { void refresh(); return () => { generation.current++ } }, [projectId])

  async function search(): Promise<void> {
    const id = ++generation.current
    setBusy(true); setError(''); setResult(null)
    try {
      const next = await api.knowledge.search({ projectId, query })
      if (id === generation.current) setResult(next)
    } catch (error) { if (id === generation.current) setError(formatError(error)) }
    finally { if (id === generation.current) setBusy(false) }
  }
  async function sync(): Promise<void> {
    const id = ++generation.current
    setBusy(true); setError(''); setResult(null)
    try {
      const next = await api.knowledge.sync(projectId)
      if (id !== generation.current) return
      setStatus(next)
      const activities = await api.knowledge.activity({ projectId })
      if (id === generation.current) setHistory(activities)
    } catch (error) { if (id === generation.current) setError(formatError(error)) }
    finally { if (id === generation.current) setBusy(false) }
  }

  return <div className="page" style={{ maxWidth: 1100 }}>
    <PageHeader title="项目知识与阅读记录" subtitle="从已登记的文献与笔记中找回上下文，保留来源，而不是让 AI 凭空记忆。" actions={<>
      <Link className="btn btn-secondary" to="/library"><BookOpen size={16} />编辑文献与笔记</Link>
      <Button onClick={() => void refresh()} disabled={busy}>刷新记录</Button>
      <Button onClick={() => void sync()} disabled={busy}><RefreshCw size={16} />同步索引</Button>
    </>} />
    {error && <p role="alert">{error}</p>}
    <section aria-label="索引范围" style={{ marginBottom: 24 }}>
      <p>本地 BM25 词项检索，支持中文与英文。检索片段会按当前问题自动提供给本项目智能体，并附来源 ID。</p>
      <p>发送智能体消息时，匹配的文献摘录会随当前问题发送给你选择的模型提供方；没有匹配时不附加来源。不要在文献笔记中保存密钥或其他敏感信息。</p>
      <p><strong>仅文献标题、摘要与文献笔记；PDF 正文未索引。</strong> 不使用外部嵌入服务，不扫描项目中的其他文件。请在文献笔记中保存需要共享的阅读结论。</p>
      <p><Link to="/notes">独立研究笔记</Link>用于组织项目页面、收藏与反向链接，当前不自动进入此文献 RAG 索引，也不会自动发送给模型。</p>
      {status && <>
        <p>{status.indexedReferences} / {status.references} 篇文献已索引；{status.chunks} 个片段；{status.pendingReferences} 篇待同步。关联的 {status.pdfAttachments} 个 PDF 不计入正文覆盖。</p>
        <p>最近索引：{status.lastIndexedAt ? new Date(status.lastIndexedAt).toLocaleString() : '尚未同步'}。已有文献可手动同步；新保存的文献与笔记自动更新。</p>
        {status.errors.map(item => <p role="alert" key={item.referenceId}>{item.referenceId}：{item.message}</p>)}
      </>}
    </section>
    <form onSubmit={event => { event.preventDefault(); void search() }} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      <Input aria-label="搜索项目知识" placeholder="输入问题或中英文关键词" maxLength={KNOWLEDGE_LIMITS.queryChars} value={query} onChange={event => setQuery(event.target.value)} style={{ flex: '1 1 280px' }} />
      <Button type="submit" variant="primary" disabled={busy || !query.trim()}><Search size={16} />搜索</Button>
    </form>
    <section aria-label="检索结果" aria-live="polite" style={{ marginTop: 24 }}>
      {busy && <p>正在处理…</p>}
      {result && <>
        <h2>检索结果</h2>
        {(result.queryTruncated || result.candidatesTruncated) && <p>检索达到字符、词项或索引候选上限；请使用更具体的关键词。</p>}
        {result.hits.length === 0 && <EmptyState title="没有匹配的片段" text="换用来源中的具体关键词，或先同步索引。无匹配结果时不会为智能体注入虚构来源。" />}
        {result.hits.map(hit => <article key={hit.sourceId} style={{ padding: '16px 0', borderBottom: '1px solid var(--line)', overflowWrap: 'anywhere' }}>
          <h3>{hit.title}</h3>
          <p>{fields[hit.field]}，字符 {hit.start}–{hit.end}，相关度 {hit.score.toFixed(3)}</p>
          <p style={{ maxWidth: '76ch', lineHeight: 1.8 }}>{hit.excerpt}</p>
          <p><code>{hit.sourceId}</code> — <code>{hit.path}</code></p>
          <small>摘录来自规范化并脱敏后的字段；偏移不代表 PDF 页码。</small>
        </article>)}
      </>}
    </section>
    <section aria-label="文献活动记录" style={{ marginTop: 36 }}>
      <h2>文献活动记录</h2>
      <p>最近 100 条真实操作。打开详情、PDF 预览与智能体 MCP 读取分别标记；同一来源一分钟内重复阅读合并。记录操作，不代表已读完全文。</p>
      {!history.length && <p>还没有记录。打开文献详情、保存笔记或导入文献后，会在这里留下记录；不会补造旧文献的阅读历史。</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {history.map(item => <li key={item.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--line)', overflowWrap: 'anywhere' }}>
          <strong>{activityNames[item.kind]}</strong>{item.channel && `（${channels[item.channel] ?? item.channel}）`} — {item.title}
          <div><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time> · {item.referenceId}</div>
        </li>)}
      </ul>
    </section>
  </div>
}
