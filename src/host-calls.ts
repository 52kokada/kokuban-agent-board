/**
 * Ties an MCP tool call to the host session that made it. The MCP request carries no session id, but
 * Claude Code runs the PreToolUse hook (which does) just before it, with the same arguments. So the hook
 * notes (session, tool, arguments) and the MCP call claims the matching note. This keeps a session's name
 * when the agent lost it, for instance after context compaction, and passes me="new" or a stale name.
 */
import type { Board } from './board.js';

const WINDOW_MS = 30_000;
interface Pending { session: string; key: string; at: number }
const pending = new WeakMap<object, Pending[]>();

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}
const keyOf = (tool: string, args: unknown): string => `${tool}\u0000${canonical(args ?? {})}`;

/** PreToolUse for mcp__kokuban__<tool>: remember which session is about to call it. */
export function noteCall(board: Board, session: string, tool: string, args: unknown): void {
  const now = board.clock();
  const list = (pending.get(board) ?? []).filter((p) => now - p.at < WINDOW_MS);
  list.push({ session, key: keyOf(tool, args), at: now });
  pending.set(board, list.slice(-200));
}

/** The session whose hook announced this exact call, consumed once; undefined when none did. */
export function claimCall(board: Board, tool: string, args: unknown): string | undefined {
  const now = board.clock();
  const list = (pending.get(board) ?? []).filter((p) => now - p.at < WINDOW_MS);
  const key = keyOf(tool, args);
  const at = list.findIndex((p) => p.key === key);
  const found = at >= 0 ? list.splice(at, 1)[0] : undefined;
  pending.set(board, list);
  return found?.session;
}
