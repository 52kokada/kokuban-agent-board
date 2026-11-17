// Every rulebook text the keeper has ever written, pinned byte for byte (tests/fixtures/vault-rulebook/*.txt).
// A vault that still holds one of the old pages unedited is upgraded by matching it exactly, so an old version's
// text must never change. Regenerate a fixture only for a new version, never to make an old one pass.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as keeper from '../src/vault-keeper.js';
import { HOW, HOW_PAGE, README_PAGE, RULES_PAGE, ensureLayout } from '../src/vault-keeper.js';
import { KEEPER_HOW, KEEPER_RULES, OLD_README, rulesPage } from '../src/vault-rulebook.js';

const FIXTURES = path.resolve('tests', 'fixtures', 'vault-rulebook');
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf8');
const EXPORTED = ['RULES_V1', 'RULES_V2', 'RULES_V3', 'RULES_V4', 'RULES_V5', 'RULES_V6', 'RULES_V7', 'RULES_PAGE', 'README_V2', 'README_V3',
  'README_PAGE', 'HOW_PAGE_V2', 'HOW_PAGE_V3', 'HOW_PAGE', 'CONNECTION_RULE', 'CREDENTIAL_RULE', 'LAYOUT_RULE', 'GROUP_RULE', 'READ_RULE'] as const;
const file = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

test('every exported rulebook text is exactly its pinned fixture', () => {
  for (const name of EXPORTED) assert.equal((keeper as unknown as Record<string, string>)[name], fixture(name), name);
});

test('the keeper\'s own earlier pages, which it replaces when unedited, are exactly the pinned old versions', () => {
  assert.deepEqual(KEEPER_RULES, ['RULES_V1', 'RULES_V2', 'RULES_V3', 'RULES_V4', 'RULES_V5', 'RULES_V6', 'RULES_V7'].map(fixture));
  assert.deepEqual(KEEPER_HOW, ['HOW_PAGE_V1', 'HOW_PAGE_V2', 'HOW_PAGE_V3'].map(fixture));
  assert.equal(OLD_README, fixture('OLD_README'));
  assert.equal(rulesPage(7), fixture('RULES_V7'));
  assert.equal(rulesPage(8), fixture('RULES_PAGE'));
  assert.match(HOW_PAGE, /Research and learning notes go to Learning\/Research\//);
});

test('each old Rules.md, README.md and "How this works" the keeper wrote, unedited, becomes the current page', () => {
  const old = (rules: string, readme: string, how: string): void => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-rulebook-text-'));
    fs.writeFileSync(path.join(root, 'Rules.md'), fixture(rules));
    fs.writeFileSync(path.join(root, 'README.md'), fixture(readme));
    fs.writeFileSync(path.join(root, HOW), fixture(how));
    ensureLayout(root);
    assert.equal(file(root, 'Rules.md'), RULES_PAGE, rules);
    assert.equal(file(root, 'README.md'), README_PAGE, readme);
    assert.equal(file(root, HOW), HOW_PAGE, how);
  };
  const readmes = ['OLD_README', 'README_V2', 'README_V3'];
  const hows = ['HOW_PAGE_V1', 'HOW_PAGE_V2', 'HOW_PAGE_V3'];
  ['RULES_V1', 'RULES_V2', 'RULES_V3', 'RULES_V4', 'RULES_V5', 'RULES_V6', 'RULES_V7'].forEach((rules, i) => old(rules, readmes[i % 3]!, hows[i % 3]!));
});

test('an edited old page is kept as the person left it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-rulebook-text-'));
  const theirs = `${fixture('HOW_PAGE_V1')}\nOur note.\n`;
  fs.writeFileSync(path.join(root, HOW), theirs);
  fs.writeFileSync(path.join(root, 'README.md'), `${fixture('README_V3')}x\n`);
  ensureLayout(root);
  assert.equal(file(root, HOW), theirs);
  assert.equal(file(root, 'README.md'), `${fixture('README_V3')}x\n`);
});
