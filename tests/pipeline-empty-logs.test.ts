import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {evidenceFile} from '../src/main/services/pipeline'
test('successful run empty stdout/stderr are valid audit logs but empty data/plan are not evidence',()=>{
 const root=mkdtempSync(join(tmpdir(),'run-log-gate-'))
 try{mkdirSync(join(root,'experiments/e/runs/r'),{recursive:true});for(const name of ['stderr.txt','stdout.txt','metrics.json'])writeFileSync(join(root,'experiments/e/runs/r',name),'');assert.ok(evidenceFile(root,'experiments/e/runs/r/stderr.txt'));assert.ok(evidenceFile(root,'experiments/e/runs/r/stdout.txt'));assert.throws(()=>evidenceFile(root,'experiments/e/runs/r/metrics.json'),/为空/);writeFileSync(join(root,'plan.md'),'');assert.throws(()=>evidenceFile(root,'plan.md'),/为空/)}finally{rmSync(root,{recursive:true,force:true})}
})
