# Cross-PC kokuban (v5): boards that talk to each other

Status: current source contract, 2026-10-16. Direct /peer replaces v4 transport.
The outgoing desktop-tool fallback is removed. Local /bridge remains temporarily
for existing desktop-tool callers; it is not the cross-PC transport.

## Why

Hand-offs between Alex and Sam still go through Discord by hand: mostly agent output passed
along, decisions and approvals, and files. Agents on one PC cannot reach the others well enough to
replace that. Reading another PC's board through the desktop tool measured 1.9 to 2.5 s per call
(2026-10-16), against a 0.12 to 0.15 s tailnet ping, because each call opens and initialises a
fresh MCP session on the far side. It also needs the desktop tool running and up to date on both PCs.

The longer aim: a neutral harness for a team's agents, Claude, Codex, local open-source models,
across the team's own machines over a private network, with hands on real desktops through
the desktop tool. Neutrality and hands are what the model vendors will not build; work staying on the
network is what makes a company say yes.

First users: Alex and Sam. Success: a week with no hand-off messages in Discord.

## Implementation and planned work

1. **The base** (one session, first): board-to-board transport, identity, trust, one envelope
   format, feed sharing. Target: under 0.5 s per hop.
2. **On the base, in parallel worktrees:**
   - A. Planned: packages to a person + project, held while the PC is off. Explicit tasks to an exact session already exist.
   - B. Built: the native feed merges cards, exact-session tasks and session state. General packages remain planned.
   - C. Built: `ask` cards use /peer; attachments use direct Taildrop.
   - D. `pc share` servers discoverable through the board.
3. A week of real use, graded by Alex, decides what comes next.

## The base

- **Transport.** Each board keeps 127.0.0.1:47600 for its own sessions. `tailscale serve` exposes
  only `/peer` to the tailnet on HTTP port 47600. A board calls another board's `/peer` directly: one HTTP request per operation, no MCP session.
- **Identity.** The receiving board identifies the caller from Tailscale Serve's identity headers,
  checked against `tailscale whois` for the forwarded address (the check the desktop tool does in
  `harness/device_bridge.py` today). The full tailnet name is the identity; nothing in the request
  body is trusted for it. No identity means refused. Serve's hop to 127.0.0.1 is plain HTTP that any
  local program could imitate, so Serve forwards `/peer` to `/peer/_ingress/<secret>` (settings.json
  `peerIngress`) and the board believes the identity headers only on that path (D97).
- **Local /bridge.** It never takes a PC name from the body on a local program's word. With no
  proof the caller is this PC: it may name this PC (full or short tailnet name, or host name) or
  nobody, and gets share level, never work; any other PC name is 403. A local relay that has
  verified a remote PC itself (the desktop tool `device_bridge.py`) sends `x-kokuban-relay:
  <peerIngress>`; only then is `from.pc` that PC, and its trust list entry decides (D97).
- **Trust,** decided by the receiving PC, in kokuban's `settings.json`, by full tailnet name.
  Not mutual: each PC sets what it lets in. A PC not listed gets nothing.

  | Level | Allows |
  | --- | --- |
  | talk | Session list with one-line summaries; messages, marked as a peer's request to weigh. |
  | share | talk + glance (shows latest prompts), ask cards, task metadata, the merged feed and update bundles. General packages/files are planned. |
  | work | share + vault access; remote requests may start work by themselves and count as the human's own work. Deleting, deploying, paying, publishing and sending outside the network still stop and ask. |

  ```json
  { "trust": { "pc-b.example-tailnet.ts.net": "work", "keeper-pc.example-tailnet.ts.net": "work" } }
  ```

  Project-scoped trust is not implemented; object entries currently supply only their level.
- **Envelope.** The wire shape is `{v, envelope, op, me, to, to_id, text, request_id, id, sent_at}`.
  `envelope` identifies a request; `id` is an operation-specific card/message/task id.
  The sender PC comes from verified Tailscale identity, never a body-supplied `from`.
  Mutating envelopes are deduplicated; keyed asks and task outboxes add durable retry semantics.
- **Feed sharing.** Boards pull `/peer` op `state` for current cards, tasks, sessions,
  running work and history. Changes poke paired boards; a minute pull is the backstop.
  The append-only cross-PC event log also exposes a cursor through op `feed`.
- **Any agent.** Joining the board is the MCP tools plus a small documented set of hook events,
  so agents other than Claude and Codex can join as equals.

## Hand-offs (A, planned)

The person-plus-project packages below are not implemented. Current task ownership
is an exact session and has a durable metadata outbox, not a package mailbox.

- **Address:** a person + project, e.g. `Sam, example-org/acme`. It goes to a live session of
  that person's in that repo on any of their PCs. With none live, it waits, and the next session
  that opens in that repo receives it at its start. Projects match by git remote, not folder name.
  People map to PCs in `settings.json` (`people`). Session addressing (`Iris@pc-b`) stays for
  live back-and-forth.
- **Package:** result text, attached files, optionally a decision for the person, optionally a
  git commit reference. Code never travels as files: push and send the commit.
- **PC off:** the sending board holds the package, files included, and delivers it when the
  receiver is back. The feed shows it as waiting. A package older than a few hours does not start
  work by itself: it waits in the inbox and the feed for a person's go. Packages expire after
  7 days unless resent. No relay PC.
- **Needs (later):** a hand-off may state what it needs (GPU memory, a signed-in Chrome) instead
  of a PC, and the board picks a machine using the desktop tool's capacity checks.

## Files (planned)

The general resumable file protocol below is not implemented. Current card files
use Taildrop; code updates use git bundles over /peer.

- Streamed board to board into `%LOCALAPPDATA%\kokuban\packages\<id>\`, in resumable chunks,
  each file verified by SHA-256. The receiving agent is given the exact paths.
- Size cap is a setting, `max_package_gb` in `settings.json`, default 2. The receiver checks
  free disk before accepting.
- Received files are kept 30 days. The sender keeps its copy until delivery is confirmed.

## The feed (B)

One page on each board showing every cross-PC package, decision and task status across the PCs
it shares the feed with, newest first, flagging anything blocked for over 30 minutes. Shown in
Japanese for Sam. No Discord mirror. It doubles as the audit log a company admin will ask for.

Design grill:

1. **The job is "what needs me", a quick check.** Not an audit log first. The top of the page is
   what waits on a person; history is secondary.
2. **Shared and live.** Alex and Sam each see the same feed in real time.
3. **Your own items first.** The top strip shows what waits on the person viewing it; what waits
   on the other person is a smaller line under it ("2 waiting on Sam"). History is the same
   for both.
4. **What goes in the strip:** decisions and approvals for you, packages waiting for your go,
   anything blocked over 30 minutes, tasks unaccepted after 30 minutes, and finished results you
   have not seen. Many kinds are fine; many items are not. The strip stays short, and every item
   can be dismissed.
5. **Clearing an item means doing it, in the strip.** Answer the question, give the go, and it is
   done, without opening anything else. A finished result clears when seen. Anything still waiting
   on you also has "later": it leaves the strip for 2 hours, or until something new happens on it,
   and never disappears silently. One item per hand-off, not per event; about 5 shown, the rest
   as "+N more".
6. **Where it lives: the native Kokuban app.** A glass pill brings up cards; the
   window holds the feed and history. Every PC runs the app. Browser pages, Electron
   windows and Windows toasts are retired; no duplicate UI fallback is retained.
7. **Direction: restrained native design.** The approved combined reference is
   `docs/feed-mockup-v2.html`; the earlier five mockups were retired.
8. **Chosen: Island (2) as the front door, Window (5) behind it.** The pill shows what waits; a
   click grows it into one card at a time to act on; from there you step into the three-pane
   window for the whole thread, files and history. The window replaces the browser page as the
   place for depth.
9. **The pill shows only while something waits on you.** It appears when an item lands in your
   strip and leaves when you have cleared them. The native app owns its tray/background lifetime.
   A hotkey and the tray bring up the pill or the window any time. Running work is seen in the
   window, not by keeping the pill up. (An always-visible pill was tempting; revisit after the
   week of use.)
10. **The pill sits at the top centre.** It fades nearly clear and lets clicks through when the
    pointer comes near anywhere but the pill itself, so it never blocks a tab strip. Fallback if
    it still gets in the way during the week: bottom centre above the taskbar.
11. **The pill shows on the monitor the pointer is on**, never the AI desktop, and stays put once
    shown. **Hotkey Ctrl+Alt+K**: once for the pill, twice for the window; changeable in settings.
    Not Ctrl+Space, which switches the input method on Japanese keyboards.
12. **The window is all of kokuban, not only the feed.** Sidebar: For you, Waiting on Sam,
    Running, History, then Sessions grouped by PC (every agent on every paired PC, what it is
    doing, its status and holds; selecting one shows what glance shows). The native app
    is required; there is no browser fallback.
13. **The combined mockup is the design** (settled in review):
    `docs/feed-mockup-v2.html` is the reference for the pill, the card flow and the window.
14. **Sessions are listed by project, not by name.** Many agents run at once, so the window's
    Sessions section shows one row per project (matched across PCs by git remote) with a count
    and status dots; it opens as a dropdown to the agents in it, each tagged with its PC and
    person. Under the hood this needs, from step 1 of the build: each session's git remote read
    from .git/config (today `where` is the folder name and branch), the session list of every
    paired PC kept live on each board (today another PC's list is fetched on demand through
    `/peer op=peers`), and each session tied to its person through `people`.

15. **A fully native Windows app replaces the Electron window** : WinUI 3 on
    .NET 10, the board behind it. Build/check flags are in `docs/setup.md`.

### Current implementation

The feed is `src/feed.ts` plus the keyed native API in `src/app-routes.ts`.
The WinUI app in `app-windows/` owns the pill, window, tray and Ctrl+Alt+K.
`docs/feed-mockup-v2.html` remains the design reference. Source changes need
an approved board restart before they become active on a PC; historical Electron
memory measurements are not evidence for the current native build.

### Feed event schema (draft, 2026-10-16)

**Not implemented.** What the feed shows today comes from question cards (the `ask` tool) and
cross-PC tasks, made fresh by `src/feed.ts`; a decision for a person is an `ask` card, and its
answer is read with `ask` op "status". The table below is a direction, not an API.

Extends `FeedEvent` in src/peer.ts. Events stay append-only; the feed groups them into one item
per `thread`, and the item's kind, state and text are those of its latest event.

| Field | Type | Meaning |
| --- | --- | --- |
| `seq`, `ts`, `dir`, `pc`, `agent`, `op` | as today | Unchanged. |
| `thread` | string | Groups events into one item. A task or package id; a shared workspace uses `<workspace>:<decision>`. Missing on old events: each is its own item. |
| `to_person` | string[] | People the item waits on (`people` names in settings.json). Empty: nobody, so it never reaches a strip. A conflict between people lists all of them. |
| `kind` | `decide` \| `go` \| `blocked` \| `done` | What the person does: answer, give the go, unblock, or look. No other kinds. |
| `state` | `open` \| `answered` \| `later` \| `cleared` \| `expired` | `open` items are in the strip of everyone in `to_person`. `later` carries `until` (ms). |
| `misaligned` | boolean? | Alex and Sam disagree; the pill and window mark it. Only with `kind: decide`. |
| `title` | `{en, ja?}` | One line, at most about 80 characters. |
| `body` | `{en, ja?}`? | One or two sentences. |
| `choices` | `{id, en, ja?}[]`? | Action labels; the first is the main action. A reply box is implied for `blocked`. |
| `answer` | `{by, choice?, text?}`? | On the event that answers or clears the item. |
| `evidence` | `{path?, commit?, url?, label}[]`? | Files by path, code by commit, never inline content. |
| `project` | string? | Git remote, e.g. `example-org/acme`. |

A missing `ja` is translated by the board before it reaches a person who reads Japanese. The
existing `text` field stays for old readers and carries `title.en`.

## Status

The base is built (src/peer.ts): /peer with Tailscale-verified identity and trust levels,
`remote` going directly board to board, "work" trust waking a session as
its human's own work, and the feed's append-only log with a cursor. Measured on real Tailscale
Serve, PC to itself: 5 to 43 ms a call. Rolled out on 2026-10-17 (JST) to pc-a, pc-b and
keeper-pc, all three at "work" to each other plus Alex's laptops. Measured board to board: pc-b and
keeper-pc 8 to 13 ms either way; either of them and pc-a about 0.3 s (the tailnet ping alone
is 132 ms, so a call is about two round trips; keeping connections open would bring it near one).

## Pairing

`kokuban pair <pc>` replaces hand-written trust lists and `tailscale serve` lines (src/pair.ts).
The asking board exposes its own /peer, then sends `/peer` op `pair` with a random id, the level
and its person's name. That op and `paired` are the only two a PC outside the trust list may
send: `pair` only makes a card for the person (one open per PC, none for an hour after a refusal),
`paired` is taken only with the id of a pairing this board started with that same PC. On Allow
the asked board trusts the asker, notes the person's PC under `people`, and sends `paired`; the
asker trusts back. An asker that cannot be reached is told by the minute sweep for 12 hours. A
pick on a pairing card is acted on by the board itself, never mailed to a session, and a card
counts as a pairing card only when the board's own pairing record names it.

`kokuban pair` alone sends `hello` (needs talk) to every PC in the trust list and prints one line
each: answering or not, milliseconds, its kokuban commit against this one, and whether it trusts
this PC back. That is the status check: a refusal, an unreachable board or an older build shows
there instead of surfacing later as an unexplained transport error. A refused `/peer` request now names the
command that fixes it (`kokuban pair <that PC>`).

## Updates (D, the code half)

`kokuban update` and `kokuban update <pc>` (src/update.ts). `hello` reports each repository's
`main` (commit, time, subject); `code` (needs share) answers with a git bundle of `main`, only
from the commit the asker names when that is an ancestor, nothing when it already has it. Getting:
each repository from the paired PC whose `main` is newest. Offering: the receiver's person gets
a card listing the incoming commit subjects; Install runs the same getting from the offering PC.
Applying is in the receiver's hands (see setup.md), and every step that finds something
unexpected leaves that repository as it was. The board restarts itself through its logon entry
with `KOKUBAN_WAIT_PORT`, so the new process waits for the port instead of bowing out.
A PC that is not running kokuban yet gets it by Taildrop when `kokuban pair` cannot reach it,
with the prompt for its agent.

## Open

- In scope now: three PCs only. pc-a (Alex), pc-b (Sam)
  and keeper-pc (the neutral worker PC, "desktop"). All three give each other "work". Other tailnet
  PCs (Jun, Ken, ...) come later.
- Monetization: deliberately deferred.
