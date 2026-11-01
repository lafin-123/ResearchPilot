import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import JSZip from 'jszip'
import {Db} from '../src/main/lib/db'
import {DocumentService} from '../src/main/services/documents'

test('native manuscript write embeds real project chart and snapshots previous content without overwriting after revocation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'native-paper-'));const db=new Db(join(root,'test.db'))
 try{
  mkdirSync(join(root,'manuscripts'));mkdirSync(join(root,'figures','plot'),{recursive:true})
  db.run('INSERT INTO projects(id,name,description,root_path,created_at,updated_at) VALUES(?,?,?,?,?,?)','p','Study','',root,'now','now')
  const docs=new DocumentService(db,{get:()=>({})} as never)
  const record=await docs.create({projectId:'p',title:'真实结果测试',format:'docx',markdown:'Initial manuscript'})
  const spec={version:1,kind:'chart',chartType:'bar',title:'Test chart',provenance:{sourceLabel:'executed fixture',isDemo:true},xLabel:'Method',yLabel:'Value',labels:['A','B'],series:[{name:'Observed',values:[1,2]}]}
  writeFileSync(join(root,'figures','plot','figure.json'),JSON.stringify(spec));writeFileSync(join(root,'figures','plot','figure.svg'),'<svg/>')
  const written=await docs.writeMarkdown('p',record.id,'# Results\n\nObserved values were 1 and 2 (test fixture).\n\n![Figure 1: exact fixture data](figures/plot/figure.svg)\n\n## Limitations\n\nNot real-world data.')
  assert.ok(written.wordCount>10)
  const bytes=readFileSync(join(root,record.relativePath));const zip=await JSZip.loadAsync(bytes);assert.ok(Object.keys(zip.files).some(f=>f.startsWith('word/media/')&&!zip.files[f].dir));assert.ok(docs.versions('p',record.id).length)
  let calls=0;await assert.rejects(docs.writeMarkdown('p',record.id,'New blocked text',()=>{if(++calls>1)throw Error('revoked')}),/revoked/)
  assert.deepEqual(readFileSync(join(root,record.relativePath)),bytes)
  await assert.rejects(docs.writeMarkdown('wrong',record.id,'Wrong project'))
 }finally{db.close();rmSync(root,{recursive:true,force:true})}
})
