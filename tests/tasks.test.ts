import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Board } from '../src/board.js';
import { createServer } from '../src/daemon.js';
import { handleHook } from '../src/hooks.js';
import { wakeMail } from '../src/wake.js';
import { flushTasks, sweepTasks, taskTool } from '../src/tasks.js';
import type { WorkTask } from '../src/tasks.js';

function room(file: string | null = null) {
  let now = 1_000_000;
  const b = new Board(file, () => now);
  const requester = b.touch('requester', '', 'codex').session;
  const owner = b.touch('owner', '', 'claude').session;
  const stranger = b.touch('stranger', '', 'codex').session;
  const create = async (text = 'Inspect the build and return evidence') => JSON.parse(await taskTool(b, requester,
    { op: 'create', to: owner.name, text, after_s: 60 })) as WorkTask;
  return { b, requester, owner, stranger, create, tick: (ms: number) => { now += ms; } };
}

test('concurrent remote retries create one handoff and malformed acknowledgements remain pending', async () => {
  const { b, requester, owner } = room();
  b.remote = async (args) => {
    if (args.op === 'agent_peers') return JSON.stringify({ ok: true, task_protocol: 1, device: 'laptop.tail.test', sessions: [{ id: owner.id, name: owner.name }] });
    return JSON.stringify({ ok: true });
  };
  const args = { op: 'create', to: owner.name, pc: 'laptop', explicit: true, text: 'One concurrent handoff' };
  const replies = await Promise.all([taskTool(b, requester, args), taskTool(b, requester, args)]);
  assert.equal(JSON.parse(replies[0]!).id, JSON.parse(replies[1]!).id);
  assert.equal(b.workTasks.length, 1);
  assert.equal(b.taskDeliveries.length, 1);
  assert.match(b.taskDeliveries[0]!.error!, /acknowledgement/);
});

test('a local task is explicitly accepted and completed; reading mail is not acceptance', async () => {
  const { b, requester, owner, stranger, create } = room();
  const t = await create();
  b.take(owner);
  assert.equal(b.workTasks[0]!.state, 'requested');
  await assert.rejects(taskTool(b, owner, { op: 'complete', id: t.id, text: 'Done' }), /Accept/);
  await assert.rejects(taskTool(b, stranger, { op: 'accept', id: t.id }), /unknown/);
  await assert.rejects(taskTool(b, requester, { op: 'complete', id: t.id, text: 'Done' }), /Only the owner/);
  await taskTool(b, owner, { op: 'accept', id: t.id });
  await assert.rejects(taskTool(b, owner, { op: '__proto__', id: t.id }), /op must/);
  await taskTool(b, owner, { op: 'progress', id: t.id, text: 'Build passes; checking the result' });
  await taskTool(b, owner, { op: 'complete', id: t.id, text: 'Build and review pass. Evidence: report.txt' });
  assert.equal(b.workTasks[0]!.state, 'done');
  assert.equal(b.workTasks[0]!.revision, 3);
  assert.match(b.take(requester).at(-1)!.text, /report.txt/);
  await assert.rejects(taskTool(b, owner, { op: 'accept', id: t.id }), /already done/);
});

test('creation and state retries do not duplicate work or notifications', async () => {
  const { b, owner, create } = room();
  const first = await create();
  const again = await create();
  assert.equal(first.id, again.id);
  assert.equal(b.workTasks.length, 1);
  assert.equal(b.take(owner).length, 1);
  await taskTool(b, owner, { op: 'accept', id: first.id });
  const count = b.messages.length;
  await taskTool(b, owner, { op: 'accept', id: first.id });
  assert.equal(b.messages.length, count);
});

test('blockers need a condition; requester cancels without granting unrelated actions', async () => {
  const { b, owner, requester, create } = room();
  const t = await create();
  await assert.rejects(taskTool(b, owner, { op: 'block', id: t.id, text: '' }), /resumption condition/);
  await taskTool(b, owner, { op: 'block', id: t.id, text: 'Missing input; requester must provide the file' });
  assert.match(b.take(requester).at(-1)!.text, /You own the follow-up/);
  await assert.rejects(taskTool(b, owner, { op: 'cancel', id: t.id, text: 'stop' }), /Only the requester/);
  await taskTool(b, requester, { op: 'cancel', id: t.id, text: 'The request is withdrawn' });
  assert.equal(b.workTasks[0]!.state, 'cancelled');
  assert.match(b.take(owner).at(-1)!.text, /preserve unrelated work/);
});

test('one overdue notice survives restarts, and unresolved tasks outlive session history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-tasks-'));
  try {
    const { b, requester, create, tick } = room(path.join(dir, 'board.json'));
    await create();
    tick(60_000);
    sweepTasks(b);
    assert.equal(b.take(requester).length, 1);
    b.confirm(requester);
    sweepTasks(b);
    assert.equal(b.take(requester).length, 0);
    b.flush();
    const back = new Board(path.join(dir, 'board.json'), () => 2_000_000);
    sweepTasks(back);
    assert.equal(back.take(back.sessions.find((s) => s.id === requester.id)!).length, 0);
    assert.ok(back.workTasks[0]!.alertedAt);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('owner departure produces one accountable notice, not an unread bounce as well', async () => {
  const { b, owner, requester, create } = room();
  await create();
  b.end(owner.id);
  sweepTasks(b);
  const mail = b.take(requester);
  assert.equal(mail.length, 1);
  assert.match(mail[0]!.text, /Owner left/);
  sweepTasks(b);
  assert.equal(b.take(requester).length, 0);
});

test('completed and blocked tasks do not get overdue reminders; progress renews the interval', async () => {
  const { b, owner, requester, create, tick } = room();
  const t = await create();
  await taskTool(b, owner, { op: 'accept', id: t.id });
  tick(50_000);
  await taskTool(b, owner, { op: 'progress', id: t.id, text: 'Inspection finished; preparing evidence' });
  b.take(requester);
  b.confirm(requester);
  tick(20_000);
  sweepTasks(b);
  assert.equal(b.take(requester).length, 0);
  await taskTool(b, owner, { op: 'block', id: t.id, text: 'Need requester to provide an input' });
  b.take(requester);
  b.confirm(requester);
  tick(120_000);
  sweepTasks(b);
  assert.equal(b.take(requester).length, 0);
  await taskTool(b, owner, { op: 'accept', id: t.id });
  await taskTool(b, owner, { op: 'complete', id: t.id, text: 'Evidence attached' });
  b.take(requester);
  b.confirm(requester);
  tick(120_000);
  sweepTasks(b);
  assert.equal(b.take(requester).length, 0);
});

test('a reused name cannot accept old work, and explicit human pauses are not woken', async () => {
  const { b, owner, requester, create } = room();
  const t = await create();
  b.end(owner.id);
  const replacement = b.touch('replacement', '', 'codex').session;
  replacement.name = owner.name;
  await assert.rejects(taskTool(b, replacement, { op: 'accept', id: t.id }), /unknown/);
  b.setWork(requester, 'paused', 'Human explicitly paused this work');
  requester.state = 'idle';
  sweepTasks(b);
  assert.equal(wakeMail(b, requester).length, 0);
  assert.equal(handleHook(b, 'codex', { session_id: requester.id, hook_event_name: 'Stop' }), null);
});

test('an unresolved owned task gets a bounded Stop check even with a done session summary', async () => {
  const { b, owner, create } = room();
  const t = await create();
  b.take(owner);
  b.setWork(owner, 'done');
  const input = { session_id: owner.id, hook_event_name: 'Stop' };
  assert.match((handleHook(b, 'claude', input) as { reason: string }).reason, new RegExp(t.id));
  assert.equal(handleHook(b, 'claude', input), null);
});

// Two real local HTTP boards exercise the wire format and bridge routing without
// changing the running board, starting agents or touching another person's PC.
const a = room();
const z = room();
// Each board relays for the other as computeruse's device_bridge would: with the relay proof (D97).
const RELAY = { 'content-type': 'application/json', 'x-kokuban-relay': 'f'.repeat(64) };
const servers = [a.b, z.b].map((b) => createServer(b, { trust: () => 'work', ingress: () => 'f'.repeat(64), self: () => ['thispc'] }));
let urls: string[];
let dropOfferReply = false;
let offline = false;
const requests: Array<Record<string, any>> = [];
before(async () => {
  urls = await Promise.all(servers.map(async (server) => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }));
  [a.b, z.b].forEach((b, i) => {
    b.remote = async (args) => {
      requests.push(args);
      if (offline) throw new Error('Other PC is offline');
      const res = await fetch(urls[1 - i] + '/bridge', { method: 'POST', headers: RELAY,
        body: JSON.stringify({ op: String(args.op).replace('agent_', ''), to: args.to, to_id: args.to_id,
          text: args.text, from: { pc: i === 0 ? 'desktop.tail.test' : 'laptop.tail.test', agent: args.me } }) });
      const out = await res.json() as object;
      if (dropOfferReply && args.op === 'agent_task' && JSON.parse(String(args.text)).kind === 'offer') {
        dropOfferReply = false;
        throw new Error('Response lost after delivery');
      }
      return JSON.stringify({ device: i === 0 ? 'laptop.tail.test' : 'desktop.tail.test', ...out });
    };
  });
});
after(() => { servers.forEach((s) => { s.closeAllConnections(); s.close(); }); });

test('remote task round trip: acceptance, blocker, progress and evidence reach the requester', async () => {
  await assert.rejects(taskTool(a.b, a.requester, { op: 'create', to: z.owner.name, pc: 'laptop', text: 'Inspect remote build' }), /explicit/);
  const t = JSON.parse(await taskTool(a.b, a.requester, { op: 'create', to: z.owner.name, pc: 'laptop', explicit: true, text: 'Inspect remote build' })) as WorkTask;
  assert.equal(t.owner.pc, 'laptop.tail.test');
  assert.equal(z.b.workTasks.find((x) => x.id === t.id)!.requester.pc, 'desktop.tail.test');
  await taskTool(z.b, z.owner, { op: 'accept', id: t.id });
  assert.equal(a.b.workTasks.find((x) => x.id === t.id)!.state, 'accepted');
  await taskTool(z.b, z.owner, { op: 'block', id: t.id, text: 'Need the input file from the requester' });
  assert.equal(a.b.workTasks.find((x) => x.id === t.id)!.state, 'blocked');
  await taskTool(z.b, z.owner, { op: 'accept', id: t.id });
  await taskTool(z.b, z.owner, { op: 'complete', id: t.id, text: 'Verified output. Evidence: laptop/report.txt' });
  assert.equal(a.b.workTasks.find((x) => x.id === t.id)!.state, 'done');
  assert.match(a.b.take(a.requester).at(-1)!.text, /laptop\/report.txt/);
  assert.equal(a.b.taskDeliveries.length + z.b.taskDeliveries.length, 0);
});

test('a lost offer response is retried without duplicate tasks or waking the owner twice', async () => {
  dropOfferReply = true;
  z.b.take(z.owner);
  const t = JSON.parse(await taskTool(a.b, a.requester, { op: 'create', to: z.owner.name, pc: 'laptop', explicit: true, text: 'Retry-safe inspection' })) as WorkTask;
  assert.equal(z.b.workTasks.filter((x) => x.id === t.id).length, 1);
  assert.equal(z.b.take(z.owner).length, 1);
  assert.equal(a.b.taskDeliveries.length, 1);
  a.tick(5000);
  await flushTasks(a.b);
  assert.equal(a.b.taskDeliveries.length, 0);
  assert.equal(z.b.take(z.owner).length, 0);
});

test('offline owner updates persist, replay once, and cannot overwrite a newer revision', async () => {
  const t = JSON.parse(await taskTool(a.b, a.requester, { op: 'create', to: z.owner.name, pc: 'laptop', explicit: true, text: 'Offline result test' })) as WorkTask;
  await taskTool(z.b, z.owner, { op: 'accept', id: t.id });
  const earlier = structuredClone(z.b.workTasks.find((x) => x.id === t.id)!);
  offline = true;
  await taskTool(z.b, z.owner, { op: 'complete', id: t.id, text: 'Finished with verified evidence while requester PC was offline' });
  assert.ok(z.b.taskDeliveries.find((d) => d.task === t.id)!.error);
  offline = false;
  z.tick(5000);
  await flushTasks(z.b);
  assert.equal(a.b.workTasks.find((x) => x.id === t.id)!.state, 'done');
  a.b.take(a.requester);
  const reply = await fetch(urls[0] + '/bridge', { method: 'POST', headers: RELAY,
    body: JSON.stringify({ op: 'task', to_id: a.requester.id, from: { pc: 'laptop.tail.test', agent: z.owner.name },
      text: JSON.stringify({ kind: 'update', actor: z.owner.id, task: earlier }) }) });
  assert.equal((await reply.json() as { ok: boolean }).ok, true);
  assert.equal(a.b.workTasks.find((x) => x.id === t.id)!.state, 'done');
  assert.equal(a.b.take(a.requester).length, 0);
});

test('pending offers cancelled offline never invite the owner to start work on retry', async () => {
  // Discovery is online, then only the offer loses its response.
  dropOfferReply = true;
  const t = JSON.parse(await taskTool(a.b, a.requester, { op: 'create', to: z.owner.name, pc: 'laptop', explicit: true, text: 'Withdraw this pending request' })) as WorkTask;
  z.b.take(z.owner);
  offline = true;
  await taskTool(a.b, a.requester, { op: 'cancel', id: t.id, text: 'Human no longer needs it' });
  offline = false;
  a.tick(5000);
  await flushTasks(a.b);
  assert.equal(z.b.workTasks.find((x) => x.id === t.id)!.state, 'cancelled');
  assert.equal(a.b.workTasks.find((x) => x.id === t.id)!.state, 'cancelled');
  assert.ok(z.b.take(z.owner).every((m) => !m.text.includes('before work')));
});

test('remote updates from a different device or a reused agent name cannot change task state', async () => {
  const t = a.b.workTasks[0]!;
  for (const [pc, actor] of [['intruder.tail.test', z.owner.id], ['laptop.tail.test', 'replacement-session']]) {
    const res = await fetch(urls[0] + '/bridge', { method: 'POST', headers: RELAY,
      body: JSON.stringify({ op: 'task', to_id: a.requester.id, from: { pc, agent: z.owner.name },
        text: JSON.stringify({ kind: 'update', actor, task: { ...t, state: 'blocked', detail: 'Spoofed', revision: 100 } }) }) });
    assert.equal((await res.json() as { ok: boolean }).ok, false);
  }
  assert.equal(a.b.workTasks[0]!.state, 'done');
});

test('an unsent result and its outbox survive a board restart', async () => {
  const t = JSON.parse(await taskTool(a.b, a.requester, { op: 'create', to: z.owner.name, pc: 'laptop', explicit: true, text: 'Persist this result across restart' })) as WorkTask;
  await taskTool(z.b, z.owner, { op: 'accept', id: t.id });
  offline = true;
  await taskTool(z.b, z.owner, { op: 'complete', id: t.id, text: 'Verified evidence survives the restart' });
  offline = false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-outbox-'));
  try {
    const file = path.join(dir, 'board.json');
    const saved = new Board(file, z.b.clock);
    saved.sessions = structuredClone(z.b.sessions);
    saved.workTasks = structuredClone(z.b.workTasks);
    saved.taskDeliveries = structuredClone(z.b.taskDeliveries);
    saved.flush();
    z.tick(5000);
    const back = new Board(file, z.b.clock);
    back.remote = z.b.remote;
    await flushTasks(back);
    assert.equal(back.taskDeliveries.length, 0);
    assert.equal(a.b.workTasks.find((x) => x.id === t.id)!.state, 'done');
    assert.match(a.b.workTasks.find((x) => x.id === t.id)!.detail, /survives the restart/);
    back.flush();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unsaved handoffs are not dispatched when snapshot persistence fails', async () => {
  const { b, requester, owner } = room();
  let dispatched = 0;
  b.remote = async (args) => {
    if (args.op === 'agent_peers') return JSON.stringify({ ok: true, task_protocol: 1, device: 'laptop.tail.test', sessions: [{ id: owner.id, name: owner.name }] });
    dispatched++;
    return '{}';
  };
  b.flush = () => false;
  await assert.rejects(taskTool(b, requester, { op: 'create', to: owner.name, pc: 'laptop', explicit: true, text: 'Do not dispatch without saving' }), /could not be saved/);
  await flushTasks(b);
  assert.equal(dispatched, 0);
});

test('older boards are refused before creating a remote task or outbox', async () => {
  const { b, requester, owner } = room();
  b.remote = async () => JSON.stringify({ ok: true, sessions: [{ id: owner.id, name: owner.name }] });
  await assert.rejects(taskTool(b, requester, { op: 'create', to: owner.name, pc: 'laptop', explicit: true, text: 'Needs task protocol' }), /task bridge version/);
  assert.equal(b.workTasks.length + b.taskDeliveries.length, 0);
});
