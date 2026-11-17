/**
 * Pairing: two PCs agree to trust each other with one command on one of them and one click on the
 * other, instead of hand-written trust lists and `tailscale serve` lines (docs/cross-pc-v5.md).
 *
 *   asking     `kokuban pair <pc>`: this board exposes its own /peer and asks the other board
 *              (/peer op "pair"). Running the command is this side's consent.
 *   deciding   the other board puts a card in front of its person: Allow or Refuse.
 *   closing    on Allow it trusts the asker and says so (/peer op "paired"); the asker, finding the
 *              pairing it started under that id, trusts back. Either way the asker hears the answer.
 *   looking    `kokuban pair` alone: every PC in the trust list, whether it answers, how fast,
 *              which kokuban it runs and whether it trusts this PC back.
 *   ending     `kokuban unpair <pc>`: both sides drop each other.
 *
 * "pair" and "paired" are the two requests a PC outside the trust list may make: the first only
 * puts a card in front of a person (one open per PC, none for an hour after a refusal), the second
 * is taken only with the id of a pairing this board started with that very PC.
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appHello } from './app-update.js';
import type { Board } from './board.js';
import { closeCard, makeCard, personName, SETTINGS, type Card } from './cards.js';
import { PORT } from './config.js';
import { ingressSecret, PEER_INGRESS, PEER_PROTOCOL, PEER_ROUTE, record, resolvePc, trustFor, type Trust } from './peer.js';
import { repoInfo, distributionRepoDir, type RepoName } from './update.js';

/** The card's sender: the board itself, not a session. */
export const PAIR_AGENT = 'kokuban';
const LEVELS: Trust[] = ['talk', 'share', 'work'];
const HOUR = 3_600_000;
/** An unanswered pairing is given up on with its card. */
const PAIR_EXPIRE_MS = 12 * HOUR;
const REFUSED_PAUSE_MS = HOUR;
const KEPT = 50;

export interface Pairing {
  /** Made by the asking board; the answer must carry it. */
  id: string;
  /** The other PC, by full tailnet name. */
  pc: string;
  /** out: this board asked; in: the other PC asked this one. */
  dir: 'in' | 'out';
  level: Trust;
  /** The other PC's person, as it names them. */
  person: string;
  /** asking: no answer yet. allowed: allowed here, the asker not yet told. */
  state: 'asking' | 'allowed' | 'paired' | 'refused' | 'expired';
  ts: number;
  cardId?: number;
}

export interface PairDeps {
  fetch?: typeof fetch;
  resolve?: (pc: string) => Promise<string>;
  /** Exposes this board's /peer on the tailnet; resolves to an error in words, or ''. */
  serve?: () => Promise<string>;
  /** This PC's full tailnet name. */
  self?: () => Promise<string>;
  /** Sends kokuban by Taildrop to a PC without it; resolves to whether that worked. */
  sendKokuban?: (pc: string) => Promise<boolean>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const bare = (name: string): string => name.toLowerCase().replace(/\.$/, '');
const short = (pc: string): string => pc.split('.')[0]!;
const isLevel = (v: unknown): v is Trust => LEVELS.includes(v as Trust);

// -- settings.json --------------------------------------------------------------------------------

type Settings = Record<string, unknown> & { trust?: Record<string, unknown>; people?: Record<string, string[]>; lang?: string };

export function readSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS.file, 'utf8')) as Settings;
  } catch {
    return {};
  }
}

/** Changes settings.json in place, keeping everything else in it. */
function editSettings(change: (s: Settings) => void): void {
  const s = readSettings();
  change(s);
  fs.mkdirSync(path.dirname(SETTINGS.file), { recursive: true });
  fs.writeFileSync(`${SETTINGS.file}.tmp`, `${JSON.stringify(s, null, 2)}\n`);
  fs.renameSync(`${SETTINGS.file}.tmp`, SETTINGS.file);
}

/** Trust a PC at a level, and note whose it is so `ask` and hand-offs to that person find it. */
export function grant(pc: string, level: Trust, person: string): void {
  editSettings((s) => {
    const trust = { ...(s.trust ?? {}) };
    for (const k of Object.keys(trust)) if (bare(k) === bare(pc)) delete trust[k];
    trust[bare(pc)] = level;
    s.trust = trust;
    if (!person) return;
    const people = { ...(s.people ?? {}) };
    const key = Object.keys(people).find((k) => k.toLowerCase() === person.toLowerCase()) ?? person;
    const pcs = Array.isArray(people[key]) ? people[key]! : [];
    if (!pcs.some((p) => bare(p).split('.')[0] === short(bare(pc)))) people[key] = [...pcs, short(bare(pc))];
    s.people = people;
  });
}

/** Stop trusting a PC. Its place in `people` stays: it is still that person's PC. */
export function revoke(pc: string): void {
  editSettings((s) => {
    const trust = { ...(s.trust ?? {}) };
    for (const k of Object.keys(trust)) if (bare(k) === bare(pc)) delete trust[k];
    s.trust = trust;
  });
}

/** The language this PC's cards speak: settings.json "lang", else both. */
export const lang = (): 'ja' | 'en' | 'both' => {
  const l = str(readSettings().lang);
  return l === 'ja' || l === 'en' ? l : 'both';
};

// -- this PC --------------------------------------------------------------------------------------

function tailscale(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tailscale', args, { windowsHide: true, timeout: 15_000, maxBuffer: 4 << 20 }, (err, out, errOut) =>
      err ? reject(new Error(str(errOut) || err.message)) : resolve(out));
  });
}

/** This PC's private /peer ingress value (peer.ts PEER_INGRESS), made once and kept in settings.json. */
export function ensureIngressSecret(): string {
  const have = ingressSecret();
  if (have) return have;
  const made = randomBytes(32).toString('hex');
  editSettings((s) => { s.peerIngress = made; });
  return made;
}

/** Serve's target for /peer: the board's private ingress path, never plain /peer. */
const peerTarget = (secret: string): string => `http://127.0.0.1:${PORT}${PEER_INGRESS}${secret}`;

/**
 * Exposes only /peer to the tailnet; everything else stays on 127.0.0.1. Tailnet callers still use
 * /peer; Serve forwards it to the private ingress path. Running it twice changes nothing.
 */
export async function serveTailnet(run: (args: string[]) => Promise<string> = tailscale): Promise<string> {
  try {
    await run(['serve', '--bg', `--http=${PORT}`, '--set-path', PEER_ROUTE, peerTarget(ensureIngressSecret())]);
    return '';
  } catch (err) {
    return `tailscale serve failed: ${(err as Error).message.slice(0, 300)}`;
  }
}

/**
 * At startup: a PC that already exposes /peer has its Serve entry pointed at the private ingress.
 * A PC that never exposed /peer is left alone, and no other Serve route is touched.
 * Resolves to an error in words, or ''.
 */
export async function repairPeerServe(run: (args: string[]) => Promise<string> = tailscale): Promise<string> {
  let web: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>;
  try {
    web = (JSON.parse(await run(['serve', 'status', '--json'])) as { Web?: typeof web }).Web ?? {};
  } catch (err) {
    return `tailscale serve status failed: ${(err as Error).message.slice(0, 300)}`;
  }
  const mounts = Object.entries(web).filter(([host]) => host.endsWith(`:${PORT}`))
    .map(([, w]) => w?.Handlers?.[PEER_ROUTE]).filter((h) => h !== undefined);
  if (!mounts.length) return '';
  const secret = ingressSecret();
  if (secret && mounts.every((h) => h?.Proxy === peerTarget(secret))) return '';
  return serveTailnet(run);
}

let selfName = '';
async function selfPc(): Promise<string> {
  if (!selfName) {
    const data = JSON.parse(await tailscale(['status', '--json'])) as { Self?: { DNSName?: string } };
    selfName = bare(str(data.Self?.DNSName));
  }
  return selfName;
}

let built: string | null = null;
/** The kokuban commit this board runs: what `kokuban pair` compares across PCs. */
export function version(): string {
  if (built === null) {
    try {
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
      built = execFileSync('git', ['-C', root, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
    } catch {
      built = '';
    }
  }
  return built;
}

// -- talking to the other board -------------------------------------------------------------------

class Answered extends Error {}

export async function post(pc: string, body: Record<string, unknown>, deps: PairDeps, timeout = 15_000): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`http://${pc}:${PORT}${PEER_ROUTE}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: PEER_PROTOCOL, ...body }), signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    // A timeout or a refused connection: the PC is off, asleep, or has no kokuban /peer on the tailnet.
    const why = (err as Error).name === 'TimeoutError' || /abort|timeout/i.test((err as Error).message)
      ? 'no answer in time: off, asleep, or no kokuban /peer there' : (err as Error).message.slice(0, 120);
    throw new Error(`${short(pc)} did not answer (${why})`);
  }
  const text = await res.text();
  let out: Record<string, unknown>;
  try {
    out = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${short(pc)} answered HTTP ${res.status} without kokuban's JSON: its /peer is not a kokuban board, or one too old to pair`);
  }
  if (!res.ok || out.ok === false) throw new Answered(str(out.error) || `HTTP ${res.status}`);
  return out;
}

/** What to send the other PC's agent when it cannot be reached: it installs kokuban and asks back. */
export function invitation(self: string, sent = false): string {
  const get = sent
    ? 'kokuban.bundle has just arrived in this PC\'s Downloads folder by Taildrop. Install kokuban from it: ' +
      '`git clone -b main "%USERPROFILE%\\Downloads\\kokuban.bundle" "%USERPROFILE%\\githubprojects\\kokuban"`, then in that folder ' +
      '`git remote set-url origin https://github.com/52kokada/kokuban-agent-board.git`, `npm ci` and `node dist/src/cli.js install` (Node.js 20+ and Git needed; docs/setup.md)'
    : 'Install kokuban on this PC (https://github.com/52kokada/kokuban-agent-board, docs/setup.md "Fresh installation")';
  return `${get}, then run \`kokuban pair ${short(self)}\` and tell me when the person at ${short(self)} has allowed it. ` +
    `After that, \`kokuban update\` brings computeruse and every later update from ${short(self)}.`;
}

/** kokuban itself, sent by Taildrop to a PC that does not run it yet. False when that did not work. */
async function sendKokuban(pc: string): Promise<boolean> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-send-'));
  const file = path.join(dir, 'kokuban.bundle');
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    execFileSync('git', ['-C', root, 'bundle', 'create', file, 'main'], { windowsHide: true, timeout: 60_000, stdio: 'ignore' });
    await tailscale(['file', 'cp', file, `${pc}:`]);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// -- asking ---------------------------------------------------------------------------------------

/** `kokuban pair <pc>`: ask another PC to connect at a level, which this PC gives it once it says yes. */
export async function askPair(board: Board, target: string, level: Trust, deps: PairDeps = {}): Promise<object> {
  if (!isLevel(level)) throw new Error(`level must be talk, share or work, not "${level}"`);
  const pc = await (deps.resolve ?? resolvePc)(target);
  const self = await (deps.self ?? selfPc)();
  if (bare(pc) === bare(self)) throw new Error('that is this PC');
  const served = await (deps.serve ?? serveTailnet)();
  if (served) throw new Error(`${served}. This PC must expose /peer before another can answer it.`);
  const id = randomBytes(16).toString('hex');
  try {
    await post(pc, { op: 'pair', id, level, person: personName(), version: version() }, deps);
  } catch (err) {
    if (err instanceof Answered) throw new Error(`${short(pc)} said no: ${err.message}`);
    const sent = await (deps.sendKokuban ?? sendKokuban)(pc);
    throw new Error(`${(err as Error).message}. If kokuban is not set up there yet, send its agent this:\n\n${invitation(self, sent)}`);
  }
  for (const p of board.pairs.filter((x) => x.dir === 'out' && x.state === 'asking' && bare(x.pc) === bare(pc))) p.state = 'expired';
  board.pairs.push({ id, pc, dir: 'out', level, person: '', state: 'asking', ts: board.clock() });
  board.pairs = board.pairs.slice(-KEPT);
  board.save();
  return { ok: true, pc: short(pc), state: 'asking', id };
}

/** The pairing `id` names, as this board knows it now. */
export function pairState(board: Board, id: string): Pairing | undefined {
  return board.pairs.find((p) => p.id === id);
}

// -- deciding (the PC that was asked) -------------------------------------------------------------

function cardWords(person: string, from: string, level: Trust, l: 'ja' | 'en'): { question: string; details: string; choices: string[] } {
  const what = l === 'ja'
    ? { talk: 'セッション一覧を見て、メッセージを送れます（同僚からの依頼として扱われます）。',
        share: 'セッションの最近の作業を見て、ファイルや質問カードを送れます。作業を勝手に始めることはできません。',
        work: 'メッセージ、タスクの引き渡し、質問カードができ、そのタスクはこのPCの作業として自動で始まります。削除・デプロイ・支払い・公開は必ず先に確認します。' }[level]
    : { talk: 'Its agents can see the session list here and send messages, treated as a peer\'s requests.',
        share: 'Its agents can see recent steps here and send files and question cards, but cannot start work.',
        work: 'Its agents can message, hand over tasks and ask you questions here, and those tasks start as this PC\'s own work. Deleting, deploying, paying and publishing still ask first.' }[level];
  return l === 'ja'
    ? { question: `${person}さんのPC（${short(from)}）がこのPCとの接続を求めています。許可しますか？`,
        details: `レベル: ${level}。${what}\nあとから「kokuban unpair ${short(from)}」で解除できます。`, choices: ['許可する', '拒否する'] }
    : { question: `${person}'s PC (${short(from)}) wants to connect with this PC. Allow it?`,
        details: `Level: ${level}. ${what}\nUndo any time with "kokuban unpair ${short(from)}".`, choices: ['Allow', 'Refuse'] };
}

/** /peer op "pair" from a PC that may not be trusted yet: a card for this PC's person, nothing more. */
export function pairAsked(board: Board, from: string, input: Record<string, unknown>): { status: number; body: object } {
  const id = str(input.id);
  const level = input.level;
  if (!/^[0-9a-f]{32}$/.test(id) || !isLevel(level)) return { status: 400, body: { ok: false, error: 'a pairing needs an id and a level' } };
  const now = board.clock();
  const mine = board.pairs.filter((p) => p.dir === 'in' && bare(p.pc) === bare(from));
  if (mine.some((p) => p.state === 'refused' && now - p.ts < REFUSED_PAUSE_MS)) {
    return { status: 403, body: { ok: false, error: 'this PC\'s person refused a pairing from you within the hour; ask them directly first' } };
  }
  // One open question per PC: asking again replaces the earlier card.
  for (const p of mine.filter((x) => x.state === 'asking')) {
    p.state = 'expired';
    const old = board.cards.find((c) => c.id === p.cardId);
    if (old) closeCard(board, old, 'withdrawn');
  }
  const person = str(input.person).slice(0, 40) || short(from);
  const l = lang();
  const en = cardWords(person, from, level, 'en');
  const ja = cardWords(person, from, level, 'ja');
  const words = l === 'both'
    ? { question: `${en.question} / ${ja.question}`, details: `${en.details}\n\n${ja.details}`,
        choices: en.choices.map((c, i) => `${c} / ${ja.choices[i]}`) }
    : l === 'ja' ? ja : en;
  const card = makeCard(board, { agent: PAIR_AGENT, pc: from }, { ...words, person, lang: l === 'ja' ? 'ja' : 'en' });
  board.pairs.push({ id, pc: from, dir: 'in', level, person, state: 'asking', ts: now, cardId: card.id });
  board.pairs = board.pairs.slice(-KEPT);
  board.save();
  record(board, { dir: 'in', pc: from, agent: PAIR_AGENT, op: 'pair', to: '', text: `${person} asks to connect at ${level}` });
  return { status: 200, body: { ok: true, protocol: PEER_PROTOCOL, state: 'asking', card: card.id } };
}

/**
 * Tell the asker what this PC's person decided. unreachable: the sweep tries again. gone: the asker
 * no longer waits for this answer (it asked again, or gave up), so an Allow here is taken back.
 */
async function tellAsker(board: Board, p: Pairing, allow: boolean, deps: PairDeps): Promise<'told' | 'unreachable' | 'gone'> {
  try {
    await post(p.pc, { op: 'paired', id: p.id, allow, person: personName(), version: version() }, deps);
    return 'told';
  } catch (err) {
    if (!(err instanceof Answered)) return 'unreachable';
    if (allow) revoke(p.pc);
    p.state = 'expired';
    board.save();
    return 'gone';
  }
}

/** The person picked on a pairing card. Returns what the card's thread shows as the outcome. */
export async function pairDecided(board: Board, card: Card, choice: string, deps: PairDeps = {}): Promise<string> {
  const p = board.pairs.find((x) => x.dir === 'in' && x.cardId === card.id);
  const ja = card.lang === 'ja';
  if (!p) return ja ? 'この接続依頼は見つかりません。' : 'This pairing is no longer known here.';
  const index = card.choices.indexOf(choice);
  if (index < 0) return ja ? '「許可する」か「拒否する」を選んでください。' : 'Pick Allow or Refuse.';
  const allow = index === 0;
  if (allow) {
    grant(p.pc, p.level, p.person);
    await (deps.serve ?? serveTailnet)();
  } else if (p.state === 'paired' || p.state === 'allowed') {
    revoke(p.pc);
  }
  p.state = allow ? 'allowed' : 'refused';
  p.ts = board.clock();
  board.save();
  const told = await tellAsker(board, p, allow, deps);
  if (allow && told === 'told') p.state = 'paired';
  board.save();
  record(board, { dir: 'out', pc: p.pc, agent: PAIR_AGENT, op: 'pair', to: '', text: allow ? `allowed at ${p.level}` : 'refused' });
  const who = short(p.pc);
  if (!allow) return ja ? `${who} を拒否しました。` : `Refused ${who}.`;
  if (told === 'gone') {
    return ja ? `${who} はもうこの返事を待っていません。接続するには ${who} からもう一度依頼してください。`
      : `${who} no longer waits for this answer, so nothing was connected. Ask it to pair again.`;
  }
  return told === 'told'
    ? (ja ? `${who} と接続しました（${p.level}）。` : `Connected with ${who} (${p.level}).`)
    : (ja ? `許可しました。${who} に届き次第、接続が完了します。` : `Allowed. The connection completes as soon as ${who} can be reached.`);
}

// -- closing (the PC that asked) ------------------------------------------------------------------

/** /peer op "paired": the answer to a pairing this board started, from the PC it asked. */
export function pairAnswered(board: Board, from: string, input: Record<string, unknown>): { status: number; body: object } {
  const p = board.pairs.find((x) => x.dir === 'out' && x.id === str(input.id) && bare(x.pc) === bare(from));
  // refused too: the person there may change their answer to Allow.
  if (!p || p.state === 'expired' || p.state === 'allowed') {
    return { status: 403, body: { ok: false, error: 'no pairing with that id is waiting here' } };
  }
  const allow = input.allow === true;
  p.person = str(input.person).slice(0, 40);
  if (allow) grant(p.pc, p.level, p.person);
  else if (p.state === 'paired') revoke(p.pc);
  p.state = allow ? 'paired' : 'refused';
  p.ts = board.clock();
  board.save();
  record(board, { dir: 'in', pc: from, agent: PAIR_AGENT, op: 'pair', to: '', text: allow ? `${p.person || short(from)} allowed: connected at ${p.level}` : 'refused' });
  return { status: 200, body: { ok: true, protocol: PEER_PROTOCOL } };
}

/** The minute-by-minute look: tell askers that could not be reached, give up on old questions. */
export async function sweepPairs(board: Board, deps: PairDeps = {}): Promise<void> {
  const now = board.clock();
  for (const p of board.pairs) {
    if (p.state === 'asking' && now - p.ts > PAIR_EXPIRE_MS) {
      p.state = 'expired';
      const card = board.cards.find((c) => c.id === p.cardId);
      if (card) closeCard(board, card, 'expired');
      board.save();
    } else if (p.state === 'allowed' && p.dir === 'in') {
      if (now - p.ts > PAIR_EXPIRE_MS) p.state = 'expired';
      else if (await tellAsker(board, p, true, deps) === 'told') p.state = 'paired';
      board.save();
    }
  }
}

// -- ending ---------------------------------------------------------------------------------------

/** `kokuban unpair <pc>`: drop it here, and ask it to drop this PC too. */
export async function unpair(target: string, deps: PairDeps = {}): Promise<object> {
  const pc = await (deps.resolve ?? resolvePc)(target);
  const had = trustFor(pc) !== null;
  revoke(pc);
  let there: string;
  try {
    await post(pc, { op: 'unpair' }, deps);
    there = 'dropped this PC too';
  } catch (err) {
    there = `could not be told (${(err as Error).message.slice(0, 160)}); it may still list this PC`;
  }
  return { ok: true, pc: short(pc), here: had ? 'removed from this PC\'s trust list' : 'was not in this PC\'s trust list', there };
}

/** /peer op "unpair": a PC this one trusts no longer wants the connection. */
export function unpairAsked(board: Board, from: string): { status: number; body: object } {
  revoke(from);
  record(board, { dir: 'in', pc: from, agent: PAIR_AGENT, op: 'unpair', to: '', text: 'disconnected' });
  return { status: 200, body: { ok: true, protocol: PEER_PROTOCOL } };
}

// -- looking --------------------------------------------------------------------------------------

/** /peer op "hello": who is at this PC and which kokuban it runs. */
export const hello = async (where?: (name: RepoName) => string | null, appFeed?: string, appExe?: string): Promise<object> =>
  ({ ok: true, protocol: PEER_PROTOCOL, person: personName(), version: version(), repos: await repoInfo(where ?? distributionRepoDir), app: appHello(appFeed, appExe) });

export interface PcStatus { pc: string; trust: string; answers: boolean; ms: number | null; version: string; person: string; back: string }

/** One line per PC this one trusts, and per pairing still waiting: what `kokuban pair` prints. */
export async function pairStatus(board: Board, deps: PairDeps = {}): Promise<{ version: string; pcs: PcStatus[]; waiting: object[] }> {
  const trust = readSettings().trust ?? {};
  const pcs = await Promise.all(Object.entries(trust).map(async ([pc, entry]): Promise<PcStatus> => {
    const level = typeof entry === 'string' ? entry : str((entry as { level?: unknown })?.level);
    const start = Date.now();
    try {
      const out = await post(bare(pc), { op: 'hello' }, deps, 5000);
      return { pc: short(bare(pc)), trust: level, answers: true, ms: Date.now() - start, version: str(out.version),
        person: str(out.person), back: 'trusts this PC' };
    } catch (err) {
      const answered = err instanceof Answered;
      return { pc: short(bare(pc)), trust: level, answers: answered, ms: answered ? Date.now() - start : null, version: '', person: '',
        back: answered ? `refuses this PC: ${err.message.slice(0, 120)}` : (err as Error).message.slice(0, 160) };
    }
  }));
  const waiting = board.pairs.filter((p) => p.state === 'asking' || p.state === 'allowed')
    .map((p) => ({ pc: short(p.pc), dir: p.dir === 'out' ? 'asked by this PC' : 'asking this PC', state: p.state, since: new Date(p.ts).toISOString() }));
  return { version: version(), pcs, waiting };
}

/** The one-line form of pairStatus, for the terminal and the board page. */
export function statusLines(s: Awaited<ReturnType<typeof pairStatus>>): string[] {
  const lines = s.pcs.map((p) => {
    const ver = !p.version ? '' : p.version === s.version ? ', same kokuban' : `, kokuban ${p.version} (this PC: ${s.version || '?'})`;
    return p.answers && p.back === 'trusts this PC'
      ? `${p.pc}: ${p.trust}, answers in ${p.ms} ms${ver}${p.person ? `, ${p.person}'s` : ''}`
      : `${p.pc}: ${p.trust}, ${p.back}`;
  });
  for (const w of s.waiting as Array<{ pc: string; dir: string; state: string }>) {
    lines.push(`${w.pc}: ${w.state === 'allowed' ? 'allowed here, telling it' : `waiting for an answer (${w.dir})`}`);
  }
  return lines.length ? lines : [`No PCs paired yet. Connect one with: kokuban pair <pc> (this PC: ${os.hostname().toLowerCase()})`];
}
