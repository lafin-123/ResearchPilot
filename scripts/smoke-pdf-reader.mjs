import assert from 'node:assert/strict'
import {annotationFixturePdf} from './pdf-fixture.mjs'
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {_electron as electron} from 'playwright-core'
const require=createRequire(import.meta.url),root=resolve(import.meta.dirname,'..')
await mkdir(join(root,'test-results'),{recursive:true});const dir=await mkdtemp(join(root,'test-results','pdf-reader-'))
const env={...process.env,RESEARCHPILOT_USER_DATA:join(dir,'profile'),RESEARCHPILOT_WORKSPACE_ROOT:join(dir,'workspace')};delete env.ELECTRON_RUN_AS_NODE
const fixture=join(dir,'paper.pdf');await writeFile(fixture,annotationFixturePdf());const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
let app,page;const checks=[];const pass=name=>{checks.push(name);console.log('PASS',name)}
try{
 app=await electron.launch({executablePath:require('electron'),args:[root],cwd:root,env,timeout:60000});page=await app.firstWindow();await page.waitForSelector('.research-home',{timeout:60000})
 const boot=await page.evaluate(()=>window.researchpilot.bootstrap());const p=boot.activeProjectId
 const ref=await page.evaluate(p=>window.researchpilot.references.upsert({projectId:p,title:'PDF annotation test paper',authors:'Local test',abstract:'A generated two-page test PDF, not a scientific reference.'}),p)
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},fixture)
 const linked=await page.evaluate(({p,id})=>window.researchpilot.references.attachPdf(p,id),{p,id:ref.id})
 const project=boot.projects.find(x=>x.id===p);const original=await readFile(join(project.rootPath,linked.pdfRelativePath))
 await page.locator('.sidebar a[href="#/library"]').click();await page.getByText(ref.title,{exact:true}).first().click();await page.getByRole('button',{name:'查看 PDF',exact:true}).click()
 await page.getByTestId('pdf-page').waitFor({timeout:30000})
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('.textLayer span')).some(s=>s.textContent?.includes('reproducible')))
 await page.evaluate(()=>{const span=Array.from(document.querySelectorAll('.textLayer span')).find(s=>s.textContent?.includes('reproducible'));const range=document.createRange();range.selectNodeContents(span);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));span.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))})
 // UI selectors finalized by PdfReader implementation.
 await page.getByTestId('pdf-comment').fill('Verify the experiment evidence before using this statement.')
 await page.getByTestId('pdf-save-annotation').click()
 await page.getByTestId('pdf-annotation-item').first().waitFor()
 pass('Text selection creates a persisted highlight with a comment')
 await page.screenshot({path:join(dir,'pdf-highlight.png')})
 const opened=await page.evaluate(({p,id})=>window.researchpilot.pdfAnnotations.open(p,id),{p,id:ref.id})
 assert.equal(opened.annotations.length,1);assert.ok(opened.annotations[0].quote.includes('reproducible'))
 assert.equal(hash(await readFile(join(project.rootPath,linked.pdfRelativePath))),hash(original))
 pass('Annotation storage does not modify original PDF bytes')
 await page.getByTestId('pdf-page-number').fill('2');await page.getByTestId('pdf-page-number').press('Enter')
 await page.locator('[data-testid="pdf-page"][data-page="2"]').waitFor()
 await page.getByTestId('pdf-comment').fill('Page two limitation note.')
 await page.getByTestId('pdf-save-annotation').click()
 await page.waitForFunction(()=>document.querySelectorAll('[data-testid="pdf-annotation-item"]').length===2)
 await page.getByTestId('pdf-annotation-item').first().locator('.pdf-annotation-locator').click()
 await page.locator('[data-testid="pdf-page"][data-page="1"]').waitFor()
 await page.getByTestId('pdf-highlight').first().waitFor()
 await page.getByTestId('pdf-zoom').selectOption('1.5')
 await page.getByTestId('pdf-highlight').first().waitFor()
 pass('Page comments and annotation navigation restore highlights at another zoom')
 page.once('dialog',dialog=>void dialog.accept())
 await page.getByTestId('pdf-create-note').click()
 await page.getByText('已创建新的研究笔记',{exact:true}).waitFor()
 const noteList=await page.evaluate(id=>window.researchpilot.notes.list(id),p)
 assert.ok(noteList.items.some(n=>n.title.includes('p.1')))
 pass('Selected original annotation creates a separate sourced research note')
 await page.reload();await page.waitForSelector('.sidebar');await page.locator('.sidebar a[href="#/library"]').click();await page.getByText(ref.title,{exact:true}).first().click();await page.getByRole('button',{name:'查看 PDF',exact:true}).click();await page.getByTestId('pdf-annotation-item').first().waitFor()
 pass('Saved highlights and comments survive reopening the reader')
 await page.getByTestId('pdf-annotation-item').first().getByRole('button',{name:'编辑批注',exact:true}).click()
 await page.getByTestId('pdf-comment').fill('Updated annotation, original source retained.')
 await page.getByTestId('pdf-save-annotation').click()
 await page.getByText('Updated annotation, original source retained.',{exact:true}).waitFor()
 page.once('dialog',dialog=>void dialog.accept())
 await page.getByTestId('pdf-annotation-item').last().getByRole('button',{name:'删除',exact:true}).click()
 await page.waitForFunction(()=>document.querySelectorAll('[data-testid="pdf-annotation-item"]').length===1)
 pass('Annotation edits and confirmed deletion affect only the saved annotation layer')
 await page.screenshot({path:join(dir,'pdf-highlight.png')})
 await writeFile(join(dir,'report.json'),JSON.stringify({checks},null,2));console.log('REPORT_DIR',dir)
}catch(error){await writeFile(join(dir,'report.json'),JSON.stringify({checks,error:String(error)},null,2));if(page){await page.screenshot({path:join(dir,'failure.png')}).catch(()=>{});console.error((await page.locator('body').innerText().catch(()=>'' )).slice(0,6000))}console.error('REPORT_DIR',dir);throw error}
finally{await app?.close()}
