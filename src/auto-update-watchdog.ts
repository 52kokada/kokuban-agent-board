/** Copied into a transaction's backup before restart. Built-ins only: survives a broken new dist. */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Transaction { dir: string; backup: string; before: string; after: string; parent: number; dataDir: string; baseUrl: string; vbs: string; settings: string; settingsHash: string }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export function validReadiness(value: unknown, expected: string, oldPid: number): boolean {
  const v = value as { head?: unknown; pid?: unknown; sessionId?: unknown } | null;
  return Boolean(v && v.head === expected && Number.isInteger(v.pid) && Number(v.pid) > 0 && v.pid !== oldPid && v.sessionId === 1);
}
async function ready(t: Transaction, head: string): Promise<boolean> {
  try {
    const k = await fetch(t.baseUrl + '/app/key', { signal: AbortSignal.timeout(2000) });
    if (!k.ok || typeof (await k.json() as { key?: unknown }).key !== 'string') return false;
    const r = await fetch(t.baseUrl + '/auto-update/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2000) });
    return r.ok && validReadiness(await r.json(), head, t.parent);
  } catch { return false; }
}
function report(t: Transaction, state: string, detail: string): void {
  const f = path.join(t.dataDir, 'auto-update/status.json');
  fs.writeFileSync(f + '.watchdog.tmp', JSON.stringify({ state, head: t.after, detail, at: Date.now() }, null, 2));
  fs.renameSync(f + '.watchdog.tmp', f);
  if (['held', 'recovering', 'rolled-back'].includes(state)) {
    fs.writeFileSync(path.join(t.dataDir, 'auto-update/rejected.json'), JSON.stringify({ head: t.after, detail, at: Date.now() }));
  }
}
function git(t: Transaction, args: string[]): string {
  return execFileSync('git', ['-C', t.dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120_000 }).trim();
}
async function recoveryLock(t: Transaction): Promise<net.Server | null> {
  const pipe = `\\\\.\\pipe\\kokuban-daemon-${createHash('sha256').update(path.resolve(t.dataDir).toLowerCase()).digest('hex').slice(0, 16)}`;
  return new Promise(resolve => {
    const server = net.createServer(socket => socket.end());
    server.once('error', () => resolve(null));
    server.listen(pipe, () => resolve(server));
  });
}
export async function monitorUpdate(t: Transaction): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await ready(t, t.after)) { report(t, 'applied', 'New commit, /app/key and Windows session 1 verified'); return; }
    await sleep(2000);
  }
  // Never kill a hung daemon or take over a process holding the single-instance lock.
  const lock = await recoveryLock(t);
  if (!lock) { report(t, 'held', 'Readiness failed but a daemon still owns the lock; no forced rollback'); return; }
  try {
    try { process.kill(t.parent, 0); report(t, 'held', 'Original daemon is still alive; no rollback'); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    if (createHash('sha256').update(fs.readFileSync(t.settings)).digest('hex') !== t.settingsHash)
      throw Error('Settings changed; recovery needs review');
    if (git(t, ['rev-parse', 'HEAD']) !== t.after || git(t, ['status', '--porcelain'])) throw Error('Checkout changed; recovery needs review');
    if (!fs.existsSync(path.join(t.backup, 'dist'))) throw Error('Backup is unavailable');
    git(t, ['reset', '--keep', t.before]);
    const live = path.join(t.dir, 'dist');
    if (fs.existsSync(live)) fs.renameSync(live, path.join(t.backup, 'failed-runtime-' + Date.now()));
    fs.renameSync(path.join(t.backup, 'dist'), live);
    report(t, 'recovering', 'Previous source and dist restored; waiting for the normal starter');
  } catch (error) { report(t, 'held', String(error)); return; }
  finally { await new Promise<void>(resolve => lock.close(() => resolve())); }
  const child = spawn('wscript.exe', [t.vbs], { windowsHide: true, stdio: 'ignore', env: { ...process.env, KOKUBAN_WAIT_PORT: '1' } });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  const recoveryDeadline = Date.now() + 120_000;
  while (Date.now() < recoveryDeadline) {
    if (await ready(t, t.before)) { report(t, 'rolled-back', 'Previous release readiness verified; failed release is held'); return; }
    await sleep(2000);
  }
  report(t, 'held', 'Previous files restored but readiness was not established; no further restart');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw Error('A local transaction file is required');
  const t = JSON.parse(fs.readFileSync(file, 'utf8')) as Transaction;
  if (!/^[a-f0-9]{40}$/.test(t.before) || !/^[a-f0-9]{40}$/.test(t.after) || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(t.baseUrl)) throw Error('Invalid recovery transaction');
  monitorUpdate(t).catch(error => { report(t, 'held', String(error)); process.exitCode = 1; });
}
