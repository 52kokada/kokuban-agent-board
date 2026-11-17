import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { charBoundary, clipChars, headChars } from '../src/text-cut.js';
import { catchup } from '../src/vault-catchup.js';
import { applyWrite, findClient, frontmatter, isLedgerEvent, readPage, searchVault, type WriteRequest } from '../src/vault-keeper.js';

const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-text-'));
const T0 = Date.parse('2026-11-05T01:13:00Z');
let n = 0;
const write = (fields: Partial<WriteRequest> & Pick<WriteRequest, 'kind' | 'text'>): WriteRequest => ({
  request_id: `text-${++n}`, source: 'slack:acmestudioaoz/C0C7HQN20MC', author: { agent: 'Prism', pc: 'keeper-pc', person: 'Sam' },
  space: 'T-05555', name: '青空工房', ...fields,
});
const EMOJI = '🧭';
/** A lone surrogate half, or U+FFFD where one was written to a file. */
const broken = (s: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|�/.test(s);
/** Every note in the vault is well-formed UTF-8 without U+FFFD. */
function assertClean(root: string, dir = ''): void {
  for (const d of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${d.name}` : d.name;
    if (d.isDirectory()) { assertClean(root, rel); continue; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(path.join(root, rel)));
    assert.ok(!broken(text), `${rel} has a broken character`);
  }
}

test('cuts land on whole characters: Japanese and an emoji at the cut point', () => {
  // 'あ' is one UTF-16 unit, the emoji two: a UTF-16 cut at 4 would split it.
  const s = `会社名は${EMOJI}検索`;
  assert.equal(s.slice(0, 5).length, 5);
  assert.ok(broken(s.slice(0, 5)), 'a UTF-16 slice splits the emoji');
  assert.equal(headChars(s, 5), `会社名は${EMOJI}`);
  assert.equal(headChars(s, 4), '会社名は');
  assert.equal(headChars(s, 99), s);
  assert.equal(clipChars(s, 6), `会社名は${EMOJI}…`);
  assert.equal(clipChars(s, 7), s);
  assert.equal(clipChars(`${EMOJI}${EMOJI}${EMOJI}`, 2), `${EMOJI}…`);
  assert.equal(charBoundary(s, 5), 4);
  assert.equal(charBoundary(s, 4), 4);
  assert.equal(charBoundary(s, 6), 6);
  for (let i = 0; i <= s.length + 1; i++) {
    assert.ok(!broken(headChars(s, i)) && !broken(clipChars(s, i)) && !broken(s.slice(0, charBoundary(s, i))), `cut at ${i}`);
  }
});

test('keeper log lines, sources, last_event and the read views never split a character', () => {
  const root = temp();
  // The space log keeps 119 characters and "…": an emoji straddles UTF-16 units 118–119.
  const text = `${'会'.repeat(118)}${EMOJI}${'社名は検索・一覧の選択肢として並べる。'.repeat(200)}`;
  // The source line keeps 199 characters; last_event 139 after its date.
  applyWrite(root, write({ kind: 'event', page: 'Communication', text, source: `${'あ'.repeat(198)}${EMOJI}tail` }), T0);
  applyWrite(root, write({ kind: 'event', page: 'Communication', text: `${'い'.repeat(400)}${EMOJI.repeat(400)}` }), T0 + 60_000);
  const dir = findClient(root, 'T-05555')!;
  const log = fs.readFileSync(path.join(root, dir, 'log.md'), 'utf8');
  assert.match(log, new RegExp(`${'会'.repeat(118)}${EMOJI}… — Prism@keeper-pc`));
  const comm = fs.readFileSync(path.join(root, dir, 'Communication.md'), 'utf8');
  assert.match(comm, new RegExp(`_source: ${'あ'.repeat(198)}${EMOJI}… · `));
  assert.ok(!broken(String(frontmatter(fs.readFileSync(path.join(root, dir, 'Overview.md'), 'utf8')).last_event)));
  assertClean(root);
  // Read-time cuts: the 3,000-character entry cut, the catchup line, a search snippet and offset paging.
  const views = [
    readPage(root, 'Communication', 'T-05555'),
    catchup(root, { space: 'T-05555' }),
    searchVault(root, '会', { space: 'T-05555' }),
    ...[0, 1, 2, 3].map((d) => readPage(root, 'Communication', 'T-05555', { offset: 2_000 + d })),
  ];
  assert.match(views[0]!, /entry shortened from \d+ characters/);
  for (const v of views) assert.ok(!broken(v), v.slice(0, 200));
  // An offset that lands inside an emoji starts at the emoji, and the next offset continues from the part's end.
  const raw = fs.readFileSync(path.join(root, dir, 'Communication.md'), 'utf8');
  const inside = raw.indexOf(EMOJI.repeat(2)) + 1;
  const part = readPage(root, 'Communication', 'T-05555', { offset: inside });
  assert.ok(part.startsWith(EMOJI), part.slice(0, 20));
  assert.match(part, new RegExp(`characters ${inside - 1}–`));
});

/** The ledger intake's write as keeper-pc sends it (Rain@keeper-pc). */
function ledgerWrite(links: number, page = 'Communication'): WriteRequest {
  const lead = 'aozora-kobo-works';
  return write({
    kind: 'event', page, author: { agent: 'Rain', pc: 'keeper-pc', person: 'Sam' },
    source: `acme context/leads/${lead}/thread.md (@e6c5e4f)`,
    text: `Ledger ${lead}/thread.md — ${links} dated sections:\n${Array.from({ length: links }, (_, i) =>
      `- [2026-08-${String(i % 28 + 1).padStart(2, '0')} 09:19 JST — ${EMOJI} 決定・メモ](https://github.com/example-org/acme/blob/e6c5e4f4c1/context/leads/${lead}/thread.md#L${i})`).join('\n')}`,
  });
}

test('a ledger import goes to the client\'s Ledger page; Communication keeps one line pointing there', () => {
  const root = temp();
  applyWrite(root, write({ kind: 'event', page: 'Communication', text: '**Slack #general · 2026-11-04** — 4 messages\n- 山田: asked about the Workspace email.' }), T0);
  const r = applyWrite(root, ledgerWrite(41), T0 + 60_000);
  assert.equal(r.page, 'Ledger.md');
  assert.match(r.message, /→ .*\/Ledger\.md, one line on .*\/Communication\.md/);
  const dir = findClient(root, 'T-05555')!;
  const ledger = fs.readFileSync(path.join(root, dir, 'Ledger.md'), 'utf8');
  assert.match(ledger, /^# Ledger\n/);
  assert.match(ledger, new RegExp(`thread\\.md#L40\\)\\n  _source: acme context/leads/aozora-kobo-works/thread\\.md \\(@e6c5e4f\\) · Rain@keeper-pc \\(Sam\\)_ \\^r-${r.revision}\\n`));
  const comm = fs.readFileSync(path.join(root, dir, 'Communication.md'), 'utf8');
  assert.doesNotMatch(comm, /github\.com/);
  const pointer = comm.trim().split('\n').at(-1)!;
  assert.equal(pointer, `- 2026-11-05 01:14Z Ledger aozora-kobo-works/thread.md — 41 dated sections → [[${dir}/Ledger#^r-${r.revision}|on Ledger]] ^r-${r.revision}`);
  assert.ok(pointer.length < 300);
  // The space log names the Ledger page; last_event stays the last thing that happened.
  assert.match(fs.readFileSync(path.join(root, dir, 'log.md'), 'utf8'), /event \[\[.*\/Ledger\|Ledger\]\]: Ledger aozora-kobo-works/);
  assert.match(String(frontmatter(fs.readFileSync(path.join(root, dir, 'Overview.md'), 'utf8')).last_event), /Slack #general/);
  // Reading: Communication shows the one line, Ledger reads newest first, the id finds both; catchup stays short.
  assert.match(readPage(root, 'Communication', 'T-05555'), /# Communication · newest first · 2 of 2/);
  assert.match(readPage(root, 'Ledger', 'T-05555'), /# Ledger · newest first · 1 of 1/);
  assert.match(searchVault(root, `r-${r.revision}`, { space: 'T-05555' }), /Ledger\.md[\s\S]*#L40\)/);
  const caught = catchup(root, { space: 'T-05555' });
  assert.match(caught, new RegExp(`- 2026-11-05 01:14Z · Communication · Ledger aozora-kobo-works/thread\\.md — 41 dated sections → on Ledger \\^r-${r.revision}`));
  assert.doesNotMatch(caught, /github\.com|\[\[/);
  // page "Ledger" may be named; it is a client's page only. Other events are unchanged.
  assert.equal(applyWrite(root, ledgerWrite(2, 'Ledger'), T0 + 120_000).page, 'Ledger.md');
  assert.throws(() => applyWrite(root, { ...ledgerWrite(2, 'Ledger'), space: 'project:kokuban', name: undefined }, T0), /"Ledger" is a client page/);
  assert.equal(applyWrite(root, { ...ledgerWrite(2, 'Work log') }, T0).page, 'Work log.md');
  assert.equal(applyWrite(root, write({ kind: 'event', page: 'Communication', text: 'Ledger reviewed with 山田さん.' }), T0).page, 'Communication.md');
  assert.ok(isLedgerEvent({ text: 'Ledger 青空工房/thread.md — 41 dated sections (part 1/2):', source: '' }));
  assert.ok(isLedgerEvent({ text: 'anything', source: 'acme context/leads/青空工房/thread.md (@e6c5e4f)' }));
  assert.ok(!isLedgerEvent({ text: '**Slack #general** — 1 message', source: 'slack:acmestudioaoz/C0C7HQN20MC' }));
  assertClean(root);
});
