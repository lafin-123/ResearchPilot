import type { Provider } from '../../shared/types'
import { normalizeProviderBase, providerHttpError, redactProviderError } from './provider-http'
export async function generateResearchJson(provider:Provider,key:string,modelId:string,prompt:string,request:typeof fetch,signal:AbortSignal):Promise<unknown> {
  if(!key||!provider.models.some(m=>m.id===modelId))throw new Error('请配置当前科研角色的Key和模型。')
  if(prompt.length>180000)throw new Error('本次研究上下文过长，请拆分资料。')
  const base=normalizeProviderBase(provider.baseUrl,provider.protocol), anthropic=provider.protocol==='anthropic-messages',responses=provider.protocol==='openai-responses'
  const url=`${base}${anthropic&&!base.endsWith('/v1')?'/v1':''}/${anthropic?'messages':responses?'responses':'chat/completions'}`
  const cap=Math.min(provider.models.find(m=>m.id===modelId)?.maxOutput??12000,12000)
  const body=responses?{model:modelId,input:[{role:'user',content:[{type:'input_text',text:prompt}]}],max_output_tokens:cap,store:false,stream:false}:anthropic?{model:modelId,messages:[{role:'user',content:prompt}],max_tokens:cap,stream:false}:{model:modelId,messages:[{role:'user',content:prompt}],...(/^gpt-5|^gpt-6|^o[134]/.test(modelId)?{max_completion_tokens:cap}:{max_tokens:cap}),stream:false}
  try{
    signal.throwIfAborted()
    const response=await request(url,{method:'POST',headers:anthropic?{'x-api-key':key,'anthropic-version':'2023-06-01','Content-Type':'application/json'}:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(180000)])})
    const reader=response.body?.getReader();if(!reader)throw new Error('模型响应为空。')
    const parts:Uint8Array[]=[];let bytes=0
    try{for(;;){const p=await reader.read();if(p.done)break;bytes+=p.value.length;if(bytes>2*1024*1024)throw new Error('模型响应超过2MiB。');parts.push(p.value)}}finally{await reader.cancel().catch(()=>{})}
    const raw=Buffer.concat(parts).toString('utf8');if(!response.ok)throw new Error(providerHttpError(response.status,raw,key))
    const payload=JSON.parse(raw);if(payload.error)throw new Error('上游返回模型错误，请检查服务状态。')
    const text=payload.choices?.[0]?.message?.content??payload.content?.map((b:{text?:string})=>b.text??'').join('')??payload.output_text??payload.output?.flatMap((b:{content?:Array<{text?:string}>})=>b.content?.map(c=>c.text??'')??[]).join('')
    if(typeof text!=='string'||text.length>200000)throw new Error('模型未返回有效文本。')
    const result=JSON.parse(text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''))
    if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('模型需要返回一个研究JSON对象。')
    signal.throwIfAborted();return result
  }catch(error){if(signal.aborted)throw signal.reason??new Error('任务已停止。');throw new Error(redactProviderError(error,key))}
}
