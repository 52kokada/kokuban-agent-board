import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Script, createContext } from 'node:vm';
import { client } from '../src/phone/shell.js';

function source(...names: string[]) {
  return names.map(name => {
    const line = client.split('\n').find(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
    assert.ok(line, name); return line;
  }).join('\n');
}
const node = (tag = '', cls = '', text = ''): any => ({ tag, cls, textContent: text, children: [], dataset: {}, append(...v: any[]) { this.children.push(...v); }, replaceChildren() { this.children = []; } });

test('failure recovery shows the reason and separates queued messages from uncertain attempts', () => {
  const host = node(), s = { id: 's', phase: 'stopped', problem: 'Provider safeguard refused this session', messages: [{ id:'a', state:'uncertain', text:'previous action' }, { id:'b', state:'queued', text:'next action' }] };
  const c: any = createContext({ selected: s, $: () => host, el: node, button: (label: string) => node('button','',label), pending: () => null });
  new Script(source('recoveryCounts','renderRecovery')).runInContext(c);
  new Script('renderRecovery()').runInContext(c);
  const all = (n: any): string => [n.textContent, ...n.children.map(all)].join(' ');
  assert.equal(host.hidden, false);
  assert.match(all(host), /Provider safeguard refused/);
  assert.match(all(host), /1 queued message is waiting/);
  assert.match(all(host), /1 previous attempt will not be resent/);
  assert.ok(host.children.some((n: any) => n.tag === 'button' && n.textContent === 'Resume 1 queued'));
  s.phase = 'recovery'; new Script('renderRecovery()').runInContext(c);
  assert.ok(host.children.some((n: any) => n.tag === 'button' && n.textContent === 'Reconnect & resume 1 queued'));
  s.phase = 'idle'; new Script('renderRecovery()').runInContext(c); assert.equal(host.hidden, true);
});

test('paused Send submits one explicit resume-and-send command without an extra confirmation', async () => {
  const d = { text:'continue with my new instruction', files:[], revision:1, voiceJobs:[] }, message = { value:d.text }, viewport = { scrollTop:0, scrollHeight:100 };
  const calls: any[] = []; let rendered = 0;
  const c: any = createContext({ selected:{id:'s',phase:'stopped'}, wantsChat:()=>true, draft:()=>d, $:(id:string)=>id==='message'?message:viewport, TextEncoder,
    commandFor:async(...args:any[])=>{calls.push(args);return {session:{phase:'working'}};}, renderDraft(){rendered++;}, toast(){} });
  new Script(source('sendMessage')).runInContext(c);
  await new Script('sendMessage()').runInContext(c);
  assert.equal(calls.length,1); assert.equal(calls[0][1],'message'); assert.equal(calls[0][2].resume,true); assert.equal(d.text,''); assert.equal(rendered,1);
});

test('a rejected resume-and-send keeps the draft and attachments for retry', async () => {
  const d = { text:'keep me', files:[{id:'image'}], revision:2 }, c: any = createContext({ selected:{id:'s',phase:'stopped'},wantsChat:()=>true,draft:()=>d,$:()=>({value:d.text}),TextEncoder,commandFor:async()=>{throw Error('Another control changed');} });
  new Script(source('sendMessage')).runInContext(c);
  await assert.rejects(new Script('sendMessage(true)').runInContext(c), /Another control changed/);
  assert.equal(d.text,'keep me'); assert.equal(d.files[0].id,'image');
});

test('pressing Send retains composer focus so keyboard layout cannot move the button before click', () => {
  const c: any = createContext({}); new Script(source('keepComposerFocus')).runInContext(c);
  let prevented = false;
  c.event = { currentTarget:{disabled:false}, preventDefault(){prevented=true;} };
  new Script('keepComposerFocus(event)').runInContext(c); assert.equal(prevented,true);
  prevented=false; c.event.currentTarget.disabled=true;
  new Script('keepComposerFocus(event)').runInContext(c); assert.equal(prevented,false);
  assert.ok(client.includes("$('send').addEventListener('pointerdown',keepComposerFocus)"));
});
