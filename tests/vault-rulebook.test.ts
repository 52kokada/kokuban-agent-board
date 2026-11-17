// D118: one rulebook for every agent on every PC: Rules.md 13–17, "How this works", and the vault lines on every host.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { SETTINGS } from '../src/cards.js';
import { handleHook } from '../src/hooks.js';
import { handleRpc } from '../src/mcp.js';
import {
  HOW, HOW_PAGE, README_PAGE, README_V2, RULES_D118_PROPOSAL_ID, RULES_PAGE, RULES_V5, ensureLayout, layoutNotes, proposeRules,
  readPage, revisions, writeAttention,
} from '../src/vault-keeper.js';

const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-rulebook-'));
const NOW = Date.parse('2026-11-04T10:00:00Z');
const file = (root: string, rel: string): string => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
async function withSettings(settings: object, run: () => Promise<void>): Promise<void> {
  const old = SETTINGS.file;
  SETTINGS.file = path.join(temp(), 'settings.json');
  fs.writeFileSync(SETTINGS.file, JSON.stringify(settings));
  try { await run(); } finally { SETTINGS.file = old; }
}
const said = (out: object | null): string => JSON.stringify(out ?? {});

test('Rules.md carries the D118 rules; the keeper\'s unedited fifth page gains them', () => {
  for (const rule of [/13\. Read before you answer \(D118\): start at \[\[How this works\]\]/, /14\. Who writes where: people edit any note/,
    /Agents on every PC never edit, move, rename or delete files/, /15\. When the keeper cannot be reached, a write waits in that PC's own \.keeper\/queue/,
    /A password is never queued/, /16\. What stays out: personal and private matters/, /security\n {4}engagement evidence/,
    /17\. Keep Obsidian healthy: do not rename or move business, group or client folders/, /Obsidian Sync stays off/]) {
    assert.match(RULES_PAGE, rule);
  }
  assert(RULES_PAGE.startsWith(RULES_V5.slice(0, RULES_V5.indexOf('11. The vault is grouped by business'))));
  const old = temp();
  fs.writeFileSync(path.join(old, 'Rules.md'), RULES_V5);
  fs.writeFileSync(path.join(old, 'README.md'), README_V2);
  ensureLayout(old);
  assert.equal(file(old, 'Rules.md'), RULES_PAGE);
  assert.equal(file(old, 'README.md'), README_PAGE);
  assert.match(README_PAGE, /\[\[How this works\]\]: start here/);
  assert.equal(proposeRules(old, NOW, 'keeper-pc'), null);
});

test('"How this works" is laid out once, never overwritten, readable and not an orphan', () => {
  const root = temp();
  ensureLayout(root);
  assert.equal(file(root, HOW), HOW_PAGE);
  assert.match(HOW_PAGE, /\| keeper-pc \(the hub\) \|[\s\S]*\| iPhones \|[\s\S]*## How agents use it[\s\S]*## Keeping it healthy/);
  assert.match(readPage(root, 'How this works'), /# How this works[\s\S]*based on: How this works\.md/);
  assert(layoutNotes(root).includes(HOW));
  const theirs = `${HOW_PAGE}\nOur own note.\n`;
  fs.writeFileSync(path.join(root, HOW), theirs);
  ensureLayout(root);
  assert.equal(file(root, HOW), theirs);
  writeAttention(root, NOW);
  assert.doesNotMatch(file(root, 'Needs attention.md'), /How this works/);
});

test('an edited Rules.md without the D118 rules gets one proposal, once', () => {
  const edited = temp();
  ensureLayout(edited);
  const theirs = `${RULES_V5}13. Our own rule.\n`;
  fs.writeFileSync(path.join(edited, 'Rules.md'), theirs);
  assert.equal(proposeRules(edited, NOW, 'keeper-pc')!.state, 'written');
  assert.match(file(edited, 'Acme/Decisions.md'), /Rules\.md rulebook[\s\S]*rules 13 to 17/);
  proposeRules(edited, NOW, 'keeper-pc');
  assert.equal(revisions(edited).filter((r) => r.request_id === RULES_D118_PROPOSAL_ID).length, 1);
  assert.equal(file(edited, 'Rules.md'), theirs);
});

test('every host hears the vault lines once: Claude and Codex at SessionStart, Kimi with its first prompt', async () => {
  await withSettings({ person: 'Alex', vault: { path: temp(), keeper: false } }, async () => {
    const board = new Board();
    for (const host of ['claude', 'codex'] as const) {
      const id = `${host}-1`;
      assert.match(said(handleHook(board, host, { hook_event_name: 'SessionStart', session_id: id, source: 'startup' })), /Shared vault \(Obsidian\): use only the vault tool/);
      assert.doesNotMatch(said(handleHook(board, host, { hook_event_name: 'UserPromptSubmit', session_id: id, prompt: 'what is the AOZ launch date?' })), /Shared vault/);
    }
    // Kimi's SessionStart is observation-only and carries no context: the first prompt does.
    assert.equal(handleHook(board, 'kimi', { hook_event_name: 'SessionStart', session_id: 'kimi-1' }), null);
    const first = said(handleHook(board, 'kimi', { hook_event_name: 'UserPromptSubmit', session_id: 'kimi-1', prompt: 'what is the AOZ launch date?' }));
    assert.match(first, /You are \\"[^"\\]+\\"[\s\S]*record peers\(work=[\s\S]*Shared vault \(Obsidian\): use only the vault tool/);
    assert.match(first, /Never edit, move or delete files in the vault folder/);
    assert.doesNotMatch(said(handleHook(board, 'kimi', { hook_event_name: 'UserPromptSubmit', session_id: 'kimi-1', prompt: 'and the next step after that?' })), /Shared vault/);
    // A resumed Claude session hears them again at its SessionStart.
    assert.match(said(handleHook(board, 'claude', { hook_event_name: 'SessionStart', session_id: 'claude-1', source: 'resume' })), /Shared vault/);
    const init = said(await handleRpc(board, 'kimi', { id: 1, method: 'initialize' }));
    // The vault rules are the session lines; the MCP instructions do not repeat them.
    assert.doesNotMatch(init, /Shared vault/);
  });
  await withSettings({ person: 'Alex' }, async () => {
    const board = new Board();
    assert.doesNotMatch(said(handleHook(board, 'kimi', { hook_event_name: 'UserPromptSubmit', session_id: 'kimi-2', prompt: 'what is the AOZ launch date?' })), /Shared vault/);
    assert.doesNotMatch(said(await handleRpc(board, 'kimi', { id: 1, method: 'initialize' })), /Shared vault/);
  });
});
