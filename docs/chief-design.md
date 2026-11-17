# Chief: design (Phase 4)

Status: approved. Builds on
`phone-and-chief-plan.md`, shared sessions (Phase 1), the phone gateway
(Phase 2) and push (Phase 3).

## What the chief is

One long-lived managed Claude conversation, pinned at the top of the phone app.
Alex talks to it like a person who sits at his PC. It does small things itself,
hands larger work to Claude or Codex sessions, follows up, and tells Alex only
what he needs to know.

## Runtime

- A managed conversation with `role: chief`, created once and resumed forever.
  Only one chief per PC. If the provider dies, the board resumes it from history.
- Board name reserved as `Chief`. The name pool must never hand it to another
  session (one already appeared in a motion-script project today).
- Working directory `~/githubprojects`, so it can reach every repository.
- MCP servers: kokuban and the desktop tool.
- Context: when the conversation compacts, the chief keeps a short notes file at
  `%LOCALAPPDATA%\kokuban\chief\notes.md` holding open threads, promises made to
  Alex and delegated work. It reads the file on every resume.

## New board abilities the chief needs

The chief already has peers, glance, send, task, ask and know. Add:

- `conversation` tool, for the chief only: launch a managed Claude or Codex
  session in a named repository with a first message, then send, stop, resume,
  shut down, and read recent history. This is the same controller as the phone,
  with the chief recorded as the actor.
- `usage` tool: the same data as `/phone/usage`.
- `notify` tool: push one message to Alex's phone under a category (blocked,
  finished, stuck), respecting his toggles and the noise rules.

## Safety gate

Alex's host runs with permission prompts off, so the SDK's built-in prompt never
fires. A PreToolUse hook, applied to the chief and every session it launches,
classifies each tool call. A call that is consequential becomes an approval card,
with Approve and Deny on the phone, and the call waits for the answer.

Consequential means:

- deleting files or writing outside the session workspace or temp;
- `git push`, deploys and release scripts;
- payments;
- publishing: posts, artifacts, public links;
- sending mail or messages to outside people;
- any Shopify mutation, which stays audit-only under Alex's standing rule.

Everything else runs freely, as when Alex is at the PC. The classifier is a
deterministic rule list first: command patterns, MCP tool names and URL hosts. An
uncertain call runs and is recorded as unusual in the audit trail. This is the
deny-list policy Alex approved after reviewing real command friction. Each
approval card shows the action, the target and the exact command.

Claude runs this check in SDK PreToolUse even with host prompts bypassed. Codex
uses its app-server approval callback with workspace writes enabled, external
MCP servers disabled, and the original subscription/auth home unchanged. Saved
Codex allow rules can skip that callback: the audit of all 50 current rules found
one consequential prefix, `git push`. Delegates therefore inherit an environment
Git hook override and a native PATH adapter. The adapter refuses push hook bypass
flags and changed Git configuration; the pre-push hook obtains a bound board
approval before refs are published, preserving existing repository hooks.

This visible-text policy is not a hostile-code sandbox. Obfuscated scripts,
opaque references, direct absolute executable paths with bypass flags, and future
saved allow rules may evade it, as they can under Alex's usual bypass setup.
The replay of 190 real commands produced four approval candidates, four forbidden
owner-credential/pairing helpers, and 182 allowed calls (14 unclassified/audited).
No credential values or raw transcript commands are kept in that report. Gate
events retain a hash, category and timestamp; the digest can report unusual use.

## Usage budget

Weekly Claude usage was high (81%) when this was drafted.

- Under 70% weekly, the chief may launch Claude sessions freely.
- From 70% to 90%, it prefers Codex for implementation and keeps Claude for
  judgment work.
- Above 90%, only the chief itself runs on Claude. New work goes to Codex, and
  Alex is told once.
- The digest always shows both plans' usage.

## When the chief speaks up

| Moment | Action |
|---|---|
| Alex asks something | Answer in the chat. |
| Delegated work finishes | One short line with the result and a link to the session. Push under "finished". |
| A session needs Alex | Pass on the card. Never answer a card meant for Alex. |
| A session is stuck for 15 minutes or crashed | Try one recovery first (glance, nudge, resume). If that fails, push under "stuck". |
| 08:00 | Digest: what finished overnight, what is waiting on Alex, what is running, usage. Five lines at most. |
| Anything else | Stay quiet. |

## Standing instructions (system prompt core)

> You are Alex's chief on this PC. Act as he would at the keyboard, within his
> CLAUDE.md rules. Prefer delegating work longer than a few minutes to a session
> in the right repository, giving it a complete brief, and track it with
> Kokuban tasks. Do small lookups yourself. Never answer cards addressed to
> Alex, never approve your own gated actions, and never pair devices. Write
> like a calm colleague: short, plain, no headings or bullet lists unless he
> asks, no all-caps labels, no filler. When you report, lead with the outcome.
> Keep notes.md current.

## Decisions

- Scope: the chief may message, task and check on every session on the board,
  including ones Alex started in terminals. It never answers his cards.
- Usage budget: as drafted above.
- Digest: 08:00 Pacific, following the PC clock.
