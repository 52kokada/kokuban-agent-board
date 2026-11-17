import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Board } from '../src/board.js';
import { handleHook } from '../src/hooks.js';
import { handleRpc } from '../src/mcp.js';
import { batchWakeScheduler, markWoken, wakeMail } from '../src/wake.js';
import { taskTool } from '../src/tasks.js';

function room(file: string | null = null) {
  let now = 1_000_000;
  const b = new Board(file, () => now);
  const a = b.touch('a', '', 'codex').session;
  const c = b.touch('c', '', 'claude').session;
  c.rules = 12;
  c.state = 'idle';
  return { b, a, c, tick: (ms: number) => { now += ms; } };
}

test('informational mail neither wakes nor extends Stop, but natural steps still deliver it', () => {
  const { b, a, c } = room();
  b.send(a, c.name, 'Build receipt for your records', 'next-step');
  assert.equal(wakeMail(b, c).length, 0);
  assert.equal(handleHook(b, 'claude', { session_id: c.id, hook_event_name: 'Stop' }), null);
  assert.equal(b.messages[0]!.delivered, false);
  const out = handleHook(b, 'claude', { session_id: c.id, hook_event_name: 'UserPromptSubmit', prompt: 'Continue the review' });
  assert.match(JSON.stringify(out), /Build receipt for your records/);
  assert.equal(b.messages[0]!.delivered, false, 'offer still requires confirmation');
  handleHook(b, 'claude', { session_id: c.id, hook_event_name: 'PostToolUse' });
  assert.equal(b.messages[0]!.delivered, true);
});

test('batch deadlines do not slide, and an urgent message flushes the whole burst', () => {
  const { b, a, c, tick } = room();
  b.send(a, c.name, 'First routine action', 'batch');
  const deadline = b.messages[0]!.wakeAfter;
  assert.equal(wakeMail(b, c).length, 0);
  tick(1000);
  b.send(a, c.name, 'Second routine action', 'batch');
  assert.equal(b.messages[1]!.wakeAfter, deadline);
  assert.equal(wakeMail(b, c).length, 0);
  b.send(a, c.name, 'Urgent blocker: stop this action');
  assert.equal(wakeMail(b, c).length, 3);
  markWoken(b, c, wakeMail(b, c));
  assert.equal(wakeMail(b, c).length, 0);
});

test('urgent escalation promotes matching unread information without a duplicate', () => {
  const { b, a, c, tick } = room();
  const text = 'The replacement backend is ready; reconnect the existing interface and verify it.';
  b.send(a, c.name, text, 'next-step');
  assert.equal(wakeMail(b, c).length, 0);
  assert.match(b.send(a, c.name, text), /already has this/, 'legacy resend does not escalate information');
  assert.equal(wakeMail(b, c).length, 0);
  const originalSent = b.messages[0]!.ts;
  tick(11 * 60_000);
  assert.match(b.send(a, c.name, text, 'immediate'), /promoted to immediate wake/);
  assert.equal(b.messages[0]!.ts, originalSent, 'escalation preserves the original timestamp');
  assert.equal(b.messages.length, 1);
  assert.equal(wakeMail(b, c).length, 1);
  b.take(c);
  assert.match(b.send(a, c.name, text, 'immediate'), /already has this/);
});

test('batch mail survives reload and wakes at the deadline; inbox may read it sooner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-batch-'));
  try {
    const file = path.join(dir, 'board.json');
    const { b, a, c } = room(file);
    b.send(a, c.name, 'Persisted batched action', 'batch');
    b.flush();
    const back = new Board(file, () => 1_002_000);
    const restored = back.sessions.find(s => s.id === c.id)!;
    assert.equal(wakeMail(back, restored).length, 1);
    assert.equal(b.take(c).length, 1, 'explicit reads do not wait for a wake deadline');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('batch scheduler wakes each deadline without waiting for the 15s retry timer', async () => {
  const b = new Board(null);
  const a = b.touch('a', '', 'codex').session;
  const c = b.touch('c', '', 'claude').session;
  const d = b.touch('d', '', 'codex').session;
  c.state = d.state = 'idle';
  b.send(a, c.name, 'First batch', 'batch');
  b.send(a, d.name, 'Second batch', 'batch');
  b.messages[0]!.wakeAfter = Date.now() + 20;
  b.messages[1]!.wakeAfter = Date.now() + 50;
  const received: string[] = [];
  const dispatch = batchWakeScheduler(b, () => {
    for (const s of [c, d]) {
      const mail = wakeMail(b, s);
      if (mail.length) { received.push(s.id); markWoken(b, s, mail); }
    }
  });
  dispatch();
  dispatch(); // A burst must not produce two callbacks for the same recipient.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(received, [c.id, d.id]);
});

test('tasks, blockers, cancellations and human answers bypass ordinary batches', async () => {
  const { b, a, c } = room();
  const t = JSON.parse(await taskTool(b, a, { op: 'create', to: c.name, text: 'Review this change' }));
  assert.equal(wakeMail(b, c).length, 1);
  b.take(c); b.confirm(c);
  a.state = 'idle';
  await taskTool(b, c, { op: 'accept', id: t.id });
  await taskTool(b, c, { op: 'block', id: t.id, text: 'Missing fixture; requester supplies it' });
  assert.equal(wakeMail(b, a).length, 1);
  await taskTool(b, a, { op: 'cancel', id: t.id, text: 'Withdraw this review' });
  assert.equal(wakeMail(b, c).length, 1);
  b.take(c); b.confirm(c);
  b.sendFromPerson('Alex', c, 'Yes, continue');
  assert.equal(wakeMail(b, c).length, 1);
});

test('paused, stale, broadcast and continuation-limited mail keep their existing gates', () => {
  const { b, a, c, tick } = room();
  b.send(a, c.name, 'A batched action', 'batch');
  tick(2000);
  c.work = 'paused';
  assert.equal(wakeMail(b, c).length, 0);
  c.work = 'active'; c.continues = 999;
  assert.equal(wakeMail(b, c).length, 0);
  c.continues = 0; tick(600_000);
  assert.equal(wakeMail(b, c).length, 0);
  b.send(a, 'everyone', 'New information for everyone', 'immediate');
  assert.equal(wakeMail(b, c).length, 0);
});

test('compact task pages retain blocked work, hide other sessions and preserve full evidence', async () => {
  const { b, a, c, tick } = room();
  const t = JSON.parse(await taskTool(b, a, { op: 'create', to: c.name, text: 'Review ' + 'x'.repeat(600) }));
  await taskTool(b, c, { op: 'block', id: t.id, text: 'Missing fixture; ' + 'e'.repeat(700) });
  tick(1);
  const done = JSON.parse(await taskTool(b, a, { op: 'create', to: c.name, text: 'Complete another review' }));
  await taskTool(b, c, { op: 'accept', id: done.id });
  await taskTool(b, c, { op: 'complete', id: done.id, text: 'Evidence: all checks pass' });
  const page = JSON.parse(await taskTool(b, a, { op: 'list', compact: true }));
  assert.equal(page.total, 1);
  assert.equal(page.tasks[0].id, t.id);
  assert.equal(page.tasks[0].state, 'blocked');
  assert.equal(page.tasks[0].truncated, true);
  assert.equal(page.next_offset, null);
  const full = JSON.parse(await taskTool(b, a, { op: 'status', id: t.id }));
  assert.equal(full.detail.length, 717);
  const history = JSON.parse(await taskTool(b, a, { op: 'list', compact: true, scope: 'all', limit: 1 }));
  assert.equal(history.total, 2);
  assert.equal(history.next_offset, 1);
  const next = JSON.parse(await taskTool(b, a, { op: 'list', compact: true, scope: 'all', limit: 1, offset: 1 }));
  assert.notEqual(history.tasks[0].id, next.tasks[0].id);
  assert.equal(next.next_offset, null);
  assert.equal(JSON.parse(await taskTool(b, a, { op: 'list', compact: false })).length, 2, 'explicit legacy list stays an array with history');
  assert.equal(JSON.parse(await taskTool(b, a, { op: 'list' })).total, 1, 'default list contains only bounded open work');
  const stranger = b.touch('stranger', '', 'claude').session;
  assert.equal(JSON.parse(await taskTool(b, stranger, { op: 'list', compact: true })).total, 0);
  await assert.rejects(taskTool(b, a, { op: 'list', compact: true, limit: 0 }), /limit/);
});

test('MCP delivery schema, validation and telemetry are bounded and contain no message text', async () => {
  const { b, a, c } = room();
  const entries: Record<string, unknown>[] = [];
  b.usage = e => entries.push(e);
  const call = async (delivery: string) => await handleRpc(b, 'codex', { id: 1, method: 'tools/call',
    params: { name: 'send', arguments: { me: a.name, to: c.name, text: 'Private evidence marker', delivery } } }) as any;
  const bad = await call('invalid');
  assert.equal(bad.result.isError, true);
  assert.equal(b.messages.length, 0);
  const good = await call('next-step');
  assert.match(good.result.content[0].text, /does not wake/);
  assert.equal(wakeMail(b, c).length, 0);
  assert.equal(entries.at(-1)!.outputChars, good.result.content[0].text.length);
  assert.equal(typeof entries.at(-1)!.durationMs, 'number');
  assert.doesNotMatch(JSON.stringify(entries), /Private evidence marker/);
});

test('short onboarding preserves authorization rules and upgrades old sessions only once', () => {
  const { b, c } = room();
  const entries: Record<string, unknown>[] = [];
  b.usage = e => entries.push(e);
  delete c.rules; // First onboarding; already-introduced resumes stay quiet.
  const out = handleHook(b, 'claude', { session_id: c.id, hook_event_name: 'SessionStart' }) as any;
  const text = out.hookSpecificOutput.additionalContext as string;
  assert.ok(text.length < 3800, `onboarding was ${text.length} characters`);
  for (const rule of ['deleting, deploying, paying, publishing', 'paused requires the human', 'explicit=true', 'Delivery is not acceptance']) assert.ok(text.includes(rule), rule);
  assert.equal(entries.length, 1);
  assert.equal(handleHook(b, 'claude', { session_id: c.id, hook_event_name: 'PostToolUse' }), null);
  assert.equal(entries.length, 1, 'quiet hooks do not add telemetry spam');
  c.rules = 11;
  assert.match(JSON.stringify(handleHook(b, 'claude', { session_id: c.id, hook_event_name: 'PostToolUse' })), /next-step/);
  assert.equal(handleHook(b, 'claude', { session_id: c.id, hook_event_name: 'PostToolUse' }), null);
});
