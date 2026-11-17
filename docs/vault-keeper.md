# Shared vault keeper

Phase 3 of the shared project context plan.
Code: `src/vault-keeper.ts` (the keeper's tick; it re-exports the whole keeper API) and the modules it is split into:

| Module | What it holds |
|---|---|
| `vault-store.ts` | settings (`keeperConfig`, grouping), note files, front matter, keeper blocks, revisions, the hidden index |
| `vault-rulebook.ts` | Rules.md, README.md and "How this works", every version the keeper ever wrote, built from versioned data |
| `vault-spaces.ts` | `ensureLayout`, spaces and their Overviews, the Homes, rulebook proposals |
| `vault-write.ts` | `validateWrite`, `applyWrite` and the writer for each kind |
| `vault-mask.ts` | the Credentials table and `maskCredentials` |
| `vault-read.ts` | `readPage` (with its "based on" line) and finding client pages |
| `vault-checkup.ts` | the nightly check-up and Needs attention |
| `vault-queue.ts` | the local outboxes in `.keeper/queue` (writes for the keeper, links for acme-cockpit) |
| `vault-transport.ts` | forwarding writes over /peer, queueing, draining, the /peer `vault_write` handler |
| `vault-cockpit.ts` | sending links to acme-cockpit |
| `vault-tool.ts` | the `vault` MCP tool and the vault lines every session hears |
| `vault-heartbeat.ts` | `.keeper/heartbeat.json` and `kokuban status` lines |

A changed rule is a new rulebook version: add its text with the next version number in `vault-rulebook.ts` and a new
fixture in `tests/fixtures/vault-rulebook/`; never edit an old version's text (`tests/vault-rulebook-text.test.ts`).

Not to be confused with `src/vault.ts`, which syncs credentials and never touches this folder.

## Turning it on

`settings.json` in Kokuban's data folder:

```json
{ "vault": { "path": "C:\\Users\\sam\\shared-vault", "keeper": true } }
```

- `keeper: true` on keeper-pc only. Every other PC sets `keeper: false` (or leaves it out).
- `keeper_pc` (optional, default `"keeper-pc"`) names the keeper for forwarding.
- `cockpit` (keeper only, optional): `{ "url": "https://cockpit.acme-agency.net", "token_file": "C:\\Users\\sam\\.ops\\credentials\\acme-cockpit-brain-token.txt" }`.
  The keeper then forwards connections to acme-cockpit (see Connections). The token is read from its file for each
  send and only ever goes into the Authorization header: it is never logged, stored or written into the vault.
  Without `cockpit`, connections are recorded only.
- `businesses` (optional): the businesses and which repositories belong where (D102). Without it the built-in
  default below applies; with it, it replaces the default as a whole (an entry that is not valid is left out; none
  valid falls back to the default). `shared` is the Shared tools list:

  ```json
  "businesses": {
    "acme": { "folder": "Acme", "client_prefix": "T",
                "repos": ["acme", "acme-cockpit", "translation", "ops-home", "prompt"],
                "client_repos": { "T-05555": ["ember-aoz", "acme-booking"] },
                "repo_aliases": { "acme-booking": "ember-aoz" },
                "keywords": ["acme"], "readme": ["Acme", "アクミ"] },
    "harbor-trading": { "folder": "Harbor Trading", "repos": ["Reservation"], "keywords": ["harbortrading", "harbor-trading"], "readme": ["Harbor Trading", "ハーバートレーディング"] },
    "crypto": { "folder": "Crypto", "repos": ["crypto"], "keywords": ["crypto"] },
    "security": { "folder": "Security", "repos": ["security"], "keywords": ["security", "pentest"] },
    "shared": { "repos": ["kokuban", "computeruse"] }
  }
  ```

  Each business may also carry `boards` (`["pipeline", "care"]`, one of them, or `[]`) and `visuals` (a list from
  `pipeline`, `clients`, `projects`, `direction`, `research`, `research-map`); see Boards, visuals and research (D126).
  Left out, they follow the rule and the per-business defaults there.
- No `vault` key: the feature is off. No tool, no session-start lines, no timer work.
- The keeper PC must give the other PCs **work** trust, since `vault_write` needs it.
- The daemon must be running a build with this code. After that, settings are read on each call and each
  30-second tick, so adding or changing `vault` needs no further restart.

## Layout (D101–D103)

Clients belong to the Acme business, and the agency sits inside the project layout, not outside it. The vault is grouped by business (code:
`src/vault-layout.ts`):

```
README.md  Rules.md  Home.md (the sync status, the businesses and Shared tools)  Needs attention.md (the whole vault)  .keeper/
<Business>/  Home.md  Decisions.md  log.md  index.md  Credentials.md (when there are any)
             Pipeline.base  Care.base                only a business with clients (D126)
             Projects.base  Research.base            what its Home's visuals need (D126)
             Research/<name>.md, Research/Research index.md, Research/<Business> research map.canvas   (D126)
             Clients/<group>/<ID> <name>/            a client space, in the group of its stage (below)
             Clients/<group>/<ID> <name>/Projects/<repo>/   a client's own repository (ember-aoz under T-05555)
             Projects/<repo>/                the business's repositories
Shared tools/Home.md, Shared tools/Projects/<repo>/   tools every business uses (kokuban, computeruse)
Unsorted/Home.md, Unsorted/Projects/<repo>/           repositories the keeper could not place (on Needs attention)
```

The keeper creates what is missing on start and before each write, and never overwrites a file (every business's
folder pages, the top `Home.md`, `Shared tools/Home.md`, `.keeper/queue/` and the `/.keeper/queue` line in
`.stignore` so Syncthing never carries the queue). A `README.md` still saying "Nothing here yet" is refreshed.

A client space is `<Business>/Clients/<group>/<ID> <name>/` with `Overview.md` (front matter `tobira_id`, `name`, `aliases`,
`business` (a link to the business Home), `cssclasses: [client]`, `updated`), `What we made.md`, `Work log.md`,
`Communication.md`, `Decisions.md`, `Facts/`, `index.md`, `log.md`. The ID's prefix names the business
(`client_prefix`; "T" is Acme) until the client is moved to another one (D112, below). It is made on the first
write to that ID, which must then carry `name`, straight into the group of the stage that write sets. A renamed
folder is still found through `tobira_id` in its Overview.

### Clients grouped by stage

Client folders are grouped by stage so a person sees which ones need work right now. Inside each business's
`Clients/`, a client folder sits in the group folder of its stage, so Obsidian's file explorer reads as a work list
(`CLIENT_GROUPS` in `src/vault-layout.ts`, the one place the mapping lives; not a setting):

| group folder | stages |
|---|---|
| `1 🔥 Act now` | replied, sample-made, engaging, proposal (we owe them something) |
| `2 🛠 Building` | signed, building, launch |
| `3 ⏳ Waiting on them` | outreach, sample-sent |
| `4 💤 Quiet` | replied, sample-sent or engaging with the tag `quiet` (the daily pipeline job adds it after 14 days without client contact; it overrides Act now and Waiting on them, not the others) |
| `5 ✅ Done` | done |
| `6 🗄 Closed` | closed |
| `0 ❓ No stage` | no stage, or one not in D104's list |

- The names pass `safeName` unchanged (the emoji are kept); the numbers keep the explorer's order. Group folders get
  no files of their own.
- The keeper moves a client folder to its group right after a write that sets `stage`, `tags` or `business`, and
  on every keeper tick (next to the project re-file) for any client out of place, flat ones from before the groups
  included: that is the migration, no separate script. `kokuban vault regroup` (dry run) also lists the client
  moves (`would move client … (stage … → group)`); `--apply` makes them. Not while the old top-level layout is still
  waiting for the regroup.
- A move is the regroup's: one `move` revision, path-style `[[links]]` rewritten in every note and base (keeper
  blocks whose text changed get a matching revision, so no false conflict), the client and its nested projects
  linked up, then the Homes and the hidden index once per batch. A target that exists is never overwritten: the
  move is skipped, reported once (in the write's answer each time), and Needs attention lists it under "Waiting to
  be re-filed". The group folder a client leaves is removed only when nothing at all is left in it.
- Every lookup (`findClient`, `allClients`, the Overview and project parents, the space keys, the hidden index, the
  credential export) accepts both the grouped and the flat form, so a vault mid-migration never splits.
- The business Home's client list (`keeper:clients`) shows the same groups in the same order with their counts,
  each client with its stage, `❓ No stage` after `✅ Done` and `🗄 Closed` folded in a collapsed callout. The
  Pipeline and Care boards are unchanged: `file.inFolder("<Business>/Clients")` in Bases matches files in subfolders
  too (client-nested project Overviews were already below it, and the boards' `tobira_id` filter leaves them out).

### The Pipeline board in Tendra's design (D120)

The Pipeline board follows the Tendra kanban design: Obsidian
1.15's built-in Bases kanban view and the shared `acme` snippet, no community plugin. Code: `src/vault-tendra.ts`.

- **Card** (172px, like a Tendra tile), top to bottom: the stage chip, plus `came back` (red) and `quiet` (amber)
  chips from the Overview's tags, and the days since the last thing on the right with a calendar mark; the client's
  name; its Acme ID and the last thing's date in mono; the last thing itself (`last_event` after its date); a
  footer with `next_step` ("No next step" when unset) and a "Work log ›" button on hover that opens the client's
  Work log (always shown on phones). The board's columns are soft trays with a stage dot, the name and a count chip.
- **How.** The card rows are formulas in `Pipeline.base` (`card_name`, `card_top`, `card_code`, `card_event`,
  `card_next`, `card_work`, helper `card_age`) and the Board view lists exactly those, 264px wide. Bases sizes every
  card from the card's padding and one row per property and places each row itself; the snippet's
  `keeper:tendra` block sets that padding and places the rows by their `data-property` names. Colours come from the
  snippet's tokens, so light and dark follow the theme. The table view and the Care board keep their own properties
  (the table gains `next_step`).
- **Kept up to date on start** (`ensureLayout`, the keeper only): a new Pipeline.base is written that way; an existing
  one gains the card formulas and display names (nothing in it changes), and its Board view switches to the Tendra
  card only while its card list is still one the keeper wrote, so a person's own choice of card properties stays.
  `tobira.css` gains the `keeper:tendra` block once (after the visual pass's own lines); a later keeper version
  replaces an unedited earlier block, and a block a person edited is left alone. A vault without the snippet gets none.
- The six rows are placed for this card list. A property a person adds to it is drawn where Bases puts it (over the
  footer), and a card_* row taken out leaves a gap; once the list is a person's own, the keeper leaves it alone.
- **Not possible in Bases + CSS:** Tendra's stat tiles above the board, owner avatars and money values, the drop
  hints ("Drag a bid here", "1 more"), empty-column fillers and the owners view; column names are the stage values
  (`sample-made`/`sample-sent` read "Sample made"/"Sample sent" while the column has cards). Nothing writes
  `next_step` yet except an agent or a person setting it.

### Boards, visuals and research (D126)

A pipeline makes no sense for some businesses; they get custom visuals instead. Research, as done for the crypto space, is shown there too, as a graph.
Code: `src/vault-visuals.ts` (boards, Homes, bases, snippet, graph) and `src/vault-research.ts` (notes, index, map).

**Boards.** A business has the Pipeline and Care boards when settings give `boards` (`["pipeline", "care"]`, one, or
`[]`), else when it has clients: a `client_prefix` of its own or client folders in its `Clients/` (Acme; Harbor Trading
since T-00650 moved there). Crypto and Security have none. On every start and write (`ensureLayout`, keeper only):

- a missing board is made for a business that has it (a business that gains a client gains its boards);
- a business without one loses the keeper's own unedited `Pipeline.base`/`Care.base` (the current text, the D101
  board, or that board moved to the Tendra card by D120): it moves to `.trash/<Business>/<file>` (a timestamped name
  when that is taken), never deleted, with a `move` revision (state `trashed`). `.trash` is in every PC's `.stignore`,
  so other PCs see the file go and the copy stays on the keeper;
- a board a person changed stays; Needs attention lists it under "Boards" (delete it, or set `boards`), and also a
  Home a person edited that still links to a board its business no longer has.

**Homes.** What a business Home shows is settings `visuals`, in that order; defaults by business key:

| business | visuals | the Home shows |
|---|---|---|
| acme | `pipeline` | unchanged: the Boards list and the Tendra Pipeline board (the classic Home, no visuals block) |
| harbor-trading | `clients`, `projects` | the board links, its client board (the Pipeline table, `Pipeline.base#Pipeline`), the project status board, then its clients by stage and its projects |
| crypto | `direction`, `research`, `research-map`, `projects` | the accepted direction, the research cards by topic and the most recent, the research map, the project status board |
| security | `projects` | the status board of its project spaces only: Overview front matter (`status`, `last_event`, `next_step`, `updated`), never page bodies, engagement evidence, client names or findings |
| any other | `pipeline`, `projects` | its Pipeline board (when it has clients) and its project status board |

- `pipeline`: `![[<B>/Pipeline.base#Board]]`; `clients`: `![[<B>/Pipeline.base#Pipeline]]` (both need the pipeline
  board, else they are left out); `projects`: `![[<B>/Projects.base#Status]]` (cards: project, status chip, last thing,
  next step, updated; a table grouped by status); `direction`: each of the business's project Overviews whose summary
  has a "Direction (accepted …):" line, that line and its points as an `[!abstract]` callout linking the Overview;
  `research`: the note count, `![[<B>/Research.base#Cards]]` (grouped by topic: status, date, confidence) and
  `![[<B>/Research.base#Recent]]` (eight newest, not superseded); `research-map`: an `[!example]` callout linking the
  Canvas (Obsidian 1.15 draws an embedded canvas as its title only, so it is a link, not an embed).
- The visuals are the Home's `keeper:visuals` block: one line of page links (boards it has, Decisions, Research index
  and map, Needs attention, Rules), then each visual under its `## ` heading. Derived and redrawn like the client and
  project lists (on start, on writes that make spaces or change stages, on research writes and nightly).
- An existing Home: the keeper's own Boards section (unchanged since written) is replaced by the block, and the empty
  Clients section of a business without clients goes. A Home a person reworked keeps everything and gains the block
  above its Clients (or Projects) heading. Shared tools and Unsorted keep their project lists only.
- The pages a visual needs are made once (`Projects.base`, `Research.base`, the Research index and an empty map).
- Project Overviews may carry front matter `status` (one short line: active, paused, …; vault write `frontmatter`),
  which the status board shows.
- `tobira.css` gains a `keeper:research` block once (status chips draft/current/superseded, confidence low/medium/high,
  callout corners, the research tag), like `keeper:tendra`: an unedited earlier version is replaced, an edited one kept.

**Research** is a write kind of its own:
`vault(op="write", kind="research", space, topic, text, source, name?, status?, date?, confidence?, sources?, related?)`.

- `space`: a business (`business:<key>`, `agency`), a client (its business), or a project filed in a business (its
  business; Shared tools and Unsorted have none). Written from a client or project, that space's Overview joins
  `related`. The business's `log.md` and `index.md` record it, and its revision is kind `research` (page
  `Research/<name>.md`, block `summary`, the front matter fields' hashes).
- The note is `<Business>/Research/<name or topic>.md` (Windows-safe), one per subject:

  ```
  ---
  topic: "Memecoins"
  status: "current"              # draft (default for a new note) | current | superseded
  date: "2026-11-03"             # YYYY-MM-DD, today for a new note
  confidence: "medium"           # low | medium | high (optional)
  tags: ["research","memecoins"] # research + the topic as a tag
  sources: ["https://…"]
  related: ["[[Crypto/Research/Custody options|Custody options]]","[[Crypto/Projects/crypto/Overview|crypto]]"]
  cssclasses: ["research"]
  created: … updated: …
  ---
  # Memecoin launch patterns
  keeper:parent   Part of [[Crypto/Research/Research index|Crypto research]] · topic: Memecoins
  keeper:summary  the write's text
  ## Sources      keeper:sources (each source; links as <…>)
  ## Related      keeper:related (each related link)
  ## Notes        free for people
  ```
- `related` items: a `[[link]]` as given, `project:<repo>` and client IDs to their Overview (refused when there is none),
  anything else to that research note in the same business (it may be written later). Web links go in `sources`. The
  related links in front matter and body are what Obsidian's graph draws.
- An update replaces the summary (a person's edit of it is a conflict: their text stays, the agent's becomes a
  proposal), sets topic, status, date and confidence only when given (a value a person changed by hand stays, with a
  `frontmatter:<field>` conflict on Needs attention), and merges tags, sources and related (never shrunk). The same
  write again is `unchanged`.
- After each write the folder's `Research index.md` (`keeper:research` block: notes by topic with status, date and
  confidence; not named index.md, which the shared graph filter hides, so it is the graph's hub) and its research map
  follow. The map (`<Business> research map.canvas`, JSON Canvas): the business in the middle, its topics on a ring,
  each topic's notes along its spoke (green current, yellow draft), an edge from topic to note and a "related" edge
  between research notes. While the map is the keeper's own (its hash in `.keeper/visuals.json`), it is redrawn; once
  a person moved things, only notes it does not show yet are added (with their topic), and their layout stays.
- The graph: once per vault (`.keeper/obsidian.json` `graph_research`, like the D124 bookmarks), when `.obsidian/`
  exists, `.obsidian/graph.json` gains the colour group `tag:#research path:Research` (violet), first so it wins over
  the folder groups. A group already finding the tag is not added again, a file that does not parse is left alone, and
  a person's later removal is respected.
- Security research stays general (Rules.md rule 16 and 18): no engagement evidence, client names or findings.

### A client in another business (D112)

ホテル山桜533 (T-00650) is Harbor Trading work. A client write may carry `frontmatter: {business: "harbor-trading"}` (a
business key or folder; never `shared`, `unsorted` or a client ID). The client keeps its ID, history and links; right
after the write the keeper moves it to `<Other business>/Clients/<group>/<ID> <name>` (a business without
`client_prefix`, such as Harbor Trading, gets its `Clients/` then) and sets `business` to the new Home's link. Until the
move happens (a taken target), the asked value stays: linking up never overwrites it. `findClient` looks in the ID's
own business first, then in every other one; a client's space is the business whose folder holds it. Cockpit links
stay keyed by the Acme ID. Writing `business` again (for example `acme`) moves it back.

Every folder and file the keeper makes (client, project and business folders, fact pages, regroup and re-file
targets) has a name Windows can hold, so Syncthing can sync it to every PC (`safeName` in `src/vault-layout.ts`):
the characters `< > : " / \ | ? *` and control characters become spaces, leading and trailing dots and spaces are
dropped ("T-01234 Acme Co.,Ltd." becomes "T-01234 Acme Co.,Ltd"), a reserved device name (CON, PRN, AUX, NUL,
COM1-9, LPT1-9, with or without an extension) gains "_", and a name is at most 80 characters. The client's display
name in the Overview's `name` (and first alias) stays exactly as given. Existing names Windows refuses are listed
by the nightly check-up ("Names Windows cannot sync") for a person or the keeper to rename.

Space keys did not change, so every caller keeps working: `agency` is business `acme` (its folder `Acme/`),
`business:<key>` is any business, `T-…` a Acme client, and `project:<repo>` a project space wherever it is filed.

### Graph links

Obsidian's graph draws only wikilinks (Bases embeds draw none), so the hierarchy is real links, by full path with a
label (`[[Acme/Home|Acme]]`): every client Overview has `business: "[[<Business>/Home|<Business>]]"` and a
"Part of …" line (`keeper:parent` block, under the title); every project Overview links to its business Home, or
to its client's Overview (`client:` too, for a client-nested repository), or to `Shared tools/Home` /
`Unsorted/Home`. Each business Home links up to the top Home ("Part of [[Home|all businesses]]") and down to
every client (`keeper:clients`, in the stage groups, Closed in a collapsed callout) and project (`keeper:projects`);
the top Home lists every business and Shared tools (`keeper:businesses`). Kept by each new space, the regroup and
the nightly check-up. The "Part of" line is its own block rather than inside `keeper:summary`, so a summary's
conflict check (hash of its block) never sees a keeper-made line; the business Home's stage counts are in their
own `keeper:stages` block under the summary for the same reason.

### Where a repository goes (D103)

1. Its Overview's front matter `business` (when a person or agent set it: a business key or folder, `shared`,
   `unsorted`, or a client ID to nest it there).
2. The settings mapping (`repos`, `client_repos`, `repo_aliases`, `shared`).
3. A guess: the repository's name, then its remote's owner/name, then words in its README (`readme`; the seeding PC
   reads the README and sends its guess with the seed). One business must match at a step.
4. Otherwise `Unsorted/Projects/<repo>`, with the reason in the Overview's `filed` front matter and a line on Needs
   attention.

Writing `business` into a project's Overview (vault write `frontmatter: {business: "crypto"}`, or by hand) re-files
it on the keeper's next tick (30 seconds): the folder moves, path-style links to it are rewritten, its `business`
becomes the link, and the Homes follow. A target folder that already exists is never overwritten: the move waits
and Needs attention lists it ("Waiting to be re-filed").

## Regrouping an older vault

On the keeper only (Syncthing carries the renames; never on a PC with only a synced copy):
`kokuban vault regroup` (dry run) and `kokuban vault regroup --apply`, or `node scripts/vault-regroup.mjs
--dry-run|--apply`. With the board running, the work runs inside its daemon (POST `/vault-regroup`, local only,
keeper only), so no write lands mid-move; the daemon must run this build. With the board stopped, the script does
it itself. Until the regroup, the keeper keeps writing the old places (Agency/, Clients/, Projects/), so nothing
splits, and Needs attention says the regroup is waiting.

- `Agency/*` → `Acme/*`; `Agency/Needs attention.md` → `Needs attention.md`; `Clients/*` → `Acme/Clients/*`;
  `Projects/<repo>` → where it goes (above).
- `Projects/acme-booking` is `ember-aoz` (`repo_aliases`): merged into
  `Acme/Clients/T-05555 …/Projects/ember-aoz`. Same-named pages are appended under "## Merged from acme-booking"
  (headings demoted, its keeper markers made plain, its front matter kept as a yaml block); the Overview gains its
  aliases, tags and remote (`merged_from`); other files move across. A full copy stays in
  `.keeper/regroup/merged/`.
- Path-style `[[links]]` into moved folders are rewritten in every note and base (front matter included); links by
  name keep working and are left alone, except that Acme's own pages' bare links to its pages (`[[Pipeline.base]]`)
  get their folder. A keeper block whose text changed gets a matching revision, so the next agent write is no
  false conflict. `file.inFolder(...)` filters follow; Pipeline.base's `groupOrder` becomes D104's stages.
- D104: client `stage: reply` → `replied` (and `engagement` → `engaging`), logged and recorded. Client summaries
  that are still the keeper's own are laid out (the "Last thing" line on its own, `**Ledger (…):**` → `### Ledger`);
  a person's edited summary is left alone and listed. `.obsidian/snippets/tobira.css` gains colours for the new
  stages (appended once, in a `keeper:stages` comment block; nothing else in the file changes).
- One `move` revision per move. A target that exists is skipped and reported; the source stays. Running it again
  changes nothing.

## Project spaces (D91)

Every repository a session opens gets a project space, made automatically (code: `src/vault-projects.ts`).

- On SessionStart, and whenever a session's cwd changes, the daemon finds the repository's main working tree
  from its `.git` files (a linked worktree, including Claude's `.claude/worktrees/*`, maps to its main repo).
  The space is `project:<folder name>`, made safe (ASCII letters, digits, `.`, `_`, `-`; otherwise `repo-<hash>`),
  filed by business (see Where a repository goes). An existing folder of that name anywhere in the layout, an
  alias's, or one whose Overview names the same `remote` is used instead, so a renamed or merged space is still found.
- No space for: a folder outside git, a bare repository, a repository at or above the home folder, the vault or
  a repository inside it, a PC without `vault` settings, or a vault folder that does not exist.
- When the local synced vault has no Overview for it, the daemon sends one `vault` write: kind
  `summary`, space `project:<repo>`, the first prose paragraph of `README.md` (at most 600 characters; a fallback
  line without one) and a `project` field `{remote, docs, business}` (`business`: this PC's guess from the README). Forwarded to the keeper as usual, or queued here while
  it is unreachable. The keeper applies such a seed only while the space has no Overview, so a second PC's seed
  is `unchanged` and nothing a person or an agent wrote is replaced.
- The Overview's front matter holds `repo`, `remote` (credentials removed), `created_by`, `created`; its body has
  the managed summary, links to `README.md`, `AGENTS.md` and `CLAUDE.md` where they exist (GitHub links for a
  GitHub remote, else the repo-relative path; never copies) and the space's pages.
- The hook never waits for it: lookups are cached for the daemon run, the write runs after the hook answers, at
  most once per repository per run, and a seed already in this PC's queue is not queued again. Only the daemon's
  own board does this; a test or CLI board never looks at the vault.
- Each business Home lists its project spaces (client-nested ones with their client) in its `keeper:projects`
  block, Shared tools and Unsorted theirs, refreshed when a space is made or re-filed and by the nightly check-up
  (a Home page without a block gets the section).
- SessionStart in such a repository adds one line: "This repo's shared context: <folder> in the vault.
  Read its Overview first; record decisions, rules and current direction there (vault write space="project:<repo>")."

## Working copies (D131)

To see whether another person had unpushed work, an agent had to start a remote agent on pc-b.
Now every PC records its git state of each repository in that repository's space (code: `src/vault-working-copies.ts`).

- **The page.** `<project space>/Facts/working-copies.md`, a `keeper:fact` block holding one table, one row per PC and
  folder: pc, folder, branch, upstream, ahead/behind (against the upstream as last fetched there), not on any remote
  (commits on local branches no remote-tracking branch contains, with the newest three as `branch: subject`), changed,
  untracked, stash, worktrees (`folder (branch, N changed)`), last commit, checked. Never file contents or diffs; a
  subject or branch name that looks like a credential is sent as `(withheld)`.
- **Reading it.** `vault(op="read", space="project:<repo>", page="Facts/working-copies")`. `peers` adds one line when
  another PC's row of the caller's repository has commits on no remote or uncommitted files, read from the local
  synced copy.
- **Collecting.** Local git only, without a window, prompt or index lock (`GIT_OPTIONAL_LOCKS=0`): `status
  --porcelain=v2 --branch`, `log --branches --not --remotes --source`, `log -1`, `stash list`, `worktree list`, and
  `status` per linked worktree (at most 12). The repository's main folder is the row; Claude worktrees and other
  linked worktrees are in its worktrees cell.
- **When.** A few seconds after a Claude session's shell command runs `git commit`, `push`, `merge`, `rebase`, `pull`,
  `reset`, `stash`, `checkout`, `switch`, `cherry-pick`, `am`, `worktree` or `branch` (the PostToolUse HTTP hook
  already carries the command; no git hook is installed in any repository), and an hourly sweep (the first ten minutes
  after start) over the child repositories of settings `vault.working_copies.roots` (default `~/githubprojects`) and
  every repository a session opened. An unchanged state is sent again only after six hours, so the page's "checked"
  time also shows whether a PC's Kokuban is running. Codex sessions are covered by the sweep.
- **Only repositories with a project space.** The sweep never makes spaces; a repository gets one when a session
  opens it (D91).
- **Writing.** A `fact` write carrying `working_copies` (page `Facts/working-copies`, space `project:<repo>`), sent
  like any write: applied on the keeper, forwarded from every other PC, queued while the keeper is away (a newer row
  for the same folder replaces the queued one). The keeper replaces only the verified sending PC's row for that folder,
  records a `fact` revision, and writes no `log.md` line and no History (machine state). A person's edit of the table
  is kept and recorded once as a conflict; the keeper stops updating it until a person empties or removes the block
  (like the sync line, D124). A folder that is gone keeps its last row, with its old "checked" time.
- **Settings.** `"vault": { …, "working_copies": { "roots": ["C:\\Users\\sam\\githubprojects"], "fetch": false } }`;
  `"working_copies": false` turns it off on that PC. `fetch: true` runs `git fetch --quiet --no-tags` before each
  sweep's collection (never on the hook path), so ahead/behind is current.

## Writes

`vault(op="write", kind, space | tobira_id, page?, section?, text, source, replaces?, accepted_by?, name?, frontmatter?)`.
`space` is `agency` (Acme), `business:<key>`, a client ID, or `project:<repo>`. The board fills in the author
(agent, PC, person).

| kind | goes to | notes |
|---|---|---|
| event | `Work log.md`, or `Communication.md` with page "Communication"; a client's ledger import goes to `Ledger.md` (below); a business's go to its `log.md` | appended; on a client it also sets `last_event` (not a ledger import) |
| fact | `Facts/<name>.md` (page "Facts/<name>" or section "<name>") | value in a `keeper:fact` block; replacing needs `replaces` = the current value; the old value moves to History with `valid_until` and `replaced_by` |
| decision | `Decisions.md` under "Accepted" | `section` is the topic; a different decision on a topic needs `replaces` = the current text |
| proposal | `Decisions.md` under "Proposed — not accepted" | never changes a fact or decision |
| summary | the `keeper:summary` block of `Overview.md` (a business: `Home.md`) | replaced; a client's is laid out ("Last thing" on its own line, `### Ledger`) and its "Last thing" line sets `last_event` |
| connection | `Decisions.md` under "Connected businesses", and `aliases` in `Overview.md` | see Connections |
| credential | `Credentials.md`, one table row per site and account | see Credentials (D99) |
| research | `<Business>/Research/<name or topic>.md` | topic, status, date, confidence, sources, related; see Boards, visuals and research (D126) |

- **Ledger imports** (2026-11-06): the ledger intake on keeper-pc writes each lead's `thread.md` from the acme repo as
  an event for Communication, "Ledger <lead>/thread.md — N dated sections:" and one GitHub link per section (one ran
  to about 4,000 characters), which buried the Slack days a person reads in Obsidian. The keeper files such an event
  (first line "Ledger … thread.md", or source "acme context/leads/…/thread.md"; or page "Ledger") on the client's
  `Ledger.md`, whole, and appends one line to Communication: the first line with a link to the entry
  (`→ [[…/Ledger#^r-<id>|on Ledger]] ^r-<id>`, the same id). The intake needs no change. Entries written before
  stay where they are: there is no recorded migration for moving entries between pages.
- Text the keeper cuts (log lines, sources, `last_event`, a README seed, and at read time the catchup lines, the
  3,000-character entry cut, search snippets and offset pages) is cut on whole characters (code points,
  `src/text-cut.ts`): a cut by UTF-16 units could split an emoji or a rare kanji and leave "�" in a note.
- A fact or decision that contradicts the accepted one (a different value without a matching `replaces`) is written
  as a proposal with a "Conflicts with" link and the caller is told.
- A person's edit inside a keeper block is detected by comparing the block's hash with the keeper's last revision
  of it. The person's text stays, a `conflict` revision is recorded, the agent's text is kept as a proposal, and
  `Needs attention.md` is refreshed.
- Every write appends `.keeper/revisions.jsonl` (who, when, space, page, section, source, kind, before/after
  hashes, request id), appends the space's `log.md`, refreshes the space's `index.md` block and updates
  `.keeper/index.json`. `index.md` blocks and the Overview's `keeper:facts` link list are derived and regenerated.
- A retried write (same request id) is answered with the first result, never applied twice.
- Text that looks like a credential is refused in every kind but `credential` (whose `value` alone is exempt; its
  other fields are still checked); nothing is written or queued. The check is know.ts `noSecrets`
  with the vault's `links` option: http(s) links (including their path, query and fragment) and bare 7–40
  character lowercase hex (Git commit ids) do not count as opaque secrets, so a GitHub blob link with a full commit
  hash and a long repository path passes. Still refused, links included: `password=`/`api_key=`/`token:` style
  key=value secrets, `sk-`, `ghp_`, `xox?-` and `AKIA` prefixes, a link with a password (`https://user:pass@…`),
  and outside links 32+ hex (other than a 7–40 commit id) or 64+ base64. Shared know-how keeps the strict check.

## Overview front matter

Any write on a client or project space may carry `frontmatter`, applied to the space's `Overview.md` together
with the write (the Pipeline and Care boards read it):

| field | value | how |
|---|---|---|
| `stage` | outreach, replied, sample-made, sample-sent, engaging, proposal, signed, building, launch, done, closed (D104) | replaced |
| `care_stage` | active, renewal, paused, ended | replaced |
| `aliases` | list of one-line names | merged, deduplicated case-insensitively, never removed by an agent write |
| `tags` | list of single words (a leading `#` is dropped) | merged, deduplicated, never removed |
| `cssclasses` | list of names (client Overviews carry `client`) | merged, never removed |
| `last_event` | one line: the last thing that happened (Kanban cards) | replaced; the keeper also keeps it from event and summary writes on a client, without a conflict check |
| `next_step` | one line: what happens next (the Pipeline card's footer, D120) | replaced |
| `status` | one short line (at most 60 characters): where a project stands, shown on its business's project status board (D126) | replaced |
| `business` | a project: a business key or folder, `shared`, `unsorted` or a client ID; a client: a business key or folder (D112) | replaced; re-files a project on the next tick, moves a client right after the write |

- Any other key, an invalid stage or business, an empty or malformed list, a client `business` that is not a
  business, or a business space is refused before anything is written. Every other front matter key and the whole body are kept; `updated` is set when something changed.
- A change is a `frontmatter` revision (with the hashes of the fields it set), a line in the space's `log.md`,
  and a refreshed hidden index (so a new alias finds the client at once). A stage change also logs
  `stage: <old> → <new> (<source>)`. Front matter that changes nothing is not recorded; a write whose text was
  `unchanged` but whose front matter changed counts as `written` on `Overview.md`.
- A field a person changed by hand since the keeper last set it (compared by hash with the keeper's latest
  revision that recorded the field, connections' alias additions included) follows the conflict rule: the person's
  value stays, a `conflict` revision (block `frontmatter:<field>`) and a proposal with the agent's value are
  recorded, and Needs attention lists it. Other fields in the same write still apply. The person's value is then the
  keeper's last known value, so the conflict is reported once and the next agent write applies on top of it.
- A field the keeper never set (for example one edited by hand during the first import) has nothing to compare
  against: the first keeper write to it applies.

## Connections (D90)

When two businesses turn out to be connected (same client, brand, sister shop or owner; for example 北光金属 and
白鷺堂), they are one client and acme-cockpit must never cold-email the other one.

`vault(op="write", kind="connection", tobira_id, name, email?, domain?, website?, evidence, text?, client_name?)`.
`name` is the other business; `evidence` (required) says where it was learned and is the source unless `source` is
given; `text` is an optional note; `client_name` names the client's folder when it does not exist yet. The keeper
appends one line to `Decisions.md` under "Connected businesses" (name, email, domains, website, evidence, author),
adds `name` to the Overview's `aliases` (so `vault client` finds the client by it), and appends the log, revisions
and index like every write. The same connection again is `unchanged`.

With `vault.cockpit` set, the keeper queues one link per value in `.keeper/queue/cockpit/` (never synced) and posts
each to `POST <url>/api/internal/brain/clients/<Acme ID>/links {kind, value, source}`: `alias` (the name), `email`
when given, and `domain` for `domain` and the website's host (lower case, without `www.`). It sends at once and on
every 30-second tick, oldest first:

- 200: done, removed from the outbox.
- 409 `{owner}`: the value already belongs to another client. Nothing is overridden: the keeper writes a proposal
  "Conflicts with <owner>" (linking the owner's Overview when it is in the vault) for a person, and it is listed
  on `Needs attention.md`.
- 400: set aside as `.refused` with the reason beside it, and listed on Needs attention (Queue backlog).
- Network failure, a missing token file, 401/403 or 5xx: kept, retried on the next tick.

## Credentials (D99)

Passwords live in the vault, where they are relevant, because only the vault's two owners can open it. This replaces the old rule 8 ("credentials never enter the vault").

`vault(op="write", kind="credential", space | tobira_id, site, account, value, url?, note?, source)`. `value` is the
password, exactly as given, one line. The keeper writes `<space>/Credentials.md` (made on the first write; the
agency's is `Acme/Credentials.md`) with a
keeper block holding one table: `site | account | password | url | note | updated`.

- One row per site and account (compared case-insensitively). A new value replaces that row in place; an omitted
  `url` or `note` keeps the row's current one. The same values again are `unchanged`, so an export can run twice.
- The password cell is an inline code span (pipes escaped), so Obsidian shows it exactly and a person can copy it.
- Rows a person added stay. A row a person changed by hand since the keeper last wrote it keeps the person's values:
  a `conflict` revision (block `credentials:<site>/<account>`) is recorded and Needs attention lists it. The agent's
  password is not written anywhere else (no proposal). The next write replaces the row.
- The revision (`kind: credential`, section `<site>/<account>`, hashes only) and the space's `log.md` line
  ("credential updated: <site>/<account>") never hold the value. `.keeper/index.json` is built from masked text.
- `read` masks every table's password column (`••••••`) unless `reveal=true`; `search` matches masked text only,
  so it cannot confirm a guessed password. Agents use credentials by name; a person reads them in Obsidian.
- `value` is refused on every other kind. A password that also appears in another field (note, source, url, …) is
  refused. A credential write is never queued: when the keeper is unreachable it fails and the caller retries.
- `Credentials.md` is never reported as an orphan page.
- `Rules.md` rule 8: a keeper-written `Rules.md` (first or second version) is replaced by the current page. A page a
  person edited is left alone; the keeper's first tick writes one proposal ("Rules.md rule 8") on
  `Acme/Decisions.md` instead (request id `rules-d99-credentials`, so it is never repeated). Likewise rule 11 (the
  business layout, D101) and "Needs attention.md" at the top: request id `rules-d101-layout`. Rule 4 now names the
  grouped folder and rule 12 lists the stage groups and the client business move (D112); the keeper's fourth
  `Rules.md`, unedited, is replaced by this page. An edited page is left alone (no proposal for rule 12).

### One-shot export

A one-shot export script (not part of this repository; it needs a built board and a keeper running a build with this kind)
reads every `computeruse/*` entry through the desktop tool's export bridge (`python -m harness.passwords export`, values
over stdin/stdout only) and maps each to a space (`src/vault-credentials.ts`):

1. Personal or unclear on its face → left out: loopback/localhost, `.invalid`/`.test`/example sites and accounts,
   test/demo/sample accounts, universities (`.ac.jp`, `.edu`), games.
2. A client: the account is a client email, the site or the account's email domain is a client domain, or a
   client's name/alias (6+ letters and digits) is a label of the site or email domain or the account's name — from
   the Overview front matter (`name`, `aliases`, `domain(s)`, `website(s)`, `email(s)`, …) and "Connected businesses"
   lines, and the email and website on the cockpit import's "Tenant / mailbox" summary line. One client found
   twice (two signals, or its old `Clients/` folder still beside `Acme/Clients/` while a regroup syncs) is one
   client; two different clients at once → left out.
3. `agency`: `@acme-agency.net` / `@acmeagency.io` accounts, `*.acme-agency.net` / `acmeagency.io` sites, a
   `acme` / `acmeagency` site label or account.
4. A project space whose folder name (letters and digits) is a label of the site or the account's name.
5. Anything else → left out, listed by name for the owner.

`--dry-run` prints `site/account → space` and the left-out names, and never fetches a value. The real run writes
each mapped entry through the local board's `vault` tool (POST `/mcp`), printing only states.

## Other PCs

A write is sent to the keeper over `/peer` as op `vault_write` (work trust). The keeper records the verified
calling PC, not the PC the request names. If the keeper cannot be reached, the write goes to this PC's
`.keeper/queue/` and the agent is told "queued"; the daemon retries every 30 seconds, oldest first. A refusal
(no trust, invalid write, not the keeper) is returned to the agent and never queued; a queued write that is later
refused is renamed `.refused` with the reason beside it, never deleted. Non-keeper PCs never write synced notes.

## Reads

Local and without network: `catchup`, `client` (Acme ID, name or alias → folder and Overview, with the catchup
call in its first line), `search`, `read` (page, optional space). Each ends with `based on: <page> (updated …)`.
Paths outside the vault or into dot folders are refused.

### Catching up (D132)

The vault must be easy for agents to read and be caught up with.
An agent needing a client's newest Slack messages got Communication.md oldest first, cut at 20000 characters before
the newest entries, and a search that named pages only. Code: `src/vault-catchup.ts`. All of it is read-time:
nothing is copied into a page, so no Overview churns on every event.

- **Entries.** A log-like page is a list of keeper entries: a line `- 2026-11-05 12:19Z …` (the write time, UTC),
  its indented lines, and `^r-<id>` at the end; the last `## ` heading above it is its section (Decisions:
  Accepted, Proposed, Connected businesses). A person's `- ` line without a time is an entry without a time.
- **`catchup`** (`space`: a client ID, `project:<repo>`, `agency`, `business:<key>`; or `query`: a client's name):
  the header (ID, name, stage, care stage, status, tags, updated), the folder, `next_step` when the summary does not
  already say it, the Overview's (a business: Home's) summary with its Ledger link list reduced to one line, then
  "Latest": the newest 8 entries across Communication, Work log and Decisions (a project: Work log and Decisions; a
  business: log and Decisions, a log line repeating a Decisions entry left out), each in one line of at most 400
  characters (no source line, links as their labels, link-only lines dropped, its `^r-<id>` kept), the calls for
  more, how many proposals wait on Decisions, the 12 facts changed last, and a client's own repositories.
  `since` shows only the entries since then (default limit 30 then); `limit` up to 100. T-05555 comes to about
  5,300 characters.
- **`read` of Communication, Work log, log or Ledger** (any space) shows the entries newest first, 10 at a time (`limit`,
  at most 100, and at most about 12,000 characters), each at most 3,000 characters (a longer one says the search
  that shows it whole). The header says how many of how many and their times; the end names the next call,
  `before="r-<id>"` of the last entry shown (an id, so entries written in the same minute are never skipped; a time
  works too). `since` keeps the entries since then. `offset` reads any page as written, 20,000 characters at a
  time, and every cut names the offset of the rest.
- **`search`** (query, optional `tobira_id`, `space`, `since`, `limit` pages): every scoped page whose name,
  headings or masked text has all the words. Each page comes with what matched: on a page with timed entries the
  entries holding every word (newest first, 5 per page), else up to 3 lines with the most words (`L<line>: …`).
  Pages with the newest matching entry come first. About 8,000 characters in all; when the matches are short
  enough together (an entry id as the query) they are shown whole. `since` keeps only entries since then.
- Times for `since` and `before`: `2d`, `12h`, `90m`, `1w` (ago), `2026-11-05`, `2026-11-05 12:19Z`, an ISO time,
  or `2026-11-05 21:09 JST`. A time without a zone is UTC, like the entries.
- Passwords stay masked in every view (the text is masked before anything is matched or shown).

## Nightly check-up

On the keeper, the first tick after 03:00 local each day links every Overview up to its parent, refreshes the
Homes (businesses, stage counts, clients by stage, projects), rebuilds `.keeper/index.json` and writes the
`keeper:attention` block of `Needs attention.md` (at the top of the vault; it covers every business):
conflicts and contradicting proposals of the last 30 days, boards a business without clients still has because a person changed them (D126), facts whose source file changed after `valid_from`,
orphan pages (no link from any page other than index/log), client folders without `tobira_id` or `aliases`,
clients without a stage (or with one that is not in D104's list), Unsorted projects, projects and clients waiting to
be re-filed (a client out of its group or asked business folder), loose notes outside any space, folder and file names Windows cannot sync (with the safe name to rename
each to), the old layout still waiting for its regroup, what the intakes report ("From the intakes": every `- ` line of a
business fact named `attention-<intake>`, such as `Acme/Facts/attention-chat-intake.md`, which an intake writes through
`vault write` like any fact), and this PC's queue backlog. No notifications.

## Heartbeat and startup

The daemon takes its single-instance lock (src/instance.ts: a local named pipe, with `daemon.lock` recording the pid)
before any board or keeper work; a second daemon exits at once, and the SessionStart hook never starts one while
the lock is held, even when the board is slow to answer. The daemon listens first and starts keeper ticks only
after that; a tick moves folders one at a time and yields between moves, refreshing the Homes and the index once
at the end (keeper-pc audit, 2026-11-05).

Every keeper tick writes `.keeper/heartbeat.json` (`ts`, `pid`, `pc`, `version`, `state` ticking/idle, keeper
`queue` and acme-cockpit outbox depth, folders `moving` so far, and the `last` tick's result: ok or its error,
duration, writes applied, folders moved and skipped). Only the keeper writes it; Syncthing carries it to the other
PCs. `vault(op="status")` and `kokuban status` show it, with "SILENT" when the last beat is over 12 minutes old (it is written at most every 5 minutes).
A failed tool call's usage-log line carries `error` (one line, passwords masked) and, for the vault, its `op`/`kind`.

## Sync status on Home (D124)

On the keeper (keeper-pc, the Syncthing hub), every tick reads the local Syncthing REST API and keeps one line in
the `keeper:sync` block right under the title of the top `Home.md` (src/vault-sync.ts). Each device then sees in
Obsidian whether the vault is in sync and the keeper is alive:

```
✅ In sync · keeper alive (beat just now) · checked 17:40 · desk-a, desk-b, pc-b up to date · [Syncthing](http://127.0.0.1:8384) ^sync-status
⚠️ pc-b 87% (213 files behind, last seen 14:02) · keeper alive (beat 3 min ago) · checked 17:40 · desk-a, desk-b up to date · [Syncthing](http://127.0.0.1:8384) ^sync-status
❌ Syncthing errors: 2 items failing on the keeper · keeper alive · checked 17:40 · … · [Syncthing](http://127.0.0.1:8384) ^sync-status
❌ Syncthing not reachable from the keeper · keeper alive · checked 17:40 · [Syncthing](http://127.0.0.1:8384) ^sync-status
```

- **Where it reads.** `config.xml` from settings `vault.syncthing` (the file or its folder), else
  `%LOCALAPPDATA%\Syncthing`, `%APPDATA%\Syncthing`, `~/.local/state/syncthing`, `~/.config/syncthing`,
  `~/Library/Application Support/Syncthing`. The GUI address (0.0.0.0 is read as loopback) and API key come from it
  per tick; the key is never logged or written. The folder is the one whose path is the vault path. Calls, 2 s each:
  `/rest/system/status` (this device's ID), `/rest/db/status` (state, needFiles, errors, pullErrors),
  `/rest/system/connections`, `/rest/db/completion?folder=&device=` for every other device sharing the folder, and
  `/rest/stats/device` (lastSeen). Device names come from `config.xml`. Any failure gives "Syncthing not reachable
  from the keeper"; a Syncthing with no folder at the vault path says so. `vault.syncthing: false` turns it off.
- **What it says.** ❌ for folder errors (or a stopped folder) or no Syncthing; ⚠️ when the keeper is still pulling
  or a device is behind (connected: "syncing"; offline: when it was last seen); otherwise ✅. A device that is offline
  but was complete is listed as "offline (last seen …)" without a warning. "keeper alive" carries the heartbeat's age
  ("SILENT" past 12 minutes).
- **How often it is written.** Each write is a synced file version, so like the heartbeat: a different status
  (ignoring the check time and heartbeat age) of another level (✅/⚠️/❌) is written at once, a change within the
  same level (a percentage moving) at most every 5 minutes, and an unchanged status once an hour. A "checked" time
  hours old therefore means the keeper is not running. Each write records a `status` revision (space `vault`, page
  `Home.md`, block `sync`), so the block's hash always matches and no false conflict is listed.
- **A person's edit.** Like any keeper block: their text is kept, one conflict is recorded (listed on Needs
  attention as `[[Home]] sync`), and the keeper stops updating it until a person empties or removes the block.
- **Bookmarks.** Once per vault (`.keeper/obsidian.json` remembers it), when `.obsidian/` exists: a "Sync status"
  bookmark (`{"type": "file", "path": "Home.md", "subpath": "#^sync-status"}`) and an "Open Syncthing" url bookmark
  (`http://127.0.0.1:8384`, each device's own Syncthing UI) are merged into `.obsidian/bookmarks.json` (core Bookmarks
  plugin: `items` of type file, folder, search, graph, url and group). The person's bookmarks are kept; one already
  there (also inside a group) is not added again; a file that does not parse is left alone. An existing
  `.obsidian/core-plugins.json` gets `bookmarks` turned on only when it is off (the object form or the older array
  form). After that, a person's removal or turning the plugin off is respected.
- `How this works.md` explains the line in "Keeping it healthy"; the keeper's own unedited page gains it.

## Session-start lines

When `vault` is configured, five lines tell the session to read "How this works" and `Rules.md` first, use the tool
for context and resolve clients by Acme ID; never to edit, move or delete files in the vault folder and to write only
through `vault write` (a "queued" write goes through by itself; passwords only as kind=credential); that proposals are
not decisions; to record connected businesses with kind=connection and the evidence; and to keep private matters,
raw transcripts and security engagement evidence out and cite "based on".

Every host hears them once per version of the text (`Session.vaultHeard`): Claude Code and Codex at SessionStart
(again on every resume), Kimi with its first prompt (its SessionStart hook is observation-only and cannot carry
context; the lines follow the intro and stay inline after `kimi-hook.mjs` moves the intro to its file), and any
session whose SessionStart was missed with its next prompt. The MCP `initialize` instructions carry one sentence
with the same pointer, for any host that reads server instructions.

## The rulebook (D118)

`Rules.md` rules 13–17 are the one rulebook for every agent on every PC: read "How this works" and the Overview
first and find clients by Acme ID; people edit in Obsidian, agents never touch the files and write only through the
keeper; the queue when the keeper is down; what stays out; Obsidian upkeep. The keeper's own unedited earlier page
(`RULES_V1`–`RULES_V6`) is replaced by the current one; an edited page gets one proposal (`rules-d118-rulebook`).
D126 rewrote rule 11 (boards only where a business has clients; Research/) and added rule 18 (research notes; security
research stays general); an edited page gets no proposal for these. "How this works" gained the research bullet and
"What each business Home shows", and README the new folder line; the keeper's previous unedited pages are replaced.

`How this works.md` at the top of the vault explains the same for a person: devices and folders, who writes, how
agents read and write, what stays out and how to keep Obsidian and Syncthing healthy. The keeper creates it once
and never overwrites it. `README.md` links to it (the keeper's previous README is refreshed).

Every PC's `.stignore` for the folder is the same: `/.keeper/queue`, `.keeper/queue`, `.obsidian/workspace*.json`,
`.trash`, `(?d).DS_Store`. `.stignore` itself is never synced, so a new PC needs it set by hand (the keeper adds only
the queue line).

## Not yet

Cockpit brain API lookups such as `clients/resolve` (clients are resolved from the vault's own front matter), other PCs' queue backlog on
the check-up page, the Kanban plugin's own board file, and the initial client import.
