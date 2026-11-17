/**
 * The `ask` tool: an agent puts a question in front of a person and keeps the thread with them.
 *
 *   new        to this PC's person, to a named person (settings.json lists their PCs; the one
 *              touched most recently gets it), or to a PC by name
 *   say        the agent adds to its card's thread: an answer to a follow-up, a second question
 *   withdraw   the answer is no longer needed: the card closes
 *   status     where the card stands and what was said
 */
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Board, Session } from './board.js';
import {
  FILE_BYTES, MAX_FILES, agentSays, cardStatus, closeCard, idempotency, makeCardOnce, pcsOf, personName, type CardFile,
} from './cards.js';
import { askedReply } from './cards.js';
import { nativeApp } from './app-routes.js';

type Args = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export const ASK_TOOL = {
  name: 'ask',
  description: 'Put a question in front of a person: a card in their Kokuban app where they pick a choice or type, and where the two of you can keep talking. Their answer and anything they add arrive as mail. Use it when your human says to ask someone ("bring this to Sam\'s attention"), or to ask your own human something that should not wait until they look at this session. Write question and every follow-up headline as one short, self-contained action line saying what the person must decide or do, such as "Approve sending 5 adviser emails?" or "Snap paper ready to edit — tap to open". Keep everything else in details or follow-up text. On say, include headline whenever the current action or state changes; otherwise the first sentence becomes the bold title. Once nothing more is needed from the person, withdraw the card with op "withdraw" instead of posting "no action needed" or leaving a resolved card in Needs you. One decision per card: a short question, two to four choices when the answer is a pick, details for what they need to decide. Write it in the language its reader uses. Name the person with `to` (their PC is found for you) or a PC with `pc`, and pass explicit=true when it is not this PC; omit both for the person at this PC. The reply says whether the Kokuban app is running; if it is not, tell your human instead of waiting. op "say" (id, text, optional headline) replies in the card\'s thread, "withdraw" (id) takes the question back when you no longer need it, "status" (id) reads what was said; pass the same pc as when you asked.',
  inputSchema: {
    type: 'object',
    properties: {
      me: { type: 'string', description: 'Your kokuban name ("new" if you were never given one).' },
      op: { type: 'string', enum: ['new', 'say', 'withdraw', 'status'] },
      to: { type: 'string', description: 'The person to ask, by name. Omit for the person at this PC.' },
      pc: { type: 'string', description: 'Or the other PC\'s tailnet name, when you know where they are.' },
      question: { type: 'string', description: 'One short self-contained action line saying what the person must decide or do, e.g. Approve sending 5 adviser emails? Keep everything else in details. At most 300 characters.' },
      headline: { type: 'string', description: 'For say: replace the bold title with the current action or state, e.g. Report draft ready to edit — tap to open. Make it understandable without reading details; one short action line, at most 300 characters.' },
      details: { type: 'string', description: 'What they need to know to answer: context, trade-offs, your recommendation.' },
      choices: { type: 'array', items: { type: 'string' }, description: 'Up to four short options; they can always type instead.' },
      links: { type: 'array', items: { type: 'string' }, description: 'http(s) links to what the question is about. A link to a picture is shown as the picture.' },
      files: { type: 'array', items: { type: 'string' }, description: 'For new or say: full paths of files on this PC to attach. Say appends files and records them on its thread entry. At most four files per call, sixteen total per card, 25 MB each. Pictures appear in the thread, other files as downloads.' },
      id: { type: 'number', description: 'For say, withdraw and status: the card id that ask returned.' },
      text: { type: 'string', description: 'For say: what you add to the thread.' },
      explicit: { type: 'boolean', description: 'true when your human asked for a person on another PC to be asked.' },
      group: { type: 'string', description: 'Your own id for the decision, when you put one decision to several people with a card each (1-64 of A-Z a-z 0-9 . _ : -). It links the cards in the feed; each card is still answered and read on its own with status.' },
      idempotency_key: { type: 'string', description: 'Your own key for this ask (1-128 of A-Z a-z 0-9 . _ : -), with issued_at: asking again with the same key and the same words returns the same card, as it stands now, even after a restart; different words under it are refused. The reply then carries idempotency {supported: 1, key, duplicate}; a board that does not echo it does not support this.' },
      issued_at: { type: 'number', description: 'With idempotency_key: when you first issued this ask, in ms since 1970. Keep it the same on every retry.' },
      misaligned: { type: 'boolean', description: 'true when the people asked disagree: the card is marked as a disagreement for whoever reads it. Ask each person with their own card.' },
    },
    required: ['me'],
  },
};

/** Prefer the first configured PC whose native app is running. */
async function whereIs(board: Board, me: Session, name: string): Promise<string> {
  const { pcs, known } = pcsOf(name);
  if (!pcs.length) {
    throw new Error(`nobody named "${name}" is listed. Known: ${known.join(', ') || 'none'} ` +
      '(settings.json "people" in the board\'s data folder). Or name the PC with pc.');
  }
  const seen = await Promise.all(pcs.map(async (pc) => {
    try {
      const reply = JSON.parse(await board.remote!({ op: 'agent_card', pc, me: me.name, explicit: true, id: '0',
        text: JSON.stringify({ presence: true }) })) as { ok?: boolean; app_running?: boolean };
      return { pc, running: reply.ok && reply.app_running === true };
    } catch {
      return { pc, running: false };
    }
  }));
  const reachable = seen.filter((s) => s.running);
  if (!reachable.length) throw new Error(`none of ${name}'s PCs has a running Kokuban app (${pcs.join(', ')}).`);
  return reachable[0]!.pc;
}

/** Check the files an agent named; for another PC, send each ahead under a name only this card uses. */
const taildrop = (file: string, pc: string): Promise<void> => new Promise((resolve, reject) => {
  execFile('tailscale', ['file', 'cp', file, `${pc}:`], { windowsHide: true, timeout: 60_000 }, err => err ? reject(err) : resolve());
});

async function attach(paths: string[], pc: string, key: string, sendFile: typeof taildrop): Promise<{ local: CardFile[]; sent: Array<{ name: string; sent: string }> }> {
  if (paths.length > MAX_FILES) throw new Error(`no card made: at most ${MAX_FILES} files`);
  const local: CardFile[] = [];
  const sent: Array<{ name: string; sent: string }> = [];
  for (const [i, file] of paths.entries()) {
    const full = path.resolve(file);
    const size = fs.statSync(full, { throwIfNoEntry: false });
    if (!size?.isFile()) throw new Error(`no card made: ${file} is not a file on this PC`);
    if (size.size > FILE_BYTES) throw new Error(`no card made: ${path.basename(full)} is over 25 MB; put it somewhere they can reach and send the link`);
    const name = path.basename(full);
    if (!pc) {
      local.push({ name, path: full });
      continue;
    }
    // Taildrop saves it into their Downloads under this name; the card there serves only names of this shape.
    const ext = (path.extname(name).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin').slice(0, 8);
    const copy = path.join(os.tmpdir(), `kokuban-${key}-${i}.${ext}`);
    fs.copyFileSync(full, copy);
    try {
      await sendFile(copy, pc);
    } finally {
      fs.rmSync(copy, { force: true });
    }
    sent.push({ name, sent: path.basename(copy) });
  }
  return { local, sent };
}

export async function askTool(board: Board, me: Session, args: Args, sendFile = taildrop): Promise<string> {
  const op = str(args.op) || 'new';
  let pc = str(args.pc);
  const to = str(args.to);
  const far = (): void => {
    if (!board.remote) throw new Error('this board cannot reach another PC');
  };

  if (op !== 'new') {
    if (!['say', 'withdraw', 'status'].includes(op)) throw new Error('op must be new, say, withdraw or status');
    if (typeof args.id !== 'number') throw new Error(`${op} needs id: the card id ask returned`);
    if (pc) {
      far();
      const files=op==='say'?await attach(Array.isArray(args.files)?args.files.map(str).filter(Boolean):[],pc,randomBytes(8).toString('hex'),sendFile):undefined;
      const does = op === 'say' ? { say: str(args.text), ...(args.headline===undefined?{}:{headline:args.headline}),...(files?.sent.length?{files:files.sent}:{}) } : op === 'withdraw' ? { withdraw: true } : {};
      if (op === 'withdraw') {
        board.asked = board.asked.filter((a) => !(a.id === args.id && a.sessionId === me.id));
        board.save();
      }
      return board.remote!({ op: 'agent_card', pc, me: me.name, explicit: true, id: String(args.id), text: JSON.stringify(does) });
    }
    const card = board.cards.find((c) => c.id === args.id && c.from.sessionId === me.id);
    if (!card) throw new Error(`no card #${args.id} of yours on this PC; for a card on another PC pass the same pc as when you asked`);
    if (op === 'say') {
      const files=await attach(Array.isArray(args.files)?args.files.map(str).filter(Boolean):[],'',card.key,sendFile);
      return JSON.stringify(agentSays(board,card,str(args.text),args.headline,files.local));
    }
    if (op === 'withdraw') closeCard(board, card, 'withdrawn');
    return JSON.stringify(cardStatus(card));
  }

  if (to && !pc && to.toLowerCase() !== personName().toLowerCase()) {
    far();
    pc = await whereIs(board, me, to);
  }
  if (pc && args.explicit !== true) {
    throw new Error('asking a person on another PC puts a card in their Kokuban app: pass explicit=true only when your human asked for it.');
  }
  const key = randomBytes(8).toString('hex');
  const paths = Array.isArray(args.files) ? args.files.map(str).filter(Boolean) : [];
  if (pc) far();
  const files = await attach(paths, pc, key, sendFile);
  const fields = {
    question: args.question, details: args.details, choices: args.choices, links: args.links, lang: args.lang,
    project: me.where, key, group: args.group, misaligned: args.misaligned,
    idempotency_key: args.idempotency_key, issued_at: args.issued_at,
  };
  if (!pc) {
    const { card, duplicate } = makeCardOnce(board, { agent: me.name, sessionId: me.id }, { ...fields, person: '' }, files.local);
    if (duplicate) return JSON.stringify({ ...cardStatus(card), ...idempotency(card, true) });
    return JSON.stringify({ ...askedReply(card, { shown: Boolean(nativeApp()) }), ...idempotency(card, false) });
  }
  const reply = await board.remote!({
    op: 'agent_ask', pc, me: me.name, explicit: true, request_id: key,
    text: JSON.stringify({ ...fields, person: personName(), files: files.sent }),
  });
  try {
    const made = JSON.parse(reply) as { ok?: boolean; id?: number };
    if (made.ok && typeof made.id === 'number') {
      // A retry with an idempotency key comes back with the card already listed: list it once.
      if (!board.asked.some((x) => x.pc === pc && x.id === made.id)) board.asked.push({ key, pc, id: made.id, sessionId: me.id });
      board.save();
      return JSON.stringify({ ...made, sent_to: pc });
    }
  } catch {
    /* An unrecognized reply is passed through to the caller. */
  }
  return reply;
}
