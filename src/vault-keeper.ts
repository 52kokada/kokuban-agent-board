/**
 * The keeper: the one writer of the shared Obsidian vault (docs/vault-keeper.md). Syncthing only
 * carries files; every agent write goes through the keeper on one PC (settings vault.keeper=true),
 * which records who, when and from what source, never silently overrides an accepted fact or
 * decision, and keeps human edits. Other PCs read their synced copy and forward writes over /peer,
 * queueing them locally while the keeper is unreachable. Not to be confused with vault.ts, which
 * syncs credentials and never touches this folder.
 *
 * This module is the keeper's daemon tick. The rest lives in the vault-* modules listed in docs/vault-keeper.md;
 * every name this module used to define is re-exported below, so callers and dist consumers keep working.
 */
import type { Board } from './board.js';
import { thisPc } from './know.js';
import { allClients, allProjects, legacy } from './vault-layout.js';
import { finishMoves, placeClients, refileProjects, type Batch } from './vault-regroup.js';
import { syncTick } from './vault-sync.js';
import { headChars } from './text-cut.js';
import { type KeeperConfig, configOf, groupingOf, put, read, str } from './vault-store.js';
import { ensureLayout, linkUp, proposeRules, refreshHomes } from './vault-spaces.js';
import { writeAttention } from './vault-checkup.js';
import { type KeeperDeps, drainQueue } from './vault-transport.js';
import { queued } from './vault-queue.js';
import { sendCockpit } from './vault-cockpit.js';
import { beat, recordTick } from './vault-heartbeat.js';

export { searchVault } from './vault-catchup.js';
export { checkup, unsafeNames, writeAttention } from './vault-checkup.js';
export { type CockpitResult, sendCockpit } from './vault-cockpit.js';
export { HEARTBEAT, type Heartbeat, type TickResult, heartbeat, keeperStatus } from './vault-heartbeat.js';
export { frontmatter } from './vault-layout.js';
export { CREDENTIALS_PAGE, MASK, maskCredentials, rowCells } from './vault-mask.js';
export { type CockpitLink, cockpitQueued, dropQueued, queued, queuedWrites } from './vault-queue.js';
export { type ReadOptions, basedOn, findClientPage, matchClients, readPage } from './vault-read.js';
export {
  CONNECTION_RULE, CREDENTIAL_RULE, GROUP_RULE, HOW, HOW_PAGE, HOW_PAGE_V2, HOW_PAGE_V3, LAYOUT_RULE, README_PAGE, README_V2, README_V3, READ_RULE,
  RULES_D118_PROPOSAL_ID, RULES_LAYOUT_PROPOSAL_ID, RULES_PAGE, RULES_PROPOSAL_ID, RULES_V1, RULES_V2, RULES_V3, RULES_V4, RULES_V5,
  RULES_V6, RULES_V7,
} from './vault-rulebook.js';
export {
  clientsBlock, ensureLayout, findClient, keeperBoard, layoutNotes, linkUp, parentOf, proposeRules, refreshHomes, spaceFor, spaceKeyOf,
  stagesBlock,
} from './vault-spaces.js';
export {
  CARE_STAGES, FRONTMATTER_FIELDS, type FrontmatterField, type FrontmatterWrite, KINDS, type KeeperConfig, type KeeperIndex, type Kind,
  OLD_STAGES, PROJECT_DOCS, type PageInfo, type Revision, STAGES, appendRevision, buildIndex, create, getBlock, groupingOf, keeperConfig,
  lastFor, loadIndex, notes, ownNotes, put, read, rebuildIndex, refreshSpaceIndex, revisions, setBlock, setFrontmatter, sha, stamp,
  touchIndex, useGrouping,
} from './vault-store.js';
export { VAULT_TOOL, person, vaultRules, vaultTool } from './vault-tool.js';
export { type KeeperDeps, drainQueue, keeperAsked, sendToKeeper } from './vault-transport.js';
export {
  type ApplyOptions, type Connection, LEDGER_PAGE, type WriteRequest, type WriteResult, applyWrite, connectionOf, isLedgerEvent,
  lastEventOf, layoutSummary, refreshResearch, validateWrite,
} from './vault-write.js';

/** A turn of the event loop for everything else: requests are answered between a tick's moves. */
export const breathe = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Move folders one at a time, a breath between moves, the Homes and the index refreshed once at the end. */
async function inBatches(cfg: KeeperConfig, deps: KeeperDeps, move: (opts: Batch) => { moved: unknown[]; skipped: unknown[] },
  done: { moved: number; skipped: number }): Promise<void> {
  let any = false;
  for (;;) {
    const step = move({ limit: 1, finish: false });
    done.skipped += step.skipped.length;
    if (!step.moved.length) break;
    any = true;
    done.moved += step.moved.length;
    beat(cfg, deps, 'ticking', { moving: done.moved });
    await breathe();
  }
  if (any) finishMoves(cfg.path);
}

const laidOut = new Set<string>();
let ticking = false;
/**
 * Every daemon tick: the keeper lays out the vault once, applies its own queue, moves folders where they belong and
 * runs the nightly check-up; others drain their queue. The daemon starts it only after it listens, and it yields
 * between moves, so a long pass never holds requests up.
 */
export async function keeperTick(board: Board, deps: KeeperDeps = {}): Promise<void> {
  if (ticking) return;
  ticking = true;
  const started = Date.now();
  let cfg: KeeperConfig | null = null;
  const done = { sent: 0, moved: 0, skipped: 0 };
  let error: string | undefined;
  try {
    cfg = configOf(deps);
    if (!cfg) return;
    if (!queued(cfg.path).length && !cfg.keeper) return;
    if (cfg.keeper) {
      const keeper = cfg;
      beat(keeper, deps, 'ticking');
      if (!laidOut.has(keeper.path)) {
        ensureLayout(keeper.path);
        laidOut.add(keeper.path);
        // D99: a person's edited Rules.md gets the new rule 8 as a proposal, once.
        proposeRules(keeper.path, (deps.now ?? Date.now)(), (deps.pc ?? thisPc)());
      }
      done.sent = (await drainQueue(keeper, deps)).sent;
      if (keeper.cockpit) {
        const sent = await sendCockpit(keeper, deps);
        if (sent.error) board.usage?.({ ts: board.clock(), tool: 'vault:cockpit', ok: false, text: `${sent.error}; ${sent.left} waiting` });
      }
      const now = new Date((deps.now ?? Date.now)());
      const pc = (deps.pc ?? thisPc)();
      // D101: a project whose Overview names another business (or client) moves there; not before the regroup.
      if (!legacy(keeper.path)) {
        await inBatches(keeper, deps, (o) => refileProjects(keeper.path, now.getTime(), pc, o), done);
        // Each client in its stage group (and business) folder: flat ones from before the groups move here too.
        await inBatches(keeper, deps, (o) => placeClients(keeper.path, now.getTime(), pc, o), done);
        if (done.moved || done.skipped) writeAttention(keeper.path, now.getTime());
      }
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      let last = '';
      try { last = str(JSON.parse(read(keeper.path, '.keeper/checkup.json') ?? '{}').last); } catch { /* never ran */ }
      if (last !== today && now.getHours() >= 3) {
        // Every Overview linked up to its parent, the Homes' lists refreshed, then the check-up.
        const spaces = [...allClients(keeper.path, groupingOf(keeper.path)), ...allProjects(keeper.path, groupingOf(keeper.path))];
        for (const [i, s] of spaces.entries()) {
          linkUp(keeper.path, s.dir, now.getTime(), pc);
          if (i % 25 === 24) await breathe();
        }
        refreshHomes(keeper.path);
        writeAttention(keeper.path, now.getTime());
        put(keeper.path, '.keeper/checkup.json', `${JSON.stringify({ last: today })}\n`);
      }
      // D124: the Syncthing status line on the top Home (and its bookmarks, once).
      if (keeper.syncthing) await syncTick(keeper.path, keeper.syncthing, now.getTime(), pc, deps.sync);
    } else {
      await drainQueue(cfg, deps);
    }
  } catch (err) {
    error = headChars((err as Error).message, 200);
    board.usage?.({ ts: board.clock(), tool: 'vault:keeper', ok: false, text: error });
  } finally {
    ticking = false;
    if (cfg?.keeper) {
      recordTick({ ok: !error, at: new Date((deps.now ?? Date.now)()).toISOString(), ms: Date.now() - started, ...done, ...(error ? { error } : {}) });
      beat(cfg, deps, 'idle');
    }
  }
}
