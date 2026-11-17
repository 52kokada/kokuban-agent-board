/**
 * D91: every repository a session opens gets a project space in the shared vault, made once by the keeper and
 * seeded from the repo's README, and its sessions are told to keep it current. D101–D103: the space is filed by
 * business (<Business>/Projects/<repo>, a client's Projects/, Shared tools/ or Unsorted/; see vault-layout.ts).
 *
 * Cheap and fail-open by design: the hook only does cached lookups and a few small file reads, the
 * write itself runs after the hook has answered, at most once per repository per daemon run, and is
 * queued like any other write while the keeper is unreachable.
 */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Board, Session } from './board.js';
import { repoIdentity, type RepoIdentity } from './git.js';
import { thisPc } from './know.js';
import { queuedWrites } from './vault-queue.js';
import { PROJECT_DOCS, groupingOf, keeperConfig, useGrouping, type KeeperConfig } from './vault-store.js';
import { person } from './vault-tool.js';
import { sendToKeeper, type KeeperDeps } from './vault-transport.js';
import { applyWrite, validateWrite, type WriteRequest } from './vault-write.js';
import { clipChars } from './text-cut.js';
import { canonicalRepo, findProject, guessPlace, placeDir } from './vault-layout.js';

export interface ProjectSpace {
  /** The write space, "project:<repo>". */
  key: string;
  /** The folder in the vault, e.g. "Shared tools/Projects/kokuban". */
  dir: string;
  repo: RepoIdentity;
  /** exists: the local synced vault has it; requested: this run asked the keeper for it. */
  state: 'exists' | 'requested';
  /** The local vault folder this space was found in (D133 reads its catch-up from here). */
  vault: string;
  /** A new space: this PC's guess of its business (it can read the README; the keeper has the last word). */
  business?: string;
}

interface State {
  /** cwd → repository root (null: not a repository, or one that never gets a space). */
  roots: Map<string, string | null>;
  repos: Map<string, RepoIdentity>;
  /** repository root → its space this run; null: not eligible. */
  spaces: Map<string, ProjectSpace | null>;
  /** session id → the cwd last looked at, so ordinary tool events cost one map lookup. */
  noticed: Map<string, string>;
  pending: Set<Promise<void>>;
}
const states = new WeakMap<Board, State>();
function stateOf(board: Board): State {
  let st = states.get(board);
  if (!st) states.set(board, st = { roots: new Map(), repos: new Map(), spaces: new Map(), noticed: new Map(), pending: new Set() });
  return st;
}

export type ProjectDeps = KeeperDeps & { home?: string };
const enabled = new WeakMap<Board, ProjectDeps>();
/**
 * Turn project spaces on for a board: the daemon does so for its own board. A board nobody enabled (a
 * test, a CLI command) never looks at the vault, so it can never write to a real one.
 */
export function enableProjectSpaces(board: Board, deps: ProjectDeps = {}): void {
  enabled.set(board, deps);
}

const SPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A repository folder name as a vault folder: ASCII letters, digits, ".", "_" and "-"; never empty. */
export function spaceName(folder: string): string {
  const clean = folder.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '').slice(0, 80).replace(/[.-]+$/, '');
  return clean || `repo-${createHash('sha256').update(folder).digest('hex').slice(0, 8)}`;
}

const same = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
/** True when `dir` is `parent` or inside it. */
function within(dir: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(dir));
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel)) || same(path.resolve(dir), path.resolve(parent));
}
/** Home-directory repositories (dotfiles) and the vault itself never get a space. */
function eligible(repo: RepoIdentity, cfg: KeeperConfig, home = os.homedir()): boolean {
  return !within(home, repo.root) && !within(repo.root, cfg.path) && !within(cfg.path, repo.root);
}

/**
 * The space's folder wherever it is filed (D101: a business, a client, Shared tools, Unsorted, or the old
 * Projects/ before the regroup): by name, an alias, or an Overview naming the same remote (a renamed space).
 */
function existing(cfg: KeeperConfig, name: string, remote: string): string | null {
  const dir = findProject(cfg.path, groupingOf(cfg.path), name, remote);
  return dir && fs.existsSync(path.join(cfg.path, ...dir.split('/'), 'Overview.md')) && SPACE_NAME.test(path.posix.basename(dir)) ? dir : null;
}
/** D131: the project space a repository already has in the local synced vault (none for an ineligible one). */
export function existingSpace(cfg: KeeperConfig, repo: RepoIdentity, home?: string): { key: string; dir: string } | null {
  if (!eligible(repo, cfg, home)) return null;
  const dir = existing(cfg, spaceName(repo.name), repo.remote);
  return dir ? { key: `project:${path.posix.basename(dir)}`, dir } : null;
}
/** D131: the repositories this board's sessions opened during this daemon run. */
export function seenRepos(board: Board): RepoIdentity[] {
  return [...stateOf(board).repos.values()];
}
/** Where a new space will go: the mapping, else the guess from the name, remote and README (the keeper decides). */
function predicted(cfg: KeeperConfig, repo: RepoIdentity, name: string): { dir: string; business?: string } {
  const g = groupingOf(cfg.path);
  const guess = guessPlace(g, { name, remote: repo.remote, readme: readmeText(repo) });
  const business = guess.place.kind === 'business' || guess.place.kind === 'client' ? guess.place.business.key : guess.place.kind;
  return { dir: placeDir(cfg.path, g, guess.place, canonicalRepo(g, name)), business };
}

/**
 * The project space for a session's repository, asking the keeper to make it the first time this daemon
 * run sees a repository without one. `full` (SessionStart) rechecks the settings and the vault; other
 * events return at once when the session's cwd has not changed. Never throws.
 */
export function projectSpace(board: Board, s: Session, full = false): ProjectSpace | null {
  try {
    const cwd = s.cwd;
    const deps = enabled.get(board);
    if (!cwd || !deps) return null;
    const st = stateOf(board);
    if (!full && st.noticed.get(s.id) === cwd) return null;
    st.noticed.set(s.id, cwd);
    const cfg = (deps.config ?? keeperConfig)();
    if (!cfg || !fs.existsSync(cfg.path)) return null;
    if (cfg.grouping) useGrouping(cfg.path, cfg.grouping);
    let root = st.roots.get(cwd);
    if (root === undefined) {
      const repo = repoIdentity(cwd);
      root = repo && eligible(repo, cfg, deps.home) ? repo.root : null;
      st.roots.set(cwd, root);
      if (repo && root) st.repos.set(root, repo);
    }
    if (!root) return null;
    const known = st.spaces.get(root);
    if (known === null) return null;
    if (known) {
      if (known.state === 'requested') {
        // The keeper may have filed it elsewhere than this PC guessed.
        const now = existing(cfg, known.key.slice('project:'.length), known.repo.remote);
        if (now) Object.assign(known, { dir: now, state: 'exists' });
      }
      return known;
    }
    const repo = st.repos.get(root)!;
    const name = spaceName(repo.name);
    const found = existing(cfg, name, repo.remote);
    const guess = found ? null : predicted(cfg, repo, name);
    const dir = found ?? guess!.dir;
    const space: ProjectSpace = { key: `project:${found ? path.posix.basename(found) : name}`, dir, repo, vault: cfg.path, state: found ? 'exists' : 'requested',
      ...(guess?.business ? { business: guess.business } : {}) };
    st.spaces.set(root, space);
    // A seed already waiting in this PC's queue (an earlier run, the keeper still away) is not sent twice.
    if (!found && !queuedWrites(cfg.path).some((w) => w.project && w.space === space.key)) seed(board, s, cfg, space, deps);
    return space;
  } catch (err) {
    board.usage?.({ ts: board.clock(), tool: 'vault:project', ok: false, text: (err as Error).message.slice(0, 200) });
    return null;
  }
}

/** Wait for this board's seeds in flight (tests, and a clean shutdown). */
export async function projectSeeds(board: Board): Promise<void> {
  while (stateOf(board).pending.size) await Promise.allSettled([...stateOf(board).pending]);
}

/** The one guidance line for a session in a repository with a space. */
export function projectLine(space: ProjectSpace | null): string {
  if (!space) return '';
  return `[kokuban] This repo's shared context: ${space.dir} in the vault. Read its Overview first; record decisions, rules and ` +
    `current direction there (vault write space="${space.key}").`;
}

const README_CHARS = 64_000;
const SUMMARY_CHARS = 600;
/** The first paragraph of prose in a README: no headings, badges, HTML, code, tables or rules. */
export function firstParagraph(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  let para: string[] = [];
  let fence = false;
  const clean = (l: string): string => l
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*>\s?/, '')
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, '$1')
    .replace(/\s+/g, ' ').trim();
  for (const raw of [...lines, '']) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; para = []; continue; }
    if (fence) continue;
    const skip = /^\s*(#|\||<!--|[-=*_]{3,}\s*$)/.test(raw);
    const text = skip ? '' : clean(raw);
    if (text) { para.push(text); continue; }
    const joined = para.join(' ').trim();
    para = [];
    if (joined.length >= 10) return clipChars(joined, SUMMARY_CHARS);
  }
  return '';
}

function docsOf(repo: RepoIdentity): string[] {
  let files: string[] = [];
  try { files = fs.readdirSync(repo.root); } catch { /* unreadable: no docs */ }
  return PROJECT_DOCS.flatMap((d) => files.find((f) => f.toLowerCase() === d.toLowerCase()) ?? []);
}
/** The first 64 KB of the repository's README ("" without one). */
function readmeText(repo: RepoIdentity): string {
  const readme = docsOf(repo).find((d) => d.toLowerCase() === 'readme.md');
  if (!readme) return '';
  try {
    const fd = fs.openSync(path.join(repo.root, readme), 'r');
    try {
      const buf = Buffer.alloc(README_CHARS);
      return buf.subarray(0, fs.readSync(fd, buf, 0, README_CHARS, 0)).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch {
    return '';
  }
}
/** What the seed says: the README's first paragraph, and which of README/AGENTS/CLAUDE the repo has. */
function seedText(repo: RepoIdentity): { text: string; docs: string[]; fromReadme: boolean } {
  const text = firstParagraph(readmeText(repo));
  return { text, docs: docsOf(repo), fromReadme: Boolean(text) };
}

function seed(board: Board, s: Session, cfg: KeeperConfig, space: ProjectSpace, deps: KeeperDeps): void {
  const run = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
    const now = (deps.now ?? board.clock)();
    const { text, docs, fromReadme } = seedText(space.repo);
    const owner = person();
    const name = space.key.slice('project:'.length);
    const fallback = `Repository ${name}${space.repo.remote ? ` (${space.repo.remote})` : ''}. No summary yet: agents working here add one.`;
    const make = (summary: string, source: string): WriteRequest => ({
      request_id: `seed-${now.toString(36)}-${randomBytes(6).toString('hex')}`,
      kind: 'summary', space: space.key, text: summary, source,
      project: { remote: space.repo.remote, docs, ...(space.business ? { business: space.business } : {}) },
      author: { agent: s.name, pc: (deps.pc ?? thisPc)(), ...(owner ? { person: owner } : {}) },
    });
    let req = make(fromReadme ? text : fallback, fromReadme ? `README.md of ${space.repo.remote || name}` : `repository ${space.repo.remote || name}`);
    try { validateWrite(req); }
    // A README paragraph that looks like a credential (or is otherwise refused) never blocks the space.
    catch { req = make(fallback, `repository ${space.repo.remote || name}`); validateWrite(req); }
    if (cfg.keeper) applyWrite(cfg.path, req, now);
    else if ((await sendToKeeper(cfg, req, now, deps)).queued) board.usage?.({ ts: board.clock(), tool: 'vault:queue', me: s.name, ok: false });
    board.usage?.({ ts: board.clock(), tool: 'vault:project', me: s.name, ok: true, text: space.key });
  }).catch((err: Error) => {
    board.usage?.({ ts: board.clock(), tool: 'vault:project', me: s.name, ok: false, text: err.message.slice(0, 200) });
  });
  const pending = stateOf(board).pending;
  const tracked = run.finally(() => pending.delete(tracked));
  pending.add(tracked);
}
