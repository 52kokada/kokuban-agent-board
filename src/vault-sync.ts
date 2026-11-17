/**
 * D124: Syncthing status inside Obsidian. On the keeper (keeper-pc, the Syncthing hub) each tick reads the local
 * Syncthing REST API and keeps one line in the `keeper:sync` block of the vault's top Home.md, so every device
 * sees in Obsidian whether the vault is in sync and the keeper is alive. Also adds, once, a "Sync status" and an
 * "Open Syncthing" bookmark to the shared Obsidian bookmarks. The API key is read per tick from config.xml and is
 * never logged or written anywhere. Every failure fails open into the status line.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ROOT_HOME } from './vault-layout.js';
import { heartbeat } from './vault-heartbeat.js';
import { appendRevision, getBlock, lastFor, put, read, revisions, setBlock, sha, touchIndex, type Revision } from './vault-store.js';

/** The write space and block of the status line (revisions.jsonl). */
export const SYNC_SPACE = 'vault';
export const SYNC_BLOCK = 'sync';
/** The Obsidian block id the "Sync status" bookmark points at. */
export const SYNC_ANCHOR = 'sync-status';
/** Each PC's own Syncthing UI. */
export const SYNCTHING_UI = 'http://127.0.0.1:8384';
const TIMEOUT_MS = 2_000;
/** A status unchanged (apart from its times) is rewritten once an hour: each write is a synced file version. */
const HOUR_MS = 60 * 60_000;
/** A change within the same level (a sync percentage moving) waits this long; a level change is written at once. */
const SETTLE_MS = 5 * 60_000;
const STALE_MS = 12 * 60_000;

export interface SyncthingGui { url: string; apikey: string }
export interface SyncthingConfig {
  gui: SyncthingGui | null;
  folders: Array<{ id: string; label: string; path: string; devices: string[] }>;
  names: Record<string, string>;
}
export interface SyncDeps { fetch?: typeof fetch; env?: NodeJS.ProcessEnv; home?: string; platform?: NodeJS.Platform }

const unxml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&');
const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) out[m[1]!] = unxml(m[2]!);
  return out;
};

/** Where config.xml may be: settings `vault.syncthing` (a file or its folder) first, then the usual places. */
export function configCandidates(setting: string, deps: SyncDeps = {}): string[] {
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const out: string[] = [];
  if (setting && setting !== 'auto') out.push(setting.toLowerCase().endsWith('.xml') ? setting : path.join(setting, 'config.xml'));
  if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'Syncthing', 'config.xml'));
  if (env.APPDATA) out.push(path.join(env.APPDATA, 'Syncthing', 'config.xml'));
  out.push(path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'syncthing', 'config.xml'));
  out.push(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'syncthing', 'config.xml'));
  out.push(path.join(home, 'Library', 'Application Support', 'Syncthing', 'config.xml'));
  return out;
}

/** The parts of config.xml the status needs. Read per tick; the key never leaves this process. */
export function parseSyncthingConfig(xml: string): SyncthingConfig {
  const guiTag = /<gui\b([^>]*)>([\s\S]*?)<\/gui>/.exec(xml);
  let gui: SyncthingGui | null = null;
  if (guiTag) {
    const a = attrs(guiTag[1]!);
    const address = unxml(/<address>([^<]*)<\/address>/.exec(guiTag[2]!)?.[1]?.trim() ?? '');
    const apikey = unxml(/<apikey>([^<]*)<\/apikey>/.exec(guiTag[2]!)?.[1]?.trim() ?? '');
    if (address && apikey && !address.startsWith('unix')) {
      // A GUI listening on every address is reached on loopback.
      const local = address.replace(/^0\.0\.0\.0(?=:)/, '127.0.0.1').replace(/^\[::\](?=:)/, '[::1]').replace(/^:(?=\d)/, '127.0.0.1:');
      gui = { url: `${a.tls === 'true' ? 'https' : 'http'}://${local}`, apikey };
    }
  }
  const folders: SyncthingConfig['folders'] = [];
  for (const m of xml.matchAll(/<folder\b([^>]*)>([\s\S]*?)<\/folder>/g)) {
    const a = attrs(m[1]!);
    if (!a.id || !a.path) continue;
    folders.push({ id: a.id, label: a.label ?? '', path: a.path, devices: [...m[2]!.matchAll(/<device\b([^>]*)>/g)].map((d) => attrs(d[1]!).id ?? '').filter(Boolean) });
  }
  const names: Record<string, string> = {};
  // Top-level devices carry a name; a folder's own device list does not.
  for (const m of xml.matchAll(/<device\b([^>]*)>/g)) {
    const a = attrs(m[1]!);
    if (a.id && a.name !== undefined) names[a.id] = a.name;
  }
  return { gui, folders, names };
}

const norm = (p: string, home: string, platform: NodeJS.Platform): string => {
  const expanded = p === '~' || /^~[\\/]/.test(p) ? path.join(home, p.slice(1)) : p;
  const r = path.resolve(expanded).replace(/[\\/]+$/, '');
  return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r;
};

export interface DeviceState { id: string; name: string; connected: boolean; completion: number; needItems: number; lastSeen?: string }
export type SyncLevel = 'ok' | 'warn' | 'error';
export interface SyncReport {
  level: SyncLevel;
  /** What the line says apart from its times: the throttle compares this. */
  key: string;
  /** Builds the line for a check time and heartbeat age. */
  line: (now: number, beatAgeMs: number | null) => string;
}

const hhmm = (t: number): string => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function seen(iso: string | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1)) return 'never seen';
  const d = new Date(t);
  const n = new Date(now);
  const day = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return `last seen ${day ? '' : `${MONTHS[d.getMonth()]} ${d.getDate()} `}${hhmm(t)}`;
}
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Ask the local Syncthing. Never throws: every failure becomes a status. */
export async function syncthingStatus(vault: string, setting: string, deps: SyncDeps = {}, now = Date.now()): Promise<SyncReport> {
  const home = deps.home ?? os.homedir();
  const platform = deps.platform ?? process.platform;
  const report = (level: SyncLevel, parts: string[]): SyncReport => ({
    level, key: parts.join(' · '),
    line: (t, age) => {
      const [head, ...rest] = parts;
      const keeper = age === null ? 'keeper alive' : age > STALE_MS ? `keeper SILENT (last beat ${Math.round(age / 60_000)} min ago)`
        : `keeper alive (beat ${age < 90_000 ? 'just now' : `${Math.round(age / 60_000)} min ago`})`;
      return [head, keeper, `checked ${hhmm(t)}`, ...rest, `[Syncthing](${SYNCTHING_UI})`].join(' · ');
    },
  });
  const unreachable = report('error', ['❌ Syncthing not reachable from the keeper']);
  let cfg: SyncthingConfig | null = null;
  for (const file of configCandidates(setting, deps)) {
    try { cfg = parseSyncthingConfig(fs.readFileSync(file, 'utf8')); break; } catch { /* the next place */ }
  }
  if (!cfg?.gui) return unreachable;
  const want = norm(vault, home, platform);
  const folder = cfg.folders.find((f) => norm(f.path, home, platform) === want);
  if (!folder) return report('warn', ['⚠️ Syncthing on the keeper shares no folder at the vault path']);
  const gui = cfg.gui;
  const get = async <T>(route: string): Promise<T> => {
    const res = await (deps.fetch ?? fetch)(`${gui.url}${route}`, { headers: { 'X-API-Key': gui.apikey }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  const q = encodeURIComponent(folder.id);
  try {
    const [system, db, conns, stats] = await Promise.all([
      get<{ myID?: string }>('/rest/system/status'),
      get<{ state?: string; needFiles?: number; errors?: number; pullErrors?: number }>(`/rest/db/status?folder=${q}`),
      get<{ connections?: Record<string, { connected?: boolean }> }>('/rest/system/connections'),
      get<Record<string, { lastSeen?: string }>>('/rest/stats/device').catch(() => ({} as Record<string, { lastSeen?: string }>)),
    ]);
    const others = [...new Set(folder.devices)].filter((id) => id !== system.myID);
    const devices: DeviceState[] = await Promise.all(others.map(async (id) => {
      const c = await get<{ completion?: number; needItems?: number; needDeletes?: number }>(`/rest/db/completion?folder=${q}&device=${encodeURIComponent(id)}`)
        .catch(() => ({ completion: -1, needItems: 0, needDeletes: 0 }));
      return { id, name: cfg!.names[id] || id.slice(0, 7), connected: conns.connections?.[id]?.connected === true,
        completion: typeof c.completion === 'number' ? c.completion : -1, needItems: (c.needItems ?? 0) + (c.needDeletes ?? 0), lastSeen: stats[id]?.lastSeen };
    }));
    devices.sort((a, b) => a.name.localeCompare(b.name));
    const errors = (db.errors ?? 0) + (db.pullErrors ?? 0);
    const upToDate = devices.filter((d) => d.connected && d.completion >= 100 && !d.needItems);
    const offlineDone = devices.filter((d) => !d.connected && d.completion >= 100 && !d.needItems);
    const behind = devices.filter((d) => !upToDate.includes(d) && !offlineDone.includes(d));
    const behindText = behind.map((d) => d.completion < 0 ? `${d.name} unknown${d.connected ? '' : ` (offline, ${seen(d.lastSeen, now)})`}`
      : `${d.name} ${Math.floor(d.completion)}% (${plural(d.needItems, 'file')} behind, ${d.connected ? 'syncing' : seen(d.lastSeen, now)})`);
    const tail = [
      ...behindText,
      ...(upToDate.length ? [`${upToDate.map((d) => d.name).join(', ')} up to date`] : []),
      ...offlineDone.map((d) => `${d.name} offline (${seen(d.lastSeen, now)})`),
    ];
    if (errors || db.state === 'error') {
      return report('error', [`❌ Syncthing errors: ${errors ? `${plural(errors, 'item')} failing on the keeper` : 'the vault folder stopped'}`, ...tail]);
    }
    const pulling = db.needFiles ?? 0;
    if (pulling) return report('warn', [`⚠️ keeper still pulling ${plural(pulling, 'file')}`, ...tail]);
    if (behind.length) return report('warn', [`⚠️ ${tail[0]}`, ...tail.slice(1)]);
    return report('ok', ['✅ In sync', ...tail]);
  } catch {
    return unreachable;
  }
}

// -- the Home block ---------------------------------------------------------------------------------

interface Memo { at: number; key: string; level: SyncLevel | ''; hash: string; conflict?: string }
const memos = new Map<string, Memo>();
/** Tests: forget what was written. */
export function forgetSync(): void { memos.clear(); }

const keyOf = (block: string | null): string => (block ?? '').replace(/ \^sync-status$/, '').trim();

/**
 * Write the status line under the top Home's title when it says something new, or once an hour. A block a person
 * edited is theirs: kept, recorded once as a conflict (Needs attention), and resumed when they empty or remove it.
 * Returns whether Home.md was written.
 */
export function writeSyncBlock(root: string, report: SyncReport, now: number, pc: string): boolean {
  const text = read(root, ROOT_HOME);
  if (text === null) return false;
  const current = getBlock(text, SYNC_BLOCK);
  let memo = memos.get(root);
  if (!memo) {
    const all = revisions(root);
    const last = lastFor(all, SYNC_SPACE, ROOT_HOME, SYNC_BLOCK);
    const conflict = [...all].reverse().find((r) => r.kind === 'conflict' && r.space === SYNC_SPACE && r.page === ROOT_HOME && r.block === SYNC_BLOCK);
    memo = { at: last ? Date.parse(last.ts) : 0, key: '', level: '', hash: last?.after ?? sha(''), conflict: conflict?.after };
    memos.set(root, memo);
  }
  const have = sha(current ?? '');
  if (current && have !== memo.hash) {
    if (memo.conflict !== have) {
      appendRevision(root, { id: randomBytes(4).toString('hex'), ts: new Date(now).toISOString(), kind: 'conflict', state: 'conflict',
        space: SYNC_SPACE, page: ROOT_HOME, block: SYNC_BLOCK, author: `keeper@${pc}`, source: 'D124: Syncthing status', before: memo.hash, after: have });
      memo.conflict = have;
    }
    return false;
  }
  const age = (() => { const hb = heartbeat(root); return hb ? Math.max(0, now - Date.parse(hb.ts)) : null; })();
  const line = `${report.line(now, age)} ^${SYNC_ANCHOR}`;
  // After a restart the memo has no key: read what the block says (its times differ, so compare the line's key).
  const shownKey = memo.key || (current ? stripTimes(keyOf(current)) : '');
  const sameText = current !== null && shownKey === stripTimes(keyOf(line));
  const since = now - memo.at;
  if (sameText && since < HOUR_MS) return false;
  if (!sameText && current && memo.level === report.level && since < SETTLE_MS) return false;
  const after = setBlock(text, SYNC_BLOCK, line);
  put(root, ROOT_HOME, after);
  const r: Revision = { id: randomBytes(4).toString('hex'), ts: new Date(now).toISOString(), kind: 'status', state: 'written', space: SYNC_SPACE,
    page: ROOT_HOME, block: SYNC_BLOCK, author: `keeper@${pc}`, source: 'D124: Syncthing status', before: have, after: sha(line), text_hash: sha(report.key) };
  appendRevision(root, r);
  memos.set(root, { at: now, key: stripTimes(keyOf(line)), level: report.level, hash: sha(line) });
  try { touchIndex(root, [ROOT_HOME]); } catch { /* the index catches up at the check-up */ }
  return true;
}
/** The line without what changes every check: the time, the heartbeat age. */
const stripTimes = (line: string): string => line.replace(/ · checked \d\d:\d\d/, '').replace(/keeper alive \([^)]*\)/, 'keeper alive')
  .replace(/keeper SILENT \([^)]*\)/, 'keeper SILENT');

// -- bookmarks ----------------------------------------------------------------------------------------

const BOOKMARKS = '.obsidian/bookmarks.json';
const CORE_PLUGINS = '.obsidian/core-plugins.json';
const DONE = '.keeper/obsidian.json';
interface Bookmark { type: string; path?: string; subpath?: string; url?: string; title?: string; ctime?: number; items?: Bookmark[] }

/**
 * Once per vault: the "Sync status" and "Open Syncthing" bookmarks merged into the shared Obsidian bookmarks (the
 * person's own kept), and the core Bookmarks plugin turned on if it is off. Written once; a person's later edits
 * (removing them, turning the plugin off) are respected. Returns whether anything was written.
 */
export function ensureSyncBookmarks(root: string, now: number): boolean {
  let done: Record<string, unknown> = {};
  try { done = JSON.parse(read(root, DONE) ?? '{}') as Record<string, unknown>; } catch { /* rewritten below */ }
  if (done.bookmarks) return false;
  if (!fs.existsSync(path.join(root, '.obsidian'))) return false;
  let marks: { items: Bookmark[] } & Record<string, unknown> = { items: [] };
  const had = read(root, BOOKMARKS);
  if (had !== null) {
    try {
      const parsed = JSON.parse(had) as { items?: unknown };
      if (!parsed || typeof parsed !== 'object' || (parsed.items !== undefined && !Array.isArray(parsed.items))) return false;
      marks = { ...(parsed as Record<string, unknown>), items: (parsed.items as Bookmark[] | undefined) ?? [] };
    } catch {
      return false; // a file Obsidian is half-way through writing, or a person's: never clobbered
    }
  }
  const flat = (items: Bookmark[]): Bookmark[] => items.flatMap((b) => [b, ...(Array.isArray(b.items) ? flat(b.items) : [])]);
  const all = flat(marks.items);
  const want: Bookmark[] = [
    { type: 'file', ctime: now, path: ROOT_HOME, subpath: `#^${SYNC_ANCHOR}`, title: 'Sync status' },
    { type: 'url', ctime: now, url: SYNCTHING_UI, title: 'Open Syncthing' },
  ];
  const missing = want.filter((w) => !all.some((b) => b.type === w.type &&
    (w.type === 'url' ? b.url === w.url : b.path === w.path && (b.subpath ?? '') === w.subpath)));
  let wrote = false;
  if (missing.length) {
    marks.items.push(...missing);
    put(root, BOOKMARKS, `${JSON.stringify(marks, null, 2)}\n`);
    wrote = true;
  }
  const core = read(root, CORE_PLUGINS);
  if (core !== null) {
    try {
      const c = JSON.parse(core) as unknown;
      if (Array.isArray(c) && !c.includes('bookmarks')) { put(root, CORE_PLUGINS, `${JSON.stringify([...c, 'bookmarks'], null, 2)}\n`); wrote = true; }
      else if (c && typeof c === 'object' && !Array.isArray(c) && (c as Record<string, unknown>).bookmarks !== true) {
        put(root, CORE_PLUGINS, `${JSON.stringify({ ...(c as Record<string, unknown>), bookmarks: true }, null, 2)}\n`);
        wrote = true;
      }
    } catch { /* not ours to repair */ }
  }
  put(root, DONE, `${JSON.stringify({ ...done, bookmarks: new Date(now).toISOString() })}\n`);
  return wrote;
}

/** One keeper tick's sync step: bookmarks once, then the status line. Fails open. */
export async function syncTick(root: string, setting: string, now: number, pc: string, deps: SyncDeps = {}): Promise<void> {
  try { ensureSyncBookmarks(root, now); } catch { /* next tick */ }
  const report = await syncthingStatus(root, setting, deps, now);
  try { writeSyncBlock(root, report, now, pc); } catch { /* next tick */ }
}
