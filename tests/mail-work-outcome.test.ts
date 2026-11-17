import{test}from'node:test';import*as assert from'node:assert/strict';
import{Board}from'../src/board.js';import{handleHook}from'../src/hooks.js';import{markWoken}from'../src/wake.js';
function fixture(){const b=new Board(null,()=>100000);const s=b.touch('mail-outcome','','codex').session;b.setWork(s,'done','Finished release');s.state='idle';return{b,s};}
test('informational mail turn preserves done outcome and next step at Stop',()=>{
 const{b,s}=fixture();markWoken(b,s,[]);assert.equal(s.work,'active');
 handleHook(b,'codex',{session_id:s.id,hook_event_name:'UserPromptSubmit',prompt:'<kokuban-message>Release receipt</kokuban-message>'});
 handleHook(b,'codex',{session_id:s.id,hook_event_name:'Stop'});assert.equal(s.work,'done');assert.equal(s.next,'Finished release');assert.ok(!b.status(s).includes('stalled'));
});
test('new explicit outcome wins and a real human prompt starts fresh active work',()=>{
 const{b,s}=fixture();markWoken(b,s,[]);b.setWork(s,'waiting','Awaiting a review');handleHook(b,'codex',{session_id:s.id,hook_event_name:'Stop'});assert.equal(s.work,'waiting');
 markWoken(b,s,[]);handleHook(b,'codex',{session_id:s.id,hook_event_name:'UserPromptSubmit',prompt:'Please implement a new feature'});handleHook(b,'codex',{session_id:s.id,hook_event_name:'Stop'});assert.equal(s.work,'active');assert.equal(s.beforeMailWork,undefined);
});
test('unresolved owned tasks remain active instead of restoring a prior done outcome',()=>{
 const{b,s}=fixture();markWoken(b,s,[]);b.workTasks.push({owner:{id:s.id},state:'accepted',id:'pending'}as any);
 const result=handleHook(b,'codex',{session_id:s.id,hook_event_name:'Stop'});assert.ok(result);assert.equal(s.work,'active');
 handleHook(b,'codex',{session_id:s.id,hook_event_name:'Stop'});assert.equal(s.work,'active');
});
