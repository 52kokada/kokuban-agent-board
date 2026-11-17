import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { handleBridge } from '../src/bridge.js';

const sender = { pc: 'review.example.ts.net', agent: 'Review' };
const fields = () => ({ question: 'Choose A?', choices: ['A', 'B'], idempotency_key: 'review-key', issued_at: Date.now() });
const ask = async (board: Board, payload: object) => await handleBridge(board, {
  op: 'ask', from: sender, request_id: 'same-request', text: JSON.stringify(payload),
}) as { ok?: boolean; error?: string };

test('legacy request cache cannot bypass keyed payload validation', async () => {
  const board = new Board();
  const input = fields();
  assert.equal((await ask(board, input)).ok, true);
  const retry = await ask(board, { ...input, question: 'Choose DIFFERENT?' });
  assert.equal(retry.ok, false, 'changed keyed payload was accepted by the legacy request cache');
  assert.equal(board.cards.length, 1);
});

test('an unreadable existing snapshot cannot recreate a keyed ask', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-once-review-'));
  const file = path.join(folder, 'board.json');
  fs.writeFileSync(file, '{broken snapshot');
  const board = new Board(file);
  const reply = await ask(board, fields());
  assert.equal(reply.ok, false, 'unreadable receipt state was treated as an empty book');
  assert.equal(board.cards.length, 0);
});

test('ordinary saves cannot erase the damaged-state latch across a second restart', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-once-review-'));
  const file = path.join(folder, 'board.json');
  fs.writeFileSync(file, '{broken snapshot');
  const damaged = new Board(file);
  damaged.touch('ordinary-session', '', 'claude');
  damaged.flush();
  const restarted = new Board(file);
  const reply = await ask(restarted, fields());
  assert.equal(reply.ok, false, 'ordinary persistence cleared lost receipt protection on the next restart');
});

test('a failed explicit repair retains the in-memory refusal', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-once-review-'));
  const file = path.join(folder, 'board.json');
  fs.writeFileSync(file, '{broken snapshot');
  const board = new Board(file);
  board.flush = () => false;
  assert.match(board.forgetLostAsks(), /not repaired/);
  assert.ok(board.loadProblem, 'failed repair cleared the live integrity guard');
  const reply = await ask(board, fields());
  assert.equal(reply.ok, false);
});
