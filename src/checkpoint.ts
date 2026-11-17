/** Small, explicit current-state records. These are agent claims, not inferred proof. */
import type { Host } from './board.js';

export interface CheckpointData {
  objective: string;
  next: string;
  reference?: string;
  decisions?: string[];
  verified?: string[];
  remaining?: string[];
  boundaries?: string[];
  evidence?: string[];
}
export interface Checkpoint {
  revision: number;
  at: number;
  author: { id: string; name: string; host: Host };
  scope?: { cwd: string; where: string; project?: string; task?: string; requestRevision: number };
  data: CheckpointData;
}

export function checkpointData(raw: unknown): CheckpointData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('data must be a checkpoint object');
  const value = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (['objective', 'next', 'reference'].includes(key)) {
      if (typeof item !== 'string' || !item.trim() || item.length > 1000) throw new Error(`${key} must contain 1 to 1000 characters`);
      out[key] = item.trim();
    } else if (['decisions', 'verified', 'remaining', 'boundaries', 'evidence'].includes(key)) {
      if (!Array.isArray(item) || item.length > 10 || item.some(v => typeof v !== 'string' || !v.trim() || v.length > 1000))
        throw new Error(`${key} must contain at most 10 nonempty strings, each at most 1000 characters`);
      out[key] = item.map(v => v.trim());
    } else throw new Error(`Unknown checkpoint field: ${key}`);
  }
  if (!out.objective || !out.next) throw new Error('Checkpoint requires objective and next');
  if (JSON.stringify(out).length > 6000) throw new Error('Checkpoint data must fit in 6000 characters');
  return out as unknown as CheckpointData;
}

export function validateCheckpoint(raw: Checkpoint): Checkpoint {
  if (!raw || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || !Number.isFinite(raw.at) || raw.at < 0 ||
      !raw.author || typeof raw.author.id !== 'string' || raw.author.id.length > 256 || typeof raw.author.name !== 'string' || raw.author.name.length > 256 ||
      !['claude', 'codex', 'kimi', 'other'].includes(raw.author.host)) throw new Error('Invalid checkpoint metadata');
  if (raw.scope && (typeof raw.scope.cwd !== 'string' || raw.scope.cwd.length > 4096 || typeof raw.scope.where !== 'string' || raw.scope.where.length > 1000 ||
    !Number.isSafeInteger(raw.scope.requestRevision) || raw.scope.requestRevision < 0 ||
    (raw.scope.project !== undefined && (typeof raw.scope.project !== 'string' || raw.scope.project.length > 1000)) ||
    (raw.scope.task !== undefined && (typeof raw.scope.task !== 'string' || raw.scope.task.length > 128)))) throw new Error('Invalid checkpoint scope');
  return { revision: raw.revision, at: raw.at, author: { id: raw.author.id, name: raw.author.name, host: raw.author.host },
    ...(raw.scope ? { scope: { cwd: raw.scope.cwd, where: raw.scope.where, project: raw.scope.project, task: raw.scope.task, requestRevision: raw.scope.requestRevision } } : {}), data: checkpointData(raw.data) };
}
