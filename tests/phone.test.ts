import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID, randomBytes, createECDH } from 'node:crypto';
import { Script } from 'node:vm';
import { Board } from '../src/board.js';
import { createServer, ownCard } from '../src/daemon.js';
import { PhoneConfig, repairPhoneServe, token } from '../src/phone/settings.js';
import { client } from '../src/phone/shell.js';
import { answerCard, makeCard } from '../src/cards.js';
import { ConversationService } from '../src/conversations/service.js';
import { MAX_UPLOAD } from '../src/conversations/attachments.js';
import { self } from '../src/feed.js';
import { PhoneUsageCache } from '../src/phone/usage.js';
import { PhoneVoice } from '../src/voice/service.js';
const subscription = () => { const e = createECDH('prime256v1'); e.generateKeys(); return { endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }; };

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-phone-'));
  const config = new PhoneConfig(path.join(root, 'settings.json')); const secret = token();
  fs.writeFileSync(config.file, JSON.stringify({ preserved: { setting: 1 } }));
  config.edit(s => { s.enabled = true; s.owner = 'owner@test'; s.origin = 'https://pc.test'; s.secret = secret; s.adminSecret = token(); });
  const board = new Board(path.join(root, 'board.json')); board.hasRoom = () => true;
  board.onOwnCard = (c, choice) => ownCard(board, c, choice);
  const sends: { body: string; files: unknown }[] = [];
  board.conversations = new ConversationService(board, true, path.join(root, 'conversations.sqlite'), {
    catalog: () => [{ id: 'repo', name: 'Repo', path: root }],
    factory: (s, sink) => ({ start: async () => s.id, send: async (body, files) => { sends.push({ body, files }); sink.turn(randomUUID()); if (body.includes('PHONE_APPROVAL')) void sink.approval('request', 'Tool', 'Review test tool', {}).then(() => sink.complete('complete')); else setTimeout(() => sink.complete('complete'), 10); return undefined; }, interrupt: async () => sink.complete('interrupted'), close: async () => {} }),
  });
  await board.conversations.ready;
  let actualLogin = 'owner@test';
  const server = createServer(board, {}, {}, {}, { config, voice: new PhoneVoice({ home: path.join(root, 'missing-voice') }), lookup: async () => ({ login: actualLogin, node: 'iphone.test' }),
    push: { file: path.join(root, 'push.json'), credential: async () => ({ publicKey: 'test', privateKey: 'test' }), sender: async () => ({ statusCode: 201 }) },
    usage: new PhoneUsageCache(async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 7, resets_at: 'later' }, seven_day: { utilization: 11 } } })) });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { 'tailscale-user-login': 'owner@test', 'x-forwarded-for': '100.64.0.13', origin: 'https://pc.test', 'x-kokuban-phone': '1', 'content-type': 'application/json' };
  let cookies = '';
  const call = (route: string, data?: unknown, extra: Record<string, string> = {}) => fetch(`${base}/phone/_gateway/${secret}${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { ...headers, cookie: cookies, ...extra }, ...(data === undefined ? {} : { body: Buffer.isBuffer(data) ? new Uint8Array(data).buffer : JSON.stringify(data) }), redirect: 'manual' });
  const pair = async (allow = true) => {
    const id = randomUUID(), admin = { 'x-kokuban-admin': config.read().adminSecret! };
    const begin = await fetch(base + '/phone-admin', { method: 'POST', headers: admin, body: JSON.stringify({ op: 'pair-create', id }) });
    assert.equal(begin.status, 200); const created = await begin.json() as any;
    const nonce = new URLSearchParams(new URL(created.url).hash.slice(1)).get('pair');
    if (!allow) { await fetch(base + '/phone-admin', { method: 'POST', headers: admin, body: JSON.stringify({ op: 'pair-cancel', id }) }); assert.equal((await call('/pairing/claim', { nonce, name: 'Test iPhone' })).status, 410); return; }
    const claim = await call('/pairing/claim', { nonce, name: 'Test iPhone' }); assert.equal(claim.status, 200);
    const handoff = (await claim.json() as any).handoff; cookies = claim.headers.getSetCookie()[0].split(';')[0];
    assert.equal((await (await call('/pairing/state')).json() as any).setup.stage, 'claimed');
    const state = await call('/pairing/redeem', { handoff, standalone: true }); assert.equal(state.status, 200);
    assert.match(state.headers.getSetCookie()[0], /HttpOnly; Secure; SameSite=Strict/);
    cookies = state.headers.getSetCookie().find(x => x.startsWith('__Secure-kokuban_phone='))!.split(';')[0];
    assert.equal(fs.readFileSync(config.file, 'utf8').includes(cookies.split('=')[1]), false);
    assert.equal((await state.json() as any).setup.stage, 'appOpened');
  };
  const until = async (id: string, phase: string) => {
    for (let i = 0; i < 100; i++) { const r = await (await call('/conversations', { op: 'get', sessionId: id })).json() as any; if (r.session.phase === phase) return r.session; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('phase timeout');
  };
  return { root, config, board, base, headers, call, pair, sends, until, setLogin: (v: string) => { actualLogin = v; }, setCookies: (v: string) => { cookies = v; },
    close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await board.conversations!.close(); board.flush(); fs.rmSync(root, { recursive: true, force: true }); } };
}
test('Scout static assets keep tailnet owner authentication and image MIME',async()=>{
 const f=await fixture();try{for(const [route,type]of [['/chief-avatar.svg','image/svg+xml'],['/chief-avatar.png','image/png']]){const r=await f.call(route);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),type);assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.ok((await r.arrayBuffer()).byteLength>100);assert.equal((await f.call(route,undefined,{'tailscale-user-login':''})).status,403);}}finally{await f.close();}
});
test('phone /feed carries a blocked session in mine', async () => {
  const f = await fixture();
  try {
    await f.pair();
    const s = f.board.touch(randomUUID(), f.root, 'claude').session; s.name = 'Rosa'; f.board.setWork(s, 'blocked', 'Needs a key');
    const feed = await (await f.call('/feed')).json() as any;
    assert.deepEqual(feed.mine.filter((i: any) => i.thread.startsWith('session:')).map((i: any) => [i.thread, i.kind, i.body]), [[`session:${s.id}:blocked`, 'blocked', 'Needs a key']]);
  } finally { await f.close(); }
});
test('phone refuses direct loopback spoofing, missing identity, wrong whois, missing token and CSRF', async () => {
  const f = await fixture(); try {
    assert.equal((await fetch(f.base + '/phone/feed', { headers: f.headers })).status, 403);
    assert.equal((await f.call('/pair', undefined, { 'tailscale-user-login': '' })).status, 403);
    f.setLogin('someone@test'); assert.equal((await f.call('/pair')).status, 403); f.setLogin('owner@test');
    assert.equal((await f.call('/feed')).status, 401);
    assert.equal((await f.call('/pair/start', { name: 'Legacy bypass' })).status, 409);
    assert.equal((await fetch(f.base + '/phone-admin', { method: 'POST', body: JSON.stringify({ op: 'pair-create', id: randomUUID() }) })).status, 403);
    await f.pair(); assert.equal((await f.call('/feed')).status, 200);
    assert.equal((await f.call('/feed', undefined, { 'tailscale-user-login': 'other@test' })).status, 403);
    assert.equal((await f.call('/conversations', { op: 'list' }, { 'x-kokuban-phone': '' })).status, 403);
    assert.equal((await f.call('/conversations', { op: 'list' }, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await f.call('/conversations', { op: 'list' }, { origin: '' })).status, 403);
    f.setCookies('__Secure-kokuban_phone=' + token()); assert.equal((await f.call('/feed')).status, 401);
  } finally { await f.close(); }
});
test('pairing refusal, hashed storage, settings preservation, device listing and revocation', async () => {
  const f = await fixture(); try {
    await f.pair(false); assert.equal((await f.call('/feed')).status, 401);
    await f.pair(); const p = f.config.read(); assert.equal(p.devices.length, 1);
    const admin = { 'x-kokuban-admin': f.config.read().adminSecret! };
    assert.equal((await fetch(f.base + '/phone-admin', { method: 'POST', body: JSON.stringify({ op: 'list' }) })).status, 403);
    const listing = await (await fetch(f.base + '/phone-admin', { method: 'POST', headers: admin, body: JSON.stringify({ op: 'list' }) })).json() as any;
    assert.equal(listing.devices[0].name, 'Test iPhone'); assert.equal('hash' in listing.devices[0], false);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.config.file, 'utf8')).preserved, { setting: 1 });
    const r = await fetch(f.base + '/phone-admin', { method: 'POST', headers: admin, body: JSON.stringify({ op: 'revoke', id: p.devices[0].id }) }); assert.equal(r.status, 200);
    assert.equal((await f.call('/feed')).status, 401);
  } finally { await f.close(); }
});
test('phone APIs reuse feed/card/conversation logic and retain bounded uploaded bytes and metadata', async () => {
  const f = await fixture(); try {
    await f.pair();
    const card = makeCard(f.board, { agent: 'Test' }, { question: 'Choose?', choices: ['One', 'Two'] });
    const paper = path.join(f.root, 'paper.docx'); fs.writeFileSync(paper, 'kept document');
    card.files.push({ name: 'strategy paper.docx', path: paper });
    const cardFile = await f.call(`/card-file?thread=${encodeURIComponent(`card:${self()}:${card.id}`)}&n=0`);
    assert.equal(cardFile.status, 200); assert.equal(await cardFile.text(), 'kept document');
    assert.match(cardFile.headers.get('content-disposition')!, /attachment; filename\*=UTF-8''strategy%20paper.docx/);
    for (const query of [`thread=card:other-pc:${card.id}&n=0`, `thread=card:${self()}:${card.id}&n=-1`, `thread=card:${self()}:${card.id}&n=1`, `thread=card:${self()}:${card.id}`, 'thread=../../secret&n=0']) assert.equal((await f.call('/card-file?' + query)).status, 404);
    for(const [bytes,type]of [[Buffer.from([137,80,78,71,13,10,26,10]),'image/png'],[Buffer.from('<svg><script>alert(1)</script></svg>'),'image/svg+xml']]as const){
      fs.writeFileSync(paper,bytes);const image=await f.call(`/card-file?thread=${encodeURIComponent(`card:${self()}:${card.id}`)}&n=0`);assert.equal(image.headers.get('content-type'),type);assert.match(image.headers.get('content-disposition')!,/^inline/);assert.equal(image.headers.get('x-content-type-options'),'nosniff');if(type==='image/svg+xml')assert.equal(image.headers.get('content-security-policy'),"sandbox; default-src 'none'; style-src 'unsafe-inline'");
    }
    assert.equal((await f.call('/act', { thread: `card:${self()}:${card.id}`, action: 'pick:1' })).status, 200);
    assert.equal(card.thread.at(-1)?.choice, 'Two');
    const launch = await (await f.call('/conversations', { op: 'launch', launch: { id: randomUUID(), projectId: 'repo', provider: 'claude', name: 'PhoneTest' } })).json() as any;
    const id = launch.session.id; let s = await f.until(id, 'idle');
    const desktop = f.board.touch(randomUUID(), f.root, 'codex').session;
    desktop.name = 'CurrentDesktop';
    const roster = await (await f.call('/sessions')).json() as any;
    assert.equal(roster.sessions.filter((x: any) => x.id === id).length, 1);
    assert.equal(roster.sessions.find((x: any) => x.id === desktop.id).external, true);
    assert.equal((await f.call('/sessions', undefined, { cookie: '' })).status, 401);
    const bytes = Buffer.from([0, 255, 1, 2, 3]);
    const upload = await (await f.call(`/upload?session=${id}&name=test.bin`, bytes)).json() as any;
    assert.equal(upload.attachment.bytes, bytes.length);
    const voice = await (await f.call(`/upload?session=${id}&name=note.m4a&voice=1`, bytes)).json() as any;
    assert.equal(voice.attachment.voiceNote, true); assert.ok(voice.voice.id);
    const voiceResult = await (await f.call(`/voice?id=${voice.voice.id}`)).json() as any;
    assert.ok(['transcribing', 'unavailable'].includes(voiceResult.state));
    assert.equal((await f.call('/voice?id=not-owned')).status, 404);
    const download = await f.call(`/file?session=${id}&id=${upload.attachment.id}`); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    const svg=await(await f.call(`/upload?session=${id}&name=vector.bin`,Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).json()as any;
    const svgFile=await f.call(`/file?session=${id}&id=${svg.attachment.id}`);assert.equal(svgFile.headers.get('content-type'),'image/svg+xml');assert.match(svgFile.headers.get('content-disposition')!,/^inline/);assert.equal(svgFile.headers.get('x-content-type-options'),'nosniff');assert.equal(svgFile.headers.get('content-security-policy'),"sandbox; default-src 'none'; style-src 'unsafe-inline'");
    const send = { id: randomUUID(), sessionId: id, epoch: s.epoch, op: 'message', text: 'Read the file', attachments: [upload.attachment.id] };
    assert.equal((await f.call('/conversations', { op: 'command', command: send })).status, 200); await f.until(id, 'idle');
    assert.equal(f.sends.length, 1); assert.equal((f.sends[0].files as any[])[0].name, 'test.bin');
    const history = await (await f.call('/conversations', { op: 'history', sessionId: id })).json() as any;
    assert.ok(history.events.some((e: any) => e.kind === 'attachment' && e.data.attachment.id === upload.attachment.id));
    const largeImage = Buffer.alloc(6 * 1024 * 1024); Buffer.from([137,80,78,71,13,10,26,10]).copy(largeImage);
    const imageIds: string[] = [];
    for (const name of ['one.png', 'two.png']) {
      const r = await f.call(`/upload?session=${id}&name=${name}`, largeImage); assert.equal(r.status, 200);
      imageIds.push((await r.json() as any).attachment.id);
    }
    assert.equal((await f.call('/conversations', { op: 'command', command: { ...send, id: randomUUID(), attachments: imageIds } })).status, 413);
    assert.equal(f.sends.length, 1);
    for (const op of ['stop', 'resume', 'shutdown']) { s = await f.until(id, op === 'resume' ? 'stopped' : 'idle'); await f.call('/conversations', { op: 'command', command: { id: randomUUID(), sessionId: id, epoch: s.epoch, controlRevision: s.controlRevision, turnId: s.turnId, op } }); }
    await f.until(id, 'closed');
    assert.equal((await f.call(`/upload?session=${id}&name=..%2Fescape`, bytes)).status, 400);
    assert.equal((await f.call(`/upload?session=${id}&name=large`, Buffer.alloc(MAX_UPLOAD + 1))).status, 413);
    assert.equal((await f.call('/push-subscription', { subscription: { endpoint: 'http://bad', keys: {} } })).status, 400);
    assert.equal((await f.call('/push-subscription', { subscription: subscription() })).status, 200);
    assert.equal((f.config.read().devices[0].push as any).endpoint, 'https://fcm.googleapis.com/fcm/send/test');
  } finally { await f.close(); }
});
test('SSE connection closes after device revocation and shell code parses', async () => {
  const f = await fixture(); try {
    await f.pair(); new Script(client);
    const stream = await f.call('/events'); const reader = stream.body!.getReader(); assert.equal(stream.status, 200);
    assert.match(new TextDecoder().decode((await reader.read()).value), /data: changed/);
    const launch = await (await f.call('/conversations', { op: 'launch', launch: { id: randomUUID(), projectId: 'repo', provider: 'claude', name: 'SSETest' } })).json() as any;
    let hints = '';
    for (let i = 0; i < 5 && !hints.includes('event: conversation'); i++) hints += new TextDecoder().decode((await reader.read()).value);
    assert.match(hints, /event: conversation/); assert.ok(hints.includes(launch.session.id));
    assert.equal(hints.includes('firstMessage'), false); // A bounded hint, not transcript/feed content.
    f.config.edit(s => { s.devices[0].revoked = Date.now(); });
    let done = false; for (let i = 0; i < 5; i++) if ((await reader.read()).done) { done = true; break; }
    assert.equal(done, true);
  } finally { await f.close(); }
});
test('phone approval commands commit once and reject an already-answered request', async () => {
  const f = await fixture(); try {
    await f.pair();
    const launched = await (await f.call('/conversations', { op: 'launch', launch: { id: randomUUID(), provider: 'claude', projectId: 'repo', name: 'Approval' } })).json() as any;
    const id = launched.session.id; const ready = await f.until(id, 'idle');
    await f.call('/conversations', { op: 'command', command: { id: randomUUID(), sessionId: id, epoch: ready.epoch, op: 'message', text: 'PHONE_APPROVAL' } });
    const waiting = await f.until(id, 'approval');
    const command = { sessionId: id, epoch: waiting.epoch, op: 'approve', approvalId: waiting.approvals[0].id };
    assert.equal((await f.call('/conversations', { op: 'command', command: { ...command, id: randomUUID(), allow: true } })).status, 200);
    assert.equal((await f.call('/conversations', { op: 'command', command: { ...command, id: randomUUID(), allow: false } })).status, 409);
    await f.until(id, 'idle');
  } finally { await f.close(); }
});
test('expired pairing cannot issue a token and malformed settings never get reset', async () => {
  const f = await fixture(); try {
    await f.pair();
    const p = f.config.read();
    f.config.edit(s => { s.setups[0].expires = Date.now() - 700000; });
    f.setCookies('__Secure-kokuban_setup=not-a-token');
    assert.equal((await f.call('/pairing/state')).status, 410);
    fs.writeFileSync(f.config.file, '{broken');
    assert.throws(() => f.config.edit(s => { s.enabled = false; }), /preserved/);
    assert.equal(fs.readFileSync(f.config.file, 'utf8'), '{broken');
    assert.equal((await f.call('/feed')).status, 400);
  } finally { await f.close(); }
});
test('Serve startup repairs only the phone mount and never resets unrelated handlers', async () => {
  const f = await fixture(); try {
    const calls: string[][] = [];
    const run = async (args: string[]) => { calls.push(args); return JSON.stringify({ Web: { 'pc.test:443': { Handlers: { '/voice-spike': { Proxy: 'http://127.0.0.1:47892' } } } } }); };
    await repairPhoneServe(f.config, run);
    assert.equal(calls.length, 2); assert.deepEqual(calls[0], ['serve', 'status', '--json']);
    assert.deepEqual(calls[1].slice(0, 4), ['serve', '--bg', '--https=443', '--set-path=/phone']);
    const target = calls[1][4]; calls.length = 0;
    await repairPhoneServe(f.config, async args => { calls.push(args); return JSON.stringify({ Web: { 'pc.test:443': { Handlers: { '/phone': { Proxy: target } } } } }); });
    assert.equal(calls.length, 1);
  } finally { await f.close(); }
});
test('notification settings, usage, presence and test-push routes remain authenticated and device-scoped', async () => {
  const f = await fixture(); try {
    assert.equal((await f.call('/usage')).status, 401);
    await f.pair();
    const settings = await (await f.call('/settings')).json() as any;
    assert.equal(settings.notifications.digestTime, '08:00'); assert.equal('hash' in settings.device, false);
    const notifications = { blocked: false, finished: true, stuck: false, digest: true, digestTime: '09:15' };
    assert.equal((await f.call('/settings', { notifications })).status, 200);
    assert.deepEqual((await (await f.call('/settings')).json() as any).notifications, notifications);
    assert.equal((await f.call('/settings', { notifications: { ...notifications, digestTime: '29:99' } })).status, 400);
    const usage = await (await f.call('/usage')).json() as any; assert.equal(usage.fiveHour.percent, 7); assert.equal(usage.weekly.percent, 11);
    assert.equal((await f.call('/presence', { visible: true, targets: ['board'] })).status, 200);
    assert.equal((await f.call('/presence', { visible: false, targets: [], client: randomUUID(), sequence: 2 })).status, 200);
    assert.equal((await f.call('/presence', { visible: true, targets: [], client: randomUUID(), sequence: -1 })).status, 400);
    assert.equal((await f.call('/presence', { visible: true, targets: [], client: 'bad', sequence: 3 })).status, 400);
    assert.equal((await f.call('/presence', { visible: true, targets: ['https://evil.test'] })).status, 400);
    assert.equal((await f.call('/push-subscription', { subscription: subscription() })).status, 200);
    assert.equal((await f.call('/push-test', { delaySeconds: 20 })).status, 200);
  } finally { await f.close(); }
});
