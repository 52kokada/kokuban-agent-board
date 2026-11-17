# Kokuban architecture

Modules in src/ and the daemon's HTTP routes. Commands are in package.json and docs/setup.md.

# Modules in src/

## Board core

- board.ts: sessions, mail, claims and snapshot persistence.
- names.ts: name pool; git.ts: repository/branch identity from git files.
- config.ts: port, URL and data paths.
- instance.ts: single-instance lock (named pipe + daemon.lock pid record), taken before any board work.
- mcp.ts: tools and JSON-RPC surface; cli.ts: local command entry point.
- daemon.ts: route dispatch and background timers.

## Delivery and wake

- hooks.ts: shared host lifecycle handling, guidance, mail confirmation and Stop checks.
- mail.ts: framing and defanging peer words on every delivery path.
- wake.ts: async Claude waiter, Codex queue, eligibility, session reaping.
- wake-hook.ts: one asyncRewake Stop command per Claude turn.
- kimi-console.ts: D130 visible Kimi wake, typing one line into the open Kimi window (tools/ConsoleInput).
- start-hook.ts: Claude SessionStart command, starting the board when down and replacing one that held the lock without answering for two minutes.
- stall-log.ts: writes blocked-event-loop and long-unanswered-request evidence to stalls.log in the data folder.
- glance.ts: read-only recent transcript steps.
- context.ts, retrieval.ts, discovery.ts: bounded native evidence search and recovery.
- checkpoint.ts, native-memory.ts, inbox.ts: explicit working state, opt-in native notes and inbox receipts.
- doing.ts: appended host titles, active tasks and cached Codex names.
- codex-title.ts: board name in Codex thread titles.
- terminal-badges.ts: opt-in Claude tab badges (settings terminalStatusBadges, D125) via tools/TerminalTitle.
- codex-rpc.ts: app-server proxy requests, thread state and MCP reload.

## Cards and native app

- cards.ts: card model, answers, closed history and durable keyed asks.
- ask.ts: person routing, card tool and direct Taildrop attachments.
- feed.ts: merged live view, local Seen/Later marks and shared history.
- app-routes.ts: keyed native app API, files, events and hello.
- app-update.ts: native app packages, checked downloads and installation.
- session-launch.ts: opt-in (settings `sessionLauncher`) human-clicked CLI start/exact resume, one-use
  60 s grants; never used by mail or wake. See docs/session-launch-port.md.

## Cross-PC

- peer.ts: direct /peer transport, Tailscale identity, trust and event log.
- pair.ts: pairing cards, trust lists, status and unpairing.
- bridge.ts: shared operation handlers, also used by the local compatibility route.
- tasks.ts: owned handoffs, revisions, reminders and durable delivery outbox.

## Know-how, vault, install and update

- know.ts: shared knowledge entries, marks, search and sync.
- vault.ts: credential sync through the local credential store, names-only records.
- vault-keeper.ts: shared Obsidian vault keeper (settings `vault`): the keeper's tick, and re-exports of
  the whole keeper API below so callers and dist consumers keep one import. See docs/vault-keeper.md.
- vault-store.ts: keeper settings and grouping, note files, front matter, keeper blocks, revisions, hidden index.
- vault-rulebook.ts: Rules.md, README.md and "How this works", every version built from versioned data
  (pinned byte for byte by tests/vault-rulebook-text.test.ts; a change is a new version).
- vault-spaces.ts: layout, spaces and Overviews, Homes, rulebook proposals.
- vault-write.ts: validateWrite/applyWrite and each kind's writer; vault-mask.ts: Credentials table and masking.
- vault-read.ts: readPage and client lookup; vault-checkup.ts: nightly check-up and Needs attention.
- vault-queue.ts: .keeper/queue outboxes; vault-transport.ts: forwarding over /peer `vault_write`, draining.
- vault-cockpit.ts: links to acme-cockpit; vault-tool.ts: `vault` tool and session vault lines;
  vault-heartbeat.ts: keeper heartbeat and status lines.
- vault-catchup.ts: D132 read-time catch-up: `catchup` op, log pages newest first (limit/before/since/offset), search with matching entries.
- text-cut.ts: cutting text on whole characters (code points), so a cut never leaves "�" in a note or answer.
- vault-projects.ts: a project space per repository (Projects/<repo>), seeded on first session (D91).
- vault-working-copies.ts: D131 each PC's git state per repository (Facts/working-copies), after agent git commands and hourly.
- vault-visuals.ts: D126 boards only where a business has clients, each Home's visuals (settings `visuals`), bases, graph group.
- vault-research.ts: D126 research notes (kind=research), the Research index and the Canvas research map.
- vault-credentials.ts: D99 one-shot export of the desktop tool's passwords to Credentials pages
  (the one-shot export script is not part of this repository).
- install.ts: hooks/MCP/logon setup and retired registry cleanup.
- update.ts: repository discovery, bundles, guarded updates and approved restart.

# Routes

- POST /mcp and /mcp/codex: MCP; /hook/claude: lifecycle events.
- POST /wait/claude: held async wake request.
- POST /peer: Tailscale-authenticated peer operations, exposed through Serve. Serve forwards
  it to /peer/_ingress/<settings peerIngress>; a direct loopback /peer is refused (D97).
- POST /bridge: local compatibility requests. A local caller is this PC (share level, never work)
  and may name only this PC; naming another PC needs the x-kokuban-relay header carrying
  settings peerIngress, and then that PC's trust entry decides. Otherwise 403 (D97).
- POST /pair, /update, /repair: local CLI operations.
- GET /app/key: local native-client contract and key.
- GET /app/feed.json?t= and /app/events?t=: keyed state and change stream.
- POST /app/act and /app/hello: keyed actions and native-client presence.
- GET /app/file?t=&thread=&n=: keyed attachment access.
- GET /app/native and /app/releases/<file>: local native app/update access.
- GET /app/open: retained compatibility URL lookup used by the C# client.
- GET /app/sessions?t=, POST /app/session-launch[/reset]: keyed launcher catalog and actions.
  POST /app/session-launch/claim|failed: the VS Code extension's one-use grant, no key, no Origin.
- /phone/*: phone PWA through the private Serve ingress, owner identity and paired
  device cookie. Direct loopback /phone requests are refused. See docs/phone-gateway.md.

There is no GET / roster, /cards list, /card browser page or GET /app page.
