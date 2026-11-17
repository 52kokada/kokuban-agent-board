import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Board, REDELIVER_MS, type Host, type Session } from '../src/board.js';
import { handleHook } from '../src/hooks.js';
import { handleRpc } from '../src/mcp.js';
import { taskTool, taskBridge } from '../src/tasks.js';
import { inboxTool } from '../src/inbox.js';
import { wakeMail } from '../src/wake.js';

function room() {
  let now = 1_000_000;
  const b = new Board(null, () => now);
  return { b, tick: (ms: number) => { now += ms; } };
}
async function call(b: Board, s: Session, name: string, args: object) {
  const r = await handleRpc(b, s.host, { id: 1, method: 'tools/call', params: { name, arguments: { me: s.name, ...args } } }) as any;
  return r.result;
}

for (const host of ['claude', 'codex', 'kimi'] as Host[]) {
  test(`${host}: receipts ride a useful board call instead of a separate inbox round trip`, async () => {
    const { b } = room(), s = b.touch('s', '', host).session;
    b.taskMail(s.id, 'Actual work');
    assert.match(await inboxTool(b, s, {}), /Next board call: ack=/);
    const id = b.messages[0]!.id;
    const r = await call(b, s, 'peers', { work: 'done', ack: JSON.stringify([id]) });
    assert.notEqual(r.isError, true);
    assert.equal(b.messages[0]!.delivered, true);
    assert.equal(s.work, 'done');
  });

  test(`${host}: native hook receipt evidence suppresses redundant hints, with retry fallback`, async () => {
    const { b, tick } = room(), s = b.touch('s', '', host).session;
    s.rules = 12;
    handleHook(b, host, { session_id: s.id, hook_event_name: 'PostToolUse' });
    assert.equal(s.toolReceipts, true);
    b.taskMail(s.id, 'Read this');
    assert.doesNotMatch(await inboxTool(b, s, {}), /ack=/);
    assert.equal(b.messages[0]!.delivered, false, 'a missing next hook must not silently deliver an offer');
    tick(REDELIVER_MS + 1);
    assert.match(await inboxTool(b, s, {}), /ack=/, 'replay restores explicit receipts if the hook path stopped working');
  });

  test(`${host}: old informational resume mail stays unread; action, task and human mail stays immediate`, async () => {
    const { b, tick } = room();
    const sender = b.touch('sender', '', 'other').session, s = b.touch('s', '', host).session;
    b.send(sender, s.name, 'OLD-INFO-BODY', 'next-step');
    b.send(sender, s.name, 'OLD-ACTION-BODY', 'immediate');
    b.taskMail(s.id, 'OLD-TASK-PROGRESS', sender.id, 'task-1', false);
    b.sendFromPerson('Alex', s, 'OLD-HUMAN-ANSWER');
    s.work = 'paused'; tick(31 * 60_000);
    const input = { session_id: s.id, hook_event_name: 'UserPromptSubmit', prompt: 'A new task.' };
    const out = JSON.stringify(handleHook(b, host, input));
    assert.doesNotMatch(out, /OLD-INFO-BODY/);
    for (const text of ['OLD-ACTION-BODY', 'OLD-TASK-PROGRESS', 'OLD-HUMAN-ANSWER']) assert.ok(out.includes(text));
    assert.match(out, /1 older informational/);
    assert.equal(b.messages[0]!.shownAt, undefined);
    assert.equal(b.messages[0]!.delivered, false);
    assert.doesNotMatch(JSON.stringify(handleHook(b, host, { ...input, hook_event_name: 'PostToolUse' })), /older informational/);
    assert.match(await inboxTool(b, s, { include_deferred: true }), /OLD-INFO-BODY/);
  });
}

test('foreign or unseen receipt IDs reject the entire useful operation without partial confirmation', async () => {
  const { b } = room(), a = b.touch('a', '', 'kimi').session, z = b.touch('z', '', 'claude').session;
  b.taskMail(a.id, 'Shown'); b.taskMail(z.id, 'Not yours');
  await inboxTool(b, a, {});
  const result = await call(b, a, 'peers', { work: 'done', ack: b.messages.map(m => m.id) });
  assert.equal(result.isError, true);
  assert.equal(b.messages[0]!.delivered, false);
  assert.notEqual(a.work, 'done');
});

test('task mutation acknowledgements stay small without losing full evidence or legacy records', async () => {
  const { b } = room(), requester = b.touch('r', '', 'codex').session, owner = b.touch('o', '', 'kimi').session;
  const text = 'TASK-BRIEF '.repeat(300), detail = 'BLOCKER-EVIDENCE '.repeat(150);
  const created = JSON.parse(await taskTool(b, requester, { op: 'create', to: owner.name, text }));
  assert.ok(JSON.stringify(created).length < 700); assert.equal(created.text, undefined);
  await taskTool(b, owner, { op: 'accept', id: created.id });
  const reply = await taskTool(b, owner, { op: 'block', id: created.id, text: detail });
  assert.ok(reply.length < 900); assert.ok(!reply.includes('TASK-BRIEF')); assert.ok(!reply.includes('BLOCKER-EVIDENCE'));
  const full = JSON.parse(await taskTool(b, owner, { op: 'status', id: created.id }));
  assert.equal(full.text, text.trim()); assert.equal(full.detail, detail.trim());
  const legacy = JSON.parse(await taskTool(b, owner, { op: 'block', id: created.id, text: detail, compact: false }));
  assert.equal(legacy.text, full.text); assert.equal(legacy.detail, full.detail);
});

test('same blocker keys coalesce wakes; changed keys, explicit urgency and legacy calls still wake', async () => {
  const { b } = room(), r = b.touch('r', '', 'codex').session, o = b.touch('o', '', 'kimi').session;
  const t = JSON.parse(await taskTool(b, r, { op: 'create', to: o.name, text: 'Do work' }));
  await taskTool(b, o, { op: 'accept', id: t.id }); r.state = 'idle';
  await taskTool(b, o, { op: 'block', id: t.id, text: 'Need schema choice', blocker_key: 'schema' });
  assert.equal(wakeMail(b, r).length, 1);
  b.take(r); b.confirm(r);
  const next = JSON.parse(await taskTool(b, o, { op: 'block', id: t.id, text: 'Still need schema; new evidence attached', blocker_key: 'schema' }));
  assert.match(next.told, /next step/); assert.equal(wakeMail(b, r).length, 0);
  assert.match(b.workTasks[0]!.detail, /new evidence/);
  await taskTool(b, o, { op: 'block', id: t.id, text: 'Need urgent schema action', blocker_key: 'schema', urgent: true });
  assert.equal(wakeMail(b, r).length, 1);
  await taskTool(b, o, { op: 'block', id: t.id, text: 'Need another dependency', blocker_key: 'access' });
  assert.equal(wakeMail(b, r).length, 1);
  await taskTool(b, o, { op: 'block', id: t.id, text: 'Legacy changed blocker' });
  assert.equal(wakeMail(b, r).length, 1);
});

test('a quieter blocker revision preserves an unreceived actionable wake', async () => {
  const { b } = room(), r = b.touch('r', '', 'codex').session, o = b.touch('o', '', 'kimi').session;
  const t = JSON.parse(await taskTool(b, r, { op: 'create', to: o.name, text: 'Do work' }));
  r.state = 'idle';
  await taskTool(b, o, { op: 'block', id: t.id, text: 'Need access', blocker_key: 'access' });
  await taskTool(b, o, { op: 'block', id: t.id, text: 'Need access; updated evidence', blocker_key: 'access' });
  assert.equal(wakeMail(b, r).length, 1);
  assert.match(wakeMail(b, r)[0]!.text, /updated evidence/);
});

test('remote blocker revisions set wake metadata before dispatch and retain explicit urgency', async () => {
  const { b } = room(), r = b.touch('r', '', 'codex').session;
  b.hasRoom = () => true;
  r.state = 'idle';
  const task = { id: '12345678-1234-1234-1234-123456789abc', key: 'k', requester: { id: r.id, name: r.name },
    owner: { id: 'owner', name: 'Remote', pc: 'test-pc' }, text: 'Work', state: 'accepted', detail: '', revision: 1,
    created: b.clock(), updated: b.clock(), afterMs: 900000 } as any;
  b.workTasks.push(task);
  const dispatched: boolean[] = [];
  b.onSend = () => { dispatched.push(wakeMail(b, r).length > 0); };
  const update = (revision: number, detail: string, attentionRevision: number) => taskBridge(b, {
    to_id: r.id, text: JSON.stringify({ kind: 'update', actor: 'owner', task: { ...task, state: 'blocked', revision, detail, blockerKey: 'access', attentionRevision } }),
  }, { pc: 'test-pc', agent: 'Remote' });
  await update(2, 'Need access', 2);
  b.take(r); b.confirm(r);
  await update(3, 'Updated evidence', 2);
  assert.deepEqual(dispatched, [true, false]);
  await update(4, 'Updated evidence', 4);
  assert.deepEqual(dispatched, [true, false, true]);
});

test('short glance errors do not dump rosters or mutate knowledge of peers', async () => {
  const { b } = room(), s = b.touch('s', '', 'claude').session;
  const peer = b.touch('peer', '', 'codex').session;
  const known = [...s.known];
  for (const args of [{}, { who: 'missing' }]) {
    const r = await call(b, s, 'glance', args);
    assert.equal(r.isError, true); assert.ok(r.content[0].text.length < 200);
    assert.ok(!r.content[0].text.includes(peer.name));
    assert.deepEqual(s.known, known);
  }
});

test('deferred informational mail does not short-circuit waiting for a fresh reply', async () => {
  const { b } = room(), sender = b.touch('sender', '', 'codex').session, s = b.touch('s', '', 'kimi').session;
  b.send(sender, s.name, 'Old information', 'next-step');
  s.deferredMailBefore = b.clock() + 1;
  const pending = inboxTool(b, s, { wait_s: 1 });
  setTimeout(() => b.taskMail(s.id, 'Fresh reply'), 20);
  const out = await pending;
  assert.match(out, /Fresh reply/); assert.doesNotMatch(out, /Old information/);
  const explicit = await inboxTool(b, s, { include_deferred: true, wait_s: 50 });
  assert.match(explicit, /Old information/);
});
