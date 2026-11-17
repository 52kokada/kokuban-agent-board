/**
 * D126: research, as in the crypto space, is shown as a graph. Research is a
 * first-class vault object. A `research` write (vault-keeper.ts writeResearch) creates or updates
 * `<Business>/Research/<name>.md`, one note per subject, grouped by `topic`. Its front matter `related` links are real
 * wikilinks, so Obsidian's graph draws them; the folder's "Research index" lists every note by topic (the graph's hub,
 * not named index.md, which the shared graph filter hides), and "<Business> research map.canvas" shows the topics as
 * nodes linked to their notes.
 *
 * This module is pure: note text, the index block and the canvas. It reads the vault but never writes.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { frontmatter, safeName, wiki } from './vault-layout.js';

export const RESEARCH_DIR = 'Research';
export const RESEARCH_INDEX = 'Research index.md';
export const RESEARCH_STATUSES = ['draft', 'current', 'superseded'] as const;
export const CONFIDENCE = ['low', 'medium', 'high'] as const;
/** The tag every research note carries; the graph's colour group finds notes by it. */
export const RESEARCH_TAG = 'research';
export const mapName = (folder: string): string => `${safeName(`${folder} research map`)}.canvas`;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const lf = (s: string): string => s.replace(/\r\n/g, '\n');
export const sha = (s: string): string => createHash('sha256').update(lf(s).trim()).digest('hex').slice(0, 16);
const abs = (root: string, rel: string): string => path.join(root, ...rel.split('/'));
const readText = (root: string, rel: string): string | null => { try { return lf(fs.readFileSync(abs(root, rel), 'utf8')); } catch { return null; } };
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : str(v) ? [str(v)] : []);

/** A topic as one Obsidian tag: lower case, words joined by "-" ("Custody & taxes" → "custody-taxes"). */
export function topicTag(topic: string): string {
  const t = topic.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}_/-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^[-/]+|[-/]+$/g, '');
  if (!t) return 'topic';
  return /^\d+$/.test(t) ? `t-${t}` : t;
}
/** The note's file name (without .md): its name, else its topic, made Windows-safe. */
export const noteFile = (name: string): string => safeName(name.replace(/\.md$/i, '')) || 'research';
export const researchDir = (businessDir: string): string => `${businessDir}/${RESEARCH_DIR}`;

export interface ResearchNote {
  rel: string; title: string; topic: string; status: string; date: string; confidence: string;
  related: string[]; sources: string[];
}
/** Every research note of a business (the index and the map left out), newest first. */
export function researchNotes(root: string, businessDir: string): ResearchNote[] {
  const dir = researchDir(businessDir);
  let names: string[] = [];
  try { names = fs.readdirSync(abs(root, dir)).filter((n) => n.endsWith('.md') && n !== RESEARCH_INDEX); } catch { return []; }
  return names.flatMap((n) => {
    const rel = `${dir}/${n}`;
    const text = readText(root, rel);
    if (text === null) return [];
    const fm = frontmatter(text);
    return [{
      rel, title: /^# (.+)$/m.exec(text.replace(/^---\n[\s\S]*?\n---\n/, ''))?.[1]?.trim() || n.slice(0, -3),
      topic: str(fm.topic) || 'Unsorted', status: str(fm.status), date: str(fm.date), confidence: str(fm.confidence),
      related: list(fm.related), sources: list(fm.sources),
    }];
  }).sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
}
const byTopic = (notes: ResearchNote[]): Array<[string, ResearchNote[]]> => {
  const m = new Map<string, ResearchNote[]>();
  for (const n of notes) m.set(n.topic, [...(m.get(n.topic) ?? []), n]);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
};

/** The Research index page (made once; its keeper:research block is regenerated). */
export function indexPage(businessDir: string, folder: string): string {
  const dir = researchDir(businessDir);
  return `---\ntags: ["${RESEARCH_TAG}"]\ncssclasses: ["dashboard"]\n---\n# ${folder} research\n\n<!-- keeper:parent -->\nPart of ${wiki(`${businessDir}/Home`, folder)}\n<!-- /keeper:parent -->\n\n` +
    `Every research note by topic. The map: ${wiki(`${dir}/${mapName(folder)}`, 'research map')}; the table: ${wiki(`${businessDir}/Research.base#By topic`, 'Research base')}. ` +
    'Agents add notes with vault write kind=research; the graph links each note to the notes, projects and clients it names.\n\n' +
    '<!-- keeper:research -->\n<!-- /keeper:research -->\n';
}
/** The index's keeper:research block: topics in order, each note with its status, date and confidence. */
export function indexBlock(notes: ResearchNote[]): string {
  if (!notes.length) return '_No research notes yet._';
  return byTopic(notes).map(([topic, ns]) => `### ${topic} (${ns.length})\n${ns.map((n) =>
    `- ${wiki(n.rel, n.title)}${[n.status, n.date, n.confidence && `confidence ${n.confidence}`].filter(Boolean).map((x) => ` · ${x}`).join('')}`).join('\n')}`).join('\n\n');
}

/** A new research note: front matter, the "Part of" line, the keeper's summary, sources and related links, and room for people. */
export function notePage(title: string, parentLine: string, fm: string, summary: string, sources: string, related: string): string {
  return `${fm}# ${title}\n\n<!-- keeper:parent -->\n${parentLine}\n<!-- /keeper:parent -->\n\n<!-- keeper:summary -->\n${summary.trim()}\n<!-- /keeper:summary -->\n\n` +
    `## Sources\n<!-- keeper:sources -->\n${sources ? `${sources}\n` : ''}<!-- /keeper:sources -->\n\n## Related\n<!-- keeper:related -->\n${related ? `${related}\n` : ''}<!-- /keeper:related -->\n\n## Notes\n\n`;
}
/** A source as a list line: a link stays a link, a vault page becomes a wikilink, anything else is plain text. */
export const sourceLine = (s: string): string => (/^https?:\/\//i.test(s) ? `- <${s}>` : `- ${s}`);

// -- the research map (Obsidian Canvas, JSON Canvas 1.0) -----------------------------------------

interface CanvasNode { id: string; type: string; x: number; y: number; width: number; height: number; text?: string; file?: string; color?: string }
interface CanvasEdge { id: string; fromNode: string; toNode: string; fromSide?: string; toSide?: string; color?: string; label?: string }
export interface Canvas { nodes: CanvasNode[]; edges: CanvasEdge[] }
const STATUS_COLOR: Record<string, string> = { current: '4', draft: '3' };
const nodeId = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
const topicId = (topic: string): string => `topic-${nodeId(topic)}`;
const fileId = (rel: string): string => `note-${nodeId(rel)}`;

/** The link target of a [[wikilink]] ("A/B" for "[[A/B|b]]"). */
const target = (link: string): string => /\[\[([^\]|#]+)/.exec(link)?.[1]?.trim() ?? '';

/**
 * The research map: the business in the middle, its topics on a ring, each topic's notes further out along its
 * spoke, an edge from each topic to its notes and a "related" edge between research notes that link each other.
 */
export function researchCanvas(businessDir: string, folder: string, notes: ResearchNote[]): Canvas {
  const groups = byTopic(notes);
  const nodes: CanvasNode[] = [{
    id: 'center', type: 'text', x: -170, y: -70, width: 340, height: 140, color: '6',
    text: `# ${folder} research\n${wiki(`${researchDir(businessDir)}/Research index`, 'Research index')} · ${notes.length} note${notes.length === 1 ? '' : 's'}`,
  }];
  const edges: CanvasEdge[] = [];
  const ring = Math.max(520, groups.length * 150);
  groups.forEach(([topic, ns], i) => {
    // Spread from the left, so one or two topics sit side by side rather than stacked.
    const a = (2 * Math.PI * i) / Math.max(1, groups.length) + Math.PI;
    const ux = Math.cos(a), uy = Math.sin(a);
    const tx = Math.round(ux * ring), ty = Math.round(uy * ring);
    const tid = topicId(topic);
    nodes.push({ id: tid, type: 'text', x: tx - 130, y: ty - 50, width: 260, height: 100, color: '6', text: `## ${topic}\n${ns.length} note${ns.length === 1 ? '' : 's'}` });
    edges.push({ id: `e-${tid}`, fromNode: 'center', toNode: tid });
    ns.forEach((n, j) => {
      const out = 420 + Math.floor(j / 2) * 260;
      const side = ns.length === 1 ? 0 : j % 2 ? 1 : -1;
      const x = Math.round(tx + ux * out - uy * side * 190), y = Math.round(ty + uy * out + ux * side * 190);
      const id = fileId(n.rel);
      nodes.push({ id, type: 'file', file: n.rel, x: x - 160, y: y - 90, width: 320, height: 180, ...(STATUS_COLOR[n.status] ? { color: STATUS_COLOR[n.status] } : {}) });
      edges.push({ id: `e-${id}`, fromNode: tid, toNode: id });
    });
  });
  // Related research notes: one edge per pair.
  const byRel = new Map(notes.map((n) => [n.rel.replace(/\.md$/, ''), n]));
  const seen = new Set<string>();
  for (const n of notes) {
    for (const r of n.related) {
      const other = byRel.get(target(r).replace(/\.md$/, ''));
      if (!other || other === n) continue;
      const pair = [n.rel, other.rel].sort().join('|');
      if (seen.has(pair)) continue;
      seen.add(pair);
      edges.push({ id: `r-${nodeId(pair)}`, fromNode: fileId(n.rel), toNode: fileId(other.rel), label: 'related' });
    }
  }
  return { nodes, edges };
}
export const canvasText = (c: Canvas): string => `${JSON.stringify(c, null, '\t')}\n`;

/**
 * A map a person rearranged keeps everything they did: only notes it does not show yet are added, at the place a
 * fresh layout gives them, with their topic node (made when missing) and its edge.
 */
export function mergeCanvas(have: Canvas, fresh: Canvas): Canvas {
  const out: Canvas = { nodes: [...have.nodes], edges: [...have.edges] };
  const files = new Set(have.nodes.filter((n) => n.type === 'file').map((n) => n.file));
  const ids = new Set(have.nodes.map((n) => n.id));
  for (const n of fresh.nodes.filter((x) => x.type === 'file' && !files.has(x.file))) {
    const edge = fresh.edges.find((e) => e.toNode === n.id && e.fromNode.startsWith('topic-'));
    if (edge && !ids.has(edge.fromNode)) {
      const topic = fresh.nodes.find((x) => x.id === edge.fromNode)!;
      out.nodes.push(topic);
      ids.add(topic.id);
      if (ids.has('center')) out.edges.push(fresh.edges.find((e) => e.toNode === topic.id)!);
    }
    out.nodes.push(n);
    ids.add(n.id);
    if (edge) out.edges.push(edge);
  }
  return out;
}
export function parseCanvas(text: string): Canvas | null {
  try {
    const c = JSON.parse(text) as Partial<Canvas>;
    return c && Array.isArray(c.nodes) && (c.edges === undefined || Array.isArray(c.edges)) ? { nodes: c.nodes, edges: c.edges ?? [] } : null;
  } catch {
    return null;
  }
}
