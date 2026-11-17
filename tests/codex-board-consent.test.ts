import{test}from'node:test';
import*as assert from'node:assert/strict';
import{automaticBoardConsent,CodexRuntime}from'../src/conversations/providers/codex.js';
import type{ManagedPolicy}from'../src/conversations/providers/policy.js';

const url='http://127.0.0.1:47600/chief/mcp/runtime-capability';
const policy:ManagedPolicy={systemAppend:'',mcpServers:{kokuban:{type:'http',url}},codexConfig:{mcp_servers:{kokuban:{url,enabled:true}}},gate:async()=>false};
const envelope=(tool:string)=>({serverName:'kokuban',mode:'form',_meta:{codex_approval_kind:'mcp_tool_call'},message:`Allow the kokuban MCP server to run tool "${tool}"?`,requestedSchema:{type:'object',properties:{}}});
test('only exact empty-schema consent for bound board coordination tools is automatic',()=>{
 for(const tool of ['peers','glance','send','inbox','task','know','claim','release'])assert.equal(automaticBoardConsent(policy,envelope(tool)),true,tool);
 for(const tool of ['ask','conversation','usage','notify','approve','publish','peers"?\nanything'])assert.equal(automaticBoardConsent(policy,envelope(tool)),false,tool);
 for(const request of [{...envelope('peers'),serverName:'outside'},{...envelope('peers'),mode:'url'},{...envelope('peers'),_meta:{}},{...envelope('peers'),requestedSchema:{type:'object',properties:{password:{type:'string'}}}},{...envelope('peers'),message:'Please allow peers'}])assert.equal(automaticBoardConsent(policy,request),false);
 assert.equal(automaticBoardConsent(undefined,envelope('peers')),false);
 assert.equal(automaticBoardConsent({...policy,codexConfig:{}},envelope('peers')),false);
});
test('automatic board consent bypasses cards; other elicitation still waits for human approval',async()=>{
 let cards=0;const frames:any[]=[];const events:any[]=[];
 const runtime=new CodexRuntime({}as any,{approval:async()=>{cards++;return false;},event:(...args:any[])=>events.push(args)}as any,policy)as any;
 const child={stdin:{writable:true,write:(s:string)=>frames.push(JSON.parse(s))}};runtime.child=child;
 await runtime.frame({id:1,method:'mcpServer/elicitation/request',params:envelope('task')},child);
 assert.equal(cards,0);assert.equal(frames[0].result.action,'accept');assert.equal(events[0][0],'policy_consent');
 await runtime.frame({id:2,method:'mcpServer/elicitation/request',params:envelope('ask')},child);
 assert.equal(cards,1);assert.equal(frames[1].result.action,'decline');
});
