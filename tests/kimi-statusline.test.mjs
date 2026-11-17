import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStatus, identityFile } from '../scripts/kimi-statusline.mjs';

test('the footer includes the assigned name and existing workspace details', () => {
  assert.equal(formatStatus({ model: 'K3', cwd: 'C:/repo', gitBranch: 'main' }, 'Oak'),
    'Oak · Kimi  K3  C:/repo  [main]');
});
test('identity lookup is scoped to session IDs, not the current directory', () => {
  assert.notEqual(identityFile('first'), identityFile('second'));
});
test('footer text cannot inject terminal control sequences', () => {
  assert.ok(!formatStatus({ model: 'K3', cwd: '\x1b]2;bad\x07' }, 'Oak\n').includes('\x1b'));
});
