import * as http from 'node:http';
import * as fs from 'node:fs';
import { isIP } from 'node:net';
import type { Board } from '../board.js';
import type { Card } from '../cards.js';
import { act, feedView, listen, readerLang, self } from '../feed.js';
import { whois, type Whois } from '../peer.js';
import { MAX_UPLOAD } from '../conversations/attachments.js';
import { ChatError, type ChatEvent, type ChatSession } from '../conversations/contracts.js';
import { PhoneConfig, DEFAULT_NOTIFICATIONS, enablePhone, equal, hash, token, type PhoneDevice, type PhoneSettings } from './settings.js';
import { PhoneNotifications, pushSubscription, type PushDeps, type PushEvent } from './notifications.js';
import { pushWorker } from './push-client.js';
import { PhoneUsageCache } from './usage.js';
import { PhonePairing, SETUP_COOKIE, setupPublic } from './pairing.js';
import { pairingShell, pairingClient } from './pairing-client.js';
import { shell, client, manifest } from './shell.js';
import { PhoneVoice } from '../voice/service.js';
import { phoneFileResponse } from './file-response.js';
import { phoneRoster } from './roster.js';

const COOKIE = '__Secure-kokuban_phone';
const gateways = new WeakMap<Board, PhoneGateway>();
export function chiefNotify(board: Board, event: PushEvent): void { gateways.get(board)?.notify(event); }
export async function chiefUsage(board: Board): Promise<unknown> { return gateways.get(board)?.usageSnapshot(); }
export interface PhoneDeps { config?: PhoneConfig; lookup?: (ip: string) => Promise<Whois>; push?: PushDeps; usage?: PhoneUsageCache; voice?: PhoneVoice }
export function startPhoneNotifications(board: Board): void { try { gateways.get(board)?.start(); } catch { console.error('Phone notifications unavailable; existing notification data was preserved.'); } }
export async function stopPhoneNotifications(board: Board): Promise<void> { await gateways.get(board)?.close(); }
export function phoneDecision(board: Board, card: Card, choice: string): Promise<string> | null { return gateways.get(board)?.decide(card, choice) ?? null; }
function cookie(req: http.IncomingMessage, name: string): string {
  return (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1) ?? '';
}
function setCookie(name: string, value: string, seconds: number): string { return `${name}=${value}; Path=/phone; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`; }
async function body(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of req) { size += part.length; if (size > max) throw new ChatError('Request is too large', 413); parts.push(part); }
  return Buffer.concat(parts);
}
export class PhoneGateway {
  readonly config: PhoneConfig;
  private lookup: (ip: string) => Promise<Whois>;
  private notifier?: PhoneNotifications;
  private detach?: () => void;
  private usage: PhoneUsageCache;
  private pairing: PhonePairing;
  private voice: PhoneVoice;
  private streams = new Map<string, number>();
  private stream(key: string, res: http.ServerResponse): boolean {
    if ((this.streams.get(key) ?? 0) >= 4 || [...this.streams.values()].reduce((n, count) => n + count, 0) >= 32) return false;
    this.streams.set(key, (this.streams.get(key) ?? 0) + 1);
    res.on('close', () => { const count = (this.streams.get(key) ?? 1) - 1; if (count) this.streams.set(key, count); else this.streams.delete(key); }); return true;
  }
  constructor(private board: Board, private deps: PhoneDeps = {}) {
    this.config = deps.config ?? new PhoneConfig(); this.lookup = deps.lookup ?? whois; this.usage = deps.usage ?? new PhoneUsageCache();
    this.pairing = new PhonePairing(this.config, () => this.board.save()); gateways.set(board, this);
    this.voice = deps.voice ?? new PhoneVoice();
  }
  private notifications(): PhoneNotifications { return this.notifier ??= new PhoneNotifications(this.board, this.config, this.deps.push); }
  notify(event: PushEvent): void { this.notifications().observe(event); }
  async usageSnapshot() { const usage = await this.usage.get(); const sessions = this.board.conversations ? (await this.board.conversations.local({ op: 'list' }) as { sessions: ChatSession[] }).sessions : []; return { ...usage, sessionTokens: sessions.filter(s => s.tokenUsage).map(s => ({ sessionId: s.id, ...s.tokenUsage })) }; }
  start(): void {
    if (!this.config.read().enabled || this.detach) return;
    if (!this.config.read().adminSecret) this.config.edit(p => { p.adminSecret = token(); });
    const n = this.notifications();
    const listener = n.conversation.bind(n); this.board.conversations?.notices.on('notice', listener);
    this.board.onLoopLimit = (key, id) => n.observe({ key: `peer-loop:${hash(key)}`, category: 'stuck', target: id ? `session:${id}` : 'board', at: Date.now(), title: 'Agent loop stopped', summary: 'Two agents reached the exchange limit. Review their work.' });
    this.detach = () => { this.board.conversations?.notices.off('notice', listener); this.board.onLoopLimit = null; }; n.start();
  }
  async close(): Promise<void> { this.detach?.(); this.detach = undefined; this.notifier?.close(); this.config.close(); await this.voice.close(); }
  private device(req: http.IncomingMessage, p: PhoneSettings, who: Whois): PhoneDevice | undefined {
    const t = cookie(req, COOKIE); if (!/^[a-f0-9]{64}$/.test(t)) return;
    return p.devices.find(d => !d.revoked && d.login === who.login && d.node === who.node && equal(d.hash, hash(t)));
  }
  decide(card: Card, _choice: string): Promise<string> | null {
    return card.from.agent === 'Phone pairing' ? Promise.resolve('Code pairing is retired. Use iPhones → Pair iPhone in the PC app. Existing paired devices are unchanged.') : null;
  }
  async admin(input: Record<string, unknown>, proof = ''): Promise<unknown> {
    const p = this.config.read();
    if (!(input.op === 'enable' && !p.adminSecret) && (!p.adminSecret || !equal(proof, p.adminSecret))) throw new ChatError('Owner-local administration capability required', 403);
    if (input.op === 'enable') { await enablePhone(this.config); this.start(); return { ok: true, origin: this.config.read().origin, path: '/phone/' }; }
    if (input.op === 'pair-create') return this.pairing.create(String(input.id ?? ''));
    if (input.op === 'pair-state') return { setups: this.pairing.list() };
    if (input.op === 'pair-cancel') return this.pairing.cancel(String(input.id ?? ''));
    if (input.op === 'push-status') return { receipts: this.notifications().receipts() };
    if (input.op === 'revoke') {
      this.config.edit(s => {
        const d = s.devices.find(d => d.id === input.id); if (!d) throw new ChatError('Device not found', 404);
        d.revoked = Date.now(); delete d.push;
        for (const p of s.pairs) if (p.device === d.id) p.state = 'refused';
      }); return { ok: true };
    }
    if (input.op !== 'list') throw new ChatError('Choose enable, list or revoke');
    const current = this.config.read();
    return { enabled: Boolean(current.enabled), origin: current.origin, devices: current.devices.map(({ id, name, node, created, revoked }) => ({ id, name, node, created, revoked })) };
  }
  async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const incoming = new URL(req.url ?? '/', 'http://localhost');
    if (incoming.pathname !== '/phone' && !incoming.pathname.startsWith('/phone/')) return false;
    const send = (status: number, value: unknown, type = 'application/json',csp?:string): true => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'content-security-policy': csp??"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(Buffer.isBuffer(value) ? value : type.startsWith('application/json') ? JSON.stringify(value) : String(value)); return true;
    };
    try {
      let p = this.config.read();
      const match = /^\/phone\/_gateway\/([a-f0-9]{64})(\/.*)?$/.exec(incoming.pathname);
      if (!p.enabled || !p.secret || !match || !equal(match[1], p.secret)) return send(403, { error: 'Use the paired tailnet phone address' });
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return send(403, { error: 'Phone ingress refused' });
      const address = String(req.headers['x-forwarded-for'] ?? '').split(',').pop()!.trim();
      const login = req.headers['tailscale-user-login'];
      if (!isIP(address) || typeof login !== 'string' || login !== p.owner) return send(403, { error: 'Owner Tailscale identity required' });
      const who = await this.lookup(address);
      if (!who.node || who.login !== login) return send(403, { error: 'Tailscale identity verification failed' });
      if (req.headers.origin && req.headers.origin !== p.origin) return send(403, { error: 'Origin refused' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Cross-site request refused' });
      const route = match[2] ?? '/'; const get = req.method === 'GET';
      if (!get && (req.method !== 'POST' || req.headers['x-kokuban-phone'] !== '1' || req.headers.origin !== p.origin)) return send(403, { error: 'Phone request header and matching origin required' });
      const json = async () => {
        if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new ChatError('Use JSON', 415);
        return JSON.parse((await body(req, 160000)).toString('utf8')) as Record<string, any>;
      };
      // Pairing/bootstrap resources require verified ingress and owner identity, before a device exists.
      if (get && route === '/app.js') return send(200, client, 'text/javascript; charset=utf-8');
      if (get && route === '/chief-avatar.svg') return send(200, fs.readFileSync(new URL('../../../assets/chief-scout.svg', import.meta.url)), 'image/svg+xml');
      if (get && route === '/chief-avatar.png') return send(200, fs.readFileSync(new URL('../../../assets/chief-scout.png', import.meta.url)), 'image/png');
      if (get && route === '/icon.png') return send(200, fs.readFileSync(new URL('../../../assets/icon.png', import.meta.url)), 'image/png');
      if (get && route === '/manifest.webmanifest') return send(200, manifest, 'application/manifest+json');
      if (get && route === '/sw.js') { res.setHeader('Service-Worker-Allowed', '/phone/'); return send(200, pushWorker, 'text/javascript; charset=utf-8'); }
      if (get && route === '/pair') return send(200, pairingShell, 'text/html; charset=utf-8');
      if (get && route === '/pairing') return send(200, pairingShell, 'text/html; charset=utf-8');
      if (get && route === '/pairing.js') return send(200, pairingClient, 'text/javascript; charset=utf-8');
      if (get && route === '/pairing/manifest') return send(200, JSON.stringify(this.pairing.manifest(incoming.searchParams.get('handoff') || cookie(req, SETUP_COOKIE), who)), 'application/manifest+json');
      if (!get && route === '/pairing/claim') {
        const i = await json(); const result = this.pairing.claim(String(i.nonce ?? ''), String(i.name ?? 'My iPhone'), who);
        res.setHeader('set-cookie', setCookie(SETUP_COOKIE, result.handoff, 300)); return send(200, result);
      }
      if (!get && route === '/pairing/redeem') {
        const i = await json(); if (i.standalone !== true) throw new ChatError('Open Kokuban from your Home Screen to finish pairing', 409);
        const result = this.pairing.redeem(String(i.handoff || cookie(req, SETUP_COOKIE)), who);
        res.setHeader('set-cookie', [setCookie(COOKIE, result.token, 365 * 86400), setCookie(SETUP_COOKIE, String(i.handoff || cookie(req, SETUP_COOKIE)), Math.max(1, Math.ceil((result.setup.expires - Date.now()) / 1000)))]); return send(200, { setup: result.setup });
      }
      if (get && route === '/pairing/state') return send(200, { setup: setupPublic(this.pairing.state(cookie(req, SETUP_COOKIE), who)) });
      if (get && route === '/pairing/events') {
        this.pairing.state(cookie(req, SETUP_COOKIE), who);
        if (!this.stream('setup:' + hash(cookie(req, SETUP_COOKIE)), res)) return send(429, { error: 'Too many open phone streams' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        let signature = '';
        const update = () => { try { const setup = setupPublic(this.pairing.state(cookie(req, SETUP_COOKIE), who)); const next = JSON.stringify(setup); if (next !== signature) { if (res.writableLength > 65536) return res.end(); signature = next; res.write(`event: pairing\ndata: ${next}\n\n`); } } catch { res.write('event: pairing\ndata: {"stage":"expired"}\n\n'); res.end(); } };
        this.config.changes.on('change', update); update(); const timer = setInterval(update, 1000);
        res.on('close', () => { this.config.changes.off('change', update); clearInterval(timer); }); return true;
      }
      if (route === '/pair/start' || route === '/pair/state') return send(409, { error: 'Use iPhones → Pair iPhone in the PC app. Code pairing no longer grants access.' });
      const device = this.device(req, p, who);
      if (!device) {
        if (get && route === '/') { res.setHeader('location', '/phone/pair'); return send(303, {}); }
        return send(401, { error: 'Pair this device on the PC first' });
      }
      const stillPaired = () => { const current = this.config.read(); if (!current.enabled || current.owner !== who.login || !this.device(req, current, who)) throw new ChatError('Device access was revoked', 401); };
      if (get && route === '/chief') return send(200, { session: await this.board.chief?.session() ?? null });
      if (get && route === '/usage') {
        const usage = await this.usage.get();
        const sessions = this.board.conversations ? (await this.board.conversations.local({ op: 'list' }) as { sessions: Array<{ id: string; tokenUsage?: unknown }> }).sessions : [];
        stillPaired(); return send(200, { ...usage, sessionTokens: sessions.filter(s => s.tokenUsage).map(s => ({ sessionId: s.id, ...s.tokenUsage as object })) });
      }
      if (get && route === '/settings') return send(200, { device: { id: device.id, name: device.name }, notifications: { ...DEFAULT_NOTIFICATIONS, ...device.notifications }, subscribed: pushSubscription(device.push) });
      if (!get && route === '/settings') {
        const input = await json(); stillPaired(); const v = input.notifications;
        if (!v || ['blocked', 'finished', 'stuck', 'digest'].some(key => typeof v[key] !== 'boolean') || typeof v.digestTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.digestTime)) throw new ChatError('Choose four notification toggles and a valid local time');
        this.config.edit(s => { const d = s.devices.find(d => d.id === device.id)!; d.notifications = { blocked: v.blocked, finished: v.finished, stuck: v.stuck, digest: v.digest, digestTime: v.digestTime }; });
        return send(200, { ok: true });
      }
      if (get && route === '/push-key') return send(200, { publicKey: await this.notifications().publicKey() });
      if (!get && route === '/presence') {
        const i = await json(); stillPaired();
        if (typeof i.visible !== 'boolean' || !Array.isArray(i.targets) || i.targets.length > 100 || i.targets.some((t: unknown) => typeof t !== 'string' || t.length > 200 || !/^(board$|(?:card|task|conversation|session):)/.test(t))) throw new ChatError('Invalid phone presence');
        if ((i.client !== undefined || i.sequence !== undefined) && (typeof i.client !== 'string' || !/^[a-f0-9-]{36}$/i.test(i.client) || !Number.isSafeInteger(i.sequence) || i.sequence < 0)) throw new ChatError('Invalid phone presence sequence');
        this.notifications().presence(device.id, i.visible, i.targets, i.client ?? 'legacy', i.sequence ?? 0); return send(200, { ok: true });
      }
      if (!get && route === '/push-test') { const i = await json(); stillPaired(); if (![0, 20].includes(i.delaySeconds ?? 0)) throw new ChatError('Choose an immediate or 20-second test'); return send(200, { id: await this.notifications().test(device, i.delaySeconds ?? 0) }); }
      if (!get && route === '/push-received') {
        const i = await json(); stillPaired(); if (typeof i.id !== 'string' || i.id.length > 80) throw new ChatError('Invalid receipt');
        this.notifications().received(device.id, i.id); return send(200, { ok: true });
      }
      if (!get && route === '/pairing/finish') { const i = await json(); stillPaired(); if (i.skipNotifications !== true) throw new ChatError('Choose whether to skip notifications'); this.pairing.complete(device.id, false); return send(200, { ok: true }); }
      if (get && route === '/session') {
        const s = this.board.sessions.find(s => s.id === incoming.searchParams.get('id'));
        return s ? send(200, { session: { id: s.id, name: s.name, status: this.board.status(s), work: s.work, doing: this.board.summary(s), next: s.next, managed: s.managed } }) : send(404, { error: 'Session not found' });
      }
      if (get && route === '/sessions') {
        const result = this.board.conversations ? await this.board.conversations.local({ op: 'list' }) as { sessions: ChatSession[] } : { sessions: [] };
        stillPaired(); return send(200, { sessions: phoneRoster(this.board, result.sessions) });
      }
      if (get && route === '/') return send(200, shell, 'text/html; charset=utf-8');
      if (get && route === '/feed') return send(200, { api: 1, lang: readerLang(), ...feedView(this.board) });
      if (get && route === '/card-file') {
        const match = /^card:([^:]+):(\d+)$/.exec(incoming.searchParams.get('thread') ?? ''), index = incoming.searchParams.get('n') ?? '';
        if (!match || match[1] !== self() || !/^\d+$/.test(index) || !Number.isSafeInteger(Number(index))) return send(404, { error: 'Card file not found' });
        const file = this.board.cards.find(c => c.id === Number(match[2]))?.files[Number(index)];
        if (!file) return send(404, { error: 'Card file not found' });
        try { const bytes = fs.readFileSync(file.path),headers=phoneFileResponse(bytes,file.name); res.setHeader('content-disposition',headers.disposition); return send(200,bytes,headers.type,headers.csp); }
        catch { return send(404, { error: 'Card file not found' }); }
      }
      if (!get && route === '/act') { const i = await json(); stillPaired(); return send(200, { ok: true, done: await act(this.board, String(i.thread ?? ''), String(i.action ?? ''), String(i.text ?? '')) }); }
      if (!get && route === '/conversations') {
        if (!this.board.conversations) throw new ChatError('Conversations unavailable', 503);
        const input = await json(); stillPaired(); const abort = new AbortController(); res.on('close', () => abort.abort());
        return send(200, await this.board.conversations.local(input as never, abort.signal));
      }
      if (!get && route === '/upload') {
        if (!this.board.conversations) throw new ChatError('Conversations unavailable', 503);
        const data = await body(req, MAX_UPLOAD); stillPaired();
        const sessionId = incoming.searchParams.get('session') ?? '', voiceNote = incoming.searchParams.get('voice') === '1';
        const a = await this.board.conversations.upload(sessionId, incoming.searchParams.get('name') ?? '', data, voiceNote);
        const audio = voiceNote ? await this.board.conversations.attachment(sessionId, a.id) : undefined;
        return send(200, { attachment: a, ...(audio ? { voice: this.voice.start(device.id, audio.path) } : {}) });
      }
      if (get && route === '/voice') { const result = this.voice.get(device.id, incoming.searchParams.get('id') ?? ''); return result ? send(200, result) : send(404, { error: 'Voice note not found' }); }
      if (get && route === '/file') {
        if (!this.board.conversations) throw new ChatError('Conversations unavailable', 503);
        const a = await this.board.conversations.attachment(incoming.searchParams.get('session') ?? '', incoming.searchParams.get('id') ?? '');
        const bytes=fs.readFileSync(a.path),headers=phoneFileResponse(bytes,a.name);
        res.setHeader('content-disposition',headers.disposition);
        return send(200,bytes,headers.type,headers.csp);
      }
      if (!get && route === '/push-subscription') {
        const i = await json(); stillPaired(); const sub = i.subscription;
        if (sub !== null && !pushSubscription(sub)) throw new ChatError('Invalid push subscription');
        this.config.edit(s => { const d = s.devices.find(x => x.id === device.id)!; if (sub === null) delete d.push; else d.push = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }; });
        if (sub) this.pairing.complete(device.id, true);
        return send(200, { stored: true, deliveryEnabled: true });
      }
      if (get && route === '/events') {
        if (!this.stream(device.id, res)) return send(429, { error: 'Too many open phone streams' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
        res.write('retry: 2000\ndata: changed\n\n');
        const valid = () => { try { const current = this.config.read(); return current.enabled && current.owner === who.login && Boolean(this.device(req, current, who)); } catch { return false; } };
        const notify = () => { if (!valid() || res.writableLength > 65536) res.end(); else res.write('data: changed\n\n'); };
        const stop = listen(this.board, notify);
        const hinted = new Set<string>(); let hintTimer: NodeJS.Timeout | undefined;
        const conversation = (_event: ChatEvent, session: ChatSession) => {
          if (hinted.size < 100) hinted.add(session.id);
          hintTimer ??= setTimeout(() => {
            hintTimer = undefined;
            if (!valid() || res.writableLength > 65536) return res.end();
            for (const sessionId of hinted) res.write(`event: conversation\ndata: ${JSON.stringify({ sessionId })}\n\n`);
            hinted.clear();
          }, 100);
        };
        this.board.conversations?.notices.on('notice', conversation);
        const beat = setInterval(() => { if (!valid()) res.end(); else if (res.writableLength > 65536) res.end(); else res.write(': beat\n\n'); }, 1000);
        res.on('close', () => { stop(); clearInterval(beat); if (hintTimer) clearTimeout(hintTimer); this.board.conversations?.notices.off('notice', conversation); }); return true;
      }
      return send(404, { error: 'Phone route not found' });
    } catch (e) { return send((e as { status?: number }).status ?? 400, { error: e instanceof ChatError ? e.message : 'Phone request could not be completed', definitive: (e as ChatError).definitive === true }); }
  }
}
