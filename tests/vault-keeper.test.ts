import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { SETTINGS } from '../src/cards.js';
import { handleHook } from '../src/hooks.js';
import { handleRpc } from '../src/mcp.js';
import { noSecrets } from '../src/know.js';
import { handlePeer } from '../src/peer.js';
import {
  RULES_PAGE, RULES_V1, applyWrite, buildIndex, cockpitQueued, drainQueue, ensureLayout, findClient, findClientPage, frontmatter, getBlock, keeperConfig, loadIndex,
  keeperTick, queued, readPage, rebuildIndex, revisions, searchVault, sendCockpit, unsafeNames, vaultRules, vaultTool, writeAttention,
  type KeeperConfig, type WriteRequest,
} from '../src/vault-keeper.js';
import { DEFAULT_GROUPING, NAME_MAX, findProject, parseGrouping, placeDir, safeName, unsafeName } from '../src/vault-layout.js';

const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-keeper-'));
const NOW = Date.parse('2026-11-04T10:00:00Z');
let n = 0;
const write = (fields: Partial<WriteRequest> & Pick<WriteRequest, 'kind' | 'text'>): WriteRequest => ({
  request_id: `test-request-${++n}`, source: 'call with Sam', author: { agent: 'Rio', pc: 'pc-c', person: 'Alex' },
  space: 'T-05555', name: '青空工房', ...fields,
});
const DIR = 'Acme/Clients/0 ❓ No stage/T-05555 青空工房';
/** A client's folder now: it moves to its stage group when its stage or tags change. */
const cdir = (root: string, id = 'T-05555'): string => findClient(root, id)!;
const file = (root: string, rel: string): string => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
function tree(root: string, dir = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${d.name}` : d.name;
    if (d.isDirectory()) Object.assign(out, tree(root, rel), { [`${rel}/`]: '' });
    else out[rel] = file(root, rel);
  }
  return out;
}
async function withSettings(settings: object, run: () => Promise<void>): Promise<void> {
  const old = SETTINGS.file;
  SETTINGS.file = path.join(temp(), 'settings.json');
  fs.writeFileSync(SETTINGS.file, JSON.stringify(settings));
  try { await run(); } finally { SETTINGS.file = old; }
}

test('layout creation is idempotent and never overwrites a person\'s page', () => {
  const root = temp();
  ensureLayout(root);
  for (const rel of ['README.md', 'Rules.md', 'Home.md', 'Shared tools/Home.md', '.keeper/queue/',
    ...['Acme', 'Harbor Trading', 'Crypto', 'Security'].flatMap((b) => ['Home.md', 'Decisions.md', 'index.md', 'log.md'].map((f) => `${b}/${f}`)),
    // D126: the boards only where a business has clients (Acme).
    'Acme/Pipeline.base', 'Acme/Care.base']) {
    assert(fs.existsSync(path.join(root, rel)), rel);
  }
  for (const old of ['Agency', 'Clients', 'Projects', 'Needs attention.md']) assert(!fs.existsSync(path.join(root, old)), old);
  fs.writeFileSync(path.join(root, 'Rules.md'), '# Our own rules\n');
  const first = tree(root);
  ensureLayout(root);
  assert.deepEqual(tree(root), first);
  assert.equal(file(root, 'Rules.md'), '# Our own rules\n');
  assert.equal(file(root, '.stignore').split('\n').filter((l) => l === '/.keeper/queue').length, 1);
});

test('each write kind lands in its page, the space log, index.md, the revision log and the hidden index', () => {
  const root = temp();
  const event = applyWrite(root, write({ kind: 'event', text: 'Sent the preview link.' }), NOW);
  assert.equal(event.state, 'written');
  assert.match(file(root, `${DIR}/Work log.md`), /Sent the preview link\.[\s\S]*source: call with Sam · Rio@pc-c \(Alex\)/);
  applyWrite(root, write({ kind: 'event', page: 'Communication', text: 'Client asked about prices.' }), NOW);
  assert.match(file(root, `${DIR}/Communication.md`), /Client asked about prices/);
  const fact = applyWrite(root, write({ kind: 'fact', page: 'Facts/launch-date', text: '2026-12-01' }), NOW);
  assert.equal(fact.page, 'Facts/launch-date.md');
  const note = file(root, `${DIR}/Facts/launch-date.md`);
  assert.equal(getBlock(note, 'fact'), '2026-12-01');
  assert.equal(frontmatter(note).value, '2026-12-01');
  assert.equal(frontmatter(note).accepted_by, 'Alex');
  assert.match(file(root, `${DIR}/Overview.md`), /\[\[Acme\/Clients\/0 ❓ No stage\/T-05555 青空工房\/Facts\/launch-date\|launch-date\]\]/);
  applyWrite(root, write({ kind: 'decision', section: 'domain', text: 'Use aoz.example as the domain.', accepted_by: 'Sam' }), NOW);
  applyWrite(root, write({ kind: 'proposal', section: 'colours', text: 'Maybe a warmer palette.' }), NOW);
  const decisions = file(root, `${DIR}/Decisions.md`);
  const [accepted, proposed] = decisions.split('## Proposed — not accepted');
  assert.match(accepted!, /Use aoz\.example as the domain\.[\s\S]*accepted by Sam/);
  assert.match(proposed!, /Maybe a warmer palette/);
  applyWrite(root, write({ kind: 'summary', text: 'Pottery school site, preview sent, launch planned for December.' }), NOW);
  const overview = file(root, `${DIR}/Overview.md`);
  assert.equal(getBlock(overview, 'summary'), 'Pottery school site, preview sent, launch planned for December.');
  assert.equal(frontmatter(overview).tobira_id, 'T-05555');
  assert.deepEqual(frontmatter(overview).aliases, ['青空工房']);
  // Each event also keeps the Overview's last_event (a derived front matter revision, for the Kanban card).
  assert.equal(frontmatter(overview).last_event, '2026-11-04 — Client asked about prices.');
  const all = revisions(root).filter((r) => r.kind !== 'frontmatter');
  assert.deepEqual(revisions(root).filter((r) => r.kind === 'frontmatter').map((r) => r.section), ['last_event', 'last_event']);
  assert.deepEqual(all.map((r) => r.kind), ['event', 'event', 'fact', 'decision', 'proposal', 'summary']);
  assert(all.every((r) => r.author === 'Rio@pc-c (Alex)' && r.source === 'call with Sam' && r.before && r.after && r.ts));
  assert.equal(file(root, `${DIR}/log.md`).split('\n').filter((l) => l.startsWith('- ')).length, 6);
  for (const page of ['Work log', 'Facts/launch-date', 'Decisions']) assert(file(root, `${DIR}/index.md`).includes(`/${page}|${page}]]`), page);
  assert(loadIndex(root)!.pages[`${DIR}/Facts/launch-date.md`]);
  // Agency events go to the agency log; project spaces work too.
  applyWrite(root, write({ kind: 'event', space: 'agency', text: 'New pricing sheet.' }), NOW);
  assert.match(file(root, 'Acme/log.md'), /New pricing sheet/);
  applyWrite(root, write({ kind: 'decision', space: 'project:kokuban', text: 'Keeper lives in Kokuban.' }), NOW);
  assert.match(file(root, 'Shared tools/Projects/kokuban/Decisions.md'), /Keeper lives in Kokuban/);
  // A retried request is answered, not applied twice.
  const again = applyWrite(root, { ...write({ kind: 'event', text: 'Sent the preview link.' }), request_id: 'test-request-1' }, NOW);
  assert.equal(again.state, 'duplicate');
  assert.equal(file(root, `${DIR}/Work log.md`).match(/Sent the preview link/g)!.length, 1);
  assert.throws(() => applyWrite(root, write({ kind: 'event', space: 'T-09999', name: '', text: 'x' }), NOW), /pass name/);
});

test('fact replacement keeps the old value in history; a contradiction becomes a proposal and is reported', () => {
  const root = temp();
  applyWrite(root, write({ kind: 'fact', section: 'launch-date', text: '2026-12-01' }), NOW);
  const contradiction = applyWrite(root, write({ kind: 'fact', section: 'launch-date', text: '2026-12-15' }), NOW + 1000);
  assert.equal(contradiction.state, 'proposal');
  assert.match(contradiction.message, /contradicts the accepted fact launch-date/);
  assert.equal(getBlock(file(root, `${DIR}/Facts/launch-date.md`), 'fact'), '2026-12-01');
  assert.match(file(root, `${DIR}/Decisions.md`).split('## Proposed — not accepted')[1]!, /2026-12-15[\s\S]*Conflicts with\*\* \[\[Acme\/Clients\/0 ❓ No stage\/T-05555 青空工房\/Facts\/launch-date\]\]/);
  const replaced = applyWrite(root, write({ kind: 'fact', section: 'launch-date', text: '2026-12-20', replaces: '2026-12-01', accepted_by: 'Sam' }), NOW + 2000);
  assert.equal(replaced.state, 'written');
  const note = file(root, `${DIR}/Facts/launch-date.md`);
  assert.equal(getBlock(note, 'fact'), '2026-12-20');
  assert.equal(frontmatter(note).accepted_by, 'Sam');
  assert.match(note, /## History\n\n- "2026-12-01" valid_from: 2026-11-04T10:00:00\.000Z · valid_until: 2026-11-04T10:00:02\.000Z .*replaced_by: "2026-12-20"/);
  assert.equal(applyWrite(root, write({ kind: 'fact', section: 'launch-date', text: '2026-12-20' }), NOW).state, 'confirmed');
  // Decisions on a topic: a different one without replaces is a proposal; with it, it supersedes.
  applyWrite(root, write({ kind: 'decision', section: 'host', text: 'Host on Cloudflare Pages.' }), NOW);
  const other = applyWrite(root, write({ kind: 'decision', section: 'host', text: 'Host on another provider.' }), NOW);
  assert.equal(other.state, 'proposal');
  assert.match(other.conflicts_with!, /Decisions\.md#\^r-/);
  assert.doesNotMatch(file(root, `${DIR}/Decisions.md`).split('## Proposed')[0]!, /another provider/);
  const superseded = applyWrite(root, write({ kind: 'decision', section: 'host', text: 'Host on another provider.', replaces: 'Host on Cloudflare Pages.' }), NOW);
  assert.equal(superseded.state, 'written');
  assert.match(file(root, `${DIR}/Decisions.md`).split('## Proposed')[0]!, /another provider[\s\S]*supersedes/);
});

test('a person\'s edit inside a keeper block is kept, recorded as a conflict and listed for attention', () => {
  const root = temp();
  applyWrite(root, write({ kind: 'summary', text: 'Keeper summary.' }), NOW);
  const overview = path.join(root, ...DIR.split('/'), 'Overview.md');
  fs.writeFileSync(overview, fs.readFileSync(overview, 'utf8').replace('Keeper summary.', 'Sam wrote this by hand.') + '\nA note below.\n');
  const out = applyWrite(root, write({ kind: 'summary', text: 'Newer keeper summary.' }), NOW + 60_000);
  assert.equal(out.state, 'conflict');
  const text = fs.readFileSync(overview, 'utf8');
  assert.equal(getBlock(text, 'summary'), 'Sam wrote this by hand.');
  assert.match(text, /A note below\./);
  assert(revisions(root).some((r) => r.kind === 'conflict' && r.page === 'Overview.md' && r.block === 'summary'));
  assert.match(file(root, `${DIR}/Decisions.md`).split('## Proposed')[1]!, /Newer keeper summary/);
  assert.match(file(root, 'Needs attention.md'), /Overview\]\] summary: a person edited the keeper block/);
});

test('an intake lists what needs a person through an attention-<intake> business fact', () => {
  const root = temp();
  applyWrite(root, write({ kind: 'fact', space: 'agency', section: 'attention-chat-intake',
    text: 'Chat intake 2026-11-05:\n- Discord #smokingeveryday has no Acme ID\n- 2 messages not written' }), NOW);
  writeAttention(root, NOW);
  const page = file(root, 'Needs attention.md').split('## From the intakes')[1]!.split('\n## ')[0]!;
  assert.match(page, /\[\[Acme\/Facts\/attention-chat-intake\|chat-intake\]\]: Discord #smokingeveryday has no Acme ID/);
  assert.match(page, /chat-intake\]\]: 2 messages not written/);
  assert.doesNotMatch(page, /Chat intake 2026-11-05/);   // only the "- " lines
  applyWrite(root, write({ kind: 'fact', space: 'agency', section: 'attention-chat-intake', text: 'nothing to do',
    replaces: 'Chat intake 2026-11-05:\n- Discord #smokingeveryday has no Acme ID\n- 2 messages not written' }), NOW + 1000);
  writeAttention(root, NOW + 1000);
  assert.match(file(root, 'Needs attention.md'), /## From the intakes\n- none/);
});

test('rebuilding the index from scratch equals the incremental one', () => {
  const root = temp();
  applyWrite(root, write({ kind: 'event', text: 'One.' }), NOW);
  applyWrite(root, write({ kind: 'fact', section: 'budget', text: '¥300,000' }), NOW);
  applyWrite(root, write({ kind: 'summary', text: 'Summary.' }), NOW);
  applyWrite(root, write({ kind: 'decision', space: 'project:kokuban', text: 'Decided.' }), NOW);
  const incremental = loadIndex(root)!;
  fs.rmSync(path.join(root, '.keeper', 'index.json'));
  assert.deepEqual(buildIndex(root), incremental);
  assert.deepEqual(rebuildIndex(root), incremental);
  assert.deepEqual(loadIndex(root), incremental);
});

test('a write that looks like a credential is refused and nothing is written', async () => {
  const root = temp();
  for (const text of ['password=hunter2', 'token: sk-abcdef', 'a'.repeat(64)]) {
    assert.throws(() => applyWrite(root, write({ kind: 'event', text }), NOW), /credential/);
  }
  assert.throws(() => applyWrite(root, write({ kind: 'event', text: 'ok', source: 'api_key=abc' }), NOW), /credential/);
  assert(!fs.existsSync(path.join(root, 'Acme')));
  const board = new Board();
  const me = board.touch('s', '', 'claude').session;
  const config = (): KeeperConfig => ({ path: root, keeper: false, keeperPc: 'keeper-pc' });
  await assert.rejects(vaultTool(board, me, { op: 'write', kind: 'event', text: 'password=x', source: 's', space: 'agency' }, { config }), /credential/);
  assert.equal(queued(root).length, 0);
});

test('a non-keeper forwards over /peer with work trust, queues while the keeper is down, then drains', () => withSettings({ person: 'Alex' }, async () => {
  const here = temp(), keeper = temp();
  const keeperBoard = new Board();
  const headers = { 'tailscale-user-login': 'alex', 'x-forwarded-for': '100.64.0.9' };
  const lookup = async () => ({ login: 'alex', node: 'pc-c.tail.ts.net' });
  const keeperCfg = (): KeeperConfig => ({ path: keeper, keeper: true, keeperPc: 'keeper-pc' });
  let up = false;
  let trust: 'share' | 'work' = 'work';
  const fetchPeer = (async (_url: string, init?: RequestInit) => {
    if (!up) throw new TypeError('fetch failed');
    const out = await handlePeer(keeperBoard, headers, JSON.parse(String(init?.body)), { lookup, trust: () => trust, keeper: { config: keeperCfg, now: () => NOW } });
    return new Response(JSON.stringify(out.body), { status: out.status });
  }) as typeof fetch;
  const deps = { config: (): KeeperConfig => ({ path: here, keeper: false, keeperPc: 'keeper-pc' }), fetch: fetchPeer, resolve: async () => 'keeper-pc.tail.ts.net', pc: () => 'pc-c', now: () => NOW };
  const board = new Board();
  const me = board.touch('s', '', 'claude').session;
  const args = { op: 'write', kind: 'event', text: 'Queued while keeper-pc was off.', source: 'test', space: 'T-05555', name: '青空工房' };
  assert.match(await vaultTool(board, me, args, deps), /^queued:/);
  assert.equal(queued(here).length, 1);
  assert(!fs.existsSync(path.join(here, 'Acme')), 'a non-keeper never writes synced notes');
  assert.match(file(here, '.stignore'), /\/\.keeper\/queue/);
  assert.deepEqual(await drainQueue(deps.config(), deps), { sent: 0, left: 1 });
  up = true;
  assert.deepEqual(await drainQueue(deps.config(), deps), { sent: 1, left: 0 });
  assert.match(file(keeper, `${DIR}/Work log.md`), /Queued while keeper-pc was off/);
  const [rev] = revisions(keeper);
  assert.equal(rev!.author, `${me.name}@pc-c (Alex)`);
  // Direct forwarding when it is up; a lesser trust is refused and not queued.
  assert.match(await vaultTool(board, me, { ...args, text: 'Sent directly.' }, deps), /^written: event/);
  trust = 'share';
  await assert.rejects(vaultTool(board, me, { ...args, text: 'Refused.' }, deps), /refused this write \(HTTP 403\)/);
  assert.equal(queued(here).length, 0);
  // A PC that is not the keeper refuses the op.
  trust = 'work';
  const notKeeper = await handlePeer(keeperBoard, headers, { op: 'vault_write', write: write({ kind: 'event', text: 'x' }) },
    { lookup, trust: () => 'work', keeper: { config: () => ({ path: keeper, keeper: false, keeperPc: 'keeper-pc' }) } });
  assert.equal(notKeeper.status, 409);
}));

test('reads are local, scoped and end with a based-on line', () => {
  const root = temp();
  applyWrite(root, write({ kind: 'summary', text: 'Pottery school, preview sent.' }), NOW);
  applyWrite(root, write({ kind: 'fact', section: 'launch-date', text: '2026-12-01' }), NOW);
  const client = findClientPage(root, 'T-05555');
  assert.match(client, /^T-05555 \| Acme\/Clients\/0 ❓ No stage\/T-05555 青空工房\//);
  assert.match(client, /Pottery school, preview sent\.[\s\S]*\nbased on: Acme\/Clients\/0 ❓ No stage\/T-05555 青空工房\/Overview\.md \(updated 2026-11-04 10:00\)$/);
  assert.match(findClientPage(root, '青空'), /^T-05555/);
  assert.match(findClientPage(root, 'nobody'), /no client matches/);
  assert.match(searchVault(root, 'launch-date', { tobira_id: 'T-05555' }), /Facts\/launch-date\.md \| launch-date \| T-05555[\s\S]*based on:/);
  assert.match(searchVault(root, 'preview sent'), /Overview\.md[\s\S]*matched by text/);
  assert.equal(searchVault(root, 'launch-date', { space: 'agency' }), 'no pages match');
  assert.match(readPage(root, 'Facts/launch-date', 'T-05555'), /2026-12-01[\s\S]*based on: .*launch-date\.md/);
  assert.throws(() => readPage(root, '../outside.md'), /inside the vault/);
  assert.throws(() => readPage(root, '.keeper/index.json'), /inside the vault/);
});

test('session-start rules and the vault tool appear only when the vault is configured', async () => {
  const start = (board: Board, id: string) => JSON.stringify(handleHook(board, 'claude', { hook_event_name: 'SessionStart', session_id: id, source: 'startup' }));
  const tools = async (board: Board) => JSON.stringify(await handleRpc(board, 'claude', { id: 1, method: 'tools/list' }));
  await withSettings({ person: 'Alex' }, async () => {
    assert.equal(keeperConfig(), null);
    const board = new Board();
    assert.doesNotMatch(start(board, 'a'), /Shared vault/);
    assert.doesNotMatch(await tools(board), /"name":"vault"/);
  });
  await withSettings({ person: 'Alex', vault: { path: temp(), keeper: false } }, async () => {
    const board = new Board();
    const out = start(board, 'b');
    assert.match(out, /Shared vault \(Obsidian\): use only the vault tool[^\n]*Catch up first with vault\(op=\\"catchup\\"/);
    const lines = (JSON.parse(out).hookSpecificOutput.additionalContext as string).split('\n');
    const at = lines.findIndex((l) => l.includes('Shared vault'));
    assert(lines.slice(at, at + 6).filter((l) => /vault|Rules\.md|proposal/i.test(l)).length <= 6);
    assert.match(await tools(board), /"name":"vault"/);
  });
});

test('the nightly check-up lists an orphan page, a conflict and a client without aliases', () => {
  const root = temp();
  applyWrite(root, write({ kind: 'fact', section: 'launch-date', text: '2026-12-01' }), NOW);
  applyWrite(root, write({ kind: 'fact', section: 'launch-date', text: '2027-01-10' }), NOW);
  fs.writeFileSync(path.join(root, ...DIR.split('/'), 'Loose notes.md'), '# Loose notes\n');
  fs.mkdirSync(path.join(root, 'Acme', 'Clients', 'T-00007 Nameless'));
  fs.writeFileSync(path.join(root, 'Acme', 'Clients', 'T-00007 Nameless', 'Overview.md'), '---\ntobira_id: T-00007\n---\n# Nameless\n');
  fs.writeFileSync(path.join(root, 'Acme', 'Clients', 'stray.md'), 'no client\n');
  const found = writeAttention(root, NOW + 3_600_000);
  assert.deepEqual(found['Orphan pages'], [`[[${DIR}/Loose notes]]`]);
  assert.equal(found['Conflicts and contradictions']!.length, 1);
  assert.match(found['Conflicts and contradictions']![0]!, /conflicts with \[\[.*Facts\/launch-date\]\]/);
  assert.match(found['Client folders without tobira_id or aliases']!.join('\n'), /T-00007 Nameless.*no aliases/);
  assert.deepEqual(found['Unassigned items'], ['[[Acme/Clients/stray]]']);
  const page = file(root, 'Needs attention.md');
  assert.match(page, /## Orphan pages\n- \[\[Acme\/Clients\/0 ❓ No stage\/T-05555 青空工房\/Loose notes\]\]/);
  assert.match(page, /## Queue backlog\n- none/);
});

/** A path Windows would otherwise trim ("Foo Inc." → "Foo Inc"): the keeper's PC may hold such a name. */
const raw = (p: string): string => (process.platform === 'win32' ? `\\\\?\\${p}` : p);

test('safeName makes every keeper-made name one Windows can hold; unsafeName says why an existing one cannot', () => {
  assert.equal(safeName('T-01234 Acme Inc.'), 'T-01234 Acme Inc');
  assert.equal(safeName('T-01234 株式会社サンプル Co.,Ltd.'), 'T-01234 株式会社サンプル Co.,Ltd');
  assert.equal(safeName('  Foo. . '), 'Foo');
  assert.equal(safeName('a<b>c:d"e/f\\g|h?i*j\u0001k\u007fl'), 'a b c d e f g h i j k l');
  assert.equal(safeName('CON'), 'CON_');
  assert.equal(safeName('nul.md'), 'nul_.md');
  assert.equal(safeName('com1'), 'com1_');
  assert.equal(safeName('LPT9.txt'), 'LPT9_.txt');
  assert.equal(safeName('console'), 'console');
  assert.equal(safeName('T-00001 青空工房'), 'T-00001 青空工房');
  assert.equal(safeName('...'), '');
  const long = safeName(`T-00001 ${'あ'.repeat(70)}. ${'い'.repeat(40)}`);
  assert.equal([...long].length <= NAME_MAX, true);
  assert(!/[. ]$/.test(long));
  assert.equal(safeName(`${'x'.repeat(78)}. y`), 'x'.repeat(78), 'a cut that leaves a trailing dot is trimmed again');
  assert.equal(unsafeName('T-00001 Acme'), '');
  assert.match(unsafeName('T-01234 Acme Inc.'), /ends with a dot/);
  assert.match(unsafeName('a:b'), /character/);
  assert.match(unsafeName('AUX.md'), /reserved/);
  assert.match(unsafeName('x'.repeat(256)), /255/);
});

test('a new client folder is Windows-safe; its front matter keeps the display name as given', () => {
  const root = temp();
  const res = applyWrite(root, write({ kind: 'summary', text: 'A company.', space: 'T-01234', name: '株式会社サンプル Co.,Ltd.' }), NOW);
  assert.equal(res.state, 'written');
  const dir = 'Acme/Clients/0 ❓ No stage/T-01234 株式会社サンプル Co.,Ltd';
  assert.deepEqual(fs.readdirSync(path.join(root, 'Acme', 'Clients')), ['0 ❓ No stage']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'Acme', 'Clients', '0 ❓ No stage')), ['T-01234 株式会社サンプル Co.,Ltd']);
  const fm = frontmatter(file(root, `${dir}/Overview.md`));
  assert.equal(fm.name, '株式会社サンプル Co.,Ltd.');
  assert.deepEqual(fm.aliases, ['株式会社サンプル Co.,Ltd.']);
  // Found again by its ID, so a second write goes to the same folder.
  assert.equal(applyWrite(root, write({ kind: 'fact', space: 'T-01234', section: 'price.', text: '1000' }), NOW).state, 'written');
  assert(fs.existsSync(path.join(root, ...dir.split('/'), 'Facts', 'price.md')), 'a fact name loses its trailing dot');
  assert.equal(applyWrite(root, write({ kind: 'fact', space: 'T-01234', section: 'con', text: 'x' }), NOW).state, 'written');
  assert(fs.existsSync(path.join(root, ...dir.split('/'), 'Facts', 'con_.md')), 'a device name gains _');
  assert.deepEqual(unsafeNames(root), []);
});

test('a business folder from settings and a new project space are Windows-safe too', () => {
  const g = parseGrouping({ acme: { folder: 'Acme Inc.', repos: ['acme'] } });
  assert.equal(g.businesses[0]!.folder, 'Acme Inc');
  const root = temp();
  assert.equal(placeDir(root, DEFAULT_GROUPING, { kind: 'shared' }, 'aux'), 'Shared tools/Projects/aux_');
  assert.equal(placeDir(root, DEFAULT_GROUPING, { kind: 'unsorted' }, 'tool.'), 'Unsorted/Projects/tool');
  fs.mkdirSync(path.join(root, 'Unsorted', 'Projects', 'tool'), { recursive: true });
  assert.equal(findProject(root, DEFAULT_GROUPING, 'tool.'), 'Unsorted/Projects/tool');
});

test('the nightly check-up lists names Windows cannot sync, so a person or the keeper can rename them', (t) => {
  const root = temp();
  applyWrite(root, write({ kind: 'summary', text: 'Pottery school.' }), NOW);
  const bad = path.join(root, 'Acme', 'Clients', 'T-01234 Acme Inc.');
  fs.mkdirSync(raw(bad));
  fs.writeFileSync(raw(path.join(bad, 'Overview.md')), '---\ntobira_id: T-01234\naliases: [Acme]\n---\n# Acme\n');
  fs.writeFileSync(raw(path.join(root, ...DIR.split('/'), 'Facts', 'nul.md')), 'x\n');
  t.after(() => fs.rmSync(raw(root), { recursive: true, force: true }));
  const found = writeAttention(root, NOW);
  assert.deepEqual(found['Names Windows cannot sync'], [
    `\`${DIR}/Facts/nul.md\`: a reserved device name; rename it to \`nul_.md\` so Windows PCs can sync it`,
    '`Acme/Clients/T-01234 Acme Inc.`: ends with a dot or space; rename it to `T-01234 Acme Inc` so Windows PCs can sync it',
  ]);
  assert.match(file(root, 'Needs attention.md'), /## Names Windows cannot sync\n(- .*\n)?- `Acme\/Clients\/T-01234 Acme Inc\.`/);
});

test('the daemon tick lays out the keeper vault and runs the check-up once a night; it is a no-op without settings', async () => {
  const root = temp();
  const board = new Board();
  const config = (): KeeperConfig => ({ path: root, keeper: true, keeperPc: 'keeper-pc' });
  await keeperTick(board, { config: () => null });
  assert(!fs.existsSync(path.join(root, 'Rules.md')));
  await keeperTick(board, { config, now: () => new Date(2026, 10, 4, 2, 0).getTime() });
  assert(fs.existsSync(path.join(root, 'Rules.md')));
  assert(!fs.existsSync(path.join(root, 'Needs attention.md')), 'not before 03:00');
  await keeperTick(board, { config, now: () => new Date(2026, 10, 4, 4, 0).getTime() });
  const first = file(root, 'Needs attention.md');
  await keeperTick(board, { config, now: () => new Date(2026, 10, 4, 5, 0).getTime() });
  assert.equal(file(root, 'Needs attention.md'), first, 'once a day');
  await keeperTick(board, { config, now: () => new Date(2026, 10, 5, 4, 0).getTime() });
  assert.notEqual(file(root, 'Needs attention.md'), first);
});

// -- connections (D90) ------------------------------------------------------------------------------

const TOKEN = 'brain-token-for-tests-only-7f3a';
const GDIR = 'Acme/Clients/0 ❓ No stage/T-00044 北光金属';
const connection = (fields: Record<string, string> = {}): Record<string, string> => ({
  op: 'write', kind: 'connection', tobira_id: 'T-00044', client_name: '北光金属', name: '白鷺堂 Shirasagi',
  email: 'Info@Shirasagi.example', website: 'https://www.shirasagi.example/shop', evidence: 'reply from the owner, 2026-11-03', ...fields,
});
function cockpitSetup(answer: (body: { kind: string; value: string }) => Response) {
  const root = temp();
  const tokenFile = path.join(temp(), 'token.txt');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`);
  const calls: Array<{ url: string; auth: string; body: { kind: string; value: string; source: string } }> = [];
  const fetchCockpit = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), auth: String((init?.headers as Record<string, string>).authorization), body });
    return answer(body);
  }) as typeof fetch;
  const config = (): KeeperConfig => ({ path: root, keeper: true, keeperPc: 'keeper-pc', cockpit: { url: 'https://cockpit.test', tokenFile } });
  const board = new Board();
  const logs: string[] = [];
  board.usage = (e) => logs.push(JSON.stringify(e));
  const me = board.touch('s', '', 'claude').session;
  return { root, tokenFile, calls, config, board, me, logs, deps: { config, fetch: fetchCockpit, pc: () => 'keeper-pc', now: () => NOW } };
}
const ok = (): Response => new Response(JSON.stringify({ ok: true }), { status: 200 });
const allText = (root: string): string => Object.entries(tree(root)).map(([rel, text]) => `${rel}\n${text}`).join('\n');

test('a connection is recorded under Connected businesses, adds an alias and is listed in the log and revisions', () => {
  const root = temp();
  const req: WriteRequest = { ...write({ kind: 'connection', text: '', space: 'T-00044', name: '白鷺堂 Shirasagi' }), client_name: '北光金属',
    email: 'info@shirasagi.example', domain: 'shirasagi.example', evidence: 'reply from the owner, 2026-11-03', source: '' };
  const out = applyWrite(root, req, NOW);
  assert.equal(out.state, 'written');
  assert.match(out.message, /alias added to Overview/);
  const decisions = file(root, `${GDIR}/Decisions.md`);
  assert.match(decisions, /## Connected businesses\n\n- 2026-11-04 10:00Z 白鷺堂 Shirasagi — email info@shirasagi\.example · domain shirasagi.example\n  _source: reply from the owner, 2026-11-03 · Rio@pc-c \(Alex\)_ \^r-/);
  assert.deepEqual(frontmatter(file(root, `${GDIR}/Overview.md`)).aliases, ['北光金属', '白鷺堂 Shirasagi']);
  assert.match(findClientPage(root, '白鷺堂 Shirasagi'), /^T-00044/);
  assert.match(file(root, `${GDIR}/log.md`), /connection \[\[.*Decisions\|Decisions\]\]: 白鷺堂 Shirasagi — email/);
  const rev = revisions(root).at(-1)!;
  assert.equal(rev.kind, 'connection');
  assert.equal(rev.section, '白鷺堂 Shirasagi');
  assert.equal(rev.source, 'reply from the owner, 2026-11-03');
  assert.equal(applyWrite(root, { ...req, request_id: 'test-request-again' }, NOW).state, 'unchanged');
  assert.equal(cockpitQueued(root).length, 0, 'nothing is queued for acme-cockpit unless it is configured');
  assert.throws(() => applyWrite(root, { ...req, request_id: 'test-r-noev', evidence: '' }, NOW), /evidence required/);
  assert.throws(() => applyWrite(root, { ...req, request_id: 'test-r-mail', email: 'not-an-email' }, NOW), /email/);
  assert.throws(() => applyWrite(root, { ...req, request_id: 'test-r-web', domain: 'no domain here' }, NOW), /not a domain/);
  assert.throws(() => applyWrite(root, { ...req, request_id: 'test-r-agency', space: 'agency' }, NOW), /tobira_id/);
});

test('on the keeper a connection is forwarded to acme-cockpit: alias, email and the website\'s domain', async () => {
  const { root, calls, board, me, deps } = cockpitSetup(ok);
  const out = await vaultTool(board, me, connection(), deps);
  assert.match(out, /^written: connection 白鷺堂 Shirasagi[\s\S]*3 link\(s\) queued[\s\S]*acme-cockpit: 3 sent\.$/);
  assert.deepEqual(calls.map((c) => [c.url, c.body.kind, c.body.value]), [
    ['https://cockpit.test/api/internal/brain/clients/T-00044/links', 'alias', '白鷺堂 Shirasagi'],
    ['https://cockpit.test/api/internal/brain/clients/T-00044/links', 'email', 'info@shirasagi.example'],
    ['https://cockpit.test/api/internal/brain/clients/T-00044/links', 'domain', 'shirasagi.example'],
  ]);
  assert(calls.every((c) => c.auth === `Bearer ${TOKEN}` && /^kokuban vault T-00044 r-\w+: reply from the owner/.test(c.body.source)));
  assert.equal(cockpitQueued(root).length, 0);
  // Without vault.cockpit the connection is recorded only.
  const plain = temp();
  calls.length = 0;
  const local = await vaultTool(board, me, connection(), { ...deps, config: () => ({ path: plain, keeper: true, keeperPc: 'keeper-pc' }) });
  assert.match(local, /^written: connection/);
  assert.doesNotMatch(local, /cockpit/);
  assert.equal(calls.length, 0);
  assert.equal(cockpitQueued(plain).length, 0);
});

test('a 409 from acme-cockpit becomes a proposal "Conflicts with <owner>" listed on Needs attention; a 400 is set aside', async () => {
  const { root, board, me, deps } = cockpitSetup((body) =>
    body.kind === 'domain' ? new Response(JSON.stringify({ ok: false, owner: 'T-00007' }), { status: 409 })
      : body.kind === 'email' ? new Response(JSON.stringify({ ok: false, error: 'free mailbox' }), { status: 400 }) : ok());
  applyWrite(root, write({ kind: 'event', space: 'T-00007', name: 'Shirasagi Online', text: 'First contact.' }), NOW);
  const out = await vaultTool(board, me, connection(), deps);
  assert.match(out, /1 sent; conflict, written as a proposal for a person: domain shirasagi.example → T-00007; 1 refused/);
  const proposed = file(root, `${GDIR}/Decisions.md`).split('## Proposed — not accepted')[1]!.split('## Connected businesses')[0]!;
  assert.match(proposed, /\*\*connection 白鷺堂 Shirasagi\*\* — Conflicts with T-00007: acme-cockpit did not link domain "shirasagi.example"/);
  assert.match(proposed, /\*\*Conflicts with\*\* \[\[Acme\/Clients\/0 ❓ No stage\/T-00007 Shirasagi Online\/Overview\]\]/);
  const attention = file(root, 'Needs attention.md');
  assert.match(attention, /## Conflicts and contradictions\n- .*proposal r \w+.* conflicts with \[\[Acme\/Clients\/0 ❓ No stage\/T-00007 Shirasagi Online\/Overview\]\]/);
  assert.match(attention, /acme-cockpit refused a connection link: \.keeper\/queue\/cockpit\/.*\.refused/);
  assert.equal(cockpitQueued(root).length, 0);
  assert.equal(cockpitQueued(root, '.refused').length, 1);
  assert.match(fs.readFileSync(path.join(root, '.keeper', 'queue', 'cockpit', cockpitQueued(root, '.refused.txt')[0]!), 'utf8'), /HTTP 400.*free mailbox/);
});

test('when acme-cockpit is down the links wait in the keeper outbox and go out on the tick; the token is never stored or logged', async () => {
  let up = false;
  const { root, tokenFile, calls, board, me, deps, logs } = cockpitSetup(() => {
    if (!up) throw new TypeError('fetch failed');
    return ok();
  });
  const out = await vaultTool(board, me, connection(), deps);
  assert.match(out, /0 sent; 3 waiting \(acme-cockpit unreachable\), retried every 30 seconds/);
  assert.equal(cockpitQueued(root).length, 3);
  assert.match(file(root, '.stignore'), /\/\.keeper\/queue/, 'the outbox is never synced');
  await keeperTick(board, deps);
  assert.equal(cockpitQueued(root).length, 3);
  assert(logs.some((l) => /vault:cockpit.*unreachable; 3 waiting/.test(l)));
  // A missing token file waits too, and says nothing about the token.
  up = true;
  fs.renameSync(tokenFile, `${tokenFile}.off`);
  assert.equal((await sendCockpit(deps.config(), deps)).error, 'the acme-cockpit token file is missing or empty');
  assert.equal(cockpitQueued(root).length, 3);
  fs.renameSync(`${tokenFile}.off`, tokenFile);
  await keeperTick(board, deps);
  assert.equal(cockpitQueued(root).length, 0);
  assert(calls.every((c) => c.auth === `Bearer ${TOKEN}`));
  assert.deepEqual(calls.slice(-3).map((c) => c.body.kind), ['alias', 'email', 'domain']);
  assert(!allText(root).includes(TOKEN), 'the token never enters the vault');
  assert(!logs.join('\n').includes(TOKEN), 'the token is never logged');
  assert(!out.includes(TOKEN));
});

test('a connection written on another PC is forwarded to the keeper, which queues its links', () => withSettings({ person: 'Alex' }, async () => {
  const here = temp(), keeper = temp();
  const tokenFile = path.join(temp(), 'token.txt');
  fs.writeFileSync(tokenFile, TOKEN);
  const keeperBoard = new Board();
  const headers = { 'tailscale-user-login': 'alex', 'x-forwarded-for': '100.64.0.9' };
  const lookup = async () => ({ login: 'alex', node: 'pc-c.tail.ts.net' });
  const keeperDeps = {
    config: (): KeeperConfig => ({ path: keeper, keeper: true, keeperPc: 'keeper-pc', cockpit: { url: 'https://cockpit.test', tokenFile } }),
    now: () => NOW, fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
  };
  const fetchPeer = (async (_url: string, init?: RequestInit) => {
    const out = await handlePeer(keeperBoard, headers, JSON.parse(String(init?.body)), { lookup, trust: () => 'work', keeper: keeperDeps });
    return new Response(JSON.stringify(out.body), { status: out.status });
  }) as typeof fetch;
  const board = new Board();
  const me = board.touch('s', '', 'claude').session;
  const out = await vaultTool(board, me, connection(), { config: () => ({ path: here, keeper: false, keeperPc: 'keeper-pc' }), fetch: fetchPeer,
    resolve: async () => 'keeper-pc.tail.ts.net', pc: () => 'pc-c', now: () => NOW });
  assert.match(out, /^written: connection 白鷺堂 Shirasagi .*3 link\(s\) queued for acme-cockpit/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cockpitQueued(keeper).length, 3);
  assert.match(file(keeper, `${GDIR}/Decisions.md`), /白鷺堂 Shirasagi — email info@shirasagi\.example · domain shirasagi.example · website https:\/\/www\.shirasagi.example\/shop/);
  assert(!fs.existsSync(path.join(here, 'Acme')));
}));

test('the connection rule is in the session-start lines and Rules.md; an untouched first Rules.md gains it; settings carry cockpit', async () => {
  assert.match(vaultRules({ path: temp(), keeper: false, keeperPc: 'keeper-pc' }), /two businesses are connected.*vault write kind=connection and the evidence/);
  const root = temp();
  ensureLayout(root);
  assert.match(file(root, 'Rules.md'), /10\. When you learn two businesses are connected .*kind=connection and the evidence/);
  const old = temp();
  fs.writeFileSync(path.join(old, 'Rules.md'), RULES_V1);
  ensureLayout(old);
  assert.equal(file(old, 'Rules.md'), RULES_PAGE);
  await withSettings({ vault: { path: root, keeper: true, cockpit: { url: 'https://cockpit.test/', token_file: 'C:\\t.txt' } } }, async () => {
    assert.deepEqual(keeperConfig()!.cockpit, { url: 'https://cockpit.test', tokenFile: 'C:\\t.txt' });
  });
  await withSettings({ vault: { path: root, keeper: true } }, async () => assert.equal(keeperConfig()!.cockpit, undefined));
});

// -- Overview front matter through the keeper -----------------------------------------------------

const overviewOf = (root: string): string => file(root, `${cdir(root)}/Overview.md`);

test('front matter on a write: whitelisted fields set on the Overview, lists merged, other keys and the body kept', () => {
  const root = temp();
  applyWrite(root, write({ kind: 'summary', text: 'Pottery school site.' }), NOW);
  // A person's own key and a note below stay where they are.
  const ov = path.join(root, ...DIR.split('/'), 'Overview.md');
  fs.writeFileSync(ov, fs.readFileSync(ov, 'utf8').replace('---\n# ', 'owner: "Sam"\n---\n# ') + '\nA note by hand.\n');
  const out = applyWrite(root, write({ kind: 'event', text: 'Contract signed.', frontmatter: {
    stage: 'signed', care_stage: 'active', aliases: ['AOZ', '青空工房', 'aoz'], tags: ['#pottery', 'web'] } }), NOW);
  assert.equal(out.state, 'written');
  assert.match(out.message, /front matter set: stage signed; care_stage active; aliases \+ AOZ; tags \+ pottery, web/);
  let text = overviewOf(root);
  let fm = frontmatter(text);
  assert.equal(fm.stage, 'signed');
  assert.equal(fm.care_stage, 'active');
  assert.deepEqual(fm.aliases, ['青空工房', 'AOZ'], 'merged and deduplicated, case-insensitively');
  assert.deepEqual(fm.tags, ['pottery', 'web']);
  assert.equal(fm.tobira_id, 'T-05555');
  assert.equal(fm.owner, 'Sam');
  assert.equal(fm.updated, new Date(NOW).toISOString());
  assert.equal(getBlock(text, 'summary'), 'Pottery school site.');
  assert.match(text, /A note by hand\./);
  // Signed: the folder moved to its stage group right after the write.
  assert.equal(cdir(root), 'Acme/Clients/2 🛠 Building/T-05555 青空工房');
  assert(!fs.existsSync(path.join(root, ...DIR.split('/'))));
  assert(!fs.existsSync(path.join(root, 'Acme', 'Clients', '0 ❓ No stage')), 'the group it left was empty, so it went');
  assert.match(out.message, /moved Acme\/Clients\/0 ❓ No stage\/T-05555 青空工房 → Acme\/Clients\/2 🛠 Building\/T-05555/);
  assert.match(file(root, `${cdir(root)}/Work log.md`), /Contract signed\./);
  // The agent's own revision (the move and its links come after it).
  const rev = revisions(root).filter((r) => r.author.startsWith('Rio@')).at(-1)!;
  assert.equal(rev.kind, 'frontmatter');
  assert.equal(rev.page, 'Overview.md');
  assert.deepEqual(Object.keys(rev.fields!).sort(), ['aliases', 'care_stage', 'stage', 'tags']);
  const log = file(root, `${cdir(root)}/log.md`);
  assert.match(log, /event \[\[.*Work log\|Work log\]\]: Contract signed\./);
  assert.match(log, /front matter \[\[.*Overview\|Overview\]\]: stage signed; care_stage active; aliases \+ AOZ; tags \+ pottery, web — Rio@pc-c/);
  assert.match(log, /stage: \(none\) → signed \(call with Sam\) — Rio@pc-c \(Alex\) \^r-/);
  // The hidden index knows the new alias, so the client is found by it.
  assert.deepEqual(loadIndex(root)!.pages[`${cdir(root)}/Overview.md`]!.aliases, ['青空工房', 'AOZ']);
  assert.match(findClientPage(root, 'AOZ'), /^T-05555/);

  // A later write adds to the lists, never removes; a stage change is logged with its source.
  applyWrite(root, write({ kind: 'event', text: 'Build started.', source: 'kickoff call', frontmatter: { stage: 'building', aliases: ['Aozora Kobo Works'] } }), NOW + 60_000);
  fm = frontmatter(overviewOf(root));
  assert.equal(fm.stage, 'building');
  assert.deepEqual(fm.aliases, ['青空工房', 'AOZ', 'Aozora Kobo Works']);
  assert.deepEqual(fm.tags, ['pottery', 'web']);
  assert.match(file(root, `${cdir(root)}/log.md`), /stage: signed → building \(kickoff call\)/);
  // The same front matter again changes nothing; with an unchanged summary the whole write is unchanged.
  text = overviewOf(root);
  const again = applyWrite(root, write({ kind: 'summary', text: 'Pottery school site.', frontmatter: { stage: 'building', aliases: ['AOZ'] } }), NOW + 120_000);
  assert.equal(again.state, 'unchanged');
  assert.equal(overviewOf(root), text);
  // Front matter alone with an otherwise unchanged write still counts as written.
  const only = applyWrite(root, write({ kind: 'summary', text: 'Pottery school site.', frontmatter: { stage: 'launch' } }), NOW + 180_000);
  assert.equal(only.state, 'written');
  assert.equal(only.page, 'Overview.md');
  assert.match(file(root, `${cdir(root)}/log.md`), /stage: building → launch/);
  // Rebuilt from scratch, the index matches the incremental one.
  assert.deepEqual(buildIndex(root), loadIndex(root));
});

test('front matter refuses unknown keys, invalid stages, bad lists and the agency space; nothing is written', async () => {
  const root = temp();
  const bad: Array<[unknown, RegExp, string?]> = [
    [{ owner: 'Sam' }, /may set only stage, care_stage, aliases, tags, cssclasses, business, last_event, next_step, status; not owner/],
    [{ stage: 'signed', updated: 'x' }, /not updated/],
    [{ stage: 'won' }, /stage must be one of outreach, replied/],
    [{ care_stage: 'gone' }, /care_stage must be one of active/],
    [{ aliases: 'AOZ' }, /aliases must be a list/],
    [{ aliases: [] }, /aliases must be a list/],
    [{ aliases: ['two\nlines'] }, /aliases must be a list/],
    [{ tags: ['two words'] }, /a tag is one word/],
    [{ next_step: 'two\nlines' }, /next_step must be one line/],
    [{}, /frontmatter is empty/],
    [['stage'], /frontmatter must be an object/],
    [{ stage: 'signed' }, /client \(T-…\) or "project:<repo>" space/, 'agency'],
  ];
  for (const [frontmatter, error, space] of bad) {
    assert.throws(() => applyWrite(root, write({ kind: 'event', text: 'x', frontmatter: frontmatter as never, ...(space ? { space } : {}) }), NOW), error);
  }
  assert(!fs.existsSync(path.join(root, 'Acme')));
  assert.equal(revisions(root).length, 0);
  // The tool takes the object (or its JSON text) and validates it the same way.
  const board = new Board();
  const me = board.touch('s', '', 'claude').session;
  const config = (): KeeperConfig => ({ path: root, keeper: true, keeperPc: 'keeper-pc' });
  await assert.rejects(vaultTool(board, me, { op: 'write', kind: 'event', text: 'x', source: 's', space: 'T-1', name: 'A', frontmatter: { stage: 'won' } }, { config }), /stage must be/);
  const out = await vaultTool(board, me, { op: 'write', kind: 'event', text: 'Proposal sent.', source: 'mail', space: 'T-1', name: 'A',
    frontmatter: JSON.stringify({ stage: 'proposal' }) }, { config, pc: () => 'keeper-pc' });
  assert.match(out, /front matter set: stage proposal/);
  assert.equal(frontmatter(file(root, 'Acme/Clients/1 🔥 Act now/T-1 A/Overview.md')).stage, 'proposal');
});

test('a front matter field a person changed by hand keeps their value, becomes a conflict and is listed for attention', () => {
  const root = temp();
  // Set by hand before the keeper ever touched it (the first import): the keeper's first write takes it over.
  applyWrite(root, write({ kind: 'summary', text: 'Summary.' }), NOW);
  // The Overview where its folder is now (it moves with the stage).
  const ovp = (): string => path.join(root, ...cdir(root).split('/'), 'Overview.md');
  let ov = ovp();
  fs.writeFileSync(ov, fs.readFileSync(ov, 'utf8').replace('---\n# ', 'stage: "replied"\n---\n# '));
  assert.equal(applyWrite(root, write({ kind: 'event', text: 'Meeting booked.', frontmatter: { stage: 'engaging' } }), NOW).state, 'written');
  assert.equal(frontmatter(overviewOf(root)).stage, 'engaging');
  assert(!revisions(root).some((r) => r.kind === 'conflict'));

  // Sam moves the card on the board by hand; an agent then writes a different stage.
  ov = ovp();
  fs.writeFileSync(ov, fs.readFileSync(ov, 'utf8').replace('stage: "engaging"', 'stage: signed'));
  const out = applyWrite(root, write({ kind: 'event', text: 'Sent the proposal.', frontmatter: { stage: 'proposal', tags: ['web'] } }), NOW + 60_000);
  assert.equal(out.state, 'written', 'the event itself is written');
  assert.equal(out.conflicts_with, 'Acme/Clients/1 🔥 Act now/T-05555 青空工房/Overview.md', 'where it was when written');
  assert.match(out.message, /front matter set: tags \+ web.*front matter conflict: a person changed stage by hand; their value was kept/);
  const fm = frontmatter(overviewOf(root));
  assert.equal(fm.stage, 'signed', 'the person\'s value stays');
  assert.deepEqual(fm.tags, ['web'], 'other fields of the same write still apply');
  const conflict = revisions(root).find((r) => r.kind === 'conflict')!;
  assert.equal(conflict.block, 'frontmatter:stage');
  assert.equal(conflict.page, 'Overview.md');
  assert.match(file(root, `${cdir(root)}/Decisions.md`).split('## Proposed')[1]!, /\*\*front matter\*\* — Overview front matter: stage → "proposal" \(a person set "signed"\)/);
  assert.match(file(root, 'Needs attention.md'), /Overview\]\] front matter stage: a person changed it by hand; their value was kept/);
  assert.match(file(root, `${cdir(root)}/log.md`), /conflict \[\[.*Overview\|Overview\]\]: a person changed stage by hand/);
  assert.doesNotMatch(file(root, `${cdir(root)}/log.md`), /stage: engaging → proposal/);

  // Reported once: the person's value is now the keeper's last one, so the next agent write applies on top of it.
  const next = applyWrite(root, write({ kind: 'event', text: 'Build started.', frontmatter: { stage: 'building' } }), NOW + 120_000);
  assert.equal(next.conflicts_with, undefined);
  assert.equal(frontmatter(overviewOf(root)).stage, 'building');
  assert.match(file(root, `${cdir(root)}/log.md`), /stage: signed → building/);

  // A person removing an alias the keeper set is a hand edit too: the alias is not re-added.
  applyWrite(root, write({ kind: 'event', text: 'x', frontmatter: { aliases: ['AOZ'] } }), NOW + 180_000);
  ov = ovp();
  fs.writeFileSync(ov, fs.readFileSync(ov, 'utf8').replace(/aliases: .*/, 'aliases:\n  - 青空工房'));
  const alias = applyWrite(root, write({ kind: 'event', text: 'y', frontmatter: { aliases: ['AOZ', 'Aozora Kobo Works'] } }), NOW + 240_000);
  assert.match(alias.message, /a person changed aliases by hand/);
  assert.deepEqual(frontmatter(overviewOf(root)).aliases, ['青空工房']);
});

test('a connection\'s alias is the keeper\'s own, so later front matter on aliases is no conflict; project spaces take front matter too', () => {
  const root = temp();
  const req: WriteRequest = { ...write({ kind: 'connection', text: '', space: 'T-00044', name: '白鷺堂' }), client_name: '北光金属', evidence: 'owner said so' };
  applyWrite(root, write({ kind: 'event', space: 'T-00044', name: '北光金属', text: 'First.', frontmatter: { aliases: ['Hokko'] } }), NOW);
  applyWrite(root, req, NOW);
  const out = applyWrite(root, write({ kind: 'event', space: 'T-00044', text: 'Second.', frontmatter: { aliases: ['HKK'] } }), NOW);
  assert.equal(out.conflicts_with, undefined);
  assert.deepEqual(frontmatter(file(root, `${GDIR}/Overview.md`)).aliases, ['北光金属', 'Hokko', '白鷺堂', 'HKK']);

  const project = applyWrite(root, write({ kind: 'decision', space: 'project:kokuban', text: 'Ship the keeper.', frontmatter: { tags: ['kokuban'], stage: 'building' } }), NOW);
  assert.match(project.message, /front matter set/);
  const ov = file(root, 'Shared tools/Projects/kokuban/Overview.md');
  assert.deepEqual(frontmatter(ov).tags, ['kokuban']);
  assert.equal(frontmatter(ov).stage, 'building');
  assert.match(ov, /^---\n[\s\S]*\n---\n# kokuban\n/);
  assert.match(file(root, 'Shared tools/Projects/kokuban/log.md'), /stage: \(none\) → building/);
});

// -- the vault's credential check -----------------------------------------------------------------

test('links and Git commit ids pass the vault\'s credential check; real credential shapes are still refused', () => {
  const root = temp();
  const sha40 = '3f9c2a7be41d06c58e9f1b2a3c4d5e6f70819a2b';
  const long = `https://github.com/example-org/acme/blob/${sha40}/context/leads/2026/10/T-05555/threads/initial/thread.md#L12`;
  const fine = [
    `Reply logged; see ${long}`,
    `[thread](${long}) and the plain path https://github.com/example-org/acme/tree/main/context/leads/archive/2026/october/clients/all`,
    `Fixed in ${sha40}.`,
    'Short id 3f9c2a7 and the full one in commit abcdef1.',
  ];
  for (const text of fine) assert.equal(applyWrite(root, write({ kind: 'event', text }), NOW).state, 'written', text);
  assert.equal(applyWrite(root, write({ kind: 'event', text: 'From the import.', source: long }), NOW).state, 'written');
  // Shared know-how keeps its strict check: only the vault passes links and bare commit ids.
  assert.throws(() => noSecrets(long));
  assert.throws(() => noSecrets(`Fixed in ${sha40}.`));
  for (const text of [
    'key sk-proj-abcdef0123456789', 'password=hunter2', 'password: hunter2', 'ghp_abcdefghijklmnop', 'xoxb-1234-abcd', 'AKIAIOSFODNN7EXAMPLE',
    'a'.repeat(41), '0123456789abcdef'.repeat(4), 'QUJD'.repeat(20),
    `${long}?token=abc123`, `https://example.com/api?access_token=xyz`, 'https://alex:hunter2@example.com/repo.git',
    `See ${long} and then sk-abcdef0123456789`,
  ]) {
    assert.throws(() => applyWrite(root, write({ kind: 'event', text }), NOW), /credential/, text);
  }
});
