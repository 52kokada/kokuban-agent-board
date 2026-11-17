import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Board } from '../src/board.js';
import { ConversationService } from '../src/conversations/service.js';

test('maintenance sees an admission-waiting request and blocks both local and chief launches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-maintenance-'));
  const board = new Board();
  let reached!: () => void;
  const admission = new Promise<void>(resolve => { reached = resolve; });
  board.hasRoom = () => { reached(); return false; };
  let starts = 0;
  const service = new ConversationService(board, true, path.join(root, 'qa.sqlite'), {
    catalog: () => [{ id: 'sandbox', name: 'Sandbox', path: root }],
    factory: s => ({ start: async () => { starts++; return s.id; }, send: async () => undefined, interrupt: async () => {}, close: async () => {} }),
  });
  try {
    const launch = { id: randomUUID(), projectId: 'sandbox', provider: 'codex' as const, name: 'Held' };
    const pending = service.local({ op: 'launch', launch });
    await admission;
    assert.throws(() => service.beginMaintenance(), /in flight/);
    await assert.rejects(pending, (e: any) => e.status === 429);
    const release = service.beginMaintenance();
    await assert.rejects(service.local({ op: 'launch', launch }), /preparing an update/);
    await assert.rejects(service.chiefLaunch(launch), /preparing an update/);
    assert.equal(starts, 0);
    release();
  } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('an idle host refreshes unknown CPU admission, while a busy host stays refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-admission-'));
  const board = new Board();
  let samples = 0, busy = false;
  board.hasRoom = () => { samples++; return !busy && samples > 1; };
  const service = new ConversationService(board, true, path.join(root, 'qa.sqlite'), {
    catalog: () => [{ id: 'sandbox', name: 'Sandbox', path: root }],
    factory: s => ({ start: async () => s.id, send: async () => undefined, interrupt: async () => {}, close: async () => {} }),
  });
  try {
    const started = performance.now();
    const result = await service.local({ op: 'launch', launch: { id: randomUUID(), projectId: 'sandbox', provider: 'codex', name: 'FreshSample' } }) as { session: { id: string } };
    assert.ok(result.session.id);
    assert.ok(performance.now() - started >= 250, 'must take an actual fresh sample interval');
    busy = true;
    await assert.rejects(service.local({ op: 'launch', launch: { id: randomUUID(), projectId: 'sandbox', provider: 'codex', name: 'BusySample' } }), (e: any) => e.status === 429);
  } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
