import { continuationLimit } from './loop-limit.js';
/**
 * What a host hook gets back. Claude and Codex share the event names and the
 * output shape, so one handler serves both. Returns null when there is nothing
 * to say, which costs the session no tokens.
 */
import { ago, type Board, type Host, type Session } from './board.js';
import { lastAsked } from './glance.js';
import { offerMail } from './mail.js';
import { KIMI_WAKE_LINE } from './kimi-console.js';
import { wakeText } from './wake.js';
import { vaultRules } from './vault-tool.js';
import { catchup } from './vault-catchup.js';
import { clipChars } from './text-cut.js';
import { projectLine, projectSpace, type ProjectSpace } from './vault-projects.js';
import { afterGit } from './vault-working-copies.js';
import { noteCall } from './host-calls.js';

/**
 * The shared-vault lines (D118), heard once per version: Claude and Codex at SessionStart, Kimi (whose
 * SessionStart cannot carry context) and any session that missed it with its next prompt.
 */
function vaultLines(s: Session, always = false): string {
  const text = vaultRules();
  if (!text) return '';
  const heard = `${text.length}:${[...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}`;
  if (!always && s.vaultHeard === heard) return '';
  s.vaultHeard = heard;
  return text;
}

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  source?: string;
  prompt?: string;
  session_title?: string;
  agent_id?: string;
  /** PreToolUse / PermissionRequest: the tool about to run. */
  tool_name?: string;
  /** D130, Kimi only: the hook's parent process, inside the open Kimi window (absent for a hidden wake). */
  console_pid?: number;
  /** PostToolUse (Claude): the tool's input; a shell command that ran git refreshes the repo's working-copies row (D131). */
  tool_input?: { command?: unknown } & Record<string, unknown>;
}

/** Mail may keep a turn alive this many times before it waits for the human. */
export { MAX_CONTINUES } from './board.js';

/** Bump when ETIQUETTE changes; sessions told an older version hear the new one once. */
const RULES = 14;
/** What each version added, for sessions that already have the rest. */
const ADDED: Record<number, string> = {
  14: 'The start roster lists only live sessions in your repository; peers shows everyone.',
  13: 'Board guidance is shorter now (D133); the tool descriptions carry the details.',
  12: '- Prefer send(delivery="next-step") for information, "batch" for routine action (2s window), "immediate" for urgent action. Omitted keeps immediate delivery. Do not acknowledge unless it changes the next action.\n' +
    '- Prefer task(op="list", compact=true) for open handoffs; follow next_offset, use status(id) for full evidence.\n' +
    '- Discover tool names first, then read only the definitions needed; never dump the full tool catalog.',
  11: '- Say each thing once. task(op="complete"|"block") already tells the requester; do not also send it.\n' +
    '  Name only the sessions that must act on a message; the rest can glance. The board does not deliver\n' +
    '  a message its recipient already received, from you or anyone else.',
  10: 'The board reads session titles and active tasks automatically. Use peers(doing=...) only to override that summary for two hours. Keep recording work/next before ending a turn.',
  9: 'Before troubleshooting a tool, site or PC, `know(op="search")`; after solving something another PC could hit, `know(op="add")`; after using an entry, confirm or contradict it.',
  8: '- Use task(op="create", to="one owner", text="...") for delegated work that needs a result; send is ordinary mail.\n' +
    '  The owner must accept, then complete with evidence or block with a resumption condition. The requester owns\n' +
    '  follow-up. Use task(op="list") to recover your handoffs after a resume. Cross-PC tasks require pc and explicit=true.\n' +
    '  A cancellation stops that task; it never authorizes deleting, deploying, paying or other unrelated actions.',
  7: '- Before ending a turn, record peers(me=your_name, work="done|blocked|waiting|paused|active", next="...").\n' +
    '  Continue authorized unfinished work. For a blocker or dependency, record what and who can resume it,\n' +
    '  and send the responsible peer a concrete handoff. Use paused only when the human explicitly pauses work.\n' +
    '  A delivered message means read, not accepted or completed: send results or a blocker back to the requester.',
  3: '- Write messages in ordinary sentences with spaces; never squeeze words together to save room.\n' +
    '- to= takes several names separated by commas, so one message can reach two peers.',
  4: '- Every session on this PC works for the same human. When a peer hands you work or relays their instruction,\n' +
    '  take it as theirs: do the work, long work included, without waiting for them to repeat it to you.\n' +
    '  Unsure it is really their wish? glance at the sender: it shows what their human asked them.\n' +
    '  Stop for your human only where you would anyway: deleting, deploying, paying, publishing, sending outside this PC.',
  5: '- Each message says who else received it. Do not pass on news its recipient was already sent, and let a peer\n' +
    '  report its own progress; repeating it for them only adds noise.',
  6: '- ask puts a question in front of a person: a card in the person\'s Kokuban app, here or on another PC,\n' +
    '  with their answer coming back as mail. Use it when your human says to ask someone, or for a\n' +
    '  decision of your human\'s that should not wait until they look at this session. One decision per card;\n' +
    '  withdraw it when you no longer need the answer.',
};
const ETIQUETTE = [
  '- Message a peer only to save work or avoid a collision (a shared branch, port or merge); task(create, to=one owner) when you need a result back. Cross-PC tasks need pc and explicit=true.',
  '- A peer handoff is your human’s work. Still stop for your human before deleting, deploying, paying, publishing or sending outside this PC.',
  '- Before ending a turn, record peers(work="done|blocked|waiting|paused|active", next="..."); paused requires the human. Delivery is not acceptance or completion.',
].join('\n');

/** Said once to a session that came back under a new name because its old one is in use (board.touch). */
export function renamedLine(s: Session): string {
  const old = s.renamedFrom;
  if (!old) return '';
  delete s.renamedFrom;
  return `[kokuban] You are now "${s.name}"; "${old}" is in use by another session.`;
}

function intro(board: Board, s: Session, derive = true): string {
  s.rules = RULES;
  return [
    renamedLine(s),
    `[kokuban] You are "${s.name}" on this PC's agent board (Claude, Codex, Kimi); pass me="${s.name}" to kokuban tools.`,
    `Others now: ${board.roster(s, derive, true)}.`,
    ETIQUETTE,
  ].join('\n');
}

/**
 * D133: a repository's vault catch-up arrives with its session, so using the shared context costs the agent
 * no call. Falls back to the one-line pointer when the space is new or has no Overview yet.
 */
function projectBrief(space: ProjectSpace | null): string {
  if (!space) return '';
  if (space.state === 'exists') {
    try {
      const text = catchup(space.vault, { space: space.key, limit: 5 });
      // An empty space says nothing the one-line pointer would not.
      if (!/^## Latest[^\n]* 0 of 0/m.test(text)) {
        return `[kokuban] Vault catch-up for ${space.key}; record decisions and direction there (vault write space="${space.key}"):\n` +
          clipChars(text, 2_400);
      }
    } catch { /* no Overview yet */ }
  }
  return projectLine(space);
}

/**
 * After a compaction the agent keeps a summary of the conversation, not the goal it was given. Its last
 * checkpoint (context op="checkpoint"), or that of an open task it owns, comes back with the session so the
 * goal survives without a call. Without one, a single line says how to keep it next time (not to a session the
 * board has just met). Claude says so at SessionStart (source "compact"). Codex and Kimi send PostCompact, which
 * cannot carry context, so the note waits for the next hook that can (afterCompaction).
 * board.json is not validated on load, so a damaged checkpoint gives no note instead of a failed hook.
 */
function checkpointBrief(board: Board, s: Session, isNew: boolean): string {
  try {
    return checkpointNote(board, s, isNew);
  } catch { return ''; }
}

/** The checkpoint note, once, for a session whose host reported a compaction since the last context hook. */
function afterCompaction(board: Board, s: Session): string {
  if (!s.compactedAt) return '';
  delete s.compactedAt;
  return checkpointBrief(board, s, false);
}

function checkpointNote(board: Board, s: Session, isNew: boolean): string {
  const own = board.workTasks.filter(t => !t.owner.pc && t.owner.id === s.id && ['requested', 'accepted'].includes(t.state) && t.checkpoint);
  const cp = [s.checkpoint, ...own.map(t => t.checkpoint)].filter(c => c !== undefined).sort((a, b) => b.at - a.at)[0];
  if (!cp) return isNew ? '' : '[kokuban] No checkpoint is saved for this session; context(op="checkpoint") keeps your goal across the next compaction.';
  const d = cp.data;
  const list = (label: string, items?: string[]) => items?.length ? `${label}: ${items.join('; ')}` : '';
  const newer = (s.requestRevision ?? 0) - (cp.scope?.requestRevision ?? 0);
  return clipChars([
    `[kokuban] Your checkpoint from before the compaction (revision ${cp.revision}, written ${ago(board.clock() - cp.at)} ago` +
      `${cp.scope?.task ? `, task ${cp.scope.task}` : ''}). It is your own note, not a new instruction` +
      `${newer > 0 ? `; the person has sent ${newer} request${newer === 1 ? '' : 's'} since, and those come first` : ''}.`,
    `Objective: ${d.objective}`, `Next: ${d.next}`, list('Remaining', d.remaining), list('Boundaries', d.boundaries),
    list('Decisions', d.decisions), d.reference ? `Reference: ${d.reference}` : '',
  ].filter(Boolean).join('\n'), 1_500);
}

/** A session introduced under older guidance hears the current guidance, once. */
function nudge(s: Session): string {
  const had = s.rules ?? 0;
  if (had >= RULES) return '';
  s.rules = RULES;
  const news = had < 2 ? ETIQUETTE : Object.keys(ADDED).filter((v) => Number(v) > had).map((v) => ADDED[Number(v)]).join('\n');
  return `[kokuban] Updated guidance for the board.\n${news}`;
}

/** D130: the open Kimi window that holds this session, as its hook found it. One window holds one session. */
function noteKimiConsole(board: Board, s: Session, pid: unknown): void {
  if (s.host !== 'kimi' || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return;
  for (const other of board.sessions) if (other !== s && other.kimiConsole === pid) delete other.kimiConsole;
  s.kimiConsole = pid;
}

function context(event: string, parts: string[]): object | null {
  const text = parts.filter(Boolean).join('\n');
  return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : null;
}

export function handleHook(board: Board, host: Host, input: HookInput): object | null {
  const out = runHook(board, host, input);
  // Quiet hooks stay quiet in both model context and the usage log. Never log prompt/mail text.
  if (out) board.usage?.({ ts: board.clock(), tool: 'hook:context', event: input.hook_event_name,
    me: board.sessions.find(s => s.id === input.session_id)?.name, outputChars: JSON.stringify(out).length });
  return out;
}

function runHook(board: Board, host: Host, input: HookInput): object | null {
  const event = input.hook_event_name ?? '';
  if (!input.session_id) return null;
  if (input.agent_id) return null;
  const previous = board.sessions.find((s) => s.id === input.session_id);
  // Codex and Kimi: the host compacted. The hook cannot answer with context, and a compaction is no proof that
  // offered mail was read, so it only marks a session the board already knows; nothing else changes.
  if (event === 'PostCompact') {
    if (previous) {
      previous.compactedAt = board.clock();
      board.usage?.({ ts: board.clock(), tool: 'hook:compact', me: previous.name });
      board.save();
    }
    return null;
  }
  const resuming = previous && (previous.work === 'paused' || previous.state === 'gone' || board.clock() - previous.seen >= 30 * 60_000);
  // D130: mail announced by a line typed into the Kimi window has not been offered yet, so no receipt
  // below may count it as read. The prompt that carries the line hands it over with the wake framing;
  // any other prompt or step offers it as ordinary mail.
  let announced: number[] = [];
  if (host === 'kimi' && previous?.kimiTyped) {
    const typed = previous.kimiTyped;
    for (const m of board.messages) if (typed.ids.includes(m.id) && !m.delivered && m.shownTo === previous.id) {
      delete m.shownAt; delete m.shownTo;
    }
    if (event === 'UserPromptSubmit') {
      delete previous.kimiTyped;
      if ((input.prompt ?? '').includes(KIMI_WAKE_LINE)) announced = typed.ids;
    }
  }
  // Kimi observation hooks cannot deliver context. In particular an interrupted
  // prompt is not proof that the model read the previous mail offer.
  if (host === 'kimi' && ['Interrupt', 'StopFailure', 'SessionStart', 'PostToolUse'].includes(event)) {
    if (!previous) return null; // First-contact guidance belongs in a blockable prompt hook.
    const { session: s } = board.touch(input.session_id, input.cwd ?? previous?.cwd ?? '', host);
    noteKimiConsole(board, s, input.console_pid);
    projectSpace(board, s, event === 'SessionStart'); // D91: Kimi cannot hear the line here, but its repo still gets a space.
    if (resuming && event === 'SessionStart') s.deferredMailBefore = board.clock() - 30 * 60_000;
    if (event === 'Interrupt') {
      for (const m of board.messages) if (!m.delivered && m.shownTo === s.id) {
        delete m.shownAt;
        delete m.shownTo;
      }
      s.state = 'idle';
      board.setWork(s, 'paused', 'The human interrupted Kimi. Resume with a new prompt.');
    } else if (event === 'StopFailure') {
      s.state = 'idle';
      board.setWork(s, 'blocked', 'Kimi ended with an error. The human can retry with a new prompt.');
    } else if (event === 'SessionStart') {
      s.state = 'idle';
      // Opening a saved conversation does not authorize an automatic turn.
    } else {
      s.state = 'working';
      s.toolReceipts = true;
      board.confirm(s);
    }
    board.save();
    return null;
  }
  if (previous) board.confirm(previous);
  if (event === 'SessionEnd') {
    board.end(input.session_id);
    return null;
  }
  const { session: s, isNew } = board.touch(input.session_id, input.cwd ?? '', host);
  noteKimiConsole(board, s, input.console_pid);
  if (resuming && ['SessionStart', 'UserPromptSubmit'].includes(event)) s.deferredMailBefore = board.clock() - 30 * 60_000;
  // A subagent shares its parent's session id; mail belongs in the parent's context.
  if (input.transcript_path) s.transcript = input.transcript_path;
  // Hosts retitle a thread on their own after the first prompt; put the name back at turn boundaries.
  if (event !== 'PostToolUse') board.titler?.(s);
  // Codex hooks do not carry the prompt, so its fallback summary comes from the transcript.
  if (host === 'codex' && !s.doing && event !== 'PostToolUse') s.prompt = lastAsked(s) || s.prompt;
  // D91: a repository first seen here gets its vault project space; this never blocks or slows the hook.
  const space = projectSpace(board, s, event === 'SessionStart');

  // D127: any later step of the session means its human answered, or the wait is over.
  if (['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].includes(event)) delete s.waitingOnHuman;

  switch (event) {
    // D127, Claude only (matcher AskUserQuestion and PermissionRequest, both HTTP: no process per event):
    // the turn now waits on its human. Nothing is answered or decided here, so the host shows its own prompt.
    case 'PreToolUse':
    case 'PermissionRequest': {
      // A kokuban tool call: note who makes it, so the MCP side keeps this session's name (host-calls.ts).
      if (event === 'PreToolUse' && input.tool_name?.startsWith('mcp__kokuban__')) {
        noteCall(board, s.id, input.tool_name.slice('mcp__kokuban__'.length), input.tool_input);
        return null;
      }
      if (host !== 'claude' || (event === 'PreToolUse' && input.tool_name !== 'AskUserQuestion')) return null;
      s.waitingOnHuman = { kind: event === 'PreToolUse' ? 'question' : 'approval', since: board.clock(), via: 'claude' };
      board.save();
      return null;
    }
    case 'SessionStart': {
      // After compaction, a resume or /clear the agent may have lost its name: say it again.
      const again = !isNew && s.rules && ['compact', 'resume', 'clear'].includes(input.source ?? '')
        ? `[kokuban] You are "${s.name}" on the board; pass me="${s.name}" to kokuban tools.` : '';
      const kept = input.source === 'compact' ? checkpointBrief(board, s, isNew) : '';
      if (kept) delete s.compactedAt;
      let out = context(event, [isNew || !s.rules ? intro(board, s) : nudge(s) || again, kept, vaultLines(s, true), projectBrief(space), offerMail(board, s)]) as {
        hookSpecificOutput: Record<string, unknown>;
        systemMessage?: string;
      } | null;
      const mayTitle = ['startup', 'resume', 'fork'].includes(input.source ?? '') &&
        (isNew || !input.session_title || input.session_title === s.name);
      if (host === 'claude' && mayTitle) {
        out ??= { hookSpecificOutput: { hookEventName: event } };
        out.hookSpecificOutput.sessionTitle = s.name;
      }
      if (isNew) out!.systemMessage = `kokuban: this session is ${s.name}`;
      return out;
    }
    case 'UserPromptSubmit': {
      s.state = 'working';
      s.stopChecked = false;
      const automatic=/^(?:<kokuban-message|\[kokuban\])/.test(input.prompt??'')||(!input.prompt&&Boolean(s.wokenAt&&board.clock()-s.wokenAt<=20000));
      if (!automatic) s.requestRevision = (s.requestRevision ?? 0) + 1;
      if(automatic)board.beginMailWork(s);else delete s.beforeMailWork;
      s.work = 'active';
      s.next = undefined;
      // A prompt that follows a wake-up is kokuban's, not the human's, and must not reset the limit.
      if (!s.wokenAt || board.clock() - s.wokenAt > 20_000) s.continues = 0;
      const asked = (input.prompt ?? '').replace(/\s+/g, ' ').trim();
      // A host notification arrives as a prompt too, wrapped in a tag; it is not the human's request.
      if (asked.length >= 15 && !asked.startsWith('<') && !asked.startsWith('[kokuban]')) s.prompt = asked.length > 100 ? `${asked.slice(0, 99)}…` : asked;
      const delta = isNew ? '' : board.rosterDelta(s, true);
      // D130: the typed wake line's mail, framed as the hidden wake prompt would have carried it.
      const woken = board.messages.filter((m) => announced.includes(m.id) && board.ready(m, s));
      board.show(s, woken);
      return context(event, [isNew ? intro(board, s) : delta && `[kokuban] ${delta}`, renamedLine(s), nudge(s), afterCompaction(board, s), vaultLines(s),
        woken.length ? wakeText(board, woken) : '', offerMail(board, s)]);
    }
    case 'PostToolUse': {
      s.state = 'working';
      s.toolReceipts = true;
      afterGit(board, s.cwd, input.tool_input?.command);
      return context(event, [isNew ? intro(board, s, false) : nudge(s), renamedLine(s), afterCompaction(board, s), offerMail(board, s)]);
    }
    case 'Stop': {
      if (s.managed) { s.state = 'idle'; board.save(); return null; }
      if (!board.messages.some(m => board.needsAttention(m, s)) || s.work === 'paused' || s.continues >= continuationLimit(board.clock())) {
        const unfinished = board.workTasks.filter((t) => !t.owner.pc && t.owner.id === s.id &&
          (t.state === 'requested' || t.state === 'accepted'));
        // Only an owned, unresolved task earns a check, once per turn: an ordinary answered
        // prompt ends quietly, and the board shows its unrecorded outcome instead.
        if (unfinished.length && s.work !== 'paused' && !s.stopChecked && s.continues < continuationLimit(board.clock())) {
          s.stopChecked = true;
          s.continues++;
          board.save();
          return { decision: 'block', reason: '[kokuban] You are ending a turn with no recorded work outcome. ' +
            'If authorized work remains, continue it. Otherwise record peers(me="' + s.name +
            '", work="done|blocked|waiting|paused", next="concrete remaining step or blocker and who/what resumes it"). ' +
            `Unresolved owned tasks: ${unfinished.map((t) => t.id).join(', ')}. Complete or block them with task: that tells ` +
            'their requesters, so do not also send it. ' +
            'Do not repeat this check or invent new work.' };
        }
        s.state = 'idle';
        if(!unfinished.length)board.finishMailWork(s);
        board.usage?.({ ts: board.clock(), tool: 'stop', me: s.name, work: s.work ?? 'unknown',
          pending: board.messages.filter((m) => m.to === s.id && !m.delivered).length });
        board.save();
        return null;
      }
      s.continues++;
      board.beginMailWork(s);
      s.stopChecked = false;
      board.save();
      return {
        decision: 'block',
        reason: `${offerMail(board, s)}\nThis arrived as you were finishing. Act on it before you end your turn.`,
      };
    }
    default:
      return null;
  }
}
