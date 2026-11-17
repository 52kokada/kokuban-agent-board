import test from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../src/board.js';
import { titleFor } from '../src/codex-title.js';
import { reapCodex } from '../src/wake.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeBadge, claudePid, cleanName, syncClaudeBadge } from '../src/terminal-badges.js';
import { titleEnv } from '../src/install.js';

// D125 Claude part: the daemon sets the tab title through the console helper, only when the badge changes.
const decode = (args: string[]): string => Buffer.from(args[2]!, 'base64').toString('utf8');

test('Claude badges are a heart and the name, nothing else', () => {
  assert.equal(claudeBadge('Lark', true), '🧡 Lark');
  assert.equal(claudeBadge('さくら café', false), '🤍 さくら café');
  assert.equal(cleanName('bad\x1bname'), null);
  assert.equal(cleanName('bad⁣name'), null);
  assert.equal(cleanName('Lark'), 'Lark');
});

test('a Claude badge runs the helper once per change, aimed at the session process', async () => {
  const s = new Board().touch('claude-badge-1', '', 'claude').session;
  s.name = 'Lark';
  const calls: string[][] = [];
  const deps = { on: () => true, pid: () => 4242, run: async (a: string[]) => { calls.push(a); return true; } };
  s.state = 'working';
  syncClaudeBadge(s, deps);
  syncClaudeBadge(s, deps); // a tool event with the same badge starts nothing
  s.state = 'idle';
  syncClaudeBadge(s, deps);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.map((a) => [a[0], a[1], decode(a)]), [['set', '4242', '🧡 Lark'], ['set', '4242', '🤍 Lark']]);
});

test('a Claude session that has only started shows idle until its first prompt', async () => {
  const s = new Board().touch('claude-badge-start', '', 'claude').session;
  s.name = 'Fern';
  s.state = 'working';
  const calls: string[][] = [];
  syncClaudeBadge(s, { event: 'SessionStart', on: () => true, pid: () => 9, run: async (a: string[]) => { calls.push(a); return true; } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.map(decode), ['🤍 Fern']);
});

test('Claude badges stay off by default and never touch other hosts', async () => {
  const calls: string[][] = [];
  const run = async (a: string[]): Promise<boolean> => { calls.push(a); return true; };
  const board = new Board();
  const claude = board.touch('claude-badge-off', '', 'claude').session;
  syncClaudeBadge(claude, { on: () => false, pid: () => 1, run });
  const codex = board.touch('codex-badge-skip', '', 'codex').session;
  syncClaudeBadge(codex, { on: () => true, pid: () => 1, run });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, []);
});

test('a title that could not be aimed is tried again at the next event', async () => {
  const s = new Board().touch('claude-badge-retry', '', 'claude').session;
  s.name = 'Wren';
  s.state = 'working';
  let pid: number | null = null;
  const calls: string[][] = [];
  const deps = { on: () => true, pid: () => pid, retryMs: 1, run: async (a: string[]) => { calls.push(a); return true; } };
  syncClaudeBadge(s, deps);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 0);
  pid = 7;
  syncClaudeBadge(s, deps);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.map((a) => a[1]), ['7']);
});

test('the Claude process comes from its own sessions file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-badge-'));
  fs.writeFileSync(path.join(dir, '100.json'), JSON.stringify({ pid: 100, sessionId: 'a' }));
  fs.writeFileSync(path.join(dir, '200.json'), JSON.stringify({ pid: 200, sessionId: 'b' }));
  fs.writeFileSync(path.join(dir, 'bad.json'), '{');
  assert.equal(claudePid('b', dir), 200);
  assert.equal(claudePid('missing', dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Claude keeps its own title unless badges are on; a person\'s own setting survives', () => {
  const on = titleEnv({ LANG: 'C' }, true, false);
  assert.deepEqual(on, { env: { LANG: 'C', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }, marked: true });
  assert.deepEqual(titleEnv(on.env, false, true), { env: { LANG: 'C' }, marked: false });
  assert.deepEqual(titleEnv({ CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }, false, false),
    { env: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }, marked: false });
  assert.deepEqual(titleEnv(undefined, false, false), { env: undefined, marked: false });
  assert.deepEqual(titleEnv({ CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }, false, true), { env: undefined, marked: false });
});

test('opt-in terminal badges show state and name without the summary', () => {
  const s = new Board().touch('badge-test', '', 'codex').session;
  s.name = 'Plum';
  s.doing = 'Long task description';
  s.state = 'working';
  assert.equal(titleFor(s, 'Old title', true), '🟠 Plum');
  s.state = 'idle';
  s.work = 'active';
  assert.equal(titleFor(s, 'Old title', true), '⚪ Plum');
  s.doing = '';
  assert.equal(titleFor(s, '⚪ Plum', false), 'Plum');
});

test('live polling refreshes terminal title from actual Codex state', async () => {
  const board = new Board();
  const s = board.touch('badge-live', '', 'codex').session;
  const states: string[] = [];
  board.titler = (session) => { states.push(session.state); };
  await reapCodex(board, async () => new Map([[s.id, 'idle']]));
  await reapCodex(board, async () => new Map([[s.id, 'active']]));
  assert.deepEqual(states, ['idle', 'working']);
});

test('install keeps the environment lines a PC already has in its logon script', async () => {
  const { startupScript } = await import('../src/install.js');
  const before = 'Set kokubanShell = CreateObject("WScript.Shell")\r\nkokubanShell.Environment("Process")("KOKUBAN_CONVERSATIONS") = "1"\r\n' +
    'CreateObject("WScript.Shell").Run """old.exe"" ""old.js""", 0, False\r\n';
  const out = startupScript("N:/node.exe", "K:/daemon.js", before);
  assert.match(out, /Environment\("Process"\)\("KOKUBAN_CONVERSATIONS"\) = "1"/);
  assert.ok(out.includes(`Run """N:/node.exe"" ""K:/daemon.js""", 0, False`));
  assert.ok(!out.includes('old.js'));
  assert.equal(startupScript('n', 'd'), 'CreateObject("WScript.Shell").Run """n"" ""d""", 0, False\r\n');
});

test('install moves copies of the logon script out of the Startup folder', async () => {
  const { moveStartupCopies } = await import('../src/install.js');
  const fsm = await import('node:fs'), os = await import('node:os'), p = await import('node:path');
  const root = fsm.mkdtempSync(p.join(os.tmpdir(), 'kokuban-startup-'));
  const startup = p.join(root, 'Startup'), dest = p.join(root, 'backups');
  fsm.mkdirSync(startup);
  for (const n of ['kokuban.vbs', 'kokuban.vbs.bak-20261105020705', 'other.lnk']) fsm.writeFileSync(p.join(startup, n), 'x');
  assert.deepEqual(moveStartupCopies(p.join(startup, 'kokuban.vbs'), dest), ['kokuban.vbs.bak-20261105020705']);
  assert.deepEqual(fsm.readdirSync(startup).sort(), ['kokuban.vbs', 'other.lnk']);
  assert.deepEqual(fsm.readdirSync(dest), ['kokuban.vbs.bak-20261105020705']);
  assert.deepEqual(moveStartupCopies(p.join(startup, 'kokuban.vbs'), dest), []);
  fsm.rmSync(root, { recursive: true, force: true });
});
