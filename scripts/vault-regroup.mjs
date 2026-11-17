#!/usr/bin/env node
// D101–D104: regroup the shared vault by business, ON THE KEEPER (keeper-pc) only. Syncthing then carries the
// renames to the other PCs; never run this on a PC that only has a synced copy.
//
//   node scripts/vault-regroup.mjs --dry-run   print every move and change, change nothing
//   node scripts/vault-regroup.mjs --apply     do it (safe to run again: a regrouped vault is left as it is)
//
// When the board is running, the work happens inside its daemon (POST /vault-regroup), so no keeper write can
// land in the middle of a move; the daemon must run a build with the regroup (restart it first). When the board
// is stopped, the script does it itself. Options: --vault <path> (only with the board stopped; default:
// settings.json vault.path), --port <n>. Needs `npm run build` first.
import { hostname } from 'node:os';
import { PORT } from '../dist/src/config.js';
import { keeperConfig } from '../dist/src/vault-keeper.js';
import { regroup } from '../dist/src/vault-regroup.js';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const known = new Set(['--dry-run', '--apply', '--vault', '--port']);
for (let i = 0; i < args.length; i++) {
  if (!known.has(args[i])) { console.error(`unknown argument ${args[i]}`); process.exit(2); }
  if (args[i] === '--vault' || args[i] === '--port') i++;
}
const apply = args.includes('--apply');
if (apply === args.includes('--dry-run')) { console.error('pass exactly one of --dry-run or --apply'); process.exit(2); }
const port = Number(option('--port')) || PORT;

let up = false;
try { up = (await fetch(`http://127.0.0.1:${port}/app/key`, { signal: AbortSignal.timeout(2000) })).status < 500; } catch { /* stopped */ }

if (up) {
  if (option('--vault')) { console.error('--vault is only for a stopped board; the running board regroups its own vault.'); process.exit(2); }
  const res = await fetch(`http://127.0.0.1:${port}/vault-regroup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apply }), signal: AbortSignal.timeout(600_000),
  });
  if (res.status === 404 || res.status === 405) {
    console.error('The running board is an older build without the regroup: restart it with this build first (or stop it and run this again).');
    process.exit(1);
  }
  const out = await res.json();
  if (out.error) console.error(`Not done: ${out.error}`);
  for (const line of out.lines ?? []) console.log(line);
  if (!apply && !out.error) console.log('(dry run: nothing changed; run again with --apply)');
  process.exitCode = out.ok === false ? 1 : 0;
} else {
  const cfg = keeperConfig();
  const root = option('--vault') ?? cfg?.path;
  if (!root) { console.error('No vault: pass --vault <path> or set "vault" in kokuban settings.json.'); process.exit(2); }
  if (apply && !option('--vault') && !cfg?.keeper) { console.error('This PC is not the vault keeper: run the regroup on keeper-pc only.'); process.exit(2); }
  const report = regroup(root, { apply, pc: hostname().toLowerCase() });
  for (const line of report.lines) console.log(line);
  if (!apply) console.log('(dry run: nothing changed; run again with --apply)');
  process.exitCode = report.skipped.length ? 1 : 0;
}
