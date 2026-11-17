import { continuationLimit } from '../loop-limit.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import webpush from 'web-push';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import type { Board, Session } from '../board.js';
import { QUIET_MS } from '../board.js';
import { personName, waiting } from '../cards.js';
import { DATA_DIR } from '../config.js';
import type { ChatEvent, ChatSession } from '../conversations/contracts.js';
import { phoneVapidCredential } from '../vault.js';
import { DEFAULT_NOTIFICATIONS, PhoneConfig, type NotificationCategory, type PhoneDevice } from './settings.js';

export interface PushEvent { key: string; category: NotificationCategory; target: string; at: number; title: string; summary: string; condition?: string }
interface Job { device: string; category: NotificationCategory; due: number; events: PushEvent[]; test?: boolean; id?: string; attempts?: number }
interface Receipt { id: string; device: string; at: number; status: 'sending' | 'accepted' | 'failed' | 'expired' | 'received'; category: NotificationCategory }
interface State { observed: Record<string, number>; jobs: Job[]; receipts: Receipt[] }
interface Presence { at: number; visible: boolean; targets: string[]; device: string; sequence: number }
export const FOREGROUND_MS = 10000;
export interface PushDeps {
  file?: string; clock?: () => number; windowMs?: number;
  credential?: typeof phoneVapidCredential;
  sender?: (subscription: webpush.PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<{ statusCode: number }>;
}
/** Short user-facing text, never tool/file/vault output, with credential-shaped spans removed. */
export function notificationText(value: string, fallback = 'Open Kokuban for details'): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (/-----BEGIN|\b(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|token)\s*[:=]\s*\S+|\b(?:sk-|ghp_|xox[baprs]-|AKIA)[A-Za-z0-9_-]+|\b[0-9a-fA-F]{32,}\b|\b[A-Za-z0-9+/_-]{64,}={0,2}/i.test(text)) return fallback;
  return (text.replace(/https?:\/\/\S+/g, '[link]') || fallback).slice(0, 120);
}
export function pushSubscription(value: unknown): value is webpush.PushSubscription {
  try {
    const s = value as webpush.PushSubscription; const u = new URL(s.endpoint);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || s.endpoint.length > 2048) return false;
    if (!(u.hostname.endsWith('.push.apple.com') || u.hostname === 'fcm.googleapis.com' || u.hostname.endsWith('.push.services.mozilla.com') || u.hostname.endsWith('.notify.windows.com'))) return false;
    return /^[\w-]+$/.test(s.keys.auth) && /^[\w-]+$/.test(s.keys.p256dh) && Buffer.from(s.keys.auth, 'base64url').length === 16 && Buffer.from(s.keys.p256dh, 'base64url').length === 65;
  } catch { return false; }
}
export function deepLink(target: string): string {
  const [kind, ...rest] = target.split(':'); const id = rest.join(':');
  if (kind === 'conversation') return `/phone/?conversation=${encodeURIComponent(id)}`;
  if (kind === 'session') return `/phone/?session=${encodeURIComponent(id)}`;
  if (kind === 'card' || kind === 'task') return `/phone/?thread=${encodeURIComponent(target)}`;
  return '/phone/';
}

export class PhoneNotifications {
  private state: State;
  private clock: () => number;
  private file: string;
  private initialized: boolean;
  private present = new Map<string, Presence>();
  private summaries = new Map<string, string>();
  private conversations = new Map<string, { phase: string; approvals: Array<{ id: string; state: string }> }>();
  private scanning = false;
  private dirty = false;
  private busy = false;
  private timer?: NodeJS.Timeout;
  private keys?: Promise<webpush.VapidKeys>;
  private credential: typeof phoneVapidCredential;
  private sender: NonNullable<PushDeps['sender']>;
  constructor(private board: Board, readonly config: PhoneConfig, private deps: PushDeps = {}) {
    this.file = deps.file ?? path.join(DATA_DIR, 'phone-notifications.json'); this.clock = deps.clock ?? Date.now;
    this.credential = deps.credential ?? phoneVapidCredential; this.sender = deps.sender ?? webpush.sendNotification;
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!this.state || typeof this.state.observed !== 'object' || !Array.isArray(this.state.jobs) || !Array.isArray(this.state.receipts)) throw new Error('Invalid notification state');
      this.initialized = true;
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Phone notification state is unreadable; preserved for repair'); this.state = { observed: {}, jobs: [], receipts: [] }; this.initialized = false; }
  }
  private save(): void {
    const protectedCards = new Set(this.board.cards.filter(waiting).map(c => `card:${c.id}:${c.ts}`));
    const keep = Object.entries(this.state.observed).sort((a, b) => b[1] - a[1]);
    this.state.observed = Object.fromEntries(keep.filter(([key], i) => i < 5000 || protectedCards.has(key)));
    this.state.receipts = this.state.receipts.slice(-100);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp'; const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
  }
  async publicKey(): Promise<string> { return (await this.vapid()).publicKey; }
  private vapid(): Promise<webpush.VapidKeys> {
    this.keys ??= (async () => {
      const saved = await this.credential('get'); if (saved) return saved;
      const generated = webpush.generateVAPIDKeys(); await this.credential('set', generated); return generated;
    })().catch(e => { this.keys = undefined; throw e; }); return this.keys;
  }
  presence(device: string, visible: boolean, targets: string[], client = 'legacy', sequence = 0): void {
    const key = device + ':' + client, previous = this.present.get(key);
    if (previous && sequence < previous.sequence) return;
    if (!previous) {
      const own = [...this.present].filter(([,p]) => p.device === device);
      if (own.length >= 8) this.present.delete(own[0][0]);
    }
    this.present.set(key, { at: this.clock(), visible, targets, device, sequence });
  }
  private foreground(device: string): boolean {
    // Foreground updates arrive through SSE/feed and its badge, not system push.
    // Do not mark the underlying card/task read or remove any history.
    return [...this.present.values()].some(p => p.device === device && p.visible && this.clock() >= p.at && this.clock() - p.at < FOREGROUND_MS);
  }
  private active(e: PushEvent): boolean {
    if (!e.condition) return true;
    const [kind, id, request] = e.condition.split(':');
    if (kind === 'card') return this.board.cards.some(c => c.id === Number(id) && waiting(c));
    if (kind === 'blocked') return this.board.sessions.some(s => s.id === id && s.state !== 'gone' && s.work === 'blocked');
    if (kind === 'approval') return Boolean(this.conversations.get(id)?.approvals.some(a => a.id === request && a.state === 'pending'));
    if (kind === 'error') return this.conversations.get(id)?.phase === 'error';
    if (kind === 'stalled') return this.board.sessions.some(s => s.id === id && this.running(s) && s.work === 'active' && this.clock() - s.seen > QUIET_MS);
    return true;
  }
  // "May be stuck" means a turn is genuinely running with no update. A session keeps its
  // stale work='active' record after its turn ends, is stopped, closed or awaiting recovery;
  // a finished turn is done, not stuck, so never flag it. A managed session is running only
  // while its conversation phase is 'working'; an external session has no phase, but its host
  // state is set to 'idle' at Stop, so 'working' there means a turn is actually in progress.
  private running(s: Session): boolean {
    if (!this.board.isLive(s)) return false;
    if (!s.managed) return s.state === 'working';
    return this.conversations.get(s.managed)?.phase === 'working';
  }
  observe(event: PushEvent, baseline = false, onlyDevice?: string): void {
    if (event.key in this.state.observed) return;
    this.state.observed[event.key] = this.clock();
    if (!baseline) for (const d of this.config.read().devices) {
      if (onlyDevice && d.id !== onlyDevice) continue;
      if (d.revoked || !pushSubscription(d.push) || !(d.notifications ?? DEFAULT_NOTIFICATIONS)[event.category]) continue;
      let job = this.state.jobs.find(j => !j.test && j.device === d.id && j.category === event.category);
      if (!job) { job = { device: d.id, category: event.category, due: this.clock() + (this.deps.windowMs ?? 20000), events: [] }; this.state.jobs.push(job); }
      const previous = job.events.findIndex(e => e.target === event.target);
      const item = { ...event, title: notificationText(event.title), summary: notificationText(event.summary) };
      if (previous >= 0) job.events[previous] = item;
      else if (job.events.length < 50) job.events.push(item);
    }
    if (this.scanning) this.dirty = true; else this.save();
  }
  conversation(event: ChatEvent, s: ChatSession): void {
    this.conversations.set(s.id, { phase: s.phase, approvals: s.approvals.map(a => ({ id: a.id, state: a.state })) });
    if (this.conversations.size > 1000) this.conversations.delete(this.conversations.keys().next().value!);
    const target = `conversation:${s.id}`;
    if (event.kind === 'message_started') this.summaries.set(s.id, '');
    if (event.kind === 'assistant_delta') this.summaries.set(s.id, ((this.summaries.get(s.id) ?? '') + (event.text ?? '')).slice(-512));
    if (event.kind === 'approval_requested') this.observe({ key: event.id, category: 'blocked', target, at: event.ts, title: `${s.name} needs you`, summary: 'Review an agent approval in Kokuban', condition: `approval:${s.id}:${(event.data as { id?: string })?.id}` });
    if (event.kind === 'turn_completed' && (event.data as { status?: string })?.status === 'complete' && !(s.role==='chief'&&(event.data as any)?.messageActor?.person==='Chief')) this.observe({ key: event.id, category: 'finished', target, at: event.ts, title: `${s.name} finished`, summary: this.summaries.get(s.id) || 'The agent finished its turn. Open the result.' });
    if (!s.chiefParent && ['error', 'shutdown_unconfirmed', 'cleanup_unconfirmed'].includes(event.kind)) this.observe({ key: event.id, category: 'stuck', target, at: event.ts, title: `${s.name} needs attention`, summary: s.problem ?? 'Agent connection failed', condition: `error:${s.id}` });
    if (event.kind === 'closed' || event.kind === 'error') this.summaries.delete(s.id);
    if (event.kind === 'closed') this.conversations.delete(s.id);
  }
  private scan(): void {
    this.scanning = true;
    try {
    const now = this.clock(); const me = personName().toLowerCase(); const baseline = !this.initialized;
    for (const c of this.board.cards) if (waiting(c) && (!c.person || c.person.toLowerCase() === me)) this.observe({ key: `card:${c.id}:${c.ts}`, category: 'blocked', target: `card:${osName()}:${c.id}`, at: c.ts, title: `${c.from.agent}: ${c.question}`, summary: c.question, condition: `card:${c.id}` }, baseline);
    for (const t of this.board.workTasks) if (t.state === 'done') this.observe({ key: `task:${t.id}:done`, category: 'finished', target: `task:${t.id}`, at: t.updated, title: `${t.owner.name} finished`, summary: t.detail || t.text }, baseline);
    for (const s of this.board.sessions.filter(s => this.board.isLive(s))) {
      if (s.work === 'blocked') this.observe({ key: `blocked:${s.id}:${s.doingAt ?? s.seen}`, category: 'blocked', target: s.managed ? `conversation:${s.managed}` : `session:${s.id}`, at: now, title: `${s.name} is blocked`, summary: s.next || s.doing || 'The agent needs your help', condition: `blocked:${s.id}` }, baseline);
      if (s.work === 'active' && now - s.seen > QUIET_MS && this.running(s)) this.observe({ key: `stalled:${s.id}:${s.seen}`, category: 'stuck', target: s.managed ? `conversation:${s.managed}` : `session:${s.id}`, at: now, title: `${s.name} may be stuck`, summary: 'Active work has had no update for 30 minutes', condition: `stalled:${s.id}` }, baseline);
      if (s.continues >= continuationLimit(now)) this.observe({ key: `loop:${s.id}:${s.joined}`, category: 'stuck', target: s.managed ? `conversation:${s.managed}` : `session:${s.id}`, at: now, title: `${s.name} reached its loop limit`, summary: 'Automatic continuation stopped. Review the session.' }, baseline);
    }
    } finally { this.scanning = false; }
    if (!this.initialized || this.dirty) { this.initialized = true; this.dirty = false; this.save(); }
  }
  private digest(): void {
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(this.clock()));
    const part=(kind:string)=>parts.find(p=>p.type===kind)!.value;
    const day=`${part('year')}-${Number(part('month'))}-${Number(part('day'))}`;
    const minute=`${part('hour')}:${part('minute')}`;
    for (const d of this.config.read().devices) {
      const settings = d.notifications ?? DEFAULT_NOTIFICATIONS;
      if (d.revoked || !settings.digest || !pushSubscription(d.push) || settings.digestTime > minute || d.digestDay === day) continue;
      const written = this.board.chief?.digest(day);
      if (this.board.chief && !written) continue;
      this.config.edit(p => { const current = p.devices.find(x => x.id === d.id)!; current.digestDay = day; });
      const cards = this.board.cards.filter(c => waiting(c) && (!c.person || c.person.toLowerCase() === personName().toLowerCase())).length;
      const done = this.board.workTasks.filter(t => t.state === 'done' && this.clock() - t.updated < 86400000).length;
      this.observe({ key: `digest:${d.id}:${day}`, category: 'digest', target: 'board', at: this.clock(), title: 'Kokuban morning digest', summary: written ?? `${this.board.sessions.filter(s => this.board.isLive(s)).length} sessions, ${done} finished tasks, ${cards} open questions` }, false, d.id);
      this.save();
    }
  }
  async tick(): Promise<void> {
    if (this.busy || !this.config.read().enabled) return; this.busy = true;
    try {
      this.scan(); this.digest();
      for (const [id, presence] of this.present) if (this.clock() - presence.at > 60000) this.present.delete(id);
      for (const job of [...this.state.jobs]) {
        if (job.due > this.clock()) continue;
        const device = this.config.read().devices.find(d => d.id === job.device);
        const events = job.events.filter(e => this.active(e) && (job.test || !this.foreground(job.device)));
        if (!device || device.revoked || (!job.test && !(device.notifications ?? DEFAULT_NOTIFICATIONS)[job.category]) || !pushSubscription(device.push) || !events.length) {
          this.state.jobs = this.state.jobs.filter(j => j !== job); this.save(); continue;
        }
        job.id ??= randomUUID(); job.due = this.clock() + 30000; this.save(); // An interrupted dispatch retries with the same notification identity.
        const result = await this.deliver(device, job.category, events, job.id);
        job.attempts = (job.attempts ?? 0) + 1;
        if (result.status !== 'failed' || job.attempts >= 6 || this.clock() - events[0].at > 3600000) this.state.jobs = this.state.jobs.filter(j => j !== job);
        else job.due = this.clock() + Math.min(300000, 30000 * 2 ** (job.attempts - 1));
        this.save();
      }
    } finally { this.busy = false; }
  }
  private async deliver(device: PhoneDevice, category: NotificationCategory, events: PushEvent[], id: string = randomUUID()): Promise<{ id: string; status: Receipt['status'] }> {
    const first = events[0];
    const title = events.length === 1 ? first.title : `${events.length} ${category === 'finished' ? 'results are ready' : 'sessions need you'}`;
    const body = events.length === 1 ? first.summary : `${first.title}. ${first.summary}`.slice(0, 120);
    const payload = JSON.stringify({ id, title, body, category, url: deepLink(first.target), tag: `kokuban-${id}` });
    let receipt = this.state.receipts.find(r => r.id === id);
    if (!receipt) { receipt = { id, device: device.id, at: this.clock(), status: 'sending', category }; this.state.receipts.push(receipt); }
    if (receipt.status === 'received') return { id, status: 'received' };
    receipt.status = 'sending'; this.save();
    let status: Receipt['status'] = 'failed';
    try {
      const keys = await this.vapid(); const current = this.config.read().devices.find(d => d.id === device.id);
      if (!current || current.revoked || !pushSubscription(current.push)) { receipt.status = 'expired'; this.save(); return { id, status: 'expired' }; }
      await this.sender(current.push, payload, { vapidDetails: { subject: this.config.read().origin!, ...keys }, timeout: 10000, TTL: 3600, urgency: category === 'blocked' || category === 'stuck' ? 'high' : 'normal' }); status = 'accepted';
    } catch (e) {
      if ([404, 410].includes(Number((e as { statusCode?: number }).statusCode))) { this.config.edit(p => { const d = p.devices.find(d => d.id === device.id); if (d) delete d.push; }); status = 'expired'; }
      // Never log a provider exception: it can contain an endpoint or credential.
    }
    if (this.state.receipts.find(r => r.id === id)?.status === 'received') return { id, status: 'received' };
    receipt.status = status; receipt.at = this.clock();
    this.save(); return { id, status: receipt.status };
  }
  async test(device: PhoneDevice, delaySeconds = 0): Promise<string> {
    if (!pushSubscription(device.push)) throw new Error('Enable notifications on this device first');
    if (delaySeconds === 20) {
      const id = randomUUID(); this.state.jobs.push({ id, device: device.id, category: 'finished', due: this.clock() + 20000, test: true,
        events: [{ key: id, category: 'finished', target: 'board', at: this.clock(), title: 'Kokuban app-closed test', summary: 'This notification should arrive with Kokuban closed. Tap to reopen it.' }] }); this.save(); return id;
    }
    const result = await this.deliver(device, 'finished', [{ key: randomUUID(), category: 'finished', target: 'board', at: this.clock(), title: 'Kokuban phone test', summary: 'Open Kokuban to confirm this notification arrived.' }]);
    if (result.status === 'failed') throw new Error('The push service did not accept the test. Try again later.'); return result.id;
  }
  received(device: string, id: string): void { const r = this.state.receipts.find(r => r.id === id && r.device === device); if (r) { r.status = 'received'; this.save(); } }
  receipts(): Receipt[] { return structuredClone(this.state.receipts); }
  start(): void { this.timer ??= setInterval(() => { void this.tick().catch(() => {}); }, 1000); this.timer.unref(); void this.tick().catch(() => {}); }
  close(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
const osName = (): string => os.hostname().toLowerCase();
