import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { SETTINGS } from '../cards.js';
import { PORT } from '../config.js';

export type NotificationCategory = 'blocked' | 'finished' | 'stuck' | 'digest';
export interface NotificationSettings { blocked: boolean; finished: boolean; stuck: boolean; digest: boolean; digestTime: string }
export const DEFAULT_NOTIFICATIONS: NotificationSettings = { blocked: true, finished: true, stuck: true, digest: true, digestTime: '08:00' };
export interface PhoneDevice { id: string; name: string; hash: string; login: string; node: string; created: number; revoked?: number; push?: unknown; notifications?: NotificationSettings; digestDay?: string; setupId?: string }
export interface PhonePair { hash: string; code: string; name: string; login: string; node: string; card: number; created: number; state: 'pending' | 'allowed' | 'refused'; device?: string }
export interface PhoneSetup { id: string; hash: string; created: number; expires: number; stage: 'offered' | 'claimed' | 'appOpened' | 'done' | 'cancelled'; login?: string; node?: string; name?: string; handoffHash?: string; device?: string; notifications?: boolean }
export interface PhoneSettings { enabled?: boolean; secret?: string; adminSecret?: string; owner?: string; origin?: string; devices: PhoneDevice[]; pairs: PhonePair[]; setups: PhoneSetup[] }
export const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
export const token = (): string => randomBytes(32).toString('hex');
export function equal(a: string, b: string): boolean { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export class PhoneConfig {
  readonly changes = new EventEmitter().setMaxListeners(64);
  private cached?: Record<string, unknown>;
  private watching?: fs.FSWatcher;
  constructor(readonly file = SETTINGS.file) {}
  private root(): Record<string, unknown> {
    if (this.cached) return structuredClone(this.cached);
    if (!this.watching) {
      try { this.watching = fs.watch(path.dirname(this.file), { persistent: false }, (_event, name) => { if (!name || name.toString() === path.basename(this.file)) { this.cached = undefined; this.changes.emit('change'); } }); this.watching.on('error', () => { this.cached = undefined; this.watching?.close(); this.watching = undefined; }); } catch { /* A not-yet-created directory is watched on the next read. */ }
    }
    try { const v = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error(); this.cached = v; return structuredClone(v); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('Phone settings cannot be read; existing settings were preserved'); }
  }
  read(): PhoneSettings {
    const p = this.root().phone as Partial<PhoneSettings> | undefined;
    return { ...p, devices: p?.devices ?? [], pairs: p?.pairs ?? [], setups: p?.setups ?? [] };
  }
  edit(fn: (s: PhoneSettings) => void): PhoneSettings {
    // A synchronous writer must not overwrite an external edit before fs.watch is delivered.
    this.cached = undefined;
    const root = this.root(); const s = { ...(root.phone as PhoneSettings | undefined), ...this.read() }; fn(s); root.phone = s;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.phone-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(root, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, this.file); this.cached = root; this.changes.emit('change'); return s;
  }
  close(): void { this.watching?.close(); this.watching = undefined; this.cached = undefined; }
}
export function tailscale(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('tailscale', args, { windowsHide: true, timeout: 15000, maxBuffer: 4 << 20 }, (err, out) => err ? reject(new Error('Tailscale phone configuration failed')) : resolve(out)));
}
export async function enablePhone(config: PhoneConfig): Promise<void> {
  const status = JSON.parse(await tailscale(['status', '--json']));
  const owner = status.User?.[String(status.Self?.UserID)]?.LoginName;
  const dns = String(status.Self?.DNSName ?? '').replace(/\.$/, '');
  if (!owner || !dns) throw new Error('Sign in to Tailscale on this PC first');
  config.edit(s => { s.secret ??= token(); s.adminSecret ??= token(); s.owner ??= owner; s.origin = `https://${dns}`; s.enabled = true; });
  await repairPhoneServe(config);
}
/** Change only this mount; never reset Serve, Funnel, /peer or another session's route. */
export async function repairPhoneServe(config: PhoneConfig, run = tailscale): Promise<void> {
  const p = config.read(); if (!p.enabled || !p.secret || !p.origin) return;
  const target = `http://127.0.0.1:${PORT}/phone/_gateway/${p.secret}`;
  const status = JSON.parse(await run(['serve', 'status', '--json']));
  if (status.AllowFunnel && Object.values(status.AllowFunnel).some(Boolean)) throw new Error('Phone requires tailnet-only HTTPS; existing Funnel configuration was preserved');
  const authority = new URL(p.origin).host + ':443';
  if (status.Web?.[authority]?.Handlers?.['/phone']?.Proxy === target) return;
  await run(['serve', '--bg', '--https=443', '--set-path=/phone', target]);
}
