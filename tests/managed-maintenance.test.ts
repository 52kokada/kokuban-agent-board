import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MaintenanceBarrier } from '../src/conversations/maintenance.js';

test('an already accepted launch waiting for admission prevents maintenance', async () => {
  const gate = new MaintenanceBarrier();
  let resume!: () => void;
  let launched = false;
  const launch = gate.run(async () => { await new Promise<void>(r => { resume = r; }); launched = true; });
  assert.throws(() => gate.hold(), /in flight/);
  assert.equal(launched, false);
  resume(); await launch;
  const release = gate.hold();
  await assert.rejects(gate.run(async () => { throw Error('must not run'); }), /preparing an update/);
  release();
  assert.equal(await gate.run(async () => 'resumed'), 'resumed');
});

test('failed requests release their admission slot', async () => {
  const gate = new MaintenanceBarrier();
  await assert.rejects(gate.run(async () => { throw Error('provider failed'); }), /provider failed/);
  const release = gate.hold(); release();
});
