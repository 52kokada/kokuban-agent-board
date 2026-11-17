import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Board } from './board.js';
import { SETTINGS } from './cards.js';
import { BASE_URL, DATA_DIR } from './config.js';
import { autoUpdatePass, type Candidate } from './auto-update.js';
import { AUTO_DIR, autoConfig, publishedKokuban, writeAutoState } from './auto-update-publication.js';
import { waitForManagedIdle } from './conversations/restart-guard.js';
import { ChatError, type ChatSession } from './conversations/contracts.js';
import { resolvePc, trustFor } from './peer.js';
import { git, post, pullUpdate, repoDir, restartBoard, blockUpdatesForRestart } from './update.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const settingsHash = () => createHash('sha256').update(fs.readFileSync(SETTINGS.file)).digest('hex');
function readState(name: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(path.join(AUTO_DIR, name + '.json'), 'utf8')); } catch { return {}; }
}
function distHash(directory: string): string {
  const hash = createHash('sha256');
  const visit = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, e.name);
      if (e.isSymbolicLink()) throw Error('Unexpected link in staged dist');
      if (e.isDirectory()) visit(file);
      else { hash.update(path.relative(directory, file)); hash.update(fs.readFileSync(file)); }
    }
  };
  visit(directory); return hash.digest('hex');
}
function trimStages(keep: string[]): void {
  const base = path.resolve(AUTO_DIR, 'releases');
  if (!fs.existsSync(base)) return;
  const candidates = fs.readdirSync(base, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.isSymbolicLink() && /^[a-f0-9]{40}-[a-f0-9]{8}$/.test(e.name))
    .map(e => path.join(base, e.name)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const retained = new Set([...keep.map(p => path.resolve(p)), ...candidates.slice(0, 3)]);
  for (const dir of candidates) if (!retained.has(dir) && path.dirname(path.resolve(dir)) === base)
    fs.rmSync(dir, { recursive: true }); // only this updater's generated, unreferenced staging directories
}
const running = new WeakSet<Board>();
const nextCheck = new WeakMap<Board, number>();
const applying = new WeakSet<Board>();
export const autoUpdateApplying = (board: Board): boolean => applying.has(board);
let runtimeHead = '';
try { runtimeHead = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'release.json'), 'utf8')).head; } catch { /* unmarked build */ }
let sessionId: number | null = null;
function windowsSession(): number {
  if (process.platform !== 'win32') throw Error('Automatic application currently supports Windows only');
  if (sessionId === null) sessionId = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).SessionId`], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim());
  return sessionId;
}
export function autoRuntimeEvidence(): object {
  return { head: runtimeHead, pid: process.pid, sessionId: sessionId ?? (autoConfig() ? windowsSession() : null) };
}
async function checkedGit(dir: string, args: string[]): Promise<string> {
  const r = await git(dir, args);
  if (!r.ok) throw Error(`git ${args[0]} failed: ${r.err.slice(0, 300)}`);
  return r.out;
}
export async function runStage(dir: string, command: string, args: string[], env = process.env): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, { cwd: dir, env, windowsHide: true, timeout: 900_000, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
      try {
        fs.appendFileSync(path.join(dir, '.kokuban', 'validation.log'), `${stdout}\n${stderr}\n`);
        error ? reject(Error(`Validation ${path.basename(command)} failed; see staged validation.log`)) : resolve();
      } catch (failure) { reject(failure); }
    });
  });
}
/** One immediate idle check (no waiting): busy, unreadable or invalid state throws. */
export async function managedIdleNow(conversations: Pick<NonNullable<Board['conversations']>, 'local'> | undefined): Promise<void> {
  await waitForManagedIdle({ timeoutMs: 0, read: async () => {
    if (!conversations) throw Error('Managed conversations cannot be read');
    let r: { sessions?: ChatSession[] };
    try { r = await conversations.local({ op: 'list' }) as { sessions?: ChatSession[] }; }
    catch (error) {
      // Same rule as scripts/wait-for-managed-idle.mjs (6803130): shared sessions switched off means none
      // can be busy. Any other failure (storage, Node version) still fails closed.
      if (error instanceof ChatError && error.status === 503 && /disabled/i.test(error.message)) return [];
      throw error;
    }
    if (!Array.isArray(r.sessions)) throw Error('Managed conversations returned invalid state');
    return r.sessions;
  } });
}
const idle = (board: Board): Promise<void> => managedIdleNow(board.conversations);

/** Restore only a transaction-owned clean checkout. Never overwrite subsequent human edits. */
export async function restoreAutoUpdate(dir: string, before: string, after: string, backup: string): Promise<void> {
  if (await checkedGit(dir, ['rev-parse', 'HEAD']) !== after || await checkedGit(dir, ['status', '--porcelain']))
    throw Error('Rollback held: checkout changed after this transaction');
  await checkedGit(dir, ['reset', '--keep', before]);
  const live = path.join(dir, 'dist');
  if (fs.existsSync(path.join(backup, 'dist'))) {
    if (fs.existsSync(live)) fs.renameSync(live, path.join(backup, 'failed-dist-' + Date.now()));
    fs.renameSync(path.join(backup, 'dist'), live);
  }
}

/** Timer entry: no setting means no process, network request or state write. */
export async function autoUpdateTick(board: Board): Promise<void> {
  const config = autoConfig();
  if (!config || running.has(board) || Date.now() < (nextCheck.get(board) ?? 0)) return;
  running.add(board);
  nextCheck.set(board, Date.now() + 300_000);
  let stage = '', bundle = '', source = '', snapshot = '', before = '', backup = '';
  let validating = false;
  let attemptedApply = false;
  let response: Record<string, unknown> = {};
  const live = repoDir('kokuban')!;
  const preflight = async (candidate: Candidate): Promise<void> => {
    if (!runtimeHead || runtimeHead !== before) throw Error('Running build does not attest the checkout HEAD; verify the baseline before enabling');
    if (settingsHash() !== snapshot) throw Error('Settings changed during preparation');
    if (await checkedGit(live, ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') throw Error('Not on main; held');
    if (await checkedGit(live, ['status', '--porcelain', '--untracked-files=normal'])) throw Error('Working tree has local changes; held');
    if (await checkedGit(live, ['rev-parse', 'HEAD']) !== before) throw Error('Local HEAD changed; held');
    await checkedGit(live, ['fetch', bundle, '+refs/heads/main:refs/kokuban/auto-incoming']);
    if (await checkedGit(live, ['rev-parse', 'refs/kokuban/auto-incoming']) !== candidate.head) throw Error('Bundle commit mismatch');
    await checkedGit(live, ['merge-base', '--is-ancestor', before, candidate.head]);
    if (await checkedGit(live, ['diff', '--name-only', before, candidate.head, '--', 'package.json', 'package-lock.json', 'tools/']))
      throw Error('Dependencies or native tools changed; automatic application held for a managed dependency update');
    if (windowsSession() !== 1) throw Error('The daemon is not in Windows session 1');
  };
  try {
    snapshot = settingsHash();
    before = await checkedGit(live, ['rev-parse', 'HEAD']);
    const result = await autoUpdatePass(config, {
      discover: async () => {
        source = await resolvePc(config.from);
        if (!['share', 'work'].includes(trustFor(source) ?? '')) throw Error('Update source is not paired for code sharing');
        if (config.role === 'client' && source.split('.')[0] !== 'keeper-pc') throw Error('Automatic clients must use the HOUSE hub');
        const published = config.role === 'hub' ? publishedKokuban() : null;
        const have = published ? await checkedGit(published, ['rev-parse', 'HEAD']) : config.role === 'client' ? before : '';
        response = await post(source, { op: 'code', repo: 'kokuban', publishedOnly: true, ...(have ? { have } : {}) }, {}, 300_000);
        if (response.same === true) return null;
        const head = String(response.commit ?? '');
        if (!/^[a-f0-9]{40}$/.test(head) || response.published !== true) throw Error('Source lacks published-commit verification; upgrade it first');
        if (readState('rejected').head === head) throw Error(`Release ${head} previously failed; held for explicit review`);
        if (typeof response.bundle !== 'string' || response.bundle.length > 400 * 1024 * 1024) throw Error('Invalid bundle');
        fs.mkdirSync(AUTO_DIR, { recursive: true });
        bundle = path.join(AUTO_DIR, head + '.bundle');
        fs.writeFileSync(bundle, Buffer.from(response.bundle, 'base64'));
        return { head, published: true };
      },
      preflight,
      stage: async (candidate) => {
        const cached = readState('prepared');
        if (cached.head === candidate.head && typeof cached.directory === 'string' &&
            path.resolve(cached.directory).startsWith(path.resolve(AUTO_DIR, 'releases') + path.sep) &&
            fs.existsSync(path.join(cached.directory, 'dist')) &&
            await checkedGit(cached.directory, ['rev-parse', 'HEAD']) === candidate.head &&
            !(await checkedGit(cached.directory, ['status', '--porcelain'])) &&
            distHash(path.join(cached.directory, 'dist')) === cached.distHash) {
          stage = cached.directory; return;
        }
        validating = true;
        const base = config.role === 'hub' ? publishedKokuban() ?? live : live;
        await checkedGit(base, ['bundle', 'verify', bundle]);
        stage = path.join(AUTO_DIR, 'releases', candidate.head + '-' + randomBytes(4).toString('hex'));
        fs.mkdirSync(path.dirname(stage), { recursive: true });
        await checkedGit(base, ['clone', '--no-hardlinks', '--no-checkout', base, stage]);
        await checkedGit(stage, ['fetch', bundle, '+refs/heads/main:refs/remotes/origin/main']);
        if (await checkedGit(stage, ['rev-parse', 'refs/remotes/origin/main']) !== candidate.head) throw Error('Staged commit mismatch');
        if (config.role === 'hub' && publishedKokuban()) await checkedGit(stage, ['merge-base', '--is-ancestor', 'HEAD', candidate.head]);
        await checkedGit(stage, ['checkout', '-B', 'main', candidate.head]);
        fs.mkdirSync(path.join(stage, '.kokuban'), { recursive: true });
        if (process.platform !== 'win32') throw Error('Staged validation currently supports Windows only');
        await runStage(stage, 'cmd.exe', ['/d', '/s', '/c', 'npm ci --ignore-scripts --no-audit --no-fund']);
        await runStage(stage, 'cmd.exe', ['/d', '/s', '/c', 'npm run build']);
        const tests = ['update', 'auto-update-instance', 'restart-guard', 'managed-maintenance', 'auto-update', 'auto-update-runtime'].map(name => `dist/tests/${name}.test.js`);
        for (const test of tests) if (!fs.existsSync(path.join(stage, test))) throw Error(`Required validation is missing: ${test}`);
        const isolated = { ...process.env, LOCALAPPDATA: path.join(stage, '.kokuban', 'test-state') };
        await runStage(stage, process.execPath, ['--test', '--test-concurrency=1', ...tests], isolated);
        // Smoke: the staged daemon and watchdog load with every import resolved. Loading does not serve:
        // daemon.ts serves only when it is argv[1], which here is the 'kokuban-smoke' placeholder, so
        // nothing touches the port, Serve or Codex.
        const smoke = "const { pathToFileURL } = await import('node:url'); for (const f of process.argv.slice(2)) await import(pathToFileURL(f).href);";
        await runStage(stage, process.execPath, ['--input-type=module', '-e', smoke, 'kokuban-smoke',
          path.join(stage, 'dist', 'src', 'daemon.js'), path.join(stage, 'dist', 'src', 'auto-update-watchdog.js')], isolated);
        if (await checkedGit(stage, ['status', '--porcelain'])) throw Error('Validation changed staged source');
        fs.writeFileSync(path.join(stage, 'dist', 'release.json'), JSON.stringify({ head: candidate.head }));
        writeAutoState('prepared', { head: candidate.head, directory: stage, distHash: distHash(path.join(stage, 'dist')), at: Date.now() });
        trimStages([stage, ...(publishedKokuban() ? [publishedKokuban()!] : [])]);
        validating = false;
      },
      publish: async (candidate) => {
        if (settingsHash() !== snapshot) throw Error('Settings changed before publication');
        writeAutoState('published', { head: candidate.head, directory: stage, source, at: Date.now() });
      },
      idle: () => idle(board),
      apply: async (candidate) => {
        const vbs = path.join(process.env.APPDATA ?? '', 'Microsoft/Windows/Start Menu/Programs/Startup/kokuban.vbs');
        if (!fs.existsSync(vbs)) throw Error('Normal startup entry is unavailable');
        backup = path.join(live, '.kokuban', 'auto-update', 'backup-' + Date.now());
        fs.mkdirSync(backup, { recursive: true });
        await fs.promises.cp(path.join(live, 'dist'), path.join(backup, 'dist'), { recursive: true });
        const watchdog = path.join(backup, 'watchdog.js');
        fs.copyFileSync(path.join(root, 'dist/src/auto-update-watchdog.js'), watchdog);
        fs.writeFileSync(path.join(backup, 'package.json'), '{"type":"module"}');
        const transaction = { dir: live, backup, before, after: candidate.head, parent: process.pid, dataDir: DATA_DIR, baseUrl: BASE_URL, vbs, settings: SETTINGS.file, settingsHash: snapshot };
        fs.writeFileSync(path.join(backup, 'transaction.json'), JSON.stringify(transaction));
        let installed = false;
        let restartHandedOff = false;
        let releaseRestartBlock: (() => void) | undefined;
        let releaseMaintenance: (() => void) | undefined;
        const rollback = async () => { await restoreAutoUpdate(live, before, candidate.head, backup); installed = false; };
        try {
        const outcome = await pullUpdate(board, { from: source, repos: ['kokuban'], app: false }, {
          expectedHead: candidate.head,
          // Reuse the exact validated bundle, never a mutable second network response.
          fetch: async () => new Response(JSON.stringify(response)), resolve: async () => source,
          beforeApply: async () => {
            await preflight(candidate);
            if (!board.conversations) throw Error('Managed conversations are unavailable');
            releaseMaintenance = board.conversations.beginMaintenance();
            releaseRestartBlock = blockUpdatesForRestart(board);
            try { await idle(board); applying.add(board); attemptedApply = true; }
            catch (error) { releaseMaintenance(); releaseMaintenance = undefined; throw error; }
          },
          build: async () => {
            const next = path.join(backup, 'next-dist');
            await fs.promises.cp(path.join(stage, 'dist'), next, { recursive: true });
            fs.renameSync(path.join(live, 'dist'), path.join(backup, 'replaced-dist'));
            fs.renameSync(next, path.join(live, 'dist'));
            installed = true;
          },
          rollback: async () => { await rollback(); },
          restart: async () => {
          if (settingsHash() !== snapshot) throw Error('Settings changed before restart');
          await idle(board);
          const monitor = spawn(process.execPath, [watchdog, path.join(backup, 'transaction.json')], { windowsHide: true, stdio: 'ignore' });
          await new Promise<void>((resolve, reject) => { monitor.once('spawn', resolve); monitor.once('error', reject); });
          monitor.unref();
          if (!restartBoard(board)) throw Error('Normal startup entry disappeared; restart was not scheduled');
          restartHandedOff = true;
          // Keep the request gate closed until this process exits on the normal starter path.
          },
        });
        if (!outcome.ok || !installed) throw Error(outcome.lines.join('; '));
        } catch (error) { if (installed) await rollback(); throw error; }
        finally { if (!restartHandedOff) { releaseRestartBlock?.(); releaseMaintenance?.(); applying.delete(board); } }
      },
    });
    if (result.state === 'held' && (validating || attemptedApply) && result.head)
      writeAutoState('rejected', { head: result.head, detail: result.detail, at: Date.now() });
    writeAutoState('status', { ...result, at: Date.now(), source });
  } catch (error) {
    writeAutoState('status', { state: 'held', detail: String(error), at: Date.now() });
  } finally {
    // The bundle is only needed within this pass (pullRepo keeps its own copy); never let them pile up.
    if (bundle) fs.rmSync(bundle, { force: true });
    running.delete(board); if (!applying.has(board)) nextCheck.set(board, Date.now() + 300_000);
  }
}
