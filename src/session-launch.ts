/** Explicit native-app CLI starts only. Never imported by wake, hooks or mail delivery. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Board, Session } from './board.js';
import { SETTINGS } from './cards.js';

export type LaunchTarget = 'vscode' | 'terminal';
type AgentHost = 'codex' | 'claude' | 'kimi';
export interface LaunchPlan { host: AgentHost; cwd: string; id: string; target: LaunchTarget; encodedCommand: string }
interface Request { id?: string; host?: string; cwd?: string; target?: string }
interface Grant { plan: LaunchPlan; expires: number }
export interface LauncherConfig { vscode?: boolean; terminal?: boolean }
const hosts = new Set(['codex', 'claude', 'kimi']);
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const quote = (s: string): string => `'${s.replaceAll("'", "''")}'`;
function config(): LauncherConfig {
  try { return JSON.parse(fs.readFileSync(SETTINGS.file, 'utf8')).sessionLauncher ?? {}; } catch { return {}; }
}
/** Some launch target is enabled in this PC's settings; without one the board behaves as before. */
export function launcherEnabled(): boolean {
  const c = config();
  return c?.vscode === true || c?.terminal === true;
}
function validDir(cwd: string): boolean {
  try { return path.isAbsolute(cwd) && !/[\x00-\x1f]/.test(cwd) && fs.statSync(cwd).isDirectory(); } catch { return false; }
}
function resumeId(s: Session): string {
  const id = s.host === 'kimi' ? s.id.replace(/^kimi:/, '') : s.id;
  return uuid.test(id) || (s.host === 'kimi' && /^session_[a-z\d-]{8,80}$/i.test(id)) ? id : '';
}
export class SessionLaunch {
  private grants = new Map<string, Grant>();
  private claimed = new Map<string, Grant>();
  constructor(private board: Board, private deps: {
    config?: () => LauncherConfig; now?: () => number;
    run?: (plan: LaunchPlan, grant: string) => Promise<void>;
  } = {}) {
    for (const s of this.all()) if (s.launchPending && !s.launchPending.claimed) delete s.launchPending;
  }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private all(): Session[] { return [...new Map([...this.board.sessionArchive, ...this.board.sessions].map(s => [s.id, s])).values()]; }
  private target(target: unknown): LaunchTarget {
    if (target !== 'vscode' && target !== 'terminal') throw Error('開く場所を選んでください。');
    if ((this.deps.config?.() ?? config())?.[target] !== true) throw Error('このPCでは選択した外部連携が有効になっていません。');
    return target;
  }
  private sweep(): void {
    for (const [token, grant] of this.grants) if (grant.expires <= this.now()) this.failed(token);
    for (const [token, grant] of this.claimed) if (grant.expires + 300_000 <= this.now()) this.claimed.delete(token);
  }
  private reason(s: Session, token?: string): string {
    if (s.managed) return 'Agents画面で管理している会話です。既存のAgents画面から操作してください。';
    if (!hosts.has(s.host) || !resumeId(s)) return 'この種類のセッションは再開できません。';
    if (this.board.isLive(s) || s.state !== 'gone') return '動作中または終了未確認です。既存のセッションを使用してください。';
    if (s.launchEndedAt === undefined) return '終了を確認できないため、重複起動を避けています。';
    if (s.launchPending && s.launchPending.token !== token) return '起動処理中です。開いたターミナルで開始を待っています。';
    if (!validDir(s.cwd)) return '元の作業フォルダーが見つかりません。';
    try { if (!s.transcript || !fs.statSync(s.transcript).isFile()) return '保存された会話履歴が見つかりません。'; }
    catch { return '保存された会話履歴が見つかりません。'; }
    return '';
  }
  catalog() {
    this.sweep();
    const settings = this.deps.config?.() ?? config();
    const targets = (['vscode', 'terminal'] as const).filter(t => settings?.[t] === true);
    return { targets, sessions: this.all().sort((a, b) => b.seen - a.seen).slice(0, 5000).map(s => {
      const reason = targets.length ? this.reason(s) : '外部セッション連携は未接続です。';
      return { id: s.id, name: s.name, host: s.host, cwd: s.cwd, seen: s.seen, live: this.board.isLive(s), canResume: !reason, reason, pending: Boolean(s.launchPending) };
    }) };
  }
  prepare(input: Request): { grant: string; target: LaunchTarget; uri: string } {
    this.sweep();
    const target = this.target(input.target);
    if (this.grants.size >= 100) throw Error('未処理の起動要求が多すぎます。少し待って再度選んでください。');
    let host = input.host, cwd = input.cwd, id = '';
    if (input.id) {
      const s = this.all().find(s => s.id === input.id); if (!s) throw Error('このPCのセッションが見つかりません。');
      const why = this.reason(s); if (why) throw Error(why);
      host = s.host; cwd = s.cwd; id = resumeId(s);
    }
    if (!host || !hosts.has(host) || !cwd || !validDir(cwd) || cwd.length > 4000) throw Error('AIと存在する作業フォルダーを選んでください。');
    const args = id ? host === 'codex' ? ['resume', id] : host === 'claude' ? ['--resume', id] : ['--session', id] : [];
    const script = `Set-Location -LiteralPath ${quote(cwd)} -ErrorAction Stop; & ${host}${args.map(a => ' ' + quote(a)).join('')}`;
    const plan: LaunchPlan = { host: host as AgentHost, cwd, id: input.id ?? '', target, encodedCommand: Buffer.from(script, 'utf16le').toString('base64') };
    const grant = randomBytes(32).toString('hex'); this.grants.set(grant, { plan, expires: this.now() + 60_000 });
    if (plan.id) {
      this.all().find(s => s.id === plan.id)!.launchPending = { token: grant, at: this.now() };
      this.board.save();
      if (!this.board.flush()) { this.failed(grant); throw Error('起動要求を保存できないため、開始しませんでした。'); }
    }
    return { grant, target, uri: `vscode://local-kokuban.session-launcher/launch?grant=${grant}` };
  }
  consume(token: string): LaunchPlan {
    const grant = this.grants.get(token); this.grants.delete(token);
    if (!grant) throw Error('起動要求は使用済みか期限切れです。');
    this.claimed.set(token, grant);
    try {
      this.target(grant.plan.target);
      if (grant.expires <= this.now()) throw Error('起動要求の期限が切れました。');
      if (grant.plan.id) {
        const s = this.all().find(s => s.id === grant.plan.id); if (!s) throw Error('セッションが見つかりません。');
        const why = this.reason(s, token); if (why) throw Error(why);
        if (s.cwd !== grant.plan.cwd || s.host !== grant.plan.host) throw Error('セッションの内容が変わったため、もう一度選んでください。');
        if (s.launchPending?.token !== token) throw Error('起動要求が解除されています。');
        s.launchPending.claimed = true;
        this.board.save(); if (!this.board.flush()) throw Error('起動状態を保存できないため、開始しませんでした。');
      }
      if (!validDir(grant.plan.cwd)) throw Error('作業フォルダーが見つかりません。');
      return grant.plan;
    } catch (error) { this.failed(token); throw error; }
  }
  failed(token: string): void {
    const grant = this.grants.get(token) ?? this.claimed.get(token); if (!grant) return;
    this.grants.delete(token); this.claimed.delete(token);
    const s = this.all().find(s => s.id === grant.plan.id);
    if (s?.launchPending?.token === token) { delete s.launchPending; this.board.save(); }
  }
  reset(id: string): void {
    const s = this.all().find(s => s.id === id);
    if (!s || s.managed || s.state !== 'gone' || this.board.isLive(s)) throw Error('動作中または終了未確認のセッションは解除できません。');
    if (s.launchPending) { this.grants.delete(s.launchPending.token); this.claimed.delete(s.launchPending.token); }
    delete s.launchPending; this.board.save();
    if (!this.board.flush()) throw Error('起動要求の解除を保存できませんでした。');
  }
  async open(token: string): Promise<void> {
    const grant = this.grants.get(token); if (!grant || grant.expires <= this.now()) throw Error('起動要求の期限が切れました。');
    this.target(grant.plan.target);
    if (this.deps.run) return this.deps.run(grant.plan, token);
    if (process.platform !== 'win32') throw Error('このPCでは外部セッション起動が未対応です。');
    if (grant.plan.target === 'vscode') {
      const exe = [path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'), path.join(process.env.ProgramFiles ?? '', 'Microsoft VS Code', 'Code.exe')].find(fs.existsSync);
      if (!exe) throw Error('VS Codeが見つかりません。');
      await start(exe, ['--open-url', `vscode://local-kokuban.session-launcher/launch?grant=${token}`]);
    } else {
      const plan = this.consume(token);
      const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      // wt splits its own command line at ';', so a folder name never goes into wt's arguments: the
      // encoded script's quoted Set-Location carries the folder instead.
      await start('wt.exe', ['new-tab', shell, '-NoExit', '-EncodedCommand', plan.encodedCommand]);
    }
  }
}
function start(exe: string, args: string[]): Promise<void> {
  const env = { ...process.env };
  for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDECODE', 'KIMI_SESSION_ID']) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: 'ignore', detached: false, env });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
}
const instances = new WeakMap<Board, SessionLaunch>();
export function sessionLaunch(board: Board): SessionLaunch {
  let launcher = instances.get(board); if (!launcher) { launcher = new SessionLaunch(board); instances.set(board, launcher); } return launcher;
}
