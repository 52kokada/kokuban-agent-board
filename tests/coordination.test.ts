import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { handleHook } from '../src/hooks.js';
import { handleBridge } from '../src/bridge.js';
import { waitClaude } from '../src/wake.js';

test('an ordinary turn ends without a stop check; an unrecorded outcome remains visibly stalled', () => {
  const b = new Board();
  const s = b.touch('task', '', 'codex').session;
  b.setDoing(s, 'Implement the requested fix');
  const hook = (event: string) => handleHook(b, 'codex', { session_id: s.id, hook_event_name: event });
  hook('UserPromptSubmit');
  assert.equal(hook('Stop'), null);
  assert.match(b.status(s), /stalled: active work/);
  hook('UserPromptSubmit');
  b.setWork(s, 'done');
  assert.equal(hook('Stop'), null);
  assert.match(b.status(s), /^done/);
});

test('a blocker needs a resumption step and remains visible locally and remotely', async () => {
  const b = new Board();
  const s = b.touch('blocked', '', 'claude').session;
  assert.throws(() => b.setWork(s, 'blocked'), /who can resume/);
  b.setWork(s, 'blocked', 'Awaiting worker result from the laptop; requester owns follow-up');
  s.state = 'idle';
  assert.match(b.describe(s), /blocked.*Awaiting worker result/);
  const out = await handleBridge(b, { op: 'peers' }) as { sessions: Array<{ work: string; next: string }> };
  assert.equal(out.sessions[0]!.work, 'blocked');
  assert.match(out.sessions[0]!.next, /requester owns follow-up/);
  assert.equal(handleHook(b, 'claude', { session_id: s.id, hook_event_name: 'Stop' }), null);
});

test('remote receipt explains a continuation limit without claiming delivery', async () => {
  const b = new Board();
  const s = b.touch('limited', '', 'codex').session;
  s.state = 'idle';
  s.continues = 30;
  const from = { pc: 'laptop', agent: 'Sender' };
  const sent = await handleBridge(b, { op: 'send', from, to: s.name, text: 'Please finish the task' }) as { id: number };
  const receipt = await handleBridge(b, { op: 'receipt', from, id: sent.id }) as { state: string; reach: string };
  assert.equal(receipt.state, 'queued');
  assert.equal(receipt.reach, 'continuation_limit');
});

test('an existing Claude waiter reattaches when the board has lost its waiter registry', async () => {
  const b = new Board();
  const s = b.touch('restart-reattach', '', 'claude').session;
  s.state = 'idle';
  const sender = b.touch('sender', '', 'codex').session;
  b.send(sender, s.name, 'Resume the requested work');
  const out = await waitClaude(b, { session_id: s.id, waiter: 'existing-hook', first: false }, () => false, 20);
  assert.equal(out.status, 200);
  assert.match(out.text!, /Resume the requested work/);
  assert.equal(b.messages[0]!.delivered, false);
  handleHook(b, 'claude', { session_id: s.id, hook_event_name: 'PostToolUse' });
  assert.equal(b.messages[0]!.delivered, true);
});
