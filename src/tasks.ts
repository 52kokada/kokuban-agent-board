/** Explicit handoffs, not a second scheduler. Ordinary mail never creates a task.
 * Each owner controls one revisioned record. Cross-PC copies use the existing
 * bridge; the persisted outbox retries only idempotent task metadata.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Board, Session } from './board.js';
import { validateCheckpoint, type Checkpoint } from './checkpoint.js';

export interface Endpoint { id: string; name: string; pc?: string }
export type TaskState = 'requested' | 'accepted' | 'blocked' | 'done' | 'cancelled';
export interface WorkTask {
  id: string;
  key: string;
  requester: Endpoint;
  owner: Endpoint;
  text: string;
  state: TaskState;
  detail: string;
  revision: number;
  created: number;
  updated: number;
  afterMs: number;
  /** One escalation for this task, persisted across restarts. */
  alertedAt?: number;
  alert?: string;
  cancelRequested?: string;
  /** This PC's person's replies from the feed, delivered to the owner. Local only: never sent in a
   *  snapshot and never taken from one, so another PC cannot write this history. */
  replies?: TaskReply[];
  checkpoint?: Checkpoint;
  checkpointHistory?: Checkpoint[];
  blockerKey?: string;
  attentionRevision?: number;
  noticeDelivery?: 'immediate' | 'next-step';
}
export interface TaskReply { text: string; person: string; ts: number }
/** The most replies kept per task; the oldest go first. */
export const MAX_REPLIES = 50;
type Kind = 'offer' | 'update' | 'cancel';
export interface TaskDelivery {
  id: string;
  kind: Kind;
  task: string;
  to: Endpoint;
  actor: Endpoint;
  snapshot: WorkTask;
  attempts: number;
  retryAt: number;
  error?: string;
}
type Args = Record<string, unknown>;
const str = (x: unknown): string => typeof x === 'string' ? x.trim() : '';
const endpoint = (s: Session): Endpoint => ({ id: s.id, name: s.name });
const same = (a: Endpoint, b: Endpoint): boolean => a.id === b.id && a.name === b.name && a.pc === b.pc;
const terminal = (t: WorkTask): boolean => t.state === 'done' || t.state === 'cancelled';
const owns = (s: Session, e: Endpoint): boolean => !e.pc && e.id === s.id;
const required = (text: unknown, label: string): string => {
  const value = str(text);
  if (!value || value.length > 4000) throw new Error(`${label} must contain 1 to 4000 characters`);
  return value;
};
const threshold = (seconds: unknown): number => {
  const n = seconds === undefined ? 900 : Number(seconds);
  if (!Number.isFinite(n) || n < 60 || n > 86400) throw new Error('after_s must be between 60 and 86400');
  return n * 1000;
};
const record = (b: Board, t: WorkTask): void => {
  b.usage?.({ ts: b.clock(), tool: 'task:state', id: t.id, state: t.state, revision: t.revision,
    owner: t.owner.name, requester: t.requester.name });
  b.save();
  if (!b.flush()) throw new Error('Task state could not be saved; inspect the current task before retrying');
};

function queue(b: Board, t: WorkTask, kind: Kind): void {
  const to = kind === 'update' ? t.requester : t.owner;
  const actor = kind === 'update' ? t.owner : t.requester;
  if (!to.pc) return;
  // Updates supersede older pending snapshots. Offers and cancels retain their order.
  b.taskDeliveries = b.taskDeliveries.filter((d) => !(d.task === t.id && d.kind === kind));
  b.taskDeliveries.push({ id: `${t.id}/${kind}/${t.revision}`, kind, task: t.id, to: { ...to }, actor: { ...actor },
    snapshot: shared(t), attempts: 0, retryAt: 0 });
  b.save();
}

/** The task as another PC may see it: everything but this PC's local reply history. */
function shared(t: WorkTask): WorkTask {
  const { replies: _local, checkpointHistory: _history, ...rest } = structuredClone(t);
  return rest;
}

function notice(b: Board, t: WorkTask, to: Endpoint, text: string, actor: Endpoint, wake = true,
  kind: 'offer' | 'progress' | 'result' | 'cancel' = t.state === 'accepted' ? 'progress' : t.state === 'requested' ? 'offer' : t.state === 'cancelled' ? 'cancel' : 'result'): void {
  const target = b.sessions.find((s) => s.id === to.id && b.isLive(s));
  if (!target) return; // The persistent task still appears on the board; never send to a reused name.
  // A quieter revision must not erase an actionable notice that has never arrived.
  if (!wake && t.state === 'blocked') wake = b.messages.some(m => m.to === target.id && m.task === t.id && m.direct !== false && !m.delivered && m.supersededBy === undefined);
  if (actor.pc) {
    b.sendRemote({ pc: actor.pc, agent: actor.name }, target, text, false, undefined,
      { task: t.id, revision: t.revision, kind, wake });
  } else b.taskMail(target.id, text, actor.id, t.id, wake, t.revision, kind);
}

/**
 * Tell the requester what changed, once. A bare acceptance says nothing it can act on, so it is only
 * recorded (task list shows it); progress waits for its next step; a result or blocker wakes it.
 */
function announce(b: Board, t: WorkTask, wake = t.state !== 'accepted'): void {
  if (t.state === 'accepted' && !t.detail) return;
  t.noticeDelivery = wake ? 'immediate' : 'next-step';
  notice(b, t, t.requester, `Task ${t.state}. ${t.detail || 'Awaiting acceptance.'}` +
    (t.state === 'blocked' ? ' You own the follow-up: resolve this condition or cancel the task.' : ''), t.owner, wake);
}

/** What the owner is told after a transition, so the requester does not hear it twice. */
function told(t: WorkTask): string {
  if (t.state === 'accepted' && !t.detail) return `Recorded. ${t.requester.name} sees it in task list; a bare acceptance is not mailed.`;
  if (t.state === 'accepted') return `Recorded and queued for ${t.requester.name}'s next step; progress does not wake it.`;
  if (t.noticeDelivery === 'next-step') return `Recorded; ${t.requester.name} sees the updated blocker at its next step. No extra wake or message is needed.`;
  return `${t.requester.name} has been told. Do not send this again as a message.`;
}

function view(b: Board, t: WorkTask): object {
  const deliveries = b.taskDeliveries.filter((d) => d.task === t.id);
  return { ...t, sync: deliveries.length ? 'pending' : 'synced',
    ...(deliveries.some((d) => d.error) ? { delivery_error: deliveries.find((d) => d.error)!.error } : {}) };
}

function mutationReply(b: Board, t: WorkTask, args: Args, notification?: string): string {
  if (args.compact === false) return JSON.stringify({ ...view(b, t), ...(notification ? { told: notification } : {}) });
  const pending = b.taskDeliveries.filter(d => d.task === t.id);
  return JSON.stringify({ id: t.id, state: t.state, revision: t.revision, updated: t.updated,
    owner: t.owner, requester: t.requester, checkpoint_revision: t.checkpoint?.revision ?? 0,
    sync: pending.length ? 'pending' : 'synced', ...(pending.find(d => d.error) ? { delivery_error: pending.find(d => d.error)!.error } : {}),
    ...(t.cancelRequested ? { cancel_requested: true } : {}), ...(t.blockerKey ? { blocker_key: t.blockerKey } : {}),
    ...(notification ? { told: notification } : {}), evidence: 'Use status(id) for full text and history.' });
}

function blockerKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,79}$/.test(value)) throw new Error('blocker_key must be 1 to 80 identifier characters');
  return value;
}

function transition(b: Board, t: WorkTask, state: TaskState, detail: string, options: { key?: string; urgent?: boolean } = {}): void {
  if (t.state === state && t.detail === detail && (state !== 'blocked' || t.blockerKey === options.key) && !options.urgent) return;
  if (terminal(t)) throw new Error(`Task is already ${t.state}; create a new task for new work`);
  if (t.state === 'blocked' && state === 'accepted' && !detail) detail = 'Work resumed; inspect current task state.';
  if (state === 'done' && t.state === 'requested') throw new Error('Accept the task before completing it');
  const coalesced = state === 'blocked' && t.state === 'blocked' && options.key !== undefined && options.key === t.blockerKey && !options.urgent;
  t.state = state;
  t.detail = detail;
  t.revision++;
  if (state === 'blocked') {
    t.blockerKey = options.key;
    if (!coalesced) t.attentionRevision = t.revision;
  } else { delete t.blockerKey; delete t.attentionRevision; }
  t.updated = b.clock();
  delete t.alert;
  if (terminal(t)) delete t.cancelRequested;
  if (t.requester.pc) queue(b, t, 'update');
  else announce(b, t, state !== 'accepted' && !coalesced);
  t.noticeDelivery = state === 'accepted' || coalesced ? 'next-step' : 'immediate';
  record(b, t);
}

/** Apply an owner's snapshot to the requester's copy; delayed replies cannot undo newer work. */
function merge(b: Board, t: WorkTask, incoming: WorkTask): void {
  if (incoming.id !== t.id) throw new Error('Task response does not match its request');
  if (!Number.isSafeInteger(incoming.revision) || incoming.revision < 0 ||
      !['requested', 'accepted', 'blocked', 'done', 'cancelled'].includes(incoming.state)) throw new Error('Invalid task revision or state');
  if (typeof incoming.detail !== 'string' || incoming.detail.length > 4000 ||
      (['blocked', 'done', 'cancelled'].includes(incoming.state) && !incoming.detail.trim())) throw new Error('Invalid task result or blocker');
  if (incoming.revision <= t.revision) return;
  const checkpoint = incoming.checkpoint ? validateCheckpoint(incoming.checkpoint) : undefined;
  const key = blockerKey(incoming.blockerKey);
  if (incoming.attentionRevision !== undefined && (!Number.isSafeInteger(incoming.attentionRevision) || incoming.attentionRevision < 0 || incoming.attentionRevision > incoming.revision)) throw new Error('Invalid attention revision');
  const changed = incoming.state !== t.state || incoming.detail !== t.detail;
  const attentionChanged = (incoming.attentionRevision ?? 0) > (t.attentionRevision ?? 0);
  const coalesced = incoming.state === 'blocked' && t.state === 'blocked' && key !== undefined && key === t.blockerKey &&
    (incoming.attentionRevision ?? 0) <= (t.attentionRevision ?? 0);
  if (terminal(t)) throw new Error('A terminal task cannot be reopened');
  t.state = incoming.state;
  t.detail = incoming.detail;
  t.blockerKey = key; t.attentionRevision = incoming.attentionRevision;
  if (checkpoint && (!t.checkpoint || checkpoint.revision > t.checkpoint.revision)) {
    if (t.checkpoint) (t.checkpointHistory ??= []).push(t.checkpoint);
    t.checkpoint = checkpoint;
  }
  t.revision = incoming.revision;
  // Receiving time is the local freshness clock; another PC's clock is not trusted.
  t.updated = b.clock();
  delete t.alert;
  if (terminal(t)) {
    delete t.cancelRequested;
    b.taskDeliveries = b.taskDeliveries.filter((d) => d.task !== t.id);
  }
  if (changed || attentionChanged) announce(b, t, incoming.state !== 'accepted' && !coalesced);
  record(b, t);
}

/** A checkpoint is explicit owner state; it does not accept, complete or wake a task. */
export async function saveTaskCheckpoint(b: Board, me: Session, id: string, checkpoint: Checkpoint, expected: number): Promise<void> {
  const t = b.workTasks.find(t => t.id === id);
  if (!t || !owns(me, t.owner)) throw new Error('Only this task\'s owner can update its checkpoint');
  if (terminal(t) || t.state === 'requested') throw new Error('Accept an open task before updating its checkpoint');
  if ((t.checkpoint?.revision ?? 0) !== expected) throw new Error('Checkpoint revision changed; read current state before retrying');
  const validated = validateCheckpoint(checkpoint);
  if (validated.revision !== expected + 1 || validated.author.id !== me.id) throw new Error('Invalid checkpoint revision or author');
  if (t.checkpoint) (t.checkpointHistory ??= []).push(t.checkpoint);
  t.checkpoint = validated;
  t.revision++; t.updated = b.clock();
  if (t.requester.pc) queue(b, t, 'update');
  record(b, t);
  await flushTasks(b, t.id);
}

interface RemoteReply {
  ok: boolean;
  error?: string;
  device?: string;
  task_protocol?: number;
  sessions?: Array<{ id: string; name: string }>;
  task?: WorkTask;
}
async function remote(b: Board, args: Record<string, unknown>): Promise<RemoteReply> {
  if (!b.remote) throw new Error('Computeruse bridge is unavailable');
  const out = JSON.parse(await b.remote(args)) as RemoteReply | null;
  if (!out || out.ok !== true) throw new Error(str(out?.error) || 'The other board refused the task operation');
  return out;
}

const flushing = new WeakSet<Board>();
/** A bounded batch on the board's existing timer; no polling of remote boards. */
export async function flushTasks(b: Board, only?: string): Promise<void> {
  if (flushing.has(b) || !b.remote || !b.taskDeliveries.length) return;
  // Never dispatch a handoff that has not reached the atomic board snapshot.
  if (!b.flush()) {
    for (const d of b.taskDeliveries) d.error = 'Board snapshot could not be saved; delivery waits for storage recovery';
    return;
  }
  flushing.add(b);
  const held = new Set<string>();
  try {
    let attempted = 0;
    for (const d of [...b.taskDeliveries]) {
      if (only && d.task !== only) continue;
      if (held.has(d.task)) continue;
      if (d.retryAt > b.clock()) { held.add(d.task); continue; }
      if (attempted++ >= 8) break;
      try {
        const out = await remote(b, { op: 'agent_task', pc: d.to.pc, me: d.actor.name, explicit: true,
          to: d.to.name, to_id: d.to.id, request_id: d.id,
          text: JSON.stringify({ kind: d.kind, actor: d.actor.id, task: d.snapshot }) });
        const t = b.workTasks.find((x) => x.id === d.task);
        if (!out.task || out.task.id !== d.task) throw new Error('Task acknowledgement is missing or mismatched');
        if (out.task && t && d.kind !== 'update') merge(b, t, out.task as WorkTask);
        // A newer update may have superseded this delivery while the network was pending.
        b.taskDeliveries = b.taskDeliveries.filter((x) => x !== d);
        b.save();
      } catch (err) {
        d.attempts++;
        d.error = (err as Error).message.slice(0, 300);
        d.retryAt = b.clock() + Math.min(300_000, 5000 * 2 ** Math.min(d.attempts - 1, 6));
        held.add(d.task);
        b.usage?.({ ts: b.clock(), tool: 'task:delivery', id: d.task, ok: false, attempts: d.attempts });
        b.save();
      }
    }
  } finally { flushing.delete(b); }
}

/** Stop a task on its requester's behalf: the requester session, or its person from the feed (feed.ts). */
export function cancel(b: Board, t: WorkTask, reason: string): void {
  if (terminal(t)) return;
  if (t.owner.pc) {
    t.cancelRequested = reason;
    const offer = b.taskDeliveries.find((d) => d.task === t.id && d.kind === 'offer');
    if (offer) offer.snapshot.cancelRequested = reason;
    queue(b, t, 'cancel');
    record(b, t);
  } else transition(b, t, 'cancelled', reason);
  notice(b, t, t.owner, `Task ${t.id} cancellation requested: ${reason}. Stop this task; preserve unrelated work.`, t.requester, true, 'cancel');
}

export async function taskTool(b: Board, me: Session, args: Args): Promise<string> {
  const op = str(args.op);
  if (op === 'list') {
    const mine = b.workTasks.filter(t => owns(me, t.owner) || owns(me, t.requester));
    // Full history remains an explicit compatibility path, never the default prompt.
    if (args.compact === false) return JSON.stringify(mine.map(t => view(b, t)));
    const scope = str(args.scope) || 'open';
    if (!['open', 'all'].includes(scope)) throw new Error('scope must be open or all');
    const limit = args.limit === undefined ? 20 : Number(args.limit);
    const offset = args.offset === undefined ? 0 : Number(args.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0)
      throw new Error('limit must be 1 to 50 and offset a nonnegative integer');
    const selected = mine.filter(t => scope === 'all' || !terminal(t)).sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
    const clip = (s: string, max: number) => s.length > max ? s.slice(0, max - 1) + '…' : s;
    return JSON.stringify({ tasks: selected.slice(offset, offset + limit).map(t => ({
      id: t.id, owner: t.owner, requester: t.requester, state: t.state, updated: t.updated,
      text: clip(t.text, 200), detail: clip(t.detail, 240),
      truncated: t.text.length > 200 || t.detail.length > 240,
      sync: b.taskDeliveries.some(d => d.task === t.id) ? 'pending' : 'synced',
    })), total: selected.length, next_offset: offset + limit < selected.length ? offset + limit : null,
    hint: 'Use status with id for full evidence and delivery details.' });
  }
  if (op === 'create') {
    const text = required(args.text, 'Task');
    const to = required(args.to, 'Owner');
    if (to.includes(',') || ['all', 'everyone'].includes(to.toLowerCase())) throw new Error('A task has exactly one owner');
    const pc = str(args.pc).toLowerCase();
    if (pc && args.explicit !== true) throw new Error('A remote task requires explicit=true for the human-requested workflow');
    const key = createHash('sha256').update(JSON.stringify([me.id, pc, to.toLowerCase(), str(args.request_id) || text])).digest('hex');
    const old = b.workTasks.find((t) => t.key === key);
    if (old) {
      if (old.text !== text) throw new Error('request_id already belongs to a different task');
      return mutationReply(b, old, args);
    }
    let owner: Endpoint;
    if (pc) {
      const out = await remote(b, { op: 'agent_peers', pc, me: me.name, explicit: true });
      if (out.task_protocol !== 1) throw new Error('The other Kokuban board needs its task bridge version loaded before accepting handoffs');
      const found = (out.sessions ?? []).find((s) => str(s.name).toLowerCase() === to.toLowerCase());
      if (!found || !str(found.id)) throw new Error('Owner is not present on the other PC');
      owner = { id: found.id, name: found.name, pc: str(out.device) || pc };
    } else {
      const found = b.byName(to);
      if (!found || !b.isLive(found) || found.id === me.id) throw new Error('Choose another present session as the owner');
      owner = endpoint(found);
    }
    const afterMs = threshold(args.after_s);
    // Discovery yields to other requests. Recheck before insertion so concurrent
    // retries share the same handoff without a second lock or queue.
    const concurrent = b.workTasks.find((t) => t.key === key);
    if (concurrent) {
      if (concurrent.text !== text) throw new Error('request_id already belongs to a different task');
      return mutationReply(b, concurrent, args);
    }
    const t: WorkTask = { id: randomUUID(), key, requester: endpoint(me), owner, text, state: 'requested', detail: '',
      revision: 0, created: b.clock(), updated: b.clock(), afterMs };
    b.workTasks.push(t);
    if (pc) queue(b, t, 'offer');
    else notice(b, t, owner, `Task ${t.id} from ${me.name}: ${text}\nUse task(op="accept", id="${t.id}") before work; return task(op="complete", id="${t.id}", text="result and evidence") or block with a resumption condition.`, t.requester);
    record(b, t);
    await flushTasks(b, t.id);
    return mutationReply(b, t, args);
  }
  const t = b.workTasks.find((x) => x.id === str(args.id));
  if (!t || (!owns(me, t.owner) && !owns(me, t.requester))) throw new Error('Task is unknown to this session');
  if (op === 'status') return JSON.stringify(view(b, t));
  if (op === 'cancel') {
    if (!owns(me, t.requester)) throw new Error('Only the requester can cancel this task');
    cancel(b, t, required(args.text, 'Cancellation reason'));
  } else {
    if (!owns(me, t.owner)) throw new Error('Only the owner can accept, block or complete this task');
    const state = op === 'accept' || op === 'progress' ? 'accepted' : op === 'block' ? 'blocked' : op === 'complete' ? 'done' : undefined;
    if (!state) throw new Error('op must be create, accept, progress, block, complete, cancel, status or list');
    if (op === 'progress' && t.state !== 'accepted') throw new Error('Accept the task before reporting progress');
    if (args.urgent !== undefined && typeof args.urgent !== 'boolean') throw new Error('urgent must be a boolean');
    transition(b, t, state, op === 'accept' ? str(args.text) : required(args.text, state === 'blocked' ? 'Blocker and resumption condition' : op === 'progress' ? 'Progress' : 'Result and evidence'),
      state === 'blocked' ? { key: blockerKey(args.blocker_key), urgent: args.urgent === true } : {});
    await flushTasks(b, t.id);
    return mutationReply(b, t, args, told(t));
  }
  await flushTasks(b, t.id);
  return mutationReply(b, t, args);
}

/** Requests arrive only through Computeruse's authenticated, allowlisted bridge. */
export async function taskBridge(b: Board, input: Args, from: { pc: string; agent: string }): Promise<object> {
  const raw = str(input.text);
  if (!raw || raw.length > 32000) throw new Error('Task envelope must contain 1 to 32000 characters');
  const payload = JSON.parse(raw) as { kind: Kind; actor: string; task: WorkTask };
  const incoming = payload.task;
  if (!incoming || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(incoming.id) || !str(payload.actor)) throw new Error('Invalid task envelope');
  const actor: Endpoint = { pc: from.pc, name: from.agent, id: payload.actor };
  let t = b.workTasks.find((x) => x.id === incoming.id);
  if (payload.kind === 'offer') {
    const owner = b.sessions.find((s) => s.id === str(input.to_id) && s.name.toLowerCase() === str(input.to).toLowerCase() && b.isLive(s));
    if (!owner || incoming.owner.id !== owner.id || incoming.requester.id !== actor.id || incoming.requester.name !== actor.name) throw new Error('Task offer does not match its requester and current owner');
    if (t) {
      if (!same(t.requester, actor) || t.owner.id !== owner.id || t.text !== incoming.text.replace(/\[kokuban\]/gi, '[kokuban, quoted]')) throw new Error('Task ID already belongs to another request');
    } else {
      t = { id: incoming.id, key: incoming.key, requester: actor, owner: endpoint(owner),
        text: required(incoming.text, 'Task').replace(/\[kokuban\]/gi, '[kokuban, quoted]'), state: 'requested', detail: '',
        revision: 0, created: b.clock(), updated: b.clock(), afterMs: threshold(incoming.afterMs / 1000) };
      b.workTasks.push(t);
      if (!incoming.cancelRequested) notice(b, t, t.owner, `Task ${t.id} from ${actor.name}@${actor.pc}: ${t.text}\nUse task(op="accept", id="${t.id}") before work, then complete with evidence or block with a resumption condition.`, actor);
      record(b, t);
    }
    if (incoming.cancelRequested && !terminal(t)) {
      transition(b, t, 'cancelled', required(incoming.cancelRequested, 'Cancellation reason'));
      notice(b, t, t.owner, `Task ${t.id} cancelled by its requester. Do not start or continue this task.`, actor);
    }
  } else if (payload.kind === 'update') {
    if (!t || !same(t.owner, actor) || str(input.to_id) !== t.requester.id) throw new Error('Task update is not from its owner');
    merge(b, t, incoming);
  } else if (payload.kind === 'cancel') {
    if (!t || !same(t.requester, actor) || str(input.to_id) !== t.owner.id) throw new Error('Task cancellation is not from its requester');
    if (!terminal(t)) {
      const reason = required(incoming.cancelRequested, 'Cancellation reason');
      transition(b, t, 'cancelled', reason);
      notice(b, t, t.owner, `Task ${t.id} cancelled by its requester: ${reason}. Stop this task; preserve unrelated work.`, actor);
    }
  } else throw new Error('Unknown task envelope kind');
  return { ok: true, task: shared(t!) };
}

/** One actionable notice to the requester. No new worker, rerouting or mutation replay. */
export function sweepTasks(b: Board): void {
  for (const t of b.workTasks) {
    if (t.requester.pc || terminal(t) || t.state === 'blocked' || t.alertedAt !== undefined) continue;
    const owner = !t.owner.pc && b.sessions.find((s) => s.id === t.owner.id);
    const left = !t.owner.pc && (!owner || !b.isLive(owner));
    const paused = owner && owner.work === 'paused';
    if (!left && !paused && b.clock() - t.updated < t.afterMs) continue;
    const requester = b.sessions.find((s) => s.id === t.requester.id && b.isLive(s));
    if (!requester) continue; // Keep it eligible if the exact requester session resumes.
    t.alertedAt = b.clock();
    t.alert = left ? 'Owner left before returning a result' : paused ? 'Owner explicitly paused; a human must resume that work' : t.state === 'requested' ? 'Owner has not accepted the task' : 'No task update within the requested interval';
    const pending = b.taskDeliveries.find((d) => d.task === t.id && d.error);
    b.taskMail(requester.id, `Task ${t.id} needs follow-up: ${t.alert}. Owner: ${t.owner.name}${t.owner.pc ? `@${t.owner.pc}` : ''}. ` +
      (pending ? `Delivery is pending: ${pending.error}. ` : '') +
      'You own the next step: inspect the owner, resolve the dependency, or cancel before handing it elsewhere. Do not duplicate work or assume completion.', undefined, t.id, true, t.revision, 'follow-up');
    record(b, t);
  }
  // Bound completed history without discarding unresolved work or unsent results.
  const kept = b.workTasks.filter((t) => !terminal(t) || b.clock() - t.updated < 7 * 86400_000 || b.taskDeliveries.some((d) => d.task === t.id));
  if (kept.length !== b.workTasks.length) { b.workTasks = kept; b.save(); }
}

export const TASK_TOOL = {
  name: 'task', description: 'Explicit owned handoffs. create names one owner (to), text is the task; pc with explicit=true uses the existing bridge. The owner accepts, blocks with a resumption condition, or completes with result/evidence. The requester owns follow-up and cancellation. Retries reuse request_id. Writes return compact acknowledgements; list defaults to bounded open tasks. status(id) returns full evidence; compact=false returns legacy full records.',
  inputSchema: { type: 'object', properties: {
    me: { type: 'string' }, op: { type: 'string', enum: ['create', 'accept', 'progress', 'block', 'complete', 'cancel', 'status', 'list'] },
    to: { type: 'string' }, pc: { type: 'string' }, explicit: { type: 'boolean' }, id: { type: 'string' },
    text: { type: 'string', description: 'For updates, give a brief result, evidence link, and blocker or next action. Keep supporting details in the linked PR or document; include safety limits needed by the recipient.' }, request_id: { type: 'string' },
    compact: { type: 'boolean', description: 'Default compact list/write replies. False returns full legacy records; status always returns full evidence.' },
    blocker_key: { type: 'string', maxLength: 80, description: 'Stable dependency ID for block. Updates to the same key remain visible without repeated wakes; a changed key wakes.' },
    urgent: { type: 'boolean', description: 'For block: explicitly wake for an actionable change even when blocker_key is unchanged.' },
    scope: { type: 'string', enum: ['open', 'all'], description: 'Compact list only; default open includes blocked tasks.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Compact list page size, default 20.' },
    offset: { type: 'integer', minimum: 0, description: 'Compact list offset; follow next_offset until null.' },
    after_s: { type: 'number', minimum: 60, maximum: 86400, description: 'One follow-up notice after this interval without a task update; default 900.' },
  }, required: ['me', 'op'] },
};
