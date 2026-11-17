import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConversationController } from '../src/conversations/controller.js';
import { ConversationStore } from '../src/conversations/store.js';
import type { ChatEvent, ChatSession, RuntimeSink } from '../src/conversations/contracts.js';

const actor = { pc: 'alex.test', person: 'Alex' };
const delay = () => new Promise(resolve => setTimeout(resolve, 10));

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-history-'));
  const sinks = new Map<string, RuntimeSink>();
  const store = new ConversationStore(path.join(dir, 'chat.sqlite'));
  const controller = new ConversationController(store, { host: 'host.test', catalog: () => [{ id: 'repo', name: 'Repo', path: dir }],
    factory: (s: ChatSession, sink: RuntimeSink) => { sinks.set(s.id, sink); return { start: async () => `p-${s.id}`, send: async () => undefined, interrupt: async () => {}, close: async () => {} }; } });
  await controller.ready;
  const s = await controller.launch({ id: randomUUID(), provider: 'codex', projectId: 'repo', name: 'Cedar' }, actor);
  for (let i = 0; i < 300 && (await controller.get(s.id)).phase !== 'idle'; i++) await delay();
  /** Bulk history in one transaction, the way a long conversation accumulates it. */
  const append = async (events: Omit<ChatEvent, 'id' | 'sessionId' | 'ts'>[]) => {
    const current = (await store.get(s.id))!;
    const expected = current.revision; current.revision++;
    await store.commit(current, expected, events.map(e => ({ id: randomUUID(), sessionId: s.id, ts: Date.now(), ...e })));
  };
  return { s, store, controller, sinks, append, close: async () => { await controller.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('opening a 50k-event conversation reads one bounded page; earlier pages tile the history exactly', async () => {
  const f = await fixture();
  try {
    await f.append(Array.from({ length: 50_000 }, (_, i) => ({ kind: 'assistant_delta', text: `token ${i} ` })));
    const all = (await f.controller.page(f.s.id, 0)).length; // sanity: forward paging still works
    assert.equal(all, 200);
    const started = performance.now();
    const latest = await f.controller.history(f.s.id);
    const openMs = performance.now() - started;
    assert.ok(latest.events.length > 0 && latest.events.length <= 200);
    assert.ok(Buffer.byteLength(JSON.stringify(latest)) <= 256 * 1024 + 1024);
    assert.equal(latest.events.at(-1)!.text, 'token 49999 ');
    assert.equal(latest.hasMore, true);
    assert.ok(openMs < 1000, `opening took ${openMs.toFixed(1)} ms`);
    // Walk back to the start: ascending within pages, strictly older between pages, no gap, no repeat.
    const seen: number[] = []; let page = latest, pages = 1;
    for (;;) {
      const seqs = page.events.map(e => e.seq!);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
      if (seen.length) assert.equal(seqs.at(-1)! + 1, seen[0], 'pages are contiguous');
      seen.unshift(...seqs);
      assert.equal(page.before, seqs[0]);
      if (!page.hasMore) break;
      page = await f.controller.history(f.s.id, page.before); pages++;
    }
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(seen.length, 50_000 + 2, 'every event once, plus launched/ready');
    assert.ok(pages >= 250);
    assert.deepEqual(await f.controller.history(f.s.id, seen[0]), { events: [], before: seen[0], hasMore: false });
  } finally { await f.close(); }
});

test('live events after opening continue from the page cursor and never appear in earlier pages', async () => {
  const f = await fixture();
  try {
    await f.append(Array.from({ length: 500 }, (_, i) => ({ kind: 'tool', text: `old ${i}` })));
    const opened = await f.controller.history(f.s.id);
    const cursor = opened.events.at(-1)!.seq!;
    f.sinks.get(f.s.id)!.event('tool', 'arrived after opening');
    const live = await f.controller.page(f.s.id, cursor, 2000);
    assert.deepEqual(live.map(e => e.text), ['arrived after opening']);
    const earlier = await f.controller.history(f.s.id, opened.before);
    assert.ok(earlier.events.every(e => e.seq! < opened.before));
    assert.ok(!earlier.events.some(e => e.text === 'arrived after opening'));
    await assert.rejects(f.controller.history(f.s.id, 0), /Invalid history cursor/);
  } finally { await f.close(); }
});

test('oversized events are projected and a history page stays under its byte budget', async () => {
  const f = await fixture();
  try {
    await f.append(Array.from({ length: 12 }, (_, i) => ({ kind: 'tool_result', text: `${i}:` + 'x'.repeat(59_000) })));
    await f.append([{ kind: 'tool_result', text: 'huge', data: { output: 'y'.repeat(300_000) } }]);
    const latest = await f.controller.history(f.s.id);
    assert.ok(Buffer.byteLength(JSON.stringify(latest.events)) <= 256 * 1024);
    const huge = latest.events.at(-1)!;
    assert.equal((huge.data as { truncated: boolean }).truncated, true);
    assert.equal(((await f.controller.detail(f.s.id, (huge.data as { detailId: string }).detailId))!.data as { output: string }).output.length, 300_000);
    assert.equal(latest.hasMore, true);
    const rest = await f.controller.history(f.s.id, latest.before);
    assert.ok(rest.events.length > 0 && rest.events.at(-1)!.seq! < latest.before);
  } finally { await f.close(); }
});
