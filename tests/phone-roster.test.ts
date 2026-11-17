import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Board, LIVE_MS } from '../src/board.js';
import type { ChatSession } from '../src/conversations/contracts.js';
import { phoneRoster } from '../src/phone/roster.js';

test('phone includes current desktop sessions, joins managed IDs, and excludes recovery/history', () => {
  let now = Date.now();
  const board = new Board(null, () => now);
  const ivy = board.touch('ivy', 'C:/projects/kokuban', 'codex').session;
  ivy.name = 'Ivy'; ivy.doing = 'Fix the phone roster'; ivy.doingAt = now;
  const old = board.touch('old', 'C:/projects/old', 'claude').session;
  old.seen = now - LIVE_MS - 1;
  const gone = board.touch('gone', '', 'codex').session; gone.state = 'gone';
  const chat = (id: string, phase: ChatSession['phase']): ChatSession => ({ id, name: id, provider: 'claude', project: 'kokuban', cwd: '', host: 'local', phase, epoch: 1, revision: 1, controlRevision: 1, created: now, updated: now, messages: [], approvals: [] });
  const chief = chat('Chief', 'idle'); chief.role = 'chief';
  const recovery = chat('Recovery', 'recovery'), closed = chat('Closed', 'closed');
  for (const s of [chief, recovery, closed]) board.touch('provider-'+s.id, '', 'claude').session.managed = s.id;
  const roster = phoneRoster(board, [chief, recovery, closed, chat('Unbound archive', 'idle')]);
  assert.deepEqual(roster.map(s => s.name), ['Chief', 'Ivy']);
  assert.equal(roster[0].id, chief.id);
  assert.equal('external' in roster[1] && roster[1].external, true);
  assert.equal('doing' in roster[1] && roster[1].doing, 'Fix the phone roster');
  assert.equal(board.sessions.length, 6); // Filtering never deletes history or presence.
  now += LIVE_MS + 1;
  assert.deepEqual(phoneRoster(board, [chief]).map(s => s.name), ['Chief']);
});
