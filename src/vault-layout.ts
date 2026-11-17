/**
 * D101–D103: the shared vault is grouped by business. Each business has its own folder (Home, boards, decisions,
 * clients and projects); client-specific repositories nest inside their client; cross-business tools live in
 * "Shared tools"; repositories nobody can place wait in "Unsorted" and are listed on Needs attention. Inside a
 * business's Clients/, each client folder sits in the group folder of its stage (CLIENT_GROUPS); every lookup also
 * accepts the flat form, and a client may live in another business than its ID's (D112).
 *
 * This module is pure path logic: which business a repository belongs to (settings mapping, then a guess from
 * its name, remote and README), and where a space's folder is. It reads folders and front matter but never
 * writes. Until `kokuban vault regroup` has moved an old vault (Agency/, Clients/, Projects/ at the top), every
 * lookup also finds the old places, and new spaces are made there, so nothing splits in two.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Business {
  /** Stable key: "acme", "harbor-trading", … The vault space of business "acme" is still called "agency". */
  key: string;
  /** Its folder at the vault's top, e.g. "Acme". */
  folder: string;
  /** Client ID prefix ("T" for T-05555); a business without one has no client IDs of its own. */
  clientPrefix?: string;
  /** Repositories of the business itself: <folder>/Projects/<repo>. */
  repos: string[];
  /** Client-specific repositories: <folder>/Clients/<ID> <name>/Projects/<repo>. */
  clientRepos: Record<string, string[]>;
  /** A repository whose space is another one's (acme-booking is ember-aoz). */
  repoAliases: Record<string, string>;
  /** Words in a repository's name or remote that place it here (the key and folder count too). */
  keywords: string[];
  /** Words in a README that place it here ("Acme", "アクミ"). */
  readme: string[];
  /**
   * D126: the client boards it has (settings `boards`: ["pipeline", "care"] or []). Not set: the rule in
   * vault-visuals.ts boardsOf (a business with a client prefix or client folders has both, any other none).
   */
  boards?: BoardKind[];
  /** D126: what its Home shows (settings `visuals`, VISUALS in vault-visuals.ts). Not set: DEFAULT_VISUALS by key. */
  visuals?: string[];
}
export type BoardKind = 'pipeline' | 'care';
export const BOARD_KINDS: readonly BoardKind[] = ['pipeline', 'care'];
/** D126: the visuals a business Home can show (vault-visuals.ts draws them). */
export const VISUAL_KINDS = ['pipeline', 'clients', 'projects', 'direction', 'research', 'research-map'] as const;
export interface Grouping { businesses: Business[]; shared: string[] }

export const SHARED = 'Shared tools';
export const UNSORTED = 'Unsorted';
export const ROOT_HOME = 'Home.md';
export const ATTENTION = 'Needs attention.md';
/** Folders of the layout before D101; a vault that still has one is regrouped with `kokuban vault regroup`. */
export const LEGACY = ['Agency', 'Clients', 'Projects'];

/** D102: the settings form of vault.businesses. Settings replace it as a whole. */
export const DEFAULT_BUSINESSES = {
  acme: {
    folder: 'Acme', client_prefix: 'T',
    repos: ['acme', 'acme-cockpit', 'translation', 'ops-home', 'prompt'],
    client_repos: { 'T-05555': ['ember-aoz', 'acme-booking'] },
    repo_aliases: { 'acme-booking': 'ember-aoz' },
    keywords: ['acme'], readme: ['Acme', 'アクミ'],
  },
  'harbor-trading': { folder: 'Harbor Trading', repos: ['Reservation'], keywords: ['harbortrading', 'harbor-trading'], readme: ['Harbor Trading', 'ハーバートレーディング'] },
  crypto: { folder: 'Crypto', repos: ['crypto'], keywords: ['crypto'], readme: [] },
  security: { folder: 'Security', repos: ['security'], keywords: ['security', 'pentest'], readme: [] },
  shared: { repos: ['kokuban', 'computeruse'] },
};

// -- Windows-safe names ------------------------------------------------------------------------------

/** The longest name the keeper gives a folder or file it makes (the vault sits deep on some PCs). */
export const NAME_MAX = 80;
/** Characters Windows refuses in a name: < > : " / \ | ? * and control characters. */
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const BAD_CHARS_G = /[<>:"/\\|?*\u0000-\u001f\u007f]+/g;
/** Device names Windows reserves, with or without an extension (CON, con.md, COM1.txt). */
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const stemOf = (name: string): string => name.split('.')[0]!.trimEnd();
/**
 * A folder or file name every PC can hold (Syncthing cannot sync to Windows a name it refuses): forbidden and
 * control characters become spaces, runs of spaces one, no leading or trailing dots and spaces ("…Co.,Ltd." →
 * "…Co.,Ltd"), a reserved device name gains "_" (CON → CON_), at most NAME_MAX characters. "" when nothing is left.
 */
export function safeName(name: string, max = NAME_MAX): string {
  let s = name.normalize('NFC').replace(BAD_CHARS_G, ' ').replace(/\s+/g, ' ');
  const trim = (t: string): string => t.replace(/^[\s.]+|[\s.]+$/g, '');
  s = trim(s);
  if (DEVICE.test(stemOf(s))) s = `${stemOf(s)}_${s.slice(stemOf(s).length)}`;
  // Code points, so a cut never splits a surrogate pair.
  const chars = [...s];
  if (chars.length > max) s = trim(chars.slice(0, max).join(''));
  return s;
}
/** Why a name that exists cannot be synced to Windows, or "" when it can. */
export function unsafeName(name: string): string {
  const why: string[] = [];
  if (BAD_CHARS.test(name)) why.push('a character Windows refuses (< > : " / \\ | ? * or a control character)');
  if (/[. ]$/.test(name)) why.push('ends with a dot or space');
  if (DEVICE.test(stemOf(name))) why.push('a reserved device name');
  if (name.length > 255) why.push('longer than 255 characters');
  return why.join('; ');
}
/** A vault-relative path with its last part made safe. */
export function safeLeaf(rel: string): string {
  const at = rel.lastIndexOf('/');
  const leaf = safeName(rel.slice(at + 1));
  return leaf ? `${rel.slice(0, at + 1)}${leaf}` : rel;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const strings =(v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : str(v) ? [str(v)] : []);
const FOLDER = /^[^\\/:*?"<>|.\r\n\t][^\\/:*?"<>|\r\n\t]{0,79}$/;
const RESERVED = new Set([SHARED, UNSORTED, ...LEGACY, '.keeper', '.obsidian'].map((s) => s.toLowerCase()));
export const CLIENT_ID = /^([A-Z]{1,4})-\d+$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** settings vault.businesses → a Grouping. Invalid entries are left out; nothing valid → the D102 default. */
export function parseGrouping(raw: unknown): Grouping {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const businesses: Business[] = [];
  let shared: string[] = [];
  for (const [key, value] of Object.entries(src)) {
    const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    if (key === 'shared') { shared = strings(v.repos).filter((r) => REPO.test(r)); continue; }
    // Every PC must be able to hold the folder (D101): "Harbor Trading." is kept as "Harbor Trading".
    const folder = safeName(str(v.folder));
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key) || !FOLDER.test(folder) || RESERVED.has(folder.toLowerCase())) continue;
    if (businesses.some((b) => b.key === key || b.folder.toLowerCase() === folder.toLowerCase())) continue;
    const prefix = str(v.client_prefix);
    const clientRepos: Record<string, string[]> = {};
    if (v.client_repos && typeof v.client_repos === 'object') {
      for (const [id, repos] of Object.entries(v.client_repos as Record<string, unknown>)) {
        if (CLIENT_ID.test(id)) clientRepos[id] = strings(repos).filter((r) => REPO.test(r));
      }
    }
    const repoAliases: Record<string, string> = {};
    if (v.repo_aliases && typeof v.repo_aliases === 'object') {
      for (const [a, b] of Object.entries(v.repo_aliases as Record<string, unknown>)) if (REPO.test(a) && REPO.test(str(b))) repoAliases[a] = str(b);
    }
    // D126: an explicit list (also []) replaces the rule; unknown names are left out.
    const boards = Array.isArray(v.boards) ? [...new Set(strings(v.boards).map((x) => x.toLowerCase()))].filter((x): x is BoardKind => (BOARD_KINDS as readonly string[]).includes(x)) : undefined;
    const visuals = Array.isArray(v.visuals) ? [...new Set(strings(v.visuals).map((x) => x.toLowerCase()))].filter((x) => (VISUAL_KINDS as readonly string[]).includes(x)) : undefined;
    businesses.push({
      key, folder, ...(/^[A-Z]{1,4}$/.test(prefix) ? { clientPrefix: prefix } : {}),
      repos: strings(v.repos).filter((r) => REPO.test(r)), clientRepos, repoAliases,
      keywords: strings(v.keywords), readme: strings(v.readme),
      ...(boards ? { boards } : {}), ...(visuals ? { visuals } : {}),
    });
  }
  if (!businesses.length && raw !== DEFAULT_BUSINESSES) return parseGrouping(DEFAULT_BUSINESSES);
  return { businesses, shared };
}
export const DEFAULT_GROUPING = parseGrouping(DEFAULT_BUSINESSES);

// -- small file helpers (read only) ------------------------------------------------------------------

const abs = (root: string, rel: string): string => path.join(root, ...rel.split('/'));
export const isDir = (root: string, rel: string): boolean => { try { return fs.statSync(abs(root, rel)).isDirectory(); } catch { return false; } };
export function subdirs(root: string, rel: string): string[] {
  try { return fs.readdirSync(abs(root, rel), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort(); }
  catch { return []; }
}
function readText(root: string, rel: string): string | null {
  try { return fs.readFileSync(abs(root, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return null; }
}
const FM = /^---\n([\s\S]*?)\n---(?:\n|$)/;
/** Tolerant reading of Obsidian YAML front matter: scalars, flow lists and "- item" lists. */
export function frontmatter(text: string): Record<string, unknown> {
  const m = FM.exec(text.replace(/\r\n/g, '\n'));
  const out: Record<string, unknown> = {};
  if (!m) return out;
  let list: string[] | null = null;
  for (const line of m[1]!.split('\n')) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item && list) { list.push(unquote(item[1]!)); continue; }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2]!.trim();
    if (!value) { list = []; out[kv[1]!] = list; continue; }
    list = null;
    if (value.startsWith('[') && !value.startsWith('[[')) {
      try { out[kv[1]!] = JSON.parse(value); }
      catch { out[kv[1]!] = value.slice(1, -1).split(',').map(unquote).filter(Boolean); }
    } else out[kv[1]!] = unquote(value);
  }
  return out;
}
export function unquote(s: string): string {
  s = s.trim();
  if (s.startsWith('"')) { try { return String(JSON.parse(s)); } catch { /* plain */ } }
  return s.replace(/^'(.*)'$/, '$1');
}
const fold = (s: string): string => s.normalize('NFKC').toLowerCase();
const same = (a: string, b: string): boolean => fold(a) === fold(b);

// -- businesses -------------------------------------------------------------------------------------

/** The business the old "agency" space means: "acme", else the first with client IDs, else the first. */
export function agencyBusiness(g: Grouping): Business {
  return g.businesses.find((b) => b.key === 'acme') ?? g.businesses.find((b) => b.clientPrefix) ?? g.businesses[0]!;
}
export function businessByKey(g: Grouping, key: string): Business | undefined {
  return g.businesses.find((b) => b.key === key);
}
/** The write space of a business: "agency" for Acme (unchanged for every caller), else "business:<key>". */
export const businessSpaceKey = (g: Grouping, b: Business): string => (b === agencyBusiness(g) ? 'agency' : `business:${b.key}`);
/** The business a client ID belongs to, by its prefix. */
export function clientBusiness(g: Grouping, id: string): Business | undefined {
  const prefix = CLIENT_ID.exec(id)?.[1];
  return prefix ? g.businesses.find((b) => b.clientPrefix === prefix) : undefined;
}

/** True while the vault still has the old top-level Agency/, Clients/ or Projects/ folder. */
export const legacy = (root: string): boolean => LEGACY.some((d) => isDir(root, d));
/** A business's folder; the old Agency/ for Acme until the vault is regrouped. */
export function businessDir(root: string, g: Grouping, b: Business): string {
  if (b === agencyBusiness(g) && isDir(root, 'Agency') && !isDir(root, b.folder)) return 'Agency';
  return b.folder;
}
/** Needs attention: at the top of the vault (D101); in Agency/ until the vault is regrouped. */
export const attentionPath = (root: string): string => (isDir(root, 'Agency') ? `Agency/${ATTENTION}` : ATTENTION);

// -- clients ----------------------------------------------------------------------------------------

/**
 * Client folders are grouped by stage so a person sees which ones need work right now. Inside each
 * business's Clients/, a client folder sits in the group folder of its stage, so the file explorer reads as a work
 * list (the numbers keep the order; the emoji survive safeName). The one place this mapping lives.
 */
export interface ClientGroup { folder: string; label: string; stages: string[] }
export const CLIENT_GROUPS: ClientGroup[] = [
  { folder: '1 🔥 Act now', label: '🔥 Act now', stages: ['replied', 'sample-made', 'engaging', 'proposal'] },
  { folder: '2 🛠 Building', label: '🛠 Building', stages: ['signed', 'building', 'launch'] },
  { folder: '3 ⏳ Waiting on them', label: '⏳ Waiting on them', stages: ['outreach', 'sample-sent'] },
  { folder: '4 💤 Quiet', label: '💤 Quiet', stages: [] },
  { folder: '5 ✅ Done', label: '✅ Done', stages: ['done'] },
  { folder: '6 🗄 Closed', label: '🗄 Closed', stages: ['closed'] },
  { folder: '0 ❓ No stage', label: '❓ No stage', stages: [] },
];
export const QUIET_GROUP = '4 💤 Quiet';
export const NO_STAGE_GROUP = '0 ❓ No stage';
export const CLOSED_GROUP = '6 🗄 Closed';
/** The tag the daily pipeline job adds after 14 days without client contact. */
export const QUIET_TAG = 'quiet';
/** Stages a `quiet` tag moves to Quiet (it overrides Act now and Waiting on them). */
export const QUIET_STAGES = ['replied', 'sample-sent', 'engaging'];
const GROUP_NAMES = new Set(CLIENT_GROUPS.map((x) => x.folder));
export const isClientGroup = (name: string): boolean => GROUP_NAMES.has(name.normalize('NFC'));
/** The group folder for a client's stage and tags; a missing or unknown stage is "No stage". */
export function clientGroup(stage: unknown, tags: unknown): string {
  const s = str(stage);
  const t = (Array.isArray(tags) ? tags.map((x) => String(x)) : str(tags) ? [str(tags)] : []).map((x) => x.trim().replace(/^#+/, '').toLowerCase());
  if (QUIET_STAGES.includes(s) && t.includes(QUIET_TAG)) return QUIET_GROUP;
  return CLIENT_GROUPS.find((x) => x.stages.includes(s))?.folder ?? NO_STAGE_GROUP;
}

/** The folders that hold a business's client folders and groups (also the old top-level Clients/ for Acme). */
export function clientParents(root: string, g: Grouping, b: Business): string[] {
  return [`${b.folder}/Clients`, ...(b === agencyBusiness(g) && isDir(root, 'Clients') ? ['Clients'] : [])];
}
/** A business's client folders: flat (<Clients>/<ID> <name>) and grouped (<Clients>/<group>/<ID> <name>). */
function clientFolders(root: string, g: Grouping, b: Business): Array<{ p: string; name: string }> {
  return clientParents(root, g, b).flatMap((p) => subdirs(root, p).flatMap((name) =>
    isClientGroup(name) ? subdirs(root, `${p}/${name}`).map((c) => ({ p: `${p}/${name}`, name: c })) : [{ p, name }]));
}
/** Every client folder in the vault, with the business whose folder holds it. */
export function allClients(root: string, g: Grouping): Array<{ dir: string; name: string; business: Business }> {
  return g.businesses.flatMap((b) => clientFolders(root, g, b).map(({ p, name }) => ({ dir: `${p}/${name}`, name, business: b })));
}
/**
 * A client folder's parts: the business whose folder holds it, its group (null: flat), the client folder itself
 * and what follows it ([] for the client folder; ["Projects", "<repo>", …] inside it). null: not in a Clients/.
 */
export function parseClientDir(g: Grouping, dir: string): { business: Business; group: string | null; dir: string; name: string; rest: string[] } | null {
  const parts = dir.split('/');
  let at: number;
  let business: Business | undefined;
  if (parts[0] === 'Clients') { at = 1; business = agencyBusiness(g); }
  else if (parts[1] === 'Clients') { at = 2; business = g.businesses.find((b) => b.folder === parts[0]); }
  else return null;
  if (!business || parts.length <= at) return null;
  let group: string | null = null;
  if (isClientGroup(parts[at]!)) { group = parts[at]!; at++; }
  if (parts.length <= at) return null;
  return { business, group, dir: parts.slice(0, at + 1).join('/'), name: parts[at]!, rest: parts.slice(at + 1) };
}
/**
 * A client's folder by its ID: the folder name starts with the ID, or its Overview says so (a renamed folder).
 * The ID's own business first, then every other one (a client can move to another business, D112).
 */
export function findClient(root: string, g: Grouping, id: string): string | null {
  const own = clientBusiness(g, id);
  const order = [...(own ? [own] : []), ...g.businesses.filter((b) => b !== own)];
  const all = order.flatMap((b) => clientFolders(root, g, b));
  const named = all.find(({ name }) => name === id || name.startsWith(`${id} `));
  if (named) return `${named.p}/${named.name}`;
  const said = all.find(({ p, name }) => str(frontmatter(readText(root, `${p}/${name}/Overview.md`) ?? '').tobira_id) === id);
  return said ? `${said.p}/${said.name}` : null;
}
/**
 * Where a new client folder goes: <Business>/Clients/<group>/<ID> <name>, made Windows-safe (the old flat
 * top-level Clients/ until regrouped).
 */
export function newClientDir(root: string, g: Grouping, id: string, name: string, group = NO_STAGE_GROUP, business?: Business): string {
  const b = business ?? clientBusiness(g, id)!;
  const legacyFlat = b === agencyBusiness(g) && isDir(root, 'Clients') && !isDir(root, `${b.folder}/Clients`);
  return `${legacyFlat ? 'Clients' : `${b.folder}/Clients/${group}`}/${safeName(`${id} ${name}`)}`;
}
/** A client's `business` front matter as a move request: a plain business key or folder (a link is what the keeper wrote). */
export function askedClientBusiness(root: string, g: Grouping, value: unknown): Business | null {
  const v = str(value);
  if (!v || v.startsWith('[[')) return null;
  const p = parseBusinessValue(root, g, v);
  return p?.kind === 'business' ? p.business : null;
}

// -- projects ---------------------------------------------------------------------------------------

/** Where a repository's space belongs. */
export type Place =
  | { kind: 'business'; business: Business }
  | { kind: 'client'; business: Business; client: string }
  | { kind: 'shared' }
  | { kind: 'unsorted' };
export const placeName = (p: Place): string => p.kind === 'business' ? p.business.key : p.kind === 'client' ? `${p.business.key} ${p.client}` : p.kind;
/** Two places are one: a client-nested place is its client, wherever (in whichever business) the client's folder is. */
export const samePlace = (a: Place, b: Place): boolean =>
  a.kind === 'client' && b.kind === 'client' ? a.client === b.client : placeName(a) === placeName(b);

/** The repository name a space is filed under: an alias (acme-booking) means its target (ember-aoz). */
export function canonicalRepo(g: Grouping, repo: string): string {
  for (const b of g.businesses) for (const [a, t] of Object.entries(b.repoAliases)) if (same(a, repo)) return t;
  return repo;
}
/** The settings mapping (D102); null when the repository is not named there. */
export function mappedPlace(g: Grouping, repo: string): Place | null {
  const names = [repo, canonicalRepo(g, repo)];
  const has = (list: string[]): boolean => list.some((r) => names.some((n) => same(r, n)));
  if (has(g.shared)) return { kind: 'shared' };
  for (const b of g.businesses) {
    for (const [client, repos] of Object.entries(b.clientRepos)) if (has(repos)) return { kind: 'client', business: b, client };
    if (has(b.repos)) return { kind: 'business', business: b };
  }
  return null;
}

const tokens = (s: string): string[] => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const squash = (s: string): string => fold(s).replace(/[^\p{L}\p{N}]+/gu, '');
/** Does a name (repo, remote owner/name) carry one of the business's words? */
function nameMatches(b: Business, name: string): boolean {
  const words = [b.key, b.folder, ...b.keywords].map(squash).filter((w) => w.length >= 3);
  const toks = tokens(name);
  const whole = squash(name);
  return words.some((w) => whole === w || toks.includes(w) || (w.length >= 5 && toks.some((t) => t.startsWith(w))));
}
function readmeMatches(b: Business, text: string): boolean {
  const t = text.normalize('NFKC');
  return b.readme.some((w) => {
    if (!w.trim()) return false;
    // Latin words count as whole words, case-insensitively; other scripts as written.
    if (/^[\x20-\x7e]+$/.test(w)) return new RegExp(`(^|[^A-Za-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i').test(t);
    return t.includes(w.normalize('NFKC'));
  });
}
/** "owner/name" of a git remote (https, ssh or scp form), or "". */
export function remoteName(remote: string): string {
  return /[/:]([^/:\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim())?.[1] ?? '';
}
export interface Guess { place: Place; why: string }
/**
 * D103: the mapping first; then the repository's name and its remote's owner/name; then words in its README.
 * Exactly one business must match at a step, else the next step; nothing clear → Unsorted.
 */
export function guessPlace(g: Grouping, repo: { name: string; remote?: string; readme?: string }): Guess {
  const mapped = mappedPlace(g, repo.name);
  if (mapped) return { place: mapped, why: 'settings mapping' };
  const steps: Array<[string, (b: Business) => boolean]> = [
    ['repository name', (b) => nameMatches(b, repo.name)],
    ['remote', (b) => !!repo.remote && remoteName(repo.remote).split('/').some((part) => nameMatches(b, part))],
    ['README', (b) => !!repo.readme && readmeMatches(b, repo.readme)],
  ];
  for (const [why, test] of steps) {
    const hits = g.businesses.filter(test);
    if (hits.length === 1) return { place: { kind: 'business', business: hits[0]! }, why };
    if (hits.length > 1) return { place: { kind: 'unsorted' }, why: `${why} matches ${hits.map((b) => b.folder).join(' and ')}` };
  }
  return { place: { kind: 'unsorted' }, why: 'no business matched its name, remote or README' };
}

export interface ProjectDir { dir: string; repo: string; place: Place | null }
/** Every project space folder in the vault, wherever it is (old top-level Projects/ included, place null). */
export function allProjects(root: string, g: Grouping): ProjectDir[] {
  const out: ProjectDir[] = [];
  const add = (parent: string, place: Place | null): void => { for (const repo of subdirs(root, parent)) out.push({ dir: `${parent}/${repo}`, repo, place }); };
  for (const b of g.businesses) {
    add(`${b.folder}/Projects`, { kind: 'business', business: b });
    // Flat and grouped client folders alike (not the old top-level Clients/: it waits for the regroup).
    for (const c of subdirs(root, `${b.folder}/Clients`).flatMap((n) => isClientGroup(n) ? subdirs(root, `${b.folder}/Clients/${n}`).map((x) => `${n}/${x}`) : [n])) {
      if (isDir(root, `${b.folder}/Clients/${c}/Projects`)) add(`${b.folder}/Clients/${c}/Projects`, { kind: 'client', business: b, client: clientIdOf(path.posix.basename(c)) });
    }
  }
  add(`${SHARED}/Projects`, { kind: 'shared' });
  add(`${UNSORTED}/Projects`, { kind: 'unsorted' });
  add('Projects', null);
  return out;
}
const clientIdOf = (folder: string): string => CLIENT_ID.exec(folder.split(' ')[0]!)?.[0] ?? folder;
const remoteKey = (r: string): string => r.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
/**
 * A repository's existing space: a folder of that name (or its alias's), an Overview whose `repo` or `aliases`
 * name it, or one whose `remote` is the same (a renamed space). null: none yet.
 */
export function findProject(root: string, g: Grouping, repo: string, remote = ''): string | null {
  // A name Windows refuses ("foo.") was filed under its safe form ("foo").
  const names = [...new Set([repo, canonicalRepo(g, repo)].flatMap((n) => [n, safeName(n) || n]))];
  const all = allProjects(root, g);
  // Its own folder first (before the regroup merges an alias, both may exist), then its alias's.
  for (const n of names) {
    const byName = all.find((p) => same(p.repo, n));
    if (byName) return byName.dir;
  }
  for (const p of all) {
    const fm = frontmatter(readText(root, `${p.dir}/Overview.md`) ?? '');
    const known = [str(fm.repo), ...strings(fm.aliases), ...strings(fm.repos)];
    if (known.some((k) => names.some((n) => same(k, n)))) return p.dir;
    if (remote && typeof fm.remote === 'string' && remoteKey(fm.remote) === remoteKey(remote)) return p.dir;
  }
  return null;
}
/** The folder a place gives a repository's space; the old top-level Projects/ until the vault is regrouped. */
export function placeDir(root: string, g: Grouping, place: Place, name: string): string {
  const repo = safeName(name) || name;
  if (isDir(root, 'Projects')) return `Projects/${repo}`;
  if (place.kind === 'shared') return `${SHARED}/Projects/${repo}`;
  if (place.kind === 'unsorted') return `${UNSORTED}/Projects/${repo}`;
  if (place.kind === 'business') return `${place.business.folder}/Projects/${repo}`;
  const client = findClient(root, g, place.client);
  // The client's folder does not exist yet: the business keeps it until it does.
  return client ? `${client}/Projects/${repo}` : `${place.business.folder}/Projects/${repo}`;
}
/** The place a project folder is in now (null: the old top-level Projects/). */
export function placeOfDir(g: Grouping, dir: string): Place | null {
  const parts = dir.split('/');
  if (parts[0] === SHARED) return { kind: 'shared' };
  if (parts[0] === UNSORTED) return { kind: 'unsorted' };
  const b = g.businesses.find((x) => x.folder === parts[0]);
  if (!b) return null;
  const c = parts[1] === 'Clients' ? parseClientDir(g, dir) : null;
  if (c) return c.rest[0] === 'Projects' && c.rest.length >= 2 ? { kind: 'client', business: c.business, client: clientIdOf(c.name) } : null;
  return parts[1] === 'Projects' ? { kind: 'business', business: b } : null;
}

// -- links ------------------------------------------------------------------------------------------

export const wiki = (rel: string, label?: string): string => `[[${rel.replace(/\.md$/, '')}${label ? `|${label}` : ''}]]`;
/** The Home a place's projects link up to (a client-nested project links to its client's Overview). */
export function parentLink(root: string, g: Grouping, place: Place): string {
  if (place.kind === 'shared') return wiki(`${SHARED}/Home`, SHARED);
  if (place.kind === 'unsorted') return wiki(`${UNSORTED}/Home`, UNSORTED);
  if (place.kind === 'business') return wiki(`${place.business.folder}/Home`, place.business.folder);
  const client = findClient(root, g, place.client);
  return client ? wiki(`${client}/Overview`, path.posix.basename(client)) : wiki(`${place.business.folder}/Home`, place.business.folder);
}
/** The target of the first [[wikilink]] in a string ("Acme/Home" for "[[Acme/Home|Acme]]"). */
export const linkTarget = (s: string): string => /\[\[([^\]|#]+)/.exec(s)?.[1]?.trim() ?? '';

/**
 * A `business` front matter value as a place: a business key or folder, "shared", "unsorted", a client ID
 * (nest under that client), or a link to a Home or client Overview (what the keeper itself writes).
 */
export function parseBusinessValue(root: string, g: Grouping, value: string, client = ''): Place | null {
  const v = value.trim();
  if (!v) return null;
  const target = linkTarget(v);
  if (target) {
    const parts = target.split('/');
    if (same(parts[0]!, SHARED)) return { kind: 'shared' };
    if (same(parts[0]!, UNSORTED)) return { kind: 'unsorted' };
    const b = g.businesses.find((x) => same(x.folder, parts[0]!) || (parts[0] === 'Agency' && x === agencyBusiness(g)));
    if (!b) return null;
    // A client link beside it keeps a client-nested project nested.
    const c = linkTarget(client);
    if (c) { const id = c.split('/').find((p) => CLIENT_ID.test(p.split(' ')[0]!)); if (id) return { kind: 'client', business: b, client: clientIdOf(id) }; }
    return { kind: 'business', business: b };
  }
  if (CLIENT_ID.test(v)) { const b = clientBusiness(g, v); return b ? { kind: 'client', business: b, client: v } : null; }
  if (['shared', fold(SHARED)].includes(fold(v))) return { kind: 'shared' };
  if (fold(v) === 'unsorted') return { kind: 'unsorted' };
  if (fold(v) === 'agency') return { kind: 'business', business: agencyBusiness(g) };
  const b = g.businesses.find((x) => same(x.key, v) || same(x.folder, v));
  return b ? { kind: 'business', business: b } : null;
}
