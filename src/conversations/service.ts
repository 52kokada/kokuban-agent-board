import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { Board } from '../board.js';
import { personName } from '../cards.js';
import { DATA_DIR, PORT } from '../config.js';
import { feedPcs } from '../feed.js';
import { resolvePc, trustFor } from '../peer.js';
import { ConversationController } from './controller.js';
import { ConversationStore } from './store.js';
import { MaintenanceBarrier } from './maintenance.js';
import { projectCatalog } from './catalog.js';
import { providerRuntime } from './providers/index.js';
import { pickName } from '../names.js';
import { saveAttachment, attachmentPath } from './attachments.js';
import { CHAT_PROTOCOL, ChatError, type Actor, type ChatSession, type Command, type Launch, type RuntimeFactory, type Project } from './contracts.js';

export type ChatRequest = { op: 'capabilities' | 'catalog' | 'list' | 'get' | 'events' | 'history' | 'detail' | 'launch' | 'command'; pc?: string; sessionId?: string; eventId?: string; after?: number; before?: number; waitMs?: number; launch?: Launch; command?: Command };
export class ConversationService {
  private maintenance = new MaintenanceBarrier();
  beginMaintenance(): () => void { return this.maintenance.hold(); }
  readonly notices = new EventEmitter();
  readonly ready: Promise<void>;
  private controller?: ConversationController;
  private problem = 'Shared agent sessions are disabled. Enable KOKUBAN_CONVERSATIONS=1 on the host.';
  private host = os.hostname().toLowerCase();
  private trust: typeof trustFor;
  private attachmentRoot: string;
  constructor(private board: Board, enabled = process.env.KOKUBAN_CONVERSATIONS === '1', file = path.join(DATA_DIR, 'conversations.sqlite'), dependencies: { host?: string; factory?: RuntimeFactory; catalog?: () => Project[]; trust?: typeof trustFor } = {}) {
    this.host = dependencies.host ?? this.host;
    this.attachmentRoot = path.join(path.dirname(file), 'conversation-files');
    this.trust = dependencies.trust ?? trustFor;
    if (!enabled || Number(process.versions.node.split('.')[0]) < 24) {
      if (enabled) this.problem = 'Shared sessions require Node 24 or newer.';
      for (const session of board.sessions) if (session.managed) session.state = 'gone';
      this.ready = Promise.resolve(); return;
    }
    const states = new Map<string, string>();
    const bind = (s: ChatSession) => {
      const id = s.providerId ?? s.id;
      const signature = `${id}:${s.phase}:${s.name}`;
      if (states.get(s.id) === signature) return;
      states.set(s.id, signature);
      if(board.managedNames.has(s.id))board.managedNames.set(s.id,s.name);
      if (id !== s.id) board.sessions = board.sessions.filter(b => !(b.id === s.id && b.managed === s.id));
      const b = board.touch(id, s.cwd, s.provider).session;
      if (s.role === 'chief') for (const other of board.sessions) if (other.id !== id && other.name.toLowerCase() === 'chief') other.name = pickName(new Set(board.sessions.map(s => s.name)));
      b.name = s.name; b.managed = s.id;
      b.state = s.phase === 'closed' ? 'gone' : ['working', 'approval', 'stopping', 'launching'].includes(s.phase) ? 'working' : 'idle';
      b.work = ['stopped', 'recovery'].includes(s.phase) ? 'paused' : ['idle', 'closed'].includes(s.phase) ? 'waiting' : s.phase === 'error' ? 'blocked' : 'active';
      b.doing = `${s.project} · shared conversation · ${s.phase}`;
      board.save();
    };
    const controller = this.controller = new ConversationController(new ConversationStore(file), {
      host: this.host, factory: dependencies.factory ?? ((s, sink) => { if((s.role||s.chiefParent)&&!board.chief)throw new ChatError('Chief guard unavailable; this session was not started',503);return providerRuntime(s, sink, board.chief?.policy(s, sink)); }), catalog: dependencies.catalog ?? projectCatalog, attachmentRoot: this.attachmentRoot,
      notice: (event, session) => this.notices.emit('notice', event, session),
      names: except => board.sessions.filter(s => (!except || s.managed !== except) && board.isLive(s)).map(s => s.name),
      recentNames: () => board.sessions.map(s => s.name),
      reserve: s => { board.managedNames.set(s.id, s.name); bind(s); },
      release: s => { board.managedNames.delete(s.id); const b = board.sessions.find(b => b.managed === s.id); if (b) board.end(b.id); },
      bind, state: s => { if (board.managedNames.has(s.id)) bind(s); },
      // Admission uses the established host CPU/free-memory signal, including conservative unknown state.
      room: () => board.hasRoom(),
    });
    this.ready = controller.ready.catch(() => {
      this.problem = 'Conversation storage could not be opened. Existing coordination remains available.'; this.controller = undefined;
      for (const session of board.sessions) if (session.managed) session.state = 'gone';
      board.save();
    });
  }
  async upload(sessionId: string, name: string, data: Buffer, voiceNote = false) {
    return this.maintenance.run(() => this.uploadUnlocked(sessionId, name, data, voiceNote));
  }
  private async uploadUnlocked(sessionId: string, name: string, data: Buffer, voiceNote: boolean) {
    await this.ready; const c = this.controller; if (!c) throw new ChatError(this.problem, 503);
    await c.get(sessionId);
    const a = { ...saveAttachment(this.attachmentRoot, sessionId, name, data), ...(voiceNote ? { voiceNote: true } : {}) };
    try { await c.attach(sessionId, a, { pc: this.host, person: personName() }); }
    catch (e) { fs.unlinkSync(attachmentPath(this.attachmentRoot, sessionId, a.id)); throw e; }
    return a;
  }
  /** In-process chief authority; never exposed as a caller-selected role in ChatRequest. */
  async chiefLaunch(input: Launch, chiefId?: string): Promise<ChatSession> {
    return this.maintenance.run(() => this.chiefLaunchUnlocked(input, chiefId));
  }
  private async chiefLaunchUnlocked(input: Launch, chiefId?: string): Promise<ChatSession> {
    await this.ready; if (!this.controller) throw new ChatError(this.problem, 503);
    return this.controller.launch(input, { pc: this.host, person: 'Chief' }, chiefId ? { chiefParent: chiefId } : { role: 'chief', project: { id: '__chief_home', name: 'All repositories', path: path.join(os.homedir(), 'githubprojects') } });
  }
  async chiefCommand(command: Command): Promise<ChatSession> {
    return this.maintenance.run(() => this.chiefCommandUnlocked(command));
  }
  private async chiefCommandUnlocked(command: Command): Promise<ChatSession> {
    await this.ready; if (!this.controller) throw new ChatError(this.problem, 503);
    if (command.op === 'approve') throw new ChatError('The chief cannot answer approvals', 403);
    return this.controller.command(command, { pc: this.host, person: 'Chief' });
  }
  async attachment(sessionId: string, id: string) {
    await this.ready; if (!this.controller) throw new ChatError(this.problem, 503);
    return this.controller.file(sessionId, id);
  }
  async local(input: ChatRequest, signal?: AbortSignal): Promise<unknown> {
    await this.ready;
    if (input.pc && ![this.host, 'local', this.host.split('.')[0]].includes(input.pc.toLowerCase())) {
      const target = feedPcs().find(pc => pc === input.pc!.toLowerCase() || pc.split('.')[0] === input.pc!.toLowerCase());
      if (!target || this.trust(target) !== 'work') throw new ChatError('Select a PC paired with work access', 403);
      const device = await resolvePc(target);
      // Once the request may have left this PC, its outcome is unknown: never answer with a definitive status.
      let response: Response, body: string;
      try {
        response = await fetch(`http://${device}:${PORT}/peer`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'conversations', request: { ...input, pc: undefined }, person: personName() }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        });
        body = await response.text();
      } catch { throw new ChatError('The host PC did not answer. The request may still have been applied there.', 502); }
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { throw new ChatError(`The host sent an unreadable answer (${response.status}).`, 502); }
      if (!response.ok) {
        const reason = (parsed as { error?: unknown })?.error;
        throw new ChatError(typeof reason === 'string' && reason ? reason.slice(0, 300) : `The host refused this request (${response.status}). Check its version and work pairing.`, response.status, response.status === 429 && (parsed as { definitive?: unknown })?.definitive === true);
      }
      return parsed;
    }
    return this.handle(input, { pc: this.host, person: personName() }, signal);
  }
  async remote(input: unknown, pc: string, person: unknown, signal?: AbortSignal): Promise<unknown> {
    // The /peer handler already authenticated pc and enforces work access. Never relay this request again.
    if (!input || typeof input !== 'object' || 'pc' in input) throw new ChatError('Invalid host-local conversation request');
    const label = typeof person === 'string' ? person.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').trim().slice(0, 80) : '';
    const result = await this.handle(input as ChatRequest, { pc, person: label || pc.split('.')[0] }, signal);
    if (this.trust(pc) !== 'work') throw new ChatError('Work access was revoked', 403);
    return result;
  }
  private async handle(input: ChatRequest, actor: Actor, signal?: AbortSignal): Promise<unknown> {
    return ['launch', 'command'].includes(input.op)
      ? this.maintenance.run(() => this.handleUnlocked(input, actor, signal))
      : this.handleUnlocked(input, actor, signal);
  }
  private async handleUnlocked(input: ChatRequest, actor: Actor, signal?: AbortSignal): Promise<unknown> {
    await this.ready;
    if (input.op === 'capabilities') return { protocol: CHAT_PROTOCOL, enabled: Boolean(this.controller), host: this.host, problem: this.controller ? null : this.problem };
    const c = this.controller; if (!c) throw new ChatError(this.problem, 503);
    // The on-demand CPU sampler returns unknown after a long idle period. Give it
    // a fresh interval before admission; the controller still checks current limits.
    if ((input.op === 'launch' || (input.op === 'command' && input.command?.op === 'restart')) && !this.board.hasRoom())
      await delay(300, undefined, { signal });
    switch (input.op) {
      case 'catalog': return { projects: c.catalog().map(p => ({ ...p, path: '' })) };
      case 'list': return { sessions: await c.list() };
      case 'get': return { session: await c.get(input.sessionId ?? '') };
      case 'history': return await c.history(input.sessionId ?? '', input.before);
      case 'events': return { events: await c.page(input.sessionId ?? '', input.after ?? 0, Math.min(input.waitMs ?? 0, 8000), signal) };
      case 'detail': return { events: [await c.detail(input.sessionId ?? '', input.eventId ?? '')].filter(Boolean) };
      case 'launch': if (!input.launch) throw new ChatError('Launch details are required'); return { session: await c.launch(input.launch, actor) };
      case 'command': {
        if (!input.command) throw new ChatError('Command details are required');
        if (['stop', 'resume', 'shutdown', 'restart'].includes(input.command.op) && !Number.isSafeInteger(input.command.controlRevision)) throw new ChatError('Refresh the session before using its controls', 409);
        return { session: await c.command(input.command, actor) };
      }
      default: throw new ChatError('Unknown conversation operation');
    }
  }
  async close(): Promise<void> { await this.ready; await this.controller?.close(); }
}
