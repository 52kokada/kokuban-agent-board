import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Board, FORGET_MS, REDELIVER_MS, type Host } from '../src/board.js';
import { handleHook } from '../src/hooks.js';
import { wakeMail, markWoken } from '../src/wake.js';
import { taskTool } from '../src/tasks.js';
import { contextTool } from '../src/context.js';

for (const host of ['claude', 'codex', 'kimi'] as Host[]) {
  test(`${host}: natural hooks offer bounded batches and never confirm hidden mail`, () => {
    const board = new Board(null, () => 1_000_000);
    const s = board.touch(host, '', host).session; s.rules = 12;
    for (let i = 0; i < 25; i++) board.taskMail(s.id, `Item ${i}`);
    const out = JSON.stringify(handleHook(board, host, { session_id: s.id, hook_event_name: 'UserPromptSubmit', prompt: 'Continue.' }));
    assert.equal((out.match(/<kokuban-message /g) ?? []).length, 10);
    assert.equal(board.messages.filter(m => m.shownTo === s.id).length, 10);
    handleHook(board, host, { session_id: s.id, hook_event_name: 'UserPromptSubmit', prompt: 'Continue.' });
    assert.equal(board.messages.filter(m => m.delivered).length, 10);
    assert.equal(board.messages[24]!.shownAt, undefined);
  });

  test(`${host}: wake selection and confirmation use the exact bounded batch`, () => {
    const board = new Board(null, () => 1_000_000);
    const s = board.touch(host, '', host).session; s.state = 'idle';
    for (let i = 0; i < 25; i++) board.taskMail(s.id, `Wake item ${i}`);
    const mail = wakeMail(board, s);
    assert.equal(mail.length, 10);
    markWoken(board, s, mail);
    assert.equal(board.messages.filter(m => m.delivered).length, 10);
    assert.equal(board.messages[10]!.shownAt, undefined);
  });
}

test('known session resumes do not reinject onboarding; custom Claude titles survive', () => {
  const board = new Board(null);
  const start = { session_id: 's', hook_event_name: 'SessionStart', source: 'startup' };
  assert.match(JSON.stringify(handleHook(board, 'claude', start)), /record peers\(work=/);
  // A resume repeats only the session's name (one line), never the onboarding, and keeps a custom title.
  const name = board.sessions[0]!.name;
  const custom = JSON.stringify(handleHook(board, 'claude', { ...start, source: 'resume', session_title: 'My title' }));
  assert.match(custom, new RegExp(`You are \\\\"${name}\\\\" on the board`));
  assert.doesNotMatch(custom, /sessionTitle|record peers\(work=/);
  const title = handleHook(board, 'claude', { ...start, source: 'resume', session_title: name });
  assert.ok(title);
  assert.doesNotMatch(JSON.stringify(title), /record peers\(work=/);
});

test('task progress is superseded without losing history; unresolved blockers are not aged out', async () => {
  let now = 1_000_000;
  const board = new Board(null, () => now);
  const requester = board.touch('requester', '', 'codex').session;
  const owner = board.touch('owner', '', 'kimi').session;
  const task = JSON.parse(await taskTool(board, requester, { op: 'create', to: owner.name, text: 'Inspect and return evidence.' }));
  await taskTool(board, owner, { op: 'accept', id: task.id });
  await taskTool(board, owner, { op: 'progress', id: task.id, text: 'Older progress' });
  await taskTool(board, owner, { op: 'progress', id: task.id, text: 'Latest progress' });
  const old = board.messages.find(m => m.text.includes('Older progress'))!;
  assert.ok(old.supersededBy);
  assert.equal(old.delivered, false);
  assert.equal(board.ready(old, requester), false);
  await taskTool(board, owner, { op: 'block', id: task.id, text: 'Need the human to choose the schema.' });
  now += 30 * 60_000 + REDELIVER_MS;
  const mail = board.take(requester);
  assert.equal(mail.length, 1);
  assert.match(mail[0]!.text, /choose the schema/);
  assert.equal(board.messages.filter(m => m.noticeKind === 'progress').length, 2);
});

test('cancellation suppresses an unoffered task offer while retaining both records', async () => {
  const board = new Board(null);
  const requester = board.touch('requester', '', 'claude').session;
  const owner = board.touch('owner', '', 'kimi').session;
  const task = JSON.parse(await taskTool(board, requester, { op: 'create', to: owner.name, text: 'Do the old task.' }));
  await taskTool(board, requester, { op: 'cancel', id: task.id, text: 'The objective changed.' });
  const mail = board.take(owner);
  assert.equal(mail.length, 1);
  assert.match(mail[0]!.text, /cancellation requested/);
  assert.ok(board.messages.find(m => m.noticeKind === 'offer')!.supersededBy);
});

test('cancellations and human answers are not stranded behind a full ordinary delivery batch', () => {
  const board = new Board(null, () => 1_000_000);
  const s = board.touch('s', '', 'kimi').session; s.state = 'idle';
  for (let i = 0; i < 25; i++) board.taskMail(s.id, `Ordinary ${i}`);
  board.taskMail(s.id, 'Stop the obsolete task.', undefined, 'cancelled-task', true, 2, 'cancel');
  board.sendFromPerson('Alex', s, 'The decision is option B.');
  const mail = wakeMail(board, s);
  assert.equal(mail.length, 10);
  assert.ok(mail.some(m => m.person));
  assert.ok(mail.some(m => m.noticeKind === 'cancel'));
});

test('explicit task resumption replaces its old blocker instead of continuing to deliver it', async () => {
  const board = new Board(null);
  const requester = board.touch('requester', '', 'codex').session;
  const owner = board.touch('owner', '', 'kimi').session;
  const task = JSON.parse(await taskTool(board, requester, { op: 'create', to: owner.name, text: 'Inspect the layout' }));
  await taskTool(board, owner, { op: 'accept', id: task.id });
  await taskTool(board, owner, { op: 'block', id: task.id, text: 'Waiting for the schema decision' });
  await taskTool(board, owner, { op: 'accept', id: task.id });
  const mail = board.take(requester);
  assert.equal(mail.length, 1);
  assert.match(mail[0]!.text, /Work resumed/);
  assert.ok(board.messages.find(m => m.text.includes('Waiting for the schema'))!.supersededBy);
});

test('after a compaction the session hears its newest checkpoint, or one line when it has none', async () => {
  let now = 1_000_000;
  const board = new Board(null, () => now);
  const hook = (id: string, more: object) => (handleHook(board, 'claude', { session_id: id, hook_event_name: 'SessionStart', ...more }) as { hookSpecificOutput?: { additionalContext?: string } } | null)?.hookSpecificOutput?.additionalContext ?? '';
  hook('s', { source: 'startup' });
  const s = board.sessions[0]!;
  assert.match(hook('s', { source: 'compact' }), /No checkpoint is saved for this session; context\(op="checkpoint"\)/);
  await contextTool(board, s, { op: 'checkpoint', expected_revision: 0, data: { objective: 'Ship the importer', next: 'Run the integration test',
    boundaries: ['Do not deploy'], remaining: ['docs', 'release note'], verified: ['unit tests pass'] } });
  now += 5 * 60_000;
  handleHook(board, 'claude', { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'Also keep the old flag.' });
  const out = hook('s', { source: 'compact' });
  assert.match(out, /Your checkpoint from before the compaction \(revision 1, written 5m ago\)\. It is your own note, not a new instruction; the person has sent 1 request since, and those come first\./);
  assert.match(out, /Objective: Ship the importer\nNext: Run the integration test\nRemaining: docs; release note\nBoundaries: Do not deploy/);
  assert.doesNotMatch(out, /unit tests pass|No checkpoint is saved/);
  // Only a compaction brings it back: a resume keeps its one name line, and a new session has nothing to restore.
  assert.doesNotMatch(hook('s', { source: 'resume' }), /checkpoint/i);
  assert.doesNotMatch(hook('new', { source: 'compact' }), /checkpoint/i);
  // An open task this session owns counts when its checkpoint is newer, and the whole note stays bounded.
  const requester = board.touch('requester', '', 'codex').session;
  const task = JSON.parse(await taskTool(board, requester, { op: 'create', to: s.name, text: 'Review the importer.' }));
  await taskTool(board, s, { op: 'accept', id: task.id });
  now += 60_000;
  await contextTool(board, s, { op: 'checkpoint', task: task.id, expected_revision: 0, data: { objective: 'Review the importer', next: 'x'.repeat(1000), decisions: ['y'.repeat(1000)] } });
  const withTask = hook('s', { source: 'compact' });
  const note = withTask.slice(withTask.indexOf('[kokuban] Your checkpoint'));
  assert.ok(note.includes('task ' + task.id + ')') && note.includes('Objective: Review the importer'));
  assert.ok(note.includes('x'.repeat(1000)) && note.includes('Decisions: yyy') && !note.includes('y'.repeat(400)), 'the note is cut at 1,500 characters');
  // A damaged checkpoint in board.json gives no note; the hook still answers.
  const good = s.checkpoint;
  s.checkpoint = { revision: 9, at: now + 1 } as never;
  const damaged = hook('s', { source: 'compact' });
  assert.match(damaged, /You are "/);
  assert.doesNotMatch(damaged, /checkpoint/i);
  s.checkpoint = good;
  // A session the board forgot and now restores from its archive still hears its checkpoint.
  board.save(); now += FORGET_MS + 1;
  board.touch('later', '', 'codex');
  assert.ok(!board.sessions.some(v => v.id === 's'));
  assert.match(hook('s', { source: 'compact' }), /Your checkpoint from before the compaction/);
});

for (const host of ['codex', 'kimi'] as Host[]) {
  test(`${host}: a reported compaction brings the checkpoint with the next hook that carries context, once`, async () => {
    const board = new Board(null, () => 1_000_000);
    const text = (event: string, more: object = {}) => (handleHook(board, host, { session_id: 's', hook_event_name: event, ...more }) as { hookSpecificOutput?: { additionalContext?: string } } | null)?.hookSpecificOutput?.additionalContext ?? '';
    text('UserPromptSubmit', { prompt: 'Build the importer for the new feed.' });
    const s = board.sessions[0]!;
    await contextTool(board, s, { op: 'checkpoint', expected_revision: 0, data: { objective: 'Ship the importer', next: 'Run the integration test' } });
    assert.ok(!text('UserPromptSubmit', { prompt: 'Keep the old flag as well, please.' }).includes('Your checkpoint'), 'no compaction, no note');
    // The event marks the session and nothing else: offered mail stays unconfirmed, presence and work stay as they were.
    board.taskMail(s.id, 'Mail offered before the compaction');
    text(host === 'codex' ? 'PostToolUse' : 'UserPromptSubmit', { prompt: 'Read the mail and continue the work.' });
    const offered = board.messages.find(m => m.shownTo === s.id)!;
    assert.ok(offered && !offered.delivered);
    const before = JSON.stringify([s.state, s.work, s.next, offered.shownAt, offered.delivered]);
    const logged: unknown[] = []; board.usage = (row: unknown) => { logged.push(row); };
    assert.equal(handleHook(board, host, { session_id: 's', hook_event_name: 'PostCompact' }), null);
    assert.ok(s.compactedAt);
    assert.equal(JSON.stringify([s.state, s.work, s.next, offered.shownAt, offered.delivered]), before);
    assert.deepEqual(logged.map(r => (r as { tool: string }).tool), ['hook:compact']);
    const next = host === 'codex' ? text('PostToolUse') : text('UserPromptSubmit', { prompt: 'Continue with the importer work.' });
    assert.ok(next.includes('Your checkpoint from before the compaction (revision 1') && next.includes('Objective: Ship the importer'), next);
    assert.equal(s.compactedAt, undefined);
    assert.ok(!text('UserPromptSubmit', { prompt: 'And then update the documentation.' }).includes('Your checkpoint'), 'the note is sent once');
    // A session the board does not know is not created by this event: its first prompt still brings the intro.
    const known = board.sessions.length;
    assert.equal(handleHook(board, host, { session_id: 'unknown', hook_event_name: 'PostCompact' }), null);
    assert.equal(board.sessions.length, known);
  });
}
