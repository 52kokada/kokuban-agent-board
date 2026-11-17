# The desktop tool + kokuban + Playwright as one tool: decisions (grill, 2026-10-16)

The goal is not one package or one deployment, but one coherent productivity tool: agents on
every PC, Claude and Codex alike, that reach each other, act on real desktops, and get better with
use. These are the decisions from the grill, with the evidence behind them, and the build order.

## Layers

| Layer | Owns | Not its job |
|---|---|---|
| kokuban | Everything between PCs, people and agents: messages, hand-offs, files, approvals and questions to people, pairing, updates, the trust list, the feed and the know-how pool (B) | Driving apps |
| The desktop tool | Hands on its own PC: desktop, apps, the signed-in browser, safety gate, its own learned app knowledge | Its own network: the `pc` tool becomes a thin shortcut onto kokuban, with one trust list |
| Playwright | Inside a page, for development: the throwaway browser, the library (a test harness, test scripts), a motion-script library's motion scripts | Acting in signed-in browsers: that goes through the desktop tool |

## Browsers

Evidence (60 days of transcripts, both main PCs): the desktop tool's browser carries everyday signed-in
work (2,754 calls). The shared `playwright` MCP is used mostly to run code in signed-in pages
(evaluate / run_code), unchecked by the desktop tool's safety gate. The isolated Playwright browser and
Playwright as a library carry development: acme layout and copy testing, site copying, a test harness
(which uses the `playwright` package and raw CDP on the desktop tool's Chrome, not a motion-script project).

Decided: one way to act in signed-in browsers. The desktop tool gets `browser(op='script')`: JavaScript
run in the page through the Chrome connection the desktop tool already holds, gated and logged (its
description says it runs in the page, not in Node: 38 `require is not defined` errors so far).
Full Playwright (network interception, several pages) stays in the isolated browser and scripts.
Implemented in the desktop tool. The shared
`playwright` MCP is no longer registered by default. `playwright-isolated`, the library and
a motion-script library's scripts stay as development tools.

Sam's agents mostly use the Claude in Chrome extension and OpenAI's computer-use and Chrome
skills; the desktop tool is turned off on pc-b. Decided: refine our side first, and set
the desktop tool up for him only where it is clearly better for him.

## A. The supervisor (retired)

The supervisor was removed to reduce scope and resident machinery.
The following is historical rationale, not current behavior. Explicit task ownership
and work/next reporting remain.

Evidence: about 30 Codex sessions on pc-b blocked for 10 hours on the same error (a Wise check
re-run every 30 minutes); sessions here "stalled" for an hour; nothing noticed.

Decided: pause, then tell.
- A repeating failure (the same failure three times in a row): pause the automation behind it, so
  no new runs start. Never stop a session in the middle of work. One card to the PC's own person,
  in their language: the reason, a suggested fix, Resume.
- A stuck session (working an hour with no new step) and a dead end (blocked, nobody resuming it):
  a card only.
- Cards go to the PC's own person, with a line in the shared feed. No fixing by itself until the
  know-how pool exists.

## B. Shared know-how

Evidence (544 memory items on pc-a and pc-b, plus outside research): about 10% are
how-things-work observations, 36% belong to one repo, and the rest are preferences, people, clients,
credentials and PC facts. About one file in five mixes kinds. All 13 conflicts between Alex's and
Sam's setups are rules (browser tool, autonomy, language, moving windows, scraping, Artifacts,
commit credit, kokuban in the prompt repo, SSH to each other's PCs), never facts. One already
leaked: Alex's "answer in English" rule reached pc-b's Codex file and the shared prompt repo.
Outside: vendors keep agent notes private by default and share reviewed, evidence-citing,
expiring entries (GitHub Copilot Memory); memory poisoning is a known attack; large instruction
files lower agent success.

Decided (both owners agreeing):
- Everything is shared between the two of them: how things work, people, clients, PC facts,
  preferences and rules, and work credentials.
- Rules and preferences carry an owner and bind only that owner's agents. Every agent knows
  "Sam: answer in Japanese, never move my windows"; only Sam's agents follow it.
- Credentials are shared through one vault (the desktop tool's password store, synced over kokuban)
  that agents ask when signing in, not written into the pool every agent reads.
- Each person's own settings decide what happens on their PC. An approval holds only on the PC it
  was given on (the desktop tool 8a89ed3).

Design rules carried over from the analysis:
- Entries are single claims, never copied files. Observations take the form: subject and version,
  symptom, cause, fix, evidence, observed on (PC), observed at (date).
- Repo knowledge stays in its repo; the pool links to it. Two people holding notes on the same repo
  is the signal to commit them there.
- PC facts live in one registry (aliases, owner, access policy), edited by the PC's owner.
- Anyone's agent may add; the author's person edits or retracts; a contradiction is a new dated
  entry; version-bound entries lapse after 30 days unless seen again.
- Pool entries are information ranked below the reading agent's own person's rules; an agent that
  acts on one cites it. A small digest is always loaded; the rest is looked up.

## Status (keep this current)

| Part | State | Spec | Who |
|---|---|---|---|
| A. Supervisor | removed from source; activation waits for approved board restart | this doc, historical A | retired |
| B. Shared know-how | live on all three boards (kokuban 37c5d9c, the desktop tool a3777f4); pc-a commits the pool to GitHub (`knowhow_commit`) | [knowhow.md](knowhow.md) | done |
| C. Vault sync | live on pc-a, keeper-pc and pc-b (104 entries synced 2026-10-16). Memory cleanup: one personal password stays out of the vault; no cleanup run on that PC | [vault.md](vault.md) | done |
| D. `browser(op='script')`, shared playwright MCP off | historical verified rollout at the desktop tool a3777f4; implementation belongs to the desktop tool | the desktop tool source | done |
| E. The desktop tool `pc` tool onto kokuban | step 1 historically verified; local device_bridge.py still calls local_board (/bridge), so /peer caller migration remains a separate the desktop tool task. No new cross-PC rollout was verified during this cleanup | [cross-pc-v5.md](cross-pc-v5.md) | migration pending |
| pc-b's desktop tool | last recorded update a3777f4; Sam later disabled its MCP. Current enablement and the historical stash were not reverified by this local cleanup; do not infer them from a code commit | historical record above | unverified |
| Sign-in hub | on hold; idea: any agent on any PC signs into shared accounts without waiting on each other for 2FA; email codes and authenticator (TOTP) secrets in the vault can be automated, passkeys and phone prompts need a person's tap routed by card | inventory of shared accounts and their second factors first | Rook |

Process: Rook designs with the owner and writes the spec; a builder session builds it on a branch with
tests and an isolated real check; Rook reviews; the owner says go; then merge and deploy.

## Build order

1. A, the supervisor: retired.
2. B's foundation: the store (git as the source of truth, synced over kokuban), `know` tools for
   Claude and Codex (search, add, retract), the owner field on rules, the PC registry, and the 14
   cross-PC lessons the analysis found as the first entries.
3. The shared credential vault.
4. `browser(op='script')`, and the shared Playwright MCP off by default.
5. The desktop tool's `pc` tool onto kokuban.

Remaining work follows current ownership; supervisor implementation is no longer in scope.
