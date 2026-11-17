/**
 * Claude Code's background Stop hook (`asyncRewake`). It waits, outside the
 * session, for the board to say a direct message arrived; exiting with code 2
 * is what wakes the idle session, with stderr as the text it sees.
 * Any other outcome exits 0 and wakes nothing.
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL } from './config.js';

const LIFETIME_MS = 8 * 60 * 60_000;

async function main(): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!input.session_id || input.agent_id) return 0;
  const waiter = randomBytes(8).toString('hex');
  let first = true;
  let unreachable = 0;
  for (const until = Date.now() + LIFETIME_MS; Date.now() < until;) {
    try {
      const res = await fetch(`${BASE_URL}/wait/claude`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: input.session_id, waiter, first }),
      });
      first = false;
      unreachable = 0;
      if (res.status === 200) {
        process.stderr.write(await res.text());
        return 2;
      }
      if (res.status !== 202) return 0;
    } catch {
      // The board restarts now and then; give it a while before giving up.
      if (++unreachable > 60) return 0;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main().catch(() => 0);
}
