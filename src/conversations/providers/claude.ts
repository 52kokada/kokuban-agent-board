import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatSession, Runtime, RuntimeSink } from '../contracts.js';
import { spawnOwned } from './process-owner.js';
import { cancelQueuedOnInterrupt } from './claude-transport.js';
import type { RuntimeAttachment } from '../attachments.js';
import type { ManagedPolicy } from './policy.js';
import { claudeFailureDetail } from './claude-errors.js';

/** What an approval is for, in the card itself: the command, file or address, not only the tool name. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const subject = ['command', 'file_path', 'notebook_path', 'url', 'path', 'pattern', 'query'].map(key => input[key]).find(value => typeof value === 'string' && value.trim());
  const detail = typeof subject === 'string' ? subject : JSON.stringify(input);
  return `${name}: ${detail.length > 2000 ? `${detail.slice(0, 2000)}…` : detail}`;
}

export class ClaudeRuntime implements Runtime {
  private query?: Query;
  private inputs: SDKUserMessage[] = [];
  private wake?: () => void;
  private closing = false;
  private interrupted = false;
  private finished?: Promise<void>;
  constructor(private session: ChatSession, private sink: RuntimeSink, private policy?: ManagedPolicy) {}
  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (!this.closing) {
      if (this.inputs.length) yield this.inputs.shift()!;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
  async start(): Promise<string> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const exe = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
    if (!fs.existsSync(exe)) throw new Error('Claude is not installed in the supported local location');
    const env = { ...process.env }; delete env.CLAUDECODE;
    this.query = query({ prompt: this.input(), options: {
      cwd: this.session.cwd, pathToClaudeCodeExecutable: exe, env,
      ...(this.session.providerId ? { resume: this.session.providerId } : { sessionId: this.session.id }),
      title: this.session.name, settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', ...(this.policy ? { append: this.policy.systemAppend } : {}) }, includePartialMessages: true,
      ...(this.policy ? { mcpServers: this.policy.mcpServers, strictMcpConfig: true, disallowedTools: ['Agent','Task'],
        hooks: { PreToolUse: [{ timeout: 86400, hooks: [async (input, id) => {
          if (input.hook_event_name !== 'PreToolUse') return {};
          const allow = await this.policy!.gate(input.tool_name, input.tool_input as Record<string, unknown>, id ?? input.tool_use_id);
          return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: allow ? 'allow' as const : 'deny' as const, permissionDecisionReason: allow ? 'Board policy allowed this exact action' : 'Board policy denied or stopped this action' } };
        }] }] } } : {}),
      canUseTool: async (toolName, input, context) => {
        if (this.policy && toolName !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };
        const allowed = await this.sink.approval(context.toolUseID ?? '', toolName, toolName === 'AskUserQuestion' ? 'The agent needs your input. Reply in the conversation.' : describeTool(toolName, input), input);
        // Questions require actual selections; a generic Allow must never invent an answer.
        if (allowed && toolName !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };
        return { behavior: 'deny', message: toolName === 'AskUserQuestion' ? 'Ask in the conversation so the participants can answer in text.' : 'A participant denied or stopped this action.' };
      },
      spawnClaudeCodeProcess: options => cancelQueuedOnInterrupt(spawnOwned(options.command, options.args, options.cwd ?? this.session.cwd, options.env, options.signal)),
    } });
    await this.query.initializationResult();
    const receipt = await this.query.interrupt();
    if (!receipt || !Array.isArray(receipt.cancelled)) { this.query.close(); throw new Error('This Claude installation cannot guarantee queued-work cancellation'); }
    this.finished = this.read();
    return this.session.providerId ?? this.session.id;
  }
  private async read(): Promise<void> {
    let assistantError: string | undefined;
    try {
      for await (const message of this.query!) {
        const m = message as any; // SDK event union is versioned; normalize only the supported boundary here.
        if (m.type === 'stream_event') {
          const e = m.event;
          if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') this.sink.event('assistant_delta', e.delta.text);
        } else if (m.type === 'assistant') {
          if (m.error) assistantError = (m.message?.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n') || String(m.error);
          for (const block of m.message?.content ?? []) if (block.type === 'tool_use') this.sink.event('tool', block.name, { id: block.id, input: block.input });
        } else if (m.type === 'user') {
          for (const block of m.message?.content ?? []) if (block.type === 'tool_result') this.sink.event('tool_result', typeof block.content === 'string' ? block.content : JSON.stringify(block.content), { id: block.tool_use_id });
        } else if (m.type === 'result') {
          const usage = Object.values(m.modelUsage ?? {}) as Array<Record<string, number>>;
          if (usage.length) this.sink.event('usage', undefined, Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'].map(key => [key, usage.reduce((sum, v) => sum + (Number(v[key]) || 0), 0)])));
          this.sink.complete(this.interrupted ? 'interrupted' : m.is_error ? 'failed' : 'complete', m.is_error ? claudeFailureDetail(m, assistantError) : undefined);
          assistantError = undefined;
          this.interrupted = false;
        }
      }
      if (!this.closing) this.sink.exit('Claude process ended');
    } catch { if (!this.closing) this.sink.exit('Claude connection failed'); }
  }
  async send(body: string, attachments: RuntimeAttachment[] = []): Promise<string> {
    if (!this.query || this.closing) throw new Error('Claude is not connected');
    const id = crypto.randomUUID();
    // An interrupt that arrived after the previous result must not mark this new turn.
    this.interrupted = false;
    this.sink.turn(id);
    const content: any[] = [{ type: 'text', text: body }];
    for (const a of attachments) {
      if (a.mime.startsWith('image/')) content.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: fs.readFileSync(a.path).toString('base64') } });
      else content.push({ type: 'text', text: `Attached file: ${a.name}\nHost-local path: ${a.path}` });
    }
    this.inputs.push({ type: 'user', uuid: id, session_id: this.session.providerId ?? this.session.id, parent_tool_use_id: null, message: { role: 'user', content: attachments.length ? content : body } });
    this.wake?.(); this.wake = undefined;
    return id;
  }
  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.inputs = [];
    await this.query?.interrupt();
  }
  async close(): Promise<void> {
    this.closing = true; this.wake?.(); this.query?.close();
    await this.finished;
  }
}
