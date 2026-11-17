/**
 * D99 one-shot export: every computeruse/* password in this PC's
 * Credential Manager goes to the Credentials page of the vault space it belongs to, through the keeper's
 * kind=credential write. Values exist only in memory and in the bridge's stdin/stdout pipes; nothing here
 * prints, logs or writes one. Personal or unclear entries are left out and listed by name for the owner.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { frontmatter } from './vault-layout.js';
import { groupingOf } from './vault-store.js';
import { allClients, allProjects } from './vault-layout.js';

export interface ClientRef { tobiraId: string; names: string[]; domains: string[]; emails: string[] }
export interface ProjectRef { repo: string }
export interface Directory { clients: ClientRef[]; projects: ProjectRef[] }
export interface Mapping { name: string; site: string; account: string; space: string; reason?: string }
export const UNMAPPED = 'UNMAPPED';
const PREFIX = 'computeruse/';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : str(v) ? [str(v)] : []).map((s) => s.trim()).filter(Boolean);
/** Names compared as letters and digits only: "Aozora Kobo Works" and "aozora-kobo-works" match. */
const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
const SECOND_LEVEL = new Set(['co', 'com', 'ne', 'net', 'or', 'org', 'ac', 'go', 'gov', 'edu']);
/** A host as computeruse keeps it: lower case, no www., no port or path. */
export function hostOf(s: string): string {
  const raw = s.trim().toLowerCase();
  let h = raw;
  try { h = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`).hostname; } catch { /* keep as is */ }
  return h.replace(/^\[|\]$/g, '').replace(/^www\./, '').replace(/\.$/, '');
}
/** example.com for accounts.example.com; example.co.jp for id.example.co.jp (as computeruse's passwords.py). */
export function registrable(host: string): string {
  const parts = host.split('.');
  if (parts.length >= 3 && parts.at(-1)!.length === 2 && SECOND_LEVEL.has(parts.at(-2)!)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}
/** The labels that name something: the host without its public suffix. */
function nameLabels(host: string): string[] {
  const reg = registrable(host);
  const suffix = reg.split('.').slice(1).length;
  return host.split('.').slice(0, host.split('.').length - suffix).filter(Boolean);
}
const within = (host: string, domain: string): boolean => !!domain && (host === domain || host.endsWith(`.${domain}`));

const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.co.jp', 'yahoo.com', 'icloud.com', 'me.com', 'mac.com', 'outlook.com',
  'outlook.jp', 'hotmail.com', 'hotmail.co.jp', 'live.com', 'live.jp', 'msn.com', 'proton.me', 'protonmail.com', 'docomo.ne.jp',
  'ezweb.ne.jp', 'au.com', 'softbank.ne.jp', 'i.softbank.jp', 'aol.com', 'gmx.com', 'mail.com', 'yandex.com', 'qq.com', '163.com']);
const GAMES = new Set(['steampowered.com', 'steamcommunity.com', 'epicgames.com', 'riotgames.com', 'leagueoflegends.com', 'nintendo.com',
  'nintendo.co.jp', 'nintendo.net', 'playstation.com', 'sony.com', 'xbox.com', 'ea.com', 'blizzard.com', 'battle.net', 'roblox.com',
  'minecraft.net', 'mojang.com', 'hoyoverse.com', 'mihoyo.com', 'ubisoft.com', 'square-enix.com', 'konami.net', 'twitch.tv', 'chess.com',
  'valorant.com', 'gog.com', 'itch.io', 'curseforge.com', 'pokemon.com']);
const EXAMPLE = new Set(['example.com', 'example.org', 'example.net']);
const SCRATCH = new Set(['test', 'tests', 'testing', 'tester', 'demo', 'dummy', 'sample', 'sandbox', 'fake', 'example']);
const AGENCY_DOMAINS = ['acme-agency.net', 'acmeagency.io'];
const AGENCY_NAMES = new Set(['acme', 'acmeagency']);

/** Why an entry is personal or unclear on its face, before any client, project or agency match. */
function scratch(host: string, account: string): string {
  if (!host) return 'no site';
  if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return 'local address';
  if (/\.(invalid|test|example|localhost|local)$/.test(host) || EXAMPLE.has(registrable(host))) return 'example or test site';
  const mail = account.includes('@') ? hostOf(account.split('@').pop()!) : '';
  if (mail && (/\.(invalid|test|example|localhost|local)$/.test(mail) || EXAMPLE.has(registrable(mail)))) return 'example or test account';
  const tokens = [...account.split('@')[0]!.toLowerCase().split(/[^a-z0-9]+/), ...(nameLabels(host)[0] ?? '').split(/[^a-z0-9]+/)];
  if (tokens.some((t) => SCRATCH.has(t))) return 'test or demo account';
  if (/\.(ac\.jp|ac\.uk|edu)$/.test(host) || /\.edu\.[a-z]{2}$/.test(host) || (mail && /\.(ac\.jp|ac\.uk|edu)$/.test(mail))) return 'university';
  if (GAMES.has(registrable(host))) return 'game';
  return '';
}

function clientMatches(c: ClientRef, host: string, account: string): boolean {
  const acct = account.toLowerCase();
  const mail = acct.includes('@') ? hostOf(acct.split('@').pop()!) : '';
  if (c.emails.includes(acct)) return true;
  if (c.domains.some((d) => within(host, d) || (mail && !FREE_MAIL.has(mail) && within(mail, d)))) return true;
  const slugs = c.names.map(norm).filter((s) => s.length >= 6);
  const words = [...nameLabels(host), ...(mail && !FREE_MAIL.has(mail) ? nameLabels(mail) : []), acct.split('@')[0]!].map(norm);
  return slugs.some((s) => words.includes(s));
}
function agencyMatches(host: string, account: string): boolean {
  const acct = account.toLowerCase();
  const mail = acct.includes('@') ? hostOf(acct.split('@').pop()!) : '';
  if (AGENCY_DOMAINS.some((d) => within(host, d) || within(mail, d))) return true;
  return [...nameLabels(host), acct.split('@')[0]!].map(norm).some((w) => AGENCY_NAMES.has(w));
}
function projectMatches(p: ProjectRef, host: string, account: string): boolean {
  const slug = norm(p.repo);
  if (slug.length < 4) return false;
  return [...nameLabels(host), account.toLowerCase().split('@')[0]!].map(norm).includes(slug);
}

/** The site and account a computeruse/<site>/<account> entry is kept under (the stored user name when the name has none). */
export function splitName(name: string, user = ''): { site: string; account: string } {
  const rest = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
  const at = rest.indexOf('/');
  const site = at < 0 ? rest : rest.slice(0, at);
  const account = (at < 0 ? '' : rest.slice(at + 1)) || user;
  return { site: site.trim(), account: account.trim() };
}

/**
 * The vault space an entry belongs to: a client (Acme ID) when its account email, site or account matches the
 * client's Overview (domains, emails, name and aliases); otherwise "agency" for Acme's own accounts, then a
 * project space whose repository name the site or account carries. Anything personal or unclear is UNMAPPED.
 */
export function mapCredential(name: string, user: string, dir: Directory): Mapping {
  const { site, account } = splitName(name, user);
  const base = { name, site, account };
  const host = hostOf(site);
  if (!account) return { ...base, space: UNMAPPED, reason: 'no account' };
  const why = scratch(host, account) || (user && user !== account ? scratch(host, user) : '');
  if (why) return { ...base, space: UNMAPPED, reason: why };
  const accounts = [...new Set([account, user].filter(Boolean))];
  // One client matched through two signals, or found twice (its old Clients/ folder beside Acme/Clients/ while a
  // regroup syncs), is still one client.
  const clients = [...new Set(dir.clients.filter((c) => accounts.some((a) => clientMatches(c, host, a))).map((c) => c.tobiraId))];
  if (clients.length > 1) return { ...base, space: UNMAPPED, reason: `several clients match: ${clients.join(', ')}` };
  if (clients.length === 1) return { ...base, space: clients[0]! };
  if (accounts.some((a) => agencyMatches(host, a))) return { ...base, space: 'agency' };
  const projects = dir.projects.filter((p) => accounts.some((a) => projectMatches(p, host, a)));
  if (projects.length === 1) return { ...base, space: `project:${projects[0]!.repo}` };
  if (projects.length > 1) return { ...base, space: UNMAPPED, reason: `several projects match: ${projects.map((p) => p.repo).join(', ')}` };
  return { ...base, space: UNMAPPED, reason: 'personal or unclear' };
}

function readText(file: string): string {
  try { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; }
}
const DOMAIN_KEYS = ['domain', 'domains', 'website', 'websites', 'url', 'urls', 'site', 'sites'];
const EMAIL_KEYS = ['email', 'emails', 'mail'];
/**
 * Clients (Acme ID, name, aliases, domains and emails from the Overview's front matter, plus the domains and
 * emails recorded under "Connected businesses") and project spaces, read from the synced vault.
 */
export function loadDirectory(root: string): Directory {
  const byId = new Map<string, ClientRef>();
  const g = groupingOf(root);
  // D101: every business's clients (and the old top-level Clients/ until the vault is regrouped).
  for (const { dir, name: d } of allClients(root, g)) {
    const at = path.join(root, ...dir.split('/'));
    const overview = readText(path.join(at, 'Overview.md'));
    const fm = frontmatter(overview);
    const id = str(fm.tobira_id) || /^(T-\d+)(?: |$)/.exec(d)?.[1] || '';
    if (!/^T-\d+$/.test(id)) continue;
    const connected = readText(path.join(at, 'Decisions.md'));
    // The cockpit import's summary line: "**Tenant / mailbox:** acme · hello@example.co.jp · https://www.example.co.jp/".
    const mailbox = /^\*\*Tenant \/ mailbox:\*\*(.*)$/m.exec(overview)?.[1] ?? '';
    const domains = [...DOMAIN_KEYS.flatMap((k) => list(fm[k])), ...[...connected.matchAll(/\b(?:domain|website) (\S+)/g)].map((m) => m[1]!),
      ...[...mailbox.matchAll(/https?:\/\/[^\s·)]+/g)].map((m) => m[0])]
      .map(hostOf).filter((h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h));
    const emails = [...EMAIL_KEYS.flatMap((k) => list(fm[k])), ...[...connected.matchAll(/\bemail (\S+@\S+)/g)].map((m) => m[1]!),
      ...[...mailbox.matchAll(/[^\s·:/]+@[^\s·/]+/g)].map((m) => m[0])]
      .map((e) => e.toLowerCase().replace(/^mailto:/, '')).filter((e) => /^[^\s@]+@[^\s@]+$/.test(e));
    // One client found twice (its old Clients/ folder beside Acme/Clients/ while the regroup syncs) is one entry.
    const ref = byId.get(id) ?? { tobiraId: id, names: [], domains: [], emails: [] };
    byId.set(id, ref);
    const add = (to: string[], items: string[]): void => { for (const x of items) if (x && !to.includes(x)) to.push(x); };
    add(ref.names, [str(fm.name), d.slice(id.length).trim(), ...list(fm.aliases)]);
    add(ref.domains, domains);
    add(ref.emails, emails);
    // Business emails name a domain too (hello@aozora-kobo-works.jp → aozora-kobo-works.jp), unless free mail.
    add(ref.domains, ref.emails.map((e) => hostOf(e.split('@').pop()!)).filter((h) => !FREE_MAIL.has(h)));
  }
  const clients = [...byId.values()];
  const projects = allProjects(root, g).map((p) => ({ repo: p.repo }));
  return { clients, projects };
}

/** A Credential Manager blob as text: what CredWrite stored from a string is UTF-16LE, bytes it was given are UTF-8. */
export function decodeBlob(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  const utf8 = buf.toString('utf8');
  const out = Buffer.from(utf8, 'utf8').equals(buf) && !utf8.includes('\0') ? utf8 : buf.length % 2 === 0 ? buf.toString('utf16le') : utf8;
  return out.replace(/\0+$/, '');
}

export interface ExportAccess {
  index(): Promise<{ entries: { name: string; account: string }[]; skipped: string[] }>;
  fetch(names: string[]): Promise<{ name: string; account: string; blob: string }[]>;
}
export interface ExportOptions {
  dryRun: boolean;
  root: string;
  access: ExportAccess;
  /** One vault tool call (op write, kind credential); returns its text or throws. */
  call: (args: Record<string, unknown>) => Promise<string>;
  print: (line: string) => void;
  pc: string;
}
export interface ExportSummary { mapped: number; unmapped: number; written: number; unchanged: number; failed: number }

/** The URL a row links to: the site's own address, for a host that looks like one. */
const urlOf = (site: string): string | undefined => (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(site) ? `https://${site}/` : undefined);
/** Never print a value: whatever a message says, any password in it is masked first. */
const scrub = (s: string, values: string[]): string => values.reduce((t, v) => (v.length >= 3 ? t.split(v).join('••••••') : t), s);

export async function runExport(o: ExportOptions): Promise<ExportSummary> {
  const listing = await o.access.index();
  const dir = loadDirectory(o.root);
  const all = listing.entries.filter((e) => e.name.startsWith(PREFIX)).map((e) => mapCredential(e.name, e.account, dir))
    .sort((a, b) => a.space.localeCompare(b.space) || a.name.localeCompare(b.name));
  const mapped = all.filter((m) => m.space !== UNMAPPED);
  const unmapped = all.filter((m) => m.space === UNMAPPED);
  const summary: ExportSummary = { mapped: mapped.length, unmapped: unmapped.length, written: 0, unchanged: 0, failed: 0 };
  o.print(`${all.length} computeruse entries: ${mapped.length} mapped, ${unmapped.length} left out${o.dryRun ? ' (dry run: nothing is read or written)' : ''}`);
  if (o.dryRun) {
    for (const m of mapped) o.print(`${m.site}/${m.account} → ${m.space}`);
  } else if (mapped.length) {
    // The only secret-bearing step: the bridge's stdout, held in memory for these writes.
    const fetched = new Map((await o.access.fetch(mapped.map((m) => m.name))).map((e) => [e.name, e]));
    const values: string[] = [];
    for (const m of mapped) {
      const entry = fetched.get(m.name);
      if (!entry) { summary.failed++; o.print(`${m.site}/${m.account} → ${m.space}: failed (not readable from Credential Manager)`); continue; }
      const value = decodeBlob(entry.blob);
      values.push(value);
      try {
        const out = await o.call({ op: 'write', kind: 'credential', space: m.space, site: m.site, account: m.account, value,
          ...(urlOf(m.site) ? { url: urlOf(m.site) } : {}), source: `computeruse Credential Manager on ${o.pc} (D99 one-shot export)` });
        const state = /^(written|unchanged|conflict|queued)/.exec(out)?.[1] ?? 'answered';
        if (state === 'written') summary.written++; else if (state === 'unchanged') summary.unchanged++; else if (state !== 'answered') summary.failed++;
        o.print(`${m.site}/${m.account} → ${m.space}: ${state === 'answered' ? scrub(out.split('\n')[0]!, values).slice(0, 200) : state}`);
      } catch (err) {
        summary.failed++;
        o.print(`${m.site}/${m.account} → ${m.space}: failed (${scrub((err as Error).message, values).slice(0, 200)})`);
      }
    }
    values.length = 0;
  }
  if (unmapped.length) {
    o.print('');
    o.print(`Left out for the owner to place (names only, nothing written): ${unmapped.length}`);
    for (const m of unmapped) o.print(`- ${m.name} (${m.reason})`);
  }
  if (listing.skipped.length) o.print(`Unreadable metadata, skipped: ${listing.skipped.join(', ')}`);
  if (!o.dryRun) o.print(`written ${summary.written}, unchanged ${summary.unchanged}, failed ${summary.failed}`);
  return summary;
}

/** The local board's vault tool over POST /mcp (loopback, no Origin). The first call registers one session name. */
export function localVaultCall(port: number, fetchImpl: typeof fetch = fetch): (args: Record<string, unknown>) => Promise<string> {
  let me = 'new';
  let id = 0;
  return async (args) => {
    const res = await fetchImpl(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'vault', arguments: { me, ...args } } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`the board answered HTTP ${res.status}`);
    const body = await res.json() as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } };
    let text = body.result?.content?.[0]?.text ?? body.error?.message ?? '';
    const named = /^You are "([^"]+)"; pass me="[^"]+" from now on\.\n/.exec(text);
    if (named) { me = named[1]!; text = text.slice(named[0].length); }
    if (body.error || body.result?.isError) throw new Error(text || 'vault tool error');
    return text;
  };
}
