import type { Db } from '../lib/db'
import { createResearchWorkspace, parseWorkspace, researchId, type ResearchKind, type ResearchWorkspace, type ResearchTask } from '../../shared/research-workflows'
import { newId, nowIso } from '../lib/util'
interface Row { id:string; project_id:string; content_json:string; revision:number }
export class ResearchWorkspaceService {
  constructor(private readonly db:Db) {
    this.db.run("UPDATE research_tasks SET status='interrupted',error='应用重启，当前步骤可以重新执行。',finished_at=? WHERE status IN ('running','pending')",nowIso())
  }
  list(projectId:string):Array<{id:string;topic:string;kind:ResearchKind;updatedAt:string;revision:number}> {
    researchId(projectId)
    return this.db.all<{id:string;topic:string;kind:ResearchKind;updated_at:string;revision:number}>('SELECT id,topic,kind,updated_at,revision FROM research_workspaces WHERE project_id=? ORDER BY updated_at DESC',projectId).map(row=>({id:row.id,topic:row.topic,kind:row.kind,updatedAt:row.updated_at,revision:row.revision}))
  }
  get(projectId:string,id:string):ResearchWorkspace {
    const row=this.db.get<Row>('SELECT * FROM research_workspaces WHERE project_id=? AND id=?',researchId(projectId),researchId(id))
    if(!row)throw new Error('研究工作页不存在或不属于当前项目。')
    return parseWorkspace(JSON.parse(row.content_json))
  }
  create(projectId:string,kind:ResearchKind,topic:string):ResearchWorkspace {
    if(!this.db.get('SELECT id FROM projects WHERE id=?',researchId(projectId)))throw new Error('项目不存在。')
    const w=parseWorkspace(createResearchWorkspace(kind,topic))
    this.db.run('INSERT INTO research_workspaces(id,project_id,kind,topic,revision,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',w.id,projectId,w.kind,w.topic,w.revision,JSON.stringify(w),w.createdAt,w.updatedAt)
    return w
  }
  save(projectId:string,raw:unknown,internal=false):ResearchWorkspace {
    const w=parseWorkspace(raw),previous=this.get(projectId,w.id)
    if(previous.revision!==w.revision)throw new Error('工作页版本冲突，请保留编辑后重新读取。')
    if(!internal&&(JSON.stringify(w.evidence)!==JSON.stringify(previous.evidence)||JSON.stringify(w.method.tests)!==JSON.stringify(previous.method.tests)))throw new Error('证据和运行记录由实际读取与执行产生，不能手动覆盖。')
    if(w.kind!==previous.kind||w.createdAt!==previous.createdAt)throw new Error('不能修改工作页身份。')
    if(!internal&&(w.method.environment!==previous.method.environment||w.method.codeHash!==previous.method.codeHash))throw new Error('方法环境和核验哈希由后端生成。')
    if(w.method.code!==previous.method.code||JSON.stringify(w.method.fields)!==JSON.stringify(previous.method.fields)||JSON.stringify(w.method.requirements)!==JSON.stringify(previous.method.requirements)){w.method.codeHash='';w.method.tests=[];if(JSON.stringify(w.method.requirements)!==JSON.stringify(previous.method.requirements))w.method.environment=''}
    if(JSON.stringify(w.outline)!==JSON.stringify(previous.outline)&&w.draft)w.draftStale=true
    w.revision++;w.updatedAt=nowIso()
    this.db.run('UPDATE research_workspaces SET topic=?,revision=?,content_json=?,updated_at=? WHERE project_id=? AND id=? AND revision=?',w.topic,w.revision,JSON.stringify(w),w.updatedAt,projectId,w.id,previous.revision)
    return w
  }
  remove(projectId:string,id:string):void {this.get(projectId,id);this.db.run('DELETE FROM research_workspaces WHERE project_id=? AND id=?',projectId,id)}
  tasks(projectId:string,id:string):ResearchTask[] {
    this.get(projectId,id)
    return this.db.all<{id:string;workspace_id:string;operation:string;status:string;input_hash:string;provider_id:string;model_id:string;output:string;error:string;created_at:string;finished_at:string}>('SELECT * FROM research_tasks WHERE project_id=? AND workspace_id=? ORDER BY created_at DESC LIMIT 100',projectId,id).map(t=>({id:t.id,workspaceId:t.workspace_id,operation:t.operation,status:t.status,inputHash:t.input_hash,providerId:t.provider_id,modelId:t.model_id,output:t.output,error:t.error,createdAt:t.created_at,finishedAt:t.finished_at}))
  }
  begin(projectId:string,id:string,operation:string,inputHash:string,providerId='',modelId=''):string {
    this.get(projectId,id);const taskId=newId('researchtask')
    this.db.run("INSERT INTO research_tasks(id,project_id,workspace_id,operation,status,input_hash,provider_id,model_id,created_at) VALUES(?,?,?,?,'running',?,?,?,?)",taskId,projectId,id,operation,inputHash,providerId,modelId,nowIso());return taskId
  }
  finish(id:string,status:string,output='',error=''):void {this.db.run('UPDATE research_tasks SET status=?,output=?,error=?,finished_at=? WHERE id=?',status,output.slice(0,100000),error.slice(0,2000),nowIso(),id)}
}
