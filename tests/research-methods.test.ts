import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Db } from '../src/main/lib/db'
import { ResearchWorkspaceService } from '../src/main/services/research-workspaces'
import { ResearchMethodService } from '../src/main/services/research-methods'
import { ExperimentService } from '../src/main/services/experiments'
import { ProjectService } from '../src/main/services/projects'
import { ProjectHealthService } from '../src/main/services/project-health'
const python=spawnSync('uv',['python','find','--no-python-downloads'],{encoding:'utf8',windowsHide:true}).stdout?.trim()||'python'
test('native method executes real changed inputs, compares expected metrics and retains failure',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rp-method-native-'));const project=join(dir,'project');mkdirSync(project);const db=new Db(join(dir,'db.sqlite'))
 try{
  db.run('INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES(?,?,?,?,?)','p','p',project,'now','now')
  const settings={get:()=>({pythonPath:python})} as never,experiments=new ExperimentService(db),projects=new ProjectService(db,settings,{} as never,experiments),pages=new ResearchWorkspaceService(db),health=new ProjectHealthService(projects,()=>{})
  const methods=new ResearchMethodService(pages,projects,experiments,settings,{request:async()=>({approved:true})} as never,health,()=>false)
  let w=pages.create('p','method','Scale fixture');w.method.sourceBinding='Independent standard-library fixture, not an external paper';w.method.fields=[{name:'scale',type:'number',required:true}];w.method.code='import json, os\np=json.load(open(os.environ["RESEARCHPILOT_METHOD_INPUT"]))\nprint("RESEARCHPILOT_METRIC:"+json.dumps({"result":p["scale"]*2}))\n';w=pages.save('p',w)
  const first=await methods.run({projectId:'p',id:w.id,inputs:{scale:3},expected:{result:6}})
  const second=await methods.run({projectId:'p',id:w.id,inputs:{scale:4},expected:{result:8}})
  assert.equal(first.checksPassed,true);assert.equal(second.metrics.result,8);assert.notEqual(first.runId,second.runId)
  const mismatch=await methods.run({projectId:'p',id:w.id,inputs:{scale:5},expected:{result:999}})
  assert.equal(mismatch.checksPassed,false)
  assert.equal(pages.get('p',w.id).method.tests.length,3)
  await assert.rejects(methods.run({projectId:'p',id:w.id,inputs:{scale:'bad'}}))
 }finally{db.close();rmSync(dir,{recursive:true,force:true})}
})
