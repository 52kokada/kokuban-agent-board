import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { askTool } from '../src/ask.js';
import { Board } from '../src/board.js';
import { SETTINGS, answerCard, cardStatus, closeCard, makeCard } from '../src/cards.js';
import { feedView, localItems, self } from '../src/feed.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-group-'));
SETTINGS.file = path.join(tmp, 'settings.json');
fs.writeFileSync(SETTINGS.file, JSON.stringify({ person: 'Alex', people: { Sam: ['pc-b'] } }));

const from = { agent: 'Mako', sessionId: 'nobody' };

test('a card can name the decision it belongs to and say the people asked disagree', () => {
  const board = new Board();
  const card = makeCard(board, from, { question: 'Keep the old booking page?', choices: ['Keep', 'Replace'], group: 'ws-7:decision-3', misaligned: true });
  assert.equal(card.group, 'ws-7:decision-3');
  assert.equal(card.misaligned, true);
  const plain = makeCard(board, from, { question: 'Ship it?' });
  assert.equal('group' in plain, false, 'a card without them has neither, as before');
  assert.equal('misaligned' in plain, false);
  assert.equal(makeCard(board, from, { question: 'q', misaligned: false }).misaligned, undefined, 'false is the same as not saying it');
  assert.throws(() => makeCard(board, from, { question: 'q', group: 'has spaces' }), /group is 1 to 64/);
  assert.throws(() => makeCard(board, from, { question: 'q', group: 'x'.repeat(65) }), /group is 1 to 64/);
  assert.throws(() => makeCard(board, from, { question: 'q', misaligned: 'yes' }), /misaligned is true or false/);
  for (const bad of ['', '   ', 42, ['d-1'], { id: 'd-1' }]) {
    assert.throws(() => makeCard(board, from, { question: 'q', group: bad }), /group is 1 to 64/, `group ${JSON.stringify(bad)} is refused, not dropped`);
  }
  assert.equal(makeCard(board, from, { question: 'q', group: null }).group, undefined, 'null is the same as not giving one');
});

test('each person\'s card in one decision is answered, read and closed on its own', async () => {
  const board = new Board();
  const alex = makeCard(board, from, { question: 'Which booking page?', choices: ['Old', 'New'], group: 'd-1', misaligned: true });
  const sam = makeCard(board, from, { question: 'Which booking page?', choices: ['Old', 'New'], group: 'd-1', misaligned: true });
  await answerCard(board, alex, '0', '');
  assert.deepEqual(cardStatus(alex), { ok: true, id: alex.id, state: 'answered', group: 'd-1', misaligned: true, choice: 'Old', said: [{ choice: 'Old', text: '' }] });
  assert.deepEqual(cardStatus(sam), { ok: true, id: sam.id, state: 'waiting', group: 'd-1', misaligned: true },
    'one answer is not the other person\'s: their card still waits');
  closeCard(board, sam, 'withdrawn');
  assert.equal((cardStatus(sam) as { state: string }).state, 'withdrawn');
  assert.equal((cardStatus(alex) as { state: string }).state, 'answered', 'withdrawing one leaves the other as it was');
});

test('the feed carries the decision and the disagreement on each person\'s item, one item per card', () => {
  const board = new Board();
  const a = makeCard(board, from, { question: 'Old or new page?', group: 'd-2', misaligned: true });
  const b = makeCard(board, from, { question: 'Ship today?' });
  const items = localItems(board);
  const ia = items.find((i) => i.thread === `card:${self()}:${a.id}`)!;
  const ib = items.find((i) => i.thread === `card:${self()}:${b.id}`)!;
  assert.equal(ia.group, 'd-2');
  assert.equal(ia.misaligned, true);
  assert.equal('group' in ib, false, 'an ordinary card adds nothing to its item');
  assert.equal('misaligned' in ib, false);
  assert.equal(feedView(board).mine.find((i) => i.thread === ia.thread)!.misaligned, true, 'and the view the pill and the window read has it');
});

test('asking someone on another PC sends the decision and the disagreement along with the card', async () => {
  const board = new Board();
  const { session } = board.touch('s-1', '', 'claude');
  const sent: Array<Record<string, unknown>> = [];
  board.remote = async (request) => { sent.push(request); return JSON.stringify({ ok: true, id: 9, state: 'waiting' }); };
  const reply = JSON.parse(await askTool(board, session, {
    me: session.name, pc: 'pc-b.tail1234.ts.net', explicit: true, question: 'Old or new page?', choices: ['Old', 'New'],
    group: 'd-3', misaligned: true,
  })) as { id: number };
  assert.equal(reply.id, 9);
  const card = JSON.parse(String(sent[0]!.text)) as { group: string; misaligned: boolean; person: string };
  assert.equal(card.group, 'd-3');
  assert.equal(card.misaligned, true);
  assert.equal(card.person, 'Alex');
  // The other board makes it with makeCard from exactly this JSON (bridge.ts ask): the same checks apply there.
  const there = makeCard(new Board(), { pc: 'pc-a', agent: session.name }, card);
  assert.equal(there.group, 'd-3');
  assert.equal(there.misaligned, true);
});
