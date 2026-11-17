/**
 * Claude Code's SessionStart hook. That one event cannot use an HTTP hook, so
 * this forwards it, and starts the daemon first when none is running.
 * Always exits 0: a missing board must never hold up a session.
 *
 * A daemon that is alive but slow to answer (a long keeper pass, a restart still loading) is left alone:
 * the hook checks the single-instance lock (instance.ts) before starting one, so two never run at once.
 * One that has held the lock without answering for HUNG_MS is frozen (2026-11-07: ten minutes, every
 * session's prompt hook timing out): the hook backs up board.json, ends that daemon and starts a new one.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL, DATA_DIR } from './config.js';
import { holder, instanceAlive } from './instance.js';

async function post(input: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/hook/claude`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: input,
    signal: AbortSignal.timeout(2000),
  });
  return res.ok ? res.text() : '';
}

/**
 * Start a daemon, hidden. wait: it waits up to 20 s for an old daemon that is still exiting to free the
 * lock and the port (daemon.ts, KOKUBAN_WAIT_PORT), instead of bowing out at once.
 */
export function startDaemon(opts: { wait?: boolean; spawner?: typeof spawn; startup?: string } = {}): void {
  const daemon = path.join(path.dirname(fileURLToPath(import.meta.url)), 'daemon.js');
  const env = opts.wait ? { ...process.env, KOKUBAN_WAIT_PORT: '1' } : process.env;
  // The logon entry (install.ts) carries this PC's process settings (KOKUBAN_CONVERSATIONS, …): start through it
  // when there is one, as update.ts does, so a board started by hand runs like one started at logon.
  const [command, args] = opts.startup && fs.existsSync(opts.startup) ? ['wscript.exe', [opts.startup]] : [process.execPath, [daemon]];
  // Not `detached`: on Windows that overrides windowsHide and opens a console window.
  (opts.spawner ?? spawn)(command, args, { stdio: 'ignore', windowsHide: true, env }).unref();
}

export interface InstallStartDeps {
  answers: () => Promise<boolean>;
  start: () => void;
  timeoutMs?: number;
  delayMs?: number;
}

/**
 * `kokuban install`: make sure the board answers. A daemon that just exited can still hold the lock or the
 * port for a moment, and one started then bowed out at once; so the new one is told to wait for them
 * (startDaemon wait), and this waits until the board answers. A busy daemon that keeps the lock wins:
 * the new one gives up quietly after its wait.
 */
export async function ensureBoard(deps: InstallStartDeps): Promise<'running' | 'started' | 'not answering'> {
  if (await deps.answers()) return 'running';
  deps.start();
  const deadline = Date.now() + (deps.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, deps.delayMs ?? 500));
    if (await deps.answers()) return 'started';
  }
  return 'not answering';
}

/** How long a daemon may hold the lock without answering before a SessionStart hook replaces it. */
export const HUNG_MS = 120_000;

export interface HungDeps {
  dir?: string;
  now?: () => number;
  kill?: (pid: number) => void;
  start?: () => void;
}

/**
 * The lock is held but the board does not answer. The first time, note when; once that is HUNG_MS old,
 * keep a copy of board.json, end the holder and start a new daemon. Returns whether it restarted.
 */
export function recoverHung(deps: HungDeps = {}): boolean {
  const dir = deps.dir ?? DATA_DIR;
  const now = (deps.now ?? Date.now)();
  const mark = path.join(dir, 'unanswered-since');
  let since = now;
  try { since = Number(fs.readFileSync(mark, 'utf8')) || now; } catch { fs.writeFileSync(mark, String(now)); }
  if (now - since < HUNG_MS) return false;
  const pid = holder(dir)?.pid;
  if (!pid || pid === process.pid) return false;
  try { fs.copyFileSync(path.join(dir, 'board.json'), path.join(dir, `board.json.before-hung-restart-${now}`)); } catch { /* no board yet */ }
  try { (deps.kill ?? ((p) => process.kill(p)))(pid); } catch { /* already gone */ }
  try { fs.unlinkSync(mark); } catch { /* raced */ }
  (deps.start ?? (() => startDaemon({ wait: true })))();
  return true;
}

/** The board answered: forget any earlier unanswered mark. */
function answered(dir = DATA_DIR): void {
  try { fs.unlinkSync(path.join(dir, 'unanswered-since')); } catch { /* none */ }
}

export interface StartDeps {
  post?: (input: string) => Promise<string>;
  alive?: () => Promise<boolean>;
  start?: () => void;
  hung?: () => boolean;
  attempts?: number;
  delayMs?: number;
}

/**
 * Forward one SessionStart event; start the daemon only when the board does not answer and no daemon
 * holds the lock. Returns what to print (empty when the board never answered: fail open).
 */
export async function forwardStart(input: string, deps: StartDeps = {}): Promise<string> {
  const send = deps.post ?? post;
  try {
    const out = await send(input);
    if (!deps.post) answered();
    return out;
  } catch {
    let alive = false;
    try { alive = await (deps.alive ?? instanceAlive)(); } catch { /* unknown: treated as none */ }
    if (!alive) (deps.start ?? startDaemon)();
    else try { (deps.hung ?? recoverHung)(); } catch { /* fail open */ }
  }
  for (let attempt = 0; attempt < (deps.attempts ?? 10); attempt++) {
    await new Promise((r) => setTimeout(r, deps.delayMs ?? 300));
    try {
      return await send(input);
    } catch {
      /* not listening yet */
    }
  }
  return '';
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = Buffer.concat(chunks).toString('utf8') || '{}';
  process.stdout.write(await forwardStart(input));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(() => {});
}
