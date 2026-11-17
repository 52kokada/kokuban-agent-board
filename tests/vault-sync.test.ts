import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { SETTINGS } from '../src/cards.js';
import { ensureLayout, getBlock, keeperConfig, keeperTick, revisions, writeAttention, type KeeperConfig } from '../src/vault-keeper.js';
import {
  configCandidates, ensureSyncBookmarks, forgetSync, parseSyncthingConfig, syncthingStatus, writeSyncBlock, type SyncDeps,
} from '../src/vault-sync.js';

const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-sync-'));
const KEY = 'secret-api-key-123';
const ME = 'KEEPER-ID';
const KR = 'PC-B-ID';
const MAC = 'MAC-ID';
const AUR = 'AURORA-ID';
const at = (h: number, m = 0): number => new Date(2026, 10, 5, h, m).getTime();

function xml(vault: string, gui = '<address>0.0.0.0:8384</address><apikey>' + KEY + '</apikey>'): string {
  return `<configuration version="37">
    <folder id="vault-1" label="Shared vault" path="${vault.replace(/&/g, '&amp;')}" type="sendreceive">
        <filesystemType>basic</filesystemType>
        <device id="${ME}" introducedBy=""><encryptionPassword></encryptionPassword></device>
        <device id="${KR}" introducedBy=""></device>
        <device id="${MAC}" introducedBy=""></device>
        <device id="${AUR}" introducedBy=""></device>
    </folder>
    <folder id="other" label="Other" path="C:\\elsewhere"><device id="${ME}"></device></folder>
    <device id="${ME}" name="keeper-pc" compression="metadata"></device>
    <device id="${KR}" name="pc-b" compression="metadata"></device>
    <device id="${MAC}" name="desk-a" compression="metadata"></device>
    <device id="${AUR}" name="desk-b" compression="metadata"></device>
    <gui enabled="true" tls="false" debugging="false">${gui}<theme>default</theme></gui>
</configuration>`;
}
interface World { db?: object; completion?: Record<string, object>; connected?: string[]; lastSeen?: Record<string, string>; down?: boolean }
function mock(w: World, seen: string[] = []): SyncDeps['fetch'] {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(url.href);
    assert.equal((init?.headers as Record<string, string>)['X-API-Key'], KEY);
    if (w.down) throw new TypeError('fetch failed');
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    switch (url.pathname) {
      case '/rest/system/status': return json({ myID: ME });
      case '/rest/db/status': assert.equal(url.searchParams.get('folder'), 'vault-1'); return json(w.db ?? { state: 'idle', needFiles: 0, errors: 0, pullErrors: 0 });
      case '/rest/system/connections': return json({ connections: Object.fromEntries([KR, MAC, AUR].map((d) => [d, { connected: (w.connected ?? [KR, MAC, AUR]).includes(d) }])) });
      case '/rest/stats/device': return json(Object.fromEntries(Object.entries(w.lastSeen ?? {}).map(([d, t]) => [d, { lastSeen: t }])));
      case '/rest/db/completion': return json(w.completion?.[url.searchParams.get('device')!] ?? { completion: 100, needItems: 0, needDeletes: 0 });
      default: return new Response('nope', { status: 404 });
    }
  }) as typeof fetch;
}
function setup(): { root: string; cfgFile: string } {
  forgetSync();
  const root = temp();
  ensureLayout(root);
  const cfgFile = path.join(temp(), 'config.xml');
  fs.writeFileSync(cfgFile, xml(root));
  return { root, cfgFile };
}
const home = (root: string): string => fs.readFileSync(path.join(root, 'Home.md'), 'utf8');
const NOENV = { env: {}, home: path.join(os.tmpdir(), 'no-such-home-kokuban') };

test('config.xml: the GUI address on loopback and the key, folders with their devices, device names', () => {
  const c = parseSyncthingConfig(xml('C:\\Users\\sam\\shared-vault'));
  assert.deepEqual(c.gui, { url: 'http://127.0.0.1:8384', apikey: KEY });
  assert.deepEqual(c.folders[0], { id: 'vault-1', label: 'Shared vault', path: 'C:\\Users\\sam\\shared-vault', devices: [ME, KR, MAC, AUR] });
  assert.equal(c.names[KR], 'pc-b');
  assert.equal(Object.keys(c.names).length, 4);
  assert.equal(parseSyncthingConfig(xml('x', '<address>127.0.0.1:8384</address>')).gui, null, 'no key, no API');
  assert.equal(parseSyncthingConfig(xml('x', `<address>[::]:9000</address><apikey>${KEY}</apikey>`)).gui!.url, 'http://[::1]:9000');
  const places = configCandidates('D:\\st', { env: { LOCALAPPDATA: 'L', APPDATA: 'A' }, home: 'H' });
  assert.equal(places[0], path.join('D:\\st', 'config.xml'));
  assert(places.includes(path.join('L', 'Syncthing', 'config.xml')) && places.includes(path.join('A', 'Syncthing', 'config.xml')));
  assert(places.includes(path.join('H', '.config', 'syncthing', 'config.xml')) && places.includes(path.join('H', 'Library', 'Application Support', 'Syncthing', 'config.xml')));
});

test('in sync: one line under the Home title, the key never written, a revision recorded', async () => {
  const { root, cfgFile } = setup();
  const seen: string[] = [];
  const r = await syncthingStatus(root, cfgFile, { ...NOENV, fetch: mock({}, seen) }, at(17, 40));
  assert.equal(r.level, 'ok');
  assert(seen.some((u) => u.includes('/rest/db/completion') && u.includes(`device=${KR}`)));
  assert(!seen.some((u) => u.includes(`device=${ME}`)), 'never asks about itself');
  assert(writeSyncBlock(root, r, at(17, 40), 'keeper-pc'));
  const text = home(root);
  const line = getBlock(text, 'sync')!;
  assert.equal(line, '✅ In sync · keeper alive · checked 17:40 · desk-a, desk-b, pc-b up to date · ' +
    '[Syncthing](http://127.0.0.1:8384) ^sync-status');
  assert(/^---[\s\S]*?---\n# Home\n\n<!-- keeper:sync -->\n/.test(text), 'right under the title');
  assert(text.includes('Start at [[How this works]]'), 'the rest of Home is untouched');
  for (const rel of ['Home.md', '.keeper/revisions.jsonl']) assert(!fs.readFileSync(path.join(root, rel), 'utf8').includes(KEY));
  const rev = revisions(root).at(-1)!;
  assert.equal(rev.kind, 'status');
  assert.equal(rev.block, 'sync');
  // The nightly check-up sees no conflict in a keeper-made line.
  writeAttention(root, at(18));
  assert(!fs.readFileSync(path.join(root, 'Needs attention.md'), 'utf8').includes('sync: a person edited'));
});

test('one device behind and one offline: a warning naming them', async () => {
  const { root, cfgFile } = setup();
  const r = await syncthingStatus(root, cfgFile, { ...NOENV, fetch: mock({
    completion: { [KR]: { completion: 87.4, needItems: 213, needDeletes: 0 } }, connected: [AUR, MAC],
    lastSeen: { [KR]: new Date(at(14, 2)).toISOString() },
  }) }, at(17, 40));
  assert.equal(r.level, 'warn');
  writeSyncBlock(root, r, at(17, 40), 'keeper-pc');
  assert.equal(getBlock(home(root), 'sync'), '⚠️ pc-b 87% (213 files behind, last seen 14:02) · keeper alive · checked 17:40 · ' +
    'desk-a, desk-b up to date · [Syncthing](http://127.0.0.1:8384) ^sync-status');
  const errs = await syncthingStatus(root, cfgFile, { ...NOENV, fetch: mock({ db: { state: 'idle', needFiles: 0, errors: 2, pullErrors: 0 } }) }, at(17, 41));
  assert.equal(errs.level, 'error');
  assert(errs.key.startsWith('❌ Syncthing errors: 2 items failing on the keeper'));
});

test('unreachable or unconfigured Syncthing fails open into the status line', async () => {
  const { root, cfgFile } = setup();
  const down = await syncthingStatus(root, cfgFile, { ...NOENV, fetch: mock({ down: true }) }, at(9));
  assert.equal(down.level, 'error');
  assert(down.line(at(9), null).startsWith('❌ Syncthing not reachable from the keeper · keeper alive · checked 09:00'));
  const none = await syncthingStatus(root, path.join(temp(), 'missing.xml'), NOENV, at(9));
  assert.equal(none.key, down.key);
  const other = path.join(temp(), 'config.xml');
  fs.writeFileSync(other, xml('C:\\not-the-vault'));
  assert((await syncthingStatus(root, other, { ...NOENV, fetch: mock({}) }, at(9))).key.includes('shares no folder'));
});

test('throttle: the same status is rewritten once an hour; a moving percentage waits; a new level is at once', async () => {
  const { root, cfgFile } = setup();
  const deps = (w: World): SyncDeps => ({ ...NOENV, fetch: mock(w) });
  const ok = await syncthingStatus(root, cfgFile, deps({}), at(10));
  assert(writeSyncBlock(root, ok, at(10), 'keeper-pc'));
  const n = revisions(root).length;
  assert(!writeSyncBlock(root, ok, at(10, 30), 'keeper-pc'), 'only the time differs');
  assert.equal(revisions(root).length, n);
  // After a restart the memo is gone; the block's own text still says the same.
  forgetSync();
  assert(!writeSyncBlock(root, ok, at(10, 40), 'keeper-pc'), 'restart: still within the hour');
  assert(writeSyncBlock(root, ok, at(11, 1), 'keeper-pc'), 'an hour later');
  assert(getBlock(home(root), 'sync')!.includes('checked 11:01'));
  const behind = (p: number): Promise<ReturnType<typeof syncthingStatus> extends Promise<infer R> ? R : never> =>
    syncthingStatus(root, cfgFile, deps({ completion: { [KR]: { completion: p, needItems: 100 - p } } }), at(11, 2));
  assert(writeSyncBlock(root, await behind(50), at(11, 2), 'keeper-pc'), 'ok → warn at once');
  assert(!writeSyncBlock(root, await behind(60), at(11, 3), 'keeper-pc'), 'same level, settling');
  assert(writeSyncBlock(root, await behind(70), at(11, 8), 'keeper-pc'), 'after five minutes');
  assert(getBlock(home(root), 'sync')!.includes('pc-b 70%'));
});

test('a person\'s edit of the sync block is kept and listed once; emptying it resumes the line', async () => {
  const { root, cfgFile } = setup();
  const ok = await syncthingStatus(root, cfgFile, { ...NOENV, fetch: mock({}) }, at(10));
  writeSyncBlock(root, ok, at(10), 'keeper-pc');
  const edited = home(root).replace(/(<!-- keeper:sync -->\n)[^\n]*/, '$1my own words');
  fs.writeFileSync(path.join(root, 'Home.md'), edited);
  assert(!writeSyncBlock(root, ok, at(12), 'keeper-pc'));
  assert(!writeSyncBlock(root, ok, at(13), 'keeper-pc'));
  forgetSync();
  assert(!writeSyncBlock(root, ok, at(14), 'keeper-pc'));
  assert.equal(home(root), edited);
  assert.equal(revisions(root).filter((r) => r.kind === 'conflict' && r.block === 'sync').length, 1);
  writeAttention(root, at(15));
  assert(fs.readFileSync(path.join(root, 'Needs attention.md'), 'utf8').includes('[[Home]] sync: a person edited the keeper block'));
  fs.writeFileSync(path.join(root, 'Home.md'), edited.replace('my own words\n', ''));
  assert(writeSyncBlock(root, ok, at(16), 'keeper-pc'));
  assert(getBlock(home(root), 'sync')!.startsWith('✅ In sync'));
});

test('bookmarks: merged once with the person\'s own, the core plugin turned on only when off, never again after', () => {
  const root = temp();
  assert(!ensureSyncBookmarks(root, at(10)), 'no .obsidian yet: wait');
  fs.mkdirSync(path.join(root, '.obsidian'));
  const mine = { items: [{ type: 'group', ctime: 1, title: 'Mine', items: [{ type: 'url', ctime: 2, url: 'http://127.0.0.1:8384', title: 'ST' }] },
    { type: 'file', ctime: 3, path: 'Rules.md' }] };
  fs.writeFileSync(path.join(root, '.obsidian/bookmarks.json'), JSON.stringify(mine));
  fs.writeFileSync(path.join(root, '.obsidian/core-plugins.json'), JSON.stringify({ 'file-explorer': true, bookmarks: false, graph: true }));
  assert(ensureSyncBookmarks(root, at(10)));
  const marks = JSON.parse(fs.readFileSync(path.join(root, '.obsidian/bookmarks.json'), 'utf8'));
  assert.deepEqual(marks.items.slice(0, 2), mine.items, 'the person\'s kept, in order');
  assert.deepEqual(marks.items.slice(2), [{ type: 'file', ctime: at(10), path: 'Home.md', subpath: '#^sync-status', title: 'Sync status' }],
    'the Syncthing url was already bookmarked (inside a group)');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.obsidian/core-plugins.json'), 'utf8')), { 'file-explorer': true, bookmarks: true, graph: true });
  // A person removes ours and turns the plugin off again: respected.
  fs.writeFileSync(path.join(root, '.obsidian/bookmarks.json'), JSON.stringify(mine));
  fs.writeFileSync(path.join(root, '.obsidian/core-plugins.json'), JSON.stringify({ bookmarks: false }));
  assert(!ensureSyncBookmarks(root, at(11)));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.obsidian/bookmarks.json'), 'utf8')), mine);
  // A fresh vault: created with both; the older array form of core-plugins gains bookmarks.
  const fresh = temp();
  fs.mkdirSync(path.join(fresh, '.obsidian'));
  fs.writeFileSync(path.join(fresh, '.obsidian/core-plugins.json'), JSON.stringify(['file-explorer']));
  assert(ensureSyncBookmarks(fresh, at(10)));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fresh, '.obsidian/bookmarks.json'), 'utf8')).items.map((b: { title: string }) => b.title), ['Sync status', 'Open Syncthing']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fresh, '.obsidian/core-plugins.json'), 'utf8')), ['file-explorer', 'bookmarks']);
  // A bookmarks file that does not parse is never clobbered.
  const broken = temp();
  fs.mkdirSync(path.join(broken, '.obsidian'));
  fs.writeFileSync(path.join(broken, '.obsidian/bookmarks.json'), '{"items": [');
  assert(!ensureSyncBookmarks(broken, at(10)));
  assert.equal(fs.readFileSync(path.join(broken, '.obsidian/bookmarks.json'), 'utf8'), '{"items": [');
});

test('the keeper tick writes the line when settings name Syncthing; a config built in code shows none', async () => {
  const { root, cfgFile } = setup();
  const board = new Board();
  const base: KeeperConfig = { path: root, keeper: true, keeperPc: 'keeper-pc' };
  await keeperTick(board, { config: () => base, now: () => at(2), sync: { ...NOENV, fetch: mock({}) } });
  assert.equal(getBlock(home(root), 'sync'), null);
  await keeperTick(board, { config: () => ({ ...base, syncthing: cfgFile }), now: () => at(2, 1), sync: { ...NOENV, fetch: mock({}) } });
  assert(getBlock(home(root), 'sync')!.startsWith('✅ In sync · keeper alive'));
  const old = SETTINGS.file;
  SETTINGS.file = path.join(temp(), 'settings.json');
  try {
    fs.writeFileSync(SETTINGS.file, JSON.stringify({ vault: { path: root, keeper: true } }));
    assert.equal(keeperConfig()!.syncthing, 'auto');
    fs.writeFileSync(SETTINGS.file, JSON.stringify({ vault: { path: root, keeper: true, syncthing: false } }));
    assert.equal(keeperConfig()!.syncthing, false);
    fs.writeFileSync(SETTINGS.file, JSON.stringify({ vault: { path: root, keeper: true, syncthing: 'D:\\st\\config.xml' } }));
    assert.equal(keeperConfig()!.syncthing, 'D:\\st\\config.xml');
  } finally { SETTINGS.file = old; }
});
