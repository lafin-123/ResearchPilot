import {readFile,writeFile} from 'node:fs/promises'
import {resolve,dirname,join} from 'node:path'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {createCanvas} from '@napi-rs/canvas'
const path=resolve(process.argv[2]);const task=getDocument({data:new Uint8Array(await readFile(path)),useSystemFonts:true,useWasm:false,useWorkerFetch:false});const doc=await task.promise
console.log('PDF pages',doc.numPages)
const inventory=[]
for(let i=1;i<=doc.numPages;i++){
 const page=await doc.getPage(i);const text=await page.getTextContent();inventory.push({page:i,characters:text.items.map(x=>x.str||'').join('').length})
 const viewport=page.getViewport({scale:1.2});const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));await page.render({canvas,canvasContext:canvas.getContext('2d'),viewport}).promise;await writeFile(join(dirname(path),`page-${i}.png`),canvas.toBuffer('image/png'))
}
await writeFile(join(dirname(path),'page-inventory.json'),JSON.stringify(inventory,null,2));await task.destroy();console.log(inventory)
