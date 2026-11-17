/** Reading: a page with its "based on" line (passwords masked), and finding a client page by ID, name or alias. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseClientDir } from './vault-layout.js';
import { isLogPage, logView } from './vault-catchup.js';
import { charBoundary } from './text-cut.js';
import { type PageInfo, abs, factAgeMark, buildIndex, fold, groupingOf, loadIndex, pageInfo, read } from './vault-store.js';
import { spaceFor } from './vault-spaces.js';
import { maskCredentials } from './vault-mask.js';

export function basedOn(root: string, rels: string[], now = Date.now()): string {
  const index = loadIndex(root);
  return `based on: ${rels.map((rel) => {
    const info = index?.pages[rel] ?? pageInfo(root, rel);
    const updated = info?.updated || (info ? new Date(info.mtime).toISOString() : '?');
    const mark = /\/Facts\//.test(rel) && info ? factAgeMark(Date.parse(info.updated ?? '') || info.mtime, now) : '';
    return `${rel} (updated ${updated.slice(0, 16).replace('T', ' ')}${mark ? `; ${mark}` : ''})`;
  }).join('; ')}`;
}
function inside(root: string, rel: string): string {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(root, clean);
  const back = path.relative(root, full);
  if (!back || back.startsWith('..') || path.isAbsolute(back) || back.split(path.sep).some((p) => p.startsWith('.'))) {
    throw new Error('page must be a note inside the vault');
  }
  return back.split(path.sep).join('/');
}
export interface ReadOptions {
  reveal?: boolean;
  /** Log pages (D132): entries per answer, older than an entry id or time, or since a time. */
  limit?: unknown; before?: string; since?: string; now?: number;
  /** Read the page as written, from this character on. */
  offset?: unknown;
}
const PAGE_CHARS = 20_000;
/**
 * reveal: show passwords in Credentials tables (D99); by default every table's password column is masked.
 * A log page (Communication, Work log, log) reads newest first, a page of entries at a time (D132); offset reads
 * any page as written, 20000 characters at a time.
 */
export function readPage(root: string, page: string, space?: string, opts: ReadOptions = {}): string {
  let rel = inside(root, page);
  if (space) {
    const s = spaceFor(root, { space });
    if (!s.dir) throw new Error(`no folder for ${space}`);
    rel = inside(root, `${s.dir}/${rel}`);
  }
  if (!fs.existsSync(abs(root, rel)) && fs.existsSync(abs(root, `${rel}.md`))) rel = `${rel}.md`;
  let text = read(root, rel);
  if (text === null) throw new Error(`no page ${rel}`);
  if (!opts.reveal) text = maskCredentials(text);
  const raw = opts.offset !== undefined && opts.offset !== null && opts.offset !== '';
  if (!raw && isLogPage(rel)) {
    return `${logView(rel, text, { page, space, limit: opts.limit, before: opts.before, since: opts.since, now: opts.now })}\n\n${basedOn(root, [rel], opts.now)}`;
  }
  if (!raw && (opts.before || opts.since)) throw new Error('before and since are for log pages (Communication, Work log, log, Ledger)');
  const from = raw ? Math.max(0, Math.floor(Number(opts.offset)) || 0) : 0;
  // Offsets count UTF-16 units; neither end of a part splits a surrogate pair.
  const start = charBoundary(text, from);
  const part = text.slice(start, charBoundary(text, start + PAGE_CHARS));
  const next = start + part.length;
  const more = next < text.length
    ? `\n… (characters ${start}–${next} of ${text.length}; the rest: vault op="read"${space ? ` space="${space}"` : ''} page="${page}" offset=${next})`
    : start ? `\n(characters ${start}–${next} of ${text.length}: the end)` : '';
  return `${part.replace(/\n*$/, '')}${more}\n\n${basedOn(root, [rel])}`;
}

/** Client Overviews whose ID, name or alias match (exact first, else partly). */
export function matchClients(root: string, query: string): Array<[string, PageInfo]> {
  const q = fold(query.trim());
  if (!q) return [];
  const index = loadIndex(root) ?? buildIndex(root);
  const g = groupingOf(root);
  // Client Overviews, flat or in their stage group (not a client-nested project's).
  const overviews = Object.entries(index.pages).filter(([rel]) => {
    if (!rel.endsWith('/Overview.md')) return false;
    const c = parseClientDir(g, path.posix.dirname(rel));
    return !!c && !c.rest.length;
  });
  const names = ([, p]: [string, PageInfo]): string[] => [p.title, ...p.aliases].map(fold);
  const exact = overviews.filter(([rel, p]) => fold(p.tobira_id ?? '') === q || names([rel, p]).includes(q));
  return exact.length ? exact : overviews.filter(([rel, p]) => names([rel, p]).some((n) => n.includes(q) || q.includes(n)) || fold(rel).includes(q));
}

/** Resolve a Acme ID, name or alias to the client's folder and Overview. */
export function findClientPage(root: string, query: string): string {
  if (!fold(query.trim())) throw new Error('query required');
  const found = matchClients(root, query);
  if (!found.length) return `no client matches "${query}"`;
  if (found.length > 1) return `several clients match "${query}":\n${found.slice(0, 10).map(([rel, p]) => `${p.tobira_id ?? '?'} | ${p.title} | ${path.posix.dirname(rel)}`).join('\n')}`;
  const [rel, p] = found[0]!;
  // D132: what is new is one call away; the answer still ends with its based-on line.
  return `${p.tobira_id ?? '(no Acme ID)'} | ${path.posix.dirname(rel)}/` +
    `${p.tobira_id ? ` | what's new, newest first: vault op="catchup" space="${p.tobira_id}"` : ''}\n\n${readPage(root, rel)}`;
}

// -- the nightly check-up -------------------------------------------------------------------------
