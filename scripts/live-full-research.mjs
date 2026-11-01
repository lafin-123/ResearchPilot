import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { _electron as electron } from 'playwright-core'
const require=createRequire(import.meta.url)
const root=resolve(import.meta.dirname,'..')
const key=process.env.RESEARCHPILOT_API_KEY?.trim()
if(!key)throw Error('Supply RESEARCHPILOT_API_KEY in environment only')
const model=process.env.RESEARCHPILOT_MODEL||'gpt-5.6-sol'
await mkdir(join(root,'test-results'),{recursive:true})
const resumeDir=process.env.RESEARCHPILOT_RESUME_DIR ? resolve(process.env.RESEARCHPILOT_RESUME_DIR) : ''
if(resumeDir && !resumeDir.toLowerCase().startsWith(join(root,'test-results','full-research-').toLowerCase()))throw Error('Resume is limited to isolated full-research test directories')
const dir=resumeDir||await mkdtemp(join(root,'test-results','full-research-'))
const env={...process.env,RESEARCHPILOT_USER_DATA:join(dir,'profile'),RESEARCHPILOT_WORKSPACE_ROOT:join(dir,'workspace'),DSH_TELEMETRY_DISABLED:'1'};delete env.RESEARCHPILOT_API_KEY;delete env.ELECTRON_RUN_AS_NODE
const redact=v=>String(v).split(key).join('[REDACTED]').replace(/sk-[A-Za-z0-9_-]{8,}/g,'[REDACTED]')
const report={startedAt:new Date().toISOString(),model,approvals:[],stages:[],claim:'Actual automatic pipeline test; no seeded code, references, metrics, figures or manuscript.'}
if(resumeDir){try{const prior=JSON.parse(await readFile(join(dir,'report.json'),'utf8'));await writeFile(join(dir,`previous-report-${Date.now()}.json`),JSON.stringify(prior,null,2))}catch{}}
let app,page,project,run,lastStage='', rateRetries=0
const topic=`研究方向：在相同函数求值预算下，怎样让 Monte Carlo 数值积分更准确、更稳定？请把这个较宽问题缩小为一个可在普通 CPU 上实际验证的小型方法比较研究，完成文献、假设、实验设计、执行、分析、图表、DOCX 成稿与审稿。\n约束：必须真实检索 Crossref 并核验至少两条相关 DOI 元数据；不声称读过只有元数据的全文。实验代码由你编写，不使用预填结果。仅用已配置 Python 标准库，不安装包，不使用网络数据/GPU/SSH。选择有解析真值的测试函数，比较至少两个有文献依据的方法、至少两个测试情形、至少30次独立重复，固定随机种子，记录预算和 MAE/RMSE 等指标及不确定性；包含可能不占优的情况并如实报告。每次运行最多120秒，总计算预算不超过5分钟。\n使用随应用提供的原生 MCP 工具完成本地文件、实验、参考文献、DOCX 和可编辑图表操作，不调用 PowerShell/bash。必须实际执行分析代码，所有数字来自 run 产物，绘图用真实数据同时产出 SVG 与原生可编辑 PPT。最终文稿为中文约2000字以上，含研究问题、相关工作、方法、实验设置、结果、局限和真实参考文献；明确这是受控数学仿真方法比较，不声称原创突破或现实应用验证。先保留分析/复现/引文审计证据，再标记完成，无法验证的事项写清楚。这个隔离项目允许所述小型本地计算与 Crossref 查询，需审批的动作会逐次审核。`
try{
 app=await electron.launch({executablePath:require('electron'),args:[root],cwd:root,env,timeout:60000});page=await app.firstWindow();await page.waitForSelector('.research-home',{timeout:60000})
 await page.evaluate(()=>{window.__pipelineApprovals=[];window.researchpilot.onEvent(e=>{if(e.type==='approval-request')window.__pipelineApprovals.push(e.request)})})
 await page.evaluate(({apiKey,model})=>window.researchpilot.providers.upsert({id:'research-live',name:'真实科研流程验证',kind:'custom',protocol:'openai-responses',baseUrl:'https://nova1api.duckdns.org/v1',apiKey,models:[{id:model,label:model}],isDefault:true}),{apiKey:key,model})
 const py=spawnSync('uv',['python','find','--no-python-downloads'],{encoding:'utf8',windowsHide:true});if(py.status!==0)throw Error('Existing Python required')
 await page.evaluate(p=>window.researchpilot.settings.update({pythonPath:p,maxOutputTokens:16000,reasoningEffort:'',telemetry:false}),py.stdout.trim())
 if(resumeDir){
  const saved=JSON.parse(await readFile(join(dir,'run-location.json'),'utf8'))
  project=(await page.evaluate(()=>window.researchpilot.projects.list())).find(p=>p.id===saved.projectId)
  if(!project)throw Error('Resume project missing')
  await page.evaluate(id=>window.researchpilot.projects.setActive(id),project.id)
  const prior=await page.evaluate(id=>window.researchpilot.pipeline.get(id),project.id)
  if(prior.run?.id!==saved.runId)throw Error('Resume run identity mismatch')
  run=await page.evaluate(id=>window.researchpilot.pipeline.runStage(id),saved.runId)
  report.resumedFrom=resumeDir
 }else{
  project=await page.evaluate(()=>window.researchpilot.projects.create({name:'完整科研实测：Monte Carlo 方法比较',description:'真实模型从题目到DOCX；仅CPU数学仿真，所有代码与研究产物由流水线生成。'}))
  await page.evaluate(id=>window.researchpilot.projects.setActive(id),project.id)
  const servers=await page.evaluate(id=>window.researchpilot.mcp.list(id),project.id)
  for(const server of servers)await page.evaluate(serverId=>window.researchpilot.mcp.configure({serverId,enabled:true}),server.id)
  run=await page.evaluate(({projectId,topic,model})=>window.researchpilot.pipeline.start({projectId,topic,formats:['docx'],autoRun:true,providerId:'research-live',modelId:model}),{projectId:project.id,topic,model})
 }
 report.project=project;report.runId=run.id
 await writeFile(join(dir,'run-location.json'),JSON.stringify({runId:run.id,projectId:project.id,rootPath:project.rootPath},null,2))
 const started=Date.now();let lastActivity=Date.now();let knownMessages=0
 while(Date.now()-started<45*60000){
  const requests=await page.evaluate(()=>window.__pipelineApprovals.splice(0))
  for(const request of requests){
   const t=request.title||'',d=request.details||''
   const native=/^MCP (写入项目产物：|创建本地实验：|向 Crossref 检索文献$|从 Crossref 添加 DOI$|写入文稿：|创建可编辑图表：|运行本地实验：)/.test(t)
   let completeCode=''
   if(t.startsWith('MCP 运行本地实验：')){
    const match=d.match(/实验：([^\s]+)/)
    if(match)completeCode=await page.evaluate(id=>window.researchpilot.experiments.readCode(id),match[1])
   }
   const forbidden=/Invoke-WebRequest|curl\s|subprocess|os\.system|socket\.|requests\.|urllib\.|shutil\.rmtree|Remove-Item|rmdir\s|rm\s+-|pip install|eval\(|exec\(|os\.environ\s*\)|environ\.items|read.*accounts\.sqlite|researchpilot\.db/i.test(d+'\n'+completeCode)
   const approved=native&&!forbidden
   report.approvals.push({title:t,details:redact(d),approved,at:new Date().toISOString()});console.log('APPROVAL',approved?'ALLOW':'DENY',t,redact(d).slice(0,350))
   await page.evaluate(({id,approved})=>window.researchpilot.approvals.respond({id,approved,remember:false}),{id:request.id,approved});lastActivity=Date.now()
  }
  const snapshot=await page.evaluate(id=>window.researchpilot.pipeline.get(id),project.id);run=snapshot.run
  if(run.currentStage!==lastStage){lastStage=run.currentStage;console.log('STAGE',lastStage,run.status);lastActivity=Date.now()}
  const messages=await page.evaluate(id=>window.researchpilot.chat.messages(id),run.chatId)
  if(messages.length!==knownMessages){knownMessages=messages.length;lastActivity=Date.now()}
  report.stages=run.steps.map(s=>({stage:s.stage,status:s.status,error:redact(s.error),startedAt:s.startedAt,finishedAt:s.finishedAt,output:redact(s.output)}));report.status=run.status
  await writeFile(join(dir,'progress.json'),JSON.stringify(report,null,2))
  if(run.status==='failed' && /gateway_concurrency_limit|Concurrency limit|rate.?limit|429/i.test(run.steps.find(s=>s.status==='failed')?.error||'') && rateRetries<2){
   rateRetries++;console.log('RATE_LIMIT_RETRY',rateRetries,'same run/stage after60sec; no artifacts fabricated');await new Promise(r=>setTimeout(r,60000));await page.evaluate(id=>window.researchpilot.pipeline.runStage(id),run.id);lastActivity=Date.now();continue
  }
  if(['completed','failed','cancelled','paused'].includes(run.status))break
  if(Date.now()-lastActivity>8*60000)throw Error('No stage/tool/message progress for8minutes')
  await new Promise(r=>setTimeout(r,1500))
 }
 if(run.status!=='completed')throw Error(`Pipeline did not complete: ${run.status}, stage ${run.currentStage}, ${run.steps.find(s=>s.status==='failed')?.error||''}`)
 const references=await page.evaluate(id=>window.researchpilot.references.list(id),project.id)
 const experiments=await page.evaluate(id=>window.researchpilot.experiments.list(id),project.id)
 const runs=[];for(const exp of experiments)runs.push(...await page.evaluate(id=>window.researchpilot.experiments.runs(id),exp.id))
 const documents=await page.evaluate(id=>window.researchpilot.documents.list(id),project.id)
 const figures=await page.evaluate(id=>window.researchpilot.figures.list(id),project.id)
 report.references=references.map(r=>({id:r.id,title:r.title,doi:r.doi,year:r.year}));report.runs=runs.map(r=>({id:r.id,status:r.status,metrics:r.metrics,artifactDir:r.artifactDir}));report.documents=documents;report.figures=figures
 if(references.filter(r=>r.doi).length<2||!runs.some(r=>r.status==='succeeded')||!documents.some(d=>d.format==='docx')||!figures.some(f=>f.pptxPath))throw Error('Completed flag lacked actual research deliverables')
 report.ok=true
}catch(error){report.ok=false;report.error=redact(error.message);console.error('FULL_RESEARCH_ERROR',report.error);process.exitCode=1}
finally{
 if(page&&run){const messages=await page.evaluate(id=>window.researchpilot.chat.messages(id),run.chatId).catch(()=>[]);await writeFile(join(dir,'messages.json'),redact(JSON.stringify(messages,null,2)))}
 if(page&&project){const snap=await page.evaluate(id=>window.researchpilot.pipeline.get(id),project.id).catch(()=>null);if(snap)await writeFile(join(dir,'pipeline.json'),redact(JSON.stringify(snap,null,2)));await page.evaluate(()=>window.researchpilot.chat.stop()).catch(()=>{});await page.reload().catch(()=>{});await page.waitForSelector('.sidebar',{timeout:10000}).catch(()=>{});await page.evaluate(()=>{window.location.hash='/pipeline'}).catch(()=>{});await page.screenshot({path:join(dir,'pipeline.png')}).catch(()=>{})}
 report.finishedAt=new Date().toISOString();await writeFile(join(dir,'report.json'),JSON.stringify(report,null,2));console.log('REPORT_DIR',dir);await app?.close()
}
