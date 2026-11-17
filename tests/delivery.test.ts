import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board, REDELIVER_MS } from '../src/board.js';
import { handleHook } from '../src/hooks.js';
import { markWoken } from '../src/wake.js';

test('lost offers retry after 90 seconds, including across a snapshot reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-delivery-'));
  const file = path.join(dir, 'board.json');
  let now = 1_000_000;
  const board = new Board(file, () => now);
  const a = board.touch('a', '', 'claude').session;
  const b = board.touch('b', '', 'claude').session;
  board.send(a, b.name, 'keep me');
  const m = board.take(b)[0]!;
  assert.equal(m.delivered, false);
  assert.equal(m.shownTo, b.id);
  assert.equal(board.take(b).length, 0);
  board.flush();
  const restored = new Board(file, () => now);
  now += REDELIVER_MS;
  assert.equal(restored.take(b)[0]!.id, m.id);
  handleHook(restored, 'claude', { session_id: 'b', hook_event_name: 'PostToolUse', agent_id: 'child' });
  assert.equal(restored.messages[0]!.delivered, false, 'a child cannot confirm parent mail');
  handleHook(restored, 'claude', { session_id: 'b', hook_event_name: 'PostToolUse' });
  now += REDELIVER_MS;
  assert.equal(restored.take(b).length, 0);
  assert.equal(restored.messages[0]!.delivered, true);
});

test('Stop reason waits for the following event, while a successful push confirms immediately', () => {
  const board = new Board(null);
  const a = board.touch('a', '', 'claude').session;
  const b = board.touch('b', '', 'claude').session;
  board.send(a, b.name, 'arrived at Stop');
  assert.equal((handleHook(board, 'claude', { session_id: 'b', hook_event_name: 'Stop' }) as { decision: string }).decision, 'block');
  assert.equal(board.messages[0]!.delivered, false);
  handleHook(board, 'claude', { session_id: 'b', hook_event_name: 'PostToolUse' });
  assert.equal(board.messages[0]!.delivered, true);
  board.send(a, b.name, 'push');
  markWoken(board, b, board.messages.filter(m => !m.delivered));
  assert.equal(board.messages.at(-1)!.delivered, true);
});

test('ending without confirmation bounces shown mail; confirmed mail does not bounce', () => {
  const board = new Board(null);
  const a = board.touch('a', '', 'claude').session;
  const b = board.touch('b', '', 'claude').session;
  board.send(a, b.name, 'lost offer');
  board.take(b);
  board.end(b.id);
  assert.match(board.take(a)[0]!.text, /closed without reading/);
});
