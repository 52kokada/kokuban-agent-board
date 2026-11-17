import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { SETTINGS } from '../src/cards.js';
import { repoIdentity } from '../src/git.js';
import { handleHook } from '../src/hooks.js';
import { frontmatter, getBlock, queued, queuedWrites, revisions, type KeeperConfig } from '../src/vault-keeper.js';
import { enableProjectSpaces, firstParagraph, projectSeeds, projectSpace, spaceName, type ProjectDeps } from '../src/vault-projects.js';

const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-projects-'));
const NOW = Date.parse('2026-11-05T09:00:00Z');
const file = (root: string, rel: string): string => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const README = '# Kokuban\n\n[![CI](https://x/badge.svg)](https://x)\n<p align="center"><img src="logo.png"></p>\n\n' +
  'One **board** per PC for Claude Code, Codex and [Kimi](https://kimi.ai).\nIt carries mail between sessions.\n\n## Install\n\nnpm i\n';

/** A repository on disk: .git/config with an origin, a README and AGENTS.md; optionally a Claude worktree. */
function repo(name = 'kokuban', remote = 'https://alex:ghp_secret@github.com/Alex/kokuban.git'): string {
  const root = path.join(temp(), name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(root, 'README.md'), README);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n');
  fs.mkdirSync(path.join(root, 'src'));
  return root;
}
/** A linked worktree, the way `git worktree add` (and Claude's .claude/worktrees) leave it. */
function worktree(main: string, at: string, id = 'wt'): string {
  const meta = path.join(main, '.git', 'worktrees', id);
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(meta, 'HEAD'), 'ref: refs/heads/feature\n');
  fs.mkdirSync(path.join(at, 'src'), { recursive: true });
  fs.writeFileSync(path.join(at, '.git'), `gitdir: ${meta}\n`);
  return at;
}
async function withSettings(settings: object, run: () => Promise<void>): Promise<void> {
  const old = SETTINGS.file;
  SETTINGS.file = path.join(temp(), 'settings.json');
  fs.writeFileSync(SETTINGS.file, JSON.stringify(settings));
  try { await run(); } finally { SETTINGS.file = old; }
}
const keeper = (vault: string): ProjectDeps => ({ config: (): KeeperConfig => ({ path: vault, keeper: true, keeperPc: 'keeper-pc' }), pc: () => 'keeper-pc', now: () => NOW });
const start = (board: Board, id: string, cwd: string): Record<string, any> | null =>
  handleHook(board, 'claude', { hook_event_name: 'SessionStart', session_id: id, cwd, source: 'startup' }) as Record<string, any> | null;
const context = (out: Record<string, any> | null): string => String(out?.hookSpecificOutput?.additionalContext ?? '');
const seeds = (vault: string): number => revisions(vault).filter((r) => r.request_id?.startsWith('seed-') && r.kind === 'summary').length;

test('repository identity: worktrees map to their main repository, credentials leave the remote, odd names become safe folders', () => {
  const main = repo();
  assert.deepEqual(repoIdentity(path.join(main, 'src')), { root: main, name: 'kokuban', remote: 'https://github.com/Alex/kokuban.git' });
  const claude = worktree(main, path.join(main, '.claude', 'worktrees', 'agent-1'), 'agent-1');
  assert.equal(repoIdentity(path.join(claude, 'src'))!.root, main);
  const elsewhere = worktree(main, path.join(temp(), 'kokuban-feature'), 'feature');
  assert.equal(repoIdentity(elsewhere)!.root, main);
  assert.equal(repoIdentity(temp()), null);
  assert.equal(spaceName('kokuban'), 'kokuban');
  assert.equal(spaceName('my repo (old)'), 'my-repo-old');
  assert.equal(spaceName('..hidden.'), 'hidden');
  assert.match(spaceName('日本語'), /^repo-[0-9a-f]{8}$/);
});

test('the first paragraph of a README skips titles, badges, HTML and code', () => {
  assert.equal(firstParagraph(README), 'One board per PC for Claude Code, Codex and Kimi. It carries mail between sessions.');
  assert.equal(firstParagraph('---\ntitle: x\n---\n# T\n\n```\ncode here is not prose\n```\n\n> A quoted tagline for the tool.\n'), 'A quoted tagline for the tool.');
  assert.equal(firstParagraph('# Only a title\n'), '');
});

test('a new repository gets its project space exactly once, seeded from its README and listed on Home', () => withSettings({ person: 'Alex' }, async () => {
  const vault = temp();
  const main = repo();
  const claude = worktree(main, path.join(main, '.claude', 'worktrees', 'agent-1'), 'agent-1');
  const board = new Board();
  enableProjectSpaces(board, keeper(vault));
  const first = start(board, 'a', path.join(main, 'src'));
  // The hook answers before the keeper writes anything.
  assert(!fs.existsSync(path.join(vault, 'Shared tools', 'Projects', 'kokuban')));
  assert.match(context(first), /This repo's shared context: Shared tools\/Projects\/kokuban in the vault\. Read its Overview first; record decisions, rules and current direction there \(vault write space="project:kokuban"\)\./);
  // A second session, in a Claude worktree of the same repository, and later tool events: no second seed.
  start(board, 'b', path.join(claude, 'src'));
  handleHook(board, 'claude', { hook_event_name: 'PostToolUse', session_id: 'a', cwd: path.join(main, 'src') });
  await projectSeeds(board);
  assert.equal(seeds(vault), 1);
  const overview = file(vault, 'Shared tools/Projects/kokuban/Overview.md');
  const fm = frontmatter(overview);
  assert.equal(fm.repo, 'kokuban');
  assert.equal(fm.remote, 'https://github.com/Alex/kokuban.git');
  assert.match(String(fm.created_by), /@keeper-pc \(Alex\)$/);
  assert.equal(fm.created, new Date(NOW).toISOString());
  assert.equal(getBlock(overview, 'summary'), 'One board per PC for Claude Code, Codex and Kimi. It carries mail between sessions.');
  assert.match(overview, /\[README\.md\]\(https:\/\/github\.com\/Alex\/kokuban\/blob\/HEAD\/README\.md\)/);
  assert.match(overview, /\[AGENTS\.md\]\(https:\/\/github\.com\/Alex\/kokuban\/blob\/HEAD\/AGENTS\.md\)/);
  assert.doesNotMatch(overview, /CLAUDE\.md|npm i|ghp_secret/);
  assert(fs.existsSync(path.join(vault, 'Shared tools', 'Projects', 'kokuban', 'Decisions.md')));
  assert.equal(getBlock(file(vault, 'Shared tools/Home.md'), 'projects'), '- [[Shared tools/Projects/kokuban/Overview|kokuban]] — https://github.com/Alex/kokuban.git');
  assert.match(file(vault, 'Shared tools/Projects/kokuban/log.md'), /summary/);
  // A later daemon run finds it and writes nothing; the line still appears.
  const next = new Board();
  enableProjectSpaces(next, keeper(vault));
  // D133: once the space has entries, a session receives its catch-up instead of the pointer.
  fs.appendFileSync(path.join(vault, 'Shared tools', 'Projects', 'kokuban', 'Decisions.md'),
    '\n## Accepted\n\n- 2026-11-07 05:00Z **Board guidance** — keep it short\n  _source: test_ ^r-d133aa\n');
  const brief = context(start(next, 'c', main));
  assert.match(brief, /Vault catch-up for project:kokuban[\s\S]*# project:kokuban[\s\S]*One board per PC for Claude Code, Codex and Kimi\./);
  assert.match(brief, /based on: /);
  await projectSeeds(next);
  assert.equal(seeds(vault), 1);
  // A second repository, Acme's by the D102 mapping, is listed on Acme's Home.
  start(next, 'd', repo('acme-cockpit', 'git@github.com:Alex/acme-cockpit.git'));
  await projectSeeds(next);
  assert.equal(getBlock(file(vault, 'Acme/Home.md'), 'projects'), '- [[Acme/Projects/acme-cockpit/Overview|acme-cockpit]] — git@github.com:Alex/acme-cockpit.git');
  assert.match(getBlock(file(vault, 'Home.md'), 'businesses')!, /\[\[Acme\/Home\|Acme\]\] — 1 project[\s\S]*\[\[Shared tools\/Home\|Shared tools\]\] — 1 project/);
}));

test('a space a person already made (or renamed) is found and never overwritten', () => withSettings({}, async () => {
  const vault = temp();
  const mine = '---\nremote: "https://github.com/Alex/kokuban.git"\n---\n# Our board\n\nHand-written.\n';
  fs.mkdirSync(path.join(vault, 'Projects', 'board'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Projects', 'board', 'Overview.md'), mine);
  const board = new Board();
  enableProjectSpaces(board, keeper(vault));
  assert.match(context(start(board, 'a', repo())), /Projects\/board in the vault[\s\S]*space="project:board"/);
  await projectSeeds(board);
  assert.equal(seeds(vault), 0);
  assert.equal(file(vault, 'Projects/board/Overview.md'), mine);
  assert(!fs.existsSync(path.join(vault, 'Projects', 'kokuban')));
}));

test('no space for a folder outside git, a home-directory repository, the vault itself, or a board the daemon did not enable', () => withSettings({}, async () => {
  const vault = temp();
  const board = new Board();
  const home = repo('alex');
  enableProjectSpaces(board, { ...keeper(vault), home });
  assert.doesNotMatch(context(start(board, 'a', temp())), /shared context/);
  assert.doesNotMatch(context(start(board, 'b', path.join(home, 'src'))), /shared context/);
  fs.mkdirSync(path.join(vault, '.git'));
  assert.doesNotMatch(context(start(board, 'c', vault)), /shared context/);
  const off = new Board();
  assert.equal(projectSpace(off, off.touch('x', repo(), 'claude').session, true), null);
  await projectSeeds(board);
  await projectSeeds(off);
  assert.deepEqual(fs.readdirSync(vault).filter((f) => f !== '.git'), []);
}));

test('the hook stays fast and fails open: a missing vault does nothing, an unreachable keeper queues the seed once', () => withSettings({}, async () => {
  const board = new Board();
  const missing = path.join(temp(), 'no-vault');
  enableProjectSpaces(board, { config: () => ({ path: missing, keeper: false, keeperPc: 'keeper-pc' }) });
  const out = start(board, 'a', repo());
  assert.doesNotMatch(context(out), /shared context/);
  await projectSeeds(board);
  assert(!fs.existsSync(missing), 'a missing vault is never created');

  const vault = temp();
  let calls = 0;
  const slowDown = (async () => { calls++; await new Promise((r) => setTimeout(r, 400)); throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  const away: ProjectDeps = { config: () => ({ path: vault, keeper: false, keeperPc: 'keeper-pc' }), fetch: slowDown,
    resolve: async () => 'keeper-pc.tail.ts.net', pc: () => 'pc-c', now: () => NOW };
  const other = new Board();
  enableProjectSpaces(other, away);
  const main = repo();
  const t0 = Date.now();
  const line = context(start(other, 'b', main));
  assert(Date.now() - t0 < 300, `the hook waited ${Date.now() - t0} ms`);
  assert.match(line, /Shared tools\/Projects\/kokuban in the vault/);
  await projectSeeds(other);
  assert.equal(calls, 1);
  assert.equal(queued(vault).length, 1);
  const [w] = queuedWrites(vault);
  assert.equal(w!.space, 'project:kokuban');
  assert.deepEqual(w!.project, { remote: 'https://github.com/Alex/kokuban.git', docs: ['README.md', 'AGENTS.md'], business: 'shared' });
  assert(!fs.existsSync(path.join(vault, 'Projects')) && !fs.existsSync(path.join(vault, 'Shared tools')), 'a non-keeper never writes synced notes');
  // The next daemon run sees the waiting seed and does not queue another.
  const again = new Board();
  enableProjectSpaces(again, away);
  start(again, 'c', main);
  await projectSeeds(again);
  assert.equal(calls, 1);
  assert.equal(queued(vault).length, 1);
}));
