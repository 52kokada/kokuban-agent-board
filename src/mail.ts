/** One boundary for peer words on every delivery path. Metadata stays outside the body. */
import type { Board, Message, Session } from './board.js';

const clean = (v: string): string => v.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
export const defang = (body: string): string => clean(body).replace(/(<\/?)(kokuban-message)/gi, '$1kokuban_message');
const attr = (v: string): string => clean(v.replace(/[\r\n]/g, ' '))
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function frameMail(board: Board, m: Message): string {
  // Transcript recovery extracts the frame alone, so retain its sender (including remote PC).
  return `<kokuban-message from="${attr(m.from)}" id="${m.id}" sent_at="${new Date(m.ts).toISOString()}"${m.task ? ` task="${attr(m.task)}"` : ''}>\n` +
    `${defang(m.text)}\n</kokuban-message>\n[kokuban] Message from ${defang(board.header(m)).replace(/[\r\n]/g, ' ')}.`;
}

/** Shared delivery budget. Preserve a single oversized body intact, never hidden. */
export function selectMail(board: Board, pending: Message[], render = (m: Message) => frameMail(board, m), limit = 10) {
  const mail: Message[] = [];
  const texts: string[] = [];
  let chars = 0;
  const priority = (m: Message) => m.person || m.noticeKind === 'cancel' ? 3 : m.noticeKind === 'result' || m.noticeKind === 'follow-up' ? 2 :
    m.direct !== false && m.wakeAfter === undefined ? 1 : 0;
  const ordered = [...pending].sort((a, b) => priority(b) - priority(a) || a.ts - b.ts || a.id - b.id);
  for (const m of ordered) {
    const text = render(m);
    if (mail.length && (mail.length >= limit || chars + text.length + 1 > 12_000)) break;
    mail.push(m); texts.push(text); chars += text.length + (mail.length > 1 ? 1 : 0);
  }
  return { mail, text: texts.join('\n'), chars, remaining: pending.length - mail.length, oversized: chars > 12_000 };
}

export function receiptHint(mail: Message[], remaining = 0, oversized = false, includeAck = true): string {
  if (!mail.length) return '';
  const parts = (includeAck ? `Next board call: ack=${JSON.stringify(mail.map(m => m.id))} (receipt, not completion). No receipt-only call.` : '') +
    (remaining ? ` ${remaining} more eligible messages remain; read inbox when needed.` : '') +
    (oversized ? ' One oversized message was preserved in full.' : '');
  return parts ? '\n[kokuban] ' + parts.trim() : '';
}

export function offerMail(board: Board, session: Session): string {
  const batch = selectMail(board, board.messages.filter(m => board.ready(m, session) && !board.isDeferred(m, session)));
  const replayed = batch.mail.filter(m => m.shownAt !== undefined).length;
  board.show(session, batch.mail);
  if (batch.mail.length) board.usage?.({ ts: board.clock(), tool: 'mail:offer', me: session.name,
    path: 'hook', messages: batch.mail.length, remaining: batch.remaining, replayed,
    bodyChars: batch.chars, oversized: batch.oversized });
  const deferred = board.deferredMail(session);
  const key = `${session.deferredMailBefore}:${deferred.length}:${deferred.at(-1)?.id}`;
  const summary = deferred.length && session.deferredNoticeKey !== key ? deferredHint(deferred.length) : '';
  if (summary) { session.deferredNoticeKey = key; board.save(); }
  return batch.text + receiptHint(batch.mail, batch.remaining, batch.oversized, !session.toolReceipts || replayed > 0) + summary;
}

export function deferredHint(count: number): string {
  return count ? `\n[kokuban] ${count} older informational messages remain unread. Use inbox(include_deferred=true) if relevant. Actionable and human mail is not deferred.` : '';
}
