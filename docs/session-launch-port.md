# Optional native session launcher

The existing managed Agents view remains the default. This Windows-only integration opens an external Codex, Claude, or Kimi CLI only after the person chooses a host, folder, and target in the native app. Direct mail never uses it.

## Opt in on one PC

Board settings (`%LOCALAPPDATA%/kokuban/settings.json`):

```json
{ "sessionLauncher": { "vscode": false, "terminal": false } }
```

Enable only targets installed and approved on that PC. VS Code requires the optional `vscode-session-launcher/` extension (`local-kokuban.session-launcher`) to be packaged and installed separately. No extension or CLI is installed automatically. The extension uses this PC's standard board port 47600.

App settings (`app-windows.json`): set `LocalUi.SessionLauncher` to `true` to show the button. It is hidden by default. The view lists only backend-enabled targets; a missing integration is shown as 未接続. Existing settings are not modified by the code patch.

## Resume safety

- Select by exact conversation ID, not a name or latest timestamp. A saved transcript file and original working directory must still exist.
- Only a recorded `Board.end` from the host lifecycle/runtime observer establishes an ended CLI. TTL pruning alone never grants resume permission. Old snapshots without this marker remain non-resumable until the host's state is observed again.
- Managed Agents sessions are excluded: use their existing Agents view.
- A 60-second random grant fixes target, host, cwd, and ID. Claims are one-use and recheck settings, session identity, and liveness. Claimed resume reservations are durable across daemon restarts. A real host hook clears them; a person can explicitly reset one after inspecting the existing terminal.
- Launcher-only archive entries are bounded to the latest 500; checkpoints, checkpoint history, pending launches, and task evidence are retained.
- Windows child creation is hidden, non-detached, with fixed executables and quoted arguments. Inherited conversation identity variables are removed. No permission-bypass flags are added.
- Clicking the native launch button asks the selected editor/terminal to open; the current UI wording reports a request, not proof that the CLI started. A missing VS Code extension leaves an unclaimed request which expires.

## Validation

New Core methods and Node modules/routes first failed before implementation. The authenticated `/app/sessions` route originally returned 404. Added tests cover opt-in defaults, expiry, one-use claims, durable state, configuration revocation, changing sessions, managed/unknown sessions, pruning, checkpoint preservation, and Unicode shell quoting.

On 2026-11-05: 35 relevant Node Board/coordination/launch tests passed with isolated LOCALAPPDATA; 2 extension tests passed; Core 107 total, 106 passed, 1 existing live-board skip. Windows x64 self-contained publish succeeded. An initial Board run against the PC's real settings saw two vault-guidance expectations fail; rerunning with isolated settings removed that environmental dependency. No production setting or installed artifact was changed.

The additional context delivery/followups/recovery suites passed 44 of 45 tests. The discovery test (`discovery catalogs older Claude, Codex and Kimi logs in bounded metadata pages`) failed with `0 !== 3`; the same failure was reproduced from an untouched `ec4052e` source archive with isolated settings. It is not resolved by this port. TypeScript/security and general code reviews found no remaining blocking findings after the reset-dialog busy guard was corrected.

Native GUI focus/desktop behavior and real external CLI startup remain unverified on this build. Do not mark those verified from unit tests or publish success. No deployed app or daemon was restarted. No push or deployment was performed.
