/**
 * A look over a peer's shoulder: its latest steps, read from the transcript its
 * host already writes. The peer is not interrupted and nothing enters its context.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Board, Session } from './board.js';

export interface Step {
  kind: 'asked' | 'says' | 'did' | 'notice';
  text: string;
}

const TAIL_BYTES = 256 * 1024;
const RECENT = 8;

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function tail(file: string, limit = TAIL_BYTES): string[] {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - limit);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    fs.closeSync(fd);
  }
}

/** The argument that says most about a tool call: the command, the file, the query. */
function gist(input: unknown): string {
  // Codex wraps a tool call in a script: `text(await tools.name({...}))`. Show the call, not the wrapper.
  if (typeof input === 'string') return input.replace(/^\s*text\(await tools\.(\w+)\(/, '$1 ');
  if (!input || typeof input !== 'object') return '';
  const args = input as Record<string, unknown>;
  for (const key of ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'cmd']) {
    if (typeof args[key] === 'string') return args[key];
  }
  return JSON.stringify(args);
}

// Text the host or a hook put in the human's place starts with a tag; a person's request does not.
// So does mail kokuban queued to wake an idle session, and Codex opens every thread with the
// directory's AGENTS.md under a heading of its own.
export const NOT_HUMAN = /^\s*(<|\[kokuban\]|# AGENTS\.md instructions for )/;
const human = (text: string): boolean => Boolean(text.trim()) && !NOT_HUMAN.test(text);

function claudeSteps(line: any): Step[] {
  if (line.isSidechain || line.isMeta) return [];
  const content = line.message?.content;
  if (line.type === 'user') {
    return typeof content === 'string' && human(content) ? [{ kind: 'asked', text: content }] : [];
  }
  if (line.type !== 'assistant' || !Array.isArray(content)) return [];
  return content.flatMap((block: any): Step[] => {
    if (block.type === 'text' && block.text?.trim()) return [{ kind: 'says', text: block.text }];
    if (block.type === 'tool_use') return [{ kind: 'did', text: `${block.name}: ${gist(block.input)}` }];
    return [];
  });
}

function codexSteps(line: any): Step[] {
  const item = line.payload;
  if (line.type !== 'response_item' || !item) return [];
  if (item.type === 'message' && Array.isArray(item.content)) {
    const text = item.content.map((c: any) => c.text ?? '').filter((t: string) => item.role !== 'user' || human(t)).join(' ');
    if (!text.trim()) return [];
    if (item.role === 'user') return [{ kind: 'asked', text }];
    return item.role === 'assistant' ? [{ kind: 'says', text }] : [];
  }
  if (item.type === 'custom_tool_call' || item.type === 'function_call') {
    let args: unknown = item.input ?? item.arguments;
    try {
      if (typeof args === 'string' && args.startsWith('{')) args = JSON.parse(args);
    } catch {
      /* not JSON: show it as written */
    }
    return [{ kind: 'did', text: `${item.name}: ${gist(args)}` }];
  }
  return [];
}

function kimiSteps(line: any): Step[] {
  // The wire journal also contains replay/context copies and private reasoning deltas.
  if (line.type !== 'agent.message.appended' || (line.agentId && line.agentId !== 'main')) return [];
  const wrapped = line.message;
  const message = wrapped?.message;
  if (!message || !['user', 'assistant'].includes(message.role)) return [];
  const origin = wrapped.meta?.origin?.kind ?? message.origin?.kind;
  if (message.role === 'user' && origin && origin !== 'user') return [];
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = typeof message.content === 'string'
    ? (message.role === 'user' && !human(message.content) ? '' : message.content)
    : blocks.filter((b: any) => b.type === 'text' && typeof b.text === 'string' &&
      (message.role !== 'user' || (!b.meta?.source && human(b.text)))).map((b: any) => b.text).join(' ');
  const steps: Step[] = text.trim() ? [{ kind: message.role === 'user' ? 'asked' : 'says', text }] : [];
  if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
    for (const call of message.toolCalls) {
      if (typeof call.name !== 'string') continue;
      let args = call.arguments;
      try { if (typeof args === 'string') args = JSON.parse(args); } catch { /* partial arguments */ }
      steps.push({ kind: 'did', text: `${call.name}: ${gist(args)}` });
    }
  }
  return steps;
}

/** Public transcript records only: never reasoning, compaction replays or schemas. */
export function transcriptSteps(host: Session['host'], line: any): Step[] {
  const notices = (values: unknown[]): Step[] => [...new Set(values.filter((v): v is string => typeof v === 'string')
    .flatMap(text => [...text.matchAll(/<kokuban-message\b[^>]*>[\s\S]*?<\/kokuban-message>/g)].map(m => m[0])))]
    .map(text => ({ kind: 'notice', text }));
  if (host === 'claude') {
    const steps = claudeSteps(line);
    if (line.isSidechain || line.isMeta) return steps;
    if (line.type === 'user') steps.push(...notices(typeof line.message?.content === 'string' ? [line.message.content] :
      Array.isArray(line.message?.content) ? line.message.content.filter((v: any) => v.type === 'text').map((v: any) => v.text) : []));
    if (line.type === 'user' && Array.isArray(line.message?.content)) {
      for (const b of line.message.content) {
        if (b.type === 'text' && typeof b.text === 'string' && human(b.text)) steps.push({ kind: 'asked', text: b.text });
        if (b.type === 'tool_result') {
          const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content)
            ? b.content.filter((v: any) => v.type === 'text').map((v: any) => v.text ?? '').join('\n') : '';
          if (text) steps.push({ kind: 'did', text: `Tool result: ${text}` });
        }
      }
    }
    if (line.type === 'attachment' && line.attachment?.type === 'hook_additional_context')
      steps.push(...notices(Array.isArray(line.attachment.content) ? line.attachment.content : [line.attachment.content]));
    return steps;
  }
  if (host === 'codex') {
    const steps = codexSteps(line);
    const p = line.type === 'response_item' ? line.payload : undefined;
    if (p?.type === 'message' && ['user', 'developer'].includes(p.role)) steps.push(...notices((p.content ?? []).map((v: any) => v.text)));
    if (p && ['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
      const text = typeof p.output === 'string' ? p.output : Array.isArray(p.output)
        ? p.output.filter((v: any) => ['text', 'input_text', 'output_text'].includes(v.type)).map((v: any) => v.text ?? '').join('\n') : '';
      if (text) steps.push({ kind: 'did', text: `Tool result: ${text}` });
    }
    return steps;
  }
  if (host === 'kimi') {
    const steps = kimiSteps(line);
    if ((!line.agentId || line.agentId === 'main') && line.type === 'agent.message.appended' && line.message?.message?.role === 'user') {
      const content = line.message.message.content;
      steps.push(...notices(typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((v: any) => v.type === 'text').map((v: any) => v.text) : []));
    }
    if ((!line.agentId || line.agentId === 'main') && line.type === 'context.append_loop_event' && line.event?.type === 'tool.result') {
      const text = line.event.result?.output;
      if (typeof text === 'string') steps.push({ kind: 'did', text: `Tool result: ${text}` });
    }
    return steps;
  }
  return [];
}

export function readSteps(file: string, host: Session['host']): Step[] {
  const parse = host === 'kimi' ? kimiSteps : host === 'codex' ? codexSteps : claudeSteps;
  // Kimi journals full MCP schemas between prompts and replies, often exceeding 256 KiB.
  return tail(file, host === 'kimi' ? 2 * 1024 * 1024 : TAIL_BYTES).flatMap((raw) => {
    try {
      return parse(JSON.parse(raw));
    } catch {
      return [];
    }
  });
}

/** Codex names each transcript after its session id, under ~/.codex/sessions/<date>/. */
export function findCodexTranscript(sessionId: string): string {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  try {
    if (sessionId.length < 30) return '';
    const hit = (fs.readdirSync(root, { recursive: true }) as string[]).find((f) => f.endsWith(`-${sessionId}.jsonl`));
    return hit ? path.join(root, hit) : '';
  } catch {
    return '';
  }
}

/** Kimi groups exact session directories by workspace; never select a subagent journal. */
export function findKimiTranscript(sessionId: string, root = path.join(process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code'), 'sessions')): string {
  if (!sessionId.startsWith('kimi-')) return '';
  const id = sessionId.slice(5);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return '';
  try {
    for (const workspace of fs.readdirSync(root, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      for (const candidate of new Set([id, `session_${id}`])) {
        const file = path.join(root, workspace.name, candidate, 'agents', 'main', 'wire.jsonl');
        try { if (fs.statSync(file).isFile()) return file; } catch { /* another workspace */ }
      }
    }
  } catch { /* unavailable host home */ }
  return '';
}

function stepsOf(s: Session): Step[] | null {
  if (!s.transcript && s.host === 'codex') s.transcript = findCodexTranscript(s.id);
  if (!s.transcript && s.host === 'kimi') s.transcript = findKimiTranscript(s.id);
  if (!s.transcript) return null;
  try {
    return readSteps(s.transcript, s.host);
  } catch {
    return null;
  }
}

/** What the session's human last asked of it, for a summary when the session has not written one. */
export function lastAsked(s: Session, max = 100): string {
  const asked = stepsOf(s)?.filter((step) => step.kind === 'asked').at(-1);
  return asked ? clip(asked.text, max) : '';
}

/** The one thing a session did most recently, for the roster. */
export function latest(s: Session): string {
  const last = stepsOf(s)?.filter((step) => step.kind !== 'asked').at(-1);
  return last ? clip(last.text, 90) : '';
}

export function glance(board: Board, s: Session): string {
  const head = board.describe(s);
  const steps = stepsOf(s);
  if (!steps) return `${head}\nNo view into ${s.name}'s steps yet; send a message if you need to know.`;
  const asked = steps.filter((step) => step.kind === 'asked').at(-1);
  const since = steps.slice(asked ? steps.lastIndexOf(asked) + 1 : 0).slice(-RECENT);
  return [
    head,
    asked ? `Its human last asked: "${clip(asked.text, 240)}"` : '',
    since.length ? 'Latest steps, oldest first:' : 'No steps since then.',
    ...since.map((step) => `- ${step.kind === 'says' ? `said: "${clip(step.text, 200)}"` : clip(step.text, 160)}`),
  ].filter(Boolean).join('\n');
}
