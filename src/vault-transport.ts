/** Forwarding writes to the keeper over /peer, queueing them while it is down, draining the queue, and the /peer handler. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PORT } from './config.js';
import { PEER_PROTOCOL, PEER_ROUTE, resolvePc } from './peer.js';
import { type SyncDeps } from './vault-sync.js';
import { type KeeperConfig, configOf, str } from './vault-store.js';
import { type WriteRequest, type WriteResult, applyWrite } from './vault-write.js';
import { enqueue, queueDir, queued } from './vault-queue.js';
import { sendCockpit } from './vault-cockpit.js';

export interface KeeperDeps {
  config?: () => KeeperConfig | null;
  now?: () => number;
  fetch?: typeof fetch;
  resolve?: (pc: string) => Promise<string>;
  pc?: () => string;
  version?: () => string;
  /** D124: the Syncthing REST calls (tests). */
  sync?: SyncDeps;
}
class Refused extends Error {}

async function forward(cfg: KeeperConfig, req: WriteRequest, deps: KeeperDeps): Promise<WriteResult> {
  const device = await (deps.resolve ?? resolvePc)(cfg.keeperPc);
  const res = await (deps.fetch ?? fetch)(`http://${device}:${PORT}${PEER_ROUTE}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: PEER_PROTOCOL, op: 'vault_write', me: req.author.agent, write: req }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({})) as WriteResult | { ok: false; error?: string };
  // A refusal (bad request, no trust, not the keeper) is final: queueing it would only repeat it.
  if (res.status >= 400 && res.status < 500) throw new Refused(`${cfg.keeperPc} refused this write (HTTP ${res.status}): ${str((body as { error?: string }).error)}`);
  if (!res.ok || body.ok !== true) throw new Error(`HTTP ${res.status}`);
  return body;
}
/** Send queued writes, oldest first, until one fails. A refused one is set aside, never dropped. */
export async function drainQueue(cfg: KeeperConfig, deps: KeeperDeps = {}): Promise<{ sent: number; left: number }> {
  let sent = 0;
  for (const file of queued(cfg.path)) {
    const full = path.join(queueDir(cfg.path), file);
    let req: WriteRequest;
    try { req = JSON.parse(fs.readFileSync(full, 'utf8')) as WriteRequest; }
    catch { fs.renameSync(full, `${full}.unreadable`); continue; }
    try {
      if (cfg.keeper) applyWrite(cfg.path, req, (deps.now ?? Date.now)(), undefined, { cockpit: !!cfg.cockpit });
      else await forward(cfg, req, deps);
    } catch (err) {
      if (!(err instanceof Refused) && !cfg.keeper) break;
      fs.renameSync(full, full.replace(/\.json$/, '.refused'));
      fs.writeFileSync(full.replace(/\.json$/, '.refused.txt'), (err as Error).message);
      continue;
    }
    fs.unlinkSync(full);
    sent++;
  }
  return { sent, left: queued(cfg.path).length };
}

/** /peer op vault_write (work trust), on the keeper. The sending PC is the verified caller, not the words. */
export function keeperAsked(input: Record<string, unknown>, pc: string, deps: KeeperDeps = {}): { status: number; body: object } {
  const cfg = configOf(deps);
  if (!cfg?.keeper) return { status: 409, body: { ok: false, error: 'this PC is not the vault keeper' } };
  const raw = (input.write && typeof input.write === 'object' ? input.write : {}) as WriteRequest;
  const author = (raw.author && typeof raw.author === 'object' ? raw.author : {}) as WriteRequest['author'];
  const req: WriteRequest = { ...raw, author: { agent: str(author.agent) || str(input.me), pc: pc.split('.')[0]!, ...(str(author.person) ? { person: str(author.person) } : {}) } };
  try {
    const out = applyWrite(cfg.path, req, (deps.now ?? Date.now)(), undefined, { cockpit: !!cfg.cockpit });
    // The links go out now in the background; whatever fails waits for the 30-second tick.
    if (req.kind === 'connection' && out.state === 'written' && cfg.cockpit) void sendCockpit(cfg, deps).catch(() => undefined);
    return { status: 200, body: out };
  } catch (err) {
    return { status: 400, body: { ok: false, error: (err as Error).message } };
  }
}

// -- the tool -------------------------------------------------------------------------------------

/**
 * A non-keeper's write: forwarded to the keeper, or queued here while it is unreachable. A refusal is
 * thrown, never queued.
 */
export async function sendToKeeper(cfg: KeeperConfig, req: WriteRequest, now: number, deps: KeeperDeps = {}): Promise<{ queued: boolean; message: string }> {
  try {
    const out = await forward(cfg, req, deps);
    return { queued: false, message: out.message };
  } catch (err) {
    if (err instanceof Refused) throw err;
    // A password never waits on disk: a credential write is retried by its caller, not queued.
    if (req.kind === 'credential') {
      throw new Error(`not written: the keeper (${cfg.keeperPc}) is unreachable, and a credential is never queued on disk. Try again when it answers.`);
    }
    enqueue(cfg.path, req, now);
    return { queued: true, message: `queued: the keeper (${cfg.keeperPc}) is unreachable; this write waits in this PC's queue and is sent ` +
      `as soon as it answers (${queued(cfg.path).length} waiting). Do not write it again.` };
  }
}
