import { StringDecoder } from 'node:string_decoder';
import * as path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { codexExe } from '../../wake.js';
import type { ChatSession, Runtime, RuntimeSink } from '../contracts.js';
import { spawnOwned, closeOwned } from './process-owner.js';
import type { RuntimeAttachment } from '../attachments.js';
import type { ManagedPolicy } from './policy.js';

/** Only Codex's empty-schema consent envelope for our capability-bound board. */
export function automaticBoardConsent(policy:ManagedPolicy|undefined,request:any):boolean {
  const bound=policy?.mcpServers?.kokuban;
  const configured=(policy?.codexConfig?.mcp_servers as any)?.kokuban;
  if(!bound||bound.type!=='http'||!bound.url||configured?.url!==bound.url)return false;
  if(request.serverName!=='kokuban'||request.mode!=='form'||request._meta?.codex_approval_kind!=='mcp_tool_call')return false;
  const schema=request.requestedSchema;
  if(schema?.type!=='object'||!schema.properties||Object.keys(schema.properties).length||schema.required?.length)return false;
  // The current protocol provides the tool name in this fixed consent message,
  // not a separate field. Fail closed if its envelope changes.
  return /^Allow the kokuban MCP server to run tool "(?:peers|glance|send|inbox|task|know|claim|release)"\?$/.test(request.message??'');
}

export class CodexRuntime implements Runtime {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private sequence = 0; private thread = ''; private closing = false;
  private activeTurn?: string;
  private starting?: Promise<any>;
  /** turn/interrupt does not end a running shell command; Stop ends the owned process tree instead. */
  private stopping?: Promise<void>;
  private settled?: () => void;
  private stops = 0;
  private toolItems = new Map<string, any>();
  constructor(private session: ChatSession, private sink: RuntimeSink, private policy?: ManagedPolicy) {}
  private sendFrame(value: object, child = this.child): void {
    if (!child?.stdin.writable) throw new Error('Codex connection closed');
    child.stdin.write(JSON.stringify(value) + '\n');
  }
  private rpc(method: string, params: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = `kokuban-${++this.sequence}`;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex request acknowledgement timed out')); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.sendFrame({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e as Error); }
    });
  }
  /** One contained app-server. A process that is no longer current never reports to the sink. */
  private async boot(): Promise<void> {
    const exe = codexExe(); if (!exe) throw new Error('Codex is not installed');
    const env=this.policy?.env??process.env;
    const child = this.child = spawnOwned(exe, ['app-server', '--listen', 'stdio://'], this.session.cwd,env);
    const current = () => this.child === child && !this.closing;
    const decoder = new StringDecoder('utf8'); let raw = '';
    child.stdout.on('data', (chunk: Buffer) => {
      raw += decoder.write(chunk);
      if (Buffer.byteLength(raw) > 16 * 1024 * 1024) { if (current()) this.sink.exit('Codex sent an oversized frame'); void this.close(); return; }
      let end: number;
      while ((end = raw.indexOf('\n')) >= 0) {
        const line = raw.slice(0, end); raw = raw.slice(end + 1);
        if (!line.trim()) continue;
        try { void this.frame(JSON.parse(line), child).catch(() => { if (current()) this.sink.exit('Codex protocol failed'); }); }
        catch { if (current()) this.sink.exit('Codex sent invalid JSON'); void this.close(); return; }
      }
    });
    child.stderr.on('data', () => {}); // Provider diagnostics may contain private paths/tokens.
    child.stdin.on('error', () => {});
    const failed = () => {
      if (this.child !== child) return;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex process ended')); } this.pending.clear();
      if (!this.closing && !this.stopping) this.sink.exit('Codex process ended unexpectedly');
    };
    child.on('error', failed); child.on('exit', failed);
    await this.rpc('initialize', { clientInfo: { name: 'kokuban', title: 'Kokuban', version: '0.4.0' } });
    this.sendFrame({ method: 'initialized' });
  }
  async start(): Promise<string> {
    await this.boot();
    const guard = await this.guardedConfig();
    const result = this.session.providerId
      ? await this.rpc('thread/resume', { threadId: this.session.providerId, ...guard })
      : await this.rpc('thread/start', { cwd: this.session.cwd, ...guard });
    this.thread = result.thread.id;
    if(this.policy&&(result.approvalPolicy!=='untrusted'||result.approvalsReviewer!=='user'||result.sandbox?.type!=='workspaceWrite'||result.sandbox?.networkAccess!==true)){await this.close();throw Error('Chief delegate approval policy could not be confirmed');}
    if(this.policy&&(!Array.isArray(result.sandbox.writableRoots)||result.sandbox.writableRoots.some((root:unknown)=>typeof root!=='string'||path.resolve(root).toLowerCase()!==path.resolve(this.session.cwd).toLowerCase()))){await this.close();throw Error('Chief delegate write roots could not be confirmed');}
    if(this.policy){const status=await this.rpc('mcpServerStatus/list',{threadId:this.thread,limit:100});this.sink.event('policy_inventory',undefined,{servers:status.data?.map((s:any)=>({name:s.name,status:s.runtimeStatus,tools:Object.keys(s.tools??{})}))});if(status.nextCursor||!Array.isArray(status.data)||status.data.some((s:any)=>s.name!=='kokuban'&&s.runtimeStatus!=='disabled')){await this.close();throw Error('Chief delegate MCP isolation could not be confirmed');}}
    await this.rpc('thread/name/set', { threadId: this.thread, name: this.session.name });
    return this.thread;
  }
  private async guardedConfig(): Promise<Record<string,unknown>> {
    if(!this.policy)return {};
    const effective=await this.rpc('config/read',{cwd:this.session.cwd});
    const config:Record<string,unknown>={...this.policy.codexConfig};
    const servers:Record<string,unknown>={};for(const [name,value]of Object.entries(effective.config?.mcp_servers??{}))servers[name]={...Object.fromEntries(Object.entries(value as object).filter(([,v])=>v!==null)),enabled:false};
    config.mcp_servers={...servers,...this.policy.codexConfig?.mcp_servers as object};
    config.sandbox_workspace_write={writable_roots:[this.session.cwd],network_access:true,exclude_tmpdir_env_var:true,exclude_slash_tmp:true};
    return {approvalPolicy:'untrusted',approvalsReviewer:'user',sandbox:'workspace-write',config,developerInstructions:this.policy.systemAppend};
  }
  private async frame(m: any, child: ChildProcessWithoutNullStreams): Promise<void> {
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(String(m.id)); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(String(m.id)); m.error ? p.reject(new Error('Codex refused this request')) : p.resolve(m.result); return;
    }
    if (this.child !== child) return;
    const p = m.params ?? {};
    if (p.threadId && this.thread && p.threadId !== this.thread) return;
    if (m.id !== undefined && m.method) {
      let result: unknown;
      if (m.method === 'item/commandExecution/requestApproval' || m.method === 'item/fileChange/requestApproval') {
        const kind = m.method.includes('fileChange') ? 'File change' : 'Command';
        const details = { ...p, ...(kind === 'File change' ? { changes: this.toolItems.get(p.itemId)?.changes } : {}) };
        const allow = this.policy ? await this.policy.gate(kind, details, String(m.id)) : await this.sink.approval(String(m.id), kind, String(p.command ?? p.reason ?? 'Review this tool action'), p);
        result = { decision: allow ? 'accept' : 'decline' };
      } else if (m.method === 'item/tool/requestUserInput') {
        await this.sink.approval(String(m.id), 'Question', 'The agent needs your input', p);
        result = { answers: {} }; // Free-form follow-up can answer in the conversation; never invent selections.
      } else if (m.method === 'mcpServer/elicitation/request') {
        const automatic=automaticBoardConsent(this.policy,p);
        const allow = automatic||await this.sink.approval(String(m.id), 'MCP request', String(p.message ?? 'Review MCP request'), p);
        if(automatic)this.sink.event('policy_consent','Bound Kokuban tool consented automatically',{server:'kokuban',message:p.message});
        result = { action: allow ? 'accept' : 'decline', content: null };
      } else { this.sendFrame({ id: m.id, error: { code: -32601, message: 'This host does not support that interactive request' } }, child); return; }
      // An answer meant for a process that Stop or Shut down has ended goes nowhere.
      if (!this.closing && this.child === child) this.sendFrame({ id: m.id, result }, child); return;
    }
    switch (m.method) {
      case 'thread/tokenUsage/updated': {
        const total = p.tokenUsage?.total;
        if (total) this.sink.event('usage', undefined, { inputTokens: Number(total.inputTokens) || 0, outputTokens: Number(total.outputTokens) || 0,
          cacheReadInputTokens: Number(total.cachedInputTokens) || 0, cacheCreationInputTokens: Number(total.cacheWriteInputTokens) || 0 });
        break;
      }
      case 'turn/started': this.activeTurn = p.turn.id; if (!this.stopping) this.sink.turn(p.turn.id); break;
      case 'item/agentMessage/delta': this.sink.event('assistant_delta', String(p.delta ?? ''), { itemId: p.itemId }); break;
      case 'item/started':
      case 'item/completed': {
        const item = p.item;
        if(item?.id){if(m.method==='item/started')this.toolItems.set(item.id,item);else this.toolItems.delete(item.id);if(this.toolItems.size>200)this.toolItems.delete(this.toolItems.keys().next().value!);}
        if (item && !['agentMessage', 'userMessage', 'reasoning'].includes(item.type)) this.sink.event('tool', String(item.command ?? item.type), { stage: m.method, item });
        break;
      }
      case 'turn/completed':
        this.activeTurn = undefined;
        // While stopping, the turn ends only once its process tree is gone.
        if (this.stopping) this.settled?.();
        else this.sink.complete(p.turn.status === 'completed' ? 'complete' : p.turn.status === 'interrupted' ? 'interrupted' : 'failed');
        break;
      case 'error': if (!p.willRetry && !this.stopping) this.sink.complete('failed', 'Codex could not complete this turn'); break;
    }
  }
  async send(body: string, attachments: RuntimeAttachment[] = []): Promise<string | undefined> {
    if (this.closing) throw new Error('Codex is not connected');
    const stops = this.stops;
    try {
      // After Stop, continue the same private thread in a fresh contained app-server.
      if (!this.child) { await this.boot(); await this.rpc('thread/resume', { threadId: this.thread, ...await this.guardedConfig() }); }
      const input: object[] = [{ type: 'text', text: body }];
      for (const a of attachments) input.push(a.mime.startsWith('image/') ? { type: 'localImage', path: a.path } : { type: 'text', text: `Attached file: ${a.name}\nHost-local path: ${a.path}` });
      this.starting = this.rpc('turn/start', { threadId: this.thread, input });
      const r = await this.starting; this.activeTurn = r.turn.id; this.sink.turn(r.turn.id); return r.turn.id;
    } catch (e) {
      // A Stop that ended this send reports the turn interrupted itself; this is not a connection failure.
      if (this.stops !== stops && !this.closing) return undefined;
      throw e;
    } finally { this.starting = undefined; }
  }
  interrupt(turnId?: string): Promise<void> {
    this.stopping ??= this.stop(turnId).finally(() => { this.stopping = undefined; this.settled = undefined; });
    return this.stopping;
  }
  private async stop(turnId?: string): Promise<void> {
    this.stops++;
    const child = this.child;
    if (!child) { if (!this.closing) this.sink.complete('interrupted'); return; }
    // Ask Codex to record the interruption first, briefly; then end every process the turn started.
    const ended = new Promise<void>(resolve => { this.settled = resolve; setTimeout(resolve, 3000).unref(); });
    try {
      const target = turnId ?? this.activeTurn ?? (await this.starting?.catch(() => undefined))?.turn.id;
      if (target) { await Promise.race([this.rpc('turn/interrupt', { threadId: this.thread, turnId: target }).catch(() => {}), ended]); await ended; }
    } finally {
      await closeOwned(child);
      if (this.child === child) this.child = undefined;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex turn was stopped')); } this.pending.clear();
      this.activeTurn = undefined;
    }
    if (!this.closing) this.sink.complete('interrupted');
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.stopping?.catch(() => {});
    if (this.child) await closeOwned(this.child);
  }
}
