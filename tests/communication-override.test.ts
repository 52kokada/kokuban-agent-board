import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Board } from '../src/board.js';
import { handleHook } from '../src/hooks.js';
import { canWake, wakeMail } from '../src/wake.js';
import { communicationOverrideUntil, continuationLimit, LOOP_SETTINGS, readLoopLimit } from '../src/loop-limit.js';

test('persistent continuation disable is live, preserves history and does not disable pair or pause guards', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-continuation-'));
  const original = LOOP_SETTINGS.file;
  LOOP_SETTINGS.file = path.join(dir, 'settings.json');
  try {
    const now = Date.now();
    const board = new Board(null, () => now);
    const a = board.touch('a', '', 'claude').session;
    const b = board.touch('b', '', 'codex').session;
    b.state = 'idle'; b.continues = 35;
    board.send(a, b.name, 'retained work');
    assert.equal(wakeMail(board, b).length, 0);
    const count = board.messages.length;
    fs.writeFileSync(LOOP_SETTINGS.file, JSON.stringify({ disableAutomaticContinuationLimit: true }));
    assert.equal(continuationLimit(now), Infinity);
    assert.equal(readLoopLimit(now), 40);
    assert.equal(wakeMail(board, b).length, 1);
    assert.equal(canWake(b, () => 'codex', () => now), true);
    assert.doesNotMatch(board.status(b), /continuation limit reached/);
    fs.writeFileSync(LOOP_SETTINGS.file, JSON.stringify({ disableAutomaticContinuationLimit: true, loopLimit: 2 }));
    assert.equal(readLoopLimit(now), 2);
    board.send(a, b.name, 'second');
    board.send(a, b.name, 'third');
    assert.throws(() => board.send(a, b.name, 'pair guard still active'), /looks like a loop/);
    b.work = 'paused';
    assert.equal(wakeMail(board, b).length, 0);
    assert.equal(canWake(b, () => 'codex', () => now), false);
    assert.equal(handleHook(board, 'codex', { hook_event_name: 'Stop', session_id: 'b' }), null);
    b.work = 'active';
    for (const value of [false, null, 1, 'true', {}, []]) {
      fs.writeFileSync(LOOP_SETTINGS.file, JSON.stringify({ disableAutomaticContinuationLimit: value }));
      assert.equal(continuationLimit(now), 30);
    }
    for (const text of ['null', '[]', 'bad json', '{}']) {
      fs.writeFileSync(LOOP_SETTINGS.file, text);
      assert.equal(continuationLimit(now), 30);
    }
    fs.unlinkSync(LOOP_SETTINGS.file);
    assert.equal(continuationLimit(now), 30);
    assert.equal(b.continues, 35);
    assert.equal(board.messages.length, count + 2);
    assert.equal(canWake(b, () => 'codex', () => now), false);
  } finally {
    LOOP_SETTINGS.file = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime override lifts both guards and expires at the exact instant without restarting or resetting history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-override-'));
  const original = LOOP_SETTINGS.file;
  LOOP_SETTINGS.file = path.join(dir, 'settings.json');
  try {
    const expiry = Date.parse('2026-10-21T08:00:00-07:00');
    let now = expiry - 1000;
    const board = new Board(null, () => now);
    const a = board.touch('a', '', 'claude').session;
    const b = board.touch('b', '', 'codex').session;
    b.state = 'idle'; b.continues = 30;
    fs.writeFileSync(LOOP_SETTINGS.file, JSON.stringify({ loopLimit: 12 }));
    assert.equal(continuationLimit(now), 30);
    assert.equal(readLoopLimit(now), 12);
    board.send(a, b.name, 'queued');
    assert.equal(wakeMail(board, b).length, 0);
    fs.writeFileSync(LOOP_SETTINGS.file, JSON.stringify({ loopLimit: 12, communicationOverrideUntil: expiry }));
    assert.equal(continuationLimit(now), Infinity);
    assert.equal(readLoopLimit(now), Infinity);
    assert.match(board.roster(a), /temporarily lifted until 2026-10-21T15:00:00.000Z/);
    assert.doesNotMatch(board.status(b), /continuation limit reached/);
    assert.equal(wakeMail(board, b).length, 1);
    assert.equal(canWake(b, () => 'codex', () => now), true);
    for (let i = 0; i < 100; i++) board.send(a, b.name, `message ${i}`);
    const stop = () => handleHook(board, 'codex', { hook_event_name: 'Stop', session_id: 'b' });
    assert.equal((stop() as { decision: string }).decision, 'block');
    b.work = 'paused';
    assert.equal(wakeMail(board, b).length, 0);
    assert.equal(canWake(b, () => 'codex', () => now), false);
    b.work = 'active';
    const count = board.messages.length;
    now = expiry;
    assert.equal(communicationOverrideUntil(now), null);
    assert.equal(continuationLimit(now), 30);
    assert.equal(readLoopLimit(now), 12);
    assert.doesNotMatch(board.roster(a), /temporarily lifted/);
    assert.match(board.status({ ...b, state: 'idle' }), /continuation limit reached/);
    assert.equal(canWake(b, () => 'codex', () => now), false);
    assert.throws(() => board.send(a, b.name, 'refused after expiry'), /looks like a loop/);
    assert.equal(stop(), null);
    assert.equal(board.messages.length, count);
    assert.equal(b.continues, 31);
  } finally {
    LOOP_SETTINGS.file = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing, malformed, nonnumeric and expired overrides keep normal limits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-override-'));
  const original = LOOP_SETTINGS.file;
  LOOP_SETTINGS.file = path.join(dir, 'settings.json');
  try {
    for (const value of [null, 'bad json', '{}', '{"communicationOverrideUntil":"9999999999999"}', '{"communicationOverrideUntil":1000}', '{"communicationOverrideUntil":1.5}']) {
      if (value !== null) fs.writeFileSync(LOOP_SETTINGS.file, value);
      assert.equal(communicationOverrideUntil(1000), null);
      assert.equal(continuationLimit(1000), 30);
      assert.equal(readLoopLimit(1000), 40);
    }
  } finally {
    LOOP_SETTINGS.file = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
