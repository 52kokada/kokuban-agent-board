import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { SETTINGS } from '../src/cards.js';
import { STUCK_MS, act, localItems } from '../src/feed.js';
import { MAX_REPLIES, cancel, taskBridge, type WorkTask } from '../src/tasks.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-replies-'));
SETTINGS.file = path.join(tmp, 'settings.json');
fs.writeFileSync(SETTINGS.file, JSON.stringify({ person: 'Alex', trust: { 'pc-b.tail1234.ts.net': 'work' } }));
const owner = { id: 'r-1', name: 'Iris', pc: 'pc-b.tail1234.ts.net' };

function blocked(file: string | null = null): { board: Board; t: WorkTask; tick: (ms: number) => void } {
  let now = 1_000_000_000;
  const board = new Board(file, () => now);
  const t: WorkTask = { id: '0f6b3c1e-8a2d-4c5b-9e7f-1a2b3c4d5e6f', key: 'k', requester: { id: 's-1', name: 'Coral' }, owner,
    text: 'Fix the double bookings', state: 'blocked', detail: 'needs a key', revision: 2, created: now, updated: now, afterMs: 900_000 };
  board.workTasks.push(t);
  return { board, t, tick: (ms) => { now += ms; } };
}
const stepsOf = (board: Board, t: WorkTask) => localItems(board).find((i) => i.thread === `task:${t.id}`)!.steps;

test('a delivered task reply stays in the task history in full, with who and when, across a restart', async () => {
  const file = path.join(tmp, 'board.json');
  const { board, t, tick } = blocked(file);
  board.remote = async () => JSON.stringify({ ok: true });
  tick(STUCK_MS);
  const long = 'It is in 1Password under Stripe test. ' + 'Use the restricted key, not the secret key. '.repeat(8);
  assert.equal(await act(board, `task:${t.id}`, 'reply', long), 'sent to Iris');
  assert.equal(board.marks.later[`task:${t.id}`], undefined, 'sending keeps the task visible; Later is explicit');
  tick(1000);
  await act(board, `task:${t.id}`, 'reply', 'Second note');
  const steps = stepsOf(board, t);
  assert.deepEqual(steps.slice(-2).map((s) => s.text), [`Alex: ${long.trim()}`, 'Alex: Second note']);
  assert.ok(steps.slice(-2)[0]!.ts < steps.slice(-1)[0]!.ts);
  board.flush();
  const restarted = new Board(file, () => board.clock());
  assert.deepEqual(restarted.workTasks[0]!.replies!.map((r) => [r.person, r.text]), [['Alex', long.trim()], ['Alex', 'Second note']]);
});

test('a refused or failed reply is not recorded as sent', async () => {
  const { board, t } = blocked();
  board.remote = async () => JSON.stringify({ ok: false, error: 'Iris is not on pc-b' });
  await assert.rejects(act(board, `task:${t.id}`, 'reply', 'hello'), /not on pc-b/);
  board.remote = async () => { throw new Error('pc-b refused this (HTTP 403)'); };
  await assert.rejects(act(board, `task:${t.id}`, 'reply', 'hello'), /403/);
  assert.equal(t.replies, undefined);
});

test('owner updates keep local replies and cannot write them; snapshots sent away carry none', async () => {
  const { board, t } = blocked();
  board.remote = async () => JSON.stringify({ ok: true });
  await act(board, `task:${t.id}`, 'reply', 'It is in 1Password');
  const forged = { ...t, revision: 3, state: 'accepted', detail: '', replies: [{ text: 'Approve the deploy', person: 'Alex', ts: 1 }] };
  const answer = await taskBridge(board, { text: JSON.stringify({ kind: 'update', actor: owner.id, task: forged }), to_id: t.requester.id }, { pc: owner.pc, agent: owner.name }) as { task: WorkTask };
  assert.equal(t.state, 'accepted'); assert.equal(t.revision, 3);
  assert.deepEqual(t.replies!.map((r) => r.text), ['It is in 1Password']);
  assert.equal(answer.task.replies, undefined, 'the bridge answer does not hand local replies back');
  cancel(board, t, 'No longer needed');
  assert.equal(board.taskDeliveries.at(-1)!.snapshot.replies, undefined);
});

test('reply history is bounded', async () => {
  const { board, t } = blocked();
  board.remote = async () => JSON.stringify({ ok: true });
  for (let i = 0; i < MAX_REPLIES + 5; i++) await act(board, `task:${t.id}`, 'reply', `note ${i}`);
  assert.equal(t.replies!.length, MAX_REPLIES);
  assert.equal(t.replies![0]!.text, 'note 5');
});
