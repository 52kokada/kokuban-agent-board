import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { acquireInstance, instanceAlive } from '../src/instance.js';

test('normal restart hands the instance lock to exactly one successor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-update-lock-'));
  const first = await acquireInstance({ dir });
  assert.ok(first);
  assert.equal(await instanceAlive(dir), true);
  assert.equal(await acquireInstance({ dir }), null);
  first.release();
  const successor = await acquireInstance({ dir, waitMs: 2000 });
  assert.ok(successor);
  assert.equal(await acquireInstance({ dir }), null);
  successor.release();
});
