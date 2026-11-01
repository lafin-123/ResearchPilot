import { _electron as electron } from 'playwright-core'
import {createRequire} from 'node:module'
import {resolve,join} from 'node:path'
import {readFile,writeFile} from 'node:fs/promises'
const require=createRequire(import.meta.url),root=resolve(import.meta.dirname,'..')
const dir=resolve(process.argv[2]||join(root,'test-results/full-research-dZMiVw'))
const loc=JSON.parse(await readFile(join(dir,'run-location.json'),'utf8'))
const env={...process.env,RESEARCHPILOT_USER_DATA:join(dir,'profile'),RESEARCHPILOT_WORKSPACE_ROOT:join(dir,'workspace')};delete env.ELECTRON_RUN_AS_NODE
const app=await electron.launch({executablePath:require('electron'),args:[root],cwd:root,env,timeout:60000})
try{const page=await app.firstWindow();await page.waitForSelector('.research-home',{timeout:60000});for(const route of ['library','experiments','figures','pipeline','writing']){await page.locator(`.sidebar a[href="#/${route}"]`).click();await page.getByRole('heading',{level:1}).first().waitFor();if(route==='library'){const row=page.getByTestId('reference-row').first();if(await row.count())await row.click()}await page.screenshot({path:join(dir,`actual-${route}.png`)})}console.log('Captured actual project management pages without model calls')}finally{await app.close()}
