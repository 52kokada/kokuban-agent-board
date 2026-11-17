/**
 * Opt-in terminal badges for Claude Code (settings terminalStatusBadges, D125): the terminal tab
 * reads "🧡 name" while the session works and "🤍 name" when it is idle. Codex badges live in codex-title.ts
 * (Codex copies its thread name into the console title itself); Kimi's live in scripts/kimi-hook.mjs.
 *
 * Display only: this never changes a session, its mail or any hook reply. The daemon already hears every
 * Claude turn boundary over HTTP, so no hook command is added: on a change of badge it runs the small
 * console-title helper once (tools/TerminalTitle, compiled from source by `kokuban install`), pointed at the
 * Claude process that ~/.claude/sessions names for the session. Tool events with an unchanged badge start
 * nothing. Every failure is silent: a title is never worth disturbing a session.
 */
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from './board.js';
import { DATA_DIR } from './config.js';
import { readSettings } from './pair.js';

export const HELPER = path.join(DATA_DIR, 'terminal-title', 'KokubanTitle.exe');
const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'TerminalTitle', 'TerminalTitle.cs');

export const badgesOn = (): boolean => readSettings().terminalStatusBadges === true;

/** A name that is safe to show as a title, or null. */
export function cleanName(name: unknown): string | null {
  return typeof name === 'string' && name.trim() && name.length <= 80 && !/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/.test(name)
    ? name : null;
}

export function claudeBadge(name: string, working: boolean): string {
  return `${working ? '🧡' : '🤍'} ${name}`;
}

/** The Claude Code process for a session id, from the one small file per process in ~/.claude/sessions. */
export function claudePid(id: string, dir = path.join(os.homedir(), '.claude', 'sessions')): number | null {
  try {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        const { pid, sessionId } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (sessionId === id && Number.isInteger(pid) && pid > 0) return pid;
      } catch { /* one unreadable file says nothing about the others */ }
    }
  } catch { /* no sessions folder */ }
  return null;
}

export type TitleRunner = (args: string[]) => Promise<boolean>;

const runHelper: TitleRunner = (args) => new Promise((resolve) => {
  if (process.platform !== 'win32' || !fs.existsSync(HELPER)) return resolve(false);
  execFile(HELPER, args, { windowsHide: true, timeout: 2000 }, (err) => resolve(!err));
});

const shown = new Map<string, string>();

export interface BadgeDeps {
  /** The hook event just handled: a session that has only started waits for its first prompt. */
  event?: string;
  on?: () => boolean; pid?: (id: string) => number | null; run?: TitleRunner; retryMs?: number;
}

/** Bring one Claude session's tab badge in line with its state; does nothing when badges are off. */
export function syncClaudeBadge(s: Session, deps: BadgeDeps = {}): void {
  try {
    if (s.host !== 'claude' || s.managed || s.id.startsWith('manual-')) return;
    if (!(deps.on ?? badgesOn)()) { shown.delete(s.id); return; }
    if (s.state === 'gone') { shown.delete(s.id); return; }
    const name = cleanName(s.name);
    if (!name) return;
    const title = claudeBadge(name, deps.event !== 'SessionStart' && s.state === 'working');
    if (shown.get(s.id) === title) return;
    shown.set(s.id, title);
    const attempt = (retry: boolean): void => {
      const pid = (deps.pid ?? claudePid)(s.id);
      // A new session can reach the board before Claude writes its process file: look once more shortly.
      if (!pid) {
        if (retry) setTimeout(() => { if (shown.get(s.id) === title) attempt(false); }, deps.retryMs ?? 3000).unref?.();
        else if (shown.get(s.id) === title) shown.delete(s.id);
        return;
      }
      void (deps.run ?? runHelper)(['set', String(pid), Buffer.from(title, 'utf8').toString('base64')]).then((ok) => {
        if (!ok && shown.get(s.id) === title) shown.delete(s.id);
      });
    };
    attempt(true);
  } catch { /* fail open */ }
}

/** Compile the helper from its source with the .NET Framework compiler every Windows 10/11 carries. */
export function buildHelper(): string {
  if (process.platform !== 'win32') return 'Terminal badges: Windows only, skipped';
  const windir = process.env.WINDIR ?? 'C:\\Windows';
  const csc = ['Framework64', 'Framework'].map((f) => path.join(windir, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find((p) => fs.existsSync(p));
  if (!csc) return 'Terminal badges: no .NET Framework compiler (csc.exe) found; badges stay off';
  if (!fs.existsSync(SOURCE)) return `Terminal badges: helper source missing (${SOURCE}); badges stay off`;
  try {
    fs.mkdirSync(path.dirname(HELPER), { recursive: true });
    const tmp = `${HELPER}.new`;
    execFileSync(csc, ['-nologo', '-target:winexe', '-optimize', `-out:${tmp}`, SOURCE], { windowsHide: true, stdio: 'ignore' });
    fs.renameSync(tmp, HELPER);
    return `Terminal badges: title helper built at ${HELPER}`;
  } catch (err) {
    return `Terminal badges: helper build failed (${(err as Error).message.split('\n')[0]}); badges stay off`;
  }
}
