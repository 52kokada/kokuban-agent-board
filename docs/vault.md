# Shared credential vault: build spec (decided 2026-10-16)

Every work account should be usable by Alex's and Sam's agents on any of their PCs, without a
password ever passing through a model, chat, memory, the know-how pool or the feed. Decisions and
evidence: [mesh-decisions.md](mesh-decisions.md) section B. Build exactly this.

## What exists

the desktop tool's vault (`harness/passwords.py`): Windows Credential Manager entries named
`computeruse/<site>/<account>`. Agents only ever see names; a field is filled with
`{secret:<name>}`, which the browser tool reads from the vault itself. Each PC's vault is separate.

## Sync

- Everything under `computeruse/` syncs between paired PCs, both ways, only between PCs that trust
  each other at **work** (the receiving board checks the caller's level, as for every `/peer` op).
- Newest wins: each entry carries the time it was last written (keep it in the credential's own
  metadata, e.g. its comment or an attribute, since Windows does not let you set LastWritten).
  Import rechecks the local time immediately before every write/delete; removals carry
  `{name, written}`. Equal/older operations are skipped; booleans and times over a day ahead are refused.
  Stamped entries edited outside the desktop tool (Credential Manager UI, cmdkey) keep the old stamp and do not sync.
  Malformed stamps skip only that entry and count in usage; a skipped entry is never inferred removed.
- A removal travels too: the board keeps a tombstone (name, time) for 90 days, so a password
  removed or rotated on one PC is removed or replaced everywhere.
  `harness.passwords remove` appends name/time to `vault-tombstones.jsonl` beside settings, even
  while the board is down; the board consumes it next round. UI removals use index comparison;
  an entry added and removed between polls was never shared and needs no propagation.
- The board asks its work-trusted PCs for their vault index (names, account names, write times,
  tombstones, never secrets) every few minutes, then fetches only the entries it needs. Secrets
  travel only inside the tailnet (WireGuard-encrypted), only in those fetch replies.
- kokuban is Node and Credential Manager is reached from the desktop tool's Python: add `export` and
  `import` commands to `python -m harness.passwords` that pass entries as JSON over stdin/stdout,
  never as arguments or files. The board runs them with the desktop tool's `.venv` Python.
- Never written anywhere else: not to logs, usage, the feed, board.json, temp files or errors. The
  feed shows only "vault: N entries updated from <pc>".
  A partial import returns applied/failed names and a retryable flag, with no exception text;
  the board refreshes after the batch so subsequent rounds retry only what remains.
- If a round would remove more than three entries, hold the removals and show one names-only
  card on this PC: Apply the removals / Keep the entries. Apply is required; Keep rejects those
  exact removal times. The pending review survives a board restart.

## One-time cleanup of passwords in agent memory

The know-how analysis found about 24 memory items holding passwords, keys or other secrets as
plain text (both PCs; list in this session's analysis, class f). For each PC:

1. List them, **names only** (file, site, account, kind): never a value. Rook shows Alex this
   list before anything moves.
   The plan records its memory root and a hash of its names-only items. `--apply` requires the
   exact reviewed `--plan-hash`; paths must resolve inside that root. Unresolved names stop cleanup.
2. For each item: add the secret to the vault under `computeruse/<site>/<account>` by script (the
   value goes from file to vault without being printed or passed to a model), then replace it in the
   memory text with `in the vault: computeruse/<site>/<account>`. Things that are not sign-in
   passwords (API keys, channel secrets, bank details) go under `computeruse/<service>/<label>`.
3. Verify each vault entry reads back, then remove any backup copy holding the plain text.
   Replace only the matched value at its recorded position, once. Detection is label-based,
   without filename rules or a generic long-token rule; obvious placeholders/numbers are excluded.

## Known issue to fix first

keeper-pc's desktop-tool `.venv` points at a Python that is no longer there (uv's cpython-3.11 under
AppData\Roaming), at least as seen over SSH. The vault sync runs that Python, so repair the venv
there (recreate it from scripts/install.ps1) before relying on it.

For this build, report the missing keeper-pc Python; do not repair it or run remote cleanup.
Cleanup first produces the names-only list on Alex's PC. No secret moves before Alex sees it.
This build is Windows Credential Manager only. A peer without that backend is skipped, fails
closed and is logged to usage only; Mac vault support is outside this build.

## Tests and proof

- The desktop tool: `export`/`import` round trip on a test credential prefix (never the real
  `computeruse/` entries in tests), nothing secret in output other than the JSON on stdout.
- kokuban: index exchange, newest-wins, tombstones, work-trust refusal for talk/share PCs, nothing
  secret in logs/usage/feed/board.json (assert on the files).
- Real check: two test boards on 47612/47613 with test credential prefixes, an entry written on one
  appearing on the other, a removal travelling, a share-level PC refused.
- Merge and deploy only after Rook's review and Alex's go.
