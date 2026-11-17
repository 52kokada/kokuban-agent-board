import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { kimiBadge, syncBadge } from '../scripts/kimi-hook.mjs';
import { badgeFile, identityFile, paintedTitle } from '../scripts/kimi-statusline.mjs';

test('Kimi badges are a square and the name', () => {
  assert.equal(kimiBadge('Yuki', 'UserPromptSubmit'), '🟧 Yuki');
  assert.equal(kimiBadge('Yuki', 'Stop'), '⬜ Yuki');
  assert.equal(kimiBadge('Yuki', 'Stop', true), '🟧 Yuki');
  assert.equal(kimiBadge('Yuki', 'Interrupt'), '⬜ Yuki');
  assert.equal(kimiBadge('Yuki', 'SessionEnd'), null);
  assert.equal(kimiBadge('bad\x1bname', 'Stop'), null);
});

function home() {
  const h = mkdtempSync(join(tmpdir(), 'kokuban-kimi-badge-'));
  mkdirSync(dirname(identityFile('s1', h)), { recursive: true });
  writeFileSync(identityFile('s1', h), JSON.stringify({ sessionId: 's1', name: 'Yuki' }));
  return h;
}

test('the badge is set once per change and recorded for the status line', () => {
  const h = home();
  const titles = [];
  const deps = { home: h, on: () => true, automatic: false, run: (t) => { titles.push(t); return true; } };
  syncBadge({ session_id: 's1', hook_event_name: 'UserPromptSubmit' }, false, deps);
  syncBadge({ session_id: 's1', hook_event_name: 'PostToolUse' }, false, deps);
  syncBadge({ session_id: 's1', hook_event_name: 'Stop' }, false, deps);
  assert.deepEqual(titles, ['🟧 Yuki', '⬜ Yuki']);
  assert.equal(JSON.parse(readFileSync(badgeFile('s1', h), 'utf8')).title, '⬜ Yuki');
  assert.equal(paintedTitle('s1', 'Yuki', true, h), '⬜ Yuki');
  assert.equal(paintedTitle('s1', 'Yuki', false, h), 'Yuki · Kimi');
  rmSync(h, { recursive: true, force: true });
});

test('badges stay off by default, for wake runs and for subagents', () => {
  const h = home();
  const titles = [];
  const run = (t) => { titles.push(t); return true; };
  syncBadge({ session_id: 's1', hook_event_name: 'Stop' }, false, { home: h, on: () => false, automatic: false, run });
  syncBadge({ session_id: 's1', hook_event_name: 'Stop' }, false, { home: h, on: () => true, automatic: true, run });
  syncBadge({ session_id: 's1', agent_id: 'a', hook_event_name: 'Stop' }, false, { home: h, on: () => true, automatic: false, run });
  assert.deepEqual(titles, []);
  rmSync(h, { recursive: true, force: true });
});
