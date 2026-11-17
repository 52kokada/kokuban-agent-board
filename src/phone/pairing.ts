import { createHmac, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import type { Whois } from '../peer.js';
import type { Board } from '../board.js';
import { ChatError, uuid } from '../conversations/contracts.js';
import { equal, hash, PhoneConfig, token, type PhoneSetup } from './settings.js';

export const SETUP_COOKIE = '__Secure-kokuban_setup';
const DURATION = 5 * 60_000;
export function setupPublic(s: PhoneSetup, now = Date.now()) {
  return { id: s.id, stage: (s.stage === 'offered' || s.stage === 'claimed') && s.expires <= now ? 'expired' : s.stage,
    name: s.name, expires: s.expires, deviceId: s.device, notifications: s.notifications ?? false };
}
export class PhonePairing {
  constructor(readonly config: PhoneConfig, private changed: () => void, private clock = Date.now) {}
  private requireLive(s?: PhoneSetup): PhoneSetup {
    if (!s || s.stage === 'cancelled') throw new ChatError('Pairing was cancelled. Start again on the PC.', 410);
    if (!s.device && s.expires <= this.clock()) throw new ChatError('This pairing expired. Show a new QR on the PC.', 410);
    return s;
  }
  async create(id: string) {
    uuid(id); const raw = token();
    const p = this.config.edit(p => {
      if (!p.enabled || !p.origin || !p.adminSecret) throw new ChatError('Enable the phone gateway first', 409);
      let s = p.setups.find(s => s.id === id);
      if (s && s.stage !== 'offered') return;
      if (!s) {
        if (p.setups.filter(s => s.expires > this.clock() && !s.device && s.stage !== 'cancelled').length >= 3) throw new ChatError('Finish or cancel the existing pairing first', 429);
        s = { id, hash: hash(raw), created: this.clock(), expires: this.clock() + DURATION, stage: 'offered' }; p.setups.push(s);
      } else { this.requireLive(s); s.hash = hash(raw); }
      p.setups = p.setups.filter(s => s.expires > this.clock() - 86400000 || s.device).slice(-100);
    });
    const s = p.setups.find(s => s.id === id)!; this.changed();
    if (s.stage !== 'offered') return { setup: setupPublic(s, this.clock()) };
    const url = `${p.origin}/phone/pairing#pair=${raw}`;
    const qr = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 4, width: 320, color: { dark: '#000000', light: '#ffffff' } });
    // URL/QR only return through the owner-capability-protected local PC API.
    return { setup: setupPublic(s, this.clock()), qr, url };
  }
  cancel(id: string) {
    this.config.edit(p => { const s = p.setups.find(s => s.id === uuid(id)); if (!s) throw new ChatError('Pairing not found', 404); if (!s.device) s.stage = 'cancelled'; }); this.changed();
    return { ok: true };
  }
  claim(raw: string, name: string, who: Whois): { setup: ReturnType<typeof setupPublic>; handoff: string } {
    if (!/^[a-f0-9]{64}$/.test(raw) || !name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new ChatError('Invalid phone pairing');
    let handoff = '', chosen!: PhoneSetup;
    this.config.edit(p => {
      const s = this.requireLive(p.setups.find(s => equal(s.hash, hash(raw))));
      if (s.stage !== 'offered' && (s.node !== who.node || s.login !== who.login)) throw new ChatError('This QR has already been used by another device', 409);
      if (s.device) throw new ChatError('This QR has already paired a device', 409);
      if (p.devices.filter(d => !d.revoked).length >= 20) throw new ChatError('Revoke an old phone first', 429);
      handoff = createHmac('sha256', p.adminSecret!).update(`install:${s.id}:${raw}`).digest('hex');
      s.node = who.node; s.login = who.login; s.name = name.trim(); s.handoffHash = hash(handoff); s.stage = 'claimed'; chosen = structuredClone(s);
    }); this.changed(); return { setup: setupPublic(chosen, this.clock()), handoff };
  }
  state(handoff: string, who: Whois): PhoneSetup {
    const s = this.requireLive(this.config.read().setups.find(s => s.handoffHash && equal(s.handoffHash, hash(handoff))));
    if (!handoff || s.node !== who.node || s.login !== who.login) throw new ChatError('This installation belongs to another phone', 403);
    if (s.device && this.config.read().devices.find(d => d.id === s.device)?.revoked) throw new ChatError('This phone was removed. Pair it again on the PC.', 403);
    return s;
  }
  manifest(handoff: string, who: Whois) {
    const s = this.state(handoff, who);
    return { id: '/phone/', name: 'Kokuban', short_name: 'Kokuban', start_url: `/phone/pairing?setup=${s.id}#handoff=${handoff}`, scope: '/phone/', display: 'standalone', background_color: '#f5f5f7', theme_color: '#f5f5f7', icons: [{ src: '/phone/icon.png', sizes: '256x256', type: 'image/png' }] };
  }
  redeem(handoff: string, who: Whois): { setup: ReturnType<typeof setupPublic>; token: string } {
    const old = this.state(handoff, who); let deviceToken = ''; let next!: PhoneSetup;
    if (old.expires <= this.clock()) throw new ChatError('The installation handoff expired. Use the paired app or show a new QR on the PC.', 410);
    this.config.edit(p => {
      const s = this.requireLive(p.setups.find(s => s.id === old.id));
      deviceToken = createHmac('sha256', p.adminSecret!).update(`device:${s.id}:${handoff}`).digest('hex');
      if (!s.device) {
        s.device = randomUUID(); s.stage = 'appOpened';
        p.devices.push({ id: s.device, name: s.name!, hash: hash(deviceToken), login: who.login, node: who.node, created: this.clock(), setupId: s.id });
      } else if (p.devices.find(d => d.id === s.device)?.revoked) throw new ChatError('This phone was removed', 403);
      next = structuredClone(s);
    }); this.changed(); return { setup: setupPublic(next, this.clock()), token: deviceToken };
  }
  complete(deviceId: string, notifications: boolean): void {
    this.config.edit(p => { const d = p.devices.find(d => d.id === deviceId); const s = p.setups.find(s => s.id === d?.setupId); if (s) { s.stage = 'done'; s.notifications = notifications; } }); this.changed();
  }
  list() { return this.config.read().setups.map(s => setupPublic(s, this.clock())); }
}
