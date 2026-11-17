import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { SETTINGS } from '../src/cards.js';
import { repoIdentity } from '../src/git.js';
import { handleHook } from '../src/hooks.js';
import { applyWrite, getBlock, queuedWrites, revisions, type KeeperConfig, type WriteRequest } from '../src/vault-keeper.js';
import {
  WORKING_COPIES_FACT, afterGit, collect, enableWorkingCopies, refresh, workingCopyHint, workingCopySettings, type WorkingCopy,
} from '../src/vault-working-copies.js';

const temp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-wc-')));
SETTINGS.file = path.join(temp(), 'settings.json');
const NOW = Date.parse('2026-11-06T09:00:00Z');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args],
  { cwd, env, encoding: 'utf8', windowsHide: true });

/** A clone of a bare origin: one pushed commit, then two local ones, a change, an untracked file, a stash and a worktree. */
function checkout(name = 'demo'): { root: string; wt: string } {
  const base = temp();
  const origin = path.join(base, 'origin.git');
  git(base, 'init', '--bare', origin);
  const root = path.join(base, name);
  git(base, 'clone', origin, root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'first');
  git(root, 'push', '-u', 'origin', 'main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  git(root, 'commit', '-am', 'second, not pushed');
  fs.writeFileSync(path.join(root, 'a.txt'), 'stashed\n');
  git(root, 'stash');
  const wt = path.join(base, `${name}-feature`);
  git(root, 'worktree', 'add', '-b', 'feature', wt);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-m', 'feature work');
  fs.writeFileSync(path.join(wt, 'c.txt'), 'c\n');
  fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'new\n');
  return { root, wt };
}
const author = (pc: string): WriteRequest['author'] => ({ agent: 'kokuban', pc });
let n = 0;
const rid = (): string => `test-${(n++).toString().padStart(4, '0')}`;
/** A vault with a project space for `name`, as a session's seed makes it. */
function vault(name = 'demo'): string {
  const root = temp();
  applyWrite(root, { request_id: rid(), kind: 'summary', space: `project:${name}`, text: 'Demo repository.', source: 'test',
    project: { remote: '', docs: [] }, author: author('keeper-pc') }, NOW);
  return root;
}
const row = (over: Partial<WorkingCopy> = {}): WorkingCopy => ({
  folder: 'C:\\Users\\sam\\githubprojects\\demo', branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, local: 2,
  newest: ['main: fix booking form', 'feature: new calendar'], changed: 3, untracked: 1, stash: 0, worktrees: [],
  last_commit: '2026-11-06T08:30:00+09:00', checked: '2026-11-06T09:00:00.000Z', ...over,
});
const write = (root: string, pc: string, w: WorkingCopy, extra: Partial<WriteRequest> = {}) => applyWrite(root, {
  request_id: rid(), kind: 'fact', space: 'project:demo', page: WORKING_COPIES_FACT, text: `${pc} ${w.folder}`, source: 'kokuban: local git on this PC',
  working_copies: w, author: author(pc), ...extra,
}, NOW);
const page = (root: string): string => {
  const dir = path.join(root, 'Unsorted', 'Projects', 'demo');
  return fs.readFileSync(path.join(dir, 'Facts', 'working-copies.md'), 'utf8');
};
const keeperCfg = (root: string, keeper = true): KeeperConfig => ({ path: root, keeper, keeperPc: 'keeper-pc' });

test('collect reads branch, upstream, unpushed commits, changes, stash and worktrees from local git only', async () => {
  const { root, wt } = checkout();
  const w = (await collect(root, NOW))!;
  assert.equal(w.folder, path.normalize(root));
  assert.equal(w.branch, 'main');
  assert.equal(w.upstream, 'origin/main');
  assert.deepEqual([w.ahead, w.behind], [1, 0]);
  // "second" on main and "feature work" on the worktree's branch: neither is on any remote.
  assert.equal(w.local, 2);
  assert.ok(w.newest.includes('main: second, not pushed') && w.newest.includes('feature: feature work'), w.newest.join(' / '));
  assert.deepEqual([w.changed, w.untracked, w.stash], [1, 1, 1]);
  assert.equal(w.worktrees.length, 1);
  assert.match(w.worktrees[0]!, /\(feature, 1 changed\)$/);
  assert.ok(w.worktrees[0]!.startsWith(path.normalize(wt)));
  assert.ok(Date.parse(w.last_commit) > 0);
  assert.equal(w.checked, new Date(NOW).toISOString());
  assert.equal(await collect(temp(), NOW), null);
});

test('the keeper keeps one row per PC and folder, replaces only the sender\'s row, and writes no log line', () => {
  const root = vault();
  assert.equal(write(root, 'pc-b', row()).state, 'written');
  assert.equal(write(root, 'keeper-pc', row({ folder: 'C:\\Users\\sam\\githubprojects\\demo', local: 0, newest: [], changed: 0, untracked: 0 })).state, 'written');
  assert.equal(write(root, 'pc-b', row({ local: 5, newest: ['main: a | b'] })).state, 'written');
  const text = page(root);
  const table = getBlock(text, 'fact')!.split('\n');
  assert.equal(table.length, 4, table.join('\n'));
  assert.match(table[0]!, /^\| pc \| folder \| branch \| upstream \| ahead\/behind \| not on any remote \|/);
  assert.match(table[2]!, /^\| keeper-pc \|/);
  assert.match(table[3]!, /^\| pc-b \| C:\\Users\\sam\\githubprojects\\demo \| main \| origin\/main \| 1\/0 \| 5: main: a \\\| b \| 3 \| 1 \| 0 \| - \| 2026-11-05 23:30Z \| 2026-11-06 09:00Z \|$/);
  assert.match(text, /^---\nfact: "working-copies"/);
  const log = fs.readFileSync(path.join(root, 'Unsorted', 'Projects', 'demo', 'log.md'), 'utf8');
  assert.doesNotMatch(log, /working/);
  assert.equal(revisions(root).filter((r) => r.page === 'Facts/working-copies.md' && r.kind === 'fact').length, 3);
  // Listed among the space's facts.
  assert.match(fs.readFileSync(path.join(root, 'Unsorted', 'Projects', 'demo', 'Overview.md'), 'utf8'), /Facts\/working-copies/);
});

test('a person\'s edit of the table is kept and reported once; an emptied table is written again', () => {
  const root = vault();
  write(root, 'pc-b', row());
  const file = path.join(root, 'Unsorted', 'Projects', 'demo', 'Facts', 'working-copies.md');
  fs.writeFileSync(file, page(root).replace('fix booking form', 'edited by hand'));
  assert.equal(write(root, 'pc-b', row({ local: 9 })).state, 'conflict');
  assert.equal(write(root, 'pc-b', row({ local: 8 })).state, 'unchanged');
  assert.match(page(root), /edited by hand/);
  fs.writeFileSync(file, page(root).replace(/<!-- keeper:fact -->[\s\S]*<!-- \/keeper:fact -->/, '<!-- keeper:fact -->\n<!-- /keeper:fact -->'));
  assert.equal(write(root, 'pc-b', row({ local: 7 })).state, 'written');
  assert.match(page(root), /\| 7: main/);
});

test('a working-copies write is refused outside its page, with a bad shape, or with a credential in it', () => {
  const root = vault();
  assert.throws(() => write(root, 'pc-b', row(), { page: 'Facts/other' }), /working_copies is a fact/);
  assert.throws(() => write(root, 'pc-b', row(), { kind: 'event' }), /working_copies is a fact/);
  assert.throws(() => write(root, 'pc-b', { ...row(), local: -1 }), /one working copy/);
  assert.throws(() => write(root, 'pc-b', row({ newest: ['main: password=hunter2hunter2'] })), /credential/);
});

test('refresh sends a repository\'s row once per state, only for a repository with a space; a non-keeper queues and keeps only the newest', async () => {
  const { root } = checkout();
  const board = new Board();
  const none = await refresh(board, repoIdentity(root)!, { config: () => keeperCfg(temp()), now: () => NOW, pc: () => 'keeper-pc' });
  assert.equal(none, 'no space');
  const v = vault();
  const deps = { config: () => keeperCfg(v), now: () => NOW, pc: () => 'keeper-pc' };
  assert.equal(await refresh(board, repoIdentity(root)!, deps), 'sent');
  assert.match(page(v), /\| keeper-pc \| .*demo \| main \| origin\/main \| 1\/0 \| 2: /);
  assert.equal(await refresh(board, repoIdentity(root)!, deps), 'unchanged');
  fs.writeFileSync(path.join(root, 'more.txt'), 'x\n');
  assert.equal(await refresh(board, repoIdentity(root)!, deps), 'sent');

  // Another PC whose keeper is away: the write waits in its queue, and a newer state replaces the older one.
  const synced = vault();
  const away = { config: () => keeperCfg(synced, false), now: () => NOW, pc: () => 'pc-b', resolve: async () => 'keeper-pc.invalid',
    fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch };
  const other = checkout();
  // A different folder of the same repository name maps to the same space.
  assert.equal(await refresh(board, repoIdentity(other.root)!, away, { force: true }), 'sent');
  fs.writeFileSync(path.join(other.root, 'more.txt'), 'x\n');
  assert.equal(await refresh(board, repoIdentity(other.root)!, away), 'sent');
  const waiting = queuedWrites(synced);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0]!.working_copies!.untracked, 2);
  assert.ok(!fs.existsSync(path.join(synced, 'Unsorted', 'Projects', 'demo', 'Facts', 'working-copies.md')), 'a non-keeper never writes the page');
});

test('peers hint names other PCs with work not on any remote or uncommitted, never this PC', () => {
  const { root } = checkout();
  const v = vault();
  write(v, 'pc-b', row());
  write(v, 'keeper-pc', row({ local: 4 }));
  write(v, 'desk-a', row({ folder: '/Users/sam/githubprojects/demo', local: 0, newest: [], changed: 0, untracked: 0 }));
  const hint = workingCopyHint(keeperCfg(v), root, 'keeper-pc');
  assert.match(hint, /^Other PCs' working copies of this repo: pc-b demo on main: 2 commit\(s\) on no remote, 4 uncommitted file\(s\) \(checked 2026-11-06 09:00Z\)\. /);
  assert.doesNotMatch(hint, /keeper-pc|desk-a/);
  assert.match(hint, /vault op="read" space="project:demo" page="Facts\/working-copies"/);
  assert.equal(workingCopyHint(keeperCfg(v), temp(), 'keeper-pc'), '');
  assert.equal(workingCopyHint(null, root), '');
});

test('an agent\'s git commit schedules one refresh, only on an enabled board; other commands do nothing', () => {
  const { root } = checkout();
  const board = new Board();
  assert.equal(afterGit(board, root, 'git commit -m x'), false);
  const v = vault();
  enableWorkingCopies(board, { config: () => keeperCfg(v), now: () => NOW, pc: () => 'keeper-pc', settings: () => ({ roots: [], fetch: false }) });
  assert.equal(afterGit(board, root, 'npm test', 60_000), false);
  assert.equal(afterGit(board, root, 'git status', 60_000), false);
  assert.equal(afterGit(board, root, 'cd x && git push origin main', 60_000), true);
  assert.equal(afterGit(board, root, 'git commit -am again', 60_000), false, 'one refresh is already waiting');
  // Through the hook: a Claude PostToolUse carries the command.
  const { root: other } = checkout('demo2');
  handleHook(board, 'claude', { hook_event_name: 'PostToolUse', session_id: 's1', cwd: other, tool_name: 'Bash', tool_input: { command: 'git commit -m y' } });
  assert.equal(afterGit(board, other, 'git commit -m z', 60_000), false, 'the hook scheduled it');
});

test('settings: on by default with ~/githubprojects, off with false, roots and fetch when given', () => {
  const file = path.join(temp(), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ vault: { path: 'x' } }));
  assert.deepEqual(workingCopySettings(file), { roots: [path.join(os.homedir(), 'githubprojects')], fetch: false });
  fs.writeFileSync(file, JSON.stringify({ vault: { path: 'x', working_copies: false } }));
  assert.equal(workingCopySettings(file), null);
  fs.writeFileSync(file, JSON.stringify({ vault: { path: 'x', working_copies: { roots: ['D:\\code'], fetch: true } } }));
  assert.deepEqual(workingCopySettings(file), { roots: ['D:\\code'], fetch: true });
});
