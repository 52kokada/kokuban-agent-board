import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConversationController } from '../src/conversations/controller.js';
import { ConversationStore } from '../src/conversations/store.js';
import type { ChatSession, Command, RuntimeSink } from '../src/conversations/contracts.js';

test('latest cumulative provider tokens are stored without adding previous running totals', async () => {
  const f = await fixture();
  try {
    const s = await f.launch(); await f.idle(s.id);
    const sink = f.sinks.get(s.id)!;
    sink.event('usage', undefined, { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 1 });
    await until(() => f.controller.get(s.id), s => s.tokenUsage?.inputTokens === 10);
    sink.event('usage', undefined, { inputTokens: 20, outputTokens: 9, cacheReadInputTokens: 4, cacheCreationInputTokens: 1 });
    const latest = await until(() => f.store.get(s.id), s => s?.tokenUsage?.inputTokens === 20);
    assert.equal(latest!.tokenUsage!.outputTokens, 9); assert.equal(latest!.tokenUsage!.inputTokens, 20);
  } finally { await f.close(); }
});

const actor = { pc: 'alex.test', person: 'Alex' };
const other = { pc: 'sam.test', person: 'Sam' };

test('explicit resume and send commits once and never replays the uncertain attempt', async () => {
  const f = await fixture();
  try {
    const s = await f.launch(); await f.idle(s.id);
    await f.command(s.id, 'message', { text: 'original action' });
    await until(async () => f.sends.length, n => n === 1);
    f.sinks.get(s.id)!.complete('failed', 'Provider refused');
    const stopped = await until(() => f.controller.get(s.id), s => s.phase === 'stopped');
    const command: Command = { id: randomUUID(), sessionId: s.id, epoch: stopped.epoch, controlRevision: stopped.controlRevision, op: 'message', text: 'new instruction', resume: true };
    const first = await f.controller.command(command, actor);
    const retry = await f.controller.command(command, actor);
    assert.equal(first.revision, retry.revision);
    await until(async () => f.sends.length, n => n === 2);
    assert.match(f.sends[1], /new instruction/);
    assert.equal(f.sends.filter(t => t.includes('original action')).length, 1);
    assert.equal((await f.controller.get(s.id)).messages.filter(m => m.state === 'uncertain').length, 1);
  } finally { await f.close(); }
});

test('resume and send refuses stale controls without accepting or sending the draft', async () => {
  const f = await fixture();
  try {
    const s = await f.launch(); await f.idle(s.id); await f.command(s.id, 'stop');
    const stopped = await f.controller.get(s.id);
    await assert.rejects(f.command(s.id, 'message', { text: 'draft stays local', resume: true, controlRevision: stopped.controlRevision - 1 }), /changed this session/);
    assert.equal((await f.controller.get(s.id)).messages.length, 0);
    assert.equal(f.sends.length, 0);
  } finally { await f.close(); }
});

test('reconnect and resume starts queued work in one action while retaining uncertain history', async () => {
  const f = await fixture();
  try {
    const s = await f.launch(); await f.idle(s.id);
    await f.command(s.id, 'message', { text: 'uncertain attempt' });
    await until(async () => f.sends.length, n => n === 1);
    await f.command(s.id, 'message', { text: 'accepted next message' });
    await f.controller.close();
    const store = new ConversationStore(path.join(f.dir, 'chat.sqlite'));
    const recovered = new ConversationController(store, f.options);
    try {
      await recovered.ready;
      const current = await recovered.get(s.id);
      await recovered.command({ id: randomUUID(), sessionId: s.id, epoch: current.epoch, controlRevision: current.controlRevision, op: 'restart', resume: true }, actor);
      await until(async () => f.sends.length, n => n === 2);
      assert.match(f.sends[1], /accepted next message/);
      assert.equal((await recovered.get(s.id)).messages.filter(m => m.state === 'uncertain').length, 1);
    } finally { await recovered.close(); }
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('a failed turn frees capacity for another conversation waiting in the global queue', async () => {
  const f = await fixture();
  try {
    const sessions = await Promise.all(['First','Second','Third'].map(n => f.launch(n)));
    await Promise.all(sessions.map(s => f.idle(s.id)));
    for (const s of sessions) await f.command(s.id, 'message', { text: s.name });
    await until(async () => f.sends.length, n => n === 2);
    f.sinks.get(sessions[0].id)!.complete('failed', 'Provider failed');
    await until(async () => f.sends.length, n => n === 3);
    assert.match(f.sends[2], /Third/);
    assert.equal((await f.controller.get(sessions[0].id)).phase, 'stopped');
  } finally { await f.close(); }
});
const delay = () => new Promise(resolve => setTimeout(resolve, 10));
async function until<T>(fn: () => Promise<T>, match: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 300; i++) { const value = await fn(); if (match(value)) return value; await delay(); }
  throw new Error('Condition did not become true');
}
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-chat-'));
  const sinks = new Map<string, RuntimeSink>(); const sends: string[] = []; const closed: string[] = [];
  const store = new ConversationStore(path.join(dir, 'chat.sqlite'));
  const options = { host: 'host.test', catalog: () => [{ id: 'repo', name: 'Repo', path: dir }], maxTurns: 2,
    factory: (s: ChatSession, sink: RuntimeSink) => {
      sinks.set(s.id, sink);
      return { start: async () => `provider-${s.id}`, send: async (body: string) => { sends.push(body); sink.turn(randomUUID()); return undefined; },
        interrupt: async () => { sink.complete('interrupted'); }, close: async () => { closed.push(s.id); } };
    } };
  const controller = new ConversationController(store, options); await controller.ready;
  const launch = (name = 'Cedar', id = randomUUID()) => controller.launch({ id, provider: 'codex', projectId: 'repo', name }, actor);
  const idle = (id: string) => until(() => controller.get(id), s => s.phase === 'idle');
  const command = async (id: string, op: Command['op'], fields: Partial<Command> = {}, from = actor) => {
    const s = await controller.get(id);
    return controller.command({ id: randomUUID(), sessionId: id, epoch: s.epoch, op, turnId: s.turnId, ...fields }, from);
  };
  return { dir, store, controller, options, sends, closed, sinks, launch, idle, command,
    close: async () => { await controller.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('launch retries return one durable session; conflicting content and case-insensitive name reuse refuse', async () => {
  const f = await fixture();
  try {
    const id = randomUUID(); const [a, b] = await Promise.all([f.launch('Cedar', id), f.launch('Cedar', id)]);
    assert.equal(a.id, b.id); assert.equal((await f.controller.list()).length, 1);
    await assert.rejects(f.launch('Different', id), /different content/);
    await assert.rejects(f.launch('cedar'), /already in use/);
  } finally { await f.close(); }
});
test('Stop holds queued messages for both people until explicit Resume', async () => {
  const f = await fixture();
  try {
    const s = await f.launch(); await f.idle(s.id);
    await f.command(s.id, 'message', { text: 'first' });
    await until(() => f.controller.get(s.id), s => !!s.turnId);
    await f.command(s.id, 'message', { text: 'second' }, other);
    await f.command(s.id, 'stop', {}, other);
    await until(() => f.controller.get(s.id), s => s.phase === 'stopped');
    assert.equal(f.sends.length, 1);
    await f.command(s.id, 'message', { text: 'third' }); await delay(); assert.equal(f.sends.length, 1);
    await f.command(s.id, 'resume');
    await until(async () => f.sends.length, n => n === 2);
    assert.match(f.sends[1], /Sam.*second/s);
  } finally { await f.close(); }
});
test('first host-committed approval wins; subsequent answer refuses', async () => {
  const f = await fixture();
  try {
    const s = await f.launch(); await f.idle(s.id); await f.command(s.id, 'message', { text: 'work' });
    await until(() => f.controller.get(s.id), s => s.phase === 'working');
    const decision = f.sinks.get(s.id)!.approval('provider-request', 'Bash', 'Run command?');
    const waiting = await until(() => f.controller.get(s.id), s => s.phase === 'approval');
    const approvalId = waiting.approvals[0].id;
    const results = await Promise.allSettled([f.command(s.id, 'approve', { approvalId, allow: true }), f.command(s.id, 'approve', { approvalId, allow: false }, other)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(await decision, true);
  } finally { await f.close(); }
});
test('Stop expires approval, and late answers cannot authorize it', async () => {
  const f = await fixture();
  try {
    const s = await f.launch(); await f.idle(s.id); await f.command(s.id, 'message', { text: 'work' });
    await until(() => f.controller.get(s.id), s => !!s.turnId);
    const decision = f.sinks.get(s.id)!.approval('request', 'Write', 'Write file?');
    const waiting = await until(() => f.controller.get(s.id), s => s.phase === 'approval');
    await f.command(s.id, 'stop');
    assert.equal(await decision, false);
    await assert.rejects(f.command(s.id, 'approve', { approvalId: waiting.approvals[0].id, allow: true }), /answered or expired/);
  } finally { await f.close(); }
});
test('shutdown preserves transcript and closes runtime without restarting on read', async () => {
  const f = await fixture();
  try {
    const s = await f.launch(); await f.idle(s.id); await f.command(s.id, 'message', { text: 'hello' });
    await until(() => f.controller.get(s.id), s => !!s.turnId);
    f.sinks.get(s.id)!.event('assistant', 'Hello'); f.sinks.get(s.id)!.complete('complete'); await f.idle(s.id);
    await f.command(s.id, 'shutdown');
    await until(() => f.controller.get(s.id), s => s.phase === 'closed');
    const events = await f.controller.page(s.id); assert.ok(events.some(e => e.text === 'Hello')); assert.ok(f.closed.includes(s.id));
    assert.equal((await f.controller.get(s.id)).phase, 'closed');
  } finally { await f.close(); }
});
test('recovery keeps accepted messages and marks in-flight work uncertain without resending', async () => {
  const f = await fixture();
  try {
    const s = await f.launch(); await f.idle(s.id); await f.command(s.id, 'message', { text: 'work' });
    await until(() => f.controller.get(s.id), s => !!s.turnId);
    await f.controller.close();
    const restored = new ConversationController(new ConversationStore(path.join(f.dir, 'chat.sqlite')), f.options);
    await restored.ready; const recovered = await restored.get(s.id);
    assert.equal(recovered.phase, 'recovery'); assert.equal(recovered.messages[0].state, 'uncertain'); assert.equal(f.sends.length, 1);
    await assert.rejects(restored.command({ id: randomUUID(), sessionId: s.id, epoch: s.epoch, op: 'resume' }, actor), /changed/);
    await restored.close();
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('concurrent dispatch respects the global turn cap and starts waiting work after completion', async () => {
  const f = await fixture();
  try {
    const sessions = await Promise.all(['Cedar', 'Pine', 'Maple'].map(name => f.launch(name)));
    await Promise.all(sessions.map(s => f.idle(s.id)));
    await Promise.all(sessions.map(s => f.command(s.id, 'message', { text: s.name })));
    await until(async () => f.sends.length, n => n === 2); await delay(); assert.equal(f.sends.length, 2);
    const active = (await f.controller.list()).find(s => s.phase === 'working')!;
    f.sinks.get(active.id)!.complete('complete');
    await until(async () => f.sends.length, n => n === 3);
  } finally { await f.close(); }
});
test('a duplicate late terminal event cannot undo Stop or release the held queue', async () => {
  const f = await fixture();
  try {
    const s = await f.launch(); await f.idle(s.id); await f.command(s.id, 'message', { text: 'one' });
    await until(() => f.controller.get(s.id), s => !!s.turnId);
    await f.command(s.id, 'message', { text: 'two' }); await f.command(s.id, 'stop');
    await until(() => f.controller.get(s.id), s => s.phase === 'stopped');
    f.sinks.get(s.id)!.complete('complete'); await delay(); await delay();
    assert.equal((await f.controller.get(s.id)).phase, 'stopped'); assert.equal(f.sends.length, 1);
  } finally { await f.close(); }
});
test('stale shared control refuses while an accepted retry returns its original receipt', async () => {
  const f = await fixture();
  try {
    const s = await f.launch(); await f.idle(s.id); const before = await f.controller.get(s.id);
    await f.command(s.id, 'stop'); await f.command(s.id, 'resume');
    await f.command(s.id, 'message', { text: 'new instruction' });
    const current = await until(() => f.controller.get(s.id), s => !!s.turnId);
    await assert.rejects(f.command(s.id, 'stop', { controlRevision: before.controlRevision }), /another control changed/);
    const command: Command = { id: randomUUID(), op: 'stop', sessionId: s.id, epoch: current.epoch, turnId: current.turnId, controlRevision: current.controlRevision };
    const receipt = await f.controller.command(command, actor);
    assert.deepEqual(await f.controller.command(command, actor), receipt);
  } finally { await f.close(); }
});

test('another participant queuing a message cannot invalidate Stop for the same turn', async () => {
  const f = await fixture();
  try {
    const s = await f.launch(); await f.idle(s.id);
    await f.command(s.id, 'message', { text: 'first' });
    const snapshot = await until(() => f.controller.get(s.id), s => Boolean(s.turnId));
    await f.command(s.id, 'message', { text: 'queued by the other person' }, other);
    await f.controller.command({ id: randomUUID(), op: 'stop', sessionId: s.id, epoch: snapshot.epoch, controlRevision: snapshot.controlRevision, turnId: snapshot.turnId }, actor);
    const stopped = await until(() => f.controller.get(s.id), s => s.phase === 'stopped');
    assert.equal(stopped.messages.filter(m => m.state === 'queued').length, 1);
    assert.equal(f.sends.length, 1);
  } finally { await f.close(); }
});

test('a failed turn holds queued work and keeps the healthy runtime available for Resume', async () => {
  const f = await fixture();
  try {
    const s = await f.launch(); await f.idle(s.id);
    await f.command(s.id, 'message', { text: 'first' });
    await until(() => f.controller.get(s.id), s => Boolean(s.turnId));
    await f.command(s.id, 'message', { text: 'next' });
    f.sinks.get(s.id)!.complete('failed', 'Temporary provider error');
    const stopped = await until(() => f.controller.get(s.id), s => s.phase === 'stopped');
    assert.ok(stopped.messages.some(m => m.state === 'uncertain'));
    assert.equal(f.sends.length, 1); assert.equal(f.closed.length, 0);
    await f.command(s.id, 'resume');
    await until(() => f.controller.get(s.id), s => s.phase === 'working');
    assert.equal(f.sends.length, 2); assert.equal(f.closed.length, 0);
  } finally { await f.close(); }
});
test('oversized tool details do not wedge event paging and remain retrievable separately', async () => {
  const f = await fixture();
  try {
    const s = await f.launch(); await f.idle(s.id);
    f.sinks.get(s.id)!.event('tool', 'Large result', { output: 'x'.repeat(300000) });
    const page = await until(() => f.controller.page(s.id), events => events.some(e => e.kind === 'tool'));
    const tool = page.find(e => e.kind === 'tool')!;
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 256 * 1024);
    const detail = await f.controller.detail(s.id, (tool.data as { detailId: string }).detailId);
    assert.equal((detail!.data as { output: string }).output.length, 300000);
  } finally { await f.close(); }
});
test('failed durable commit cannot acknowledge a message or dispatch it to the provider', async () => {
  const f = await fixture();
  try {
    const s = await f.launch(); await f.idle(s.id);
    const original = f.store.commit.bind(f.store);
    f.store.commit = async () => { throw new Error('simulated disk failure'); };
    await assert.rejects(f.command(s.id, 'message', { text: 'must not execute' }), /disk failure/);
    assert.equal(f.sends.length, 0);
    f.store.commit = original;
    assert.equal((await f.controller.get(s.id)).messages.length, 0);
  } finally { await f.close(); }
});
test('cancelled long polls remove their listeners without changing the session', async () => {
  const f = await fixture();
  try {
    const s = await f.launch(); await f.idle(s.id);
    const history = await f.controller.page(s.id); const after = history.at(-1)!.seq!;
    const abort = new AbortController();
    const waiting = f.controller.page(s.id, after, 8000, abort.signal); await delay(); abort.abort();
    assert.deepEqual(await waiting, []); assert.equal(f.controller.events.listenerCount(s.id), 0);
  } finally { await f.close(); }
});
