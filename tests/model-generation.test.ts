import test from 'node:test'
import assert from 'node:assert/strict'
import type { Provider } from '../src/shared/types'
test('structured generation uses selected protocol, returns JSON and redacts failed responses', async () => {
 const { generateResearchJson }=await import('../src/main/lib/model-generation')
 for(const protocol of ['openai-completions','openai-responses','anthropic-messages'] as const){
  const provider={id:'p',name:'p',kind:'custom',protocol,baseUrl:'https://models.example/v1',models:[{id:'m',label:'m'}]} as Provider
  const request=(async (_url,init)=>{const body=JSON.parse(String(init?.body));assert.equal(body.model,'m');assert.equal(body.stream,false);return new Response(JSON.stringify(protocol==='anthropic-messages'?{content:[{text:'{"answer":42}'}]}:protocol==='openai-responses'?{output:[{content:[{text:'{"answer":42}'}]}]}:{choices:[{message:{content:'{"answer":42}'}}]}))}) as typeof fetch
  const result=await generateResearchJson(provider,'test-key','m','test',request,new AbortController().signal)
  assert.equal((result as {answer:number}).answer,42)
  await assert.rejects(generateResearchJson(provider,'test-key','m','test',(async()=>new Response('test-key',{status:401})) as typeof fetch,new AbortController().signal),e=>e instanceof Error&&!e.message.includes('test-key'))
 }
})
