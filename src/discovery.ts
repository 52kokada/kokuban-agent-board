/** Discover older native logs without loading their conversations into context. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Board, Host, Session } from './board.js';
import { projectOf } from './git.js';
import type { TranscriptSource } from './retrieval.js';

function files(root: string, accept: (file: string) => boolean, depth = 0): string[] {
  if (depth > 8) return [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap(e => {
    if (e.isSymbolicLink() || e.name === 'subagents') return [];
    const file = path.join(root, e.name);
    return e.isDirectory() ? files(file, accept, depth + 1) : e.isFile() && accept(file) ? [file] : [];
  });
}

export function discoverTranscripts(board: Board, me: Session, args: Record<string, unknown>): object {
  const limit = args.limit ?? 100;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 500) throw new Error('Discovery limit must be 1 to 500');
  const home = os.homedir();
  const roots: [Host, string, (file: string) => boolean][] = [
    ['claude', path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'), file => file.endsWith('.jsonl')],
    ['codex', path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions'), file => /rollout-.*\.jsonl$/.test(file)],
    ['codex', path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'archived_sessions'), file => /rollout-.*\.jsonl$/.test(file)],
    ['kimi', path.join(process.env.KIMI_CODE_HOME || path.join(home, '.kimi-code'), 'sessions'), file => path.basename(file) === 'state.json'],
  ];
  const candidates = roots.flatMap(([host, root, accept]) => files(root, accept).map(file => ({ host, file, key: `${host}:${file}` }))).sort((a, b) => a.key.localeCompare(b.key));
  let after = '';
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== 'string' || args.cursor.length > 4000) throw new Error('Invalid discovery cursor');
    try { const value = JSON.parse(Buffer.from(args.cursor, 'base64url').toString());
      if (value.op !== 'discover' || value.scope !== me.id || typeof value.after !== 'string') throw new Error();
      after = value.after;
    } catch { throw new Error('Invalid discovery cursor'); }
  }
  const page = candidates.filter(v => v.key.localeCompare(after) > 0).slice(0, Number(limit));
  let added = 0, skipped = 0, outsideScope = 0;
  for (const item of page) {
    try {
      let cwd = '', id = '', name = '', file = item.file;
      const fd = fs.openSync(item.file, 'r');
      let head: string;
      try { const buf = Buffer.alloc(128 * 1024); head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8'); }
      finally { fs.closeSync(fd); }
      if (item.host === 'kimi') {
        const state = JSON.parse(head);
        cwd = state.cwd; id = `kimi-${state.id}`;
        file = path.join(path.dirname(item.file), 'agents', 'main', 'wire.jsonl');
      } else {
        for (const raw of head.split('\n')) {
          let r; try { r = JSON.parse(raw); } catch { continue; }
          if (item.host === 'codex' && r.type === 'session_meta') {
            if (/subagent/i.test(JSON.stringify([r.payload?.source, r.payload?.thread_source]))) break;
            cwd = r.payload?.cwd; id = r.payload?.id; break;
          }
          if (item.host === 'claude') {
            if (r.isSidechain) continue;
            cwd ||= r.cwd; id ||= r.sessionId;
            if (r.type === 'agent-name') name = r.agentName ?? '';
            if (cwd && id) break;
          }
        }
      }
      if (typeof cwd !== 'string' || !cwd || typeof id !== 'string' || !id || !fs.existsSync(file)) { skipped++; continue; }
      const project = projectOf(cwd);
      if (args.cross_repo !== true && project !== (me.project || projectOf(me.cwd))) { outsideScope++; continue; }
      if (board.transcriptSources.some(s => s.id === id)) continue;
      const source: TranscriptSource = { id, name: name || `${item.host}:${id.slice(0, 12)}`, host: item.host, file, cwd,
        where: `${path.basename(cwd)}@historical`, project };
      board.transcriptSources.push(source); added++;
    } catch { skipped++; }
  }
  if (added) { board.save(); if (!board.flush()) throw new Error('Source catalog could not be saved; retry discovery'); }
  const last = page.at(-1)?.key;
  return { inspected: page.length, added, outside_scope: outsideScope, unavailable_metadata: skipped,
    next_cursor: last && candidates.some(v => v.key.localeCompare(last) > 0)
      ? Buffer.from(JSON.stringify({ op: 'discover', scope: me.id, after: last })).toString('base64url') : null,
    note: 'Native metadata only; no conversation bodies injected. Unknown layouts and missing sources are counted, not guessed.' };
}
