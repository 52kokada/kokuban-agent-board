import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeUsage } from '../scripts/token-audit.mjs';

test('usage audit separates measured sizes, legacy coverage, transport, and outcomes without text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-token-audit-'));
  try {
    const file = path.join(dir, 'usage.jsonl');
    const now = 10 * 86400000;
    const rows = [
      { ts: 0, tool: 'send', outputChars: 9999 },
      { ts: now + 1, tool: 'send' },
      { ts: now, tool: 'send', ok: true, delivery: 'next-step', outputChars: 30, text: 'PRIVATE' },
      { ts: now, tool: 'send', ok: true },
      { ts: now, tool: 'wake', ok: true, mail: [1, 2] },
      { ts: now, tool: 'wake', ok: true, messages: 3, reasons: ['batch', 'task'] },
      { ts: now, tool: 'wake', ok: false },
      { ts: now, tool: 'peer:state', ok: true },
      { ts: now, tool: 'task:state', state: 'done' },
      { ts: now, tool: '__proto__' },
    ];
    fs.writeFileSync(file, rows.map(x => JSON.stringify(x)).join('\n') + '\nmalformed\n');
    const r = await summarizeUsage(file, { days: 1, now });
    assert.equal(r.records, 8);
    assert.equal(r.malformed, 1);
    assert.equal(r.measuredOutputs, 1);
    assert.equal(r.outputChars, 30);
    assert.equal(r.wakes.successful, 2);
    assert.equal(r.wakes.failed, 1);
    assert.equal(r.wakes.messages, 5);
    assert.equal(r.delivery['next-step'], 1);
    assert.equal(r.delivery['legacy/unknown'], 1);
    assert.equal(r.taskOutcomes.done, 1);
    assert.equal(r.byTool['peer:state'].calls, 1);
    assert.equal(r.byTool.__proto__.calls, 1);
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
    await assert.rejects(summarizeUsage(file, { days: 0 }), /positive/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('context audit counts operation and offer metadata without treating it as model token usage', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-context-audit-')), 'usage.jsonl');
  const now = Date.now();
  const rows = [
    { tool: 'context', op: 'search', outputChars: 100, q: 'PRIVATE' },
    { tool: 'context', op: '__proto__', q: 'PRIVATE' },
    { tool: 'mail:offer', messages: 10, replayed: 2, oversized: false },
    { tool: 'inbox:offer', messages: 1, replayed: 1, acknowledged: 10, oversized: true },
  ];
  fs.writeFileSync(file, rows.map(r => JSON.stringify({ ts: now, ...r })).join('\n'));
  const result = await summarizeUsage(file, { now });
  assert.deepEqual(result.contextOps, { search: 1 });
  assert.deepEqual(result.mailOffers, { batches: 2, messages: 11, replayed: 3, explicitAcknowledgements: 10, oversized: 1 });
  assert.equal(result.outputChars, 100, 'offer counters do not double count model-facing outputs');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
