import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Board } from '../src/board.js';
import { remoteFor } from '../src/peer.js';
import { wakeMail } from '../src/wake.js';
import { LOOP_SETTINGS,readLoopLimit } from '../src/loop-limit.js';
import { taskTool } from '../src/tasks.js';
const original=LOOP_SETTINGS.file,dir=fs.mkdtempSync(path.join(os.tmpdir(),'loop-settings-'));
before(()=>{LOOP_SETTINGS.file=path.join(dir,'settings.json');fs.writeFileSync(LOOP_SETTINGS.file,JSON.stringify({loopLimit:12}));});
after(()=>{LOOP_SETTINGS.file=original;fs.rmSync(dir,{recursive:true,force:true});});

test('a loop counts both directions, exempts card answers and board notices, and expires after ten minutes', () => {
  let now = 1_000_000;
  const b = new Board(null, () => now);
  const a = b.touch('a', '', 'claude').session, c = b.touch('c', '', 'codex').session;
  for (let i = 0; i <= readLoopLimit(); i++) b.send(i % 2 ? c : a, i % 2 ? a.name : c.name, 'repeat');
  assert.throws(() => b.send(a, c.name, 'loop'), /looks like a loop; check with your human/);
  b.sendFromPerson(a.name, c, 'real answer');
  b.taskMail(c.id, 'board notice');
  assert.throws(() => b.send(c, a.name, 'still blocked'), /looks like a loop/);
  now += 10 * 60_000 + 1;
  assert.match(b.send(a, c.name, 'fresh'), /sent to/);
});

test('cross-PC loop counts outgoing and incoming mail and leaves card answers exempt', async () => {
  const b = new Board(null);
  const a = b.touch('a', '', 'claude').session;
  const remote = { pc: 'pc-b.tail1234.ts.net', agent: 'Iris' };
  const send = remoteFor(b, async () => JSON.stringify({ ok: true }));
  for (let i = 0; i < readLoopLimit()/2; i++) {
    await send({ op: 'agent_send', me: a.name, pc: remote.pc, to: remote.agent, text: 'out' });
    b.sendRemote(remote, a, 'in');
  }
  b.sendRemote(remote, a, 'thirteenth');
  assert.throws(() => b.sendRemote(remote, a, 'loop'), /looks like a loop/);
  await assert.rejects(send({ op: 'agent_send', me: a.name, pc: 'pc-b', to: 'Iris', text: 'loop' }), /looks like a loop/);
  await send({ op: 'agent_send', me: a.name, pc: 'pc-b', to: 'Iris', text: 'answer', request_id: 'card-0123456789abcdef-1' });
  b.sendRemote(remote, a, 'answer', true);
});

test('loop setting defaults to40, accepts an explicit limit and keeps invalid settings guarded',()=>{
  try{for(const value of [undefined,0,-1,'unlimited',Infinity]){fs.writeFileSync(LOOP_SETTINGS.file,JSON.stringify({loopLimit:value}));assert.equal(readLoopLimit(),40);}
    fs.writeFileSync(LOOP_SETTINGS.file,JSON.stringify({loopLimit:2}));assert.equal(readLoopLimit(),2);
    const b=new Board(null),a=b.touch('a','','claude').session,c=b.touch('c','','codex').session;
    for(let i=0;i<3;i++)b.send(a,c.name,'coordination');assert.throws(()=>b.send(a,c.name,'loop'),/looks like a loop/);
  }finally{fs.writeFileSync(LOOP_SETTINGS.file,JSON.stringify({loopLimit:12}));}
});
test('task protocol and coordination between active task endpoints remain exempt after completion',async()=>{
  const b=new Board(null),a=b.touch('a','','claude').session,c=b.touch('c','','codex').session;
  const t=JSON.parse(await taskTool(b,a,{op:'create',to:c.name,text:'Build and return evidence'}));
  await taskTool(b,c,{op:'accept',id:t.id});
  for(let i=0;i<60;i++)b.send(i%2?a:c,i%2?c.name:a.name,'task coordination');
  assert.ok(b.messages.filter(m=>!m.task&&m.fromLabel!=='the board').every(m=>m.loopExempt));
  await taskTool(b,c,{op:'progress',id:t.id,text:'Working'});await taskTool(b,c,{op:'complete',id:t.id,text:'Done with evidence'});
  assert.match(b.send(a,c.name,'one ordinary followup'),/sent to/);
  for(let i=0;i<readLoopLimit();i++)b.send(a,c.name,'ordinary');assert.throws(()=>b.send(a,c.name,'loop'),/looks like a loop/);
});

test('repo addressing matches full canonical name or basename, reaches live sessions only, and never wakes', () => {
  const b = new Board(null);
  const a = b.touch('a', '', 'claude').session;
  const c = b.touch('c', '', 'codex').session;
  const d = b.touch('d', '', 'claude').session;
  const gone = b.touch('gone', '', 'claude').session;
  c.project = gone.project = 'example-org/acme';
  d.project = 'example-org/kokuban';
  c.state = 'idle';
  b.end(gone.id);
  assert.match(b.send(a, 'repo:ACME', 'repo news'), /sent to/);
  assert.equal(b.messages.length, 1);
  assert.equal(b.messages[0]!.direct, false);
  assert.equal(wakeMail(b, c).length, 0);
  b.take(c);
  assert.match(b.send(a, 'repo:example-org/acme', 'canonical news'), /sent to/);
  assert.equal(b.take(c).length, 1);
  assert.equal(b.take(d).length, 0);
  assert.match(b.send(a, 'repo:missing', 'news'), /no other live session/);
});
