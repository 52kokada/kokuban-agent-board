import type { Board } from '../board.js';
import type { ChatSession } from '../conversations/contracts.js';
type RosterSession = ChatSession | { id: string; name: string; provider: string; project: string; external: true; phase: string; statusText: string; doing: string; next: string; approvals: never[]; messages: never[] };

/** Current PC presence, not the durable conversation archive. */
export function phoneRoster(board: Board, conversations: ChatSession[]) {
  const managed = new Map(conversations.map(s => [s.id, s]));
  return board.sessions.filter(s => board.isLive(s)).flatMap<RosterSession>(s => {
    if (s.managed) {
      const chat = managed.get(s.managed);
      return chat && !['closed', 'recovery'].includes(chat.phase) ? [chat] : [];
    }
    return [{ id: s.id, name: s.name, provider: s.host, project: s.project || s.where,
      external: true, phase: s.state === 'working' ? 'working' : s.work === 'done' ? 'closed' : s.work === 'blocked' ? 'error' : s.work === 'paused' ? 'stopped' : 'idle',
      statusText: board.status(s), doing: board.summary(s), next: s.next || '', approvals: [], messages: [] }];
  }).sort((a, b) => Number('role' in b && b.role === 'chief') - Number('role' in a && a.role === 'chief'));
}
