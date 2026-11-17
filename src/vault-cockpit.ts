/** Sending connection links to acme-cockpit (D90), and turning its conflicts into proposals. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { thisPc } from './know.js';
import { type KeeperConfig, TOBIRA, oneLine, str } from './vault-store.js';
import { findClient } from './vault-spaces.js';
import { type WriteRequest, applyWrite } from './vault-write.js';
import { writeAttention } from './vault-checkup.js';
import { type KeeperDeps } from './vault-transport.js';
import { type CockpitLink, cockpitDir, cockpitQueued } from './vault-queue.js';

export interface CockpitResult { sent: number; left: number; conflicts: string[]; refused: number; error?: string }
let sendingCockpit = false;
/**
 * Keeper only: send the outbox to the brain API, oldest first. 200 removes the link; 409 (another client owns
 * the value) becomes a proposal for a person and is listed on Needs attention; 400 is set aside as .refused;
 * anything else (network, token, server) stops the run, to be retried on the next 30-second tick.
 * The token is read from its file for each run and appears only in the Authorization header.
 */
export async function sendCockpit(cfg: KeeperConfig, deps: KeeperDeps = {}): Promise<CockpitResult> {
  const out: CockpitResult = { sent: 0, left: cockpitQueued(cfg.path).length, conflicts: [], refused: 0 };
  if (!cfg.keeper || !cfg.cockpit || !out.left || sendingCockpit) return out;
  sendingCockpit = true;
  try {
    let token = '';
    try { token = fs.readFileSync(cfg.cockpit.tokenFile, 'utf8').trim(); } catch { /* reported below, without the path's contents */ }
    if (!token) { out.error = 'the acme-cockpit token file is missing or empty'; return out; }
    for (const file of cockpitQueued(cfg.path)) {
      const full = path.join(cockpitDir(cfg.path), file);
      let link: CockpitLink;
      try { link = JSON.parse(fs.readFileSync(full, 'utf8')) as CockpitLink; }
      catch { fs.renameSync(full, `${full}.unreadable`); continue; }
      let res: Response;
      try {
        res = await (deps.fetch ?? fetch)(`${cfg.cockpit.url}/api/internal/brain/clients/${encodeURIComponent(link.tobira_id)}/links`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ kind: link.kind, value: link.value, source: link.source }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        out.error = 'acme-cockpit unreachable';
        break;
      }
      const body = await res.json().catch(() => ({})) as { ok?: boolean; owner?: unknown; error?: unknown };
      const owner = str(body.owner);
      const setAside = (why: string): void => {
        fs.renameSync(full, full.replace(/\.json$/, '.refused'));
        fs.writeFileSync(full.replace(/\.json$/, '.refused.txt'), `${oneLine(why, 400)}\n`);
        out.refused++;
      };
      if (res.status === 409 && owner !== link.tobira_id) {
        if (!owner) { setAside('acme-cockpit answered HTTP 409 without naming the owner'); continue; }
        try { cockpitConflict(cfg.path, link, owner, file, deps); }
        catch (err) { setAside(`acme-cockpit: owned by ${owner}; the proposal could not be written: ${(err as Error).message}`); continue; }
        out.conflicts.push(`${link.kind} ${link.value} → ${owner}`);
        fs.unlinkSync(full);
        continue;
      } else if (res.status === 400) {
        setAside(`acme-cockpit refused this link (HTTP 400): ${str(body.error)}`);
        continue;
      } else if (!res.ok && res.status !== 409) {
        out.error = `acme-cockpit answered HTTP ${res.status}`;
        break;
      }
      fs.unlinkSync(full);
      out.sent++;
    }
    return out;
  } finally {
    sendingCockpit = false;
    out.left = cockpitQueued(cfg.path).length;
    if (out.refused) writeAttention(cfg.path, (deps.now ?? Date.now)());
  }
}
/** A 409: the value already belongs to another client. A person decides; nothing is overridden. */
function cockpitConflict(root: string, link: CockpitLink, owner: string, file: string, deps: KeeperDeps): void {
  const ownerDir = TOBIRA.test(owner) ? findClient(root, owner) : null;
  const req: WriteRequest = {
    request_id: `cockpit-${file.replace(/\.json$/, '')}`.slice(0, 64),
    kind: 'proposal', space: link.tobira_id, section: `connection ${link.name}`,
    text: `Conflicts with ${owner}: acme-cockpit did not link ${link.kind} "${link.value}" to ${link.tobira_id}, because it already ` +
      `belongs to ${owner}. A person should decide whether ${link.tobira_id} and ${owner} are one client or connected.`,
    source: `acme-cockpit 409 for the connection recorded in r-${link.revision}`,
    author: { agent: 'keeper', pc: (deps.pc ?? thisPc)() },
  };
  applyWrite(root, req, (deps.now ?? Date.now)(), undefined, { conflictsWith: ownerDir ? `${ownerDir}/Overview` : owner });
}
