/**
 * D120: the Acme Pipeline board in the "Tendra kanban" design.
 * Obsidian Bases' built-in kanban view plus the acme snippet, no community plugin.
 *
 * - Each card shows, top to bottom: the stage chip (plus "came back" / "quiet" chips from the Overview's tags) and the
 *   days since the last thing happened; the client's name; its Acme ID and that date in mono; the last thing
 *   itself; and a footer with the next step (front matter next_step, "No next step" when unset) and a Work log link
 *   that appears on hover, like Tendra's "go" button.
 * - Bases lays the cards out itself: every card is as tall as its padding plus one row per property (measured from
 *   CSS), and each row is placed absolutely. The snippet block sets the padding and places the rows by the card_*
 *   formula names, so a card reads like a Tendra tile (172px). Rows a person adds keep Obsidian's own places.
 * - The keeper applies this on every start (ensureLayout): a new Pipeline.base has it; an existing one gains the card
 *   formulas, and its Board view switches to them only while its card list is still one the keeper wrote (a person's
 *   own choice of card properties is kept). tobira.css gains the block once, between keeper:tendra markers; a later
 *   version replaces an unedited earlier one, and a person's edited block is left alone.
 * - Not possible in Bases + CSS: Tendra's stat tiles above the board, avatars and money values, drop hints ("Drag a bid
 *   here"), column fillers and the owners view. Column names are the stage values (sample-made and sample-sent are
 *   relabelled in CSS while the column has cards).
 */

/** The card's formulas (YAML values), in the order they are written. card_name is the title row. */
export const CARD_FORMULAS: ReadonlyArray<readonly [string, string]> = [
  ['card_name', 'if(name, name, tobira_id)'],
  ['card_age', 'if(last_event, (today() - date(last_event.slice(0, 10))).days.floor(), "")'],
  ['card_top', 'html(\'<span class="tb-top"><span class="tobira-stage" data-stage="\' + escapeHTML(stage) + \'">\' + escapeHTML(stage) + \'</span>\' + ' +
    'if(file.hasTag("came-back"), \'<span class="tobira-stage" data-stage="came-back">came back</span>\', \'\') + ' +
    'if(file.hasTag("quiet"), \'<span class="tobira-stage" data-stage="quiet">quiet</span>\', \'\') + ' +
    '\'<span class="tb-when">\' + if(last_event, if(formula.card_age < 1, \'Today\', if(formula.card_age == 1, \'1 day\', formula.card_age + \' days\')), \'\') + ' +
    '\'</span></span>\')'],
  ['card_code', 'html(\'<span class="tb-code"><code>\' + escapeHTML(tobira_id) + \'</code>\' + ' +
    'if(last_event, \'<span class="tb-sep">·</span>\' + escapeHTML(last_event.slice(0, 10)), \'\') + \'</span>\')'],
  ['card_event', 'if(last_event, if(last_event.contains(" — "), last_event.split(" — ").slice(1).join(" — "), last_event), "Nothing logged yet")'],
  ['card_next', 'html(\'<span class="tb-next">\' + if(next_step, escapeHTML(next_step), \'<span class="tb-none">No next step</span>\') + \'</span>\')'],
  ['card_work', 'link(file.folder + "/Work log", "Work log")'],
];
/** Display names (the Properties menu and table headers). */
export const CARD_PROPERTIES: ReadonlyArray<readonly [string, string]> = [
  ['next_step', 'Next step'], ['formula.card_name', 'Client'], ['formula.card_top', 'Stage'], ['formula.card_code', 'ID'],
  ['formula.card_event', 'Last thing'], ['formula.card_next', 'Next step'], ['formula.card_work', 'Work'],
];
/** The Board view's card rows, top to bottom as Bases counts them (the first is the title). */
export const CARD_ORDER = ['formula.card_name', 'formula.card_top', 'formula.card_code', 'formula.card_event', 'formula.card_next', 'formula.card_work'];
export const BOARD_COLUMN_WIDTH = 264;
/** Board card lists the keeper wrote before D120; only these are switched to the Tendra card. */
const KEEPER_BOARD_ORDERS = [
  ['formula.client', 'formula.meta', 'formula.touched'],
  ['formula.client', 'formula.meta', 'last_event', 'formula.touched'],
];

/** YAML lines for a base's formulas and properties sections. */
export const formulaLines = (): string[] => CARD_FORMULAS.map(([k, v]) => `  ${k}: ${v}`);
export const propertyLines = (): string[] => CARD_PROPERTIES.flatMap(([k, v]) => [`  ${k}:`, `    displayName: ${v}`]);

const indentOf = (line: string): number => line.length - line.trimStart().length;
/** The end (exclusive) of the block starting at line i: the lines after it indented deeper (blank lines inside kept). */
function blockEnd(lines: string[], i: number): number {
  const base = indentOf(lines[i]!);
  let j = i + 1;
  while (j < lines.length && (!lines[j]!.trim() || indentOf(lines[j]!) > base)) j++;
  while (j > i + 1 && !lines[j - 1]!.trim()) j--;
  return j;
}
/** Add lines at the end of a top-level section, making the section before `before` when it is missing. */
function addToSection(lines: string[], name: string, add: string[], before: string): void {
  const at = lines.findIndex((l) => l === `${name}:`);
  if (at >= 0) { lines.splice(blockEnd(lines, at), 0, ...add); return; }
  let b = lines.findIndex((l) => l === `${before}:`);
  if (b < 0) b = lines.length;
  lines.splice(b, 0, `${name}:`, ...add);
}

export type TendraBase = { text: string; board: 'updated' | 'kept' | 'already' };
/**
 * An existing Pipeline.base moved to the Tendra card: the card formulas and display names are added (nothing already
 * there changes), and the Board view's card list switches only while it is still one the keeper wrote ("kept" when a
 * person chose their own). "already": the base has the card formulas; it is returned unchanged.
 */
export function tendraBase(text: string): TendraBase {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.some((l) => /^ {2}card_top:/.test(l))) return { text, board: 'already' };
  addToSection(lines, 'properties', propertyLines(), 'views');
  addToSection(lines, 'formulas', formulaLines(), 'properties');
  let board: TendraBase['board'] = 'kept';
  const views = lines.findIndex((l) => l === 'views:');
  const end = views >= 0 ? blockEnd(lines, views) : -1;
  for (let i = views + 1; views >= 0 && i < end; i++) {
    if (!/^ {2}- /.test(lines[i]!)) continue;
    const item = blockEnd(lines, i);
    const own = lines.slice(i, item).map((l, k) => (k === 0 ? l.replace(/^ {2}- /, '    ') : l));
    if (!own.includes('    type: kanban') || !own.includes('    name: Board')) continue;
    const o = lines.findIndex((l, k) => k > i && k < item && l === '    order:');
    if (o < 0) break;
    let e = o + 1;
    while (e < item && /^ {6}- /.test(lines[e]!)) e++;
    const order = lines.slice(o + 1, e).map((l) => l.trim().slice(1).trim());
    if (!KEEPER_BOARD_ORDERS.some((x) => x.length === order.length && x.every((v, k) => v === order[k]))) break;
    lines.splice(o + 1, e - o - 1, ...CARD_ORDER.map((p) => `      - ${p}`));
    const last = item + CARD_ORDER.length - (e - o - 1);
    const w = lines.findIndex((l, k) => k > i && k < last && /^ {4}columnWidth:/.test(l));
    if (w >= 0) lines[w] = `    columnWidth: ${BOARD_COLUMN_WIDTH}`;
    else lines.splice(o + 1 + CARD_ORDER.length, 0, `    columnWidth: ${BOARD_COLUMN_WIDTH}`);
    board = 'updated';
    break;
  }
  return { text: lines.join('\n'), board };
}

export const SNIPPET_FILE = '.obsidian/snippets/tobira.css';
export const TENDRA_CSS_OPEN = '/* keeper:tendra (D120) */';
export const TENDRA_CSS_CLOSE = '/* /keeper:tendra */';
/** The snippet block: the board's columns and cards in Tendra's layout, light and dark from the snippet's tokens. */
export const TENDRA_CSS = `/* keeper:tendra (D120) */
/*
  The Pipeline board in the Tendra layout: columns as soft trays
  with a stage dot, name and count chip; each card a white tile with the stage chip and "when" on top, the
  client's name, its Acme ID in mono, the last thing that happened, and a footer with the next step and a
  Work log link. Bases lays cards out itself (fixed height from the card's padding and its property rows), so
  the rows are placed by the card_* formulas' names; any other property keeps Obsidian's own row.
*/
body {
  --bases-kanban-container-gap: 13px;
  --bases-kanban-container-padding: 14px;
  --bases-kanban-line-height: 24px;
}
.bases-kanban-column {
  border: 0;
  padding: 0 2px;
}
.bases-kanban-column-header {
  height: 44px;
  padding: 0 12px 0 14px;
}
.bases-kanban-column-header .bases-group-value { font-size: 13.5px; font-weight: 600; letter-spacing: -.005em; line-height: 20px; }
.bases-kanban-column-count {
  background: var(--tb-card);
  color: var(--t-gray-ink);
  box-shadow: 0 0 0 1px var(--tb-line);
}
.bases-kanban-column-content { padding: 0 8px 8px; }
.bases-kanban-column-footer { height: 46px; padding: 0 8px 6px; display: grid; place-items: center; }
.bases-kanban-column-footer .text-icon-button {
  justify-content: center; height: 30px; border-radius: 8px; color: var(--tb-muted-2); font-size: 12px; background: none; box-shadow: none;
}
.bases-kanban-column-footer .text-icon-button:hover { background: var(--background-modifier-hover); color: var(--tb-ink-2); }
/* stage names read as words: "sample-sent" → "Sample sent" */
.bases-kanban-column:has(.tobira-stage[data-stage="sample-made"]) .bases-group-value,
.bases-kanban-column:has(.tobira-stage[data-stage="sample-sent"]) .bases-group-value { font-size: 0; display: flex; align-items: center; }
.bases-kanban-column:has(.tobira-stage[data-stage="sample-made"]) .bases-group-value::after { content: "Sample made"; font-size: 13.5px; line-height: 20px; }
.bases-kanban-column:has(.tobira-stage[data-stage="sample-sent"]) .bases-group-value::after { content: "Sample sent"; font-size: 13.5px; line-height: 20px; }
.bases-kanban-column:has(.tobira-stage[data-stage="outreach"]) { --st-dot: #9c9ca4; }

/* the card: 13px top, rows at 24px, 15px bottom → 172px with six rows, as in Tendra */
.bases-kanban-card { padding: 13px 14px 15px; gap: 0; }
.bases-kanban-card-property[data-property^="formula.card_"] .bases-kanban-card-line {
  height: 100%;
  display: flex;
  align-items: center;
  min-width: 0;
}
.bases-kanban-card-property[data-property^="formula.card_"] .bases-kanban-card-line:empty::before { content: none; }
.bases-kanban-card-property[data-property="formula.card_top"]   { top: 13px !important;  height: 22px !important; }
.bases-kanban-card-property[data-property="formula.card_name"]     { top: 45px !important;  height: 20px !important; }
.bases-kanban-card-property[data-property="formula.card_code"]   { top: 67px !important;  height: 18px !important; }
.bases-kanban-card-property[data-property="formula.card_event"] { top: 84px !important;  height: 40px !important; }
.bases-kanban-card-property[data-property="formula.card_next"]  { top: 124px !important; height: 48px !important; border-top: 1px solid var(--tb-line-soft); }
.bases-kanban-card-property[data-property="formula.card_work"]  { top: 125px !important; height: 47px !important; inset-inline-start: auto !important; overflow: visible; }

.tb-top { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; }
.tb-top .tobira-stage { display: inline-block; height: 22px; line-height: 22px; padding: 0 7px; font-size: 10.5px; letter-spacing: .035em; flex: none; max-width: 68%; overflow: hidden; text-overflow: ellipsis; }
.tobira-stage[data-stage="came-back"] { --st-bg: var(--t-red-bg); --st-ink: var(--t-red-ink); --st-line: var(--t-red-line); }
.tobira-stage[data-stage="quiet"] { --st-bg: var(--t-amber-bg); --st-ink: var(--t-amber-ink); --st-line: var(--t-amber-line); }
.tb-when {
  margin-inline-start: auto; display: inline-flex; align-items: center; gap: 5px;
  color: var(--tb-muted); font-size: 11.5px; white-space: nowrap; flex: 0 1 auto; min-width: 0; overflow: hidden;
}
.tb-when:empty { display: none; }
.tb-when::before {
  content: ""; width: 13px; height: 13px; flex: none; background: var(--tb-muted-2);
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3.5' y='5' width='17' height='15.5' rx='2.5'/%3E%3Cpath d='M3.5 10h17M8 3v4M16 3v4'/%3E%3C/svg%3E") center / contain no-repeat;
          mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3.5' y='5' width='17' height='15.5' rx='2.5'/%3E%3Cpath d='M3.5 10h17M8 3v4M16 3v4'/%3E%3C/svg%3E") center / contain no-repeat;
}
.bases-kanban-card-property[data-property="formula.card_name"] .bases-kanban-card-line {
  font-size: 13.5px; font-weight: 600; letter-spacing: -.005em; color: var(--tb-ink); line-height: 20px; display: block;
}
.tb-code { display: block; color: var(--tb-muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.tb-code code { font-family: var(--tb-mono); font-size: 11px; letter-spacing: .02em; background: none; padding: 0; color: inherit; }
.tb-sep { margin: 0 5px; color: var(--tb-muted-2); }
.bases-kanban-card-property[data-property="formula.card_event"] .bases-kanban-card-line {
  display: block; line-height: 40px; color: var(--tb-muted); font-size: 11.5px;
}
.tb-next { display: block; width: 100%; padding-inline-end: 84px; font-size: 12px; color: var(--tb-ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tb-next .tb-none { color: var(--tb-muted); font-size: 11.5px; }
.bases-kanban-card-property[data-property="formula.card_work"] .bases-kanban-card-line { justify-content: flex-end; overflow: visible; }
/* the Work log link: Tendra's "go" button, shown on hover */
.bases-kanban-card-property[data-property="formula.card_work"] .internal-link {
  display: inline-flex; align-items: center; gap: 3px; height: 26px; padding: 0 7px 0 9px; border-radius: 7px;
  background: var(--tb-card); color: var(--tb-ink-2); font-size: 12px; font-weight: 500; text-decoration: none;
  box-shadow: 0 0 0 1px var(--tb-line-2), 0 1px 2px rgba(0, 0, 0, .05);
  pointer-events: auto; opacity: 0; transform: translateX(4px); transition: opacity .15s ease, transform .18s var(--tb-ease);
}
.bases-kanban-card-property[data-property="formula.card_work"] .internal-link::after { content: "\\203A"; font-size: 15px; line-height: 1; color: var(--tb-muted); }
.bases-kanban-card:is(:hover, :focus-visible, :focus-within) .bases-kanban-card-property[data-property="formula.card_work"] .internal-link { opacity: 1; transform: none; }
.bases-kanban-card-property[data-property="formula.card_work"] .internal-link:hover { color: var(--tb-ink); text-decoration: none; }
.is-mobile .bases-kanban-card-property[data-property="formula.card_work"] .internal-link { opacity: 1; transform: none; }
/* /keeper:tendra */
`;
/** Earlier keeper versions of the block (each ending in a newline); one of these, unedited, is replaced. */
const KEEPER_TENDRA_CSS: string[] = [];

/** The snippet with the current block (appended once, an unedited earlier version replaced); null when nothing changes. */
export function withTendraCss(text: string): string | null {
  const s = text.replace(/\r\n/g, '\n');
  const a = s.indexOf(TENDRA_CSS_OPEN);
  if (a < 0) return `${s.replace(/\n*$/, s.trim() ? '\n\n' : '')}${TENDRA_CSS}`;
  const b = s.indexOf(TENDRA_CSS_CLOSE, a);
  if (b < 0) return null;
  const have = `${s.slice(a, b + TENDRA_CSS_CLOSE.length)}\n`;
  if (have === TENDRA_CSS || !KEEPER_TENDRA_CSS.includes(have)) return null;
  return s.slice(0, a) + TENDRA_CSS + s.slice(b + TENDRA_CSS_CLOSE.length).replace(/^\n/, '');
}
