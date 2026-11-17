import { continuationLimit } from './loop-limit.js';
/** Operation handlers shared by authenticated /peer and the local compatibility /bridge.
 * Remote senders never join this board and reach one named session per message. */
import type { Board, Session } from './board.js';
import * as os from 'node:os';
import * as path from 'node:path';
import { SENT_FILE, agentSays, cardStatus, closeCard, idempotency, makeCardOnce, waiting, type CardFile, type CardInput } from './cards.js';
import { askedReply } from './cards.js';
import { nativeApp } from './app-routes.js';
import { glance } from './glance.js';
import { canSteer, wakeBlocker, WAKE_FRESH_MS } from './wake.js';
import { taskBridge } from './tasks.js';

const TEXT_CHARS = 4000;
const REMEMBERED = 200;
// A tailnet node name, short or in full ("laptop.tail1234.ts.net"): the full name is what tells two tailnets' "laptop" apart.
const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
const PC = new RegExp(`^(?=.{1,253}$)${LABEL}(\\.${LABEL})*$`);
const AGENT = /^[\p{L}\p{N}_-]{1,40}$/u;

type Input = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Requests already answered, so a send that is retried after a lost reply is not queued twice. */
const answered = new WeakMap<Board, Map<string, object>>();

/** Only a session that is present, under exactly this name: a remote sender gets no fallback to a stale one. */
function present(board: Board, name: string): Session | undefined {
  const wanted = name.toLowerCase();
  return board.sessions.find((s) => board.isLive(s) && s.name.toLowerCase() === wanted);
}

/** How the message will come to its reader's attention. */
function reach(board: Board, s: Session): string {
  // D127: its turn waits on its human; nothing reaches the model before they answer.
  if (s.waitingOnHuman) {
    if (!canSteer(s, undefined, board.clock)) return 'waiting_on_human';
    return board.hasRoom() ? 'steering_into_running_turn' : 'waiting_for_resources';
  }
  if (s.state !== 'idle') return 'next_step';
  // No way to start a turn in it now: its human's next prompt brings the mail.
  if (wakeBlocker(s, undefined, board.clock)) return 'next_prompt';
  return board.hasRoom() ? 'waking' : 'waiting_for_resources';
}

/** The same, in words for the sender, with the reason when nothing can start a turn (D127). */
function reachDetail(board: Board, s: Session, how: string): string {
  const owed = s.waitingOnHuman?.kind === 'approval' ? 'an approval' : 'an answer to its question';
  switch (how) {
    case 'waking': return 'idle: kokuban is starting a turn to deliver it';
    case 'steering_into_running_turn': return `waiting on its human for ${owed}: kokuban steers this into its running ` +
      'turn, which reads it once its human answers; the question itself stays theirs';
    case 'waiting_on_human': return `waiting on its human for ${owed}: delivered when they answer`;
    case 'next_step': return 'working: it reads this at its next step';
    case 'waiting_for_resources': return 'queued until this PC has memory and processor to spare';
    case 'next_prompt': return `queued for its human's next prompt (${wakeBlocker(s, undefined, board.clock) ?? 'cannot be woken'})`;
    default: return how.replace(/_/g, ' ');
  }
}

/** Who is asking, as the authenticated transport established it: the sending PC and the session there. */
function asker(input: Input): { pc: string; agent: string } {
  const sender = (input.from && typeof input.from === 'object' ? input.from : {}) as Input;
  return { pc: (str(sender.pc) || str(input.source)).toLowerCase(), agent: str(sender.agent) || str(input.me) };
}

/** The named session, present, and the very one meant when its id is given: a name is reused once its holder leaves. */
function named(board: Board, input: Input, what: string): Session {
  const name = str(input.who) || str(input.to);
  const s = present(board, name);
  if (!s) throw new Error(`${what}: no session named "${name}" is present on this PC`);
  if (str(input.to_id) && str(input.to_id) !== s.id) {
    throw new Error(`${what}: "${s.name}" is now a different session from the one this was addressed to`);
  }
  return s;
}

function send(board: Board, input: Input): object {
  const from = asker(input);
  if (!PC.test(from.pc) || !AGENT.test(from.agent)) {
    throw new Error('send needs its source: from {pc, agent}, the tailnet name of the sending PC and the session name there');
  }
  const to = str(input.to);
  if (!to || to.includes(',') || ['all', 'everyone'].includes(to.toLowerCase())) {
    throw new Error('send reaches exactly one session, by name; there are no broadcasts between PCs');
  }
  const text = str(input.text);
  if (!text) throw new Error('nothing sent: the text is empty');
  if (text.length > TEXT_CHARS) {
    throw new Error(`nothing sent: the text is ${text.length} characters, over the ${TEXT_CHARS} a message carries. ` +
      'Send the file to that PC and name its path.');
  }
  const target = named(board, { to, to_id: input.to_id }, 'nothing sent');

  const key = str(input.request_id) && `${from.pc}/${from.agent}/${str(input.request_id)}`;
  const seen = answered.get(board) ?? new Map<string, object>();
  answered.set(board, seen);
  if (key && seen.has(key)) return { ...seen.get(key), duplicate: true };

  // The answer to a card this board sent quotes the card's key, which only the two boards hold:
  // that, and coming from the PC the card went to, is what marks it as a person's own words.
  const cardKey = /^card-([0-9a-f]{16})-\d+$/.exec(str(input.request_id))?.[1];
  const short = (pc: string): string => pc.split('.')[0]!.toLowerCase();
  const person = Boolean(cardKey && board.asked.some((a) => a.key === cardKey && short(a.pc) === short(from.pc)));
  // "work" trust (peer.ts): this PC's human lets that PC's agents hand work over as their own.
  const trust = str(input.trust) || undefined;
  const message = board.sendRemote(from, target, text, person, trust);
  board.usage?.({ ts: board.clock(), tool: 'bridge:send', me: message.from, to: target.name, chars: text.length });
  const how = reach(board, target);
  const out = {
    ok: true, id: message.id, state: 'queued',
    to: { name: target.name, id: target.id, status: board.status(target) }, reach: how, reach_detail: reachDetail(board, target, how),
  };
  if (key) {
    seen.set(key, out);
    if (seen.size > REMEMBERED) seen.delete(seen.keys().next().value!);
  }
  return out;
}

/** A question card from a session on another PC, for the person at this one: saved for the native app. */
async function ask(board: Board, input: Input): Promise<object> {
  const from = asker(input);
  if (!PC.test(from.pc) || !AGENT.test(from.agent)) {
    throw new Error('ask needs its source: from {pc, agent}, the tailnet name of the asking PC and the session name there');
  }
  let fields: CardInput;
  try {
    fields = JSON.parse(str(input.text)) as CardInput;
  } catch {
    throw new Error('ask carries its card as JSON in text: {question, details, choices, links, files, project, person}');
  }
  // A keyed ask always goes through its durable receipt (makeCardOnce), which checks its words; the old
  // in-memory request_id memory is only for asks without a key.
  const keyed = fields.idempotency_key !== undefined && fields.idempotency_key !== null;
  const key = !keyed && str(input.request_id) && `ask/${from.pc}/${from.agent}/${str(input.request_id)}`;
  const seen = answered.get(board) ?? new Map<string, object>();
  answered.set(board, seen);
  if (key && seen.has(key)) return { ...seen.get(key), duplicate: true };
  // Files came ahead by Taildrop into Downloads, under names only a card uses; nothing else there is ever served.
  const files: CardFile[] = (Array.isArray(fields.files) ? fields.files as Array<{ name?: unknown; sent?: unknown }> : [])
    .filter((f) => SENT_FILE.test(str(f?.sent)))
    .map((f) => ({ name: path.basename(str(f.name)) || str(f.sent), path: path.join(os.homedir(), 'Downloads', str(f.sent)) }));
  // With an idempotency key, a retry after a lost answer or a restart gets the same card, as it stands now.
  const { card, duplicate } = makeCardOnce(board, { pc: from.pc, agent: from.agent }, fields, files);
  if (duplicate) return { ...cardStatus(card), ...idempotency(card, true) };
  board.usage?.({ ts: board.clock(), tool: 'bridge:ask', me: `${from.agent}@${from.pc}`, chars: card.question.length });
  const shown = { shown: Boolean(nativeApp()) };
  const out = { ...askedReply(card, shown), ...idempotency(card, false) };
  if (key) {
    seen.set(key, out);
    if (seen.size > REMEMBERED) seen.delete(seen.keys().next().value!);
  }
  return out;
}

/**
 * What the asker does with a card it sent here, named in the request's text: {say} adds to the thread,
 * {withdraw} takes the question back, {presence} asks only whether someone is at this PC; nothing reads
 * where the card stands. Only the session that asked may touch a card; to anyone else it is unknown.
 */
async function card(board: Board, input: Input): Promise<object> {
  let does: { say?: unknown; headline?: unknown; files?: unknown; withdraw?: unknown; presence?: unknown } = {};
  try {
    does = JSON.parse(str(input.text) || '{}') as typeof does;
  } catch {
    /* no instruction: a status read */
  }
  if (does.presence) return { ok: true, app_running: Boolean(nativeApp()) };
  const from = asker(input);
  const found = board.cards.find((c) => c.id === Number(input.id) && c.from.pc === from.pc && c.from.agent === from.agent);
  if (!found) return cardStatus(undefined);
  if (typeof does.say === 'string') {
    if(does.files!==undefined&&(!Array.isArray(does.files)||does.files.some(f=>!SENT_FILE.test(str(f?.sent)))))throw new Error('Invalid follow-up attachment');
    const files:CardFile[]=(Array.isArray(does.files)?does.files:[]).map(f=>({name:path.basename(str(f.name))||str(f.sent),path:path.join(os.homedir(),'Downloads',str(f.sent))}));
    return agentSays(board,found,does.say,does.headline,files);
  }
  // 'unanswered' is the asker's session ending: an answer already given stays readable in its window.
  if (does.withdraw && (does.withdraw !== 'unanswered' || waiting(found))) closeCard(board, found, 'withdrawn');
  return cardStatus(found);
}

/** One authenticated request made for a session on another PC. */
export function handleBridge(board: Board, input: Input): object | Promise<object> {
  try {
    switch (str(input.op)) {
      case 'task': {
        const from = asker(input);
        if (!PC.test(from.pc) || !AGENT.test(from.agent)) throw new Error('Task needs a verified source device and agent');
        return taskBridge(board, input, from).catch((err: Error) => ({ ok: false, error: err.message }));
      }
      case 'ask':
        // The one request that waits (for the native app result); its own failures are answered like any other.
        return ask(board, input).catch((err: Error) => ({ ok: false, error: err.message }));
      case 'card':
        return card(board, input).catch((err: Error) => ({ ok: false, error: err.message }));
      case 'peers':
        // Each session's own summary line only: what its human typed stays on this PC unless glance is asked.
        return {
          ok: true,
          task_protocol: 1,
          sessions: board.sessions.filter((s) => board.isLive(s)).map((s) => ({
            name: s.name, id: s.id, host: s.host, state: s.state, status: board.status(s),
            doing: s.doing ?? '', where: s.where,
            work: s.work ?? 'unknown', next: s.next ?? '',
          })),
        };
      case 'glance': {
        const who = named(board, input, 'no glance');
        return { ok: true, name: who.name, id: who.id, text: glance(board, who) };
      }
      case 'send':
        return send(board, input);
      case 'receipt': {
        // queued = not yet shown to its reader; delivered = shown to it, which says nothing of what it did next.
        // Only its own sender may ask: to anyone else the message is unknown, like an id that never existed.
        const from = asker(input);
        const message = board.messages.find((m) => m.id === Number(input.id) &&
          m.remote?.pc === from.pc && m.remote.agent === from.agent);
        const target = message && board.sessions.find((s) => s.id === message.to);
        const reason = !message || message.delivered ? undefined
          : !target || !board.isLive(target) ? 'recipient_left'
          : target.work === 'paused' ? 'human_paused'
          : target.continues >= continuationLimit(board.clock()) ? 'continuation_limit'
          : board.clock() - message.ts >= WAKE_FRESH_MS ? 'wake_window_expired'
          : reach(board, target);
        return { ok: true, id: Number(input.id), state: !message ? 'unknown' : message.delivered ? 'delivered' : 'queued',
          ...(reason ? { reach: reason, reach_detail: target ? reachDetail(board, target, reason) : 'it left this PC' } : {}) };
      }
      default:
        throw new Error('op must be peers, glance, send, receipt, ask or card');
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
