import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Db } from '../src/main/lib/db'
import { BackupService } from '../src/main/services/backups'

test('research pages persist, isolate projects and reject stale revisions', async () => {
 const { ResearchWorkspaceService } = await import('../src/main/services/research-workspaces')
 const dir=mkdtempSync(join(tmpdir(),'rp-research-store-'));const path=join(dir,'db.sqlite');let db=new Db(path)
 try{
  for(const id of ['p','q']){mkdirSync(join(dir,id));db.run('INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES(?,?,?,?,?)',id,id,join(dir,id),'now','now')}
  let service=new ResearchWorkspaceService(db)
  const w=service.create('p','brainstorm','A question')
  assert.throws(()=>service.get('q',w.id))
  const saved=service.save('p',{...w,purpose:'A review'})
  assert.equal(saved.revision,2)
  assert.throws(()=>service.save('p',{...w,purpose:'stale'}),/冲突/)
  db.close();db=new Db(path);service=new ResearchWorkspaceService(db)
  assert.equal(service.get('p',w.id).purpose,'A review')
  assert.equal(service.list('q').length,0)
  const backup=new BackupService(db,{workspaceRoot:()=>dir,assertIdle:()=>{}})
  const backupPath=join(dir,'research.rpbackup')
  backup.exportProject('p',backupPath)
  const restored=backup.restoreCopy(backup.inspect(backupPath).token)
  const restoredPage=service.list(restored.projectId)[0]
  assert.ok(restoredPage)
  assert.notEqual(restoredPage.id,w.id)
  assert.equal(service.get(restored.projectId,restoredPage.id).purpose,'A review')
  db.run('DELETE FROM projects WHERE id=?','p')
  assert.equal(service.list('p').length,0)
 }finally{db.close();rmSync(dir,{recursive:true,force:true})}
})
