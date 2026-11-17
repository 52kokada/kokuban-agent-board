import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { APP_EXE, APP_ID, CHUNK, SETUP, appAsked, appChunk, appHello, collides, fetchFile, installApp, newer, newestApp, type AppAsset, type AppFile } from '../src/app-update.js';
import { Board } from '../src/board.js';
import { SETTINGS } from '../src/cards.js';
import { DATA_DIR } from '../src/config.js';
import { handlePeer } from '../src/peer.js';
import { offerUpdate, pullUpdate, type UpdateDeps } from '../src/update.js';

const A = 'pc-a.tail1234.ts.net';
const B = 'pc-b.tail1234.ts.net';
const C = 'keeper-pc.tail1234.ts.net';
const hash = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** A feed with one more published version, as build.ps1 -Pack leaves it. */
function publish(feed: string, version: string, bytes = Buffer.from(`package ${version}`), id = APP_ID): AppAsset {
  fs.mkdirSync(feed, { recursive: true });
  const name = `${id}-${version}-full.nupkg`;
  fs.writeFileSync(path.join(feed, name), bytes);
  fs.writeFileSync(path.join(feed, SETUP), Buffer.from(`setup ${version}`));
  const asset: AppAsset = { PackageId: id, Version: version, Type: 'Full', FileName: name, SHA256: hash(bytes).toUpperCase(), Size: bytes.length };
  const index = path.join(feed, 'releases.win.json');
  const had = fs.existsSync(index) ? (JSON.parse(fs.readFileSync(index, 'utf8')) as { Assets: AppAsset[] }).Assets : [];
  fs.writeFileSync(index, JSON.stringify({ Assets: [...had, asset] }));
  return asset;
}

/** An installed app, as Velopack leaves it: the exe and sq.version beside it. */
function install(exe: string, version: string): void {
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  fs.writeFileSync(path.join(path.dirname(exe), 'sq.version'), `<?xml version="1.0"?><package><metadata><id>Kokuban</id><version>${version}</version></metadata></package>`);
}

const temp = (name: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `kokuban-${name}-`));

test("the app never installs into the board's own data folder", async () => {
  // Velopack installs to %LOCALAPPDATA%\<package id>; "Kokuban" is the board's data (paths ignore case).
  const installedIn = path.dirname(path.dirname(APP_EXE)).toLowerCase();
  assert.notEqual(installedIn, DATA_DIR.toLowerCase());
  assert.ok(!DATA_DIR.toLowerCase().startsWith(installedIn + path.sep) && !installedIn.startsWith(DATA_DIR.toLowerCase() + path.sep));
  assert.equal(collides(APP_ID), false);
  for (const id of ['Kokuban', 'kokuban', 'KOKUBAN', '..', '', 'a/b']) assert.equal(collides(id), true, id);
  assert.match(await installApp(path.join(os.tmpdir(), 'nope.exe'), 'Kokuban'), /^refused/);
});

test('versions compare part by part, and a pre-release is older than its release', () => {
  assert.equal(newer('0.2.10', '0.2.9'), true);
  assert.equal(newer('0.2.9', '0.2.10'), false);
  assert.equal(newer('1.0.0', '1.0.0'), false);
  assert.equal(newer('1.0.0', '1.0.0-beta'), false);
  assert.equal(newer('0.3.0', ''), true);
});

test('a feed names its newest package, or Setup.exe alone for a PC without the app, with sizes and hashes', () => {
  const feed = temp('feed');
  publish(feed, '0.1.0');
  const asset = publish(feed, '0.2.0');
  assert.equal(newestApp(feed)?.Version, '0.2.0');
  assert.deepEqual(appHello(feed, path.join(feed, 'nope.exe')), { version: '0.2.0', installed: false, gives: '0.2.0' });
  assert.deepEqual(appAsked({ have: '0.2.0' }, feed).body, { ok: true, version: '0.2.0', same: true });
  const pkg = appAsked({ have: '0.1.0' }, feed).body as { files: AppFile[] };
  assert.deepEqual(pkg.files, [{ name: asset.FileName, size: asset.Size, sha256: asset.SHA256!.toLowerCase() }]);
  const setup = appAsked({ setup: true }, feed).body as { files: AppFile[] };
  assert.deepEqual(setup.files.map((f) => f.name), [SETUP]);
  assert.equal(setup.files[0]!.sha256, hash(Buffer.from('setup 0.2.0')));
  assert.equal(appAsked({}, temp('empty')).status, 404);
  assert.equal(appChunk({ file: '../releases.win.json', offset: 0 }, feed).status, 404, 'only the files it named');
  assert.equal(appChunk({ file: `${APP_ID}-0.1.0-full.nupkg`, offset: 0 }, feed).status, 404, 'only the newest');
});

test('a file comes over in chunks, carries on after a break, and is kept only when its hash checks out', async () => {
  const from = temp('from');
  const big = Buffer.alloc(CHUNK * 2 + 123, 7);
  const asset = publish(from, '0.2.0', big);
  const meta = { name: asset.FileName, size: asset.Size, sha256: asset.SHA256!.toLowerCase() };
  const to = temp('to');
  let calls = 0;
  const chunk = async (offset: number): Promise<Buffer> => {
    calls++;
    if (calls === 2) throw new Error('the connection dropped');
    return Buffer.from((appChunk({ file: asset.FileName, offset }, from).body as { data: string }).data, 'base64');
  };
  await assert.rejects(fetchFile(meta, chunk, to), /dropped/);
  assert.equal(fs.statSync(path.join(to, `${asset.FileName}.part`)).size, CHUNK, 'what arrived is kept for the next try');
  const done = await fetchFile(meta, chunk, to);
  assert.equal(hash(fs.readFileSync(done)), meta.sha256);
  assert.equal(calls, 4, 'the second try asked only for what was missing');

  const bad = temp('bad');
  await assert.rejects(fetchFile({ ...meta, sha256: 'a'.repeat(64) }, async (o) =>
    Buffer.from((appChunk({ file: asset.FileName, offset: o }, from).body as { data: string }).data, 'base64'), bad), /damaged/);
  assert.deepEqual(fs.readdirSync(bad), [], 'a damaged file is neither kept nor named');
  await assert.rejects(fetchFile({ ...meta, name: '../evil.exe' }, chunk, bad), /usable description/);
});

/** Three boards paired at "work": A has published the app; B and C have none. */
function boards() {
  const dir = temp('app');
  const pcs: Record<string, { board: Board; file: string; feed: string; exe: string; installed: string[] }> = {
    [A]: { board: new Board(), file: path.join(dir, 'a.json'), feed: path.join(dir, 'a-feed'), exe: path.join(dir, 'a', 'current', 'Kokuban.exe'), installed: [] },
    [B]: { board: new Board(), file: path.join(dir, 'b.json'), feed: path.join(dir, 'b-feed'), exe: path.join(dir, 'b', 'current', 'Kokuban.exe'), installed: [] },
    [C]: { board: new Board(), file: path.join(dir, 'c.json'), feed: path.join(dir, 'c-feed'), exe: path.join(dir, 'c', 'current', 'Kokuban.exe'), installed: [] },
  };
  const others = (me: string): string[] => [A, B, C].filter((pc) => pc !== me);
  for (const [pc, person] of [[A, 'Alex'], [B, 'Sam'], [C, 'Sam']] as const) {
    fs.writeFileSync(pcs[pc]!.file, JSON.stringify({ person, trust: Object.fromEntries(others(pc).map((o) => [o, 'work'])) }));
  }
  publish(pcs[A]!.feed, '0.2.0');
  const as = async <T>(pc: string, fn: () => Promise<T> | T): Promise<T> => {
    const before = SETTINGS.file;
    SETTINGS.file = pcs[pc]!.file;
    try {
      return await fn();
    } finally {
      SETTINGS.file = before;
    }
  };
  const deps = (me: string): UpdateDeps => ({
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const host = new URL(String(url)).hostname;
      const there = pcs[host]!;
      const out = await as(host, () => handlePeer(there.board, { 'tailscale-user-login': 'k@x', 'x-forwarded-for': '100.64.0.1' },
        JSON.parse(String(init?.body)), { lookup: async () => ({ login: 'k@x', node: me }), where: () => null, appFeed: there.feed, appExe: there.exe }));
      return new Response(JSON.stringify(out.body), { status: out.status });
    }) as typeof fetch,
    resolve: async (n) => (n.includes('.') ? n : `${n}.tail1234.ts.net`),
    where: () => null, trusted: () => others(me), restart: () => {},
    appFeed: pcs[me]!.feed, appExe: pcs[me]!.exe,
    installApp: async (setup) => {
      pcs[me]!.installed.push(fs.readFileSync(setup, 'utf8'));
      return 'installed';
    },
  });
  return { pcs, as, deps };
}

test('kokuban update installs the app from Setup.exe alone, then brings newer packages for its own updater', async () => {
  const { pcs, as, deps } = boards();
  const out = await as(B, () => pullUpdate(pcs[B]!.board, {}, deps(B)));
  assert.ok(out.lines.includes('app: 0.2.0, installed (from pc-a)'), out.lines.join('\n'));
  assert.deepEqual(pcs[B]!.installed, ['setup 0.2.0']);
  assert.equal(newestApp(pcs[B]!.feed), null, 'no package travelled with Setup.exe');

  // Installed now: a newer version comes as its package, into the feed, for the app's updater.
  install(pcs[B]!.exe, '0.2.0');
  assert.deepEqual(appHello(pcs[B]!.feed, pcs[B]!.exe), { version: '0.2.0', installed: true, gives: '' });
  assert.ok((await as(B, () => pullUpdate(pcs[B]!.board, {}, deps(B)))).lines.includes('app: 0.2.0 is the newest among the paired PCs that answered'));
  publish(pcs[A]!.feed, '0.3.0');
  const again = await as(B, () => pullUpdate(pcs[B]!.board, {}, deps(B)));
  assert.ok(again.lines.some((l) => l.startsWith('app: 0.2.0 -> 0.3.0;')), again.lines.join('\n'));
  assert.equal(newestApp(pcs[B]!.feed)?.Version, '0.3.0');
  assert.equal(pcs[B]!.installed.length, 1);
});

test("a package that would install into the board's data is never run", async () => {
  const { pcs, as, deps } = boards();
  fs.rmSync(pcs[A]!.feed, { recursive: true, force: true });
  publish(pcs[A]!.feed, '0.2.0', undefined, 'Kokuban');
  const out = await as(B, () => pullUpdate(pcs[B]!.board, {}, deps(B)));
  assert.ok(out.lines.some((l) => l.startsWith(`app: refused, package "Kokuban" would install into the board's own data folder`)), out.lines.join('\n'));
  assert.deepEqual(pcs[B]!.installed, []);
});

test('an offer carries the app, and its card says it is a new install', async () => {
  const { pcs, as, deps } = boards();
  const out = await as(A, () => offerUpdate(pcs[A]!.board, 'pc-b', deps(A)));
  assert.ok(out.lines.includes('app: offered 0.2.0 (not on pc-b yet: it would be installed)'), out.lines.join('\n'));
  const card = pcs[B]!.board.cards.at(-1)!;
  assert.match(card.question, /the Kokuban app/);
  assert.match(card.details, /Kokuban app 0\.2\.0 \(new install\)/);
  assert.equal(pcs[B]!.board.offers.at(-1)!.app?.version, '0.2.0');
  // Already on it: nothing to offer.
  install(pcs[B]!.exe, '0.2.0');
  const none = await as(A, () => offerUpdate(pcs[A]!.board, 'pc-b', deps(A)));
  assert.ok(none.lines.includes('app: pc-b already has 0.2.0'), none.lines.join('\n'));
});

test('the app comes from a PC that can give it, not one that only runs it; a refusal falls back to the next', async () => {
  const { pcs, as, deps } = boards();
  // pc-b runs 0.2.0 from Setup.exe and holds no package: it is never asked.
  install(pcs[B]!.exe, '0.2.0');
  const out = await as(C, () => pullUpdate(pcs[C]!.board, {}, deps(C)));
  assert.ok(out.lines.includes('app: 0.2.0, installed (from pc-a)'), out.lines.join('\n'));

  // A board from before "gives" says only its version: when it cannot give, the next one does.
  const fresh = boards();
  install(fresh.pcs[B]!.exe, '0.2.0');
  const old = fresh.deps(C);
  const asked: string[] = [];
  const routed: UpdateDeps = { ...old, fetch: (async (url: string | URL, init?: RequestInit) => {
    const res = await old.fetch!(url, init);
    const host = new URL(String(url)).hostname;
    const body = JSON.parse(String(init?.body)) as { op: string };
    if (body.op === 'app') asked.push(host.split('.')[0]!);
    if (host !== B || body.op !== 'hello') return res;
    const said = await res.json() as { app: { version: string; installed: boolean } };
    return new Response(JSON.stringify({ ...said, app: { version: '0.3.0', installed: true } }), { status: 200 });
  }) as typeof fetch };
  const back = await fresh.as(C, () => pullUpdate(fresh.pcs[C]!.board, {}, routed));
  assert.deepEqual(asked, ['pc-b', 'pc-a']);
  assert.ok(back.lines.includes('app: 0.2.0, installed (from pc-a)'), back.lines.join('\n'));
  assert.equal(back.ok, true);
});
