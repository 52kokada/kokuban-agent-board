/**
 * Sessions on this board that wait on this PC's person, as feed items (D134). Computed on read from
 * the roster; nothing is stored. A session shows when it is blocked, when it waits and its `next`
 * names the person, or when it sits at a question or approval prompt in its own terminal.
 */
import type { Board, Session } from './board.js';
import { projectOf } from './git.js';
import type { Item } from './feed.js';

const MINUTE = 60_000;
/** A prompt must have stood this long before it reaches the list, so one the person answers at once never flashes. */
export const PROMPT_MIN_MS = MINUTE;
/** Older than this, a wait is stale rather than urgent. */
export const NEEDS_YOU_MAX_MS = 3 * 86_400_000;

/** Whether `text` names `person` as a whole word. Names without Latin letters (Japanese) may sit inside a longer run, as in "タナカさん". */
export function namesPerson(text: string, person: string): boolean {
  const name = person.trim();
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!/[A-Za-z]/.test(name)) return new RegExp(escaped, 'iu').test(text);
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
}

export interface NeedsYouContext { person: string; here: string; lang: 'en' | 'ja' }

export function sessionItems(board: Board, ctx: NeedsYouContext): Item[] {
  const now = board.clock();
  const out: Item[] = [];
  const make = (s: Session, thread: string, kind: Item['kind'], title: string, body: string, ts: number): void => {
    if (now - ts > NEEDS_YOU_MAX_MS) return;
    out.push({
      thread, kind, person: ctx.person, pc: ctx.here, board: ctx.here, agent: s.name, project: s.project ?? projectOf(s.cwd),
      title, body, choices: [{ id: 'seen', label: 'Seen' }], reply: false, ts, lang: ctx.lang, steps: [], files: [], links: [],
    });
  };
  const ja = ctx.lang === 'ja';
  // The same liveness rule as the roster (sessionLines): isLive.
  for (const s of board.sessions.filter((x) => board.isLive(x))) {
    // Never `seen`: it moves on every hook, and a Seen mark would then last only until the next one.
    const stamp = s.workAt ?? s.doingAt ?? s.joined;
    const w = s.waitingOnHuman;
    if (w && !s.managed && now - w.since >= PROMPT_MIN_MS) {
      const title = w.kind === 'approval'
        ? (ja ? `${s.name}がターミナルで承認を待っています` : `${s.name} waits for an approval in its terminal`)
        : (ja ? `${s.name}がターミナルで質問しています` : `${s.name} asks a question in its terminal`);
      make(s, `session:${s.id}:human`, 'decide', title, board.summary(s), w.since);
    }
    if (s.work === 'blocked') {
      make(s, `session:${s.id}:blocked`, 'blocked', ja ? `${s.name}が止まっています` : `${s.name} is blocked`, s.next ?? '', stamp);
    } else if (s.work === 'waiting' && namesPerson(s.next ?? '', ctx.person)) {
      make(s, `session:${s.id}:waiting`, 'decide', ja ? `${s.name}が返答を待っています` : `${s.name} waits for you`, s.next ?? '', stamp);
    }
  }
  return out;
}
