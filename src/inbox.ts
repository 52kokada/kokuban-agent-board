/** Bounded inbox offers with explicit, host-independent receipts. */
import type { Board, Session } from './board.js';
import { ago } from './board.js';
import { frameMail, selectMail, receiptHint, deferredHint } from './mail.js';
import { acknowledgeMail } from './receipts.js';

const DEFAULT_LIMIT = 10;

export async function inboxTool(board: Board, me: Session, args: Record<string, unknown>): Promise<string> {
  const limit = args.limit === undefined ? DEFAULT_LIMIT : args.limit;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 50)
    throw new Error('limit must be an integer from 1 to 50');
  if (args.include_deferred !== undefined && typeof args.include_deferred !== 'boolean') throw new Error('include_deferred must be a boolean');
  const acknowledged = acknowledgeMail(board, me, args.ack);

  if (!(args.include_deferred === true && board.messages.some(m => board.ready(m, me))))
    await board.wait(me, Math.min(50, Math.max(0, Number(args.wait_s) || 0)) * 1000);
  const ready = board.messages.filter(m => board.ready(m, me) && (args.include_deferred === true || !board.isDeferred(m, me)));
  const { mail, text, chars, remaining, oversized } = selectMail(board, ready,
    m => `${frameMail(board, m)} (${ago(board.clock() - m.ts)} ago)`, Number(limit));
  const replayed = mail.filter(m => m.shownAt !== undefined).length;
  board.show(me, mail);
  board.usage?.({ ts: board.clock(), tool: 'inbox:offer', me: me.name,
    messages: mail.length, remaining,
    acknowledged, replayed, bodyChars: chars,
    oversized });
  const deferred = args.include_deferred === true ? '' : deferredHint(board.deferredMail(me).length);
  if (!mail.length) return 'no new messages' + deferred;
  return text + receiptHint(mail, remaining, oversized, !me.toolReceipts || replayed > 0) + deferred;
}
