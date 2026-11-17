/** Credential values exist only in process memory and the Credential Manager bridge's JSON pipes. */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Board } from './board.js';
import { SETTINGS, makeCard, closeCard, type Card } from './cards.js';
import { DATA_DIR, PORT } from './config.js';
import { record, trustFor } from './peer.js';
import { repoDir } from './update.js';

export interface VaultMeta {
  name: string;
  account: string;
  written: number;
}
export interface VaultEntry extends VaultMeta {
  blob: string;
}
export interface VaultRemoval {
  name: string;
  written: number;
}
export interface VaultListing {
  entries: VaultMeta[];
  skipped: string[];
}
export interface VaultBatch {
  updated: number;
  removed: number;
  applied: { write: string[]; remove: string[] };
  failed: string[];
  skipped: string[];
  retryable: boolean;
}
export interface VaultState {
  known: VaultMeta[];
  tombstones: { name: string; written: number }[];
  review?: { items: VaultRemoval[]; cardId: number };
  approved?: VaultRemoval[];
  kept?: VaultRemoval[];
}
export interface VaultIndex {
  entries: VaultMeta[];
  tombstones: VaultState['tombstones'];
}
export interface VaultAccess {
  prefix: string;
  removalsFile?: string;
  index(): Promise<VaultListing>;
  fetch(names: string[]): Promise<VaultEntry[]>;
  import(entries: VaultEntry[], remove: VaultRemoval[]): Promise<VaultBatch>;
}
const DAYS_90 = 90 * 86_400_000;

/** Local signing credentials never enter the computeruse/ namespace or cross-PC sync. */
export function phoneVapidCredential(op: 'get' | 'set', value?: { publicKey: string; privateKey: string }): Promise<{ publicKey: string; privateKey: string } | null> {
  const dir = repoDir('computeruse'); if (!dir) return Promise.reject(new Error('Local credential bridge unavailable'));
  return new Promise((resolve, reject) => {
    const child = execFile(path.join(dir, '.venv', 'Scripts', 'python.exe'), ['-X', 'utf8', fileURLToPath(new URL('../../assets/phone-vapid.py', import.meta.url))],
      { cwd: dir, windowsHide: true, timeout: 15000, maxBuffer: 16000 }, (error, output) => {
        if (error) return reject(new Error('Local phone credential operation failed'));
        try { resolve(JSON.parse(output)); } catch { reject(new Error('Local phone credential operation failed')); }
      });
    child.stdin?.on('error', () => {}); child.stdin?.end(JSON.stringify({ op, value }));
  });
}

/** Neither stderr nor a subprocess exception is ever returned: either may contain credential data. */
export function pythonVault(where = repoDir, prefix = 'computeruse/', python?: string): VaultAccess {
  if (prefix !== 'computeruse/' && !/^computeruse-vault-test-[a-z0-9-]+\/$/.test(prefix)) {
    throw new Error('Invalid vault prefix');
  }
  const run = (op: 'export' | 'import', input: object): Promise<Record<string, unknown>> => {
    const dir = where('computeruse');
    if (!dir) return Promise.reject(new Error('Vault Python unavailable'));
    return new Promise((resolve, reject) => {
      const child = execFile(
        python ?? path.join(dir, '.venv', 'Scripts', 'python.exe'),
        ['-X', 'utf8', '-m', 'harness.passwords', op],
        { cwd: dir, windowsHide: true, timeout: 30_000, maxBuffer: 16 << 20 },
        (err, stdout) => {
          if (err) return reject(new Error('Vault bridge failed'));
          try {
            resolve(JSON.parse(String(stdout)));
          } catch {
            reject(new Error('Vault bridge failed'));
          }
        },
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify({ prefix, ...input }));
    });
  };
  return {
    prefix,
    removalsFile: path.join(DATA_DIR, 'vault-tombstones.jsonl'),
    index: async () => {
      const result = await run('export', { op: 'index' });
      return { entries: result.entries as VaultMeta[], skipped: result.skipped as string[] };
    },
    fetch: async (names) => (await run('export', { op: 'fetch', names })).entries as VaultEntry[],
    import: async (entries, remove) => {
      return (await run('import', { entries, remove })) as unknown as VaultBatch;
    },
  };
}

function validName(name: unknown, prefix: string): name is string {
  return (
    typeof name === 'string' && name.startsWith(prefix) && name.length > prefix.length && !name.includes('\0')
  );
}
function meta(input: unknown, prefix: string): VaultMeta {
  const row = input as Partial<VaultMeta> | null;
  if (
    !row ||
    !validName(row.name, prefix) ||
    typeof row.account !== 'string' ||
    !Number.isSafeInteger(row.written) ||
    row.written! <= 0 ||
    row.written! > Date.now() + 86_400_000
  )
    throw new Error('Invalid vault metadata');
  // Construct a fresh names-only object; never spread a secret-bearing peer object into state.
  return { name: row.name, account: row.account, written: row.written! };
}
function indexOf(input: unknown, prefix: string): VaultIndex {
  const raw = input as Partial<VaultIndex> | null;
  if (!raw || !Array.isArray(raw.entries) || !Array.isArray(raw.tombstones))
    throw new Error('Invalid vault index');
  return {
    entries: raw.entries.map((e) => meta(e, prefix)),
    tombstones: raw.tombstones.map((t) => {
      const m = meta({ ...t, account: '' }, prefix);
      return { name: m.name, written: m.written };
    }),
  };
}
const queues = new WeakMap<Board, Promise<unknown>>();
function local<T>(board: Board, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(board) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  queues.set(board, next);
  return next;
}
function keepState(board: Board, next: VaultState): void {
  const previous = board.vault;
  board.vault = next;
  if (!board.flush()) {
    board.vault = previous;
    throw new Error('Vault metadata could not be saved');
  }
}
function mergeRemovals(before: VaultRemoval[], after: VaultRemoval[]): VaultRemoval[] {
  const merged = new Map(before.map((t) => [t.name, t.written]));
  for (const t of after) merged.set(t.name, Math.max(t.written, merged.get(t.name) ?? 0));
  return [...merged].map(([name, written]) => ({ name, written }));
}
/** A bulk removal is held as names/times only. Its tombstones are not accepted before approval. */
function reviewRemovals(board: Board, items: VaultRemoval[]): VaultRemoval[] {
  const kept = new Map((board.vault.kept ?? []).map((t) => [t.name, t.written]));
  const approved = new Map((board.vault.approved ?? []).map((t) => [t.name, t.written]));
  const eligible = items.filter((t) => t.written > (kept.get(t.name) ?? 0));
  const unapproved = eligible.filter((t) => t.written > (approved.get(t.name) ?? 0));
  if (unapproved.length <= 3 && !board.vault.review) return eligible;
  if (!unapproved.length) return eligible;
  const pending = mergeRemovals(board.vault.review?.items ?? [], unapproved).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const previous = board.vault.review;
  if (
    !previous ||
    JSON.stringify(previous.items) !== JSON.stringify(pending) ||
    board.cards.find((c) => c.id === previous.cardId)?.closed
  ) {
    if (previous) {
      const old = board.cards.find((c) => c.id === previous.cardId);
      if (old) closeCard(board, old, 'withdrawn');
    }
    const card = makeCard(
      board,
      { agent: 'kokuban' },
      {
        question: `Vault sync proposes removing ${pending.length} entries. Apply the removals?`,
        details:
          pending
            .slice(0, 20)
            .map((t) => t.name)
            .join('\n')
            .slice(0, 3500) +
          (pending.length > 20
            ? `\n…and ${pending.length - 20} more; full names are in the board’s vault review.`
            : ''),
        choices: ['Apply the removals', 'Keep the entries'],
        lang: 'en',
      },
    );
    keepState(board, { ...board.vault, review: { items: pending, cardId: card.id } });
  }
  return eligible.filter((t) => t.written <= (approved.get(t.name) ?? 0));
}
function noteBatch(board: Board, result: VaultBatch): void {
  if (result.retryable)
    board.usage?.({
      ts: board.clock(),
      tool: 'vault:batch',
      ok: false,
      failed: result.failed.length,
      retryable: true,
    });
}
/** A missing previously seen name becomes a dated removal; enumeration errors never mean empty. */
async function refresh(board: Board, access: VaultAccess): Promise<VaultIndex> {
  const listing = await access.index();
  const entries = listing.entries.map((e) => meta(e, access.prefix));
  const skipped = new Set(listing.skipped.filter((name) => validName(name, access.prefix)));
  if (skipped.size)
    board.usage?.({ ts: board.clock(), tool: 'vault:metadata', ok: false, skipped: skipped.size });
  // A malformed stamp is not a deletion. Retain only its previous names-only metadata.
  for (const old of board.vault.known) if (skipped.has(old.name)) entries.push(old);
  const now = board.clock();
  const tombstones = new Map(
    board.vault.tombstones.filter((t) => now - t.written < DAYS_90).map((t) => [t.name, t.written]),
  );
  let pending: string | undefined;
  if (access.removalsFile) {
    pending = access.removalsFile + '.pending';
    if (!fs.existsSync(pending) && fs.existsSync(access.removalsFile)) {
      // Rotate rather than rewrite the producer's file; a concurrent append gets a new file.
      try {
        fs.renameSync(access.removalsFile, pending);
      } catch {
        throw new Error('Vault removal metadata unavailable');
      }
    }
    if (fs.existsSync(pending)) {
      for (const line of fs.readFileSync(pending, 'utf8').split(/\r?\n/).filter(Boolean)) {
        try {
          const row = JSON.parse(line);
          if (
            validName(row.name, access.prefix) &&
            Number.isSafeInteger(row.written) &&
            row.written > 0 &&
            now - row.written < DAYS_90
          ) {
            tombstones.set(row.name, Math.max(row.written, tombstones.get(row.name) ?? 0));
          }
        } catch {
          /* An incomplete append is retried by the producer's next operation. */
        }
      }
    }
  }
  const present = new Set(entries.map((e) => e.name));
  for (const old of board.vault.known) {
    if (!present.has(old.name) && !tombstones.has(old.name)) tombstones.set(old.name, now);
  }
  const proposed = entries
    .filter((e) => !skipped.has(e.name) && (tombstones.get(e.name) ?? 0) > e.written)
    .map((e) => ({ name: e.name, written: tombstones.get(e.name)! }));
  const allowed = reviewRemovals(board, proposed);
  const allowedNames = new Set(allowed.map((t) => t.name));
  for (const t of proposed) if (!allowedNames.has(t.name)) tombstones.delete(t.name);
  const remove: VaultRemoval[] = [];
  const known = entries.filter((e) => {
    const removed = tombstones.get(e.name);
    if (removed === undefined) return true;
    if (e.written > removed) {
      tombstones.delete(e.name);
      return true;
    }
    if (skipped.has(e.name) || removed <= e.written) return true;
    remove.push({ name: e.name, written: removed });
    return false;
  });
  const next = {
    ...board.vault,
    known,
    tombstones: [...tombstones].map(([name, written]) => ({ name, written })),
    approved: (board.vault.approved ?? []).filter((t) => now - t.written < DAYS_90),
    kept: (board.vault.kept ?? []).filter((t) => now - t.written < DAYS_90),
  };
  keepState(board, next);
  if (remove.length) noteBatch(board, await access.import([], remove));
  if (pending && fs.existsSync(pending)) fs.unlinkSync(pending);
  return { entries: known, tombstones: next.tombstones };
}
export function vaultDecided(
  board: Board,
  card: Card,
  choice: string,
  access = pythonVault(),
): Promise<string> | null {
  if (board.vault.review?.cardId !== card.id) return null;
  return local(board, async () => {
    const review = board.vault.review;
    if (!review || review.cardId !== card.id) return 'This vault review is no longer pending.';
    if (choice === 'Keep the entries') {
      keepState(board, {
        ...board.vault,
        review: undefined,
        kept: mergeRemovals(board.vault.kept ?? [], review.items),
      });
      return 'Kept the entries. These removals will not be applied.';
    }
    if (choice !== 'Apply the removals') return 'Choose Apply the removals or Keep the entries.';
    keepState(board, {
      ...board.vault,
      review: undefined,
      approved: mergeRemovals(board.vault.approved ?? [], review.items),
      tombstones: mergeRemovals(board.vault.tombstones, review.items),
    });
    await refresh(board, access);
    return 'Approved the reviewed removals. Newer local rotations are preserved; incomplete removals will retry.';
  });
}

/** Called only after /peer's work-trust gate. No secret is returned by an index reply. */
export async function vaultAsked(
  board: Board,
  input: Record<string, unknown>,
  access = pythonVault(),
): Promise<object> {
  return local(board, async () => {
    const index = await refresh(board, access);
    if (input.op === 'vault_index') return { ok: true, ...index };
    if (
      input.op !== 'vault_fetch' ||
      !Array.isArray(input.names) ||
      input.names.some((n) => !validName(n, access.prefix))
    )
      throw new Error('Invalid vault request');
    const available = new Set(index.entries.map((e) => e.name));
    const names = [...new Set(input.names as string[])].filter((n) => available.has(n));
    const entries = await access.fetch(names);
    return { ok: true, entries: entries.map((e) => ({ ...meta(e, access.prefix), blob: e.blob })) };
  });
}

export interface VaultDeps {
  access?: VaultAccess;
  pcs?: () => string[];
  fetch?: typeof fetch;
  url?: (pc: string) => string;
}
const syncing = new WeakSet<Board>();
export async function syncVault(board: Board, deps: VaultDeps = {}): Promise<void> {
  if (syncing.has(board)) return;
  syncing.add(board);
  try {
    const access = deps.access ?? pythonVault();
    const pcs =
      deps.pcs?.() ??
      (() => {
        try {
          return Object.keys(JSON.parse(fs.readFileSync(SETTINGS.file, 'utf8')).trust ?? {}).filter(
            (pc) => trustFor(pc) === 'work',
          );
        } catch {
          return [];
        }
      })();
    const offers: { pc: string; remote: VaultIndex; fetched: VaultEntry[] }[] = [];
    for (const pc of pcs) {
      try {
        const post = async (body: object): Promise<unknown> => {
          const res = await (deps.fetch ?? fetch)(deps.url?.(pc) ?? `http://${pc}:${PORT}/peer`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ v: 1, ...body }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) throw new Error('Vault peer unavailable');
          return res.json();
        };
        const remote = indexOf(await post({ op: 'vault_index' }), access.prefix);
        const before = await local(board, () => refresh(board, access));
        const current = new Map(before.entries.map((e) => [e.name, e.written]));
        const deleted = new Map(before.tombstones.map((t) => [t.name, t.written]));
        const wanted = remote.entries.filter(
          (e) => e.written > Math.max(current.get(e.name) ?? 0, deleted.get(e.name) ?? 0),
        );
        let fetched: VaultEntry[] = [];
        if (wanted.length) {
          const raw = (await post({ op: 'vault_fetch', names: wanted.map((e) => e.name) })) as {
            entries?: unknown[];
          };
          if (!Array.isArray(raw.entries)) throw new Error('Invalid vault response');
          const requested = new Set(wanted.map((e) => e.name));
          fetched = raw.entries.map((e) => {
            const row = e as VaultEntry;
            const m = meta(row, access.prefix);
            if (
              !requested.has(m.name) ||
              typeof row.blob !== 'string' ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.blob)
            ) {
              throw new Error('Invalid vault response');
            }
            return { ...m, blob: row.blob };
          });
        }
        offers.push({ pc, remote, fetched });
      } catch {
        // No exception, response, command input or subprocess output reaches logs.
        board.usage?.({ ts: board.clock(), tool: 'vault:sync', pc, ok: false });
      }
    }
    if (!offers.length) return;
    await local(board, async () => {
      // Gather every peer first: two batches of three removals must still hit the bulk brake.
      const latest = await refresh(board, access);
      const entries = new Map(latest.entries.map((e) => [e.name, e]));
      const tombstones = new Map(latest.tombstones.map((t) => [t.name, t.written]));
      const writeSources = new Map<string, string>();
      const removalSources = new Map<string, string>();
      const incoming = new Map<string, VaultEntry>();
      for (const offer of offers) {
        for (const t of offer.remote.tombstones) {
          if (board.clock() - t.written >= DAYS_90 || t.written <= (tombstones.get(t.name) ?? 0)) continue;
          if (
            t.written <=
            Math.max(...(board.vault.kept ?? []).filter((k) => k.name === t.name).map((k) => k.written), 0)
          )
            continue;
          tombstones.set(t.name, t.written);
          removalSources.set(t.name, offer.pc);
        }
        for (const e of offer.fetched)
          if (e.written > (incoming.get(e.name)?.written ?? 0)) {
            incoming.set(e.name, e);
            writeSources.set(e.name, offer.pc);
          }
      }
      const proposed = [...entries.values()]
        .filter((e) => (tombstones.get(e.name) ?? 0) > e.written)
        .map((e) => ({ name: e.name, written: tombstones.get(e.name)! }));
      const removals = reviewRemovals(board, proposed);
      const allowed = new Set(removals.map((t) => t.name));
      for (const t of proposed) if (!allowed.has(t.name)) tombstones.delete(t.name);
      const imports = [...incoming.values()].filter(
        (e) => e.written > Math.max(entries.get(e.name)?.written ?? 0, tombstones.get(e.name) ?? 0),
      );
      keepState(board, {
        ...board.vault,
        known: latest.entries,
        tombstones: [...tombstones].map(([name, written]) => ({ name, written })),
      });
      let result: VaultBatch | undefined;
      try {
        if (imports.length || removals.length) {
          result = await access.import(imports, removals);
          noteBatch(board, result);
        }
      } finally {
        // A partial import is retryable: learn what actually landed before the next round.
        await refresh(board, access);
      }
      if (result) {
        const counts = new Map<string, number>();
        for (const [names, sources] of [
          [result.applied.write, writeSources],
          [result.applied.remove, removalSources],
        ] as const) {
          for (const name of names) {
            const pc = sources.get(name) ?? 'paired PCs';
            counts.set(pc, (counts.get(pc) ?? 0) + 1);
          }
        }
        for (const [pc, count] of counts)
          record(board, {
            dir: 'in',
            pc,
            agent: 'kokuban',
            op: 'vault',
            to: '',
            text: `vault: ${count} entries updated from ${pc}`,
          });
      }
    });
  } catch {
    board.usage?.({ ts: board.clock(), tool: 'vault:sync', ok: false, retryable: true });
  } finally {
    syncing.delete(board);
  }
}
