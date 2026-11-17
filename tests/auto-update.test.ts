import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoUpdatePass, type AutoUpdateOperations } from '../src/auto-update.js';

function fixture() {
  const calls: string[] = [];
  const operations: AutoUpdateOperations = {
    discover: async () => { calls.push('discover'); return { head: 'b'.repeat(40), published: true }; },
    stage: async () => { calls.push('stage'); },
    publish: async () => { calls.push('publish'); },
    preflight: async () => { calls.push('preflight'); },
    idle: async () => { calls.push('idle'); },
    apply: async () => { calls.push('apply'); },
  };
  return { operations, calls };
}

test('a hub validates and publishes without ever applying to its keeper', async () => {
  const { operations, calls } = fixture();
  const result = await autoUpdatePass({ role: 'hub', enabled: true }, operations);
  assert.equal(result.state, 'published');
  assert.deepEqual(calls, ['discover', 'stage', 'publish']);
});

test('an opted-in client checks state again after staging and waits for idle before applying', async () => {
  const { operations, calls } = fixture();
  const result = await autoUpdatePass({ role: 'client', enabled: true }, operations);
  assert.equal(result.state, 'restarting');
  assert.deepEqual(calls, ['discover', 'preflight', 'stage', 'preflight', 'idle', 'apply']);
});

test('disabled configuration never contacts another PC', async () => {
  const { operations, calls } = fixture();
  assert.equal((await autoUpdatePass({ role: 'client', enabled: false }, operations)).state, 'disabled');
  assert.deepEqual(calls, []);
});

test('an unpublished upstream commit is not built or distributed', async () => {
  const { operations, calls } = fixture();
  operations.discover = async () => ({ head: 'b'.repeat(40), published: false });
  assert.equal((await autoUpdatePass({ role: 'hub', enabled: true }, operations)).state, 'held');
  assert.deepEqual(calls, []);
});

test('dirty tree, dependency changes, failed builds and unreadable/busy conversations never apply', async () => {
  for (const phase of ['preflight', 'stage', 'idle'] as const) {
    const { operations, calls } = fixture();
    operations[phase] = async () => { throw new Error(`held at ${phase}`); };
    const result = await autoUpdatePass({ role: 'client', enabled: true }, operations);
    assert.equal(result.state, 'held');
    assert.match(result.detail, /held at/);
    assert.ok(!calls.includes('apply'));
  }
});

test('an already current release is not rebuilt or restarted', async () => {
  const { operations, calls } = fixture();
  operations.discover = async () => null;
  assert.equal((await autoUpdatePass({ role: 'client', enabled: true }, operations)).state, 'current');
  assert.deepEqual(calls, []);
});
