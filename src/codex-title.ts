/**
 * Shows a Codex session's board name and summary where its human looks: the
 * thread title, which Codex puts on the terminal tab. Renaming goes through
 * Codex's own app-server (`thread/name/set`).
 */
import type { Session } from './board.js';
import { codexRpc } from './codex-rpc.js';
import { currentTitle } from './doing.js';
import { readSettings } from './pair.js';

const SEPARATOR = ' \u00b7 ';

/** Opt-in terminal badges (settings terminalStatusBadges, D125): 🟠 name while working, ⚪ name otherwise. */
export function titleFor(s: Session, current: string, badges = false): string {
  if (badges) return `${s.state === 'working' ? '🟠' : '⚪'} ${s.name}`;
  if (current === `🟠 ${s.name}` || current === `⚪ ${s.name}`) current = '';
  const own = current.startsWith(s.name + SEPARATOR) ? current.slice((s.name + SEPARATOR).length) : current;
  const explicit = s.doing && Date.now() - (s.doingAt ?? s.joined) < 2 * 60 * 60_000 ? s.doing : '';
  const about = (explicit || (current === s.name ? '' : own)).replace(/\s+/g, ' ').trim();
  return about ? `${s.name}${SEPARATOR}${about.length > 70 ? `${about.slice(0, 69)}…` : about}` : s.name;
}

const requested = new Map<string, string>();

/** Bring a Codex session's thread title in line with the board; a no-op when it already is. */
export function syncCodexTitle(s: Session): void {
  if (s.host !== 'codex' || s.id.startsWith('manual-')) return;
  const current = currentTitle(s.id);
  const wanted = titleFor(s, current, readSettings().terminalStatusBadges === true);
  if (wanted === current || requested.has(s.id)) return;
  requested.set(s.id, wanted);
  void codexRpc('thread/name/set', { threadId: s.id, name: wanted }).finally(() => {
    requested.delete(s.id);
  });
}
