/**
 * D126: a pipeline makes no sense for some businesses; they need custom visuals instead. A business gets the Pipeline and Care boards only when it has
 * clients (boardsOf), and its Home shows the visuals its settings name (visualsOf), drawn here with Obsidian's own
 * parts only: Bases views embedded in the Home, a Canvas, callouts and the acme snippet. No community plugin.
 *
 * Pure apart from ensureResearchGraph (the shared graph colour group, written once): every function returns text
 * for the keeper to write.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BOARD_KINDS, allClients, allProjects, wiki, type BoardKind, type Business, type Grouping,
} from './vault-layout.js';
import { RESEARCH_INDEX, RESEARCH_TAG, mapName, researchDir, researchNotes } from './vault-research.js';

/**
 * What each business Home shows unless settings `visuals` say otherwise (D126). Acme keeps its Tendra pipeline
 * Home exactly as it was ("pipeline" alone with both boards is that classic Home).
 *
 * - pipeline: the Pipeline board (needs the pipeline board)
 * - clients: the Pipeline table, a simple client list (needs the pipeline board)
 * - projects: a status board of the business's project spaces (Projects.base)
 * - direction: the accepted direction from its projects' Overview summaries, as a callout
 * - research: its research notes by topic, and the most recent ones (Research.base)
 * - research-map: the Canvas of topics and their notes
 */
export const DEFAULT_VISUALS: Record<string, string[]> = {
  acme: ['pipeline'],
  'harbor-trading': ['clients', 'projects'],
  crypto: ['direction', 'research', 'research-map', 'projects'],
  security: ['projects'],
};
/** Any other business: its boards when it has clients, and its projects. */
export const OTHER_VISUALS = ['pipeline', 'projects'];

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const lf = (s: string): string => s.replace(/\r\n/g, '\n');
const abs = (root: string, rel: string): string => path.join(root, ...rel.split('/'));
const readText = (root: string, rel: string): string | null => { try { return lf(fs.readFileSync(abs(root, rel), 'utf8')); } catch { return null; } };
const exists = (root: string, rel: string): boolean => fs.existsSync(abs(root, rel));
const blockOf = (text: string, name: string): string => {
  const a = text.indexOf(`<!-- keeper:${name} -->`);
  const b = text.indexOf(`<!-- /keeper:${name} -->`);
  return a < 0 || b < a ? '' : text.slice(a + `<!-- keeper:${name} -->`.length, b).trim();
};

/**
 * The boards a business has: settings `boards` when given (also []), else both when it has clients (a client ID
 * prefix of its own, or client folders in its Clients/), else none.
 */
export function boardsOf(root: string, g: Grouping, b: Business): BoardKind[] {
  if (b.boards) return BOARD_KINDS.filter((k) => b.boards!.includes(k));
  return b.clientPrefix || allClients(root, g).some((c) => c.business === b) ? [...BOARD_KINDS] : [];
}
export const visualsOf = (b: Business): string[] => b.visuals ?? DEFAULT_VISUALS[b.key] ?? OTHER_VISUALS;
/** The Home from before D126 (the Boards list and the embedded Pipeline board): Acme's, unchanged. */
export const classicHome = (boards: BoardKind[], visuals: string[]): boolean =>
  boards.length === 2 && visuals.length === 1 && visuals[0] === 'pipeline';
export const boardFile = (k: BoardKind): string => (k === 'pipeline' ? 'Pipeline.base' : 'Care.base');

// -- bases --------------------------------------------------------------------------------------------

const chip = (prop: string): string =>
  `if(${prop}, html('<span class="tobira-stage" data-stage="' + escapeHTML(${prop}) + '">' + escapeHTML(${prop}) + '</span>'), "")`;
/** Research notes of a business: cards and a table grouped by topic, and the most recent ones. */
export function researchBase(dir: string): string {
  const sortByDate = '    sort:\n      - property: date\n        direction: DESC\n';
  return `filters:\n  and:\n    - file.inFolder("${researchDir(dir)}")\n    - file.hasTag("${RESEARCH_TAG}")\n    - file.name != "${RESEARCH_INDEX.replace(/\.md$/, '')}"\n` +
    `formulas:\n  status_chip: ${chip('status')}\n  confidence_chip: ${chip('confidence')}\n  source_count: if(sources, sources.length, 0)\n` +
    'properties:\n  note.topic:\n    displayName: Topic\n  note.status:\n    displayName: Status\n  note.date:\n    displayName: Date\n  note.confidence:\n    displayName: Confidence\n' +
    '  formula.status_chip:\n    displayName: Status\n  formula.confidence_chip:\n    displayName: Confidence\n  formula.source_count:\n    displayName: Sources\n' +
    'views:\n  - type: cards\n    name: Cards\n    groupBy:\n      property: topic\n      direction: ASC\n    order:\n      - file.name\n      - formula.status_chip\n' +
    `      - date\n      - formula.confidence_chip\n${sortByDate}` +
    '  - type: table\n    name: By topic\n    groupBy:\n      property: topic\n      direction: ASC\n    order:\n      - file.name\n      - formula.status_chip\n' +
    `      - date\n      - formula.confidence_chip\n      - formula.source_count\n${sortByDate}` +
    '  - type: table\n    name: Recent\n    filters:\n      and:\n        - status != "superseded"\n    order:\n      - file.name\n      - topic\n' +
    `      - formula.status_chip\n      - date\n${sortByDate}    limit: 8\n`;
}
/**
 * The business's project spaces: a card per project with its status (Overview front matter `status`), the last
 * thing and the next step, and a table. Front matter only, so nothing from a page's body (no engagement detail) shows.
 */
export function projectsBase(dir: string): string {
  return `filters:\n  and:\n    - file.name == "Overview"\n    - file.inFolder("${dir}/Projects")\n` +
    `formulas:\n  project: link(file.path, if(repo, repo, file.folder.split("/").slice(-1).join("")))\n  status_chip: ${chip('status')}\n  touched: if(updated, date(updated).relative(), "")\n` +
    'properties:\n  formula.project:\n    displayName: Project\n  formula.status_chip:\n    displayName: Status\n  note.last_event:\n    displayName: Last thing\n' +
    '  note.next_step:\n    displayName: Next step\n  formula.touched:\n    displayName: Updated\n' +
    'views:\n  - type: cards\n    name: Status\n    order:\n      - formula.project\n      - formula.status_chip\n      - last_event\n      - next_step\n      - formula.touched\n' +
    '  - type: table\n    name: Projects\n    groupBy:\n      property: status\n      direction: ASC\n    order:\n      - formula.project\n      - formula.status_chip\n' +
    '      - last_event\n      - next_step\n      - formula.touched\n';
}

// -- the Home's visuals block -------------------------------------------------------------------------

/** "Direction (accepted …):" and its points from each of the business's project Overview summaries. */
export function directions(root: string, g: Grouping, b: Business): Array<{ dir: string; repo: string; lines: string[] }> {
  return allProjects(root, g).filter((p) => p.place?.kind === 'business' && p.place.business === b).flatMap((p) => {
    const lines = blockOf(readText(root, `${p.dir}/Overview.md`) ?? '', 'summary').split('\n');
    const at = lines.findIndex((l) => /^\**\s*(accepted\s+)?direction\b/i.test(l.trim()));
    if (at < 0) return [];
    const out = [lines[at]!.trim()];
    for (let i = at + 1; i < lines.length && /^\s*[-*] /.test(lines[i]!); i++) out.push(lines[i]!.trimEnd());
    return [{ dir: p.dir, repo: p.repo, lines: out }];
  });
}

/**
 * The keeper:visuals block of a business Home: its pages on one line, then each visual in the order settings give.
 * Derived and regenerated (like the client and project lists). A visual that needs a board the business does not
 * have is left out.
 */
export function visualsBlock(root: string, g: Grouping, b: Business, dir: string): string {
  const boards = boardsOf(root, g, b);
  const visuals = visualsOf(b);
  const research = visuals.includes('research') || visuals.includes('research-map') || researchNotes(root, dir).length > 0;
  const rdir = researchDir(dir);
  const pages = [
    ...boards.map((k) => wiki(`${dir}/${boardFile(k)}#Board`, k === 'pipeline' ? 'Pipeline board' : 'Care board')),
    wiki(`${dir}/Decisions`, 'Decisions'),
    ...(research ? [wiki(`${rdir}/${RESEARCH_INDEX}`, 'Research index'), wiki(`${rdir}/${mapName(b.folder)}`, 'Research map')] : []),
    '[[Needs attention]]', '[[Rules]]',
  ];
  const out = [pages.join(' · ')];
  for (const v of visuals) {
    if (v === 'pipeline' && boards.includes('pipeline')) out.push(`## Pipeline\n![[${dir}/Pipeline.base#Board]]`);
    if (v === 'clients' && boards.includes('pipeline')) out.push(`## Client board\n![[${dir}/Pipeline.base#Pipeline]]`);
    if (v === 'projects') out.push(`## Project status\n![[${dir}/Projects.base#Status]]`);
    if (v === 'direction') {
      const d = directions(root, g, b);
      out.push(`## Direction\n${d.length ? d.map((x) => `> [!abstract] From ${wiki(`${x.dir}/Overview`, x.repo)}\n${x.lines.map((l) => `> ${l}`).join('\n')}`).join('\n\n')
        : '_No accepted direction yet: a project Overview summary\'s "Direction (accepted …):" lines show here._'}`);
    }
    if (v === 'research') {
      const n = researchNotes(root, dir);
      const topics = new Set(n.map((x) => x.topic)).size;
      out.push(`## Research\n${n.length ? `${n.length} note${n.length === 1 ? '' : 's'} in ${topics} topic${topics === 1 ? '' : 's'}.\n\n` : ''}` +
        `![[${dir}/Research.base#Cards]]\n\n### Recent\n![[${dir}/Research.base#Recent]]`);
    }
    // Obsidian draws an embedded canvas as its title only, so the map is a callout that opens it.
    if (v === 'research-map') {
      const n = researchNotes(root, dir);
      const topics = new Set(n.map((x) => x.topic)).size;
      out.push(`## Research map\n> [!example] ${wiki(`${rdir}/${mapName(b.folder)}`, `${b.folder} research map`)}\n> Topics as nodes, each linked to its notes; `+
        `related notes linked to each other (${topics} topic${topics === 1 ? '' : 's'}, ${n.length} note${n.length === 1 ? '' : 's'}). Open it to move things around: the keeper keeps your layout.`);
    }
  }
  return out.join('\n\n');
}
/** The Home of a business with visuals (new vaults): no Boards section, the visuals block, the lists below. */
export function visualsHome(b: Business, dir: string, boards: BoardKind[], parts: { dashboard: string; parent: string; block: (name: string) => string }): string {
  return `${parts.dashboard}# ${b.folder}\n\n${parts.parent}\n\n${parts.block('summary')}\n\n${parts.block('stages')}\n\n${parts.block('visuals')}\n\n` +
    `${boards.length ? `## Clients\n${parts.block('clients')}\n\n` : ''}## Projects\n${parts.block('projects')}\n`;
}
/** The pre-D126 Boards section exactly as the keeper wrote it (a Home that still has it is the keeper's own). */
export const classicBoards = (dir: string): string =>
  `## Boards\n- ${wiki(`${dir}/Pipeline.base#Board`, 'Pipeline board')}\n- ${wiki(`${dir}/Care.base#Board`, 'Care board')}\n` +
  `- ${wiki(`${dir}/Decisions`, 'Decisions')}\n- [[Needs attention]]\n- [[Rules]]\n\n![[${dir}/Pipeline.base#Board]]\n\n`;
/** The empty Clients section a business without clients had. */
export const emptyClients = '## Clients\n<!-- keeper:clients -->\n<!-- /keeper:clients -->\n\n';

// -- the acme snippet and the graph -----------------------------------------------------------------

export const RESEARCH_CSS_OPEN = '/* keeper:research (D126) */';
export const RESEARCH_CSS_CLOSE = '/* /keeper:research */';
export const RESEARCH_CSS = `/* keeper:research (D126) */
/* Research status and confidence chips (Research.base, Projects.base), research notes and the map on a Home. */
.tobira-stage[data-stage="draft"]      { --st-bg: var(--t-amber-bg);  --st-ink: var(--t-amber-ink);  --st-line: var(--t-amber-line); }
.tobira-stage[data-stage="current"]    { --st-bg: var(--t-green-bg);  --st-ink: var(--t-green-ink);  --st-line: var(--t-green-line); }
.tobira-stage[data-stage="superseded"] { --st-bg: var(--t-gray-bg);   --st-ink: var(--t-gray-ink);   --st-line: var(--t-gray-line); text-decoration: line-through; }
.tobira-stage[data-stage="high"]       { --st-bg: var(--t-teal-bg);   --st-ink: var(--t-teal-ink);   --st-line: var(--t-teal-line); }
.tobira-stage[data-stage="medium"]     { --st-bg: var(--t-blue-bg);   --st-ink: var(--t-blue-ink);   --st-line: var(--t-blue-line); }
.tobira-stage[data-stage="low"]        { --st-bg: var(--t-gray-bg);   --st-ink: var(--t-gray-ink);   --st-line: var(--t-gray-line); }
.dashboard .callout[data-callout="example"] { border-radius: 12px; }
.dashboard .callout[data-callout="abstract"] { border-radius: 12px; }
a.tag[href="#research"] { --tag-background: var(--t-violet-bg); --tag-color: var(--t-violet-ink); }
/* /keeper:research */
`;
/** Earlier keeper versions of the block; one of these, unedited, is replaced. */
const KEEPER_RESEARCH_CSS: string[] = [];
/** The snippet with the research block (appended once, an unedited earlier version replaced); null when nothing changes. */
export function withResearchCss(text: string): string | null {
  const s = lf(text);
  const a = s.indexOf(RESEARCH_CSS_OPEN);
  if (a < 0) return `${s.replace(/\n*$/, s.trim() ? '\n\n' : '')}${RESEARCH_CSS}`;
  const b = s.indexOf(RESEARCH_CSS_CLOSE, a);
  if (b < 0) return null;
  const have = `${s.slice(a, b + RESEARCH_CSS_CLOSE.length)}\n`;
  if (have === RESEARCH_CSS || !KEEPER_RESEARCH_CSS.includes(have)) return null;
  return s.slice(0, a) + RESEARCH_CSS + s.slice(b + RESEARCH_CSS_CLOSE.length).replace(/^\n/, '');
}

const GRAPH = '.obsidian/graph.json';
const DONE = '.keeper/obsidian.json';
/** Violet, like the snippet's research tag (0x7a53c5). */
export const RESEARCH_GROUP = { query: `tag:#${RESEARCH_TAG} path:Research`, color: { a: 1, rgb: 0x7a53c5 } };
/**
 * Once per vault, like the sync bookmarks (D124): the graph's "research" colour group, first so it wins over the
 * folder groups. The person's groups and settings stay; a group already finding the tag is not added again; a file
 * that does not parse is left alone. `.keeper/obsidian.json` remembers it, so a person's removal is respected.
 */
export function ensureResearchGraph(root: string, now: number): boolean {
  let done: Record<string, unknown> = {};
  try { done = JSON.parse(readText(root, DONE) ?? '{}') as Record<string, unknown>; } catch { /* rewritten below */ }
  if (done.graph_research || !exists(root, '.obsidian')) return false;
  let graph: Record<string, unknown> = {};
  const had = readText(root, GRAPH);
  if (had !== null) {
    try {
      const parsed = JSON.parse(had) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      graph = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
  }
  const groups = Array.isArray(graph.colorGroups) ? graph.colorGroups as Array<{ query?: unknown }> : [];
  let wrote = false;
  if (!groups.some((x) => str(x?.query).includes(`tag:#${RESEARCH_TAG}`))) {
    fs.writeFileSync(abs(root, GRAPH), `${JSON.stringify({ ...graph, colorGroups: [RESEARCH_GROUP, ...groups] }, null, 2)}\n`);
    wrote = true;
  }
  fs.mkdirSync(abs(root, '.keeper'), { recursive: true });
  fs.writeFileSync(abs(root, DONE), `${JSON.stringify({ ...done, graph_research: new Date(now).toISOString() })}\n`);
  return wrote;
}

