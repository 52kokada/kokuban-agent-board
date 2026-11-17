import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
export function identityFile(sessionId, home = homedir()) {
  const id = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 24);
  return join(home, '.kimi-code', 'kokuban-context', `${id}.json`);
}
/** Where kimi-hook.mjs keeps the session's current terminal badge (D125), beside its identity file. */
export function badgeFile(sessionId, home = homedir()) {
  return identityFile(sessionId, home).replace(/\.json$/, '.badge.json');
}
/** The per-PC Kokuban setting terminalStatusBadges (off unless it is exactly true). */
export function badgesOn(dataDir = join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'state'), 'kokuban')) {
  try { return JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).terminalStatusBadges === true; }
  catch { return false; }
}
/** The tab title to paint: the badge while badges are on and one is recorded, else "name · Kimi". */
export function paintedTitle(sessionId, name, on = badgesOn(), home = homedir()) {
  if (on && sessionId) {
    try {
      const badge = JSON.parse(readFileSync(badgeFile(sessionId, home), 'utf8'));
      if (badge.sessionId === sessionId && typeof badge.title === 'string' && !/[\x00-\x1f\x7f-\x9f]/.test(badge.title)) return badge.title;
    } catch {}
  }
  return name ? `${name} · Kimi` : '';
}
export function formatStatus(snapshot, name) {
  return [name && `${clean(name)} · Kimi`, clean(snapshot.model),
    snapshot.planMode && 'plan', clean(snapshot.cwd),
    snapshot.gitBranch && `[${clean(snapshot.gitBranch)}]`].filter(Boolean).join('  ');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const snapshot = JSON.parse(raw);
    let name = '';
    if (snapshot.sessionId) {
      try {
        const identity = JSON.parse(readFileSync(identityFile(snapshot.sessionId), 'utf8'));
        if (identity.sessionId === snapshot.sessionId) name = clean(identity.name);
      } catch {}
    }
    // The footer preserves ANSI/OSC controls. Set the tab title as it is painted,
    // so Kimi's own later session-title update cannot leave the generic label.
    // With terminal badges on (D125) the painted title is the badge, which also undoes Kimi's own retitling.
    const painted = paintedTitle(snapshot.sessionId, name);
    const title = painted ? `\x1b]2;${painted}\x07` : '';
    console.log(title + formatStatus(snapshot, name));
  } catch { process.exitCode = 1; }
}
