/** The `vault` MCP tool: its schema, its handler, and the vault lines every session hears. */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import type { Board, Session } from './board.js';
import { SETTINGS } from './cards.js';
import { thisPc } from './know.js';
import { CONFIDENCE, RESEARCH_STATUSES } from './vault-research.js';
import { catchup, searchVault } from './vault-catchup.js';
import { CARE_STAGES, type FrontmatterWrite, KINDS, type Kind, STAGES, configOf, keeperConfig, str } from './vault-store.js';
import { type WriteRequest, applyWrite, prepared, validateWrite } from './vault-write.js';
import { findClientPage, readPage } from './vault-read.js';
import { type KeeperDeps, sendToKeeper } from './vault-transport.js';
import { sendCockpit } from './vault-cockpit.js';
import { keeperStatus } from './vault-heartbeat.js';
import { CONNECTION_RULE } from './vault-rulebook.js';

export const person = (): string => {
  try { return str(JSON.parse(fs.readFileSync(SETTINGS.file, 'utf8')).person); } catch { return ''; }
};

export async function vaultTool(board: Board, me: Session, args: Record<string, unknown>, deps: KeeperDeps = {}): Promise<string> {
  const cfg = configOf(deps);
  if (!cfg) throw new Error('the shared vault is not configured on this PC (settings.json "vault")');
  const op = str(args.op);
  const at = (deps.now ?? Date.now)();
  // D132: catchup, search and log reads take since (a time, or "2d") and limit; reads also before and offset.
  const since = str(args.since) || undefined;
  if (op === 'read') {
    return readPage(cfg.path, str(args.page), str(args.space) || undefined, { reveal: args.reveal === true || args.reveal === 'true',
      limit: args.limit, before: str(args.before) || undefined, since, offset: args.offset, now: at });
  }
  if (op === 'search') {
    return searchVault(cfg.path, str(args.query), { tobira_id: str(args.tobira_id) || undefined, space: str(args.space) || undefined, since, limit: args.limit, now: at });
  }
  if (op === 'catchup') {
    return catchup(cfg.path, { space: str(args.space) || undefined, tobira_id: str(args.tobira_id) || undefined, query: str(args.query) || undefined,
      since, limit: args.limit, now: at });
  }
  if (op === 'client') return findClientPage(cfg.path, str(args.query) || str(args.tobira_id));
  if (op === 'status') return keeperStatus(cfg, at).join('\n');
  if (op !== 'write') throw new Error('op must be catchup, read, search, client, status or write');
  const now = (deps.now ?? board.clock)();
  const owner = person();
  let req: WriteRequest = {
    request_id: `${now.toString(36)}-${randomBytes(6).toString('hex')}`,
    kind: str(args.kind) as Kind,
    text: typeof args.text === 'string' ? args.text : '',
    source: str(args.source),
    author: { agent: me.name, pc: (deps.pc ?? thisPc)(), ...(owner ? { person: owner } : {}) },
  };
  for (const k of ['space', 'tobira_id', 'name', 'page', 'section', 'accepted_by', 'email', 'domain', 'website', 'evidence', 'client_name',
    'site', 'account', 'url', 'note', 'topic', 'status', 'date', 'confidence'] as const) {
    if (str(args[k])) req[k] = str(args[k]);
  }
  // Research lists: an array, or JSON text or one item per line from clients that send text.
  for (const k of ['sources', 'related'] as const) {
    let v = args[k];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'string') { const s = v; try { v = JSON.parse(s); } catch { v = s.split('\n'); } }
    req[k] = (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
  }
  // A password is taken exactly as given (never trimmed), and only by kind credential (validateWrite).
  if (typeof args.value === 'string') req.value = args.value;
  if (typeof args.replaces === 'string') req.replaces = args.replaces;
  if (args.frontmatter !== undefined && args.frontmatter !== null) {
    let fm = args.frontmatter;
    // Some clients send an object argument as JSON text.
    if (typeof fm === 'string') { try { fm = JSON.parse(fm); } catch { throw new Error('frontmatter must be an object'); } }
    req.frontmatter = fm as FrontmatterWrite;
  }
  req = prepared(req);
  validateWrite(req);
  if (cfg.keeper) {
    const out = applyWrite(cfg.path, req, now, undefined, { cockpit: !!cfg.cockpit });
    if (req.kind !== 'connection' || out.state !== 'written' || !cfg.cockpit) return out.message;
    const sent = await sendCockpit(cfg, deps);
    return `${out.message}. acme-cockpit: ${sent.sent} sent` +
      `${sent.conflicts.length ? `; conflict, written as a proposal for a person: ${sent.conflicts.join(', ')}` : ''}` +
      `${sent.refused ? `; ${sent.refused} refused (listed on Needs attention)` : ''}` +
      `${sent.left ? `; ${sent.left} waiting (${sent.error ?? 'retried'}), retried every 30 seconds` : ''}.`;
  }
  const sent = await sendToKeeper(cfg, req, now, deps);
  if (sent.queued) board.usage?.({ ts: board.clock(), tool: 'vault:queue', me: me.name, ok: false });
  return sent.message;
}

export const VAULT_TOOL = {
  name: 'vault',
  description: [
    'The shared Obsidian vault, grouped by business. Reads are local; writes go to the keeper on keeper-pc.',
    'Spaces: "agency" (the Acme business), "business:<key>", a client ID (T-…) or "project:<repo>".',
    'Read: op "catchup" (space, or query = a client\'s name; since="2d" for only what changed); "client" (query: Acme ID, name or alias) ' +
      'opens its Overview; "search" (query; optional tobira_id, space, since); "read" (page; optional space). Work log, Communication and log ' +
      'read newest first (limit, before = an entry id, since, offset). Cite the "based on" line each answer ends with. ' +
      'Another PC\'s git state of a repo: read page "Facts/working-copies" in space "project:<repo>". op "status": the keeper\'s heartbeat and queues.',
    'Write: op "write", kind, source (always). kind event: Work log or Communication (page). fact: page "Facts/<name>"; replacing one needs ' +
      'replaces = its current value. decision: section = topic. proposal, summary. connection: tobira_id, name = the connected business, ' +
      'evidence; optional email, domain, website. credential: site, account, value = the password; optional url, note. Reads mask passwords ' +
      'unless reveal=true, which is only for signing in yourself. research: topic, text = the summary; optional name, status, date, confidence, sources, related.',
    'Research and learning notes: leave space out and they go to Learning/Research. A business, client or project space files the note ' +
      'in that space\'s business (a project in no business: Learning).',
    'frontmatter (client or project space only) sets Overview fields; frontmatter.business re-files a project or moves a client to that business.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      me: { type: 'string' },
      op: { type: 'string', enum: ['catchup', 'read', 'search', 'client', 'status', 'write'] },
      since: { type: 'string', description: 'catchup, search and log reads: only entries since then ("2d", "12h", "2026-11-05", "2026-11-05 21:00 JST"; no zone = UTC).' },
      before: { type: 'string', description: 'log reads: entries older than this entry id (r-…, as the last answer names it) or time.' },
      limit: { type: 'number', description: 'catchup and log reads: entries (default 8 and 10); search: pages (default 10).' },
      offset: { type: 'number', description: 'read: the page as written, from this character (20000 per answer).' },
      kind: { type: 'string', enum: [...KINDS] },
      space: { type: 'string', description: '"agency" (Acme), "business:<key>", a client ID (T-…) or "project:<repo>".' },
      ...Object.fromEntries(['query', 'page', 'tobira_id', 'section', 'text', 'source', 'replaces', 'accepted_by', 'name',
        'email', 'domain', 'website', 'evidence'].map((k) => [k, { type: 'string' }])),
      client_name: { type: 'string', description: 'connection only: the client\'s name when its folder does not exist yet.' },
      site: { type: 'string', description: 'credential only: the site (host) the password is for.' },
      account: { type: 'string', description: 'credential only: the account (login or email).' },
      value: { type: 'string', description: 'credential only: the password. Never pass it in any other field.' },
      url: { type: 'string', description: 'credential only: the sign-in page.' },
      note: { type: 'string', description: 'credential only: a short note, without the password.' },
      reveal: { type: 'boolean', description: 'read only: show passwords instead of masking them.' },
      topic: { type: 'string', description: 'research only: the topic the note is grouped under (also its file name when name is not given).' },
      status: { type: 'string', enum: [...RESEARCH_STATUSES], description: 'research only (default draft).' },
      date: { type: 'string', description: 'research only: YYYY-MM-DD (default today for a new note).' },
      confidence: { type: 'string', enum: [...CONFIDENCE], description: 'research only.' },
      sources: { type: 'array', items: { type: 'string' }, description: 'research only: links the note is based on (merged).' },
      related: { type: 'array', items: { type: 'string' }, description: 'research only: other research notes by name, project:<repo>, client IDs or [[links]] (merged; graph edges).' },
      frontmatter: {
        type: 'object',
        description: 'Client or project space only: Overview front matter to set with this write. stage and care_stage replace; ' +
          'aliases, tags and cssclasses are added (never removed); business moves a project space on the keeper\'s next tick, ' +
          'or a client to another business right after the write. Other keys are refused.',
        properties: {
          stage: { type: 'string', enum: [...STAGES] },
          care_stage: { type: 'string', enum: [...CARE_STAGES] },
          aliases: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          cssclasses: { type: 'array', items: { type: 'string' } },
          business: { type: 'string', description: 'project spaces: a business key, "shared", "unsorted" or a client ID (T-…); clients: a business key.' },
          last_event: { type: 'string', description: 'one line: the last thing that happened (the keeper keeps it from event writes on clients).' },
          next_step: { type: 'string', description: 'one line: what happens next (shown on the client\'s Pipeline card).' },
          status: { type: 'string', description: 'one short line: where a project stands (active, paused, …), shown on its business\'s project status board.' },
        },
      },
    },
    required: ['me', 'op'],
  },
};

/** SessionStart lines (D78), only where the vault is configured. */
export function vaultRules(cfg = keeperConfig()): string {
  if (!cfg) return '';
  return [
    '[kokuban] Shared vault (Obsidian): use only the vault tool; its description says how to read and write. ' +
      'Catch up first with vault(op="catchup", space="T-…" or "project:<repo>"). Current truth is the Overview, Facts/ and accepted decisions.',
    '- Never edit, move or delete files in the vault folder. A "queued" write goes through by itself. If a write is refused, fix the request; never write the file another way.',
    '- Passwords go only in kind=credential. Use them by name and never echo them.',
    '- A proposal is not a decision: a conflicting fact or decision comes back as a proposal for a person to accept.',
    `- ${CONNECTION_RULE}`,
    '- Keep personal and private matters, raw transcripts and security engagement evidence out.',
  ].join('\n');
}

// -- the daemon's tick ----------------------------------------------------------------------------
