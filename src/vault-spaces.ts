/** The vault's layout: the pages the keeper lays out, spaces (client, project, business), their Overviews and the Homes. */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { thisPc } from './know.js';
import {
  CLIENT_GROUPS, CLOSED_GROUP, ROOT_HOME, SHARED, UNSORTED, agencyBusiness, allClients, allProjects, askedClientBusiness, businessByKey,
  businessDir, businessSpaceKey, canonicalRepo, clientBusiness, clientGroup, findClient as findClientIn, findProject, frontmatter,
  guessPlace, mappedPlace, newClientDir, parentLink, parseBusinessValue, parseClientDir, placeDir, placeOfDir, safeName, samePlace, subdirs,
  type Business, type Grouping, type Place,
} from './vault-layout.js';
import { BOARD_COLUMN_WIDTH, CARD_ORDER, SNIPPET_FILE, formulaLines, propertyLines, tendraBase, withTendraCss } from './vault-tendra.js';
import { RESEARCH_INDEX, canvasText, indexPage, mapName, researchCanvas, researchDir } from './vault-research.js';
import {
  boardFile, boardsOf, classicBoards, classicHome, emptyClients, ensureResearchGraph, projectsBase, researchBase, visualsBlock, visualsHome,
  visualsOf, withResearchCss,
} from './vault-visuals.js';
import {
  ACCEPTED, BUSINESS, CARE_STAGES, CLIENTS_HEADING, PROJECT, PROJECTS_HEADING, PROPOSED, STAGES, TOBIRA, abs, appendRevision, block, close, create,
  ensureBlock, fieldHash, fold, getBlock, groupingOf, lf, listOf, notes, open, put, read, setBlock, setFrontmatter, sha, str, wiki,
} from './vault-store.js';
import { ignoreQueue } from './vault-queue.js';
import { type WriteRequest, type WriteResult, applyWrite, newId, who } from './vault-write.js';
import {
  CREDENTIAL_RULE, HOW, HOW_PAGE, KEEPER_HOW, KEEPER_RULES, LAYOUT_RULE, OLD_README, README_PAGE, README_V2, README_V3, READ_RULE,
  RULES_D118_PROPOSAL_ID, RULES_LAYOUT_PROPOSAL_ID, RULES_PAGE, RULES_PROPOSAL_ID,
} from './vault-rulebook.js';

const DASHBOARD = '---\ncssclasses:\n  - dashboard\n---\n';
const ROOT_HOME_PAGE = `${DASHBOARD}# Home\n\nAlex and Sam's shared vault, one folder per business. Start at [[How this works]]; the rulebook is [[Rules]]; what needs a person is on ` +
  `[[Needs attention]].\n\n## Businesses\n${block('businesses')}\n`;
const UP = 'Part of [[Home|all businesses]]';

/**
 * Obsidian Bases over a business's client Overviews: the Kanban board and a table (D40, D57, D104). The board's
 * cards are Tendra tiles (D120, src/vault-tendra.ts).
 */
function pipelineBase(dir: string): string {
  const order = STAGES.filter((s) => s !== 'closed');
  return 'filters:\n  and:\n    - tobira_id\n    - file.name == "Overview"\n' + `    - file.inFolder("${dir}/Clients")\n` +
    'formulas:\n  client: if(name, name, tobira_id)\n' +
    '  stage_chip: html(\'<span class="tobira-stage" data-stage="\' + escapeHTML(stage) + \'">\' + escapeHTML(stage) + \'</span>\')\n' +
    '  meta: html(\'<span class="tobira-stage" data-stage="\' + escapeHTML(stage) + \'">\' + escapeHTML(stage) + \'</span><span class="tobira-id">\' + escapeHTML(tobira_id) + \'</span>\')\n' +
    '  touched: if(updated, date(updated).relative(), "")\n' + formulaLines().map((l) => `${l}\n`).join('') +
    'properties:\n  stage:\n    displayName: Stage\n  formula.client:\n    displayName: Client\n  formula.stage_chip:\n    displayName: Stage\n' +
    '  formula.meta:\n    displayName: Stage\n  formula.touched:\n    displayName: Updated\n  tobira_id:\n    displayName: ID\n' +
    '  last_event:\n    displayName: Last thing\n' + propertyLines().map((l) => `${l}\n`).join('') +
    'views:\n  - type: kanban\n    name: Board\n    filters:\n      and:\n        - stage != "closed"\n' +
    '    groupBy:\n      property: stage\n      direction: ASC\n    groupOrder:\n' + order.map((s) => `      - ${s}\n`).join('') +
    '    order:\n' + CARD_ORDER.map((p) => `      - ${p}\n`).join('') + `    columnWidth: ${BOARD_COLUMN_WIDTH}\n` +
    '  - type: table\n    name: Pipeline\n    filters:\n      and:\n        - stage != "closed"\n' +
    '    groupBy:\n      property: stage\n      direction: ASC\n    order:\n      - formula.client\n      - tobira_id\n      - formula.stage_chip\n' +
    '      - last_event\n      - next_step\n      - formula.touched\n      - file.name\n';
}
function careBase(dir: string): string {
  return 'filters:\n  and:\n    - tobira_id\n    - file.name == "Overview"\n    - care_stage\n' + `    - file.inFolder("${dir}/Clients")\n` +
    'formulas:\n  client: if(name, name, tobira_id)\n' +
    '  care_chip: html(\'<span class="tobira-stage" data-stage="\' + escapeHTML(care_stage) + \'">\' + escapeHTML(care_stage) + \'</span>\')\n' +
    '  touched: if(updated, date(updated).relative(), "")\n' +
    'properties:\n  care_stage:\n    displayName: Care stage\n  formula.client:\n    displayName: Client\n  formula.care_chip:\n    displayName: Care stage\n' +
    '  formula.touched:\n    displayName: Updated\n  tobira_id:\n    displayName: ID\n' +
    'views:\n  - type: kanban\n    name: Board\n    groupBy:\n      property: care_stage\n      direction: ASC\n    groupOrder:\n' +
    CARE_STAGES.filter((s) => s !== 'ended').map((s) => `      - ${s}\n`).join('') +
    '    order:\n      - formula.client\n      - formula.care_chip\n      - formula.touched\n    columnWidth: 240\n' +
    '  - type: table\n    name: Care\n    groupBy:\n      property: care_stage\n      direction: ASC\n    order:\n      - formula.client\n      - tobira_id\n' +
    '      - formula.care_chip\n      - formula.touched\n      - file.name\n';
}
/** The Pipeline board as the keeper wrote it from D101 until D120 (each one, unedited, is still the keeper's own). */
function pipelineBaseV1(dir: string): string {
  const order = STAGES.filter((s) => s !== 'closed');
  return 'filters:\n  and:\n    - tobira_id\n    - file.name == "Overview"\n' + `    - file.inFolder("${dir}/Clients")\n` +
    'formulas:\n  client: if(name, name, tobira_id)\n' +
    '  stage_chip: html(\'<span class="tobira-stage" data-stage="\' + escapeHTML(stage) + \'">\' + escapeHTML(stage) + \'</span>\')\n' +
    '  meta: html(\'<span class="tobira-stage" data-stage="\' + escapeHTML(stage) + \'">\' + escapeHTML(stage) + \'</span><span class="tobira-id">\' + escapeHTML(tobira_id) + \'</span>\')\n' +
    '  touched: if(updated, date(updated).relative(), "")\n' +
    'properties:\n  stage:\n    displayName: Stage\n  formula.client:\n    displayName: Client\n  formula.stage_chip:\n    displayName: Stage\n' +
    '  formula.meta:\n    displayName: Stage\n  formula.touched:\n    displayName: Updated\n  tobira_id:\n    displayName: ID\n' +
    '  last_event:\n    displayName: Last thing\n' +
    'views:\n  - type: kanban\n    name: Board\n    filters:\n      and:\n        - stage != "closed"\n' +
    '    groupBy:\n      property: stage\n      direction: ASC\n    groupOrder:\n' + order.map((s) => `      - ${s}\n`).join('') +
    '    order:\n      - formula.client\n      - formula.meta\n      - last_event\n      - formula.touched\n    columnWidth: 240\n' +
    '  - type: table\n    name: Pipeline\n    filters:\n      and:\n        - stage != "closed"\n' +
    '    groupBy:\n      property: stage\n      direction: ASC\n    order:\n      - formula.client\n      - tobira_id\n      - formula.stage_chip\n' +
    '      - last_event\n      - formula.touched\n      - file.name\n';
}
/**
 * D126: is this board file one the keeper wrote and nobody changed? The current text, or an earlier keeper version
 * (the D101 board, and that board as the D120 start-up moved it to the Tendra card). Line endings and a trailing
 * newline do not count.
 */
export function keeperBoard(text: string, dir: string, kind: 'pipeline' | 'care'): boolean {
  const norm = (s: string): string => lf(s).trimEnd();
  const known = kind === 'pipeline' ? [pipelineBase(dir), pipelineBaseV1(dir), tendraBase(pipelineBaseV1(dir)).text] : [careBase(dir)];
  return known.some((k) => norm(k) === norm(text));
}
/** The Home a business had before D126: the Boards list and the Pipeline board embedded (Acme's, unchanged). */
const classicHomePage = (b: Business, dir: string): string => `${DASHBOARD}# ${b.folder}\n\n${block('parent', UP)}\n\n${block('summary')}\n\n${block('stages')}\n\n` +
  `${classicBoards(dir)}${CLIENTS_HEADING}\n${block('clients')}\n\n${PROJECTS_HEADING}\n${block('projects')}\n`;
/**
 * A business's own pages, in its folder (dir: the folder, the old Agency/ for Acme until regrouped). D126: the
 * Pipeline and Care boards only where it has them (boardsOf); its Home is the classic one (Acme) or one with a
 * keeper:visuals block.
 */
function businessLayout(root: string, g: Grouping, b: Business, dir: string): Record<string, string> {
  const boards = boardsOf(root, g, b);
  const home = classicHome(boards, visualsOf(b)) ? classicHomePage(b, dir)
    : visualsHome(b, dir, boards, { dashboard: DASHBOARD, parent: block('parent', UP), block: (name) => block(name) });
  return {
    [`${dir}/Home.md`]: home,
    ...(boards.includes('pipeline') ? { [`${dir}/Pipeline.base`]: pipelineBase(dir) } : {}),
    ...(boards.includes('care') ? { [`${dir}/Care.base`]: careBase(dir) } : {}),
    [`${dir}/Decisions.md`]: DECISIONS,
    [`${dir}/index.md`]: `# ${b.folder} index\n\n${block('index')}\n`,
    [`${dir}/log.md`]: `# ${b.folder} log\n\n`,
  };
}
/** The pages a business's visuals need, made once (D126); the research index and map also come with a research write. */
function visualFiles(b: Business, dir: string): Record<string, string> {
  const v = visualsOf(b);
  const rdir = researchDir(dir);
  const research = v.includes('research') || v.includes('research-map');
  return {
    ...(v.includes('projects') ? { [`${dir}/Projects.base`]: projectsBase(dir) } : {}),
    ...(research ? {
      [`${dir}/Research.base`]: researchBase(dir),
      [`${rdir}/${RESEARCH_INDEX}`]: indexPage(dir, b.folder),
      [`${rdir}/${mapName(b.folder)}`]: canvasText(researchCanvas(dir, b.folder, [])),
    } : {}),
  };
}
const SHARED_HOME = `# ${SHARED}\n\n${block('parent', UP)}\n\nTools every business uses.\n\n${PROJECTS_HEADING}\n${block('projects')}\n`;
const UNSORTED_HOME = `# ${UNSORTED}\n\n${block('parent', UP)}\n\nRepositories the keeper could not place. Set \`business\` in a project's ` +
  'Overview front matter (a business, "shared", or a client ID such as T-05555) and the keeper files it on its next run.\n\n' +
  `${PROJECTS_HEADING}\n${block('projects')}\n`;

/** Create what is missing; never overwrite. Safe to run on every start. */
export function ensureLayout(root: string): void {
  const g = groupingOf(root);
  create(root, 'README.md', README_PAGE);
  create(root, 'Rules.md', RULES_PAGE);
  create(root, HOW, HOW_PAGE);
  create(root, ROOT_HOME, ROOT_HOME_PAGE);
  // The keeper's own unchanged earlier Rules.md gains the later rules; a person's edited page is left alone
  // (proposeRules offers them the new rules instead). A README still saying the vault is empty is refreshed.
  if (KEEPER_RULES.includes(read(root, 'Rules.md') ?? '')) put(root, 'Rules.md', RULES_PAGE);
  const readme = read(root, 'README.md') ?? '';
  if (readme === OLD_README || readme === README_V2 || readme === README_V3 || /Nothing here yet/.test(readme)) put(root, 'README.md', README_PAGE);
  if (KEEPER_HOW.includes(read(root, HOW) ?? '')) put(root, HOW, HOW_PAGE);
  for (const b of g.businesses) {
    const dir = businessDir(root, g, b);
    for (const [rel, text] of Object.entries({ ...businessLayout(root, g, b, dir), ...visualFiles(b, dir) })) create(root, rel, text);
    retireBoards(root, g, b, dir);
    visualHome(root, g, b, dir);
  }
  ensureTendra(root, g);
  create(root, `${SHARED}/Home.md`, SHARED_HOME);
  fs.mkdirSync(abs(root, '.keeper/queue'), { recursive: true });
  ignoreQueue(root);
  if (fs.existsSync(abs(root, '.obsidian'))) {
    try { ensureResearchGraph(root, Date.now()); } catch { /* next start */ }
  }
}
/**
 * D126: a business without boards loses the keeper's own Pipeline.base and Care.base: each unedited one moves to
 * .trash/<folder>/ (never deleted; Syncthing ignores .trash, so the copy stays on the keeper) with a `move` revision.
 * A board a person changed stays where it is and is listed on Needs attention.
 */
function retireBoards(root: string, g: Grouping, b: Business, dir: string): string[] {
  const have = boardsOf(root, g, b);
  const moved: string[] = [];
  for (const kind of ['pipeline', 'care'] as const) {
    if (have.includes(kind)) continue;
    const rel = `${dir}/${boardFile(kind)}`;
    const text = read(root, rel);
    if (text === null || !keeperBoard(text, dir, kind)) continue;
    let to = `.trash/${rel}`;
    if (fs.existsSync(abs(root, to))) to = `.trash/${dir}/${boardFile(kind).replace(/\.base$/, '')} ${new Date().toISOString().replace(/[:.]/g, '-')}.base`;
    fs.mkdirSync(path.dirname(abs(root, to)), { recursive: true });
    fs.renameSync(abs(root, rel), abs(root, to));
    appendRevision(root, { id: newId(), ts: new Date().toISOString(), kind: 'move', state: 'trashed', space: businessSpaceKey(g, b), page: boardFile(kind),
      section: to, author: `keeper@${thisPc()}`, source: `D126: ${b.folder} has no clients, so no ${kind} board (moved to ${to})`, before: sha(text), after: sha('') });
    moved.push(rel);
  }
  return moved;
}
/**
 * D126: a business Home that is not the classic one gets its keeper:visuals block. The keeper's own Boards section
 * (unchanged since it was written) is replaced by it, and the empty Clients section of a business without clients
 * goes; a Home a person reworked keeps everything and gains the block above its lists. The block is then drawn.
 */
function visualHome(root: string, g: Grouping, b: Business, dir: string): void {
  const rel = `${dir}/Home.md`;
  const text = read(root, rel);
  const boards = boardsOf(root, g, b);
  if (text === null || classicHome(boards, visualsOf(b))) return;
  let t = text;
  if (getBlock(t, 'visuals') === null) {
    if (t.includes(classicBoards(dir))) t = t.replace(classicBoards(dir), `${block('visuals')}\n\n`);
    else {
      const before = t.split('\n').some((l) => l.trim() === CLIENTS_HEADING) ? CLIENTS_HEADING : PROJECTS_HEADING;
      t = ensureBlock(t, 'visuals', { before });
    }
  }
  if (!boards.length && !allClients(root, g).some((c) => c.business === b)) t = t.replace(emptyClients, '');
  t = setBlock(t, 'visuals', visualsBlock(root, g, b, dir));
  if (t !== text) put(root, rel, t);
}
/**
 * D120: every business's Pipeline board in the Tendra card (an unedited keeper card list only) and the acme
 * snippet's keeper:tendra block. The snippet itself is the visual pass's file; a vault without it is left alone.
 * D126: only where the business has a pipeline board (a person's kept board elsewhere is left as it is), and the
 * snippet's keeper:research block.
 */
function ensureTendra(root: string, g: Grouping): void {
  for (const b of g.businesses) {
    if (!boardsOf(root, g, b).includes('pipeline')) continue;
    const rel = `${businessDir(root, g, b)}/Pipeline.base`;
    const text = read(root, rel);
    if (text === null) continue;
    const next = tendraBase(text);
    if (next.board !== 'already' && next.text !== text) put(root, rel, next.text);
  }
  const css = read(root, SNIPPET_FILE);
  const next = css === null ? null : withTendraCss(css);
  if (next !== null) put(root, SNIPPET_FILE, next);
  const css2 = read(root, SNIPPET_FILE);
  const next2 = css2 === null ? null : withResearchCss(css2);
  if (next2 !== null) put(root, SNIPPET_FILE, next2);
}
/** The notes the layout makes (for the hidden index). */
export function layoutNotes(root: string): string[] {
  const g = groupingOf(root);
  return ['README.md', 'Rules.md', HOW, ROOT_HOME, `${SHARED}/Home.md`, `${UNSORTED}/Home.md`,
    ...g.businesses.flatMap((b) => {
      const dir = businessDir(root, g, b);
      return [...Object.keys(businessLayout(root, g, b, dir)), `${researchDir(dir)}/${RESEARCH_INDEX}`].filter((r) => r.endsWith('.md'));
    })]
    .filter((rel) => fs.existsSync(abs(root, rel)));
}
/**
 * A Rules.md a person edited is never overwritten: when it does not carry the D99 credential rule or the D101
 * layout yet, the keeper writes one proposal each on Acme's Decisions page for a person to accept (once; the
 * fixed request ids (vault-rulebook.ts) make a later call a duplicate).
 */
export function proposeRules(root: string, now: number, pc: string): WriteResult | null {
  const text = read(root, 'Rules.md');
  if (text === null || text === RULES_PAGE || KEEPER_RULES.includes(text)) return null;
  let out: WriteResult | null = null;
  if (!text.includes('kind=credential')) {
    out = applyWrite(root, {
      request_id: RULES_PROPOSAL_ID, kind: 'proposal', space: 'agency', section: 'Rules.md rule 8',
      text: `Rules.md was edited by a person, so the keeper did not change it. Replace rule 8 ("Credentials never enter the vault") with: ${CREDENTIAL_RULE}`,
      source: 'D99: put the password where it is relevant',
      author: { agent: 'keeper', pc },
    }, now);
  }
  if (!text.includes('grouped by business')) {
    out = applyWrite(root, {
      request_id: RULES_LAYOUT_PROPOSAL_ID, kind: 'proposal', space: 'agency', section: 'Rules.md layout',
      text: `Rules.md was edited by a person, so the keeper did not change it. Say "Needs attention.md" (now at the top of the vault) ` +
        `instead of "Agency/Needs attention.md", and add: ${LAYOUT_RULE}`,
      source: 'D101: the agency belongs inside the project layout',
      author: { agent: 'keeper', pc },
    }, now);
  }
  if (!text.includes('How this works')) {
    out = applyWrite(root, {
      request_id: RULES_D118_PROPOSAL_ID, kind: 'proposal', space: 'agency', section: 'Rules.md rulebook',
      text: `Rules.md was edited by a person, so the keeper did not change it. Add rules 13 to 17 (reading, who writes, ` +
        `the queue, what stays out, Obsidian upkeep) as the keeper's current Rules.md has them; the first is: ${READ_RULE}`,
      source: 'D118: syncing and agent reading must be aligned',
      author: { agent: 'keeper', pc },
    }, now);
  }
  return out;
}
export interface Space {
  key: string; dir: string; kind: 'business' | 'client' | 'project';
  business?: Business; tobiraId?: string; name?: string;
  /** A project space not made yet: where it will go and why (the mapping, a guess, or Unsorted). */
  place?: Place; why?: string;
}

const dirs = subdirs;
/** A client's folder by its ID (T-…), in its business's Clients/ (or the old top-level Clients/). */
export function findClient(root: string, id: string): string | null {
  return findClientIn(root, groupingOf(root), id);
}

export function spaceFor(root: string, req: { space?: string; tobira_id?: string; project?: WriteRequest['project']; text?: string }): Space {
  const g = groupingOf(root);
  const s = str(req.space) || str(req.tobira_id);
  const business = (b: Business): Space => ({ key: businessSpaceKey(g, b), dir: businessDir(root, g, b), kind: 'business', business: b });
  if (!s || s.toLowerCase() === 'agency') return business(agencyBusiness(g));
  const named = BUSINESS.exec(s);
  if (named) {
    const b = businessByKey(g, named[1]!.toLowerCase());
    if (!b) throw new Error(`no business "${named[1]}": the businesses are ${g.businesses.map((x) => x.key).join(', ')}`);
    return business(b);
  }
  if (TOBIRA.test(s)) {
    const dir = findClientIn(root, g, s);
    // The business whose folder holds it (D112: a client can move to another business), else the one its ID names.
    const b = (dir ? parseClientDir(g, dir)?.business : undefined) ?? clientBusiness(g, s);
    if (!b) throw new Error(`no business gives client IDs starting "${s.split('-')[0]}-"`);
    return { key: s, dir: dir ?? '', kind: 'client', business: b, tobiraId: s, name: dir ? path.posix.basename(dir).slice(s.length).trim() : undefined };
  }
  const project = PROJECT.exec(s);
  if (project && !/^\.+$/.test(project[1]!)) {
    const repo = project[1]!;
    const found = findProject(root, g, repo, req.project?.remote ?? '');
    if (found) return { key: `project:${path.posix.basename(found)}`, dir: found, kind: 'project', place: placeOfDir(g, found) ?? undefined };
    // A new space: the settings mapping, the seeding PC's guess (it read the README), else the keeper's own guess.
    const hint = str(req.project?.business) ? parseBusinessValue(root, g, str(req.project?.business)) : null;
    const guess = guessPlace(g, { name: repo, remote: req.project?.remote, readme: req.project ? req.text : undefined });
    const place = mappedPlace(g, repo) ?? (hint && hint.kind !== 'unsorted' ? hint : null) ?? guess.place;
    const why = mappedPlace(g, repo) ? 'settings mapping' : hint && hint.kind !== 'unsorted' ? 'guessed from its README' : guess.why;
    const dir = placeDir(root, g, place, canonicalRepo(g, repo));
    return { key: `project:${path.posix.basename(dir)}`, dir, kind: 'project', place, why };
  }
  throw new Error('space must be "agency" (Acme), "business:<key>", a client ID (T-…) or "project:<repo>"');
}

/**
 * What a space's Overview links up to (D101, the graph request): front matter links, which Obsidian draws
 * as graph edges, and the visible "Part of …" line. A client links to its business's Home; a project to its
 * business's Home, its client's Overview (client-nested), or the Shared tools / Unsorted Home.
 */
export function parentOf(root: string, dir: string): { fields: Record<string, string>; line: string; client: boolean } | null {
  const g = groupingOf(root);
  const home = (b: Business): string => wiki(`${businessDir(root, g, b)}/Home`, b.folder);
  // A client folder: <Business>/Clients/<group>/<ID> <name>, <Business>/Clients/<ID> <name>, or the old Clients/<ID> <name>.
  const c = parseClientDir(g, dir);
  if (c && !c.rest.length) return { fields: { business: home(c.business) }, line: `Part of ${home(c.business)}`, client: true };
  const place = placeOfDir(g, dir);
  // The old top-level Projects/: its place is decided by the regroup, so it links nowhere yet.
  if (!place) return null;
  if (place.kind === 'client' && c) {
    const client = c.dir;
    const up = wiki(`${client}/Overview`, c.name);
    return { fields: { business: home(place.business), client: up }, line: `Part of ${up} · ${home(place.business)}`, client: false };
  }
  const link = parentLink(root, g, place);
  return { fields: { business: link }, line: `Part of ${link}`, client: false };
}
/**
 * Keep a space's Overview linked up: its parent front matter, cssclasses [client] on a client, and the
 * "Part of" block. A `business` value that asks for a different place (a re-file still waiting, or blocked) is
 * left alone. Records a frontmatter revision for the fields it set, so a later agent write is no false conflict.
 */
export function linkUp(root: string, dir: string, now: number, pc = 'keeper'): boolean {
  const rel = `${dir}/Overview.md`;
  const text = read(root, rel);
  const up = parentOf(root, dir);
  if (text === null || !up) return false;
  const g = groupingOf(root);
  const fm = frontmatter(text);
  const set: Record<string, string | string[]> = {};
  const here = placeOfDir(g, dir);
  const asked = !up.client && here ? parseBusinessValue(root, g, str(fm.business), str(fm.client)) : null;
  // A client asked to move to another business (D112) keeps the asked value until the move.
  const clientAsked = up.client ? askedClientBusiness(root, g, fm.business) : null;
  const waiting = (asked !== null && here !== null && !samePlace(asked, here)) ||
    (clientAsked !== null && clientAsked !== parseClientDir(g, dir)?.business);
  for (const [k, v] of Object.entries(up.fields)) if (str(fm[k]) !== v && !(waiting && (k === 'business' || k === 'client'))) set[k] = v;
  if (up.client) {
    const classes = listOf(fm.cssclasses);
    if (!classes.some((c) => fold(c) === 'client')) set.cssclasses = [...classes, 'client'];
  }
  let after = Object.keys(set).length ? setFrontmatter(text, set) : text;
  if ((getBlock(after, 'parent') ?? null) !== up.line) after = setBlock(after, 'parent', up.line);
  if (after === text) return false;
  put(root, rel, after);
  if (Object.keys(set).length) {
    const key = spaceKeyOf(root, dir);
    const after2 = frontmatter(after);
    appendRevision(root, { id: randomBytes(4).toString('hex'), ts: new Date(now).toISOString(), kind: 'frontmatter', state: 'written',
      space: key, page: 'Overview.md', section: Object.keys(set).join(', '), block: 'frontmatter', author: `keeper@${pc}`,
      source: 'D101: links up to the business', before: sha(text), after: sha(after),
      fields: Object.fromEntries(Object.keys(set).map((f) => [f, fieldHash(after2, f)])) });
  }
  return true;
}
/** The write space a folder is: a client's ID, "project:<folder>", or a business's space. */
export function spaceKeyOf(root: string, dir: string): string {
  const g = groupingOf(root);
  const parts = dir.split('/');
  if (parts.length >= 2 && parts.at(-2) === 'Projects') return `project:${parts.at(-1)}`;
  // A client folder, flat or in its stage group.
  const c = parseClientDir(g, dir);
  if (c && !c.rest.length) {
    const id = /^([A-Z]{1,4}-\d+)(?: |$)/.exec(c.name)?.[1] ?? str(frontmatter(read(root, `${dir}/Overview.md`) ?? '').tobira_id);
    if (id) return id;
  }
  const b = parts[0] === 'Agency' ? agencyBusiness(g) : g.businesses.find((x) => x.folder === parts[0]);
  return b ? businessSpaceKey(g, b) : dir;
}

export function clientOverview(root: string, space: Space, id: string, name: string, now: number): string {
  const pages = ['What we made', 'Work log', 'Communication', 'Decisions'];
  const up = parentOf(root, space.dir);
  return `---\ntobira_id: ${JSON.stringify(id)}\nname: ${JSON.stringify(name)}\naliases: ${JSON.stringify([name])}\n` +
    `${up ? `business: ${JSON.stringify(up.fields.business)}\n` : ''}cssclasses: ${JSON.stringify(['client'])}\n` +
    `updated: ${JSON.stringify(new Date(now).toISOString())}\n---\n# ${name}\n\n${up ? `${block('parent', up.line)}\n\n` : ''}${block('summary')}\n\n` +
    `## Pages\n${pages.map((p) => `- ${wiki(`${space.dir}/${p}`, p)}`).join('\n')}\n\n## Facts\n${block('facts')}\n`;
}
export const DECISIONS = `# Decisions\n\n${ACCEPTED}\n\n${PROPOSED}\n`;

/** A GitHub remote's web address, so the Overview can link to the repository's own files. */
function webOf(remote: string): string {
  const m = /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote);
  return m ? `https://github.com/${m[1]}/${m[2]}` : '';
}
export function projectOverview(root: string, space: Space, now: number, req?: WriteRequest): string {
  const repo = path.posix.basename(space.dir);
  const pages = ['Work log', 'Decisions'].map((p) => `- ${wiki(`${space.dir}/${p}`, p)}`).join('\n');
  const up = parentOf(root, space.dir);
  const links = up ? Object.entries(up.fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}\n`).join('') : '';
  const filed = space.why && space.why !== 'settings mapping' ? `filed: ${JSON.stringify(space.why)}\n` : '';
  const head = `${up ? `${block('parent', up.line)}\n\n` : ''}${block('summary')}\n\n`;
  const seed = req?.project;
  if (!seed) {
    return `---\nrepo: ${JSON.stringify(repo)}\n${links}${filed}---\n# ${repo}\n\n${head}## Pages\n${pages}\n\n## Facts\n${block('facts')}\n`;
  }
  const web = webOf(seed.remote);
  // Links to the repository's files, never copies: they stay the source of truth for the code.
  const docs = seed.docs.map((d) => `- ${web ? `[${d}](${web}/blob/HEAD/${d})` : `\`${d}\``}`).join('\n');
  return `---\nrepo: ${JSON.stringify(repo)}\nremote: ${JSON.stringify(seed.remote)}\ncreated_by: ${JSON.stringify(who(req.author))}\n` +
    `created: ${JSON.stringify(new Date(now).toISOString())}\n${links}${filed}---\n# ${repo}\n\n${head}` +
    `## In the repository\n${docs || '- (no README.md, AGENTS.md or CLAUDE.md yet)'}\n\n` +
    `Keep this space current as you work: context in the summary, decisions and rules in Decisions, events in the Work log.\n\n` +
    `## Pages\n${pages}\n\n## Facts\n${block('facts')}\n`;
}

/** The space's folder, made on its first write. A new client needs its name. made: it did not exist before. */
export function ensureSpace(root: string, space: Space, name: string, now: number, req?: WriteRequest): Space & { made?: boolean } {
  let made = false;
  if (space.kind === 'client' && !space.dir) {
    // The display name stays as given (front matter `name`); only the folder is made Windows-safe ("…Co.,Ltd." → "…Co.,Ltd").
    // eslint-disable-next-line no-control-regex
    const display = name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!safeName(display)) throw new Error(`no client folder for ${space.tobiraId}: pass name to create it`);
    // Straight into the group of the stage this write sets (No stage without one); a business move follows the write.
    const group = clientGroup(req?.frontmatter?.stage, req?.frontmatter?.tags);
    space = { ...space, dir: newClientDir(root, groupingOf(root), space.tobiraId!, display, group, space.business), name: display };
    made = create(root, `${space.dir}/Overview.md`, clientOverview(root, space, space.tobiraId!, display, now));
    create(root, `${space.dir}/What we made.md`, '# What we made\n\n');
    create(root, `${space.dir}/Work log.md`, '# Work log\n\n');
    create(root, `${space.dir}/Communication.md`, '# Communication\n\n');
    create(root, `${space.dir}/Decisions.md`, DECISIONS);
    fs.mkdirSync(abs(root, `${space.dir}/Facts`), { recursive: true });
  }
  if (space.kind === 'project') {
    if (space.place?.kind === 'unsorted') create(root, `${UNSORTED}/Home.md`, UNSORTED_HOME);
    made = create(root, `${space.dir}/Overview.md`, projectOverview(root, space, now, req));
    create(root, `${space.dir}/Decisions.md`, DECISIONS);
  }
  create(root, `${space.dir}/index.md`, `# Index\n\n${block('index')}\n`);
  create(root, `${space.dir}/log.md`, '# Log\n\n');
  return { ...space, made };
}

// -- revisions ------------------------------------------------------------------------------------

const label = (dir: string): string => path.posix.basename(dir);
/**
 * Clients in the same groups as their folders (CLIENT_GROUPS), "Act now" first, each with its count and every
 * client's stage; No stage after Done; Closed folded into a collapsed callout (real wikilinks: Bases embeds draw no
 * graph edges).
 */
export function clientsBlock(clients: Array<{ dir: string; stage: string; tags?: unknown }>): string {
  const by = new Map<string, string[]>();
  for (const c of [...clients].sort((a, b) => label(a.dir).localeCompare(label(b.dir)))) {
    const group = clientGroup(c.stage, c.tags);
    by.set(group, [...(by.get(group) ?? []), `- ${wiki(`${c.dir}/Overview`, label(c.dir))}${c.stage ? ` · ${c.stage}` : ''}`]);
  }
  // CLIENT_GROUPS is in the Home's order already (No stage last).
  const shown = CLIENT_GROUPS.filter((x) => x.folder !== CLOSED_GROUP).filter((x) => by.has(x.folder)).map((x) => `**${x.label}** (${by.get(x.folder)!.length})\n${by.get(x.folder)!.join('\n')}`);
  const closed = by.get(CLOSED_GROUP);
  const closedLabel = CLIENT_GROUPS.find((x) => x.folder === CLOSED_GROUP)!.label;
  return [...shown, ...(closed ? [`> [!note]- ${closedLabel} (${closed.length})\n${closed.map((l) => `> ${l}`).join('\n')}`] : [])].join('\n\n');
}
/** Stage counts in D104's order, for the business Home. */
export function stagesBlock(clients: Array<{ stage: string }>): string {
  const count = (s: string): number => clients.filter((c) => c.stage === s).length;
  const other = [...new Set(clients.map((c) => c.stage).filter((s) => s && !STAGES.includes(s)))].sort();
  const none = clients.filter((c) => !c.stage).length;
  return `**Clients by stage** (${clients.length}): ${[...STAGES, ...other].map((s) => `${s} ${count(s)}`).join(' · ')}${none ? ` · no stage ${none}` : ''}`;
}
/**
 * Every Home's derived blocks (D101): the top Home lists the businesses and Shared tools; each business Home has
 * its stage counts, its clients by stage and its projects (client-nested ones too, with their client); Shared
 * tools and Unsorted list theirs. Returns the pages it changed.
 */
export function refreshHomes(root: string): string[] {
  const g = groupingOf(root);
  const touched: string[] = [];
  const update = (rel: string, change: (text: string) => string): void => {
    const text = read(root, rel);
    if (text === null) return;
    const after = change(text);
    if (after !== text) { put(root, rel, after); touched.push(rel); }
  };
  const projects = allProjects(root, g).filter((p) => fs.existsSync(abs(root, `${p.dir}/Overview.md`)));
  const projectLine = (p: (typeof projects)[number]): string => {
    const remote = str(frontmatter(read(root, `${p.dir}/Overview.md`) ?? '').remote);
    const client = p.place?.kind === 'client' ? parseClientDir(g, p.dir)?.dir ?? '' : '';
    return `- ${wiki(`${p.dir}/Overview`, p.repo)}${client ? ` — for ${wiki(`${client}/Overview`, label(client))}` : ''}${remote ? ` — ${remote}` : ''}`;
  };
  const clients = allClients(root, g).map((c) => {
    const fm = frontmatter(read(root, `${c.dir}/Overview.md`) ?? '');
    return { ...c, stage: str(fm.stage), tags: fm.tags };
  });
  const lines: string[] = [];
  const plural = (n: number, w: string): string => (n ? `${n} ${w}${n === 1 ? '' : 's'}` : '');
  for (const b of g.businesses) {
    const dir = businessDir(root, g, b);
    const mine = projects.filter((p) => (p.place && (p.place.kind === 'business' || p.place.kind === 'client') && p.place.business === b) ||
      (!p.place && b === agencyBusiness(g)));
    const theirs = clients.filter((c) => c.business === b);
    // D126: a business without clients or boards has no Clients section; its visuals block is redrawn.
    const withClients = theirs.length > 0 || boardsOf(root, g, b).length > 0;
    update(`${dir}/Home.md`, (text) => {
      let t = ensureBlock(text, 'parent', {});
      t = ensureBlock(t, 'stages', { after: 'summary' });
      if (withClients || getBlock(t, 'clients') !== null) t = ensureBlock(t, 'clients', { before: PROJECTS_HEADING, heading: CLIENTS_HEADING });
      t = ensureBlock(t, 'projects', { heading: PROJECTS_HEADING });
      t = setBlock(t, 'parent', UP);
      t = setBlock(t, 'stages', theirs.length ? stagesBlock(theirs) : '');
      if (getBlock(t, 'clients') !== null) t = setBlock(t, 'clients', clientsBlock(theirs));
      if (getBlock(t, 'visuals') !== null) t = setBlock(t, 'visuals', visualsBlock(root, g, b, dir));
      return setBlock(t, 'projects', mine.map(projectLine).join('\n'));
    });
    const n = [plural(theirs.length, 'client'), plural(mine.length, 'project')].filter(Boolean).join(' · ');
    lines.push(`- ${wiki(`${dir}/Home`, b.folder)}${n ? ` — ${n}` : ''}`);
  }
  for (const [folder, kind, page] of [[SHARED, 'shared', SHARED_HOME], [UNSORTED, 'unsorted', UNSORTED_HOME]] as const) {
    const mine = projects.filter((p) => p.place?.kind === kind);
    if (kind === 'unsorted' && mine.length && create(root, `${folder}/Home.md`, page)) touched.push(`${folder}/Home.md`);
    if (!fs.existsSync(abs(root, `${folder}/Home.md`))) continue;
    update(`${folder}/Home.md`, (text) => setBlock(setBlock(ensureBlock(ensureBlock(text, 'parent', {}), 'projects', { heading: PROJECTS_HEADING }), 'parent', UP),
      'projects', mine.map(projectLine).join('\n')));
    const n = plural(mine.length, 'project');
    lines.push(`- ${wiki(`${folder}/Home`, folder)}${n ? ` — ${n}` : ''}`);
  }
  update(ROOT_HOME, (text) => setBlock(ensureBlock(text, 'businesses', { heading: '## Businesses' }), 'businesses', lines.join('\n')));
  return touched;
}
/** The Overview's facts block: a link down to each fact note. */
export function refreshFacts(root: string, dir: string): string | null {
  const overview = `${dir}/Overview.md`;
  const text = read(root, overview);
  if (text === null) return null;
  const facts = notes(root, `${dir}/Facts`).map((p) => `- ${wiki(p, path.posix.basename(p, '.md'))}`);
  const after = setBlock(text, 'facts', facts.join('\n'));
  if (after !== text) put(root, overview, after);
  return overview;
}

// -- writing --------------------------------------------------------------------------------------
