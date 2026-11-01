import test from 'node:test'
import assert from 'node:assert/strict'
import {turnFailure} from '../src/main/lib/turn-result'
test('structured upstream errors cannot be mistaken for an empty successful completion',()=>{assert.equal(turnFailure([{type:'turn/end',data:{reason:{kind:'error',error:{message:'gateway_concurrency_limit'}}}}]),'gateway_concurrency_limit')})
test('max tokens and cancellations report incomplete stages while normal ends remain successful',()=>{assert.match(turnFailure([{type:'turn/end',data:{reason:{kind:'max-tokens'}}}])!,/上限/);assert.match(turnFailure([{type:'turn/end',data:{reason:'cancelled'}}])!,/停止/);assert.equal(turnFailure([{type:'turn/end',data:{reason:{kind:'completed'}}}]),null);assert.equal(turnFailure([]),null)})
