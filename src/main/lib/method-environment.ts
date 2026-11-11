import { lstatSync, readdirSync, readFileSync, mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { join, relative, resolve, extname, dirname, parse } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
const execute=promisify(execFile)
export interface MethodSourceInventory { root:string; commit:string; files:Array<{path:string;sha256:string;text:string}>; truncated:boolean }
export function assertSourceDirectory(directory:string):string {
 const root=resolve(directory)
 for(let current=root;;current=dirname(current)){const s=lstatSync(current);if(s.isSymbolicLink()||!s.isDirectory())throw new Error('代码目录或父目录不能是链接。');if(current===parse(current).root)break}
 if(realpathSync(root).toLowerCase()!==root.toLowerCase())throw new Error('代码目录解析发生变化。')
 return root
}
export function inspectMethodSource(directory:string):MethodSourceInventory {
 const root=assertSourceDirectory(directory),files:MethodSourceInventory['files']=[];let bytes=0,visited=0,truncated=false
 const ignored=new Set(['.git','node_modules','.venv','venv','env','__pycache__','dist','build','runs'])
 const allowed=new Set(['.py','.r','.md','.txt','.toml','.yaml','.yml','.json','.ipynb'])
 const walk=(dir:string,depth:number)=>{if(depth>5||visited>3000){truncated=true;return};for(const entry of readdirSync(dir,{withFileTypes:true})){if(++visited>3000){truncated=true;return}if(entry.name.startsWith('.')||ignored.has(entry.name)||/secret|credential|password|token|private.key/i.test(entry.name))continue;const full=join(dir,entry.name),s=lstatSync(full);if(s.isSymbolicLink())continue;if(s.isDirectory())walk(full,depth+1);else if(s.isFile()&&s.nlink===1&&allowed.has(extname(entry.name).toLowerCase())){if(s.size>160000||bytes+s.size>600000||files.length>=60){truncated=true;continue}const buffer=readFileSync(full);if(buffer.includes(0))continue;bytes+=buffer.length;files.push({path:relative(root,full).replaceAll('\\','/'),sha256:createHash('sha256').update(buffer).digest('hex'),text:buffer.toString('utf8')})}}}
 walk(root,0)
 return{root,commit:'local-files',files,truncated}
}
export function methodRequirements(requirements:string[]):string[]{
 if(!Array.isArray(requirements)||requirements.length>30||requirements.some(item=>typeof item!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:==[A-Za-z0-9_.+-]+)?$/.test(item)))throw new Error('依赖只接受包名或package==version，不接受URL、路径或pip参数。')
 return requirements
}
export function methodChildEnvironment():NodeJS.ProcessEnv {
 const env:NodeJS.ProcessEnv={PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PIP_CONFIG_FILE:process.platform==='win32'?'NUL':'/dev/null',PIP_NO_INPUT:'1',PIP_DISABLE_PIP_VERSION_CHECK:'1'}
 for(const key of ['SystemRoot','WINDIR','PATH','Path','TEMP','TMP'])if(process.env[key])env[key]=process.env[key]
 return env
}
export async function checkoutMethodSource(url:string,parent:string,signal:AbortSignal):Promise<MethodSourceInventory>{
 if(!/^https:\/\/github\.com\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\.git)?\/?$/.test(url))throw new Error('请使用GitHub仓库HTTPS地址。')
 mkdirSync(parent,{recursive:true});assertSourceDirectory(parent);const root=mkdtempSync(join(parent,'source-'))
 await execute('git',['-c',`core.hooksPath=${process.platform==='win32'?'NUL':'/dev/null'}`,'-c','credential.helper=','clone','--depth','1','--no-recurse-submodules','--',url,root],{cwd:parent,signal,windowsHide:true,timeout:120000,maxBuffer:200000,env:{...methodChildEnvironment(),GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_LFS_SKIP_SMUDGE:'1'}})
 const commit=(await execute('git',['-C',root,'rev-parse','HEAD'],{cwd:parent,signal,windowsHide:true})).stdout.trim()
 return{...inspectMethodSource(root),commit}
}
export async function prepareMethodEnvironment(python:string,parent:string,requirements:string[],signal:AbortSignal):Promise<string>{
 methodRequirements(requirements);mkdirSync(parent,{recursive:true});assertSourceDirectory(parent);const dir=mkdtempSync(join(parent,'env-'))
 await execute(python,['-I','-m','venv',dir],{cwd:parent,signal,windowsHide:true,timeout:120000,maxBuffer:500000,env:methodChildEnvironment()})
 const interpreter=join(dir,process.platform==='win32'?'Scripts/python.exe':'bin/python')
 if(requirements.length)await execute(interpreter,['-I','-m','pip','install','--disable-pip-version-check','--only-binary=:all:',...requirements],{cwd:parent,signal,windowsHide:true,timeout:240000,maxBuffer:500000,env:methodChildEnvironment()})
 return interpreter
}
