// Kimi command hook bridge. Fail open when the board is unavailable.
// Only blockable hooks receive context: observation-only hooks must not take mail.
export async function relay(payload, base = 'http://127.0.0.1:47600', request = fetch, automatic = process.env.KOKUBAN_KIMI_WAKE === '1') {
  if (!payload.session_id || payload.agent_id) return { text: '', blocked: false };
  // A one-shot delivery process exiting does not mean the person's conversation closed.
  if (automatic && payload.hook_event_name === 'SessionEnd') return { text: '', blocked: false };
  if (!['UserPromptSubmit', 'Stop', 'SessionEnd', 'SessionStart', 'Interrupt', 'StopFailure', 'PostToolUse', 'PostCompact'].includes(payload.hook_event_name)) {
    return { text: '', blocked: false };
  }
  const promptText = value => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(promptText).filter(Boolean).join('\n');
    if (value && typeof value === 'object') return promptText(value.text ?? value.content ?? value.message);
    return '';
  };
  const response = await request(`${base}/hook/kimi`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hook_event_name: payload.hook_event_name, session_id: `kimi-${payload.session_id}`,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
      prompt: promptText(payload.prompt),
      ...(Number.isInteger(payload.console_pid) && payload.console_pid > 0 && !automatic ? { console_pid: payload.console_pid } : {}),
    }),
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`Kokuban returned ${response.status}`);
  const raw = await response.text();
  const result = raw ? JSON.parse(raw) : {};
  if (['SessionStart', 'Interrupt', 'StopFailure', 'PostToolUse', 'PostCompact'].includes(payload.hook_event_name)) {
    return { text: '', blocked: false };
  }
  return {
    text: result.decision === 'block' ? result.reason ?? '' : result.hookSpecificOutput?.additionalContext ?? '',
    blocked: result.decision === 'block',
  };
}

import { pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { identityFile, badgeFile, badgesOn } from './kimi-statusline.mjs';

// D125 terminal badges (settings terminalStatusBadges, off by default): 🟧 name while Kimi works, ⬜ name
// when idle. Display only: it runs after the relay, never changes what the board hears or what Kimi sees.
const WORKING = new Set(['UserPromptSubmit', 'PostToolUse']);
const IDLE = new Set(['SessionStart', 'Stop', 'Interrupt', 'StopFailure']);
export function kimiBadge(name, event, blocked = false) {
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/.test(name)) return null;
  // A Stop that mail turned into more work keeps working.
  const working = WORKING.has(event) || (event === 'Stop' && blocked);
  if (!working && !IDLE.has(event)) return null;
  return `${working ? '🟧' : '⬜'} ${name}`;
}

const HELPER = join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'state'), 'kokuban', 'terminal-title', 'KokubanTitle.exe');
/** The native helper walks up from this hook past kimi.exe to the shell whose console is the tab. */
const runHelper = (title) => {
  if (process.platform !== 'win32') return false;
  const r = spawnSync(HELPER, ['kimi', String(process.pid), Buffer.from(title, 'utf8').toString('base64')],
    { windowsHide: true, stdio: 'ignore', timeout: 2000 });
  return !r.error && r.status === 0;
};

/** Set the tab badge when it changed; the status line repaints the same title (kimi-statusline.mjs). */
export function syncBadge(payload, blocked, deps = {}) {
  try {
    const automatic = deps.automatic ?? process.env.KOKUBAN_KIMI_WAKE === '1';
    if (automatic || !payload.session_id || payload.agent_id || !(deps.on ?? badgesOn)()) return null;
    const home = deps.home ?? homedir();
    const identity = JSON.parse(readFileSync(identityFile(payload.session_id, home), 'utf8'));
    if (identity.sessionId !== payload.session_id) return null;
    const title = kimiBadge(identity.name, payload.hook_event_name, blocked);
    if (!title) return null;
    const file = badgeFile(payload.session_id, home);
    try { if (JSON.parse(readFileSync(file, 'utf8')).title === title) return null; } catch {}
    writeFileSync(file, JSON.stringify({ sessionId: payload.session_id, title }) + '\n');
    (deps.run ?? runHelper)(title);
    return title;
  } catch { return null; }
}

// D130: the open Kimi window that runs this hook, so the board can wake the session there, visibly,
// instead of in a hidden process. Kimi starts hooks through a short-lived shell, so the native helper
// walks up to the outermost kimi.exe while that chain still exists. Only prompts and session starts ask
// (a few milliseconds); a hidden wake process has no window and never reports one.
const TYPIST = join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'state'), 'kokuban', 'console-input', 'KokubanType.exe');
export function kimiConsole(payload, deps = {}) {
  try {
    const automatic = deps.automatic ?? process.env.KOKUBAN_KIMI_WAKE === '1';
    if (automatic || payload.agent_id || !['UserPromptSubmit', 'SessionStart'].includes(payload.hook_event_name)) return null;
    if ((deps.platform ?? process.platform) !== 'win32') return null;
    const run = deps.run ?? ((args) => spawnSync(TYPIST, args, { windowsHide: true, encoding: 'utf8', timeout: 1500 }));
    const r = run(['find', String(deps.ppid ?? process.ppid)]);
    const pid = Number(String(r?.stdout ?? '').trim());
    return !r?.error && r?.status === 0 && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

/** Remember this session's board name for the tab badge and status line. Kept apart from compaction:
 *  D133's shorter intro has no compaction marker, and tying the two together hid every Kimi name. */
export function rememberIdentity(text, sessionId, home = homedir()) {
  const name = /^\[kokuban\] You are "([^"\r\n]+)"/m.exec(text)?.[1];
  if (!name || !sessionId) return null;
  mkdirSync(dirname(identityFile(sessionId, home)), { recursive: true });
  writeFileSync(identityFile(sessionId, home), JSON.stringify({ sessionId, name }) + '\n');
  return name;
}

export function instructionReminder(payload) {
  return payload.hook_event_name === 'UserPromptSubmit' && !payload.agent_id
    ? `Follow ${join(process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code'), 'AGENTS.md')}.`
    : '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let reminder = '';
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const payload = JSON.parse(raw);
    const consolePid = kimiConsole(payload);
    if (consolePid) payload.console_pid = consolePid;
    const parts = [];
    reminder = instructionReminder(payload);
    if (reminder) parts.push(reminder);
    const result = await relay(payload, process.env.KOKUBAN_URL || 'http://127.0.0.1:47600');
    if (result.blocked) { console.error(result.text); process.exitCode = 2; }
    else {
      if (result.text) {
        rememberIdentity(result.text, payload.session_id);
        parts.push(result.text);
      }
      if (parts.length) process.stdout.write(parts.join('\n') + '\n');
    }
    syncBadge(payload, result.blocked);
  } catch (error) {
    if (reminder) process.stdout.write(reminder + '\n');
    console.error(`Kokuban Kimi hook unavailable: ${error.message}`);
  }
}
