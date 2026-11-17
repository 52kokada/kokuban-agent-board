# Kokuban - Spec v5

Status: v5, 2026-10-16. Replaces v4. The board is a small local coordination service
with a native Windows face and direct authenticated links to paired boards.

## Problem

Claude Code and Codex sessions work simultaneously across worktrees and PCs.
They need to find each other, hand over concrete work, and avoid collisions in
shared ports and branches without expensive per-tool-call commands or repeated
status reporting.

## What earlier versions got wrong

Per-repository boards split worktrees; per-tool command hooks opened consoles;
ceremonial records consumed tokens. Browser windows, toast handling and indirect
transport later duplicated the native app and direct peer path. v5 removes those
fallbacks and the supervisor, retaining evidence and human-owned decisions.

## Decisions inherited from v4

1. **Kept: one board per machine.** One long-lived process; repository and branch
   identify each session, with canonical git remotes grouping projects across PCs.
2. **Kept: MCP is the common surface.** Both hosts use the same agent tools.
3. **Superseded in part: hooks without per-tool commands.** Claude prompt/tool/Stop
   hooks use HTTP, Codex uses MCP hooks. Claude SessionStart runs start-hook.js;
   each Claude turn also has one asyncRewake Stop command, wake-hook.js.
4. **Kept: register on first sight.** An unknown parent session joins at any hook.
5. **Kept: random human names.** Unique among live sessions, retained for a day.
   Local callers identify their session using me. Remote identity comes from Tailscale.
6. **Superseded: three records and once-only delivery.** Sessions, mail, claims,
   cards, ask receipts, tasks, delivery outboxes, pairings, offers, feed marks/events
   and vault metadata are retained as needed. Mail is at least once: take records
   shownAt/shownTo, the next parent hook confirms delivery, and an unconfirmed
   offer may reappear after 90 seconds. Remote sender-only receipts distinguish
   queued, confirmed delivered and unknown. Receipt is not task completion.
7. **Kept: resource claims.** Atomic names for shared resources, not a file-locking
   system. Release on session end or two hours of silence.
8. **Kept: silence is free.** No mail/news means no injected text. Summaries come
   from appended transcript titles/tasks; explicit doing overrides last two hours.
9. **Superseded in part: autonomous peer coordination.** Agents send useful
   handoffs without asking first; the same human's scope still controls consequential
   actions. The continuation limit is 30, not ten. The pair guard reads `loopLimit` from local settings (default 40) and refuses
   the next send after more than that many exchanges in ten minutes; card answers,
   board notices and active-task coordination are exempt. A local runtime setting
   `communicationOverrideUntil` (epoch milliseconds) temporarily lifts continuation
   and pair exchange limits until that instant, shown in peers while active. Each
   check evaluates expiry without a restart; expired/invalid settings restore the
   normal limits without clearing counters or history. A separate persistent local
   setting `disableAutomaticContinuationLimit: true` disables only the automatic
   continuation cap. It is read on every check without resetting counters/history;
   removing it or using any value other than boolean true restores the default 30.
   Pair exchange limits, explicit pause and other wake guards remain unchanged.
10. **Superseded transport; kept separate identity.** Other PCs are reached, never
    joined. Direct /peer replaces the desktop tool transport and fallback. A remote
    sender has no local roster entry, and cannot broadcast between PCs.

## Additional v5 decisions

11. **Peer identity, trust and pairing.** Tailscale Serve exposes only /peer on
    HTTP port 47600. Identity headers are checked with whois. Receiving-PC settings
    grant talk, share or work. Pairing is consent here plus an Allow/Refuse card
    there; unpairing drops the relationship. Project-scoped trust is not implemented.
    The local /bridge route remains temporarily for existing callers. It acts as this
    PC (share level) and refuses a body-claimed foreign PC with 403 unless a local relay
    sends x-kokuban-relay with this PC's peerIngress value; then the trust list decides (D97).
12. **Bounded wake.** Claude uses its background Stop hook; Codex uses codex queue;
    Kimi types one wake line into the open Kimi window its own hooks named, so the turn
    runs where its human watches (D130, docs/kimi-code.md), and resumes hidden only
    when no window is known.
    Only recent direct mail wakes an eligible open idle session. Pause, continuation
    limits and remote CPU/memory gates still apply. Broadcasts wait for a host step.
    Claude's undocumented socket was dropped: a flushed write can be held by its
    inbound policy, and the owner declined crossSessionInbound=accept.
    Waiting on a human (D129): a session whose turn waits on its human is not idle.
    Codex says so in thread/list (active + waitingOnUserInput / waitingOnApproval, read
    by the 20-second poll); Claude through HTTP hooks PreToolUse (matcher AskUserQuestion)
    and PermissionRequest. Its mail is never queued behind the question. Settings
    wakeWaitingSessions=true (per PC, off by default) steers direct mail into a waiting
    Codex turn with turn/steer, under the same wake rules; Codex 0.166 shows it to the
    model only once the human answers. Nothing answers the human's question or prompt:
    an unsubscribed app-server client never receives request_user_input, and Claude has
    no outside input path. Receipts say waking, steering_into_running_turn,
    waiting_on_human, next_step, next_prompt (with its reason) or waiting_for_resources,
    plus reach_detail in words.
13. **Native app and feed.** Every PC runs the WinUI app. Keyed local APIs provide
    cards, tasks, sessions, history, attachments and live changes. Browser UI,
    Electron shell and toast fallback are retired. Local Seen marks hide current
    shared notifications without changing another person's question/task; later
    thread updates remain visible. Later lasts two hours. All question conversations,
    including answered cards with agent follow-ups, expire after twelve hours without
    a new message. Expired cards reject answers and follow-ups. The person's Close
    prompt action permanently dismisses a card without recording consent; its thread
    and closure remain in history. Close prompt appears first so it stays reachable
    when a narrow native window clips long answer buttons.
    **Phone PWA.** A tailnet-only /phone path serves the phone client to the owner's
    paired devices with verified identity and a device token. It is not a desktop
    browser UI; the WinUI app remains the PC client. (Approved direction,
    2026-10-20; implementation follows shared sessions.)
14. **Explicit tasks.** One requester and exact owner session, accept/progress/
    complete/block/cancel, revisioned state and persisted metadata retry. One overdue
    notice, no automatic reassignment. Ordinary send stays ordinary mail.
15. **Shared know-how.** Evidence-backed immutable entries plus confirm/contradict/
    retract marks. Rules bind their named owner, not every reader. Versioned entries
    age out of default search; secrets are refused. Repository facts stay in repos.
16. **Vault.** Work-trusted peers sync credential values through the credential store.
    Only names, times and tombstones reach snapshots/logs; bulk removal needs a card.
17. **Updates.** kokuban update transfers guarded git bundles and app packages from
    paired boards. Unexpected local state refuses mutation. Applying new board code
    needs a coordinated authorized restart; local build alone does not activate it.
18. **Say each thing once (2026-10-23).** Long collaborations keep their limits;
    redundancy is what goes. A bare task acceptance is recorded, not mailed; progress
    queues for the requester's next step without waking it; results, blockers and
    cancellations wake it. Task transitions tell the owner the requester has been told.
    send skips a recipient whose last 30 minutes of mail already says at least 80% of
    the message's three-word phrases (messages under four phrases never count).
    Recording work/next answers with only who joined or left, not the roster. A trusted
    tailnet name that answers the feed as this board itself is neither pulled nor poked.
    Cards and running cross-PC work poke paired boards at once; session status alone
    pokes them at most every 30 seconds, coalesced.

## Context management

- **Short onboarding and vault catch-up at start (D133).** The owner asked
  for less instruction overhead and for the vault to be easier than the alternative.
  The board intro is four lines (talk, hand off, stop-for-human boundaries, record
  peers); tool descriptions carry the rest. At SessionStart a repository whose
  project space has entries receives its `catchup` (clipped to 2,400 characters)
  instead of a pointer, so agents start with the shared context at no tool call.
  Agents no longer must read "How this works" and Rules.md before using the vault;
  those pages remain the human rulebook (D118).

- **Sessions that wait on the person are in For you (D134, 2026-11-11).** The list that
  holds cards and cross-PC tasks also holds this board's live sessions that need their
  person: work=blocked (kind blocked), work=waiting whose next names the person as a whole
  word (decide), and a non-managed session at a terminal question or approval for at least
  60 seconds (decide; managed approvals stay on the phone). Items are thread
  session:<id>:blocked | :waiting | :human, computed on read, never stored, and travel in
  the peer state like other items. Time is Session.workAt (set only when work or next
  changes), else doingAt, else joined (never seen, which moves on every hook); the prompt wait uses its own start. Items older than
  three days are dropped. Seen hides until the time is newer; Later works as for cards.
  No push, no new route or kind.

- **Context management (2026-11-01).** Inbox, hooks and wakes share default
  10-message / 12,000-character soft mail budgets. An oversized individual body
  stays intact and is delivered alone. Human answers, cancellations and results
  take priority. Explicit `ack` IDs on normal board calls complement observed host hook receipts; lost
  responses retain at-least-once recovery. Known resumes omit repeated onboarding.
  Revisioned task notices supersede prior progress, resolved blockers and cancelled
  offers in delivery without rewriting history. Age alone does not discard work.
  Task listing defaults to bounded open summaries; `compact=false` explicitly
  retains the legacy full-history array.
  Task mutations default to compact acknowledgements, with full evidence in status
  and legacy write replies through compact=false. Explicit blocker keys coalesce
  repeat wakes after receipt; changed keys and urgent=true request fresh attention.
  New revisions preserve unreceived actionable wakes, including cross-PC dispatch.
  On paused/stale-session resume, ordinary non-task informational mail older than
  30 minutes stays unread behind a count and include_deferred=true retrieval.
  Task, human and actionable mail is exempt; no age-based deletion occurs.
  The common `context` tool supports metadata discovery, bounded source-linked
  search/read, explicit checkpoints, resume and native capability inspection for
  Claude Code, Codex and Kimi. Native logs remain evidence, native memories
  supplementary, and owned task state authoritative. Checkpoints use optimistic
  revisions and retain previous versions; session recovery survives roster expiry.
  Branch changes and later human prompts are flagged, not silently reconciled.
  Reading another session's recovery state never transfers task ownership.
  Source pointers persist; log bodies remain in native storage. Reads verify
  hashes, exclude private reasoning/replay records and report missing sources.
  Native default Claude/Codex Markdown memory reads are opt-in; global Codex notes
  require explicit cross-repository scope. Kimi journals and common checkpoints
  are supported; custom memory paths and native Kimi memory generation are not
  inferred. Settings and host context windows are untouched.
  Limits: discovery inspects native layouts, not unknown formats; source retention
  follows each host; records over 2 MiB are skipped with counters; transcript
  search is lexical streaming rather than a semantic index. Actual host compaction
  and context eviction remain host-owned. Activation requires the guarded local
  restart workflow, backups, readiness checks and exact module verification.

## Still planned or limited

- Ordinary mail to an offline PC fails; task metadata has a durable retry outbox.
- Person-plus-project packages and resumable general file delivery are planned.
  Current card attachments use direct Taildrop and the keyed app file route.
- Closed host sessions cannot be revived. Waking open idle sessions is implemented,
  subject to a live Claude waiter or usable Codex queue.

The supervisor is removed by decision. Work/next disposition remains
explicit because a transcript cannot establish who can resume blocked work.
