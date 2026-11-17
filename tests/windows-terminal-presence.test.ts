import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session } from '../src/board.js';
import { loadedIds, reconcile } from '../src/windows-terminal-presence.js';
// @ts-expect-error plain module shared with the native roster, no types
import { matchRoster } from '../../tools/TerminalPresence/match.mjs';

const s = (id: string, host: string, extra: Partial<Session> = {}): Session => ({ id, name: id, host, ...extra } as Session);
const scan = (extra: object = {}) => ({ capturedAt: '2026-11-10T16:00:00.000Z', interactive: true, windows: [{}], ...extra });
const seen = (...ids: string[]) => ({ agents: ids.map((id) => ({ id })), unconfirmed: [] as unknown[] });

test('reconcile: a seen terminal with a live runtime is present, an unseen or managed one is not', () => {
  const sessions = [s('a', 'claude'), s('b', 'claude'), s('c', 'codex'), s('d', 'codex'), s('m', 'claude', { managed: 'x' })];
  const out = reconcile(sessions, scan(), seen('a', 'c', 'd', 'm'), new Set(['c']), () => true);
  assert.equal(out.terminalScan.error, undefined);
  assert.equal(out.proofs.get('a')?.present, true);
  assert.equal(out.proofs.get('b')?.present, false);          // no terminal seen
  assert.equal(out.proofs.get('c')?.present, true);           // codex: loaded in the runtime
  assert.equal(out.proofs.get('d')?.present, false);          // codex: tab seen, thread not loaded
  assert.equal(out.proofs.get('m')?.present, false);          // managed sessions are never terminal-proven
});

test('reconcile: an unreliable scan proves nothing', () => {
  const sessions = [s('a', 'claude')];
  for (const [bad, matches] of [
    [scan({ interactive: false }), seen('a')],
    [scan({ capturedAt: 'not a date' }), seen('a')],
    [scan({ windows: [{ scanError: 'denied' }] }), seen('a')],
    [scan(), { agents: [{ id: 'a' }], unconfirmed: [{} as unknown] }],
  ] as Array<[ReturnType<typeof scan>, ReturnType<typeof seen>]>) {
    const out = reconcile(sessions, bad, matches, new Set(), () => true);
    assert.ok(out.terminalScan.error);
    assert.equal(out.proofs.size, 0);
  }
});

test('reconcile: an unreadable runtime is an error for that session, not absence', () => {
  const out = reconcile([s('c', 'codex'), s('a', 'claude')], scan(), seen('c', 'a'), null, () => null);
  assert.ok(out.terminalScan.error);
  assert.equal(out.proofs.has('c'), false);
  assert.equal(out.proofs.has('a'), false);
});

test('loadedIds: follows pages; a bad page or a cursor cycle is unknown, not empty', async () => {
  const pages: Record<string, { data: unknown[]; nextCursor?: string | null }> = {
    '': { data: ['t1', 't2'], nextCursor: 'p2' }, p2: { data: ['t3'], nextCursor: null },
  };
  const rpc = (async (_m: string, p: { cursor?: string }) => pages[p.cursor ?? '']) as never;
  assert.deepEqual([...(await loadedIds(rpc))!], ['t1', 't2', 't3']);
  assert.equal(await loadedIds((async () => null) as never), null);
  assert.equal(await loadedIds((async () => ({ data: [1] })) as never), null);
  assert.equal(await loadedIds((async () => ({ data: ['x'], nextCursor: 'same' })) as never), null);
});

test('matchRoster: a badge tab matches one board name; unknown and duplicate names stay unconfirmed', () => {
  const windows = [{ hwnd: 1, app: 'WindowsTerminal', elements: [
    { role: 'TabItem', name: '🔵 Lake' }, { role: 'TabItem', name: '🟠 Ghost' }, { role: 'TabItem', name: '🧡 Twin' }, { role: 'TabItem', name: 'plain shell' },
  ] }];
  const board = [{ id: '1', name: 'Lake' }, { id: '2', name: 'Twin' }, { id: '3', name: 'Twin' }];
  const out = matchRoster(windows, board);
  assert.deepEqual(out.agents.map((a: { id: string }) => a.id), ['1']);
  assert.deepEqual(out.unconfirmed.map((u: { reason: string }) => u.reason).sort(), ['ambiguous-board-name', 'name-not-on-live-board']);
});
