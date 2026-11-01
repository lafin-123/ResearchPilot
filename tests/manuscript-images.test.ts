import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { resolveManuscriptImage } from '../src/main/lib/manuscript-images'

test('manuscript images regenerate declared SVG safely and reject external/unstructured content', async () => {
 const root=mkdtempSync(join(tmpdir(),'manuscript-image-'))
 try{
  mkdirSync(join(root,'figures','test'),{recursive:true})
  const spec={version:1,kind:'chart',chartType:'bar',title:'Executed comparison',provenance:{sourceLabel:'test fixture only',isDemo:true},xLabel:'Method',yLabel:'Value',labels:['A','B'],series:[{name:'Observed',values:[1,2]}]}
  writeFileSync(join(root,'figures','test','figure.json'),JSON.stringify(spec))
  writeFileSync(join(root,'figures','test','figure.svg'),'<svg><image href="https://example.invalid/private" /></svg>')
  const image=await resolveManuscriptImage(root,'figures/test/figure.svg')
  assert.equal(image.type,'png');assert.ok(image.width>100);assert.ok(image.height>100);assert.equal((await sharp(image.data).metadata()).format,'png')
  await assert.rejects(resolveManuscriptImage(root,'https://example.invalid/a.png'))
  await assert.rejects(resolveManuscriptImage(root,'figures/../secrets.png'))
  mkdirSync(join(root,'figures','missing'));writeFileSync(join(root,'figures','missing','figure.svg'),'<svg/>')
  await assert.rejects(resolveManuscriptImage(root,'figures/missing/figure.svg'),/figure.json/)
 }finally{rmSync(root,{recursive:true,force:true})}
})
