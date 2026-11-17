import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relay, kimiConsole, instructionReminder } from '../scripts/kimi-hook.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Kimi instruction reminder reaches parent prompts even if the board is down', () => {
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: '123', prompt: 'hello' };
  assert.match(instructionReminder(payload), /^Follow .*AGENTS\.md\.$/);
  assert.equal(instructionReminder({ ...payload, agent_id: 'child' }), '');
  assert.equal(instructionReminder({ ...payload, hook_event_name: 'Stop' }), '');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/kimi-hook.mjs', import.meta.url))], {
    input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, KOKUBAN_URL: 'http://127.0.0.1:1' }, timeout: 10000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), instructionReminder(payload));
  assert.match(result.stderr, /Kokuban Kimi hook unavailable/);
});

test('D130: prompts and session starts name the open Kimi window; hidden wakes and other events never do', async () => {
  const calls = [];
  const run = (args) => { calls.push(args); return { status: 0, stdout: '5150\n' }; };
  const deps = { run, ppid: 99, platform: 'win32', automatic: false };
  assert.equal(kimiConsole({ hook_event_name: 'UserPromptSubmit', session_id: '1' }, deps), 5150);
  assert.equal(kimiConsole({ hook_event_name: 'SessionStart', session_id: '1' }, deps), 5150);
  assert.deepEqual(calls[0], ['find', '99']);
  for (const payload of [{ hook_event_name: 'Stop' }, { hook_event_name: 'PostToolUse' }, { hook_event_name: 'UserPromptSubmit', agent_id: 'child' }]) {
    assert.equal(kimiConsole(payload, deps), null);
  }
  assert.equal(kimiConsole({ hook_event_name: 'UserPromptSubmit' }, { ...deps, automatic: true }), null);
  assert.equal(kimiConsole({ hook_event_name: 'UserPromptSubmit' }, { ...deps, run: () => ({ status: 2, stdout: '' }) }), null);
  assert.equal(kimiConsole({ hook_event_name: 'UserPromptSubmit' }, { ...deps, run: () => ({ error: new Error('missing helper') }) }), null);
  assert.equal(calls.length, 2);
  // The board hears the window; a one-shot wake process never names one.
  await relay({ hook_event_name: 'UserPromptSubmit', session_id: '1', console_pid: 5150 }, 'http://board', async (_, options) => {
    assert.equal(JSON.parse(options.body).console_pid, 5150);
    return new Response('');
  });
  await relay({ hook_event_name: 'UserPromptSubmit', session_id: '1', console_pid: 5150 }, 'http://board', async (_, options) => {
    assert.equal(JSON.parse(options.body).console_pid, undefined);
    return new Response('');
  }, true);
});

test('Kimi hook namespaces session IDs and translates context', async () => {
  const result = await relay({ hook_event_name: 'UserPromptSubmit', session_id: '123', cwd: 'C:/repo' }, 'http://board', async (url, options) => {
    assert.equal(url, 'http://board/hook/kimi');
    assert.equal(JSON.parse(options.body).session_id, 'kimi-123');
    return new Response(JSON.stringify({ hookSpecificOutput: { additionalContext: 'your name and mail' } }));
  });
  assert.deepEqual(result, { text: 'your name and mail', blocked: false });
});

test('Stop mail translates to the Kimi continuation contract', async () => {
  const result = await relay({ hook_event_name: 'Stop', session_id: '123' }, 'http://board', async () =>
    new Response(JSON.stringify({ decision: 'block', reason: 'read incoming mail' })));
  assert.deepEqual(result, { text: 'read incoming mail', blocked: true });
});

test('one-shot wake exit does not close the original conversation', async () => {
  const result = await relay({ hook_event_name: 'SessionEnd', session_id: '123' }, 'http://board',
    async () => { throw new Error('must not close the session'); }, true);
  assert.deepEqual(result, { text: '', blocked: false });
});

test('structured Kimi prompts become plain text for the board', async () => {
  await relay({ hook_event_name: 'UserPromptSubmit', session_id: '123', prompt: [{ type: 'text', text: 'Check the tools' }] }, 'http://board', async (_, options) => {
    assert.equal(JSON.parse(options.body).prompt, 'Check the tools');
    return new Response('');
  });
});

test('observation-only events and subagents never consume parent mail', async () => {
  const forbidden = async () => { throw new Error('must not call the board'); };
  for (const payload of [
    { hook_event_name: 'Notification', session_id: '123' },
    { hook_event_name: 'UserPromptSubmit', session_id: '123', agent_id: 'child' },
  ]) assert.deepEqual(await relay(payload, 'http://board', forbidden), { text: '', blocked: false });
});

test('Kimi observation hooks report lifecycle but never return mail or block', async () => {
  for (const event of ['SessionStart', 'PostToolUse', 'Interrupt', 'StopFailure', 'PostCompact']) {
    let called = false;
    const result = await relay({ hook_event_name: event, session_id: '123' }, 'http://board', async (_, options) => {
      called = true;
      assert.equal(JSON.parse(options.body).hook_event_name, event);
      return new Response(JSON.stringify({ decision: 'block', reason: 'must not consume' }));
    });
    assert.equal(called, true);
    assert.deepEqual(result, { text: '', blocked: false });
  }
});

test('D133 short intro (no compaction marker) still records the board name for badge and status line', async () => {
  const { rememberIdentity } = await import('../scripts/kimi-hook.mjs');
  const { identityFile } = await import('../scripts/kimi-statusline.mjs');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'kimi-id-'));
  const intro = '[kokuban] You are "Vesper" on this PC\'s agent board (Claude, Codex, Kimi); pass me="Vesper" to kokuban tools.\nOthers now: Calla.';
  assert.equal(rememberIdentity(intro, '42', home), 'Vesper');
  assert.deepEqual(JSON.parse(readFileSync(identityFile('42', home), 'utf8')), { sessionId: '42', name: 'Vesper' });
  assert.equal(rememberIdentity('[kokuban] Joined: Calla.', '43', home), null);
});
