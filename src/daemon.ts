/**
 * The one long-lived process. Serves, on 127.0.0.1 only:
 *   POST /mcp, /mcp/codex   the agent tools
 *   POST /hook/claude       Claude Code HTTP hooks
 *   POST /bridge            local compatibility requests, as this PC (or relayed with proof, D97)
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board } from './board.js';
import { appRoutes } from './app-routes.js';
import { changed, feedView, listen, pull, pullAll, stateFor } from './feed.js';
import { sessionEnded, sweep } from './cards.js';
import { codexRpc } from './codex-rpc.js';
import { syncCodexTitle } from './codex-title.js';
import { syncClaudeBadge } from './terminal-badges.js';
import { BASE_URL, BOARD_FILE, DATA_DIR, PORT } from './config.js';
import { handleHook } from './hooks.js';
import { handleRpc } from './mcp.js';
import { reapClaude, reapCodex, waitClaude, wakeCodex, wakeKimi, batchWakeScheduler } from './wake.js';
import { ensureTypist } from './kimi-console.js';
import { sweepTasks, flushTasks } from './tasks.js';
import { bridgeCaller, handlePeer, ingressSecret, PEER_INGRESS, PEER_ROUTE, peerIngress, remoteFor, type PeerDeps } from './peer.js';
import { askPair, pairDecided, pairState, pairStatus, repairPeerServe, statusLines, sweepPairs, unpair, type PairDeps } from './pair.js';
import { offerDecided, offerUpdate, pullUpdate, sweepOffers, type RepoName, type UpdateDeps } from './update.js';
import type { Card } from './cards.js';
import { syncKnowhow, thisPc } from './know.js';
import { syncVault, vaultDecided } from './vault.js';
import { keeperTick } from './vault-keeper.js';
import { watchStalls } from './stall-log.js';
import { keeperConfig } from './vault-store.js';
import { regroup } from './vault-regroup.js';
import { enableProjectSpaces } from './vault-projects.js';
import { enableWorkingCopies, sweepWorkingCopies } from './vault-working-copies.js';
import { handleBridge } from './bridge.js';
import { ConversationService } from './conversations/service.js';
import { PhoneGateway, phoneDecision, startPhoneNotifications, stopPhoneNotifications, type PhoneDeps } from './phone/routes.js';
import { PhoneConfig, repairPhoneServe } from './phone/settings.js';
import { ChiefService } from './chief/service.js';
import { acquireInstance } from './instance.js';
import { autoUpdateTick, autoUpdateApplying, autoRuntimeEvidence } from './auto-update-runtime.js';

function body(req: http.IncomingMessage, max = Infinity): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) return reject(new Error('request too large'));
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createServer(board: Board, peer: PeerDeps = {}, pairing: PairDeps = {}, updating: UpdateDeps = {}, phoneDeps: PhoneDeps = {}): http.Server {
  const phone = new PhoneGateway(board, phoneDeps);
  const server = http.createServer(async (req, res) => {
    const send = (status: number, text = '', type = 'application/json') => {
      res.writeHead(status, text ? { 'content-type': type } : {});
      res.end(text);
    };
    try {
      if (autoUpdateApplying(board) && req.url !== '/app/key' && req.url !== '/auto-update/status')
        return send(503, JSON.stringify({ error: 'A verified update is restarting this board; retry shortly' }));
      if (await phone.route(req, res)) return;
      // Another board, through tailscale serve: Serve connects from loopback and carries the caller's
      // tailnet identity, which handlePeer checks. Any local program could write those headers too, so
      // they count only on the private path this PC's Serve entry forwards to (PEER_INGRESS); a direct
      // call to /peer, or a wrong path, is refused before identity or trust is looked at.
      // A browser page carries an Origin and is refused.
      if ((req.url === PEER_ROUTE || req.url?.startsWith(PEER_INGRESS)) && req.method === 'POST') {
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
        if (!local || req.headers.origin || !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(403);
        if (peerIngress(req.url, (peer.ingress ?? ingressSecret)()) !== 'serve') {
          return send(403, JSON.stringify({ ok: false, error: 'this PC takes /peer only through its own tailscale serve entry, which is missing or out of date; restarting its kokuban board or running kokuban pair there repairs it' }));
        }
        const out = await handlePeer(board, req.headers, JSON.parse(await body(req, 64_000)), peer);
        return send(out.status, JSON.stringify(out.body));
      }
      // Only local programs may talk to the board. A browser page that tries
      // carries an Origin header, and a rebound DNS name carries a foreign Host.
      const host = (req.headers.host ?? '').split(':')[0];
      if (host !== '127.0.0.1' && host !== 'localhost') return send(403);
      const url = new URL(req.url ?? '/', BASE_URL);
      const route = url.pathname;

      if (await appRoutes(board, req, res, url)) return;
      if (req.headers.origin) return send(403);

      if (req.method !== 'POST') return send(405);
      if (route === '/auto-update/status') return send(200, JSON.stringify(autoRuntimeEvidence()));

      if (route === '/bridge') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(415);
        // A local program is this PC. Another PC's name counts only with a relay's proof (bridgeCaller, D97);
        // the handlers then see only the established caller, never the body's own from/source.
        const input = JSON.parse(await body(req, 64_000));
        const caller = await bridgeCaller(req.headers, input, peer);
        if ('error' in caller) return send(caller.status, JSON.stringify({ ok: false, error: caller.error }));
        const { source: _source, from, ...rest } = input as { source?: unknown; from?: { agent?: unknown } };
        const agent = typeof from === 'object' && from ? from.agent : undefined;
        return send(200, JSON.stringify(await handleBridge(board,
          { ...rest, from: { pc: caller.pc, agent: typeof agent === 'string' ? agent : '' }, trust: caller.level })));
      }
      const parsed = JSON.parse((await body(req)) || '{}');
      if(route.startsWith('/chief/gate/')){if(!board.chief)return send(503);try{return send(200,JSON.stringify(await board.chief.pushGate(route.slice('/chief/gate/'.length),parsed)));}catch{return send(403,JSON.stringify({allow:false}));}}
      if (route.startsWith('/chief/mcp/')) {
        if (!board.chief) return send(503);
        try { const reply = await board.chief.rpc(route.slice('/chief/mcp/'.length), parsed); return reply ? send(200,JSON.stringify(reply)) : send(202); }
        catch { return send(403,JSON.stringify({error:'Managed chief capability refused'})); }
      }
      // `kokuban pair`, from this PC's own terminal (cli.ts).
      if (route === '/pair') return send(200, JSON.stringify(await pairRequest(board, parsed, pairing)));
      if (route === '/phone-admin') {
        try { return send(200, JSON.stringify(await phone.admin(parsed, String(req.headers['x-kokuban-admin'] ?? '')))); }
        catch (e) { return send((e as { status?: number }).status ?? 400, JSON.stringify({ error: (e as Error).message })); }
      }
      // `kokuban update`, likewise.
      if (route === '/update') return send(200, JSON.stringify(await updateRequest(board, parsed, updating)));
      // `kokuban repair --forget-lost-asks`: a person accepts that asks lost with damaged state are gone.
      if (route === '/repair') {
        // Success is what the board now is, not what the words say: a failed save leaves it damaged.
        return send(200, JSON.stringify(parsed.op === 'forget-lost-asks' ? { line: board.forgetLostAsks(), ok: !board.damaged }
          : { ok: !board.damaged, line: board.damaged ? `damaged since ${new Date(board.damaged.since).toISOString()}: ${board.damaged.why}; copy at ${board.damaged.copy}. Keyed asks are refused until: kokuban repair --forget-lost-asks` : 'the saved state is fine' }));
      }
      // `kokuban vault regroup [--apply]` (D101), run inside the keeper's own daemon so no write lands mid-move.
      if (route === '/vault-regroup') {
        const cfg = keeperConfig();
        if (!cfg?.keeper) return send(409, JSON.stringify({ ok: false, error: 'this PC is not the vault keeper: run the regroup on the keeper (keeper-pc) only' }));
        try {
          const report = regroup(cfg.path, { apply: parsed.apply === true, pc: thisPc() });
          return send(200, JSON.stringify({ ok: !report.skipped.length, lines: report.lines, moves: report.moves.length, skipped: report.skipped.length }));
        } catch (e) {
          return send(500, JSON.stringify({ ok: false, error: (e as Error).message }));
        }
      }
      if (route === '/hook/claude' || route === '/hook/kimi') {
        const out = handleHook(board, route === '/hook/kimi' ? 'kimi' : 'claude', parsed);
        // D125 terminal badges: display only, after the hook has settled the session's state.
        if (route === '/hook/claude' && !parsed?.agent_id) {
          const s = board.sessions.find((x) => x.id === parsed?.session_id);
          if (s) syncClaudeBadge(s, { event: parsed?.hook_event_name });
        }
        return out ? send(200, JSON.stringify(out)) : send(200);
      }
      if (route === '/wait/claude') {
        let gone = false;
        res.on('close', () => { gone = true; });
        const out = await waitClaude(board, parsed, () => gone);
        return send(out.status, out.text ?? '', 'text/plain; charset=utf-8');
      }
      if (route === '/mcp' || route === '/mcp/codex' || route === '/mcp/kimi') {
        const agent = route === '/mcp/kimi' ? 'kimi' : route === '/mcp/codex' ? 'codex' : 'claude';
        const replies = (await Promise.all(
          (Array.isArray(parsed) ? parsed : [parsed]).map((msg) => handleRpc(board, agent, msg)),
        )).filter(Boolean);
        if (replies.length === 0) return send(202);
        return send(200, JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
      }
      return send(404);
    } catch (err) {
      return send(400, JSON.stringify({ error: (err as Error).message }));
    }
  });
  server.on('close', () => phone.close());
  return server;
}

/** The terminal's pairing requests: ask, look at one, list all, or unpair. Failures come back in words. */
async function pairRequest(board: Board, input: Record<string, unknown>, deps: PairDeps): Promise<object> {
  const pc = typeof input.pc === 'string' ? input.pc : '';
  try {
    switch (input.op) {
      case 'ask': return await askPair(board, pc, (input.level ?? 'work') as never, deps);
      case 'state': return { ok: true, ...pairState(board, String(input.id)) };
      case 'list': {
        const status = await pairStatus(board, deps);
        return { ok: true, ...status, lines: statusLines(status) };
      }
      case 'unpair': return await unpair(pc, deps);
      default: return { ok: false, error: 'op must be ask, state, list or unpair' };
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** A pick on one of the board's own cards; null for a card an agent asked, whose answer is mailed. */
export function ownCard(board: Board, card: Card, choice: string, pairing: PairDeps = {}, updating: UpdateDeps = {}): Promise<string> | null {
  const phone = phoneDecision(board, card, choice);
  if (phone) return phone;
  const vault = vaultDecided(board, card, choice);
  if (vault) return vault;
  if (board.pairs.some((p) => p.dir === 'in' && p.cardId === card.id)) return pairDecided(board, card, choice, pairing);
  if (board.offers.some((o) => o.cardId === card.id)) return offerDecided(board, card, choice, updating);
  return null;
}

/** The terminal's update requests: get from paired PCs, or offer to one. */
async function updateRequest(board: Board, input: Record<string, unknown>, deps: UpdateDeps): Promise<object> {
  try {
    const repos = (Array.isArray(input.repos) ? input.repos : []) as RepoName[];
    if (input.op === 'offer') return await offerUpdate(board, String(input.pc ?? ''), deps);
    if (input.op === 'pull') return await pullUpdate(board, { from: typeof input.from === 'string' && input.from ? input.from : undefined, repos }, deps);
    return { ok: false, error: 'op must be pull or offer' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

const USAGE_DAYS = 14;

/** The usage log is for reviewing recent use of the board; older lines are dropped. */
export function trimUsage(file: string, now: number): void {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const kept = lines.filter((line) => now - JSON.parse(line).ts < USAGE_DAYS * 86_400_000);
    if (kept.length < lines.length) fs.writeFileSync(file, kept.map((line) => `${line}\n`).join(''));
  } catch {
    /* no log yet, or an unreadable one: leave it */
  }
}

/**
 * Background work starts only once the server listens (keeper-pc audit, 2026-11-05: a long keeper pass
 * that ran first left 127.0.0.1:47600 silent for minutes). run is called once, delayMs after listening.
 */
export function afterListening(server: http.Server, run: () => void, delayMs = 0): void {
  const go = (): void => { setTimeout(run, delayMs); };
  if (server.listening) go();
  else server.once('listening', go);
}

/**
 * The keeper's ticks (vault-keeper.ts), every everyMs once the server listens. A tick runs in the
 * background and yields between folder moves, so requests are answered while it works. Returns stop.
 */
export function startKeeper(server: http.Server, tick: () => Promise<void>, opts: { delayMs?: number; everyMs?: number } = {}): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  afterListening(server, () => {
    if (stopped) return;
    void tick().catch(() => undefined);
    timer = setInterval(() => void tick().catch(() => undefined), opts.everyMs ?? 30_000);
  }, opts.delayMs ?? 2_000);
  return () => { stopped = true; if (timer) clearInterval(timer); };
}

export async function serve(): Promise<void> {
  // One daemon per PC (instance.ts): the lock comes before any board or keeper work, and a second daemon
  // (a hook that gave up waiting, a manual Start-ScheduledTask) leaves at once, quietly. A board started by
  // one that is updating itself (update.ts) waits for the old one to let go instead.
  const waiting = !!process.env.KOKUBAN_WAIT_PORT;
  const instance = await acquireInstance({ waitMs: waiting ? 20_000 : 0 });
  if (!instance) process.exit(0);
  process.on('exit', () => instance.release());
  const board = new Board(BOARD_FILE);
  try { board.chief = new ChiefService(board); }
  catch { console.error('Chief unavailable; existing chief state was preserved for repair.'); }
  board.conversations = new ConversationService(board);
  await board.conversations.ready;
  board.titler = syncCodexTitle;
  board.remote = remoteFor(board);
  board.onEnd = (id) => sessionEnded(board, id);
  board.onOwnCard = (card, choice) => ownCard(board, card, choice);
  // The feed (feed.ts): this board's part for paired boards, theirs pulled when they poke and every minute.
  board.feedState = () => stateFor(board);
  board.onPoke = (pc) => void pull(board, pc);
  board.onChange = () => changed(board);
  const usage = path.join(DATA_DIR, 'usage.jsonl');
  trimUsage(usage, Date.now());
  board.usage = (entry) => fs.appendFile(usage, `${JSON.stringify(entry)}\n`, () => {});
  // The board's own timer: catches a session that went idle just after mail arrived, and retries.
  board.onSend = batchWakeScheduler(board, () => { void wakeCodex(board); wakeKimi(board); });
  // D91: every repository a session opens gets its vault project space (vault-projects.ts).
  enableProjectSpaces(board);
  // D131: this PC's working copy of each repository, in its vault space (vault-working-copies.ts).
  enableWorkingCopies(board);
  const server = createServer(board);
  watchStalls(server);
  // The port is the second guard: taken by something else, this one bows out.
  let tries = waiting ? 40 : 0;
  delete process.env.KOKUBAN_WAIT_PORT;
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && tries-- > 0) return void setTimeout(() => server.listen(PORT, '127.0.0.1'), 500);
    process.exit(err.code === 'EADDRINUSE' ? 0 : 1);
  });
  // A Codex thread opened while the board was down built its tool list without
  // kokuban and never retries; reloading Codex's MCP servers hands it the tools.
  server.on('listening', () => void codexRpc('config/mcpServer/reload', {}));
  // Listen first: the board answers before any background pass starts.
  server.listen(PORT, '127.0.0.1');
  afterListening(server, () => {
    const autoTick = () => void autoUpdateTick(board).catch(error => console.error('Automatic update held:', String(error)));
    autoTick();
    setInterval(autoTick, 60_000);
    void pullAll(board);
    void syncKnowhow(board);
    setInterval(() => void syncKnowhow(board), 120_000);
    void syncVault(board);
    setInterval(() => void syncVault(board), 120_000);
    setInterval(() => void pullAll(board), 60_000);
    // Question cards: one reminder for one nobody answered, then giving up on it.
    setInterval(() => sweep(board), 60_000);
    setInterval(() => void sweepPairs(board).catch(() => {}), 60_000);
    setInterval(() => sweepOffers(board), 60_000);
    setInterval(() => {
      try { sweepTasks(board); }
      catch { board.usage?.({ ts: board.clock(), tool: 'task:sweep', ok: false }); }
      void flushTasks(board).catch(() => board.usage?.({ ts: board.clock(), tool: 'task:delivery', ok: false }));
    }, 15_000);
    setInterval(() => { void wakeCodex(board); wakeKimi(board); }, 15_000);
    // D130: the helper that wakes an open Kimi window visibly; built from source when missing or stale.
    void ensureTypist();
    setInterval(() => void reapCodex(board), 20_000);
    setInterval(() => reapClaude(board), 10_000);
    void reapCodex(board);
    reapClaude(board);
    setInterval(() => trimUsage(usage, Date.now()), 86_400_000);
    // D131: the hourly working-copies sweep, the first ten minutes after start so a restart never begins with a burst of git.
    setTimeout(() => void sweepWorkingCopies(board), 600_000);
    setInterval(() => void sweepWorkingCopies(board), 3_600_000);
    for (const s of board.sessions) if (board.isLive(s)) syncCodexTitle(s);
    startPhoneNotifications(board);
    board.chief?.start();
    void repairPhoneServe(new PhoneConfig()).catch(() => console.error('Phone Serve configuration needs repair: kokuban phone enable'));
    // A PC that exposes /peer has Serve forward it to the private ingress path (peer.ts PEER_INGRESS).
    void repairPeerServe().then((error) => { if (error) console.error(`Peer Serve configuration needs repair (kokuban pair <pc>): ${error}`); });
  });
  // The shared vault (vault-keeper.ts): queued writes, folder moves and the nightly check-up, after the board
  // answers and never holding a request up for long. Off without settings.
  startKeeper(server, () => keeperTick(board));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      board.flush();
      await board.chief?.close();
      await stopPhoneNotifications(board);
      await board.conversations?.close();
      instance.release();
      process.exit(0);
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
