/** The local outboxes under .keeper/queue (never synced): writes waiting for the keeper, and acme-cockpit links. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { abs, oneLine, read, str } from './vault-store.js';
import { type Connection, type WriteRequest } from './vault-write.js';

/** The queue is this PC's own outbox: Syncthing must not carry it (.stignore is itself never synced). */
export function ignoreQueue(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  const have = read(root, '.stignore') ?? '';
  if (!have.split('\n').some((l) => l.trim() === '/.keeper/queue')) {
    fs.writeFileSync(path.join(root, '.stignore'), `${have.replace(/\n*$/, have ? '\n' : '')}/.keeper/queue\n`);
  }
}

// -- spaces ---------------------------------------------------------------------------------------

export const queueDir = (root: string): string => abs(root, '.keeper/queue');
export function enqueue(root: string, req: WriteRequest, now: number): void {
  fs.mkdirSync(queueDir(root), { recursive: true });
  ignoreQueue(root);
  fs.writeFileSync(path.join(queueDir(root), `${now}-${req.request_id}.json`), JSON.stringify(req));
}
export function queued(root: string): string[] {
  try { return fs.readdirSync(queueDir(root)).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
}

// -- acme-cockpit links (D90) -------------------------------------------------------------------

/**
 * One client_links row for acme-cockpit, waiting in the keeper's own outbox. It lives under .keeper/queue,
 * which Syncthing never carries, and never holds the token.
 */
export interface CockpitLink { tobira_id: string; kind: 'alias' | 'email' | 'domain'; value: string; source: string; name: string; revision: string }
export const cockpitDir = (root: string): string => path.join(queueDir(root), 'cockpit');
export function cockpitQueued(root: string, ext = '.json'): string[] {
  try { return fs.readdirSync(cockpitDir(root)).filter((f) => f.endsWith(ext)).sort(); } catch { return []; }
}
export function enqueueLinks(root: string, tobiraId: string, c: Connection, revision: string, req: WriteRequest, now: number): number {
  const links: Array<[CockpitLink['kind'], string]> = [['alias', c.name], ...(c.email ? [['email', c.email] as [CockpitLink['kind'], string]] : []),
    ...c.domains.map((d) => ['domain', d] as [CockpitLink['kind'], string])];
  fs.mkdirSync(cockpitDir(root), { recursive: true });
  ignoreQueue(root);
  const source = `kokuban vault ${tobiraId} r-${revision}: ${oneLine(str(req.evidence), 160)}`;
  links.forEach(([kind, value], i) => {
    const link: CockpitLink = { tobira_id: tobiraId, kind, value, source, name: c.name, revision };
    fs.writeFileSync(path.join(cockpitDir(root), `${now}-${revision}-${i}.json`), JSON.stringify(link));
  });
  return links.length;
}

/** D131: remove queued writes a newer one supersedes (an older working-copies row). */
export function dropQueued(root: string, pick: (req: WriteRequest) => boolean): number {
  let n = 0;
  for (const f of queued(root)) {
    const full = path.join(queueDir(root), f);
    try { if (pick(JSON.parse(fs.readFileSync(full, 'utf8')) as WriteRequest)) { fs.unlinkSync(full); n++; } }
    catch { /* unreadable or gone: drainQueue sets it aside */ }
  }
  return n;
}
/** The queued writes themselves, oldest first; an unreadable file is skipped. */
export function queuedWrites(root: string): WriteRequest[] {
  return queued(root).flatMap((f) => {
    try { return [JSON.parse(fs.readFileSync(path.join(queueDir(root), f), 'utf8')) as WriteRequest]; } catch { return []; }
  });
}
