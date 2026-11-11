import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import JSZip from 'jszip'
import type { ResearchWorkspaceService } from './research-workspaces'
import type { ProjectService } from './projects'
import type { ExperimentService } from './experiments'
import type { SettingsService } from './settings'
import type { ApprovalService } from './approvals'
import type { ProjectHealthService } from './project-health'
import { validateMethodInput, methodVerification, type MethodTest } from '../../shared/research-workflows'
import { ensureFigureDir, figurePath } from '../lib/figure-files'
import { pythonCommandAvailable } from '../lib/python-runtime'
import { newId } from '../lib/util'
import { inspectMethodSource, checkoutMethodSource, prepareMethodEnvironment, methodRequirements, methodChildEnvironment } from '../lib/method-environment'
import { accountDataRoot } from '../lib/paths'
import { join } from 'node:path'
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
export interface MethodRunInput { projectId:string; id:string; inputs:Record<string,unknown>; expected?:Record<string,number>; tolerance?:number; timeoutSeconds?:number }
export class ResearchMethodService {
 private active:{projectId:string;id:string;controller:AbortController}|null=null
 constructor(private readonly pages:ResearchWorkspaceService,private readonly projects:ProjectService,private readonly experiments:ExperimentService,private readonly settings:SettingsService,private readonly approvals:ApprovalService,private readonly health:ProjectHealthService,private readonly otherBusy:()=>boolean){}
 isRunning(){return !!this.active}
 stop(projectId:string,id:string){if(this.active?.projectId===projectId&&this.active.id===id)this.active.controller.abort(new Error('方法运行已停止。'))}
 close(){this.active?.controller.abort(new Error('应用关闭。'))}
 async source(projectId:string,id:string,localPath?:string){
  if(this.active||this.otherBusy())throw new Error('请等待当前研究任务。')
  const controller=new AbortController();this.active={projectId,id,controller}
  try{const w=this.pages.get(projectId,id);this.health.assertAvailable(projectId)
   const approval=await this.approvals.request({origin:'agent',title:localPath?'读取论文方法源码目录':'获取论文方法GitHub源码',description:'只盘点代码、教程和依赖文件，不执行仓库安装脚本。',details:localPath??w.method.repositoryUrl,risk:'medium'},{signal:controller.signal,remember:false})
   if(!approval.approved)throw new Error('已取消源码读取。')
   const inventory=localPath?inspectMethodSource(localPath):await checkoutMethodSource(w.method.repositoryUrl,join(accountDataRoot(),'research-sources'),controller.signal)
   controller.signal.throwIfAborted();this.health.assertAvailable(projectId)
   const preview=inventory.files.map(file=>`FILE ${file.path} SHA256 ${file.sha256}\n${file.text.slice(0,4000)}`).join('\n\n').slice(0,11000)
   w.method.sourceBinding=`源码版本：${inventory.commit}\n${preview}${inventory.truncated?'\n[清单有界，未包含全部源码]':''}`
   return this.pages.save(projectId,w,true)
  }finally{this.active=null}
 }
 async environment(projectId:string,id:string){
  if(this.active||this.otherBusy())throw new Error('请等待当前研究任务。')
  const controller=new AbortController();this.active={projectId,id,controller}
  try{const w=this.pages.get(projectId,id),requirements=methodRequirements(w.method.requirements),python=this.settings.get().pythonPath.trim()
   if(!python||!pythonCommandAvailable(python))throw new Error('先配置Python解释器。')
   const approval=await this.approvals.request({origin:'agent',title:'准备方法专属Python环境',description:'创建独立venv，按列表下载二进制依赖；不运行下载仓库的setup脚本。',details:`Python：${python}\n依赖：${requirements.join(', ')||'仅标准库'}\n网络包安装存在供应链风险，请确认来源。`,risk:'high'},{signal:controller.signal,remember:false})
   if(!approval.approved)throw new Error('已取消环境准备。')
   this.health.assertAvailable(projectId)
   const interpreter=await prepareMethodEnvironment(python,join(accountDataRoot(),'method-environments'),requirements,controller.signal)
   controller.signal.throwIfAborted();w.method.environment=interpreter;w.method.tests=[];return this.pages.save(projectId,w,true)
  }finally{this.active=null}
 }
 async run(input:MethodRunInput):Promise<MethodTest>{
  if(this.active||this.otherBusy())throw new Error('请等待当前研究任务完成。')
  const controller=new AbortController();this.active={projectId:input.projectId,id:input.id,controller}
  let task='',runId=''
  try{
   const w=this.pages.get(input.projectId,input.id),method=w.method
   if(w.kind!=='method'||!method.code.trim()||!method.sourceBinding.trim())throw new Error('请先补充方法来源、参数与实现代码。')
   const inputs=validateMethodInput(method.fields,input.inputs),codeHash=hash(method.code),inputHash=hash(JSON.stringify(inputs))
   const expected=input.expected??{},tolerance=input.tolerance??1e-8
   if(!Number.isFinite(tolerance)||tolerance<0||Object.keys(expected).length>30||Object.values(expected).some(v=>typeof v!=='number'||!Number.isFinite(v)))throw new Error('预期指标或容差无效。')
   const seconds=Math.max(5,Math.min(120,Math.floor(input.timeoutSeconds??60))),python=method.environment||this.settings.get().pythonPath.trim()
   if(!python||!pythonCommandAvailable(python))throw new Error('请在设置中选择可用的Python 3.10+解释器。')
   this.health.assertAvailable(input.projectId)
   const permission=await this.approvals.request({origin:'agent',title:`运行论文方法：${w.topic}`,description:'将在本机执行当前方法代码，读取所选项目输入，输出保存为新的运行。代码执行不是操作系统沙箱。',details:`来源：${method.sourceBinding}\n代码SHA256：${codeHash}\n参数：${JSON.stringify(inputs)}\n预期：${JSON.stringify(expected)}；容差：${tolerance}\n最长${seconds}秒\n代码预览：\n${method.code.slice(0,6000)}`,risk:'high'},{signal:controller.signal,remember:false})
   if(!permission.approved)throw new Error('已取消方法执行。')
   controller.signal.throwIfAborted();this.health.assertAvailable(input.projectId)
   if(this.pages.get(input.projectId,input.id).revision!==w.revision)throw new Error('确认期间方法工作页已变化，请重新检查。')
   const project=this.projects.get(input.projectId)
   for(const f of method.fields.filter(f=>f.type==='path'))if(inputs[f.name]!==undefined)figurePath(project.rootPath,String(inputs[f.name]))
   const experiment=this.experiments.create({projectId:input.projectId,name:`方法：${w.topic}`,code:method.code,envKind:'local'})
   runId=newId('run');const relative=`experiments/method-runs/${runId}`,dir=ensureFigureDir(project.rootPath,relative)
   const codePath=figurePath(project.rootPath,`${relative}/method.py`),inputPath=figurePath(project.rootPath,`${relative}/input.json`)
   writeFileSync(codePath,method.code,{flag:'wx',encoding:'utf8'});writeFileSync(inputPath,JSON.stringify(inputs),{flag:'wx',encoding:'utf8'})
   this.experiments.createRun(experiment,`${python} -I method.py`,relative,{environment:'method-minimal-env'},runId)
   task=this.pages.begin(input.projectId,input.id,'method-run',inputHash)
   const env:NodeJS.ProcessEnv={...methodChildEnvironment(),PYTHONUTF8:'1',PYTHONUNBUFFERED:'1',PYTHONIOENCODING:'utf-8',RESEARCHPILOT_METHOD_INPUT:inputPath,RESEARCHPILOT_RUN_DIR:dir,RESEARCHPILOT_PROJECT_ROOT:project.rootPath}
   for(const key of ['SystemRoot','WINDIR','PATH','Path','TEMP','TMP'])if(process.env[key])env[key]=process.env[key]
   const result=await new Promise<{exitCode:number|null;stdout:string;stderr:string}>(resolve=>{
    const child=spawn(python,['-I',codePath],{cwd:dir,env,windowsHide:true});let stdout='',stderr='',done=false
    const finish=(exitCode:number|null)=>{if(done)return;done=true;clearTimeout(timer);controller.signal.removeEventListener('abort',abort);resolve({exitCode,stdout,stderr})}
    const abort=()=>{child.kill();stderr+='\n任务已停止。';finish(-1)}
    const timer=setTimeout(()=>{child.kill();stderr+='\n运行超时。';finish(-1)},seconds*1000)
    controller.signal.addEventListener('abort',abort,{once:true})
    child.stdout.on('data',b=>{stdout=(stdout+b.toString('utf8')).slice(-200000)})
    child.stderr.on('data',b=>{stderr=(stderr+b.toString('utf8')).slice(-200000)})
    child.on('error',error=>{stderr+=error.message;finish(-1)});child.on('close',finish)
    if(controller.signal.aborted)abort()
   })
   const metrics:Record<string,number|string>={}
   for(const line of result.stdout.split(/\r?\n/))if(line.startsWith('RESEARCHPILOT_METRIC:')){try{const raw=JSON.parse(line.slice('RESEARCHPILOT_METRIC:'.length));for(const [key,value]of Object.entries(raw))if(typeof value==='number'&&Number.isFinite(value)||typeof value==='string')metrics[key]=value as number|string}catch{}}
   const status=controller.signal.aborted?'cancelled':result.exitCode===0?'succeeded':'failed'
   this.experiments.updateRun(runId,{status,exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr,metrics,finishedAt:new Date().toISOString()})
   const checksPassed=status==='succeeded'&&Object.keys(expected).length>0&&Object.entries(expected).every(([key,value])=>typeof metrics[key]==='number'&&Math.abs(Number(metrics[key])-value)<=tolerance)
   const test:MethodTest={inputHash,runId,status,checksPassed,inputs,metrics,notes:Object.keys(expected).length?`预期${JSON.stringify(expected)}；容差${tolerance}`:'未设置预期指标：已运行，尚未核验输出。',codeHash}
   const current=this.pages.get(input.projectId,input.id)
   if(hash(current.method.code)!==codeHash)throw new Error('运行期间方法代码已变化；运行保留在实验台，未计入当前方法核验。')
   current.method.codeHash=codeHash;current.method.tests.push(test);this.pages.save(input.projectId,current,true)
   this.pages.finish(task,status,JSON.stringify(test),result.stderr.slice(-1000));return test
  }catch(error){if(task)this.pages.finish(task,controller.signal.aborted?'cancelled':'failed','',String(error));if(runId){try{const run=this.experiments.getRun(runId);if(run.status==='running')this.experiments.updateRun(runId,{status:'failed',stderr:String(error),finishedAt:new Date().toISOString()})}catch{}}throw error}
  finally{this.active=null}
 }
 async exportPackage(projectId:string,id:string,destination:string):Promise<{path:string;sha256:string;ready:boolean}>{
  const w=this.pages.get(projectId,id);this.health.assertAvailable(projectId)
  if(!w.method.code.trim())throw new Error('没有可导出的方法实现。')
  const zip=new JSZip();zip.file('method.py',w.method.code);zip.file('schema.json',JSON.stringify(w.method.fields,null,2));zip.file('verification.json',JSON.stringify({sourceBinding:w.method.sourceBinding,repositoryUrl:w.method.repositoryUrl,codeHash:hash(w.method.code),tests:w.method.tests,verification:methodVerification(w.method.tests)},null,2))
  zip.file('USAGE.md',`# ${w.topic}\n\n来源：${w.method.sourceBinding}\n\n需要Python 3.10+及已安装的方法依赖。用method.py读取RESEARCHPILOT_METHOD_INPUT指定JSON参数；RESEARCHPILOT_PROJECT_ROOT为输入根，RESEARCHPILOT_RUN_DIR为新输出目录。\n\n运行：python -I method.py\n\n方法代码的使用需核对原来源许可。verification.json保存实际运行记录，未设置预期数值的运行不计为核验通过。\n`)
  const bytes=await zip.generateAsync({type:'nodebuffer'});this.health.assertAvailable(projectId);writeFileSync(destination,bytes,{flag:'wx'});return{path:destination,sha256:createHash('sha256').update(bytes).digest('hex'),ready:methodVerification(w.method.tests).ready}
 }
}
