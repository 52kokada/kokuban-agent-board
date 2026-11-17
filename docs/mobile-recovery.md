# Mobile conversation recovery

The phone shows a persistent recovery notice for stopped, disconnected and
recovery sessions. Provider diagnostics are available under “Why it stopped.”
The notice hides while typing so the composer and conversation remain readable.

- **Resume & send** accepts the new message and resumes a stopped session in one
  durable, idempotent command (`message`, `resume: true`). It requires the current
  control revision, so an intervening Stop cannot be silently overridden.
- **Reconnect** uses `restart`, `resume: true` to open the provider and resume
  messages that were accepted but never started. Older restart callers still
  leave the queue held until an explicit Resume.
- Uncertain attempts remain in history and are never resent by either action.
  The notice counts them separately from queued messages.
- Failed turns release global turn capacity and wake other waiting conversations.
- Send keeps the message field focused on pointer-down. Otherwise blur can change
  the footer layout between pointer-down and click, causing the first tap to miss.

## October 21 investigation

A practice quiz transcript from one session records Claude provider refusals under
category `cyber` at 2026-10-22 00:53:10 and 00:54:05 UTC. Kokuban had replaced these
diagnostics with a generic failure message. The transcript does not establish why
the study session received that classification. This change preserves provider
diagnostics; it does not remove or bypass provider refusals.

Other conversations were in recovery after daemon restarts. During activation,
C: had zero free bytes and the required SQLite backup failed with SQLITE_FULL.
After space was recovered, the backup and guarded restart succeeded. Disk
exhaustion is a separate reliability issue; it is not evidence that it caused
Coral’s provider refusal.

## Verification

Controller tests cover duplicate resume-and-send commands, stale controls,
uncertain-attempt preservation, reconnect with queued work, and global capacity
after failure. Phone tests cover recovery rendering, draft preservation and Send
focus. Browser QA uses an isolated fixture, never production conversation writes.
Full-suite verification isolates LOCALAPPDATA: live communication override
settings otherwise contaminate board tests that use a synthetic clock.
