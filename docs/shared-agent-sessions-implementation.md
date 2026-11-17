# Shared agent sessions: implementation status

2026-10-18 · The local update was explicitly authorized. Local native app 0.1.5 and the new board code are active; pc-b production remains unchanged.

## Implemented and exercised

- A host-authoritative conversation controller, durable command receipts, message queue, approval resolution, explicit Stop/Resume/Shutdown, held queues, recovery, and separate transcript events.
- SQLite WAL/FULL storage in a worker thread. Legacy board snapshots, cards, tasks, claims, and vault data are preserved.
- Installed Codex app-server and Claude Code adapters. Both completed a bounded real local text turn through the new contained process path using the existing local authentication.
- Both providers passed a real active-response Stop check. The queued second message remained held and the provider received only the first message.
- Windows Job containment from suspended process creation, kill-on-close, and supervisor-death handling. Tests cover argument quoting/Unicode, descendant shutdown, and parent death.
- Keyed native-client API, authenticated work-trusted cross-PC operations, one-hop-only requests, cursor history, bounded event pages, and separate retrieval for large tool details.
- Managed sessions bypass legacy wake/reaping so those paths cannot independently drive them. Name reservations are shared with legacy registration.
- Native DTOs/client and durable immutable retry outbox. Concept 01 was selected. The conversation list and detail now sit inside the board, with native pill controls, rounded selection surfaces, compact copy, expandable tools/queue, styled launch/confirmation dialogs, and compositor pane/disclosure transitions. Windows reduced-motion settings are honored.

The feature remains disabled by default in source. On the owner's PC, the approved activation sets KOKUBAN_CONVERSATIONS=1 in the existing user startup script. The installed app is 0.1.5; its DLL hash matches the verified publish. Local board tasks, cards and messages were retained and settings.json is byte-identical. Pre-activation board/settings/startup backups are under the local board's activation-backups/20261018-161926 directory.

## Local validation receipts

- Existing plus new Node suite: 206 passed, zero failures. See the current testing receipt for the final run.
- Native core tests: 46 passed, one optional live-board test skipped. Retry classification preserves unknown outcomes after authorization/routing failures as well as network/server failures; host-declared pre-commit busy refusals can be corrected immediately.
- Native application Release build: passed with zero warnings/errors after the embedded UI changes; repeat after any final packaging changes.
- Isolated native UI: launch, local invalid-name correction, old refused-request cleanup, transcript/tools, Stop, held queue, view detach/return, Resume, and shutdown confirmation exercised through the desktop tool. Light and dark screenshots inspected; dark run had reduced motion enabled. See `docs/mockups/shared-agents/native-review.md` for limits.
- Real local provider smoke: Claude and Codex each returned exactly `KOKUBAN_READY`.
- Real Stop test: both remained stopped, retained the second queued message, and recorded one provider send. The observed ~111 ms includes a 100 ms test polling interval and is not a production latency distribution.
- Real installed Claude and Codex on pc-b passed remote launch, Stop, held queue, Resume with context retention, and Shutdown. Actual tailnet tests also covered reverse launch, distinct participant attribution, competing approvals, trust downgrade/restoration and an outage with immutable retry. Owned test provider processes and temporary Serve routes were closed. Details and fixture corrections are in `docs/shared-agent-sessions-testing.md`.

Raw local-only results: `.kokuban/chat-e2e/runtime-results.json`, `.kokuban/chat-e2e/real-stop-results.json`, and `.kokuban/launch-investigation/*`. These contain test identifiers and are ignored by git. The original feasibility receipt remains a historical record of the earlier research phase.

## Build and configuration

`npm run build:managed` compiles TypeScript and builds `assets/agent-host/AgentHost.exe` with .NET 10. `npm run build` remains the existing lightweight TypeScript build. The generated native process host is included in npm asset packaging but is not checked in; a git-bundle rollout must build it on the receiving PC before activation.

Managed conversations require Node 24 or newer. Set `KOKUBAN_CONVERSATIONS=1` only for an approved activation/restart. `KOKUBAN_PROJECT_ROOTS` optionally sets the host-local catalog roots using the OS path-list separator. The default is the owner's `~/githubprojects`; only immediate real directories within those roots are offered. The API never accepts an executable, shell command, environment override, or arbitrary working-directory path from the viewer.

The SDK is pinned to 0.3.302 and points at the owner's installed Claude executable. Its public interrupt wire request supports `cancel_queued`, while the public SDK convenience method currently omits that field. A small transport adapter adds it, and startup probes the interrupt receipt for explicit cancellation support before accepting a user message. It does not access SDK private object fields. Older/incompatible binaries fail startup rather than silently permitting queued work after Stop.

## Review and release gates still open

1. Broaden native reconnect/retry QA against real two-PC failures. API outage/retry, native draft preservation and bounded long-history model tests pass; a combined native remote outage walkthrough remains useful.
2. Review the embedded implementation at ordinary window sizes, keyboard-only navigation, high contrast, and screen-reader expanded/collapsed announcements. The mockup is a design reference; it is not proof of native accessibility or animation quality.
3. Improve structured questions/MCP form input beyond the present conservative fallback. The adapters do not invent answers; unsupported structured input is declined and redirected to ordinary conversation.
4. Real local tool approvals and live-shell interruption pass. Full hook/skill/MCP parity and scheduled/internal continuation remain to review; legacy peer mail to idle managed sessions needs routing or a visible refusal.
5. Actual tailnet identity/trust/control/network and real remote provider tests pass on isolated hosts. Real PC sleep/wake and a second-PC native viewer walkthrough remain untested; neither person's active PC was put to sleep.
6. Exercise the SQLite-aware backup utility under a long resource/launch-shutdown soak before release. It uses the online backup API, verifies integrity, includes committed WAL state, and refuses an existing output. Automatic restore/migration of production data is not implemented.
7. Review shutdown/recovery failure handling, catalog and stream limits, and native pending-operation UX against the research plan.

Runtime restart, software rollout, and enabling this on Sam's PC require the owner's explicit instruction after the build is concrete and reviewed. A successful local build does not activate it.

## Consistent backup

After building, run `node scripts/backup-conversations.mjs [source.sqlite] [new-backup.sqlite]`. Defaults use the local board's conversation database and a dated file in its `backups` directory. The command opens the source read-only, pins a SQLite read snapshot, includes committed WAL data, verifies the result, and prints its size and SHA-256. It never replaces an existing output. Backups can contain private conversation/tool history; they stay local unless deliberately transferred. Restore into a scratch directory for verification first; this utility does not replace a running board's database.
