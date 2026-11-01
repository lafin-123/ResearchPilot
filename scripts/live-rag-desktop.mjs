import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const key = process.env.RESEARCHPILOT_API_KEY?.trim()
if (!key) throw new Error('Supply RESEARCHPILOT_API_KEY in environment; never embed it in source.')
await mkdir(join(root,'test-results'),{recursive:true})
const runDir=await mkdtemp(join(root,'test-results','live-rag-'))
const env={...process.env,RESEARCHPILOT_USER_DATA:join(runDir,'profile'),RESEARCHPILOT_WORKSPACE_ROOT:join(runDir,'workspace'),DSH_TELEMETRY_DISABLED:'1'}
delete env.RESEARCHPILOT_API_KEY;delete env.ELECTRON_RUN_AS_NODE
const report={checks:[],responses:[],startedAt:new Date().toISOString()}
let app
const record=(name)=>{report.checks.push(name);console.log('PASS',name)}
try {
 app=await electron.launch({executablePath:require('electron'),args:[root],cwd:root,env,timeout:60000})
 const page=await app.firstWindow()
 await page.waitForSelector('.research-home',{timeout:60000})
 await page.evaluate((apiKey)=>window.researchpilot.providers.upsert({id:'nova-rag',name:'Nova RAG test',kind:'custom',protocol:'openai-responses',baseUrl:'https://nova1api.duckdns.org/v1',apiKey,models:[{id:'gpt-5.6-sol',label:'gpt-5.6-sol'}],isDefault:true}),key)
 const project=await page.evaluate(()=>window.researchpilot.projects.create({name:'RAG synthetic project A'}))
 const other=await page.evaluate(()=>window.researchpilot.projects.create({name:'RAG synthetic project B'}))
 const secret=`蓝杉${randomBytes(3).toString('hex')}`
 const foreign=`隔离${randomBytes(3).toString('hex')}`
 const ref=await page.evaluate(({projectId,secret})=>window.researchpilot.references.upsert({projectId,title:'Project protocol reading note',abstract:'This is a synthetic reference used only to test local retrieval.',notes:`The project protocol code is ${secret}. This code is synthetic and not an experimental finding.`}),{projectId:project.id,secret})
 await page.evaluate(({projectId,foreign})=>window.researchpilot.references.upsert({projectId,title:'Other project protocol reading note',notes:`The project protocol code is ${foreign}.`}),{projectId:other.id,foreign})
 await page.evaluate(({projectId,referenceId})=>window.researchpilot.knowledge.read({projectId,referenceId}),{projectId:project.id,referenceId:ref.id})
 const ask=async(label)=>{
  const chat=await page.evaluate(async(projectId)=>{const c=await window.researchpilot.chat.create(projectId);return window.researchpilot.chat.setModel(c.id,'nova-rag','gpt-5.6-sol')},project.id)
  await page.evaluate(({projectId,chatId})=>window.researchpilot.chat.send({projectId,chatId,text:'From the project protocol reading note in the supplied project-local retrieval context, what is the protocol code? Reply with the exact code and the sourceId. This is a synthetic retrieval test. Do not call any tools, do not read files, and do not infer a code from outside the supplied sources.'}),{projectId:project.id,chatId:chat.id})
  const start=Date.now();let state
  do {await new Promise(r=>setTimeout(r,800));state=await page.evaluate(()=>window.researchpilot.chat.state())}while(['running','starting'].includes(state.status)&&Date.now()-start<120000)
  if(['running','starting'].includes(state.status)){await page.evaluate(()=>window.researchpilot.chat.stop());throw Error('RAG model timeout')}
  if(state.status==='error')throw Error(state.lastError)
  const messages=await page.evaluate(id=>window.researchpilot.chat.messages(id),chat.id)
  assert.equal(messages.some(m=>m.tool),false,'Verification must use injected RAG, not file/MCP fallback')
  const text=messages.filter(m=>m.role==='assistant'&&m.kind==='text').map(m=>m.content).join('\n')
  report.responses.push({label,text});return text
 }
 const answer=await ask('new conversation retrieves current project note')
 assert.ok(answer.includes(secret));assert.ok(!answer.includes(foreign));assert.match(answer,/src_[a-f0-9]+/)
 record('Real model uses cited retrieved evidence in a fresh conversation without tools')
 const updated=`银杉${randomBytes(3).toString('hex')}`
 await page.evaluate(({ref,updated})=>window.researchpilot.references.upsert({...ref,notes:`The updated project protocol code is ${updated}. The former code is obsolete and is not present in this note.`}),{ref,updated})
 const next=await ask('second conversation sees updated note')
 assert.ok(next.includes(updated));assert.ok(!next.includes(secret));assert.ok(!next.includes(foreign))
 record('Shared project context refreshes after note edits and does not include another project')
 await page.reload();await page.waitForSelector('.sidebar',{timeout:30000})
 const history=await page.evaluate(projectId=>window.researchpilot.knowledge.activity({projectId}),project.id)
 assert.ok(history.some(e=>e.kind==='read'));assert.ok(history.some(e=>e.kind==='note_updated'));record('Reading and note-update history survives renderer reload')
 report.ok=true
}catch(error){report.ok=false;report.error=String(error.message).split(key).join('[REDACTED]');console.error(report.error);process.exitCode=1}
finally{report.finishedAt=new Date().toISOString();await writeFile(join(runDir,'report.json'),JSON.stringify(report,null,2));console.log('REPORT_DIR',runDir);await app?.close()}
