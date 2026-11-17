/**
 * The vault's rulebook pages: Rules.md, README.md and "How this works" (docs/vault-keeper.md). Every version the
 * keeper ever wrote is kept, because a vault that still holds one unedited is upgraded by matching it exactly. Each
 * version is built from the data below, never by editing the version before it, so changing one rule's later text
 * cannot change an earlier page. tests/vault-rulebook-text.test.ts pins every version byte for byte.
 */
import { CLIENT_GROUPS, QUIET_TAG } from './vault-layout.js';

/** The page at the top of the vault that explains the whole system to a person (D118). */
export const HOW = 'How this works.md';

export const CONNECTION_RULE = 'When you learn two businesses are connected (same client, brand, sister shop or owner), record it ' +
  'with vault write kind=connection and the evidence.';
/** D99 replaces the old rule 8 ("credentials never enter the vault"). */
export const CREDENTIAL_RULE = 'Passwords live on a Credentials page in the space they belong to (decision D99). ' +
  'Agents write them only with kind=credential, never in other notes, and never echo them in chat.';
/** D101: the vault is grouped by business. */
export const LAYOUT_RULE = 'The vault is grouped by business (D101). Each business has its folder: Home, the Pipeline and Care boards, ' +
  'Decisions, Clients/ and Projects/. A client\'s own repositories sit in its folder\'s Projects/; tools every business uses are in ' +
  'Shared tools/; a repository nobody could place waits in Unsorted/ until its Overview\'s front matter names its business.';
/** The client groups as Rules.md lists them, from CLIENT_GROUPS (the one place they live). */
export const GROUP_RULE = CLIENT_GROUPS.map((x) => `${x.folder}${x.stages.length ? ` (${x.stages.join(', ')})` : x.folder.includes('Quiet') ? ` (tagged ${QUIET_TAG})` : ''}`).join(', ');
/**
 * D118: syncing and agent reading must be aligned. One rulebook
 * for every agent on every PC: how to read, who writes, what happens when the keeper is down, what stays out,
 * and how to keep Obsidian healthy.
 */
export const READ_RULE = 'Read before you answer: start at "How this works", then the space\'s Overview; find a client with ' +
  'vault op="client" by its Acme ID, never by guessing a folder name.';

// -- Rules.md -------------------------------------------------------------------------------------

/**
 * Rules.md versions: 1 first page, 2 connections, 3 D99 passwords, 4 D101 business layout, 5 D112 client groups,
 * 6 D118 one rulebook, 7 D126 boards only where a business has clients, and research, 8 research and learning notes in
 * Learning (2026-11-07, the current page).
 */
type RulesVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
const RULES_HEAD = '# Vault rules\n\nThis vault is shared by Alex, Sam and their agents, and kept by the Kokuban keeper on keeper-pc.\n\n';
/** Each rule's texts, numbered, with the version that introduced each text; a later text replaces the earlier one. */
const RULES: Array<[number, Array<[RulesVersion, string]>]> = [
  [1, [[1, 'The notes are the truth. The hidden index in .keeper/ is rebuilt from them and nobody edits it.\n']]],
  [2, [[1, 'Agents write only through the keeper (Kokuban `vault` tool, op "write"): events, facts, decisions,\n' +
    '   proposals and summaries. Every write records who, when, the source and a revision in .keeper/revisions.jsonl.\n']]],
  [3, [
    [1, 'Text between `<!-- keeper:… -->` markers belongs to the keeper. A person may still edit it: the keeper keeps\n' +
      '   the person\'s text, records a conflict and lists it on Agency/Needs attention.md. Everything else is free to edit.\n'],
    [4, 'Text between `<!-- keeper:… -->` markers belongs to the keeper. A person may still edit it: the keeper keeps\n' +
      '   the person\'s text, records a conflict and lists it on Needs attention.md. Everything else is free to edit.\n'],
  ]],
  [4, [
    [1, 'Clients are identified by their Acme ID (T-…). The folder is "<Acme ID> <name>"; the ID in Overview.md\'s\n' +
      '   front matter is what counts, so a folder may be renamed.\n'],
    [4, 'Clients are identified by their Acme ID (T-…). The folder is "<Business>/Clients/<Acme ID> <name>"; the ID in Overview.md\'s\n' +
      '   front matter is what counts, so a folder may be renamed.\n'],
    [5, 'Clients are identified by their Acme ID (T-…). The folder is "<Business>/Clients/<group>/<Acme ID> <name>"; the ID in Overview.md\'s\n' +
      '   front matter is what counts, so a folder may be renamed.\n'],
  ]],
  [5, [[1, 'A proposal is not a decision. Only a person\'s acceptance makes a decision. A fact or decision that contradicts\n' +
    '   an accepted one is written as a proposal with a "Conflicts with" link, never as a silent override.\n']]],
  [6, [[1, 'Facts are small notes in Facts/. A replaced value stays in its History with when it stopped being valid.\n']]],
  [7, [[1, 'Answers built from the vault end with a "based on" line naming the pages used and when they were updated.\n']]],
  [8, [
    [1, 'Credentials never enter the vault. The keeper refuses text that looks like one.\n'],
    [3, 'Passwords live on a Credentials page in the space they belong to (decision D99).\n' +
      '   Agents write them only with kind=credential, never in other notes, and never echo them in chat.\n'],
  ]],
  [9, [
    [1, 'The keeper checks the vault every night and lists what needs a person on Agency/Needs attention.md.\n'],
    [4, 'The keeper checks the vault every night and lists what needs a person on Needs attention.md, at the top of the vault.\n'],
  ]],
  [10, [[2, `${CONNECTION_RULE} The keeper adds the other name as an alias and tells acme-cockpit,\n` +
    '    which then never sends a first-time email to the connected business.\n']]],
  [11, [
    [4, 'The vault is grouped by business (D101). Each business has its folder: Home, the Pipeline and Care boards,\n' +
      '    Decisions, Clients/ and Projects/. A client\'s own repositories sit in its folder\'s Projects/; tools every\n' +
      '    business uses are in Shared tools/; a repository nobody could place waits in Unsorted/ until its Overview\'s\n' +
      '    front matter names its business.\n'],
    [7, 'The vault is grouped by business (D101). Each business has its folder: Home, Decisions, Projects/, Research/\n' +
      '    and, where it has clients, Clients/ with the Pipeline and Care boards (D126); its Home shows what suits it. A client\'s own repositories sit in its folder\'s Projects/; tools every\n' +
      '    business uses are in Shared tools/; a repository nobody could place waits in Unsorted/ until its Overview\'s\n' +
      '    front matter names its business.\n'],
  ]],
  [12, [[5, 'Inside each business\'s Clients/, a client\'s folder sits in the group of its stage, so the list reads as a work list:\n' +
    `    ${GROUP_RULE}.\n` +
    '    The keeper moves the folder when the stage or tags change. To move a client to another business, write its\n' +
    '    Overview front matter business (D112); it keeps its ID. Do not move client folders by hand.\n']]],
  [13, [[6, 'Read before you answer (D118): start at [[How this works]], then the space\'s Overview.md. Find a client with\n' +
    '    vault op="client" by its Acme ID; never guess a folder name. Current truth is the Overview, Facts/ and the\n' +
    '    Accepted decisions; log and Work log entries are history, and a proposal is only a suggestion.\n']]],
  [14, [[6, 'Who writes where: people edit any note in Obsidian on any device, except .keeper/ and keeper blocks (rule 3).\n' +
    '    Agents on every PC never edit, move, rename or delete files in this folder, even though Syncthing would let\n' +
    '    them: they read with vault op="client", "search" or "read" and write only with vault op="write". Only the\n' +
    '    keeper on keeper-pc writes; every other PC forwards its writes there.\n']]],
  [15, [[6, 'When the keeper cannot be reached, a write waits in that PC\'s own .keeper/queue (never synced) and is sent\n' +
    '    within 30 seconds of the keeper answering; the agent is told "queued". A password is never queued: try again\n' +
    '    later. A refused write is fixed, not retried as it was, and never worked around by editing files.\n']]],
  [16, [[6, 'What stays out: personal and private matters (health, family, personal money, private messages), other\n' +
    '    people\'s personal data beyond the business contact a client gave, raw chat or call transcripts, and security\n' +
    '    engagement evidence or findings detail (those stay in the engagement\'s own storage; Security/ holds status\n' +
    '    only). Passwords only as rule 8 says. When unsure, leave it out and ask a person.\n']]],
  [17, [[6, 'Keep Obsidian healthy: do not rename or move business, group or client folders (the keeper places them);\n' +
    '    never edit or delete .keeper/; settle a "sync-conflict" copy by merging it into the original and deleting the\n' +
    '    copy; .obsidian/ (the acme snippet, graph colours, Bases) is shared, so change it on one device and add\n' +
    '    community plugins only when both people agree; Obsidian Sync stays off, Syncthing carries the vault.\n']]],
  [18, [
    [7, 'Research (D126) is written with vault write kind=research: one note per subject in <Business>/Research/, with\n' +
      '    its topic, status (draft, current, superseded), date, confidence, sources and related notes, projects or clients.\n' +
      '    Related links are what the graph and the research map draw. Security research stays general: no engagement\n' +
      '    evidence, client names or findings (rule 16).\n'],
    [8, 'Research and learning notes are written with vault write kind=research: one note per subject, with its topic,\n' +
      '    status (draft, current, superseded), date, confidence, sources and related notes, projects or clients. With no\n' +
      '    space they go to Learning/Research/; a business, client or project space files them in that space\'s business (a\n' +
      '    project in no business: Learning). Related links are what the graph and the research map draw. Security research\n' +
      '    stays general: no engagement evidence, client names or findings (rule 16).\n'],
  ]],
];
/** Rules.md as the keeper wrote it at version v: each rule's latest text from v or before. */
export function rulesPage(v: RulesVersion): string {
  let out = RULES_HEAD;
  for (const [n, texts] of RULES) {
    const text = texts.filter(([since]) => since <= v).at(-1)?.[1];
    if (text !== undefined) out += `${n}. ${text}`;
  }
  return out;
}
/** The first Rules.md the keeper wrote; a vault that still has exactly this text gets the later rules. */
export const RULES_V1 = rulesPage(1);
/** The second Rules.md (the connection rule added). */
export const RULES_V2 = rulesPage(2);
/** The third Rules.md (D99's rule 8). */
export const RULES_V3 = rulesPage(3);
/** The fourth Rules.md: the business layout (D101) and Needs attention at the top of the vault. */
export const RULES_V4 = rulesPage(4);
/** The fifth Rules.md: clients grouped by stage inside Clients/, and moved to another business by front matter (D112). */
export const RULES_V5 = rulesPage(5);
/** The sixth Rules.md: one rulebook for every agent on every PC (D118). */
export const RULES_V6 = rulesPage(6);
/** The seventh Rules.md (D126): boards only where a business has clients, its Home's own visuals, and research notes. */
export const RULES_V7 = rulesPage(7);
/** The eighth Rules.md: research and learning notes go to Learning unless another business is named. */
export const RULES_PAGE = rulesPage(8);
/** Rules.md pages the keeper wrote itself; one of these, unedited, is replaced by the current page. */
export const KEEPER_RULES = [RULES_V1, RULES_V2, RULES_V3, RULES_V4, RULES_V5, RULES_V6, RULES_V7];

/** Proposals offered when a person edited Rules.md, so the keeper could not add a later rule itself. */
export const RULES_PROPOSAL_ID = 'rules-d99-credentials';
export const RULES_LAYOUT_PROPOSAL_ID = 'rules-d101-layout';
export const RULES_D118_PROPOSAL_ID = 'rules-d118-rulebook';

// -- README.md ------------------------------------------------------------------------------------

/** README.md pages the keeper (or the first setup) wrote; a stale one is replaced by the current page. */
export const OLD_README = '# Shared vault\n\nAcme Agency and project context. Read Rules.md first.\n';
/** README.md versions after the first: 2 before "How this works" (D118), 3 before D126, 4 the current page. */
function readmePage(v: 2 | 3 | 4): string {
  return '# Shared vault\n\nAlex and Sam\'s shared context (Obsidian), kept by the Kokuban keeper on keeper-pc.\n\n' +
    (v >= 3 ? '- [[How this works]]: start here: which devices sync, who may write, how agents read and write.\n' : '') +
    '- [[Home|Home]]: every business and the shared tools.\n' +
    (v >= 3 ? '- [[Rules]]: how people and agents write here.\n' : '- [[Rules]]: how people and agents write here; read it first.\n') +
    '- [[Needs attention]]: what the nightly check-up found.\n\n' +
    (v >= 4
      ? 'One folder per business (Home, Decisions, Projects/, Research/; Clients/ and the Pipeline and Care boards where it has clients).'
      : 'One folder per business (Home, Pipeline and Care boards, Decisions, Clients/, Projects/).') +
    ' A client\'s own repositories sit in ' +
    'its folder; Shared tools/ holds the tools every business uses; Unsorted/ holds repositories not placed yet.\n\n' +
    'Design records: kokuban/docs/vault-keeper.md.\n';
}
/** The second README.md, from before "How this works" (D118). */
export const README_V2 = readmePage(2);
/** The third README.md, from before D126 (every business with boards). */
export const README_V3 = readmePage(3);
export const README_PAGE = readmePage(4);

// -- How this works -------------------------------------------------------------------------------

/** D124: the sync line on Home, explained (added in version 2). */
const SYNC_HOW = '- The line at the top of [[Home]] is the sync status: keeper-pc asks its Syncthing which devices are up to date\n' +
  '  and writes it when that changes, else once an hour ("checked" is when). A "checked" time hours old means the keeper\n' +
  '  is not running. Its [Syncthing] link (and the "Open Syncthing" bookmark) opens this device\'s own Syncthing.\n';
/** D126: research, and what each business Home shows (added in version 3). */
const RESEARCH_HOW = '- **Research.** Research is its own kind of note (`kind=research`): one per subject in a business\'s Research/ folder,\n' +
  '  with its topic, status, date, confidence, sources and related notes. The related links are lines in the graph and\n' +
  '  on the business\'s research map (a Canvas).\n';
/** Where research and learning notes go when no other business is named (added in version 4, as Rules.md v8). */
const LEARNING_HOW = '  Research and learning notes go to Learning/Research/ unless another business\'s space is named.\n';
const HOMES_HOW = '\n## What each business Home shows\n\n' +
  'Only a business with clients has the Pipeline and Care boards (Acme, and Harbor Trading since it has a client). The others\n' +
  'show what suits them: Crypto its research (by topic, the most recent, the research map) and its accepted direction,\n' +
  'Security the status of its project spaces only (never engagement evidence), and every business its projects. Which\n' +
  'business has which boards and visuals is a setting (`boards`, `visuals`) on keeper-pc, so it can change.\n';
/**
 * "How this works" (D118): the vault explained for a person; the keeper writes it once and a person may edit it.
 * Versions: 1 the first page, 2 the sync line on Home (D124), 3 research and each Home's visuals (D126), 4 research
 * and learning notes in Learning (2026-11-07, current).
 */
function howPage(v: 1 | 2 | 3 | 4): string {
  return `# How this works

This folder is Alex and Sam's shared memory: every business, client and project, written by the two of you in
Obsidian and by your agents (Claude Code, Codex and Kimi) through Kokuban. [[Rules]] is the exact rulebook; this
page is the short version.

## Where the vault lives

| Device | Folder | Syncs by | Obsidian | Writes |
|---|---|---|---|---|
| keeper-pc (the hub) | C:\\Users\\sam\\shared-vault | Syncthing, to every PC | not installed | the keeper: all agent writes land here |
| Alex's PC | C:\\Users\\alex\\shared-vault | Syncthing via keeper-pc | yes | Alex in Obsidian; agents forward to the keeper |
| pc-b | C:\\Users\\pat\\shared-vault | Syncthing via keeper-pc | yes | Sam in Obsidian; agents forward to the keeper |
| Sam's MacBook | ~/shared-vault | Syncthing via keeper-pc | yes | Sam in Obsidian; agents forward to the keeper |
| iPhones | Remotely Save | WebDAV on keeper-pc (tailnet only) | yes | the person holding it |

Every folder is the same "Shared vault" (send and receive) with 30 days of trash-can versioning. Keeper-pc is the hub,
so a device sees the others' changes once keeper-pc has them.

## How agents use it

- **Reading.** An agent starts at this page and the space's Overview, finds a client by its Acme ID (T-…) with
  \`vault op="client"\`, and searches with \`vault op="search"\`. Answers end with a "based on" line naming the pages.
- **Writing.** Only through \`vault op="write"\`: ${v >= 3 ? 'an event, fact, decision, proposal, summary, connection, credential or research note.' : 'an event, fact, decision, proposal, summary, connection or credential.'}
  Each write is sent to the keeper on keeper-pc, which records who, when and the source. Agents never edit, move
  or delete files here directly, even though they could.
- **When keeper-pc is down.** The write waits in that PC's own queue and goes through by itself once keeper-pc answers.
  A password is never left waiting; the agent asks to try again later.
${v >= 3 ? RESEARCH_HOW : ''}${v >= 4 ? LEARNING_HOW : ''}- **Proposals.** An agent that disagrees with an accepted fact or decision writes a proposal. Only a person turns it
  into a decision.
- **Every session hears this.** Claude Code and Codex get the vault lines when a session starts, Kimi with its first
  prompt. All three have the same \`vault\` tool.
${v >= 3 ? HOMES_HOW : ''}
## What you can edit

Anything, in Obsidian, except the \`.keeper/\` folder. Text between \`<!-- keeper:… -->\` markers is the keeper's: you
may change it, and the keeper keeps your text and lists the clash on [[Needs attention]]. Passwords go only on a
space's Credentials page.

## What stays out

Personal and private matters, other people's personal data beyond the business contact a client gave, raw chat or call
transcripts, and security engagement evidence. When in doubt, leave it out.

## Keeping it healthy

${v >= 2 ? SYNC_HOW : ''}- Do not rename or move business, group ("1 🔥 Act now" …) or client folders: the keeper places them. To move a client,
  change its Overview's \`stage\` or \`business\`.
- A file named "… sync-conflict-…" means two devices changed one note at once: merge it into the original by hand, then
  delete the copy. [[Needs attention]] lists what the nightly check-up found.
- \`.obsidian/\` is shared: the acme snippet, graph colours and Bases look the same everywhere. Change settings on one
  device; agree before adding a community plugin. Workspace layout files stay per device and are not synced.
- Keep Obsidian Sync off: Syncthing carries the vault.
- Every PC ignores the same files: .keeper/queue, .obsidian/workspace*.json, .trash and .DS_Store.
- Syncthing on Windows starts from a scheduled task "Syncthing (shared vault)" that runs the WinGet Links path
  (…\\Microsoft\\WinGet\\Links\\syncthing.exe), so an upgrade keeps working. If an upgrade ever points it at a versioned
  folder, point it back at the Links path.
- Keeper-pc keeps a nightly Restic backup of the vault.
`;
}
/** The second "How this works" (D124's sync line, before D126). */
export const HOW_PAGE_V2 = howPage(2);
/** The third "How this works" (D126, before the Learning line). */
export const HOW_PAGE_V3 = howPage(3);
/** The current "How this works": research and learning notes go to Learning. */
export const HOW_PAGE = howPage(4);
/** "How this works" pages the keeper wrote; one of these, unedited, is replaced by the current page. */
export const KEEPER_HOW: string[] = [howPage(1), HOW_PAGE_V2, HOW_PAGE_V3];
