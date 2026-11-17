import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { titleFor } from '../src/codex-title.js';
import { findKimiTranscript, glance, lastAsked, latest, readSteps } from '../src/glance.js';
import { handleHook } from '../src/hooks.js';
import { wakeText } from '../src/wake.js';

function transcript(lines: object[]): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-')), 't.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('glancing at a Claude session shows its request and steps, not host noise or subagents', () => {
  const board = new Board();
  const file = transcript([
    { type: 'user', message: { content: 'an older request' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'old answer' }] } },
    { type: 'user', message: { content: 'make the capture   test pass' } },
    { type: 'user', message: { content: '<system-reminder>ignore me</system-reminder>' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Reading the test first.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'tests/capture.test.ts' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'file body' }] } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] } },
  ]);
  handleHook(board, 'claude', { hook_event_name: 'PostToolUse', session_id: 'a', transcript_path: file });
  const a = board.byName(board.sessions[0]!.name)!;

  const view = glance(board, a);
  assert.match(view, /Its human last asked: "make the capture test pass"/);
  assert.match(view, /- said: "Reading the test first\."\n- Read: tests\/capture\.test\.ts\n- Bash: Run the tests$/);
  assert.doesNotMatch(view, /older|old answer|ignore me|private|file body|subagent/);
  assert.equal(latest(a), 'Bash: Run the tests');
});

test('glancing at a Codex session reads its rollout format', () => {
  const board = new Board();
  const b = board.touch('b', '', 'codex').session;
  b.transcript = transcript([
    { type: 'session_meta', payload: { id: 'b' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }, { type: 'input_text', text: 'retake the Notion captures' }] } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'text(await tools.mcp__desk__browser({op:"scroll"}))' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"git status"}' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'big output' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[kokuban] Message from Thorn (codex): take over' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '39 retaken.' }] } },
  ]);
  const view = glance(board, b);
  assert.match(view, /last asked: "retake the Notion captures"/);
  assert.match(view, /- exec: mcp__desk__browser \{op:"scroll"\}\)\)\n- shell: git status\n- said: "39 retaken\."$/);
  assert.doesNotMatch(view, /rules|environment_context|big output/);
});

test('a session with no transcript is still described, and the asker is told to send', () => {
  const board = new Board();
  const c = board.touch('c', '', 'claude').session;
  assert.match(glance(board, c), new RegExp(`^${c.name} .*\nNo view into ${c.name}'s steps yet`));
  assert.equal(latest(c), '');
});

test('Kimi glance reads completed main-agent messages without replay, reasoning, injections or wake prompts', () => {
  const board = new Board(null);
  const s = board.touch('kimi-session_test', '', 'kimi').session;
  const event = (message: object, meta: object = {}) => ({ type: 'agent.message.appended', message: { message, meta } });
  s.transcript = transcript([
    { type: 'context.append_message', message: { role: 'user', content: 'replayed request' } },
    event({ role: 'user', content: [{ type: 'text', text: '<hook_result>instructions</hook_result>' },
      { type: 'text', text: 'fix the capture test' }] }, { origin: { kind: 'user' } }),
    { type: 'mcp.tools_discovered', tools: 'schema noise '.repeat(30000) },
    event({ role: 'user', content: [{ type: 'text', text: 'injected content' }] }, { origin: { kind: 'task' } }),
    event({ role: 'user', content: [{ type: 'text', text: 'hook plain text', meta: { source: 'hook' } }] }),
    { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'think', think: 'private thought' } } },
    event({ role: 'assistant', content: [{ type: 'think', think: 'private thought' }, { type: 'text', text: 'Checking the capture.' }],
      toolCalls: [{ name: 'Shell', arguments: '{"command":"npm test"}' }] }),
    event({ role: 'tool', content: 'large tool result' }),
    { ...event({ role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] }), agentId: 'agent-0' },
    event({ role: 'user', content: [{ type: 'text', text: '<kokuban-message>peer request</kokuban-message>' }] }, { origin: { kind: 'user' } }),
    event({ role: 'assistant', content: [{ type: 'text', text: 'Capture test passes.' }] }),
  ]);
  fs.appendFileSync(s.transcript, '{partial journal line');
  const view = glance(board, s);
  assert.match(view, /last asked: "fix the capture test"/);
  assert.match(view, /said: "Checking the capture\."\n- Shell: npm test\n- said: "Capture test passes\."$/);
  assert.doesNotMatch(view, /private|replayed|injected|hook plain|large tool|subagent|peer request/);
  assert.equal(lastAsked(s), 'fix the capture test');
  assert.equal(latest(s), 'Capture test passes.');
  assert.equal(readSteps(s.transcript, 'kimi').length, 4);
});

test('Kimi discovery matches exact session across workspaces and only its main journal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-kimi-glance-'));
  const make = (rel: string) => {
    const file = path.join(root, rel, 'wire.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); return file;
  };
  make('wd_a/session_abc-extra/agents/main');
  make('wd_a/session_abc/agents/agent-0');
  assert.equal(findKimiTranscript('kimi-session_abc', root), '');
  const main = make('wd_b/session_abc/agents/main');
  assert.equal(findKimiTranscript('kimi-session_abc', root), main);
  assert.equal(findKimiTranscript('kimi-abc', root), main, 'legacy bare session IDs');
  assert.equal(findKimiTranscript('kimi-../session_abc', root), '');
  assert.equal(findKimiTranscript('session_abc', root), '');
  assert.equal(findKimiTranscript('kimi-missing', root), '');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a Codex thread is titled with the session name, then its summary once it has one', () => {
  const board = new Board();
  const s = board.touch('t', '', 'codex').session;
  s.name = 'Tansy';
  assert.equal(titleFor(s, ''), 'Tansy');
  assert.equal(titleFor(s, 'Preview latest AcmeAgency locally'), 'Tansy · Preview latest AcmeAgency locally');
  assert.equal(titleFor(s, 'Tansy · Preview latest AcmeAgency locally'), 'Tansy · Preview latest AcmeAgency locally');
  s.doing = 'Bring the newest integrated ACME experience onto localhost for a full user walkthrough';
  const title = titleFor(s, 'Tansy · Preview latest AcmeAgency locally');
  assert.match(title, /^Tansy · Bring the newest integrated ACME/);
  assert.ok(title.length <= 'Tansy · '.length + 70 && title.endsWith('…'));
});

test('a woken session is shown what the sender\'s human asked, from the sender\'s transcript', () => {
  const board = new Board();
  const thorn = board.touch('thorn', '', 'claude').session;
  const delta = board.touch('delta', '', 'claude').session;
  thorn.transcript = transcript([
    { type: 'user', message: { content: 'can you send a handoff to delta to keep going until all the missing bundles are fixed pls?' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Sending it.' }] } },
  ]);
  board.send(thorn, delta.name, 'Alex asks you to take over the missing-bundle recovery.');
  const text = wakeText(board, board.take(delta));
  assert.match(text, new RegExp(`From ${thorn.name}'s transcript, their human last asked them: "can you send a handoff to delta`));
  assert.match(text, /if it hands you a task, do the task/);

  board.send(delta, thorn.name, 'started');
  assert.doesNotMatch(wakeText(board, board.take(thorn)), /their human last asked/);
});
