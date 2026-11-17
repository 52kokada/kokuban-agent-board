/**
 * Wire kokuban into this user's Claude Code and Codex, machine-wide, and start
 * it at logon. Re-running upgrades in place; other hooks are left alone.
 */
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL, DATA_DIR } from './config.js';
import { badgesOn, buildHelper } from './terminal-badges.js';

type Handler = Record<string, unknown>;
interface Group { matcher?: string; hooks?: Handler[] }
type Hooks = Record<string, Group[]>;
/** Our handlers for one event: a plain list applies to every tool; a group carries its own matcher. */
type Ours = Record<string, Handler[] | Group>;

const here = path.dirname(fileURLToPath(import.meta.url));
const slash = (p: string): string => p.replace(/\\/g, '/');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const CODEX_HOOKS = path.join(os.homedir(), '.codex', 'hooks.json');
export const STARTUP = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'kokuban.vbs');
/** `kokuban` as a command: npm's global folder is on PATH wherever Node was installed the usual way. */
const SHIMS = path.join(process.env.APPDATA ?? '', 'npm');
const SHIM_FILES = ['kokuban.cmd', 'kokuban.ps1', 'kokuban'];

const isOurs = (h: Handler): boolean =>
  (h.type === 'http' && String(h.url).startsWith(BASE_URL)) ||
  (h.type === 'command' && /(start|wake)-hook\.js/.test(String(h.command))) ||
  (h.type === 'mcp_tool' && h.server === 'kokuban');

/** Replace our handlers in a hooks table, keeping everyone else's. */
export function mergeHooks(existing: Hooks, ours: Ours): Hooks {
  const merged: Hooks = {};
  for (const [event, groups] of Object.entries(existing)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) merged[event] = kept;
  }
  for (const [event, handlers] of Object.entries(ours)) {
    merged[event] = [...(merged[event] ?? []), Array.isArray(handlers) ? { hooks: handlers } : handlers];
  }
  return merged;
}

function claudeHandlers(): Ours {
  const http = { type: 'http', url: `${BASE_URL}/hook/claude`, timeout: 5 };
  const node = (script: string): string => `"${slash(process.execPath)}" "${slash(path.join(here, script))}"`;
  return {
    SessionStart: [{ type: 'command', command: node('start-hook.js'), timeout: 10 }],
    UserPromptSubmit: [http],
    PostToolUse: [http],
    // The second Stop hook stays behind in the background and wakes the session when direct mail arrives.
    Stop: [http, { type: 'command', command: node('wake-hook.js'), asyncRewake: true, timeout: 28_800 }],
    SessionEnd: [http],
    // D127: the turn now waits on its human. Only AskUserQuestion, and only an actual permission prompt,
    // reach the board, over HTTP: never a process, never for every tool.
    // A kokuban tool call also reaches the board first, so the call keeps this session's name (host-calls.ts).
    PreToolUse: { matcher: 'AskUserQuestion|mcp__kokuban__.*', hooks: [http] },
    PermissionRequest: [http],
  };
}

function codexHandlers(): Record<string, Handler[]> {
  const tool = {
    type: 'mcp_tool', server: 'kokuban', tool: 'hook', timeout: 5,
    input: { event: '${hook_event_name}', session_id: '${session_id}', cwd: '${cwd}' },
  };
  // Codex does not run MCP hooks on SessionEnd; an ended Codex session ages off the board instead.
  // PostCompact only marks the session; its checkpoint note goes out with the next prompt or tool result (hooks.ts).
  return { SessionStart: [tool], UserPromptSubmit: [tool], PostToolUse: [tool], Stop: [tool], PostCompact: [tool] };
}

const TITLE_ENV = 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE';
/** Present while kokuban is the one that set TITLE_ENV, so turning badges off never removes a person's own value. */
const TITLE_ENV_MARK = path.join(DATA_DIR, 'terminal-title', 'claude-env-set-by-kokuban');

/**
 * D125 terminal badges: with them on, Claude Code must not write its own terminal title over the badge.
 * Returns the env table to write; leaves everything else in it alone.
 */
export function titleEnv(env: Record<string, unknown> | undefined, on: boolean, marked: boolean): { env?: Record<string, unknown>; marked: boolean } {
  const next = { ...(env ?? {}) };
  if (on) {
    if (next[TITLE_ENV] === '1') return { env, marked };
    next[TITLE_ENV] = '1';
    return { env: next, marked: true };
  }
  if (!marked) return { env, marked };
  if (next[TITLE_ENV] === '1') delete next[TITLE_ENV];
  return { env: Object.keys(next).length ? next : undefined, marked: false };
}

const readText = (file: string): string => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
/**
 * The logon script that starts the daemon. Process environment lines a PC already has (KOKUBAN_CONVERSATIONS,
 * KOKUBAN_PROJECT_ROOTS, …) are kept: dropping one silently turns a feature off at the next restart.
 */
export function startupScript(node: string, daemon: string, existing = ''): string {
  const env = [...existing.matchAll(/\.Environment\("Process"\)\("([A-Z0-9_]+)"\)\s*=\s*("(?:[^"]|"")*")/gi)]
    .map((m) => `shell.Environment("Process")("${m[1]}") = ${m[2]}`);
  const lines = [
    ...(env.length ? ['Set shell = CreateObject("WScript.Shell")', ...env] : []),
    `CreateObject("WScript.Shell").Run """${node}"" ""${daemon}""", 0, False`,
  ];
  return `${lines.join('\r\n')}\r\n`;
}
/**
 * Windows opens every file in the Startup folder at logon, so a copy such as `kokuban.vbs.bak-…` left beside the
 * logon script pops up in a text editor. Move such copies to DATA_DIR/startup-backups; returns the moved names.
 */
export function moveStartupCopies(script = STARTUP, dest = path.join(DATA_DIR, 'startup-backups')): string[] {
  const dir = path.dirname(script), base = path.basename(script).toLowerCase();
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const strays = names.filter((n) => n.toLowerCase().startsWith(`${base}.`));
  if (strays.length) fs.mkdirSync(dest, { recursive: true });
  for (const n of strays) fs.renameSync(path.join(dir, n), path.join(dest, n));
  return strays;
}
function rewrite(file: string, ours: Ours, badges?: boolean): void {
  let json: { hooks?: Hooks; env?: Record<string, unknown> } & Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!fs.existsSync(`${file}.before-kokuban`)) fs.copyFileSync(file, `${file}.before-kokuban`);
  }
  if (badges !== undefined) {
    const result = titleEnv(json.env, badges, fs.existsSync(TITLE_ENV_MARK));
    if (result.env === undefined) delete json.env;
    else json.env = result.env;
    if (result.marked) { fs.mkdirSync(path.dirname(TITLE_ENV_MARK), { recursive: true }); fs.writeFileSync(TITLE_ENV_MARK, ''); }
    else fs.rmSync(TITLE_ENV_MARK, { force: true });
  }
  json.hooks = mergeHooks(json.hooks ?? {}, ours);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

function run(command: string): boolean {
  try {
    execSync(command, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function install(): string[] {
  removeLegacyWindowsLinks();
  const done: string[] = [];
  const badges = badgesOn();
  rewrite(CLAUDE_SETTINGS, claudeHandlers(), badges);
  run('claude mcp remove -s user kokuban');
  done.push(run(`claude mcp add --transport http -s user kokuban ${BASE_URL}/mcp`)
    ? 'Claude Code: hooks and MCP server registered'
    : 'Claude Code: hooks written, but `claude mcp add` failed; add the server by hand');

  rewrite(CODEX_HOOKS, codexHandlers());
  run('codex mcp remove kokuban');
  done.push(run(`codex mcp add kokuban --url ${BASE_URL}/mcp/codex`)
    ? 'Codex: hooks and MCP server registered (trust the hooks once with /hooks)'
    : 'Codex: hooks written, but `codex mcp add` failed; add the server by hand');

  if (process.platform === 'win32') {
    const daemon = path.join(here, 'daemon.js');
    fs.writeFileSync(STARTUP, startupScript(process.execPath, daemon, readText(STARTUP)));
    const moved = moveStartupCopies();
    if (moved.length) done.push(`Moved ${moved.join(', ')} out of Startup to ${path.join(DATA_DIR, 'startup-backups')}`);
    // D125: the helper is compiled here from tools/TerminalTitle, never shipped as a binary.
    if (badges) done.push(buildHelper());
    done.push('Starts at logon');
    const cli = path.join(here, 'cli.js');
    try {
      fs.mkdirSync(SHIMS, { recursive: true });
      fs.writeFileSync(path.join(SHIMS, 'kokuban.cmd'), `@"${process.execPath}" "${cli}" %*\r\n`);
      // PowerShell runs a kokuban.ps1 before the .cmd: an old npm-made one would point elsewhere.
      fs.writeFileSync(path.join(SHIMS, 'kokuban.ps1'), `& "${process.execPath}" "${cli}" @args\r\nexit $LASTEXITCODE\r\n`);
      // Git Bash and other POSIX shells find the extensionless one.
      const posix = (p: string): string => p.replace(/\\/g, '/');
      fs.writeFileSync(path.join(SHIMS, 'kokuban'), `#!/bin/sh\nexec "${posix(process.execPath)}" "${posix(cli)}" "$@"\n`);
      done.push(`The kokuban command (kokuban pair, kokuban status) in ${SHIMS}`);
    } catch (err) {
      done.push(`No kokuban command: ${(err as Error).message}; use node "${cli}" instead`);
    }
  }
  return done;
}

export function uninstall(): string[] {
  removeLegacyWindowsLinks();
  if (fs.existsSync(CLAUDE_SETTINGS)) rewrite(CLAUDE_SETTINGS, {}, false);
  if (fs.existsSync(CODEX_HOOKS)) rewrite(CODEX_HOOKS, {});
  run('claude mcp remove -s user kokuban');
  run('codex mcp remove kokuban');
  fs.rmSync(STARTUP, { force: true });
  for (const f of SHIM_FILES) fs.rmSync(path.join(SHIMS, f), { force: true });
  return ['Removed kokuban hooks, MCP servers, the logon entry and the kokuban command'];
}

/** The native app owns its shortcut; remove only the retired board protocol and toast identity. */
function removeLegacyWindowsLinks(): void {
  if (process.platform !== 'win32') return;
  for (const key of ['HKCU\\Software\\Classes\\kokuban', 'HKCU\\Software\\Classes\\AppUserModelId\\Kokuban.Questions']) {
    try { execFileSync('reg.exe', ['delete', key, '/f'], { windowsHide: true, stdio: 'ignore' }); }
    catch { /* Already absent. */ }
  }
}
