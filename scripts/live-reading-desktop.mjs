import {mkdtemp,mkdir,writeFile,realpath} from 'node:fs/promises'
import {resolve,join,relative,isAbsolute,sep} from 'node:path'
import {createRequire} from 'node:module'
import {_electron as electron} from 'playwright-core'
const require=createRequire(import.meta.url),root=resolve(import.meta.dirname,'..'),key=process.env.RESEARCHPILOT_API_KEY?.trim()
if(!key)throw Error('RESEARCHPILOT_API_KEY must be supplied in environment; never embed it in source.')
const baseUrl=process.env.RESEARCHPILOT_API_BASE?.trim()
if(!baseUrl)throw Error('RESEARCHPILOT_API_BASE must be supplied in environment for this live inference test.')
const model=process.env.RESEARCHPILOT_MODEL?.trim()
if(!model)throw Error('RESEARCHPILOT_MODEL must be supplied in environment for this live inference test.')
const referenceDb=process.env.RESEARCHPILOT_REFERENCE_DB?.trim()
if(!referenceDb)throw Error('RESEARCHPILOT_REFERENCE_DB must name an isolated reference fixture database under test-results, not a personal app database.')
const fixturePath=await realpath(resolve(root,referenceDb))
const fixtureRelative=relative(await realpath(join(root,'test-results')),fixturePath)
if(!fixtureRelative||fixtureRelative==='..'||fixtureRelative.startsWith(`..${sep}`)||isAbsolute(fixtureRelative))throw Error('RESEARCHPILOT_REFERENCE_DB must stay inside test-results; personal app databases are not allowed.')
const {DatabaseSync}=await import('node:sqlite')
const verifiedDb=new DatabaseSync(fixturePath,{readOnly:true})
let verified
try{verified=verifiedDb.prepare('SELECT title,authors,year,venue,doi,url,abstract FROM reference_items WHERE doi=?').get('10.1017/s0305004100031455')}finally{verifiedDb.close()}
if(!verified?.abstract)throw Error('RESEARCHPILOT_REFERENCE_DB fixture must contain the expected DOI and its abstract.')
await mkdir(join(root,'test-results'),{recursive:true});const dir=await mkdtemp(join(root,'test-results','live-reading-'))
const env={...process.env,RESEARCHPILOT_USER_DATA:join(dir,'profile'),RESEARCHPILOT_WORKSPACE_ROOT:join(dir,'workspace')};delete env.RESEARCHPILOT_API_KEY;delete env.ELECTRON_RUN_AS_NODE
let app,page;const report={startedAt:new Date().toISOString(),ok:false}
try{
 app=await electron.launch({executablePath:require('electron'),args:[root],cwd:root,env,timeout:60000});page=await app.firstWindow();await page.waitForSelector('.research-home',{timeout:60000})
 await page.evaluate(({apiKey,baseUrl,model})=>window.researchpilot.providers.upsert({id:'nova-reading',name:'Nova 阅读验证',kind:'custom',protocol:'openai-responses',baseUrl,apiKey,models:[{id:model,label:model}],isDefault:true}),{apiKey:key,baseUrl,model})
 const boot=await page.evaluate(()=>window.researchpilot.bootstrap());const p=boot.activeProjectId
 const ref=await page.evaluate(({p,record})=>window.researchpilot.references.upsert({projectId:p,...record}),{p,record:verified})
 report.sourceAcquisition='Metadata/abstract reused from the explicitly supplied local test-results fixture; not a new metadata or full-text fetch.'
 if(!ref.abstract.trim())throw Error('Real DOI has no abstract; cannot claim reading')
 await page.evaluate(()=>window.researchpilot.mcp.configure({serverId:'evidence',enabled:true}))
 await page.reload();await page.waitForSelector('.sidebar');await page.evaluate(()=>{window.__readingApprovals=[];window.researchpilot.onEvent(e=>{if(e.type==='approval-request')window.__readingApprovals.push(e.request)})})
 await page.locator('.sidebar a[href="#/library"]').click();await page.getByText(ref.title,{exact:true}).first().click();await page.getByTestId('reference-generate-reading').click()
 const started=Date.now();let draft
 while(Date.now()-started<240000){
  const approvals=await page.evaluate(()=>window.__readingApprovals.splice(0));for(const req of approvals){const ok=req.title.includes('阅读摘记')&&req.details.includes(ref.id);await page.evaluate(({id,approved})=>window.researchpilot.approvals.respond({id,approved,remember:false}),{id:req.id,approved:ok})}
  draft=await page.evaluate(({p,id})=>window.researchpilot.references.getReadingDraft(p,id),{p,id:ref.id});if(draft)break
  const state=await page.evaluate(()=>window.researchpilot.chat.state());if(state.status==='error')throw Error(state.lastError)
  await new Promise(r=>setTimeout(r,1200))
 }
 if(!draft)throw Error('No saved AI draft within bounded test')
 const unchanged=await page.evaluate(({p,id})=>window.researchpilot.references.list(p).then(rows=>rows.find(r=>r.id===id)),{p,id:ref.id})
 if(unchanged.notes!==ref.notes)throw Error('Human notes changed unexpectedly')
 report.ok=true;report.source={title:ref.title,doi:ref.doi,referenceId:ref.id};report.draft=draft;report.humanNotesUnchanged=true
 await page.reload();await page.waitForSelector('.sidebar');await page.locator('.sidebar a[href="#/library"]').click();await page.getByText(ref.title,{exact:true}).first().click();await page.getByTestId('reference-reading-draft').waitFor();await page.screenshot({path:join(dir,'ai-reading.png')})
}catch(e){report.ok=false;report.error=String(e.message).split(key).join('[REDACTED]');console.error(report.error);process.exitCode=1}
finally{await page?.evaluate(()=>window.researchpilot.chat.stop()).catch(()=>{});report.finishedAt=new Date().toISOString();await writeFile(join(dir,'report.json'),JSON.stringify(report,null,2));console.log('REPORT_DIR',dir);await app?.close()}
