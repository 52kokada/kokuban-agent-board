import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Board, FORGET_MS } from '../src/board.js';
import { SessionLaunch } from '../src/session-launch.js';

const id = '01a18676-615a-7f11-a692-0e7830720b32';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-manual-launch-'));
  let now = 1000;
  const board = new Board(path.join(root, 'board.json'), () => now);
  board.keepEnded = () => true;
  const s = board.touch(id, root, 'codex').session;
  s.transcript = path.join(root, id + '.jsonl'); fs.writeFileSync(s.transcript, '{}'); board.end(id);
  const enabled = { vscode: true, terminal: true };
  const launch = new SessionLaunch(board, { config: () => enabled, now: () => now });
  return { root, board, s, launch, enabled, later: () => { now += FORGET_MS + 1; }, clean: () => { board.flush(); fs.rmSync(root, { recursive: true, force: true }); } };
}
test('external CLI launch is off unless this target is explicitly enabled', () => {
  const f = fixture(); try {
    const off = new SessionLaunch(f.board, { config: () => ({}) });
    assert.throws(() => off.prepare({ id, target: 'vscode' }), /有効/);
    f.enabled.vscode = false;
    assert.throws(() => f.launch.prepare({ id, target: 'vscode' }), /有効/);
    assert.ok(f.launch.prepare({ id, target: 'terminal' }).grant);
  } finally { f.clean(); }
});
test('an explicit stopped session gets one durable, expiring exact-target grant', () => {
  const f = fixture(); try {
    const request = f.launch.prepare({ id, target: 'vscode' });
    assert.throws(() => f.launch.prepare({ id, target: 'terminal' }), /起動/);
    const plan = f.launch.consume(request.grant);
    assert.equal(plan.id, id); assert.equal(plan.target, 'vscode');
    assert.match(Buffer.from(plan.encodedCommand, 'base64').toString('utf16le'), /& codex 'resume'/);
    assert.throws(() => f.launch.consume(request.grant));
    const loaded = new Board(path.join(f.root, 'board.json'), f.board.clock);
    loaded.keepEnded = () => true;
    const next = new SessionLaunch(loaded, { config: () => f.enabled });
    assert.equal(next.catalog().sessions[0]!.pending, true);
    next.reset(id); loaded.flush();
  } finally { f.clean(); }
});
test('claim rechecks liveness, configuration and session identity', () => {
  const f = fixture(); try {
    let request = f.launch.prepare({ id, target: 'vscode' });
    f.enabled.vscode = false; assert.throws(() => f.launch.consume(request.grant), /有効/);
    f.enabled.vscode = true; request = f.launch.prepare({ id, target: 'vscode' });
    f.board.touch(id, f.root, 'codex'); assert.throws(() => f.launch.consume(request.grant), /動作中/);
    f.board.end(id); request = f.launch.prepare({ id, target: 'vscode' });
    f.s.host = 'claude'; assert.throws(() => f.launch.consume(request.grant), /変わ/);
  } finally { f.clean(); }
});
test('expiry and archival never authorize stale or managed sessions', () => {
  const f = fixture(); try {
    const request = f.launch.prepare({ id, target: 'terminal' }); f.later();
    assert.throws(() => f.launch.consume(request.grant), /期限/);
    f.s.managed = id; assert.equal(f.launch.catalog().sessions[0]!.canResume, false);
    delete f.s.managed; delete f.s.launchEndedAt;
    f.board.sessionArchive.push({ ...f.s, state: 'gone' }); f.board.sessions = [];
    assert.equal(f.board.sessionArchive[0]!.state, 'gone');
    assert.equal(f.launch.catalog().sessions.find(s => s.id === id)!.canResume, false);
  } finally { f.clean(); }
});
test('confirmed ended history survives pruning, while a real hook clears pending launch', () => {
  const f = fixture(); try {
    f.later(); f.board.touch('other', f.root, 'claude'); f.board.flush();
    const loaded = new Board(path.join(f.root, 'board.json'), f.board.clock);
    loaded.keepEnded = () => true;
    const launch = new SessionLaunch(loaded, { config: () => f.enabled });
    assert.equal(launch.catalog().sessions.find(s => s.id === id)!.canResume, true);
    launch.prepare({ id, target: 'terminal' });
    const resumed = loaded.touch(id, f.root, 'codex').session;
    assert.equal(resumed.launchPending, undefined); assert.equal(resumed.launchEndedAt, undefined);
    assert.equal(resumed.transcript, f.s.transcript);
    loaded.flush();
  } finally { f.clean(); }
});
test('launcher-only archive is bounded without deleting checkpoint history', () => {
  const f = fixture(); try {
    f.board.sessionArchive = Array.from({ length: 510 }, (_, i) => ({ ...f.s, id: `past-${i}`, seen: i }));
    const preserved = f.board.sessionArchive[0]!;
    preserved.checkpointHistory = [{ revision: 1, at: 1, author: { id: preserved.id, name: 'Past', host: 'codex' }, data: { objective: 'Keep evidence', next: 'Review' } }];
    f.later(); f.board.touch('other', f.root, 'claude');
    assert.equal(f.board.sessionArchive.length, 501);
    assert.ok(f.board.sessionArchive.some(s => s.id === preserved.id));
  } finally { f.clean(); }
});
test('new requests quote Unicode paths and never accept arbitrary commands', () => {
  const f = fixture(); try {
    const cwd = path.join(f.root, "日本語 ' ; $() folder"); fs.mkdirSync(cwd);
    const request = f.launch.prepare({ host: 'claude', cwd, target: 'terminal' });
    const script = Buffer.from(f.launch.consume(request.grant).encodedCommand, 'base64').toString('utf16le');
    assert.ok(script.includes(cwd.replaceAll("'", "''"))); assert.ok(script.endsWith('& claude'));
    assert.throws(() => f.launch.prepare({ host: 'evil;whoami', cwd, target: 'terminal' }));
    assert.throws(() => f.launch.prepare({ host: 'codex', cwd: '.', target: 'terminal' }));
  } finally { f.clean(); }
});
test('without an enabled launcher target, ended sessions leave the board exactly as before', () => {
  const f = fixture(); try {
    f.board.keepEnded = () => false;
    f.later(); f.board.touch('other', f.root, 'claude');
    assert.equal(f.board.sessionArchive.some(s => s.id === id), false);
    assert.equal(f.board.sessions.some(s => s.id === id), false);
  } finally { f.clean(); }
});
