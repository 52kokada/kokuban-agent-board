# Token efficiency

Kokuban should spend model turns on decisions and work. Transport polling and quiet hooks do not themselves require a model turn. Characters, repeated input tokens, cached input tokens and billed cost are different measurements.

## Delivery

Use `send(delivery="next-step")` for information that needs no immediate action. It remains in the inbox and is offered at the next natural hook or explicit inbox read. It neither wakes an idle session nor extends Stop. Broadcasts also wait for a natural step.

Use `send(delivery="batch")` for routine actionable coordination. The first pending batch anchors a two-second collection window; subsequent messages cannot slide it indefinitely. One daemon timer dispatches due batches; Claude's existing held hook also checks them. Natural reads can deliver a batch sooner. An immediate message flushes pending actionable batch mail to that recipient.

Use `send(delivery="immediate")` for urgent blockers. Omitted delivery preserves the old immediate behavior. Task offers, completion, blockers, cancellations, overdue task notices and human card answers retain immediate eligibility. Pause, freshness, continuation, trust and remote resource gates remain in place. Existing sender/recipient metadata and delivery confirmation are preserved.

An explicit immediate resend of matching unread informational/batch mail promotes the existing message instead of creating a duplicate. It refreshes wake eligibility while retaining the original sent timestamp. Legacy resends and already offered or confirmed messages remain deduplicated.

The modes above apply to local `send`. The remote protocol is unchanged; cross-PC sends retain their existing behavior. No text classifier guesses whether a message is informational or urgent.

## Read less context

Task writes now return compact acknowledgements without echoing the submitted brief,
detail or history. `status(id)` returns full evidence; `compact=false` preserves
full write replies. Glance validation errors point to discovery without printing
the roster or marking it as seen.

Explicit receipts can accompany any useful public board call through `ack`.
Never make a receipt-only call. Observed parent PostToolUse hooks suppress redundant
receipt hints; missing confirmation still retries after 90 seconds and restores
the explicit fallback. Invalid or foreign receipt batches confirm nothing.

For repeated `block` updates, an explicit stable `blocker_key` keeps the updated
record and next-step notice without a fresh wake once the initial blocker has
been received. A changed key, `urgent=true`, and legacy calls without keys retain
actionable wakes. Replacing an unreceived notice preserves its wake eligibility.
Remote notice metadata is attached before dispatch so callbacks see the correct
task revision and delivery mode.

When a paused session resumes or returns after 30 minutes away, ordinary
informational mail older than 30 minutes stays unread behind a count. Use
`inbox(include_deferred=true)` to retrieve its intact bodies. Task, human and
actionable mail is exempt. This limits new injection; it cannot erase text
already held in a harness's conversation context.

`task(op="list")` defaults to compact open tasks, including blocked work, in pages of 20 (maximum 50). Follow `next_offset` until null. Use `scope="all"` for completed/cancelled history, and `status(id)` for full evidence, replies and delivery errors. Summary fields explicitly mark truncation. Explicit `compact=false` returns the full historical array for compatibility. Stored task text is never truncated or migrated.

When discovering tools, first filter tool names and print names only, then read the selected definitions. Do not print `ALL_TOOLS` or every matching description. MCP still exposes its full schema as required; this change does not claim to remove schemas from the host's internal prompt.

Session onboarding is shorter and versioned. Essential authorization, remote access, task ownership, cancellation, pause and outcome rules remain. Existing sessions receive only the new efficiency guidance once; full procedures also remain in tool definitions and project documentation.

## Measure before claiming savings

Run `node scripts/token-audit.mjs 7` for a read-only streaming report over the retained usage log. An optional second argument selects a different log file. It reports activity counts, measured response characters, delivery modes, wake reasons and task outcome transitions. It stores no report and does not read credentials or conversation text.

New tool-call telemetry records input/output character counts and duration; nonempty hook telemetry records context size. Wake telemetry records batch size, message IDs, oldest age and reason categories. Task transitions include owner/requester names. No new prompt, message or evidence content is logged. Quiet hooks add no log entry.

Historical records lack some fields; the report shows measurement coverage. Hook output from an MCP hook may appear in both tool and hook categories, so their sum is instrumentation volume, not unique context. Wake success means transport accepted delivery, not that useful work completed. Task outcomes are transitions, not unique task totals. Actual model cost and usefulness still require transcript/provider usage and review; do not multiply characters by a guessed token price or claim a measured savings percentage from these counts.

## Regression checks

`tests/token-efficiency.test.ts` covers informational Stop behavior and natural receipt, fixed/restart-safe batch deadlines, urgent flushing/escalation, scheduler dispatch, task/card bypasses, existing wake gates, bounded task history, full evidence preservation, telemetry privacy, and onboarding rules. Existing board, delivery, task, Chief and host tests cover the surrounding contracts.

The shared recovery contract and bounded mail paths are covered by
`tests/context-recovery.test.ts`, `tests/context-delivery.test.ts` and
`tests/inbox-receipts.test.ts`. Run `npm run test:isolated` to verify all hosts
without rebuilding installed code or inheriting live communication-limit settings.
`tests/context-followups.test.ts` covers receipt piggybacking on all three hosts,
hook fallback, deferred retrieval, compact writes, keyed blockers and remote
dispatch ordering. Remote checks use an in-memory board, not a remote device.

## Harness tool loading

The follow-up Kimi snapshot contained 178 tools and 176,373 serialized schema
characters; its first measured input was 47,845 tokens. These are different
measurements, not a token attribution. The keeper PC desktop server is a separate
remote capability, not a duplicate local tool set. Do not disable it merely to
reduce the count, or reconnect another person's active session.

Kimi supports experimental deferred MCP definitions: `deferred: true` per server,
`KIMI_CODE_EXPERIMENTAL_TOOL_SELECT=1` (or `[experimental] tool-select = true`),
and a model with `dynamically_loaded_tools`. Keep Kokuban eager and defer larger
optional tool sets in a future-session pilot. A manifest remains visible and
`select_tools` loads full definitions on demand. Missing prerequisites fall back
to eager loading; settings are captured at connection time. This preserves
capability but does not eliminate connection overhead or retained tool results.
See the [official Kimi MCP documentation](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/mcp.md#loading-tools-on-demand).
No global profile or live-session tool configuration is changed by this rollout.
Compare initial input, successful tool discovery, failure/retry counts and
recovery behavior in a fresh pilot before changing the default.

## Initial local rollout audit (2026-11-01)

The first approximately 53 minutes after activation recorded 14 offered messages,
zero offer replays, six explicit message acknowledgements and no oversized
offers. Successful inbox reads had a maximum response of 2,591 characters;
hook output peaked at 2,770 characters. These are character counts from a small,
non-controlled workload, not measured model-token or cost savings. Native recovery
operations in this window were the rollout's own checks, not evidence of broad
agent adoption. Existing transcript-based stress cases remain important.

The audit found four rejected inbox reads from already-open Claude clients that
serialized the new `ack` argument as `"[id]"` or `"id"`. The compatibility decoder
now accepts those JSON representations while preserving positive-integer,
batch-size, prior-offer and session-ownership validation. Invalid strings remain
errors; no evaluation or implicit confirmation is used. Regression tests cover
the observed forms and invalid/cross-session receipts. One Kimi wake failed or
was busy; its recovery path retained unconfirmed mail rather than treating the
launch as delivery. Longer normal-use observation is still needed before
claiming a savings percentage or universal improvement.
