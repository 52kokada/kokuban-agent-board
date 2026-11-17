import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { applyWrite, ensureLayout, findClient, frontmatter, type WriteRequest } from '../src/vault-keeper.js';
import {
  BOARD_COLUMN_WIDTH, CARD_FORMULAS, CARD_ORDER, SNIPPET_FILE, TENDRA_CSS, TENDRA_CSS_CLOSE, TENDRA_CSS_OPEN, tendraBase, withTendraCss,
} from '../src/vault-tendra.js';
import { RESEARCH_CSS } from '../src/vault-visuals.js';

const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-tendra-'));
const file = (root: string, rel: string): string => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const has = (root: string, rel: string): boolean => fs.existsSync(path.join(root, ...rel.split('/')));
const put = (root: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, ...rel.split('/'))), { recursive: true });
  fs.writeFileSync(path.join(root, ...rel.split('/')), text);
};
const NOW = Date.parse('2026-11-06T10:00:00Z');
const boardOrder = (base: string): string[] => {
  const board = base.slice(base.indexOf('    name: Board\n'), base.indexOf('  - type: table'));
  return [...board.slice(board.indexOf('    order:\n')).matchAll(/^ {6}- (.+)$/gm)].map((m) => m[1]!);
};

/** Acme/Pipeline.base as the keeper wrote it before D120 (the shared vault's copy on 2026-11-05). */
const OLD_BASE = 'filters:\n  and:\n    - tobira_id\n    - file.name == "Overview"\nformulas:\n  client: if(name, name, tobira_id)\n' +
  '  stage_chip: html(\'<span class="tobira-stage" data-stage="\' + escapeHTML(stage) + \'">\' + escapeHTML(stage) + \'</span>\')\n' +
  '  touched: if(updated, date(updated).relative(), "")\nproperties:\n  stage:\n    displayName: Stage\n  formula.client:\n    displayName: Client\n' +
  'views:\n  - type: kanban\n    name: Board\n    filters:\n      and:\n        - stage != "closed"\n    groupBy:\n      property: stage\n' +
  '      direction: ASC\n    groupOrder:\n      - outreach\n      - replied\n    order:\n      - formula.client\n      - formula.meta\n' +
  '      - formula.touched\n    columnWidth: 240\n  - type: table\n    name: Pipeline\n    order:\n      - formula.client\n      - tobira_id\n';

test('a new vault\'s Pipeline board is the Tendra card; the Care board keeps its own', () => {
  const root = temp();
  ensureLayout(root);
  const base = file(root, 'Acme/Pipeline.base');
  assert.deepEqual(boardOrder(base), CARD_ORDER);
  assert.match(base, new RegExp(`columnWidth: ${BOARD_COLUMN_WIDTH}\\n  - type: table`));
  for (const [k, v] of CARD_FORMULAS) assert(base.includes(`\n  ${k}: ${v}\n`), k);
  assert.match(base, /\n {2}formula\.card_next:\n {4}displayName: Next step\n/);
  // The table still has the older formulas and shows the next step.
  assert.match(base, /name: Pipeline[\s\S]*- formula\.stage_chip\n {6}- last_event\n {6}- next_step\n/);
  assert.equal(tendraBase(base).board, 'already');
  assert.equal(tendraBase(base).text, base);
  assert.doesNotMatch(file(root, 'Acme/Care.base'), /card_/);
  // Without the visual pass's snippet nothing is made: enabling a snippet is a person's choice.
  assert(!has(root, SNIPPET_FILE));
});

test('an existing keeper base gains the card formulas and the Tendra board; nothing else in it changes', () => {
  const out = tendraBase(OLD_BASE);
  assert.equal(out.board, 'updated');
  assert.deepEqual(boardOrder(out.text), CARD_ORDER);
  assert.match(out.text, new RegExp(`columnWidth: ${BOARD_COLUMN_WIDTH}\\n  - type: table\\n    name: Pipeline\\n    order:\\n      - formula.client\\n      - tobira_id\\n$`));
  // Formulas are added at the end of formulas:, display names at the end of properties:.
  assert.match(out.text, /touched: if\(updated, date\(updated\)\.relative\(\), ""\)\n {2}card_name: /);
  assert.match(out.text, /formula\.client:\n {4}displayName: Client\n {2}next_step:\n {4}displayName: Next step\n/);
  // Taking out what was added gives the old base back, apart from the board's card list and width.
  const added = new Set([...CARD_FORMULAS.map(([k, v]) => `  ${k}: ${v}`)]);
  const back = out.text.split('\n').filter((l) => !added.has(l)).join('\n')
    .replace(/\n {2}next_step:\n {4}displayName: Next step(\n {2}formula\.card_\w+:\n {4}displayName: [^\n]+)+/, '')
    .replace(CARD_ORDER.map((p) => `      - ${p}\n`).join(''), '      - formula.client\n      - formula.meta\n      - formula.touched\n')
    .replace(`columnWidth: ${BOARD_COLUMN_WIDTH}`, 'columnWidth: 240');
  assert.equal(back, OLD_BASE);
  // Idempotent; CRLF files read the same.
  assert.equal(tendraBase(out.text).board, 'already');
  assert.equal(tendraBase(OLD_BASE.replace(/\n/g, '\r\n')).text, out.text);
  // The other keeper card list (with last_event) switches too; a base without a width gains one.
  const withEvent = tendraBase(OLD_BASE.replace('      - formula.meta\n', '      - formula.meta\n      - last_event\n').replace('    columnWidth: 240\n', ''));
  assert.equal(withEvent.board, 'updated');
  assert.match(withEvent.text, new RegExp(`      - formula\\.card_work\\n    columnWidth: ${BOARD_COLUMN_WIDTH}\\n  - type: table`));
});

test('a person\'s own card list is kept; the formulas are still there to pick', () => {
  const mine = OLD_BASE.replace('      - formula.meta\n      - formula.touched\n', '      - tobira_id\n');
  const out = tendraBase(mine);
  assert.equal(out.board, 'kept');
  assert.deepEqual(boardOrder(out.text), ['formula.client', 'tobira_id']);
  assert.match(out.text, /columnWidth: 240/);
  assert.match(out.text, /\n {2}card_top: html\(/);
  // A base without formulas or properties gets both sections, in YAML order.
  const bare = tendraBase('filters:\n  and:\n    - tobira_id\nviews:\n  - type: kanban\n    name: Board\n    order:\n      - formula.client\n');
  assert.equal(bare.board, 'kept');
  assert.match(bare.text, /^filters:\n {2}and:\n {4}- tobira_id\nformulas:\n {2}card_name: [^\n]+\n[\s\S]*\nproperties:\n {2}next_step:\n[\s\S]*\nviews:\n/);
});

test('the snippet gains the keeper:tendra block once; an edited block is left alone', () => {
  assert(TENDRA_CSS.startsWith(`${TENDRA_CSS_OPEN}\n`) && TENDRA_CSS.endsWith(`${TENDRA_CSS_CLOSE}\n`));
  const visual = '/* the visual pass */\n.tobira-stage { color: red; }\n';
  const once = withTendraCss(visual)!;
  assert.equal(once, `${visual}\n${TENDRA_CSS}`);
  assert.equal(withTendraCss(once), null);
  assert.equal(withTendraCss(once.replace(/\n/g, '\r\n')), null);
  const edited = once.replace('--bases-kanban-container-gap: 13px;', '--bases-kanban-container-gap: 20px;');
  assert.equal(withTendraCss(edited), null);
  assert.equal(withTendraCss(`${visual}${TENDRA_CSS_OPEN}\n.broken {`), null, 'an unclosed block is never doubled');
  // The block is plain CSS: balanced braces, the rows placed by the card formulas' names, light/dark from tokens only.
  const body = TENDRA_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(body.split('{').length, body.split('}').length);
  for (const p of CARD_ORDER) assert(TENDRA_CSS.includes(`[data-property="${p}"]`), p);
  assert.doesNotMatch(body, /theme-(light|dark)/);
  assert.match(TENDRA_CSS, /content: "\\203A"/);
});

test('the keeper lays it out on start: an existing vault\'s base and snippet are moved over once', () => {
  const root = temp();
  ensureLayout(root);
  put(root, 'Acme/Pipeline.base', OLD_BASE);
  put(root, SNIPPET_FILE, '/* the visual pass */\n');
  ensureLayout(root);
  assert.deepEqual(boardOrder(file(root, 'Acme/Pipeline.base')), CARD_ORDER);
  // D126's research block follows the Tendra block.
  assert.equal(file(root, SNIPPET_FILE), `/* the visual pass */\n\n${TENDRA_CSS}\n${RESEARCH_CSS}`);
  const base = file(root, 'Acme/Pipeline.base');
  const css = file(root, SNIPPET_FILE);
  ensureLayout(root);
  assert.equal(file(root, 'Acme/Pipeline.base'), base);
  assert.equal(file(root, SNIPPET_FILE), css);
});

test('next_step is Overview front matter an agent may set (one line), shown on the card', () => {
  const root = temp();
  const req: WriteRequest = {
    request_id: 'tendra-1', kind: 'event', text: 'Asked for the sample link.', source: 'test', space: 'T-05555', name: '青空工房',
    author: { agent: 'Rio', pc: 'keeper-pc', person: 'Alex' }, frontmatter: { stage: 'replied', next_step: 'Send the sample site link' },
  };
  assert.equal(applyWrite(root, req, NOW).state, 'written');
  const overview = file(root, `${findClient(root, 'T-05555')}/Overview.md`);
  assert.equal(frontmatter(overview).next_step, 'Send the sample site link');
});
