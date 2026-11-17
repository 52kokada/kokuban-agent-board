import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import {
  CREDENTIALS_PAGE, MASK, RULES_PAGE, RULES_PROPOSAL_ID, RULES_V1, RULES_V2, applyWrite, ensureLayout, getBlock, maskCredentials,
  proposeRules, readPage, revisions, searchVault, vaultTool, writeAttention, type KeeperConfig, type WriteRequest,
} from '../src/vault-keeper.js';
import { decodeBlob, loadDirectory, mapCredential, runExport, UNMAPPED, type Directory } from '../src/vault-credentials.js';

const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-cred-'));
const NOW = Date.parse('2026-11-05T09:00:00Z');
const DIR = 'Acme/Clients/0 ❓ No stage/T-05555 青空工房';
const SECRET = 'Pa55|w`rd-xyzzy!';
const OTHER = 'Second-Secret-42';
let n = 0;
const cred = (fields: Partial<WriteRequest> = {}): WriteRequest => ({
  request_id: `cred-request-${++n}`, kind: 'credential', text: '', source: 'test', author: { agent: 'Rio', pc: 'pc-c', person: 'Alex' },
  space: 'T-05555', name: '青空工房', site: 'aozora-kobo-works.myshopify.com', account: 'hello@aozora-kobo-works.jp', value: SECRET,
  ...fields,
});
const file = (root: string, rel: string): string => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');

test('kind credential writes one table row per site and account; an update replaces that row', () => {
  const root = temp();
  const first = applyWrite(root, cred({ url: 'https://aozora-kobo-works.myshopify.com/admin', note: 'store owner' }), NOW);
  assert.equal(first.state, 'written');
  assert.equal(first.page, CREDENTIALS_PAGE);
  assert(!first.message.includes(SECRET));
  const page = file(root, `${DIR}/Credentials.md`);
  const block = getBlock(page, 'credentials')!;
  const lines = block.split('\n');
  assert.equal(lines[0], '| site | account | password | url | note | updated |');
  assert.equal(lines.length, 3);
  // The password is a code span with its pipe escaped, so the row splits back into the same six cells.
  assert.equal(lines[2], '| aozora-kobo-works.myshopify.com | hello@aozora-kobo-works.jp | `` Pa55\\|w`rd-xyzzy! `` | ' +
    'https://aozora-kobo-works.myshopify.com/admin | store owner | 2026-11-05 09:00Z |');
  // The same again is unchanged (an idempotent export); a new value replaces the row and keeps url and note.
  assert.equal(applyWrite(root, cred(), NOW).state, 'unchanged');
  assert.equal(applyWrite(root, cred({ value: OTHER }), NOW + 60_000).state, 'written');
  applyWrite(root, cred({ site: 'shopify.com', account: 'info@acme-agency.net', value: 'Third-Secret-99' }), NOW);
  const rows = getBlock(file(root, `${DIR}/Credentials.md`), 'credentials')!.split('\n').slice(2);
  assert.equal(rows.length, 2);
  assert.match(rows[0]!, /^\| aozora-kobo-works\.myshopify\.com \| hello@aozora-kobo-works.jp \| ` Second-Secret-42 ` \| https:\/\/aozora-kobo-works\.myshopify\.com\/admin \| store owner \| 2026-11-05 09:01Z \|$/);
  assert(!file(root, `${DIR}/Credentials.md`).includes(SECRET));
  assert.match(file(root, `${DIR}/index.md`), /\[\[Acme\/Clients\/0 ❓ No stage\/T-05555 青空工房\/Credentials\|Credentials\]\]/);
});

test('the password never reaches revisions, the log, the hidden index or a masked read; reveal shows it', async () => {
  const root = temp();
  applyWrite(root, cred(), NOW);
  applyWrite(root, cred({ value: OTHER }), NOW);
  const log = file(root, `${DIR}/log.md`);
  assert.match(log, /credential \[\[Acme\/Clients\/0 ❓ No stage\/T-05555 青空工房\/Credentials\|Credentials\]\]: credential updated: aozora-kobo-works\.myshopify\.com\/hello@aozora-kobo-works.jp — Rio@pc-c/);
  for (const [name, text] of [['revisions', file(root, '.keeper/revisions.jsonl')], ['log', log], ['index', file(root, '.keeper/index.json')],
    ['agency log', file(root, 'Acme/log.md')]] as const) {
    for (const v of [SECRET, OTHER, 'Pa55', 'Second-Secret']) assert(!text.includes(v), `${name} holds a password`);
  }
  const revs = revisions(root).filter((r) => r.kind === 'credential');
  assert.equal(revs.length, 2);
  assert.equal(revs[0]!.section, 'aozora-kobo-works.myshopify.com/hello@aozora-kobo-works.jp');
  const masked = readPage(root, 'Credentials', 'T-05555');
  assert(!masked.includes(OTHER));
  assert.match(masked, new RegExp(`\\| hello@aozora-kobo-works\\.jp \\| ${MASK} \\|`));
  assert.match(readPage(root, 'Credentials', 'T-05555', { reveal: true }), /` Second-Secret-42 `/);
  // Search never confirms a password, by the index or by the text.
  assert.equal(searchVault(root, OTHER), 'no pages match');
  assert.match(searchVault(root, 'hello@aozora-kobo-works.jp'), /Credentials\.md/);
  // Through the tool: masked unless reveal=true; a write reports no value.
  const board = new Board();
  const me = board.touch('s', '', 'claude').session;
  const config = (): KeeperConfig => ({ path: root, keeper: true, keeperPc: 'keeper-pc' });
  const read = await vaultTool(board, me, { op: 'read', page: 'Credentials', space: 'T-05555' }, { config });
  assert(!read.includes(OTHER));
  assert(( await vaultTool(board, me, { op: 'read', page: 'Credentials', space: 'T-05555', reveal: true }, { config })).includes(OTHER));
  const out = await vaultTool(board, me, { op: 'write', kind: 'credential', space: 'agency', site: 'acme-agency.net', account: 'info@acme-agency.net',
    value: 'agency-pass-1234567890abcdef', source: 'test' }, { config, now: () => NOW });
  assert.match(out, /^written: credential updated: acme-agency.net\/info@acme-agency.net → Acme\/Credentials\.md/);
  assert(!out.includes('agency-pass'));
  assert(!file(root, 'Acme/log.md').includes('agency-pass'));
  assert(file(root, 'Acme/Credentials.md').includes('agency-pass-1234567890abcdef'));
  // Nothing other than the Credentials pages holds a password.
  for (const [v, pages] of [[OTHER, [`${DIR}/Credentials.md`]], ['agency-pass', ['Acme/Credentials.md']]] as const) {
    const holders = fs.readdirSync(root, { recursive: true }).map(String).map((p) => p.replace(/\\/g, '/'))
      .filter((p) => fs.statSync(path.join(root, p)).isFile() && file(root, p).includes(v));
    assert.deepEqual(holders, pages);
  }
});

test('the credential filter still refuses secrets in every other kind and field; a credential is never queued', async () => {
  const root = temp();
  for (const kind of ['event', 'fact', 'decision', 'proposal', 'summary'] as const) {
    assert.throws(() => applyWrite(root, { ...cred(), kind, text: 'password=hunter2', value: undefined, section: 'x', page: kind === 'fact' ? 'Facts/x' : undefined } as WriteRequest, NOW), /credential/);
  }
  // value belongs to kind credential alone.
  assert.throws(() => applyWrite(root, { ...cred(), kind: 'event', text: 'note' } as WriteRequest, NOW), /only a credential write carries value/);
  // The exemption covers the value only: a secret in the note or source is still refused, and so is the password elsewhere.
  assert.throws(() => applyWrite(root, cred({ note: 'api_key=abc123' }), NOW), /credential/);
  assert.throws(() => applyWrite(root, cred({ note: `old one was ${SECRET}` }), NOW), /also appears in another field/);
  assert.throws(() => applyWrite(root, cred({ value: 'two\nlines' }), NOW), /one line/);
  assert.throws(() => applyWrite(root, cred({ text: 'hi' }), NOW), /not text/);
  assert.throws(() => applyWrite(root, cred({ account: '' }), NOW), /account/);
  // A value shaped like a token is fine in a credential write.
  assert.equal(applyWrite(root, cred({ value: `sk-${'a'.repeat(70)}` }), NOW).state, 'written');
  // A non-keeper whose keeper is down: refused, not queued on disk.
  const here = temp();
  const board = new Board();
  const me = board.touch('s', '', 'claude').session;
  const deps = { config: (): KeeperConfig => ({ path: here, keeper: false, keeperPc: 'keeper-pc' }), resolve: async () => 'keeper-pc',
    fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch, pc: () => 'pc-c', now: () => NOW };
  await assert.rejects(vaultTool(board, me, { op: 'write', kind: 'credential', space: 'agency', site: 'x.com', account: 'a', value: SECRET, source: 's' }, deps),
    /never queued/);
  assert(!fs.existsSync(path.join(here, '.keeper', 'queue')) || fs.readdirSync(path.join(here, '.keeper', 'queue')).length === 0);
});

test('a row a person changed by hand is kept, listed for attention, and the agent password goes nowhere', () => {
  const root = temp();
  applyWrite(root, cred(), NOW);
  const rel = `${DIR}/Credentials.md`;
  fs.writeFileSync(path.join(root, ...rel.split('/')), file(root, rel).replace(SECRET.replace('|', '\\|'), 'Changed-By-Alex'));
  // A person's own extra row stays through later writes.
  fs.writeFileSync(path.join(root, ...rel.split('/')), file(root, rel).replace('<!-- /keeper:credentials -->',
    '| bank.example.jp | alex | ` hand-made ` |  |  |  |\n<!-- /keeper:credentials -->'));
  const out = applyWrite(root, cred({ value: OTHER }), NOW);
  assert.equal(out.state, 'conflict');
  assert(!file(root, rel).includes(OTHER));
  assert.match(file(root, rel), /Changed-By-Alex/);
  assert(!file(root, `${DIR}/Decisions.md`).includes(OTHER), 'no proposal carries the password');
  assert.match(file(root, 'Needs attention.md'), /credential aozora-kobo-works\.myshopify\.com\/hello@aozora-kobo-works.jp: a person changed the row by hand/);
  // Reported once: the next write applies over the person's row, and their extra row stays.
  assert.equal(applyWrite(root, cred({ value: OTHER }), NOW).state, 'written');
  assert.match(file(root, rel), /Second-Secret-42/);
  assert.match(file(root, rel), /hand-made/);
  assert.doesNotMatch(writeAttention(root, NOW)['Orphan pages']!.join('\n'), /Credentials/);
});

test('rule 8 is replaced on a keeper-written Rules.md; an edited one gets a proposal once', () => {
  const root = temp();
  ensureLayout(root);
  assert.match(file(root, 'Rules.md'), /8\. Passwords live on a Credentials page in the space they belong to \(decision D99\)\.\n {3}Agents write them only with kind=credential, never in other notes, and never echo them in chat\./);
  assert.doesNotMatch(file(root, 'Rules.md'), /Credentials never enter/);
  assert.match(file(root, 'Rules.md'), /10\. When you learn two businesses are connected/);
  for (const earlier of [RULES_V1, RULES_V2]) {
    const old = temp();
    fs.writeFileSync(path.join(old, 'Rules.md'), earlier);
    ensureLayout(old);
    assert.equal(file(old, 'Rules.md'), RULES_PAGE);
    assert.equal(proposeRules(old, NOW, 'keeper-pc'), null);
  }
  const edited = temp();
  const theirs = `${RULES_V2}11. Our own rule.\n`;
  fs.writeFileSync(path.join(edited, 'Rules.md'), theirs);
  ensureLayout(edited);
  assert.equal(file(edited, 'Rules.md'), theirs);
  assert.equal(proposeRules(edited, NOW, 'keeper-pc')!.state, 'written');
  assert.match(file(edited, 'Acme/Decisions.md'), /## Proposed — not accepted[\s\S]*Rules\.md rule 8[\s\S]*kind=credential/);
  assert.equal(proposeRules(edited, NOW, 'keeper-pc')!.state, 'duplicate');
  assert.equal(revisions(edited).filter((r) => r.request_id === RULES_PROPOSAL_ID).length, 1);
  assert.equal(file(edited, 'Rules.md'), theirs);
});

test('maskCredentials masks any table\'s password column and nothing else', () => {
  const text = '# X\n\n| site | password |\n| --- | --- |\n| a.com | ` s3cret ` |\n\nplain password: words\n\n| name | value |\n|---|---|\n| password | kept |\n';
  const out = maskCredentials(text);
  assert(!out.includes('s3cret'));
  assert.match(out, /\| a\.com \| •+ \|/);
  assert.match(out, /\| password \| kept \|/);
  assert.match(out, /plain password: words/);
});

const DIRECTORY: Directory = {
  clients: [
    { tobiraId: 'T-05555', names: ['青空工房', 'Aozora Kobo Works'], domains: [], emails: [] },
    { tobiraId: 'T-00450', names: ['北光金属', 'Hokko'], domains: ['hokko-kinzoku.co.jp'], emails: ['owner@gmail.com'] },
  ],
  projects: [{ repo: 'kokuban' }, { repo: 'acme-cockpit' }, { repo: 'ops-home' }],
};
const space = (name: string, user = ''): string => mapCredential(name, user, DIRECTORY).space;

test('the mapping function places sample names by client, agency and project, and leaves the rest out', () => {
  // Clients: by an alias in the account email's domain, a client domain, or a client email.
  assert.equal(space('computeruse/accounts.shopify.com/hello@aozora-kobo-works.jp'), 'T-05555');
  assert.equal(space('computeruse/aozora-kobo-works.myshopify.com/staff@acme-agency.net'), 'T-05555');
  assert.equal(space('computeruse/admin.hokko-kinzoku.co.jp/admin'), 'T-00450');
  assert.equal(space('computeruse/shop.example-host.jp/owner@gmail.com'), 'T-00450');
  // Agency: Acme's own accounts and services.
  assert.equal(space('computeruse/accounts.google.com/info@acme-agency.net'), 'agency');
  assert.equal(space('computeruse/dash.cloudflare.com/alex@acme-agency.net'), 'agency');
  assert.equal(space('computeruse/cockpit.acme-agency.net/alex'), 'agency');
  assert.equal(space('computeruse/instagram.com/acmeagency'), 'agency');
  // Projects: a repository's name in the site or account.
  assert.equal(space('computeruse/kokuban.app/alex'), 'project:kokuban');
  assert.equal(space('computeruse/github.com/ops-home'), 'project:ops-home');
  // Personal or unclear: never written.
  for (const name of ['computeruse/127.0.0.1/admin', 'computeruse/localhost/me', 'computeruse/example.invalid/x@example.invalid',
    'computeruse/example.com/me@example.com', 'computeruse/portal.u-tokyo.ac.jp/s1234', 'computeruse/store.steampowered.com/gamer',
    'computeruse/accounts.google.com/alex.personal@gmail.com', 'computeruse/shopify.com/test@aozora-kobo-works.jp',
    'computeruse/demo.store.com/demo', 'computeruse/randomsite.com/someone']) {
    assert.equal(space(name), UNMAPPED, name);
  }
  assert.match(mapCredential('computeruse/127.0.0.1/admin', '', DIRECTORY).reason!, /local/);
  assert.deepEqual(mapCredential('computeruse/a.com/hello@aozora-kobo-works.jp', '', DIRECTORY),
    { name: 'computeruse/a.com/hello@aozora-kobo-works.jp', site: 'a.com', account: 'hello@aozora-kobo-works.jp', space: 'T-05555' });
  // Two clients at once is unclear.
  assert.match(mapCredential('computeruse/hokko-kinzoku.co.jp/hello@aozora-kobo-works.jp', '', DIRECTORY).reason!, /several clients/);
});

test('the directory comes from client Overview front matter, aliases, connections and project folders', () => {
  const root = temp();
  applyWrite(root, { ...cred(), kind: 'summary', text: 'Pottery school.', value: undefined, site: undefined, account: undefined,
    frontmatter: { aliases: ['Aozora Kobo Works'] } } as WriteRequest, NOW);
  applyWrite(root, { ...cred(), kind: 'connection', name: 'Sister Shop', email: 'hello@sistershop.jp', domain: 'sistershop.jp', evidence: 'call',
    value: undefined, site: undefined, account: undefined } as WriteRequest, NOW);
  fs.mkdirSync(path.join(root, 'Shared tools', 'Projects', 'kokuban'), { recursive: true });
  const dir = loadDirectory(root);
  assert.equal(dir.clients.length, 1);
  assert.equal(dir.clients[0]!.tobiraId, 'T-05555');
  assert(dir.clients[0]!.names.includes('Aozora Kobo Works'));
  assert(dir.clients[0]!.domains.includes('sistershop.jp'));
  assert.deepEqual(dir.projects, [{ repo: 'kokuban' }]);
  assert.equal(mapCredential('computeruse/x.com/hello@aozora-kobo-works.jp', '', dir).space, 'T-05555');
  assert.equal(mapCredential('computeruse/admin.sistershop.jp/owner', '', dir).space, 'T-05555');
});

test('one client matched twice (two signals, or its old Clients/ folder beside Acme/Clients/) is one client, not "several"', () => {
  // Two refs with the same ID, each matching the same entry through a different signal.
  const twice: Directory = { clients: [
    { tobiraId: 'T-05555', names: ['aozora-kobo-works'], domains: [], emails: [] },
    { tobiraId: 'T-05555', names: [], domains: ['aozora-kobo-works.jp'], emails: ['hello@aozora-kobo-works.jp'] },
  ], projects: [] };
  assert.equal(mapCredential('computeruse/aozora-kobo-works.myshopify.com/hello@aozora-kobo-works.jp', '', twice).space, 'T-05555');
  assert.equal(mapCredential('computeruse/accounts.shopify.com/hello@aozora-kobo-works.jp', 'hello@aozora-kobo-works.jp', twice).space, 'T-05555');
  // A real second client still makes it unclear, listed once each.
  const two: Directory = { clients: [...twice.clients, { tobiraId: 'T-00450', names: [], domains: ['aozora-kobo-works.myshopify.com'], emails: [] }], projects: [] };
  assert.equal(mapCredential('computeruse/aozora-kobo-works.myshopify.com/x', '', two).reason, 'several clients match: T-05555, T-00450');

  // The post-regroup layout as a vault syncing it holds it: Acme/Clients/ with `business`/`aliases` front matter,
  // and the same client still in the old top-level Clients/ (no Decisions.md there), alias-only front matter.
  const root = temp();
  const overview = (extra: string): string => `---\ntobira_id: T-05555\nname: 青空工房\naliases:\n  - 青空工房\n  - aoz\n` +
    `  - aozora-kobo-works\nstage: "building"\n${extra}---\n# 青空工房\n\n<!-- keeper:summary -->\n` +
    `**Stage:** signed\n**Tenant / mailbox:** acme · hello@aozora-kobo-works.jp · https://www.aozora-kobo-works.jp/\n<!-- /keeper:summary -->\n`;
  for (const [dir, extra] of [[DIR, 'business: "[[Acme/Home|Acme]]"\ncssclasses: ["client"]\n'], ['Clients/T-05555 青空工房', '']] as const) {
    fs.mkdirSync(path.join(root, ...dir.split('/')), { recursive: true });
    fs.writeFileSync(path.join(root, ...dir.split('/'), 'Overview.md'), overview(extra));
  }
  fs.mkdirSync(path.join(root, 'Acme', 'Clients', 'T-05555 青空工房', 'Projects', 'ember-aoz'), { recursive: true });
  const dir = loadDirectory(root);
  assert.equal(dir.clients.length, 1);
  assert(dir.clients[0]!.names.includes('aozora-kobo-works'));
  assert(dir.clients[0]!.domains.includes('aozora-kobo-works.jp'), 'the mailbox line names the domain');
  assert(dir.clients[0]!.emails.includes('hello@aozora-kobo-works.jp'));
  assert.deepEqual(dir.projects, [{ repo: 'ember-aoz' }]);
  for (const [name, user] of [['computeruse/aozora-kobo-works.myshopify.com/alex@acme-agency.net', ''], // alias in the site
    ['computeruse/accounts.shopify.com/hello@aozora-kobo-works.jp', ''], // the client's email
    ['computeruse/www.aozora-kobo-works.jp/admin', ''], // the client's website
    ['computeruse/accounts.google.com', 'hello@aozora-kobo-works.jp']] as const) { // the account only as the stored user
    assert.equal(mapCredential(name, user, dir).space, 'T-05555', name);
  }
});

test('blobs decode from UTF-16LE (a string) and UTF-8 (bytes)', () => {
  assert.equal(decodeBlob(Buffer.from('hunter2', 'utf16le').toString('base64')), 'hunter2');
  assert.equal(decodeBlob(Buffer.from('パスワード1', 'utf16le').toString('base64')), 'パスワード1');
  assert.equal(decodeBlob(Buffer.from('héllo-wörld', 'utf8').toString('base64')), 'héllo-wörld');
});

test('the export: a dry run prints the mapping with no values and reads none; the real run writes through the tool and is idempotent', async () => {
  const root = temp();
  applyWrite(root, { ...cred(), kind: 'summary', text: 'Pottery school.', value: undefined, site: undefined, account: undefined,
    frontmatter: { aliases: ['Aozora Kobo Works'] } } as WriteRequest, NOW);
  const values: Record<string, string> = {
    'computeruse/aozora-kobo-works.myshopify.com/hello@aozora-kobo-works.jp': 'Client-Pass-111',
    'computeruse/accounts.google.com/info@acme-agency.net': 'Agency-Pass-222',
    'computeruse/127.0.0.1/admin': 'Local-Pass-333',
    'computeruse/store.steampowered.com/gamer': 'Game-Pass-444',
  };
  let fetches = 0;
  const access = {
    index: async () => ({ entries: Object.keys(values).map((name) => ({ name, account: name.split('/').pop()!, written: NOW })), skipped: [] }),
    fetch: async (names: string[]) => { fetches++; return names.map((name) => ({ name, account: name.split('/').pop()!, written: NOW, blob: Buffer.from(values[name]!, 'utf16le').toString('base64') })); },
  };
  const board = new Board();
  const me = board.touch('s', '', 'claude').session;
  const config = (): KeeperConfig => ({ path: root, keeper: true, keeperPc: 'keeper-pc' });
  const calls: Record<string, unknown>[] = [];
  const call = async (args: Record<string, unknown>): Promise<string> => { calls.push(args); return vaultTool(board, me, args, { config, now: () => NOW }); };
  const run = async (dryRun: boolean): Promise<string> => {
    const lines: string[] = [];
    await runExport({ dryRun, root, access, call, print: (l) => lines.push(l), pc: 'pc-c' });
    return lines.join('\n');
  };
  const dry = await run(true);
  assert.equal(fetches, 0, 'a dry run never reads a value');
  assert.equal(calls.length, 0);
  for (const v of Object.values(values)) assert(!dry.includes(v), 'dry run printed a value');
  assert.match(dry, /aozora-kobo-works\.myshopify\.com\/hello@aozora-kobo-works.jp → T-05555/);
  assert.match(dry, /accounts\.google\.com\/info@acme-agency.net → agency/);
  assert.match(dry, /- computeruse\/127\.0\.0\.1\/admin \(local address\)/);
  assert.match(dry, /- computeruse\/store\.steampowered\.com\/gamer \(game\)/);
  assert(!fs.existsSync(path.join(root, DIR, 'Credentials.md')));

  const real = await run(false);
  for (const v of Object.values(values)) assert(!real.includes(v), 'the export printed a value');
  assert.match(real, /→ T-05555: written/);
  assert.match(real, /written 2, unchanged 0, failed 0/);
  assert.equal(calls.length, 2, 'unmapped entries are never written');
  assert(!calls.some((c) => c.value === 'Local-Pass-333' || c.value === 'Game-Pass-444'));
  assert(file(root, `${DIR}/Credentials.md`).includes('Client-Pass-111'));
  assert(file(root, 'Acme/Credentials.md').includes('Agency-Pass-222'));
  assert.match(await run(false), /written 0, unchanged 2, failed 0/);
  assert.equal(getBlock(file(root, `${DIR}/Credentials.md`), 'credentials')!.split('\n').length, 3);
});
