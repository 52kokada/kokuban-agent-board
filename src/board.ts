/**
 * The board: every agent session on this machine, the mail between them, and
 * the named resources they hold. One process owns it, so there is no locking;
 * the file is only a snapshot that survives a restart.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Asked, AskReceipt, Card } from './cards.js';
import type { WorkTask, TaskDelivery } from './tasks.js';
import type { FeedEvent } from './peer.js';
import type { Pairing } from './pair.js';
import type { Offer } from './update.js';
import type { VaultState } from './vault.js';
import { describeDir, projectOf } from './git.js';
import { NOT_HUMAN } from './glance.js';
import { pickName } from './names.js';
import { readLoopLimit, continuationLimit, communicationOverrideUntil, wakeWaitingSessions } from './loop-limit.js';
import { derivedDoing } from './doing.js';
import { launcherEnabled } from './session-launch.js';
import type { Checkpoint } from './checkpoint.js';
import { rememberTranscripts, type TranscriptSource } from './retrieval.js';
import type { ConversationService } from './conversations/service.js';
import type { ChiefService } from './chief/service.js';

export type Host = 'claude' | 'codex' | 'kimi' | 'other';

export interface Session {
  /** The name this session had before touch renamed it because a live session held it; cleared once told. */
  renamedFrom?: string;
  /** A managed conversation owns this runtime; legacy wake/reaping must not drive it. */
  managed?: string;
  /** A host-observed end; TTL archival alone is not permission to resume a CLI. */
  launchEndedAt?: number;
  /** Durable one-use manual launch reservation, never used by mail delivery. */
  launchPending?: { token: string; at: number; claimed?: boolean };
  id: string;
  name: string;
  host: Host;
  cwd: string;
  where: string;
  /** "owner/repo" from its git remote: how one project is recognised across PCs (git.ts). */
  project?: string;
  state: 'working' | 'idle' | 'gone';
  joined: number;
  seen: number;
  /** Turns kept alive by mail since the human last spoke. */
  continues: number;
  /** Names this session has already been told are present. */
  known: string[];
  /** What the session is achieving, in its own words. */
  doing?: string;
  /** Its human's latest request, shown until the session describes itself. */
  prompt?: string;
  /** When it last wrote an explicit summary. */
  doingAt?: number;
  /** The version of the board's guidance it has been given. */
  rules?: number;
  /** The shared-vault lines it has heard (vault-keeper.ts vaultRules), so a host without SessionStart context hears them once. */
  vaultHeard?: string;
  /** When kokuban last woke it; the prompt that follows is not its human speaking. */
  wokenAt?: number;
  /** D130: a process in the open Kimi window that holds this session, reported by its own hooks. */
  kimiConsole?: number;
  /** D130: mail announced by a line typed into that window, handed over by the prompt hook it causes. */
  kimiTyped?: { ids: number[]; at: number; seen: number; continues: number };
  /** Where its host writes its transcript, for glance. */
  transcript?: string;
  /** Work disposition is separate from whether the host is currently generating. */
  work?: 'active' | 'blocked' | 'waiting' | 'paused' | 'done';
  /** Restore a recorded outcome after an automatic mail turn with no new owned work. */
  beforeMailWork?: {work?: Session['work'];next?:string};
  next?: string;
  /** When work or next last changed to a different value; re-recording the same state keeps it. */
  workAt?: number;
  stopChecked?: boolean;
  checkpoint?: Checkpoint;
  checkpointHistory?: Checkpoint[];
  requestRevision?: number;
  /** The host said it compacted (PostCompact: Codex, Kimi); the checkpoint note goes out with the next hook that carries context. */
  compactedAt?: number;
  /** An observed parent PostToolUse event, not an assumption based on host name. */
  toolReceipts?: boolean;
  /** On resume, old explicitly informational mail stays available by request. */
  deferredMailBefore?: number;
  deferredNoticeKey?: string;
  /**
   * D127: its host is waiting on its human, an open question or an approval prompt, as the host itself
   * reports it (Codex thread flags, Claude PreToolUse AskUserQuestion / PermissionRequest hooks).
   * Mail cannot start or interrupt anything until they answer. Cleared at the session's next step.
   */
  waitingOnHuman?: { kind: 'question' | 'approval'; since: number; via: 'codex' | 'claude' };
}

/** D127: what a waiting session's human owes it, for receipts and status. */
export function waitingWhat(s: Session): string {
  return s.waitingOnHuman?.kind === 'approval' ? 'an approval' : 'an answer to its question';
}

export interface Message {
  id: number;
  from: string;
  fromLabel: string;
  to: string;
  toName: string;
  text: string;
  ts: number;
  delivered: boolean;
  /** Offered to the host, awaiting its next hook event to confirm receipt. */
  shownAt?: number;
  shownTo?: string;
  /** Sent to this session by name, not as part of a broadcast. Only direct mail wakes an idle session. */
  direct?: boolean;
  /** Optional fixed batching deadline. Natural hook/inbox reads never wait for it. */
  wakeAfter?: number;
  /** Explicit escalation refreshes wake eligibility while preserving the original sent timestamp. */
  wakeRequestedAt?: number;
  /** Who else received it, in words, so nobody relays what its recipient already has. */
  audience?: string;
  /** Set when it came over the bridge from a session on another PC, which is not on this board. */
  remote?: { pc: string; agent: string; trust?: string };
  /** Its sender has been told that the recipient left without reading it. */
  bounced?: boolean;
  /** A person's own words from a question card's window: an answer to act on, not a peer's request to weigh. */
  person?: boolean;
  /** Task mail has its own accountable follow-up rather than generic unread bounces. */
  task?: string;
  taskRevision?: number;
  noticeKind?: 'offer' | 'progress' | 'result' | 'cancel' | 'follow-up';
  /** A newer task notice replaces this one in delivery, not in durable history. */
  supersededBy?: number;
  /** Ordinary coordination sent while these endpoints share an active task. */
  loopExempt?: boolean;
}

export interface Claim {
  what: string;
  by: string;
  note: string;
  ts: number;
}

const MINUTE = 60_000;
/** Bound mail-driven turns without hiding why automatic continuation stopped. */
export { MAX_CONTINUES } from './loop-limit.js';
/** A session unseen this long no longer counts as present. */
export const LIVE_MS = 12 * 60 * MINUTE;
/** A "working" session unseen this long is shown as quiet: a long tool call, or a crash. */
export const QUIET_MS = 30 * MINUTE;
/** A claim lapses when its holder has been unseen this long. */
export const CLAIM_MS = 2 * 60 * MINUTE;
/** A session is remembered this long after it was last seen, so resuming it soon brings its name back. */
export const FORGET_MS = 24 * 60 * MINUTE;
/** A session unseen this long is listed without its summary: what it was doing hours ago is rarely news. */
export const BRIEF_MS = 2 * 60 * MINUTE;
/** A session unseen this long (paused or quiet for hours) is left out of every roster. */
export const DROP_MS = 3 * 60 * MINUTE;
/** The SessionStart roster lists sessions in the same repository working or seen this recently. */
export const ROSTER_LIVE_MS = 15 * MINUTE;
const DOING_MAX = 140;
const HISTORY = 200;
export const REDELIVER_MS = 90_000;
/** Waking a session for mail from another PC starts a turn nobody here asked for; it waits for this much free memory. */
const WAKE_FREE_BYTES = 1024 ** 3;
const WAKE_FREE_SHARE = 0.1;
const WAKE_BUSY_SHARE = 0.9;
const CPU_SAMPLE_MS = 250;
const CPU_STALE_MS = 60_000;

/**
 * How busy the processors were between the last two looks, 0 to 1; null until there are two looks
 * a moment apart, or when the last one is too old to speak for now. It measures only when asked,
 * so it costs nothing while nobody is waiting to be woken.
 */
export function cpuBusy(read: () => os.CpuInfo[] = os.cpus, now: () => number = Date.now): () => number | null {
  let last: { at: number; idle: number; total: number } | null = null;
  let busy: number | null = null;
  return () => {
    const at = now();
    if (last && at - last.at < CPU_SAMPLE_MS) return busy;
    let idle = 0;
    let total = 0;
    for (const cpu of read()) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
    }
    const fresh = last && at - last.at <= CPU_STALE_MS && total > last.total;
    busy = fresh ? 1 - (idle - last!.idle) / (total - last!.total) : null;
    last = { at, idle, total };
    return busy;
  };
}

export function ago(ms: number): string {
  if (ms < MINUTE) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 60 * MINUTE) return `${Math.round(ms / MINUTE)}m`;
  return `${Math.round(ms / (60 * MINUTE))}h`;
}

/** How long a session's mail counts as what it already knows. */
const ECHO_MS = 30 * MINUTE;
/** The share of a message an earlier one must already say for it to be a repeat. */
const ECHO_SHARE = 0.8;
/** Short replies ("yes, go ahead") recur legitimately; only a message with this many phrases can be a repeat. */
const ECHO_MIN = 4;

/** Overlapping three-word runs: wording shared at this grain is the same news, not a coincidence. */
function phrases(text: string): Set<string> {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return new Set(words.slice(2).map((w, i) => `${words[i]} ${words[i + 1]} ${w}`));
}

/** Whether `earlier` already says most of what `text` says: a copy, a relay or a restated task result. */
export function repeats(text: string, earlier: string): boolean {
  const runs = [...phrases(text)];
  if (runs.length < ECHO_MIN) return false;
  const said = phrases(earlier);
  return runs.filter((r) => said.has(r)).length >= ECHO_SHARE * runs.length;
}

export class Board {
  conversations?: ConversationService;
  chief?: ChiefService;
  /** Host-local launch reservations, loaded before managed conversation routes become ready. */
  readonly managedNames = new Map<string, string>();
  sessions: Session[] = [];
  messages: Message[] = [];
  claims: Claim[] = [];
  /** Questions for a person, and their answers (cards.ts). */
  cards: Card[] = [];
  workTasks: WorkTask[] = [];
  taskDeliveries: TaskDelivery[] = [];
  /** This board's cross-PC sends, tasks and questions, for the feed (peer.ts). */
  feed: FeedEvent[] = [];
  nextFeedSeq = 1;
  /** Pairings asked and answered (pair.ts). */
  pairs: Pairing[] = [];
  /** Updates other PCs sent this one (update.ts). */
  offers: Offer[] = [];
  /** Asks made with an idempotency key, so a retry finds its card after a restart (cards.ts makeCardOnce). */
  askReceipts: AskReceipt[] = [];
  /** Credential names/times and removals only. Values never belong in a board snapshot. */
  vault: VaultState = { known: [], tombstones: [] };
  /** The person's own marks on feed items (feed.ts): put off until, and seen at, by thread. */
  marks: { later: Record<string, number>; seen: Record<string, number> } = { later: {}, seen: {} };
  /** Called when anything the feed shows may have changed; set by the daemon (feed.ts). */
  onChange: (() => void) | null = null;
  onLoopLimit: ((key: string, sessionId?: string) => void) | null = null;
  /** This board's part of the feed, for another board's /peer op "state"; set by the daemon (feed.ts). */
  feedState: (() => object) | null = null;
  /** A paired board says it has news: pull from it now; set by the daemon (feed.ts). */
  onPoke: ((pc: string) => void) | null = null;
  nextCardId = 1;
  /** Cards this board sent to other PCs, so their answers are recognised and they can be taken back. */
  asked: Asked[] = [];
  /** Called after mail is sent, so an idle recipient can be woken at once; set by the daemon. */
  onSend: (() => void) | null = null;
  /** Records each tool call, so the board's use can be reviewed later; set by the daemon. */
  usage: ((entry: Record<string, unknown>) => void) | null = null;
  /** Source pointers only; native hosts retain ownership of transcript contents. */
  transcriptSources: TranscriptSource[] = [];
  /** Preserve explicit recovery state when a session leaves the live roster. */
  sessionArchive: Session[] = [];
  /** Whether ended sessions are archived for the native launcher; off unless settings enable a target. */
  keepEnded: () => boolean = launcherEnabled;
  /** Shows a session's name and summary in its host's own UI; set by the daemon. */
  titler: ((s: Session) => void) | null = null;
  /** Carries the `remote` tool's request directly to the other board; set by the daemon. */
  remote: ((request: Record<string, unknown>) => Promise<string>) | null = null;
  /**
   * The board's own cards (pairing, updates): acts on the person's pick and says how it went, or
   * returns null for a card an agent asked. Set by the daemon.
   */
  onOwnCard: ((card: Card, choice: string) => Promise<string> | null) | null = null;
  /** Called when a session ends, so what it asked can be taken back; set by the daemon. */
  onEnd: ((sessionId: string) => void) | null = null;
  private readonly busy = cpuBusy();
  /**
   * Whether this PC has memory and processor to spare for a turn started by mail from another PC.
   * Not knowing how busy it is counts as no: the first look only sets the baseline.
   */
  hasRoom: () => boolean = () => {
    const busy = this.busy();
    return busy !== null && busy < WAKE_BUSY_SHARE &&
      os.freemem() >= WAKE_FREE_BYTES && os.freemem() >= os.totalmem() * WAKE_FREE_SHARE;
  };
  private nextId = 1;
  private waiters = new Map<string, Array<() => void>>();
  private saveTimer: NodeJS.Timeout | null = null;

  /**
   * Set when a snapshot existed but could not be read: the board starts blank as before, but what it
   * promised to remember (idempotent asks, cards.ts makeCardOnce) is refused until it is repaired.
   */
  loadProblem: string | null = null;
  /**
   * The same, kept in the snapshot so it outlives later saves and restarts: once receipts may have been
   * lost, keyed asks stay refused until a person clears it (`kokuban repair --forget-lost-asks`).
   */
  damaged: { since: number; copy: string; why: string } | null = null;

  constructor(
    private readonly file: string | null = null,
    readonly clock: () => number = Date.now,
  ) {
    if (!file) return;
    if (!fs.existsSync(file)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.sessions = (saved.sessions ?? []).map(({ job, jobTries, flagged, ...s }: Session & { job?: unknown; jobTries?: unknown; flagged?: unknown }) => s);
      this.messages = saved.messages ?? [];
      this.transcriptSources = saved.transcriptSources ?? [];
      this.sessionArchive = saved.sessionArchive ?? [];
      this.claims = saved.claims ?? [];
      this.nextId = saved.nextId ?? 1;
      // Cards from before a card had a thread are dropped: the feature had not shipped.
      this.cards = (saved.cards ?? []).filter((c: Card) => Array.isArray(c.thread));
      const retiredCards = new Set<number>([...(saved.stalledCards ?? []),
        ...Object.values(saved.jobs ?? {}).map(j => (j as { cardId?: number }).cardId).filter((id): id is number => typeof id === 'number')]);
      for (const c of this.cards) if (retiredCards.has(c.id) && !c.closed && !c.thread.some(t => t.from === 'person')) c.closed = 'withdrawn';
      this.asked = saved.asked ?? [];
      this.workTasks = saved.workTasks ?? [];
      this.taskDeliveries = saved.taskDeliveries ?? [];
      this.feed = saved.feed ?? [];
      this.nextFeedSeq = saved.nextFeedSeq ?? 1;
      this.pairs = saved.pairs ?? [];
      this.offers = saved.offers ?? [];
      this.askReceipts = saved.askReceipts ?? [];
      this.vault = saved.vault ?? { known: [], tombstones: [] };
      this.marks = { later: saved.marks?.later ?? {}, seen: saved.marks?.seen ?? {} };
      this.nextCardId = saved.nextCardId ?? 1;
      if (saved.damaged) {
        this.damaged = saved.damaged;
        this.loadProblem = `the saved state was damaged on ${new Date(saved.damaged.since).toISOString()} (a copy is at ${saved.damaged.copy})`;
      }
    } catch (err) {
      // An unreadable snapshot: keep a copy of it, start blank, and remember that receipts may be lost.
      const why = (err as Error).message.slice(0, 120);
      const copy = `${file}.damaged-${this.clock()}`;
      try { fs.copyFileSync(file, copy); } catch { /* the latch below still holds */ }
      this.damaged = { since: this.clock(), copy, why };
      this.loadProblem = `${file} could not be read (${why}); a copy is at ${copy}`;
    }
  }

  save(): void {
    rememberTranscripts(this);
    // Everything that changes the board saves it, so this is where the feed hears of a change.
    this.onChange?.();
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 500);
    this.saveTimer.unref();
  }

  /** A person's decision that asks lost with damaged state are given up on: keyed asks are taken again. */
  forgetLostAsks(): string {
    if (!this.damaged) return 'nothing to repair: the saved state has not been damaged';
    const was = { damaged: this.damaged, loadProblem: this.loadProblem };
    this.damaged = null;
    this.loadProblem = null;
    if (!this.flush()) {
      // Not saved, so not repaired: both guards come back, and keyed asks stay refused.
      this.damaged = was.damaged;
      this.loadProblem = was.loadProblem;
      return 'not repaired: the board could not save';
    }
    return `repaired: keyed asks are taken again (the damaged copy stays at ${was.damaged.copy})`;
  }

  flush(): boolean {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return true;
    rememberTranscripts(this);
    const { sessions, messages, claims, nextId, cards, nextCardId, asked, workTasks, taskDeliveries, feed, nextFeedSeq, pairs, offers, vault, marks, askReceipts, damaged, transcriptSources, sessionArchive } = this;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Written, forced to the disk, then put in place: when flush says true, a crash cannot take it back.
      const fd = fs.openSync(`${this.file}.tmp`, 'w');
      try {
        fs.writeSync(fd, JSON.stringify({ sessions, messages, claims, nextId, cards, nextCardId, asked, workTasks, taskDeliveries, feed, nextFeedSeq, pairs, offers, vault, marks, askReceipts, damaged, transcriptSources, sessionArchive }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(`${this.file}.tmp`, this.file);
      return true;
    } catch {
      /* the snapshot is a convenience; the live board is in memory */
      return false;
    }
  }

  private prune(now: number): void {
    rememberTranscripts(this);
    // Ended sessions are kept for the opt-in launcher only; a PC without it archives exactly as before.
    const keepEnded = this.keepEnded();
    for (const s of this.sessions) {
      if ((s.managed && s.state !== 'gone') || now - s.seen < FORGET_MS ||
          ((!keepEnded || s.launchEndedAt === undefined) && !s.checkpoint && !this.workTasks.some(t => t.owner.id === s.id || t.requester.id === s.id))) continue;
      const archived = structuredClone(s);
      archived.state = 'gone';
      const index = this.sessionArchive.findIndex(x => x.id === s.id);
      if (index < 0) this.sessionArchive.push(archived); else this.sessionArchive[index] = archived;
    }
    // Bound optional launcher-only history; never remove checkpoints or task evidence.
    const resumeOnly = this.sessionArchive.filter(s => s.launchEndedAt !== undefined && !s.launchPending && !s.checkpoint && !s.checkpointHistory?.length &&
      !this.workTasks.some(t => t.owner.id === s.id || t.requester.id === s.id)).sort((a, b) => b.seen - a.seen);
    const excess = new Set(resumeOnly.slice(500).map(s => s.id));
    this.sessionArchive = this.sessionArchive.filter(s => !excess.has(s.id));
    this.sessions = this.sessions.filter((s) => Boolean(s.managed) && s.state !== 'gone' || now - s.seen < FORGET_MS);
    // Mail to a forgotten session can never be read.
    this.messages = this.messages.filter((m) => m.delivered || this.sessions.some((s) => s.id === m.to));
    this.claims = this.claims.filter((c) => {
      const holder = this.sessions.find((s) => s.id === c.by);
      return holder && holder.state !== 'gone' && now - holder.seen < CLAIM_MS;
    });
  }

  /**
   * Record that a session is alive, registering it the first time it is seen.
   * Only present sessions hold a name; `isNew` is also true for one that returns
   * to find its name taken and is given another.
   */
  touch(id: string, cwd: string, host: Host): { session: Session; isNew: boolean } {
    const now = this.clock();
    this.prune(now);
    let session = this.sessions.find((s) => s.id === id);
    // Taken: held by another live session, or reserved for a managed conversation other than this one.
    const reserved = [...this.managedNames].filter(([key]) => key !== id && key !== session?.managed).map(([, name]) => name);
    const taken = new Set([...this.sessions.filter((s) => s.id !== id && this.isLive(s)).map((s) => s.name), ...reserved]);
    const recent = this.sessions.map((s) => s.name);
    let isNew = !session;
    if (!session) {
      const archived = this.sessionArchive.find(s => s.id === id && s.host === host);
      session = {
        id, host, cwd: '', where: '', state: 'working', joined: now, seen: now, continues: 0, known: [],
        name: pickName(taken, Math.random, recent),
        ...(archived ? { checkpoint: archived.checkpoint, checkpointHistory: archived.checkpointHistory, requestRevision: archived.requestRevision } : {}),
        ...(archived?.launchEndedAt !== undefined ? { transcript: archived.transcript } : {}),
      };
      this.sessions.push(session);
    } else if (!this.isLive(session) && taken.has(session.name)) {
      // Back after it stopped being live, and its name is in use: a new name, and the session is told why.
      session.renamedFrom = session.name;
      session.name = pickName(taken, Math.random, recent);
      isNew = true;
    }
    if (session.state === 'gone') session.state = 'working';
    delete session.launchPending;
    delete session.launchEndedAt;
    const launchArchive = this.sessionArchive.find(s => s.id === id);
    if (launchArchive) { delete launchArchive.launchPending; delete launchArchive.launchEndedAt; }
    if (cwd) session.cwd = cwd;
    session.where = describeDir(session.cwd);
    session.project = projectOf(session.cwd);
    session.seen = now;
    this.save();
    return { session, isNew };
  }

  isLive(s: Session): boolean {
    return s.state !== 'gone' && (Boolean(s.managed) || this.clock() - s.seen < LIVE_MS);
  }

  others(me: Session): Session[] {
    return this.sessions.filter((s) => s.id !== me.id && this.isLive(s));
  }

  byName(name: string): Session | undefined {
    const wanted = name.trim().toLowerCase();
    const named = this.sessions.filter((s) => s.name.toLowerCase() === wanted && s.state !== 'gone');
    return named.find((s) => this.isLive(s)) ?? named[0];
  }

  label(s: Session): string {
    return s.where ? `${s.host} · ${s.where}` : s.host;
  }

  status(s: Session, withNext = true): string {
    const unseen = this.clock() - s.seen;
    if (s.waitingOnHuman) return `waiting on its human for ${waitingWhat(s)} ${ago(this.clock() - s.waitingOnHuman.since)}`;
    if (s.state === 'idle') return `${s.work === 'active' ? 'stalled: active work' : s.work ?? 'idle: outcome unknown'} ${ago(unseen)}` +
      (s.continues >= continuationLimit(this.clock()) ? '; automatic continuation limit reached' : '') + (withNext && s.next ? `; next: ${s.next}` : '');
    return unseen > QUIET_MS ? `quiet ${ago(unseen)}` : 'working';
  }

  /** One line on what the session is for; empty when nothing is known yet. */
  summary(s: Session, derive = true): string {
    const explicit = s.doing && this.clock() - (s.doingAt ?? s.joined) < BRIEF_MS ? s.doing : '';
    return explicit || (derive ? derivedDoing(s) : '') || (s.prompt && !NOT_HUMAN.test(s.prompt) ? `asked: "${s.prompt}"` : '');
  }

  setDoing(s: Session, text: string): void {
    const line = text.replace(/\s+/g, ' ').trim();
    // Too long a line ends at a word, marked as cut, so nobody reads half a sentence as the whole.
    s.doing = line.length <= DOING_MAX ? line : `${line.slice(0, DOING_MAX).replace(/\s+\S*$/, '')}…`;
    s.doingAt = this.clock();
    this.titler?.(s);
    this.save();
  }

  setWork(s: Session, work: string, next = ''): void {
    if (!['active', 'blocked', 'waiting', 'paused', 'done'].includes(work)) throw new Error('work must be active, blocked, waiting, paused or done');
    const detail = next.replace(/\s+/g, ' ').trim();
    if (['blocked', 'waiting', 'paused'].includes(work) && !detail) throw new Error('Record the blocker and what or who can resume it in next');
    const cleaned = detail.slice(0, 600);
    if (s.work !== work || (s.next ?? '') !== cleaned) s.workAt = this.clock();
    s.work = work as Session['work'];
    delete s.beforeMailWork;
    s.next = cleaned;
    this.usage?.({ ts: this.clock(), tool: 'work', me: s.name, work, next: s.next });
    this.save();
  }

  beginMailWork(s:Session):void {
    s.beforeMailWork??={work:s.work,next:s.next};
    s.work='active';s.next=undefined;
  }

  finishMailWork(s:Session):void {
    if(!s.beforeMailWork)return;
    s.work=s.beforeMailWork.work;s.next=s.beforeMailWork.next;delete s.beforeMailWork;
  }

  /**
   * `full` carries a peer's free-text (its `doing`/`asked` summary and `next:` plan).
   * When false, only identity and state show — used for cross-repo peers in the
   * auto-injected roster, so one repo's working notes never land in another repo's
   * session context. On-demand `peers`/`glance` always pass full.
   */
  describe(s: Session, brief = false, derive = true, full = true): string {
    const held = this.claims.filter((c) => c.by === s.id).map((c) => c.what);
    const summary = brief || !full ? '' : this.summary(s, derive);
    return `${s.name} (${this.label(s)} · ${this.status(s, full)}${held.length ? ` · holds ${held.join(', ')}` : ''})` +
      (summary ? ` — ${summary}` : '');
  }

  /** True when `s` shares `me`'s repository; a repoless session (no git) matches no one. */
  /** In me's repository, or anywhere when me is outside one: the scope of the start roster and its news. */
  private inScope(me: Session, s: Session): boolean {
    return !(me.where ?? '').split('@')[0] || this.sameRepo(me, s);
  }

  private sameRepo(me: Session, s: Session): boolean {
    const mine = (me.where ?? '').split('@')[0];
    return !!mine && (s.where ?? '').split('@')[0] === mine;
  }

  /**
   * `lean` keeps cross-repo peers to identity + state (no free-text). The two
   * auto-injected call sites (SessionStart intro, per-turn delta) pass it so a
   * session is never handed another repo's working prose it did not ask for;
   * the `peers` tool leaves it off and shows everyone in full on request.
   */
  /** Others worth listing: a session unseen for DROP_MS (paused or quiet for hours) is left out; mail still reaches it. */
  listed(me: Session): Session[] {
    const now = this.clock();
    return this.others(me).filter((s) => Boolean(s.managed) ||
      (now - s.seen < DROP_MS && !(s.work === 'paused' && now - s.seen >= BRIEF_MS)));
  }

  /** End sessions unseen past LIVE_MS that host reaping missed (Codex, Kimi, a Claude whose process list failed). */
  reapStale(): number {
    const now = this.clock();
    const stale = this.sessions.filter((s) => !s.managed && s.state !== 'gone' && now - s.seen >= LIVE_MS);
    for (const s of stale) this.end(s.id);
    return stale.length;
  }

  /** Live in me's repository (anywhere, when me has none): working, or seen within ROSTER_LIVE_MS. What the start roster shows. */
  private nearby(me: Session, s: Session): boolean {
    return this.inScope(me, s) && (s.state === 'working' || this.clock() - s.seen < ROSTER_LIVE_MS);
  }

  roster(me: Session, derive = true, lean = false): string {
    const others = this.listed(me);
    me.known = others.map((s) => s.name);
    const now = this.clock();
    const until = communicationOverrideUntil(now);
    const notice = until ? `Communication limits temporarily lifted until ${new Date(until).toISOString()}. ` : '';
    // lean (the SessionStart intro): live sessions in this repository, the rest as a count.
    const shown = lean ? others.filter((s) => this.nearby(me, s)) : others;
    const rest = others.length - shown.length;
    const list = shown.map((s) => this.describe(s, now - s.seen > BRIEF_MS, derive)).join('; ');
    const more = rest ? `+${rest} other${rest === 1 ? '' : 's'} on this PC: use peers to see them` : '';
    return notice + ([list, more].filter(Boolean).join('; ') || 'nobody else right now');
  }

  /** Who arrived or left since this session was last told; empty when nothing changed. */
  rosterDelta(me: Session, lean = false): string {
    const others = this.listed(me);
    const joined = others.filter((s) => !me.known.includes(s.name) && (!lean || this.inScope(me, s)));
    const left = me.known.filter((name) => !others.some((s) => s.name === name) &&
      (!lean || this.sessions.some((s) => s.name === name && this.inScope(me, s))));
    me.known = others.map((s) => s.name);
    return [
      joined.length ? `Joined: ${joined.map((s) => this.describe(s)).join('; ')}.` : '',
      left.length ? `Left: ${left.join(', ')}.` : '',
    ].filter(Boolean).join(' ');
  }

  send(from: Session, to: string, text: string, delivery?: 'immediate' | 'batch' | 'next-step'): string {
    const mode = delivery ?? 'immediate';
    if (!['immediate', 'batch', 'next-step'].includes(mode)) throw new Error('delivery must be immediate, batch or next-step');
    const body = text.trim();
    if (!body) return 'nothing sent: the text is empty';
    // "all" is the sender's repository: a broadcast rarely concerns sessions working elsewhere.
    const scope = to.trim().toLowerCase();
    const repo = (s: Session): string => s.where.split('@')[0]!;
    const chosenRepo = scope.startsWith('repo:') ? scope.slice(5).trim() : '';
    const broadcast = scope === 'all' || scope === 'everyone' || scope.startsWith('repo:');
    // Several names, comma-separated, share one message instead of two near-copies.
    const names = to.split(',').map((n) => n.trim()).filter(Boolean);
    const named = names.map((n) => this.byName(n)).filter((s): s is Session => Boolean(s) && s!.id !== from.id);
    const unknown = names.filter((n) => !this.byName(n));
    const targets = scope === 'everyone' ? this.others(from)
      : scope === 'all' ? this.others(from).filter((s) => repo(s) && repo(s) === repo(from))
      : chosenRepo ? this.others(from).filter(s => [s.project, s.project?.split('/').at(-1), repo(s)].some(r => r?.toLowerCase() === chosenRepo))
      : [...new Set(named)];
    if (targets.length === 0 || (unknown.length && !broadcast)) {
      return scope === 'everyone' ? 'nothing sent: nobody else is on the board'
        : scope.startsWith('repo:') ? `nothing sent: no other live session is working in ${chosenRepo || 'that repository'}`
        : scope === 'all' ? `nothing sent: no other session is working in ${repo(from) || 'your repository'}. ` +
          'to="everyone" reaches the whole PC, if it truly concerns every session.'
        : `nothing sent: no other session is named "${unknown.join('", "') || to}". Present: ${this.roster(from)}`;
    }
    // A session is never handed news it already has: a second copy costs its reader a turn and adds nothing.
    const had = new Map<Session, Message>();
    const promoted = new Set<Session>();
    for (const t of targets) {
      const m = this.already(t, body);
      if (m) {
        had.set(t, m);
        // An explicit urgent resend can escalate unread information without duplicating it.
        if (!broadcast && delivery === 'immediate' && !m.delivered && m.shownAt === undefined &&
            (m.direct === false || (m.wakeAfter !== undefined && m.wakeAfter > this.clock()))) {
          m.direct = true;
          delete m.wakeAfter;
          m.wakeRequestedAt = this.clock();
          promoted.add(t);
        }
      }
    }
    if (promoted.size) this.posted();
    const skipped = [...had].map(([t, m]) => promoted.has(t)
      ? `${t.name}: unread message ${m.id} promoted to immediate wake`
      : `${t.name} already has this (message ${m.id} from ${m.from}, ${ago(this.clock() - m.ts)} ago)`);
    const fresh = targets.filter((t) => !had.has(t));
    if (!fresh.length) return promoted.size ? skipped.join('; ') : `nothing sent: ${skipped.join('; ')}. Glance instead of repeating it.`;
    for (const target of fresh) this.checkLoop({ agent: from.name }, { agent: target.name });
    const sender = from.doing ? `${this.label(from)} — ${from.doing}` : this.label(from);
    const direct = !broadcast && mode !== 'next-step';
    for (const target of fresh) {
      const others = fresh.filter((t) => t !== target).map((t) => t.name);
      const audience = scope === 'everyone' ? 'sent to every session on this PC'
        : scope === 'all' ? `sent to every session in ${repo(from)}`
        : chosenRepo ? `sent to every session in ${chosenRepo}`
        : others.length ? `also sent to ${others.join(', ')}` : undefined;
      // Anchor on the first pending batch, so a busy sender cannot postpone delivery forever.
      const batch = direct && mode === 'batch';
      const deadline = batch ? Math.min(this.clock() + 2000, ...this.messages.filter(m =>
        this.ready(m, target) && m.direct !== false && m.wakeAfter !== undefined).map(m => m.wakeAfter!)) : undefined;
      this.post(target, { from: from.name, fromLabel: sender, text: body, direct, audience,
        ...(deadline !== undefined ? { wakeAfter: deadline } : {}) });
    }
    this.posted();
    const unseen = (t: Session): number => this.clock() - t.seen;
    return [...fresh.map((t) => `sent to ${t.name} (${t.waitingOnHuman
      ? `waiting on its human for ${waitingWhat(t)}: ${direct && t.host === 'codex' && wakeWaitingSessions()
        ? 'kokuban steers this into its running turn, which reads it once its human answers'
        : 'it reads this once its human answers'}; delivery is not confirmed, check inbox or glance`
      : t.state !== 'idle'
      ? unseen(t) > QUIET_MS ? `quiet ${ago(unseen(t))}: it may have stopped, and reads this only if it takes another step`
        : 'working: it reads this at its next step'
      : t.work === 'paused' ? 'idle: explicitly paused; queued until the human resumes it'
      : !direct ? 'idle: queued for its next step; this message does not wake it'
      : direct && t.continues >= continuationLimit(this.clock()) ? 'idle: automatic continuation limit reached; queued until the human prompts it'
      : direct && !t.id.startsWith('manual-') ? `idle: queued for ${mode === 'batch' ? 'batched ' : ''}wake; delivery is not confirmed, check inbox or glance`
      : 'idle: it reads this when its human next prompts it'})`), ...skipped.map((s) => `not sent: ${s}`)].join('; ');
  }

  /** Recent mail to this session that already says what `text` says, delivered or still queued. */
  private already(target: Session, text: string): Message | undefined {
    const since = this.clock() - ECHO_MS;
    return this.messages.find((m) => m.to === target.id && m.ts >= since && repeats(text, m.text));
  }

  /** Both directions count, including outgoing cross-PC sends. Card answers and board notices do not. */
  checkLoop(a: { agent: string; pc?: string }, b: { agent: string; pc?: string }): void {
    if ([a, b].some(p => p.agent.toLowerCase() === 'kokuban')) return;
    if(this.activeTaskBetween(a,b))return;
    const key = (p: { agent: string; pc?: string }): string =>
      `${(p.pc || os.hostname()).toLowerCase().split('.')[0]}/${p.agent.toLowerCase()}`;
    const pair = [key(a), key(b)].sort().join('|');
    const matches = (x: { agent: string; pc?: string }, y: { agent: string; pc?: string }): boolean =>
      [key(x), key(y)].sort().join('|') === pair;
    const since = this.clock() - 10 * MINUTE;
    const incoming = this.messages.filter(m => m.ts >= since && !m.person && !m.task && !m.loopExempt && m.fromLabel !== 'the board' &&
      matches(m.remote ?? { agent: m.from }, { agent: m.toName })).length;
    const outgoing = this.feed.filter(e => e.ts >= since && e.dir === 'out' && e.op === 'send' && !e.person && !e.loopExempt &&
      matches({ agent: e.agent }, { agent: e.to, pc: e.pc })).length;
    if (incoming + outgoing > readLoopLimit(this.clock())) {
      try { this.onLoopLimit?.(`${pair}:${Math.floor(this.clock() / (10 * MINUTE))}`, this.byName(b.agent)?.id); } catch { /* Coordination still refuses the loop if notifications fail. */ }
      throw new Error('these two sessions have exchanged a lot in the last few minutes, which looks like a loop; check with your human before continuing');
    }
  }
  activeTaskBetween(a:{agent:string;pc?:string},b:{agent:string;pc?:string}):boolean {
    const key=(p:{agent:string;pc?:string})=>`${(p.pc||os.hostname()).toLowerCase().split('.')[0]}/${p.agent.toLowerCase()}`;
    const matches=(e:{id:string;name:string;pc?:string},p:{agent:string;pc?:string})=>key({agent:e.name,pc:e.pc})===key(p)&&(e.pc||this.byName(e.name)?.id===e.id);
    return this.workTasks.some(t=>!['done','cancelled'].includes(t.state)&&((matches(t.requester,a)&&matches(t.owner,b))||(matches(t.requester,b)&&matches(t.owner,a))));
  }

  /** Queue one message for a session and stir whoever is waiting on its mail. */
  private post(
    target: Session,
    fields: Pick<Message, 'from' | 'fromLabel' | 'text' | 'direct' | 'audience' | 'remote' | 'person' | 'task' | 'taskRevision' | 'noticeKind' | 'wakeAfter'>,
  ): Message {
    const message: Message = {
      id: this.nextId++, to: target.id, toName: target.name, ts: this.clock(), delivered: false, ...fields,
      ...(this.activeTaskBetween(fields.remote??{agent:fields.from},{agent:target.name})?{loopExempt:true}:{}),
    };
    this.messages.push(message);
    for (const wake of this.waiters.get(target.id) ?? []) wake();
    return message;
  }

  private posted(): void {
    if (this.messages.length > HISTORY) {
      const cut = this.messages.length - HISTORY;
      this.messages = this.messages.filter((m, i) => i >= cut || !m.delivered);
    }
    this.save();
    this.onSend?.();
  }

  /** Task notices use the same inbox and wake path, addressed by session ID. Progress waits for the next step instead of waking. */
  taskMail(id: string, text: string, senderId?: string, taskId?: string, wake = true,
    revision?: number, noticeKind?: Message['noticeKind']): void {
    const target = this.sessions.find((s) => s.id === id && this.isLive(s));
    if (!target) return;
    const sender = this.sessions.find((s) => s.id === senderId);
    const message = this.post(target, { from: sender?.name ?? 'kokuban', fromLabel: sender ? this.label(sender) : 'the board', text, direct: wake, task: taskId,
      ...(revision !== undefined ? { taskRevision: revision } : {}), ...(noticeKind ? { noticeKind } : {}) });
    this.supersedeTaskMail(message);
    this.posted();
  }

  /**
   * Mail from a session on another PC, for one session here. Its sender is not on this board and
   * never joins it: the message alone says where it came from and how to answer.
   */
  sendRemote(from: { pc: string; agent: string }, target: Session, text: string, person = false, trust?: string,
    notice?: { task: string; revision: number; kind: Message['noticeKind']; wake: boolean }): Message {
    if (!person) this.checkLoop(from, { agent: target.name });
    const message = this.post(target, {
      from: `${from.agent}@${from.pc}`,
      // A person's answer to a card this board sent is not a session: there is nobody to `remote` back to.
      fromLabel: person ? `the person at the PC "${from.pc}", in the window of the question card you sent; reply there with ask(op="say")`
        : `a session on the PC "${from.pc}", not on this board; answer with ` +
          `remote(op="send", pc="${from.pc}", to="${from.agent}", explicit=true)`,
      text, direct: notice?.wake ?? true, remote: trust ? { ...from, trust } : from, ...(person ? { person: true } : {}),
      ...(notice ? { task: notice.task, taskRevision: notice.revision, noticeKind: notice.kind } : {}),
    });
    this.supersedeTaskMail(message);
    this.posted();
    return message;
  }

  /** A person's answer to a question card, for the session here that asked. Direct, so it wakes an idle one. */
  sendFromPerson(name: string, target: Session, text: string): Message {
    const message = this.post(target, {
      from: name, fromLabel: 'the person at this PC, in the window of the question card you sent; reply there with ask(op="say")',
      text, direct: true, person: true,
    });
    this.posted();
    return message;
  }

  /** "Thorn (codex · prompt@main — doing; also sent to Finch)": who a message is from and who else has it. */
  header(m: Message): string {
    return `${m.from} (${m.fromLabel}${m.audience ? `; ${m.audience}` : ''})`;
  }

  hasMail(s: Session): boolean {
    return this.messages.some((m) => this.ready(m, s) && !this.isDeferred(m, s));
  }

  isDeferred(m: Message, s: Session): boolean {
    return m.to === s.id && m.direct === false && !m.person && !m.task && s.deferredMailBefore !== undefined && m.ts < s.deferredMailBefore;
  }

  deferredMail(s: Session): Message[] {
    return this.messages.filter(m => !m.delivered && m.supersededBy === undefined && this.isDeferred(m, s));
  }

  /** Informational mail waits for a natural step rather than extending a finished turn. */
  needsAttention(m: Message, s: Session): boolean {
    return this.ready(m, s) && m.direct !== false && (m.wakeAfter === undefined || m.wakeAfter <= this.clock());
  }

  ready(m: Message, s: Session): boolean {
    return m.to === s.id && !m.delivered && m.supersededBy === undefined && (m.shownAt === undefined || this.clock() - m.shownAt >= REDELIVER_MS);
  }

  supersedeTaskMail(newest: Message): void {
    if (!newest.task || newest.taskRevision === undefined || !newest.noticeKind) return;
    for (const old of this.messages) {
      if (old.id === newest.id || old.to !== newest.to || old.task !== newest.task || old.delivered ||
          old.taskRevision === undefined || old.taskRevision >= newest.taskRevision) continue;
      if (old.noticeKind === 'progress' || old.noticeKind === 'result' || old.noticeKind === 'follow-up' ||
          (newest.noticeKind === 'cancel' && old.noticeKind === 'offer')) old.supersededBy = newest.id;
    }
    this.save();
  }

  /** An offer is not a receipt: a lost hook reply becomes eligible again. */
  take(s: Session): Message[] {
    const mail = this.messages.filter((m) => this.ready(m, s) && !this.isDeferred(m, s));
    this.show(s, mail);
    return mail;
  }

  show(s: Session, mail: Message[]): void {
    for (const m of mail) { m.shownAt = this.clock(); m.shownTo = s.id; }
    if (mail.length) this.save();
  }

  /** Next host event confirms the previous offer; socket/queue success confirms its exact batch. */
  confirm(s: Session, mail = this.messages.filter((m) => m.shownTo === s.id && m.shownAt !== undefined)): void {
    for (const m of mail) if (m.to === s.id) m.delivered = true;
    if (mail.length) this.save();
  }

  /** Resolve when mail for this session arrives, or after `ms`. */
  wait(s: Session, ms: number): Promise<void> {
    if (ms <= 0 || this.hasMail(s)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.waiters.get(s.id) ?? [];
      const done = () => {
        clearTimeout(timer);
        const rest = (this.waiters.get(s.id) ?? []).filter((w) => w !== done);
        if (rest.length) this.waiters.set(s.id, rest);
        else this.waiters.delete(s.id);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.set(s.id, [...list, done]);
    });
  }

  claim(s: Session, what: string, note: string): string {
    const key = what.trim().toLowerCase();
    if (!key) return 'nothing claimed: name the resource';
    const now = this.clock();
    this.prune(now);
    const held = this.claims.find((c) => c.what === key);
    if (held && held.by !== s.id) {
      const holder = this.sessions.find((x) => x.id === held.by)!;
      return `not yours: ${key} is held by ${holder.name} for ${ago(now - held.ts)}` +
        `${held.note ? ` (${held.note})` : ''}. Wait, pick another, or send ${holder.name} a message.`;
    }
    this.claims = this.claims.filter((c) => c.what !== key);
    this.claims.push({ what: key, by: s.id, note: note.trim(), ts: held?.ts ?? now });
    this.save();
    return `yours: ${key}. Release it when you are done.`;
  }

  release(s: Session, what: string): string {
    const key = what.trim().toLowerCase();
    const mine = this.claims.filter((c) => c.by === s.id && (!key || c.what === key));
    this.claims = this.claims.filter((c) => !mine.includes(c));
    this.save();
    return mine.length ? `released: ${mine.map((c) => c.what).join(', ')}` : 'nothing to release';
  }

  /**
   * Tell whoever wrote to a session that left with their message unread, once per message, at their
   * next step: it does not wake them. A sender who has left too, or whose name now belongs to a
   * later session, hears nothing; mail from another PC has its own receipt.
   */
  private bounce(gone: Session): void {
    const unread = this.messages.filter((m) => m.to === gone.id && !m.delivered && m.direct && !m.remote && !m.bounced && !m.task);
    for (const m of unread) m.bounced = true;
    for (const name of new Set(unread.map((m) => m.from))) {
      const sender = this.byName(name);
      const theirs = unread.filter((m) => m.from === name);
      if (!sender || sender.id === gone.id || !this.isLive(sender) || sender.joined > theirs[0]!.ts) continue;
      const first = theirs[0]!.text.replace(/\s+/g, ' ');
      this.post(sender, {
        from: 'kokuban', fromLabel: 'the board',
        text: `${gone.name} closed without reading ${theirs.length > 1 ? `your ${theirs.length} messages, the first` : 'your message'} ` +
          `"${first.length > 80 ? `${first.slice(0, 79)}…` : first}". It is shown if that session is reopened within a day; ` +
          'if the work cannot wait, hand it to someone present.',
      });
    }
  }

  end(id: string): void {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    s.state = 'gone';
    s.launchEndedAt = this.clock();
    s.seen = this.clock();
    this.claims = this.claims.filter((c) => c.by !== id);
    this.bounce(s);
    this.onEnd?.(id);
    this.save();
  }
}
