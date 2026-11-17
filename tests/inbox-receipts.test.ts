import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Board, REDELIVER_MS, type Host, type Session } from '../src/board.js';
import { handleRpc } from '../src/mcp.js';
import { handleHook } from '../src/hooks.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function room() {
  let now = 1_000_000;
  return { board: new Board(null, () => now), tick: () => { now += REDELIVER_MS + 1; } };
}

async function inbox(board: Board, s: Session, args: Record<string, unknown> = {}) {
  const reply = await handleRpc(board, s.host, { id: 1, method: 'tools/call',
    params: { name: 'inbox', arguments: { me: s.name, ...args } } }) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
  return { text: reply.result.content[0]!.text, error: reply.result.isError };
}

const hosts: Host[] = ['claude', 'codex', 'kimi'];
for (const from of hosts) for (const to of hosts) if (from !== to) {
  test(`${from} -> ${to}: an explicit receipt prevents replay without hooks`, async () => {
    const { board, tick } = room();
    const sender = board.touch('sender', '', from).session;
    const reader = board.touch('reader', '', to).session;
    board.send(sender, reader.name, 'Please inspect the fixture.');
    const message = board.messages[0]!;
    const first = await inbox(board, reader);
    assert.match(first.text, /Please inspect the fixture/);
    assert.ok(first.text.includes(`ack=[${message.id}]`));
    assert.equal(message.delivered, false);
    tick();
    const next = await inbox(board, reader, { ack: [message.id] });
    assert.equal(next.text, 'no new messages');
    assert.equal(message.delivered, true);
    assert.equal((await inbox(board, reader, { ack: [message.id] })).text, 'no new messages');
  });
}

test('a lost inbox response remains recoverable after the retry interval', async () => {
  const { board, tick } = room();
  const s = board.touch('reader', '', 'kimi').session;
  board.taskMail(s.id, 'Recover this exact body.');
  const first = await inbox(board, s);
  assert.equal((await inbox(board, s)).text, 'no new messages');
  tick();
  const retry = await inbox(board, s);
  assert.match(retry.text, /Recover this exact body/);
  assert.equal(board.messages[0]!.delivered, false);
  assert.ok(first.text.includes(`id="${board.messages[0]!.id}"`));
});

test('board recovery preserves both unacknowledged offers and confirmed receipts', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-inbox-'));
  const file = path.join(folder, 'board.json');
  let now = 1_000_000;
  const board = new Board(file, () => now);
  const s = board.touch('reader', '', 'kimi').session;
  board.taskMail(s.id, 'Survive recovery.');
  await inbox(board, s);
  board.flush();
  now += REDELIVER_MS + 1;
  const recovered = new Board(file, () => now);
  const reader = recovered.sessions.find(x => x.id === s.id)!;
  assert.match((await inbox(recovered, reader)).text, /Survive recovery/);
  await inbox(recovered, reader, { ack: [recovered.messages[0]!.id] });
  recovered.flush();
  const confirmed = new Board(file, () => now);
  assert.equal(confirmed.messages[0]!.delivered, true);
  assert.equal((await inbox(confirmed, confirmed.sessions[0]!)).text, 'no new messages');
});

test('bounded batches leave hidden messages unoffered and drain with receipts', async () => {
  const { board } = room();
  const s = board.touch('reader', '', 'kimi').session;
  for (let i = 0; i < 12; i++) board.taskMail(s.id, `Item ${i}.`);
  const first = await inbox(board, s);
  assert.equal((first.text.match(/<kokuban-message /g) ?? []).length, 10);
  assert.match(first.text, /2 more eligible messages remain/);
  assert.equal(board.messages[10]!.shownAt, undefined);
  const ids = board.messages.slice(0, 10).map(m => m.id);
  const second = await inbox(board, s, { ack: ids });
  assert.equal((second.text.match(/<kokuban-message /g) ?? []).length, 2);
  assert.equal(board.messages.filter(m => m.delivered).length, 10);
});

test('the character target separates large messages without cutting their bodies', async () => {
  const { board } = room();
  const s = board.touch('reader', '', 'codex').session;
  const bodies = ['a'.repeat(7000), 'b'.repeat(7000), 'c'.repeat(15000)];
  for (const body of bodies) board.taskMail(s.id, body);
  for (let i = 0; i < bodies.length; i++) {
    const out = await inbox(board, s, i ? { ack: [board.messages[i - 1]!.id] } : {});
    assert.equal((out.text.match(/<kokuban-message /g) ?? []).length, 1);
    assert.ok(out.text.includes(bodies[i]!));
    if (i === 2) assert.match(out.text, /oversized message was preserved in full/);
    else assert.ok(out.text.length < 12500);
  }
});

test('invalid receipts cannot acknowledge unseen or another session\'s messages, even partially', async () => {
  const { board } = room();
  const s = board.touch('reader', '', 'kimi').session;
  const other = board.touch('other', '', 'claude').session;
  board.taskMail(s.id, 'Shown');
  board.taskMail(s.id, 'Not shown');
  board.taskMail(other.id, 'Other recipient');
  await inbox(board, s, { limit: 1 });
  for (const id of [board.messages[1]!.id, board.messages[2]!.id]) {
    assert.equal((await inbox(board, s, { ack: [board.messages[0]!.id, id] })).error, true);
    assert.equal(board.messages[0]!.delivered, false);
  }
  for (const args of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { ack: 'all' }, { ack: [-1] }])
    assert.equal((await inbox(board, s, args)).error, true);
});

test('normal host hooks confirm only offered inbox messages; explicit receipt retries are harmless', async () => {
  const { board } = room();
  const s = board.touch('reader', '', 'codex').session;
  s.rules = 12;
  board.taskMail(s.id, 'First');
  board.taskMail(s.id, 'Second');
  await inbox(board, s, { limit: 1 });
  handleHook(board, 'codex', { session_id: s.id, hook_event_name: 'PostToolUse' });
  assert.equal(board.messages[0]!.delivered, true);
  assert.equal(board.messages[1]!.delivered, false);
  assert.equal((await inbox(board, s, { ack: [board.messages[0]!.id] })).error, undefined);
});

test('cached Claude schemas may serialize receipt lists or a single ID as JSON text', async () => {
  for (const format of ['list', 'single']) {
    const { board, tick } = room();
    const s = board.touch('reader', '', 'claude').session;
    board.taskMail(s.id, 'Preserve this receipt.');
    await inbox(board, s);
    tick();
    const id = board.messages[0]!.id;
    const result = await inbox(board, s, { ack: format === 'list' ? JSON.stringify([id]) : String(id) });
    assert.equal(result.error, undefined);
    assert.equal(result.text, 'no new messages');
    assert.equal(board.messages[0]!.delivered, true);
  }
});

test('serialized compatibility receipts retain strict ownership, type and batch validation', async () => {
  const { board } = room();
  const s = board.touch('reader', '', 'claude').session;
  const other = board.touch('other', '', 'kimi').session;
  board.taskMail(s.id, 'Own message'); board.taskMail(other.id, 'Other message');
  await inbox(board, s);
  for (const ack of ['null', '{}', '["1"]', '[1.5]', '[0]', 'true', '1,2', '[1]; process.exit()', JSON.stringify(Array(51).fill(1)), '9'.repeat(2049), String(board.messages[1]!.id)]) {
    assert.equal((await inbox(board, s, { ack })).error, true);
    assert.equal(board.messages[0]!.delivered, false);
  }
});
