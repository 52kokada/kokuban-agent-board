import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConversationService } from '../src/conversations/service.js';
import { ClaudeRuntime } from '../src/conversations/providers/claude.js';
import { Board } from '../src/board.js';
import { SETTINGS } from '../src/cards.js';
import type { ChatSession, RuntimeSink } from '../src/conversations/contracts.js';

const delay = () => new Promise(resolve => setTimeout(resolve, 10));

async function relay(fake: typeof fetch): Promise<{ status: number; message: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-relay-'));
  const settings = SETTINGS.file, original = globalThis.fetch;
  const service = new ConversationService(new Board(path.join(dir, 'board.json')), true, path.join(dir, 'c.sqlite'), { trust: () => 'work', catalog: () => [] });
  try {
    SETTINGS.file = path.join(dir, 'settings.json');
    fs.writeFileSync(SETTINGS.file, JSON.stringify({ trust: { 'host.example.ts.net': 'work' } }));
    await service.ready;
    globalThis.fetch = fake;
    const command = { id: randomUUID(), op: 'message' as const, sessionId: randomUUID(), epoch: 1, text: 'hello' };
    try { await service.local({ op: 'command', pc: 'host.example.ts.net', command }); }
    catch (e) { return { status: Number((e as { status?: number }).status) || 400, message: (e as Error).message }; }
    throw new Error('The relay unexpectedly succeeded');
  } finally {
    globalThis.fetch = original; SETTINGS.file = settings;
    await service.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a relay that may have reached the host never answers with a definitive status', async () => {
  const lost = await relay(async () => { throw new TypeError('fetch failed'); });
  assert.equal(lost.status, 502); assert.match(lost.message, /may still have been applied/);
  const garbled = await relay(async () => new Response('<html>gateway</html>', { status: 200 }));
  assert.equal(garbled.status, 502);
});

test('a host refusal keeps its status and the host\'s own words', async () => {
  const refused = await relay(async () => new Response(JSON.stringify({ ok: false, error: 'Restart the session before sending a message' }), { status: 409 }));
  assert.deepEqual(refused, { status: 409, message: 'Restart the session before sending a message' });
});

test('an interrupt that lands after a Claude result does not mark the next turn interrupted', async () => {
  const outcomes: string[] = [];
  const sink: RuntimeSink = { event() {}, turn() {}, complete: status => { outcomes.push(status); }, approval: async () => false, exit() {} };
  const runtime = new ClaudeRuntime({ id: randomUUID() } as ChatSession, sink) as unknown as { query: unknown; finished: Promise<void>; read(): Promise<void>; send(body: string): Promise<string>; interrupt(): Promise<void>; close(): Promise<void> };
  const queue: unknown[] = []; let wake: (() => void) | undefined; let done = false;
  runtime.query = {
    interrupt: async () => ({ cancelled: [] }), close: () => { done = true; wake?.(); },
    async *[Symbol.asyncIterator]() { while (!done) { if (queue.length) yield queue.shift(); else await new Promise<void>(r => { wake = r; }); } },
  };
  runtime.finished = runtime.read();
  const emit = (m: unknown) => { queue.push(m); wake?.(); };
  await runtime.send('first'); emit({ type: 'result', is_error: false }); await delay();
  await runtime.interrupt(); // No active turn, so the CLI emits no result for it.
  await runtime.send('after resume'); emit({ type: 'result', is_error: false }); await delay();
  await runtime.close();
  assert.deepEqual(outcomes, ['complete', 'complete']);
});

test('Stop while a Codex app-server is booting for Resume ends as interrupted, not as a connection failure', async () => {
  const { EventEmitter } = await import('node:events');
  const { CodexRuntime } = await import('../src/conversations/providers/codex.js');
  const outcomes: string[] = [], exits: string[] = [];
  const sink: RuntimeSink = { event() {}, turn() {}, complete: status => { outcomes.push(status); }, approval: async () => false, exit: detail => { exits.push(detail); } };
  const runtime = new CodexRuntime({ id: randomUUID() } as ChatSession, sink) as unknown as { thread: string; child: unknown; boot(): Promise<void>; send(body: string): Promise<string | undefined>; interrupt(): Promise<void> };
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() {},
    stdin: { writable: true, write() {}, end() { setImmediate(() => child.emit('exit')); } } });
  runtime.thread = 'thread-1';
  runtime.boot = async function (this: { child: unknown }) {
    this.child = child;
    await new Promise((_, reject) => child.once('exit', () => reject(new Error('Codex process ended'))));
  };
  const sending = runtime.send('held message');
  await delay();
  await runtime.interrupt();
  assert.equal(await sending, undefined);
  assert.deepEqual(outcomes, ['interrupted']); assert.deepEqual(exits, []);
});

test('Stop with no Codex process still settles the turn', async () => {
  const { CodexRuntime } = await import('../src/conversations/providers/codex.js');
  const outcomes: string[] = [];
  const sink: RuntimeSink = { event() {}, turn() {}, complete: status => { outcomes.push(status); }, approval: async () => false, exit() {} };
  await new CodexRuntime({ id: randomUUID() } as ChatSession, sink).interrupt();
  assert.deepEqual(outcomes, ['interrupted']);
});

test('a Claude approval names what it is for, not only the tool', async () => {
  const { describeTool } = await import('../src/conversations/providers/claude.js');
  assert.equal(describeTool('PowerShell', { command: 'Start-Sleep -Seconds 61', description: 'wait' }), 'PowerShell: Start-Sleep -Seconds 61');
  assert.equal(describeTool('Write', { file_path: 'C:\repo\a.txt', content: 'x' }), 'Write: C:\repo\a.txt');
  assert.match(describeTool('mcp__x__y', { a: 1 }), /^mcp__x__y: \{"a":1\}$/);
  assert.ok(describeTool('Bash', { command: 'x'.repeat(5000) }).length < 2100);
});
