import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { handleBridge } from '../src/bridge.js';
import { IDEM_MS, MAX_RECEIPTS, SETTINGS, answerCard, closeCard, makeCardOnce } from '../src/cards.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-once-'));
SETTINGS.file = path.join(tmp, 'settings.json');
fs.writeFileSync(SETTINGS.file, JSON.stringify({ person: 'Alex' }));

const T0 = 2_000_000_000_000;
const mako = { pc: 'pc-a.tail1234.ts.net', agent: 'Mako' };
const card = (over: Record<string, unknown> = {}) => ({
  question: 'Merge step 1 of the shared workspace?', details: 'Akira passed the review.', choices: ['Merge', 'Wait'],
  group: 'ws-1:d-7:v-2', misaligned: true, person: 'Alex', idempotency_key: 'ws-1:d-7:v-2:Alex', issued_at: T0, ...over,
});
let req = 0;
// Each call is a new request as far as the old in-memory dedup goes: only the idempotency key links them.
const ask = (board: Board, fields: Record<string, unknown>, from = mako) =>
  Promise.resolve(handleBridge(board, { op: 'ask', from, request_id: `r${++req}`, text: JSON.stringify(fields) })) as Promise<Record<string, unknown>>;
function boardAt(file: string, at = T0): Board {
  const b = new Board(file, () => at);
  return b;
}

test('a lost answer, a restart and a retry give back the same card, answered, withdrawn or expired', async () => {
  for (const end of ['answered', 'withdrawn', 'expired'] as const) {
    const file = path.join(fs.mkdtempSync(path.join(tmp, 'b-')), 'board.json');
    const first = boardAt(file);
    const made = await ask(first, card());
    assert.equal(made.ok, true);
    assert.deepEqual(made.idempotency, { supported: 1, key: 'ws-1:d-7:v-2:Alex', duplicate: false });
    const c = first.cards.find((x) => x.id === made.id)!;
    if (end === 'answered') await answerCard(first, c, '0', '');
    else closeCard(first, c, end);
    first.flush();
    // The board restarts; the asker never saw the first reply and asks again.
    const again = await ask(boardAt(file, T0 + 3_600_000), card());
    assert.equal(again.id, made.id, `${end}: same card`);
    assert.equal(again.state, end);
    assert.deepEqual(again.idempotency, { supported: 1, key: 'ws-1:d-7:v-2:Alex', duplicate: true });
    if (end === 'answered') assert.equal(again.choice, 'Merge', 'the answer given before the retry is what the retry reads');
  }
});

test('nothing is made twice: no second card or receipt', async () => {
  const board = boardAt(path.join(fs.mkdtempSync(path.join(tmp, 'b-')), 'board.json'));
  await ask(board, card());
  await ask(board, card());
  await ask(board, card({ request_id: 'other' }));
  assert.equal(board.cards.length, 1);
});

test('the same key with different words is refused; another sender has its own keys', async () => {
  const board = boardAt(path.join(fs.mkdtempSync(path.join(tmp, 'b-')), 'board.json'));
  const made = await ask(board, card());
  for (const changed of [{ question: 'Merge step 2?' }, { choices: ['Merge', 'Hold'] }, { details: 'x' }, { group: 'ws-1:d-8' },
    { misaligned: false }, { person: 'Sam' }]) {
    const out = await ask(board, card(changed));
    assert.equal(out.ok, false, JSON.stringify(changed));
    assert.match(String(out.error), /already used for a card with different words/);
  }
  const other = await ask(board, card(), { pc: mako.pc, agent: 'Akira' });
  assert.notEqual(other.id, made.id, 'Akira\'s key is not Mako\'s');
  assert.deepEqual((other.idempotency as { duplicate: boolean }).duplicate, false);
  const elsewhere = await ask(board, card(), { pc: 'pc-b.tail1234.ts.net', agent: 'Mako' });
  assert.notEqual(elsewhere.id, made.id, 'a Mako on another PC is another sender');
});

test('a key issued longer ago than the board remembers is refused, not made again; bad keys and times too', () => {
  const board = new Board(null, () => T0);
  assert.throws(() => makeCardOnce(board, mako, card({ issued_at: T0 - IDEM_MS })), /older than this board remembers/);
  assert.throws(() => makeCardOnce(board, mako, card({ issued_at: T0 + 2 * 86_400_000 })), /in the future/);
  assert.throws(() => makeCardOnce(board, mako, card({ issued_at: undefined })), /issued_at .* is required/);
  for (const bad of ['', 'has space', 'x'.repeat(129), 42]) {
    assert.throws(() => makeCardOnce(board, mako, card({ idempotency_key: bad })), /idempotency_key is 1 to 128/);
  }
  assert.equal(board.cards.length, 0);
});

test('a keyed card outlives the 100-card limit while its receipt does; a full store refuses', () => {
  let now = T0;
  const board = new Board(null, () => now);
  const { card: kept } = makeCardOnce(board, mako, card());
  for (let i = 0; i < 150; i++) {
    const c = makeCardOnce(board, { pc: `p${i}.tail1234.ts.net`, agent: 'X' }, { question: `plain ${i}` }).card;
    closeCard(board, c, 'withdrawn');
  }
  assert.equal(board.cards.some((c) => c.id === kept.id), true, 'still here for a retry');
  assert.equal(makeCardOnce(board, mako, card()).card.id, kept.id);
  now += IDEM_MS;
  makeCardOnce(board, { pc: 'q.tail1234.ts.net', agent: 'X' }, { question: 'after the window' });
  assert.equal(board.cards.some((c) => c.id === kept.id), false, 'once its receipt is gone, it ages out like any card');

  const full = new Board(null, () => T0);
  full.askReceipts = Array.from({ length: MAX_RECEIPTS }, (_, i) => ({ sender: 's', key: `k${i}`, hash: 'h', card: -1, at: T0 }));
  assert.throws(() => makeCardOnce(full, mako, card()), /keyed asks are being remembered here/);
});

test('if the board cannot save, nothing was made and nothing is claimed', async () => {
  const board = boardAt(path.join(tmp, 'no-such-dir', '\0bad', 'board.json'));
  const out = await ask(board, card());
  assert.equal(out.ok, false);
  assert.match(String(out.error), /could not save it/);
  assert.equal(board.cards.length, 0);
  assert.equal(board.askReceipts.length, 0);
});

test('an ask without a key is as before: no receipt and no idempotency echo', async () => {
  const board = boardAt(path.join(fs.mkdtempSync(path.join(tmp, 'b-')), 'board.json'));
  const a = await ask(board, { question: 'Plain?' });
  const b = await ask(board, { question: 'Plain?' });
  assert.notEqual(a.id, b.id);
  assert.equal('idempotency' in a, false);
  assert.equal(board.askReceipts.length, 0);
});

test('the same /peer envelope or request_id with changed words is refused, not answered from memory', async () => {
  const { handlePeer } = await import('../src/peer.js');
  const board = boardAt(path.join(fs.mkdtempSync(path.join(tmp, 'b-')), 'board.json'));
  const headers = { 'tailscale-user-login': 'k@example.com', 'x-forwarded-for': '100.64.0.11' };
  const deps = { lookup: async () => ({ login: 'k@example.com', node: mako.pc }), trust: () => 'share' as const };
  const send = (fields: Record<string, unknown>) =>
    handlePeer(board, headers, { op: 'ask', me: 'Mako', envelope: 'env-1', request_id: 'same', text: JSON.stringify(fields) }, deps);
  const first = await send(card());
  assert.equal((first.body as { ok: boolean }).ok, true);
  const repeat = await send(card());
  assert.equal((repeat.body as { id: number }).id, (first.body as { id: number }).id, 'the same words: the same card');
  assert.equal((repeat.body as { idempotency: { duplicate: boolean } }).idempotency.duplicate, true);
  const changed = await send(card({ question: 'Merge step 2?' }));
  assert.equal((changed.body as { ok: boolean }).ok, false, 'a repeated envelope cannot carry new words past the receipt');
  assert.match(String((changed.body as { error: string }).error), /different words/);
  assert.equal(board.cards.length, 1);
});

test('a board that could not read its saved state refuses keyed asks, and still takes plain ones', async () => {
  const file = path.join(fs.mkdtempSync(path.join(tmp, 'b-')), 'board.json');
  fs.writeFileSync(file, '{not json');
  const board = boardAt(file);
  assert.match(String(board.loadProblem), /could not be read/);
  const keyed = await ask(board, card());
  assert.equal(keyed.ok, false);
  assert.match(String(keyed.error), /saved state is damaged/);
  assert.equal((await ask(board, { question: 'Plain still works?' })).ok, true);
  assert.equal(new Board(path.join(tmp, 'never-written.json')).loadProblem, null, 'a first run is not damage');
});

test('damage is remembered across later saves and restarts until a person clears it', async () => {
  const file = path.join(fs.mkdtempSync(path.join(tmp, 'b-')), 'board.json');
  fs.writeFileSync(file, '{not json');
  const first = boardAt(file);
  assert.equal(fs.existsSync(first.damaged!.copy), true, 'the damaged file is kept');
  first.touch('s-1', '', 'claude');
  assert.equal((await ask(first, { question: 'Plain ask, then a save' })).ok, true);
  first.flush();
  const second = boardAt(file);
  assert.match(String(second.loadProblem), /damaged on/, 'a clean-looking file still knows it lost receipts');
  assert.equal((await ask(second, card())).ok, false);
  assert.match(second.forgetLostAsks(), /^repaired/);
  const third = boardAt(file);
  assert.equal(third.loadProblem, null);
  assert.equal((await ask(third, card())).ok, true, 'keyed asks are taken again once a person said so');
  assert.match(new Board(null).forgetLostAsks(), /nothing to repair/);
});
