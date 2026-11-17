import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { answerCard, SETTINGS } from '../src/cards.js';
import { ownCard } from '../src/daemon.js';
import { handlePeer } from '../src/peer.js';
import { codeAsked, offerUpdate, pullUpdate, repoInfo, blockUpdatesForRestart, type RepoName, type UpdateDeps } from '../src/update.js';

const A = 'pc-a.tail1234.ts.net';
const B = 'pc-b.tail1234.ts.net';

const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function commit(dir: string, file: string, text: string, message: string, when: number): void {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', file);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message], {
    env: { ...process.env, GIT_AUTHOR_DATE: `${when} +0000`, GIT_COMMITTER_DATE: `${when} +0000` },
  });
}

interface Pc { name: string; board: Board; file: string; repos: Partial<Record<RepoName, string>>; built: string[]; restarted: number; installed: string[] }

async function as<T>(pc: Pc, fn: () => Promise<T> | T): Promise<T> {
  const before = SETTINGS.file;
  SETTINGS.file = pc.file;
  try {
    return await fn();
  } finally {
    SETTINGS.file = before;
  }
}

/**
 * Two PCs paired at "work": A has two commits in each repository, B has the first (or, with
 * `bareB`, no computeruse at all).
 */
function twoPcs(opts: { bareB?: boolean; lang?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-update-'));
  const a: Pc = { name: A, board: new Board(), file: path.join(dir, 'a.json'), repos: {}, built: [], restarted: 0, installed: [] };
  const b: Pc = { name: B, board: new Board(), file: path.join(dir, 'b.json'), repos: {}, built: [], restarted: 0, installed: [] };
  fs.writeFileSync(a.file, JSON.stringify({ person: 'Alex', trust: { [B]: 'work' } }));
  fs.writeFileSync(b.file, JSON.stringify({ person: 'Sam', trust: { [A]: 'work' }, ...(opts.lang ? { lang: opts.lang } : {}) }));
  for (const name of ['kokuban', 'computeruse'] as RepoName[]) {
    const ra = path.join(dir, 'a', name);
    fs.mkdirSync(ra, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', ra]);
    commit(ra, 'README.md', 'one\n', `${name}: first`, 1_700_000_000);
    commit(ra, 'README.md', 'one\ntwo\n', `${name}: second`, 1_700_000_100);
    a.repos[name] = ra;
    if (name === 'computeruse' && opts.bareB) continue;
    const rb = path.join(dir, 'b', name);
    execFileSync('git', ['clone', '-q', ra, rb]);
    git(rb, 'reset', '-q', '--hard', 'HEAD~1');
    b.repos[name] = rb;
  }
  const pcs: Record<string, Pc> = { [A]: a, [B]: b };
  const fetchFrom = (caller: string): typeof fetch => (async (url: string | URL, init?: RequestInit) => {
    const target = pcs[new URL(String(url)).hostname]!;
    const out = await as(target, () => handlePeer(target.board, { 'tailscale-user-login': 'k@x', 'x-forwarded-for': '100.64.0.1' },
      JSON.parse(String(init?.body)), { lookup: async () => ({ login: 'k@x', node: caller }), where: (n) => target.repos[n] ?? null }));
    return new Response(JSON.stringify(out.body), { status: out.status });
  }) as typeof fetch;
  const deps = (pc: Pc): UpdateDeps => ({
    fetch: fetchFrom(pc.name), resolve: async (n) => (n.includes('.') ? n : `${n}.tail1234.ts.net`),
    where: (n) => pc.repos[n] ?? null, trusted: () => [pc === a ? B : A],
    build: async (d, lock) => { pc.built.push(`${path.basename(d)}${lock ? ' ci' : ''}`); },
    restart: () => { pc.restarted++; },
    // computeruse's own updater, reduced to its fast-forward
    applyComputeruse: async (d, bundle) => {
      git(d, 'fetch', '-q', bundle, '+refs/heads/main:refs/remotes/origin/main');
      git(d, 'merge', '-q', '--ff-only', 'origin/main');
      return `now ${git(d, 'log', '-1', '--format=%s')}`;
    },
    installComputeruse: async (d) => { pc.installed.push(d); pc.repos.computeruse = d; return `installed in ${path.basename(d)}`; },
  });
  for (const pc of [a, b]) pc.board.onOwnCard = (card, choice) => as(pc, () => ownCard(pc.board, card, choice, {}, deps(pc)) ?? '');
  return { a, b, deps };
}

const subject = (dir: string): string => git(dir, 'log', '-1', '--format=%s');

test('manual updates cannot enter during asynchronous restart handoff or the restart delay', async () => {
  const { b, deps } = twoPcs();
  let entered!: () => void, finish!: () => void;
  const atRestart = new Promise<void>(r => { entered = r; });
  const pending = new Promise<void>(r => { finish = r; });
  let unblock!: () => void;
  const first = as(b, () => pullUpdate(b.board, { from: A, repos: ['kokuban'] }, {
    ...deps(b), restart: async () => { entered(); await pending; unblock = blockUpdatesForRestart(b.board); },
  }));
  await atRestart;
  assert.equal((await pullUpdate(b.board, { from: A }, deps(b))).ok, false);
  finish(); await first;
  assert.equal((await pullUpdate(b.board, { from: A }, deps(b))).ok, false);
  unblock();
});

test('automatic bundle requests refuse unpushed main and certify a matching origin/main', async () => {
  const { a } = twoPcs();
  const where = (n: RepoName) => a.repos[n] ?? null;
  assert.equal((await codeAsked({ repo: 'kokuban', publishedOnly: true }, where)).status, 409);
  git(a.repos.kokuban!, 'update-ref', 'refs/remotes/origin/main', 'main');
  const response = await codeAsked({ repo: 'kokuban', publishedOnly: true }, where);
  assert.equal(response.status, 200);
  assert.equal((response.body as { published: boolean }).published, true);
  assert.match((response.body as { commit: string }).commit, /^[a-f0-9]{40}$/);
});

test('automatic update pins its release and does not merge a source that changed', async () => {
  const { b, deps } = twoPcs();
  const before = git(b.repos.kokuban!, 'rev-parse', 'HEAD');
  const result = await as(b, () => pullUpdate(b.board, { from: A, repos: ['kokuban'] }, {
    ...deps(b), expectedHead: '0'.repeat(40), beforeApply: async () => { throw Error('must not apply'); },
  }));
  assert.equal(result.ok, false);
  assert.equal(git(b.repos.kokuban!, 'rev-parse', 'HEAD'), before);
  assert.equal(b.restarted, 0);
});

test('automatic update rolls source back when installation fails, without restarting', async () => {
  const { a, b, deps } = twoPcs();
  const before = git(b.repos.kokuban!, 'rev-parse', 'HEAD');
  let rolled = false;
  const result = await as(b, () => pullUpdate(b.board, { from: A, repos: ['kokuban'] }, {
    ...deps(b), expectedHead: git(a.repos.kokuban!, 'rev-parse', 'HEAD'),
    beforeApply: async () => {}, build: async () => { throw Error('staged installation failed'); },
    rollback: async (dir, old) => { git(dir, 'reset', '--keep', old); rolled = true; },
  }));
  assert.equal(result.ok, false);
  assert.equal(rolled, true);
  assert.equal(git(b.repos.kokuban!, 'rev-parse', 'HEAD'), before);
  assert.equal(b.restarted, 0);
});

test('code is sent as a bundle of only what the asker lacks, or nothing when it has it all', async () => {
  const { a } = twoPcs();
  const where = (n: RepoName) => a.repos[n] ?? null;
  const first = git(a.repos.kokuban!, 'rev-parse', 'HEAD~1');
  const part = (await codeAsked({ repo: 'kokuban', have: first }, where)).body as { full: boolean; bundle: string };
  const whole = (await codeAsked({ repo: 'kokuban' }, where)).body as { full: boolean; bundle: string };
  assert.equal(part.full, false);
  assert.equal(whole.full, true);
  assert.ok(part.bundle.length < whole.bundle.length);
  assert.equal(((await codeAsked({ repo: 'kokuban', have: git(a.repos.kokuban!, 'rev-parse', 'HEAD') }, where)).body as { same: boolean }).same, true);
  assert.equal((await codeAsked({ repo: 'secrets' }, where)).status, 400);
  assert.equal((await codeAsked({ repo: 'computeruse' }, () => null)).status, 404);
});

test('hello tells a paired PC which commit each repository is on', async () => {
  const { a } = twoPcs();
  const info = await repoInfo((n) => a.repos[n] ?? null);
  assert.equal(info.kokuban?.subject, 'kokuban: second');
  assert.equal(info.computeruse?.ts, 1_700_000_100_000);
});

test('kokuban update takes each repository from the paired PC with the newest commit and applies it', async () => {
  const { b, deps } = twoPcs();
  const out = await as(b, () => pullUpdate(b.board, {}, deps(b)));
  assert.equal(out.ok, true, out.lines.join('\n'));
  assert.equal(subject(b.repos.kokuban!), 'kokuban: second');
  assert.equal(subject(b.repos.computeruse!), 'computeruse: second');
  assert.match(out.lines.join('\n'), /computeruse: now computeruse: second \(from pc-a\)/);
  assert.match(out.lines.join('\n'), /kokuban: \w{7} -> \w{7}; the board restarts on it in a moment \(from pc-a\)/);
  assert.deepEqual(b.built, ['kokuban']);
  assert.equal(b.restarted, 1);
  assert.ok(b.board.feed.some((e) => e.op === 'update'));

  const again = await as(b, () => pullUpdate(b.board, {}, deps(b)));
  assert.match(again.lines.join('\n'), /is the newest among the paired PCs/);
  assert.equal(b.restarted, 1, 'nothing new, no restart');
});

test('local edits to kokuban leave it alone; line endings alone do not count', async () => {
  const { b, deps } = twoPcs();
  fs.writeFileSync(path.join(b.repos.kokuban!, 'README.md'), 'one\r\n');
  let out = await as(b, () => pullUpdate(b.board, { repos: ['kokuban'] }, deps(b)));
  assert.equal(out.ok, true, out.lines.join('\n'));
  assert.equal(subject(b.repos.kokuban!), 'kokuban: second');

  const { b: b2, deps: deps2 } = twoPcs();
  fs.writeFileSync(path.join(b2.repos.kokuban!, 'README.md'), 'edited here\n');
  out = await as(b2, () => pullUpdate(b2.board, { repos: ['kokuban'] }, deps2(b2)));
  assert.equal(out.ok, false);
  assert.match(out.lines[0]!, /local edits here \(README.md\); left alone/);
  assert.equal(b2.restarted, 0);
});

test('a PC with commits of its own is not moved', async () => {
  const { b, deps } = twoPcs();
  commit(b.repos.kokuban!, 'local.txt', 'mine\n', 'kokuban: only here', 1_700_000_200);
  const out = await as(b, () => pullUpdate(b.board, { from: 'pc-a', repos: ['kokuban'] }, deps(b)));
  assert.match(out.lines[0]!, /this PC has commits pc-a lacks; not a fast-forward/);
  assert.equal(subject(b.repos.kokuban!), 'kokuban: only here');
});

test('kokuban update <pc> offers; the person there installs with one click', async () => {
  const { a, b, deps } = twoPcs({ lang: 'ja' });
  const offered = await as(a, () => offerUpdate(a.board, 'pc-b', deps(a)));
  assert.match(offered.lines.join('\n'), /kokuban: offered \w{7} \(pc-b runs \w{7}\)/);
  const card = b.board.cards.at(-1)!;
  assert.match(card.question, /Alexさん（pc-a）から kokubanとcomputeruse の更新が届きました/);
  assert.match(card.details, /kokuban: second/);
  assert.deepEqual(card.choices, ['インストール', '今はしない']);

  const result = await as(b, () => answerCard(b.board, card, '0', ''));
  assert.match(result, /computeruse: now computeruse: second/);
  assert.equal(subject(b.repos.kokuban!), 'kokuban: second');
  assert.equal(b.board.offers[0]!.state, 'done');
  assert.equal(b.board.messages.length, 0, 'acted on, not mailed to a session');

  const nothing = await as(a, () => offerUpdate(a.board, 'pc-b', deps(a)));
  assert.match(nothing.lines.join('\n'), /pc-b already runs/);
});

test('Not now changes nothing', async () => {
  const { a, b, deps } = twoPcs();
  await as(a, () => offerUpdate(a.board, 'pc-b', deps(a)));
  assert.match(await as(b, () => answerCard(b.board, b.board.cards.at(-1)!, '1', '')), /Not installed/);
  assert.equal(subject(b.repos.kokuban!), 'kokuban: first');
  assert.equal(b.board.offers[0]!.state, 'declined');
});

test('a PC without computeruse gets it cloned and installed', async () => {
  const { a, b, deps } = twoPcs({ bareB: true });
  const offered = await as(a, () => offerUpdate(a.board, 'pc-b', deps(a)));
  assert.match(offered.lines.join('\n'), /not on pc-b yet: it would be installed/);
  const card = b.board.cards.at(-1)!;
  assert.match(card.details, /new install/);
  const beside = path.join(path.dirname(b.repos.kokuban!), 'computeruse');
  const result = await as(b, () => pullUpdate(b.board, { from: 'pc-a', repos: ['computeruse'] }, { ...deps(b), cloneTo: () => beside }));
  assert.equal(b.installed.length, 1, result.lines.join('\n'));
  assert.equal(subject(b.installed[0]!), 'computeruse: second');
  // A PC whose git config rewrites https to ssh (url.<base>.insteadOf) reports the rewritten form.
  const remote = git(b.installed[0]!, 'remote', 'get-url', 'origin');
  assert.ok(['https://github.com/52kokada/computeruse-windows.git', 'git@github.com:52kokada/computeruse-windows.git'].includes(remote), remote);
  assert.equal(b.installed[0], beside);
});
