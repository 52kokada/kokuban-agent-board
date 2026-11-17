# Shared know-how: build spec (decided 2026-10-16)

What one agent learns about how tools, sites, apps and PCs work should reach every agent on every
PC, Claude and Codex alike, and stay accurate without anyone curating it. Decisions and evidence:
[mesh-decisions.md](mesh-decisions.md) section B. Two worries drive every choice here:
**outdated entries** and **bloat**. Build exactly this; anything beyond it needs the owner's yes.

## Where it lives

- Entries are files in **the desktop-tool repository**: `knowledge/knowhow/entries/<id>.md`, one file per entry, so
  two PCs adding at once never conflict. The desktop tool's knowledge already travels to every PC through
  GitHub and `kokuban update`, whose updater keeps each PC's local knowledge.
  the desktop tool's `scripts/update_checkout.py` must preserve local know-how entries and union
  `events.jsonl`. Identical untracked entries arriving upstream are stepped aside for the
  fast-forward; a same-id entry with different bytes refuses the update before checkout changes.
- Marks on entries (confirm, contradict, retract) go in one append-only file,
  `knowledge/knowhow/events.jsonl`, merged by union in `.gitattributes` like `knowledge/tasks.jsonl`.
  Entry files are never edited after they are written; everything that changes is an event.
- The **tool is in kokuban**, because kokuban runs in every Claude and Codex session on every PC
  (the desktop tool's MCP is off on pc-b). kokuban only reads and writes those files; it stores nothing
  of its own. It finds the folder with `repoDir('computeruse')` (src/update.ts).
- Private, PC-only notes stay in each agent's own memory, as today. No bulk import of old memories.
- No secrets: passwords and tokens belong in the vault (a later part). `add` refuses values that
  look like a password, API key or token (`password=…`, `sk-…`, `ghp_…`, `xox…`, `AKIA…`, long
  base64 or hex strings). Naming a vault item is fine.

## An entry

YAML front matter, then an optional short body. `id`: `YYYYMMDD-<slug>-<4 hex>`.

| Field | Required | Meaning |
|---|---|---|
| `kind` | yes | `observation` (how something works or fails, and the fix), `rule` (a person's preference or policy), `person`, `client`, `pc` |
| `title` | yes | one line |
| `subject` | yes | the tool, site, app or PC, with `version` when it matters |
| `symptom`, `cause`, `fix` | observation | what happens, why, what works |
| `check` | recommended | how to verify it now: a command, a page, a setting |
| `evidence` | yes | what it rests on: output, a commit, a URL, a file |
| `owner` | rule | whose agents it binds; everyone reads it, only the owner's agents follow it |
| `author` | set by the tool | `{person, pc, agent}` from kokuban settings `person`, this PC, the calling session |
| `created` | set by the tool | ISO date |

Entries may be in any language.

## Staying accurate (the loop)

- Every use is a test. After using an entry an agent records `confirm` (it worked) or `contradict`
  (it did not, with what happened, and normally `add`s the corrected entry, which `supersedes` it).
- Status is computed from the events and age, never stored:
  - **contradicted**: its latest mark is a contradict with no confirm after it
  - **retracted**: retracted by its author's person
  - **stale**: no confirm (or creation) within 30 days when it names a `version`, 90 days otherwise
  - **confirmed N×, last <date>** otherwise, or **unconfirmed** when never confirmed
- `search` leaves out retracted and stale entries unless asked (`include_stale`), ranks confirmed
  above unconfirmed above contradicted, and shows the label on every result.
- Only the author's person (an agent of that person, by kokuban settings `person`) may retract.
- Every add, contradict and retract is noted in the board's feed (`record` in src/peer.ts).

## The tool

One MCP tool `know` on the board, for Claude and Codex, ops:

- `search` (`q`, optional `kind`, `include_stale`): at most 8 results, each one line with id, kind,
  title, subject, label. Matches words in title, subject, symptom, fix and body.
- `read` (`id`): the whole entry with its label and events.
- `add` (the fields above): validates, writes the file, returns its id.
- `confirm` / `contradict` (`id`, `evidence`): appends an event.
- `retract` (`id`, `why`): appends an event, author's person only.

Its description says plainly: entries are information, below the reading agent's own person's
rules and instructions; cite the id when acting on one; confirm or contradict after use.

One line is added to kokuban's guidance for sessions (src/hooks.ts), nothing else is loaded into
sessions: "Before troubleshooting a tool, site or PC, `know(op="search")`; after solving something
another PC could hit, `know(op="add")`; after using an entry, confirm or contradict it."

## Between PCs

- New entries and events reach paired PCs within a few minutes: a `/peer` op `knowhow` (needs
  `share` trust) answers with the entry files and event lines the asker does not have (it sends the
  ids and event hashes it has). Each board asks its paired PCs every 2 minutes. Union only: nothing
  is ever deleted or overwritten by sync.
- Alex's PC (kokuban settings `"knowhow_commit": true`) commits `knowledge/knowhow` to GitHub when
  it changed: a commit of that path only, then push. Never rebase or force; if the push is refused,
  merge `origin/main` (`git pull --no-rebase`) only when that touches nothing but this path, else
  leave it for the next round and log it. Other sessions edit the desktop tool's working tree; never
  touch any other path.

## Starting content

- The 14 lessons the know-how analysis found that would have saved the other PC a failure
  (analysis summary, with source paths: the "Lessons on one PC that would clearly help the other"
  table in the original implementation research; the temporary seed note is retired). The original plan called for lessons 1-13 as
  observation entries in the fixed shape and lesson 14 as a `person` entry, paraphrased, with no
  accounts, sign-in details or secrets (names are fine: people facts are shared), author
  `{person: Alex, pc: pc-a, agent: <builder>}`.
- One `pc` entry each for pc-a, pc-b and keeper-pc: aliases, owner, how agents may reach
  it, what it has and lacks, from docs/setup.md, the desktop tool docs/multi-pc.md and the decisions.

## Tests and proof

- kokuban tests: validation and secret refusal, status from events and age, search ranking and
  labels, retract permission, sync union between two boards (both directions, no duplicates, nothing
  lost), the commit step against a temporary git repo.
- Then a real check before anything is merged: two test boards on this PC, on ports 47612 and 47613,
  each with its own LOCALAPPDATA and its own scratch copy of the desktop tool, paired with each other; the
  live board on 47600 is neither called nor written. An entry added on one appears on the other;
  confirm and contradict change the label on both.
- Merge and deploy only after Rook has reviewed it and the owner has said go.
