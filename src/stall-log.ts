/**
 * Evidence for a frozen board (2026-11-07: the daemon stopped answering for over ten minutes at low CPU,
 * and nothing recorded why). Two signals go to stalls.log in the data folder:
 * - the event loop was blocked (a timer fired late), with how long: a synchronous call held the process;
 * - a request has waited a long time for its answer, with its route: a handler is awaiting something.
 */
import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as path from 'node:path';
import { DATA_DIR } from './config.js';

export interface StallOptions {
  file?: string;
  tickMs?: number;
  lagMs?: number;
  slowMs?: number;
  now?: () => number;
}

export function stallFile(dir = DATA_DIR): string {
  return path.join(dir, 'stalls.log');
}

/** Keeps the log small: past 1 MB, the older half goes. */
function append(file: string, line: string): void {
  try {
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    const size = fs.statSync(file).size;
    if (size > 1 << 20) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(size / 2));
  } catch {
    /* evidence only: never let it break the board */
  }
}

/**
 * Requests the board holds open on purpose: a Claude session's wake wait (wake.ts, about four minutes each)
 * and the native app's change stream. Their waiting is no sign of a stall, and it buried the real ones:
 * 3,781 of the 3,895 lines in this PC's log on 2026-11-09 were these two routes.
 */
const HELD = new Set(['POST /wait/claude', 'GET /app/events']);

/** Watch the loop and the requests of one server. Returns a stop function. */
export function watchStalls(server: http.Server, opts: StallOptions = {}): () => void {
  const file = opts.file ?? stallFile();
  const tick = opts.tickMs ?? 1000;
  const lag = opts.lagMs ?? 3000;
  const slow = opts.slowMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const open = new Map<http.IncomingMessage, { route: string; since: number; logged: boolean }>();

  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const route = `${req.method} ${(req.url ?? '').split('?')[0]}`;
    if (HELD.has(route)) return;
    open.set(req, { route, since: now(), logged: false });
    const done = (): void => {
      const r = open.get(req);
      open.delete(req);
      if (r?.logged) append(file, `answered after ${Math.round((now() - r.since) / 1000)} s: ${r.route}`);
    };
    res.once('finish', done);
    res.once('close', done);
  };
  server.prependListener('request', onRequest);

  let last = now();
  const timer = setInterval(() => {
    const t = now();
    const late = t - last - tick;
    last = t;
    if (late >= lag) append(file, `event loop blocked ${Math.round(late / 1000)} s; ${open.size} requests open`);
    for (const r of open.values()) {
      if (!r.logged && t - r.since >= slow) {
        r.logged = true;
        append(file, `no answer after ${Math.round((t - r.since) / 1000)} s: ${r.route} (${open.size} open)`);
      }
    }
  }, tick);
  timer.unref();
  return () => { clearInterval(timer); server.off('request', onRequest); };
}
