# Kokuban: names, installation, and pulling updates

Kokuban is a separate repository from the desktop tool. It gives Claude Code and Codex sessions a shared local board with names, task summaries, messages, and resource claims. You can install either project independently; install both to have desktop automation plus agent coordination.

## How names work

1. A lifecycle hook reports a host session ID to the local board.
2. `src/board.ts` looks up that ID. A new session gets a randomly selected unused name from `src/names.ts`, such as Dara, Opal, or Yuki.
3. If the pool is exhausted, a numbered name is selected. Names are unique among retained sessions on that board.
4. The board tells the agent its name through hook context. The agent uses it as `me` when calling `peers`, `send`, `glance`, `inbox`, `claim`, and `release`.
5. The board reads the host title and active task from appended transcript records. `peers(doing=...)` overrides that summary for two hours. Claude session titles use the name; Codex thread titles include its name and summary.

Board snapshots are saved to `%LOCALAPPDATA%\kokuban\board.json` on Windows. Session names are retained for a day (24 hours) after last contact, allowing a resumed session to recover its name within that window. A new session gets its own identity; an agent name is not a permanent account or a name shared by every session using the same model.

Each desktop has its own localhost board. Pulling Git transfers the naming code, not live session identities or messages. Do not copy the board snapshot onto another PC to migrate active sessions: session IDs, transcript paths, claims, and host state belong to their original machine.

## Fresh installation on Windows

Requirements: **Node.js 20 or newer**, npm, Git, and Claude Code and/or Codex installed and authenticated. Use the Windows account that will run your agent sessions. Keep this checkout in a permanent location; installation writes paths to its compiled files.

Everything is on **`main`**:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\githubprojects" | Out-Null
Set-Location "$env:USERPROFILE\githubprojects"
git clone https://github.com/52kokada/kokuban-agent-board.git kokuban
Set-Location kokuban
npm ci
npm test
node dist/src/cli.js install
node dist/src/cli.js status
```

Authenticate to GitHub if requested. `npm ci` installs the locked dependencies and runs the package's build preparation. `npm test` builds and runs regression tests. `install` adds user-level hooks/MCP registrations, creates a Windows logon startup entry, and starts the board if it is down, waiting for a daemon that is still exiting; it starts the board through the logon entry, so its process settings apply. `status` exits 0 when the board answers, 2 while a daemon holds the lock but does not answer yet, 1 when it is not running. It preserves unrelated hook handlers and creates initial `before-kokuban` backups for existing settings files.

Check the install output: if either CLI is unavailable or its MCP registration fails, that client needs registration after it is installed. The installer writes hook configuration for both hosts, so inspect the reported outcomes rather than assuming both clients connected.

Install and open the **native Kokuban app** from its Start menu entry or tray. The board has no browser page. In Codex, open **`/hooks`** and trust the installed hooks once. Reconnect your client's MCP session if the tools are missing. Ask an agent to call `peers` with its assigned name; its entry should show the host title/task.

The local API is bound to `127.0.0.1`; only `/peer` is exposed to paired PCs through Tailscale Serve. Keep the default port **47600** unless you deliberately configure an alternative; `KOKUBAN_PORT` changes the service URL and registration must match.

## Updates between your PCs

Once PCs are paired, they update each other over the tailnet; no PC needs its own way into GitHub:

```powershell
kokuban update                      # the newest kokuban and computeruse among the paired PCs
kokuban update --from pc-a --repo computeruse
kokuban update pc-b               # offer this PC's versions to pc-b: a card there, Install / Not now
```

Each repository comes as a git bundle of `main` (only the commits this PC lacks) from a PC that
trusts it at `share` or more. kokuban fast-forwards, builds (`npm ci` when the lock file changed)
and the board restarts itself on the new build, staying in the person's session. The desktop tool is
updated by its own `scripts/update_checkout.py`, taken from the incoming commit, which keeps the
PC's `config.yaml` and learned knowledge and installs new requirements; a PC without the desktop tool
gets it cloned beside kokuban and installed (`scripts\install.ps1 -NoVoice`, log in the board's
data folder under `updates`). Anything unexpected (local edits, commits only this PC has, another
branch checked out) leaves that repository alone and says why. `kokuban pair` shows which commit
each PC runs.

## Pull updates on an existing checkout

First check for local edits and confirm the branch:

```powershell
Set-Location "$env:USERPROFILE\githubprojects\kokuban"
git status --short
git fetch origin
git switch main
git pull --ff-only origin main
npm ci
npm test
```

If the branch does not exist locally, after fetching use:

```powershell
git switch --track origin/main
```

Preserve any local edits before switching or pulling. `--ff-only` refuses a divergent history instead of creating an unexpected merge; inspect divergence if it refuses. A checkout still on `v4-mailbox`, where the implementation used to live, switches with `git switch main`; `main` has all of its history.

The installed board runs compiled files from `dist/`. A pull/build does not replace the code already loaded by a running process. At a coordinated maintenance point, close/restart only Kokuban's board process, then run:

```powershell
node dist/src/cli.js install
node dist/src/cli.js status
```

`install` refreshes registration and starts the board only if it is down; it does not restart an already running daemon. There is currently no dedicated restart CLI. Avoid killing unrelated Node processes. On a new desktop there is no old daemon to coordinate. On the owner's current PC, do not restart Kokuban during active sessions without the owner's instruction.

If you move the checkout, rebuild and rerun `install` so hooks/startup paths point at the new location. Do not move the folder while agents depend on it.

## Talking to other PCs' boards

A board reaches another PC's board directly when that PC exposes its `/peer` route to the tailnet
and trusts the caller ([cross-PC v5](cross-pc-v5.md)). Pairing sets up both, on both PCs:

```powershell
kokuban pair pc-b            # asks the person at pc-b; waits up to 3 minutes for their answer
kokuban pair pc-b --level talk
kokuban pair                   # every connected PC: answers?, how fast, its kokuban, trusts back?
kokuban unpair pc-b          # both sides drop each other
```

Running `pair` is this side's consent: this PC exposes `/peer` and asks the other board, whose
person gets a card (Allow / Refuse, in Japanese when that PC's `settings.json` has `"lang": "ja"`,
in both languages when it names none). On Allow both boards write each other into their trust
lists and note whose PC it is under `people`. An unanswered card stays 12 hours and the connection
completes whenever it is allowed. Changing the answer to Refuse later disconnects again. A PC that
refused may not be asked again for an hour; asking again before an answer replaces the card.

**A new PC.** When the other PC does not answer, `kokuban pair <pc>` prints a prompt for that PC's
agent: install kokuban there, then `kokuban pair <this PC>` from that side. The card then comes to
you. `kokuban install` puts the `kokuban` command in `%APPDATA%\npm` (on PATH with a normal Node
install); without it, run `node dist/src/cli.js pair ...` in the checkout.

By hand, which pairing does for you:

```powershell
# <secret> is "peerIngress" in %LOCALAPPDATA%\kokuban\settings.json: 64 hex characters, made by
# kokuban pair (or by hand: any 32 random bytes in hex). Keep it private.
tailscale serve --bg --http=47600 --set-path /peer http://127.0.0.1:47600/peer/_ingress/<secret>
```

Only `/peer` is exposed; everything else stays on 127.0.0.1. Other PCs still call `/peer`; Serve
forwards it to the private path, and the board refuses `/peer` called directly on 127.0.0.1 (a local
program could write Serve's identity headers itself). A board that starts and finds an older `/peer`
entry repoints it. In Git Bash, prefix the command with
`MSYS_NO_PATHCONV=1`, or it rewrites `/peer` into a Windows path. Then list who may call this PC,
by full tailnet name, in `%LOCALAPPDATA%\kokuban\settings.json`:

```json
{ "trust": { "pc-b.example-tailnet.ts.net": "work", "keeper-pc.example-tailnet.ts.net": "work" } }
```

Levels: `talk` (session list, messages marked as a peer's request), `share` (adds glance, files,
question cards, the feed), `work` (adds starting work as this human's own; deleting, deploying,
paying and publishing still ask). A PC that is not listed is refused. The file is read on every
request, so trust changes need no restart. Every connected PC must run `/peer`; transport errors and refusals are final.

## Useful tools

| Tool | Purpose |
| --- | --- |
| `peers(me, doing?, work?, next?)` | Discover sessions, optionally override the derived summary, and record disposition. |
| `glance(me, who)` | Read another session's recent request/steps without interrupting it. |
| `send(me, to, text)` | Message one or several sessions. `all` means this repository; `repo:name` means another repository; `everyone` means this PC. |
| `inbox(me, wait_s?)` | Read unread mail, optionally waiting briefly. |
| `claim(me, what, note?)` | Atomically reserve a shared resource, e.g. `port:3000`. |
| `release(me, what?)` | Release a resource, or all your claims. |
| `ask(me, question, ...)` | Create a native app card for a person; say/status/withdraw keep its thread. |
| `task(me, op, ...)` | Assign one exact owner, then accept/progress/complete/block/cancel. |
| `know(me, op, ...)` | Search evidence-backed lessons; add, read, confirm, contradict or retract. |
| `remote(me, op, pc, explicit=true, ...)` | Reach a paired board within the human-authorized workflow. |

Direct messages can wake idle open sessions through host-specific mechanisms. Closed sessions cannot be started by mail. Claims release when the holder ends, explicitly releases them, or has been silent for two hours. Names and claims help agents coordinate; they do not replace Git branches or permission to perform external actions.

## Troubleshooting and removal

- **No name/tools:** verify `status`, inspect install output, reconnect MCP, and check Codex hook trust.
- **Codex thread has no kokuban tools while the board is up:** the thread opened before the daemon was listening, so Codex built its tool list without kokuban and does not retry. The daemon now asks Codex to reload its MCP servers when it starts; to do it by hand, run `node --input-type=module -e "import {codexRpc} from './dist/src/codex-rpc.js'; console.log(await codexRpc('config/mcpServer/reload', {}))"` in this checkout. The thread sees the tools on its next turn; if it still does not, resume it or open a new one.
- **Old behavior after pull:** compiled files or the loaded daemon may be stale. Build/test and schedule a board-only restart as described above.
- **The board will not come back after its process was stopped:** `install` only starts it when it finds none and can miss; start it the way logon does, `wscript "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\kokuban.vbs"`.
- **Restarting the board on another PC over SSH:** a board started from the SSH shell lives outside the person's desktop session, so nothing it shows reaches their screen. Stop only `dist\src\daemon.js`, copy `kokuban.vbs` to a path without spaces, and run it through a one-off task for the signed-in user: `schtasks /create /tn kokuban-restart /tr "wscript.exe <copy>" /sc once /st 00:00 /it /f`, `schtasks /run /tn kokuban-restart`, then delete the task and the copy. The new process should report the desktop's session number (1), not 0.
- **Finding the board's process:** its command line may use forward slashes (`C:/Users/.../dist/src/daemon.js`); compare paths with slashes normalised.
- **Native app still shows old behavior:** a running app retains its loaded code. Coordinate an app update/relaunch at an approved time; the app owns its shortcut and hotkey.
- **No running app for a named person:** inspect `kokuban pair` and confirm the native app runs on one of their configured PCs. Named-person routing picks the first configured app that answers.
- **Another PC shows different names:** expected; each PC has its own board and new session IDs.
- **Missing original browser accounts:** Kokuban stores coordination state, not browser credentials. Configure the desktop tool/accounts separately.
- **Port occupied:** identify the owner before changing anything; do not terminate unrelated sessions.

```powershell
node dist/src/cli.js uninstall
```

This removes Kokuban's hooks, MCP registrations, startup entry and retired board protocol/toast registry keys. The native app owns Kokuban.lnk; the board does not recreate or delete that shortcut. It does not serve as a daemon restart command.

## Running and checking the native app

Build with `npm run app` (or `app-windows/build.ps1`; `-Pack` publishes into this
PC's app feed). The app owns `Kokuban.lnk` and Ctrl+Alt+K. Start flags include
`--pill`, `--item <thread>`, `--background`, `--settings`, `--quit`; checks use
`--port <n>` (test board, labeled Demo), `--pill-test`, `--offscreen`, `--theme`
and `--lang`. `app-windows/tools/DemoBoard` serves fixture items on its own port.
`KOKUBAN_TRACE=1` logs drawn lines to `%LOCALAPPDATA%/kokuban/app-windows.log`.
Do not start or stop the running app/board merely to build; use an isolated port
and separate state for checks. Every production PC needs the native app.
