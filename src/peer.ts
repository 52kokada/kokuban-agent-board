/** Boards communicate directly over /peer through Tailscale Serve. Tailscale identifies
 * the sender; the receiving board's trust list grants talk, share or work access. */
import { execFile } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import * as os from 'node:os';
import type { Board } from './board.js';
import { handleBridge } from './bridge.js';
import { SETTINGS } from './cards.js';
import { PORT } from './config.js';
import { hello, lang, pairAnswered, pairAsked, unpairAsked } from './pair.js';
import { appAsked, appChunk } from './app-update.js';
import { codeAsked, offerAsked, type RepoName } from './update.js';
import { storeFor } from './know.js';
import { vaultAsked, type VaultAccess } from './vault.js';
import { keeperAsked, type KeeperDeps } from './vault-transport.js';

export const PEER_ROUTE = '/peer';
export const PEER_PROTOCOL = 1;
/**
 * Where this PC's Tailscale Serve forwards /peer: PEER_INGRESS + a private random value from
 * settings.json ("peerIngress"). Serve's plain-HTTP hop to 127.0.0.1 carries headers any local
 * program could also write, so the identity headers are believed only on a request that arrived
 * on this path. Remote boards still call /peer; only this PC's Serve entry and settings know it.
 */
export const PEER_INGRESS = `${PEER_ROUTE}/_ingress/`;

/** This PC's /peer ingress value, or '' before pairing has made one. */
export function ingressSecret(file = SETTINGS.file): string {
  try {
    const v = (JSON.parse(fs.readFileSync(file, 'utf8')) as { peerIngress?: unknown }).peerIngress;
    return typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : '';
  } catch {
    return '';
  }
}

/** Whether a request path is this PC's Serve ingress for /peer: 'serve', or 'refused'. */
export function peerIngress(url: string, secret: string): 'serve' | 'refused' {
  if (!secret || !url.startsWith(PEER_INGRESS)) return 'refused';
  const given = Buffer.from(url.slice(PEER_INGRESS.length).replace(/\/$/, ''));
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want) ? 'serve' : 'refused';
}

export type Trust = 'talk' | 'share' | 'work';
const RANK: Record<Trust, number> = { talk: 1, share: 2, work: 3 };
/** The least trust each operation needs. */
const NEEDS: Record<string, Trust> = {
  conversations: 'work',
  peers: 'talk', send: 'talk', receipt: 'talk', hello: 'talk', unpair: 'talk', poke: 'talk', state: 'share',
  glance: 'share', ask: 'share', card: 'share', task: 'share', feed: 'share', code: 'share', app: 'share', app_chunk: 'share', offer: 'share', knowhow: 'share',
  vault_index: 'work', vault_fetch: 'work', vault_write: 'work',
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const bare = (name: string): string => name.toLowerCase().replace(/\.$/, '');

function trustList(file: string): Record<string, unknown> | null {
  try {
    const listed = (JSON.parse(fs.readFileSync(file, 'utf8')) as { trust?: unknown }).trust;
    return listed && typeof listed === 'object' ? listed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}


/** What this PC lets another PC do, from settings.json: {"trust": {"pc-b.tail1234.ts.net": "work"}}. */
export function trustFor(pc: string, file = SETTINGS.file): Trust | null {
  const listed = trustList(file) ?? {};
  const key = Object.keys(listed).find((k) => bare(k) === bare(pc));
  const entry = key === undefined ? undefined : listed[key];
  const level = typeof entry === 'string' ? entry : str((entry as { level?: unknown } | undefined)?.level);
  return level in RANK ? level as Trust : null;
}

export interface Whois { login: string; node: string }
type WhoisFn = (address: string) => Promise<Whois>;
/** What a test puts in place of Tailscale. */
export interface PeerDeps {
  lookup?: WhoisFn; trust?: (pc: string) => Trust | null;
  /** This PC's /peer ingress value (ingressSecret); tests set their own. */
  ingress?: () => string;
  /** This PC's own names (ownNames); tests set their own. */
  self?: () => string[] | Promise<string[]>;
  /** Where this PC's repositories are (update.ts); tests point it at their own. */
  where?: (name: RepoName) => string | null;
  /** This PC's app feed and installed app (app-update.ts); tests point them at their own. */
  appFeed?: string;
  appExe?: string;
  vault?: VaultAccess;
  /** The shared-vault keeper (vault-keeper.ts); tests point it at their own. */
  keeper?: KeeperDeps;
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tailscale', args, { windowsHide: true, timeout: 5000, maxBuffer: 4 << 20 }, (err, out) =>
      err ? reject(err) : resolve(out));
  });
}

const known = new Map<string, { at: number; who: Whois }>();
/** Who Tailscale says is at this tailnet address. Kept a minute: a conversation is several calls. */
export async function whois(address: string): Promise<Whois> {
  const hit = known.get(address);
  if (hit && Date.now() - hit.at < 60_000) return hit.who;
  const data = JSON.parse(await run(['whois', '--json', address])) as {
    Node?: { Name?: string }; UserProfile?: { LoginName?: string };
  };
  const who = { login: str(data.UserProfile?.LoginName), node: bare(str(data.Node?.Name)) };
  known.set(address, { at: Date.now(), who });
  return who;
}

/**
 * The calling PC's full tailnet name. Tailscale Serve, the only way in from the tailnet, names
 * the caller's login and address in its headers; the address is checked with whois, so a
 * request's own words never decide who sent it. A request without them is refused. The headers
 * are only believed on Serve's private ingress path (PEER_INGRESS, checked in daemon.ts).
 */
export async function verifyCaller(headers: IncomingHttpHeaders, lookup: WhoisFn = whois): Promise<string> {
  const login = str(headers['tailscale-user-login']);
  const address = str(String(headers['x-forwarded-for'] ?? '').split(',').pop());
  if (!login || !isIP(address)) throw new Error('no Tailscale identity: /peer is reached through tailscale serve');
  const who = await lookup(address);
  if (who.login !== login) throw new Error('the Tailscale identity does not match whois');
  if (!who.node) throw new Error('the calling PC has no tailnet name');
  return who.node;
}

type TrustFn = (pc: string) => Trust | null;

/** The level a PC has for an operation, or why it may not. */
export function gate(pc: string, op: string, trust: TrustFn = trustFor): { level: Trust } | { status: number; error: string } {
  const need = NEEDS[op];
  if (!need) return { status: 400, error: `unknown op "${op}"` };
  const level = trust(pc);
  if (level && RANK[level] >= RANK[need]) return { level };
  return { status: 403, error: level ? `${op} needs "${need}" trust; this PC gives ${pc} "${level}"`
    : `${pc} is not in this PC's trust list. To ask this PC's person to connect, run: kokuban pair ${os.hostname().toLowerCase()}` };
}

// -- the local compatibility /bridge -------------------------------------------------------------

/**
 * The header a local relay (computeruse's device_bridge) sets to say it already verified the
 * remote PC named in the request: this PC's peerIngress value, the same proof Serve's /peer entry
 * carries in its path. Without it a /bridge request is this PC's own, whatever its body says.
 */
export const BRIDGE_RELAY = 'x-kokuban-relay';
/** What an unproven local caller may do: what this PC's own sessions already can through /mcp. Never "work". */
export const LOCAL_TRUST: Trust = 'share';

let self: { at: number; names: string[] } | null = null;
/** This PC's own names, lower case: its tailnet name in full and short when Tailscale answers, and its host name. */
export async function ownNames(status: () => Promise<string> = () => run(['status', '--json'])): Promise<string[]> {
  if (self && Date.now() - self.at < 300_000) return self.names;
  const names = [os.hostname().toLowerCase()];
  try {
    const data = JSON.parse(await status()) as { Self?: Node };
    const dns = bare(str(data.Self?.DNSName));
    if (dns) names.unshift(dns, dns.split('.')[0]!);
    const host = str(data.Self?.HostName).toLowerCase();
    if (host) names.push(host);
  } catch {
    /* Tailscale is down or absent: the host name is all there is */
  }
  self = { at: Date.now(), names: [...new Set(names)] };
  return self.names;
}

/** Whether a PC name a request gives is this PC. With no full tailnet name known, "<host>.anything" counts. */
function isSelf(pc: string, names: string[]): boolean {
  const name = bare(pc);
  if (names.includes(name)) return true;
  return !names.some((n) => n.includes('.')) && names.includes(name.split('.')[0]!);
}

/**
 * Who a POST /bridge request comes from, and with what trust. A local program is this PC: it may
 * name this PC or nobody, and gets LOCAL_TRUST. Naming another PC needs the relay proof
 * (BRIDGE_RELAY), and then that PC's trust list entry decides, as on /peer. A claimed foreign PC
 * without the proof is refused with 403, before any operation runs (D97).
 */
export async function bridgeCaller(
  headers: IncomingHttpHeaders, input: Record<string, unknown>, deps: PeerDeps = {},
): Promise<{ pc: string; level: Trust } | { status: number; error: string }> {
  const sender = (input.from && typeof input.from === 'object' ? input.from : {}) as Record<string, unknown>;
  const claimed = bare(str(sender.pc) || str(input.source));
  const op = str(input.op);
  const proof = str(headers[BRIDGE_RELAY]);
  if (proof) {
    if (peerIngress(PEER_INGRESS + proof, (deps.ingress ?? ingressSecret)()) !== 'serve') {
      return { status: 403, error: 'the relay proof does not match this PC\'s peerIngress' };
    }
    if (!claimed) return { status: 403, error: 'a relayed request names the verified PC it carries in from.pc' };
    const allowed = gate(claimed, op, deps.trust);
    return 'error' in allowed ? { status: 200, error: allowed.error } : { pc: claimed, level: allowed.level };
  }
  const names = await (deps.self ?? ownNames)();
  if (claimed && !isSelf(claimed, names)) {
    return { status: 403, error: `/bridge acts only as this PC (${names[0]}); it does not take "${claimed}" on a local ` +
      'program\'s word. Reach that PC\'s sessions through its own /peer.' };
  }
  const allowed = gate(claimed || names[0]!, op, () => LOCAL_TRUST);
  return 'error' in allowed ? { status: 200, error: allowed.error } : { pc: claimed || names[0]!, level: allowed.level };
}

/** Answers already given, by envelope id, so a retried request is never applied twice. */
const MUTATING = new Set(['send', 'task', 'ask', 'card']);
const done = new WeakMap<Board, Map<string, { status: number; body: object }>>();

/** One request from another board. */
export async function handlePeer(
  board: Board, headers: IncomingHttpHeaders, input: Record<string, unknown>,
  deps: PeerDeps = {},
): Promise<{ status: number; body: object }> {
  let pc: string;
  try {
    pc = await verifyCaller(headers, deps.lookup);
  } catch (err) {
    return { status: 403, body: { ok: false, error: (err as Error).message } };
  }
  const op = str(input.op);
  // The two requests a PC outside the trust list may make (pair.ts): a card for this PC's person,
  // and the answer to a pairing this board started with that PC.
  if (op === 'pair' || op === 'paired') {
    const out = op === 'pair' ? pairAsked(board, pc, input) : pairAnswered(board, pc, input);
    board.usage?.({ ts: board.clock(), tool: `peer:${op}`, me: `${str(input.me)}@${pc}`, ok: out.status === 200 });
    return out;
  }
  const allowed = gate(pc, op, deps.trust);
  board.usage?.({ ts: board.clock(), tool: `peer:${op}`, me: `${str(input.me)}@${pc}`, ok: !('error' in allowed) });
  if ('error' in allowed) return { status: allowed.status, body: { ok: false, error: allowed.error } };
  const level = allowed.level;
  if (op === 'conversations') {
    if (!board.conversations) return { status: 503, body: { ok: false, error: 'Shared conversations are unavailable on this board' } };
    try { return { status: 200, body: await board.conversations.remote(input.request, pc, input.person) as object }; }
    catch (e) { return { status: Number((e as { status?: number }).status) || 400, body: { ok: false, error: (e as Error).message, definitive: (e as { definitive?: boolean }).definitive === true } }; }
  }
  // A keyed ask has its own durable dedup that checks its words (cards.ts makeCardOnce): never answer it
  // from this in-memory envelope memory, which would hand back an earlier answer to different words.
  const keyedAsk = op === 'ask' && (() => {
    try {
      const k = (JSON.parse(str(input.text)) as { idempotency_key?: unknown }).idempotency_key;
      return k !== undefined && k !== null;
    } catch {
      return false;
    }
  })();
  const key = MUTATING.has(op) && !keyedAsk && str(input.envelope) ? `${pc}/${str(input.envelope)}` : '';
  const seen = done.get(board) ?? new Map<string, { status: number; body: object }>();
  done.set(board, seen);
  if (key && seen.has(key)) return seen.get(key)!;
  const from = { pc, agent: str(input.me) };
  if (op === 'vault_index' || op === 'vault_fetch') {
    try { return { status: 200, body: await vaultAsked(board, input, deps.vault) }; }
    catch { return { status: 503, body: { ok: false, error: 'Vault unavailable' } }; }
  }
  // A write for the shared vault, applied only by its keeper; its request_id makes a retry harmless.
  if (op === 'vault_write') return keeperAsked(input, pc, deps.keeper);
  if (op === 'hello') return { status: 200, body: await hello(deps.where, deps.appFeed, deps.appExe) };
  if (op === 'code') return codeAsked(input, deps.where);
  if (op === 'app') return appAsked(input, deps.appFeed);
  if (op === 'app_chunk') return appChunk(input, deps.appFeed);
  if (op === 'knowhow') {
    const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
    return { status: 200, body: { ok: true, ...storeFor(deps.where).missing(strings(input.ids), strings(input.hashes)) } };
  }
  if (op === 'offer') return offerAsked(board, pc, input, lang());
  if (op === 'unpair') return unpairAsked(board, pc);
  // The feed (feed.ts): what this board shows other boards, and word that the caller has news.
  if (op === 'state') {
    const {terminalState}=await import('./windows-terminal-presence.js');
    return {status:200,body:{ok:true,protocol:PEER_PROTOCOL,state:await terminalState(board,board.feedState?.()??null)}};
  }
  if (op === 'poke') {
    board.onPoke?.(pc);
    return { status: 200, body: { ok: true, protocol: PEER_PROTOCOL } };
  }
  if (op === 'feed') return { status: 200, body: { ok: true, protocol: PEER_PROTOCOL, ...feedSince(board, Number(input.after) || 0) } };
  const out = await handleBridge(board, {
    op, who: input.to, to: input.to, to_id: input.to_id, text: input.text, from,
    request_id: input.request_id, id: input.id, trust: level,
  }) as { ok?: boolean };
  if (out.ok !== false && ['send', 'task', 'ask'].includes(op)) {
    record(board, { dir: 'in', pc, agent: from.agent, op, to: str(input.to), text: str(input.text) });
  }
  const answer = { status: 200, body: { ...out, protocol: PEER_PROTOCOL } };
  if (key) {
    seen.set(key, answer);
    if (seen.size > 500) seen.delete(seen.keys().next().value!);
  }
  return answer;
}

// -- going out ------------------------------------------------------------------------------------

interface Node { DNSName?: string; HostName?: string }
let roster: { at: number; nodes: Node[] } | null = null;

/** The full tailnet name of a PC named short ("pc-b") or in full. */
export async function resolvePc(pc: string, status: () => Promise<string> = () => run(['status', '--json'])): Promise<string> {
  const wanted = bare(pc);
  if (wanted.includes('.')) return wanted;
  if (!roster || Date.now() - roster.at > 60_000) {
    const data = JSON.parse(await status()) as { Self?: Node; Peer?: Record<string, Node> };
    roster = { at: Date.now(), nodes: [data.Self ?? {}, ...Object.values(data.Peer ?? {})] };
  }
  const node = roster.nodes.find((n) => bare(str(n.DNSName)).split('.')[0] === wanted ||
    str(n.HostName).toLowerCase() === wanted);
  if (!node?.DNSName) throw new Error(`no PC named "${pc}" on this tailnet`);
  return bare(node.DNSName);
}

/** One direct request to a paired board. Transport errors and refusals are final. */
export async function callPeer(request: Record<string, unknown>, deps: { fetch?: typeof fetch; resolve?: (pc: string) => Promise<string> } = {}): Promise<string> {
  const op = str(request.op);
  if (!op.startsWith('agent_')) throw new Error('not a board operation');
  const device = await (deps.resolve ?? resolvePc)(str(request.pc));
  const envelope = { v: PEER_PROTOCOL, envelope: randomUUID(), op: op.slice(6), me: request.me,
    to: request.to, to_id: request.to_id, text: request.text, request_id: request.request_id,
    ...(request.id !== undefined ? { id: String(request.id) } : {}), sent_at: Date.now() };
  const res = await (deps.fetch ?? fetch)(`http://${device}:${PORT}${PEER_ROUTE}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(op === 'agent_ask' ? 45_000 : 15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${device} refused this (HTTP ${res.status}): ${str((JSON.parse(text) as { error?: unknown }).error) || text.slice(0, 300)}`);
  return JSON.stringify({ pc: device.split('.')[0], device, via: 'direct', ...JSON.parse(text) });
}

/** The board's way to another PC: callPeer, with each send, task and question noted in the feed. */
export function remoteFor(board: Board, call = callPeer): (request: Record<string, unknown>) => Promise<string> {
  return async (request) => {
    const op = str(request.op).replace(/^agent_/, '');
    const coordinated=board.activeTaskBetween({agent:str(request.me)},{agent:str(request.to),pc:str(request.pc)});
    if (op === 'send' && !/^card-[0-9a-f]{16}-\d+$/.test(str(request.request_id))) {
      board.checkLoop({ agent: str(request.me) }, { agent: str(request.to), pc: str(request.pc) });
    }
    const out = await call(request);
    let ok = true;
    try {
      ok = (JSON.parse(out) as { ok?: unknown }).ok !== false;
    } catch {
      /* an answer in words */
    }
    if (ok && ['send', 'task', 'ask'].includes(op)) {
      record(board, { dir: 'out', pc: str(request.pc), agent: str(request.me), op, to: str(request.to), text: str(request.text),
        ...(coordinated?{loopExempt:true}:{}),
        ...(/^card-[0-9a-f]{16}-\d+$/.test(str(request.request_id)) ? { person: true } : {}) });
    }
    return out;
  };
}

// -- the feed's source ----------------------------------------------------------------------------

export interface FeedEvent {
  seq: number;
  ts: number;
  dir: 'in' | 'out';
  /** The other PC. */
  pc: string;
  agent: string;
  op: string;
  to: string;
  text: string;
  /** A card answer is exempt from peer message-loop limits. */
  person?: boolean;
  loopExempt?: boolean;
}

const FEED_KEPT = 2000;
const FEED_DAYS = 30;

/** Note a cross-PC send, task or question in this board's append-only log. */
export function record(board: Board, e: Omit<FeedEvent, 'seq' | 'ts'>): void {
  const now = board.clock();
  board.feed.push({ ...e, text: e.text.slice(0, 300), seq: board.nextFeedSeq++, ts: now });
  board.feed = board.feed.filter((x) => now - x.ts < FEED_DAYS * 86_400_000).slice(-FEED_KEPT);
  board.save();
}

/** Events after a cursor, so another board can merge this one's log into its feed page. */
export function feedSince(board: Board, after: number): { events: FeedEvent[]; next: number } {
  const events = board.feed.filter((e) => e.seq > after).slice(0, 500);
  return { events, next: events.length ? events[events.length - 1]!.seq : after };
}
