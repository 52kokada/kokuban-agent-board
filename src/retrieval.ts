/** Rebuildable source catalog + bounded streaming retrieval over native logs. */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { Board, Host, Session } from './board.js';
import { transcriptSteps } from './glance.js';
import { nativeMemorySources } from './native-memory.js';

export interface TranscriptSource { id: string; name: string; host: Host; file: string; cwd: string; where: string; project?: string; kind?: 'memory' }
const MAX_RECORD = 2 * 1024 * 1024;
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function decode(v: unknown): any {
  if (typeof v !== 'string' || v.length > 4000) throw new Error('Invalid source reference or cursor');
  try { return JSON.parse(Buffer.from(v, 'base64url').toString()); } catch { throw new Error('Invalid source reference or cursor'); }
}

export function rememberTranscripts(board: Board): void {
  for (const s of board.sessions) {
    if (!s.transcript) continue;
    const source: TranscriptSource = { id: s.id, name: s.name, host: s.host, file: s.transcript, cwd: s.cwd, where: s.where, project: s.project };
    const i = board.transcriptSources.findIndex(x => x.id === s.id);
    if (i < 0) board.transcriptSources.push(source); else board.transcriptSources[i] = source;
  }
}

function sources(board: Board, me: Session, args: Record<string, unknown>): TranscriptSource[] {
  rememberTranscripts(board);
  const repo = (where: string) => where.split('@')[0];
  if (args.source !== undefined && !['transcript', 'memory'].includes(String(args.source))) throw new Error('source must be transcript or memory');
  const catalog = args.source === 'memory' ? nativeMemorySources(me, args.cross_repo === true) : board.transcriptSources;
  const task = args.task ? board.workTasks.find(t => t.id === args.task && [t.owner, t.requester].some(e => !e.pc && e.id === me.id)) : undefined;
  if (args.task && !task) throw new Error('Task is unknown to this session');
  return catalog.filter(s => {
    const same = s.id === me.id || (me.project && s.project ? me.project === s.project :
      (repo(me.where) && repo(me.where) === repo(s.where)));
    const participant = task && [task.owner, task.requester].some(e => !e.pc && e.id === s.id);
    return (!task || participant) && (same || participant || args.cross_repo === true) &&
      (!args.who || args.who === s.id || String(args.who).toLowerCase() === s.name.toLowerCase());
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function sourceRecord(source: TranscriptSource, ref: any): Buffer {
  if (!Number.isSafeInteger(ref.offset) || ref.offset < 0 || !Number.isInteger(ref.length) || ref.length < 1 || ref.length > MAX_RECORD || typeof ref.hash !== 'string')
    throw new Error('Invalid source range');
  let fd: number;
  try { fd = fs.openSync(source.file, 'r'); } catch { throw new Error('Original transcript is unavailable'); }
  let raw: Buffer;
  try { raw = Buffer.alloc(ref.length); if (fs.readSync(fd, raw, 0, raw.length, ref.offset) !== raw.length) throw new Error('Source changed; search again'); }
  finally { fs.closeSync(fd); }
  if (hash(raw) !== ref.hash) throw new Error('Source changed; search again');
  return raw;
}

/** Byte offsets remain stable when logs append. Incomplete final records wait. */
async function* lines(file: string, start: number, finalLine = false) {
  let pending = Buffer.alloc(0), offset = start, dropped = 0;
  for await (const chunk of fs.createReadStream(file, { start, highWaterMark: 65536 })) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    let end: number;
    while ((end = pending.indexOf(10)) >= 0) {
      const raw = pending.subarray(0, end);
      yield { raw, offset, length: end, next: offset + end + 1, oversized: dropped > 0 || raw.length > MAX_RECORD };
      offset += end + 1; pending = pending.subarray(end + 1); dropped = 0;
    }
    if (pending.length > MAX_RECORD) { offset += pending.length; dropped += pending.length; pending = Buffer.alloc(0); }
  }
  if (finalLine && pending.length) yield { raw: pending, offset, length: pending.length, next: offset + pending.length, oversized: dropped > 0 || pending.length > MAX_RECORD };
}

export async function searchTranscripts(board: Board, me: Session, args: Record<string, unknown>): Promise<object> {
  const q = typeof args.q === 'string' ? args.q.trim() : '';
  if (!q || q.length > 200) throw new Error('q must contain 1 to 200 characters');
  const limit = args.limit ?? 8;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 20) throw new Error('limit must be 1 to 20');
  const selected = sources(board, me, args);
  const since = args.since === undefined ? undefined : typeof args.since === 'string' ? Date.parse(args.since) : NaN;
  if (since !== undefined && !Number.isFinite(since)) throw new Error('since must be an ISO timestamp');
  if (args.kind !== undefined && !['asked', 'says', 'did', 'notice'].includes(String(args.kind))) throw new Error('kind must be asked, says, did or notice');
  const queryKey = hash(JSON.stringify([q.toLowerCase(), args.who ?? '', args.cross_repo === true, args.source ?? 'transcript', args.task ?? '', args.kind ?? '', since ?? null, me.id]));
  const cursor = args.cursor ? decode(args.cursor) : undefined;
  if (cursor && (cursor.query !== queryKey || typeof cursor.id !== 'string' || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0))
    throw new Error('Cursor belongs to a different query or scope');
  if (cursor) {
    const source = selected.find(s => s.id === cursor.id);
    if (!source || !cursor.anchor) throw new Error('Cursor source is unavailable; search again');
    sourceRecord(source, cursor.anchor);
  }
  const matches: object[] = [], unavailable: string[] = [];
  let skippedRecords = 0, scannedSources = 0;
  for (const source of selected) {
    if (cursor && source.id.localeCompare(cursor.id) < 0) continue;
    scannedSources++;
    try {
      for await (const line of lines(source.file, cursor?.id === source.id ? cursor.offset : 0, source.kind === 'memory')) {
        if (line.oversized) { skippedRecords++; continue; }
        let record; try { record = source.kind === 'memory' ? {} : JSON.parse(line.raw.toString('utf8')); } catch { skippedRecords++; continue; }
        const steps = source.kind === 'memory' ? [{ kind: 'says', text: line.raw.toString('utf8') }] : transcriptSteps(source.host, record);
        const timestamp = record.timestamp ?? record.time ?? null;
        const time = typeof timestamp === 'number' ? timestamp : typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
        if (since !== undefined && (!Number.isFinite(time) || time < since)) continue;
        // Return all matching public parts from this record as one hit, so a
        // page cursor never skips another part of the same record.
        const hits = steps.map((step, part) => ({ step, part })).filter(({ step }) =>
          (!args.kind || step.kind === args.kind) && step.text.toLowerCase().includes(q.toLowerCase()));
        if (!hits.length) continue;
        const anchor = { offset: line.offset, length: line.length, hash: hash(line.raw) };
        const ref = encode({ id: source.id, ...anchor });
        matches.push({ ref, session: source.name, session_id: source.id, host: source.host, source_kind: source.kind ?? 'transcript', timestamp,
          parts: hits.slice(0, 4).map(({ step, part }) => {
            const at = step.text.toLowerCase().indexOf(q.toLowerCase());
            return { part, kind: step.kind, excerpt: step.text.slice(Math.max(0, at - 100), at + q.length + 220), truncated: step.text.length > 320 };
          }), more_parts: hits.length > 4 });
        if (matches.length >= Number(limit)) return { matches, next_cursor: encode({ id: source.id, offset: line.next, anchor, query: queryKey }),
          scanned_sources: scannedSources, unavailable, skipped_records: skippedRecords, coverage: 'Catalogued native transcripts; public records only. Continue next_cursor until null.' };
      }
    } catch { unavailable.push(source.id); }
  }
  return { matches, next_cursor: null, scanned_sources: scannedSources, unavailable, skipped_records: skippedRecords,
    coverage: 'Catalogued native transcripts, including archived session pointers; not undiscovered historical files. Public records only.' };
}

export function readTranscript(board: Board, me: Session, args: Record<string, unknown>): object {
  const ref = decode(args.ref);
  const source = sources(board, me, args).find(s => s.id === ref.id);
  if (!source) throw new Error('Source is unavailable in this scope');
  const part = args.part ?? 0, offset = args.offset ?? 0;
  if (!Number.isInteger(part) || Number(part) < 0 || !Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error('Invalid part or text offset');
  const raw = sourceRecord(source, ref);
  const step = (source.kind === 'memory' ? [{ kind: 'says', text: raw.toString('utf8') }] : transcriptSteps(source.host, JSON.parse(raw.toString('utf8'))))[Number(part)];
  if (!step) throw new Error('Public transcript part is unavailable');
  const text = step.text.slice(Number(offset), Number(offset) + 6000);
  return { ref: args.ref, session: source.name, host: source.host, source_kind: source.kind ?? 'transcript', kind: step.kind, text,
    next_offset: Number(offset) + text.length < step.text.length ? Number(offset) + text.length : null,
    evidence: 'Historical transcript evidence; statements and tool results are not current authorization or verified task completion.' };
}
