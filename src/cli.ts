#!/usr/bin/env node
import { BASE_URL } from './config.js';
import { serve } from './daemon.js';
import { install, STARTUP, uninstall } from './install.js';
import { ensureBoard, startDaemon } from './start-hook.js';
import { holder, instanceAlive, statusCode } from './instance.js';
import { keeperStatus } from './vault-heartbeat.js';
import { keeperConfig } from './vault-store.js';
import { PhoneConfig } from './phone/settings.js';
import { installVoice } from './voice/install.js';

async function running(): Promise<boolean> {
  try {
    return (await fetch(`${BASE_URL}/app/key`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

async function pairCall(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  return await res.json() as Record<string, unknown>;
}

/** `kokuban pair [pc] [--level talk|share|work]` and `kokuban unpair <pc>`: one line per outcome. */
async function pairCommand(args: string[]): Promise<number> {
  if (!(await running())) {
    console.log('The board is not running here: kokuban install starts it.');
    return 1;
  }
  const at = args.indexOf('--level');
  const level = at >= 0 ? args[at + 1] : 'work';
  const [pc] = args.filter((a, i) => !a.startsWith('--') && !(at >= 0 && i === at + 1));
  if (process.argv[2] === 'unpair') {
    if (!pc) { console.log('usage: kokuban unpair <pc>'); return 1; }
    const out = await pairCall({ op: 'unpair', pc });
    console.log(out.ok === false ? `Not done: ${out.error}` : `${out.pc}: ${out.here}; ${out.pc} ${out.there}.`);
    return out.ok === false ? 1 : 0;
  }
  if (!pc) {
    const out = await pairCall({ op: 'list' });
    if (out.ok === false) { console.log(`Could not look: ${out.error}`); return 1; }
    console.log(`This PC runs kokuban ${out.version || '(unknown)'}.`);
    for (const line of out.lines as string[]) console.log(line);
    return 0;
  }
  const asked = await pairCall({ op: 'ask', pc, level });
  if (asked.ok === false) { console.log(`Not paired. ${asked.error}`); return 1; }
  console.log(`Asked the person at ${asked.pc} to allow a "${level}" connection. Waiting for their answer...`);
  for (let waited = 0; waited < 180; waited += 3) {
    await new Promise((r) => setTimeout(r, 3000));
    const state = (await pairCall({ op: 'state', id: asked.id })).state;
    if (state === 'paired') { console.log(`Connected with ${asked.pc} (${level}, both ways).`); return 0; }
    if (state === 'refused') { console.log(`${asked.pc} refused the connection.`); return 1; }
    if (state === 'expired') { console.log('This request was replaced by a newer one.'); return 1; }
  }
  console.log(`No answer yet. The card stays on ${asked.pc}'s screen for 12 hours and the connection completes by itself when they allow it; kokuban pair shows where it stands.`);
  return 0;
}

/** `kokuban update [--from <pc>] [--repo kokuban|computeruse]` gets; `kokuban update <pc>` offers. */
async function updateCommand(args: string[]): Promise<number> {
  if (!(await running())) {
    console.log('The board is not running here: kokuban install starts it.');
    return 1;
  }
  const value = (flag: string): string => (args.includes(flag) ? args[args.indexOf(flag) + 1] ?? '' : '');
  const from = value('--from');
  const repo = value('--repo');
  const [pc] = args.filter((a, i) => !a.startsWith('--') && !['--from', '--repo'].includes(args[i - 1] ?? ''));
  if (pc) console.log(`Offering this PC's kokuban and computeruse to ${pc}...`);
  else console.log(`Getting the newest kokuban and computeruse from ${from || 'the paired PCs'}...`);
  const res = await fetch(`${BASE_URL}/update`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(1_200_000),
    body: JSON.stringify(pc ? { op: 'offer', pc } : { op: 'pull', from, repos: repo ? [repo] : [] }),
  });
  const out = await res.json() as { ok?: boolean; error?: string; lines?: string[] };
  if (out.error) console.log(`Not done: ${out.error}`);
  for (const line of out.lines ?? []) console.log(line);
  return out.ok === false ? 1 : 0;
}

/** `kokuban repair`: whether the board's saved state was damaged; with --forget-lost-asks, take keyed asks again. */
async function repairCommand(args: string[]): Promise<number> {
  if (!(await running())) {
    console.log('The board is not running here: kokuban install starts it.');
    return 1;
  }
  const res = await fetch(`${BASE_URL}/repair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args.includes('--forget-lost-asks') ? { op: 'forget-lost-asks' } : {}),
  });
  const out = await res.json() as { ok?: boolean; line?: string };
  console.log(out.line ?? '');
  return out.ok === false ? 1 : 0;
}

/** `kokuban vault regroup [--apply]` (D101), on the keeper: the board's own daemon moves the vault into the business layout. */
async function vaultCommand(args: string[]): Promise<number> {
  if (args[0] !== 'regroup') {
    console.log('usage: kokuban vault regroup [--apply]   (a dry run without --apply)');
    return 2;
  }
  if (!(await running())) {
    console.log('The board is not running here. Start it with this build, or run node scripts/vault-regroup.mjs while it is stopped.');
    return 1;
  }
  const res = await fetch(`${BASE_URL}/vault-regroup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(600_000),
    body: JSON.stringify({ apply: args.includes('--apply') }),
  });
  if (res.status === 404 || res.status === 405) {
    console.log('The running board is an older build without the regroup: restart it with this build first.');
    return 1;
  }
  const out = await res.json() as { ok?: boolean; error?: string; lines?: string[] };
  if (out.error) console.log(`Not done: ${out.error}`);
  for (const line of out.lines ?? []) console.log(line);
  if (!args.includes('--apply') && !out.error) console.log('(dry run: nothing changed; run again with --apply)');
  return out.ok === false ? 1 : 0;
}

switch (process.argv[2]) {
  case 'vault':
    process.exitCode = await vaultCommand(process.argv.slice(3));
    break;
  case 'phone': {
    const [op = 'list', id] = process.argv.slice(3);
    if (op === 'voice' && id === 'install') { try { await installVoice(); } catch (e) { console.error((e as Error).message); process.exitCode = 1; } break; }
    const response = await fetch(`${BASE_URL}/phone-admin`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kokuban-admin': new PhoneConfig().read().adminSecret ?? '' }, body: JSON.stringify({ op, id }), signal: AbortSignal.timeout(30000) });
    const out = await response.json();
    console.log(JSON.stringify(out, null, 2));
    if (!response.ok) process.exitCode = 1;
    break;
  }
  case 'repair':
    process.exitCode = await repairCommand(process.argv.slice(3));
    break;
  case 'update':
    process.exitCode = await updateCommand(process.argv.slice(3));
    break;
  case 'pair':
  case 'unpair':
    process.exitCode = await pairCommand(process.argv.slice(3));
    break;
  case 'serve':
    serve();
    break;
  case 'install':
    for (const line of install()) console.log(line);
    switch (await ensureBoard({ answers: running, start: () => startDaemon({ wait: true, startup: STARTUP }) })) {
      case 'running': console.log(`Board: ${BASE_URL}`); break;
      case 'started': console.log(`Board started: ${BASE_URL}`); break;
      default:
        console.log(`Board: started, but ${BASE_URL} did not answer within 30 s; check with kokuban status`);
        process.exitCode = 1;
    }
    break;
  case 'uninstall':
    for (const line of uninstall()) console.log(line);
    break;
  case 'status': {
    const answers = await running();
    const locked = answers || (await instanceAlive());
    const pid = holder()?.pid;
    console.log(answers ? `running: ${BASE_URL}${pid ? ` (pid ${pid})` : ''}`
      : locked ? `starting or busy: a daemon${pid ? ` (pid ${pid})` : ''} holds the lock but ${BASE_URL} does not answer yet`
        : 'not running (kokuban install, or kokuban serve)');
    // The keeper's heartbeat (.keeper/heartbeat.json), read from the vault folder: no daemon needed.
    try {
      const cfg = keeperConfig();
      if (cfg) for (const line of keeperStatus(cfg)) console.log(line);
    } catch (err) {
      console.log(`vault: status unreadable: ${(err as Error).message}`);
    }
    process.exitCode = statusCode(answers, locked);
    break;
  }
  default:
    console.log('usage: kokuban serve | install | uninstall | status | phone [enable|list|revoke <device-id>] | pair [<pc>] [--level talk|share|work] | unpair <pc> | update [<pc>] [--from <pc>] [--repo kokuban|computeruse] | repair [--forget-lost-asks] | vault regroup [--apply]');
    process.exitCode = process.argv[2] ? 1 : 0;
}
