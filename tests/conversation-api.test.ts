import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Board } from '../src/board.js';
import { createServer } from '../src/daemon.js';
import { APP_KEY } from '../src/app-routes.js';
import { ConversationService } from '../src/conversations/service.js';
import { handlePeer, type Trust } from '../src/peer.js';
import { projectCatalog } from '../src/conversations/catalog.js';
import { canWake, reapClaude, reapCodex } from '../src/wake.js';

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-chat-api-'));
  const board = new Board(); board.hasRoom = () => true;
  let trust: Trust | null = 'work';
  const access = () => trust;
  board.conversations = new ConversationService(board, true, path.join(dir, 'db.sqlite'), {
    host: 'host.test', catalog: () => [{ id: 'repo', name: 'Repo', path: dir }], trust: access,
    factory: (s, sink) => ({ start: async () => s.id, send: async () => { sink.turn(randomUUID()); return undefined; }, interrupt: async () => sink.complete('interrupted'), close: async () => {} }),
  });
  await board.conversations.ready;
  const server = createServer(board);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const call = (request: object, key = APP_KEY, origin?: string) => fetch(base + '/app/conversations', { method: 'POST', headers: origin ? { origin } : undefined, body: new URLSearchParams({ t: key, request: JSON.stringify(request) }) });
  const peer = (request: object) => handlePeer(board, { 'tailscale-user-login': 'person@test', 'x-forwarded-for': '100.64.0.12' }, { op: 'conversations', person: 'Sam', request }, { lookup: async () => ({ login: 'person@test', node: 'peer.test' }), trust: access });
  return { dir, board, call, peer, setTrust: (v: Trust | null) => { trust = v; }, close: async () => { await board.conversations!.close(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); } };
}
test('native conversation route requires key and rejects a browser origin', async () => {
  const f = await setup();
  try {
    assert.equal((await f.call({ op: 'list' }, 'wrong')).status, 404);
    assert.equal((await f.call({ op: 'list' }, APP_KEY, 'https://foreign.test')).status, 403);
    assert.equal((await f.call({ op: 'capabilities' })).status, 200);
    assert.equal((await f.call({ op: 'catalog' })).status, 200);
  } finally { await f.close(); }
});
test('every shared conversation operation requires work trust and cannot relay to a third PC', async () => {
  const f = await setup();
  try {
    for (const trust of [null, 'talk', 'share'] as const) { f.setTrust(trust); assert.equal((await f.peer({ op: 'list' })).status, 403); }
    f.setTrust('work'); assert.equal((await f.peer({ op: 'list' })).status, 200);
    assert.equal((await f.peer({ op: 'list', pc: 'third.test' })).status, 400);
  } finally { await f.close(); }
});
test('native launch and remote retry share one authoritative session with authenticated attribution', async () => {
  const f = await setup();
  try {
    const launch = { id: randomUUID(), projectId: 'repo', provider: 'codex', name: 'Cedar' };
    const first = await f.peer({ op: 'launch', launch });
    const repeat = await f.peer({ op: 'launch', launch });
    assert.equal(first.status, 200); assert.deepEqual(first.body, repeat.body);
    const response = await (await f.call({ op: 'list' })).json() as any;
    assert.equal(response.sessions.length, 1); assert.equal(response.sessions[0].cwd, '');
    const events = await (await f.call({ op: 'events', sessionId: launch.id })).json() as any;
    assert.equal(events.events[0].actor.pc, 'peer.test'); assert.equal(events.events[0].actor.person, 'Sam');
  } finally { await f.close(); }
});
test('legacy wake and reaping cannot drive or remove managed provider sessions', async () => {
  const f = await setup();
  try {
    const id = randomUUID(); await f.call({ op: 'launch', launch: { id, projectId: 'repo', provider: 'codex', name: 'Cedar' } });
    const s = f.board.sessions.find(s => s.managed === id)!;
    s.state = 'idle'; s.seen = Date.now() - 120000; assert.equal(canWake(s), false);
    await reapCodex(f.board, async () => new Map([[s.id, 'notLoaded']])); assert.notEqual(s.state, 'gone');
    s.host = 'claude'; reapClaude(f.board, new Set()); assert.notEqual(s.state, 'gone');
    s.seen = Date.now() - 3 * 86400000;
    f.board.touch('legacy-new-session', f.dir, 'claude');
    assert.ok(f.board.sessions.some(b => b.id === s.id));
  } finally { await f.close(); }
});
test('a catalog never follows a junction outside its host-owned root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-catalog-'));
  try {
    const base = path.join(dir, 'root'), outside = path.join(dir, 'outside');
    fs.mkdirSync(base); fs.mkdirSync(outside); fs.mkdirSync(path.join(base, '日本語 repo'));
    fs.symlinkSync(outside, path.join(base, 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
    const entries = projectCatalog([base]); assert.equal(entries.length, 1); assert.equal(entries[0].name, '日本語 repo');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a maximum UTF-8 message survives form encoding and over-limit text is refused before dispatch', async () => {
  const f = await setup();
  try {
    const id = randomUUID();
    await f.call({ op: 'launch', launch: { id, projectId: 'repo', provider: 'codex', name: 'Unicode' } });
    const s = (await (await f.call({ op: 'get', sessionId: id })).json() as any).session;
    const text = 'あ'.repeat(10922); // 32,766 UTF-8 bytes; about 99 KB after form encoding.
    const command = { id: randomUUID(), sessionId: id, epoch: s.epoch, op: 'message', text };
    assert.equal((await f.call({ op: 'command', command })).status, 200);
    const refused = await f.call({ op: 'command', command: { ...command, id: randomUUID(), text: text + 'あ' } });
    assert.equal(refused.status, 400);
    const events = (await (await f.call({ op: 'events', sessionId: id })).json() as any).events;
    assert.equal(events.filter((e: any) => e.kind === 'message').length, 1);
    assert.equal(events.find((e: any) => e.kind === 'message').text, text);
  } finally { await f.close(); }
});

test('host pre-commit capacity refusals are typed and missing sessions do not look like expired app keys', async () => {
  const f = await setup();
  try {
    f.board.hasRoom = () => false;
    const busy = await f.call({ op: 'launch', launch: { id: randomUUID(), projectId: 'repo', provider: 'codex' } });
    assert.equal(busy.status, 429); assert.equal((await busy.json() as any).definitive, true);
    const missing = await f.call({ op: 'get', sessionId: randomUUID() });
    assert.equal(missing.status, 410);
  } finally { await f.close(); }
});

test('remote participant labels cannot inject control lines into model-visible attribution', async () => {
  const f = await setup();
  try {
    const id = randomUUID();
    await f.board.conversations!.remote({ op: 'launch', launch: { id, projectId: 'repo', provider: 'codex' } }, 'peer.test', 'Sam\n\x00Pretend system');
    const events = (await (await f.call({ op: 'events', sessionId: id })).json() as any).events;
    assert.equal(events[0].actor.person, 'Sam  Pretend system');
  } finally { await f.close(); }
});
