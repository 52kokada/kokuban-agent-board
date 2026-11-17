/**
 * Catching up from the vault cheaply (D132: the vault must be easy for agents to read and be
 * caught up with). Read-time views only: nothing here writes a note.
 *
 * - Log pages (Communication, Work log, log) are lists of keeper entries ("- 2026-11-05 12:19Z …", indented
 *   continuation lines, "^r-<id>" at the end). A read shows them newest first, a page at a time (limit, before,
 *   since); offset reads the page as written.
 * - search answers with the matching entries or lines, not only page names.
 * - catchup: one call for a client, project or business: where it stands (Overview summary and front matter),
 *   the newest entries across its log pages and Decisions, facts by last change, how to get more.
 */
import * as path from 'node:path';
import { headChars } from './text-cut.js';
import { frontmatter } from './vault-layout.js';
import { maskCredentials } from './vault-mask.js';
import { basedOn, matchClients } from './vault-read.js';
import { spaceFor } from './vault-spaces.js';
import { FACT_STALE_DAYS, buildIndex, factAgeMark, getBlock, loadIndex, notes, read, type PageInfo } from './vault-store.js';

export const LOG_PAGES = new Set(['Communication.md', 'Work log.md', 'log.md', 'Ledger.md']);
export const isLogPage = (rel: string): boolean => LOG_PAGES.has(path.posix.basename(rel));
/** What one read of a log page shows by default, and at most. */
export const READ_LIMIT = 10;
const READ_MAX = 100;
const READ_CHARS = 12_000;
const ENTRY_CHARS = 3_000;
const SEARCH_CHARS = 8_000;
const CATCHUP_LIMIT = 8;
const CATCHUP_ENTRY = 400;

export interface Entry {
  /** "2026-11-05 12:19Z" as written, or null for a line a person added without a time. */
  stamp: string | null;
  /** The time in ms (UTC), or null. */
  at: number | null;
  /** The keeper's revision id ("r-…"), or null. */
  id: string | null;
  /** The last "## " heading above it (Decisions: Accepted, Proposed — not accepted, Connected businesses). */
  section: string;
  text: string;
  /** Its order in the file. */
  pos: number;
}

const FM = /^---\n[\s\S]*?\n---(?:\n|$)/;
const STAMP = /^- (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})Z\b/;
const ID = /\^(r-[0-9a-f]{4,})\s*$/;

/** A page's entries ("- " at the start of a line, with its indented lines) and whether other text sits between them. */
export function entriesOf(text: string): { entries: Entry[]; other: boolean } {
  const lines = text.replace(/\r\n/g, '\n').replace(FM, '').split('\n');
  const entries: Entry[] = [];
  let section = '';
  let other = false;
  let cur: string[] | null = null;
  const flush = (): void => {
    if (!cur) return;
    while (cur.length && !cur.at(-1)!.trim()) cur.pop();
    const body = cur.join('\n');
    const m = STAMP.exec(body);
    entries.push({ stamp: m ? `${m[1]} ${m[2]}Z` : null, at: m ? Date.parse(`${m[1]}T${m[2]}:00Z`) : null,
      id: ID.exec(body)?.[1] ?? null, section, text: body, pos: entries.length });
    cur = null;
  };
  for (const line of lines) {
    if (/^- /.test(line)) { flush(); cur = [line]; continue; }
    if (cur && (/^\s/.test(line) || !line.trim())) { cur.push(line); continue; }
    flush();
    const h = /^##\s+(.+)$/.exec(line);
    if (h) section = h[1]!.trim();
    else if (line.trim() && !/^# /.test(line)) other = true;
  }
  flush();
  return { entries, other };
}

/**
 * A time for since/before: "2d", "12h", "90m" (ago), an ISO date or time, "2026-11-05 12:19Z" as entries show it,
 * or a time with "JST". A time without a zone is UTC, like the entries.
 */
export function parseWhen(value: string, now: number): number {
  const s = value.trim();
  const rel = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(s);
  if (rel) return now - Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2]!.toLowerCase() as 'm']!;
  let t = s.replace(/\s*JST$/i, '+09:00').replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)/, (_, d: string, h: string) => `${d}T${h.padStart(5, '0')}`);
  if (/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(t)) t += 'Z';
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) throw new Error(`"${value}" is not a time: use 2026-11-05, 2026-11-05 12:19Z, 2026-11-05 21:09 JST or 2d / 12h`);
  return ms;
}

/** At most n characters, cut on whole characters (code points) and before a broken word. */
const clip = (s: string, n: number): string => (headChars(s, n).length < s.length ? `${headChars(s, n - 1).replace(/\s+\S*$/, '')}…` : s);
const fold = (s: string): string => s.normalize('NFKC').toLocaleLowerCase();
const num = (v: unknown, dflt: number, max: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : dflt;
};
/** How to call the tool again, for the hints at the end of an answer. */
const call = (op: string, args: Record<string, string | undefined>): string =>
  `vault op="${op}"${Object.entries(args).filter(([, v]) => v).map(([k, v]) => ` ${k}="${v}"`).join('')}`;

export interface LogOptions { limit?: unknown; before?: string; since?: string; now?: number; space?: string; page: string }

/** A log page newest first, a page of entries at a time. text is already masked. */
export function logView(rel: string, text: string, opts: LogOptions): string {
  const { entries, other } = entriesOf(text);
  const limit = num(opts.limit, READ_LIMIT, READ_MAX);
  const now = opts.now ?? Date.now();
  let list = [...entries].reverse();
  if (opts.before) {
    const b = opts.before.trim().replace(/^\^/, '');
    const at = /^r-[0-9a-f]+$/.test(b) ? list.findIndex((e) => e.id === b) : -1;
    if (at >= 0) list = list.slice(at + 1);
    else if (/^r-/.test(b)) throw new Error(`no entry ${b} on ${rel}`);
    else { const t = parseWhen(b, now); list = list.filter((e) => e.at !== null && e.at < t); }
  }
  let since = '';
  if (opts.since) {
    const t = parseWhen(opts.since, now);
    since = new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
    list = list.filter((e) => e.at !== null && e.at >= t);
  }
  const shown: string[] = [];
  let used = 0;
  for (const e of list.slice(0, limit)) {
    let t = e.text;
    const head = headChars(t, ENTRY_CHARS);
    if (head.length < t.length) {
      t = `${head}\n  … (entry shortened from ${e.text.length} characters${e.id ? `; whole: ${call('search', { space: opts.space, query: e.id })}` : ''})`;
    }
    if (shown.length && used + t.length > READ_CHARS) break;
    shown.push(t);
    used += t.length;
  }
  const title = /^# (.+)$/m.exec(text.replace(FM, ''))?.[1]?.trim() || path.posix.basename(rel, '.md');
  const first = list[0]?.stamp ?? '';
  const last = list[shown.length - 1]?.stamp ?? '';
  const head = `# ${title} · newest first · ${shown.length} of ${list.length}${since ? ` since ${since}` : ''}` +
    `${list.length !== entries.length ? ` (${entries.length} on the page)` : ''}${first ? ` · ${first}${last && last !== first ? ` … ${last}` : ''}` : ''}`;
  const left = list.length - shown.length;
  const tail = left > 0
    ? `… ${left} older${since ? ` since ${since}` : ''}: ${call('read', { space: opts.space, page: opts.page, before: list[shown.length - 1]!.id ?? list[shown.length - 1]!.stamp ?? undefined, ...(since ? { since } : {}) })}`
    : list.length ? 'No older entries.' : since ? 'Nothing since then.' : 'No entries yet.';
  return [head, '', ...(shown.length ? [shown.join('\n'), ''] : []), tail,
    ...(other ? ['Notes outside the entries: read the page as written with offset=0.'] : [])].join('\n');
}

// -- search ---------------------------------------------------------------------------------------

interface Unit { at: number | null; text: string; line?: boolean }
/** What matched on one page: its entries with every word (a log or Decisions), else the lines with the most words. */
function unitsOf(text: string, words: string[], since: number | null): Unit[] {
  const { entries } = entriesOf(text);
  if (entries.some((e) => e.stamp)) {
    const hit = entries.filter((e) => words.every((w) => fold(e.text).includes(w)) && (since === null || (e.at !== null && e.at >= since)));
    if (hit.length || since !== null) return hit.reverse().map((e) => ({ at: e.at, text: e.text }));
  }
  if (since !== null) return [];
  const lines = text.replace(FM, '').split('\n').map((l, i) => ({ l: l.trim(), i, n: words.filter((w) => fold(l).includes(w)).length }))
    .filter((x) => x.l && x.n > 0);
  const best = Math.max(0, ...lines.map((x) => x.n));
  return lines.filter((x) => x.n === best).slice(0, 3).map((x) => ({ at: null, text: `L${x.i + 1}: ${x.l}`, line: true }));
}

export interface SearchOptions { tobira_id?: string; space?: string; since?: string; limit?: unknown; now?: number }

/** Pages, with what matched in each: newest matching entries first. Masked text only (D99). */
export function searchVault(root: string, query: string, opts: SearchOptions = {}): string {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('query required');
  const since = opts.since ? parseWhen(opts.since, opts.now ?? Date.now()) : null;
  const index = loadIndex(root) ?? buildIndex(root);
  const space = opts.space ? spaceFor(root, { space: opts.space }) : null;
  const scoped = Object.entries(index.pages).filter(([rel, p]) =>
    (!opts.tobira_id || p.tobira_id === opts.tobira_id) &&
    (!space || (space.kind === 'client' ? p.tobira_id === space.tobiraId : rel.startsWith(`${space.dir}/`) &&
      // A business's own pages: its clients and projects are spaces of their own.
      !(space.kind === 'business' && (rel.startsWith(`${space.dir}/Clients/`) || rel.startsWith(`${space.dir}/Projects/`))))));
  const named = (rel: string, p: PageInfo): boolean => words.every((w) => fold([rel, p.title, ...p.aliases, ...p.headings].join(' ')).includes(w));
  const pages = scoped.flatMap(([rel, p]) => {
    const raw = read(root, rel);
    if (raw === null) return [];
    // Passwords are never searchable: the text is masked first, so a search cannot confirm a guessed password.
    const text = maskCredentials(raw);
    const byName = named(rel, p);
    if (!byName && !words.every((w) => fold(text).includes(w))) return [];
    const units = unitsOf(text, words, since);
    if (since !== null && !units.length) return [];
    return [{ rel, p, byName, units, newest: Math.max(-1, ...units.map((u) => u.at ?? -1)) }];
  }).sort((a, b) => b.newest - a.newest || Number(b.byName) - Number(a.byName) || a.rel.localeCompare(b.rel));
  if (!pages.length) return since !== null ? 'nothing matches since then' : 'no pages match';
  const maxPages = num(opts.limit, 10, 50);
  const shown = pages.slice(0, maxPages);
  const per = shown.map((x) => x.units.slice(0, 5));
  const count = per.reduce((n, u) => n + u.length, 0);
  // A few hits are shown whole (an entry id as the query: the entry and its log line); many share the budget.
  const total = per.flat().reduce((n, u) => n + u.text.length, 0);
  const cap = total <= 20_000 ? 20_000 : Math.max(600, Math.floor(SEARCH_CHARS / count));
  const blocks: string[] = [];
  let used = 0;
  for (const [i, x] of shown.entries()) {
    const head = `${x.rel} | ${x.p.title}${x.p.tobira_id ? ` | ${x.p.tobira_id}` : ''}`;
    const body = per[i]!.map((u) => {
      const head = headChars(u.text, cap);
      const t = head.length < u.text.length ? `${head} …` : u.text;
      return u.line ? `  ${t}` : t;
    });
    const more = x.units.length - per[i]!.length;
    const block = [head, ...body, ...(more > 0 ? [`  … ${more} more on this page: add words, or since=…`] : [])].join('\n');
    if (blocks.length && used + block.length > Math.max(SEARCH_CHARS, cap) + 2_000) { blocks.push(`… budget reached; also: ${shown.slice(i).map((y) => y.rel).join('; ')}`); break; }
    blocks.push(block);
    used += block.length;
  }
  const rest = pages.length - shown.length;
  const how = pages.every((x) => x.byName && !x.units.length) ? 'name' : 'text';
  return `${blocks.join('\n\n')}${rest > 0 ? `\n… ${rest} more pages (limit=${maxPages})` : ''}\n(matched by ${how})\n${basedOn(root, shown.map((x) => x.rel), opts.now)}`;
}

// -- catching up ----------------------------------------------------------------------------------

/** An entry in a line or two: no source line, links as their labels. */
function brief(e: Entry, page: string): string {
  // A line of links only ("first message · last message") says nothing without the addresses.
  const body = e.text.split('\n').filter((l) => !/^\s*_source: /.test(l) && !/^[\s·|,-]*(\[[^\]]*\]\([^)]*\)[\s·|,-]*)+$/.test(l)).join('\n')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, '$1').replace(/^- \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z\s*/, '').replace(/\s*\^r-[0-9a-f]+\s*$/, '');
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l && l !== '·');
  return `- ${e.stamp ?? '(no time)'} · ${page} · ${clip(lines.join(' / '), CATCHUP_ENTRY)}${e.id ? ` ^${e.id}` : ''}`;
}

/** The pages whose entries are a space's history, newest last. */
function historyPages(kind: 'business' | 'client' | 'project'): string[] {
  return kind === 'client' ? ['Communication.md', 'Work log.md', 'Decisions.md'] : kind === 'project' ? ['Work log.md', 'Decisions.md'] : ['log.md', 'Decisions.md'];
}
const label = (page: string, section: string): string =>
  page !== 'Decisions.md' ? page.replace(/\.md$/, '') : /^Proposed/.test(section) ? 'Proposed' : /^Connected/.test(section) ? 'Connected' : 'Decision';

export interface CatchupOptions { space?: string; tobira_id?: string; query?: string; since?: string; limit?: unknown; now?: number }

/** One call to catch up on a client, project or business. */
export function catchup(root: string, opts: CatchupOptions): string {
  const now = opts.now ?? Date.now();
  let key = (opts.space ?? '').trim() || (opts.tobira_id ?? '').trim();
  if (!key && opts.query?.trim()) {
    const found = matchClients(root, opts.query);
    if (!found.length) return `no client matches "${opts.query}"; for a project pass space="project:<repo>"`;
    if (found.length > 1) return `several clients match "${opts.query}":\n${found.slice(0, 10).map(([rel, p]) => `${p.tobira_id ?? '?'} | ${p.title} | ${path.posix.dirname(rel)}`).join('\n')}`;
    key = found[0]![1].tobira_id ?? '';
  }
  if (!key) throw new Error('catchup needs space ("T-…", "project:<repo>", "agency", "business:<key>") or query (a client\'s name)');
  const space = spaceFor(root, { space: key });
  if (!space.dir || read(root, `${space.dir}/${space.kind === 'business' ? 'Home.md' : 'Overview.md'}`) === null) throw new Error(`no folder for ${key} yet`);
  const ovRel = `${space.dir}/${space.kind === 'business' ? 'Home.md' : 'Overview.md'}`;
  const ov = maskCredentials(read(root, ovRel)!);
  const fm = frontmatter(ov);
  const s = (k: string): string => (typeof fm[k] === 'string' ? (fm[k] as string).trim() : '');
  const out: string[] = [];
  const name = space.kind === 'client' ? `${space.tobiraId} ${s('name') || space.name || ''}`.trim()
    : space.kind === 'project' ? space.key : /^# (.+)$/m.exec(ov.replace(FM, ''))?.[1]?.trim() || space.key;
  const tags = Array.isArray(fm.tags) ? (fm.tags as unknown[]).map(String) : [];
  out.push(`# ${name}${[['stage', s('stage')], ['care', s('care_stage')], ['status', s('status')]].filter(([, v]) => v).map(([k, v]) => ` · ${k} ${v}`).join('')}` +
    `${tags.length ? ` · #${tags.join(' #')}` : ''}${s('updated') ? ` · updated ${s('updated').slice(0, 16).replace('T', ' ')}` : ''}`);
  out.push(`Folder: ${space.dir}/`);

  let summary = getBlock(ov, 'summary') ?? '';
  // The ledger is a link list: one line says where it is.
  const ledger = /^### Ledger[\s\S]*?(?=^### |$(?![\s\S]))/m.exec(summary);
  if (ledger) {
    const links = (ledger[0].match(/\]\(/g) ?? []).length;
    summary = summary.replace(ledger[0], `_Ledger: ${links} links, in the Overview._\n`).trim();
  }
  summary = clip(summary, 3_000);
  // last_event is the newest entry, shown under Latest.
  if (s('next_step') && !summary.includes(s('next_step'))) out.push(`Next step: ${s('next_step')}`);
  if (summary) out.push('', summary);

  // The newest entries across the space's history pages.
  const since = opts.since ? parseWhen(opts.since, now) : null;
  const limit = num(opts.limit, since !== null ? 30 : CATCHUP_LIMIT, READ_MAX);
  const used: string[] = [ovRel];
  const counts: string[] = [];
  const all: Array<{ e: Entry; page: string; rel: string }> = [];
  for (const page of historyPages(space.kind)) {
    const rel = `${space.dir}/${page}`;
    const text = read(root, rel);
    if (text === null) continue;
    const { entries } = entriesOf(maskCredentials(text));
    const timed = entries.filter((e) => e.at !== null && (since === null || e.at >= since));
    if (!timed.length) continue;
    counts.push(`${page.replace(/\.md$/, '')} ${timed.length}`);
    for (const e of timed) all.push({ e, page, rel });
  }
  all.sort((a, b) => b.e.at! - a.e.at! || b.e.pos - a.e.pos);
  // A business's log.md repeats each write's entry: the page's own entry is shown, once.
  const own = new Set(all.filter((x) => x.page !== 'log.md' && x.e.id).map((x) => x.e.id));
  const kept = all.filter((x) => x.page !== 'log.md' || !x.e.id || !own.has(x.e.id));
  const latest = kept.slice(0, limit);
  for (const rel of new Set(latest.map((x) => x.rel))) used.push(rel);
  const sinceText = since !== null ? ` since ${new Date(since).toISOString().slice(0, 16).replace('T', ' ')}Z` : '';
  out.push('', `## Latest${sinceText} · ${latest.length} of ${kept.length}${counts.length ? ` (${counts.join(', ')})` : ''}`);
  if (latest.length) out.push(...latest.map((x) => brief(x.e, label(x.page, x.e.section))));
  else out.push(since !== null ? 'Nothing new since then.' : 'No entries yet.');
  const logs = historyPages(space.kind).filter((p) => p !== 'Decisions.md').map((p) => p.replace(/\.md$/, ''));
  out.push(`More: ${call('read', { space: space.key, page: logs[0] })} (newest first; before="r-…" pages back)` +
    `${logs.length > 1 ? `, page="${logs.slice(1).join('", "')}"` : ''}; since="2d" or "2026-11-05 21:00 JST" for what changed; ` +
    `${call('search', { space: space.key, query: '…' })} for matching entries.`);

  // Proposals wait for a person.
  const dec = read(root, `${space.dir}/Decisions.md`);
  if (dec !== null) {
    const open = entriesOf(dec).entries.filter((e) => /^Proposed/.test(e.section)).length;
    if (open) out.push(`Proposed, not accepted: ${open} on Decisions (a person decides).`);
  }
  // Facts, most recently changed first.
  if (space.kind !== 'business') {
    const index = loadIndex(root);
    const facts = notes(root, `${space.dir}/Facts`).map((rel) => ({ rel, t: Date.parse(index?.pages[rel]?.updated ?? '') || index?.pages[rel]?.mtime || 0 }))
      .sort((a, b) => b.t - a.t);
    if (facts.length) {
      const top = facts.slice(0, 12).map((f) => {
        const mark = factAgeMark(f.t, now);
        const day = new Date(f.t).toISOString();
        return `${path.posix.basename(f.rel, '.md')}${f.t ? ` ${mark ? day.slice(0, 10) : day.slice(5, 10)}` : ''}${mark ? ` (${mark})` : ''}`;
      });
      out.push(`Facts (${facts.length}, last changed first): ${top.join(', ')}${facts.length > top.length ? `, … ${facts.length - top.length} more (listed in the Overview)` : ''}; ` +
        `a fact marked "check before use" last changed over ${FACT_STALE_DAYS} days ago or has no date (write it again with the same value to confirm it); read one with page="Facts/<name>".`);
    }
    const projects = notes(root, `${space.dir}/Projects`).filter((rel) => rel.endsWith('/Overview.md')).map((rel) => path.posix.basename(path.posix.dirname(rel)));
    if (projects.length) out.push(`Its repositories: ${projects.map((p) => `project:${p}`).join(', ')} (catchup each with that space).`);
  }
  out.push('', basedOn(root, used, now));
  return out.join('\n');
}
