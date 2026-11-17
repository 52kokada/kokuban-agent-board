import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Board } from '../src/board.js';
import { handleHook } from '../src/hooks.js';
import { wakeCodex, wakeMail, reconcileKimiInterrupts, canWake } from '../src/wake.js';

test('Kimi observation-only SessionStart leaves first-contact guidance for the prompt', () => {
  const board = new Board(null);
  assert.equal(handleHook(board, 'kimi', { session_id: 'kimi-first', hook_event_name: 'SessionStart' }), null);
  const result = handleHook(board, 'kimi', { session_id: 'kimi-first', hook_event_name: 'UserPromptSubmit', prompt: 'Check the board.' });
  assert.match(JSON.stringify(result), /You are/);
});

test('Codex can recover after more than three transient queue failures', async () => {
  let now = Date.now();
  const board = new Board(null, () => now);
  const sender = board.touch('retry-sender', '', 'claude').session;
  const s = board.touch('codex-four-failures', '', 'codex').session;
  s.state = 'idle';
  board.send(sender, s.name, 'Retry after the daemon recovers.');
  let child = new EventEmitter();
  const launch = (() => child) as unknown as typeof import('node:child_process').spawn;
  const states = async () => new Map([[s.id, 'idle']]);
  for (let i = 0; i < 4; i++) {
    child = new EventEmitter();
    await wakeCodex(board, 'codex.exe', launch, states);
    child.emit('exit', 1);
    assert.equal(canWake(s, () => 'codex.exe', () => now), false);
    now += Math.min(120_000, 30_000 * (i + 1)) + 1;
  }
  assert.equal(canWake(s, () => 'codex.exe', () => now), true);
  child = new EventEmitter();
  await wakeCodex(board, 'codex.exe', launch, states);
  child.emit('exit', 0);
  assert.equal(board.messages[0]!.delivered, true);
});

test('missed Kimi Interrupt is recovered from its journal, without pausing a later turn', () => {
  const now = Date.now();
  const board = new Board(null, () => now);
  const s = board.touch('kimi-old-process', '', 'kimi').session;
  s.seen = now - 60_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-interrupt-'));
  const file = path.join(dir, 'wire.jsonl');
  try {
    const abort = { type: 'turn.cancel', agentId: 'main', reason: 'user_cancelled', time: now - 50_000 };
    fs.writeFileSync(file, JSON.stringify(abort) + '\n' + JSON.stringify({ type: 'agent.turn.started', time: now - 40_000 }) + '\n');
    reconcileKimiInterrupts(board, () => file);
    assert.equal(s.state, 'working');
    fs.writeFileSync(file, JSON.stringify(abort) + '\n');
    reconcileKimiInterrupts(board, () => file);
    assert.equal(s.state, 'idle');
    assert.equal(s.work, 'paused');
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('a Kimi turn that ended after a Stop handed over mail goes idle from its journal, and fresh mail wakes it', () => {
  let now = Date.now();
  const board = new Board(null, () => now);
  const sender = board.touch('journal-sender', '', 'claude').session;
  const s = board.touch('kimi-stop-once', '', 'kimi').session;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-turn-end-'));
  const file = path.join(dir, 'wire.jsonl');
  const write = (...events: object[]) => fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  try {
    handleHook(board, 'kimi', { session_id: s.id, hook_event_name: 'UserPromptSubmit', prompt: 'Do the first task.' });
    board.send(sender, s.name, 'Arrives while the turn runs.');
    // Kimi's one Stop for this prompt hands the mail over and keeps the turn going.
    const stop = handleHook(board, 'kimi', { session_id: s.id, hook_event_name: 'Stop' }) as { decision?: string };
    assert.equal(stop.decision, 'block');
    assert.equal(s.state, 'working');
    const stopped = now;
    now += 40_000;
    const followUp = { type: 'agent.turn.started', turnId: 2, time: stopped + 100 };
    // The follow-up turn still runs: nothing is concluded from silence.
    write({ type: 'turn.ended', agentId: 'main', reason: 'completed', time: stopped - 60_000 }, followUp);
    reconcileKimiInterrupts(board, () => file);
    assert.equal(s.state, 'working');
    // An end from before the board last heard from the session is an earlier prompt's.
    write({ type: 'turn.ended', agentId: 'main', reason: 'completed', time: stopped - 60_000 });
    reconcileKimiInterrupts(board, () => file);
    assert.equal(s.state, 'working');
    // A subagent's end, or a turn that did not complete, is not the session's end.
    write(followUp, { type: 'turn.ended', agentId: 'sub-1', reason: 'completed', time: stopped + 20_000 },
      { type: 'turn.ended', agentId: 'main', reason: 'failed', time: stopped + 20_000 });
    reconcileKimiInterrupts(board, () => file);
    assert.equal(s.state, 'working');
    write(followUp, { type: 'agent.turn.ended', turnId: 2, outcome: 'done', time: stopped + 20_000 },
      { type: 'turn.ended', agentId: 'main', reason: 'completed', time: stopped + 20_000 });
    reconcileKimiInterrupts(board, () => file);
    assert.equal(s.state, 'idle');
    assert.notEqual(s.work, 'paused');
    board.send(sender, s.name, 'Arrives after the unreported end.');
    assert.equal(wakeMail(board, s).length, 1, 'mail sent after the turn really ended wakes the session');
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('a Kimi session whose process was killed mid-turn stops showing as working, and mail can resume it', () => {
  let now = Date.now();
  const board = new Board(null, () => now);
  const sender = board.touch('killed-sender', '', 'claude').session;
  const s = board.touch('kimi-session_killed', '', 'kimi').session;
  handleHook(board, 'kimi', { session_id: s.id, hook_event_name: 'UserPromptSubmit', prompt: 'Start a long task.' });
  const noJournal = () => '';
  // Kimi's lock for the prompt, held by a live process: the turn runs, however long it is silent.
  now += 40 * 60_000;
  reconcileKimiInterrupts(board, noJournal, () => process.pid);
  assert.equal(s.state, 'working');
  // No lock at all proves nothing either.
  reconcileKimiInterrupts(board, noJournal, () => null);
  assert.equal(s.state, 'working');
  // The lock is still there but its process is gone: a process id far above any in use.
  reconcileKimiInterrupts(board, noJournal, () => 4_194_301);
  assert.equal(s.state, 'idle');
  assert.equal(s.work, 'blocked');
  assert.match(s.next ?? '', /ended in the middle of a turn/);
  board.send(sender, s.name, 'Sent after the window died.');
  assert.equal(wakeMail(board, s).length, 1);
});

test('Kimi interruption pauses without consuming mail, and a human prompt resumes tracking', () => {
  const board = new Board(null);
  const sender = board.touch('sender', '', 'codex').session;
  const s = board.touch('kimi-interrupted', 'C:/repo', 'kimi').session;
  board.send(sender, s.name, 'Please check this when resumed.');
  board.take(s);
  handleHook(board, 'kimi', { session_id: s.id, hook_event_name: 'Interrupt' });
  assert.equal(s.state, 'idle');
  assert.equal(s.work, 'paused');
  assert.equal(board.messages[0]!.delivered, false);
  assert.equal(wakeMail(board, s).length, 0);
  handleHook(board, 'kimi', { session_id: s.id, hook_event_name: 'SessionStart' });
  assert.equal(s.work, 'paused');
  handleHook(board, 'kimi', { session_id: s.id, hook_event_name: 'UserPromptSubmit', prompt: 'Resume and check the board.' });
  assert.equal(s.state, 'working');
  assert.equal(s.work, 'active');
  assert.equal(board.messages[0]!.delivered, false, 'a cancelled offer must be shown again before confirmation');
  handleHook(board, 'kimi', { session_id: s.id, hook_event_name: 'PostToolUse' });
  assert.equal(board.messages[0]!.delivered, true);
});

test('Kimi errors leave an idle blocked session and observation hooks never offer new mail', () => {
  const board = new Board(null);
  const sender = board.touch('sender', '', 'codex').session;
  const s = board.touch('kimi-failed', '', 'kimi').session;
  board.send(sender, s.name, 'Pending mail.');
  assert.equal(handleHook(board, 'kimi', { session_id: s.id, hook_event_name: 'PostToolUse' }), null);
  assert.equal(board.messages[0]!.shownAt, undefined);
  handleHook(board, 'kimi', { session_id: s.id, hook_event_name: 'StopFailure' });
  assert.equal(s.state, 'idle');
  assert.equal(s.work, 'blocked');
  assert.equal(board.messages[0]!.delivered, false);
});

test('Codex queue requests resume, keeps exact identity and confirms only a successful queue', async () => {
  let now = Date.now();
  const board = new Board(null, () => now);
  const sender = board.touch('sender', '', 'claude').session;
  const s = board.touch('codex-recovery', '', 'codex').session;
  s.state = 'idle';
  board.send(sender, s.name, 'Read your board.');
  let child = new EventEmitter();
  let calls = 0;
  const launch = ((exe: string, args: string[], options: any) => {
    calls++;
    assert.deepEqual(args.slice(0, 5), ['queue', '--resume', '--thread', s.id, '--message']);
    assert.equal(options.windowsHide, true);
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  const states = async () => new Map([[s.id, 'idle']]);
  s.work = 'paused';
  await wakeCodex(board, 'codex.exe', launch, states);
  assert.equal(calls, 0);
  s.work = 'active';
  await wakeCodex(board, 'codex.exe', launch, states);
  child.emit('error', new Error('temporarily unavailable'));
  child.emit('exit', 1);
  assert.equal(board.messages[0]!.delivered, false);
  await wakeCodex(board, 'codex.exe', launch, states);
  assert.equal(calls, 1, 'failed queues back off');
  now += 30_001;
  child = new EventEmitter();
  await wakeCodex(board, 'codex.exe', launch, states);
  child.emit('exit', 0);
  assert.equal(calls, 2);
  assert.equal(board.messages[0]!.delivered, true);
});
