/**
 * The feed: what waits on each person, what is running, and who works where, across every PC this
 * board is paired with (docs/cross-pc-v5.md, "The feed (B)").
 *
 *   items     made fresh from this board's own question cards and cross-PC tasks, never stored twice:
 *             a card waits on the person at the PC it was asked on, a task's outcome on the person
 *             whose agent asked for it
 *   peers     each paired board's items, sessions and running work, pulled with /peer op "state":
 *             at once when that board pokes this one, and every minute as a backstop
 *   marks     the person's Later and Seen, by thread (board.marks)
 *   view      everything the pill and the window show, for this PC's person (feedView)
 */
import * as os from 'node:os';
import type { Board, Session } from './board.js';
import { projectOf } from './git.js';
import { answerCard, answered, closeCard, currentChoice, personName, sweep, waiting, type Card } from './cards.js';
import { sessionItems } from './needs-you.js';
import { lang, post, readSettings } from './pair.js';
import { MAX_REPLIES, cancel, type WorkTask } from './tasks.js';

export type Kind = 'decide' | 'go' | 'blocked' | 'done';
export interface Choice { id: string; label: string }
export interface Item {
  thread: string;
  kind: Kind;
  /** Who it waits on. */
  person: string;
  /** Where the agent behind it is, and the board that holds it. */
  pc: string;
  board: string;
  agent: string;
  project: string;
  title: string;
  body: string;
  choices: Choice[];
  /** A reply box: the person can answer in words. */
  reply: boolean;
  ts: number;
  lang: 'en' | 'ja';
  steps: Array<{ text: string; ts: number }>;
  files: string[];
  links: string[];
  /** The asker's decision this item belongs to (cards.ts `group`): items with the same group are one decision put to several people. */
  group?: string;
  misaligned?: boolean;
}
export interface SessionLine {
  name: string; host: string; project: string; where: string; status: string; work: string;
  doing: string; next: string; holds: string[]; pc: string; person: string;
}
export interface Running { thread: string; from: string; to: string; title: string; detail: string; state: string; ts: number }
export interface HistoryLine { id: string; ts: number; kind: Kind | 'note'; text: string; pc: string }
export interface State { person: string; pc: string; items: Item[]; sessions: SessionLine[]; running: Running[]; history: HistoryLine[] }

const MINUTE = 60_000;
/** A blocked or unaccepted hand-off reaches the strip after this long. */
export const STUCK_MS = 30 * MINUTE;
export const LATER_MS = 2 * 60 * MINUTE;
const MARK_DAYS = 7;
const HISTORY = 60;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const short = (pc: string): string => pc.toLowerCase().split('.')[0]!;
export const self = (): string => os.hostname().toLowerCase();
const line = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1).replace(/\s+\S*$/, '')}…`;
};
/** The language this PC's person reads: settings.json "lang", or Windows' own when it is not set. */
export const readerLang = (): 'en' | 'ja' => {
  const set = lang();
  return set === 'ja' || (set === 'both' && Intl.DateTimeFormat().resolvedOptions().locale.startsWith('ja')) ? 'ja' : 'en';
};
const terminal = (t: WorkTask): boolean => t.state === 'done' || t.state === 'cancelled';
/** A hand-off this PC's agents asked another PC for: its outcome is this PC's person's to see. */
const askedAway = (t: WorkTask): boolean => Boolean(t.owner.pc) && !t.requester.pc;
const crossPc = (t: WorkTask): boolean => Boolean(t.owner.pc || t.requester.pc);

function cardItem(card: Card, person: string, here: string): Item {
  // Back because the agent spoke after the answer: show what it said, and let the person mark it
  // seen or change their mind; the choice that already stands is not offered again.
  const update = answered(card) && card.thread.at(-1)?.from === 'agent' ? card.thread.at(-1)!.text : '';
  const chose = currentChoice(card);
  const said = !update ? '' : !chose ? update
    : card.lang === 'ja' ? `回答済み:「${chose}」。${update}` : `You answered “${chose}”. ${update}`;
  const picks = card.choices.map((label, i) => ({ id: `pick:${i}`, label }));
  return {
    thread: `card:${here}:${card.id}`, kind: 'decide', person, pc: short(card.from.pc ?? here), board: here,
    agent: card.from.agent, project: card.project, title: card.headline || card.question, body: said || card.details,
    choices: [{ id: 'close', label: card.lang === 'ja' ? 'この質問を閉じる' : 'Close prompt' },
      ...(update ? [{ id: 'seen', label: 'Seen' }, ...picks.filter((c) => c.label !== chose)] : picks)], reply: true, ts: card.thread.at(-1)?.ts ?? card.ts, lang: card.lang,
    steps: [...(card.headline?[{text:`${card.from.agent}: ${card.question}`,ts:card.ts}]:[]), ...(said && card.details ? [{ text: `${card.from.agent}: ${card.details}`, ts: card.ts }] : []),...card.thread.map((t) => ({ text: t.from === 'agent' ? `${card.from.agent}: ${t.headline&&t.headline!==t.text?'Headline: '+t.headline+'\n':''}${t.text}${t.files?.length?'\nAttached: '+t.files.map(f=>f.name).join(', '):''}` : `${person}: ${t.choice ?? t.text}`, ts: t.ts }))],
    files: card.files.map((f) => f.name),
    // Keep every URL available as an action as well as in the full text.
    links: [...new Set([...(card.links ?? []), ...[card.question, card.details, ...card.thread.map(t => t.text)].flatMap(text => text.match(/https?:\/\/[^\s<>"']+/gi) ?? [])])],
    ...(card.group ? { group: card.group } : {}), ...(card.misaligned ? { misaligned: true } : {}),
  };
}

function taskItem(t: WorkTask, kind: Kind, body: string, person: string, here: string): Item {
  return {
    thread: `task:${t.id}`, kind, person, pc: short(t.owner.pc ?? here), board: here, agent: t.owner.name, project: '',
    title: t.text, body,
    choices: kind === 'done' ? [{ id: 'seen', label: 'Seen' }] : [{ id: 'cancel', label: 'Cancel task' }],
    reply: kind !== 'done', ts: t.updated, lang: 'en',
    // What this PC's person replied, in full, among the task's own steps in time order.
    steps: [
      { text: `${t.requester.name} asked ${t.owner.name}`, ts: t.created },
      { text: `${t.state}${t.detail ? `: ${t.detail}` : ''}`, ts: t.updated },
      ...(t.replies ?? []).map((r) => ({ text: `${r.person}: ${r.text}`, ts: r.ts })),
    ].sort((a, b) => a.ts - b.ts),
    files: [], links: [],
  };
}

/** What waits on this PC's person, from this board alone: cards asked here, hand-offs its agents sent away, and sessions that wait on them (needs-you.ts). */
export function localItems(board: Board): Item[] {
  sweep(board);
  const now = board.clock();
  const person = personName();
  const here = self();
  const items = board.cards.filter(c => waiting(c) || (!c.closed && c.thread.at(-1)?.from === 'agent')).map((c) => cardItem(c, person, here));
  for (const t of board.workTasks.filter(askedAway)) {
    if (t.state === 'blocked' && now - t.updated >= STUCK_MS) items.push(taskItem(t, 'blocked', t.detail, person, here));
    else if (t.state === 'requested' && now - t.created >= STUCK_MS) {
      const min = Math.round((now - t.created) / MINUTE);
      items.push(taskItem(t, 'blocked', readerLang() === 'ja' ? `${min}分間、受け取られていません。` : `Not picked up for ${min} min.`, person, here));
    } else if (t.state === 'done' && !board.marks.seen[`task:${t.id}`]) items.push(taskItem(t, 'done', t.detail, person, here));
  }
  items.push(...sessionItems(board, { person, here, lang: readerLang() }));
  return items.sort((a, b) => b.ts - a.ts);
}

export function sessionLines(board: Board): SessionLine[] {
  const person = personName();
  const here = self();
  return board.sessions.filter((s) => board.isLive(s)).map((s: Session) => ({
    name: s.name, host: s.host, project: s.project ?? projectOf(s.cwd), where: s.where, status: board.status(s),
    work: s.work ?? '', doing: board.summary(s), next: s.next ?? '',
    holds: board.claims.filter((c) => c.by === s.id).map((c) => c.what), pc: here, person,
  }));
}

function running(board: Board): Running[] {
  return board.workTasks.filter((t) => crossPc(t) && !terminal(t) && t.state !== 'blocked').map((t) => ({
    thread: `task:${t.id}`, from: `${t.requester.name}@${short(t.requester.pc ?? self())}`, to: `${t.owner.name}@${short(t.owner.pc ?? self())}`,
    title: line(t.text, 120), detail: line(t.detail, 200), state: t.state, ts: t.updated,
  }));
}

function history(board: Board): HistoryLine[] {
  const here = self();
  const person = personName();
  const out: HistoryLine[] = [];
  for (const c of board.cards) {
    if (c.closed) out.push({ id: `card:${here}:${c.id}:closed`, ts: c.closedAt ?? c.thread.at(-1)?.ts ?? c.ts,
      kind: 'note', text: `${c.from.agent}: ${line(c.headline || c.question, 80)} (${c.closed})`, pc: here });
    out.push({ id: `card:${here}:${c.id}:asked`, ts: c.ts, kind: 'decide', text: `${c.from.agent} asked ${person}: ${line(c.question, 100)}`, pc: here });
    const answer = c.thread.find((t) => t.from === 'person');
    if (answer) {
      out.push({ id: `card:${here}:${c.id}:answered`, ts: answer.ts, kind: 'note',
        text: `${person} answered ${c.from.agent}: ${line(currentChoice(c) || answer.text, 80)}`, pc: here });
    }
  }
  for (const t of board.workTasks.filter(crossPc)) {
    out.push({ id: `task:${t.id}:${t.revision}`, ts: t.updated, kind: t.state === 'done' ? 'done' : t.state === 'blocked' ? 'blocked' : 'go',
      text: `${t.requester.name} → ${t.owner.name}: ${line(t.text, 80)} (${t.state})`, pc: here });
  }
  for (const e of board.feed.filter((x) => x.op === 'send' || x.op === 'pair' || x.op === 'unpair')) {
    out.push({ id: `feed:${here}:${e.seq}`, ts: e.ts, kind: 'note',
      text: e.op === 'send' ? `${e.dir === 'in' ? `${e.agent}@${short(e.pc)} → ${e.to}` : `${e.agent} → ${e.to}@${short(e.pc)}`}: ${line(e.text, 80)}`
        : `${short(e.pc)}: ${e.text}`, pc: here });
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, HISTORY);
}

/** This board's part of the feed, as another board pulls it. */
export function stateFor(board: Board): State {
  return { person: personName(), pc: self(), items: localItems(board), sessions: sessionLines(board), running: running(board), history: history(board) };
}

// -- other boards ---------------------------------------------------------------------------------

export interface PeerSeen { pc: string; ok: boolean; ms: number | null; at: number; error?: string; state?: State }
type Post = (pc: string, body: Record<string, unknown>, timeout: number) => Promise<Record<string, unknown>>;
const viaPeer: Post = (pc, body, timeout) => post(pc, body, {}, timeout);

/**
 * `mirrors`: trusted names that answered as this board itself (an alias of this PC), never pulled or poked again.
 * `sent`: what the last poke told other boards, as signatures of what waits on people and of who is working.
 */
interface Live {
  peers: Map<string, PeerSeen>; mirrors: Set<string>; sent: { urgent: string; ambient: string }; pokedAt: number;
  timer: NodeJS.Timeout | null; ambient: NodeJS.Timeout | null; listeners: Set<() => void>; call: Post;
}
const live = new WeakMap<Board, Live>();
function of(board: Board): Live {
  let l = live.get(board);
  if (!l) live.set(board, l = { peers: new Map(), mirrors: new Set(), sent: { urgent: '', ambient: '' }, pokedAt: 0, timer: null, ambient: null,
    listeners: new Set(), call: viaPeer });
  return l;
}

/** The PCs whose boards share the feed with this one: everything in the trust list. */
export function feedPcs(): string[] {
  return Object.keys(readSettings().trust ?? {}).map((pc) => pc.toLowerCase().replace(/\.$/, ''));
}

/** Use another way to reach boards: tests. */
export function usePost(board: Board, call: Post): void {
  of(board).call = call;
}

/** Fetch one paired board's state. A board that does not answer keeps what it last said, marked stale. */
export async function pull(board: Board, pc: string): Promise<void> {
  const l = of(board);
  const start = Date.now();
  const key = short(pc);
  if (l.mirrors.has(key)) return;
  const had = l.peers.get(key);
  try {
    const out = await l.call(pc, { op: 'state' }, 5000);
    const state = out.state as State | undefined;
    if (!state || !Array.isArray(state.items)) throw new Error('its board has no feed yet (an older kokuban)');
    if (short(state.pc) === short(self())) {
      l.mirrors.add(key);
      l.peers.delete(key);
      return;
    }
    l.peers.set(key, { pc: key, ok: true, ms: Date.now() - start, at: board.clock(), state });
  } catch (err) {
    const why = /unknown op/.test((err as Error).message) ? 'an older kokuban: run kokuban update there' : (err as Error).message.slice(0, 160);
    l.peers.set(key, { pc: key, ok: false, ms: null, at: had?.at ?? 0, error: why, ...(had?.state ? { state: had.state } : {}) });
  }
  for (const listen of l.listeners) listen();
}

export async function pullAll(board: Board, pcs: string[] = feedPcs()): Promise<void> {
  await Promise.all(others(board, pcs).map((pc) => pull(board, pc)));
}

/** The paired boards that are really elsewhere: pulling or poking this board's own alias is traffic for nothing. */
function others(board: Board, pcs: string[]): string[] {
  const { mirrors } = of(board);
  return pcs.filter((pc) => !mirrors.has(short(pc)));
}

/** Who is working on what changes with every step; other boards hear of that at most this often. */
export const AMBIENT_MS = 30_000;

/** What other boards see, split by how soon they need it: what waits on a person, and who is working. */
function signatures(board: Board): { urgent: string; ambient: string } {
  const s = stateFor(board);
  return { urgent: JSON.stringify([s.items, s.running]),
    ambient: JSON.stringify(s.sessions.map((x) => [x.name, x.project, x.status, x.work, x.doing])) };
}

function poke(board: Board, pcs: () => string[]): void {
  const l = of(board);
  l.sent = signatures(board);
  l.pokedAt = Date.now();
  for (const pc of others(board, pcs())) void l.call(pc, { op: 'poke' }, 3000).catch(() => {});
}

/**
 * Something on this board changed. What waits on a person pokes other boards at once, so they pull it;
 * a change in who is working only waits for the next poke, at most AMBIENT_MS away. The app windows here
 * are told either way. Called often (every save), so it waits a moment and does the work once.
 */
export function changed(board: Board, pcs: () => string[] = feedPcs, ambientMs = AMBIENT_MS): void {
  const l = of(board);
  if (l.timer) return;
  l.timer = setTimeout(() => {
    l.timer = null;
    const now = signatures(board);
    if (now.urgent !== l.sent.urgent || (now.ambient !== l.sent.ambient && Date.now() - l.pokedAt >= ambientMs)) {
      if (l.ambient) clearTimeout(l.ambient);
      l.ambient = null;
      poke(board, pcs);
    } else if (now.ambient !== l.sent.ambient && !l.ambient) {
      l.ambient = setTimeout(() => {
        l.ambient = null;
        if (signatures(board).ambient !== l.sent.ambient) poke(board, pcs);
      }, l.pokedAt + ambientMs - Date.now());
      l.ambient.unref?.();
    }
    for (const listen of l.listeners) listen();
  }, 800);
  l.timer.unref?.();
}

/** Be told whenever the view may have changed (the app's event stream). */
export function listen(board: Board, fn: () => void): () => void {
  const l = of(board);
  l.listeners.add(fn);
  return () => l.listeners.delete(fn);
}

// -- the view -------------------------------------------------------------------------------------

export interface View {
  me: string;
  pc: string;
  mine: Item[];
  later: Array<Item & { until: number }>;
  theirs: Array<{ person: string; items: Item[] }>;
  running: Running[];
  projects: Array<{ project: string; sessions: SessionLine[] }>;
  pcs: Array<{ pc: string; person: string; ok: boolean; ms: number | null; at: number; error?: string }>;
  history: HistoryLine[];
}

export function feedView(board: Board): View {
  const now = board.clock();
  const me = personName();
  const here = self();
  // A tailnet alias can point back to this board (or to another paired alias).
  // Use the board's reported identity, keeping local state authoritative.
  const seenPcs = new Set([short(here)]);
  const peers = [...of(board).peers.values()].sort((a, b) => Number(b.ok) - Number(a.ok)).filter((p) => {
    const identity = short(p.state?.pc || p.pc);
    if (seenPcs.has(identity)) return false;
    seenPcs.add(identity);
    return true;
  });
  const states = [stateFor(board), ...peers.filter((p) => p.state).map((p) => p.state!)];
  const all = new Map<string, Item>();
  for (const s of states) for (const i of s.items) if (!all.has(i.thread)) all.set(i.thread, i);
  // Clearing a shared item is local to this reader; never answer another person's
  // question or change their task. A newer update to the thread is visible again.
  const items = [...all.values()].filter((i) => (board.marks.seen[i.thread] ?? -1) < i.ts);
  const isMine = (i: Item): boolean => i.person.toLowerCase() === me.toLowerCase();
  const until = (i: Item): number => board.marks.later[i.thread] ?? 0;
  const mine = items.filter((i) => isMine(i) && until(i) <= now);
  const later = items.filter((i) => isMine(i) && until(i) > now).map((i) => ({ ...i, until: until(i) }));
  const theirs = new Map<string, Item[]>();
  for (const i of items.filter((x) => !isMine(x))) theirs.set(i.person, [...(theirs.get(i.person) ?? []), i]);
  const runningAll = new Map<string, Running>();
  for (const s of states) for (const r of s.running) runningAll.set(r.thread, r);
  const projects = new Map<string, SessionLine[]>();
  for (const s of states) for (const x of s.sessions) projects.set(x.project || '(no project)', [...(projects.get(x.project || '(no project)') ?? []), x]);
  const hist = new Map<string, HistoryLine>();
  for (const s of states) for (const h of s.history) hist.set(h.id, h);
  const order: Record<Kind, number> = { decide: 0, blocked: 1, go: 2, done: 3 };
  return {
    me, pc: here,
    mine: mine.sort((a, b) => order[a.kind] - order[b.kind] || b.ts - a.ts),
    later,
    theirs: [...theirs].map(([person, list]) => ({ person, items: list.sort((a, b) => b.ts - a.ts) })),
    running: [...runningAll.values()].sort((a, b) => b.ts - a.ts),
    projects: [...projects].map(([project, sessions]) => ({ project, sessions }))
      .sort((a, b) => b.sessions.length - a.sessions.length || a.project.localeCompare(b.project)),
    pcs: [{ pc: here, person: me, ok: true, ms: 0, at: now }, ...peers.map((p) => ({ pc: p.pc, person: p.state?.person ?? '', ok: p.ok, ms: p.ms, at: p.at, ...(p.error ? { error: p.error } : {}) }))],
    history: [...hist.values()].sort((a, b) => b.ts - a.ts).slice(0, HISTORY),
  };
}

// -- what the person does -------------------------------------------------------------------------

function prune(board: Board): void {
  const old = board.clock() - MARK_DAYS * 86_400_000;
  // Seen is durable: pruning it would resurrect old shared notifications.
  for (const [k, at] of Object.entries(board.marks.later)) if (at < old) delete board.marks.later[k];
}

/**
 * The person acted on an item in the pill or the window: a choice (`pick:<n>`, `cancel`, `seen`),
 * words (`reply`), or `later`. Throws with a sentence to show them.
 */
export async function act(board: Board, thread: string, action: string, text = ''): Promise<string> {
  prune(board);
  const now = board.clock();
  if (action === 'later') {
    board.marks.later[thread] = now + LATER_MS;
    board.save();
    return 'later';
  }
  if (action === 'seen') {
    board.marks.seen[thread] = now;
    delete board.marks.later[thread];
    board.save();
    return 'seen';
  }
  const card = /^card:([^:]+):(\d+)$/.exec(thread);
  if (card) {
    if (card[1] !== self()) throw new Error(`This question is on ${card[1]}: answer it there.`);
    const c = board.cards.find((x) => x.id === Number(card[2]));
    if (!c) throw new Error('This question is gone.');
    if (action === 'close') {
      delete board.marks.later[thread];
      closeCard(board, c, 'dismissed');
      return 'closed';
    }
    const pick = /^pick:(\d+)$/.exec(action)?.[1] ?? '';
    if (!pick && action !== 'reply') throw new Error(`Unknown action "${action}".`);
    delete board.marks.later[thread];
    return answerCard(board, c, pick, text);
  }
  const task = /^task:(.+)$/.exec(thread);
  const t = task && board.workTasks.find((x) => x.id === task[1]);
  if (!t) throw new Error('This hand-off is not on this PC.');
  const me = personName();
  if (action === 'cancel') {
    cancel(board, t, `Cancelled by ${me} from the feed.`);
    delete board.marks.later[thread];
    return 'cancelled';
  }
  if (action === 'reply') {
    const words = text.trim().slice(0, 4000);
    if (!words) throw new Error('Type something first.');
    if (!t.owner.pc) throw new Error('This hand-off stayed on this PC.');
    if (!board.remote) throw new Error('This board cannot reach another PC.');
    const out = JSON.parse(await board.remote({
      op: 'agent_send', pc: t.owner.pc, me: me.replace(/[^\p{L}\p{N}_-]/gu, '') || 'person', to: t.owner.name, explicit: true,
      text: `${me}, about task ${t.id} ("${line(t.text, 80)}"), from the kokuban feed: ${words}`,
    })) as { ok?: boolean; error?: string };
    if (out.ok === false) throw new Error(out.error ?? 'not delivered');
    // Kept only once delivered: a refused reply is never shown as sent.
    t.replies = [...(t.replies ?? []), { text: words, person: me, ts: board.clock() }].slice(-MAX_REPLIES);
    delete board.marks.later[thread];
    board.save();
    return `sent to ${t.owner.name}`;
  }
  throw new Error(`Unknown action "${action}".`);
}
