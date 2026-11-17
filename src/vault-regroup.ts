/**
 * D101–D104 migration: an existing vault (Agency/, Clients/, Projects/ at the top) is regrouped by business, on
 * the keeper only (Syncthing carries the renames to the other PCs). `kokuban vault regroup` / scripts/vault-regroup.mjs.
 *
 * - Agency/* → Acme/*, Agency/Needs attention.md → Needs attention.md; Clients/* → Acme/Clients/*;
 *   Projects/<repo> → its business, client, Shared tools or Unsorted (settings mapping, front matter, then a guess).
 * - A repository that is another's alias (acme-booking is ember-aoz) is merged into it: every file kept, the
 *   same-named pages appended under "Merged from <repo>", and a full copy left in .keeper/regroup/merged/.
 * - Path-style [[links]] into moved folders are rewritten everywhere ([[name]] links resolve by name and are left
 *   alone), keeper blocks whose text changed get a matching revision (so no false conflict), Bases filters and
 *   the Pipeline's stage order are updated, old stages are renamed (D104), client summaries are laid out, every
 *   Overview links up to its parent, and the Homes and Needs attention are refreshed.
 * - One revision per move. A target that already exists is never overwritten: that move is skipped and reported.
 *   Running it again changes nothing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAttention } from './vault-checkup.js';
import { ensureLayout, linkUp, refreshHomes, spaceKeyOf } from './vault-spaces.js';
import { OLD_STAGES, STAGES, appendRevision, getBlock, groupingOf, lastFor, put, read, rebuildIndex, refreshSpaceIndex, revisions, setBlock, setFrontmatter, sha, stamp, type Revision } from './vault-store.js';
import { layoutSummary } from './vault-write.js';
import {
  ATTENTION, QUIET_GROUP, QUIET_TAG, SHARED, UNSORTED, agencyBusiness, allClients, allProjects, askedClientBusiness, canonicalRepo, clientBusiness, clientGroup,
  findClient, frontmatter, guessPlace, isClientGroup, isDir, legacy, mappedPlace, parseBusinessValue, parseClientDir, placeName, placeOfDir,
  safeLeaf, safeName, samePlace, subdirs, type Grouping, type Place,
} from './vault-layout.js';
import { randomBytes } from 'node:crypto';

export interface Move { from: string; to: string; kind: 'move' | 'merge'; why: string }
export interface Skipped extends Move { reason: string }
export interface RegroupReport {
  applied: boolean;
  moves: Move[];
  skipped: Skipped[];
  /** Pages whose path-style links were rewritten. */
  rewritten: string[];
  /** Client stages renamed (D104): "T-… name: reply → replied". */
  stages: string[];
  /** Client Overviews whose summary was laid out ("Last thing" on its own line, the ledger under a heading). */
  summaries: string[];
  /** Summaries a person edited by hand: left as they are. */
  keptSummaries: string[];
  bases: string[];
  css: string;
  /** Overviews that gained their parent links. */
  linked: number;
  /** Client folders moved (or, in a dry run, to be moved) into their stage group or business; once the old layout is gone. */
  clients: Move[];
  clientsSkipped: Skipped[];
  lines: string[];
}

const abs = (root: string, rel: string): string => path.join(root, ...rel.split('/'));
const exists = (root: string, rel: string): boolean => fs.existsSync(abs(root, rel));
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const lf = (s: string): string => s.replace(/\r\n/g, '\n');
function entries(root: string, rel: string): fs.Dirent[] {
  try { return fs.readdirSync(abs(root, rel), { withFileTypes: true }).filter((d) => !d.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name)); }
  catch { return []; }
}
/** Every file under a folder (vault-relative), dot folders left out. */
function files(root: string, rel = ''): string[] {
  return entries(root, rel).flatMap((d) => {
    const sub = rel ? `${rel}/${d.name}` : d.name;
    return d.isDirectory() ? files(root, sub) : [sub];
  });
}

// -- where a project goes ----------------------------------------------------------------------------

/** A place's folder in the regrouped layout (the client folder as it will be after the moves). */
function targetDir(root: string, g: Grouping, place: Place, repo: string, after: (rel: string) => string): string {
  if (place.kind === 'shared') return `${SHARED}/Projects/${repo}`;
  if (place.kind === 'unsorted') return `${UNSORTED}/Projects/${repo}`;
  if (place.kind === 'business') return `${place.business.folder}/Projects/${repo}`;
  const client = findClient(root, g, place.client);
  return client ? `${after(client)}/Projects/${repo}` : `${place.business.folder}/Projects/${repo}`;
}
/** Where an old Projects/<repo> belongs: its own front matter, the settings mapping, then the guess (D103). */
function placeOfOld(root: string, g: Grouping, repo: string): { place: Place; why: string } {
  const fm = frontmatter(read(root, `Projects/${repo}/Overview.md`) ?? '');
  // A plain value is a person's or agent's choice; a link is only what the keeper wrote before the regroup.
  const asked = str(fm.business) && !str(fm.business).startsWith('[[') ? parseBusinessValue(root, g, str(fm.business), str(fm.client)) : null;
  if (asked) return { place: asked, why: 'its Overview front matter' };
  const mapped = mappedPlace(g, repo);
  if (mapped) return { place: mapped, why: 'settings mapping' };
  const summary = getBlock(read(root, `Projects/${repo}/Overview.md`) ?? '', 'summary') ?? '';
  return guessPlace(g, { name: repo, remote: str(fm.remote), readme: summary });
}

/** The moves that regroup an old vault, with the ones that cannot happen (their target exists). */
export function planRegroup(root: string): { moves: Move[]; skipped: Skipped[] } {
  const g = groupingOf(root);
  const acme = agencyBusiness(g);
  const moves: Move[] = [];
  const skipped: Skipped[] = [];
  const add = (move: Move): void => {
    // Every PC must be able to hold the new name: "Clients/T-… Foo Co.,Ltd." moves to "Acme/Clients/T-… Foo Co.,Ltd".
    const m = move.kind === 'move' ? { ...move, to: safeLeaf(move.to) } : move;
    if (m.kind === 'move' && exists(root, m.to)) skipped.push({ ...m, reason: `${m.to} already exists` });
    else moves.push(m);
  };
  for (const d of entries(root, 'Agency')) {
    add(d.name === ATTENTION ? { from: `Agency/${d.name}`, to: ATTENTION, kind: 'move', why: 'Needs attention covers the whole vault (D101)' }
      : { from: `Agency/${d.name}`, to: `${acme.folder}/${d.name}`, kind: 'move', why: `the agency is ${acme.folder} (D101)` });
  }
  // Old client folders, flat or already in a stage group (each client by itself, so a group that exists is no obstacle).
  const oldClients = entries(root, 'Clients').flatMap((d) => d.isDirectory() && isClientGroup(d.name)
    ? entries(root, `Clients/${d.name}`).map((x) => ({ d: x, rel: `${d.name}/${x.name}` })) : [{ d, rel: d.name }]);
  for (const { d, rel } of oldClients) {
    const b = (d.isDirectory() ? clientBusiness(g, d.name.split(' ')[0]!) : undefined) ?? acme;
    add({ from: `Clients/${rel}`, to: `${b.folder}/Clients/${rel}`, kind: 'move', why: `a ${b.folder} client` });
  }
  // A client folder's place after the moves above.
  const after = (rel: string): string => {
    const m = moves.find((x) => rel === x.from || rel.startsWith(`${x.from}/`));
    return m ? m.to + rel.slice(m.from.length) : rel;
  };
  const projects = entries(root, 'Projects');
  for (const d of projects.filter((x) => !x.isDirectory())) {
    add({ from: `Projects/${d.name}`, to: `${UNSORTED}/${d.name}`, kind: 'move', why: 'a loose note in Projects/ (listed on Needs attention)' });
  }
  const dirs = projects.filter((x) => x.isDirectory()).map((x) => x.name);
  // Canonical repositories first, so an alias merges into a folder that has moved already.
  for (const repo of [...dirs].sort((a, b) => Number(canonicalRepo(g, a) !== a) - Number(canonicalRepo(g, b) !== b) || a.localeCompare(b))) {
    const canon = canonicalRepo(g, repo);
    if (canon.toLowerCase() !== repo.toLowerCase()) {
      const into = moves.find((m) => m.from.toLowerCase() === `projects/${canon.toLowerCase()}`)?.to ??
        allProjects(root, g).find((p) => p.place && p.repo.toLowerCase() === canon.toLowerCase())?.dir;
      if (into) { moves.push({ from: `Projects/${repo}`, to: into, kind: 'merge', why: `${repo} is ${canon} (settings repo_aliases)` }); continue; }
    }
    const { place, why } = placeOfOld(root, g, repo);
    add({ from: `Projects/${repo}`, to: targetDir(root, g, place, repo, after), kind: 'move', why: `${placeName(place)}: ${why}` });
  }
  return { moves, skipped };
}

// -- links ---------------------------------------------------------------------------------------------

/** Rewrite path-style [[links]] (front matter included) whose target is inside a moved folder or file. */
export function rewriteLinks(text: string, map: Array<[string, string]>, bare: Map<string, string> = new Map()): string {
  const sorted = [...map].sort((a, b) => b[0].length - a[0].length);
  return text.replace(/(!?\[\[)([^\]|#\n]+)((?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\])/g, (whole, open: string, target: string, rest: string) => {
    const t = target.trim();
    const noExt = t.replace(/\.md$/, '');
    if (!t.includes('/')) {
      const q = bare.get(noExt.toLowerCase());
      return q ? `${open}${q}${rest}` : whole;
    }
    for (const [from, to] of sorted) {
      if (noExt === from || noExt.startsWith(`${from}/`)) return `${open}${to}${noExt.slice(from.length)}${t.endsWith('.md') ? '.md' : ''}${rest}`;
    }
    return whole;
  });
}
/** A file moved or merged: its text changed by the regroup, keeper blocks given a matching revision. */
function syncBlocks(root: string, rel: string, before: string, after: string, now: number, pc: string, all: Revision[]): void {
  const dir = path.posix.dirname(rel);
  const space = path.posix.basename(dir) === 'Facts' ? path.posix.dirname(dir) : dir;
  const page = rel.slice(space.length + 1);
  const key = spaceKeyOf(root, space);
  for (const name of ['summary', 'fact']) {
    const was = getBlock(before, name);
    const now2 = getBlock(after, name);
    if (was === null || now2 === null || was === now2) continue;
    const last = lastFor(all, key, page, name);
    // Only a block that is still the keeper's own: a person's pending edit keeps its conflict.
    if ((last?.after ?? sha('')) !== sha(was)) continue;
    const r: Revision = { id: randomBytes(4).toString('hex'), ts: new Date(now).toISOString(), kind: name === 'summary' ? 'summary' : 'fact', state: 'written',
      space: key, page, block: name, author: `keeper@${pc}`, source: 'D101 regroup: links to moved folders', before: sha(was), after: sha(now2), text_hash: sha(now2) };
    appendRevision(root, r);
    all.push(r);
  }
}
function rewriteAll(root: string, map: Array<[string, string]>, bareFor: (rel: string) => Map<string, string>, now: number, pc: string): string[] {
  if (!map.length) return [];
  const all = revisions(root);
  const changed: string[] = [];
  for (const rel of files(root)) {
    if (!/\.(md|base|canvas)$/.test(rel)) continue;
    const before = read(root, rel);
    if (before === null) continue;
    let after = rewriteLinks(before, map, bareFor(rel));
    // Bases filters name folders, not links.
    if (rel.endsWith('.base')) {
      after = after.replace(/file\.inFolder\("([^"]+)"\)/g, (whole, folder: string) => {
        for (const [from, to] of [...map].sort((a, b) => b[0].length - a[0].length)) {
          if (folder === from || folder.startsWith(`${from}/`)) return `file.inFolder("${to}${folder.slice(from.length)}")`;
        }
        return whole;
      });
    }
    if (after === before) continue;
    put(root, rel, after);
    changed.push(rel);
    if (rel.endsWith('.md')) syncBlocks(root, rel, before, after, now, pc, all);
  }
  return changed;
}

// -- moving and merging --------------------------------------------------------------------------------

function moveRevision(root: string, m: Move, state: string, now: number, pc: string): void {
  const dir = /\.(md|base|canvas)$/.test(m.to) ? path.posix.dirname(m.to) : m.to;
  const key = dir === '.' ? 'vault' : spaceKeyOf(root, dir);
  appendRevision(root, { id: randomBytes(4).toString('hex'), ts: new Date(now).toISOString(), kind: 'move', state, space: key,
    page: m.from, section: m.to, author: `keeper@${pc}`, source: `D101 regroup: ${m.why}`, before: m.from, after: m.to });
}
/** Headings two levels down, so merged pages sit under their "Merged from" heading without new sections. */
const demote = (text: string): string => text.replace(/^(#{1,4}) /gm, (_, h: string) => `${h}## `);
/** Keeper markers of merged text become plain comments: the target keeps exactly one block of each. */
const unblock = (text: string): string => text.replace(/<!-- (\/?)keeper:([\w:-]+) -->/g, '<!-- $1merged:$2 -->');
const body = (text: string): string => lf(text).replace(/^---\n[\s\S]*?\n---\n?/, '');
const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()) : str(v) ? [str(v)] : []).filter(Boolean);

/**
 * Merge one project space into another (acme-booking into ember-aoz): nothing is lost. A full copy goes to
 * .keeper/regroup/merged/; same-named Markdown pages are appended under "## Merged from <repo>" (headings
 * demoted, keeper markers made plain); the Overview's front matter gains the other's aliases, tags and remote,
 * its own front matter kept as a block; every other file moves across (renamed "<name> (<repo>)" when taken).
 */
export function mergeProject(root: string, from: string, to: string, now: number, pc: string): string[] {
  const repo = path.posix.basename(from);
  const done: string[] = [];
  const backup = `.keeper/regroup/merged/${repo}-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
  for (const rel of files(root, from)) {
    fs.mkdirSync(path.dirname(abs(root, `${backup}/${rel.slice(from.length + 1)}`)), { recursive: true });
    fs.copyFileSync(abs(root, rel), abs(root, `${backup}/${rel.slice(from.length + 1)}`));
  }
  const all = revisions(root);
  for (const rel of files(root, from)) {
    const sub = rel.slice(from.length + 1);
    const dest = `${to}/${sub}`;
    if (!exists(root, dest)) {
      fs.mkdirSync(path.dirname(abs(root, dest)), { recursive: true });
      fs.renameSync(abs(root, rel), abs(root, dest));
      done.push(`${rel} → ${dest}`);
      continue;
    }
    if (!rel.endsWith('.md')) {
      const ext = path.posix.extname(sub);
      let alt = `${to}/${sub.slice(0, sub.length - ext.length)} (${repo})${ext}`;
      for (let i = 2; exists(root, alt); i++) alt = `${to}/${sub.slice(0, sub.length - ext.length)} (${repo} ${i})${ext}`;
      fs.renameSync(abs(root, rel), abs(root, alt));
      done.push(`${rel} → ${alt}`);
      continue;
    }
    const mine = read(root, dest)!;
    const theirs = read(root, rel)!;
    if (path.posix.basename(sub) === 'index.md') {
      // Derived (regenerated below); the copy in .keeper/regroup keeps the original.
      fs.rmSync(abs(root, rel));
      done.push(`${rel}: derived index, regenerated (copy in ${backup})`);
      continue;
    }
    const fmText = /^---\n([\s\S]*?)\n---/.exec(lf(theirs))?.[1];
    const section = `\n\n## Merged from ${repo}\n\n_Merged ${stamp(now)} by the regroup (D101): ${repo} and ${path.posix.basename(to)} are one space._\n\n` +
      `${fmText ? `\`\`\`yaml\n${fmText}\n\`\`\`\n\n` : ''}${demote(unblock(body(theirs))).trim()}\n`;
    let next = `${mine.replace(/\n*$/, '')}${section}`;
    if (sub === 'Overview.md') {
      const a = frontmatter(mine);
      const b = frontmatter(theirs);
      const set: Record<string, string | string[]> = {};
      const merged = (k: string, extra: string[] = []): string[] => {
        const out = listOf(a[k]);
        for (const x of [...extra, ...listOf(b[k])]) if (!out.some((y) => y.toLowerCase() === x.toLowerCase())) out.push(x);
        return out;
      };
      const aliases = merged('aliases', [repo]);
      if (aliases.length !== listOf(a.aliases).length) set.aliases = aliases;
      const tags = merged('tags');
      if (tags.length !== listOf(a.tags).length) set.tags = tags;
      if (!str(a.remote) && str(b.remote)) set.remote = str(b.remote);
      set.merged_from = merged('merged_from', [repo]);
      next = setFrontmatter(next, set);
    }
    put(root, dest, next);
    fs.rmSync(abs(root, rel));
    syncBlocks(root, dest, mine, next, now, pc, all);
    done.push(`${rel} → appended to ${dest}`);
  }
  removeEmpty(root, from);
  return done;
}
/** Remove a folder only when nothing but empty folders is left in it. */
function removeEmpty(root: string, rel: string): boolean {
  let left: fs.Dirent[];
  try { left = fs.readdirSync(abs(root, rel), { withFileTypes: true }); } catch { return false; }
  for (const d of left) if (!d.isDirectory() || !removeEmpty(root, `${rel}/${d.name}`)) return false;
  try { fs.rmdirSync(abs(root, rel)); return true; } catch { return false; }
}

// -- stages, summaries, bases and colours (D104 and the visual pass) -----------------------------------

/** Rename D50's stages to D104's on every client Overview, logged and recorded (no false conflict later). */
function migrateStages(root: string, g: Grouping, now: number, pc: string, apply: boolean): string[] {
  const out: string[] = [];
  for (const c of allClients(root, g)) {
    const rel = `${c.dir}/Overview.md`;
    const text = read(root, rel);
    if (text === null) continue;
    const stage = str(frontmatter(text).stage);
    const next = OLD_STAGES[stage];
    if (!next) continue;
    out.push(`${c.name}: ${stage} → ${next}`);
    if (!apply) continue;
    const after = setFrontmatter(text, { stage: next });
    put(root, rel, after);
    const key = spaceKeyOf(root, c.dir);
    const id = randomBytes(4).toString('hex');
    appendRevision(root, { id, ts: new Date(now).toISOString(), kind: 'frontmatter', state: 'written', space: key, page: 'Overview.md',
      section: 'stage', block: 'frontmatter', author: `keeper@${pc}`, source: 'D104: the stage list changed',
      before: sha(text), after: sha(after), fields: { stage: sha(next) } });
    const log = `${c.dir}/log.md`;
    put(root, log, `${(read(root, log) ?? '# Log\n\n').replace(/\n*$/, '\n')}- ${stamp(now)} stage: ${stage} → ${next} (D104 stage list) — keeper@${pc} ^r-${id}\n`);
  }
  return out;
}
/** Lay out each client's summary for reading, where it is still the keeper's own text. */
function layoutSummaries(root: string, g: Grouping, now: number, pc: string, apply: boolean): { done: string[]; kept: string[] } {
  const all = revisions(root);
  const done: string[] = [];
  const kept: string[] = [];
  for (const c of allClients(root, g)) {
    const rel = `${c.dir}/Overview.md`;
    const text = read(root, rel);
    const current = text === null ? null : getBlock(text, 'summary');
    if (text === null || !current) continue;
    const next = layoutSummary(current);
    if (next === current) continue;
    const key = spaceKeyOf(root, c.dir);
    if ((lastFor(all, key, 'Overview.md', 'summary')?.after ?? sha('')) !== sha(current)) { kept.push(c.name); continue; }
    done.push(c.name);
    if (!apply) continue;
    put(root, rel, setBlock(text, 'summary', next));
    appendRevision(root, { id: randomBytes(4).toString('hex'), ts: new Date(now).toISOString(), kind: 'summary', state: 'written', space: key,
      page: 'Overview.md', block: 'summary', author: `keeper@${pc}`, source: 'visual pass: "Last thing" on its own line, the ledger under a heading',
      before: sha(current), after: sha(next), text_hash: sha(next) });
  }
  return { done, kept };
}
/** Every business's Pipeline.base shows D104's stages in order (closed stays hidden by its view filter). */
export function updateBaseStages(text: string): string {
  const order = STAGES.filter((s) => s !== 'closed');
  const lines = lf(text).split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)groupOrder:\s*$/.exec(lines[i]!);
    if (!m) { out.push(lines[i]!); continue; }
    let j = i + 1;
    const items: string[] = [];
    let indent = '';
    while (j < lines.length && /^\s*-\s/.test(lines[j]!) && lines[j]!.length - lines[j]!.trimStart().length > m[1]!.length) {
      indent = /^(\s*)-/.exec(lines[j]!)![1]!;
      items.push(lines[j]!.trim().slice(2).trim());
      j++;
    }
    out.push(lines[i]!);
    if (items.includes('outreach')) { out.push(...order.map((s) => `${indent}- ${s}`)); i = j - 1; }
  }
  return out.join('\n');
}
function updateBases(root: string, g: Grouping, apply: boolean): string[] {
  const out: string[] = [];
  for (const b of g.businesses) {
    for (const dir of [b.folder, ...(b === agencyBusiness(g) ? ['Agency'] : [])]) {
      const rel = `${dir}/Pipeline.base`;
      const text = read(root, rel);
      if (text === null) continue;
      const next = updateBaseStages(text);
      if (next === text) continue;
      out.push(rel);
      if (apply) put(root, rel, next);
    }
  }
  return out;
}
const CSS_OPEN = '/* keeper:stages (D104) */';
const CSS_CLOSE = '/* /keeper:stages */';
const chip = (name: string, v: { bg: string; ink: string; line: string; dot: string }): string =>
  `:is(.tobira-stage[data-stage="${name}"], a.tag[href="#${name}"]) {\n  --st-bg: ${v.bg}; --st-ink: ${v.ink}; --st-line: ${v.line}; --st-dot: ${v.dot};\n}`;
const mix = (a: string, b: string, k: 'bg' | 'ink' | 'line'): string => `color-mix(in srgb, var(--t-${a}-${k}) 50%, var(--t-${b}-${k}))`;
/** Colours for D104's new stage values, in the visual pass's stage-chip pattern (light and dark from its palette). */
export const STAGE_CSS = `${CSS_OPEN}
/* Pipeline stages (D104): outreach → replied → sample-made → sample-sent → engaging → proposal → signed → building → launch → done, closed */
a.tag:is([href="#replied"], [href="#sample-made"], [href="#sample-sent"], [href="#engaging"]) {
  background: var(--st-bg); color: var(--st-ink); box-shadow: inset 0 0 0 1px var(--st-line);
}
${chip('replied', { bg: 'var(--t-blue-bg)', ink: 'var(--t-blue-ink)', line: 'var(--t-blue-line)', dot: 'var(--t-blue-ink)' })}
${chip('sample-made', { bg: mix('blue', 'teal', 'bg'), ink: mix('blue', 'teal', 'ink'), line: mix('blue', 'teal', 'line'), dot: mix('blue', 'teal', 'ink') })}
${chip('sample-sent', { bg: mix('indigo', 'teal', 'bg'), ink: mix('indigo', 'teal', 'ink'), line: mix('indigo', 'teal', 'line'), dot: mix('indigo', 'teal', 'ink') })}
${chip('engaging', { bg: 'var(--t-indigo-bg)', ink: 'var(--t-indigo-ink)', line: 'var(--t-indigo-line)', dot: 'var(--t-indigo-ink)' })}
.bases-kanban-column:has(.tobira-stage[data-stage="replied"])     { --st-dot: var(--t-blue-ink); }
.bases-kanban-column:has(.tobira-stage[data-stage="sample-made"]) { --st-dot: ${mix('blue', 'teal', 'ink')}; }
.bases-kanban-column:has(.tobira-stage[data-stage="sample-sent"]) { --st-dot: ${mix('indigo', 'teal', 'ink')}; }
.bases-kanban-column:has(.tobira-stage[data-stage="engaging"])    { --st-dot: var(--t-indigo-ink); }
${CSS_CLOSE}
`;
export const STAGE_CSS_FILE = '.obsidian/snippets/tobira.css';
/** The visual pass's snippet gains the new stages' colours, appended once; nothing in it is changed. */
function updateCss(root: string, apply: boolean): string {
  const text = read(root, STAGE_CSS_FILE);
  if (text === null) return '';
  if (text.includes(CSS_OPEN)) return '';
  if (apply) put(root, STAGE_CSS_FILE, `${text.replace(/\n*$/, '\n\n')}${STAGE_CSS}`);
  return `${STAGE_CSS_FILE}: colours added for replied, sample-made, sample-sent, engaging`;
}

// -- the regroup -----------------------------------------------------------------------------------------

/**
 * Plan (dryRun) or apply the regroup. On the keeper only, with its daemon either running this code (the
 * route runs it inside the one writer) or stopped. Idempotent: on a regrouped vault only the derived parts are
 * refreshed and nothing moves.
 */
export function regroup(root: string, opts: { apply: boolean; now?: number; pc?: string }): RegroupReport {
  const now = opts.now ?? Date.now();
  const pc = opts.pc ?? 'keeper';
  const g = groupingOf(root);
  const { moves, skipped } = planRegroup(root);
  const report: RegroupReport = { applied: opts.apply, moves, skipped, rewritten: [], stages: [], summaries: [], keptSummaries: [], bases: [], css: '', linked: 0, clients: [], clientsSkipped: [], lines: [] };
  const done: Move[] = [];
  if (opts.apply) {
    for (const m of moves.filter((x) => x.kind === 'move')) {
      try {
        if (exists(root, m.to)) throw new Error(`${m.to} already exists`);
        fs.mkdirSync(path.dirname(abs(root, m.to)), { recursive: true });
        fs.renameSync(abs(root, m.from), abs(root, m.to));
        moveRevision(root, m, 'moved', now, pc);
        done.push(m);
      } catch (err) {
        skipped.push({ ...m, reason: (err as Error).message });
      }
    }
    for (const m of moves.filter((x) => x.kind === 'merge')) {
      try {
        const steps = mergeProject(root, m.from, m.to, now, pc);
        moveRevision(root, m, 'merged', now, pc);
        done.push(m);
        report.lines.push(...steps.map((s) => `  merge: ${s}`));
      } catch (err) {
        skipped.push({ ...m, reason: (err as Error).message });
      }
    }
    for (const d of ['Agency', 'Clients', 'Projects']) removeEmpty(root, d);
    // Links: every moved path to its new one; inside Acme's moved pages, bare names of its own pages too.
    const map: Array<[string, string]> = done.map((m) => [m.from.replace(/\.md$/, ''), m.to.replace(/\.md$/, '')]);
    // The old folders themselves (a Bases folder filter, a link to a page that is not there any more).
    const acme = agencyBusiness(g).folder;
    if (done.some((m) => m.from.startsWith('Agency/'))) map.push(['Agency', acme]);
    if (done.some((m) => m.from.startsWith('Clients/'))) map.push(['Clients', `${acme}/Clients`]);
    const fromAgency = new Set(done.filter((m) => m.from.startsWith('Agency/')).map((m) => m.to));
    const bare = new Map<string, string>();
    for (const m of done.filter((x) => x.from.startsWith('Agency/') && x.to.includes('/'))) {
      const name = path.posix.basename(m.from).replace(/\.md$/, '');
      bare.set(name.toLowerCase(), m.to.replace(/\.md$/, ''));
    }
    report.rewritten = rewriteAll(root, map, (rel) => (fromAgency.has(rel) ? bare : new Map()), now, pc);
  }
  report.stages = migrateStages(root, g, now, pc, opts.apply);
  const laid = layoutSummaries(root, g, now, pc, opts.apply);
  report.summaries = laid.done;
  report.keptSummaries = laid.kept;
  report.bases = updateBases(root, g, opts.apply);
  report.css = updateCss(root, opts.apply);
  // Clients into their stage groups (the keeper's tick does the same): only once nothing old is left at the top.
  if (!legacy(root)) {
    const placed = placeClients(root, now, pc, { dryRun: !opts.apply });
    report.clients = placed.moved;
    report.clientsSkipped = placed.skipped;
  }
  if (opts.apply && !legacy(root)) {
    ensureLayout(root);
    for (const c of allClients(root, g)) if (linkUp(root, c.dir, now, pc)) report.linked++;
    for (const p of allProjects(root, g)) if (linkUp(root, p.dir, now, pc)) report.linked++;
    for (const b of g.businesses) if (isDir(root, b.folder)) refreshSpaceIndex(root, b.folder);
    for (const c of allClients(root, g)) if (exists(root, `${c.dir}/index.md`)) refreshSpaceIndex(root, c.dir);
    for (const p of allProjects(root, g)) if (exists(root, `${p.dir}/index.md`)) refreshSpaceIndex(root, p.dir);
    refreshHomes(root);
    rebuildIndex(root);
    writeAttention(root, now);
  }
  const verb = opts.apply ? '' : 'would ';
  report.lines.unshift(
    ...moves.map((m) => `${verb}${m.kind} ${m.from} → ${m.to} (${m.why})`),
    ...skipped.map((m) => `skipped ${m.from} → ${m.to}: ${m.reason}`),
    ...report.clients.map((m) => `${verb}move client ${m.from} → ${m.to} (${m.why})`),
    ...report.clientsSkipped.map((m) => `skipped client ${m.from} → ${m.to}: ${m.reason}`),
    ...report.stages.map((s) => `${verb}rename stage ${s}`),
    ...(report.summaries.length ? [`${verb}lay out ${report.summaries.length} client summar${report.summaries.length === 1 ? 'y' : 'ies'}`] : []),
    ...report.keptSummaries.map((s) => `left a person's summary as it is: ${s}`),
    ...report.bases.map((b) => `${verb}update the stage order in ${b}`),
    ...(report.css ? [`${verb}${report.css}`] : []),
    ...(opts.apply ? [`rewrote links in ${report.rewritten.length} page(s); linked ${report.linked} Overview(s) up to their parent`] : []),
  );
  if (!moves.length && !skipped.length && !report.clients.length && opts.apply) report.lines.push('nothing to move: the vault is already grouped by business');
  return report;
}

// -- re-filing (the keeper's tick) -----------------------------------------------------------------------

const reported = new Set<string>();
/**
 * D101: a project whose Overview front matter names another place (`business`: a business, "shared",
 * "unsorted" or a client ID) moves there, its links rewritten, and its front matter set to the new links.
 * A taken target is skipped (reported once) and listed on Needs attention.
 */
export function refileProjects(root: string, now: number, pc = 'keeper', opts: Batch = {}): { moved: Move[]; skipped: Skipped[] } {
  const g = groupingOf(root);
  const moved: Move[] = [];
  const skipped: Skipped[] = [];
  for (const p of allProjects(root, g)) {
    if (opts.limit !== undefined && moved.length >= opts.limit) break;
    if (!p.place) continue;
    const fm = frontmatter(read(root, `${p.dir}/Overview.md`) ?? '');
    if (!str(fm.business)) continue;
    const asked = parseBusinessValue(root, g, str(fm.business), str(fm.client));
    if (!asked || samePlace(asked, p.place)) continue;
    const to = safeLeaf(targetDir(root, g, asked, p.repo, (r) => r));
    const m: Move = { from: p.dir, to, kind: 'move', why: `its Overview says business ${str(fm.business)}` };
    if (exists(root, to)) {
      if (!reported.has(`${m.from}>${m.to}`)) { reported.add(`${m.from}>${m.to}`); skipped.push({ ...m, reason: `${to} already exists` }); }
      continue;
    }
    fs.mkdirSync(path.dirname(abs(root, to)), { recursive: true });
    fs.renameSync(abs(root, p.dir), abs(root, to));
    moveRevision(root, m, 'moved', now, pc);
    rewriteAll(root, [[m.from, m.to]], () => new Map(), now, pc);
    // The plain value asked for the move; the links now say where it is.
    const rel = `${to}/Overview.md`;
    const text = read(root, rel);
    if (text !== null && placeOfDir(g, to)?.kind !== 'client' && 'client' in frontmatter(text)) put(root, rel, text.replace(/^client: .*\n/m, ''));
    linkUp(root, to, now, pc);
    moved.push(m);
  }
  if (moved.length && opts.finish !== false) finishMoves(root);
  return { moved, skipped };
}

/**
 * The keeper's tick moves in batches (keeper-pc audit, 2026-11-05: one long pass held the daemon for minutes):
 * limit stops after that many moves, and finish: false leaves the Homes and the hidden index to finishMoves,
 * once after the last batch.
 */
export interface Batch { limit?: number; finish?: boolean }
export function finishMoves(root: string): void { refreshHomes(root); rebuildIndex(root); }

// -- client stage groups and business moves (the keeper's tick and its writes) ---------------------------

/**
 * Where a client folder belongs: the business its Overview asks for (a plain `business`, D112) or the one whose
 * folder holds it, then the group of its stage and tags (CLIENT_GROUPS), then its folder name. null: not a client
 * folder, one without an Overview, or one in the old top-level Clients/ (the regroup moves those first).
 */
export function clientTarget(root: string, g: Grouping, dir: string): string | null {
  const c = parseClientDir(g, dir);
  if (!c || c.rest.length || dir.split('/')[0] === 'Clients') return null;
  const text = read(root, `${dir}/Overview.md`);
  if (text === null) return null;
  const fm = frontmatter(text);
  const b = askedClientBusiness(root, g, fm.business) ?? c.business;
  return `${b.folder}/Clients/${clientGroup(fm.stage, fm.tags)}/${safeName(c.name) || c.name}`;
}
const reportedClients = new Set<string>();
/**
 * Every client folder (or only one, right after its write) moved to where it belongs (clientTarget): flat folders
 * from before the groups, a stage or `quiet` tag that changed, a business it asks for. The move is the regroup's:
 * one revision, path-style links rewritten everywhere (keeper blocks given matching revisions), the client and its
 * nested projects linked up, then the Homes and the hidden index once per batch. A taken target is never
 * overwritten: skipped, reported once (each time for `only`, the writer's answer) and listed on Needs attention.
 * The group folder a client leaves is removed when nothing at all is left in it. dryRun only reports.
 */
export function placeClients(root: string, now: number, pc = 'keeper', opts: { only?: string; dryRun?: boolean } & Batch = {}): { moved: Move[]; skipped: Skipped[] } {
  const g = groupingOf(root);
  const moved: Move[] = [];
  const skipped: Skipped[] = [];
  for (const from of opts.only ? [opts.only] : allClients(root, g).map((c) => c.dir)) {
    if (opts.limit !== undefined && moved.length >= opts.limit) break;
    const to = clientTarget(root, g, from);
    if (!to || to === from) {
      // In place already: a plain business value that names where it is becomes the keeper's link.
      if (to && opts.only && !opts.dryRun) linkUp(root, from, now, pc);
      continue;
    }
    const fm = frontmatter(read(root, `${from}/Overview.md`) ?? '');
    const here = parseClientDir(g, from)!;
    const there = parseClientDir(g, to)!;
    const why = [
      ...(there.business !== here.business ? [`its Overview says business ${str(fm.business)} (D112)`] : []),
      ...(there.group !== here.group ? [`${str(fm.stage) ? `stage ${str(fm.stage)}` : 'no stage'}${there.group === QUIET_GROUP ? `, tagged ${QUIET_TAG}` : ''} → ${there.group}`] : []),
      ...(there.name !== here.name ? ['a name Windows can hold'] : []),
    ].join('; ');
    const m: Move = { from, to, kind: 'move', why };
    if (exists(root, to)) {
      const key = `${from}>${to}`;
      if (opts.only || !reportedClients.has(key)) { reportedClients.add(key); skipped.push({ ...m, reason: `${to} already exists` }); }
      continue;
    }
    if (opts.dryRun) { moved.push(m); continue; }
    fs.mkdirSync(path.dirname(abs(root, to)), { recursive: true });
    fs.renameSync(abs(root, from), abs(root, to));
    moveRevision(root, m, 'moved', now, pc);
    rewriteAll(root, [[from, to]], () => new Map(), now, pc);
    linkUp(root, to, now, pc);
    for (const repo of subdirs(root, `${to}/Projects`)) linkUp(root, `${to}/Projects/${repo}`, now, pc);
    // The group it left, only when truly empty (rmdir refuses a folder with anything in it).
    if (here.group) { try { fs.rmdirSync(abs(root, path.posix.dirname(from))); } catch { /* not empty */ } }
    moved.push(m);
  }
  if (moved.length && !opts.dryRun && opts.finish !== false) finishMoves(root);
  return { moved, skipped };
}
