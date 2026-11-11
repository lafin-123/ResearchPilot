import { createHash } from 'node:crypto'
import type { ResearchWorkspaceService } from './research-workspaces'
import type { ProviderService } from './providers'
import type { SettingsService } from './settings'
import type { ReferenceService } from './references'
import type { DocumentService } from './documents'
import type { ProjectHealthService } from './project-health'
import { applyResearchOutput, researchPrompt, workspaceMarkdown, RESEARCH_OPERATIONS, type ResearchOperation, type ResearchWorkspace } from '../../shared/research-workflows'
import { generateResearchJson } from '../lib/model-generation'
import { requestViaSystemProxy } from '../lib/network'
import { clarificationInstruction } from '../../shared/research-interaction'
import { resolveAgentRole } from '../../shared/agent-roles'
import { extractPdfPages } from '../lib/research-sources'
import { searchCrossref } from './references'
import type { ApprovalService } from './approvals'
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
export class ResearchCoordinator {
 private active:{projectId:string;id:string;controller:AbortController}|null=null
 constructor(private readonly pages:ResearchWorkspaceService,private readonly providers:ProviderService,private readonly settings:SettingsService,private readonly references:ReferenceService,private readonly documents:DocumentService,private readonly health:ProjectHealthService,private readonly approvals:ApprovalService,private readonly otherBusy:()=>boolean,private readonly request:typeof fetch=requestViaSystemProxy){}
 isRunning():boolean{return !!this.active}
 status(){return this.active?{projectId:this.active.projectId,workspaceId:this.active.id}:null}
 stop(projectId:string,id:string):void{if(this.active?.projectId===projectId&&this.active.id===id)this.active.controller.abort(new Error('研究任务已停止。'))}
 close():void{this.active?.controller.abort(new Error('应用关闭，任务已中断。'))}
 private lease(projectId:string,id:string){if(this.active||this.otherBusy())throw new Error('已有研究任务执行中，请等待或停止后继续。');this.health.assertAvailable(projectId);const controller=new AbortController();this.active={projectId,id,controller};return controller}
 async collect(projectId:string,id:string,referenceId:string,pdfPage?:number):Promise<ResearchWorkspace>{
  const controller=this.lease(projectId,id)
  try{
   const w=this.pages.get(projectId,id),ref=this.references.get(projectId,referenceId)
   if(w.evidence.length>=100)throw new Error('来源卡已达上限。')
   let quote=ref.abstract.slice(0,12000),hash=sha(ref.title+'\n'+ref.abstract),locator=`reference:${ref.id}#abstract`,coverage:'pdf'|'abstract'='abstract'
   if(pdfPage!==undefined){const data=this.references.readPdf(projectId,referenceId);const result=await extractPdfPages(Buffer.from(data.base64,'base64'),{startPage:pdfPage,pageCount:1,maxChars:12000},controller.signal);quote=result.pages[0].text;hash=result.sha256;locator=`reference:${ref.id}#pdf-page=${pdfPage}&offset=0`;coverage='pdf'}
   controller.signal.throwIfAborted();if(!quote.trim())throw new Error('此来源范围没有可读取文本，请选择其他页或补充摘要。')
   w.evidence.push({id:`S${w.evidence.length+1}_${globalThis.crypto.randomUUID().slice(0,8)}`,referenceId:ref.id,title:ref.title,locator,quote,coverage,hash});w.draftStale=!!w.draft
   return this.pages.save(projectId,w,true)
  }finally{this.active=null}
 }
 private verifySources(projectId:string,w:ResearchWorkspace):void{
  for(const e of w.evidence){if(e.coverage==='artifact')continue;const ref=this.references.get(projectId,e.referenceId);const current=e.coverage==='abstract'?sha(ref.title+'\n'+ref.abstract):createHash('sha256').update(Buffer.from(this.references.readPdf(projectId,e.referenceId).base64,'base64')).digest('hex');if(current!==e.hash)throw new Error(`来源已变化：${e.title}，请重新添加当前版本。`)}
 }
 async search(projectId:string,id:string,query:string):Promise<unknown>{
  const controller=this.lease(projectId,id)
  try{this.pages.get(projectId,id);const permission=await this.approvals.request({origin:'agent',title:'研究探索：检索文献',description:'将检索词发送到Crossref，返回候选书目供选择。',details:query.slice(0,500),risk:'medium'},{signal:controller.signal,remember:false});if(!permission.approved)throw new Error('已取消外部检索。');return await searchCrossref(query.slice(0,500),15,controller.signal)}finally{this.active=null}
 }
 async run(projectId:string,id:string,operation:ResearchOperation,automatic=false,maxCalls=8):Promise<ResearchWorkspace>{
  if(!RESEARCH_OPERATIONS.includes(operation))throw new Error('未知研究操作。')
  const controller=this.lease(projectId,id);const signal=controller.signal;let calls=0
  const budget=Math.max(1,Math.min(20,Math.floor(Number(maxCalls)||8)))
  try{
   let w=this.pages.get(projectId,id)
   const generate=async(op:ResearchOperation,perspective?:ResearchWorkspace['perspectives'][number])=>{
    signal.throwIfAborted();if(++calls>budget)throw new Error(`已达到本次${budget}次模型调用上限，已完成产物保留。`)
    w=this.pages.get(projectId,id);this.verifySources(projectId,w);this.health.assertAvailable(projectId)
    const cfg=this.settings.get(),role=op==='method'?'engineering':op==='review'?'reviewer':op==='supervisor'||op==='perspectives'?'coordinator':'writing'
    const route=resolveAgentRole(role,cfg.agentRoleModels,this.providers.list())??resolveAgentRole('writing',cfg.agentRoleModels,this.providers.list())??{providerId:cfg.defaultProviderId,modelId:cfg.defaultModelId}
    const provider=this.providers.get(route.providerId),task=this.pages.begin(projectId,id,op,sha(JSON.stringify(w)),provider.id,route.modelId)
    try{
     const output=await generateResearchJson(provider,this.providers.apiKey(provider.id),route.modelId,researchPrompt(w,op,perspective)+'\n'+clarificationInstruction(cfg.researchClarification),this.request,signal)
     signal.throwIfAborted();this.health.assertAvailable(projectId);this.verifySources(projectId,w)
     w=this.pages.save(projectId,applyResearchOutput(w,op,output),true);this.pages.finish(task,'succeeded',JSON.stringify(output));return w
    }catch(error){this.pages.finish(task,signal.aborted?'cancelled':'failed','',error instanceof Error?error.message:String(error));throw error}
   }
   if(automatic){
    await generate('supervisor');if(!w.perspectives.length)await generate('perspectives')
    for(const perspective of w.perspectives.slice(0,3))await generate('round',perspective)
    await generate('outline');await generate('draft');await generate('review')
   }else if(operation==='round'){
    if(!w.perspectives.length)throw new Error('先生成或添加研究视角。')
    for(const perspective of w.perspectives.slice(0,3))await generate('round',perspective)
   }else await generate(operation)
   return w
  }finally{this.active=null}
 }
 async exportDoc(projectId:string,id:string){this.health.assertAvailable(projectId);const w=this.pages.get(projectId,id);return this.documents.create({projectId,title:w.topic,format:'docx',markdown:workspaceMarkdown(w)},()=>this.health.assertAvailable(projectId))}
}
