import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { catchup, entriesOf, parseWhen } from '../src/vault-catchup.js';
import { factAgeMark } from '../src/vault-store.js';
import { applyWrite, findClient, findClientPage, readPage, searchVault, vaultTool, type WriteRequest } from '../src/vault-keeper.js';

const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-catchup-'));
const T0 = Date.parse('2026-11-01T00:00:00Z');
const HOUR = 3_600_000;
let n = 0;
const write = (fields: Partial<WriteRequest> & Pick<WriteRequest, 'kind' | 'text'>): WriteRequest => ({
  request_id: `catchup-${++n}`, source: 'slack:aoz/general', author: { agent: 'Prism', pc: 'keeper-pc', person: 'Sam' },
  space: 'T-05555', name: '青空工房', ...fields,
});
const ids = (text: string): string[] => [...text.matchAll(/\^(r-[0-9a-f]+)/g)].map((m) => m[1]!);

/** A client with 30 Slack days in Communication (the newest about Square declines), a work log and a proposal. */
function client(): { root: string; comm: string[] } {
  const root = temp();
  applyWrite(root, write({ kind: 'summary', text: '**Where things stand:** launch.\n**Next step:** fix the 11/5 reminder.' }), T0);
  // A ledger dump first, long like the real one.
  applyWrite(root, write({ kind: 'event', page: 'Communication', text: `Ledger thread.md — 41 dated sections:\n${Array.from({ length: 60 }, (_, i) =>
    `- [2026-08-${String(i % 28 + 1).padStart(2, '0')} 09:19 JST — 決定・メモ](https://github.com/x/thread.md#L${i})`).join('\n')}` }), T0);
  const comm: string[] = [];
  for (let i = 1; i <= 30; i++) {
    const r = applyWrite(root, write({ kind: 'event', page: 'Communication', text: `**Slack #general · day ${i}** — 1 message\n- 山田: ${i === 30
      ? 'Square declined the card three times for the 11/9 tasting booking.' : `ordinary message ${i} ${'about the class schedule '.repeat(16)}`}\n\n` +
      `[first message](https://slack.example/p${i}) · [last message](https://slack.example/p${i})` }), T0 + i * HOUR);
    comm.push(`r-${r.revision}`);
  }
  applyWrite(root, write({ kind: 'event', text: 'Deployed the decline-reason fix.' }), T0 + 31 * HOUR);
  applyWrite(root, write({ kind: 'proposal', section: 'photos', text: 'Use one studio for all photos.' }), T0 + 2 * HOUR);
  applyWrite(root, write({ kind: 'fact', section: 'payment-provider', text: 'Square' }), T0 + 3 * HOUR);
  return { root, comm };
}

test('log entries are split with their time, id and section; times parse in UTC, JST and relative', () => {
  const { entries, other } = entriesOf('---\na: 1\n---\n# Decisions\n\n## Accepted\n\n- 2026-11-05 12:19Z one\n  more\n  _source: x_ ^r-abc123\n\n' +
    '## Proposed — not accepted\n\n- no time here\nA person\'s note\n');
  assert.equal(entries.length, 2);
  assert.deepEqual([entries[0]!.stamp, entries[0]!.id, entries[0]!.section], ['2026-11-05 12:19Z', 'r-abc123', 'Accepted']);
  assert.equal(entries[0]!.text.split('\n').length, 3);
  assert.deepEqual([entries[1]!.stamp, entries[1]!.section], [null, 'Proposed — not accepted']);
  assert.equal(other, true);
  const now = Date.parse('2026-11-06T12:00:00Z');
  assert.equal(parseWhen('2026-11-05 21:09 JST', now), Date.parse('2026-11-05T12:09:00Z'));
  assert.equal(parseWhen('2026-11-05 12:09Z', now), Date.parse('2026-11-05T12:09:00Z'));
  assert.equal(parseWhen('2026-11-05 12:09', now), Date.parse('2026-11-05T12:09:00Z'));
  assert.equal(parseWhen('2026-11-05', now), Date.parse('2026-11-05T00:00:00Z'));
  assert.equal(parseWhen('2d', now), now - 2 * 86_400_000);
  assert.throws(() => parseWhen('yesterday', now), /not a time/);
});

test('a log page reads newest first, a page at a time; before pages back and since shows what changed', () => {
  const { root, comm } = client();
  const first = readPage(root, 'Communication', 'T-05555');
  assert.match(first, /^# Communication · newest first · 10 of 31 · /);
  assert.deepEqual(ids(first), comm.slice(-10).reverse());
  assert.match(first, /Square declined the card/);
  const next = /before="(r-[0-9a-f]+)"/.exec(first)![1]!;
  assert.equal(next, comm.at(-10));
  assert.match(first, /… 21 older: vault op="read" space="T-05555" page="Communication" before="r-/);
  const second = readPage(root, 'Communication', 'T-05555', { before: next });
  assert.deepEqual(ids(second), comm.slice(-20, -10).reverse());
  // The last page: the 60-link ledger dump is one line pointing to the Ledger page.
  const last = readPage(root, 'Communication', 'T-05555', { before: comm[0], limit: 5 });
  assert.match(last, /\n- 2026-11-01 00:00Z Ledger thread\.md — 41 dated sections → \[\[Acme\/Clients\/.*\/Ledger#\^r-[0-9a-f]+\|on Ledger\]\] \^r-[0-9a-f]+\n/);
  assert.doesNotMatch(last, /github\.com/);
  assert.match(last, /No older entries\./);
  // Ledger reads like the other log pages: the long entry is shortened and names how to see it whole.
  const ledger = readPage(root, 'Ledger', 'T-05555');
  assert.match(ledger, /^# Ledger · newest first · 1 of 1/);
  assert.match(ledger, /entry shortened from \d+ characters; whole: vault op="search" space="T-05555" query="r-/);
  const whole = searchVault(root, /query="(r-[0-9a-f]+)"/.exec(ledger)![1]!, { space: 'T-05555' });
  assert.match(whole, /#L59\)/);
  const since = readPage(root, 'Communication', 'T-05555', { since: '2026-11-02 03:00Z' });
  assert.deepEqual(ids(since), comm.slice(-4).reverse());
  assert.match(since, /4 of 4 since 2026-11-02 03:00Z \(31 on the page\)/);
  assert.match(readPage(root, 'Communication', 'T-05555', { since: '2026-12-01' }), /Nothing since then\./);
  assert.throws(() => readPage(root, 'Communication', 'T-05555', { before: 'r-00000000' }), /no entry r-00000000/);
  // offset reads the page as written and says where the rest is.
  const raw = readPage(root, 'Communication', 'T-05555', { offset: 0 });
  assert.match(raw, /^# Communication\n/);
  assert.doesNotMatch(raw, /the rest:/);
  assert.match(readPage(root, 'Communication', 'T-05555', { offset: 10_000 }), /\(characters 10000–(\d+) of \1: the end\)/);
  assert.throws(() => readPage(root, 'Overview', 'T-05555', { since: '2d' }), /for log pages/);
});

test('search answers with the matching entries and lines, newest first, not just page names', () => {
  const { root } = client();
  const out = searchVault(root, 'square declined', { space: 'T-05555' });
  assert.match(out, /^Acme\/Clients\/.*\/Communication\.md \| Communication \| T-05555\n- 2026-11-02 06:00Z \*\*Slack #general · day 30\*\*[\s\S]*Square declined the card/);
  assert.doesNotMatch(out, /ordinary message/);
  assert.match(out, /\(matched by text\)\nbased on: /);
  const many = searchVault(root, 'ordinary', { space: 'T-05555' });
  assert.match(many, /day 29[\s\S]*day 25[\s\S]*… 24 more on this page/);
  assert.ok(many.length < 12_000, `${many.length}`);
  assert.match(searchVault(root, 'ordinary', { space: 'T-05555', since: '2026-11-02 04:30Z', now: T0 }), /day 29\*\*/);
  assert.equal(searchVault(root, 'ordinary', { space: 'T-05555', since: '2026-12-01' }), 'nothing matches since then');
  // A page without entries shows its matching lines.
  assert.match(searchVault(root, 'next step reminder', { space: 'T-05555' }), /Overview\.md \| 青空工房 \| T-05555\n {2}L\d+: \*\*Next step:\*\* fix the 11\/5 reminder\./);
});

test('catchup gives where a client stands and the newest entries in one short answer', async () => {
  const { root, comm } = client();
  const out = catchup(root, { space: 'T-05555' });
  assert.match(out, /^# T-05555 青空工房/);
  assert.match(out, /\*\*Next step:\*\* fix the 11\/5 reminder\./);
  assert.match(out, /## Latest · 8 of 33 \(Communication 31, Work log 1, Decisions 1\)\n- 2026-11-02 07:00Z · Work log · Deployed the decline-reason fix\./);
  assert.match(out, /\n- 2026-11-02 06:00Z · Communication · \*\*Slack #general · day 30\*\* — 1 message \/ - 山田: Square declined the card three times for the 11\/9 tasting booking\. \^r-/);
  assert.doesNotMatch(out, /first message|_source:|slack\.example/);
  assert.equal(ids(out).filter((id) => comm.includes(id)).length, 7);
  assert.match(out, /More: vault op="read" space="T-05555" page="Communication" \(newest first/);
  assert.match(out, /Proposed, not accepted: 1 on Decisions/);
  assert.match(out, /Facts \(1, last changed first\): payment-provider/);
  assert.match(out, /\nbased on: .*Overview\.md.*Communication\.md/);
  assert.ok(out.length < 6_000, `${out.length}`);
  // since: only what changed, the proposal and summary not repeated as news.
  const since = catchup(root, { space: 'T-05555', since: '2026-11-02 05:30Z' });
  assert.match(since, /## Latest since 2026-11-02 05:30Z · 2 of 2 \(Communication 1, Work log 1\)/);
  // By name, through the tool, and the client answer points to it.
  assert.match(catchup(root, { query: '青空' }), /^# T-05555/);
  assert.match(findClientPage(root, 'T-05555'), /^T-05555 \| .*\/ \| what's new, newest first: vault op="catchup" space="T-05555"\n[\s\S]*\nbased on: /);
  const tool = await vaultTool(new Board(), { name: 'Rio' } as never, { op: 'catchup', space: 'T-05555', limit: 2 },
    { config: () => ({ path: root, keeper: true, keeperPc: 'keeper-pc' }) });
  assert.match(tool, /## Latest · 2 of 33/);
  assert.ok(findClient(root, 'T-05555'));
});

test('catchup on a project and a business; a business log does not repeat its decisions', () => {
  const root = temp();
  const p = (fields: Partial<WriteRequest> & Pick<WriteRequest, 'kind' | 'text'>): WriteRequest => write({ space: 'project:kokuban', name: undefined, ...fields });
  applyWrite(root, p({ kind: 'summary', text: 'Kokuban is the board.', frontmatter: { status: 'active', next_step: 'merge the catch-up view' } }), T0);
  applyWrite(root, p({ kind: 'event', text: 'Built catchup.' }), T0 + HOUR);
  applyWrite(root, p({ kind: 'decision', section: 'reads', text: 'Log pages read newest first.', accepted_by: 'Alex' }), T0 + 2 * HOUR);
  const out = catchup(root, { space: 'project:kokuban' });
  assert.match(out, /^# project:kokuban · status active/);
  assert.match(out, /Next step: merge the catch-up view/);
  assert.match(out, /- 2026-11-01 02:00Z · Decision · \*\*reads\*\* — Log pages read newest first\.[\s\S]*- 2026-11-01 01:00Z · Work log · Built catchup\./);
  assert.match(out, /page="Work log"/);
  applyWrite(root, write({ space: 'agency', name: undefined, kind: 'decision', section: 'name', text: 'The company is Acme.', accepted_by: 'Alex' }), T0);
  const biz = catchup(root, { space: 'agency' });
  assert.equal((biz.match(/The company is Acme/g) ?? []).length, 1);
  assert.match(biz, /· Decision · /);
  assert.throws(() => catchup(root, {}), /catchup needs space/);
});

test('facts older than 90 days show their full date and a check mark; recent ones keep the short form', () => {
  const { root } = client();
  const DAY = 24 * HOUR;
  applyWrite(root, write({ kind: 'fact', section: 'old-fact', text: 'A' }), T0 - 200 * DAY);
  applyWrite(root, write({ kind: 'fact', section: 'edge-fact', text: 'B' }), T0 + 3 * HOUR - 90 * DAY);
  applyWrite(root, write({ kind: 'fact', section: 'over-fact', text: 'C' }), T0 + 3 * HOUR - 90 * DAY - 1000);
  const out = catchup(root, { space: 'T-05555', now: T0 + 3 * HOUR });
  // payment-provider changed at T0 + 3h: recent, short form. edge-fact is exactly 90 days old: not marked.
  assert.match(out, /Facts \(4, last changed first\): payment-provider 11-01, edge-fact 08-03, over-fact 2026-08-03 \(check before use\), old-fact 2026-04-15 \(check before use\); a fact marked "check before use" last changed over 90 days ago or has no date \(write it again with the same value to confirm it\); read one/);
  // One fact page read shows the mark where the date is shown.
  assert.match(readPage(root, 'Facts/old-fact', 'T-05555', { now: T0 }), /Facts\/old-fact\.md \(updated 2026-04-15 00:00; check before use\)/);
  assert.match(readPage(root, 'Facts/payment-provider', 'T-05555', { now: T0 }), /payment-provider\.md \(updated 2026-11-01 03:00\)/);
  // A page that is not a fact is never marked.
  assert.doesNotMatch(readPage(root, 'Overview', 'T-05555', { now: T0 + 400 * DAY }), /check before use/);
});

test('a fact with no known date is marked as age unknown', () => {
  assert.equal(factAgeMark(0, T0), 'age unknown, check before use');
  assert.equal(factAgeMark(T0 - 90 * 24 * HOUR, T0), '');
  assert.equal(factAgeMark(T0 - 90 * 24 * HOUR - 1, T0), 'check before use');
});

test('writing a fact again with the same value confirms it: updated moves, the mark goes, a later replacement still works', () => {
  const { root } = client();
  const DAY = 24 * HOUR;
  const t1 = T0 + 200 * DAY;
  applyWrite(root, write({ kind: 'fact', section: 'old-fact', text: 'A', author: { agent: 'Prism', pc: 'keeper-pc', person: 'Sam' } }), T0);
  assert.match(catchup(root, { space: 'T-05555', now: t1 }), /old-fact 2026-11-01 \(check before use\)/);
  const r = applyWrite(root, write({ kind: 'fact', section: 'old-fact', text: 'A', author: { agent: 'Other', pc: 'keeper-pc', person: 'Someone' } }), t1);
  assert.equal(r.state, 'confirmed');
  assert.equal(r.revision, '');
  assert.match(r.message, /^confirmed: old-fact is still "A"/);
  const out = catchup(root, { space: 'T-05555', now: t1 });
  assert.match(out, /Facts \(2, last changed first\): old-fact 05-20, payment-provider 2026-11-01 \(check before use\)/);
  assert.doesNotMatch(out, /old-fact 05-20 \(/);
  const page = readPage(root, 'Facts/old-fact', 'T-05555', { now: t1, offset: 0 });
  assert.match(page, /accepted_by: .*Sam/);
  assert.match(page, /valid_from: "2026-11-01T00:00:00.000Z"/);
  assert.match(page, new RegExp(`updated: "${new Date(t1).toISOString()}"`));
  assert.doesNotMatch(page, /Someone/);
  // The confirmation recorded no revision, so a real replacement still passes its hash check.
  const rep = applyWrite(root, write({ kind: 'fact', section: 'old-fact', text: 'B', replaces: 'A' }), t1 + HOUR);
  assert.equal(rep.state, 'written');
  assert.match(readPage(root, 'Facts/old-fact', 'T-05555', { offset: 0 }), /replaced_by: "B"/);
});
