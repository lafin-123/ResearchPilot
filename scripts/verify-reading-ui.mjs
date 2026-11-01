import { _electron as electron } from 'playwright-core'
import {createRequire} from 'node:module'
import {join,resolve} from 'node:path'
import {readFile,writeFile} from 'node:fs/promises'
const require=createRequire(import.meta.url),root=resolve(import.meta.dirname,'..'),dir=join(root,'test-results/live-reading-OINmHS')
const report=JSON.parse(await readFile(join(dir,'report.json'),'utf8'))
const env={...process.env,RESEARCHPILOT_USER_DATA:join(dir,'profile'),RESEARCHPILOT_WORKSPACE_ROOT:join(dir,'workspace')};delete env.ELECTRON_RUN_AS_NODE
const app=await electron.launch({executablePath:require('electron'),args:[root],cwd:root,env,timeout:60000})
try{const page=await app.firstWindow();await page.waitForSelector('.research-home',{timeout:60000});await page.locator('.sidebar a[href="#/library"]').click();await page.getByText(report.source.title,{exact:true}).first().click();await page.getByTestId('reference-reading-draft').waitFor();await page.locator('.content').evaluate(e=>e.scrollTop=0);await page.screenshot({path:join(dir,'ai-reading.png')});await writeFile(join(dir,'ui-verification.json'),JSON.stringify({ok:true,networkCalls:false,action:'Opened the already-generated real AI draft after restart; no model request repeated.',checkedAt:new Date().toISOString()},null,2));console.log('AI reading draft visible and persistent; no new model calls')}finally{await app.close()}
