/** Question cards in the native Kokuban app. The person's answers and agent follow-ups
 * stay in one thread; answers return to the asking session as framed mail. */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Board, Session } from './board.js';
import { DATA_DIR } from './config.js';

/** One thing said on a card after its question: by the person at this PC, or by the agent that asked. */
export interface Turn {
  /** Display headline established by this agent turn; the original question is unchanged. */
  headline?: string;
  /** Attachments appended by this follow-up, in card file index order. */
  files?: CardFile[];
  from: 'person' | 'agent';
  /** The choice picked, when the person pressed one. */
  choice?: string;
  text: string;
  ts: number;
  /** The person's side: how sending it to the asker went, in words. */
  delivery?: string;
}

export interface CardFile {
  /** The name the person sees. */
  name: string;
  /** Where it is on this PC. Only these paths are ever served. */
  path: string;
}

export interface Card {
  id: number;
  /** Made by the asking board: its answers quote it, so the asker knows a person's answer from an agent's mail. */
  key: string;
  /** The asking session; `pc` is set when it is on another PC. */
  from: { agent: string; pc?: string; sessionId?: string };
  /** The human the agent asks for, as the sender names them. */
  person: string;
  project: string;
  question: string;
  headline?: string;
  details: string;
  choices: string[];
  links: string[];
  files: CardFile[];
  /** The card's language; the card's own words are whatever the agent wrote. */
  lang: 'en' | 'ja';
  ts: number;
  thread: Turn[];
  /** No answer is wanted any more: the agent took it back, its session ended, or it waited too long. */
  closed?: 'withdrawn' | 'expired' | 'dismissed';
  closedAt?: number;
  /**
   * The asker's own decision this card belongs to, when one decision is put to several people (a card
   * each). It only links them: every card is still answered, read and expires on its own.
   */
  group?: string;
  /** The people asked disagree, as far as the asker knows: the card says so plainly to whoever reads it. */
  misaligned?: boolean;
  /** The asker's idempotency key, when it asked with one (makeCardOnce): a retry gets this card back. */
  idem?: string;
}

/**
 * One ask made with an idempotency key: which card it made, for which sender, from which words. Kept
 * on the board (so across restarts) for IDEM_MS; while it is kept, its card is kept too.
 */
export interface AskReceipt { sender: string; key: string; hash: string; card: number; at: number }

/** A card this board sent to another PC, remembered so its answers can be recognised and it can be taken back. */
export interface Asked { key: string; pc: string; id: number; sessionId: string }

export interface CardInput {
  question?: unknown; details?: unknown; choices?: unknown; links?: unknown; project?: unknown; person?: unknown;
  lang?: unknown; key?: unknown; files?: unknown; group?: unknown; misaligned?: unknown;
  /** The asker's own key for this ask, with when it first issued it (ms): see makeCardOnce. */
  idempotency_key?: unknown; issued_at?: unknown;
}

const QUESTION_CHARS = 300;
const DETAILS_CHARS = 4000;
const CHOICE_CHARS = 80;
const MAX_CHOICES = 4;
const MAX_LINKS = 6;
/** How long an idempotent ask is remembered, and its card kept: a retry within it finds the same card. */
export const IDEM_MS = 30 * 86_400_000;
/** A retry must be issued well inside that window, so a receipt is never pruned under a retry in flight. */
const IDEM_SAFE_MS = IDEM_MS - 86_400_000;
const IDEM_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
/** At most this many receipts are kept; past it, keyed asks are refused rather than forgetting live ones. */
export const MAX_RECEIPTS = 2000;
/** A decision id from the asker: short, and safe to show and to log. */
const GROUP = /^[A-Za-z0-9._:-]{1,64}$/;
export const MAX_FILES = 4;
/** Follow-ups append without replacing old file indices. */
export const MAX_CARD_FILES = 16;
export const FILE_BYTES = 25 * 1024 * 1024;
/** One sender cannot bury a person in cards: its unanswered cards are capped. */
const MAX_OPEN_PER_SENDER = 5;
const KEPT = 100;
const TURN_CHARS = 4000;
const MAX_TURNS = 60;
const MINUTE = 60_000;
export const EXPIRE_MS = 12 * 60 * MINUTE;
/** A file that came by Taildrop for a card: only names of this shape are served from Downloads. */
export const SENT_FILE = /^kokuban-[0-9a-f]{16}-\d\.[a-z0-9]{1,8}$/;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** Kana or kanji: written for a Japanese reader. */
export const JAPANESE = /[぀-ヿ㐀-鿿]/;

interface Settings { person?: string; people?: Record<string, string[]> }
/** Who sits at this PC and where the people it asks are: {"person": "Alex", "people": {"Sam": ["keeper-pc"]}}. */
export const SETTINGS = { file: path.join(DATA_DIR, 'settings.json') };
const settings = (): Settings => {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS.file, 'utf8')) as Settings;
  } catch {
    return {};
  }
};

let gitName: string | null = null;

/**
 * This PC's person, for "Question from ...": settings.json in the data folder ({"person": "..."}),
 * else the first name git signs commits with, else the account name ("jdoe" is not a name).
 */
export function personName(): string {
  const named = str(settings().person);
  if (named) return named.slice(0, 40);
  if (gitName === null) {
    try {
      gitName = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
        .trim().split(/\s+/)[0] ?? '';
    } catch {
      gitName = '';
    }
  }
  if (gitName) return gitName.slice(0, 40);
  const user = os.userInfo().username;
  return user.charAt(0).toUpperCase() + user.slice(1);
}

/** The PCs a named person uses, from settings.json ({"people": {"Sam": ["keeper-pc", "pc-b"]}}). */
export function pcsOf(name: string): { pcs: string[]; known: string[] } {
  const people = settings().people ?? {};
  const hit = Object.keys(people).find((k) => k.toLowerCase() === name.trim().toLowerCase());
  return { pcs: hit ? list(people[hit]) : [], known: Object.keys(people) };
}

export const answered = (card: Card): boolean => card.thread.some((t) => t.from === 'person');
/** Still waiting for its first answer. */
export const waiting = (card: Card): boolean => !card.closed && !answered(card);
/** Native app notification result; a queued card never claims somebody has seen it. */
export interface Shown { shown: boolean }
export function askedReply(card: Card, shown: Shown): Record<string, unknown> {
  return { ok: true, id: card.id, state: 'waiting', popup_shown: shown.shown,
    note: shown.shown ? 'The card is in the person\'s Kokuban app. Their answer arrives as mail; reply with op "say", and withdraw it when no longer needed.'
      : 'The card is saved, but the Kokuban app is not running there. Tell your human; do not count on a quick answer.' };
}
/** The choice that stands now: the latest one the person picked. */
export const currentChoice = (card: Card): string => [...card.thread].reverse().find((t) => t.choice)?.choice ?? '';
/** Check what an agent sent and make the card. Throws with a sentence the agent can act on. */
export function makeCard(board: Board, from: Card['from'], input: CardInput, files: CardFile[] = []): Card {
  const question = oneLine(str(input.question));
  if (!question) throw new Error('no card made: question is empty. Ask one thing, in one or two sentences.');
  if (question.length > QUESTION_CHARS) {
    throw new Error(`no card made: the question is ${question.length} characters, over ${QUESTION_CHARS}. ` +
      'Put the short question there and the rest in details.');
  }
  const details = str(input.details);
  if (details.length > DETAILS_CHARS) throw new Error(`no card made: details are over ${DETAILS_CHARS} characters`);
  const choices = list(input.choices).map(oneLine);
  if (choices.length > MAX_CHOICES) throw new Error(`no card made: at most ${MAX_CHOICES} choices; the person can also type an answer`);
  const long = choices.find((c) => c.length > CHOICE_CHARS);
  if (long) throw new Error(`no card made: the choice "${long.slice(0, 30)}…" is over ${CHOICE_CHARS} characters; explain it in details`);
  const links = list(input.links);
  if (links.length > MAX_LINKS) throw new Error(`no card made: at most ${MAX_LINKS} links`);
  const bad = links.find((l) => !/^https?:\/\/[^\s<>"']+$/i.test(l));
  if (bad) throw new Error(`no card made: "${bad.slice(0, 60)}" is not an http(s) link`);
  const sender = (c: Card): string => `${c.from.pc ?? ''}/${c.from.agent}`;
  const open = board.cards.filter((c) => waiting(c) && sender(c) === `${from.pc ?? ''}/${from.agent}`);
  if (open.length >= MAX_OPEN_PER_SENDER) {
    throw new Error(`no card made: ${open.length} of your cards are still unanswered there. Wait for those answers, or withdraw them.`);
  }
  // Given at all, it must be a real id: an empty or non-text group would quietly unlink a card from its decision.
  const group = input.group === undefined || input.group === null ? '' : typeof input.group === 'string' ? input.group.trim() : '\0';
  if ((input.group !== undefined && input.group !== null && !group) || (group && !GROUP.test(group))) {
    throw new Error('no card made: group is 1 to 64 letters, digits, ".", "_", ":" or "-"');
  }
  if (input.misaligned !== undefined && typeof input.misaligned !== 'boolean') throw new Error('no card made: misaligned is true or false');
  const key = str(input.key);
  const card: Card = {
    id: board.nextCardId++,
    key: /^[0-9a-f]{16}$/.test(key) ? key : randomBytes(8).toString('hex'), from,
    person: oneLine(str(input.person)).slice(0, 40), project: oneLine(str(input.project)).slice(0, 80),
    question, details, choices, links, files: files.slice(0, MAX_FILES), ts: board.clock(), thread: [],
    // Named by the agent, else read from what it wrote: a card with Japanese in it is for a Japanese reader.
    lang: str(input.lang) === 'ja' || (str(input.lang) !== 'en' && JAPANESE.test(question + choices.join(''))) ? 'ja' : 'en',
    ...(group ? { group } : {}), ...(input.misaligned === true ? { misaligned: true } : {}),
  };
  board.cards.push(card);
  if (board.cards.length > KEPT) {
    // The oldest go first, except a card an unexpired receipt points at: a retry must still find it.
    const kept = new Set(board.askReceipts.filter((r) => board.clock() - r.at < IDEM_MS).map((r) => r.card));
    let over = board.cards.length - KEPT;
    board.cards = board.cards.filter((c) => over <= 0 || kept.has(c.id) || c === card || !(over-- > 0));
  }
  board.save();
  return card;
}

const fingerprint = (input: CardInput): string => createHash('sha256').update(JSON.stringify([
  oneLine(str(input.question)), str(input.details), list(input.choices).map(oneLine), list(input.links),
  input.group === undefined || input.group === null ? '' : String(input.group).trim(), input.misaligned === true,
  oneLine(str(input.person)), str(input.lang),
])).digest('hex');

/**
 * makeCard, made safe to retry: with an idempotency_key (and the time the asker first issued it), a
 * second ask from the same sender with the same key gets the same card back, whatever has happened
 * to it since (answered, withdrawn, expired) and across restarts. Different words under the same key,
 * a key issued too long ago to be remembered, or a full receipt store are refused, never re-made. The
 * receipt and the card are on disk before this returns; if they cannot be saved, nothing was made.
 * Without a key it is makeCard, unchanged.
 */
export function makeCardOnce(board: Board, from: Card['from'], input: CardInput, files: CardFile[] = []): { card: Card; duplicate: boolean } {
  if (input.idempotency_key === undefined || input.idempotency_key === null) return { card: makeCard(board, from, input, files), duplicate: false };
  // A board that lost its snapshot may have forgotten this very key: refuse rather than make it twice.
  if (board.loadProblem) throw new Error(`no card made: this board's saved state is damaged, so it cannot honour idempotency_key (${board.loadProblem})`);
  const key = typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : '';
  if (!IDEM_KEY.test(key)) throw new Error('no card made: idempotency_key is 1 to 128 letters, digits, ".", "_", ":" or "-"');
  const now = board.clock();
  const issued = Number(input.issued_at);
  if (!Number.isFinite(issued) || issued <= 0) throw new Error('no card made: issued_at (ms since 1970, when you first issued this ask) is required with idempotency_key');
  if (issued > now + 86_400_000) throw new Error('no card made: issued_at is in the future');
  board.askReceipts = board.askReceipts.filter((r) => now - r.at < IDEM_MS);
  const sender = `${from.pc ?? 'local'}/${from.agent}`;
  const hash = fingerprint(input);
  const had = board.askReceipts.find((r) => r.sender === sender && r.key === key);
  if (had) {
    if (had.hash !== hash) throw new Error(`no card made: idempotency_key "${key}" was already used for a card with different words (#${had.card})`);
    const card = board.cards.find((c) => c.id === had.card);
    if (!card) throw new Error(`no card made: card #${had.card} for this key is no longer on this board; it is not made again`);
    return { card, duplicate: true };
  }
  if (now - issued > IDEM_SAFE_MS) throw new Error('no card made: issued_at is older than this board remembers asks; it is not made again');
  if (board.askReceipts.length >= MAX_RECEIPTS) throw new Error(`no card made: ${MAX_RECEIPTS} keyed asks are being remembered here; try again later`);
  const card = makeCard(board, from, input, files);
  card.idem = key;
  board.askReceipts.push({ sender, key, hash, card: card.id, at: now });
  if (!board.flush()) {
    board.askReceipts = board.askReceipts.filter((r) => !(r.sender === sender && r.key === key));
    board.cards = board.cards.filter((c) => c !== card);
    throw new Error('no card made: the board could not save it');
  }
  return { card, duplicate: false };
}

/** What an ask made with a key says about it: that the key is honoured here, and whether this was a retry. */
export const idempotency = (card: Card, duplicate: boolean): object =>
  card.idem ? { idempotency: { supported: 1, key: card.idem, duplicate } } : {};

const quoted = (card: Card): string =>
  `#${card.id} ("${card.question.length > 90 ? `${card.question.slice(0, 89)}…` : card.question}")`;

/** The mail the asking session gets for one turn: the person's own words, not an instruction from the board. */
export function turnText(card: Card, turn: Turn, first: boolean): string {
  const said = turn.text ? `${turn.choice ? '. They also wrote' : ': they wrote'}: "${turn.text}"` : '';
  return first
    ? `Answer to your question card ${quoted(card)}, given in the card's window${turn.choice ? `: chose "${turn.choice}"` : ''}${said}`
    : `Follow-up on your question card ${quoted(card)}, from the same person in the card's window` +
      `${turn.choice ? `: they changed their answer to "${turn.choice}"` : ''}${said}`;
}

/** Send one turn from the card's window to whoever asked; returns how that went, in words. */
async function deliver(board: Board, card: Card, text: string, n: number): Promise<string> {
  const me = personName().replace(/[^\p{L}\p{N}_-]/gu, '') || 'person';
  let delivery: string;
  try {
    if (card.from.pc) {
      if (!board.remote) throw new Error('this board cannot reach another PC');
      const reply = await board.remote({
        // The key in the request id is how the asking board knows this is a person's answer to its own card.
        op: 'agent_send', pc: card.from.pc, me, to: card.from.agent, explicit: true, text, request_id: `card-${card.key}-${n}`,
      });
      const parsed = JSON.parse(reply) as { ok?: boolean; error?: string };
      if (parsed.ok === false) throw new Error(parsed.error ?? 'refused');
      delivery = `sent to ${card.from.agent} on ${card.from.pc.split('.')[0]}`;
    } else {
      const target = board.sessions.find((s: Session) => s.id === card.from.sessionId && board.isLive(s));
      if (!target) throw new Error(`${card.from.agent} is no longer open`);
      board.sendFromPerson(me, target, text);
      delivery = `sent to ${card.from.agent}`;
    }
  } catch (err) {
    delivery = `saved, but not delivered: ${(err as Error).message.slice(0, 200)}`;
  }
  board.usage?.({ ts: board.clock(), tool: 'card:answer', me, to: card.from.agent, ok: delivery.startsWith('sent') });
  return delivery;
}

const say = (card: Card, en: string, ja: string): string => (card.lang === 'ja' ? ja : en);

/**
 * Record what the person sent from the card's window and pass it to whoever asked: the first time
 * it is the answer, after that a follow-up (a changed mind, something forgotten). It is kept on the
 * card whatever happens to the mail, so a sender that has gone can still be told later.
 */
export async function answerCard(board: Board, card: Card, pick: string, text: string): Promise<string> {
  sweep(board);
  if (card.closed) throw new Error(say(card, 'This question is closed.', 'この質問は終了しました。'));
  // No pick is not the first choice: Number('') is 0.
  const choice = /^\d+$/.test(pick) ? card.choices[Number(pick)] ?? '' : '';
  const words = text.trim().slice(0, TURN_CHARS);
  if (!choice && !words) {
    throw new Error(card.choices.length ? say(card, 'Pick a choice or type something first.', '選択肢を選ぶか、回答を入力してください。')
      : say(card, 'Type something first.', '回答を入力してください。'));
  }
  if (card.thread.length >= MAX_TURNS) {
    throw new Error(say(card, 'This thread is full. Ask the agent for a new question.', 'このスレッドはいっぱいです。エージェントに新しい質問を依頼してください。'));
  }
  if (choice && choice === currentChoice(card) && !words) {
    throw new Error(say(card, `“${choice}” is already your answer.`, `「${choice}」はすでに回答済みです。`));
  }
  const first = !answered(card);
  const turn: Turn = { from: 'person', text: words, ts: board.clock(), delivery: 'sending', ...(choice ? { choice } : {}) };
  card.thread.push(turn);
  board.save();
  // A pairing or update card is the board's own question: the pick is acted on here, not mailed to a session.
  const own = board.onOwnCard?.(card, choice);
  turn.delivery = own ? await own : await deliver(board, card, turnText(card, turn, first), card.thread.length);
  board.save();
  return turn.delivery;
}

/** The agent says more on its own card: an answer to a follow-up, a thank-you, a second question. */
export function agentSays(board: Board, card: Card, text: string, headline?: unknown, files:CardFile[]=[]): object {
  sweep(board);
  const words = text.trim().slice(0, TURN_CHARS);
  if (!words) throw new Error('nothing said: the text is empty');
  if (card.closed) throw new Error(`nothing said: card #${card.id} is ${card.closed}. Ask again with a new card.`);
  if (card.thread.length >= MAX_TURNS) throw new Error('nothing said: this thread is full; ask with a new card');
  if(headline!==undefined&&(typeof headline!=='string'||!headline.trim()||headline.trim().length>QUESTION_CHARS))throw new Error('headline must be a nonempty action line of at most 300 characters');
  if(files.length>MAX_FILES)throw new Error(`at most ${MAX_FILES} files per follow-up`);
  if(card.files.length+files.length>MAX_CARD_FILES)throw new Error(`at most ${MAX_CARD_FILES} total files per card`);
  for(const file of files){const stat=fs.statSync(file.path,{throwIfNoEntry:false});if(!stat?.isFile())throw new Error('Follow-up attachment is not a file');if(stat.size>FILE_BYTES)throw new Error('Follow-up attachment is over 25 MB');}
  const first=words.split(/(?<=[.!?])\s+|[\r\n]+/u)[0].replace(/\s+/g,' ').trim();
  const fallback=Array.from(first);const next=headline===undefined?(fallback.length>80?fallback.slice(0,79).join('')+'…':first):String(headline).trim().replace(/\s+/g,' ');
  card.headline=next;
  card.files.push(...files);
  card.thread.push({ from: 'agent', text: words, headline:next, ...(files.length?{files:files.map(f=>({...f}))}:{}), ts: board.clock() });
  board.save();
  return { ok: true, id: card.id, state: 'updated' };
}

/** No answer is wanted any more; retain the thread as closed history. */
export function closeCard(board: Board, card: Card, why: NonNullable<Card['closed']>): void {
  if (card.closed) return;
  card.closed = why;
  card.closedAt = board.clock();
  board.save();
}

/** What its sender may learn about a card later: where it stands and what was said. */
export function cardStatus(card: Card | undefined): object {
  if (!card) return { ok: true, state: 'unknown' };
  const said = card.thread.filter((t) => t.from === 'person');
  return {
    ok: true, id: card.id, state: card.closed ?? (said.length ? 'answered' : 'waiting'),
    ...(card.group ? { group: card.group } : {}), ...(card.misaligned ? { misaligned: true } : {}),
    ...(card.idem ? { idempotency: { supported: 1, key: card.idem } } : {}),
    ...(said.length ? { choice: currentChoice(card), said: said.map((t) => ({ choice: t.choice ?? '', text: t.text })) } : {}),
  };
}

/** Every inactive conversation expires, including follow-ups after an answer. */
export function sweep(board: Board): void {
  const now = board.clock();
  for (const card of board.cards.filter(c => !c.closed)) {
    if (now - (card.thread.at(-1)?.ts ?? card.ts) >= EXPIRE_MS) closeCard(board, card, 'expired');
  }
}

/** A session ended: nobody is left to read an answer, so what it asked and nobody answered is taken back. */
export function sessionEnded(board: Board, sessionId: string): void {
  for (const card of board.cards.filter((c) => waiting(c) && c.from.sessionId === sessionId)) closeCard(board, card, 'withdrawn');
  const mine = board.asked.filter((a) => a.sessionId === sessionId);
  board.asked = board.asked.filter((a) => a.sessionId !== sessionId);
  // Cards on other PCs: tell each one, without waiting; an unreachable PC lets its card expire by itself.
  for (const a of mine) {
    void board.remote?.({ op: 'agent_card', pc: a.pc, me: board.sessions.find((s) => s.id === sessionId)?.name ?? '',
      explicit: true, id: String(a.id), text: JSON.stringify({ withdraw: 'unanswered' }) }).catch(() => {});
  }
  if (mine.length) board.save();
}
