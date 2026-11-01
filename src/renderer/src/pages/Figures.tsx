import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChartSpline, ChevronDown, Code2, Download, ExternalLink, Image as ImageIcon, Pencil, Plus, Save, Shapes, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Figure } from '@shared/types'
import { FIGURE_LIMITS, validateFigureSpec, type ChartFigureSpec, type FigureNode, type FigureSpec } from '@shared/figure-spec'
import { api, base64ToBlobUrl, formatError, relativeTime } from '../lib/api'
import { FigurePreview } from '../lib/figure-preview'
import { useAppStore } from '../store/app'
import { Badge, Button, EmptyState, Field, Input, Modal, PageHeader, Select, Textarea } from '../components/Ui'
import './figure-studio.css'
import './research-management.css'

const PLOT_TEMPLATE = `import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# Load your actual dataset/run artifacts, create your plot, then save:
# fig.savefig(os.environ["RESEARCHPILOT_FIGURE_PATH"], dpi=300, bbox_inches="tight")
# Python output is a PNG raster, not an editable PowerPoint model.
raise ValueError("请先加载真实实验数据并编写绘图代码。没有预填的基线或结果数值。")
`
const blank = (): ChartFigureSpec => ({ version: 1, kind: 'chart', chartType: 'bar', title: '', provenance: { sourceLabel: '', isDemo: false }, xLabel: '', yLabel: '', labels: [], series: [] })
const newNode = (id: string, index: number): FigureNode => ({ id, label: '研究步骤', shape: 'roundRect', x: Math.min(760, index % 4 * 245), y: Math.min(330, Math.floor(index / 4) * 110), width: 220, height: 90 })

function parseData(text: string, draft: ChartFigureSpec): FigureSpec {
  const rows = text.trim().split(/\r?\n/).map(row => row.split('\t').map(cell => cell.trim()))
  if (rows.length < 3 || rows[0].length < 2) throw new Error('请粘贴至少一列系列名及两行数据，用 Tab 分列（可从电子表格复制）。')
  const width = rows[0].length
  if (width > 4 || rows.slice(1).some(row => row.length !== width)) throw new Error('每行列数须一致；最多 3 个数据系列。')
  const numeric = (cell: string): number => {
    if (!cell || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(cell)) throw new Error(`数值无效：「${cell}」。不可留空，不自动填 0。`)
    return Number(cell)
  }
  const { labels: _labels, xValues: _xValues, ...base } = draft
  return validateFigureSpec({ ...base, ...(draft.chartType === 'scatter' ? { xValues: rows.slice(1).map(row => numeric(row[0])) } : { labels: rows.slice(1).map(row => row[0]) }), series: rows[0].slice(1).map((name, i) => ({ name, values: rows.slice(1).map(row => numeric(row[i + 1])) })) })
}
function dataText(spec: ChartFigureSpec): string {
  return [['X', ...spec.series.map(s => s.name)], ...(spec.labels ?? spec.xValues ?? []).map((x, i) => [x, ...spec.series.map(s => s.values[i])])].map(row => row.join('\t')).join('\n')
}

function FigureImage({ figure }: { figure: Figure }): ReactNode {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let active = true; let created = ''
    setUrl('')
    void api.figures.read(figure.projectId, figure.id).then(data => {
      if (!active) return
      if (!['image/png', 'image/jpeg', 'image/svg+xml'].includes(data.mimeType)) return
      created = base64ToBlobUrl(data.base64, data.mimeType); setUrl(created)
    }).catch(() => setUrl(''))
    return () => { active = false; if (created) URL.revokeObjectURL(created) }
  }, [figure.projectId, figure.id, figure.filePath])
  return url ? <img className="figure-img" src={url} alt={figure.name} /> : <div className="figure-img figure-image-empty"><ImageIcon size={24} /></div>
}

export function FiguresPage(): ReactNode {
  const projectId = useAppStore(state => state.activeProjectId)
  const navigate = useNavigate()
  const projectRef = useRef(projectId)
  projectRef.current = projectId
  const loadVersion = useRef(0)
  const advancedMenu = useRef<HTMLDetailsElement>(null)
  const [preview, setPreview] = useState<Figure | null>(null)
  const askAssistant = (): void => {
    useAppStore.getState().seedPrompt('请读取当前项目真实实验结果与方法说明，自动生成带明确来源的科研图表和原生可编辑 PPT。优先使用结构化图表或节点/边，保存 JSON、SVG 与 PPTX，不用整图截图冒充可编辑对象。不编造数据、基线或显著性；缺少必要输入时先说明。')
    navigate('/agent')
  }
  const openAdvanced = (open: () => void): void => {
    if (advancedMenu.current) advancedMenu.current.open = false
    open()
  }
  const figureVersion = useAppStore(state => state.figureVersion)
  const [figures, setFigures] = useState<Figure[]>([])
  const [studio, setStudio] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [draft, setDraft] = useState<FigureSpec>(blank)
  const [table, setTable] = useState('')
  const [busy, setBusy] = useState(false)
  const [pythonOpen, setPythonOpen] = useState(false)
  const [name, setName] = useState('')
  const [caption, setCaption] = useState('')
  const [code, setCode] = useState(PLOT_TEMPLATE)
  const validation = useMemo(() => {
    try { return { spec: draft.kind === 'chart' ? parseData(table, draft) : validateFigureSpec(draft), error: '' } }
    catch (error) { return { spec: null, error: formatError(error) } }
  }, [draft, table])

  const load = async (): Promise<void> => {
    if (!projectId) { setFigures([]); return }
    const version = ++loadVersion.current
    try {
      const rows = await api.figures.list(projectId)
      if (projectRef.current === projectId && version === loadVersion.current) setFigures(rows)
    } catch (error) { if (projectRef.current === projectId && version === loadVersion.current) toast.error(formatError(error)) }
  }
  useEffect(() => { void load(); return () => { loadVersion.current += 1 } }, [projectId, figureVersion])
  useEffect(() => { setStudio(false); setPythonOpen(false); setPreview(null); setFigures([]) }, [projectId])

  const create = (): void => { setEditingId(''); setDraft(blank()); setTable(''); setStudio(true) }
  const edit = async (figure: Figure): Promise<void> => {
    try {
      const spec = await api.figures.getStructured(figure.projectId, figure.id)
      if (projectRef.current !== figure.projectId) return
      setEditingId(figure.id); setDraft(spec); setTable(spec.kind === 'chart' ? dataText(spec) : ''); setStudio(true)
    } catch (error) { toast.error(formatError(error)) }
  }
  const changeKind = (kind: string): void => {
    const common = { version: 1 as const, title: draft.title, provenance: draft.provenance }
    setDraft(kind === 'diagram' ? { ...common, kind: 'diagram', nodes: [newNode('n1', 0)], edges: [] } : { ...blank(), ...common, chartType: kind as ChartFigureSpec['chartType'] })
  }
  const demo = (): void => {
    if (draft.kind === 'diagram') setDraft({ version: 1, kind: 'diagram', title: '示例：研究方法流程', provenance: { sourceLabel: '教学演示：非真实实验或证据', isDemo: true }, nodes: [newNode('n1', 0), { ...newNode('n2', 1), label: '分析步骤' }, { ...newNode('n3', 2), label: '验证方案' }], edges: [{ id: 'e1', from: 'n1', to: 'n2' }, { id: 'e2', from: 'n2', to: 'n3' }] })
    else {
      setDraft({ ...blank(), title: '示例：合成数据（非证据）', chartType: draft.chartType, provenance: { sourceLabel: '教学演示：手工合成数据，非真实实验', isDemo: true }, xLabel: draft.chartType === 'scatter' ? '合成 X' : '示例类别', yLabel: '示例数值' })
      setTable('X\t合成系列\n1\t3\n2\t5\n3\t4')
    }
  }
  const save = async (): Promise<void> => {
    if (!projectId || !validation.spec) return
    setBusy(true)
    try {
      const figure = editingId ? await api.figures.saveStructured(projectId, editingId, validation.spec) : await api.figures.createStructured({ projectId, spec: validation.spec })
      if (projectRef.current !== projectId) return
      setEditingId(figure.id)
      toast.success('已保存 JSON 源文件、SVG 预览与可编辑 PPTX')
      await load()
    } catch (error) { toast.error(formatError(error)) } finally { setBusy(false) }
  }
  const exportPpt = async (figure: Figure): Promise<void> => {
    setBusy(true)
    try {
      await api.figures.exportPptx(figure.projectId, figure.id)
      const data = await api.figures.read(figure.projectId, figure.id, 'pptx')
      const url = base64ToBlobUrl(data.base64, data.mimeType)
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${figure.name.replace(/[<>:"/\\|?*]/g, '-')}.pptx`; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
      toast.success('可编辑 PowerPoint 已导出；原文件也保存在工作区')
      await load()
    } catch (error) { toast.error(formatError(error)) } finally { setBusy(false) }
  }
  const downloadPreview = async (figure: Figure): Promise<void> => {
    try {
      const data = await api.figures.read(figure.projectId, figure.id, 'preview')
      const url = base64ToBlobUrl(data.base64, data.mimeType)
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = data.fileName; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (error) { toast.error(formatError(error)) }
  }
  const renderPython = async (): Promise<void> => {
    if (!projectId || !name.trim()) return
    setBusy(true)
    try {
      await api.figures.render({ projectId, name: name.trim(), caption, code })
      setPythonOpen(false); toast.success('已生成 PNG 栅格图（无可编辑模型）'); await load()
    } catch (error) { toast.error(formatError(error)) } finally { setBusy(false) }
  }
  const remove = async (figure: Figure): Promise<void> => {
    if (!window.confirm(`删除图表「${figure.name}」？工作区源文件修订仍保留。`)) return
    try { await api.figures.remove(figure.projectId, figure.id); await load() } catch (error) { toast.error(formatError(error)) }
  }
  const updateNode = (id: string, patch: Partial<FigureNode>): void => {
    if (draft.kind === 'diagram') setDraft({ ...draft, nodes: draft.nodes.map(n => n.id === id ? { ...n, ...patch } : n) })
  }

  return <div className="page research-management figure-page">
    <PageHeader title="图表与演示" subtitle="审阅助手生成的科研图、来源和可编辑 PPT，集中管理研究产物。" actions={<><Button onClick={() => navigate('/pipeline')}>打开研究流程</Button><Button variant="primary" disabled={!projectId} onClick={askAssistant}>让助手生成</Button></>} />
    <div className="figure-gallery-heading"><span>{figures.length} 项图表产物</span><details className="research-menu" ref={advancedMenu}><summary className="btn btn-ghost" data-testid="figure-advanced-tools">高级工具<ChevronDown size={14} /></summary><div className="research-menu-items"><Button disabled={!projectId || busy} onClick={() => openAdvanced(create)}><Plus />新建可编辑图</Button><Button disabled={!projectId || busy} onClick={() => openAdvanced(() => setPythonOpen(true))}><Code2 />Python 栅格图</Button></div></details></div>
    {!figures.length ? <div className="card"><EmptyState icon={<ChartSpline />} title="研究产物会汇集在这里" text="研究流程的绘图与报告阶段由助手自动生成图表和可编辑 PPT。这里用于预览、核对来源和导出；无需先填写数据表或编写绘图代码。" action={<Button disabled={!projectId} onClick={askAssistant}>让助手生成</Button>} /></div> : <div className="figure-grid">
      {figures.map(figure => <article className="card figure-card" key={figure.id}>
        <button className="figure-preview-button" aria-label={`预览 ${figure.name}`} onClick={() => setPreview(figure)}><FigureImage figure={figure} /></button>
        <div className="figure-info">
          <div className="card-title">{figure.name}</div>
          <div className="figure-format">{figure.sourcePath ? figure.modelKind === 'diagram' ? '方法流程图 / 原生可编辑 PPT' : '数据图 / 原生可编辑 PPT' : '栅格图 / 无可编辑模型'}</div>
          <p className="figure-source">{figure.provenance?.isDemo ? '演示内容，非研究证据：' : '声明来源：'}{figure.provenance?.sourceLabel || '未记录来源，使用前请核对'}{figure.experimentId ? <span className="figure-experiment-source">关联实验：{figure.experimentId}</span> : null}</p>
          {figure.caption && <p className="card-sub">{figure.caption}</p>}
          <div className="small muted">{relativeTime(figure.updatedAt ?? figure.createdAt)}{figure.pptxPath ? ' · SVG / PPTX' : ` · ${figure.format.toUpperCase()}`}</div>
          <div className="figure-card-actions">
            {figure.sourcePath && <Button size="sm" disabled={busy} onClick={() => void exportPpt(figure)}><Download />导出 PPT</Button>}
            <Button size="sm" onClick={() => void downloadPreview(figure)}>下载 {figure.sourcePath ? 'SVG' : figure.format.toUpperCase()}</Button>
            <details className="research-menu"><summary className="btn btn-ghost btn-sm" aria-label={`${figure.name} 的更多操作`}>更多<ChevronDown size={13} /></summary><div className="research-menu-items">
              <Button size="sm" onClick={() => void api.figures.open(figure.projectId, figure.id).catch(error => toast.error(formatError(error)))}><ExternalLink />打开文件夹</Button>
              {figure.sourcePath && <Button size="sm" disabled={busy} onClick={() => void edit(figure)}><Pencil />编辑模型</Button>}
              <Button size="sm" disabled={busy} onClick={() => void remove(figure)}><Trash2 />删除图表</Button>
            </div></details>
          </div>
        </div>
      </article>)}
    </div>}
    {preview && <Modal title={preview.name} subtitle={preview.sourcePath ? '图表预览；PPT 中保留原生可编辑数据或形状。' : '栅格图片，没有原生可编辑模型。'} size="wide" onClose={() => setPreview(null)} footer={<><Button onClick={() => setPreview(null)}>关闭</Button><Button onClick={() => void downloadPreview(preview)}>下载 {preview.sourcePath ? 'SVG' : preview.format.toUpperCase()}</Button>{preview.sourcePath && <Button variant="primary" disabled={busy} onClick={() => void exportPpt(preview)}>导出 PPT</Button>}</>}><div className="research-figure-preview"><FigureImage figure={preview} /><p>{preview.provenance?.isDemo ? '演示内容，非研究证据：' : '声明来源：'}{preview.provenance?.sourceLabel || '未记录来源，使用前请核对'}</p>{preview.caption && <p>{preview.caption}</p>}</div></Modal>}

    {studio && <Modal title={editingId ? '编辑科研图' : '新建可编辑科研图'} subtitle="本地原生生成，不调用图像或 AI 服务。数据图包含内嵌工作簿；流程图包含独立形状、文字与连线。" size="wide" onClose={() => { if (!busy) setStudio(false) }} footer={<><span className="figure-save-note">每次保存自动更新对应 PPTX</span><Button disabled={busy} onClick={() => setStudio(false)}>关闭</Button><Button variant="primary" disabled={busy || !validation.spec} onClick={() => void save()}><Save />{busy ? '正在生成…' : '保存并生成 PPT'}</Button></>}>
      <div className="figure-studio-layout">
        <section className="figure-controls" aria-label="图表编辑器">
          <div className="grid-2"><Field label="图表类型"><Select value={draft.kind === 'diagram' ? 'diagram' : draft.chartType} onChange={e => changeKind(e.target.value)}><option value="bar">柱状图 · 比较大小</option><option value="line">折线图 · 等间隔趋势</option><option value="scatter">散点图 · 数值 X/Y</option><option value="diagram">科研方法 / 工作流程</option></Select></Field><Field label="标题"><Input value={draft.title} maxLength={100} onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="由你命名，不预设研究结论" /></Field></div>
          <Field label="来源标签（必填）" hint="注明真实 run / 数据集 / 文献；方法草案请标注“拟议”。声明不等于验证。"><Input maxLength={240} value={draft.provenance.sourceLabel} onChange={e => setDraft({ ...draft, provenance: { ...draft.provenance, sourceLabel: e.target.value } })} placeholder="如 experiments/run_…/results.csv；或拟议研究方法 v1" /></Field>
          <div className="figure-provenance-row"><label><input type="checkbox" checked={draft.provenance.isDemo} onChange={e => setDraft({ ...draft, provenance: { ...draft.provenance, isDemo: e.target.checked } })} />合成 / 演示内容（明确标记非证据）</label><Button size="sm" onClick={demo}>载入演示（非证据）</Button></div>
          {draft.kind === 'chart' ? <>
            <div className="grid-2"><Field label="X 轴名称 / 单位"><Input value={draft.xLabel} onChange={e => setDraft({ ...draft, xLabel: e.target.value })} /></Field><Field label="Y 轴名称 / 单位"><Input value={draft.yLabel} onChange={e => setDraft({ ...draft, yLabel: e.target.value })} /></Field></div>
            <Field label="数据（Tab 分列，第一行为列名）" hint="从电子表格直接复制。第一列为类别或散点 X，后 1–3 列为测量系列，2–200 行。空值不自动填零。"><Textarea className="figure-data-input" aria-label="图表数据" value={table} onChange={e => setTable(e.target.value)} placeholder={'X\t系列名称\n请粘贴真实数据，不预填示例值'} /></Field>
            <p className="figure-help">{draft.chartType === 'line' ? '折线使用等间隔类别轴；不等间距数值请用散点图。' : draft.chartType === 'bar' ? '柱状图从零基线绘制，支持正负数值。' : '各系列共用第一列数值 X；不连接散点，不暗示时间连续性。'} 单一 Y 轴，无虚构误差棒或显著性。</p>
          </> : <>
            <div className="row-between"><strong>节点 · 位置与文本</strong><Button size="sm" disabled={draft.nodes.length >= FIGURE_LIMITS.nodes} onClick={() => setDraft({ ...draft, nodes: [...draft.nodes, newNode(`n${Date.now()}`, draft.nodes.length)] })}><Plus />节点</Button></div>
            <p className="figure-help">内容画布 1000 × 440。X/Y/宽/高均可编辑，超界或文本放不下时不能保存。</p>
            <div className="figure-node-list">{draft.nodes.map(node => <div className="figure-node" key={node.id}>
              <div className="figure-node-heading"><span className="tiny muted">{node.id}</span><button className="btn btn-ghost btn-icon" aria-label={`删除节点 ${node.id}`} disabled={draft.nodes.length < 2} onClick={() => setDraft({ ...draft, nodes: draft.nodes.filter(n => n.id !== node.id), edges: draft.edges.filter(e => e.from !== node.id && e.to !== node.id) })}><Trash2 size={13} /></button></div>
              <div className="grid-2"><Field label="节点文字"><Input value={node.label} onChange={e => updateNode(node.id, { label: e.target.value })} /></Field><Field label="形状"><Select value={node.shape} onChange={e => updateNode(node.id, { shape: e.target.value as FigureNode['shape'] })}><option value="roundRect">圆角矩形</option><option value="rect">矩形</option><option value="ellipse">椭圆</option><option value="diamond">菱形</option></Select></Field></div>
              <div className="figure-coordinates">{(['x', 'y', 'width', 'height'] as const).map(key => <Field key={key} label={{ x: 'X', y: 'Y', width: '宽', height: '高' }[key]}><Input type="number" step="10" value={Number.isNaN(node[key]) ? '' : node[key]} onChange={e => updateNode(node.id, { [key]: e.target.valueAsNumber })} /></Field>)}</div>
            </div>)}</div>
            <div className="row-between"><strong>连接 · 独立箭头</strong><Button size="sm" disabled={draft.nodes.length < 2 || draft.edges.length >= FIGURE_LIMITS.edges} onClick={() => setDraft({ ...draft, edges: [...draft.edges, { id: `e${Date.now()}`, from: draft.nodes[0].id, to: draft.nodes[1].id }] })}><Plus />连接</Button></div>
            {draft.edges.map(edge => <div className="figure-edge" key={edge.id}>
              <Select aria-label={`${edge.id} 起点`} value={edge.from} onChange={e => setDraft({ ...draft, edges: draft.edges.map(v => v.id === edge.id ? { ...v, from: e.target.value } : v) })}>{draft.nodes.map(n => <option key={n.id} value={n.id}>{n.label} ({n.id})</option>)}</Select><span>→</span>
              <Select aria-label={`${edge.id} 终点`} value={edge.to} onChange={e => setDraft({ ...draft, edges: draft.edges.map(v => v.id === edge.id ? { ...v, to: e.target.value } : v) })}>{draft.nodes.map(n => <option key={n.id} value={n.id}>{n.label} ({n.id})</option>)}</Select>
              <Input aria-label={`${edge.id} 标签`} value={edge.label ?? ''} placeholder="连接标签（可选）" onChange={e => setDraft({ ...draft, edges: draft.edges.map(v => v.id === edge.id ? { ...v, label: e.target.value } : v) })} />
              <button className="btn btn-ghost btn-icon" aria-label={`删除连接 ${edge.id}`} onClick={() => setDraft({ ...draft, edges: draft.edges.filter(v => v.id !== edge.id) })}><Trash2 size={13} /></button>
            </div>)}
            <p className="figure-help">PPT 中节点、文字与箭头独立可编辑；移动节点后，需手动调整箭头（不承诺自动重连）。</p>
          </>}
        </section>
        <section className="figure-preview-panel" aria-label="实时图表预览"><div className="row-between"><strong>模型预览</strong><Badge tone={draft.provenance.isDemo ? 'gold' : 'blue'}>{draft.provenance.isDemo ? '示例 / 非证据' : '来源由用户声明'}</Badge></div>
          {validation.spec ? <><FigurePreview spec={validation.spec} />{validation.spec.kind === 'chart' && <details className="figure-data-table"><summary>查看完整数据表（可访问替代视图）</summary><div><table><thead><tr><th>{validation.spec.xLabel || 'X'}</th>{validation.spec.series.map(s => <th key={s.name}>{s.name}</th>)}</tr></thead><tbody>{(validation.spec.labels ?? validation.spec.xValues ?? []).map((x, i) => <tr key={i}><td>{x}</td>{validation.spec!.kind === 'chart' && validation.spec!.series.map(s => <td key={s.name}>{s.values[i]}</td>)}</tr>)}</tbody></table></div></details>}</> : <div className="figure-validation" role="status"><Shapes size={32} /><strong>准备你的图表模型</strong><p>{validation.error}</p><span>填写标题、来源和数据后显示预览。未提供数据时不会生成实验结果。</span></div>}
          <p className="figure-help">SVG 与 PPT 分别从同一 JSON 模型生成，布局可能略有差异。PPT 数据图可在 PowerPoint「编辑数据」中修改；绝不是把预览图片铺满幻灯片。</p>
        </section>
      </div>
    </Modal>}
    {pythonOpen && <Modal title="Python 绘图 · 栅格输出" subtitle="点击运行会在本机执行代码。保留任意 Python 绘图能力；PNG 无结构化编辑模型，不提供伪可编辑 PPT。" size="wide" onClose={() => { if (!busy) setPythonOpen(false) }} footer={<><Button disabled={busy} onClick={() => setPythonOpen(false)}>取消</Button><Button variant="primary" disabled={busy || !name.trim() || !code.trim()} onClick={() => void renderPython()}>{busy ? '运行中…' : '运行并生成 PNG'}</Button></>}>
      <div className="grid-2"><Field label="图表名称"><Input value={name} onChange={e => setName(e.target.value)} /></Field><Field label="来源 / 图注"><Input value={caption} onChange={e => setCaption(e.target.value)} placeholder="注明数据来源；演示请标记非证据" /></Field></div><Field label="Python 脚本"><Textarea className="figure-python-input" value={code} onChange={e => setCode(e.target.value)} /></Field>
    </Modal>}
  </div>
}
