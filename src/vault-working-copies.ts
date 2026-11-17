/**
 * D131: every PC's git working copies in the vault, so an agent reads one page instead of asking another PC.
 * Each repository with a project space gets `Facts/working-copies.md`: one row per PC and folder with its
 * branch, upstream, ahead/behind, commits that no remote has, changed/untracked/stash counts, worktrees and
 * times. Local git only (an optional `git fetch` behind settings); never file contents or diffs.
 *
 * The rows are collected on each PC and sent as a fact write carrying `working_copies`, so they go the
 * normal way: applied on the keeper, forwarded to it from every other PC (queued while it is away). The
 * keeper replaces only the sending PC's row for that folder. Refreshed after an agent's git commit, push,
 * merge and the like (Claude PostToolUse, no process per event otherwise), and by an hourly sweep.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Board } from './board.js';
import { SETTINGS } from './cards.js';
import { repoIdentity, type RepoIdentity } from './git.js';
import { noSecrets, thisPc } from './know.js';
import { dropQueued, queuedWrites } from './vault-queue.js';
import { getBlock, keeperConfig, read, setBlock, setFrontmatter, type KeeperConfig } from './vault-store.js';
import { sendToKeeper, type KeeperDeps } from './vault-transport.js';
import { applyWrite, type WriteRequest } from './vault-write.js';
import { existingSpace, seenRepos } from './vault-projects.js';

export const WORKING_COPIES_PAGE = 'Facts/working-copies.md';
export const WORKING_COPIES_FACT = 'Facts/working-copies';

/** One PC's checkout of a repository, as it is sent to the keeper (the PC comes from the verified caller). */
export interface WorkingCopy {
  folder: string;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  /** Commits on local branches that no remote-tracking branch contains. */
  local: number;
  /** The newest of those, "branch: subject", at most three. */
  newest: string[];
  changed: number;
  untracked: number;
  stash: number;
  /** Linked worktrees: "folder (branch, N changed)". */
  worktrees: string[];
  /** ISO times. */
  last_commit: string;
  checked: string;
}

// -- collecting (local git only) ------------------------------------------------------------------

/** git without a window, a prompt or an index lock; null when it fails or times out. */
function git(cwd: string, args: string[], timeout = 15_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'credential.interactive=never', ...args], {
      cwd, windowsHide: true, timeout, maxBuffer: 4 << 20,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}
const lines = (s: string | null): string[] => (s ?? '').split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
/** A commit subject or branch name that looks like a credential never leaves the PC. */
function clean(s: string, max = 80): string {
  const one = s.replace(/\s+/g, ' ').trim();
  try { noSecrets(one, { links: true }); } catch { return '(withheld)'; }
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
const MAX_LOCAL = 500;
const MAX_WORKTREES = 12;

/** The working copy at a repository's main folder. Never throws; a folder git cannot read gives null. */
export async function collect(root: string, now = Date.now(), opts: { fetch?: boolean } = {}): Promise<WorkingCopy | null> {
  if (opts.fetch) await git(root, ['fetch', '--quiet', '--no-tags'], 60_000);
  const status = await git(root, ['status', '--porcelain=v2', '--branch']);
  if (status === null) return null;
  let branch = '', upstream = '', ahead = 0, behind = 0, changed = 0, untracked = 0;
  for (const l of lines(status)) {
    if (l.startsWith('# branch.head ')) branch = l.slice(14);
    else if (l.startsWith('# branch.upstream ')) upstream = l.slice(18);
    else if (l.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(l);
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
    } else if (l.startsWith('? ')) untracked++;
    else if (/^[12u] /.test(l)) changed++;
  }
  const [unpushed, last, stash, trees] = await Promise.all([
    git(root, ['log', '--branches', '--not', '--remotes', '--source', `--max-count=${MAX_LOCAL}`, '--format=%S%x09%s']),
    git(root, ['log', '-1', '--format=%cI']),
    git(root, ['stash', 'list', '--format=%gd']),
    git(root, ['worktree', 'list', '--porcelain']),
  ]);
  const local = lines(unpushed);
  const newest = local.slice(0, 3).map((l) => {
    const [ref = '', ...rest] = l.split('\t');
    return `${clean(ref.replace(/^refs\/heads\//, ''), 40)}: ${clean(rest.join('\t'))}`;
  });
  // The first block is the main working tree (this folder); the others are linked worktrees.
  const linked = (trees ?? '').replace(/\r/g, '').split('\n\n').slice(1).flatMap((b) => {
    const dir = /^worktree (.+)$/m.exec(b)?.[1];
    if (!dir || /^prunable/m.test(b) || !fs.existsSync(dir)) return [];
    const ref = /^branch refs\/heads\/(.+)$/m.exec(b)?.[1];
    return [{ dir: path.normalize(dir), branch: ref ? clean(ref, 60) : 'detached' }];
  });
  const worktrees = await Promise.all(linked.slice(0, MAX_WORKTREES).map(async (w) => {
    const n = lines(await git(w.dir, ['status', '--porcelain=v1'])).length;
    return `${w.dir} (${w.branch}${n ? `, ${n} changed` : ''})`;
  }));
  if (linked.length > MAX_WORKTREES) worktrees.push(`+${linked.length - MAX_WORKTREES} more`);
  return {
    folder: path.normalize(root), branch: branch === '(detached)' ? 'detached' : clean(branch, 60), upstream: clean(upstream, 60),
    ahead, behind, local: local.length, newest, changed, untracked, stash: lines(stash).length, worktrees,
    last_commit: lines(last)[0] ?? '', checked: new Date(now).toISOString(),
  };
}

// -- the page (on the keeper) ---------------------------------------------------------------------

const COLUMNS = ['pc', 'folder', 'branch', 'upstream', 'ahead/behind', 'not on any remote', 'changed', 'untracked', 'stash', 'worktrees', 'last commit', 'checked'];
const HEADER = `| ${COLUMNS.join(' | ')} |\n|${COLUMNS.map(() => ' --- ').join('|')}|`;
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const cells = (line: string): string[] => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
/** Every time in UTC, "2026-11-06 09:00Z", so rows from PCs in different zones compare at a glance. */
const short = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')}Z` : '';
};
const key = (pc: string, folder: string): string => `${pc}\n${folder}`.toLowerCase();

export function rowLine(pc: string, w: WorkingCopy): string {
  const local = w.local ? `${w.local >= MAX_LOCAL ? `${MAX_LOCAL}+` : w.local}${w.newest.length ? `: ${w.newest.join(' · ')}` : ''}` : '0';
  return `| ${[pc, w.folder, w.branch || '?', w.upstream || 'none', w.upstream ? `${w.ahead}/${w.behind}` : '-', local,
    String(w.changed), String(w.untracked), String(w.stash), w.worktrees.join('; ') || '-', short(w.last_commit), short(w.checked)].map(cell).join(' | ')} |`;
}
export const PAGE_INTRO = '# Working copies\n\nKept by Kokuban: every PC\'s git checkout of this repository, from local git only (no file ' +
  'contents). "not on any remote" counts commits on local branches that no remote branch contains, newest first; "ahead/behind" is ' +
  'against the upstream as last fetched on that PC. Rows refresh after an agent\'s commit or push and hourly; "checked" says when.\n\n';

/** The table with this PC's row for this folder replaced (or added), sorted by PC and folder. */
export function mergeRows(table: string, pc: string, w: WorkingCopy): string {
  const rows = new Map<string, string>();
  for (const l of table.split('\n')) {
    if (!/^\s*\|/.test(l) || /^\s*\|\s*pc\s*\|/.test(l) || /^\s*\|[\s:|-]+\|\s*$/.test(l)) continue;
    const c = cells(l);
    if (c.length >= 2) rows.set(key(c[0]!, c[1]!), l.trim());
  }
  rows.set(key(pc, w.folder), rowLine(pc, w));
  return `${HEADER}\n${[...rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, l]) => l).join('\n')}`;
}

/** The page's new text: this PC's row merged into the table (a new page when there is none). */
export function workingCopiesPage(text: string | null, pc: string, w: WorkingCopy, nowIso: string): string {
  const base = text ?? setFrontmatter(`${PAGE_INTRO}<!-- keeper:fact -->\n<!-- /keeper:fact -->\n`, { fact: 'working-copies' });
  const after = setBlock(base, 'fact', mergeRows(getBlock(base, 'fact') ?? '', pc, w));
  return setFrontmatter(after, { updated: nowIso });
}

export function validWorkingCopy(w: unknown): void {
  const o = (w && typeof w === 'object' ? w : {}) as Record<string, unknown>;
  const isStr = (k: string, max: number): boolean => typeof o[k] === 'string' && (o[k] as string).length <= max && !/[\r\n]/.test(o[k] as string);
  const isNum = (k: string): boolean => Number.isInteger(o[k]) && (o[k] as number) >= 0;
  const list = (k: string, n: number): boolean => Array.isArray(o[k]) && (o[k] as unknown[]).length <= n &&
    (o[k] as unknown[]).every((x) => typeof x === 'string' && x.length <= 400 && !/[\r\n]/.test(x));
  if (!isStr('folder', 400) || !o.folder || !['branch', 'upstream'].every((k) => isStr(k, 200)) ||
    !['ahead', 'behind', 'local', 'changed', 'untracked', 'stash'].every(isNum) || !list('newest', 3) || !list('worktrees', MAX_WORKTREES + 1) ||
    !['last_commit', 'checked'].every((k) => isStr(k, 40))) throw new Error('working_copies must be one working copy (folder, branch, counts, times)');
}

// -- sending (every PC) ---------------------------------------------------------------------------

export interface WorkingCopySettings { roots: string[]; fetch: boolean }
/**
 * settings vault.working_copies: false turns it off; {roots, fetch} names the folders whose child repositories are
 * swept (default ~/githubprojects) and whether the sweep runs `git fetch` first (default false).
 */
export function workingCopySettings(file = SETTINGS.file): WorkingCopySettings | null {
  let v: unknown;
  try { v = (JSON.parse(fs.readFileSync(file, 'utf8')) as { vault?: { working_copies?: unknown } }).vault?.working_copies; } catch { v = undefined; }
  if (v === false) return null;
  const o = (v && typeof v === 'object' ? v : {}) as { roots?: unknown; fetch?: unknown };
  const roots = Array.isArray(o.roots) ? o.roots.filter((r): r is string => typeof r === 'string' && !!r.trim()) : [path.join(os.homedir(), 'githubprojects')];
  return { roots, fetch: o.fetch === true };
}

export type WorkingCopyDeps = KeeperDeps & { settings?: () => WorkingCopySettings | null; home?: string };
const enabled = new WeakMap<Board, WorkingCopyDeps>();
/** Only the daemon's own board refreshes working copies; a test or CLI board never runs git or writes. */
export function enableWorkingCopies(board: Board, deps: WorkingCopyDeps = {}): void {
  enabled.set(board, deps);
}
const SAME_AGAIN_MS = 6 * 3600_000;
/** Per repository root: what was last sent (without its check time) and when, so an unchanged state is sent every 6 hours only. */
const sent = new Map<string, { hash: string; at: number }>();

/** Collect one repository and send its row, unless it has no project space or nothing changed. */
export async function refresh(board: Board, repo: RepoIdentity, deps: WorkingCopyDeps = {}, opts: { fetch?: boolean; force?: boolean } = {}): Promise<string> {
  const cfg = (deps.config ?? keeperConfig)();
  if (!cfg || !fs.existsSync(cfg.path)) return 'off';
  const space = existingSpace(cfg, repo, deps.home);
  if (!space) return 'no space';
  const now = (deps.now ?? Date.now)();
  const w = await collect(repo.root, now, opts);
  if (!w) return 'not readable';
  const hash = JSON.stringify({ ...w, checked: '' });
  const last = sent.get(repo.root);
  if (!opts.force && last && last.hash === hash && now - last.at < SAME_AGAIN_MS) return 'unchanged';
  const pc = (deps.pc ?? thisPc)();
  const req: WriteRequest = {
    request_id: `wc-${now.toString(36)}-${randomBytes(6).toString('hex')}`,
    kind: 'fact', space: space.key, page: WORKING_COPIES_FACT, source: 'kokuban: local git on this PC',
    text: `${pc} ${w.folder}: ${w.branch}, ${w.local} commit(s) on no remote, ${w.changed} changed, ${w.untracked} untracked`,
    working_copies: w,
    author: { agent: 'kokuban', pc },
  };
  if (cfg.keeper) applyWrite(cfg.path, req, now);
  else {
    // Only the newest state matters: an older row for this space still waiting in the queue is dropped.
    dropQueued(cfg.path, (q) => !!q.working_copies && q.space === space.key && q.working_copies.folder.toLowerCase() === w.folder.toLowerCase());
    await sendToKeeper(cfg, req, now, deps);
  }
  sent.set(repo.root, { hash, at: now });
  return 'sent';
}

const scheduled = new Map<string, NodeJS.Timeout>();
/** An agent's git command: refresh that repository a few seconds later (once, however many commands). Never throws. */
export function afterGit(board: Board, cwd: string, command: unknown, delayMs = 5_000): boolean {
  try {
    const deps = enabled.get(board);
    if (!deps) return false;
    if (typeof command !== 'string' || !/\bgit\b[^\n]*\b(commit|push|merge|rebase|pull|reset|stash|checkout|switch|cherry-pick|am|worktree|branch)\b/.test(command)) return false;
    if (!(deps.settings ?? workingCopySettings)()) return false;
    const repo = cwd ? repoIdentity(cwd) : null;
    if (!repo || scheduled.has(repo.root)) return false;
    const t = setTimeout(() => {
      scheduled.delete(repo.root);
      void refresh(board, repo, deps).catch((err: Error) => board.usage?.({ ts: board.clock(), tool: 'vault:working-copies', ok: false, text: err.message.slice(0, 200) }));
    }, delayMs);
    t.unref?.();
    scheduled.set(repo.root, t);
    return true;
  } catch {
    return false;
  }
}

/** The repositories to sweep: the child folders of the settings roots, and every repository a session opened. */
export function sweepRepos(board: Board, s: WorkingCopySettings): RepoIdentity[] {
  const found = new Map<string, RepoIdentity>();
  for (const root of s.roots) {
    let names: string[] = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      if (!fs.existsSync(path.join(root, n, '.git'))) continue;
      const r = repoIdentity(path.join(root, n));
      if (r) found.set(r.root.toLowerCase(), r);
    }
  }
  for (const r of seenRepos(board)) found.set(r.root.toLowerCase(), r);
  return [...found.values()];
}

let sweeping = false;
/** The hourly sweep, one repository at a time. */
export async function sweepWorkingCopies(board: Board): Promise<number> {
  const deps = enabled.get(board);
  if (!deps) return 0;
  const s = (deps.settings ?? workingCopySettings)();
  if (!s || sweeping || !(deps.config ?? keeperConfig)()) return 0;
  sweeping = true;
  let n = 0;
  try {
    for (const repo of sweepRepos(board, s)) {
      try { if (await refresh(board, repo, deps, { fetch: s.fetch }) === 'sent') n++; }
      catch (err) { board.usage?.({ ts: board.clock(), tool: 'vault:working-copies', ok: false, text: (err as Error).message.slice(0, 200) }); }
    }
  } finally { sweeping = false; }
  return n;
}

// -- reading: one line for peers ------------------------------------------------------------------

/**
 * One line for a session in a repository whose page shows another PC with work not on any remote or uncommitted
 * files; '' otherwise. Reads the local synced page only.
 */
export function workingCopyHint(cfg: KeeperConfig | null, cwd: string, pc = thisPc()): string {
  try {
    if (!cfg || !cwd) return '';
    const repo = repoIdentity(cwd);
    const space = repo ? existingSpace(cfg, repo) : null;
    if (!space) return '';
    const table = getBlock(read(cfg.path, `${space.dir}/${WORKING_COPIES_PAGE}`) ?? '', 'fact') ?? '';
    const notes = table.split('\n').filter((l) => /^\s*\|/.test(l)).map(cells).flatMap((c) => {
      if (c.length < COLUMNS.length || c[0] === 'pc' || /^-+$/.test(c[0]!) || c[0]!.toLowerCase() === pc.toLowerCase()) return [];
      const local = Number.parseInt(c[5]!, 10) || 0;
      const dirty = (Number(c[6]) || 0) + (Number(c[7]) || 0);
      if (!local && !dirty) return [];
      return [`${c[0]} ${path.win32.basename(c[1]!) || c[1]} on ${c[2]}: ${[local ? `${c[5]!.split(':')[0]} commit(s) on no remote` : '', dirty ? `${dirty} uncommitted file(s)` : '']
        .filter(Boolean).join(', ')} (checked ${c[11]})`];
    });
    return notes.length ? `Other PCs' working copies of this repo: ${notes.join('; ')}. Details: vault op="read" space="${space.key}" page="${WORKING_COPIES_FACT}".` : '';
  } catch {
    return '';
  }
}
