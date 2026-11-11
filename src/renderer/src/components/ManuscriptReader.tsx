import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { FilePenLine, RefreshCw } from 'lucide-react'
import type { DocumentRecord } from '@shared/types'
import { api, formatError } from '../lib/api'
import { readerChapters } from '../lib/writing-reader'
import { useAppStore } from '../store/app'
import { Button } from './Ui'

export function ManuscriptReader({ projectId, document }: { projectId: string; document: DocumentRecord }): ReactNode {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [active, setActive] = useState('')
  const [truncated, setTruncated] = useState(false)
  const sections = useRef(new Map<string, HTMLElement>())
  useEffect(() => {
    let cancelled = false
    setText(''); setLoading(true); setError(''); setTruncated(false)
    void api.documents.readText(projectId, document.id).then(result => {
      if (cancelled || useAppStore.getState().activeProjectId !== projectId) return
      const visible = result.text.slice(0, 300000)
      setText(visible); setTruncated(result.text.length > 300000)
      setActive(readerChapters(visible, document.title)[0]?.id ?? '')
    }).catch(cause => { if (!cancelled) setError(formatError(cause)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectId, document.id, document.updatedAt, reload])
  const chapters = readerChapters(text, document.title)
  return <section className="manuscript-workspace" aria-label="文稿阅读区">
    <div className="manuscript-toolbar">
      <div><span className="manuscript-format">{document.format === 'docx' ? 'Word 文稿' : 'LaTeX 文稿'}</span><span className="manuscript-reading-note">已保存正文</span></div>
      <div className="row"><Button size="sm" variant="ghost" disabled={loading} onClick={() => setReload(value => value + 1)} aria-label="刷新正文"><RefreshCw size={14}/></Button><Button size="sm" variant="primary" onClick={() => navigate(`/write/${document.id}`)}><FilePenLine size={14}/>打开编辑器</Button></div>
    </div>
    <div className="manuscript-reading-layout">
      <nav className="manuscript-outline" aria-label="文稿章节"><span className="manuscript-outline-label">章节</span>{chapters.map(chapter => <button key={chapter.id} aria-current={active === chapter.id ? 'location' : undefined} onClick={() => { setActive(chapter.id); sections.current.get(chapter.id)?.scrollIntoView({ block: 'start', behavior: 'auto' }) }}>{chapter.title}</button>)}</nav>
      <div className="manuscript-page-wrap">
        {loading ? <div className="manuscript-placeholder" role="status">正在读取正文…</div> : error ? <div className="manuscript-placeholder" role="alert"><h2>正文暂时无法读取</h2><p>{error}</p><Button onClick={() => setReload(value => value + 1)}>重新读取</Button></div> : <article className="manuscript-paper">
          <header className="manuscript-paper-heading"><h1>{document.title}</h1><p>{document.format === 'docx' ? '正文阅读预览，排版与公式请在编辑器查看。' : '源码文字预览，完整排版请在编辑器编译。'}</p></header>
          {!text.trim() ? <p className="manuscript-empty">正文还是空的。打开编辑器，开始写下第一段。</p> : chapters.map(chapter => <section className="manuscript-chapter" key={chapter.id} ref={element => { if (element) sections.current.set(chapter.id, element); else sections.current.delete(chapter.id) }}>
            {chapter.title !== '正文' && chapter.title !== document.title ? <h2>{chapter.title}</h2> : null}
            {chapter.body.split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
          </section>)}
          {truncated ? <p className="manuscript-truncation">阅读区显示前300,000字符，其余内容请在编辑器查看；原文未截断或修改。</p> : null}
        </article>}
      </div>
    </div>
  </section>
}
