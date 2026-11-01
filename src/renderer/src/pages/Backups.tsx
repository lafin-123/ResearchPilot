import { useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download, ShieldCheck, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type { BackupExportResult, BackupPreview, BackupRestoreResult } from '@shared/backups'
import { BACKUP_WARNINGS } from '@shared/backups'
import { api, formatBytes, formatError } from '../lib/api'
import { useAppStore } from '../store/app'
import { Button, Modal, PageHeader } from '../components/Ui'

const names: Record<string,string> = { reference_items:'文献', documents:'文稿', document_versions:'文稿版本', project_notes:'研究笔记', note_links:'页面链接', reference_activity:'阅读活动', reference_reading_drafts:'AI 阅读草稿', pdf_annotations:'PDF 标注', figures:'科研图表', experiments:'实验', experiment_runs:'运行记录' }
function Contents({data}:{data:BackupExportResult|BackupPreview|BackupRestoreResult}):ReactNode {
 return <div className="backup-contents"><p>{data.fileCount} 个文件，{formatBytes(data.totalBytes)}</p><dl>{Object.entries(data.counts).filter(([,count])=>count>0).map(([name,count])=><div key={name}><dt>{names[name]??name}</dt><dd>{count}</dd></div>)}</dl></div>
}
export function BackupsPage():ReactNode {
 const navigate=useNavigate()
 const project=useAppStore(s=>s.projects.find(p=>p.id===s.activeProjectId))
 const refresh=useAppStore(s=>s.refreshBootstrap)
 const openProject=useAppStore(s=>s.openProject)
 const [busy,setBusy]=useState('')
 const [error,setError]=useState('')
 const [refreshWarning,setRefreshWarning]=useState('')
 const [exported,setExported]=useState<BackupExportResult|null>(null)
 const [preview,setPreview]=useState<BackupPreview|null>(null)
 const [restored,setRestored]=useState<BackupRestoreResult|null>(null)
 const lock=useRef(false)
 const exportProject=async():Promise<void>=>{
  if(!project||lock.current)return
  lock.current=true;setBusy('export');setError('')
  try{const result=await api.backups.exportProject(project.id);if(result){setExported(result);toast.success('项目备份已写入本地文件')}}catch(e){setError(formatError(e))}finally{lock.current=false;setBusy('')}
 }
 const inspect=async():Promise<void>=>{
  if(lock.current)return
  lock.current=true;setBusy('inspect');setError('');setPreview(null)
  try{const result=await api.backups.inspect();if(result)setPreview(result)}catch(e){setError(formatError(e))}finally{lock.current=false;setBusy('')}
 }
 const restore=async():Promise<void>=>{
  if(!preview||lock.current)return
  lock.current=true;setBusy('restore');setError('')
  try{
   const result=await api.backups.restoreCopy(preview.token)
   setRestored(result);setPreview(null)
   toast.success('已恢复为独立项目，原项目未修改')
   try{await refresh()}catch(e){setRefreshWarning(`资料已成功恢复，但项目列表刷新失败：${formatError(e)}。请点击“重新读取项目列表”，不要重复恢复。`)}
  }catch(e){setError(formatError(e));setPreview(null)}finally{lock.current=false;setBusy('')}
 }
  const retryRefresh=async():Promise<void>=>{
    if(lock.current)return
    lock.current=true;setBusy('refresh')
    try{await refresh();setRefreshWarning('')}catch(e){setRefreshWarning(`资料已成功恢复，但项目列表刷新失败：${formatError(e)}。请稍后重新读取，不要重复恢复。`)}finally{lock.current=false;setBusy('')}
  }
  return <div className="page backups-page">
  <PageHeader title="备份与恢复" subtitle="一起保存研究资料。恢复始终创建副本，不覆盖现有项目。" />
  <p className="backup-local"><ShieldCheck size={17}/>仅在本机处理，不上传备份、不调用模型。</p>
  {error&&<div role="alert" className="alert alert-danger">{error}</div>}
  {refreshWarning&&<div role="alert" className="alert alert-danger">{refreshWarning}<Button size="sm" disabled={!!busy} onClick={()=>void retryRefresh()}>重新读取项目列表</Button></div>}
  <div className="backup-actions">
   <section><Download size={24}/><h2>备份当前项目</h2><p>当前项目：<strong>{project?.name??'未选择'}</strong></p><p>保存文献、文稿、笔记、批注、图表和实验资料。请把备份放在可信位置。</p><Button variant="primary" disabled={!project||!!busy} onClick={()=>void exportProject()} data-testid="backup-export">{busy==='export'?'正在写入…':'导出项目备份'}</Button></section>
   <section><Upload size={24}/><h2>从备份恢复</h2><p>先检查完整性与内容，再明确确认恢复。不执行归档中的实验代码。</p><p>备份未加密，只打开自己信任的文件。</p><Button disabled={!!busy} onClick={()=>void inspect()} data-testid="backup-inspect">{busy==='inspect'?'正在检查…':'选择并检查备份'}</Button></section>
  </div>
  {exported&&<section className="backup-result" data-testid="backup-export-result"><h2>最近导出的备份</h2><p className="backup-path">{exported.path}</p><Contents data={exported}/><details><summary>本次备份说明</summary><ul>{exported.warnings.map(text=><li key={text}>{text}</li>)}</ul></details></section>}
  {restored&&<section className="backup-result" data-testid="backup-restore-result"><h2>已恢复：{restored.name}</h2><Contents data={restored}/><div className="row wrap"><Button variant="primary" disabled={!!busy} onClick={()=>void openProject(restored.projectId).then(()=>navigate('/'))}>进入恢复项目</Button><Button onClick={()=>void api.projects.reveal(restored.projectId).catch(e=>setError(formatError(e)))}>查看项目文件</Button></div><ul>{restored.warnings.map(text=><li key={text}>{text}</li>)}</ul></section>}
  <section className="backup-scope"><h2>备份范围与隐私</h2><ul>{BACKUP_WARNINGS.map(text=><li key={text}>{text}</li>)}</ul><Button onClick={()=>navigate('/setup')}>查看使用准备检查</Button></section>
  {preview&&<Modal title={`恢复副本：${preview.projectName}`} subtitle={`备份时间：${new Date(preview.createdAt).toLocaleString()}。原项目不会被替换。`} onClose={()=>{if(!busy)setPreview(null)}} footer={<><Button disabled={!!busy} onClick={()=>setPreview(null)}>取消</Button><Button variant="primary" disabled={!!busy} onClick={()=>void restore()} data-testid="backup-confirm-restore">{busy==='restore'?'正在恢复…':'创建独立恢复项目'}</Button></>}><Contents data={preview}/><ul>{preview.warnings.map(text=><li key={text}>{text}</li>)}</ul><p>预览超过有效期时，请重新选择文件。恢复后需核对来源标签、运行路径和稿件内容。</p></Modal>}
 </div>
}
