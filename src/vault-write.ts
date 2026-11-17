/** The write pipeline: validateWrite, then applyWrite and the writer for each kind (event, fact, decision, credential, …). */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { noSecrets, thisPc } from './know.js';
import {
  businessDir, businessSpaceKey, findClient as findClientIn, findProject, frontmatter, legacy, parseBusinessValue, placeOfDir, safeName,
  type Business, type Grouping,
} from './vault-layout.js';
import {
  CONFIDENCE, RESEARCH_INDEX, RESEARCH_STATUSES, RESEARCH_TAG, canvasText, indexBlock, indexPage, mapName, mergeCanvas, noteFile, notePage,
  parseCanvas, researchCanvas, researchDir, researchNotes, sourceLine, topicTag,
} from './vault-research.js';
import { researchBase } from './vault-visuals.js';
import { placeClients } from './vault-regroup.js';
import { WORKING_COPIES_FACT, WORKING_COPIES_PAGE, validWorkingCopy, workingCopiesPage, type WorkingCopy } from './vault-working-copies.js';
import {
  ACCEPTED, CARE_STAGES, CONNECTED, FM, FRONTMATTER_FIELDS, type FrontmatterField, type FrontmatterWrite, KINDS, type Kind, LIST_FIELDS,
  PROJECT, PROJECT_DOCS, PROPOSED, type Revision, STAGES, TEXT_CHARS, TOBIRA, abs, appendRevision, appendUnder, close, create, fieldHash,
  fold, getBlock, groupingOf, lastFor, latest, lf, listOf, oneLine, open, ownNotes, put, read, refreshSpaceIndex, revisions, setBlock,
  setFrontmatter, sha, stamp, str, touchIndex, wiki,
} from './vault-store.js';
import { CREDENTIALS_PAGE, CREDENTIAL_HEADER, type CredentialRow, isSeparator, isTableLine, parseRow, rowCells, rowLine } from './vault-mask.js';
import {
  DECISIONS, type Space, clientOverview, ensureLayout, ensureSpace, layoutNotes, projectOverview, refreshFacts, refreshHomes, spaceFor,
} from './vault-spaces.js';
import { writeAttention } from './vault-checkup.js';
import { enqueueLinks } from './vault-queue.js';

export interface WriteRequest {
  request_id: string;
  kind: Kind;
  space?: string; tobira_id?: string; name?: string;
  page?: string; section?: string;
  text: string; source: string;
  replaces?: string; accepted_by?: string;
  /** kind connection: name is the other business; client_name names a client folder that does not exist yet. */
  email?: string; domain?: string; website?: string; evidence?: string; client_name?: string;
  /** kind credential (D99): one row of the space's Credentials page. value is the password; it is never logged or revised. */
  site?: string; account?: string; value?: string; url?: string; note?: string;
  /**
   * kind research (D126): one note in the business's Research/ folder, named by `name` (else its topic). topic groups
   * it; status draft/current/superseded; date YYYY-MM-DD; confidence low/medium/high; sources links (merged);
   * related research notes, project:<repo>, client IDs or [[links]] (merged), which the graph draws.
   */
  topic?: string; status?: string; date?: string; confidence?: string; sources?: string[]; related?: string[];
  /**
   * D91: the board's own first summary of a repository's project space. Applied only while the space has
   * no Overview, so a second PC's seed (or a later one after a person's edits) never replaces anything.
   */
  project?: { remote: string; docs: string[]; business?: string };
  /** Overview front matter (client and project spaces): stage, care_stage, aliases (merged), tags (merged). */
  frontmatter?: FrontmatterWrite;
  /** D131: a fact write from Kokuban itself: the sending PC's row of the project's Facts/working-copies table. */
  working_copies?: WorkingCopy;
  author: { agent: string; pc: string; person?: string };
}
export interface WriteResult {
  ok: true; state: 'written' | 'proposal' | 'conflict' | 'unchanged' | 'confirmed' | 'duplicate';
  revision: string; page: string; conflicts_with?: string; message: string;
}

/** A credential write without its password: what the credential filter, logs and messages may see. */
const withoutValue = (req: WriteRequest): WriteRequest => {
  const { value: _value, ...rest } = req;
  return rest as WriteRequest;
};
const oneLineField = (v: unknown, name: string, max: number, required: boolean): void => {
  if (v === undefined && !required) return;
  if (typeof v !== 'string' || (required && !v.trim()) || v.length > max || /[\r\n\0]/.test(v)) {
    throw new Error(`${name} must be one line of at most ${max} characters${required ? '' : ' when given'}`);
  }
};
function validateCredential(req: WriteRequest): void {
  if (str(req.text)) throw new Error('a credential takes value (the password), site and account; not text');
  if (req.frontmatter !== undefined || req.project !== undefined) throw new Error('a credential write carries no frontmatter or project');
  oneLineField(req.site, 'site', 200, true);
  oneLineField(req.account, 'account', 200, true);
  oneLineField(req.url, 'url', 500, false);
  oneLineField(req.note, 'note', 300, false);
  if (typeof req.value !== 'string' || !req.value.trim() || req.value.length > 1000 || /[\r\n\0]/.test(req.value)) {
    throw new Error('value (the password) must be one line of 1 to 1000 characters');
  }
  if (str(req.url) && !/^https?:\/\/[^\s]+$/i.test(str(req.url))) throw new Error('url must be an http(s) link');
  // The password goes only in its cell: never in the note, source, url or any other field that is logged.
  const value = req.value;
  if (value.length >= 6 && [req.site, req.account, req.url, req.note, req.source, req.section, req.page].some((f) => typeof f === 'string' && f.includes(value))) {
    throw new Error('the password also appears in another field; it may only be passed as value. Nothing was written.');
  }
}
function secretFree(s: string): void {
  // Links and Git commit ids are evidence, not credentials (the vault's option; know-how keeps the strict check).
  try { noSecrets(s, { links: true }); }
  catch { throw new Error('Looks like a credential: a password goes only in a kind=credential write (D99), never in other notes. Nothing was written.'); }
}
/** A connection's links for acme-cockpit: the business name, an email, and domains (a website counts by its host). */
export interface Connection { name: string; email?: string; domains: string[]; website?: string }
function host(s: string): string {
  const raw = s.trim().toLowerCase();
  let h = '';
  try { h = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`).hostname; } catch { /* invalid */ }
  h = h.replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) throw new Error(`not a domain or website: ${JSON.stringify(oneLine(s, 80))}`);
  return h;
}
export function connectionOf(req: WriteRequest): Connection {
  const name = str(req.name);
  if (!name || /[\r\n]/.test(name) || name.length > 200) throw new Error('a connection needs name: the other business, on one line');
  const email = str(req.email).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('email is not an email address');
  const domains = [...new Set([str(req.domain), str(req.website)].filter(Boolean).map(host))];
  return { name, ...(email ? { email } : {}), domains, ...(str(req.website) ? { website: str(req.website) } : {}) };
}
/** The line a connection is recorded and logged as. */
function connectionLine(req: WriteRequest): string {
  const c = connectionOf(req);
  const bits = [...(c.email ? [`email ${c.email}`] : []), ...c.domains.map((d) => `domain ${d}`), ...(c.website ? [`website ${c.website}`] : [])];
  const note = str(req.text);
  return `${c.name}${bits.length ? ` — ${bits.join(' · ')}` : ''}${note ? `\n${note}` : ''}`;
}
/** A connection's evidence is its source when no other source is given. */
export function prepared(req: WriteRequest): WriteRequest {
  return req.kind === 'connection' && !str(req.source) && str(req.evidence) ? { ...req, source: str(req.evidence) } : req;
}
export function validateWrite(req: WriteRequest): void {
  if (!KINDS.includes(req.kind)) throw new Error(`kind must be ${KINDS.join(', ')}`);
  if (req.kind !== 'credential' && req.value !== undefined) throw new Error('only a credential write carries value; never put a password in another kind');
  if (req.kind === 'credential') validateCredential(req);
  else if (req.kind === 'connection') {
    if (!TOBIRA.test(str(req.space) || str(req.tobira_id))) throw new Error('a connection belongs to a client: pass tobira_id (T-…)');
    if (!str(req.evidence)) throw new Error('evidence required: where you learned the two businesses are connected');
    connectionOf(req);
  } else if (!str(req.text)) throw new Error('text required');
  else if (req.kind === 'research') validateResearch(req);
  const researchOnly = (['topic', 'status', 'date', 'confidence', 'sources', 'related'] as const).filter((k) => req[k] !== undefined);
  if (req.kind !== 'research' && researchOnly.length) throw new Error(`${researchOnly.join(', ')}: only a research write carries these`);
  if (req.project !== undefined) {
    const p = req.project as { remote?: unknown; docs?: unknown };
    if (req.kind !== 'summary' || !PROJECT.test(str(req.space))) throw new Error('a project seed is a summary for space "project:<repo>"');
    if (typeof p?.remote !== 'string' || /[\r\n]/.test(p.remote) || p.remote.length > 300) throw new Error('project remote must be one line');
    if (!Array.isArray(p.docs) || !p.docs.every((d) => typeof d === 'string' && PROJECT_DOCS.some((k) => k.toLowerCase() === d.toLowerCase())))throw new Error(`project docs are ${PROJECT_DOCS.join(', ')}`);
    const hint = (req.project as { business?: unknown }).business;
    if (hint !== undefined && (typeof hint !== 'string' || hint.length > 100 || /[\r\n]/.test(hint))) throw new Error('project business must be one line');
  }
  if (req.frontmatter !== undefined) validateFrontmatter(req);
  if (req.working_copies !== undefined) {
    if (req.kind !== 'fact' || !PROJECT.test(str(req.space)) || str(req.page) !== WORKING_COPIES_FACT || req.frontmatter !== undefined) {
      throw new Error(`working_copies is a fact for space "project:<repo>", page "${WORKING_COPIES_FACT}"`);
    }
    validWorkingCopy(req.working_copies);
  }
  if (req.text.length > TEXT_CHARS) throw new Error(`text is over ${TEXT_CHARS} characters: link a page or file instead`);
  if (!str(req.source)) throw new Error('source required: where this came from (a message, call, page or file)');
  if (!str(req.author?.agent) || !str(req.author?.pc)) throw new Error('author required');
  if (!/^[\w-]{6,64}$/.test(str(req.request_id))) throw new Error('request_id required');
  // D99: kind credential is the only write exempt from the credential filter, and only for its value.
  secretFree(JSON.stringify(req.kind === 'credential' ? withoutValue(req) : req));
}
/** D126: a research write's own fields. */
function validateResearch(req: WriteRequest): void {
  if (req.frontmatter !== undefined || req.project !== undefined) throw new Error('a research write carries topic, status, date, confidence, sources and related; not frontmatter');
  oneLineField(req.topic, 'topic', 80, true);
  if (/[[\]|#^]/.test(str(req.topic))) throw new Error('topic may not contain [ ] | # or ^');
  oneLineField(req.name, 'name', 120, false);
  if (req.status !== undefined && !(RESEARCH_STATUSES as readonly string[]).includes(req.status)) throw new Error(`status must be one of ${RESEARCH_STATUSES.join(', ')}`);
  if (req.confidence !== undefined && !(CONFIDENCE as readonly string[]).includes(req.confidence)) throw new Error(`confidence must be one of ${CONFIDENCE.join(', ')}`);
  if (req.date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(req.date) || Number.isNaN(Date.parse(`${req.date}T00:00:00Z`)))) throw new Error('date must be YYYY-MM-DD');
  for (const [k, max] of [['sources', 500], ['related', 200]] as const) {
    const v = req[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length > 50 || !v.every((x) => typeof x === 'string' && x.trim() && x.length <= max && !/[\r\n]/.test(x))) {
      throw new Error(`${k} must be a list of at most 50 one-line items`);
    }
  }
  if ((req.related ?? []).some((r) => /^https?:\/\//i.test(r.trim()))) throw new Error('related takes research notes, project:<repo>, client IDs or [[links]]; web links go in sources');
}
const tagOf = (t: string): string => t.trim().replace(/^#+/, '');
function validateFrontmatter(req: WriteRequest): void {
  const fm = req.frontmatter as unknown;
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) throw new Error('frontmatter must be an object');
  const s = str(req.space) || str(req.tobira_id);
  if (!TOBIRA.test(s) && !PROJECT.test(s)) throw new Error('frontmatter is set on a client (T-…) or "project:<repo>" space');
  const keys = Object.keys(fm);
  if (!keys.length) throw new Error('frontmatter is empty');
  const unknown = keys.filter((k) => !(FRONTMATTER_FIELDS as readonly string[]).includes(k));
  if (unknown.length) throw new Error(`frontmatter may set only ${FRONTMATTER_FIELDS.join(', ')}; not ${unknown.join(', ')}`);
  const f = fm as Record<string, unknown>;
  if (f.stage !== undefined && !STAGES.includes(f.stage as string)) throw new Error(`stage must be one of ${STAGES.join(', ')}`);
  if (f.care_stage !== undefined && !CARE_STAGES.includes(f.care_stage as string)) throw new Error(`care_stage must be one of ${CARE_STAGES.join(', ')}`);
  for (const k of ['business', 'last_event', 'next_step', 'status']) {
    const v = f[k];
    const max = k === 'status' ? 60 : 200;
    if (v !== undefined && (typeof v !== 'string' || !v.trim() || v.length > max || /[\r\n]/.test(v))) throw new Error(`${k} must be one line of at most ${max} characters`);
  }
  // A client's business (D112) is checked against the vault's businesses in applyWrite.
  for (const k of LIST_FIELDS) {
    const v = f[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.length || v.length > 50 || !v.every((x) => typeof x === 'string' && x.trim() && x.length <= 200 && !/[\r\n]/.test(x))) {
      throw new Error(`${k} must be a list of 1 to 50 one-line names`);
    }
    if (k === 'tags' && !v.every((t: string) => /^[^\s#,][^\s,]*$/.test(tagOf(t)))) throw new Error('a tag is one word, without spaces or commas');
  }
}
export const who = (a: WriteRequest['author']): string => `${a.agent}@${a.pc}${a.person ? ` (${a.person})` : ''}`;
const slug = (s: string): string => s.replace(/^Facts\//i, '').replace(/\.md$/i, '').normalize('NFKC').toLowerCase()
  .replace(/[\\/:*?"<>|#^[\]]+/g, ' ').trim().replace(/\s+/g, '-');
/** A fact's file name: its slug, made Windows-safe (no trailing dot, no device name, at most NAME_MAX). */
const factKey = (s: string): string => safeName(slug(s)).replace(/ /g, '-');

/**
 * Apply one write on the keeper. Synchronous, so the daemon applies writes one at a time. A retried
 * request (same request_id) gets the first answer back instead of being applied twice.
 */
export interface ApplyOptions {
  /** On the keeper with vault.cockpit set: queue a written connection's links for acme-cockpit. */
  cockpit?: boolean;
  /** A proposal the keeper raises itself (a cockpit 409): the page it conflicts with. */
  conflictsWith?: string;
}
export function applyWrite(root: string, req: WriteRequest, now = Date.now(), onConflict?: () => void, opts: ApplyOptions = {}): WriteResult {
  req = prepared(req);
  validateWrite(req);
  const all = revisions(root);
  const earlier = all.find((r) => r.request_id === req.request_id);
  if (earlier) return { ok: true, state: 'duplicate', revision: earlier.id, page: earlier.page, message: `already written (r ${earlier.id})` };
  const g = groupingOf(root);
  if (req.frontmatter?.business !== undefined) {
    const asked = parseBusinessValue(root, g, req.frontmatter.business);
    // D112: a client may move to another business (it keeps its ID); never to Shared tools, Unsorted or under a client.
    if (TOBIRA.test(str(req.space) || str(req.tobira_id))) {
      if (asked?.kind !== 'business') throw new Error(`a client's business must be one of ${g.businesses.map((b) => b.key).join(', ')} (a business key or folder)`);
      // Recorded as the business's key: a plain value is what asks the keeper to move it (a link is the keeper's own).
      req = { ...req, frontmatter: { ...req.frontmatter, business: asked.business.key } };
    } else if (!asked) {
      throw new Error(`business must be one of ${g.businesses.map((b) => b.key).join(', ')}, "shared", "unsorted" or a client ID (T-…)`);
    }
  }
  let target = spaceFor(root, req);
  // D126: research belongs to a business; written from a project or client space, it links back to that space.
  if (req.kind === 'research') ({ target, req } = researchTarget(root, target, req));
  // A seed only starts a space: once it has an Overview (another PC's seed, a person's page), nothing changes.
  if (req.project && fs.existsSync(abs(root, `${target.dir}/Overview.md`))) {
    return { ok: true, state: 'unchanged', revision: '', page: 'Overview.md', message: `unchanged: ${target.dir} already exists` };
  }
  ensureLayout(root);
  const space = ensureSpace(root, target, str(req.kind === 'connection' ? req.client_name : req.name), now, req);
  const ctx: Ctx = { root, req, now, space, all, touched: new Set<string>() };
  const out = {
    event: writeEvent, fact: writeFact, decision: writeDecision, summary: writeSummary,
    proposal: (c: Ctx) => writeProposal(c, str(req.section), str(opts.conflictsWith)),
    connection: writeConnection, credential: writeCredential, research: writeResearch,
  }[req.kind](ctx);
  if (req.kind === 'connection' && out.state === 'written' && opts.cockpit) {
    const n = enqueueLinks(root, space.key, connectionOf(req), out.revision, req, now);
    out.message += `; ${n} link(s) queued for acme-cockpit`;
  }
  const main = { ...out };
  // The client's last thing that happened, for its Kanban card: derived, so the keeper keeps it without a conflict check.
  // A ledger import is the history it lists, not something that just happened.
  if (space.kind === 'client' && main.state === 'written' && (req.kind === 'event' || req.kind === 'summary') && req.frontmatter?.last_event === undefined &&
    main.page !== LEDGER_PAGE) {
    const last = lastEventOf(req, now);
    if (last) setDerived(ctx, { last_event: last });
  }
  const fm = req.frontmatter ? writeFrontmatter(ctx) : null;
  if (fm) {
    if (main.state === 'unchanged' && fm.written) Object.assign(out, { state: 'written', revision: fm.revision, page: 'Overview.md', message: fm.message });
    else out.message += `; ${fm.message}`;
    if (fm.conflictsWith && !out.conflicts_with) out.conflicts_with = fm.conflictsWith;
  }
  const quiet = main.state === 'unchanged' || main.state === 'confirmed';
  // A confirmation only moves one page's `updated`: the index takes it, nothing is logged.
  if (main.state === 'confirmed' && !fm?.lines.length) touchIndex(root, [...ctx.touched]);
  if (!quiet || fm?.lines.length) {
    const log = `${space.dir}/log.md`;
    const lines = [
      ...(!quiet ? [`- ${stamp(now)} ${main.state === 'written' ? req.kind : main.state} ` +
        `${wiki(`${space.dir}/${main.page}`, main.page.replace(/\.md$/, ''))}: ${oneLine(logText(req, main.state))} — ${who(req.author)} ^r-${main.revision}`] : []),
      ...(fm?.lines ?? []),
    ];
    // D131: a working-copies row is machine state refreshed hourly; its revision is the record, a log line would only fill the log.
    if (!req.working_copies) {
      put(root, log, `${(read(root, log) ?? '# Log\n\n').replace(/\n*$/, '\n')}${lines.join('\n')}\n`);
      ctx.touched.add(log);
    }
    if (main.state === 'written' && main.page.startsWith('Facts/')) {
      const overview = refreshFacts(root, space.dir);
      if (overview) ctx.touched.add(overview);
    }
    ctx.touched.add(refreshSpaceIndex(root, space.dir));
    // The Homes list projects and clients by stage: refreshed when a space is made, or a stage or place changes.
    if (space.made || req.kind === 'research' || req.frontmatter?.stage !== undefined || req.frontmatter?.business !== undefined || req.frontmatter?.status !== undefined) {
      for (const rel of refreshHomes(root)) ctx.touched.add(rel);
    }
    // Pages the layout or a new space just made are notes too.
    for (const rel of [...layoutNotes(root), ...ownNotes(root, space.dir)]) ctx.touched.add(rel);
    touchIndex(root, [...ctx.touched]);
  }
  // A client whose stage, tags or business changed moves to its group (and business) folder at once. Not before the
  // regroup: the old top-level Clients/ waits for it.
  const fmc = req.frontmatter;
  if (space.kind === 'client' && fmc && (fmc.stage !== undefined || fmc.tags !== undefined || fmc.business !== undefined) && !legacy(root)) {
    const placed = placeClients(root, now, thisPc(), { only: space.dir });
    const m = placed.moved[0];
    if (m) out.message += `; moved ${m.from} → ${m.to}`;
    if (placed.skipped.length) {
      out.message += `; not moved: ${placed.skipped[0]!.reason} (listed on Needs attention)`;
      writeAttention(root, now);
    }
  }
  // A repository nobody could place is listed on Needs attention at once.
  if (space.made && space.place?.kind === 'unsorted' && !(out.state === 'conflict' || out.conflicts_with)) writeAttention(root, now);
  if (out.state === 'conflict' || out.conflicts_with) (onConflict ?? (() => writeAttention(root, now)))();
  return out;
}

/** Front matter the keeper derives itself (last_event): set without a conflict check, recorded so agents see no false conflict. */
function setDerived(ctx: Ctx, fields: Record<string, string>): void {
  const rel = `${ctx.space.dir}/Overview.md`;
  const text = read(ctx.root, rel);
  if (text === null) return;
  const fm = frontmatter(text);
  const set = Object.fromEntries(Object.entries(fields).filter(([k, v]) => str(fm[k]) !== v));
  if (!Object.keys(set).length) return;
  const after = setFrontmatter(text, set);
  put(ctx.root, rel, after);
  ctx.touched.add(rel);
  const now = frontmatter(after);
  revise(ctx, { kind: 'frontmatter', state: 'written', page: 'Overview.md', section: Object.keys(set).join(', '), block: 'frontmatter',
    before: sha(text), after: sha(after), fields: Object.fromEntries(Object.keys(set).map((f) => [f, fieldHash(now, f)])) });
  ctx.all.push({ id: '', ts: '', kind: 'frontmatter', state: 'written', space: ctx.space.key, page: 'Overview.md', author: '', source: '',
    before: '', after: '', fields: Object.fromEntries(Object.keys(set).map((f) => [f, fieldHash(now, f)])) });
}

/** What the space's log says about a write. A credential's line names the site and account only, never the password. */
function logText(req: WriteRequest, state: WriteResult['state']): string {
  if (req.kind === 'connection') return connectionLine(req);
  if (req.kind !== 'credential') return req.text;
  const key = `${str(req.site)}/${str(req.account)}`;
  return state === 'conflict' ? `credential ${key}: a person changed this row by hand; their row was kept` : `credential updated: ${key}`;
}
interface Ctx { root: string; req: WriteRequest; now: number; space: Space; all: Revision[]; touched: Set<string> }

type Change = Omit<Revision, 'id' | 'ts' | 'request_id' | 'space' | 'author' | 'source'>;
export const newId = (): string => randomBytes(4).toString('hex');
function revise(ctx: Ctx, r: Change, id = newId()): string {
  appendRevision(ctx.root, { id, ts: new Date(ctx.now).toISOString(), request_id: ctx.req.request_id,
    space: ctx.space.key, author: who(ctx.req.author), source: ctx.req.source, ...r });
  return id;
}
const entry = (ctx: Ctx, id: string, text: string, extra = ''): string => {
  const [first, ...rest] = lf(text).trim().split('\n');
  const topic = str(ctx.req.section) ? `**${str(ctx.req.section)}** — ` : '';
  return `- ${stamp(ctx.now)} ${topic}${first}${rest.map((l) => `\n  ${l}`).join('')}\n` +
    `  _source: ${oneLine(ctx.req.source, 200)} · ${who(ctx.req.author)}${extra}_ ^r-${id}`;
};

/**
 * A client's ledger import: the intake's "Ledger <lead>/thread.md — N dated sections:" list of links into the acme
 * repo's context/leads/<lead>/thread.md. Long link lists that crowded out the Slack days on Communication.
 */
export const LEDGER_PAGE = 'Ledger.md';
export function isLedgerEvent(req: Pick<WriteRequest, 'text' | 'source'>): boolean {
  const first = lf(str(req.text)).trim().split('\n')[0] ?? '';
  return /^Ledger\s+.*\bthread\.md\b/.test(first) || /(^|\s)acme context\/leads\/.+\/thread\.md\b/.test(str(req.source));
}
/** Communication's one line for a ledger import: what it was (links as labels) and where it is whole. */
function ledgerPointer(ctx: Ctx, id: string): string {
  const first = (lf(ctx.req.text).trim().split('\n')[0] ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/:\s*$/, '');
  return `- ${stamp(ctx.now)} ${oneLine(first, 160)} → ${wiki(`${ctx.space.dir}/Ledger#^r-${id}`, 'on Ledger')} ^r-${id}`;
}

function writeEvent(ctx: Ctx): WriteResult {
  const { root, space } = ctx;
  const asked = str(ctx.req.page).replace(/\.md$/i, '').toLowerCase();
  if (asked && !['work log', 'communication', 'log', 'ledger'].includes(asked)) throw new Error('an event goes to "Work log" or "Communication" (a client\'s ledger import: "Ledger")');
  // A client's ledger import goes to its own page; Communication keeps one line pointing there.
  const ledger = space.kind === 'client' && (asked === 'ledger' || (asked === 'communication' && isLedgerEvent(ctx.req)));
  if (asked === 'ledger' && !ledger) throw new Error('"Ledger" is a client page: pass a client ID (T-…)');
  // A business has no work log: its events go to its log only (appended by applyWrite).
  const page = space.kind === 'business' ? 'log.md' : ledger ? LEDGER_PAGE : asked === 'communication' ? 'Communication.md' : 'Work log.md';
  const rel = `${space.dir}/${page}`;
  const before = read(root, rel) ?? (ledger ? '# Ledger\n\nThe dated sections of each lead\'s thread.md in the acme repo, as the ledger intake imported them.\n\n' : `# ${page.replace(/\.md$/, '')}\n\n`);
  const id = newId();
  if (page !== 'log.md') {
    const after = `${before.replace(/\n*$/, '\n')}${entry(ctx, id, ctx.req.text)}\n`;
    put(root, rel, after);
    ctx.touched.add(rel);
    revise(ctx, { kind: 'event', state: 'written', page, section: str(ctx.req.section) || undefined, before: sha(before), after: sha(after), text_hash: sha(ctx.req.text) }, id);
  } else {
    revise(ctx, { kind: 'event', state: 'written', page, before: sha(before), after: sha(before), text_hash: sha(ctx.req.text) }, id);
  }
  if (ledger) {
    const comm = `${space.dir}/Communication.md`;
    put(root, comm, `${(read(root, comm) ?? '# Communication\n\n').replace(/\n*$/, '\n')}${ledgerPointer(ctx, id)}\n`);
    ctx.touched.add(comm);
    return { ok: true, state: 'written', revision: id, page, message: `written: event → ${rel}, one line on ${comm} (r ${id})` };
  }
  return { ok: true, state: 'written', revision: id, page, message: `written: event → ${rel} (r ${id})` };
}
/** A person edited a keeper block: keep their words, record it, and keep the agent's text as a proposal. */
function conflict(ctx: Ctx, page: string, block: string, current: string, expected: string): WriteResult {
  const rel = `${ctx.space.dir}/${page}`;
  const id = revise(ctx, { kind: 'conflict', state: 'conflict', page, block, before: expected, after: sha(current) });
  const kept = writeProposal({ ...ctx, req: { ...ctx.req, request_id: `${ctx.req.request_id}-p` } }, str(ctx.req.section) || block, rel);
  return { ok: true, state: 'conflict', revision: id, page, conflicts_with: rel,
    message: `conflict: a person edited the keeper block in ${rel}; their text was kept and listed on Needs attention. ` +
      `Your ${ctx.req.kind} was recorded as a proposal (r ${kept.revision}) for a person to settle.` };
}

/**
 * A client summary laid out for reading (visual pass, 2026-11-05): the "**Last thing that happened:**" line
 * stands on its own, and a "**Ledger (…):**" label becomes a short "### Ledger" heading over its link list, its
 * parenthesis kept as a line below. Idempotent; nothing is dropped.
 */
export function layoutSummary(text: string): string {
  const lines = lf(text).trim().split('\n');
  const out: string[] = [];
  const gap = (): void => { if (out.length && out.at(-1)!.trim()) out.push(''); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const ledger = /^\*\*Ledger(?:\s*\(([^)]*)\))?:?\*\*:?\s*$/.exec(line.trim());
    if (ledger) {
      gap();
      out.push('### Ledger');
      if (ledger[1]) out.push(`_${ledger[1]}_`);
      continue;
    }
    if (/^\*\*Last thing(?: that happened)?:?\*\*/.test(line.trim())) {
      gap();
      out.push(line);
      if (i + 1 < lines.length && lines[i + 1]!.trim()) out.push('');
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
/** "Last thing that happened" for a Kanban card: one short line from an event, or a summary's "Last thing" line. */
export function lastEventOf(req: WriteRequest, now: number): string {
  const plain = (s: string): string => oneLine(s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2').replace(/[*_`]/g, ''), 140);
  if (req.kind === 'event') return `${new Date(now).toISOString().slice(0, 10)} — ${plain(req.text)}`;
  const m = /\*\*Last thing(?: that happened)?:?\*\*:?\s*(.+)/.exec(req.text);
  return m ? plain(m[1]!) : '';
}

function writeSummary(ctx: Ctx): WriteResult {
  const { root, space } = ctx;
  const page = space.kind === 'business' ? 'Home.md' : 'Overview.md';
  const rel = `${space.dir}/${page}`;
  const text = read(root, rel) ?? `# ${space.name ?? space.key}\n`;
  const current = getBlock(text, 'summary') ?? '';
  const expected = lastFor(ctx.all, space.key, page, 'summary')?.after ?? sha('');
  if (sha(current) !== expected) return conflict(ctx, page, 'summary', current, expected);
  // A client's summary is laid out for reading: the "Last thing" line on its own, the ledger links under a heading.
  const want = space.kind === 'client' ? layoutSummary(ctx.req.text) : ctx.req.text;
  if (sha(current) === sha(want)) return { ok: true, state: 'unchanged', revision: '', page, message: `unchanged: ${rel} already says this` };
  let after = setBlock(text, 'summary', want);
  if (FM.test(after)) after = setFrontmatter(after, { updated: new Date(ctx.now).toISOString() });
  put(root, rel, after);
  ctx.touched.add(rel);
  const id = revise(ctx, { kind: 'summary', state: 'written', page, block: 'summary', before: sha(current), after: sha(want), text_hash: sha(want) });
  return { ok: true, state: 'written', revision: id, page, message: `written: summary → ${rel} (r ${id})` };
}

function writeFact(ctx: Ctx): WriteResult {
  if (ctx.req.working_copies) return writeWorkingCopy(ctx);
  const { root, space, req, now } = ctx;
  const key = factKey(str(req.page) || str(req.section));
  if (!key) throw new Error('a fact needs its name: page "Facts/<name>" or section "<name>"');
  const page = `Facts/${key}.md`;
  const rel = `${space.dir}/${page}`;
  const value = lf(req.text).trim();
  const accepted = str(req.accepted_by) || req.author.person || who(req.author);
  const iso = new Date(now).toISOString();
  const fields = { fact: key, value, valid_from: iso, source: str(req.source), accepted_by: accepted, updated: iso };
  const text = read(root, rel);
  if (text === null) {
    put(root, rel, setFrontmatter(`# ${key}\n\n${open('fact')}\n${value}\n${close('fact')}\n\n## History\n`, fields));
    ctx.touched.add(rel);
    const id = revise(ctx, { kind: 'fact', state: 'written', page, section: key, block: 'fact', before: sha(''), after: sha(value), text_hash: sha(value) });
    return { ok: true, state: 'written', revision: id, page, message: `written: fact ${key} → ${rel} (r ${id})` };
  }
  const current = getBlock(text, 'fact') ?? '';
  const expected = lastFor(ctx.all, space.key, page, 'fact')?.after ?? sha('');
  if (sha(current) !== expected) return conflict(ctx, page, 'fact', current, expected);
  // The same value again is a confirmation: only `updated` moves (no revision: the content is the same, so the next write's hash check holds).
  if (sha(current) === sha(value)) {
    put(root, rel, setFrontmatter(text, { updated: iso }));
    ctx.touched.add(rel);
    return { ok: true, state: 'confirmed', revision: '', page, message: `confirmed: ${key} is still ${JSON.stringify(oneLine(value, 80))}` };
  }
  // A replacement must name the value it replaces; anything else contradicts an accepted fact.
  if (req.replaces === undefined || sha(req.replaces) !== sha(current)) {
    return writeProposal({ ...ctx, req: { ...req, section: key } }, key, rel, `the accepted fact ${key} = ${JSON.stringify(oneLine(current, 80))}`);
  }
  const old = frontmatter(text);
  const history = `- ${JSON.stringify(oneLine(current, 300))} valid_from: ${str(old.valid_from) || '?'} · valid_until: ${iso} · ` +
    `source: ${oneLine(str(old.source), 200) || '?'} · accepted_by: ${str(old.accepted_by) || '?'} · replaced_by: ${JSON.stringify(oneLine(value, 300))}`;
  const after = appendUnder(setFrontmatter(setBlock(text, 'fact', value), fields), '## History', history);
  put(root, rel, after);
  ctx.touched.add(rel);
  const id = revise(ctx, { kind: 'fact', state: 'written', page, section: key, block: 'fact', before: sha(current), after: sha(value), text_hash: sha(value) });
  return { ok: true, state: 'written', revision: id, page, message: `written: fact ${key} replaced (old value kept in History) → ${rel} (r ${id})` };
}

/**
 * D131: the sending PC's row of Facts/working-copies (the PC is the verified caller). No History and no proposal:
 * it is machine state. A person's edit of the table is kept, recorded once as a conflict, and the keeper stops
 * updating it until a person empties or removes the block (like the sync line, D124).
 */
function writeWorkingCopy(ctx: Ctx): WriteResult {
  const { root, space, req } = ctx;
  const page = WORKING_COPIES_PAGE;
  const rel = `${space.dir}/${page}`;
  const text = read(root, rel);
  const current = text === null ? '' : getBlock(text, 'fact') ?? '';
  const expected = lastFor(ctx.all, space.key, page, 'fact')?.after;
  if (current.trim() && expected !== undefined && sha(current) !== expected) {
    const noted = latest(ctx.all, (r) => r.space === space.key && r.page === page && r.kind === 'conflict');
    if (noted?.after === sha(current)) return { ok: true, state: 'unchanged', revision: '', page, message: `unchanged: a person edited ${rel}; it is left alone until they empty the table` };
    const id = revise(ctx, { kind: 'conflict', state: 'conflict', page, block: 'fact', before: expected, after: sha(current) });
    return { ok: true, state: 'conflict', revision: id, page, conflicts_with: rel, message: `conflict: a person edited ${rel}; their table was kept` };
  }
  const after = workingCopiesPage(text, req.author.pc, req.working_copies!, new Date(ctx.now).toISOString());
  const block = getBlock(after, 'fact') ?? '';
  put(root, rel, after);
  ctx.touched.add(rel);
  const id = revise(ctx, { kind: 'fact', state: 'written', page, section: 'working-copies', block: 'fact', before: sha(current), after: sha(block), text_hash: sha(req.text) });
  return { ok: true, state: 'written', revision: id, page, message: `written: working copy ${req.author.pc} ${req.working_copies!.folder} → ${rel} (r ${id})` };
}

function writeDecision(ctx: Ctx): WriteResult {
  const { root, space, req } = ctx;
  const topic = str(req.section);
  const page = 'Decisions.md';
  const rel = `${space.dir}/${page}`;
  // The accepted decision on this topic is the keeper's last one; a different one must name what it replaces.
  const prior = topic ? latest(ctx.all, (r) => r.space === space.key && r.kind === 'decision' && r.section === topic) : undefined;
  if (prior && prior.text_hash !== sha(req.text) && (req.replaces === undefined || sha(req.replaces) !== prior.text_hash)) {
    return writeProposal(ctx, topic, `${rel}#^r-${prior.id}`, `the accepted decision on ${topic} (r ${prior.id})`);
  }
  if (prior && prior.text_hash === sha(req.text)) return { ok: true, state: 'unchanged', revision: prior.id, page, message: `unchanged: already decided (r ${prior.id})` };
  const before = read(root, rel) ?? DECISIONS;
  const id = newId();
  const accepted = str(req.accepted_by) || req.author.person || who(req.author);
  const after = appendUnder(before, ACCEPTED, entry(ctx, id, req.text, ` · accepted by ${accepted}${prior ? ` · supersedes ${wiki(`${rel}#^r-${prior.id}`)}` : ''}`));
  put(root, rel, after);
  ctx.touched.add(rel);
  revise(ctx, { kind: 'decision', state: 'written', page, section: topic || undefined, before: sha(before), after: sha(after), text_hash: sha(req.text) }, id);
  return { ok: true, state: 'written', revision: id, page, message: `written: decision → ${rel} (r ${id})` };
}

/** Decisions.md under "Connected businesses", and the other name as an alias in the Overview's front matter. */
// -- research (D126) -------------------------------------------------------------------------------

/**
 * A research write's space is a business: a business space itself, a client's business, or the business a project is
 * filed in (Shared tools and Unsorted have no research). Written from a client or project, that space's Overview is
 * added to `related`; every related item is resolved to a wikilink here, so a bad one is refused before anything is written.
 */
function researchTarget(root: string, space: Space, req: WriteRequest): { target: Space; req: WriteRequest } {
  const g = groupingOf(root);
  let b: Business | undefined;
  let origin = '';
  // Research and learning notes with no space, or from a project in Shared tools or Unsorted, go to Learning (2026-11-07).
  const learning = learningBusiness(g);
  if (!str(req.space) && !str(req.tobira_id)) b = learning ?? space.business;
  else if (space.kind === 'business') b = space.business;
  else if (space.kind === 'client') { b = space.business; if (space.dir) origin = wiki(`${space.dir}/Overview`, path.posix.basename(space.dir)); }
  else {
    const place = space.place ?? placeOfDir(g, space.dir) ?? undefined;
    b = place && (place.kind === 'business' || place.kind === 'client') ? place.business : learning;
    if (fs.existsSync(abs(root, `${space.dir}/Overview.md`))) origin = wiki(`${space.dir}/Overview`, path.posix.basename(space.dir));
  }
  if (!b) {
    throw new Error(`research needs a business: pass space "business:<key>" (${g.businesses.map((x) => x.key).join(', ')}), ` +
      `e.g. vault(op="write", kind="research", space="business:${g.businesses[0]?.key ?? '<key>'}", topic="…", text="…", source="…")`);
  }
  const dir = businessDir(root, g, b);
  const related = [...(req.related ?? []).map((r) => relatedLink(root, g, dir, r.trim())), ...(origin ? [origin] : [])];
  return { target: { key: businessSpaceKey(g, b), dir, kind: 'business', business: b }, req: { ...req, related: [...new Set(related)] } };
}
/** The business research and learning notes go to by default: key "learning" or folder "Learning", when configured. */
export const learningBusiness = (g: Grouping): Business | undefined =>
  g.businesses.find((b) => b.key === 'learning') ?? g.businesses.find((b) => b.folder.toLowerCase() === 'learning');
/** A related item as a wikilink: a [[link]] as given, project:<repo> and client IDs to their Overview, a name to that research note. */
function relatedLink(root: string, g: Grouping, dir: string, r: string): string {
  if (r.startsWith('[[')) return r;
  const project = PROJECT.exec(r);
  if (project) {
    const found = findProject(root, g, project[1]!);
    if (!found) throw new Error(`related ${r}: there is no such project space`);
    return wiki(`${found}/Overview`, path.posix.basename(found));
  }
  if (TOBIRA.test(r)) {
    const found = findClientIn(root, g, r);
    if (!found) throw new Error(`related ${r}: there is no such client`);
    return wiki(`${found}/Overview`, path.posix.basename(found));
  }
  return wiki(`${researchDir(dir)}/${noteFile(r)}`, r);
}
/** The field's hash as the keeper last set or saw it on this page (research notes share their business's space). */
const lastPageField = (all: Revision[], space: string, page: string, f: string): string | undefined =>
  latest(all, (r) => r.space === space && r.page === page && r.fields?.[f] !== undefined)?.fields![f];
const RESEARCH_LISTS = ['tags', 'sources', 'related'];
const researchHash = (fm: Record<string, unknown>, f: string): string => sha(RESEARCH_LISTS.includes(f) ? JSON.stringify(listOf(fm[f])) : str(fm[f]));

/**
 * One research note (D126): `<Business>/Research/<name>.md`. A new note is made whole; an existing one has its
 * summary replaced (a person's edit of it is a conflict, like any keeper block), its topic, status, date and
 * confidence set (a value a person changed by hand stays, with a conflict), and its tags, sources and related links
 * merged, never shrunk. Then the folder's Research index and research map follow.
 */
function writeResearch(ctx: Ctx): WriteResult {
  const { root, space, req, now } = ctx;
  const b = space.business!;
  const topic = str(req.topic);
  const title = str(req.name) || topic;
  const page = `Research/${noteFile(title)}.md`;
  const rel = `${space.dir}/${page}`;
  const rdir = researchDir(space.dir);
  const text = lf(req.text).trim();
  const before = read(root, rel);
  const fm = before === null ? {} : frontmatter(before);
  const iso = new Date(now).toISOString();
  const scalars: Record<string, string> = {
    topic, ...(req.status || before === null ? { status: req.status ?? 'draft' } : {}),
    ...(req.date || before === null ? { date: req.date ?? iso.slice(0, 10) } : {}), ...(req.confidence ? { confidence: req.confidence } : {}),
  };
  const lists: Record<string, string[]> = { tags: [RESEARCH_TAG, topicTag(topic)], sources: (req.sources ?? []).map((s) => s.trim()), related: req.related ?? [] };
  if (before !== null) {
    const current = getBlock(before, 'summary') ?? '';
    const expected = lastFor(ctx.all, space.key, page, 'summary')?.after ?? sha('');
    if (sha(current) !== expected) return conflict(ctx, page, 'summary', current, expected);
  }
  const set: Record<string, string | string[]> = {};
  const conflicts: string[] = [];
  for (const [f, v] of Object.entries(scalars)) {
    if (str(fm[f]) === v) continue;
    const last = lastPageField(ctx.all, space.key, page, f);
    if (before !== null && last !== undefined && last !== researchHash(fm, f)) { conflicts.push(f); continue; }
    set[f] = v;
  }
  for (const [f, v] of Object.entries(lists)) {
    const have = listOf(fm[f]);
    const merged = [...have];
    for (const x of v) if (!merged.some((m) => fold(m) === fold(x))) merged.push(x);
    if (merged.length !== have.length || (before === null && merged.length)) set[f] = merged;
  }
  const all = { ...fm, ...set };
  const sources = listOf(all.sources).map(sourceLine).join('\n');
  const related = listOf(all.related).map((r) => `- ${r}`).join('\n');
  const parent = `Part of ${wiki(`${rdir}/${RESEARCH_INDEX}`, `${b.folder} research`)} · topic: ${str(all.topic) || topic}`;
  let after: string;
  if (before === null) {
    after = notePage(title, parent, setFrontmatter('', { ...set, cssclasses: ['research'], created: iso, updated: iso }), text, sources, related);
  } else {
    after = before;
    if (Object.keys(set).length || sha(getBlock(before, 'summary') ?? '') !== sha(text)) after = setFrontmatter(after, { ...set, updated: iso });
    after = setBlock(after, 'summary', text);
    after = setBlock(after, 'parent', parent);
    after = setBlock(after, 'sources', sources);
    after = setBlock(after, 'related', related);
  }
  const conflictLines = conflicts.map((f) => {
    const cid = revise(ctx, { kind: 'conflict', state: 'conflict', page, block: `frontmatter:${f}`, before: lastPageField(ctx.all, space.key, page, f)!,
      after: researchHash(fm, f), fields: { [f]: researchHash(fm, f) } });
    return `${f} (r ${cid})`;
  });
  if (after === before) {
    return { ok: true, state: 'unchanged', revision: '', page, message: `unchanged: ${rel} already says this${conflictLines.length ? `; a person changed ${conflictLines.join(', ')} by hand, their value was kept` : ''}`,
      ...(conflictLines.length ? { conflicts_with: rel } : {}) };
  }
  put(root, rel, after);
  ctx.touched.add(rel);
  const fmAfter = frontmatter(after);
  const id = revise(ctx, { kind: 'research', state: 'written', page, section: topic, block: 'summary', before: sha(getBlock(before ?? '', 'summary') ?? ''),
    after: sha(text), text_hash: sha(text), fields: Object.fromEntries([...Object.keys(scalars), ...RESEARCH_LISTS].map((f) => [f, researchHash(fmAfter, f)])) });
  for (const r of refreshResearch(root, b, space.dir)) ctx.touched.add(r);
  return { ok: true, state: 'written', revision: id, page, ...(conflictLines.length ? { conflicts_with: rel } : {}),
    message: `written: research ${before === null ? 'note' : 'updated'} → ${rel} (r ${id})` +
      `${conflictLines.length ? `; a person changed ${conflictLines.join(', ')} by hand, their value was kept and listed on Needs attention` : ''}` };
}
const VISUALS_STATE = '.keeper/visuals.json';
/**
 * A business's Research index block, its Research.base (made once) and its research map: redrawn while the map is
 * the keeper's own (its hash is the one the keeper last wrote), else only the notes it does not show yet are added.
 */
export function refreshResearch(root: string, b: Business, dir: string): string[] {
  const rdir = researchDir(dir);
  const notes = researchNotes(root, dir);
  const touched: string[] = [];
  create(root, `${dir}/Research.base`, researchBase(dir));
  const index = `${rdir}/${RESEARCH_INDEX}`;
  const itext = read(root, index) ?? indexPage(dir, b.folder);
  const inext = setBlock(itext, 'research', indexBlock(notes));
  if (inext !== read(root, index)) { put(root, index, inext); touched.push(index); }
  const map = `${rdir}/${mapName(b.folder)}`;
  let state: { canvas?: Record<string, string> } = {};
  try { state = JSON.parse(read(root, VISUALS_STATE) ?? '{}') as typeof state; } catch { /* rewritten below */ }
  const fresh = researchCanvas(dir, b.folder, notes);
  const have = read(root, map);
  const known = state.canvas?.[map];
  const own = have === null || (known !== undefined ? sha(have) === known : have === canvasText(researchCanvas(dir, b.folder, [])));
  if (own) {
    const next = canvasText(fresh);
    if (next !== have) put(root, map, next);
    state = { ...state, canvas: { ...state.canvas, [map]: sha(next) } };
    put(root, VISUALS_STATE, `${JSON.stringify(state)}\n`);
  } else {
    const parsed = parseCanvas(have!);
    if (parsed) {
      const next = canvasText(mergeCanvas(parsed, fresh));
      if (lf(next) !== lf(have!)) put(root, map, next);
    }
  }
  return touched;
}

function writeConnection(ctx: Ctx): WriteResult {
  const { root, space, req, now } = ctx;
  const c = connectionOf(req);
  const line = connectionLine(req);
  const page = 'Decisions.md';
  const rel = `${space.dir}/${page}`;
  const prior = latest(ctx.all, (r) => r.space === space.key && r.kind === 'connection' && r.text_hash === sha(line));
  if (prior) return { ok: true, state: 'unchanged', revision: prior.id, page, message: `unchanged: ${c.name} is already recorded (r ${prior.id})` };
  const before = read(root, rel) ?? DECISIONS;
  const id = newId();
  const evidence = str(req.evidence) !== str(req.source) ? ` · evidence: ${oneLine(str(req.evidence), 200)}` : '';
  const after = appendUnder(before, CONNECTED, entry({ ...ctx, req: { ...req, section: '' } }, id, line, evidence));
  put(root, rel, after);
  ctx.touched.add(rel);
  let aliased = false;
  const overview = `${space.dir}/Overview.md`;
  const text = read(root, overview);
  if (text !== null) {
    const fm = frontmatter(text);
    const aliases = Array.isArray(fm.aliases) ? fm.aliases.map(String).filter(Boolean) : str(fm.aliases) ? [str(fm.aliases)] : [];
    if (!aliases.some((a) => fold(a) === fold(c.name))) {
      put(root, overview, setFrontmatter(text, { aliases: [...aliases, c.name], updated: new Date(now).toISOString() }));
      ctx.touched.add(overview);
      aliased = true;
    }
  }
  // The aliases the keeper just wrote are its last known value, so a later front matter write is not a false conflict.
  const fields = aliased ? { fields: { aliases: fieldHash(frontmatter(read(root, overview) ?? ''), 'aliases') } } : {};
  revise(ctx, { kind: 'connection', state: 'written', page, section: c.name, before: sha(before), after: sha(after), text_hash: sha(line), ...fields }, id);
  return { ok: true, state: 'written', revision: id, page,
    message: `written: connection ${c.name} → ${rel}${aliased ? ', alias added to Overview' : ''} (r ${id})` };
}

// -- credentials (D99) ----------------------------------------------------------------------------

/** The Credentials page a space's first credential write makes. */
const rowKey = (site: string, account: string): string => `${fold(site.trim())}\n${fold(account.trim())}`;
const credentialsPage = (space: Space): string => `# Credentials\n\n` +
  `Passwords for ${space.kind === 'business' ? space.business!.folder : space.name || space.key} (D99: only the vault's two owners can open this vault). ` +
  'Agents add or change rows only with vault write kind=credential and use them by name; ' +
  'never copy a password into another note or a chat.\n\n' +
  `${open('credentials')}\n${CREDENTIAL_HEADER}\n${close('credentials')}\n`;

/**
 * One row per site and account in the space's Credentials page; an update replaces that row in place. Rows a
 * person added stay. A row a person changed by hand since the keeper last wrote it keeps the person's values: a
 * conflict revision is recorded and Needs attention lists it. The agent's password is never written elsewhere
 * (no proposal), and no revision or log line holds it.
 */
function writeCredential(ctx: Ctx): WriteResult {
  const { root, space, req, now } = ctx;
  const page = CREDENTIALS_PAGE;
  const rel = `${space.dir}/${page}`;
  const site = str(req.site);
  const account = str(req.account);
  const key = `${site}/${account}`;
  const text = read(root, rel) ?? credentialsPage(space);
  const before = getBlock(text, 'credentials') ?? '';
  const lines = before ? before.split('\n') : [];
  // The keeper's header first; every other line in the block (a person's rows, notes) is kept in its order.
  let rows = lines.filter((l) => l.trim() && !(isTableLine(l) && (isSeparator(l) || fold(rowCells(l)[0]?.trim() ?? '') === 'site')));
  const at = rows.findIndex((l) => { const r = isTableLine(l) ? parseRow(l) : null; return !!r && rowKey(r.site, r.account) === rowKey(site, account); });
  const old = at >= 0 ? parseRow(rows[at]!) : null;
  const next: CredentialRow = { site, account, value: req.value!, url: str(req.url) || old?.url || '', note: str(req.note) || old?.note || '' };
  if (old && old.value === next.value && old.url === next.url && old.note === next.note && old.site === site && old.account === account) {
    return { ok: true, state: 'unchanged', revision: '', page, message: `unchanged: credential ${key} is already recorded in ${rel}` };
  }
  const last = latest(ctx.all, (r) => r.space === space.key && r.page === page && r.section === key && (r.kind === 'credential' || r.kind === 'conflict'));
  const known = last ? (last.kind === 'credential' ? last.text_hash : last.after) : undefined;
  if (old && known !== undefined && sha(rows[at]!) !== known) {
    const id = revise(ctx, { kind: 'conflict', state: 'conflict', page, section: key, block: `credentials:${key}`, before: known, after: sha(rows[at]!) });
    return { ok: true, state: 'conflict', revision: id, page, conflicts_with: rel,
      message: `conflict: a person changed the ${key} row in ${rel} by hand; their row was kept and listed on Needs attention. ` +
        'Nothing was written; ask the person which password is current. A later write replaces the row.' };
  }
  const line = rowLine(next, stamp(now));
  if (at >= 0) rows[at] = line; else rows = [...rows.filter(isTableLine), line, ...rows.filter((l) => !isTableLine(l))];
  const after = [CREDENTIAL_HEADER, ...rows].join('\n');
  put(root, rel, setBlock(text, 'credentials', after));
  ctx.touched.add(rel);
  const id = revise(ctx, { kind: 'credential', state: 'written', page, section: key, block: 'credentials', before: sha(before), after: sha(after), text_hash: sha(line) });
  return { ok: true, state: 'written', revision: id, page, message: `written: credential updated: ${key} → ${rel} (r ${id})` };
}

/** The field's hash as the keeper last set or saw it in this space (none: the keeper never touched it). */
const lastField = (all: Revision[], space: string, f: string): string | undefined =>
  latest(all, (r) => r.space === space && r.fields?.[f] !== undefined)?.fields![f];

interface FrontmatterResult { message: string; lines: string[]; revision: string; written: boolean; conflictsWith?: string }
/**
 * The write's front matter on the space's Overview: whitelisted fields only, lists merged and never shrunk,
 * every other key and the body kept. A field a person changed since the keeper's last revision of it keeps the
 * person's value: a conflict revision, a proposal with the agent's value, and Needs attention. The person's value
 * then counts as the keeper's last one, so the conflict is reported once.
 */
function writeFrontmatter(ctx: Ctx): FrontmatterResult {
  const { root, space, req, now } = ctx;
  const want = req.frontmatter!;
  const page = 'Overview.md';
  const rel = `${space.dir}/${page}`;
  const before = read(root, rel) ??
    (space.kind === 'client' ? clientOverview(root, space, space.tobiraId!, space.name || space.tobiraId!, now) : projectOverview(root, space, now));
  const fm = frontmatter(before);
  const set: Record<string, string | string[]> = {};
  const fields: Record<string, string> = {};
  const changes: string[] = [];
  const conflicts: FrontmatterField[] = [];
  let stage: [string, string] | null = null;
  for (const f of FRONTMATTER_FIELDS) {
    if (want[f] === undefined) continue;
    const current = fieldHash(fm, f);
    const last = lastField(ctx.all, space.key, f);
    let next: string | string[];
    let change: string;
    if (LIST_FIELDS.includes(f)) {
      const have = listOf(fm[f]);
      const norm = f === 'tags' ? tagOf : (x: string): string => x.trim();
      const merged = [...have];
      for (const x of (want[f] as string[]).map(norm)) if (!merged.some((m) => fold(norm(m)) === fold(x))) merged.push(x);
      next = merged;
      change = `${f} + ${merged.slice(have.length).join(', ')}`;
      if (merged.length === have.length) { if (last !== current) fields[f] = current; continue; }
    } else {
      next = want[f] as string;
      change = `${f} ${next}`;
      if (str(fm[f]) === next) { if (last !== current) fields[f] = current; continue; }
    }
    if (last !== undefined && last !== current) { conflicts.push(f); continue; }
    if (f === 'stage') stage = [str(fm.stage), next as string];
    set[f] = next;
    fields[f] = fieldHash(set, f);
    changes.push(change);
  }
  const lines: string[] = [];
  const by = `— ${who(req.author)}`;
  let after = before;
  let id = '';
  if (changes.length) after = setFrontmatter(before, { ...set, updated: new Date(now).toISOString() });
  if (after !== read(root, rel)) { put(root, rel, after); ctx.touched.add(rel); }
  if (Object.keys(fields).length) {
    id = revise(ctx, { kind: 'frontmatter', state: changes.length ? 'written' : 'unchanged', page, section: Object.keys(fields).join(', '),
      block: 'frontmatter', before: sha(before), after: sha(after), fields });
  }
  if (changes.length) {
    lines.push(`- ${stamp(now)} front matter ${wiki(rel, 'Overview')}: ${oneLine(changes.join('; '), 300)} ${by} ^r-${id}`);
    if (stage) lines.push(`- ${stamp(now)} stage: ${stage[0] || '(none)'} → ${stage[1]} (${oneLine(req.source, 200)}) ${by} ^r-${id}`);
  }
  let proposal = '';
  if (conflicts.length) {
    for (const f of conflicts) {
      const cid = revise(ctx, { kind: 'conflict', state: 'conflict', page, block: `frontmatter:${f}`,
        before: lastField(ctx.all, space.key, f)!, after: fieldHash(fm, f), fields: { [f]: fieldHash(fm, f) } });
      lines.push(`- ${stamp(now)} conflict ${wiki(rel, 'Overview')}: a person changed ${f} by hand; their value was kept ${by} ^r-${cid}`);
    }
    const text = `Overview front matter: ${conflicts.map((f) => `${f} → ${JSON.stringify(want[f])} (a person set ${JSON.stringify(fm[f] ?? '')})`).join('; ')}`;
    proposal = writeProposal({ ...ctx, req: { ...req, request_id: `${req.request_id}-fm`, text } }, 'front matter', rel).revision;
  }
  const parts = [
    ...(changes.length ? [`front matter set: ${changes.join('; ')} (r ${id})`] : []),
    ...(conflicts.length ? [`front matter conflict: a person changed ${conflicts.join(', ')} by hand; their value was kept and listed on ` +
      `Needs attention, and yours was recorded as a proposal (r ${proposal})`] : []),
  ];
  return { message: parts.join('; ') || 'front matter unchanged', lines, revision: id, written: changes.length > 0,
    ...(conflicts.length ? { conflictsWith: rel } : {}) };
}

/** Under "Proposed — not accepted": never changes a fact or a decision. */
function writeProposal(ctx: Ctx, topic: string, conflictsWith: string, against = ''): WriteResult {
  const { root, space, req } = ctx;
  const page = 'Decisions.md';
  const rel = `${space.dir}/${page}`;
  const before = read(root, rel) ?? DECISIONS;
  const id = newId();
  const link = conflictsWith ? ` · **Conflicts with** ${wiki(conflictsWith)}` : '';
  const after = appendUnder(before, PROPOSED, entry({ ...ctx, req: { ...req, section: topic } }, id, req.text, `${link}${req.kind !== 'proposal' ? ` · offered as ${req.kind}` : ''}`));
  put(root, rel, after);
  ctx.touched.add(rel);
  revise(ctx, { kind: 'proposal', state: conflictsWith ? 'proposal' : 'written', page, section: topic || undefined,
    before: sha(before), after: sha(after), text_hash: sha(req.text), ...(conflictsWith ? { conflicts_with: conflictsWith } : {}) }, id);
  if (!conflictsWith || !against) return { ok: true, state: conflictsWith ? 'proposal' : 'written', revision: id, page, ...(conflictsWith ? { conflicts_with: conflictsWith } : {}), message: `written: proposal → ${rel} (r ${id})` };
  return { ok: true, state: 'proposal', revision: id, page, conflicts_with: conflictsWith,
    message: `not applied: this contradicts ${against}. Written as a proposal under "Proposed — not accepted" in ${rel} (r ${id}) ` +
      'for a person to decide. To replace it on a person\'s word, write again with replaces set to the current text.' };
}

// -- reading --------------------------------------------------------------------------------------
