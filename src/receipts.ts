/** Explicit receipts can accompany useful work on any board tool. */
import type { Board, Session } from './board.js';

export const ACK_SCHEMA = { type: 'array', maxItems: 50, items: { type: 'integer', minimum: 1 },
  description: 'Received message IDs. Attach to normal work; never make a separate receipt-only call.' };

export function acknowledgeMail(board: Board, me: Session, raw: unknown): number {
  let ack: unknown = raw === undefined ? [] : raw;
  if (typeof ack === 'string' && ack.length <= 2048) {
    try { const parsed: unknown = JSON.parse(ack); ack = typeof parsed === 'number' ? [parsed] : parsed; }
    catch { /* Strict validation below handles cached-client invalid input. */ }
  }
  if (!Array.isArray(ack) || ack.length > 50 || ack.some(id => !Number.isSafeInteger(id) || id < 1))
    throw new Error('ack must contain at most 50 positive integer message IDs');
  const ids = new Set<number>(ack);
  const receipts = board.messages.filter(m => ids.has(m.id));
  if (receipts.some(m => m.to !== me.id || (!m.delivered && m.shownTo !== me.id)))
    throw new Error('ack IDs must be messages previously shown to this session');
  const fresh = receipts.filter(m => !m.delivered);
  board.confirm(me, fresh);
  return fresh.length;
}
