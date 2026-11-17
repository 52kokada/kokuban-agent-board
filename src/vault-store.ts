/** The keeper's ground floor: settings, vault paths, note files, front matter, keeper blocks, revisions and the hidden index. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SETTINGS } from './cards.js';
import { CLIENT_ID, DEFAULT_GROUPING, frontmatter, parseGrouping, type Grouping } from './vault-layout.js';
import { clipChars } from './text-cut.js';
import { maskCredentials } from './vault-mask.js';

/**
 * cockpit: acme-cockpit's brain API, used by the keeper only. The token stays in its file and is read per send.
 * grouping: the businesses and which repositories belong where (D102; settings vault.businesses).
 * syncthing (D124, keeper only): where Syncthing's config.xml is ("auto": the usual places), or false for no sync
 * status on Home. Settings always give it; a config built in code without it shows none.
 */
export interface KeeperConfig {
  path: string; keeper: boolean; keeperPc: string; cockpit?: { url: string; tokenFile: string }; grouping?: Grouping; syncthing?: string | false;
}
export const KINDS = ['event', 'fact', 'decision', 'proposal', 'summary', 'connection', 'credential', 'research'] as const;
export type Kind = (typeof KINDS)[number];
/** D104 (amends D50). Older vaults' "reply" is "replied" and "engagement" is "engaging". */
export const STAGES = ['outreach', 'replied', 'sample-made', 'sample-sent', 'engaging', 'proposal', 'signed', 'building', 'launch', 'done', 'closed'];
export const OLD_STAGES: Record<string, string> = { reply: 'replied', engagement: 'engaging' };
export const CARE_STAGES = ['active', 'renewal', 'paused', 'ended'];
/** Overview front matter an agent write may set (client and project spaces). Lists are merged, never shrunk. */
export const FRONTMATTER_FIELDS = ['stage', 'care_stage', 'aliases', 'tags', 'cssclasses', 'business', 'last_event', 'next_step', 'status'] as const;
export type FrontmatterField = (typeof FRONTMATTER_FIELDS)[number];
export const LIST_FIELDS: readonly string[] = ['aliases', 'tags', 'cssclasses'];
export interface FrontmatterWrite {
  stage?: string; care_stage?: string; aliases?: string[]; tags?: string[]; cssclasses?: string[];
  /**
   * Where the space belongs, moved by the keeper. A project: a business key or folder, "shared", "unsorted" or a client ID
   * (re-filed on the next tick). A client (D112): a business key or folder; it keeps its ID and moves right after the write.
   */
  business?: string;
  /** One line: the last thing that happened (Kanban cards show it). The keeper also keeps it from event writes. */
  last_event?: string;
  /** One line: what we do next (the Pipeline card's footer, D120). */
  next_step?: string;
  /** One short line: where a project stands ("active", "paused", …), shown on its business's project status board (D126). */
  status?: string;
}
export const TOBIRA = CLIENT_ID;
export const PROJECT = /^project[:/]([A-Za-z0-9][A-Za-z0-9._-]*)$/i;
export const BUSINESS = /^business:([a-z0-9][a-z0-9-]*)$/i;
export const TEXT_CHARS = 8000;
export const ATTENTION_DAYS = 30;
export const PROPOSED = '## Proposed — not accepted';
export const ACCEPTED = '## Accepted';
export const CONNECTED = '## Connected businesses';
export const PROJECTS_HEADING = '## Projects';
export const CLIENTS_HEADING = '## Clients';
/** The repository files a project Overview points to (never copies). */
export const PROJECT_DOCS = ['README.md', 'AGENTS.md', 'CLAUDE.md'];

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
export const lf = (s: string): string => s.replace(/\r\n/g, '\n');
export const sha = (s: string): string => createHash('sha256').update(lf(s).trim()).digest('hex').slice(0, 16);
export const abs = (root: string, rel: string): string => path.join(root, ...rel.split('/'));
export const stamp = (now: number): string => `${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}Z`;
// Cut on whole characters: a slice by UTF-16 units can split an emoji's surrogate pair and leave "�" in a note.
export const oneLine = (s: string, n = 120): string => clipChars(s.replace(/\s+/g, ' ').trim(), n);
export const wiki = (rel: string, label?: string): string => `[[${rel.replace(/\.md$/, '')}${label ? `|${label}` : ''}]]`;

/**
 * settings.json {"vault": {"path": "...", "keeper": true, "cockpit": {"url": "...", "token_file": "..."}}}.
 * Absent or unreadable: the feature is off. Without cockpit, connections are recorded but not forwarded.
 */
export function keeperConfig(file = SETTINGS.file): KeeperConfig | null {
  try {
    const v = (JSON.parse(fs.readFileSync(file, 'utf8')) as { vault?: Record<string, unknown> }).vault;
    if (!v || typeof v !== 'object' || !str(v.path)) return null;
    const c = (v.cockpit && typeof v.cockpit === 'object' ? v.cockpit : {}) as Record<string, unknown>;
    const cockpit = str(c.url) && str(c.token_file) ? { url: str(c.url).replace(/\/+$/, ''), tokenFile: str(c.token_file) } : undefined;
    return { path: path.resolve(str(v.path)), keeper: v.keeper === true, keeperPc: str(v.keeper_pc) || 'keeper-pc', ...(cockpit ? { cockpit } : {}),
      grouping: v.businesses === undefined ? DEFAULT_GROUPING : parseGrouping(v.businesses), syncthing: v.syncthing === false ? false : str(v.syncthing) || 'auto' };
  } catch {
    return null;
  }
}

const groupings = new Map<string, Grouping>();
/** Use this grouping for the vault at root (tests, and a config passed in explicitly); null forgets it. */
export function useGrouping(root: string, g: Grouping | null): void {
  if (g) groupings.set(path.resolve(root), g); else groupings.delete(path.resolve(root));
}
/** The businesses of the vault at root: one set with useGrouping, else settings when they name this vault, else D102. */
export function groupingOf(root: string): Grouping {
  const set = groupings.get(path.resolve(root));
  if (set) return set;
  // Settings are read again only when the file changed (this runs many times per write).
  let mtime = -1;
  try { mtime = fs.statSync(SETTINGS.file).mtimeMs; } catch { /* no settings */ }
  if (!settingsCache || settingsCache.file !== SETTINGS.file || settingsCache.mtime !== mtime) settingsCache = { file: SETTINGS.file, mtime, cfg: keeperConfig() };
  const cfg = settingsCache.cfg;
  return cfg && path.resolve(cfg.path).toLowerCase() === path.resolve(root).toLowerCase() && cfg.grouping ? cfg.grouping : DEFAULT_GROUPING;
}
let settingsCache: { file: string; mtime: number; cfg: KeeperConfig | null } | null = null;
/** The config (settings, or the one a caller passes), its grouping registered for its vault. */
export function configOf(deps: { config?: () => KeeperConfig | null }): KeeperConfig | null {
  const cfg = (deps.config ?? keeperConfig)();
  if (cfg?.grouping) useGrouping(cfg.path, cfg.grouping);
  return cfg;
}

// -- files, front matter and keeper blocks --------------------------------------------------------

export function read(root: string, rel: string): string | null {
  try { return lf(fs.readFileSync(abs(root, rel), 'utf8')); } catch { return null; }
}
export function put(root: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(abs(root, rel)), { recursive: true });
  fs.writeFileSync(abs(root, rel), text);
}
/** Write a file only if it is not there: layout never overwrites anything a person already has. */
export function create(root: string, rel: string, text: string): boolean {
  fs.mkdirSync(path.dirname(abs(root, rel)), { recursive: true });
  try {
    fs.writeFileSync(abs(root, rel), text, { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  }
}

export const FM = /^---\n([\s\S]*?)\n---(?:\n|$)/;
/** Set the keeper's own front matter fields, keeping every other line a person wrote. */
export function setFrontmatter(text: string, fields: Record<string, string | string[]>): string {
  const m = FM.exec(text);
  const lines = m ? m[1]!.split('\n') : [];
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const key = /^([A-Za-z_][\w-]*):/.exec(line)?.[1];
    if (key) skipping = key in fields;
    else if (!/^\s+-/.test(line)) skipping = false;
    if (!skipping) kept.push(line);
  }
  const set = Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${[...kept, ...set].join('\n')}\n---\n${m ? text.slice(m[0].length) : text}`;
}

export const open = (name: string): string => `<!-- keeper:${name} -->`;
export const close = (name: string): string => `<!-- /keeper:${name} -->`;
export const block = (name: string, content = ''): string => `${open(name)}\n${content ? `${content}\n` : ''}${close(name)}`;
export function getBlock(text: string, name: string): string | null {
  const a = text.indexOf(open(name));
  const b = text.indexOf(close(name));
  return a < 0 || b < a ? null : text.slice(a + open(name).length, b).trim();
}
export function setBlock(text: string, name: string, content: string): string {
  const a = text.indexOf(open(name));
  const b = text.indexOf(close(name));
  const block = `${open(name)}\n${content.trim() ? `${content.trim()}\n` : ''}${close(name)}`;
  if (a >= 0 && b > a) return text.slice(0, a) + block + text.slice(b + close(name).length);
  // No block yet: right under the title, else at the end.
  const title = /^# .*$/m.exec(text);
  if (title) {
    const at = title.index + title[0].length;
    return `${text.slice(0, at)}\n\n${block}\n${text.slice(at)}`;
  }
  return `${text.replace(/\n*$/, '\n\n')}${block}\n`;
}
/** Insert an entry at the end of a "## " section, adding the section when a person removed it. */
export function appendUnder(text: string, heading: string, entry: string): string {
  const lines = text.replace(/\n*$/, '').split('\n');
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at < 0) return `${lines.join('\n')}\n\n${heading}\n\n${entry}\n`;
  let end = lines.findIndex((l, i) => i > at && /^## /.test(l));
  if (end < 0) end = lines.length;
  let last = end;
  while (last > at + 1 && !lines[last - 1]!.trim()) last--;
  const tail = lines.slice(end);
  return [...lines.slice(0, last), ...(last === at + 1 ? [''] : []), entry, ...(tail.length ? ['', ...tail] : [])].join('\n') + '\n';
}

// -- the layout -----------------------------------------------------------------------------------

export interface Revision {
  id: string; ts: string; request_id?: string;
  kind: Kind | 'conflict' | 'frontmatter' | 'move' | 'status'; state: string;
  space: string; page: string; section?: string; block?: string;
  author: string; source: string;
  before: string; after: string; text_hash?: string; conflicts_with?: string;
  /** Overview front matter the keeper set or last saw: field → hash of its value (see fieldHash). */
  fields?: Record<string, string>;
}
export function revisions(root: string): Revision[] {
  return (read(root, '.keeper/revisions.jsonl') ?? '').split('\n').flatMap((line) => {
    try { return line ? [JSON.parse(line) as Revision] : []; } catch { return []; }
  });
}
export function appendRevision(root: string, r: Revision): void {
  fs.mkdirSync(abs(root, '.keeper'), { recursive: true });
  fs.appendFileSync(abs(root, '.keeper/revisions.jsonl'), `${JSON.stringify(r)}\n`);
}
export const latest = <T>(all: T[], pick: (x: T) => boolean): T | undefined => {
  for (let i = all.length - 1; i >= 0; i--) if (pick(all[i]!)) return all[i];
  return undefined;
};
export const lastFor = (all: Revision[], space: string, page: string, block: string): Revision | undefined =>
  latest(all, (r) => r.space === space && r.page === page && r.block === block && r.kind !== 'conflict');

// -- the index ------------------------------------------------------------------------------------

/** A fact last changed longer ago than this is marked so an agent checks it before relying on it. */
export const FACT_STALE_DAYS = 90;
/** The mark for a fact changed at t (ms; 0 = no known date): '' when recent. */
export function factAgeMark(t: number, now: number): string {
  if (!t) return 'age unknown, check before use';
  return now - t > FACT_STALE_DAYS * 86_400_000 ? 'check before use' : '';
}
export interface PageInfo { title: string; tobira_id?: string; aliases: string[]; headings: string[]; links: string[]; mtime: number; updated?: string }
export interface KeeperIndex { version: 1; pages: Record<string, PageInfo> }

/** Every note, as vault-relative paths; dot folders (.keeper, .obsidian, .stversions, .trash) are not notes. */
export function notes(root: string, dir = ''): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(abs(root, dir), { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((d) => {
    if (d.name.startsWith('.')) return [];
    const rel = dir ? `${dir}/${d.name}` : d.name;
    return d.isDirectory() ? notes(root, rel) : d.name.endsWith('.md') ? [rel] : [];
  }).sort();
}
export function pageInfo(root: string, rel: string): PageInfo | null {
  const text = read(root, rel);
  if (text === null) return null;
  const fm = frontmatter(text);
  // The hidden index never holds a password: tables are masked before headings and links are taken.
  const body = maskCredentials(text.replace(FM, ''));
  const headings = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1]!.trim());
  // A client page's ID from its folder, flat or in its stage group.
  const id = str(fm.tobira_id) || /(?:^|\/)Clients\/(?:[^/]+\/)?([A-Z]{1,4}-\d+)(?:[ /]|$)/.exec(rel)?.[1];
  const info: PageInfo = {
    title: str(fm.name) || /^# (.+)$/m.exec(body)?.[1]?.trim() || path.posix.basename(rel, '.md'),
    aliases: Array.isArray(fm.aliases) ? fm.aliases.map(String).filter(Boolean) : str(fm.aliases) ? [str(fm.aliases)] : [],
    headings,
    links: [...new Set([...body.matchAll(/!?\[\[([^\]|#^]+)[^\]]*\]\]/g)].map((m) => m[1]!.trim()))],
    mtime: Math.floor(fs.statSync(abs(root, rel)).mtimeMs),
  };
  if (id) info.tobira_id = id;
  if (str(fm.updated)) info.updated = str(fm.updated);
  return info;
}
export function buildIndex(root: string): KeeperIndex {
  const pages: Record<string, PageInfo> = {};
  for (const rel of notes(root)) {
    const info = pageInfo(root, rel);
    if (info) pages[rel] = info;
  }
  return { version: 1, pages };
}
function saveIndex(root: string, index: KeeperIndex): void {
  const pages = Object.fromEntries(Object.entries(index.pages).sort(([a], [b]) => a.localeCompare(b)));
  put(root, '.keeper/index.json', `${JSON.stringify({ version: 1, pages })}\n`);
}
export function loadIndex(root: string): KeeperIndex | null {
  try {
    const index = JSON.parse(read(root, '.keeper/index.json') ?? '') as KeeperIndex;
    return index?.version === 1 && index.pages && typeof index.pages === 'object' ? index : null;
  } catch {
    return null;
  }
}
/** Keeper only: rebuild the whole index (also the nightly check-up's first step). */
export function rebuildIndex(root: string): KeeperIndex {
  const index = buildIndex(root);
  saveIndex(root, index);
  return index;
}
export function touchIndex(root: string, rels: string[]): void {
  const index = loadIndex(root);
  if (!index) { rebuildIndex(root); return; }
  for (const rel of rels) {
    const info = pageInfo(root, rel);
    if (info) index.pages[rel] = info; else delete index.pages[rel];
  }
  saveIndex(root, index);
}

/** The space's index.md: one link per page, kept in its keeper block (derived, so always regenerated). */
export function refreshSpaceIndex(root: string, dir: string): string {
  const rel = `${dir}/index.md`;
  const pages = ownNotes(root, dir).filter((p) => p !== rel && p !== `${dir}/log.md`);
  const lines = pages.map((p) => `- ${wiki(p, p.slice(dir.length + 1).replace(/\.md$/, ''))}`);
  put(root, rel, setBlock(read(root, rel) ?? '# Index\n', 'index', lines.join('\n')));
  return rel;
}
/** A space's own notes: a business's or client's nested Clients/ and Projects/ are spaces of their own. */
export function ownNotes(root: string, dir: string): string[] {
  const nested = new Set(['Clients', 'Projects'].map((d) => `${dir}/${d}`));
  const walk = (rel: string): string[] => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs(root, rel), { withFileTypes: true }); } catch { return []; }
    return entries.flatMap((d) => {
      if (d.name.startsWith('.')) return [];
      const sub = `${rel}/${d.name}`;
      if (d.isDirectory()) return nested.has(sub) ? [] : walk(sub);
      return d.name.endsWith('.md') ? [sub] : [];
    });
  };
  return walk(dir).sort();
}

/** A keeper block that a page is missing: right after another block, before a heading, or at the end under one. */
export function ensureBlock(text: string, name: string, where: { after?: string; before?: string; heading?: string }): string {
  if (getBlock(text, name) !== null) return text;
  const section = `${where.heading ? `${where.heading}\n` : ''}${block(name)}`;
  if (where.after && text.includes(close(where.after))) {
    const at = text.indexOf(close(where.after)) + close(where.after).length;
    return `${text.slice(0, at)}\n\n${block(name)}${text.slice(at)}`;
  }
  const lines = text.split('\n');
  const before = where.before ? lines.findIndex((l) => l.trim() === where.before) : -1;
  if (before >= 0) return [...lines.slice(0, before), ...section.split('\n'), '', ...lines.slice(before)].join('\n');
  if (!where.after && !where.before && !where.heading) return setBlock(text, name, '');
  return `${text.replace(/\n*$/, '\n\n')}${section}\n`;
}
export const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()) : str(v) ? [str(v)] : []).filter(Boolean);
/** A front matter field as revisions compare it: a list as its JSON, a scalar as its text. */
export const fieldHash = (fm: Record<string, unknown>, f: string): string => sha(LIST_FIELDS.includes(f) ? JSON.stringify(listOf(fm[f])) : str(fm[f]));
export const fold = (s: string): string => s.normalize('NFKC').toLocaleLowerCase();
