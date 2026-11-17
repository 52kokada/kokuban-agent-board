import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR } from './config.js';
export const MAX_CONTINUES = 30;
export const LOOP_SETTINGS = { file: path.join(DATA_DIR,'settings.json') };
/** Runtime-only expiry; invalid/missing settings preserve the normal guards. */
export function communicationOverrideUntil(now = Date.now()): number | null {
  try {
    const value = JSON.parse(fs.readFileSync(LOOP_SETTINGS.file, 'utf8')).communicationOverrideUntil;
    if (Number.isSafeInteger(value) && value > now) return value;
  } catch { /* Keep normal limits when settings cannot be read. */ }
  return null;
}
export function continuationLimit(now = Date.now()): number {
  try {
    const settings = JSON.parse(fs.readFileSync(LOOP_SETTINGS.file, 'utf8'));
    if (settings?.disableAutomaticContinuationLimit === true) return Number.POSITIVE_INFINITY;
  } catch { /* Missing or malformed settings preserve the normal guard. */ }
  return communicationOverrideUntil(now) ? Number.POSITIVE_INFINITY : MAX_CONTINUES;
}
export function readLoopLimit(now = Date.now()):number {
  if (communicationOverrideUntil(now)) return Number.POSITIVE_INFINITY;
  try { const value=JSON.parse(fs.readFileSync(LOOP_SETTINGS.file,'utf8')).loopLimit; if(Number.isSafeInteger(value)&&value>0&&value<=10000)return value; } catch { /* Preserve the guard if settings are unavailable. */ }
  return 40;
}

/**
 * D127, per PC and off unless settings.json says `"wakeWaitingSessions": true`: direct mail for a Codex
 * session whose running turn waits on its human (an open question or approval) is steered into that
 * turn (turn/steer) instead of only waiting for its next step. It never answers the human's question.
 */
export function wakeWaitingSessions(): boolean {
  try { return JSON.parse(fs.readFileSync(LOOP_SETTINGS.file, 'utf8'))?.wakeWaitingSessions === true; }
  catch { return false; }
}
