/**
 * Daemon and keeper startup reliability (keeper-pc audit, 2026-11-05): one daemon per PC, the board answers
 * before the keeper's folder pass, the start hook never launches a second daemon, the keeper's heartbeat,
 * and a failed tool call's reason in the usage log.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Board } from '../src/board.js';
import { SETTINGS } from '../src/cards.js';
import { startKeeper } from '../src/daemon.js';
import { acquireInstance, holder, instanceAlive, statusCode } from '../src/instance.js';
import { handleRpc } from '../src/mcp.js';
import { HUNG_MS, ensureBoard, forwardStart, recoverHung, startDaemon } from '../src/start-hook.js';
import { watchStalls } from '../src/stall-log.js';
import { HEARTBEAT, ensureLayout, findClient, heartbeat, keeperStatus, keeperTick, vaultTool, type KeeperConfig } from '../src/vault-keeper.js';

const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-startup-'));
const instanceModule = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'instance.js')).href;

/** Another process trying the lock on dir: "got" or "held". */
function otherProcess(dir: string, waitMs = 0): Promise<string> {
  const code = `const { acquireInstance } = await import(${JSON.stringify(instanceModule)});` +
    `const i = await acquireInstance({ dir: ${JSON.stringify(dir)}, waitMs: ${waitMs} });` +
    `console.log(i ? 'got' : 'held'); i?.release();`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, timeout: 20_000 },
      (err, out) => (err ? reject(err) : resolve(out.trim())));
  });
}

test('one daemon per data folder: a second one is refused until the first lets go, in this process and another', async () => {
  const dir = temp();
  assert.equal(await instanceAlive(dir), false);
  const first = await acquireInstance({ dir });
  assert(first, 'the first daemon takes the lock');
  assert.equal(await instanceAlive(dir), true, 'the hook sees a live daemon without HTTP');
  assert.equal(holder(dir)?.pid, process.pid, 'daemon.lock records the holder');
  assert.equal(await acquireInstance({ dir }), null, 'a second daemon in this process is refused');
  assert.equal(await otherProcess(dir), 'held', 'a second daemon in another process is refused');
  const other = temp();
  const elsewhere = await acquireInstance({ dir: other });
  assert(elsewhere, 'another data folder (a test board) has its own lock');
  elsewhere.release();
  // A restarted board (KOKUBAN_WAIT_PORT) waits for the old one to let go instead of bowing out.
  const waiting = otherProcess(dir, 15_000);
  await new Promise((r) => setTimeout(r, 1500));
  first.release();
  assert.equal(await waiting, 'got');
  assert.equal(holder(dir), null, 'the pid record leaves with its holder');
  const again = await acquireInstance({ dir });
  assert(again, 'free again once released');
  again.release();
  assert.equal(await instanceAlive(dir), false);
});

test('the start hook never launches a second daemon while one holds the lock, and fails open', async () => {
  let starts = 0;
  const down = async (): Promise<string> => { throw new Error('ECONNREFUSED'); };
  // Alive but slow (a long keeper pass, a restart still loading): left alone.
  assert.equal(await forwardStart('{}', { post: down, alive: async () => true, start: () => { starts++; }, hung: () => false, attempts: 3, delayMs: 1 }), '');
  assert.equal(starts, 0);
  // A lock check that itself fails counts as no daemon: the new one bows out if that was wrong.
  await forwardStart('{}', { post: down, alive: async () => { throw new Error('pipe'); }, start: () => { starts++; }, attempts: 1, delayMs: 1 });
  assert.equal(starts, 1);
  // Nobody holds the lock: one daemon is started and the event forwarded once it answers.
  let calls = 0;
  const late = async (): Promise<string> => { if (++calls < 3) throw new Error('not yet'); return '{"ok":true}'; };
  assert.equal(await forwardStart('{}', { post: late, alive: async () => false, start: () => { starts++; }, attempts: 5, delayMs: 1 }), '{"ok":true}');
  assert.equal(starts, 2);
  // A board that answers is never started.
  assert.equal(await forwardStart('{}', { post: async () => 'hi', alive: async () => false, start: () => { starts++; } }), 'hi');
  assert.equal(starts, 2);
});

test('keeper ticks start only after the server listens', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const seen: boolean[] = [];
  const stop = startKeeper(server, async () => { seen.push(server.listening); }, { delayMs: 0, everyMs: 20 });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(seen, [], 'no tick before listening');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise((r) => setTimeout(r, 100));
  stop();
  server.close();
  assert(seen.length >= 2, `ticks after listening (${seen.length})`);
  assert(seen.every(Boolean));
});

const overview = (id: string, name: string, stage: string): string =>
  `---\ntobira_id: "${id}"\nname: "${name}"\naliases: ["${name}"]\nstage: ${stage}\n---\n# ${name}\n\n<!-- keeper:summary -->\n<!-- /keeper:summary -->\n`;
function misplaced(root: string, count: number): void {
  ensureLayout(root);
  for (let i = 0; i < count; i++) {
    const dir = path.join(root, 'Acme', 'Clients', '0 ❓ No stage', `T-0${1000 + i} Client ${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Overview.md'), overview(`T-0${1000 + i}`, `Client ${i}`, 'signed'));
  }
}

test('a long folder pass yields between moves, so the board keeps answering; the heartbeat tracks it', async () => {
  const root = temp();
  misplaced(root, 12);
  const config = (): KeeperConfig => ({ path: root, keeper: true, keeperPc: 'keeper-pc' });
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  let turns = 0;
  let answered = 0;
  const spin = setInterval(() => { turns++; }, 0);
  const tick = keeperTick(new Board(), { config, now: () => new Date(2026, 10, 6, 1, 0).getTime(), pc: () => 'keeper-pc', version: () => 'abc1234' });
  const asked = fetch(url).then(() => { answered++; });
  await tick;
  clearInterval(spin);
  await asked;
  server.close();
  assert.equal(findClient(root, 'T-01000'), 'Acme/Clients/2 🛠 Building/T-01000 Client 0', 'the clients moved');
  assert(turns >= 5, `the event loop turned between moves (${turns})`);
  assert.equal(answered, 1);
  const hb = heartbeat(root)!;
  assert.equal(hb.state, 'idle');
  assert.equal(hb.pid, process.pid);
  assert.equal(hb.pc, 'keeper-pc');
  assert.equal(hb.version, 'abc1234');
  assert.equal(hb.queue, 0);
  assert.deepEqual([hb.last?.ok, hb.last?.moved, hb.last?.skipped], [true, 12, 0]);
});

test('the heartbeat is written by the keeper tick (at most every 5 minutes) and shown by vault op="status" and kokuban status', async () => {
  const root = temp();
  let now = new Date(2026, 10, 6, 1, 0).getTime();
  const config = (): KeeperConfig => ({ path: root, keeper: true, keeperPc: 'keeper-pc' });
  const deps = { config, now: () => now, pc: () => 'keeper-pc', version: () => 'abc1234' };
  const board = new Board();
  await keeperTick(board, deps);
  const first = heartbeat(root)!;
  assert(fs.existsSync(path.join(root, ...HEARTBEAT.split('/'))));
  assert.equal(first.ts, new Date(now).toISOString());
  const firstTs = new Date(now).toISOString();
  now += 30_000;
  await keeperTick(board, deps);
  assert.equal(heartbeat(root)!.ts, firstTs, 'an unchanged state is not rewritten within 5 minutes (each write is a synced version)');
  now += 5 * 60_000;
  await keeperTick(board, deps);
  assert.equal(heartbeat(root)!.ts, new Date(now).toISOString(), 'rewritten after 5 minutes');
  const me = board.touch('status-session', '', 'claude').session;
  const shown = await vaultTool(board, me, { op: 'status' }, { ...deps, now: () => now + 10_000 });
  assert.match(shown, /keeper: alive, idle, last beat 10s ago from keeper-pc pid \d+ \(abc1234\); keeper queue 0/);
  assert.match(shown, /last tick: ok at .*; 0 queued writes applied, 0 folders moved, 0 moves skipped/);
  // Another PC reads the synced heartbeat: silent after a few minutes, never guessed from the last write.
  const away = keeperStatus({ path: root, keeper: false, keeperPc: 'keeper-pc' }, now + 15 * 60_000).join('\n');
  assert.match(away, /the keeper is keeper-pc[\s\S]*keeper: SILENT, idle, last beat 15 min ago[\s\S]*this PC's queue: 0 writes/);
  assert.match(keeperStatus({ path: temp(), keeper: false, keeperPc: 'keeper-pc' }).join('\n'), /no heartbeat yet/);
  // A non-keeper never writes the keeper's heartbeat.
  const other = temp();
  await keeperTick(board, { config: () => ({ path: other, keeper: false, keeperPc: 'keeper-pc' }) });
  assert.equal(heartbeat(other), null);
});

test('a failed vault call records its reason in the usage log, with the password masked', async () => {
  const old = SETTINGS.file;
  SETTINGS.file = path.join(temp(), 'settings.json');
  fs.writeFileSync(SETTINGS.file, JSON.stringify({ vault: { path: temp(), keeper: true } }));
  try {
    const board = new Board();
    const logs: Array<Record<string, unknown>> = [];
    board.usage = (e) => logs.push(e);
    const me = board.touch('usage-session', '', 'claude').session;
    const out = await handleRpc(board, 'claude', { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'vault', arguments: { me: me.name, op: 'write', kind: 'credential', space: 'T-05555', site: 'example.com', value: 'hunter2-secret', source: 'test' } } });
    assert.equal((out as { result: { isError?: boolean } }).result.isError, true);
    const entry = logs.find((e) => e.tool === 'vault')!;
    assert.equal(entry.ok, false);
    assert.equal(entry.op, 'write');
    assert.equal(entry.kind, 'credential');
    assert.equal(typeof entry.error, 'string');
    assert((entry.error as string).length > 0);
    assert(!JSON.stringify(logs).includes('hunter2-secret'));
    await handleRpc(board, 'claude', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'vault', arguments: { me: me.name, op: 'nope' } } });
    assert.match(String(logs.filter((e) => e.tool === 'vault').at(-1)!.error), /op must be catchup, read, search, client, status or write/);
  } finally {
    SETTINGS.file = old;
  }
});

test('install starts the board when an old daemon has just exited, and waits until it answers', async () => {
  let up = false, starts = 0, polls = 0;
  const answers = async (): Promise<boolean> => { if (starts) polls++; return up || (starts > 0 && polls >= 3 && (up = true)); };
  assert.equal(await ensureBoard({ answers, start: () => { starts++; }, delayMs: 1 }), 'started');
  assert.equal(starts, 1);
  // Already answering: nothing is started.
  assert.equal(await ensureBoard({ answers: async () => true, start: () => { throw Error('started a second board'); } }), 'running');
  // Never answers (a busy old daemon kept the lock): reported, not hidden.
  assert.equal(await ensureBoard({ answers: async () => false, start: () => undefined, timeoutMs: 20, delayMs: 1 }), 'not answering');
});

test('install starts the daemon hidden, attached, and told to wait for the old one to let go', () => {
  const calls: { args: string[]; opts: Record<string, unknown> }[] = [];
  const spawner = ((_cmd: string, args: string[], opts: Record<string, unknown>) => { calls.push({ args, opts }); return { unref() {} }; }) as never;
  startDaemon({ wait: true, spawner });
  startDaemon({ spawner });
  assert.equal(calls.length, 2);
  for (const { args, opts } of calls) {
    assert.match(args[0]!, /daemon\.js$/);
    assert.equal(opts.windowsHide, true);
    assert.notEqual(opts.detached, true);
  }
  assert.equal((calls[0]!.opts.env as NodeJS.ProcessEnv).KOKUBAN_WAIT_PORT, '1');
  assert.equal((calls[1]!.opts.env as NodeJS.ProcessEnv).KOKUBAN_WAIT_PORT, undefined);
  // With a logon entry, through it, so its process settings apply; a missing one falls back to node.
  const vbs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-startup-')), 'kokuban.vbs');
  fs.writeFileSync(vbs, '');
  startDaemon({ wait: true, spawner, startup: vbs });
  startDaemon({ wait: true, spawner, startup: `${vbs}.missing` });
  assert.deepEqual(calls[2]!.args, [vbs]);
  assert.equal(calls[2]!.opts.windowsHide, true);
  assert.equal((calls[2]!.opts.env as NodeJS.ProcessEnv).KOKUBAN_WAIT_PORT, '1');
  assert.match(calls[3]!.args[0]!, /daemon\.js$/);
});

test('kokuban status exits 0 when the board answers, 1 when it is down', async () => {
  assert.equal(statusCode(true, true), 0);
  assert.equal(statusCode(false, true), 2);
  assert.equal(statusCode(false, false), 1);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-status-'));
  const server = http.createServer((req, res) => { res.statusCode = req.url === '/app/key' ? 200 : 404; res.end('{}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const status = (p: number) => new Promise<{ code: number; out: string }>((resolve) => {
    execFile(process.execPath, [cli, 'status'], { env: { ...process.env, LOCALAPPDATA: state, KOKUBAN_PORT: String(p) }, windowsHide: true },
      (err, out) => resolve({ code: err ? Number((err as { code?: number }).code) : 0, out }));
  });
  try {
    const up = await status(port);
    assert.equal(up.code, 0, up.out);
    assert.match(up.out, /^running: /);
    await new Promise<void>((r) => server.close(() => r()));
    const down = await status(port);
    assert.equal(down.code, 1, down.out);
    assert.match(down.out, /^not running/);
  } finally {
    server.close();
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test('a daemon that holds the lock without answering for HUNG_MS is backed up, ended and replaced', () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, 'board.json'), '{"x":1}');
  fs.writeFileSync(path.join(dir, 'daemon.lock'), JSON.stringify({ pid: 424242, ts: 0, started: 0 }));
  const killed: number[] = [];
  let starts = 0;
  let t = 1_000_000;
  const deps = { dir, now: () => t, kill: (p: number) => { killed.push(p); }, start: () => { starts++; } };
  // First unanswered look only notes the time; a slow board is left alone until HUNG_MS has passed.
  assert.equal(recoverHung(deps), false);
  t += HUNG_MS - 1;
  assert.equal(recoverHung(deps), false);
  t += 1;
  assert.equal(recoverHung(deps), true);
  assert.deepEqual(killed, [424242]);
  assert.equal(starts, 1);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('board.json.before-hung-restart-')));
  assert.ok(!fs.existsSync(path.join(dir, 'unanswered-since')));
});

test('the stall log records a request left without an answer and a blocked event loop', async () => {
  const dir = temp();
  const file = path.join(dir, 'stalls.log');
  let release: () => void = () => undefined;
  const server = http.createServer((_req, res) => { release = () => res.end('ok'); });
  const stop = watchStalls(server, { file, tickMs: 20, lagMs: 100, slowMs: 50 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const reply = fetch(`http://127.0.0.1:${port}/hook/claude?x=1`, { method: 'POST' });
  await new Promise((r) => setTimeout(r, 150));
  const until = Date.now() + 200; while (Date.now() < until) { /* block the loop */ }
  await new Promise((r) => setTimeout(r, 60));
  release();
  await (await reply).text();
  await new Promise((r) => setTimeout(r, 30));
  stop();
  server.close();
  const log = fs.readFileSync(file, 'utf8');
  assert.match(log, /no answer after \d+ s: POST \/hook\/claude \(/);
  assert.match(log, /event loop blocked/);
  assert.match(log, /answered after \d+ s: POST \/hook\/claude/);
});

test('the stall log leaves out requests the board holds open on purpose', async () => {
  const file = path.join(temp(), 'stalls.log');
  const held: http.ServerResponse[] = [];
  const server = http.createServer((_req, res) => { held.push(res); });
  const stop = watchStalls(server, { file, tickMs: 20, lagMs: 60_000, slowMs: 50 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const replies = [fetch(`${base}/wait/claude`, { method: 'POST' }), fetch(`${base}/app/events?t=key`), fetch(`${base}/mcp`, { method: 'POST' })];
  await new Promise((r) => setTimeout(r, 150));
  for (const res of held) res.end('ok');
  for (const reply of replies) await (await reply).text();
  await new Promise((r) => setTimeout(r, 30));
  stop();
  server.close();
  const log = fs.readFileSync(file, 'utf8');
  assert.match(log, /no answer after \d+ s: POST \/mcp \(1 open\)/, 'an ordinary request is still recorded, and counted alone');
  assert.doesNotMatch(log, /wait\/claude|app\/events/);
});
