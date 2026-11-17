import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import { Script } from 'node:vm';
import { Board, QUIET_MS } from '../src/board.js';
import { makeCard, waiting } from '../src/cards.js';
import { DEFAULT_NOTIFICATIONS, PhoneConfig } from '../src/phone/settings.js';
import { PhoneNotifications, FOREGROUND_MS, deepLink, notificationText, pushSubscription } from '../src/phone/notifications.js';
import { PhoneUsageCache } from '../src/phone/usage.js';
import { pushWorker } from '../src/phone/push-client.js';
import { client } from '../src/phone/shell.js';

function fixture(at = new Date(2026, 9, 20, 7, 0).getTime(), windowMs = 20000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-push-')); let now = at;
  const config = new PhoneConfig(path.join(root, 'settings.json'));
  const e = createECDH('prime256v1'); e.generateKeys();
  config.edit(s => { s.enabled = true; s.origin = 'https://pc.test'; s.owner = 'owner'; s.devices = ['one', 'two'].map(id => ({ id, name: id, node: id, login: 'owner', hash: id, created: now,
    push: { endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, keys: { p256dh: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }, notifications: { ...DEFAULT_NOTIFICATIONS } })); });
  const board = new Board(null, () => now); const sent: Array<{ endpoint: string; payload: any }> = [];
  const deps = { file: path.join(root, 'notifications.json'), clock: () => now, windowMs, credential: async () => ({ publicKey: 'public', privateKey: 'private' }),
    sender: async (s: any, payload: string) => { sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload) }); return { statusCode: 201 }; } };
  const n = new PhoneNotifications(board, config, deps);
  return { root, config, board, n, sent, deps, advance: (ms: number) => { now += ms; }, setTime: (v: number) => { now = v; }, now: () => now,
    close: () => { n.close(); config.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
test('push coalesces per device/category, honors toggles and pending cards notify at most once', async () => {
  const f = fixture(); try {
    await f.n.tick(); f.config.edit(s => { s.devices[1].notifications!.blocked = false; });
    makeCard(f.board, { agent: 'Lotus' }, { question: 'Review the first change?' });
    makeCard(f.board, { agent: 'Beck' }, { question: 'Review the second change?' });
    await f.n.tick(); f.advance(19999); await f.n.tick(); assert.equal(f.sent.length, 0);
    f.advance(1); await f.n.tick(); assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].payload.title, /2/); assert.match(f.sent[0].payload.body, /Lotus/);
    assert.ok(f.sent[0].payload.url.startsWith('/phone/?thread=card'));
    f.advance(60000); await f.n.tick(); assert.equal(f.sent.length, 1);
    const state = fs.readFileSync(f.deps.file, 'utf8'); assert.ok(!state.includes('p256dh')); assert.ok(!state.includes('private'));
  } finally { f.close(); }
});
test('fresh foreground presence suppresses delivery while stale/hidden presence does not', async () => {
  const f = fixture(); try {
    await f.n.tick(); const c = makeCard(f.board, { agent: 'Lotus' }, { question: 'Visible question?' }); await f.n.tick();
    const target = `card:${os.hostname().toLowerCase()}:${c.id}`;
    f.n.presence('one', true, [target]); f.n.presence('two', false, [target]);
    f.advance(20000); f.n.presence('one', true, [target]); await f.n.tick(); assert.equal(f.sent.length, 1); assert.ok(f.sent[0].endpoint.endsWith('/two'));
    f.n.presence('one', true, ['conversation:test']); f.advance(45001);
    f.n.observe({ key: 'new-result', category: 'finished', target: 'conversation:test', at: f.now(), title: 'Lotus finished', summary: 'Phase 3 passed' });
    f.advance(20000); await f.n.tick(); assert.equal(f.sent.length, 3);
  } finally { f.close(); }
});

test('foreground silences new and unrelated topics without marking cards seen; background resumes immediately', async () => {
  const f=fixture(undefined,0);try{
    await f.n.tick(); f.n.presence('one',true,['conversation:other']);f.advance(1);
    const card=makeCard(f.board,{agent:'Beck'},{question:'New foreground question'});await f.n.tick();
    assert.equal(f.sent.length,1);assert.ok(f.sent[0].endpoint.endsWith('/two'));assert.equal(waiting(card),true);assert.equal(card.thread.length,0);assert.ok(f.board.cards.includes(card));
    f.n.presence('one',false,[]);f.advance(1);makeCard(f.board,{agent:'Beck'},{question:'Background question'});await f.n.tick();assert.equal(f.sent.length,3);
    f.n.presence('one',true,[]);f.advance(FOREGROUND_MS+1);makeCard(f.board,{agent:'Beck'},{question:'Stale client question'});await f.n.tick();assert.equal(f.sent.length,5);
  }finally{f.close();}
});

test('a late visible heartbeat cannot overwrite hidden state, and another foreground tab remains active', async () => {
  const f=fixture(undefined,0);try{
    await f.n.tick();f.n.presence('one',true,[],'tab-a',1);f.n.presence('one',false,[],'tab-b',1);
    f.n.observe({key:'first',category:'finished',target:'board',at:f.now(),title:'Ready',summary:'In-app update'});await f.n.tick();assert.equal(f.sent.length,1);
    f.n.presence('one',false,[],'tab-a',3);f.n.presence('one',true,[],'tab-a',2);
    f.n.observe({key:'second',category:'finished',target:'board',at:f.now(),title:'Ready again',summary:'Background update'});await f.n.tick();assert.equal(f.sent.length,3);
  }finally{f.close();}
});

test('client sends sequenced keepalive presence and existing badges surface foreground updates', async () => {
  const {createContext}=await import('node:vm');const calls:any[]=[];const nodes=new Map<string,any>();
  const source=(name:string)=>client.split('\n').find(s=>s.startsWith('function '+name+'(')||s.startsWith('async function '+name+'('))!;
  const context:any=createContext({paired:true,document:{hidden:false},view:'cards',wantsChat:()=>false,visibleTopics:new Set(['card:pc:1']),presenceClient:'client-one',presenceSequence:0,
    api:async(...args:any[])=>{calls.push(args);},sessions:[],roster:[{phase:'working'}],feed:{mine:[{kind:'decide'},{kind:'decide'}]},$: (id:string)=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);},
  });new Script(source('presence')+'\n'+source('renderOverview')).runInContext(context);
  await new Script('presence()').runInContext(context);await new Script('presence(false)').runInContext(context);
  assert.equal(calls[0][1].visible,true);assert.equal(calls[1][1].visible,false);assert.equal(calls[0][1].sequence,1);assert.equal(calls[1][1].sequence,2);assert.equal(calls[0][4],true);assert.equal(calls[1][1].targets.length,0);
  new Script('renderOverview()').runInContext(context);assert.equal(nodes.get('badge').hidden,false);assert.equal(nodes.get('badge').textContent,2);
  assert.equal(nodes.get('sessionCount').textContent,1);assert.equal(nodes.get('workingCount').textContent,1);
  assert.ok(client.includes('setInterval(presence,5000)'));assert.ok(client.includes("presence(false);discardRecording()"));
});
test('pending queue survives restart, revoked devices are skipped and expired subscriptions are pruned', async () => {
  const f = fixture(); let restarted: PhoneNotifications | undefined; try {
    await f.n.tick(); f.n.observe({ key: 'result', category: 'finished', target: 'conversation:123', at: f.now(), title: 'Lotus finished', summary: 'Result ready' }); f.n.close();
    f.config.edit(s => { s.devices[1].revoked = f.now(); });
    restarted = new PhoneNotifications(f.board, f.config, { ...f.deps, sender: async () => { throw { statusCode: 410, body: 'private provider detail' }; } });
    f.advance(20000); await restarted.tick();
    assert.equal(f.config.read().devices[0].push, undefined); assert.ok(f.config.read().devices[1].push);
    assert.equal(restarted.receipts().at(-1)?.status, 'expired'); assert.ok(!fs.readFileSync(f.deps.file, 'utf8').includes('private provider detail'));
  } finally { restarted?.close(); f.close(); }
});
test('daily digest respects each device local schedule and does not repeat after restart', async () => {
  const f = fixture(); let restarted: PhoneNotifications | undefined; try {
    await f.n.tick(); f.config.edit(s => { s.devices[1].notifications!.digestTime = '09:00'; });
    f.setTime(new Date(2026, 9, 20, 8, 0).getTime()); await f.n.tick(); f.advance(20000); await f.n.tick();
    assert.equal(f.sent.length, 1); assert.ok(f.sent[0].endpoint.endsWith('/one')); assert.match(f.sent[0].payload.body, /open questions/);
    restarted = new PhoneNotifications(f.board, f.config, f.deps); await restarted.tick(); assert.equal(f.sent.length, 1);
    f.setTime(new Date(2026, 9, 20, 9, 0).getTime()); await restarted.tick(); f.advance(20000); await restarted.tick();
    assert.equal(f.sent.length, 2); assert.ok(f.sent[1].endpoint.endsWith('/two'));
  } finally { restarted?.close(); f.close(); }
});
test('new blocked/stalled/continuation-limit states and explicit delayed tests produce actionable events', async () => {
  const f = fixture(); try {
    await f.n.tick(); const s = f.board.touch('session', '', 'claude').session; s.name = 'Lotus'; s.work = 'blocked'; s.next = 'Please review the build';
    await f.n.tick(); f.advance(20000); await f.n.tick(); assert.ok(f.sent.some(x => x.payload.title.includes('blocked')));
    s.work = 'active'; s.seen = f.now() - QUIET_MS - 1; s.continues = 30;
    await f.n.tick(); f.advance(20000); await f.n.tick(); assert.ok(f.sent.some(x => x.payload.category === 'stuck'));
    const count = f.sent.length; const d = f.config.read().devices[0]; f.n.presence(d.id, true, ['board']); await f.n.test(d, 20);
    f.advance(19999); await f.n.tick(); assert.equal(f.sent.length, count); f.advance(1); await f.n.tick(); assert.equal(f.sent.length, count + 1);
  } finally { f.close(); }
});
test('a managed session past its turn does not raise "may be stuck"; only a running turn does', async () => {
  const f = fixture(); try {
    await f.n.tick();
    const s = f.board.touch('session', '', 'claude').session; s.name = 'Teal'; s.managed = 'conv1';
    s.work = 'active'; s.seen = f.now() - QUIET_MS - 1;
    // Turn finished: the conversation is idle even though the stale board record still reads active.
    f.n.conversation({ id: 'e1', sessionId: 'conv1', kind: 'turn_completed', ts: f.now(), data: {} } as any, { id: 'conv1', name: 'Teal', phase: 'idle', approvals: [] } as any);
    await f.n.tick(); f.advance(20000); await f.n.tick();
    assert.ok(!f.sent.some(x => x.payload.category === 'stuck'), 'an idle managed turn must not alert as stuck');
    // A genuinely running turn with no update for the quiet window still alerts.
    f.n.conversation({ id: 'e2', sessionId: 'conv1', kind: 'assistant_delta', ts: f.now(), text: 'still here' } as any, { id: 'conv1', name: 'Teal', phase: 'working', approvals: [] } as any);
    s.seen = f.now() - QUIET_MS - 1;
    await f.n.tick(); f.advance(20000); await f.n.tick();
    assert.ok(f.sent.some(x => x.payload.category === 'stuck'), 'a running turn gone quiet must still alert');
  } finally { f.close(); }
});
test('an external session past its turn does not raise "may be stuck"; only a working turn does', async () => {
  const f = fixture(); try {
    await f.n.tick();
    const s = f.board.touch('ext', '', 'claude').session; s.name = 'Bay';
    // Turn finished: the host set the session idle, but the board record still reads active.
    s.work = 'active'; s.state = 'idle'; s.seen = f.now() - QUIET_MS - 1;
    await f.n.tick(); f.advance(20000); await f.n.tick();
    assert.ok(!f.sent.some(x => x.payload.category === 'stuck'), 'a done/idle external session must not alert as stuck');
    // A turn genuinely in progress and gone quiet still alerts.
    s.state = 'working'; s.seen = f.now() - QUIET_MS - 1;
    await f.n.tick(); f.advance(20000); await f.n.tick();
    assert.ok(f.sent.some(x => x.payload.category === 'stuck'), 'a working external turn gone quiet must still alert');
  } finally { f.close(); }
});
test('push text, endpoints, worker deep links and cached usage have bounded safe contracts', async () => {
  assert.equal(notificationText('password: hunter2'), 'Open Kokuban for details'); assert.ok(!notificationText('open https://host/?token=secret').includes('secret'));
  assert.equal(pushSubscription({ endpoint: 'https://127.0.0.1/private', keys: {} }), false);
  assert.equal(deepLink('conversation:abc'), '/phone/?conversation=abc'); new Script(pushWorker);
  let reads = 0, now = 1;
  const usage = new PhoneUsageCache(async () => { reads++; return { rate_limits_available: true, rate_limits: { five_hour: { utilization: 5, resets_at: 'later' }, seven_day: { utilization: 8 } } }; }, () => now);
  const [a, b] = await Promise.all([usage.get(), usage.get()]); assert.equal(reads, 1); assert.equal(a.fiveHour?.percent, 5); assert.equal(b.weekly?.percent, 8);
  now += 300001; await usage.get(); assert.equal(reads, 2);
});
test('phone settings cache avoids repeat reads and invalidates on atomic external replacement', async () => {
  const f = fixture(); try {
    assert.equal(f.config.read().owner, 'owner');
    const replacement = JSON.parse(fs.readFileSync(f.config.file, 'utf8')); replacement.phone.owner = 'new-owner';
    const temp = f.config.file + '.external'; fs.writeFileSync(temp, JSON.stringify(replacement)); fs.renameSync(temp, f.config.file);
    for (let i = 0; i < 50 && f.config.read().owner !== 'new-owner'; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(f.config.read().owner, 'new-owner');
    fs.writeFileSync(f.config.file, '{broken'); assert.throws(() => f.config.edit(s => { s.enabled = false; }), /preserved/); assert.equal(fs.readFileSync(f.config.file, 'utf8'), '{broken');
  } finally { f.close(); }
});
test('conversation notices carry actionable result summaries and cancelled approvals do not push', async () => {
  const f = fixture(); try {
    await f.n.tick();
    const s: any = { id: 'managed', name: 'Lotus', phase: 'working', approvals: [] };
    const notice = (kind: string, text?: string, data?: unknown) => f.n.conversation({ id: `${kind}-${f.now()}`, sessionId: s.id, kind, ts: f.now(), text, data }, s);
    notice('message_started'); notice('assistant_delta', 'Phase 3 landed and all tests passed.'); notice('turn_completed', undefined, { status: 'complete' });
    f.advance(20000); await f.n.tick(); assert.equal(f.sent.length, 2); assert.match(f.sent[0].payload.body, /Phase 3 landed/);
    s.phase = 'approval'; s.approvals = [{ id: 'approve-1', state: 'pending' }]; notice('approval_requested', undefined, { id: 'approve-1' });
    s.phase = 'working'; s.approvals = []; notice('approve'); f.advance(20000); await f.n.tick(); assert.equal(f.sent.length, 2);
    s.phase = 'error'; s.problem = 'The agent connection failed'; notice('error'); f.advance(20000); await f.n.tick(); assert.equal(f.sent.length, 4);
  } finally { f.close(); }
});
test('transient push failure retries the same persisted notification identity and topic', async () => {
  const f = fixture(); let retrying: PhoneNotifications | undefined; try {
    f.config.edit(s => { s.devices[1].revoked = 1; });
    let attempts = 0; const ids: string[] = [], tags: string[] = [];
    retrying = new PhoneNotifications(f.board, f.config, { ...f.deps, sender: async (_s, payload) => { const p = JSON.parse(payload); ids.push(p.id); tags.push(p.tag); if (++attempts === 1) throw { statusCode: 503 }; return { statusCode: 201 }; } });
    await retrying.tick(); retrying.observe({ key: 'retry-result', category: 'finished', target: 'board', at: f.now(), title: 'Lotus finished', summary: 'Build ready' });
    f.advance(20000); await retrying.tick(); assert.equal(attempts, 1); assert.equal(retrying.receipts().at(-1)?.status, 'failed');
    f.advance(30000); await retrying.tick(); assert.equal(attempts, 2); assert.equal(ids[0], ids[1]); assert.equal(tags[0], tags[1]); assert.equal(retrying.receipts().at(-1)?.status, 'accepted');
  } finally { retrying?.close(); f.close(); }
});
