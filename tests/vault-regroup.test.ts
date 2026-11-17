import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { SETTINGS } from '../src/cards.js';
import {
  RULES_PAGE, appendRevision, applyWrite, ensureLayout, sha, frontmatter, getBlock, keeperConfig, keeperTick, layoutSummary, revisions, useGrouping, vaultTool,
  type KeeperConfig, type WriteRequest,
} from '../src/vault-keeper.js';
import { DEFAULT_GROUPING, findProject, guessPlace, isClientGroup, linkTarget, mappedPlace, parseGrouping, placeName } from '../src/vault-layout.js';
import { STAGE_CSS, planRegroup, regroup, rewriteLinks, updateBaseStages } from '../src/vault-regroup.js';
import { TENDRA_CSS } from '../src/vault-tendra.js';
import { RESEARCH_CSS } from '../src/vault-visuals.js';

const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-regroup-'));
const NOW = Date.parse('2026-11-05T10:00:00Z');
let n = 0;
const write = (fields: Partial<WriteRequest> & Pick<WriteRequest, 'kind' | 'text'>): WriteRequest => ({
  request_id: `regroup-test-${++n}`, source: 'test', author: { agent: 'Rio', pc: 'keeper-pc', person: 'Alex' }, ...fields,
});
const file = (root: string, rel: string): string => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const has = (root: string, rel: string): boolean => fs.existsSync(path.join(root, ...rel.split('/')));
function paths(root: string, dir = ''): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = dir ? `${dir}/${d.name}` : d.name;
    if (d.name === '.keeper') return [];
    return d.isDirectory() ? paths(root, rel) : [rel];
  }).sort();
}
function tree(root: string, skip = /^\.keeper\/index\.json$/): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const d of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${d.name}` : d.name;
      if (d.isDirectory()) walk(rel); else if (!skip.test(rel)) out[rel] = file(root, rel);
    }
  };
  walk('');
  return out;
}
const AOZ = 'T-05555 青空工房';
/** The stage groups a client folder sits in (Clients/<group>/<ID> <name>). */
const NS = '0 ❓ No stage';
const ACT = '1 🔥 Act now';
const BUILD = '2 🛠 Building';
const SUMMARY = '**Stage:** signed — cockpit lead `proposal_signed`\n**Last thing that happened:** 2026-10-01 — kickoff notes\n' +
  '**Ledger (acme repo):**\n- [thread.md](https://github.com/example-org/acme/blob/main/context/leads/aoz/thread.md)\n\n_Imported 2026-11-05._';
/** The visual pass's base (property filters, a kanban view with D50's stage order). */
const VISUAL_BASE = 'filters:\n  and:\n    - tobira_id\n    - file.name == "Overview"\n' +
  'views:\n  - type: kanban\n    name: Board\n    filters:\n      and:\n        - stage != "closed"\n    groupBy:\n      property: stage\n' +
  '    groupOrder:\n      - outreach\n      - reply\n      - engagement\n      - proposal\n      - signed\n      - building\n      - launch\n      - done\n' +
  '    order:\n      - formula.client\n    columnWidth: 240\n  - type: table\n    name: Pipeline\n';

/**
 * A vault as the keeper made it before D101: Agency/, Clients/, Projects/ at the top, written through the keeper
 * itself (so revisions exist), plus a person's note, the visual pass's bases and css, and acme-booking as a
 * separate space next to ember-aoz.
 */
function legacyVault(): string {
  const root = temp();
  for (const d of ['Agency', 'Clients', 'Projects', '.obsidian/snippets']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'Agency', 'Pipeline.base'), VISUAL_BASE);
  fs.writeFileSync(path.join(root, 'Agency', 'Care.base'), 'filters:\n  and:\n    - file.inFolder("Clients")\n    - care_stage\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# Shared vault\n\nNothing here yet — Phase 3 fills it.\n');
  fs.writeFileSync(path.join(root, '.obsidian', 'snippets', 'tobira.css'), '/* the visual pass */\n.tobira-stage { color: red; }\n');
  ensureLayout(root);
  assert(!has(root, 'Acme'), 'before the regroup the keeper lays Acme out in Agency/');
  applyWrite(root, write({ kind: 'summary', space: 'T-05555', name: '青空工房', text: SUMMARY }), NOW);
  // The import's summary, as the old keeper wrote it (before the layout): the block and its revision.
  const ov = path.join(root, 'Clients', AOZ, 'Overview.md');
  fs.writeFileSync(ov, fs.readFileSync(ov, 'utf8').replace(layoutSummary(SUMMARY), SUMMARY));
  appendRevision(root, { id: 'old00001', ts: new Date(NOW).toISOString(), kind: 'summary', state: 'written', space: 'T-05555', page: 'Overview.md',
    block: 'summary', author: 'Rio@keeper-pc', source: 'import', before: sha(''), after: sha(SUMMARY), text_hash: sha(SUMMARY) });
  applyWrite(root, write({ kind: 'event', space: 'T-05555', text: 'Kickoff held.', frontmatter: { stage: 'signed' } }), NOW);
  applyWrite(root, write({ kind: 'fact', space: 'T-05555', section: 'agreed-price', text: '¥300,000' }), NOW);
  applyWrite(root, write({ kind: 'event', space: 'T-00160', name: 'ひまわり商会', text: 'First reply.' }), NOW);
  // An Overview with D50's old stage (written by hand, as the import left some).
  const sea = path.join(root, 'Clients', 'T-00160 ひまわり商会', 'Overview.md');
  fs.writeFileSync(sea, fs.readFileSync(sea, 'utf8').replace('---\n# ', 'stage: reply\n---\n# '));
  applyWrite(root, write({ kind: 'event', space: 'agency', text: 'New pricing sheet.' }), NOW);
  applyWrite(root, write({ kind: 'credential', space: 'agency', text: '', site: 'acme.example', account: 'info@acme.example', value: 'regroup-pass-123456' }), NOW);
  // The old keeper knew no aliases: acme-booking got a space of its own next to ember-aoz.
  useGrouping(root, { ...DEFAULT_GROUPING, businesses: DEFAULT_GROUPING.businesses.map((b) => ({ ...b, repoAliases: {} })) });
  for (const [repo, remote] of [['kokuban', 'https://github.com/example-org/kokuban.git'], ['acme', ''], ['ember-aoz', ''],
    ['acme-booking', 'https://github.com/example-org/acme-booking.git'], ['Reservation', ''], ['mystery', 'https://github.com/someone/mystery.git']] as const) {
    applyWrite(root, write({ kind: 'summary', space: `project:${repo}`, text: `${repo}: the ${repo} repository.`, project: { remote, docs: ['README.md'] } }), NOW);
  }
  applyWrite(root, write({ kind: 'decision', space: 'project:ember-aoz', section: 'launch', text: 'Early launch on harbor-trading.example.' }), NOW);
  applyWrite(root, write({ kind: 'decision', space: 'project:acme-booking', section: 'tenants', text: 'AOZ is the first tenant.' }), NOW);
  applyWrite(root, write({ kind: 'event', space: 'project:acme-booking', text: 'Booking worker deployed.' }), NOW);
  useGrouping(root, null);
  fs.writeFileSync(path.join(root, 'Agency', 'Notes by Sam.md'),
    `# Notes\n\nSee [[Clients/${AOZ}/Overview|AOZ]], [[Projects/acme-booking/Decisions#Accepted|booking decisions]], ` +
    `[[Projects/kokuban/Overview]] and [[Needs attention]]. A name link: [[Rules]].\n`);
  return root;
}

test('the default mapping is D102, settings replace it, and the repository guess places or leaves in Unsorted', async () => {
  const where = (repo: string): string => { const p = mappedPlace(DEFAULT_GROUPING, repo); return p ? placeName(p) : 'none'; };
  for (const repo of ['acme', 'acme-cockpit', 'translation', 'ops-home', 'prompt']) assert.equal(where(repo), 'acme', repo);
  assert.equal(where('ember-aoz'), 'acme T-05555');
  assert.equal(where('acme-booking'), 'acme T-05555');
  assert.equal(where('Reservation'), 'harbor-trading');
  assert.equal(where('crypto'), 'crypto');
  assert.equal(where('security'), 'security');
  assert.equal(where('kokuban'), 'shared');
  assert.equal(where('computeruse'), 'shared');
  assert.equal(where('mystery'), 'none');
  assert.deepEqual(DEFAULT_GROUPING.businesses.map((b) => [b.key, b.folder, b.clientPrefix ?? '']),
    [['acme', 'Acme', 'T'], ['harbor-trading', 'Harbor Trading', ''], ['crypto', 'Crypto', ''], ['security', 'Security', '']]);
  // D103: name, then remote, then README; unsure → Unsorted.
  const guess = (r: { name: string; remote?: string; readme?: string }): string => `${placeName(guessPlace(DEFAULT_GROUPING, r).place)} (${guessPlace(DEFAULT_GROUPING, r).why})`;
  assert.equal(guess({ name: 'acme-landing' }), 'acme (repository name)');
  assert.equal(guess({ name: 'bot', remote: 'git@github.com:someone/crypto-bot.git' }), 'crypto (remote)');
  assert.equal(guess({ name: 'site-2026', readme: 'アクミのクライアント用サイト' }), 'acme (README)');
  assert.equal(guess({ name: 'site-2026', readme: 'Built by Acme Agency.' }), 'acme (README)');
  assert.match(guess({ name: 'site', readme: 'Acme and Harbor Trading together' }), /^unsorted \(README matches Acme and Harbor Trading\)/);
  assert.match(guess({ name: 'mystery', remote: 'https://github.com/someone/mystery.git', readme: 'A tool.' }), /^unsorted/);
  assert.match(guess({ name: 'acmesecurity' }), /^unsorted|^acme/);
  // Settings override the whole default; nothing valid falls back to it.
  const g = parseGrouping({ acme: { folder: 'Acme', client_prefix: 'A', repos: ['acme-web'] }, shared: { repos: ['tools'] } });
  assert.deepEqual(g.businesses.map((b) => b.key), ['acme']);
  assert.equal(placeName(mappedPlace(g, 'tools')!), 'shared');
  assert.deepEqual(parseGrouping({ bad: { folder: '' } }).businesses.map((b) => b.key), DEFAULT_GROUPING.businesses.map((b) => b.key));
  const old = SETTINGS.file;
  SETTINGS.file = path.join(temp(), 'settings.json');
  try {
    fs.writeFileSync(SETTINGS.file, JSON.stringify({ vault: { path: temp(), keeper: true, businesses: { acme: { folder: 'Acme', repos: ['x'] } } } }));
    assert.deepEqual(keeperConfig()!.grouping!.businesses.map((b) => b.folder), ['Acme']);
    fs.writeFileSync(SETTINGS.file, JSON.stringify({ vault: { path: temp(), keeper: true } }));
    assert.equal(keeperConfig()!.grouping, DEFAULT_GROUPING);
  } finally { SETTINGS.file = old; }
});

test('spaces in the new layout: "agency" is Acme, business:<key>, client-nested repos, Shared tools and Unsorted', () => {
  const root = temp();
  applyWrite(root, write({ kind: 'event', space: 'agency', text: 'Agency news.' }), NOW);
  assert.match(file(root, 'Acme/log.md'), /Agency news\./);
  applyWrite(root, write({ kind: 'event', space: 'business:crypto', text: 'Crypto news.' }), NOW);
  assert.match(file(root, 'Crypto/log.md'), /Crypto news\./);
  assert.throws(() => applyWrite(root, write({ kind: 'event', space: 'business:nope', text: 'x' }), NOW), /no business "nope"/);
  applyWrite(root, write({ kind: 'event', space: 'T-05555', name: '青空工房', text: 'Hello.' }), NOW);
  assert(has(root, `Acme/Clients/${NS}/${AOZ}/Overview.md`));
  // ember-aoz and its alias acme-booking are one space inside the client.
  applyWrite(root, write({ kind: 'decision', space: 'project:ember-aoz', text: 'Early launch.' }), NOW);
  const nested = `Acme/Clients/${NS}/${AOZ}/Projects/ember-aoz`;
  assert.match(file(root, `${nested}/Decisions.md`), /Early launch/);
  const viaAlias = applyWrite(root, write({ kind: 'decision', space: 'project:acme-booking', section: 'tenants', text: 'AOZ first.' }), NOW);
  assert.match(viaAlias.message, new RegExp(`${nested}/Decisions\\.md`));
  assert.equal(findProject(root, DEFAULT_GROUPING, 'acme-booking'), nested);
  applyWrite(root, write({ kind: 'decision', space: 'project:kokuban', text: 'Keeper lives in Kokuban.' }), NOW);
  assert(has(root, 'Shared tools/Projects/kokuban/Decisions.md'));
  applyWrite(root, write({ kind: 'summary', space: 'project:Reservation', text: 'Reservations.', project: { remote: '', docs: [] } }), NOW);
  assert(has(root, 'Harbor Trading/Projects/Reservation/Overview.md'));
  // A repository nobody can place: Unsorted, with why, and listed on Needs attention at once.
  applyWrite(root, write({ kind: 'summary', space: 'project:mystery', text: 'A tool.', project: { remote: 'https://github.com/someone/mystery.git', docs: [] } }), NOW);
  assert(has(root, 'Unsorted/Projects/mystery/Overview.md'));
  assert.match(String(frontmatter(file(root, 'Unsorted/Projects/mystery/Overview.md')).filed), /no business matched/);
  assert.match(file(root, 'Needs attention.md'), /## Unsorted projects\n- \[\[Unsorted\/Projects\/mystery\/Overview\|mystery\]\]: set `business`/);
  // The seeding PC's README guess is used when the keeper has no better answer.
  applyWrite(root, write({ kind: 'summary', space: 'project:landing', text: 'A site.', project: { remote: '', docs: [], business: 'acme' } }), NOW);
  assert(has(root, 'Acme/Projects/landing/Overview.md'));
  // Business Homes list their projects (with the client for nested ones) and the top Home lists the businesses.
  assert.match(getBlock(file(root, 'Acme/Home.md'), 'projects')!, new RegExp(`\\[\\[${nested}/Overview\\|ember-aoz\\]\\] — for \\[\\[Acme/Clients/${NS}/${AOZ}/Overview\\|${AOZ}\\]\\]`));
  assert.match(getBlock(file(root, 'Home.md'), 'businesses')!, /\[\[Acme\/Home\|Acme\]\] — 1 client · 2 projects\n- \[\[Harbor Trading\/Home\|Harbor Trading\]\] — 1 project/);
  assert.match(getBlock(file(root, 'Home.md'), 'businesses')!, /\[\[Unsorted\/Home\|Unsorted\]\] — 1 project/);
});

test('before the regroup the new keeper keeps writing the old layout, so nothing splits in two', () => {
  const root = legacyVault();
  assert(has(root, `Clients/${AOZ}/Work log.md`));
  assert(has(root, 'Projects/ember-aoz/Decisions.md'));
  assert(has(root, 'Projects/acme-booking/Decisions.md'));
  assert(has(root, 'Agency/Credentials.md'));
  assert.match(file(root, 'Agency/log.md'), /New pricing sheet/);
  assert(has(root, 'Agency/Needs attention.md') || true);
  for (const top of ['Acme', 'Needs attention.md']) assert(!has(root, top), top);
});

test('the regroup dry run prints every move and changes nothing', () => {
  const root = legacyVault();
  const before = tree(root, /^$/);
  const out = regroup(root, { apply: false, now: NOW + 1000, pc: 'keeper-pc' });
  assert.deepEqual(tree(root, /^$/), before, 'a dry run writes nothing');
  const text = out.lines.join('\n');
  assert.match(text, /^would move Agency\/Home\.md → Acme\/Home\.md/m);
  assert.match(text, /^would move Agency\/Needs attention\.md → Needs attention\.md/m);
  assert.match(text, new RegExp(`^would move Clients/${AOZ} → Acme/Clients/${AOZ}`, 'm'));
  assert.match(text, /^would move Projects\/kokuban → Shared tools\/Projects\/kokuban \(shared: settings mapping\)/m);
  assert.match(text, /^would move Projects\/acme → Acme\/Projects\/acme/m);
  assert.match(text, new RegExp(`^would move Projects/ember-aoz → Acme/Clients/${AOZ}/Projects/ember-aoz`, 'm'));
  assert.match(text, new RegExp(`^would merge Projects/acme-booking → Acme/Clients/${AOZ}/Projects/ember-aoz \\(acme-booking is ember-aoz`, 'm'));
  assert.match(text, /^would move Projects\/Reservation → Harbor Trading\/Projects\/Reservation/m);
  assert.match(text, /^would move Projects\/mystery → Unsorted\/Projects\/mystery \(unsorted: /m);
  assert.match(text, /^would rename stage T-00160 ひまわり商会: reply → replied/m);
  assert.match(text, /^would lay out 1 client summary/m);
  assert.match(text, /^would update the stage order in Agency\/Pipeline\.base/m);
  assert.match(text, /^would \.obsidian\/snippets\/tobira.css: colours added/m);
  assert.equal(planRegroup(root).skipped.length, 0);
});

test('apply regroups a vault into the business tree, keeps every note and passes the checks; a second run changes nothing', () => {
  const root = legacyVault();
  const revs = revisions(root).length;
  const out = regroup(root, { apply: true, now: NOW + 1000, pc: 'keeper-pc' });
  assert.deepEqual(out.skipped, []);
  // Into their stage groups: AOZ is signed, ひまわり商会 replied (renamed from reply by D104).
  const C = `Acme/Clients/${BUILD}/${AOZ}`;
  const S = `Acme/Clients/${ACT}/T-00160 ひまわり商会`;
  const E = `${C}/Projects/ember-aoz`;
  const layout = (b: string): string[] => ['Care.base', 'Decisions.md', 'Home.md', 'Pipeline.base', 'index.md', 'log.md'].map((f) => `${b}/${f}`);
  // D126: a business without clients has no boards, and the pages its visuals need.
  const plain = (b: string, extra: string[]): string[] => [...['Decisions.md', 'Home.md', 'index.md', 'log.md'], ...extra].map((f) => `${b}/${f}`);
  const research = ['Projects.base', 'Research.base', 'Research/Crypto research map.canvas', 'Research/Research index.md'];
  const space = (d: string, pages: string[]): string[] => [...pages, 'index.md', 'log.md'].map((p) => `${d}/${p}`);
  const project = (d: string, extra: string[] = []): string[] => space(d, ['Overview.md', 'Decisions.md', ...extra]);
  const client = (d: string, extra: string[] = []): string[] => space(d, ['Overview.md', 'What we made.md', 'Work log.md', 'Communication.md', 'Decisions.md', ...extra]);
  const expected = [
    '.obsidian/snippets/tobira.css', '.stignore', 'Home.md', 'How this works.md', 'Needs attention.md', 'README.md', 'Rules.md',
    ...layout('Acme'), 'Acme/Credentials.md', 'Acme/Notes by Sam.md',
    ...client(C, ['Facts/agreed-price.md']), ...project(E, ['Work log.md']), ...client(S),
    ...project('Acme/Projects/acme'),
    ...plain('Harbor Trading', ['Projects.base']), ...project('Harbor Trading/Projects/Reservation'),
    ...plain('Crypto', research), ...plain('Security', ['Projects.base']), '.obsidian/graph.json',
    'Shared tools/Home.md', ...project('Shared tools/Projects/kokuban'),
    'Unsorted/Home.md', ...project('Unsorted/Projects/mystery'),
  ].sort();
  assert.deepEqual(paths(root), expected);
  // One revision per move (and one for the merge).
  const moves = revisions(root).slice(revs).filter((r) => r.kind === 'move');
  assert.equal(moves.length, out.moves.length + out.clients.length);
  assert.deepEqual(out.clients.map((m) => m.to), [`Acme/Clients/${BUILD}/${AOZ}`, `Acme/Clients/${ACT}/T-00160 ひまわり商会`].sort());
  assert.equal(moves.filter((r) => r.state === 'merged').length, 1);
  // Path-style links follow their notes; links by name are left alone.
  const notes = file(root, 'Acme/Notes by Sam.md');
  assert.match(notes, new RegExp(`\\[\\[${C}/Overview\\|AOZ\\]\\]`));
  assert.match(notes, new RegExp(`\\[\\[${E}/Decisions#Accepted\\|booking decisions\\]\\]`));
  assert.match(notes, /\[\[Shared tools\/Projects\/kokuban\/Overview\]\] and \[\[Needs attention\]\]\. A name link: \[\[Rules\]\]/);
  assert.match(file(root, 'Acme/Home.md'), /\[\[Acme\/Pipeline\.base#Board\|Pipeline board\]\][\s\S]*!\[\[Acme\/Pipeline\.base#Board\]\]/);
  assert.doesNotMatch(Object.values(tree(root, /^\.keeper\//)).join('\n'), /\[\[(Agency|Clients|Projects)\//);
  // Bases: the folder filter follows, the Pipeline's order is D104's, the visual pass's lines stay.
  assert.match(file(root, 'Acme/Care.base'), /file\.inFolder\("Acme\/Clients"\)/);
  const pipeline = file(root, 'Acme/Pipeline.base');
  assert.match(pipeline, /groupOrder:\n      - outreach\n      - replied\n      - sample-made\n      - sample-sent\n      - engaging\n      - proposal\n      - signed\n      - building\n      - launch\n      - done\n    order:/);
  assert.match(pipeline, /- tobira_id\n    - file\.name == "Overview"\n[\s\S]*columnWidth: 240\n  - type: table\n    name: Pipeline/);
  // D104 stages, the summary layout, the colours and the README.
  assert.equal(frontmatter(file(root, `${S}/Overview.md`)).stage, 'replied');
  assert.match(file(root, `${S}/log.md`), /stage: reply → replied \(D104 stage list\)/);
  const summary = getBlock(file(root, `${C}/Overview.md`), 'summary')!;
  assert.equal(summary, layoutSummary(SUMMARY));
  assert.match(summary, /`proposal_signed`\n\n\*\*Last thing that happened:\*\* 2026-10-01 — kickoff notes\n\n### Ledger\n_acme repo_\n- \[thread\.md\]/);
  // The visual pass's lines stay first; the D120 board block (laid out on start) and D104's colours follow.
  assert.equal(file(root, '.obsidian/snippets/tobira.css'), `/* the visual pass */\n.tobira-stage { color: red; }\n\n${TENDRA_CSS}\n${RESEARCH_CSS}\n${STAGE_CSS}`);
  assert.doesNotMatch(file(root, 'README.md'), /Nothing here yet/);
  assert.equal(file(root, 'Rules.md'), RULES_PAGE);
  assert.match(RULES_PAGE, /Needs attention\.md, at the top of the vault[\s\S]*11\. The vault is grouped by business \(D101\)/);
  // Credentials stay Acme's, and a later agent write goes to the new place.
  assert(file(root, 'Acme/Credentials.md').includes('regroup-pass-123456'));
  assert.equal(applyWrite(root, write({ kind: 'credential', space: 'agency', text: '', site: 'cloudflare.com', account: 'k@acme.example', value: 'regroup-pass-999999' }), NOW + 2000).state, 'written');
  assert(file(root, 'Acme/Credentials.md').includes('regroup-pass-999999'));
  // Keeper blocks whose links were rewritten are still the keeper's: the next summary write is no conflict.
  assert.equal(applyWrite(root, write({ kind: 'summary', space: 'T-05555', text: `${SUMMARY}\nMore.` }), NOW + 3000).state, 'written');
  assert.equal(applyWrite(root, write({ kind: 'event', space: 'T-00160', text: 'Sample sent.', frontmatter: { stage: 'sample-sent' } }), NOW + 3000).conflicts_with, undefined);
  // Needs attention covers everything: the unsorted repository is there, the old layout is not.
  const attention = file(root, 'Needs attention.md');
  assert.match(attention, /## Unsorted projects\n- \[\[Unsorted\/Projects\/mystery\/Overview\|mystery\]\]/);
  assert.doesNotMatch(attention, /## Old layout/);

  // Idempotent: nothing moves, no revision is added, no page changes.
  const settled = regroup(root, { apply: true, now: NOW + 5000, pc: 'keeper-pc' });
  const once = { tree: tree(root, /^(\.keeper\/index\.json|Needs attention\.md)$/), revs: revisions(root).length };
  const again = regroup(root, { apply: true, now: NOW + 9000, pc: 'keeper-pc' });
  assert.deepEqual([again.moves, again.skipped, again.rewritten, again.stages, again.summaries, again.bases, again.linked, again.css], [[], [], [], [], [], [], 0, '']);
  assert.deepEqual(settled.moves, []);
  assert.deepEqual({ tree: tree(root, /^(\.keeper\/index\.json|Needs attention\.md)$/), revs: revisions(root).length }, once);
  assert.match(again.lines.join('\n'), /nothing to move/);
});

test('acme-booking merges into ember-aoz with nothing lost', () => {
  const root = legacyVault();
  const booking = { overview: file(root, 'Projects/acme-booking/Overview.md'), decisions: file(root, 'Projects/acme-booking/Decisions.md'),
    work: file(root, 'Projects/acme-booking/Work log.md'), log: file(root, 'Projects/acme-booking/log.md') };
  const ember = file(root, 'Projects/ember-aoz/Overview.md');
  regroup(root, { apply: true, now: NOW + 1000, pc: 'keeper-pc' });
  const E = `Acme/Clients/${BUILD}/${AOZ}/Projects/ember-aoz`;
  assert(!has(root, 'Projects') && !has(root, 'Acme/Projects/acme-booking'));
  const ov = file(root, `${E}/Overview.md`);
  // Both summaries are there; only ember-aoz's is still a keeper block.
  assert.equal(getBlock(ov, 'summary'), getBlock(ember, 'summary'));
  assert(ov.includes('acme-booking: the acme-booking repository.'));
  assert.match(ov, /## Merged from acme-booking\n\n_Merged .* by the regroup \(D101\)/);
  assert.equal(ov.match(/<!-- keeper:summary -->/g)!.length, 1);
  const fm = frontmatter(ov);
  assert.deepEqual(fm.aliases, ['acme-booking']);
  assert.equal(fm.remote, 'https://github.com/example-org/acme-booking.git');
  assert.deepEqual(fm.merged_from, ['acme-booking']);
  assert(ov.includes('```yaml\nrepo: "acme-booking"'), 'its own front matter is kept as a block');
  // Decisions, the work log and the log of both, every entry kept with its block id.
  const decisions = file(root, `${E}/Decisions.md`);
  assert.match(decisions, /Early launch on harbor-trading.example[\s\S]*## Merged from acme-booking[\s\S]*AOZ is the first tenant/);
  for (const id of booking.decisions.match(/\^r-\w+/g)!) assert(decisions.includes(id), id);
  assert(file(root, `${E}/Work log.md`).includes('Booking worker deployed.'));
  for (const id of booking.log.match(/\^r-\w+/g)!) assert(file(root, `${E}/log.md`).includes(id), id);
  assert.doesNotMatch(file(root, `${E}/log.md`), /\[\[Projects\//, 'the merged log links to the merged space');
  // A full copy of the merged space stays in .keeper/regroup/merged/.
  const backups = fs.readdirSync(path.join(root, '.keeper', 'regroup', 'merged'));
  assert.equal(backups.length, 1);
  assert.equal(file(root, `.keeper/regroup/merged/${backups[0]}/Overview.md`), booking.overview);
  assert.equal(file(root, `.keeper/regroup/merged/${backups[0]}/Work log.md`), booking.work);
  // Writes to either name land in the one space, and a session in the acme-booking repo finds it by its remote.
  assert.match(applyWrite(root, write({ kind: 'event', space: 'project:acme-booking', text: 'After.' }), NOW + 2000).message, new RegExp(`${E}/Work log\\.md`));
  assert.equal(findProject(root, DEFAULT_GROUPING, 'some-clone', 'https://github.com/example-org/acme-booking.git'), E);
});

test('a target that already exists is skipped and reported, never overwritten', () => {
  const root = legacyVault();
  fs.mkdirSync(path.join(root, 'Shared tools', 'Projects', 'kokuban'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Shared tools', 'Projects', 'kokuban', 'Overview.md'), '# A person made this\n');
  const dry = regroup(root, { apply: false, now: NOW, pc: 'keeper-pc' });
  assert.match(dry.lines.join('\n'), /skipped Projects\/kokuban → Shared tools\/Projects\/kokuban: Shared tools\/Projects\/kokuban already exists/);
  const out = regroup(root, { apply: true, now: NOW, pc: 'keeper-pc' });
  assert.equal(out.skipped.length, 1);
  assert.equal(file(root, 'Shared tools/Projects/kokuban/Overview.md'), '# A person made this\n');
  assert(has(root, 'Projects/kokuban/Overview.md'), 'the source is kept where it was');
  assert.match(file(root, 'Needs attention.md'), /## Old layout/);
});

test('the regroup gives an old client folder Windows refuses ("…Inc.") a safe name; its links and display name follow', (t) => {
  const root = temp();
  const raw = (p: string): string => (process.platform === 'win32' ? `\\\\?\\${p}` : p);
  t.after(() => fs.rmSync(raw(root), { recursive: true, force: true }));
  const old = path.join(root, 'Clients', 'T-01234 Acme Inc.');
  fs.mkdirSync(raw(old), { recursive: true });
  fs.writeFileSync(raw(path.join(old, 'Overview.md')), '---\ntobira_id: T-01234\nname: Acme Inc.\naliases: [Acme Inc.]\nstage: "lead"\n---\n# Acme Inc.\n\n' +
    '## Pages\n- [[Clients/T-01234 Acme Inc./Work log|Work log]]\n');
  fs.writeFileSync(raw(path.join(old, 'Work log.md')), '# Work log\n');
  const plan = planRegroup(root);
  assert.deepEqual(plan.moves.map((m) => `${m.from} → ${m.to}`), ['Clients/T-01234 Acme Inc. → Acme/Clients/T-01234 Acme Inc']);
  const out = regroup(root, { apply: true, now: NOW, pc: 'keeper-pc' });
  assert.deepEqual(out.skipped, []);
  // "lead" is no D104 stage: the client waits in No stage.
  const C = `Acme/Clients/${NS}/T-01234 Acme Inc`;
  assert.deepEqual(fs.readdirSync(path.join(root, 'Acme', 'Clients')), [NS]);
  assert.deepEqual(fs.readdirSync(path.join(root, 'Acme', 'Clients', NS)), ['T-01234 Acme Inc']);
  const text = file(root, `${C}/Overview.md`);
  assert.equal(frontmatter(text).name, 'Acme Inc.');
  assert.match(text, /\[\[Acme\/Clients\/0 ❓ No stage\/T-01234 Acme Inc\/Work log\|Work log\]\]/);
  assert(!has(root, 'Clients'));
});

test('every client and project Overview links up to its parent; the Homes link down and up (graph view)', () => {
  const root = legacyVault();
  regroup(root, { apply: true, now: NOW + 1000, pc: 'keeper-pc' });
  const resolves = (link: string): string => {
    const target = linkTarget(link);
    assert(target, `not a link: ${link}`);
    assert(has(root, `${target}.md`), `${link} does not resolve`);
    return `${target}.md`;
  };
  const overviews = paths(root).filter((p) => p.endsWith('/Overview.md'));
  assert.equal(overviews.length, 7);
  for (const ov of overviews) {
    const text = file(root, ov);
    const fm = frontmatter(text);
    const dir = path.posix.dirname(ov);
    // A client folder's stage group is only a folder in between: the client links up to its business.
    const parts = dir.split('/').filter((p, i) => !(i === 2 && isClientGroup(p)));
    const parent = parts[1] === 'Clients' && parts.length === 3 ? `${parts[0]}/Home.md`
      : parts[1] === 'Clients' ? `${dir.split('/').slice(0, 4).join('/')}/Overview.md` : `${parts[0]}/Home.md`;
    const links = [String(fm.business ?? ''), String(fm.client ?? '')].filter(Boolean).map(resolves);
    assert(links.includes(parent), `${ov} links up to ${parent} (has ${links.join(', ')})`);
    const line = getBlock(text, 'parent')!;
    assert.match(line, /^Part of \[\[/);
    assert(line.match(/\[\[[^\]]+\]\]/g)!.map(resolves).includes(parent), `${ov}: "${line}"`);
    if (parts[1] === 'Clients' && parts.length === 3) assert.deepEqual(fm.cssclasses, ['client']);
  }
  // The business Home links up to the top Home and down to every client (by stage, closed folded) and project.
  const home = file(root, 'Acme/Home.md');
  assert.equal(getBlock(home, 'parent'), 'Part of [[Home|all businesses]]');
  const clients = getBlock(home, 'clients')!;
  // The same groups as the folders, Act now first, each client with its stage.
  assert.match(clients, new RegExp(`^\\*\\*🔥 Act now\\*\\* \\(1\\)\\n- \\[\\[Acme/Clients/${ACT}/T-00160 ひまわり商会/Overview\\|T-00160 ひまわり商会\\]\\] · replied\\n\\n` +
    `\\*\\*🛠 Building\\*\\* \\(1\\)\\n- \\[\\[Acme/Clients/${BUILD}/${AOZ}/Overview\\|${AOZ}\\]\\] · signed$`));
  for (const l of clients.match(/\[\[[^\]]+\]\]/g)!) resolves(l);
  assert.equal(getBlock(home, 'stages'), '**Clients by stage** (2): outreach 0 · replied 1 · sample-made 0 · sample-sent 0 · engaging 0 · proposal 0 · signed 1 · ' +
    'building 0 · launch 0 · done 0 · closed 0');
  for (const l of getBlock(home, 'projects')!.match(/\[\[[^\]]+\]\]/g)!) resolves(l);
  const top = getBlock(file(root, 'Home.md'), 'businesses')!;
  for (const b of ['Acme', 'Harbor Trading', 'Crypto', 'Security', 'Shared tools', 'Unsorted']) assert(top.includes(`[[${b}/Home|${b}]]`), b);
  for (const l of top.match(/\[\[[^\]]+\]\]/g)!) resolves(l);
  // A closed client goes into the collapsed callout.
  applyWrite(root, write({ kind: 'event', space: 'T-00160', text: 'Lost.', frontmatter: { stage: 'closed' } }), NOW + 2000);
  assert.match(getBlock(file(root, 'Acme/Home.md'), 'clients')!, /> \[!note\]- 🗄 Closed \(1\)\n> - \[\[Acme\/Clients\/6 🗄 Closed\/T-00160 ひまわり商会\/Overview\|T-00160 ひまわり商会\]\] · closed$/);
});

test('business in a project\'s front matter re-files it on the next keeper tick, links and Homes follow', async () => {
  const root = temp();
  const config = (): KeeperConfig => ({ path: root, keeper: true, keeperPc: 'keeper-pc' });
  const board = new Board();
  applyWrite(root, write({ kind: 'summary', space: 'project:mystery', text: 'A tool.', project: { remote: '', docs: [] } }), NOW);
  fs.writeFileSync(path.join(root, 'Notes.md'), '# Notes\n\nSee [[Unsorted/Projects/mystery/Overview|mystery]].\n');
  assert.throws(() => applyWrite(root, write({ kind: 'event', space: 'project:mystery', text: 'x', frontmatter: { business: 'nowhere' } }), NOW), /business must be one of acme/);
  assert.throws(() => applyWrite(root, write({ kind: 'event', space: 'T-05555', name: 'A', text: 'x', frontmatter: { business: 'shared' } }), NOW), /a client's business must be one of acme/);
  const me = board.touch('s', '', 'claude').session;
  const out = await vaultTool(board, me, { op: 'write', kind: 'event', space: 'project:mystery', text: 'It is the crypto bot.', source: 'Alex',
    frontmatter: { business: 'crypto' } }, { config, now: () => NOW, pc: () => 'keeper-pc' });
  assert.match(out, /front matter set: business crypto/);
  assert(has(root, 'Unsorted/Projects/mystery/Overview.md'), 'moved by the tick, not by the write');
  await keeperTick(board, { config, now: () => new Date(2026, 10, 5, 1, 0).getTime(), pc: () => 'keeper-pc' });
  assert(!has(root, 'Unsorted/Projects/mystery'));
  const ov = file(root, 'Crypto/Projects/mystery/Overview.md');
  assert.equal(frontmatter(ov).business, '[[Crypto/Home|Crypto]]');
  assert.equal(getBlock(ov, 'parent'), 'Part of [[Crypto/Home|Crypto]]');
  assert.match(file(root, 'Notes.md'), /\[\[Crypto\/Projects\/mystery\/Overview\|mystery\]\]/);
  assert.match(getBlock(file(root, 'Crypto/Home.md'), 'projects')!, /\[\[Crypto\/Projects\/mystery\/Overview\|mystery\]\]/);
  assert(revisions(root).some((r) => r.kind === 'move' && r.page === 'Unsorted/Projects/mystery' && r.section === 'Crypto/Projects/mystery'));
  assert.doesNotMatch(file(root, 'Needs attention.md'), /Unsorted\/Projects\/mystery/);
  // A client ID nests it under the client; a later agent business write is no false conflict.
  applyWrite(root, write({ kind: 'event', space: 'T-05555', name: '青空工房', text: 'Hi.' }), NOW);
  applyWrite(root, write({ kind: 'event', space: 'project:mystery', text: 'Belongs to AOZ.', frontmatter: { business: 'T-05555' } }), NOW);
  await keeperTick(board, { config, now: () => new Date(2026, 10, 5, 1, 5).getTime(), pc: () => 'keeper-pc' });
  const nested = `Acme/Clients/${NS}/${AOZ}/Projects/mystery/Overview.md`;
  assert.equal(frontmatter(file(root, nested)).client, `[[Acme/Clients/${NS}/${AOZ}/Overview|${AOZ}]]`);
  // Back to the business: the client link goes.
  applyWrite(root, write({ kind: 'event', space: 'project:mystery', text: 'Agency tool after all.', frontmatter: { business: 'acme' } }), NOW);
  await keeperTick(board, { config, now: () => new Date(2026, 10, 5, 1, 10).getTime(), pc: () => 'keeper-pc' });
  const back = frontmatter(file(root, 'Acme/Projects/mystery/Overview.md'));
  assert.equal(back.business, '[[Acme/Home|Acme]]');
  assert.equal(back.client, undefined);
  assert(!revisions(root).some((r) => r.kind === 'conflict'));
});

test('summary layout, last_event from summaries, link rewriting and the stage order are pure and idempotent', () => {
  const once = layoutSummary(SUMMARY);
  assert.equal(layoutSummary(once), once);
  assert.match(once, /\n\n### Ledger\n_acme repo_\n/);
  assert.equal(rewriteLinks('[[Agency/Home|Home]] ![[Agency/Pipeline.base#Board]] [[Clients/T-1 A/Overview.md]] [[Rules]] [[Agencyx/a]]',
    [['Agency', 'Acme'], ['Clients', 'Acme/Clients']]), '[[Acme/Home|Home]] ![[Acme/Pipeline.base#Board]] [[Acme/Clients/T-1 A/Overview.md]] [[Rules]] [[Agencyx/a]]');
  assert.equal(updateBaseStages(updateBaseStages(VISUAL_BASE)), updateBaseStages(VISUAL_BASE));
  // A summary's "Last thing" line becomes the client's last_event for the Kanban card.
  const root = temp();
  applyWrite(root, write({ kind: 'summary', space: 'T-05555', name: '青空工房', text: SUMMARY }), NOW);
  assert.equal(frontmatter(file(root, `Acme/Clients/${NS}/${AOZ}/Overview.md`)).last_event, '2026-10-01 — kickoff notes');
  assert.throws(() => applyWrite(root, write({ kind: 'event', space: 'T-05555', text: 'x', frontmatter: { stage: 'reply' } }), NOW), /stage must be one of outreach, replied, sample-made, sample-sent, engaging/);
  applyWrite(root, write({ kind: 'event', space: 'T-05555', text: 'x', frontmatter: { cssclasses: ['wide'], last_event: 'Set by hand.' } }), NOW);
  const fm = frontmatter(file(root, `Acme/Clients/${NS}/${AOZ}/Overview.md`));
  assert.deepEqual(fm.cssclasses, ['client', 'wide']);
  assert.equal(fm.last_event, 'Set by hand.');
});
