import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { handleHook } from '../src/hooks.js';
import { handleRpc } from '../src/mcp.js';

function setup() {
  let now = 1_000_000;
  const board = new Board(null, () => now);
  handleHook(board, 'claude', { hook_event_name: 'SessionStart', session_id: 'host-1', cwd: 'C:/x', source: 'startup' });
  const s = board.sessions.find((x) => x.id === 'host-1')!;
  return { board, s, tick: (ms: number) => { now += ms; } };
}

/** What Claude Code does for one kokuban tool call: PreToolUse hook, then the MCP request. */
async function call(board: Board, session: string | null, tool: string, args: Record<string, unknown>) {
  if (session) handleHook(board, 'claude', { hook_event_name: 'PreToolUse', session_id: session, tool_name: `mcp__kokuban__${tool}`, tool_input: args });
  const r = await handleRpc(board, 'claude', { id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) as any;
  return { text: r.result.content[0].text as string, isError: Boolean(r.result.isError) };
}

test('me="new" from a known host session keeps its name instead of issuing another', async () => {
  const { board, s } = setup();
  const before = board.sessions.length;
  const r = await call(board, 'host-1', 'peers', { me: 'new' });
  assert.equal(r.isError, false);
  assert.match(r.text, new RegExp(`You are "${s.name}"`));
  assert.equal(board.sessions.length, before, 'no new session was made');
});

test('an unknown or another session\'s name from a known host session resolves to its own name', async () => {
  const { board, s } = setup();
  const r = await call(board, 'host-1', 'peers', { me: 'Posy', doing: 'x' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, new RegExp(`No session is named "Posy". You are "${s.name}"`));
  handleHook(board, 'claude', { hook_event_name: 'SessionStart', session_id: 'host-2', cwd: 'C:/y', source: 'startup' });
  const other = board.sessions.find((x) => x.id === 'host-2')!;
  const r2 = await call(board, 'host-1', 'peers', { me: other.name });
  assert.match(r2.text, new RegExp(`"${other.name}" is another session. You are "${s.name}"`));
});

test('without a host hook, the old behaviour stays: unknown names fail, "new" issues a name', async () => {
  const { board } = setup();
  assert.equal((await call(board, null, 'peers', { me: 'Posy' })).isError, true);
  const before = board.sessions.length;
  await call(board, null, 'peers', { me: 'new' });
  assert.equal(board.sessions.length, before + 1);
});

test('a noted call is used once and expires', async () => {
  const { board, tick } = setup();
  handleHook(board, 'claude', { hook_event_name: 'PreToolUse', session_id: 'host-1', tool_name: 'mcp__kokuban__peers', tool_input: { me: 'Posy' } });
  tick(31_000);
  assert.equal((await call(board, null, 'peers', { me: 'Posy' })).isError, true);
});

test('SessionStart after compaction, resume or clear says the session\'s name again', () => {
  const { board, s } = setup();
  for (const source of ['compact', 'resume', 'clear']) {
    const out = handleHook(board, 'claude', { hook_event_name: 'SessionStart', session_id: 'host-1', cwd: 'C:/x', source }) as any;
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`You are "${s.name}" on the board`), source);
  }
});
