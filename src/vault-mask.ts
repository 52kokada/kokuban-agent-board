/** Credentials pages' table: the columns, reading and writing rows, and masking passwords in anything read back. */

/** D99: a space's passwords, one keeper-managed table row per site and account. */
export const CREDENTIALS_PAGE = 'Credentials.md';
const CREDENTIAL_COLUMNS = ['site', 'account', 'password', 'url', 'note', 'updated'];
/** What a read shows instead of a password unless the caller passes reveal=true. */
export const MASK = '••••••';
/** A table cell's text: pipes escaped, so a row always splits back into the same cells. */
const cellOf = (s: string): string => s.replace(/\|/g, '\\|');
const uncell = (s: string): string => s.trim().replace(/\\\|/g, '|');
/** A password as an inline code span, so Obsidian shows it exactly (no Markdown) and a person can copy it. */
function codeCell(value: string): string {
  const fence = '`'.repeat(Math.max(0, ...[...value.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  return `${fence} ${cellOf(value)} ${fence}`;
}
function uncode(cell: string): string {
  const raw = uncell(cell);
  const m = /^(`+) ([\s\S]*) \1$/.exec(raw) ?? /^(`+)([\s\S]*)\1$/.exec(raw);
  return m ? m[2]! : raw;
}
/** The cells of one Markdown table row (pipes escaped with a backslash stay in their cell). */
export function rowCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/);
}
export const isTableLine = (line: string): boolean => /^\s*\|/.test(line);
export const isSeparator = (line: string): boolean => isTableLine(line) && rowCells(line).every((c) => /^\s*:?-+:?\s*$/.test(c));
export const CREDENTIAL_HEADER = `| ${CREDENTIAL_COLUMNS.join(' | ')} |\n|${CREDENTIAL_COLUMNS.map(() => ' --- ').join('|')}|`;
export interface CredentialRow { site: string; account: string; value: string; url: string; note: string }
export function parseRow(line: string): CredentialRow | null {
  const c = rowCells(line);
  if (c.length < 3) return null;
  return { site: uncell(c[0]!), account: uncell(c[1]!), value: uncode(c[2]!), url: uncell(c[3] ?? ''), note: uncell(c[4] ?? '') };
}
export const rowLine = (r: CredentialRow, updated: string): string =>
  `| ${cellOf(r.site)} | ${cellOf(r.account)} | ${codeCell(r.value)} | ${cellOf(r.url)} | ${cellOf(r.note)} | ${updated} |`;

/**
 * Every Markdown table with a "password" column, with that column's cells masked. Reads show this unless the
 * caller passes reveal=true, and the hidden index and text search only ever see it.
 */
export function maskCredentials(text: string): string {
  const lines = text.split('\n');
  let col = -1;
  let header = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!isTableLine(line)) { col = -1; header = true; continue; }
    if (header) {
      header = false;
      col = rowCells(line).findIndex((c) => /^(password|passwords|pass|pw|パスワード)$/i.test(c.trim()));
      continue;
    }
    if (col < 0 || isSeparator(line)) continue;
    const cells = rowCells(line);
    if (col < cells.length && cells[col]!.trim()) {
      cells[col] = ` ${MASK} `;
      lines[i] = `|${cells.join('|')}|`;
    }
  }
  return lines.join('\n');
}
