import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { managedIdleNow, restoreAutoUpdate, runStage } from '../src/auto-update-runtime.js';
import { ChatError } from '../src/conversations/contracts.js';
import { validReadiness } from '../src/auto-update-watchdog.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }).trim();
test('validation log failure rejects the update without an uncaught daemon exception', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-stage-log-'));
  await assert.rejects(runStage(dir, process.execPath, ['-e', 'process.stdout.write("validated")']), /ENOENT/);
});
function transaction() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-rollback-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n.kokuban/\n');
  fs.writeFileSync(path.join(dir, 'source.txt'), 'old');
  git(dir, 'add', '.'); git(dir, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'old');
  const before = git(dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'source.txt'), 'new');
  git(dir, 'add', '.'); git(dir, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'new');
  const after = git(dir, 'rev-parse', 'HEAD');
  const backup = path.join(dir, '.kokuban', 'backup');
  fs.mkdirSync(path.join(backup, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(backup, 'dist', 'runtime.js'), 'old runtime');
  fs.mkdirSync(path.join(dir, 'dist')); fs.writeFileSync(path.join(dir, 'dist', 'runtime.js'), 'broken runtime');
  return { dir, backup, before, after };
}
test('rollback restores actual Git source and runtime together', async () => {
  const t = transaction();
  await restoreAutoUpdate(t.dir, t.before, t.after, t.backup);
  assert.equal(git(t.dir, 'rev-parse', 'HEAD'), t.before);
  assert.equal(fs.readFileSync(path.join(t.dir, 'source.txt'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(t.dir, 'dist/runtime.js'), 'utf8'), 'old runtime');
});
test('rollback preserves intervening user edits and refuses to reset them', async () => {
  const t = transaction();
  fs.writeFileSync(path.join(t.dir, 'source.txt'), 'human edit');
  await assert.rejects(restoreAutoUpdate(t.dir, t.before, t.after, t.backup), /checkout changed/);
  assert.equal(fs.readFileSync(path.join(t.dir, 'source.txt'), 'utf8'), 'human edit');
  assert.equal(git(t.dir, 'rev-parse', 'HEAD'), t.after);
});
test('readiness requires the exact new commit, a new PID, and session 1', () => {
  const expected = 'b'.repeat(40), good = { head: expected, pid: 42, sessionId: 1 };
  assert.equal(validReadiness(good, expected, 41), true);
  for (const bad of [{ ...good, head: 'a'.repeat(40) }, { ...good, pid: 41 }, { ...good, sessionId: 0 }, {}, null])
    assert.equal(validReadiness(bad, expected, 41), false);
});
test('the in-daemon idle check treats disabled shared sessions as idle and fails closed otherwise', async () => {
  const fails = (error: Error) => ({ local: async () => { throw error; } });
  await managedIdleNow(fails(new ChatError('Shared agent sessions are disabled. Enable KOKUBAN_CONVERSATIONS=1 on the host.', 503)));
  await assert.rejects(managedIdleNow(fails(new ChatError('Conversation storage could not be opened.', 503))), /storage/);
  await assert.rejects(managedIdleNow(undefined), /cannot be read/);
  await assert.rejects(managedIdleNow({ local: async () => ({}) }), /invalid state/);
  const busy = { local: async () => ({ sessions: [{ name: 'a', phase: 'working', messages: [] }] }) };
  await assert.rejects(managedIdleNow(busy as never), /remain busy/);
  const queued = { local: async () => ({ sessions: [{ name: 'a', phase: 'idle', messages: [{ state: 'queued' }] }] }) };
  await assert.rejects(managedIdleNow(queued as never), /remain busy/);
  await managedIdleNow({ local: async () => ({ sessions: [{ name: 'a', phase: 'idle', messages: [] }] }) } as never);
});
