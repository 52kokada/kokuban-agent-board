import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  HOW, HOW_PAGE, HOW_PAGE_V2, README_PAGE, README_V3, RULES_PAGE, RULES_V6, applyWrite, checkup, ensureLayout, frontmatter, getBlock, keeperBoard, refreshHomes, revisions, useGrouping, validateWrite, vaultTool,
  type WriteRequest,
} from '../src/vault-keeper.js';
import { DEFAULT_BUSINESSES, DEFAULT_GROUPING, parseGrouping } from '../src/vault-layout.js';
import { RESEARCH_INDEX, mapName, parseCanvas, topicTag } from '../src/vault-research.js';
import { RESEARCH_CSS, RESEARCH_GROUP, boardsOf, classicBoards, ensureResearchGraph, visualsOf, withResearchCss } from '../src/vault-visuals.js';
import { SNIPPET_FILE } from '../src/vault-tendra.js';

const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-visuals-'));
const NOW = Date.parse('2026-11-05T10:00:00Z');
const file = (root: string, rel: string): string => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const has = (root: string, rel: string): boolean => fs.existsSync(path.join(root, ...rel.split('/')));
const put = (root: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, ...rel.split('/'))), { recursive: true });
  fs.writeFileSync(path.join(root, ...rel.split('/')), text);
};
let n = 0;
const research = (fields: Partial<WriteRequest>): WriteRequest => ({
  request_id: `visual-test-${++n}`, kind: 'research', source: 'crypto repo research/INDEX.md', author: { agent: 'Rio', pc: 'pc-c', person: 'Alex' },
  space: 'business:crypto', topic: 'Memecoins', text: 'Most memecoins lose their value within days.', ...fields,
});
/** The default businesses, with Crypto and Security given boards (the vault before D126). */
const withBoards = (): ReturnType<typeof parseGrouping> => parseGrouping({
  ...DEFAULT_BUSINESSES,
  crypto: { ...DEFAULT_BUSINESSES.crypto, boards: ['pipeline', 'care'], visuals: ['pipeline'] },
  security: { ...DEFAULT_BUSINESSES.security, boards: ['pipeline', 'care'], visuals: ['pipeline'] },
});

test('boards only where a business has clients; each Home shows its own visuals (D126)', () => {
  const root = temp();
  ensureLayout(root);
  // Acme: both boards and the classic Home, exactly as before.
  for (const f of ['Pipeline.base', 'Care.base']) assert(has(root, `Acme/${f}`), f);
  assert(file(root, 'Acme/Home.md').includes(classicBoards('Acme')));
  assert.equal(getBlock(file(root, 'Acme/Home.md'), 'visuals'), null);
  // No clients: no boards anywhere else.
  for (const b of ['Crypto', 'Security', 'Harbor Trading']) for (const f of ['Pipeline.base', 'Care.base']) assert(!has(root, `${b}/${f}`), `${b}/${f}`);
  const crypto = file(root, 'Crypto/Home.md');
  assert.doesNotMatch(crypto, /## Boards|## Clients|Pipeline\.base/);
  const v = getBlock(crypto, 'visuals')!;
  assert.match(v, /## Direction[\s\S]*## Research\n!\[\[Crypto\/Research\.base#Cards\]\][\s\S]*### Recent\n!\[\[Crypto\/Research\.base#Recent\]\][\s\S]*## Research map\n> \[!example\] \[\[Crypto\/Research\/Crypto research map\.canvas\|Crypto research map\]\][\s\S]*## Project status\n!\[\[Crypto\/Projects\.base#Status\]\]/);
  assert.match(v, /\[\[Crypto\/Research\/Research index\|Research index\]\]/);
  for (const f of ['Crypto/Research.base', 'Crypto/Projects.base', `Crypto/Research/${RESEARCH_INDEX}`, `Crypto/Research/${mapName('Crypto')}`]) assert(has(root, f), f);
  // Security: the project status board and nothing else; never research or clients.
  const sec = getBlock(file(root, 'Security/Home.md'), 'visuals')!;
  assert.equal(sec, '[[Security/Decisions|Decisions]] · [[Needs attention]] · [[Rules]]\n\n## Project status\n![[Security/Projects.base#Status]]');
  assert.match(file(root, 'Security/Projects.base'), /file\.inFolder\("Security\/Projects"\)/);
  assert.doesNotMatch(file(root, 'Security/Projects.base'), /summary|Work log/);
  // Idempotent.
  const before = file(root, 'Crypto/Home.md');
  ensureLayout(root);
  refreshHomes(root);
  assert.equal(file(root, 'Crypto/Home.md'), before);
});

test('a business that gains a client gains its boards and a client board on its Home', () => {
  const root = temp();
  ensureLayout(root);
  put(root, 'Harbor Trading/Clients/1 🔥 Act now/T-00650 ホテル/Overview.md', '---\ntobira_id: "T-00650"\nstage: "engaging"\n---\n# ホテル\n');
  assert.deepEqual(boardsOf(root, DEFAULT_GROUPING, DEFAULT_GROUPING.businesses.find((b) => b.key === 'harbor-trading')!), ['pipeline', 'care']);
  ensureLayout(root);
  assert(has(root, 'Harbor Trading/Pipeline.base') && has(root, 'Harbor Trading/Care.base'));
  refreshHomes(root);
  const home = file(root, 'Harbor Trading/Home.md');
  assert.match(getBlock(home, 'visuals')!, /^\[\[Harbor Trading\/Pipeline\.base#Board\|Pipeline board\]\] · \[\[Harbor Trading\/Care\.base#Board\|Care board\]\][\s\S]*## Client board\n!\[\[Harbor Trading\/Pipeline\.base#Pipeline\]\][\s\S]*## Project status/);
  assert.match(home, /## Clients\n<!-- keeper:clients -->\n\*\*🔥 Act now\*\* \(1\)/);
});

test('unedited keeper boards of a business without clients move to .trash with a revision; an edited one stays and is listed', () => {
  const root = temp();
  useGrouping(root, withBoards());
  try {
    ensureLayout(root);
    assert(has(root, 'Crypto/Pipeline.base') && has(root, 'Security/Care.base'));
    assert(file(root, 'Crypto/Home.md').includes(classicBoards('Crypto')));
    // A person changed Security's Care board.
    put(root, 'Security/Care.base', `${file(root, 'Security/Care.base')}# mine\n`);
    assert(keeperBoard(file(root, 'Crypto/Pipeline.base'), 'Crypto', 'pipeline'));
    assert(!keeperBoard(file(root, 'Security/Care.base'), 'Security', 'care'));
  } finally {
    useGrouping(root, null);
  }
  ensureLayout(root);
  for (const f of ['Crypto/Pipeline.base', 'Crypto/Care.base', 'Security/Pipeline.base']) {
    assert(!has(root, f), f);
    assert(has(root, `.trash/${f}`), `.trash/${f}`);
  }
  assert(has(root, 'Security/Care.base'));
  const moves = revisions(root).filter((r) => r.kind === 'move' && r.state === 'trashed');
  assert.deepEqual(moves.map((r) => `${r.space} ${r.page}`).sort(), ['business:crypto Care.base', 'business:crypto Pipeline.base', 'business:security Pipeline.base']);
  // The keeper's Boards section became the visuals block; the empty Clients section went.
  const home = file(root, 'Crypto/Home.md');
  assert(!home.includes('## Boards') && !home.includes('## Clients'));
  assert.match(home, /<!-- keeper:visuals -->\n\[\[Crypto\/Decisions\|Decisions\]\]/);
  const found = checkup(root, NOW);
  assert.equal(found.Boards!.length, 1);
  assert.match(found.Boards![0]!, /\[\[Security\/Care\.base\]\]: Security has no clients, so no care board \(D126\), but a person changed this one/);
  // Running again moves nothing more.
  ensureLayout(root);
  assert.equal(revisions(root).filter((r) => r.kind === 'move').length, 3);
});

test('a person-edited Home keeps its text and gains the visuals block; settings choose boards and visuals', () => {
  const root = temp();
  useGrouping(root, withBoards());
  ensureLayout(root);
  useGrouping(root, null);
  put(root, 'Crypto/Home.md', file(root, 'Crypto/Home.md').replace('- [[Rules]]\n', '- [[Rules]]\n- my own link\n'));
  ensureLayout(root);
  const home = file(root, 'Crypto/Home.md');
  assert.match(home, /- my own link\n/);
  assert.match(home, /<!-- keeper:visuals -->[\s\S]*<!-- \/keeper:visuals -->\n\n## Projects/);
  assert.match(checkup(root, NOW).Boards!.join('\n'), /Crypto Home\]\] still links to its pipeline board/);
  const g = parseGrouping({ x: { folder: 'X', boards: ['care', 'bogus'], visuals: ['research', 'nope', 'Projects'] }, y: { folder: 'Y', client_prefix: 'Y', boards: [] } });
  assert.deepEqual(g.businesses[0]!.boards, ['care']);
  assert.deepEqual(visualsOf(g.businesses[0]!), ['research', 'projects']);
  assert.deepEqual(boardsOf(root, g, g.businesses[1]!), []);
  assert.deepEqual(visualsOf(DEFAULT_GROUPING.businesses.find((b) => b.key === 'crypto')!), ['direction', 'research', 'research-map', 'projects']);
});

test('a research write makes a note with its front matter, links, index and map; an update merges', () => {
  const root = temp();
  ensureLayout(root);
  applyWrite(root, { request_id: 'seed-crypto-1', kind: 'summary', space: 'project:crypto', text: 'Research workspace.\nDirection (accepted, 2026-11-02):\n- Paper first.\n- Free data only.',
    source: 'README', author: { agent: 'Rio', pc: 'pc-c' } }, NOW);
  const a = applyWrite(root, research({ name: 'Memecoin launch patterns', status: 'current', date: '2026-11-03', confidence: 'medium',
    sources: ['https://example.org/memecoins'], related: ['Custody options', 'project:crypto'] }), NOW);
  assert.equal(a.state, 'written');
  assert.equal(a.page, 'Research/Memecoin launch patterns.md');
  const rel = 'Crypto/Research/Memecoin launch patterns.md';
  const text = file(root, rel);
  const fm = frontmatter(text);
  assert.deepEqual(fm.tags, ['research', 'memecoins']);
  assert.equal(fm.topic, 'Memecoins');
  assert.equal(fm.status, 'current');
  assert.equal(fm.date, '2026-11-03');
  assert.equal(fm.confidence, 'medium');
  assert.deepEqual(fm.sources, ['https://example.org/memecoins']);
  assert.deepEqual(fm.related, ['[[Crypto/Research/Custody options|Custody options]]', '[[Crypto/Projects/crypto/Overview|crypto]]']);
  assert.equal(getBlock(text, 'summary'), 'Most memecoins lose their value within days.');
  assert.equal(getBlock(text, 'parent'), 'Part of [[Crypto/Research/Research index|Crypto research]] · topic: Memecoins');
  assert.equal(getBlock(text, 'sources'), '- <https://example.org/memecoins>');
  assert.match(getBlock(text, 'related')!, /\[\[Crypto\/Projects\/crypto\/Overview\|crypto\]\]/);
  // Written from a project space: the note links back to that project; a new note is a draft dated today.
  const b = applyWrite(root, research({ space: 'project:crypto', topic: 'Custody & taxes', name: 'Custody options', text: 'Self-custody versus exchanges.' }), NOW);
  assert.equal(b.state, 'written');
  const bfm = frontmatter(file(root, 'Crypto/Research/Custody options.md'));
  assert.equal(bfm.status, 'draft');
  assert.equal(bfm.date, '2026-11-05');
  assert.deepEqual(bfm.tags, ['research', topicTag('Custody & taxes')]);
  assert.equal(topicTag('Custody & taxes'), 'custody-taxes');
  assert.deepEqual(bfm.related, ['[[Crypto/Projects/crypto/Overview|crypto]]']);
  // The index lists both by topic; the business log has the writes.
  const index = getBlock(file(root, `Crypto/Research/${RESEARCH_INDEX}`), 'research')!;
  assert.match(index, /### Custody & taxes \(1\)\n- \[\[Crypto\/Research\/Custody options\|Custody options\]\] · draft · 2026-11-05\n\n### Memecoins \(1\)\n- \[\[Crypto\/Research\/Memecoin launch patterns\|Memecoin launch patterns\]\] · current · 2026-11-03 · confidence medium/);
  assert.match(file(root, 'Crypto/log.md'), /research \[\[Crypto\/Research\/Memecoin launch patterns\|Research\/Memecoin launch patterns\]\]/);
  // The map: topics, notes and the related edge between the two research notes.
  const map = parseCanvas(file(root, `Crypto/Research/${mapName('Crypto')}`))!;
  assert.deepEqual(map.nodes.filter((x) => x.type === 'file').map((x) => x.file).sort(), ['Crypto/Research/Custody options.md', 'Crypto/Research/Memecoin launch patterns.md']);
  assert.equal(map.nodes.filter((x) => x.id.startsWith('topic-')).length, 2);
  assert.equal(map.edges.filter((e) => e.label === 'related').length, 1);
  // The Home shows the direction and the count.
  const home = getBlock(file(root, 'Crypto/Home.md'), 'visuals')!;
  assert.match(home, /> \[!abstract\] From \[\[Crypto\/Projects\/crypto\/Overview\|crypto\]\]\n> Direction \(accepted, 2026-11-02\):\n> - Paper first\.\n> - Free data only\./);
  assert.match(home, /2 notes in 2 topics\./);
  // An update replaces the summary and merges the lists; the same write again is unchanged.
  const c = applyWrite(root, research({ name: 'Memecoin launch patterns', text: 'Updated view.', sources: ['https://example.org/second'], related: ['[[Some note]]'] }), NOW + 1000);
  assert.equal(c.state, 'written');
  const cfm = frontmatter(file(root, rel));
  assert.deepEqual(cfm.sources, ['https://example.org/memecoins', 'https://example.org/second']);
  assert.equal((cfm.related as string[]).length, 3);
  assert.equal(cfm.status, 'current');
  assert.equal(cfm.date, '2026-11-03');
  assert.equal(applyWrite(root, research({ name: 'Memecoin launch patterns', text: 'Updated view.' }), NOW + 2000).state, 'unchanged');
});

test('research keeps a person\'s edits: summary and status conflicts, and a rearranged map', () => {
  const root = temp();
  ensureLayout(root);
  applyWrite(root, research({ name: 'A', status: 'draft' }), NOW);
  const rel = 'Crypto/Research/A.md';
  // A person changed the status and moved a node on the map.
  put(root, rel, file(root, rel).replace('status: "draft"', 'status: "superseded"'));
  const mapRel = `Crypto/Research/${mapName('Crypto')}`;
  const map = parseCanvas(file(root, mapRel))!;
  map.nodes[0]!.x = 9999;
  put(root, mapRel, JSON.stringify(map));
  const out = applyWrite(root, research({ name: 'A', status: 'current', text: 'New text.' }), NOW + 1000);
  assert.equal(out.state, 'written');
  assert.match(out.message, /a person changed status/);
  assert.equal(frontmatter(file(root, rel)).status, 'superseded');
  assert.equal(getBlock(file(root, rel), 'summary'), 'New text.');
  assert(revisions(root).some((r) => r.kind === 'conflict' && r.block === 'frontmatter:status' && r.page === 'Research/A.md'));
  // A new note is added to the person's map; their move stays.
  applyWrite(root, research({ name: 'B', topic: 'Custody' }), NOW + 2000);
  const after = parseCanvas(file(root, mapRel))!;
  assert.equal(after.nodes[0]!.x, 9999);
  assert(after.nodes.some((x) => x.file === 'Crypto/Research/B.md'));
  // A person's summary edit: their text stays, the agent's becomes a proposal.
  put(root, rel, file(root, rel).replace('New text.', 'Alex\'s words.'));
  const conflict = applyWrite(root, research({ name: 'A', text: 'Agent text.' }), NOW + 3000);
  assert.equal(conflict.state, 'conflict');
  assert.equal(getBlock(file(root, rel), 'summary'), 'Alex\'s words.');
  assert.match(file(root, 'Crypto/Decisions.md'), /Agent text\./);
});

test('research writes are validated and reach the tool', async () => {
  const bad = (fields: Partial<WriteRequest>): void => assert.throws(() => validateWrite(research(fields)));
  bad({ topic: '' });
  bad({ topic: 'a [[b]]' });
  bad({ status: 'final' });
  bad({ confidence: 'sure' });
  bad({ date: '2026-13-45' });
  bad({ related: ['https://example.org'] });
  bad({ sources: ['a\nb'] });
  assert.throws(() => validateWrite({ ...research({}), kind: 'fact', page: 'Facts/x' }), /only a research write carries/);
  const root = temp();
  ensureLayout(root);
  assert.throws(() => applyWrite(root, research({ related: ['project:nope'] }), NOW), /no such project space/);
  assert.throws(() => applyWrite(root, research({ space: 'project:kokuban' }), NOW), /research needs a business: pass space "business:<key>"/);
  assert(!has(root, 'Crypto/Research/Memecoins.md'));
  // Through the tool: lists may arrive as JSON text.
  const cfg = { path: root, keeper: true, keeperPc: 'keeper-pc', grouping: DEFAULT_GROUPING };
  const board = { clock: () => NOW } as unknown as Parameters<typeof vaultTool>[0];
  const me = { name: 'Rio' } as unknown as Parameters<typeof vaultTool>[1];
  const msg = await vaultTool(board, me, { op: 'write', kind: 'research', space: 'business:crypto', topic: 'Memecoins', text: 'Via the tool.',
    source: 'test', sources: '["https://example.org/a"]', related: 'Other note', confidence: 'low' }, { config: () => cfg, pc: () => 'pc-c' });
  assert.match(msg, /written: research note → Crypto\/Research\/Memecoins\.md/);
  const fm = frontmatter(file(root, 'Crypto/Research/Memecoins.md'));
  assert.deepEqual(fm.sources, ['https://example.org/a']);
  assert.deepEqual(fm.related, ['[[Crypto/Research/Other note|Other note]]']);
  assert.equal(fm.confidence, 'low');
});

test('research with no space, or from a project outside a business, goes to Learning (2026-11-07)', () => {
  const withLearning = parseGrouping({ ...DEFAULT_BUSINESSES, learning: { folder: 'Learning', repos: [] } });
  const root = temp();
  useGrouping(root, withLearning);
  ensureLayout(root);
  applyWrite(root, { request_id: 'seed-kokuban-1', kind: 'summary', space: 'project:kokuban', text: 'The agent board.', source: 'README',
    author: { agent: 'Rio', pc: 'pc-c' } }, NOW);
  const none = applyWrite(root, research({ space: undefined, topic: 'VideoGen', name: 'Launch film pacing' }), NOW);
  assert.equal(none.state, 'written');
  assert(has(root, 'Learning/Research/Launch film pacing.md'));
  assert(!has(root, 'Acme/Research/Launch film pacing.md'));
  const shared = applyWrite(root, research({ space: 'project:kokuban', topic: 'Agents', name: 'Hook wording' }), NOW);
  assert.equal(shared.state, 'written');
  assert.match(file(root, 'Learning/Research/Hook wording.md'), /\[\[Shared tools\/Projects\/kokuban\/Overview\|kokuban\]\]/);
  // A business named explicitly still gets it.
  applyWrite(root, research({ name: 'Memecoin decay' }), NOW);
  assert(has(root, 'Crypto/Research/Memecoin decay.md'));
});

test('without a Learning business, research from Shared tools names what to pass', () => {
  const root = temp();
  ensureLayout(root);
  applyWrite(root, { request_id: 'seed-kokuban-2', kind: 'summary', space: 'project:kokuban', text: 'The agent board.', source: 'README',
    author: { agent: 'Rio', pc: 'pc-c' } }, NOW);
  assert.throws(() => applyWrite(root, research({ space: 'project:kokuban' }), NOW),
    /research needs a business: pass space "business:<key>" \(acme, harbor-trading, crypto, security\), e\.g\. vault\(op="write", kind="research", space="business:acme"/);
  // No space and no Learning: the old default, Acme.
  applyWrite(root, research({ space: undefined, name: 'Old default' }), NOW);
  assert(has(root, 'Acme/Research/Old default.md'));
});

test('the graph colour group and the snippet block are written once; a person\'s choices stay', () => {
  const root = temp();
  ensureLayout(root);
  assert(!has(root, '.obsidian/graph.json'));
  fs.mkdirSync(path.join(root, '.obsidian'));
  put(root, '.obsidian/graph.json', JSON.stringify({ scale: 4, colorGroups: [{ query: 'path:Clients/', color: { a: 1, rgb: 1 } }] }));
  assert.equal(ensureResearchGraph(root, NOW), true);
  const g = JSON.parse(file(root, '.obsidian/graph.json'));
  assert.equal(g.scale, 4);
  assert.deepEqual(g.colorGroups.map((x: { query: string }) => x.query), [RESEARCH_GROUP.query, 'path:Clients/']);
  // Removed by a person: never added again.
  put(root, '.obsidian/graph.json', JSON.stringify({ colorGroups: [] }));
  assert.equal(ensureResearchGraph(root, NOW), false);
  assert.deepEqual(JSON.parse(file(root, '.obsidian/graph.json')).colorGroups, []);
  // The snippet gains the research block once; an edited block is left alone.
  put(root, SNIPPET_FILE, '/* acme */\n');
  ensureLayout(root);
  const css = file(root, SNIPPET_FILE);
  assert.equal(css.split('keeper:research (D126)').length - 1, 1);
  assert(css.endsWith(RESEARCH_CSS));
  assert.equal(withResearchCss(css), null);
  assert.equal(withResearchCss(css.replace('violet', 'teal')), null);
});

test('Rules.md and the vault tool describe D126', () => {
  assert.match(RULES_PAGE, /where it has clients, Clients\/ with the Pipeline and Care boards \(D126\)/);
  assert.match(RULES_PAGE, /18\. Research and learning notes[\s\S]*Learning\/Research\//);
  assert.doesNotMatch(RULES_PAGE, /Home, the Pipeline and Care boards,\n/);
  assert.match(HOW_PAGE, /## What each business Home shows/);
  assert.match(HOW_PAGE, /credential or research note\./);
  assert.match(README_PAGE, /Clients\/ and the Pipeline and Care boards where it has clients/);
  // The keeper's own previous pages are replaced; a person's are not.
  const root = temp();
  put(root, 'Rules.md', RULES_V6);
  put(root, 'README.md', README_V3);
  put(root, HOW, HOW_PAGE_V2);
  ensureLayout(root);
  assert.equal(file(root, 'Rules.md'), RULES_PAGE);
  assert.equal(file(root, 'README.md'), README_PAGE);
  assert.equal(file(root, HOW), HOW_PAGE);
});
