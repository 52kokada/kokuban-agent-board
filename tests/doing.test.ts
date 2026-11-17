import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board, BRIEF_MS } from '../src/board.js';
import { currentTitle, derivedDoing } from '../src/doing.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-doing-'));
const line = (v: unknown): string => `${JSON.stringify(v)}\n`;

test('Claude title/todos are incremental, ignore partial lines and clear completed tasks', () => {
  const s = new Board().touch('claude-doing', '', 'claude').session;
  s.transcript = path.join(dir, 'claude.jsonl');
  const todo = (todos: unknown[]) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos } }] } });
  fs.writeFileSync(s.transcript, line({ type: 'ai-title', aiTitle: 'Auth refresh' }) + line(todo([{ status: 'in_progress', activeForm: 'Running tests' }])));
  assert.equal(derivedDoing(s, dir), 'Auth refresh · Running tests');
  const next = line({ type: 'ai-title', aiTitle: 'Ready to ship' });
  fs.appendFileSync(s.transcript, next.slice(0, -1));
  assert.equal(derivedDoing(s, dir), 'Auth refresh · Running tests');
  fs.appendFileSync(s.transcript, '\n' + line(todo([])));
  assert.equal(derivedDoing(s, dir), 'Ready to ship');
  fs.writeFileSync(s.transcript, line({ type: 'ai-title', aiTitle: 'New' }));
  assert.equal(derivedDoing(s, dir), 'New', 'truncation resets cached state');
});

test('Codex reads appended thread names and JSON-string update_plan arguments', () => {
  const s = new Board().touch('codex-doing', '', 'codex').session;
  s.transcript = path.join(dir, 'codex.jsonl');
  const index = path.join(dir, 'index.jsonl');
  const plan = (steps: unknown[]) => ({ type: 'response_item', payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan: steps }) } });
  fs.writeFileSync(index, line({ id: s.id, thread_name: `${s.name} · Repair wake` }));
  fs.writeFileSync(s.transcript, line(plan([{ step: 'Verify receipt', status: 'in_progress' }])));
  assert.equal(derivedDoing(s, dir, index), 'Repair wake · Verify receipt');
  fs.appendFileSync(index, line({ id: s.id, thread_name: 'Wake verified' }));
  fs.appendFileSync(s.transcript, line(plan([{ step: 'Verify receipt', status: 'completed' }])));
  assert.equal(currentTitle(s.id, index), 'Wake verified');
  assert.equal(derivedDoing(s, dir, index), 'Wake verified');
});

test('persistent Claude tasks override transcript todos, and completing them clears the active text', () => {
  const s = new Board().touch('task-doing', '', 'claude').session;
  const taskDir = path.join(dir, 'tasks', s.id);
  fs.mkdirSync(taskDir, { recursive: true });
  const file = path.join(taskDir, '1.json');
  fs.writeFileSync(file, JSON.stringify({ id: '1', activeForm: 'Verifying socket', status: 'in_progress' }));
  assert.equal(derivedDoing(s, dir), 'Verifying socket');
  fs.writeFileSync(file, JSON.stringify({ id: '1', activeForm: 'Verifying socket', status: 'completed' }));
  assert.equal(derivedDoing(s, dir), '');
});

test('the first read is bounded to the last 2MB and an explicit summary wins for two hours', () => {
  let now = 1_000_000;
  const board = new Board(null, () => now);
  const s = board.touch('bounded', '', 'claude').session;
  s.transcript = path.join(dir, 'bounded.jsonl');
  fs.writeFileSync(s.transcript, line({ type: 'ai-title', aiTitle: 'Outside window' }) + 'x'.repeat(2 * 1024 * 1024) + '\n' + line({ type: 'ai-title', aiTitle: 'Current task' }));
  assert.equal(board.summary(s), 'Current task');
  board.setDoing(s, 'Explicit override');
  assert.equal(board.summary(s), 'Explicit override');
  now += BRIEF_MS + 1;
  assert.equal(board.summary(s), 'Current task');
});

test('Kimi native title and public task calls are reused without reading reasoning or subagents', () => {
  const s = new Board().touch('kimi-doing', '', 'kimi').session;
  const root = path.join(dir, 'kimi-session');
  fs.mkdirSync(path.join(root, 'agents/main'), { recursive: true });
  s.transcript = path.join(root, 'agents/main/wire.jsonl');
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ title: 'Repair receipts' }));
  const record = (agentId: string, text: string) => ({ type: 'agent.message.appended', agentId, message: { message: {
    role: 'assistant', toolCalls: [{ name: 'TodoWrite', arguments: JSON.stringify({ todos: [{ status: 'in_progress', content: text }] }) }],
  } } });
  fs.writeFileSync(s.transcript, line(record('main', 'Verify replay recovery')) + line(record('child', 'Do not use this task')));
  assert.equal(derivedDoing(s), 'Repair receipts · Verify replay recovery');
});
