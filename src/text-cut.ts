/**
 * Cutting text on whole characters. String.slice counts UTF-16 units, so a cut can land between the two halves of
 * an emoji or a rare kanji (a surrogate pair); the lone half is written to a file as U+FFFD ("�"). These count code
 * points instead, so a cut text is always well-formed.
 */
const high = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const low = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** The first n characters (code points) of s; s itself when it is no longer. */
export function headChars(s: string, n: number): string {
  if (s.length <= n) return s;
  let i = 0;
  for (let count = 0; i < s.length && count < n; count++) i += high(s.charCodeAt(i)) && low(s.charCodeAt(i + 1)) ? 2 : 1;
  return s.slice(0, i);
}

/** s cut to at most n characters (code points), the last one the mark when anything was cut. */
export function clipChars(s: string, n: number, mark = '…'): string {
  const head = headChars(s, n);
  return head.length === s.length ? s : `${headChars(s, Math.max(0, n - [...mark].length))}${mark}`;
}

/** A UTF-16 index moved back, if needed, so that cutting there never splits a surrogate pair. */
export function charBoundary(s: string, at: number): number {
  return at > 0 && at < s.length && high(s.charCodeAt(at - 1)) && low(s.charCodeAt(at)) ? at - 1 : at;
}
