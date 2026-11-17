import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { askTool } from '../src/ask.js';
import { handleBridge } from '../src/bridge.js';
import { EXPIRE_MS, SENT_FILE, SETTINGS, agentSays, answerCard, cardStatus, closeCard, makeCard, sessionEnded, sweep } from '../src/cards.js';
import { act, feedView, self } from '../src/feed.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-cards-'));
SETTINGS.file = path.join(tmp, 'settings.json');
fs.writeFileSync(SETTINGS.file, JSON.stringify({ person: 'Alex', people: { Sam: ['keeper-pc', 'pc-b'] } }));

function room() {
  let now = 1_000_000;
  const b = new Board(null, () => now);
  const s = b.touch('asker', '', 'claude').session;
  return { b, s, tick: (ms: number) => { now += ms; } };
}

test('agent headlines update the feed while original question and every change stay in history',async()=>{
 const{b,s}=room();const made=JSON.parse(await askTool(b,s,{question:'Approve sending 5 adviser emails?'}));const card=b.cards[0];
 assert.equal(feedView(b).mine[0].title,card.question);
 await askTool(b,s,{op:'say',id:made.id,text:'The drafts are now ready. Open the links below.',headline:'Five adviser drafts ready — review and approve sending'});
 assert.equal(feedView(b).mine[0].title,'Five adviser drafts ready — review and approve sending');assert.equal(card.question,'Approve sending 5 adviser emails?');
 assert.ok(feedView(b).mine[0].steps.some(t=>t.text.includes(card.question)));
 await askTool(b,s,{op:'say',id:made.id,text:'Sent with your approval. No action needed.'});
 assert.equal(feedView(b).mine[0].title,'Sent with your approval.');assert.equal(card.thread[0].headline,'Five adviser drafts ready — review and approve sending');assert.equal(card.thread[1].headline,'Sent with your approval.');
 const before=JSON.stringify(card);await assert.rejects(askTool(b,s,{op:'say',id:made.id,text:'Invalid',headline:''}),/headline/);assert.equal(JSON.stringify(card),before);
 agentSays(b,card,'A'.repeat(110));assert.equal(Array.from(card.headline!).length,80);assert.ok(card.headline!.endsWith('…'));
});

test('remote follow-up forwards headline without changing card ownership checks',async()=>{
 const{b,s}=room();let sent:any;b.remote=async(input:any)=>{sent=input;return '{}';};
 await askTool(b,s,{op:'say',pc:'other',id:7,text:'Ready to open.',headline:'Paper ready — tap to open'});
 assert.deepEqual(JSON.parse(sent.text),{say:'Ready to open.',headline:'Paper ready — tap to open'});
});

test('say appends validated attachments atomically and records their thread provenance',async()=>{
 const{b,s}=room();const made=JSON.parse(await askTool(b,s,{question:'Choose an image?'}));const card=b.cards[0];
 const file=path.join(tmp,'follow-up.png');fs.writeFileSync(file,'image fixture');
 await askTool(b,s,{op:'say',id:made.id,text:'Compact comparison ready.',files:[file]});
 assert.equal(card.files.length,1);assert.equal(card.files[0].path,file);assert.deepEqual(card.thread[0].files,card.files);
 const item=feedView(b).mine[0];assert.deepEqual(item.files,['follow-up.png']);assert.ok(item.steps.some(t=>t.text.includes('Attached: follow-up.png')));
 const before=JSON.stringify(card);
 await assert.rejects(askTool(b,s,{op:'say',id:made.id,text:'Missing',files:[path.join(tmp,'missing.png')]}),/not a file/);
 await assert.rejects(askTool(b,s,{op:'say',id:made.id,text:'Too many',files:[file,file,file,file,file]}),/at most 4/);assert.equal(JSON.stringify(card),before);
 const large=path.join(tmp,'oversize.bin');const fd=fs.openSync(large,'w');fs.ftruncateSync(fd,25*1024*1024+1);fs.closeSync(fd);
 await assert.rejects(askTool(b,s,{op:'say',id:made.id,text:'Too big',files:[large]}),/over 25 MB/);assert.equal(JSON.stringify(card),before);
 for(let i=0;i<3;i++)await askTool(b,s,{op:'say',id:made.id,text:'More comparisons',files:[file,file,file,file]});
 await askTool(b,s,{op:'say',id:made.id,text:'Last comparisons',files:[file,file,file]});assert.equal(card.files.length,16);assert.equal(card.files[0].path,file);
 const full=JSON.stringify(card);await assert.rejects(askTool(b,s,{op:'say',id:made.id,text:'Overflow',files:[file]}),/16 total/);assert.equal(JSON.stringify(card),full);
 let sent:any;b.remote=async(input:any)=>{sent=JSON.parse(input.text);return '{}';};const copies:any[]=[];
 await askTool(b,s,{op:'say',pc:'other',id:7,text:'Remote comparison',files:[file]},async(copy,pc)=>{copies.push({copy,pc,exists:fs.existsSync(copy)});});
 assert.equal(copies.length,1);assert.equal(copies[0].exists,true);assert.equal(sent.files[0].name,'follow-up.png');assert.match(sent.files[0].sent,SENT_FILE);
});

test('native cards retain choices, typed answers and follow-ups without the retired web routes', async () => {
  const { b, s, tick } = room();
  const made = JSON.parse(await askTool(b, s, { question: 'Ship today or Monday?', choices: ['Today', 'Monday'] }));
  assert.equal(made.popup_shown, false, 'a saved card never claims a missing app displayed it');
  assert.match(made.note, /app is not running/);
  const card = b.cards[0]!;
  assert.equal(feedView(b).mine[0]!.thread, 'card:' + self() + ':' + card.id);
  await answerCard(b, card, '1', 'after the copy lands');
  assert.equal(card.thread[0]!.choice, 'Monday');
  assert.equal(b.take(s)[0]!.person, true);
  assert.equal(feedView(b).mine.length, 0);
  await assert.rejects(answerCard(b, card, '1', ''), /already your answer/);
  tick(1);
  assert.deepEqual(agentSays(b, card, 'The copy is ready.'), { ok: true, id: card.id, state: 'updated' });
  assert.equal(feedView(b).mine.length, 1, 'a new agent reply returns to the native feed');
  await answerCard(b, card, '', 'Great, use Monday.');
  assert.equal(feedView(b).mine.length, 0);
  assert.equal((cardStatus(card) as { said: unknown[] }).said.length, 2);
});

test('answered follow-ups expire from latest activity and stale approvals cannot be submitted', async () => {
  const { b, s, tick } = room();
  const c = makeCard(b, { agent: s.name, sessionId: s.id }, { question: 'Proceed?', choices: ['Approve'] });
  await answerCard(b, c, '0', '');
  tick(EXPIRE_MS - 1);
  agentSays(b, c, 'Working now.');
  tick(2);
  sweep(b);
  assert.equal(c.closed, undefined);
  tick(EXPIRE_MS);
  await assert.rejects(answerCard(b, c, '0', 'Approve again'), /closed/);
  assert.equal(c.closed, 'expired');
  assert.equal(feedView(b).mine.length, 0);
  assert.equal(c.thread.length, 2);
  assert.throws(() => agentSays(b, c, 'Revive'), /expired/);
});

test('person can permanently close a prompt without answering or losing its history', async () => {
  const { b, s } = room();
  const c = makeCard(b, { agent: s.name, sessionId: s.id }, { question: 'Proceed?', choices: ['Approve'] });
  const thread = `card:${self()}:${c.id}`;
  assert.ok(feedView(b).mine[0].choices.some(c => c.id === 'close'));
  assert.equal(await act(b, thread, 'close'), 'closed');
  assert.equal(c.closed, 'dismissed');
  assert.equal(c.thread.length, 0);
  assert.equal(feedView(b).mine.length, 0);
  assert.ok(feedView(b).history.some(h => h.text.includes('(dismissed)')));
  assert.throws(() => agentSays(b, c, 'Revive'), /dismissed/);
});

test('withdrawal, asker departure and expiration close cards without changing answered history', async () => {
  const { b, s, tick } = room();
  b.onEnd = id => sessionEnded(b, id);
  const open = makeCard(b, { agent: s.name, sessionId: s.id }, { question: 'Still needed?' });
  const answered = makeCard(b, { agent: s.name, sessionId: s.id }, { question: 'Keep history?' });
  await answerCard(b, answered, '', 'Yes');
  b.end(s.id);
  assert.equal(open.closed, 'withdrawn');
  assert.equal(answered.closed, undefined);
  await assert.rejects(answerCard(b, open, '', 'late'), /closed/);
  assert.throws(() => agentSays(b, open, 'late'), /withdrawn/);
  const expires = makeCard(b, { agent: 'Remote', pc: 'other' }, { question: 'Expire?' });
  tick(EXPIRE_MS + 1); sweep(b);
  assert.equal(expires.closed, 'expired');
});

test('remote answers keep card authentication and thread ownership', async () => {
  const { b, s } = room();
  const sent: Record<string, unknown>[] = [];
  b.remote = async r => { sent.push(r); return JSON.stringify({ ok: true }); };
  const from = { pc: 'other.tail1234.ts.net', agent: 'Echo' };
  const c = makeCard(b, from, { question: 'Blue or red?', choices: ['Blue', 'Red'], key: '0123456789abcdef' });
  await answerCard(b, c, '1', 'Crop it tighter');
  assert.equal(sent[0]!.request_id, 'card-0123456789abcdef-1');
  assert.match(String(sent[0]!.text), /chose "Red"/);
  assert.equal((await handleBridge(b, { op: 'card', id: c.id, from }) as { state: string }).state, 'answered');
  assert.equal((await handleBridge(b, { op: 'card', id: c.id, from: { pc: 'wrong', agent: 'Echo' } }) as { state: string }).state, 'unknown');
    const unchanged=JSON.stringify(c);
    assert.match(JSON.stringify(await handleBridge(b,{op:'card',id:c.id,from,text:JSON.stringify({say:'Bad file',files:[{name:'secret',sent:'../../secret'}]})})),/Invalid follow-up attachment/);
    assert.equal(JSON.stringify(c),unchanged);
  b.asked.push({ key: '0123456789abcdef', pc: from.pc, id: 5, sessionId: s.id });
  const message = { op: 'send', from, to: s.name, text: 'A real card answer', request_id: 'card-0123456789abcdef-1' };
  await handleBridge(b, message);
  assert.equal(b.messages.at(-1)!.person, true);
  await handleBridge(b, { ...message, request_id: 'fake' });
  assert.equal(b.messages.at(-1)!.person, undefined);
});

test('named people route to a reachable native app and other-PC asks require explicit intent', async () => {
  const { b, s } = room();
  const sent: Record<string, unknown>[] = [];
  b.remote = async r => { sent.push(r); return JSON.stringify(r.op === 'agent_card' ? { ok: true, app_running: r.pc === 'pc-b' } : { ok: true, id: 41 }); };
  await assert.rejects(askTool(b, s, { pc: 'pc-b', question: 'Choose?' }), /explicit=true/);
  const reply = JSON.parse(await askTool(b, s, { to: 'Sam', question: 'Choose?', explicit: true }));
  assert.equal(reply.sent_to, 'pc-b');
  assert.equal(sent.at(-1)!.op, 'agent_ask');
  assert.equal(b.asked[0]!.id, 41);
  await assert.rejects(askTool(b, s, { to: 'Unknown', question: 'Choose?', explicit: true }), /nobody named/);
  b.remote = async () => JSON.stringify({ ok: true, app_running: false });
  await assert.rejects(askTool(b, s, { to: 'Sam', question: 'Choose?', explicit: true }), /running Kokuban app/);
});

test('attachments use direct Taildrop and retain their private generated names', async () => {
  const { b, s } = room();
  const picture = path.join(tmp, 'mock up.png'); fs.writeFileSync(picture, 'PNGDATA');
  const local = JSON.parse(await askTool(b, s, { question: 'Look right?', files: [picture] }));
  assert.deepEqual(b.cards.find(c => c.id === local.id)!.files, [{ name: 'mock up.png', path: picture }]);
  const sent: Record<string, unknown>[] = [];
  b.remote = async r => { sent.push(r); return JSON.stringify({ ok: true, id: 2 }); };
  let copy = '';
  await askTool(b, s, { pc: 'pc-b', explicit: true, question: 'And this?', files: [picture] }, async (file, pc) => {
    copy = file; assert.equal(pc, 'pc-b'); assert.match(path.basename(file), SENT_FILE); assert.equal(fs.readFileSync(file, 'utf8'), 'PNGDATA');
  });
  assert.equal(fs.existsSync(copy), false);
  assert.deepEqual(JSON.parse(String(sent[0]!.text)).files, [{ name: 'mock up.png', sent: path.basename(copy) }]);
  await assert.rejects(askTool(b, s, { question: 'Missing?', files: [path.join(tmp, 'absent.png')] }), /not a file/);
});

test('card validation, language inference and sender limits remain part of the model', () => {
  const { b } = room(); const from = { agent: 'Echo', pc: 'remote' };
  assert.throws(() => makeCard(b, from, { question: '' }), /question is empty/);
  assert.throws(() => makeCard(b, from, { question: 'x'.repeat(301) }), /300/);
  assert.throws(() => makeCard(b, from, { question: 'Choose', choices: ['a', 'b', 'c', 'd', 'e'] }), /four|4/);
  for (let i = 0; i < 5; i++) makeCard(b, from, { question: 'Question ' + i });
  assert.throws(() => makeCard(b, from, { question: 'Flood' }), /unanswered/);
  closeCard(b, b.cards[0]!, 'withdrawn');
  assert.equal(makeCard(b, from, { question: 'English', lang: 'ja' }).lang, 'ja');
});
