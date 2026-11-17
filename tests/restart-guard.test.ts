import{test}from'node:test';import*as assert from'node:assert/strict';
import{waitForManagedIdle}from'../src/conversations/restart-guard.js';
import type{ChatSession}from'../src/conversations/contracts.js';
const session=(phase:string,messages:any[]=[]):ChatSession=>({name:'Chief',phase,messages}as ChatSession);
test('restart waits for active turns and queued messages before returning',async()=>{
 let at=0,reads=0;const states=[session('working'),session('idle',[{state:'queued'}]),session('idle')];
 await waitForManagedIdle({read:async()=>[states[Math.min(reads++,2)]],now:()=>at,sleep:async ms=>{at+=ms;}});
 assert.equal(reads,3);assert.equal(at,10000);
});
test('restart aborts at deadline without authorizing an interrupt',async()=>{
 let at=0;await assert.rejects(waitForManagedIdle({read:async()=>[session('approval')],now:()=>at,sleep:async ms=>{at+=ms;},timeoutMs:10000}),/Restart held/);assert.equal(at,10000);
});
test('idle preflight fails closed on unreadable state and preserves stopped sessions',async()=>{
 await assert.rejects(waitForManagedIdle({read:async()=>{throw Error('offline');}}),/offline/);
 await waitForManagedIdle({read:async()=>[session('stopped',[{state:'queued'}]),session('recovery')]});
});
