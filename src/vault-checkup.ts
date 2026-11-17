/** The nightly check-up and the Needs attention page it writes. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ATTENTION, ROOT_HOME, SHARED, UNSORTED, allClients, allProjects, attentionPath, businessDir, frontmatter, isClientGroup, legacy,
  parseBusinessValue, placeName, safeName, samePlace, subdirs, unsafeName,
} from './vault-layout.js';
import { boardFile, boardsOf } from './vault-visuals.js';
import { clientTarget } from './vault-regroup.js';
import { SYNC_SPACE } from './vault-sync.js';
import {
  ATTENTION_DAYS, type Revision, STAGES, TOBIRA, abs, getBlock, groupingOf, put, read, rebuildIndex, refreshSpaceIndex, revisions, setBlock,
  stamp, str, touchIndex, wiki,
} from './vault-store.js';
import { spaceFor } from './vault-spaces.js';
import { cockpitQueued } from './vault-queue.js';
import { HOW } from './vault-rulebook.js';

const EXEMPT = new Set(['README.md', 'Rules.md', HOW, ROOT_HOME, ATTENTION]);
/** The folder a write space is in now (for links on Needs attention). */
function dirOfKey(root: string, key: string): string {
  try {
    const s = spaceFor(root, { space: key });
    return s.dir || key;
  } catch {
    return key;
  }
}
/**
 * Every folder and file in the vault (dot folders left out) whose name Windows refuses, so Syncthing cannot sync
 * it to a Windows PC: "T-… Foo Co.,Ltd." with its trailing dot, a reserved device name, a forbidden character.
 * Inside such a folder only the folder itself is listed.
 */
export function unsafeNames(root: string, rel = ''): Array<{ rel: string; why: string }> {
  let found: fs.Dirent[];
  try { found = fs.readdirSync(abs(root, rel), { withFileTypes: true }); } catch { return []; }
  return found.filter((d) => !d.name.startsWith('.') && !d.name.startsWith('~syncthing~')).sort((a, b) => a.name.localeCompare(b.name)).flatMap((d) => {
    const sub = rel ? `${rel}/${d.name}` : d.name;
    const why = unsafeName(d.name);
    if (why) return [{ rel: sub, why }];
    return d.isDirectory() ? unsafeNames(root, sub) : [];
  });
}
/**
 * The nightly check-up, over the whole vault (D52, D101): conflicts, changed fact sources, orphan pages, client
 * folders without their identity or stage, loose notes, repositories waiting in Unsorted or for a re-file, names
 * Windows cannot sync, the old layout still waiting for its regroup, and this PC's queue backlog.
 */
export function checkup(root: string, now = Date.now()): Record<string, string[]> {
  const g = groupingOf(root);
  const index = rebuildIndex(root);
  const rels = Object.keys(index.pages);
  const byBase = new Map<string, string[]>();
  for (const rel of rels) {
    const base = path.posix.basename(rel, '.md').toLowerCase();
    byBase.set(base, [...(byBase.get(base) ?? []), rel]);
  }
  const linked = new Set<string>();
  for (const [rel, p] of Object.entries(index.pages)) {
    if (/(^|\/)(index|log)\.md$/.test(rel)) continue;
    for (const link of p.links) {
      const target = link.replace(/\.md$/, '');
      if (index.pages[`${target}.md`]) linked.add(`${target}.md`);
      else for (const hit of byBase.get(path.posix.basename(target).toLowerCase()) ?? []) linked.add(hit);
    }
  }
  const since = now - ATTENTION_DAYS * 86_400_000;
  const dirOf = (key: string): string => dirOfKey(root, key);
  // The vault's own pages (the top Home's sync block, D124) are at the top, in no space.
  const pageOf = (r: Revision): string => (r.space === SYNC_SPACE ? r.page : `${dirOf(r.space)}/${r.page}`);
  const conflicts = revisions(root).filter((r) => Date.parse(r.ts) >= since && (r.kind === 'conflict' || r.conflicts_with)).map((r) =>
    r.kind === 'conflict'
      ? r.block?.startsWith('credentials:')
        ? `${r.ts.slice(0, 10)} ${wiki(pageOf(r))} credential ${r.block.slice('credentials:'.length)}: a person changed the row by hand; their row was kept and the agent's password was not written (r ${r.id})`
        : r.block?.startsWith('frontmatter:')
        ? `${r.ts.slice(0, 10)} ${wiki(pageOf(r))} front matter ${r.block.slice('frontmatter:'.length)}: a person changed it by hand; their value was kept (r ${r.id})`
        : `${r.ts.slice(0, 10)} ${wiki(pageOf(r))} ${r.block}: a person edited the keeper block; their text was kept (r ${r.id})`
      : `${r.ts.slice(0, 10)} ${wiki(`${pageOf(r)}#^r-${r.id}`, `proposal r ${r.id}`)} conflicts with ${wiki(r.conflicts_with!)}`);
  const sourceChanged = rels.filter((rel) => /\/Facts\/[^/]+\.md$/.test(rel)).flatMap((rel) => {
    const fm = frontmatter(read(root, rel) ?? '');
    const source = str(fm.source);
    const from = Date.parse(str(fm.valid_from));
    if (!source || !Number.isFinite(from)) return [];
    const file = path.isAbsolute(source) ? source : path.resolve(root, source);
    try {
      return fs.statSync(file).isFile() && fs.statSync(file).mtimeMs > from + 1000 ? [`${wiki(rel)}: ${source} changed after ${str(fm.valid_from).slice(0, 10)}`] : [];
    } catch {
      return [];
    }
  });
  // Folders that hold only spaces: a note directly inside one belongs to no space.
  const holders = new Set(['Clients', 'Projects', `${SHARED}/Projects`, `${UNSORTED}/Projects`,
    ...g.businesses.flatMap((b) => [`${b.folder}/Clients`, `${b.folder}/Projects`,
      ...subdirs(root, `${b.folder}/Clients`).filter(isClientGroup).map((x) => `${b.folder}/Clients/${x}`)]),
    ...subdirs(root, 'Clients').filter(isClientGroup).map((x) => `Clients/${x}`)]);
  const tops = new Set(['Agency', SHARED, UNSORTED, ...g.businesses.map((b) => b.folder)]);
  for (const c of allClients(root, g)) holders.add(`${c.dir}/Projects`);
  const loose = (rel: string): boolean => (!rel.includes('/') && !EXEMPT.has(rel)) || holders.has(path.posix.dirname(rel));
  const orphans = rels.filter((rel) => !EXEMPT.has(rel) && !loose(rel) && !tops.has(path.posix.dirname(rel)) &&
    !/(^|\/)(index|log|Overview|Credentials|Home)\.md$/.test(rel) && !linked.has(rel)).map((rel) => wiki(rel));
  const clients = allClients(root, g);
  const identity = clients.flatMap(({ dir, name }) => {
    const text = read(root, `${dir}/Overview.md`);
    if (text === null) return [`${dir}: no Overview.md`];
    const fm = frontmatter(text);
    const missing = [...(TOBIRA.test(str(fm.tobira_id)) ? [] : ['tobira_id']), ...((Array.isArray(fm.aliases) ? fm.aliases.length : str(fm.aliases)) ? [] : ['aliases'])];
    return missing.length ? [`${wiki(`${dir}/Overview`, name)}: no ${missing.join(' or ')}`] : [];
  });
  const noStage = clients.flatMap(({ dir, name }) => {
    const fm = frontmatter(read(root, `${dir}/Overview.md`) ?? '');
    const stage = str(fm.stage);
    if (read(root, `${dir}/Overview.md`) === null) return [];
    if (!stage) return [`${wiki(`${dir}/Overview`, name)}: no stage`];
    return STAGES.includes(stage) ? [] : [`${wiki(`${dir}/Overview`, name)}: stage "${stage}" is not one of ${STAGES.join(', ')}`];
  });
  const unassigned = rels.filter(loose).map((rel) => wiki(rel));
  const projects = allProjects(root, g);
  const unsorted = projects.filter((p) => p.place?.kind === 'unsorted').map((p) => {
    const why = str(frontmatter(read(root, `${p.dir}/Overview.md`) ?? '').filed);
    return `${wiki(`${p.dir}/Overview`, p.repo)}: set \`business\` in its Overview front matter (${g.businesses.map((b) => b.key).join(', ')}, shared or a client ID)` +
      `${why ? `; the keeper's guess: ${why}` : ''}`;
  });
  const waiting = projects.flatMap((p) => {
    const fm = frontmatter(read(root, `${p.dir}/Overview.md`) ?? '');
    const asked = str(fm.business) ? parseBusinessValue(root, g, str(fm.business), str(fm.client)) : null;
    if (!str(fm.business) || !p.place) return [];
    if (!asked) return [`${wiki(`${p.dir}/Overview`, p.repo)}: business "${str(fm.business)}" names no business`];
    return !samePlace(asked, p.place) ? [`${wiki(`${p.dir}/Overview`, p.repo)}: asks to move to ${placeName(asked)}; the keeper re-files it on its next tick unless its new folder is taken`] : [];
  });
  // Clients out of their group (or business) folder; not before the regroup, which moves the old Clients/ first.
  const waitingClients = legacy(root) ? [] : clients.flatMap((c) => {
    const to = clientTarget(root, g, c.dir);
    return to && to !== c.dir ? [`${wiki(`${c.dir}/Overview`, c.name)}: belongs in \`${to}\`; the keeper moves it on its next tick unless that folder is taken`] : [];
  });
  const unsafe = unsafeNames(root).map(({ rel, why }) => `\`${rel}\`: ${why}; rename it to \`${safeName(path.posix.basename(rel)) || '(a new name)'}\` so Windows PCs can sync it`);
  const old = legacy(root) ? ['The vault still has the old top-level Agency/, Clients/ or Projects/ folder: on the keeper, run `node scripts/vault-regroup.mjs --dry-run`, then `--apply`.'] : [];
  let queued = 0;
  try { queued = fs.readdirSync(abs(root, '.keeper/queue')).filter((f) => f.endsWith('.json')).length; } catch { /* none */ }
  // Intakes (Discord/Slack readers, mail, ledger) report what needs a person as a business fact named
  // attention-<intake>, written through the keeper like any fact; each "- " line of its value is listed here.
  const intakes = g.businesses.flatMap((b) => {
    let files: string[] = [];
    try { files = fs.readdirSync(abs(root, `${b.folder}/Facts`)).filter((f) => /^attention-.+\.md$/.test(f)).sort(); } catch { return []; }
    return files.flatMap((f) => {
      const rel = `${b.folder}/Facts/${f}`;
      return (getBlock(read(root, rel) ?? '', 'fact') ?? '').split('\n').filter((l) => /^\s*- /.test(l))
        .map((l) => `${wiki(rel.replace(/\.md$/, ''), f.slice('attention-'.length, -3))}: ${l.replace(/^\s*- /, '')}`);
    });
  });
  // D126: a board a business has no use for, kept because a person changed it; a Home still pointing at a removed board.
  const boards = g.businesses.flatMap((b) => {
    const dir = businessDir(root, g, b);
    const have = boardsOf(root, g, b);
    const kept = (['pipeline', 'care'] as const).filter((k) => !have.includes(k) && fs.existsSync(abs(root, `${dir}/${boardFile(k)}`)))
      .map((k) => `${wiki(`${dir}/${boardFile(k)}`)}: ${b.folder} has no clients, so no ${k} board (D126), but a person changed this one, so it was kept. ` +
        `Delete it, or set \`boards\` for ${b.key} in settings to keep it.`);
    const home = read(root, `${dir}/Home.md`) ?? '';
    const dangling = (['pipeline', 'care'] as const).filter((k) => home.includes(`[[${dir}/${boardFile(k)}`) && !fs.existsSync(abs(root, `${dir}/${boardFile(k)}`)))
      .map((k) => `${wiki(`${dir}/Home`, `${b.folder} Home`)} still links to its ${k} board, which it no longer has (D126); a person edited that part of the Home, so the keeper left it.`);
    return [...kept, ...dangling];
  });
  return {
    'Conflicts and contradictions': conflicts,
    'Boards': boards,
    'Facts whose source changed': sourceChanged,
    'Orphan pages': orphans,
    'Client folders without tobira_id or aliases': identity,
    'Clients without a stage': noStage,
    'Unsorted projects': unsorted,
    'Waiting to be re-filed': [...waiting, ...waitingClients],
    'Unassigned items': unassigned,
    'Names Windows cannot sync': unsafe,
    ...(old.length ? { 'Old layout': old } : {}),
    'From the intakes': intakes,
    'Queue backlog': [
      ...(queued ? [`${queued} write(s) waiting in this PC's queue`] : []),
      ...(cockpitQueued(root).length ? [`${cockpitQueued(root).length} connection link(s) waiting for acme-cockpit`] : []),
      ...cockpitQueued(root, '.refused').map((f) => `acme-cockpit refused a connection link: .keeper/queue/cockpit/${f} (reason beside it)`),
    ],
  };
}
/** Needs attention.md at the top of the vault (D101; in Agency/ until regrouped): one quiet page, no notifications. */
export function writeAttention(root: string, now = Date.now()): Record<string, string[]> {
  const found = checkup(root, now);
  const rel = attentionPath(root);
  const body = `_Checked ${stamp(now)}._\n\n${Object.entries(found).map(([h, lines]) =>
    `## ${h}\n${lines.length ? lines.map((l) => `- ${l}`).join('\n') : '- none'}`).join('\n\n')}`;
  put(root, rel, setBlock(read(root, rel) ?? '# Needs attention\n', 'attention', body));
  touchIndex(root, [rel, ...(rel.includes('/') ? [refreshSpaceIndex(root, path.posix.dirname(rel))] : [])]);
  return found;
}

// -- forwarding and the queue ---------------------------------------------------------------------
