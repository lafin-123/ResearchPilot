import {readFile,readdir,writeFile,stat} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {resolve,join,relative,isAbsolute} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import JSZip from 'jszip'
const root=resolve(import.meta.dirname,'..'),dir=resolve(process.argv[2]||join(root,'test-results/full-research-dZMiVw'))
const location=JSON.parse(await readFile(join(dir,'run-location.json'),'utf8'))
const db=new DatabaseSync(join(dir,'profile/researchpilot.db'),{readOnly:true})
const report={runId:location.runId,checkedAt:new Date().toISOString(),checks:[],limitations:['Structural independent artifact inspection, not a guarantee of scientific validity or citation support.']}
const check=(name,ok,detail)=>report.checks.push({name,ok,detail})
const safe=(p)=>{const abs=resolve(location.rootPath,p),r=relative(location.rootPath,abs);if(r.startsWith('..')||isAbsolute(r))throw Error('Out-of-project artifact');return abs}
try{
 const stages=db.prepare('SELECT stage,status,error FROM pipeline_steps WHERE run_id=? ORDER BY position').all(location.runId);report.stages=stages
 check('eight stages completed',stages.length===8&&stages.every(s=>s.status==='completed'),stages.map(s=>`${s.stage}:${s.status}`))
 const refs=db.prepare('SELECT id,title,doi,abstract FROM reference_items WHERE project_id=?').all(location.projectId)
 check('actual DOI records',refs.filter(r=>r.doi).length>=2,refs.map(r=>({id:r.id,doi:r.doi,title:r.title,hasAbstract:!!r.abstract})))
 const runs=db.prepare('SELECT id,experiment_id,status,exit_code,metrics_json,artifact_dir FROM experiment_runs WHERE project_id=?').all(location.projectId)
 for(const run of runs){const files=await readdir(safe(run.artifact_dir)).catch(()=>[]);check(`run record ${run.id}`,['succeeded','failed','cancelled'].includes(run.status),{status:run.status,exitCode:run.exit_code,files,metrics:JSON.parse(run.metrics_json),note:run.status==='succeeded'?'Actual succeeded process':'Retained failed/cancelled attempt; not counted as successful evidence'})}
 check('real runs exist',runs.some(r=>r.status==='succeeded'),runs.length)
 for(const stage of stages.filter(s=>s.status==='completed')){
  const receipt=JSON.parse(await readFile(safe(`exports/pipeline/${location.runId}/${stage.stage}.verification.json`),'utf8'))
  const mismatches=[];for(const [p,hash]of Object.entries(receipt.hashes)){const actual=createHash('sha256').update(await readFile(safe(p))).digest('hex');if(actual!==hash)mismatches.push(p)}
  if(stage.stage==='paper'&&mismatches.length){
   const review=JSON.parse(await readFile(safe(`exports/pipeline/${location.runId}/review.verification.json`),'utf8'))
   const documented=[]
   for(const p of mismatches){const actual=createHash('sha256').update(await readFile(safe(p))).digest('hex');documented.push(review.hashes[p]===actual)}
   check('paper-stage files changed only through verified review revision',documented.every(Boolean),{supersededAtReview:mismatches})
  }else check(`receipt hashes ${stage.stage}`,mismatches.length===0,mismatches)
 }
 const figures=db.prepare('SELECT id,file_path FROM figures WHERE project_id=?').all(location.projectId)
 for(const f of figures){const folder=resolve(safe(f.file_path),'..');const zip=await JSZip.loadAsync(await readFile(join(folder,'figure.pptx')));check(`editable PPT ${f.id}`,Object.keys(zip.files).some(p=>/^ppt\/charts\/chart\d+\.xml$/.test(p))||!!(await zip.file('ppt/slides/slide1.xml').async('string')).match(/<p:sp>/),{source:join(folder,'figure.json')})}
 const docs=db.prepare('SELECT id,title,relative_path,format,word_count FROM documents WHERE project_id=?').all(location.projectId)
 for(const doc of docs.filter(d=>d.format==='docx')){const zip=await JSZip.loadAsync(await readFile(safe(doc.relative_path)));const xml=await zip.file('word/document.xml').async('string');const texts=[...xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(m=>m[1]).join(' ');check(`manuscript ${doc.id}`,doc.word_count>=100,{title:doc.title,characters:texts.length,images:Object.keys(zip.files).filter(p=>p.startsWith('word/media/')&&!zip.files[p].dir).length,hasReferences:/参考文献|References/i.test(texts)});await writeFile(join(dir,'manuscript-extracted.txt'),texts)}
 report.ok=report.checks.every(c=>c.ok)
}catch(error){report.ok=false;report.error=String(error.message)}finally{db.close();await writeFile(join(dir,'independent-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,checks:report.checks.map(c=>({name:c.name,ok:c.ok})),error:report.error},null,2))}
