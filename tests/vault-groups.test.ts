import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import {
  RULES_PAGE, RULES_V4, applyWrite, clientsBlock, cockpitQueued, ensureLayout, findClient, findClientPage, frontmatter, getBlock, keeperTick,
  linkUp, parentOf, readPage, revisions, spaceKeyOf, type KeeperConfig, type WriteRequest,
} from '../src/vault-keeper.js';
import { CLIENT_GROUPS, DEFAULT_GROUPING, allClients, allProjects, clientGroup, parseClientDir, safeName } from '../src/vault-layout.js';
import { regroup } from '../src/vault-regroup.js';

const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-groups-'));
const NOW = Date.parse('2026-11-06T10:00:00Z');
let n = 0;
const write = (fields: Partial<WriteRequest> & Pick<WriteRequest, 'kind' | 'text'>): WriteRequest => ({
  request_id: `groups-test-${++n}`, source: 'test', author: { agent: 'Rio', pc: 'keeper-pc', person: 'Alex' },
  space: 'T-05555', name: '青空工房', ...fields,
});
const file = (root: string, rel: string): string => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const has = (root: string, rel: string): boolean => fs.existsSync(path.join(root, ...rel.split('/')));
const put = (root: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, ...rel.split('/'))), { recursive: true });
  fs.writeFileSync(path.join(root, ...rel.split('/')), text);
};
const AOZ = 'T-05555 青空工房';
const NS = '0 ❓ No stage';
const ACT = '1 🔥 Act now';
const BUILD = '2 🛠 Building';
const WAIT = '3 ⏳ Waiting on them';
const QUIET = '4 💤 Quiet';
const overview = (id: string, name: string, extra = ''): string =>
  `---\ntobira_id: "${id}"\nname: "${name}"\naliases: ["${name}"]\n${extra}---\n# ${name}\n\n<!-- keeper:summary -->\n<!-- /keeper:summary -->\n`;
const keeper = (root: string): { board: Board; tick: (hour?: number) => Promise<void> } => {
  const board = new Board();
  const config = (): KeeperConfig => ({ path: root, keeper: true, keeperPc: 'keeper-pc' });
  return { board, tick: (hour = 1) => keeperTick(board, { config, now: () => new Date(2026, 10, 6, hour, 0).getTime(), pc: () => 'keeper-pc' }) };
};

test('the stage groups: one mapping, names Windows can hold (emoji kept), quiet overrides Act now and Waiting only', () => {
  assert.deepEqual(CLIENT_GROUPS.map((g) => g.folder), [ACT, BUILD, WAIT, QUIET, '5 ✅ Done', '6 🗄 Closed', NS]);
  for (const g of CLIENT_GROUPS) assert.equal(safeName(g.folder), g.folder, g.folder);
  const cases: Array<[string, string[], string]> = [
    ['replied', [], ACT], ['sample-made', [], ACT], ['engaging', [], ACT], ['proposal', [], ACT],
    ['signed', [], BUILD], ['building', [], BUILD], ['launch', [], BUILD],
    ['outreach', [], WAIT], ['sample-sent', [], WAIT],
    ['replied', ['quiet'], QUIET], ['sample-sent', ['#quiet'], QUIET], ['engaging', ['web', 'Quiet'], QUIET],
    ['proposal', ['quiet'], ACT], ['signed', ['quiet'], BUILD], ['outreach', ['quiet'], WAIT],
    ['done', [], '5 ✅ Done'], ['closed', [], '6 🗄 Closed'], ['', [], NS], ['lead', [], NS], ['reply', [], NS],
  ];
  for (const [stage, tags, group] of cases) assert.equal(clientGroup(stage, tags), group, `${stage} ${tags.join(',')}`);
});

test('lookups accept grouped and flat client folders alike, so a vault mid-migration never splits', async () => {
  const root = temp();
  ensureLayout(root);
  put(root, 'Acme/Clients/T-00100 Flat Co/Overview.md', overview('T-00100', 'Flat Co', 'stage: "proposal"\n'));
  put(root, `Acme/Clients/${BUILD}/T-00200 Grouped Co/Overview.md`, overview('T-00200', 'Grouped Co', 'stage: "building"\n'));
  put(root, `Acme/Clients/${BUILD}/T-00200 Grouped Co/Projects/grouped-site/Overview.md`, '---\nrepo: "grouped-site"\n---\n# grouped-site\n');
  const g = DEFAULT_GROUPING;
  assert.equal(findClient(root, 'T-00100'), 'Acme/Clients/T-00100 Flat Co');
  assert.equal(findClient(root, 'T-00200'), `Acme/Clients/${BUILD}/T-00200 Grouped Co`);
  assert.deepEqual(allClients(root, g).map((c) => c.dir).sort(), ['Acme/Clients/T-00100 Flat Co', `Acme/Clients/${BUILD}/T-00200 Grouped Co`].sort());
  assert.equal(spaceKeyOf(root, `Acme/Clients/${BUILD}/T-00200 Grouped Co`), 'T-00200');
  assert.equal(spaceKeyOf(root, 'Acme/Clients/T-00100 Flat Co'), 'T-00100');
  assert.deepEqual(parseClientDir(g, `Acme/Clients/${BUILD}/T-00200 Grouped Co/Projects/grouped-site`)?.rest, ['Projects', 'grouped-site']);
  const nested = allProjects(root, g).find((p) => p.repo === 'grouped-site')!;
  assert.equal(nested.place?.kind, 'client');
  assert.equal(parentOf(root, nested.dir)!.fields.client, `[[Acme/Clients/${BUILD}/T-00200 Grouped Co/Overview|T-00200 Grouped Co]]`);
  assert.equal(parentOf(root, `Acme/Clients/${BUILD}/T-00200 Grouped Co`)!.fields.business, '[[Acme/Home|Acme]]');
  // A write without stage or tags lands where the client is; reads find both.
  applyWrite(root, write({ kind: 'event', space: 'T-00100', text: 'Called.' }), NOW);
  assert.match(file(root, 'Acme/Clients/T-00100 Flat Co/Work log.md'), /Called\./);
  applyWrite(root, write({ kind: 'event', space: 'T-00200', text: 'Built.' }), NOW);
  assert.match(file(root, `Acme/Clients/${BUILD}/T-00200 Grouped Co/Work log.md`), /Built\./);
  assert.match(findClientPage(root, 'Grouped Co'), new RegExp(`^T-00200 \\| Acme/Clients/${BUILD}/T-00200 Grouped Co/`));
  assert.match(findClientPage(root, 'T-00100'), /^T-00100 \| Acme\/Clients\/T-00100 Flat Co\//);
  assert.match(readPage(root, 'Overview', 'T-00200'), /Grouped Co/);
  // The keeper's tick is the migration: the flat folder moves into its group.
  await keeper(root).tick();
  assert.equal(findClient(root, 'T-00100'), `Acme/Clients/${ACT}/T-00100 Flat Co`);
  assert(!has(root, 'Acme/Clients/T-00100 Flat Co'));
  assert.match(getBlock(file(root, 'Acme/Home.md'), 'clients')!, /^\*\*🔥 Act now\*\* \(1\)\n- \[\[Acme\/Clients\/1 🔥 Act now\/T-00100 Flat Co\/Overview\|T-00100 Flat Co\]\] · proposal\n\n\*\*🛠 Building\*\* \(1\)/);
});

test('a stage change moves the folder at once; path links elsewhere and keeper blocks follow, with no false conflict', () => {
  const root = temp();
  applyWrite(root, write({ kind: 'summary', text: `Pottery school. See [[Acme/Clients/${NS}/${AOZ}/Work log|the work log]].` }), NOW);
  assert(has(root, `Acme/Clients/${NS}/${AOZ}/Overview.md`), 'a new client without a stage waits in No stage');
  put(root, 'Acme/Notes.md', `# Notes\n\nSee [[Acme/Clients/${NS}/${AOZ}/Overview|AOZ]] and [[${AOZ}]].\n`);
  const out = applyWrite(root, write({ kind: 'event', text: 'Signed.', frontmatter: { stage: 'signed' } }), NOW + 1000);
  assert.match(out.message, new RegExp(`moved Acme/Clients/${NS}/${AOZ} → Acme/Clients/${BUILD}/${AOZ}`));
  const C = `Acme/Clients/${BUILD}/${AOZ}`;
  assert(has(root, `${C}/Work log.md`));
  assert(!has(root, `Acme/Clients/${NS}`), 'the group it left is removed when empty');
  assert.match(file(root, 'Acme/Notes.md'), new RegExp(`\\[\\[${C}/Overview\\|AOZ\\]\\] and \\[\\[${AOZ}\\]\\]`), 'path links rewritten, name links kept');
  const ov = file(root, `${C}/Overview.md`);
  assert.match(getBlock(ov, 'summary')!, new RegExp(`\\[\\[${C}/Work log\\|the work log\\]\\]`));
  assert.equal(frontmatter(ov).business, '[[Acme/Home|Acme]]');
  const move = revisions(root).find((r) => r.kind === 'move')!;
  assert.deepEqual([move.space, move.page, move.section], ['T-05555', `Acme/Clients/${NS}/${AOZ}`, C]);
  // The summary block's rewritten link has its revision: the next summary write is no conflict.
  assert.equal(applyWrite(root, write({ kind: 'summary', text: 'Pottery school, building.' }), NOW + 2000).state, 'written');
  assert(!revisions(root).some((r) => r.kind === 'conflict'));
  assert.match(file(root, `${C}/log.md`), /stage: \(none\) → signed/);
  // Done, then closed: each its own group.
  applyWrite(root, write({ kind: 'event', text: 'Live.', frontmatter: { stage: 'done' } }), NOW + 3000);
  assert.equal(findClient(root, 'T-05555'), `Acme/Clients/5 ✅ Done/${AOZ}`);
});

test('the quiet tag moves a waiting client to Quiet; a later stage brings it back out', () => {
  const root = temp();
  applyWrite(root, write({ kind: 'event', text: 'They replied.', frontmatter: { stage: 'replied' } }), NOW);
  assert.equal(findClient(root, 'T-05555'), `Acme/Clients/${ACT}/${AOZ}`, 'created straight into its group');
  applyWrite(root, write({ kind: 'event', text: '14 days without contact.', source: 'daily pipeline job', frontmatter: { tags: ['quiet'] } }), NOW + 1000);
  assert.equal(findClient(root, 'T-05555'), `Acme/Clients/${QUIET}/${AOZ}`);
  assert.match(getBlock(file(root, 'Acme/Home.md'), 'clients')!, /^\*\*💤 Quiet\*\* \(1\)\n- .* · replied$/);
  applyWrite(root, write({ kind: 'event', text: 'Signed after all.', frontmatter: { stage: 'signed' } }), NOW + 2000);
  assert.equal(findClient(root, 'T-05555'), `Acme/Clients/${BUILD}/${AOZ}`, 'quiet only holds replied, sample-sent and engaging');
});

test('a taken target is never overwritten: the move waits, is reported and listed on Needs attention', async () => {
  const root = temp();
  applyWrite(root, write({ kind: 'event', text: 'Hello.' }), NOW);
  put(root, `Acme/Clients/${BUILD}/${AOZ}/Mine.md`, '# A person made this\n');
  const out = applyWrite(root, write({ kind: 'event', text: 'Signed.', frontmatter: { stage: 'signed' } }), NOW + 1000);
  assert.match(out.message, new RegExp(`not moved: Acme/Clients/${BUILD}/${AOZ} already exists`));
  assert(has(root, `Acme/Clients/${NS}/${AOZ}/Overview.md`), 'the source stays');
  assert.equal(file(root, `Acme/Clients/${BUILD}/${AOZ}/Mine.md`), '# A person made this\n');
  assert.match(file(root, 'Needs attention.md'), new RegExp(`## Waiting to be re-filed\n- \\[\\[Acme/Clients/${NS}/${AOZ}/Overview\\|${AOZ}\\]\\]: belongs in \`Acme/Clients/${BUILD}/${AOZ}\``));
  // The writes keep landing in the one folder that is the client's (its Overview).
  applyWrite(root, write({ kind: 'event', text: 'Kickoff.' }), NOW + 2000);
  assert.match(file(root, `Acme/Clients/${NS}/${AOZ}/Work log.md`), /Kickoff\./);
  assert(!has(root, `Acme/Clients/${BUILD}/${AOZ}/Work log.md`));
  const { tick } = keeper(root);
  await tick();
  await tick();
  assert(has(root, `Acme/Clients/${NS}/${AOZ}/Overview.md`));
  assert.equal(revisions(root).filter((r) => r.kind === 'move').length, 0);
});

test('D112: a client moves to another business by its front matter, keeps its ID, and can move back', () => {
  const root = temp();
  ensureLayout(root);
  const HOTEL = 'T-00650 ホテル山桜533';
  applyWrite(root, write({ kind: 'event', space: 'T-00650', name: 'ホテル山桜533', text: 'Engaged.', frontmatter: { stage: 'engaging' } }), NOW);
  assert.equal(findClient(root, 'T-00650'), `Acme/Clients/${ACT}/${HOTEL}`);
  assert(!has(root, 'Harbor Trading/Clients'), 'a business without client IDs has no Clients/ until one moves there');
  const out = applyWrite(root, write({ kind: 'event', space: 'T-00650', text: 'This is Harbor Trading work.', source: 'D112: Alex',
    frontmatter: { business: 'harbor-trading' } }), NOW + 1000);
  assert.match(out.message, /front matter set: business harbor-trading/);
  const D = `Harbor Trading/Clients/${ACT}/${HOTEL}`;
  assert.match(out.message, new RegExp(`moved Acme/Clients/${ACT}/${HOTEL} → ${D}`));
  assert.equal(findClient(root, 'T-00650'), D, 'found in the other business');
  assert(!has(root, `Acme/Clients/${ACT}`));
  const ov = file(root, `${D}/Overview.md`);
  assert.equal(frontmatter(ov).business, '[[Harbor Trading/Home|Harbor Trading]]');
  assert.equal(frontmatter(ov).tobira_id, 'T-00650');
  assert.equal(getBlock(ov, 'parent'), 'Part of [[Harbor Trading/Home|Harbor Trading]]');
  assert.match(getBlock(file(root, 'Harbor Trading/Home.md'), 'clients')!, new RegExp(`\\[\\[${D}/Overview\\|${HOTEL}\\]\\] · engaging`));
  assert.doesNotMatch(getBlock(file(root, 'Acme/Home.md'), 'clients')!, /T-00650/);
  assert.match(getBlock(file(root, 'Home.md'), 'businesses')!, /\[\[Harbor Trading\/Home\|Harbor Trading\]\] — 1 client/);
  // The same ID, history and space key: later writes, the log, revisions and acme-cockpit links follow it.
  applyWrite(root, write({ kind: 'event', space: 'T-00650', text: 'Reservation call.' }), NOW + 2000);
  assert.match(file(root, `${D}/Work log.md`), /Engaged\.[\s\S]*Reservation call\./);
  assert(revisions(root).filter((r) => r.space === 'T-00650').length >= 4);
  applyWrite(root, { ...write({ kind: 'connection', space: 'T-00650', text: '', name: 'Sengokuhara Hotel' }), evidence: 'their site' }, NOW + 3000, undefined, { cockpit: true });
  const link = JSON.parse(fs.readFileSync(path.join(root, '.keeper', 'queue', 'cockpit', cockpitQueued(root)[0]!), 'utf8'));
  assert.equal(link.tobira_id, 'T-00650');
  assert.match(findClientPage(root, 'Sengokuhara Hotel'), new RegExp(`^T-00650 \\| ${D}/`));
  // A later write's business by folder name is no false conflict, and moves it back.
  const back = applyWrite(root, write({ kind: 'event', space: 'T-00650', text: 'Back to Acme.', frontmatter: { business: 'Acme' } }), NOW + 4000);
  assert.equal(back.conflicts_with, undefined);
  assert.equal(findClient(root, 'T-00650'), `Acme/Clients/${ACT}/${HOTEL}`);
  assert.equal(frontmatter(file(root, `Acme/Clients/${ACT}/${HOTEL}/Overview.md`)).business, '[[Acme/Home|Acme]]');
  assert(!has(root, `Harbor Trading/Clients/${ACT}`));
  assert(!revisions(root).some((r) => r.kind === 'conflict'));
});

test('linkUp keeps a client\'s asked business while the move waits', () => {
  const root = temp();
  applyWrite(root, write({ kind: 'event', text: 'Hello.', frontmatter: { stage: 'proposal' } }), NOW);
  const C = `Acme/Clients/${ACT}/${AOZ}`;
  const rel = path.join(root, ...C.split('/'), 'Overview.md');
  fs.writeFileSync(rel, fs.readFileSync(rel, 'utf8').replace('business: "[[Acme/Home|Acme]]"', 'business: "harbor-trading"'));
  put(root, `Harbor Trading/Clients/${ACT}/${AOZ}/Taken.md`, 'x\n');
  linkUp(root, C, NOW);
  assert.equal(frontmatter(file(root, `${C}/Overview.md`)).business, 'harbor-trading');
  // A plain value naming where it already is becomes the keeper's link.
  fs.writeFileSync(rel, fs.readFileSync(rel, 'utf8').replace('business: "harbor-trading"', 'business: "acme"'));
  linkUp(root, C, NOW);
  assert.equal(frontmatter(file(root, `${C}/Overview.md`)).business, '[[Acme/Home|Acme]]');
});

test('a client\'s business must be a business: shared, unsorted, a client ID or an unknown name is refused, nothing written', () => {
  const root = temp();
  for (const business of ['shared', 'unsorted', 'T-05555', 'nowhere', '[[Shared tools/Home|Shared tools]]']) {
    assert.throws(() => applyWrite(root, write({ kind: 'event', text: 'x', frontmatter: { business } }), NOW),
      /a client's business must be one of acme, harbor-trading, crypto, security/, business);
  }
  assert(!has(root, 'Acme'));
  assert.equal(revisions(root).length, 0);
});

test('the business Home lists clients in the folder groups, Act now first, No stage after Done, Closed folded', () => {
  const c = (id: string, stage: string, tags: string[] = []): { dir: string; stage: string; tags: string[] } =>
    ({ dir: `Acme/Clients/${clientGroup(stage, tags)}/${id} X`, stage, tags });
  const block = clientsBlock([c('T-7', 'closed'), c('T-6', ''), c('T-5', 'done'), c('T-4', 'replied', ['quiet']), c('T-3', 'outreach'),
    c('T-2', 'building'), c('T-1', 'proposal'), c('T-8', 'lead')]);
  const heads = [...block.matchAll(/^(?:> \[!note\]- )?\**([^*\n(]+?)\**\s\((\d+)\)$/gm)].map((m) => `${m[1]!.trim()} ${m[2]}`);
  assert.deepEqual(heads, ['🔥 Act now 1', '🛠 Building 1', '⏳ Waiting on them 1', '💤 Quiet 1', '✅ Done 1', '❓ No stage 2', '🗄 Closed 1']);
  assert.match(block, /> \[!note\]- 🗄 Closed \(1\)\n> - \[\[Acme\/Clients\/6 🗄 Closed\/T-7 X\/Overview\|T-7 X\]\] · closed$/);
  assert.match(block, /- \[\[Acme\/Clients\/0 ❓ No stage\/T-8 X\/Overview\|T-8 X\]\] · lead/);
});

test('the regroup dry run reports client folders that would move into their groups; Rules.md describes the groups', () => {
  const root = temp();
  ensureLayout(root);
  put(root, 'Acme/Clients/T-00100 Flat Co/Overview.md', overview('T-00100', 'Flat Co', 'stage: "outreach"\n'));
  const dry = regroup(root, { apply: false, now: NOW, pc: 'keeper-pc' });
  assert.match(dry.lines.join('\n'), new RegExp(`^would move client Acme/Clients/T-00100 Flat Co → Acme/Clients/${WAIT}/T-00100 Flat Co \\(stage outreach → ${WAIT}\\)`, 'm'));
  assert(has(root, 'Acme/Clients/T-00100 Flat Co/Overview.md'), 'a dry run moves nothing');
  const done = regroup(root, { apply: true, now: NOW, pc: 'keeper-pc' });
  assert.equal(done.clients.length, 1);
  assert(has(root, `Acme/Clients/${WAIT}/T-00100 Flat Co/Overview.md`));
  assert.match(RULES_PAGE, /"<Business>\/Clients\/<group>\/<Acme ID> <name>"/);
  assert.match(RULES_PAGE, /12\. Inside each business's Clients\/[\s\S]*1 🔥 Act now \(replied, sample-made, engaging, proposal\)[\s\S]*4 💤 Quiet \(tagged quiet\)[\s\S]*business \(D112\)/);
  // The keeper's previous Rules.md, unedited, is replaced by the current one.
  const old = temp();
  fs.writeFileSync(path.join(old, 'Rules.md'), RULES_V4);
  ensureLayout(old);
  assert.equal(file(old, 'Rules.md'), RULES_PAGE);
});
