# Phone notifications and QR pairing (Phase 3)

The existing `/phone` tailnet gateway remains the only phone ingress. No public
port, Funnel route, separate phone backend, or new provider API key is introduced.
Beck's production phone UI is merged with these APIs. Its Settings screen uses
the real settings, usage, subscription and immediate/app-closed test endpoints.
The temporary notification panel has been removed.

## Pairing and local authority

In WinUI, choose **iPhones → Pair iPhone**. This explicit owner-local action
creates a five-minute QR. On the iPhone, scan it, tap **Pair**, add Kokuban to
the Home Screen, open that icon, and choose whether to enable notifications.
The PC sheet follows actual claim, standalone launch and completion milestones.
The server cannot observe the exact Add to Home Screen tap. Safari cannot open
the installed icon automatically. The guide supports compact and bottom toolbar
layouts and respects reduced motion.

The QR claim nonce and the installation handoff are different credentials.
Only hashes are saved. Claiming binds the setup to the verified owner login and
tailnet node; another node cannot finish it. The dynamic manifest has a stable
app identity and a temporary handoff in its start URL. Redemption is bounded by
the original expiry even after a device has been issued, and a retry creates no
second device. A valid device cookie bypasses an obsolete installed start URL.
There is no permanent bearer token in the manifest. See
[phone-pairing-feasibility.md](phone-pairing-feasibility.md) for iOS cookie limits.

New QR creation, cancellation and device revocation require a separate random
32-byte `phone.adminSecret`, read directly from local settings by the native
client/CLI. It is distinct from the Serve ingress proof and is never fetched over
HTTP. Ordinary agent/card approval cannot grant a new phone. Legacy code/card
pair-start and pair-state endpoints refuse; old Allow cards cannot issue tokens.
Closing an unfinished sheet cancels its setup. Closing a sheet after device
issuance preserves the paired phone; **Remove** is a separate confirmed action.

The local settings ACL was inspected: access inherits to SYSTEM, Administrators
and the owner's account. This retains the owner-process trust boundary: code running
as the owner can read local credentials. Two preexisting local trust gaps remain
outside this change: `/peer` accepts forged loopback identity headers, and native
card routes use the board's ordinary local app capability. Neither can replace
the new private phone-admin capability to create a QR. Cross-PC/native protocol
hardening needs a separate coordinated change.

## Delivery and privacy

VAPID keys are generated once and stored in Windows Credential Manager under
`kokuban/phone-vapid`, outside the credential-sync namespace. The private key is
never written to settings, logs, board snapshots or the phone. Web Push payloads
use the standard encrypted web-push transport. Subscriptions are authenticated,
device scoped, restricted to supported push providers, and pruned on 404/410.
Revocation stops further sends and authenticated streams.

Per-device `/phone/settings` controls blocked, finished, stuck and morning digest
notifications. All default on; the digest defaults to 08:00 in this PC's local
time. The digest is recorded once per device/day. Sources are owner questions,
completed tasks, blocked/quiet/continuation-limited sessions, and managed
conversation approvals, completed turns and connection failures. Existing items
are seeded on first activation so startup does not flood the phone.

Messages carry an agent name and a short question/result summary (at most 120
characters). Tool/file/vault bodies are not notification sources. Credential-shaped
text is replaced with a generic summary, and URLs become `[link]`. Deep links
select the exact conversation, session, card or task. A category is coalesced for
20 seconds per device, with bounded queues. Resolved cards/approvals are removed
before delivery. A card is observed once across restarts.

Visible foreground presence expires after 45 seconds and suppresses only matching
targets observed at or after the event. Background tabs do not suppress delivery.
Digest suppression requires the visible board. Test pushes deliberately bypass
foreground suppression. The app-closed test queues a push 20 seconds later.

The durable ledger is `%LOCALAPPDATA%/kokuban/phone-notifications.json`. It stores
bounded observation keys, queued jobs and the latest 100 delivery receipts. Failed
dispatches retry up to six times over at most one hour, with bounded exponential
delay and a stable notification identity/tag across restarts. An interrupted send
can be retried; that tag lets the phone replace a duplicate. Provider acceptance
is distinct from the service worker's authenticated `received` callback. A receipt
does not prove the person saw or tapped a notification. Provider errors are not
logged because they can contain subscription credentials.

The service worker caches no transcript or uploaded file. Notification clicks
accept only same-origin `/phone/` destinations. Notification permission is
requested directly from the person's button gesture in the installed app.

## Events, usage and settings cache

`/phone/events` retains the existing feed invalidation and adds named
`conversation` hints with `{sessionId}`. Hints coalesce for 100 ms, are bounded,
and carry no token text. The phone fetches canonical conversation history;
the eight-second fallback remains useful for reconnects and remote providers.

Settings reads use an in-memory snapshot. Local edits and directory `fs.watch`
invalidate it; edits reload synchronously to avoid overwriting a recent external
change. SSE heartbeats do not read settings from disk on every connection.

`GET /phone/usage` caches the public Claude SDK usage probe for five minutes and
deduplicates concurrent requests. It opens a bounded no-prompt/no-tool/no-MCP,
nonpersisted query. It refuses API-key/base-URL environments. Missing plan data
is explicitly unavailable. Session token totals use cumulative provider reports,
overwriting rather than summing repeated totals. They do not estimate plan use.

## Validation record

- Node suite after merging the phone UI: 238 passed, zero failed (2026-10-20).
- Native core: 56 passed, one optional live-board test skipped, zero failed.
- QR tests cover hash-only proofs, node binding, lost-response retries, expiry,
  cancellation, revocation, and refusal of legacy/admin-less pairing.
- Notification tests cover sources, truncation/redaction, coalescing, toggles,
  presence, restart persistence, transient retries, pruning and digest timing.
- A real SDK probe returned plan windows; the stored VAPID public key was checked
  against the private key without printing either key.

The restart hold was lifted. Phase 3 is commit `a618fdb`;
phone UI `ac04773` was merged as `0ea8c4f`. One announced restart activated it.
The backup is `%LOCALAPPDATA%/kokuban/activation-backups/phone-1792525141826`.
The real tailnet HTTPS `/phone/app.js` and `/phone/sw.js` each returned 200 and
byte-matched the merged client and push worker. Unpaired `/phone/` redirects to
pairing; direct loopback returns 403. Existing device IDs, token hashes and
revocation state matched the pre-restart backup, including My iPhone on
`my-phone.example-tailnet.ts.net`. No re-pairing was required or performed.

Consolidated card 16 asks for the immediate notification, 20-second app-closed
notification and tap-to-reopen checks. Real iPhone delivery remains pending;
HTTP provider acceptance alone must not be reported as the person's receipt.
The native sheet visual recheck is explicitly deferred and does not block using
the phone app. Beck owns removal of his temporary `/phone-ui` preview.
