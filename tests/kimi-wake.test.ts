import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { handleHook } from '../src/hooks.js';
import { KIMI_WAKE_LINE } from '../src/kimi-console.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KIMI_TYPED_MS, canWake, kimiPromptRunning, wakeKimi } from '../src/wake.js';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const noLaunch = (() => { throw new Error('a session with an open window must not start a hidden Kimi'); }) as unknown as typeof import('node:child_process').spawn;
const text = (out: unknown): string => (out as any)?.hookSpecificOutput?.additionalContext ?? '';

/** A Kimi session whose own prompt hook named its open window, then went idle. */
function openWindow(board: Board, id: string, pid = 4242) {
  handleHook(board, 'kimi', { session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'hello there, first human prompt', console_pid: pid });
  handleHook(board, 'kimi', { session_id: id, hook_event_name: 'Stop' });
  return board.sessions.find((s) => s.id === id)!;
}

test('D130: an open Kimi window is woken by a typed line, and its prompt hook hands over the mail', async () => {
  const board = new Board(null);
  const sender = board.touch('sender', '', 'codex').session;
  const target = openWindow(board, 'kimi-session_visible');
  assert.equal(target.kimiConsole, 4242);
  assert.equal(target.state, 'idle');
  board.send(sender, target.name, 'Please report the visible test result.');
  const typed: Array<[number, string]> = [];
  const type = async (pid: number, line: string) => { typed.push([pid, line]); return true; };
  wakeKimi(board, 'kimi.exe', noLaunch, type);
  await settle();
  wakeKimi(board, 'kimi.exe', noLaunch, type);
  await settle();
  assert.deepEqual(typed, [[4242, KIMI_WAKE_LINE]], 'one typed line, never a second while the first is on its way');
  assert.equal(board.messages[0]!.delivered, false, 'typing is not delivery');
  // The line Kimi submits starts an ordinary turn in the window: its hook carries the framed mail.
  const out = handleHook(board, 'kimi', { session_id: target.id, hook_event_name: 'UserPromptSubmit', prompt: KIMI_WAKE_LINE, console_pid: 4242 });
  assert.match(text(out), /Please report the visible test result/);
  assert.match(text(out), /kokuban woke this idle session/);
  assert.equal(target.kimiTyped, undefined);
  assert.equal(target.prompt, 'hello there, first human prompt', 'the wake line is not the human speaking');
  assert.equal(board.messages[0]!.delivered, false, 'offered now, confirmed by the next hook');
  handleHook(board, 'kimi', { session_id: target.id, hook_event_name: 'Stop' });
  assert.equal(board.messages[0]!.delivered, true);
});

test('a Kimi session still inside a prompt is neither typed into nor resumed hidden; the mail waits', async () => {
  const board = new Board(null);
  const sender = board.touch('sender', '', 'codex').session;
  const target = openWindow(board, 'kimi-session_midprompt');
  board.send(sender, target.name, 'Arrives between two turns of one prompt.');
  let typed = 0;
  const type = async () => { typed++; return true; };
  // The Stop hook fired, but Kimi's lock says the prompt still runs.
  wakeKimi(board, 'kimi.exe', noLaunch, type, () => true);
  await settle();
  assert.equal(typed, 0);
  assert.equal(target.kimiTyped, undefined);
  assert.equal(target.kimiConsole, 4242, 'the window is not forgotten');
  assert.equal(board.messages[0]!.shownAt, undefined, 'the mail was not offered');
  // The same holds for a session with no known window: no hidden process that can only be refused.
  delete target.kimiConsole;
  wakeKimi(board, 'kimi.exe', noLaunch, type, () => true);
  target.kimiConsole = 4242;
  // The prompt ended: the next pass wakes the window.
  wakeKimi(board, 'kimi.exe', noLaunch, type, () => false);
  await settle();
  assert.equal(typed, 1);
});

test('a Kimi prompt is running only while a live process holds the session lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-locks-'));
  const lock = (pid: unknown) => fs.writeFileSync(path.join(dir, 'session_locked.lock'), JSON.stringify({ version: 1, pid }));
  try {
    assert.equal(kimiPromptRunning('kimi-session_locked', dir), false, 'no lock: the session is between prompts');
    lock(process.pid);
    assert.equal(kimiPromptRunning('kimi-session_locked', dir), true);
    assert.equal(kimiPromptRunning('kimi-session_other', dir), false);
    assert.equal(kimiPromptRunning('kimi-../session_locked', dir), false);
    // A killed Kimi leaves its lock behind: a process id far above any in use stands for the dead holder.
    lock(4_194_301);
    assert.equal(kimiPromptRunning('kimi-session_locked', dir), false, 'a dead holder is not a running prompt');
    lock('not a pid');
    assert.equal(kimiPromptRunning('kimi-session_locked', dir), false);
    fs.writeFileSync(path.join(dir, 'session_locked.lock'), '{ broken');
    assert.equal(kimiPromptRunning('kimi-session_locked', dir), false);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('a sender is told a Kimi session inside a prompt cannot be woken now', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-home-'));
  const before = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  try {
    const board = new Board(null);
    const target = openWindow(board, 'kimi-session_receipt');
    assert.equal(canWake(target), true);
    fs.mkdirSync(path.join(home, 'locks', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, 'locks', 'sessions', 'session_receipt.lock'), JSON.stringify({ pid: process.pid }));
    assert.equal(canWake(target), false);
  } finally {
    if (before === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = before;
    fs.rmSync(home, { recursive: true });
  }
});

test('D130: a closed window is forgotten and the session falls back to the hidden resume', async () => {
  const board = new Board(null);
  const sender = board.touch('sender', '', 'codex').session;
  const target = openWindow(board, 'kimi-session_closed');
  board.send(sender, target.name, 'Fallback mail.');
  wakeKimi(board, 'kimi.exe', noLaunch, async () => false);
  await settle();
  assert.equal(target.kimiConsole, undefined);
  assert.equal(target.kimiTyped, undefined);
  assert.equal(board.messages[0]!.shownAt, undefined, 'the mail is queued again');
  assert.equal(target.state, 'idle');
  let launched = 0;
  const child = new EventEmitter();
  wakeKimi(board, 'kimi.exe', (() => { launched++; return child; }) as unknown as typeof import('node:child_process').spawn, async () => true);
  assert.equal(launched, 1);
});

test('D130: a typed line that never arrives puts the mail back, and no receipt counts unseen mail as read', async () => {
  let now = Date.now();
  const board = new Board(null, () => now);
  const sender = board.touch('sender', '', 'codex').session;
  const target = openWindow(board, 'kimi-session_lost');
  board.send(sender, target.name, 'Mail behind a dialog.');
  let typed = 0;
  const type = async () => { typed++; return true; };
  wakeKimi(board, 'kimi.exe', noLaunch, type);
  await settle();
  // A tool step or stop before the line arrives must not confirm mail the model never saw.
  handleHook(board, 'kimi', { session_id: target.id, hook_event_name: 'PostToolUse' });
  assert.equal(board.messages[0]!.delivered, false);
  target.state = 'idle';
  now += KIMI_TYPED_MS + 1;
  wakeKimi(board, 'kimi.exe', noLaunch, type);
  assert.equal(target.kimiTyped, undefined);
  assert.equal(board.messages[0]!.delivered, false);
  wakeKimi(board, 'kimi.exe', noLaunch, type);
  assert.equal(typed, 1, 'the retry waits');
  // The human's own next prompt reads the mail as ordinary mail.
  const out = handleHook(board, 'kimi', { session_id: target.id, hook_event_name: 'UserPromptSubmit', prompt: 'what is going on with the board?' });
  assert.match(text(out), /Mail behind a dialog/);
});

test('D130: a human prompt that arrives instead of the typed line still reads the announced mail', async () => {
  const board = new Board(null);
  const sender = board.touch('sender', '', 'codex').session;
  const target = openWindow(board, 'kimi-session_draft');
  board.send(sender, target.name, 'Announced mail.');
  wakeKimi(board, 'kimi.exe', noLaunch, async () => true);
  await settle();
  const out = handleHook(board, 'kimi', { session_id: target.id, hook_event_name: 'UserPromptSubmit', prompt: 'my own words, typed first' });
  assert.match(text(out), /Announced mail/);
  assert.equal(target.kimiTyped, undefined);
});

test('D130: one window holds one session; a hidden wake never reports a window', () => {
  const board = new Board(null);
  const a = openWindow(board, 'kimi-session_a', 777);
  const b = openWindow(board, 'kimi-session_b', 777);
  assert.equal(a.kimiConsole, undefined);
  assert.equal(b.kimiConsole, 777);
  handleHook(board, 'kimi', { session_id: b.id, hook_event_name: 'UserPromptSubmit', prompt: 'x', console_pid: -3 });
  assert.equal(b.kimiConsole, 777, 'an invalid pid changes nothing');
});

test('Kimi resumes exact identity once and waits for hook confirmation', () => {
  const board = new Board(null);
  const sender = board.touch('sender', '', 'codex').session;
  const target = board.touch('kimi-session_123', 'C:/repo', 'kimi').session;
  target.state = 'idle';
  board.send(sender, target.name, 'Please report the test result.');
  const child = new EventEmitter();
  let calls = 0;
  const launch = ((exe: string, args: string[], options: any) => {
    calls++;
    assert.equal(exe, 'kimi.exe');
    assert.deepEqual(args.slice(0, 3), ['--session', 'session_123', '--prompt']);
    assert.match(args[3]!, /Please report the test result/);
    assert.equal(options.cwd, 'C:/repo');
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.KOKUBAN_KIMI_WAKE, '1');
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  wakeKimi(board, 'kimi.exe', launch);
  wakeKimi(board, 'kimi.exe', launch);
  assert.equal(calls, 1);
  assert.equal(board.messages[0]!.delivered, false);
  handleHook(board, 'kimi', { session_id: target.id, hook_event_name: 'UserPromptSubmit', prompt: '<kokuban-message>test</kokuban-message>' });
  assert.equal(board.messages[0]!.delivered, true);
  handleHook(board, 'kimi', { session_id: target.id, hook_event_name: 'Stop' });
  child.emit('exit', 0);
  assert.equal(target.state, 'idle');
  assert.equal(target.continues, 1);
});

test('Kimi failure retains mail, backs off, and never wakes paused or closed sessions', () => {
  let now = Date.now();
  const board = new Board(null, () => now);
  const sender = board.touch('sender', '', 'codex').session;
  const target = board.touch('kimi-retry', '', 'kimi').session;
  target.state = 'idle';
  board.send(sender, target.name, 'Retry this mail.');
  const child = new EventEmitter();
  let calls = 0;
  const launch = (() => { calls++; return child; }) as unknown as typeof import('node:child_process').spawn;
  wakeKimi(board, 'kimi.exe', launch);
  child.emit('error', new Error('busy'));
  child.emit('exit', 1);
  assert.equal(board.messages[0]!.delivered, false);
  assert.equal(board.messages[0]!.shownAt, undefined);
  assert.equal(target.state, 'idle');
  assert.equal(target.continues, 0);
  wakeKimi(board, 'kimi.exe', launch);
  assert.equal(calls, 1);
  now += 31_000;
  target.work = 'paused';
  wakeKimi(board, 'kimi.exe', launch);
  target.work = 'done'; target.state = 'gone';
  wakeKimi(board, 'kimi.exe', launch);
  assert.equal(calls, 1);
  target.state = 'idle';
  wakeKimi(board, 'kimi.exe', launch);
  assert.equal(calls, 2);
  child.emit('exit', 0);
  assert.equal(target.state, 'idle', 'exit success without a hook receipt is not delivery');
  assert.equal(board.messages[0]!.delivered, false);
});
