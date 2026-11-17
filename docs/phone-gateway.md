# Phone gateway (Phase 2)

This records the Phase 2 implementation and evidence. Phase 3 replaces new-device
code/card pairing with the owner-local QR flow and enables notification delivery;
see [phone-notifications.md](phone-notifications.md). Existing paired devices and
their history remain valid. The legacy pairing endpoints no longer grant access.

The functional PWA lives at `https://<this-PC-tailnet-name>/phone/`. It uses the
same feed/card actions and host-authoritative conversation service as WinUI.
This is a replaceable test shell; the selected phone design is a separate step.

## Enable and pair

After building and an authorized board restart, run `kokuban phone enable`.
It records this PC's Tailscale owner login and HTTPS origin, generates a 32-byte
random ingress secret and repairs only the HTTPS 443 `/phone` Serve entry.
Startup repeats that idempotent repair. Existing `/peer`, other Serve routes and
Funnel settings are not reset. Existing Funnel exposure causes setup to refuse
rather than turning the phone gateway public. The board still binds loopback.

Open the phone link with Tailscale connected. Enter a recognizable device name
and request pairing. Compare the six-digit code with the PC's Phone pairing card,
then choose Allow or Refuse. Requests expire in ten minutes. Both verified owner
identity and the random pending-cookie proof must match to finish pairing.
Allow alone does not reveal a token in the card or feed.

`kokuban phone list` lists device IDs, names, tailnet nodes and revocation state.
`kokuban phone revoke <device-id>` immediately refuses later requests, removes
that device's push subscription and closes its SSE streams within a second.
It preserves the device audit record and conversation history. This phase uses
the CLI instead of a new WinUI device-management screen.

Device tokens are 32-byte values in a Secure, HttpOnly, SameSite=Strict cookie
scoped to `/phone`; settings contain only hashes. A ten-minute pending pairing
can retry a lost token-issuance response without creating another device.
Pairing initiation is bounded per node and globally; active devices are capped.
Settings updates preserve all unrelated keys and fail closed on unreadable JSON.

## Requests and storage

The phone routes provide feed, card/task actions, conversation catalog/launch,
list/get/history/events/detail, send and lifecycle/approval commands, a separate
SSE invalidation stream, raw binary upload and authenticated download. Mutations
require a custom `X-Kokuban-Phone: 1` header and the configured HTTPS Origin.
All routes require verified ingress and owner identity. Only pairing and static
bootstrap resources are available before device authentication. No transcript,
token or file is cached by the service worker. The client keeps an immutable
unconfirmed conversation command for retry in session storage.

Uploads are limited to 10 MiB per file, 100 files/250 MiB per conversation,
and ten selected attachments per Send (images total at most 10 MiB per message,
so base64 inputs fit the provider frame budget). Upload only saves the file and its durable
history entry; it does not start an agent turn. Send resolves uploaded IDs on the
host. Raster PNG/JPEG/GIF/WebP signatures become Claude image blocks or Codex
`localImage` inputs; ordinary files and unsupported image formats are described
with a host-local path the agent can open. No caller-supplied executable or file
path is accepted. Downloads are attachments with inert MIME and nosniff.

Files live at `%LOCALAPPDATA%/kokuban/conversation-files/<session UUID>/<file UUID>`.
Schema 2 adds an attachment metadata index in the same transaction as the event;
schema 1 upgrades additively without rewriting old history. Older schema-1-only
boards refuse this database. The SQLite backup utility accepts schema 1 and 2.
**A database backup does not include uploaded bytes:** preserve the entire
`conversation-files` directory alongside the consistent SQLite backup. There is
no automatic deletion or production restore command. Files remain with history.

Uploads currently target conversations on this PC. Existing conversation text
and controls can still relay to work-trusted paired PCs. Push subscriptions may
be stored per device, but the Phase 2 endpoint explicitly reports delivery off;
VAPID, notification settings and delivery belong to Phase 3.

## Identity boundary and follow-up

Tailscale Serve replaces identity headers, and the gateway checks the final
forwarded IP using local `tailscale whois`, matching both the asserted login and
the configured owner. Serve alone cannot authenticate its plain HTTP connection
to a loopback backend. Its target therefore includes a private, random gateway
path, compared in constant time. Public URLs never contain this secret. The
backend does not log request URLs or expose the path, secret, device hashes or
push credentials in board snapshots, feeds, errors or browser responses.

This blocks browser-originated and other-OS-user loopback requests that forge
Serve headers but cannot read the owner's settings. It does not defend against
a malicious process running as the owner, which can read those settings and
already controls the board. Protect local settings and Serve configuration with
the owner's existing OS account boundary. A paired device remains a second
factor even with correct owner identity and ingress.

**Follow-up, done (D97):** `/peer` now has the same boundary. Its Serve entry
forwards to `/peer/_ingress/<peerIngress>` and a direct loopback `/peer` call is
refused before identity or trust is checked. Calling boards are unchanged; a
board repoints an existing `/peer` Serve entry at startup. The local `/bridge`
compatibility route no longer takes a PC's identity from the request body: a
local caller is this PC, and a relayed foreign PC needs the `x-kokuban-relay`
header carrying the same `peerIngress` value.

Host approval policy is unchanged. On a bypass/never host, allowed tools do not
raise provider callbacks. Consequential chief actions require the separate
Phase 4 gate described in the phone/chief plan.
