/** Keep provider diagnostics visible without copying an unbounded response into session state. */
export function claudeFailureDetail(result: { subtype?: string; errors?: unknown }, assistantError?: string): string {
  const errors = Array.isArray(result.errors) ? result.errors.filter((v): v is string => typeof v === 'string' && !!v.trim()) : [];
  const detail = [...new Set([...errors, ...(assistantError ? [assistantError] : [])])].join('\n');
  return detail ? `Claude could not complete this turn: ${detail.slice(0, 8000)}`
    : `Claude could not complete this turn${result.subtype ? ` (${result.subtype})` : ''}`;
}
