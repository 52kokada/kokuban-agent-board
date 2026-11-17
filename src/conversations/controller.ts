import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { pickName } from '../names.js';
import { ConversationStore } from './store.js';
import { attachmentPath, MAX_UPLOAD, type Attachment, type RuntimeAttachment } from './attachments.js';
import { ChatError, digest, publicSession, text, uuid, type Actor, type ChatEvent, type ChatSession, type Command, type Launch, type Project, type Runtime, type RuntimeFactory, type RuntimeSink } from './contracts.js';

export interface ControllerOptions {
  host: string; factory: RuntimeFactory; catalog: () => Project[];
  names?: (exceptId?: string) => string[]; recentNames?: () => string[]; reserve?: (s: ChatSession) => void; release?: (s: ChatSession) => void;
  bind?: (s: ChatSession) => void; changed?: () => void; room?: () => boolean;
  state?: (s: ChatSession) => void;
  maxProcesses?: number; maxTurns?: number;
  attachmentRoot?: string;
  notice?: (event: ChatEvent, session: ChatSession) => void;
}
interface Live { runtime: Runtime; epoch: number }

/** Single host authority. All durable transitions precede provider effects and acknowledgements. */
export class ConversationController {
  readonly events = new EventEmitter();
  readonly ready: Promise<void>;
  private locks = new Map<string, Promise<unknown>>();
  private live = new Map<string, Live>();
  private decisions = new Map<string, (answer: boolean) => void>();
  private dispatching = new Set<string>();
  private disposed = false;

  constructor(readonly store: ConversationStore, private options: ControllerOptions) {
    this.events.setMaxListeners(100);
    this.ready = this.recover();
  }
  private async recover(): Promise<void> {
    await this.store.ready;
    for (const old of await this.store.list()) {
      if (old.phase === 'closed') continue;
      const s = structuredClone(old);
      s.phase = 'recovery'; s.problem = 'The board restarted. Review unfinished work, then explicitly restart this session.';
      s.epoch++;
      for (const m of s.messages) if (m.state === 'running') m.state = 'uncertain';
      for (const a of s.approvals) if (a.state === 'pending') a.state = 'expired';
      await this.save(s, 'recovery', s.problem);
      this.options.reserve?.(s);
    }
  }
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    this.locks.set(key, next);
    void next.finally(() => { if (this.locks.get(key) === next) this.locks.delete(key); }).catch(() => {});
    return next;
  }
  private async save(s: ChatSession, kind: string, message?: string, actor?: Actor, data?: unknown, receipt?: { actor: string; id: string; hash: string }): Promise<void> {
    const expected = s.revision; s.revision++; s.updated = Date.now();
    s.controlRevision ??= 0;
    s.messages = s.messages.filter(m => !['complete', 'interrupted'].includes(m.state));
    s.approvals = s.approvals.filter(a => a.state === 'pending' || this.decisions.has(a.id));
    const event: ChatEvent = { id: randomUUID(), sessionId: s.id, ts: s.updated, kind, text: message, actor, data };
    await this.store.commit(s, expected, [event], receipt ? { ...receipt, receipt: publicSession(s) } : undefined);
    try { this.options.notice?.(event, s); } catch { /* Notification failure never rolls back a committed agent command. */ }
    this.options.state?.(s);
    this.events.emit(s.id); this.options.changed?.();
  }
  private async session(id: string): Promise<ChatSession> {
    const s = await this.store.get(uuid(id)); if (!s) throw new ChatError('Conversation not found. Refresh the conversation list.', 410); return s;
  }
  private async duplicate(actor: Actor, id: string, hash: string): Promise<ChatSession | null> {
    const r = await this.store.receipt(actor.pc, id);
    if (!r) return null;
    if (r.hash !== hash) throw new ChatError('This command ID was already used for different content', 409);
    return r.receipt;
  }
  async list(): Promise<ChatSession[]> { await this.ready; return (await this.store.list()).map(publicSession); }
  async get(id: string): Promise<ChatSession> { await this.ready; return publicSession(await this.session(id)); }
  async detail(id: string, eventId: string): Promise<ChatEvent | null> { await this.ready; await this.session(id); return this.store.detail(id, uuid(eventId)); }
  async attach(id: string, attachment: Attachment, actor: Actor): Promise<void> {
    await this.ready;
    await this.serial(id, async () => {
      const s = await this.session(id);
      await this.save(s, 'attachment', attachment.name, actor, { attachment });
    });
  }
  async file(id: string, attachmentId: string): Promise<RuntimeAttachment> {
    await this.ready; await this.session(id);
    // The attachment event id is independent of the uploaded file id; use the bounded attachment index.
    const a = await this.store.attachment(id, uuid(attachmentId));
    if (!a || !this.options.attachmentRoot) throw new ChatError('Attachment not found', 404);
    return { ...a, path: attachmentPath(this.options.attachmentRoot, id, a.id) };
  }
  catalog(): Project[] { return this.options.catalog(); }
  /** The latest bounded page before a cursor (or the newest), for opening and explicit Load earlier. */
  async history(id: string, before?: number): Promise<{ events: ChatEvent[]; before: number; hasMore: boolean }> {
    await this.ready; await this.session(id);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new ChatError('Invalid history cursor');
    return this.store.history(id, before);
  }
  async page(id: string, after = 0, waitMs = 0, signal?: AbortSignal): Promise<ChatEvent[]> {
    await this.ready; await this.session(id);
    if (!Number.isSafeInteger(after) || after < 0) throw new ChatError('Invalid event cursor');
    let page = await this.store.page(id, after);
    if (page.length || waitMs <= 0 || signal?.aborted) return page;
    // Attach before the second read, closing the fetch/subscribe race.
    let wake!: () => void;
    const changed = new Promise<void>(resolve => { wake = resolve; });
    this.events.once(id, wake);
    const timer = setTimeout(wake, Math.min(waitMs, 10000));
    signal?.addEventListener('abort', wake, { once: true });
    try { page = await this.store.page(id, after); if (!page.length) await changed; return await this.store.page(id, after); }
    finally { clearTimeout(timer); this.events.off(id, wake); signal?.removeEventListener('abort', wake); }
  }
  async launch(input: Launch, actor: Actor, trusted?: { role?: 'chief'; chiefParent?: string; project?: Project }): Promise<ChatSession> {
    await this.ready;
    const id = uuid(input.id), hash = digest(trusted ? { input, trusted } : input);
    return this.serial('__launch', async () => {
      const duplicate = await this.duplicate(actor, id, hash); if (duplicate) return duplicate;
      if (this.disposed) throw new ChatError('Board is shutting down', 503);
      if (!['codex', 'claude'].includes(input.provider)) throw new ChatError('Choose Codex or Claude');
      const project = trusted?.project ?? this.catalog().find(p => p.id === input.projectId); if (!project) throw new ChatError('Choose an available project on the host PC');
      const all = await this.store.list();
      if (trusted?.role === 'chief' && all.some(s => s.role === 'chief')) throw new ChatError('This PC already has a chief', 409);
      if(trusted?.role==='chief')for(const previous of all.filter(s=>s.name.toLowerCase()==='chief'&&s.phase!=='closed')){
        previous.name=pickName(new Set(all.map(s=>s.name)));
        await this.save(previous,'renamed','Reserved Chief name handed to the chief runtime; existing conversation state preserved',actor);
      }
      const active = all.filter(s => !['closed', 'error', 'recovery'].includes(s.phase));
      if (active.length >= (this.options.maxProcesses ?? 4) || this.options.room?.() === false) throw new ChatError('Host resources are busy; try again after stopping a session', 429, true);
      const names = [...(this.options.names?.() ?? []), ...all.filter(s => s.phase !== 'closed').map(s => s.name)];
      const chosen = input.name ? text(input.name, 'Name', 40) : pickName(new Set(names), Math.random, [...(this.options.recentNames?.() ?? []), ...all.map(s => s.name)]);
      if (chosen.toLowerCase() === 'chief' && trusted?.role !== 'chief') throw new ChatError('Chief is reserved for this PC’s chief', 409);
      if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(chosen)) throw new ChatError('Use letters, numbers, underscores or hyphens for the name');
      if (trusted?.role !== 'chief' && names.some(n => n.toLowerCase() === chosen.toLowerCase())) throw new ChatError('That name is already in use', 409);
      const s: ChatSession = { id, name: chosen, provider: input.provider, project: project.name, cwd: project.path, host: this.options.host,
        phase: 'launching', epoch: 1, revision: -1, controlRevision: 0, created: Date.now(), updated: Date.now(), messages: [], approvals: [],
        ...(trusted?.role ? { role: trusted.role } : {}), ...(trusted?.chiefParent ? { chiefParent: trusted.chiefParent } : {}) };
      if (input.text) s.messages.push({ id: randomUUID(), text: text(input.text, 'Message'), actor, state: 'queued' });
      // Reserve synchronously before SQLite yields, so legacy SessionStart cannot steal this name.
      this.options.reserve?.(s);
      try { await this.save(s, 'launched', `${s.name} on ${s.host} · ${s.project}`, actor, { firstMessage: s.messages[0] }, { actor: actor.pc, id, hash }); }
      catch (e) { this.options.release?.(s); throw e; }
      void this.open(s.id).catch(e => this.fail(s.id, e));
      return publicSession(s);
    });
  }
  async command(input: Command, actor: Actor): Promise<ChatSession> {
    await this.ready;
    const id = uuid(input.id), hash = digest(input);
    // Actor-level serialization also prevents reuse of one command ID across two sessions.
    const execute = () => this.serial(`actor:${actor.pc}`, () => this.serial(input.sessionId, async () => {
      const duplicate = await this.duplicate(actor, id, hash); if (duplicate) return duplicate;
      const s = await this.session(input.sessionId);
      if (input.epoch !== s.epoch) throw new ChatError('The agent session changed. Refresh before acting.', 409);
      if (input.resume !== undefined && (typeof input.resume !== 'boolean' || !['message', 'restart'].includes(input.op))) throw new ChatError('Resume is only supported with a message or restart');
      if (input.resume && input.controlRevision !== (s.controlRevision ?? 0)) throw new ChatError('Another control changed this session. Refresh before resuming.', 409);
      if (['stop', 'resume', 'shutdown', 'restart'].includes(input.op) && input.controlRevision !== undefined && input.controlRevision !== (s.controlRevision ?? 0)) throw new ChatError('New work or another control changed this session. Refresh before acting.', 409);
      const receipt = { actor: actor.pc, id, hash };
      let effect: (() => void) | undefined;
      let description: string = input.op;
      switch (input.op) {
        case 'message': {
          if (['closed', 'closing', 'error', 'recovery'].includes(s.phase)) throw new ChatError('Restart the session before sending a message', 409);
          if (input.resume && s.phase !== 'stopped') throw new ChatError('The paused session changed. Refresh before resuming.', 409);
          if (s.messages.filter(m => m.state === 'queued').length >= 100) throw new ChatError('Message queue is full', 429, true);
          const body = text(input.text, 'Message');
          if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length > 10)) throw new ChatError('Choose at most ten attachments');
          const attachments = input.attachments?.map(a => uuid(a));
          const files = await Promise.all((attachments ?? []).map(a => this.file(s.id, a)));
          if (files.filter(a => a.mime.startsWith('image/')).reduce((bytes, a) => bytes + a.bytes, 0) > MAX_UPLOAD) throw new ChatError('Choose images totaling at most 10 MB per message', 413);
          s.messages.push({ id, text: body, actor, state: 'queued', ...(attachments?.length ? { attachments } : {}) }); description = body;
          // Explicit Resume and send is one durable command: a lost response cannot
          // leave an accepted message held between separate message/resume requests.
          if (input.resume) { s.phase = 'idle'; s.problem = undefined; s.controlRevision = (s.controlRevision ?? 0) + 1; }
          effect = () => void this.pump(s.id); break;
        }
        case 'stop': {
          if (['launching', 'closed', 'closing', 'recovery', 'error'].includes(s.phase)) throw new ChatError('This agent is not ready to stop', 409);
          if (s.phase !== 'stopped' && input.turnId !== s.turnId) throw new ChatError('The active turn changed. Refresh before stopping.', 409);
          const running = s.messages.some(m => m.state === 'running');
          s.phase = running ? 'stopping' : 'stopped';
          this.expire(s); description = `Stopped by ${actor.person}`;
          if (running) effect = () => { void this.live.get(s.id)?.runtime.interrupt(s.turnId).catch(e => this.fail(s.id, e)); };
          break;
        }
        case 'resume':
          if (s.phase !== 'stopped') throw new ChatError('Only a stopped session can resume', 409);
          s.phase = 'idle'; s.problem = undefined; description = `Resumed by ${actor.person}`; effect = () => void this.pump(s.id); break;
        case 'shutdown':
          if (s.phase !== 'closed') { s.phase = 'closing'; this.expire(s); effect = () => void this.shutdown(s.id); }
          description = `Shut down by ${actor.person}`; break;
        case 'restart':
          if (!['closed', 'error', 'recovery'].includes(s.phase)) throw new ChatError('This agent is already running', 409);
          if (this.live.has(s.id)) throw new ChatError('Shut down the previous process before restarting', 409);
          if ((await this.store.list()).filter(x => x.id !== s.id && !['closed', 'error', 'recovery'].includes(x.phase)).length >= (this.options.maxProcesses ?? 4) || this.options.room?.() === false) throw new ChatError('Host resources are busy', 429, true);
          if ((this.options.names?.(s.id) ?? []).some(n => n.toLowerCase() === s.name.toLowerCase()) || (await this.store.list()).some(x => x.id !== s.id && x.phase !== 'closed' && x.name.toLowerCase() === s.name.toLowerCase())) throw new ChatError('That name is now in use. Launch a new conversation with another name.', 409);
          s.epoch++; s.phase = 'launching'; s.problem = undefined; s.turnId = undefined; this.expire(s);
          this.options.reserve?.(s);
          // Legacy callers keep work held. Reconnect and resume is an explicit choice;
          // pump only takes queued messages, never uncertain previous attempts.
          effect = () => void this.open(s.id, !input.resume).catch(e => this.fail(s.id, e)); description = `Restarted by ${actor.person}${input.resume ? '; queued work will resume' : ''}`; break;
        case 'approve': {
          const a = s.approvals.find(a => a.id === input.approvalId);
          if (!a || a.epoch !== s.epoch || a.state !== 'pending' || s.phase !== 'approval') throw new ChatError('This request has already been answered or expired', 409);
          if (typeof input.allow !== 'boolean') throw new ChatError('An allow or deny decision is required');
          a.state = input.allow ? 'allowed' : 'denied'; a.actor = actor;
          s.phase = s.approvals.some(a => a.state === 'pending') ? 'approval' : 'working';
          description = `${actor.person} ${input.allow ? 'allowed' : 'denied'} ${a.kind}`;
          effect = () => { const resolve = this.decisions.get(a.id); this.decisions.delete(a.id); resolve?.(input.allow!); }; break;
        }
        default: throw new ChatError('Unknown conversation command');
      }
      // Messages and approval answers must not invalidate a Stop for the same turn.
      if (['stop', 'resume', 'shutdown', 'restart'].includes(input.op)) s.controlRevision = (s.controlRevision ?? 0) + 1;
      await this.save(s, input.op, description, actor, { commandId: id, approvalId: input.approvalId, allow: input.allow }, receipt);
      effect?.(); this.resolveExpired(s); return publicSession(s);
    }));
    return input.op === 'restart' ? this.serial('__launch', execute) : execute();
  }
  private expire(s: ChatSession): void {
    for (const a of s.approvals) if (a.state === 'pending') { a.state = 'expired'; }
  }
  private resolveExpired(s: ChatSession): void {
    for (const a of s.approvals) if (a.state === 'expired') { this.decisions.get(a.id)?.(false); this.decisions.delete(a.id); }
  }
  private async open(id: string, held = false): Promise<void> {
    let s = await this.session(id);
    if (s.phase !== 'launching' || this.disposed) return;
    const epoch = s.epoch;
    const post = (fn: (current: ChatSession) => Promise<void>) => {
      void this.serial(id, async () => { const current = await this.session(id); if (current.epoch === epoch && !['closed', 'closing', 'error', 'recovery'].includes(current.phase)) await fn(current); }).catch(e => this.fail(id, e));
    };
    let delta = '', deltaData: unknown, flushTimer: NodeJS.Timeout | undefined;
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer); flushTimer = undefined;
      if (!delta) return;
      const body = delta, data = deltaData; delta = '';
      post(async current => { await this.save(current, 'assistant_delta', body, undefined, data); });
    };
    const sink: RuntimeSink = {
      event: (kind, body, data) => {
        if (kind === 'assistant_delta') {
          if (delta.length + (body?.length ?? 0) > 16000) flush();
          delta += body ?? ''; deltaData = data;
          if (!flushTimer) { flushTimer = setTimeout(flush, 50); flushTimer.unref(); }
          return;
        }
        flush();
        const details = body && body.length > 60000 ? { data, fullText: body } : data;
        post(async current => {
          if (kind === 'usage') {
            const value = data as Record<string, unknown>;
            const keys = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
            if (keys.every(key => typeof value?.[key] === 'number' && Number.isFinite(value[key]) && Number(value[key]) >= 0))
              current.tokenUsage = { inputTokens: Number(value.inputTokens), outputTokens: Number(value.outputTokens), cacheReadInputTokens: Number(value.cacheReadInputTokens), cacheCreationInputTokens: Number(value.cacheCreationInputTokens), observedAt: Date.now(), source: current.provider };
          }
          await this.save(current, kind, body?.slice(0, 60000), undefined, details);
        });
      },
      turn: turnId => post(async current => { current.turnId = turnId; const m = current.messages.find(m => m.state === 'running'); if (m) m.turnId = turnId; await this.save(current, 'turn_started', undefined, undefined, { turnId }); }),
      complete: (status, detail) => { flush(); post(async current => {
        const m = current.messages.find(m => m.state === 'running');
        if (!m) return;
        if (m) m.state = status === 'complete' ? 'complete' : status === 'interrupted' ? 'interrupted' : 'uncertain';
        this.expire(current); current.turnId = undefined;
        // A failed turn may have had effects. Hold the queue for review, while retaining
        // the healthy runtime so an explicit Resume does not require a shutdown/restart.
        current.phase = current.phase === 'stopping' || status !== 'complete' ? 'stopped' : 'idle';
        if (status === 'failed') current.problem = detail ?? 'Provider turn failed';
        await this.save(current, 'turn_completed', detail, undefined, { status, messageActor: m.actor }); this.resolveExpired(current);
        // Completed messages live in the append-only history, not every summary response.
        // Failure also frees a global turn slot. Other conversations must not
        // remain queued just because this conversation is held for review.
        setImmediate(() => { for (const key of this.live.keys()) void this.pump(key); });
      }); },
      approval: (requestId, kind, description, options) => new Promise(resolve => {
        void this.serial(id, async () => {
          const current = await this.session(id);
          if (current.epoch !== epoch || !['working', 'approval'].includes(current.phase)) { resolve(false); return; }
          const a = { id: randomUUID(), epoch, requestId, kind, description: description.slice(0, 12000), options, state: 'pending' as const };
          current.approvals.push(a); current.phase = 'approval';
          await this.save(current, 'approval_requested', a.description, undefined, { id: a.id, kind, options });
          this.decisions.set(a.id, resolve);
        }).catch(() => resolve(false));
      }),
      exit: detail => { flush(); void this.fail(id, new Error(detail), epoch); },
    };
    const runtime = this.options.factory(s, sink);
    this.live.set(id, { runtime, epoch });
    const providerId = await runtime.start();
    await this.serial(id, async () => {
      s = await this.session(id);
      if (s.epoch !== epoch || s.phase !== 'launching') { await runtime.close(); return; }
      s.providerId = providerId; s.phase = held ? 'stopped' : 'idle';
      this.options.bind?.(s); await this.save(s, 'ready', held ? 'Ready; queued messages remain held until Resume' : 'Ready');
    });
    if (!held) void this.pump(id);
  }
  private async pump(id: string): Promise<void> {
    if (this.dispatching.has(id) || this.disposed) return;
    this.dispatching.add(id);
    let sent = false;
    try {
      let sending: Promise<string | undefined> | undefined;
      await this.serial('__dispatch', () => this.serial(id, async () => {
        const s = await this.session(id), live = this.live.get(id);
        if (!live || s.phase !== 'idle') return;
        if ([...this.live.keys()].length && (await this.store.list()).filter(s => ['working', 'approval', 'stopping'].includes(s.phase)).length >= (this.options.maxTurns ?? 2)) return;
        const m = s.messages.find(m => m.state === 'queued'); if (!m) return;
        m.state = 'running'; s.phase = 'working';
        await this.save(s, 'message_started', m.text, m.actor, { messageId: m.id });
        // Begin writing while still holding the session lock; Stop cannot overtake a claimed send.
        sent = true;
        const files = await Promise.all((m.attachments ?? []).map(a => this.file(s.id, a)));
        sending = live.runtime.send(`${m.actor.person} (${m.actor.pc}) says:\n${m.text}`, files);
        void sending.catch(() => {});
      }));
      if (sending) await sending;
    } catch (e) { await this.fail(id, e); }
    finally {
      this.dispatching.delete(id);
      if (sent && !this.disposed) setImmediate(() => { void this.store.get(id).then(s => { if (s?.phase === 'idle' && s.messages.some(m => m.state === 'queued')) void this.pump(id); }).catch(() => {}); });
    }
  }
  private async shutdown(id: string): Promise<void> {
    try {
      const live = this.live.get(id);
      const current = await this.session(id); this.resolveExpired(current);
      await live?.runtime.close();
      this.live.delete(id);
      await this.serial(id, async () => {
        const s = await this.session(id); if (s.phase !== 'closing') return;
        for (const m of s.messages) if (m.state === 'running') m.state = 'interrupted';
        s.phase = 'closed'; s.turnId = undefined; await this.save(s, 'closed', 'Agent process ended; conversation retained'); this.options.release?.(s);
      });
    } catch {
      await this.serial(id, async () => {
        const s = await this.session(id); s.phase = 'error'; s.problem = 'Process shutdown could not be confirmed. Retry Shut down before restarting.';
        await this.save(s, 'shutdown_unconfirmed', s.problem);
      }).catch(() => {});
    }
  }
  private async fail(id: string, error: unknown, epoch?: number): Promise<void> {
    if (this.disposed) return;
    await this.serial(id, async () => {
      const s = await this.session(id);
      if (epoch !== undefined && s.epoch !== epoch || ['closed', 'closing', 'recovery', 'error'].includes(s.phase)) return;
      s.phase = 'error'; s.problem = 'Agent connection failed. Review unfinished work before restarting.';
      for (const m of s.messages) if (m.state === 'running') m.state = 'uncertain';
      this.expire(s); await this.save(s, 'error', s.problem); this.resolveExpired(s);
      const live = this.live.get(id);
      try { await live?.runtime.close(); this.live.delete(id); }
      catch { s.problem = 'The agent failed and process cleanup is unconfirmed. Shut down before restarting.'; await this.save(s, 'cleanup_unconfirmed', s.problem); }
      setImmediate(() => { for (const key of this.live.keys()) void this.pump(key); });
    }).catch(() => {});
  }
  async close(): Promise<void> {
    this.disposed = true;
    for (const resolve of this.decisions.values()) resolve(false); this.decisions.clear();
    await Promise.allSettled([...this.live.values()].map(l => l.runtime.close())); this.live.clear();
    await Promise.allSettled([...this.locks.values()]); await this.store.close();
  }
}
