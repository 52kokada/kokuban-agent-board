import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Board, BRIEF_MS, CLAIM_MS, cpuBusy, DROP_MS, FORGET_MS, LIVE_MS, QUIET_MS, ROSTER_LIVE_MS } from '../src/board.js';
import { handleHook, MAX_CONTINUES } from '../src/hooks.js';
import { mergeHooks } from '../src/install.js';
import { handleBridge } from '../src/bridge.js';
import { liveClaudeIds, reapClaude, reapCodex, canWake, waitClaude, wakeMail, wakeText, WAKE_FRESH_MS } from '../src/wake.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function room(): { board: Board; tick: (ms: number) => void } {
  let now = 1_000_000;
  return { board: new Board(null, () => now), tick: (ms) => { now += ms; } };
}

const ctx = (out: object | null): string =>
  (out as { hookSpecificOutput?: { additionalContext?: string } } | null)?.hookSpecificOutput?.additionalContext ?? '';

test('every session gets its own name, kept for its lifetime', () => {
  const { board } = room();
  const names = new Set(Array.from({ length: 90 }, (_, i) => board.touch(`s${i}`, '', 'claude').session.name));
  assert.equal(names.size, 90);
  assert.equal(board.touch('s0', '', 'claude').isNew, false);
  assert.ok(names.has(board.touch('s0', '', 'claude').session.name));
});

test('only present sessions hold a name; one that returns keeps its own unless it was taken', () => {
  const { board, tick } = room();
  const first = Array.from({ length: 400 }, (_, i) => board.touch(`s${i}`, '', 'claude').session.name);
  for (let i = 1; i < 400; i++) board.end(`s${i}`);
  assert.doesNotMatch(board.touch('t', '', 'claude').session.name, /\d/);
  assert.deepEqual(board.touch('s1', '', 'claude'), { session: board.sessions[1], isNew: false });
  assert.equal(board.sessions[1]!.name, first[1]);

  tick(LIVE_MS);
  const taker = board.touch('u', '', 'claude').session;
  taker.name = first[0]!;
  const back = board.touch('s0', '', 'claude');
  assert.equal(back.isNew, true);
  assert.notEqual(back.session.name, first[0]);
  assert.equal(board.byName(first[0]!), taker);

  tick(FORGET_MS);
  board.touch('v', '', 'claude');
  assert.deepEqual(board.sessions.map((s) => s.id), ['v']);
});

test('a message is delivered once, to the session it names', () => {
  const { board } = room();
  const a = board.touch('a', '', 'claude').session;
  const b = board.touch('b', '', 'codex').session;
  assert.match(board.send(a, b.name.toUpperCase(), 'rebase before you merge'), /^sent to/);
  assert.equal(board.take(a).length, 0);
  assert.equal(board.take(b)[0]!.text, 'rebase before you merge');
  assert.equal(board.take(b).length, 0);
  assert.match(board.send(a, 'Nobody', 'hi'), /nothing sent/);
  assert.match(board.send(a, a.name, 'hi'), /nothing sent/);
});

test('"all" reaches the sender\'s repository; "everyone" reaches every live session', () => {
  const { board } = room();
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => board.touch(id, '', 'claude').session);
  a!.where = 'prompt@session-a';
  b!.where = 'prompt@session-b';
  c!.where = 'acme@main';
  board.end('d');
  board.setDoing(a!, 'Session A: viewer repairs');

  board.send(a!, 'all', 'main is red');
  const broadcast = board.take(b!)[0]!;
  assert.equal(broadcast.fromLabel, 'claude · prompt@session-a — Session A: viewer repairs');
  assert.match(board.header(broadcast), /; sent to every session in prompt\)$/);
  assert.equal(board.take(c!).length, 0);
  assert.match(board.send(c!, 'all', 'anyone?'), /no other session is working in acme.*everyone/);

  assert.match(board.send(a!, `${b!.name}, ${c!.name}`, 'patch is ready'), /sent to .*; sent to /);
  assert.match(board.header(board.take(b!)[0]!), new RegExp(`viewer repairs; also sent to ${c!.name}\\)$`));
  assert.equal(board.take(c!).length, 1);
  assert.match(board.send(a!, `${b!.name}, Nobody`, 'x'), /nothing sent: no other session is named "Nobody"/);
  assert.equal(board.take(b!).length, 0);

  board.send(a!, 'everyone', 'rule from the human');
  assert.equal(board.take(b!).length + board.take(c!).length, 2);
  assert.equal(board.take(d!).length, 0);
});

test('a claim blocks others until released, ended, or its holder goes silent', () => {
  const { board, tick } = room();
  const a = board.touch('a', '', 'claude').session;
  const b = board.touch('b', '', 'codex').session;
  assert.match(board.claim(a, 'Port:3000', 'dev server'), /^yours/);
  assert.match(board.claim(b, 'port:3000', ''), new RegExp(`held by ${a.name}.*dev server`));
  assert.match(board.claim(a, 'port:3000', ''), /^yours/);
  board.release(a, '');
  assert.match(board.claim(b, 'port:3000', ''), /^yours/);
  tick(CLAIM_MS + 1);
  assert.match(board.claim(board.touch('a', '', 'claude').session, 'port:3000', ''), /^yours/);
});

test('waiting on the inbox ends when mail arrives', async () => {
  const { board } = room();
  const a = board.touch('a', '', 'claude').session;
  const b = board.touch('b', '', 'claude').session;
  const waiting = board.wait(b, 5000);
  board.send(a, b.name, 'done');
  await waiting;
  assert.equal(board.take(b).length, 1);
});

test('a session first seen at any hook is introduced, then only hears news', () => {
  const { board } = room();
  const first = ctx(handleHook(board, 'claude', { hook_event_name: 'PostToolUse', session_id: 'a', cwd: '' }));
  assert.match(first, /You are "/);
  assert.equal(handleHook(board, 'claude', { hook_event_name: 'PostToolUse', session_id: 'a' }), null);
  assert.equal(handleHook(board, 'claude', { hook_event_name: 'UserPromptSubmit', session_id: 'a' }), null);

  const b = board.touch('b', '', 'codex').session;
  assert.match(ctx(handleHook(board, 'claude', { hook_event_name: 'UserPromptSubmit', session_id: 'a' })),
    new RegExp(`Joined: ${b.name}`));
  assert.equal(handleHook(board, 'claude', { hook_event_name: 'UserPromptSubmit', session_id: 'a' }), null);
  board.end('b');
  assert.match(ctx(handleHook(board, 'claude', { hook_event_name: 'UserPromptSubmit', session_id: 'a' })),
    new RegExp(`Left: ${b.name}`));
});

test('SessionStart titles a new Claude session with its name, never a renamed one', () => {
  const { board } = room();
  const start = (id: string, extra: object) => handleHook(board, 'claude',
    { hook_event_name: 'SessionStart', session_id: id, source: 'startup', ...extra }) as
    { hookSpecificOutput: { sessionTitle?: string } };
  const name = board.touch('a', '', 'claude').session.name;
  board.end('a');
  assert.equal(start('a', { source: 'resume', session_title: 'my own title' })?.hookSpecificOutput.sessionTitle, undefined);
  assert.equal(start('a', { source: 'resume', session_title: name }).hookSpecificOutput.sessionTitle, name);
  assert.ok(start('fresh', { session_title: 'repo-e1' }).hookSpecificOutput.sessionTitle);
  assert.equal(start('a', { source: 'compact' })?.hookSpecificOutput.sessionTitle, undefined);
});

test('mail arriving at Stop keeps the turn alive, up to a limit', () => {
  const { board, tick } = room();
  const a = board.touch('a', '', 'claude').session;
  const b = board.touch('b', '', 'codex').session;
  const stop = () => handleHook(board, 'codex', { hook_event_name: 'Stop', session_id: 'b' }) as
    { decision?: string; reason?: string } | null;

  assert.equal(stop(), null);
  assert.equal(b.state, 'idle');
  for (let i = 0; i < MAX_CONTINUES; i++) {
    tick(60_001); // Exercise continuation limits independently of the ten-minute loop guard.
    board.send(a, b.name, `note ${i}`);
    assert.equal(stop()!.decision, 'block');
  }
  board.send(a, b.name, 'one too many');
  assert.equal(stop(), null);
  assert.match(ctx(handleHook(board, 'codex', { hook_event_name: 'UserPromptSubmit', session_id: 'b' })), /one too many/);
  board.send(a, b.name, 'after the human spoke');
  assert.equal(stop()!.decision, 'block');
});

test('a session is shown with what it is achieving, in its own words once it says', () => {
  const { board } = room();
  const a = board.touch('a', '', 'claude').session;
  const b = board.touch('b', '', 'codex').session;
  assert.doesNotMatch(board.roster(a), /—/);

  handleHook(board, 'claude', { hook_event_name: 'UserPromptSubmit', session_id: 'b', prompt: 'fix the flaky capture test' });
  assert.match(board.roster(a), /— asked: "fix the flaky capture test"/);
  handleHook(board, 'claude', { hook_event_name: 'UserPromptSubmit', session_id: 'b', prompt: 'yes pls' });
  handleHook(board, 'claude', { hook_event_name: 'UserPromptSubmit', session_id: 'b', prompt: '<task-notification>a background task finished</task-notification>' });
  assert.match(board.roster(a), /flaky capture test/);

  board.setDoing(b, '  Stabilising   capture tests ');
  assert.match(board.roster(a), /working\) — Stabilising capture tests$/);

  b.prompt = '[kokuban] Message from Thorn (codex): take over';
  b.doing = '';
  assert.doesNotMatch(board.roster(a), /—/);
});

test('a session introduced under older guidance hears the current guidance, once', () => {
  const { board } = room();
  const a = board.touch('a', '', 'codex').session;
  const tool = (id: string) => ctx(handleHook(board, 'codex', { hook_event_name: 'PostToolUse', session_id: id }));
  assert.match(tool('a'), /Updated guidance[\s\S]*Message a peer only to save work[\s\S]*record peers\(work=/);
  assert.equal(tool('a'), '');
  assert.equal(a.rules, 14);

  a.rules = 2;
  const delta = tool('a');
  assert.match(delta, /never squeeze words together[\s\S]*take it as theirs: do the work/);
  assert.doesNotMatch(delta, /Look before you ask/);

  board.touch('b', '', 'codex').session.doing = 'already described';
  assert.match(tool('b'), /Updated guidance/);
  board.touch('c', '', 'codex').session.doing = 'already described';
  assert.doesNotMatch(tool('c'), /record what this session/);
});

test("a subagent's tool calls do not swallow its parent's mail", () => {
  const { board } = room();
  const a = board.touch('a', '', 'claude').session;
  const b = board.touch('b', '', 'claude').session;
  board.send(a, b.name, 'for the parent');
  assert.equal(handleHook(board, 'claude', { hook_event_name: 'PostToolUse', session_id: 'b', agent_id: 'x' }), null);
  assert.match(ctx(handleHook(board, 'claude', { hook_event_name: 'PostToolUse', session_id: 'b' })), /for the parent/);
});

test('SessionEnd takes a session off the board and frees what it held', () => {
  const { board } = room();
  const a = board.touch('a', '', 'claude').session;
  const b = board.touch('b', '', 'claude').session;
  board.claim(a, 'merge:main', '');
  handleHook(board, 'claude', { hook_event_name: 'SessionEnd', session_id: 'a' });
  assert.equal(board.others(b).length, 0);
  assert.match(board.claim(b, 'merge:main', ''), /^yours/);
});

test('installing replaces our hooks and keeps everyone else\'s', () => {
  const theirs = { type: 'command', command: 'guard.ps1' };
  const ours = { type: 'http', url: 'http://127.0.0.1:47600/hook/claude' };
  const merged = mergeHooks(
    { PreToolUse: [{ matcher: 'x', hooks: [theirs] }], Stop: [{ hooks: [ours] }, { hooks: [theirs] }] },
    { Stop: [ours] },
  );
  assert.deepEqual(merged.PreToolUse, [{ matcher: 'x', hooks: [theirs] }]);
  assert.deepEqual(merged.Stop, [{ hooks: [theirs] }, { hooks: [ours] }]);
  assert.deepEqual(mergeHooks(merged, {}).Stop, [{ hooks: [theirs] }]);
});

test('an idle session is woken for fresh direct mail only, and only so many times', async () => {
  const { board, tick } = room();
  const a = board.touch('a', '', 'claude').session;
  const b = board.touch('b', '', 'claude').session;
  a.where = b.where = 'prompt@main';
  const poll = (first = false, waiter = 'w1') => waitClaude(board, { session_id: 'b', waiter, first }, () => false, 50);

  board.send(a, b.name, 'while you work');
  assert.equal(wakeMail(board, b).length, 0);
  assert.match(board.send(a, b.name, 'x'), /working: it reads this at its next step/);
  board.take(b);

  handleHook(board, 'claude', { hook_event_name: 'Stop', session_id: 'b' });
  board.send(a, 'all', 'a broadcast');
  assert.equal((await poll(true)).status, 202);
  board.take(b);

  assert.match(board.send(a, b.name, 'your patch broke main'), /idle: queued for wake/);
  const woke = await poll();
  assert.equal(woke.status, 200);
  assert.match(woke.text!, /your patch broke main[\s\S]*act on it as their work/);
  assert.equal(b.state, 'working');
  assert.equal(b.continues, 1);

  handleHook(board, 'claude', { hook_event_name: 'UserPromptSubmit', session_id: 'b' });
  assert.equal(b.continues, 1);
  handleHook(board, 'claude', { hook_event_name: 'Stop', session_id: 'b' });

  board.send(a, b.name, 'old news');
  tick(WAKE_FRESH_MS + 1);
  assert.equal((await poll()).status, 202);
  board.take(b);

  board.send(a, b.name, 'second hook takes over');
  assert.equal((await poll(false, 'stale')).status, 204);
  assert.equal((await poll(true, 'w2')).status, 200);

  b.state = 'idle';
  b.continues = MAX_CONTINUES;
  board.send(a, b.name, 'over the limit');
  assert.equal((await poll(false, 'w2')).status, 202);
  tick(30_000);
  handleHook(board, 'claude', { hook_event_name: 'UserPromptSubmit', session_id: 'b' });
  assert.equal(b.continues, 0);
});

test('mail from another PC wakes an idle session only with memory to spare, and is not taken for the human\'s wish', async () => {
  const { board } = room();
  let roomy = false;
  board.hasRoom = () => roomy;
  const a = board.touch('a', '', 'claude').session;
  const b = board.touch('far-b', '', 'claude').session;
  // A local session that shares the remote sender's name must not lend it a transcript.
  a.name = 'Wren';
  // Keep the receiver distinct: its random initial name can also be Wren, which
  // would send the probe to the working local sender instead of the idle receiver.
  b.name = 'FarReceiver';
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-')), 'a.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'ship the release tonight' } })}\n`);
  a.transcript = file;
  handleHook(board, 'claude', { hook_event_name: 'Stop', session_id: 'far-b' });
  const poll = (first = false) => waitClaude(board, { session_id: 'far-b', waiter: 'w', first }, () => false, 50);
  const send = (text: string) =>
    handleBridge(board, { op: 'send', to: b.name, text, from: { pc: 'laptop', agent: 'Wren' } }) as { id: number; reach: string };

  // Until its wake hook is listening, nothing can start a turn in an idle Claude session; nor in one that joined by hand.
  assert.equal(send('before the hook listens').reach, 'next_prompt');
  board.take(b);
  b.state = 'idle';
  const byHand = board.touch('manual-1', '', 'other').session;
  byHand.state = 'idle';
  assert.equal((handleBridge(board, { op: 'send', to: byHand.name, text: 'x', source: 'laptop', me: 'Wren' }) as { reach: string }).reach, 'next_prompt');
  const codex = board.touch('codex-1', '', 'codex').session;
  codex.state = 'idle';
  assert.equal(canWake(codex, () => 'codex.exe'), true);
  assert.equal(canWake(codex, () => null), false);
  assert.equal((await poll(true)).status, 202);

  const tight = send('run the benchmark');
  assert.equal(tight.reach, 'waiting_for_resources');
  assert.equal((await poll()).status, 202);
  assert.deepEqual(handleBridge(board, { op: 'receipt', id: tight.id, source: 'laptop', me: 'Wren' }),
    { ok: true, id: tight.id, state: 'queued', reach: 'waiting_for_resources', reach_detail: 'queued until this PC has memory and processor to spare' });

  // Local mail is not held back by memory; the waiting remote message is read along with it.
  board.send(a, b.name, 'lunch?');
  assert.deepEqual(wakeMail(board, b).map((m) => m.text), ['lunch?']);
  assert.equal(board.take(b).length, 2);
  b.state = 'idle';

  roomy = true;
  assert.equal(send('run the benchmark now').reach, 'waking');
  const woke = await poll();
  assert.equal(woke.status, 200);
  assert.match(woke.text!, /run the benchmark now[\s\S]*Message from Wren@laptop/);
  assert.match(woke.text!, /It came from another PC: this board cannot see that session/);
  assert.doesNotMatch(woke.text!, /works for the same human|ship the release/);

  b.state = 'idle';
  board.send(a, b.name, 'local');
  send('far');
  const mixed = wakeText(board, wakeMail(board, b));
  assert.match(mixed, /ship the release tonight[\s\S]*works for the same human[\s\S]*That does not cover the mail from another PC/);

  b.continues = MAX_CONTINUES;
  assert.equal(send('one more').reach, 'next_prompt');
  b.state = 'working';
  assert.equal(send('while working').reach, 'next_step');
});

test('how busy the processors are is known only from two looks a moment apart, and not from an old one', () => {
  let at = 0;
  let times = { user: 0, nice: 0, sys: 0, irq: 0, idle: 0 };
  const busy = cpuBusy(() => [{ times }, { times }] as os.CpuInfo[], () => at);
  const pass = (ms: number, worked: number) => {
    at += ms;
    times = { ...times, user: times.user + worked, idle: times.idle + ms - worked };
  };
  assert.equal(busy(), null);
  pass(100, 100);
  assert.equal(busy(), null);
  pass(200, 200);
  assert.equal(busy(), 1);
  pass(1000, 250);
  assert.equal(busy(), 0.25);
  pass(100, 100);
  assert.equal(busy(), 0.25);
  pass(61_000, 61_000);
  assert.equal(busy(), null);
  pass(300, 0);
  assert.equal(busy(), 0);
  assert.equal(new Board().hasRoom(), false);
});

test('a closed Codex session leaves the board, frees its claims, and gets its name back if reopened', async () => {
  const { board, tick } = room();
  const a = board.touch('a', '', 'claude').session;
  const open = board.touch('codex-open', '', 'codex').session;
  const closed = board.touch('codex-closed', '', 'codex').session;
  const name = closed.name;
  board.claim(closed, 'port:8938', '');

  await reapCodex(board, async () => new Map([['codex-open', 'idle'], ['codex-closed', 'notLoaded']]));
  assert.deepEqual(board.others(a).map((s) => s.name), [open.name]);
  assert.match(board.claim(a, 'port:8938', ''), /^yours/);
  assert.match(board.send(a, name, 'are you there?'), /no other session is named/);

  await reapCodex(board, async () => null);
  assert.equal(board.others(a).length, 1);

  tick(12 * 60 * 60_000);
  const back = board.touch('codex-closed', '', 'codex');
  assert.equal(back.isNew, false);
  assert.equal(back.session.name, name);
  assert.equal(back.session.state, 'working');
});

test('a Claude session whose process died without a goodbye leaves the board', () => {
  const { board, tick } = room();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-sessions-'));
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'running' }));
  fs.writeFileSync(path.join(dir, '999999.json'), JSON.stringify({ pid: 999999, sessionId: 'crashed' }));
  fs.writeFileSync(path.join(dir, '999999.abc.key'), 'not json');
  assert.deepEqual([...liveClaudeIds(dir)!], ['running']);

  const running = board.touch('running', '', 'claude').session;
  const crashed = board.touch('crashed', '', 'claude').session;
  const codex = board.touch('some-codex', '', 'codex').session;
  board.claim(crashed, 'merge:main', '');

  reapClaude(board, liveClaudeIds(dir));
  assert.equal(crashed.state, 'working');
  tick(31_000);
  reapClaude(board, null);
  assert.equal(crashed.state, 'working');
  reapClaude(board, liveClaudeIds(dir));
  assert.equal(crashed.state, 'gone');
  assert.equal(running.state, 'working');
  assert.equal(codex.state, 'working');
  assert.match(board.claim(running, 'merge:main', ''), /^yours/);

  fs.writeFileSync(path.join(dir, 'odd.json'), JSON.stringify({ somethingElse: true }));
  assert.equal(liveClaudeIds(dir), null);
});

test('an hours-old summary does not ask the session to maintain board metadata', () => {
  const { board, tick } = room();
  const a = board.touch('a', '', 'claude').session;
  a.rules = 99;
  board.setDoing(a, 'Session A: viewer repairs');
  const prompt = () => ctx(handleHook(board, 'claude', { hook_event_name: 'UserPromptSubmit', session_id: 'a' }));
  assert.equal(prompt(), '');
  tick(2 * 60 * 60_000 + 1);
  assert.equal(prompt(), '');
  assert.equal(prompt(), '');
  board.setDoing(a, 'Writing the consolidated report');
  tick(60 * 60_000);
  assert.equal(prompt(), '');
});

test('a peer unseen for hours is listed without its summary, and an overlong summary ends at a word', () => {
  const { board, tick } = room();
  const a = board.touch('a', '', 'claude').session;
  const b = board.touch('b', '', 'codex').session;
  board.setDoing(b, `${'word '.repeat(40)}end`);
  assert.ok(b.doing!.length <= 141);
  assert.match(b.doing!, /word…$/);
  assert.match(board.roster(a), /— word/);
  tick(BRIEF_MS + 1);
  board.touch('a', '', 'claude');
  assert.doesNotMatch(board.roster(a), /—/);
  assert.equal(board.roster(a), `${b.name} (codex · quiet 2h)`);
});

test('Codex opening a thread with AGENTS.md is not what its human asked', () => {
  const { board } = room();
  const a = board.touch('a', '', 'claude').session;
  const b = board.touch('b', '', 'codex').session;
  b.prompt = '# AGENTS.md instructions for C:\repo <INSTRUCTIONS>…';
  assert.doesNotMatch(board.roster(a), /AGENTS/);
});

test('a sender hears, once and without being woken, that its reader left with the message unread', () => {
  const { board, tick } = room();
  const a = board.touch('a', '', 'claude').session;
  const b = board.touch('b', '', 'codex').session;
  board.send(a, b.name, 'please take the flaky capture test');
  board.send(b, a.name, 'read before b leaves');
  board.take(a);
  board.end('b');
  const [notice] = board.take(a);
  assert.match(notice!.text, new RegExp(`^${b.name} closed without reading your message "please take the flaky`));
  assert.equal(notice!.direct, undefined);
  board.touch('b', '', 'codex');
  board.end('b');
  assert.equal(board.take(a).length, 0);
  assert.equal(board.take(board.touch('b', '', 'codex').session)[0]!.text, 'please take the flaky capture test');

  tick(QUIET_MS + 1);
  board.touch('a', '', 'claude');
  assert.match(board.send(a, b.name, 'still there?'), /quiet 30m: it may have stopped/);
});

test('the start roster lists live sessions in this repository and counts the rest; hours-quiet or paused ones are dropped', () => {
  const { board, tick } = room();
  const [me, near, idleNear, far, paused, quiet] = ['me', 'near', 'idle', 'far', 'paused', 'quiet'].map((id) => board.touch(id, '', 'claude').session);
  for (const s of [me, near, idleNear, paused, quiet]) s.where = 'kokuban@main';
  far.where = 'acme@main';
  quiet.seen -= DROP_MS;
  paused.work = 'paused';
  paused.seen -= BRIEF_MS;
  idleNear.state = 'idle';
  idleNear.seen -= ROSTER_LIVE_MS + 1;
  near.state = 'working';
  const lean = board.roster(me, true, true);
  assert.ok(lean.includes(`${near.name} (`), lean);
  for (const s of [idleNear, far, paused, quiet]) assert.ok(!lean.includes(s.name), s.name);
  assert.match(lean, /; \+2 others on this PC: use peers to see them$/);
  // peers shows everyone listed, but never the hours-quiet or long-paused sessions.
  const full = board.roster(me);
  for (const s of [near, idleNear, far]) assert.ok(full.includes(s.name), s.name);
  for (const s of [paused, quiet]) assert.ok(!full.includes(s.name), s.name);
  // Alone in the repository: only the count.
  near.where = 'other@main';
  assert.match(board.roster(me, true, true), /(^|Z\. )\+3 others on this PC: use peers to see them$/);
  // A session unseen past LIVE_MS is ended even when host reaping missed it.
  tick(LIVE_MS - DROP_MS);
  board.touch('me', '', 'claude');
  assert.equal(board.reapStale(), 1);
  assert.equal(quiet.state, 'gone');
});

test('a session back after it stopped being live keeps its name unless a live session holds it, and is told when not', () => {
  const { board, tick } = room();
  const a = board.touch('a', '', 'claude').session;
  const original = a.name;
  tick(LIVE_MS);
  // Nobody took it meanwhile: the name stays and nothing is said.
  assert.equal(board.touch('a', '', 'claude').session.name, original);
  assert.equal(a.renamedFrom, undefined);

  // Its own managed reservation does not count as taken.
  a.managed = 'conv-a';
  board.managedNames.set('conv-a', original);
  tick(LIVE_MS);
  assert.equal(board.touch('a', '', 'claude').session.name, original);
  delete a.managed;
  board.managedNames.delete('conv-a');

  // A live session holds it now: renamed, and the next hook says so plainly, once.
  tick(LIVE_MS);
  const taker = board.touch('t', '', 'claude').session;
  taker.name = original;
  const back = ctx(handleHook(board, 'claude', { hook_event_name: 'UserPromptSubmit', session_id: 'a', prompt: 'carry on with the fix please' }));
  assert.notEqual(a.name, original);
  assert.ok(back.includes(`[kokuban] You are now "${a.name}"; "${original}" is in use by another session.`), back);
  assert.ok(!ctx(handleHook(board, 'claude', { hook_event_name: 'PostToolUse', session_id: 'a' })).includes('You are now'));
});
