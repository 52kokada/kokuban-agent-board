/**
 * One daemon per PC (keeper-pc audit, 2026-11-05): two daemons once ran side by side, and both keepers
 * moved the same vault folders. The lock is a local named pipe (a Unix socket elsewhere) that only one
 * process can listen on; the system lets go of it when that process ends, so a crash leaves no stale lock.
 * Beside it, daemon.lock records the holder's pid for people and `kokuban status`.
 *
 * The pipe also answers "is a daemon alive?" for the SessionStart hook: the system accepts the
 * connection even while the daemon is busy and slow to answer HTTP, so the hook never starts a second one.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { DATA_DIR } from './config.js';

export interface Holder { pid: number; ts: number; started: number }
export interface Instance { file: string; pipe: string; release(): void }

/** The lock's name, one per data folder: a test board's lock never meets the real one. */
export function pipeName(dir = DATA_DIR): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\kokuban-daemon-${createHash('sha256').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 16)}`;
  }
  return path.join(dir, 'daemon.sock');
}
export const lockFile = (dir = DATA_DIR): string => path.join(dir, 'daemon.lock');

function listenOn(pipe: string): Promise<net.Server | null> {
  return new Promise((resolve, reject) => {
    // A caller that only checks liveness hangs up at once: its broken pipe is no error here.
    const server = net.createServer((socket) => { socket.on('error', () => undefined); socket.end(`${process.pid}\n`); });
    server.once('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' ? resolve(null) : reject(err)));
    server.listen(pipe, () => resolve(server));
  });
}

/** Whether a daemon holds the lock now. Fails closed to "no" (and a hook then starts one, which bows out if wrong). */
export function instanceAlive(dir = DATA_DIR, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(pipeName(dir));
    const done = (alive: boolean): void => { clearTimeout(timer); socket.destroy(); resolve(alive); };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** The pid file the holder writes, or null. Only a record: the pipe decides who holds the lock. */
export function holder(dir = DATA_DIR): Holder | null {
  try {
    const h = JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')) as Holder;
    return typeof h.pid === 'number' ? h : null;
  } catch {
    return null;
  }
}

/**
 * Take the lock, before any board or keeper work. null: another daemon holds it (the caller exits quietly).
 * waitMs: keep trying that long, for a board restarted by its own update while the old one lets go.
 */
export async function acquireInstance(opts: { dir?: string; waitMs?: number; touchMs?: number } = {}): Promise<Instance | null> {
  const dir = opts.dir ?? DATA_DIR;
  const pipe = pipeName(dir);
  fs.mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + (opts.waitMs ?? 0);
  let server: net.Server | null = null;
  for (;;) {
    try {
      server = await listenOn(pipe);
    } catch {
      return null;
    }
    // A Unix socket outlives a crashed holder as a file: nobody answering on it means it is stale.
    if (!server && process.platform !== 'win32' && !(await instanceAlive(dir, 500))) {
      try { fs.unlinkSync(pipe); } catch { /* gone already */ }
      continue;
    }
    if (server || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!server) return null;
  server.unref();
  const file = lockFile(dir);
  const started = Date.now();
  const write = (): void => {
    try { fs.writeFileSync(file, `${JSON.stringify({ pid: process.pid, ts: Date.now(), started })}\n`); } catch { /* a record only */ }
  };
  write();
  const touch = setInterval(write, opts.touchMs ?? 30_000);
  touch.unref();
  let released = false;
  return {
    file,
    pipe,
    release(): void {
      if (released) return;
      released = true;
      clearInterval(touch);
      server!.close();
      try { if (holder(dir)?.pid === process.pid) fs.unlinkSync(file); } catch { /* left for the next holder to overwrite */ }
    },
  };
}

/** `kokuban status` exit code: 0 running, 2 holding the lock but not answering yet, 1 not running. */
export function statusCode(answers: boolean, locked: boolean): number {
  return answers ? 0 : locked ? 2 : 1;
}
