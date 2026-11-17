/**
 * Updates over the tailnet: a PC gets kokuban and computeruse from a PC it is paired with, so no
 * PC needs its own way into GitHub (pc-b has none from an SSH session: wrong git account, and the
 * repositories are private).
 *
 *   getting    `kokuban update`: asks each paired PC which commits it runs (/peer op "hello"),
 *              takes each repository from the PC with the newest, as a git bundle (op "code").
 *   sending    `kokuban update pc-b`: offers this PC's commits to pc-b (op "offer"); its
 *              person gets a card listing what is new, and Install fetches and applies them.
 *   applying   kokuban: fast-forward, build, and the board restarts itself on the new build.
 *              computeruse: its own updater (scripts/update_checkout.py, run from the incoming
 *              commit), which keeps the PC's config.yaml and learned knowledge; a PC without
 *              computeruse gets it cloned and installed (scripts/install.ps1 -NoVoice).
 *
 * Only main is ever sent, and only to a PC this one trusts at "share" or more.
 */
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_EXE, APP_FEED, SETUP, appHello, collides, fetchFile, installApp, listApp, newer, newestApp, type AppAsset, type AppFile } from './app-update.js';
import type { Board } from './board.js';
import { closeCard, makeCard, personName, SETTINGS, type Card } from './cards.js';
import { DATA_DIR, PORT } from './config.js';
import { PEER_PROTOCOL, PEER_ROUTE, record, resolvePc } from './peer.js';
import { autoConfig, publishedKokuban } from './auto-update-publication.js';

export const REPOS = ['kokuban', 'computeruse'] as const;
export type RepoName = typeof REPOS[number];
const GITHUB: Record<RepoName, string> = {
  kokuban: 'https://github.com/52kokada/kokuban-agent-board.git',
  computeruse: 'https://github.com/52kokada/computeruse-windows.git',
};
const MAX_BUNDLE_BYTES = 300 * 1024 * 1024;
const KEPT = 30;
const OFFER_EXPIRE_MS = 12 * 3_600_000;

export interface RepoInfo { head: string; ts: number; subject: string }

export interface Offer {
  id: string;
  /** The offering PC, by full tailnet name. */
  pc: string;
  person: string;
  repos: Partial<Record<RepoName, { head: string; subjects: string[]; install: boolean }>>;
  /** The Windows app (app-update.ts), when the offering PC has a newer one. */
  app?: { version: string; install: boolean };
  state: 'asking' | 'installing' | 'done' | 'failed' | 'declined' | 'expired';
  ts: number;
  cardId?: number;
  result?: string;
}

export interface UpdateDeps {
  /** Automatic callers pin a separately validated release and supply transaction guards. */
  expectedHead?: string;
  beforeApply?: (dir: string, before: string, after: string) => Promise<void>;
  rollback?: (dir: string, before: string, after: string) => Promise<void>;
  fetch?: typeof fetch;
  resolve?: (pc: string) => Promise<string>;
  /** Where each repository is on this PC; null when it is not here. */
  where?: (name: RepoName) => string | null;
  /** Applies computeruse from a bundle (its own updater); resolves to a one-line outcome. */
  applyComputeruse?: (dir: string, bundle: string) => Promise<string>;
  /** Where a repository that is not on this PC yet is cloned to. */
  cloneTo?: (name: RepoName) => string;
  /** Installs computeruse into a fresh clone; resolves to a one-line outcome. */
  installComputeruse?: (dir: string) => Promise<string>;
  /** Builds kokuban after its code changed. */
  build?: (dir: string, lockChanged: boolean) => Promise<void>;
  /** Restarts this board on the new build. */
  restart?: () => void | Promise<void>;
  /** This PC's trust list, by full tailnet name. */
  trusted?: () => string[];
  /** Where the app's releases are kept, and where it runs when installed (tests). */
  appFeed?: string;
  appExe?: string;
  /** Runs the app's Setup.exe; resolves to a one-line outcome. */
  installApp?: (setup: string, packageId: string) => Promise<string>;
}

/** Get the newest Windows app from another PC into this PC's feed; install it where it is not yet. */
async function pullApp(from: string, deps: UpdateDeps): Promise<string> {
  const feed = deps.appFeed ?? APP_FEED;
  const installed = fs.existsSync(deps.appExe ?? APP_EXE);
  const ours = appHello(feed, deps.appExe ?? APP_EXE)?.version ?? '';
  // A PC without the app asks for Setup.exe alone; one with it, for the newer package only.
  const got = await post(from, { op: 'app', ...(installed && ours ? { have: ours } : {}), setup: !installed }, deps, 30_000);
  if (got.same) return `app: already on ${ours}`;
  const files = (Array.isArray(got.files) ? got.files : []) as AppFile[];
  const fetched: string[] = [];
  for (const meta of files) {
    fetched.push(await fetchFile(meta, async (offset) => {
      const part = await post(from, { op: 'app_chunk', file: meta.name, offset }, deps, 120_000);
      return Buffer.from(str(part.data), 'base64');
    }, feed));
  }
  const version = str(got.version);
  if (!installed) {
    const setup = fetched.find((f) => path.basename(f) === SETUP);
    if (!setup) return `app: ${short(from)} sent no Setup.exe`;
    // Checked here as well as in installApp: a package whose install folder is the board's data never runs.
    const id = str((got.asset as AppAsset | undefined)?.PackageId);
    if (collides(id)) return `app: refused, package "${id}" would install into the board's own data folder`;
    return `app: ${version}, ${await (deps.installApp ?? installApp)(setup, id)}`;
  }
  listApp(got.asset as AppAsset, feed);
  return `app: ${ours || 'none'} -> ${version}; it updates itself when none of its windows is open`;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const bare = (name: string): string => name.toLowerCase().replace(/\.$/, '');
const short = (pc: string): string => pc.split('.')[0]!;
const isRepo = (v: unknown): v is RepoName => REPOS.includes(v as RepoName);

// -- this PC's repositories -----------------------------------------------------------------------

export function git(dir: string, args: string[], timeout = 120_000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { windowsHide: true, timeout, maxBuffer: 16 << 20, encoding: 'utf8' },
      (err, out, errOut) => resolve({ ok: !err, out: String(out).trim(), err: String(errOut).trim() || (err?.message ?? '') }));
  });
}

/** kokuban is this checkout; computeruse is named in settings.json "repos", else found beside it or in the usual places. */
export function repoDir(name: RepoName): string | null {
  if (name === 'kokuban') return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  let named = '';
  try {
    named = str((JSON.parse(fs.readFileSync(SETTINGS.file, 'utf8')) as { repos?: Record<string, unknown> }).repos?.[name]);
  } catch {
    /* no settings */
  }
  const candidates = [named, path.join(repoDir('kokuban')!, '..', name),
    path.join(os.homedir(), 'githubprojects', name), path.join(os.homedir(), 'computeruse-workspace', name)].filter(Boolean);
  return candidates.find((d) => fs.existsSync(path.join(d, '.git'))) ?? null;
}

/** The place a repository that is not here yet is cloned to. */
const newDir = (name: RepoName): string => path.join(path.dirname(repoDir('kokuban')!), name);

/** A configured hub must never fall back to distributing its unreviewed keeper checkout. */
export function distributionRepoDir(name: RepoName): string | null {
  if (name === 'kokuban' && autoConfig()?.role === 'hub') return publishedKokuban();
  return repoDir(name);
}

/** Which main each repository here is on: what `hello` tells other PCs. */
export async function repoInfo(where: (n: RepoName) => string | null = repoDir): Promise<Partial<Record<RepoName, RepoInfo>>> {
  const out: Partial<Record<RepoName, RepoInfo>> = {};
  for (const name of REPOS) {
    const dir = where(name);
    if (!dir) continue;
    const log = await git(dir, ['log', '-1', '--format=%h%x09%ct%x09%s', 'main'], 10_000);
    if (!log.ok) continue;
    const [head, ts, subject] = log.out.split('\t');
    out[name] = { head: head!, ts: Number(ts) * 1000, subject: subject ?? '' };
  }
  return out;
}

// -- giving code ----------------------------------------------------------------------------------

/** /peer op "code": main of one repository as a git bundle, only what the asker lacks when it says what it has. */
export async function codeAsked(input: Record<string, unknown>, where: (n: RepoName) => string | null = distributionRepoDir): Promise<{ status: number; body: object }> {
  const name = input.repo;
  if (!isRepo(name)) return { status: 400, body: { ok: false, error: `repo must be one of ${REPOS.join(', ')}` } };
  const dir = where(name);
  if (!dir) return { status: 404, body: { ok: false, error: `${name} is not on this PC` } };
  const head = await git(dir, ['rev-parse', 'main']);
  if (!head.ok) return { status: 500, body: { ok: false, error: `${name} has no main here` } };
  const published = (await git(dir, ['rev-parse', 'refs/remotes/origin/main'])).out === head.out;
  if (input.publishedOnly === true && !published)
    return { status: 409, body: { ok: false, error: 'main does not match origin/main; not published' } };
  const have = str(input.have);
  const range = ['main'];
  if (/^[0-9a-f]{7,40}$/.test(have) && (await git(dir, ['merge-base', '--is-ancestor', have, 'main'])).ok) {
    if (head.out.startsWith(have) || (await git(dir, ['rev-parse', have])).out === head.out) {
      return { status: 200, body: { ok: true, protocol: PEER_PROTOCOL, head: head.out.slice(0, 7), commit: head.out, published, same: true } };
    }
    range.push(`^${have}`);
  }
  const file = path.join(os.tmpdir(), `kokuban-${name}-${randomBytes(6).toString('hex')}.bundle`);
  try {
    const made = await git(dir, ['bundle', 'create', file, ...range]);
    if (!made.ok) return { status: 500, body: { ok: false, error: `could not bundle ${name}: ${made.err.slice(0, 200)}` } };
    const bytes = fs.readFileSync(file);
    if (bytes.length > MAX_BUNDLE_BYTES) return { status: 500, body: { ok: false, error: `${name} bundle is over ${MAX_BUNDLE_BYTES >> 20} MB` } };
    return { status: 200, body: { ok: true, protocol: PEER_PROTOCOL, head: head.out.slice(0, 7), commit: head.out, published, full: range.length === 1, bundle: bytes.toString('base64') } };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// -- talking to the other board -------------------------------------------------------------------

export async function post(pc: string, body: Record<string, unknown>, deps: UpdateDeps, timeout = 15_000): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`http://${pc}:${PORT}${PEER_ROUTE}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: PEER_PROTOCOL, ...body }), signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    // A timeout or a refused connection: the PC is off, asleep, or has no kokuban /peer on the tailnet.
    const why = (err as Error).name === 'TimeoutError' || /abort|timeout/i.test((err as Error).message)
      ? 'no answer in time: off, asleep, or no kokuban /peer there' : (err as Error).message.slice(0, 120);
    throw new Error(`${short(pc)} did not answer (${why})`);
  }
  const out = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` })) as Record<string, unknown>;
  if (!res.ok || out.ok === false) throw new Error(`${short(pc)}: ${str(out.error) || `HTTP ${res.status}`}`);
  return out;
}

function trustedPcs(): string[] {
  try {
    return Object.keys((JSON.parse(fs.readFileSync(SETTINGS.file, 'utf8')) as { trust?: object }).trust ?? {}).map(bare);
  } catch {
    return [];
  }
}

// -- applying -------------------------------------------------------------------------------------

function sh(command: string, cwd: string, timeout = 900_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('cmd.exe', ['/d', '/s', '/c', command], { cwd, windowsHide: true, timeout, maxBuffer: 32 << 20 },
      (err, out, errOut) => resolve({ ok: !err, out: `${out}${errOut}`.trim() }));
  });
}

/**
 * Stop the programs running from this checkout's node_modules (Electron, on a PC coming from before
 * the Windows app): they hold files there, and npm ci cannot replace a file in use (EPERM, pc-b,
 * 2026-10-16). The board itself runs from Node's own folder, not from node_modules.
 */
function freeModules(dir: string): Promise<void> {
  const modules = path.join(dir, 'node_modules').replace(/'/g, "''");
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${modules}\\', 'OrdinalIgnoreCase') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000 }, () => resolve());
  });
}

async function buildKokuban(dir: string, lockChanged: boolean): Promise<void> {
  if (lockChanged && process.platform === 'win32') await freeModules(dir);
  const run = await sh(lockChanged ? 'npm ci' : 'npm run build', dir);
  if (!run.ok) throw new Error(`${lockChanged ? 'npm ci' : 'npm run build'} failed: ${run.out.slice(-400)}`);
}

/**
 * Start the board again from the logon entry, then leave. The new process inherits KOKUBAN_WAIT_PORT,
 * so it waits for this one to let go of the port instead of bowing out. Not detached: a detached
 * console program opens a terminal window on the person's screen.
 */
export function restartBoard(board: Board): boolean {
  const vbs = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'kokuban.vbs');
  if (!fs.existsSync(vbs)) return false;
  setTimeout(() => {
    spawn('wscript.exe', [vbs], { windowsHide: true, stdio: 'ignore', env: { ...process.env, KOKUBAN_WAIT_PORT: '1' } }).unref();
    board.flush();
    setTimeout(() => process.exit(0), 300);
  }, 1500);
  return true;
}

/** computeruse's own updater, as the incoming commit has it (the one here may predate bundles). */
async function applyComputeruse(dir: string, bundle: string): Promise<string> {
  const script = path.join(os.tmpdir(), `update_checkout-${randomBytes(4).toString('hex')}.py`);
  const show = await git(dir, ['show', 'refs/kokuban/incoming:scripts/update_checkout.py']);
  if (!show.ok) return `not updated: the incoming computeruse has no scripts/update_checkout.py`;
  fs.writeFileSync(script, show.out);
  const python = path.join(dir, '.venv', 'Scripts', 'python.exe');
  try {
    const run = await new Promise<{ ok: boolean; out: string }>((resolve) => {
      execFile(fs.existsSync(python) ? python : 'python', ['-X', 'utf8', script, dir, repoDir('kokuban')!, '--only=computeruse', `--computeruse-bundle=${bundle}`],
        { windowsHide: true, timeout: 900_000, maxBuffer: 16 << 20 }, (err, out, errOut) => resolve({ ok: !err, out: `${out}${errOut}` }));
    });
    let report: { stopped?: string; computeruse?: { head_before?: string; head_after?: string; requirements?: string } } = {};
    try {
      report = JSON.parse(run.out.slice(run.out.indexOf('{')));
    } catch {
      return `not updated: ${run.out.trim().slice(-300)}`;
    }
    if (report.stopped) return `not updated: ${report.stopped}`;
    const c = report.computeruse ?? {};
    return `${c.head_before} -> ${c.head_after}${c.requirements ? `, requirements ${c.requirements}` : ''}; its API and agent sessions pick it up when restarted`;
  } finally {
    fs.rmSync(script, { force: true });
  }
}

async function installComputeruse(dir: string): Promise<string> {
  const log = path.join(DATA_DIR, 'updates', 'computeruse-install.log');
  const out = fs.openSync(log, 'w');
  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'scripts', 'install.ps1'), '-NoVoice'],
    { cwd: dir, windowsHide: true, stdio: ['ignore', out, out] }).unref();
  return `cloned to ${dir}; installing now (log: ${log}). Then register it for the agents: scripts\\register-mcp.ps1`;
}

/** Get one repository's main from another PC and apply it. Returns one line on what happened. */
async function pullRepo(name: RepoName, from: string, deps: UpdateDeps, restartNeeded: { kokuban: boolean }): Promise<string> {
  const where = deps.where ?? repoDir;
  const dir = where(name);
  const local = dir ? await git(dir, ['rev-parse', 'HEAD']) : { ok: false, out: '' };
  const got = await post(from, { op: 'code', repo: name, ...(local.ok ? { have: local.out } : {}) }, deps, 300_000);
  if (got.same) return `${name}: already on ${str(got.head)}`;
  const store = path.join(DATA_DIR, 'updates');
  fs.mkdirSync(store, { recursive: true });
  const bundle = path.join(store, `${name}-${str(got.head)}.bundle`);
  fs.writeFileSync(bundle, Buffer.from(str(got.bundle), 'base64'));

  if (!dir) {
    if (name !== 'computeruse') return `${name}: not on this PC`;
    const target = (deps.cloneTo ?? newDir)(name);
    const cloned = await git(path.dirname(target), ['clone', '-b', 'main', bundle, target], 600_000);
    if (!cloned.ok) return `${name}: could not clone (${cloned.err.slice(0, 200)})`;
    await git(target, ['remote', 'set-url', 'origin', GITHUB[name]]);
    return `${name}: ${await (deps.installComputeruse ?? installComputeruse)(target)}`;
  }

  const fetched = await git(dir, ['fetch', bundle, '+refs/heads/main:refs/kokuban/incoming']);
  if (!fetched.ok) return `${name}: the bundle from ${short(from)} did not apply here (${fetched.err.slice(0, 200)})`;
  const incoming = (await git(dir, ['rev-parse', 'refs/kokuban/incoming'])).out;
  if (deps.expectedHead && incoming !== deps.expectedHead) return `${name}: release changed after validation; left alone`;
  if ((await git(dir, ['merge-base', '--is-ancestor', 'refs/kokuban/incoming', 'HEAD'])).ok) return `${name}: already has everything ${short(from)} has`;
  if (name === 'computeruse') return `${name}: ${await (deps.applyComputeruse ?? applyComputeruse)(dir, bundle)}`;

  // kokuban: this checkout carries no settings or history of its own, so anything but line endings stops it.
  if ((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).out !== 'main') return `${name}: not on main here; left alone`;
  if (deps.beforeApply && (await git(dir, ['status', '--porcelain', '--untracked-files=normal'])).out)
    return `${name}: local edits or untracked files; left alone`;
  const dirty = (await git(dir, ['diff', '--name-only'])).out.split('\n').filter(Boolean);
  for (const f of dirty) if ((await git(dir, ['diff', '--quiet', '--ignore-cr-at-eol', '--', f])).ok) await git(dir, ['checkout', '--', f]);
  const left = (await git(dir, ['diff', '--name-only'])).out;
  if (left) return `${name}: local edits here (${left.split('\n').slice(0, 4).join(', ')}); left alone`;
  if (!(await git(dir, ['merge-base', '--is-ancestor', 'HEAD', 'refs/kokuban/incoming'])).ok) {
    return `${name}: this PC has commits ${short(from)} lacks; not a fast-forward, left alone`;
  }
  const before = (await git(dir, ['rev-parse', 'HEAD'])).out;
  const lockChanged = (await git(dir, ['diff', '--name-only', 'HEAD', 'refs/kokuban/incoming', '--', 'package-lock.json'])).out !== '';
  if (deps.beforeApply) await deps.beforeApply(dir, before, incoming);
  const merged = await git(dir, ['merge', '--ff-only', incoming]);
  if (!merged.ok) return `${name}: fast-forward failed (${merged.err.slice(0, 200)})`;
  try {
    await (deps.build ?? buildKokuban)(dir, lockChanged);
  } catch (err) {
    if (deps.rollback) await deps.rollback(dir, before, incoming);
    return `${name}: ${before} -> ${str(got.head)}, but ${(err as Error).message}`;
  }
  restartNeeded.kokuban = true;
  return `${name}: ${before.slice(0, 7)} -> ${str(got.head)}; the board restarts on it in a moment`;
}

/** `kokuban update [--from pc]`: each repository from the paired PC with the newest commit, or all from one. */
const updatingBoards = new WeakSet<Board>();
const restartingBoards = new WeakSet<Board>();
export function blockUpdatesForRestart(board: Board): () => void {
  restartingBoards.add(board);
  return () => restartingBoards.delete(board);
}
export async function pullUpdate(board: Board, opts: { from?: string; repos?: RepoName[]; app?: boolean }, deps: UpdateDeps = {}): Promise<{ ok: boolean; lines: string[] }> {
  if (updatingBoards.has(board) || restartingBoards.has(board)) return { ok: false, lines: ['An update is already running or restarting; retry later'] };
  updatingBoards.add(board);
  try { return await pullUpdateLocked(board, opts, deps); }
  finally { updatingBoards.delete(board); }
}
async function pullUpdateLocked(board: Board, opts: { from?: string; repos?: RepoName[]; app?: boolean }, deps: UpdateDeps = {}): Promise<{ ok: boolean; lines: string[] }> {
  // Without a choice of repositories, everything: both repositories and the app. Asked for the app
  // alone (an update card that offers only it), no repository.
  const repos = opts.repos?.length ? opts.repos : opts.app === undefined ? [...REPOS] : [];
  const wantApp = opts.app ?? !opts.repos?.length;
  const ours = await repoInfo(deps.where ?? repoDir);
  const ourApp = appHello(deps.appFeed ?? APP_FEED, deps.appExe ?? APP_EXE)?.version ?? '';
  const source: Partial<Record<RepoName, string>> = {};
  // Where to get the app: the PCs that can give a newer one, newest first; the next is tried when one refuses.
  let appFroms: string[] = [];
  if (opts.from) {
    const pc = await (deps.resolve ?? resolvePc)(opts.from);
    for (const r of repos) source[r] = pc;
    if (wantApp) appFroms = [pc];
  } else {
    const pcs = (deps.trusted ?? trustedPcs)();
    const heard = await Promise.all(pcs.map(async (pc) => {
      try {
        const said = await post(pc, { op: 'hello' }, deps, 5000);
        // What a PC can give is what its feed holds ("gives"), not what it runs: a PC that installed the
        // app from Setup.exe has none to hand on. A board from before "gives" said only "version".
        const app = said.app as { version?: unknown; gives?: unknown } | null;
        return { pc, repos: (said.repos ?? {}) as Partial<Record<RepoName, RepoInfo>>, app: str(app?.gives ?? app?.version) };
      } catch {
        return { pc, repos: {}, app: '' };
      }
    }));
    if (wantApp) {
      appFroms = heard.filter((h) => h.app && newer(h.app, ourApp)).sort((x, y) => (newer(x.app, y.app) ? -1 : newer(y.app, x.app) ? 1 : 0)).map((h) => h.pc);
    }
    for (const r of repos) {
      const newest = heard.filter((h) => h.repos[r] && h.repos[r]!.head !== ours[r]?.head && h.repos[r]!.ts > (ours[r]?.ts ?? 0))
        .sort((x, y) => y.repos[r]!.ts - x.repos[r]!.ts)[0];
      if (newest) source[r] = newest.pc;
    }
  }
  const lines: string[] = [];
  const restart = { kokuban: false };
  let ok = true;
  // computeruse first: kokuban's restart ends this process.
  for (const r of [...repos.filter((x) => x !== 'kokuban'), ...repos.filter((x) => x === 'kokuban')]) {
    const from = source[r];
    if (!from) {
      lines.push(`${r}: ${ours[r] ? `${ours[r]!.head} is the newest among the paired PCs that answered` : 'not on this PC, and no paired PC offered it'}`);
      continue;
    }
    try {
      const line = await pullRepo(r, from, deps, restart);
      if (/not updated|did not apply|could not|left alone|failed|but /.test(line)) ok = false;
      lines.push(`${line} (from ${short(from)})`);
    } catch (err) {
      ok = false;
      lines.push(`${r}: ${(err as Error).message}`);
    }
  }
  // The app before kokuban, whose restart ends this process.
  if (wantApp && appFroms.length) {
    const refused: string[] = [];
    for (const from of appFroms) {
      try {
        const line = await pullApp(from, deps);
        if (/failed|no Setup|refused/.test(line)) ok = false;
        lines.push(`${line} (from ${short(from)})`);
        refused.length = 0;
        break;
      } catch (err) {
        refused.push(`${short(from)}: ${(err as Error).message.replace(/^[^:]+: /, '')}`);
      }
    }
    if (refused.length) {
      ok = false;
      lines.push(`app: ${refused.join('; ')}`);
    }
  } else if (wantApp && !opts.from) {
    lines.push(`app: ${ourApp ? `${ourApp} is the newest among the paired PCs that answered` : 'no paired PC has published it'}`);
  }
  record(board, { dir: 'in', pc: Object.values(source)[0] ?? appFroms[0] ?? '', agent: 'kokuban', op: 'update', to: '', text: lines.join(' | ').slice(0, 300) });
  // A scheduled restart keeps every later update (manual or automatic) out until this process exits.
  if (restart.kokuban) await (deps.restart ?? (() => { if (restartBoard(board)) blockUpdatesForRestart(board); }))();
  return { ok, lines };
}

// -- offering (`kokuban update <pc>`) -------------------------------------------------------------

/** Offer this PC's commits to another PC, whose person decides on a card. */
export async function offerUpdate(board: Board, target: string, deps: UpdateDeps = {}): Promise<{ ok: boolean; lines: string[] }> {
  const pc = await (deps.resolve ?? resolvePc)(target);
  const where = deps.where ?? repoDir;
  const ours = await repoInfo(where);
  const said = await post(pc, { op: 'hello' }, deps, 8000);
  const theirs = (said.repos ?? {}) as Partial<Record<RepoName, RepoInfo>>;
  const theirApp = said.app as { version?: unknown; installed?: unknown } | null | undefined;
  const repos: Offer['repos'] = {};
  const lines: string[] = [];
  for (const r of REPOS) {
    const mine = ours[r];
    if (!mine) continue;
    const their = theirs[r];
    if (their?.head === mine.head) { lines.push(`${r}: ${short(pc)} already runs ${mine.head}`); continue; }
    if (their && their.ts > mine.ts) { lines.push(`${r}: ${short(pc)} has a newer one (${their.head}); not offered`); continue; }
    const dir = where(r)!;
    const known = their && (await git(dir, ['merge-base', '--is-ancestor', their.head, 'main'])).ok;
    const subjects = known ? (await git(dir, ['log', '--format=%s', '-8', `${their!.head}..main`])).out.split('\n').filter(Boolean) : [mine.subject];
    repos[r] = { head: mine.head, subjects, install: !their };
    lines.push(`${r}: offered ${mine.head}${their ? ` (${short(pc)} runs ${their.head})` : ` (not on ${short(pc)} yet: it would be installed)`}`);
  }
  // The Windows app, when this PC has published a newer one than that PC holds.
  const ourApp = newestApp(deps.appFeed ?? APP_FEED)?.Version ?? '';
  let app: Offer['app'];
  if (ourApp && (!str(theirApp?.version) || newer(ourApp, str(theirApp?.version)))) {
    app = { version: ourApp, install: theirApp?.installed !== true };
    lines.push(`app: offered ${ourApp}${app.install ? ` (not on ${short(pc)} yet: it would be installed)` : ''}`);
  } else if (ourApp) {
    lines.push(`app: ${short(pc)} already has ${str(theirApp?.version)}`);
  }
  if (!Object.keys(repos).length && !app) return { ok: true, lines };
  await post(pc, { op: 'offer', id: randomBytes(16).toString('hex'), person: personName(), repos, ...(app ? { app } : {}) }, deps);
  record(board, { dir: 'out', pc, agent: 'kokuban', op: 'offer', to: '', text: lines.join(' | ').slice(0, 300) });
  lines.push(`The person at ${short(pc)} decides on a card there; kokuban pair shows its versions afterwards.`);
  return { ok: true, lines };
}

function offerWords(o: Offer, l: 'ja' | 'en'): { question: string; details: string; choices: string[] } {
  const names = [...Object.keys(o.repos), ...(o.app ? [l === 'ja' ? 'Kokuban アプリ' : 'the Kokuban app'] : [])].join(l === 'ja' ? 'と' : ' and ');
  const fresh = l === 'ja' ? '（新規インストール）' : ' (new install)';
  const list = [
    ...Object.entries(o.repos).map(([r, v]) => `${r} ${v!.head}${v!.install ? fresh : ''}:\n${v!.subjects.map((s) => `  - ${s}`).join('\n')}`),
    ...(o.app ? [`${l === 'ja' ? 'Kokuban アプリ' : 'Kokuban app'} ${o.app.version}${o.app.install ? fresh : ''}`] : []),
  ].join('\n');
  return l === 'ja'
    ? { question: `${o.person}さん（${short(o.pc)}）から ${names} の更新が届きました。今インストールしますか？`,
        details: `${list}\n\nkokuban は数秒だけ再起動します。このPCの設定と学習した知識はそのまま残ります。`, choices: ['インストール', '今はしない'] }
    : { question: `${o.person} (${short(o.pc)}) sent updates for ${names}. Install them now?`,
        details: `${list}\n\nkokuban restarts for a few seconds. This PC's own settings and learned knowledge are kept.`, choices: ['Install', 'Not now'] };
}

/** /peer op "offer": a paired PC sends its commits; a card for this PC's person, nothing more until they say Install. */
export function offerAsked(board: Board, from: string, input: Record<string, unknown>, lang: 'ja' | 'en' | 'both'): { status: number; body: object } {
  const raw = (input.repos ?? {}) as Record<string, unknown>;
  const repos: Offer['repos'] = {};
  for (const [r, v] of Object.entries(raw)) {
    if (!isRepo(r) || !v || typeof v !== 'object') continue;
    const e = v as { head?: unknown; subjects?: unknown; install?: unknown };
    if (!/^[0-9a-f]{7,40}$/.test(str(e.head))) continue;
    repos[r] = { head: str(e.head), install: e.install === true,
      subjects: (Array.isArray(e.subjects) ? e.subjects : []).map(str).filter(Boolean).slice(0, 8).map((s) => s.slice(0, 120)) };
  }
  const rawApp = input.app as { version?: unknown; install?: unknown } | undefined;
  const app = rawApp && /^\d+\.\d+\.\d+[\w.+-]*$/.test(str(rawApp.version))
    ? { version: str(rawApp.version).slice(0, 40), install: rawApp.install === true } : undefined;
  const id = str(input.id);
  if (!/^[0-9a-f]{32}$/.test(id) || (!Object.keys(repos).length && !app)) {
    return { status: 400, body: { ok: false, error: 'an offer needs an id and at least one repository or the app' } };
  }
  for (const old of board.offers.filter((x) => bare(x.pc) === bare(from) && x.state === 'asking')) {
    old.state = 'expired';
    const card = board.cards.find((c) => c.id === old.cardId);
    if (card) closeCard(board, card, 'withdrawn');
  }
  const offer: Offer = { id, pc: from, person: str(input.person).slice(0, 40) || short(from), repos, ...(app ? { app } : {}), state: 'asking', ts: board.clock() };
  const en = offerWords(offer, 'en');
  const ja = offerWords(offer, 'ja');
  const words = lang === 'both'
    ? { question: `${en.question} / ${ja.question}`, details: `${en.details}\n\n${ja.details}`, choices: en.choices.map((c, i) => `${c} / ${ja.choices[i]}`) }
    : lang === 'ja' ? ja : en;
  const card = makeCard(board, { agent: 'kokuban', pc: from }, { ...words, person: offer.person, lang: lang === 'ja' ? 'ja' : 'en' });
  offer.cardId = card.id;
  board.offers.push(offer);
  board.offers = board.offers.slice(-KEPT);
  board.save();
  record(board, { dir: 'in', pc: from, agent: 'kokuban', op: 'offer', to: '', text: `${offer.person} sent ${[...Object.keys(repos), ...(app ? ['app'] : [])].join(', ')}` });
  return { status: 200, body: { ok: true, protocol: PEER_PROTOCOL, state: 'asking', card: card.id } };
}

/** The person picked on an update card. Returns what the card's thread shows. */
export async function offerDecided(board: Board, card: Card, choice: string, deps: UpdateDeps = {}): Promise<string> {
  const o = board.offers.find((x) => x.cardId === card.id);
  const ja = card.lang === 'ja';
  if (!o) return ja ? 'この更新は見つかりません。' : 'This update is no longer known here.';
  const index = card.choices.indexOf(choice);
  if (index < 0) return ja ? '「インストール」か「今はしない」を選んでください。' : 'Pick Install or Not now.';
  if (index === 1) {
    o.state = 'declined';
    board.save();
    return ja ? '今回はインストールしません。' : 'Not installed.';
  }
  if (o.state === 'installing') return ja ? 'インストール中です。' : 'Already installing.';
  if (o.state === 'done') return o.result ?? '';
  o.state = 'installing';
  board.save();
  const out = await pullUpdate(board, { from: o.pc, repos: Object.keys(o.repos) as RepoName[], app: Boolean(o.app) }, deps);
  o.state = out.ok ? 'done' : 'failed';
  o.result = out.lines.join('\n');
  board.save();
  return o.result;
}

/** Give up on update cards nobody answered in half a day. */
export function sweepOffers(board: Board): void {
  const now = board.clock();
  for (const o of board.offers.filter((x) => x.state === 'asking' && now - x.ts > OFFER_EXPIRE_MS)) {
    o.state = 'expired';
    board.save();
  }
}
