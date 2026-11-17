/**
 * The MCP surface: the board's tools for agents, `remote` for sessions on another
 * PC (bridge.ts), plus one host-internal tool that lets Codex hooks reach the board
 * without spawning a process. Hand-rolled
 * JSON-RPC, since the whole protocol we need is four methods.
 */
import { randomBytes } from 'node:crypto';
import type { Board, Host, Session } from './board.js';
// ASK_TOOL owns headline/question guidance so every host sees the same action-line contract.
import { ASK_TOOL, askTool } from './ask.js';
import { glance } from './glance.js';
import { claimCall } from './host-calls.js';
import { handleHook } from './hooks.js';
import { TASK_TOOL, taskTool } from './tasks.js';
import { KNOW_TOOL, knowTool } from './know.js';
import { inboxTool } from './inbox.js';
import { CONTEXT_TOOL, contextTool } from './context.js';
import { keeperConfig } from './vault-store.js';
import { VAULT_TOOL, vaultTool } from './vault-tool.js';
import { headChars } from './text-cut.js';
import { workingCopyHint } from './vault-working-copies.js';
import { ACK_SCHEMA, acknowledgeMail } from './receipts.js';

const ME = { type: 'string', description: 'Your kokuban name ("new" if you were never given one).' };

const TOOLS = [
  {
    name: 'peers',
    description: 'Who else is on this PC right now: every Claude and Codex session, what it is achieving, where it works, and what it holds. Summaries come from session titles and active tasks; doing overrides them for two hours. Before ending a turn record work and next so completion, blockers and pauses are visible; recording answers with only who joined or left.',
    inputSchema: {
      type: 'object',
      properties: { me: ME, doing: { type: 'string', description: 'What this session is achieving, in one line.' },
        work: { type: 'string', enum: ['active', 'blocked', 'waiting', 'paused', 'done'], description: 'Record work disposition before ending a turn.' },
        next: { type: 'string', description: 'Next action, or blocker and who/what can resume it. Required for blocked, waiting, paused.' } },
      required: ['me'],
    },
  },
  {
    name: 'glance',
    description: "Look over a peer's shoulder: what its human last asked and its latest steps. It is not interrupted and does not know. Prefer this to asking.",
    inputSchema: {
      type: 'object',
      properties: { me: ME, who: { type: 'string', description: "The peer's name." } },
      required: ['me', 'who'],
    },
  },
  {
    name: 'send',
    description: 'Message a session by name (several, comma-separated), "all" (your repository), "repo:name" (another repository), or "everyone" (the whole PC). Send what changes what they do, only to those who must act on it; glance instead of asking for status. A recipient that already received the same news is skipped. Direct mail wakes an eligible idle session; broadcasts wait for its next step.',
    inputSchema: {
      type: 'object',
      properties: { me: ME, to: { type: 'string' }, text: { type: 'string', description: 'Keep messages brief: result, link, and required action or blocker. Put supporting details in the linked PR or document. Include safety limits needed for the next action.' },
        delivery: { type: 'string', enum: ['immediate', 'batch', 'next-step'], description: 'Use next-step for information (no wake), batch for routine action (2s collection window), immediate for urgent action. Omitted preserves immediate delivery.' } },
      required: ['me', 'to', 'text'],
    },
  },
  {
    name: 'inbox',
    description: 'Unread mail: default 10 messages / 12000 characters; oversized bodies stay intact. Unconfirmed offers retry after 90 seconds. Attach ack IDs to normal board work; do not make receipt-only calls. wait_s (up to 50) waits for an expected reply.',
    inputSchema: {
      type: 'object',
      properties: { me: ME, wait_s: { type: 'number' },
        include_deferred: { type: 'boolean', description: 'Explicitly read old informational mail parked on resume. Bodies remain intact and unread until offered.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum messages in this batch; default 10.' },
        ack: ACK_SCHEMA },
      required: ['me'],
    },
  },
  {
    name: 'claim',
    description: 'Take a named shared resource before using it, e.g. "port:3000", "merge:main", "branch:release". Fails if another session holds it.',
    inputSchema: {
      type: 'object',
      properties: { me: ME, what: { type: 'string' }, note: { type: 'string' } },
      required: ['me', 'what'],
    },
  },
  {
    name: 'release',
    description: 'Release a resource you claimed; omit `what` to release all of yours.',
    inputSchema: { type: 'object', properties: { me: ME, what: { type: 'string' } }, required: ['me'] },
  },
  {
    name: 'remote',
    description: 'Sessions on another of your human\'s PCs, reached board to board over the tailnet. Not part of normal work: use it only when your human asked for work with another PC, or to answer mail that came from one, and pass explicit=true to say so. op "peers" lists the sessions on that PC, "glance" looks at one (to=its name), "send" messages exactly one by name (no "all", no several names) and returns a message id, "receipt" (id) says whether that message is still queued or was shown to its reader. A reply comes back as ordinary mail from "name@pc".',
    inputSchema: {
      type: 'object',
      properties: {
        me: ME,
        op: { type: 'string', enum: ['peers', 'glance', 'send', 'receipt'] },
        pc: { type: 'string', description: 'The other PC\'s tailnet name.' },
        to: { type: 'string', description: 'One session name on that PC.' },
        to_id: { type: 'string', description: 'Its session id from peers, so a reply cannot reach a later session of the same name.' },
        text: { type: 'string' },
        id: { type: 'number', description: 'For receipt: the message id send returned.' },
        explicit: { type: 'boolean', description: 'true only when your human asked for this, or you are answering mail from that PC.' },
      },
      required: ['me', 'op', 'pc', 'explicit'],
    },
  },
  ASK_TOOL,
  TASK_TOOL,
  KNOW_TOOL,
  CONTEXT_TOOL,
];
const withAck = <T extends { inputSchema: { properties: object } }>(tool: T): T => ({ ...tool, inputSchema: { ...tool.inputSchema,
  properties: { ...tool.inputSchema.properties, ack: ACK_SCHEMA } } });
const PUBLIC_TOOLS = TOOLS.map(withAck);
/** The shared vault tool exists only on a PC whose settings name a vault (vault-keeper.ts). */
const publicTools = () => keeperConfig() ? [...PUBLIC_TOOLS, withAck(VAULT_TOOL)] : PUBLIC_TOOLS;

const HOOK_TOOL = {
  name: 'hook',
  description: 'Host-internal: called by Codex lifecycle hooks. Never call this yourself.',
  inputSchema: {
    type: 'object',
    properties: { event: { type: 'string' }, session_id: { type: 'string' }, cwd: { type: 'string' } },
    required: ['event', 'session_id'],
  },
};

type Args = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function resolveMe(board: Board, host: Host, me: string, tool = '', args: Args = {}): { session: Session; note: string } {
  // The host session that announced this exact call in its PreToolUse hook (host-calls.ts), if any.
  const boundId = host === 'claude' && tool ? claimCall(board, tool, args) : undefined;
  const bound = boundId ? board.sessions.find((s) => s.id === boundId && s.state !== 'gone') : undefined;
  const keep = (why: string) => {
    bound!.seen = board.clock();
    return { session: bound!, note: `${why}You are "${bound!.name}"; pass me="${bound!.name}" from now on.
` };
  };
  if (!me.trim() || me.trim().toLowerCase() === 'new') {
    if (bound) return keep('');
    const { session } = board.touch(`manual-${randomBytes(6).toString('hex')}`, '', host);
    return { session, note: `You are "${session.name}"; pass me="${session.name}" from now on.
` };
  }
  const session = board.byName(me);
  if (bound && session?.id !== bound.id) return keep(session ? `"${me}" is another session. ` : `No session is named "${me}". `);
  if (!session) {
    throw new Error(`no session is named "${me}". Your name is in the [kokuban] note you were given; ` +
      'if you never got one, pass me="new".');
  }
  session.seen = board.clock();
  return { session, note: '' };
}

/** The usage log's reason for a failed call: one line, short, with any password the call carried masked. */
export function failureReason(output: string, args: Args): string {
  let text = output.replace(/\s+/g, ' ').trim();
  const secret = typeof args.value === 'string' ? args.value : '';
  if (secret.length >= 3) text = text.split(secret).join('••••••');
  return headChars(text, 300) || 'no message';
}

async function callTool(board: Board, host: Host, name: string, args: Args): Promise<string> {
  if (name === 'hook') {
    const out = handleHook(board, 'codex', {
      hook_event_name: str(args.event), session_id: str(args.session_id), cwd: str(args.cwd),
    });
    return out ? JSON.stringify(out) : '';
  }
  const { session: me, note } = resolveMe(board, host, str(args.me), name, args);
  const started = performance.now();
  // Logged when the call ends, with how it went: a refusal reads "nothing ..." or "not yours", an error throws.
  const log = (ok: boolean, output: string): void => board.usage?.({
    ts: board.clock(), tool: name, me: me.name, to: str(args.to) || str(args.who) || undefined,
    chars: str(args.text).length || undefined, ok,
    inputChars: JSON.stringify(args).length, outputChars: output.length,
    durationMs: Math.round(performance.now() - started),
    ...(name === 'send' ? { delivery: str(args.delivery) || 'immediate' } : {}),
    ...(name === 'context' && ['discover', 'search', 'read', 'resume', 'checkpoint', 'capabilities'].includes(str(args.op)) ? { op: str(args.op) } : {}),
    ...(name === 'vault' ? { op: str(args.op) || undefined, kind: str(args.kind) || undefined } : {}),
    // A failure says why (keeper-pc audit: 27 failed vault calls with no reason), never with a password in it.
    ...(ok ? {} : { error: failureReason(output, args) }),
  });
  try {
    if (name !== 'inbox' && args.ack !== undefined) {
      const acknowledged = acknowledgeMail(board, me, args.ack);
      board.usage?.({ ts: board.clock(), tool: 'mail:receipt', me: me.name, acknowledged });
    }
    const out = await runTool(board, me, note, name, args);
    log(!/^(nothing (sent|claimed)|not yours)/.test(out.slice(note.length)), out);
    return out;
  } catch (err) {
    log(false, (err as Error).message);
    throw err;
  }
}

async function runTool(board: Board, me: Session, note: string, name: string, args: Args): Promise<string> {
  switch (name) {
    case 'context':
      return note + await contextTool(board, me, args);
    case 'know':
      return note + knowTool(board, me, args);
    case 'vault':
      return note + await vaultTool(board, me, args);
    case 'peers': {
      if (args.work !== undefined) board.setWork(me, str(args.work), str(args.next));
      if (str(args.doing).trim()) board.setDoing(me, str(args.doing));
      // Recording an outcome ends most turns; the whole roster again would be news only where it changed.
      if (args.work !== undefined) {
        const delta = board.rosterDelta(me);
        return `${note}Recorded: ${board.describe(me)}.${delta ? `\n${delta}` : ''}`;
      }
      // D131: unpushed or uncommitted work in another PC's copy of this repository, from the synced vault page.
      const elsewhere = workingCopyHint(keeperConfig(), me.cwd);
      return `${note}You are ${board.describe(me)}.\nOthers: ${board.roster(me)}.${elsewhere ? `\n${elsewhere}` : ''}`;
    }
    case 'glance': {
      const name = str(args.who).trim();
      if (!name) throw new Error('who is required: use glance(me="your name", who="peer name").');
      const who = board.byName(name);
      if (!who) throw new Error('Peer is not present. Use peers to find a live name, or context(resume, who=session_id) for archived work.');
      return note + glance(board, who);
    }
    case 'send':
      return note + board.send(me, str(args.to), str(args.text), args.delivery as 'immediate' | 'batch' | 'next-step' | undefined);
    case 'inbox':
      return note + await inboxTool(board, me, args);
    case 'claim':
      return note + board.claim(me, str(args.what), str(args.note));
    case 'release':
      return note + board.release(me, str(args.what));
    case 'remote': {
      const op = str(args.op);
      const [pc, to, text] = [str(args.pc).trim(), str(args.to).trim(), str(args.text).trim()];
      if (args.explicit !== true) {
        throw new Error('remote reaches another PC, so it is not used on your own initiative: pass explicit=true only ' +
          'when your human asked for work with that PC, or you are answering mail that came from it.');
      }
      if (!['peers', 'glance', 'send', 'receipt'].includes(op)) throw new Error('op must be peers, glance, send or receipt');
      if (!pc) throw new Error('pc required: the other PC\'s tailnet name');
      if (op === 'receipt' && typeof args.id !== 'number') throw new Error('receipt needs id: the message id send returned');
      if ((op === 'glance' || op === 'send') && (!to || to.includes(',') || ['all', 'everyone'].includes(to.toLowerCase()))) {
        throw new Error(`${op} needs to: exactly one session name on ${pc}. There are no broadcasts between PCs.`);
      }
      if (op === 'send' && !text) throw new Error('nothing sent: the text is empty');
      if (!board.remote) throw new Error('remote is not available on this board');
      // `me` is the name the board resolved, never the caller's spelling of it; the id makes a retry harmless.
      return note + await board.remote({
        op: `agent_${op}`, pc, me: me.name, explicit: true,
        ...(to ? { to } : {}), ...(str(args.to_id) ? { to_id: str(args.to_id) } : {}),
        ...(op === 'send' ? { text, request_id: randomBytes(8).toString('hex') } : {}),
        ...(op === 'receipt' ? { id: String(args.id) } : {}),   // Wire ids are text
      });
    }
    case 'ask':
      return note + await askTool(board, me, args);
    case 'task':
      return note + await taskTool(board, me, args);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Args; protocolVersion?: string };
}

/** Answer one JSON-RPC message; null for notifications, which get no reply. */
export async function handleRpc(board: Board, host: Host, msg: Rpc): Promise<object | null> {
  if (msg.id === undefined || msg.id === null) return null;
  const reply = (result: object) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'kokuban', version: '0.4.0' },
        // The vault's rules are the SessionStart lines (vaultRules) and the vault tool's description; not repeated here.
        instructions: 'Shared agent board on this PC. Pass your assigned name as me; use me="new" only if unnamed.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: host === 'codex' ? [...publicTools(), HOOK_TOOL] : publicTools() });
    case 'tools/call':
      try {
        const text = await callTool(board, host, msg.params?.name ?? '', msg.params?.arguments ?? {});
        return reply({ content: [{ type: 'text', text }] });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: (err as Error).message }], isError: true });
      }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
  }
}
