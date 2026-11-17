import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { answerCard, SETTINGS } from '../src/cards.js';
import { askPair, pairState, pairStatus, statusLines, sweepPairs, unpair, version, type PairDeps } from '../src/pair.js';
import { handlePeer } from '../src/peer.js';
import { ownCard } from '../src/daemon.js';

const A = 'pc-a.tail1234.ts.net';
const B = 'pc-b.tail1234.ts.net';

interface Pc { name: string; board: Board; file: string; up: boolean }

/** Run with one PC's settings.json in place, as its own board would read it. */
async function as<T>(pc: Pc, fn: () => Promise<T> | T): Promise<T> {
  const before = SETTINGS.file;
  SETTINGS.file = pc.file;
  try {
    return await fn();
  } finally {
    SETTINGS.file = before;
  }
}

/** Two boards on one tailnet: a request reaches the other board's /peer under the caller's name. */
function tailnet(settings: Record<string, object> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-pair-'));
  const pcs: Record<string, Pc> = {};
  for (const [name, person] of [[A, 'Alex'], [B, 'Sam']] as const) {
    const file = path.join(dir, `${name.split('.')[0]}.json`);
    fs.writeFileSync(file, JSON.stringify({ person, ...(settings[name] ?? {}) }));
    pcs[name] = { name, board: new Board(), file, up: true };
  }
  const fetchFrom = (caller: string): typeof fetch => (async (url: string | URL, init?: RequestInit) => {
    const target = pcs[new URL(String(url)).hostname];
    if (!target?.up) throw new TypeError('fetch failed');
    const headers = { 'tailscale-user-login': 'alex@example.com', 'x-forwarded-for': '100.64.0.1' };
    const out = await as(target, () => handlePeer(target.board, headers, JSON.parse(String(init?.body)),
      { lookup: async () => ({ login: 'alex@example.com', node: caller }) }));
    return new Response(JSON.stringify(out.body), { status: out.status });
  }) as typeof fetch;
  const deps = (pc: Pc): PairDeps => ({
    fetch: fetchFrom(pc.name), resolve: async (n) => (n.includes('.') ? n : `${n}.tail1234.ts.net`),
    serve: async () => '', self: async () => pc.name, sendKokuban: async () => false,
  });
  for (const pc of Object.values(pcs)) pc.board.onOwnCard = (card, choice) => as(pc, () => ownCard(pc.board, card, choice, deps(pc)) ?? '');
  const read = (pc: Pc) => JSON.parse(fs.readFileSync(pc.file, 'utf8'));
  return { a: pcs[A]!, b: pcs[B]!, deps, read };
}

test('one command on one PC and one click on the other connect both ways', async () => {
  const { a, b, deps, read } = tailnet();
  const asked = await as(a, () => askPair(a.board, 'pc-b', 'work', deps(a))) as { id: string; state: string };
  assert.equal(asked.state, 'asking');
  assert.equal(read(a).trust, undefined, 'nothing is trusted before the other side says yes');

  const card = b.board.cards.at(-1)!;
  assert.match(card.question, /Alex's PC \(pc-a\) wants to connect/);
  assert.match(card.question, /Alexさん/, 'no language set: both languages');
  assert.deepEqual(card.choices, ['Allow / 許可する', 'Refuse / 拒否する']);
  assert.equal(card.from.pc, A);

  const outcome = await as(b, () => answerCard(b.board, card, '0', ''));
  assert.match(outcome, /Connected with pc-a \(work\)/);
  assert.deepEqual(read(b).trust, { [A]: 'work' });
  assert.deepEqual(read(b).people, { Alex: ['pc-a'] });
  assert.equal(read(b).person, 'Sam', 'the rest of settings.json is kept');
  assert.deepEqual(read(a).trust, { [B]: 'work' });
  assert.deepEqual(read(a).people, { Sam: ['pc-b'] });
  assert.equal(pairState(a.board, asked.id)?.state, 'paired');
  assert.ok(a.board.feed.some((e) => e.op === 'pair' && /allowed: connected at work/.test(e.text)));
  assert.ok(b.board.feed.some((e) => e.op === 'pair' && /allowed at work/.test(e.text)));
  assert.equal(b.board.messages.length, 0, 'the pick is acted on, not mailed to a session');

  // Once paired, the ordinary operations work in both directions.
  const peers = await deps(a).fetch!(`http://${B}:47600/peer`, { method: 'POST', body: JSON.stringify({ op: 'peers' }) });
  assert.equal(peers.status, 200);
});

test('a refusal leaves both sides as they were, and the asker may not ask again for an hour', async () => {
  const { a, b, deps, read } = tailnet({ [B]: { lang: 'ja' } });
  const asked = await as(a, () => askPair(a.board, 'pc-b', 'share', deps(a))) as { id: string };
  const card = b.board.cards.at(-1)!;
  assert.equal(card.lang, 'ja');
  assert.deepEqual(card.choices, ['許可する', '拒否する']);
  assert.match(await as(b, () => answerCard(b.board, card, '1', '')), /拒否しました/);
  assert.equal(pairState(a.board, asked.id)?.state, 'refused');
  assert.equal(read(a).trust, undefined);
  assert.deepEqual(read(b).trust ?? {}, {});
  await assert.rejects(as(a, () => askPair(a.board, 'pc-b', 'share', deps(a))), /refused a pairing from you within the hour/);
});

test('changing the answer to Refuse after Allow disconnects both sides', async () => {
  const { a, b, deps, read } = tailnet();
  await as(a, () => askPair(a.board, 'pc-b', 'work', deps(a)));
  const card = b.board.cards.at(-1)!;
  await as(b, () => answerCard(b.board, card, '0', ''));
  await as(b, () => answerCard(b.board, card, '1', ''));
  assert.deepEqual(read(a).trust, {});
  assert.deepEqual(read(b).trust, {});
});

test('typed words without a pick decide nothing', async () => {
  const { a, b, deps, read } = tailnet();
  await as(a, () => askPair(a.board, 'pc-b', 'work', deps(a)));
  assert.match(await as(b, () => answerCard(b.board, b.board.cards.at(-1)!, '', 'who is this?')), /Pick Allow or Refuse/);
  assert.equal(read(b).trust, undefined);
});

test('an answer only counts with the id of a pairing this board started with that PC', async () => {
  const { a, b, deps } = tailnet();
  const ask = (pc: Pc, body: object) => deps(pc).fetch!(`http://${pc === a ? B : A}:47600/peer`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await ask(b, { op: 'paired', id: 'f'.repeat(32), allow: true })).status, 403);
  assert.equal((await ask(a, { op: 'pair', id: 'short', level: 'work' })).status, 400);
  assert.equal((await ask(a, { op: 'pair', id: 'a'.repeat(32), level: 'root' })).status, 400);
  // Unpaired, nothing else gets through.
  assert.equal((await ask(a, { op: 'peers' })).status, 403);
  assert.match(await (await ask(a, { op: 'hello' })).text(), /To ask this PC's person to connect, run: kokuban pair/);
});

test('asking again replaces the earlier card instead of stacking them', async () => {
  const { a, b, deps } = tailnet();
  await as(a, () => askPair(a.board, 'pc-b', 'work', deps(a)));
  await as(a, () => askPair(a.board, 'pc-b', 'talk', deps(a)));
  assert.deepEqual(b.board.cards.map((c) => c.closed ?? 'open'), ['withdrawn', 'open']);
  assert.deepEqual(a.board.pairs.map((p) => p.state), ['expired', 'asking']);
});

test('an asker that went away hears the answer when it is back', async () => {
  const { a, b, deps, read } = tailnet();
  const asked = await as(a, () => askPair(a.board, 'pc-b', 'work', deps(a))) as { id: string };
  a.up = false;
  assert.match(await as(b, () => answerCard(b.board, b.board.cards.at(-1)!, '0', '')), /completes as soon as pc-a can be reached/);
  assert.equal(b.board.pairs[0]!.state, 'allowed');
  a.up = true;
  await as(b, () => sweepPairs(b.board, deps(b)));
  assert.equal(b.board.pairs[0]!.state, 'paired');
  assert.equal(pairState(a.board, asked.id)?.state, 'paired');
  assert.deepEqual(read(a).trust, { [B]: 'work' });
});

test('a PC without kokuban yet gets the prompt for its agent', async () => {
  const { a, b, deps } = tailnet();
  b.up = false;
  await assert.rejects(as(a, () => askPair(a.board, 'pc-b', 'work', deps(a))),
    /pc-b did not answer[\s\S]*Install kokuban on this PC[\s\S]*pair pc-a/);
  await assert.rejects(as(a, () => askPair(a.board, A, 'work', deps(a))), /that is this PC/);
  await assert.rejects(as(a, () => askPair(a.board, 'pc-b', 'root' as never, deps(a))), /level must be/);
  await assert.rejects(as(a, () => askPair(a.board, 'pc-b', 'work', { ...deps(a), serve: async () => 'tailscale serve failed: denied' })), /must expose \/peer/);
});

test('kokuban pair lists each PC: answers, how fast, its kokuban, whether it trusts back', async () => {
  const { a, b, deps } = tailnet({ [A]: { trust: { [B]: 'work', 'keeper-pc.tail1234.ts.net': 'work' } } });
  await as(b, () => fs.writeFileSync(b.file, JSON.stringify({ person: 'Sam', trust: { [A]: 'work' } })));
  const status = await as(a, () => pairStatus(a.board, deps(a)));
  const lines = statusLines(status);
  assert.match(lines[0]!, /^pc-b: work, answers in \d+ ms, same kokuban, Sam's$/);
  assert.match(lines[1]!, /^keeper-pc: work, keeper-pc did not answer/);
  assert.equal(status.version, version());

  await as(b, () => fs.writeFileSync(b.file, JSON.stringify({ person: 'Sam' })));
  assert.match(statusLines(await as(a, () => pairStatus(a.board, deps(a))))[0]!, /^pc-b: work, refuses this PC: .*not in this PC's trust list/);
});

test('unpair drops the connection on both sides', async () => {
  const { a, b, deps, read } = tailnet();
  await as(a, () => askPair(a.board, 'pc-b', 'work', deps(a)));
  await as(b, () => answerCard(b.board, b.board.cards.at(-1)!, '0', ''));
  const out = await as(a, () => unpair('pc-b', deps(a))) as { here: string; there: string };
  assert.match(out.here, /removed/);
  assert.match(out.there, /dropped this PC too/);
  assert.deepEqual(read(a).trust, {});
  assert.deepEqual(read(b).trust, {});
  assert.deepEqual(read(b).people, { Alex: ['pc-a'] }, 'still Alex\'s PC, just not connected');
});

test('an Allow for a request the asker gave up on connects nothing', async () => {
  const { a, b, deps, read } = tailnet();
  await as(a, () => askPair(a.board, 'pc-b', 'work', deps(a)));
  a.board.pairs[0]!.state = 'expired';
  assert.match(await as(b, () => answerCard(b.board, b.board.cards.at(-1)!, '0', '')), /no longer waits for this answer/);
  assert.deepEqual(read(b).trust, {});
  assert.equal(read(a).trust, undefined);
});

test('Refuse, then a change of mind to Allow, connects both sides', async () => {
  const { a, b, deps, read } = tailnet();
  const asked = await as(a, () => askPair(a.board, 'pc-b', 'work', deps(a))) as { id: string };
  const card = b.board.cards.at(-1)!;
  await as(b, () => answerCard(b.board, card, '1', ''));
  assert.match(await as(b, () => answerCard(b.board, card, '0', '')), /Connected with pc-a/);
  assert.equal(pairState(a.board, asked.id)?.state, 'paired');
  assert.deepEqual(read(a).trust, { [B]: 'work' });
});
