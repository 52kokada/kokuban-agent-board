import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { chiefGitEnvironment } from '../src/chief/git-hook.js';
import { classifyTool,gateDescription } from '../src/chief/gate.js';
import { ChiefService,budgetProvider } from '../src/chief/service.js';
import { ConversationController } from '../src/conversations/controller.js';
import { ConversationStore } from '../src/conversations/store.js';
import { backupConversations } from '../src/conversations/backup.js';
import { Board } from '../src/board.js';
import type { ChatSession,RuntimeSink } from '../src/conversations/contracts.js';

// The Git adapter is gitignored and built by `node scripts/build-chief-git.mjs`; a fresh worktree lacks it.
const chiefGitExe=path.resolve(import.meta.dirname,'../../assets/chief-git/ChiefGit.exe');
const noChiefGit=process.platform!=='win32'?'Windows only':!fs.existsSync(chiefGitExe)?`assets/chief-git/ChiefGit.exe is missing; build it with node scripts/build-chief-git.mjs`:false;

test('delegate Git refuses bypasses, preserves local commands and gates an actual push', {skip:noChiefGit},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chief-git-'));
  const git=(args:string[],env=process.env)=>execFileSync('git',args,{cwd:dir,env,windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  try{
    git(['init','--bare',path.join(dir,'remote.git')]);git(['init',path.join(dir,'work')]);
    const work=path.join(dir,'work');const local=(args:string[])=>git(['-C',work,...args]);
    local(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','fixture']);
    local(['remote','add','origin',path.join(dir,'remote.git')]);
    const env=chiefGitEnvironment(path.join(dir,'hooks'),'http://127.0.0.1:1/refuse');
    const wrapper=path.join(dir,'hooks','bin','git.exe');
    const run=(args:string[],e=env)=>execFileSync(wrapper,['-C',work,...args],{env:e,windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']});
    assert.equal(run(['status','--porcelain']),'');assert.equal(run(['diff']),'');
    fs.writeFileSync(path.join(work,'.git','hooks','pre-commit'),'#!/bin/sh\necho preserved > .git/chief-hook-proof\n');
    run(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','through adapter']);
    assert.equal(fs.readFileSync(path.join(work,'.git','chief-hook-proof'),'utf8').trim(),'preserved');
    for(const args of [['push','--no-verify','origin','HEAD:refs/heads/test'],['-c','core.hooksPath=NUL','push','origin','HEAD:refs/heads/test']]){
      assert.throws(()=>run(args),(e:any)=>e.status===77);
    }
    assert.throws(()=>run(['push','origin','HEAD:refs/heads/test'],{...env,GIT_CONFIG_COUNT:'0'}),(e:any)=>e.status===77);
    assert.throws(()=>run(['push','origin','HEAD:refs/heads/test']),(e:any)=>{assert.match(String(e.stderr),/Kokuban did not confirm approval/,JSON.stringify({status:e.status,signal:e.signal,stderr:String(e.stderr),stdout:String(e.stdout)}));return true;});
    assert.throws(()=>git(['--git-dir',path.join(dir,'remote.git'),'show-ref'],process.env),(e:any)=>e.status===1&&String(e.stdout)==='');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('chief deny list gates consequential categories and permits ordinary unknown actions',()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'chief-gate-'));try{
    for(const [name,input]of [
      ['Bash',{command:'git push origin main'}],['Bash',{command:'npm run release:aoz'}],['Bash',{command:'wrangler deploy'}],
      ['mcp__payments__charge',{amount:10}],['mcp__mail__send_mail',{to:'outside@example.com',body:'hello'}],['mcp__site__publish',{url:'https://example.com'}],
      ['Bash',{command:'git status; git push'}],
      ['mcp__shopify__update_product',{id:1}],['WebFetch',{url:'https://shop.myshopify.com/admin/api',method:'POST',body:'mutation'}],
    ]as Array<[string,Record<string,unknown>]>){assert.equal(classifyTool(name,input,cwd).decision,'ask',name+JSON.stringify(input));}
    assert.equal(classifyTool('Read',{file_path:path.join(cwd,'product.txt')},cwd).decision,'allow');
    assert.equal(classifyTool('WebFetch',{url:'https://shop.myshopify.com/products'},cwd).decision,'allow');
    assert.equal(classifyTool('Bash',{command:'git status --short'},cwd).decision,'allow');
    assert.equal(classifyTool('Bash',{command:'python unknown.py'},cwd).decision,'allow');assert.equal(classifyTool('UnknownTool',{},cwd).decision,'allow');
    for(const command of ['git log | head','echo okay > output.txt','node --test check.test.mjs > test.log','git status && git diff'])assert.equal(classifyTool('Bash',{command},cwd).decision,'allow',command);
    assert.equal(classifyTool('Bash',{command:"node -e \"require('child_process').execFileSync('git',['push'])\""},cwd).decision,'ask');
    assert.equal(classifyTool('Edit',{file_path:path.join(cwd,'app.ts'),old_string:'a',new_string:'b'},cwd).decision,'allow');
    assert.equal(classifyTool('Read',{file_path:'C:/Users/alex/AppData/Local/kokuban/settings.json'},cwd).decision,'deny');
    const d=classifyTool('Bash',{command:'git push origin main'},cwd);assert.ok(gateDescription(d).includes('Exact command/input:\ngit push origin main'));assert.ok(gateDescription(d).includes('Target:'));
  }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
test('local workspace/temp deletion stays free while outside writes and broad grants are gated',()=>{
  const cwd=fs.mkdtempSync(path.join(os.homedir(),'.chief-test-'));try{
    fs.mkdirSync(path.join(cwd,'.kokuban-scratch'));fs.writeFileSync(path.join(cwd,'.kokuban-scratch','safe.txt'),'safe');fs.writeFileSync(path.join(cwd,'kept.txt'),'kept');
    assert.equal(classifyTool('Bash',{command:'rm .kokuban-scratch/safe.txt'},cwd).decision,'allow');
    assert.equal(classifyTool('Bash',{command:'rm kept.txt'},cwd).decision,'allow');
    assert.equal(classifyTool('Bash',{command:'rm "'+path.join(os.homedir(),'outside-kept.txt')+'"'},cwd).decision,'ask');
    assert.equal(classifyTool('File change',{grantRoot:cwd},cwd).decision,'deny');
    assert.equal(classifyTool('File change',{changes:[{path:path.join(cwd,'kept.txt'),kind:{type:'update'},diff:'-a\n+b'}]},cwd).decision,'allow');
  }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
test('budget boundaries keep Claude for judgment and reserve it for chief above90%',()=>{
  assert.equal(budgetProvider(69,'claude','implementation'),'claude');assert.equal(budgetProvider(70,'claude','implementation'),'codex');
  assert.equal(budgetProvider(81,'claude','judgment'),'claude');assert.equal(budgetProvider(90,'claude','judgment'),'claude');
  assert.equal(budgetProvider(91,'claude','judgment'),'codex');assert.equal(budgetProvider(null,'claude','judgment'),'codex');
});
test('chief role is singleton and cannot be selected by ordinary conversation launch',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chief-controller-'));const store=new ConversationStore(path.join(dir,'chat.sqlite'));
  const c=new ConversationController(store,{host:'test',catalog:()=>[{id:'repo',name:'Repo',path:dir}],factory:()=>({start:async()=>randomUUID(),send:async()=>undefined,interrupt:async()=>{},close:async()=>{}})});
  const actor={pc:'test',person:'Chief'};try{
    await assert.rejects(c.launch({id:randomUUID(),projectId:'repo',provider:'claude',name:'Chief'},actor),/reserved/);
    const prior=await c.launch({id:randomUUID(),projectId:'repo',provider:'claude',name:'Cedar'},actor);
    const legacy=(await store.get(prior.id))!;legacy.name='Chief';legacy.phase='recovery';legacy.revision++;
    await store.commit(legacy,legacy.revision-1,[]);
    const s=await c.launch({id:randomUUID(),projectId:'repo',provider:'claude',name:'Chief'},actor,{role:'chief'});assert.equal(s.role,'chief');
    const renamed=(await store.get(prior.id))!;assert.notEqual(renamed.name,'Chief');assert.equal(renamed.phase,'recovery');
    assert.equal((await backupConversations(path.join(dir,'chat.sqlite'),path.join(dir,'backup.sqlite'))).version,3);
    await assert.rejects(c.launch({id:randomUUID(),projectId:'repo',provider:'claude',name:'Chief'},actor,{role:'chief'}),/already has a chief/);
    const child=await c.launch({id:randomUUID(),projectId:'repo',provider:'codex'},actor,{chiefParent:s.id});assert.equal(child.chiefParent,s.id);
  }finally{await c.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('chief-only MCP authority is bound to runtime capability and not the supplied board name',{skip:noChiefGit},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chief-mcp-'));const b=new Board(path.join(dir,'board.json'));const approvals:any[]=[];
  const s:ChatSession={id:randomUUID(),provider:'claude',name:'Chief',role:'chief',project:'repo',cwd:dir,host:'test',phase:'working',epoch:1,revision:1,controlRevision:0,created:Date.now(),updated:Date.now(),messages:[],approvals:[]};
  const child={...s,id:randomUUID(),role:undefined,provider:'codex' as const,name:'Cedar',chiefParent:s.id};let list=[s,child];
  b.conversations={notices:new EventEmitter(),local:async()=>({sessions:list})}as any;const chief=new ChiefService(b,path.join(dir,'chief'));
  const sink:RuntimeSink={event:()=>{},turn:()=>{},complete:()=>{},exit:()=>{},approval:async(...a)=>{approvals.push(a);return false;}};
  try{
    assert.equal(chief.policy({...s,role:undefined},sink),undefined);
    const policy=chief.policy(s,sink)!,delegated=chief.policy(child,sink)!;
    assert.deepEqual(Object.keys(delegated.mcpServers!),['kokuban']);assert.ok(policy.mcpServers!.computeruse);
    const secret=(policy.mcpServers!.kokuban as any).url.split('/').at(-1),other=(delegated.mcpServers!.kokuban as any).url.split('/').at(-1);
    const tools=await chief.rpc(secret,{jsonrpc:'2.0',id:1,method:'tools/list'})as any;assert.ok(tools.result.tools.some((t:any)=>t.name==='conversation'));
    await assert.rejects(chief.rpc(other,{id:2,method:'tools/call',params:{name:'conversation',arguments:{op:'list',me:'Chief'}}}),/Chief-only/);
    await assert.rejects(chief.rpc('forged',{method:'tools/list'}),/Unknown/);
    await policy.gate('Bash',{command:'git push origin main'},'exact-tool-id');assert.equal(approvals[0][0],'exact-tool-id');assert.match(approvals[0][2],/git push origin main/);
    list=[{...s,epoch:2},child];await assert.rejects(chief.rpc(secret,{method:'tools/list'}),/Expired/);
  }finally{await chief.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('chief recovery resumes after a provider crash while respecting a person Stop',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chief-recovery-'));const b=new Board(path.join(dir,'board.json'));
  let s:ChatSession={id:randomUUID(),provider:'claude',name:'Chief',role:'chief',project:'repo',cwd:dir,host:'test',phase:'recovery',epoch:1,revision:1,controlRevision:0,created:Date.now(),updated:Date.now(),messages:[],approvals:[]};
  const commands: any[]=[];
  b.conversations={notices:new EventEmitter(),local:async()=>({sessions:[s]}),chiefCommand:async(c:any)=>{commands.push(c);if(c.op==='restart')s={...s,epoch:s.epoch+1,phase:'stopped'};else if(c.op==='resume')s={...s,phase:'idle'};return s;}}as any;
  const chief=new ChiefService(b,path.join(dir,'chief'),'http://127.0.0.1',{retryMs:0});
  try{
    await (chief as any).tick();await (chief as any).tick();
    assert.deepEqual(commands.map(c=>c.op),['restart','resume','message']);
    s={...s,phase:'stopped'};await (chief as any).tick();assert.equal(commands.length,3);
    s={...s,phase:'closed'};await (chief as any).tick();assert.equal(commands.length,3);
  }finally{await chief.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('managed peer mail is confirmed only after durable enqueue, with a stable retry ID',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chief-mail-'));const b=new Board(path.join(dir,'board.json'));
  const s:ChatSession={id:randomUUID(),provider:'claude',name:'Chief',role:'chief',project:'repo',cwd:dir,host:'test',phase:'idle',epoch:1,revision:1,controlRevision:0,created:Date.now(),updated:Date.now(),messages:[],approvals:[]};
  const registered={id:'managed-chief',name:'Chief',managed:s.id,work:'active',seen:Date.now()}as any;b.sessions.push(registered);
  const message={id:1,to:registered.id,from:'Willow',fromLabel:'design owner',text:'Please inspect the result.',direct:true,ts:b.clock()}as any;b.messages.push(message);
  let fail=true;const commands:any[]=[];
  b.conversations={notices:new EventEmitter(),local:async()=>({sessions:[s]}),chiefCommand:async(c:any)=>{commands.push(c);if(fail)throw Error('SQLite unavailable');return s;}}as any;
  const chief=new ChiefService(b,path.join(dir,'chief'));
  try{
    await assert.rejects((chief as any).deliverMail(),/SQLite/);assert.ok(!message.delivered);
    fail=false;await (chief as any).deliverMail();assert.equal(message.delivered,true);assert.equal(commands[0].id,commands[1].id);assert.match(commands[1].text,/<kokuban-message/);
    await (chief as any).deliverMail();assert.equal(commands.length,2);
  }finally{await chief.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('chief quiet recovery skips recorded done sessions and still nudges active stalled work',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chief-stall-'));const b=new Board(path.join(dir,'board.json'));const peer=b.touch('finished-peer','','codex').session;peer.name='Beck';peer.state='idle';peer.seen=Date.now()-16*60000;b.setWork(peer,'done','Release finished');
 const s={id:randomUUID(),role:'chief',name:'Chief',phase:'idle',epoch:1,controlRevision:0}as ChatSession;const commands:any[]=[];
 b.conversations={notices:new EventEmitter(),local:async()=>({sessions:[s]}),chiefCommand:async(c:any)=>{commands.push(c);return s;}}as any;
 const chief=new ChiefService(b,path.join(dir,'chief'));try{
  await(chief as any).watchSessions(s);assert.equal(commands.length,0);
  b.setWork(peer,'active');await(chief as any).watchSessions(s);assert.equal(commands.length,1);assert.match(commands[0].text,/quiet for15minutes/);
  b.setWork(peer,'done','Release finished');await(chief as any).watchSessions(s);assert.equal(commands.length,1);assert.equal((chief as any).state.watching[peer.id],undefined);
 }finally{await chief.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('managed mail waits for a batch but urgent work bypasses a full pending batch',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chief-batch-'));let now=1_000_000;const b=new Board(null,()=>now);
 const s={id:randomUUID(),role:'chief',name:'Chief',phase:'idle',epoch:1,controlRevision:0}as ChatSession;
 const registered={id:'managed-chief',name:'Chief',managed:s.id,work:'active',seen:now}as any;b.sessions.push(registered);
 for(let i=0;i<20;i++)b.messages.push({id:i+1,to:registered.id,toName:registered.name,from:'Willow',fromLabel:'owner',text:`Routine action ${i}`,direct:true,ts:now,wakeAfter:now+2000,delivered:false});
 const commands:any[]=[];
 b.conversations={notices:new EventEmitter(),local:async()=>({sessions:[s]}),chiefCommand:async(c:any)=>{commands.push(c);return s;}}as any;
 const chief=new ChiefService(b,path.join(dir,'chief'));
 try{
  await(chief as any).deliverMail();assert.equal(commands.length,0);
  b.messages.push({id:21,to:registered.id,toName:registered.name,from:'Willow',fromLabel:'owner',text:'Urgent stop',direct:true,ts:now,delivered:false});
  await(chief as any).deliverMail();assert.equal(commands.length,1);assert.match(commands[0].text,/Urgent stop/);
  assert.equal(b.messages[20]!.delivered,true);assert.equal(b.messages.filter(m=>!m.delivered).length,1);
  now+=2000;await(chief as any).deliverMail();assert.equal(commands.length,2);assert.ok(b.messages.every(m=>m.delivered));
 }finally{await chief.close();fs.rmSync(dir,{recursive:true,force:true});}
});
