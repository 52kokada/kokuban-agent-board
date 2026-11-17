/** The keeper's heartbeat file and `kokuban status` lines built from it. */
import { thisPc } from './know.js';
import { version } from './pair.js';
import { type KeeperConfig, put, read } from './vault-store.js';
import { type KeeperDeps } from './vault-transport.js';
import { cockpitQueued, queued } from './vault-queue.js';

/**
 * The keeper's heartbeat (keeper-pc audit, 2026-11-05): written to .keeper/heartbeat.json at the start and end of
 * every keeper tick and after each folder move, so "is the keeper alive" is read, not guessed from its last write.
 * Only the keeper writes it; Syncthing carries it to the other PCs, whose `kokuban status` reads it.
 */
export interface TickResult { ok: boolean; at: string; ms: number; sent: number; moved: number; skipped: number; error?: string }
export interface Heartbeat {
  ts: string; pid: number; pc: string; version: string; state: 'ticking' | 'idle';
  queue: number; cockpit: number; moving?: number; last?: TickResult;
}
export const HEARTBEAT = '.keeper/heartbeat.json';
/** Written at most every 5 minutes (each write is a synced file version), sooner when the state or last result changes. */
const BEAT_MS = 5 * 60_000;
const STALE_MS = 12 * 60_000;
let lastTick: TickResult | undefined;
/** The keeper loop records each tick's result here; the next beat carries it. */
export function recordTick(t: TickResult): void { lastTick = t; }
const lastBeats = new Map<string, { at: number; key: string }>();
export function beat(cfg: KeeperConfig, deps: KeeperDeps, state: Heartbeat['state'], extra: Partial<Heartbeat> = {}): void {
  // The start of a plain tick adds nothing a reader needs: the end-of-tick beat says the same, one write later.
  if (state === 'ticking' && !extra.moving) return;
  const now = (deps.now ?? Date.now)();
  // Ticking/idle flips every tick and is not a reason to write; an error or a folder pass is.
  const key = `${lastTick?.ok === false ? lastTick.error ?? 'error' : ''}|${extra.moving ? 'moving' : ''}`;
  const prev = lastBeats.get(cfg.path);
  if (prev && key === prev.key && now - prev.at < BEAT_MS) return;
  lastBeats.set(cfg.path, { at: now, key });
  const hb: Heartbeat = {
    ts: new Date((deps.now ?? Date.now)()).toISOString(), pid: process.pid, pc: (deps.pc ?? thisPc)(), version: deps.version?.() ?? version(),
    state, queue: queued(cfg.path).length, cockpit: cockpitQueued(cfg.path).length, ...(lastTick ? { last: lastTick } : {}), ...extra,
  };
  try { put(cfg.path, HEARTBEAT, `${JSON.stringify(hb)}\n`); } catch { /* the tick goes on; status then reads it as silent */ }
}
export function heartbeat(root: string): Heartbeat | null {
  try { return JSON.parse(read(root, HEARTBEAT) ?? '') as Heartbeat; } catch { return null; }
}
/** One line per fact: is the keeper alive, how its last tick went, and this PC's own queue. */
export function keeperStatus(cfg: KeeperConfig | null, now = Date.now()): string[] {
  if (!cfg) return ['vault: not configured on this PC'];
  const hb = heartbeat(cfg.path);
  const role = cfg.keeper ? 'this PC is the keeper' : `the keeper is ${cfg.keeperPc}`;
  const lines = [`vault: ${cfg.path} (${role})`];
  if (!hb) lines.push('keeper: no heartbeat yet (.keeper/heartbeat.json missing): the keeper has not ticked with this build');
  else {
    const age = Math.max(0, now - Date.parse(hb.ts));
    const ago = age < 120_000 ? `${Math.round(age / 1000)}s ago` : `${Math.round(age / 60_000)} min ago`;
    lines.push(`keeper: ${age > STALE_MS ? 'SILENT' : 'alive'}, ${hb.state}${hb.moving ? ` (${hb.moving} folders moved so far)` : ''}, ` +
      `last beat ${ago} from ${hb.pc} pid ${hb.pid}${hb.version ? ` (${hb.version})` : ''}; keeper queue ${hb.queue}, acme-cockpit outbox ${hb.cockpit}`);
    if (hb.last) {
      lines.push(`last tick: ${hb.last.ok ? 'ok' : `FAILED: ${hb.last.error ?? 'no reason recorded'}`} at ${hb.last.at}, ${hb.last.ms} ms; ` +
        `${hb.last.sent} queued writes applied, ${hb.last.moved} folders moved, ${hb.last.skipped} moves skipped`);
    }
  }
  if (!cfg.keeper) lines.push(`this PC's queue: ${queued(cfg.path).length} writes waiting for the keeper`);
  return lines;
}
