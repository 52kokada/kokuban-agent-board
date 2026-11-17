import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickName } from '../src/names.js';

test('large session history gets distinct unnumbered names before reuse', () => {
  const history: string[] = [];
  for (let i = 0; i < 440; i++) {
    const name = pickName(new Set(), () => 0, history);
    assert.match(name, /^[A-Za-z]+$/);
    assert.ok(!history.some(previous => previous.toLowerCase() === name.toLowerCase()));
    history.push(name);
  }
});

test('active names stay reserved even when every pool name is recent', () => {
  const taken = new Set<string>();
  for (;;) {
    const name = pickName(taken, () => 0);
    if (/\d/.test(name)) break;
    taken.add(name);
    assert.ok(taken.size < 1000);
  }
  assert.ok(taken.size >= 440);
  assert.ok([...taken].every(name => /^[A-Za-z]+$/.test(name)));
  const overflow = pickName(new Set([...taken].map(name => name.toLowerCase())), () => 0, taken);
  assert.equal(overflow, 'Acorn2');
  assert.equal(pickName(new Set(['ACORN']), () => 0, taken), 'Agate');
});
