import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { makeCard } from '../src/cards.js';
import { createServer } from '../src/daemon.js';
import { APP_KEY } from '../src/app-routes.js';

test('old supervisor snapshots retain ordinary cards and history but retire unanswered supervisor cards', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-native-'));
  const file = path.join(folder, 'board.json');
  const b = new Board(null);
  const s = b.touch('a', '', 'claude').session;
  const retired = makeCard(b, { agent: 'kokuban' }, { question: 'Resume old supervisor job?' });
  const ordinary = makeCard(b, { agent: s.name }, { question: 'Keep this question?' });
  fs.writeFileSync(file, JSON.stringify({ sessions: [{ ...s, job: 'old', jobTries: 2, flagged: 1 }], cards: b.cards,
    jobs: { old: { cardId: retired.id } }, stalledCards: [], messages: [] }));
  const restored = new Board(file);
  assert.equal(restored.cards.find(c => c.id === retired.id)!.closed, 'withdrawn');
  assert.equal(restored.cards.find(c => c.id === ordinary.id)!.closed, undefined);
  restored.flush();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal('jobs' in saved, false);
  assert.equal('job' in saved.sessions[0], false);
  assert.equal(saved.cards.length, 2);
});

test('native API survives without browser pages and the retained compatibility bridge enforces trust', async () => {
  const board = new Board(null);
  const server = createServer(board, { trust: () => 'talk', ingress: () => 'e'.repeat(64), self: () => ['thispc'] });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(base + '/app/key')).status, 200);
    assert.equal((await fetch(base + '/app/feed.json?t=' + APP_KEY)).status, 200);
    for (const route of ['/app?t=' + APP_KEY, '/cards', '/card/1']) assert.ok((await fetch(base + route)).status >= 400);
    const glance = (headers: Record<string, string> = {}) => fetch(base + '/bridge', { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ op: 'glance', source: 'remote', me: 'Iris', who: 'Nobody' }) });
    // A local program's word is not another PC's identity (D97)...
    assert.equal((await glance()).status, 403);
    // ...a relay's proof is, and then that PC's trust level decides.
    assert.match((await (await glance({ 'x-kokuban-relay': 'e'.repeat(64) })).json()).error, /needs "share" trust/);
  } finally { server.close(); }
});
