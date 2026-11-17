import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawnOwned } from '../conversations/providers/process-owner.js';
import { codexRpc } from '../codex-rpc.js';

interface WindowUsage { percent: number; resetsAt: string | null }
export interface PhoneUsage { available: boolean; asOf: number; fiveHour: WindowUsage | null; weekly: WindowUsage | null; scoped: Array<WindowUsage & { label: string }>; sessionTokens: unknown; codex: { available: boolean; primary: WindowUsage | null; secondary: WindowUsage | null } }
export function normalizeUsage(raw: any, at = Date.now()): PhoneUsage {
  const window = (v: any): WindowUsage | null => v && typeof v.utilization === 'number' ? { percent: v.utilization, resetsAt: typeof v.resets_at === 'string' ? v.resets_at : null } : null;
  return { available: raw?.rate_limits_available === true, asOf: at, fiveHour: window(raw?.rate_limits?.five_hour), weekly: window(raw?.rate_limits?.seven_day),
    scoped: (raw?.rate_limits?.model_scoped ?? []).filter((v: any) => typeof v.utilization === 'number').map((v: any) => ({ label: String(v.display_name).slice(0, 80), percent: v.utilization, resetsAt: v.resets_at ?? null })), sessionTokens: null,
    codex: { available: Boolean(raw?.codexPlan?.rateLimits), primary: codexWindow(raw?.codexPlan?.rateLimits?.primary), secondary: codexWindow(raw?.codexPlan?.rateLimits?.secondary) } };
}
function codexWindow(v:any):WindowUsage|null { return v&&typeof v.usedPercent==='number'?{percent:v.usedPercent,resetsAt:typeof v.resetsAt==='number'?new Date(v.resetsAt*1000).toISOString():null}:null; }
async function readClaudeUsage(): Promise<unknown> {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_BASE_URL) throw new Error('Subscription usage unavailable in this environment');
  let finish!: () => void;
  const stop = new Promise<void>(resolve => { finish = resolve; });
  async function* empty(): AsyncGenerator<never> { await stop; }
  const env = { ...process.env }; delete env.CLAUDECODE;
  const q = query({ prompt: empty(), options: { sessionId: randomUUID(), cwd: os.homedir(), pathToClaudeCodeExecutable: path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    env, settingSources: [], tools: [], mcpServers: {}, strictMcpConfig: true, persistSession: false,
    spawnClaudeCodeProcess: o => spawnOwned(o.command, o.args, o.cwd ?? os.homedir(), o.env, o.signal) } });
  const timer = setTimeout(() => { finish(); q.close(); }, 12000);
  let raw:unknown;
  try { await q.initializationResult(); raw = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }); }
  finally { clearTimeout(timer); finish(); q.close(); }
  return raw;
}
async function readPlanUsage():Promise<unknown>{
  const [claude,codex]=await Promise.allSettled([readClaudeUsage(),codexRpc('account/rateLimits/read',{})]);
  return {...(claude.status==='fulfilled'?claude.value as object:{}),codexPlan:codex.status==='fulfilled'?codex.value:null};
}
/** On-demand only: no provider is launched by feed/list reads or background notification polling. */
export class PhoneUsageCache {
  private pending?: Promise<PhoneUsage>;
  private cached?: PhoneUsage;
  constructor(private read: () => Promise<unknown> = readPlanUsage, private clock = Date.now) {}
  async get(): Promise<PhoneUsage> {
    if (this.cached && this.clock() - this.cached.asOf < 300000) return structuredClone(this.cached);
    this.pending ??= this.read().then(v => normalizeUsage(v, this.clock())).catch(() => normalizeUsage(null, this.clock())).then(v => this.cached = v).finally(() => { this.pending = undefined; });
    return structuredClone(await this.pending);
  }
}
