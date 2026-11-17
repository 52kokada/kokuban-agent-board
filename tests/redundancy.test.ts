import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Board, repeats, type Session } from '../src/board.js';
import { changed, feedView, pull, pullAll, self, stateFor, usePost } from '../src/feed.js';
import { handleRpc } from '../src/mcp.js';
import { taskTool, type WorkTask } from '../src/tasks.js';
import { wakeMail } from '../src/wake.js';

function room() {
  let now = 1_000_000;
  const board = new Board(null, () => now);
  const [a, b, c] = ['a', 'b', 'c'].map((id) => board.touch(id, '', 'codex').session) as [Session, Session, Session];
  return { board, a, b, c, tick: (ms: number) => { now += ms; } };
}

const NEWS = 'The deployed pause endpoint only accepts running intents, so intent 39 cannot be paused while open.';

test('a repeat is wording the reader already has, not a short reply or new news', () => {
  assert.equal(repeats(NEWS, `Heads up: ${NEWS} Plan accordingly.`), true);
  assert.equal(repeats(`Flora says: ${NEWS}`, NEWS), true, 'a relay with a short preface is still the same news');
  assert.equal(repeats('Yes, go ahead.', 'Yes, go ahead.'), false, 'short replies recur legitimately');
  assert.equal(repeats('The pause endpoint now accepts open intents after the patch, so retry intent 39.', NEWS), false);
});

test('a session is not handed news it already has, from the same sender or a relay', () => {
  const { board, a, b, c, tick } = room();
  assert.match(board.send(a, `${b.name},${c.name}`, NEWS), /^sent to/);
  board.take(b);
  tick(60_000);
  const relay = board.send(c, b.name, `Relaying from ${a.name}: ${NEWS}`);
  assert.match(relay, /^nothing sent: .*already has this \(message \d+ from /);
  assert.equal(board.take(b).length, 0);

  const d = board.touch('d', '', 'codex').session;
  const partial = board.send(a, `${b.name},${d.name}`, NEWS);
  assert.match(partial, new RegExp(`sent to ${d.name} .*not sent: ${b.name} already has this`));
  assert.equal(board.take(d)[0]!.audience, undefined, 'the skipped reader is not named as a co-recipient');

  tick(31 * 60_000);
  assert.match(board.send(a, b.name, NEWS), /^sent to/, 'old news may be said again');
});

test('task notices carry only news: no bare acceptance, progress waits, results wake', async () => {
  const { board, a: requester, b: owner } = room();
  const t = JSON.parse(await taskTool(board, requester, { op: 'create', to: owner.name, text: 'Check the build and return evidence' })) as WorkTask;
  board.take(owner);
  requester.state = 'idle';

  const accepted = JSON.parse(await taskTool(board, owner, { op: 'accept', id: t.id })) as { told: string };
  assert.equal(board.messages.filter((m) => m.to === requester.id).length, 0);
  assert.match(accepted.told, /not mailed/);

  const progress = JSON.parse(await taskTool(board, owner, { op: 'progress', id: t.id, text: 'Build passes; reviewing output' })) as { told: string };
  assert.equal(wakeMail(board, requester).length, 0, 'progress does not wake the requester');
  assert.match(progress.told, /does not wake/);

  const done = JSON.parse(await taskTool(board, owner, { op: 'complete', id: t.id, text: 'Build and review pass. Evidence: report.txt' })) as { told: string };
  assert.equal(wakeMail(board, requester).length, 1, 'the result wakes it');
  assert.match(done.told, /Do not send this again/);
  assert.deepEqual(board.take(requester).map((m) => ({ task: m.task, text: m.text })),
    [{ task: t.id, text: 'Task done. Build and review pass. Evidence: report.txt' }]);
  assert.ok(board.messages.some(m => m.noticeKind === 'progress' && m.supersededBy !== undefined), 'superseded progress remains in history');
});

test('recording an outcome answers with what changed, not the whole roster', async () => {
  const { board, a, b } = room();
  const call = async (args: Record<string, unknown>) => ((await handleRpc(board, 'codex',
    { id: 1, method: 'tools/call', params: { name: 'peers', arguments: { me: a.name, ...args } } })) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
  assert.match(await call({}), new RegExp(`Others: .*${b.name}`));
  const recorded = await call({ work: 'done', next: 'nothing left' });
  assert.match(recorded, /^Recorded: /);
  assert.doesNotMatch(recorded, new RegExp(b.name));
  board.touch('e', '', 'claude');
  assert.match(await call({ work: 'done', next: 'nothing left' }), /Joined: /);
});

test('a trusted name that answers as this board is never pulled or poked again', async () => {
  const { board } = room();
  const calls: string[] = [];
  const elsewhere = { ...stateFor(board), pc: 'pc-b', person: 'Sam' };
  usePost(board, async (pc, body) => {
    calls.push(`${pc}:${String(body.op)}`);
    return { ok: true, state: pc.startsWith('me') ? stateFor(board) : elsewhere };
  });
  const pcs = ['me.tail.test', 'pc-b.tail.test'];
  await pullAll(board, pcs);
  assert.equal(self(), stateFor(board).pc);
  assert.deepEqual(feedView(board).pcs.map((p) => p.pc).filter((pc) => pc !== self()), ['pc-b'], 'the alias is not listed as another PC');

  calls.length = 0;
  await pullAll(board, pcs);
  await pull(board, 'me.tail.test');
  board.touch('f', '', 'claude');
  changed(board, () => pcs);
  await new Promise((r) => setTimeout(r, 900));
  assert.deepEqual(calls.sort(), ['pc-b.tail.test:poke', 'pc-b.tail.test:state']);
});

test('who is working reaches other boards at most once per interval; what waits on a person goes at once', async () => {
  const { board } = room();
  const pokes: number[] = [];
  usePost(board, async () => { pokes.push(Date.now()); return { ok: true }; });
  const pcs = () => ['pc-b.tail.test'];
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
  changed(board, pcs, 1500);
  await settle(900);
  assert.equal(pokes.length, 1, 'the first change is news');

  board.touch('g', '', 'claude');
  changed(board, pcs, 1500);
  await settle(900);
  assert.equal(pokes.length, 1, 'a new session waits for the interval');
  board.touch('h', '', 'claude');
  changed(board, pcs, 1500);
  await settle(900);
  assert.equal(pokes.length, 2, 'both session changes go in one poke when the interval ends');

  board.touch('i', '', 'claude');
  board.workTasks.push({ id: 'cross', key: 'k', requester: { id: 'r', name: 'Rin', pc: 'pc-b.tail.test' }, owner: { id: board.sessions[0]!.id, name: board.sessions[0]!.name },
    text: 'Review the release', state: 'accepted', detail: '', revision: 1, created: board.clock(), updated: board.clock(), afterMs: 900_000 });
  changed(board, pcs, 1500);
  await settle(900);
  assert.equal(pokes.length, 3, 'running work is urgent and carries the session change with it');
  await settle(1600);
  assert.equal(pokes.length, 3, 'nothing is left over to send');
});
