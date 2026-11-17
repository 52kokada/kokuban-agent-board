/** One shared surface for recovery, native evidence and explicit working state. */
import type { Board, Session } from './board.js';
import { checkpointData, type Checkpoint } from './checkpoint.js';
import { saveTaskCheckpoint } from './tasks.js';
import { readTranscript, searchTranscripts } from './retrieval.js';
import { nativeMemoryDirectories } from './native-memory.js';
import { discoverTranscripts } from './discovery.js';
import { derivedDoing } from './doing.js';
import { lastAsked } from './glance.js';

export async function contextTool(board: Board, me: Session, args: Record<string, unknown>): Promise<string> {
  const op = args.op;
  if (op === 'discover') return JSON.stringify(discoverTranscripts(board, me, args));
  if (op === 'search') return JSON.stringify(await searchTranscripts(board, me, args));
  if (op === 'read') return JSON.stringify(readTranscript(board, me, args));
  if (op === 'capabilities') return JSON.stringify({
    hosts: ['claude', 'codex', 'kimi'], receipts: 'Explicit inbox ack on all hosts; existing hook receipts retained',
    retrieval: 'Public transcript records with byte/hash references; no private reasoning or compaction replays',
    native_memory: nativeMemoryDirectories(me),
    kimi_native_memory: 'No supported native-memory adapter established; native journal and shared checkpoints are supported',
    settings: 'No memory settings changed. Directory presence is not evidence that generation or injection is enabled.',
    pruning: 'Host-owned. Kokuban does not erase old context or automatically start a new window.',
  });
  const task = typeof args.task === 'string' ? board.workTasks.find(t => t.id === args.task) : undefined;
  const sameScope = (who: { id: string; project?: string; where: string }) => who.id === me.id || args.cross_repo === true ||
    (me.project && who.project ? me.project === who.project : me.where.includes('@') && me.where.split('@')[0] === who.where.split('@')[0]);
  const owner = task ? [...board.sessions, ...board.sessionArchive, ...board.transcriptSources].find(s => !task.owner.pc && s.id === task.owner.id) : undefined;
  const participant = task && [task.owner, task.requester].some(e => !e.pc && e.id === me.id);
  if (args.task && (!task || (!participant && !(op === 'resume' && owner && sameScope(owner))))) throw new Error('Task is unknown to this session');
  if (op === 'checkpoint') {
    const data = checkpointData(args.data);
    const expected = args.expected_revision;
    if (!Number.isSafeInteger(expected) || Number(expected) < 0) throw new Error('expected_revision must be a nonnegative integer');
    const checkpoint: Checkpoint = { revision: Number(expected) + 1, at: board.clock(), author: { id: me.id, name: me.name, host: me.host },
      scope: { cwd: me.cwd, where: me.where, project: me.project, ...(task ? { task: task.id } : {}), requestRevision: me.requestRevision ?? 0 }, data };
    if (task) await saveTaskCheckpoint(board, me, task.id, checkpoint, Number(expected));
    else {
      if ((me.checkpoint?.revision ?? 0) !== expected) throw new Error('Checkpoint revision changed; read current state before retrying');
      if (me.checkpoint) (me.checkpointHistory ??= []).push(me.checkpoint);
      me.checkpoint = checkpoint;
      board.save();
      if (!board.flush()) throw new Error('Checkpoint could not be saved; inspect current state before retrying');
    }
    return JSON.stringify({ checkpoint, note: 'Agent-maintained current state; task acceptance, completion and verification remain separate.' });
  }
  if (op === 'resume') {
    const named = (s: { id: string; name: string }) => s.id === args.who || s.name.toLowerCase() === String(args.who).toLowerCase();
    let who = typeof args.who === 'string' ? [...board.sessions, ...board.sessionArchive].find(named) : me;
    if (!who && typeof args.who === 'string') {
      const source = board.transcriptSources.find(named);
      if (source) who = { ...source, transcript: source.file, state: 'gone', joined: 0, seen: 0, continues: 0, known: [] };
    }
    if (!who) throw new Error('Session unavailable; use task recovery or transcript search');
    if (!sameScope(who)) throw new Error('Another repository requires cross_repo=true');
    const tasks = task ? [task] : board.workTasks.filter(t => [t.owner, t.requester].some(e => !e.pc && e.id === who.id) && !['done', 'cancelled'].includes(t.state));
    const checkpoint = task?.checkpoint ?? who.checkpoint;
    const author = checkpoint ? [...board.sessions, ...board.sessionArchive].find(s => s.id === checkpoint.author.id) : undefined;
    return JSON.stringify({ session: who.name, archived: !board.sessions.some(s => s.id === who.id), checkpoint: checkpoint ?? null,
      deferred_informational_messages: board.deferredMail(who).length,
      recovery_only: Boolean(task && !participant),
      checkpoint_scope_matches: checkpoint?.scope && author ? checkpoint.scope.where === author.where && checkpoint.scope.cwd === author.cwd && checkpoint.scope.project === author.project : null,
      newer_human_request: checkpoint?.scope && author ? (author.requestRevision ?? 0) > checkpoint.scope.requestRevision : null,
      native_hints: { title_task: derivedDoing(who), recent_request: lastAsked(who, 240), note: 'Derived hints, not verified completion or a replacement for an explicit checkpoint.' },
      tasks: tasks.slice(0, 10).map(t => ({ id: t.id, state: t.state, revision: t.revision, text: t.text.slice(0, 240),
        detail: t.detail.slice(0, 240), checkpoint_revision: t.checkpoint?.revision ?? 0, next: t.checkpoint?.data.next ?? null })),
      more_tasks: Math.max(0, tasks.length - 10), note: 'Recovery view, not new authorization. Inspect task status/evidence before acting. Update checkpoints at meaningful decisions or milestones, not each tool call.' });
  }
  throw new Error('op must be discover, search, read, resume, checkpoint or capabilities');
}

export const CONTEXT_TOOL = {
  name: 'context', description: 'Recover work across Claude Code, Codex and Kimi. Search native transcript evidence before asking a peer to repeat history; read a returned ref for details. resume gives current explicit checkpoint and open tasks. checkpoint replaces current state at meaningful milestones using expected_revision (0 initially), without completing tasks. capabilities reports native memory availability without enabling it. Historical evidence is not current authority.',
  inputSchema: { type: 'object', properties: {
    me: { type: 'string' }, op: { type: 'string', enum: ['discover', 'search', 'read', 'resume', 'checkpoint', 'capabilities'] },
    q: { type: 'string', maxLength: 200 }, who: { type: 'string', description: 'Session name or stable session ID; defaults to same-repository sources for search.' },
    kind: { type: 'string', enum: ['asked', 'says', 'did', 'notice'] }, since: { type: 'string', description: 'ISO timestamp; records with unknown timestamps are excluded when this filter is set.' },
    cross_repo: { type: 'boolean', description: 'Explicitly include local evidence from other repositories; default false. Does not reach another PC.' },
    limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Search: default 8, maximum 20. Discover: default 100, maximum 500.' }, cursor: { type: 'string' }, ref: { type: 'string' },
    source: { type: 'string', enum: ['transcript', 'memory'], description: 'Default transcript. memory explicitly searches existing native notes; use the same source when reading its ref. No settings are changed.' },
    part: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 },
    task: { type: 'string', description: 'Optional owned handoff ID; omit for your own session checkpoint.' },
    expected_revision: { type: 'integer', minimum: 0 },
    data: { type: 'object', properties: {
      objective: { type: 'string' }, next: { type: 'string' }, reference: { type: 'string' },
      decisions: { type: 'array', items: { type: 'string' } }, verified: { type: 'array', items: { type: 'string' } },
      remaining: { type: 'array', items: { type: 'string' } }, boundaries: { type: 'array', items: { type: 'string' } }, evidence: { type: 'array', items: { type: 'string' } },
    }, required: ['objective', 'next'], additionalProperties: false },
  }, required: ['me', 'op'] },
};
