import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Board } from '../src/board.js';
import { createServer } from '../src/daemon.js';
import { SETTINGS } from '../src/cards.js';
import { PORT } from '../src/config.js';
import { repairPeerServe, serveTailnet } from '../src/pair.js';
import { bridgeCaller, callPeer, feedSince, handlePeer, ingressSecret, PEER_INGRESS, remoteFor, resolvePc, trustFor, verifyCaller, type Trust } from '../src/peer.js';
import { wakeText } from '../src/wake.js';

const PC_B = 'pc-b.tail1234.ts.net';
const INGRESS = 'a1'.repeat(32);
const headers = { 'tailscale-user-login': 'alex@example.com', 'x-forwarded-for': '100.64.0.11' };
const lookup = async () => ({ login: 'alex@example.com', node: PC_B });
const trusting = (level: Trust | null) => () => level;

function boardWith(name = 'Wren'): { board: Board; id: string } {
  const board = new Board();
  const { session } = board.touch('s-1', '', 'claude');
  session.name = name;
  return { board, id: session.id };
}

test('the caller is who Tailscale says, never what the request claims', async () => {
  await assert.rejects(verifyCaller({}, lookup), /no Tailscale identity/);
  await assert.rejects(verifyCaller({ ...headers, 'x-forwarded-for': 'not-an-ip' }, lookup), /no Tailscale identity/);
  await assert.rejects(verifyCaller(headers, async () => ({ login: 'someone-else@example.com', node: PC_B })), /does not match/);
  assert.equal(await verifyCaller({ ...headers, 'x-forwarded-for': '10.0.0.1, 100.64.0.11' }, lookup), PC_B);
});

test('trust comes from settings.json by full tailnet name, as a level or with a level', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-')), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ trust: { 'PC-B.tail1234.ts.net.': 'work', 'client.tail1234.ts.net': { level: 'share' }, 'odd.tail1234.ts.net': 'root' } }));
  assert.equal(trustFor(PC_B, file), 'work');
  assert.equal(trustFor('client.tail1234.ts.net', file), 'share');
  assert.equal(trustFor('odd.tail1234.ts.net', file), null);
  assert.equal(trustFor('stranger.tail1234.ts.net', file), null);
  assert.equal(trustFor(PC_B, path.join(path.dirname(file), 'missing.json')), null);
});

test('a PC gets only what its trust level allows', async () => {
  const { board } = boardWith();
  const unlisted = await handlePeer(board, headers, { op: 'peers' }, { lookup, trust: trusting(null) });
  assert.equal(unlisted.status, 403);
  assert.match(JSON.stringify(unlisted.body), /not in this PC's trust list/);

  const talk = { lookup, trust: trusting('talk') };
  assert.equal((await handlePeer(board, headers, { op: 'peers' }, talk)).status, 200);
  const glance = await handlePeer(board, headers, { op: 'glance', to: 'Wren' }, talk);
  assert.equal(glance.status, 403);
  assert.match(JSON.stringify(glance.body), /needs \\"share\\" trust/);
  assert.equal((await handlePeer(board, {}, { op: 'peers' }, talk)).status, 403);
  assert.equal((await handlePeer(board, headers, { op: 'run' }, talk)).status, 400);
});

test('mail from a "work" PC wakes a session as its own human\'s work; from a "talk" PC as a peer\'s request', async () => {
  for (const [level, wording] of [['work', /act on it as their work/], ['talk', /weigh it as a request from a peer/]] as const) {
    const { board, id } = boardWith();
    const out = await handlePeer(board, headers, { op: 'send', me: 'Iris', to: 'Wren', text: 'the AOZ build is ready', request_id: 'r1' },
      { lookup, trust: trusting(level) });
    assert.equal(out.status, 200);
    const mail = board.messages.filter((m) => m.to === id);
    assert.equal(mail.length, 1);
    assert.equal(mail[0]!.from, `Iris@${PC_B}`);
    assert.match(wakeText(board, mail), wording);
  }
});

test('cross-PC sends are logged in and out, and read back from a cursor', async () => {
  const { board } = boardWith();
  await handlePeer(board, headers, { op: 'send', me: 'Iris', to: 'Wren', text: 'hello' }, { lookup, trust: trusting('share') });
  await handlePeer(board, headers, { op: 'peers' }, { lookup, trust: trusting('share') });
  const remote = remoteFor(board, async () => JSON.stringify({ ok: true, id: 3 }));
  await remote({ op: 'agent_send', pc: 'pc-b', me: 'Wren', to: 'Iris', text: 'thanks' });
  await remote({ op: 'agent_peers', pc: 'pc-b', me: 'Wren' });
  assert.deepEqual(board.feed.map((e) => [e.dir, e.op, e.to]), [['in', 'send', 'Wren'], ['out', 'send', 'Iris']]);
  const first = feedSince(board, 0);
  assert.equal(first.events.length, 2);
  assert.deepEqual(feedSince(board, first.next).events, []);

  const feed = await handlePeer(board, headers, { op: 'feed', after: 1 }, { lookup, trust: trusting('share') });
  assert.deepEqual((feed.body as { events: unknown[] }).events.length, 1);
  assert.equal((await handlePeer(board, headers, { op: 'feed' }, { lookup, trust: trusting('talk') })).status, 403);
});

test('a short PC name is found on the tailnet', async () => {
  const status = async () => JSON.stringify({
    Self: { DNSName: 'pc-a.tail1234.ts.net.', HostName: 'pc-a' },
    Peer: { a: { DNSName: 'pc-b.tail1234.ts.net.', HostName: 'pc-b' } },
  });
  assert.equal(await resolvePc('keeper-pc.tail1234.ts.net', status), 'keeper-pc.tail1234.ts.net');
  assert.equal(await resolvePc('pc-b', status), PC_B);
});

test('peer transport is direct and never falls back on refusal or downtime', async () => {
  const resolve = async () => PC_B;
  const answer = (status: number, body: object) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  const request = { op: 'agent_send', pc: 'pc-b', me: 'Wren', to: 'Iris', text: 'hi' };
  assert.equal(JSON.parse(await callPeer(request, { resolve, fetch: answer(200, { ok: true, id: 7 }) })).via, 'direct');
  await assert.rejects(callPeer(request, { resolve, fetch: answer(403, { error: 'share trust required' }) }), /share trust required/);
  await assert.rejects(callPeer(request, { resolve, fetch: (async () => { throw new Error('offline'); }) as typeof fetch }), /offline/);
  await assert.rejects(callPeer({ op: 'send' }, { resolve }), /not a board operation/);
});

test('/peer refuses a request without a Tailscale identity, and from a browser page', async () => {
  const server = createServer(new Board(), { ingress: () => INGRESS });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${PEER_INGRESS}${INGRESS}`;
  try {
    const post = (extra: Record<string, string>) => fetch(url, { method: 'POST',
      headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify({ op: 'peers' }) });
    const plain = await post({});
    assert.equal(plain.status, 403);
    assert.match(await plain.text(), /no Tailscale identity/);
    assert.equal((await post({ origin: 'https://evil.example', ...headers })).status, 403);
  } finally {
    server.close();
  }
});

/** A board whose whois answers truthfully for a real work-trusted PC: what a forger would name. */
async function ingressBoard(level: Trust | null, ingress = INGRESS) {
  let touched = 0;
  const vault = { prefix: 'kokuban/', index: async () => { touched++; return { entries: [] }; },
    fetch: async () => { touched++; return []; }, import: async () => { touched++; return {}; } } as never;
  const keeper = { config: () => { touched++; return null; } } as never;
  const server = createServer(new Board(), { lookup, trust: () => level, ingress: () => ingress, vault, keeper });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (route: string, op: string, extra: Record<string, string> = {}) => fetch(`${base}${route}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers, ...extra }, body: JSON.stringify({ op, me: 'Iris', names: ['kokuban/x'] }) });
  return { post, touched: () => touched, close: () => server.close() };
}

const EVERY_OP = ['peers', 'send', 'hello', 'poke', 'pair', 'paired', 'state', 'glance', 'feed', 'knowhow', 'conversations',
  'vault_index', 'vault_fetch', 'vault_write'];

test('a local program writing Serve\'s identity headers to 127.0.0.1/peer is refused for every op', async () => {
  const b = await ingressBoard('work');
  try {
    for (const op of EVERY_OP) {
      const res = await b.post('/peer', op);
      assert.equal(res.status, 403, `${op} on plain /peer`);
      assert.match(await res.text(), /tailscale serve entry/);
      // Guessing at the ingress path does no better.
      for (const route of [PEER_INGRESS, `${PEER_INGRESS}${'b2'.repeat(32)}`, `${PEER_INGRESS}${INGRESS.slice(1)}`, `${PEER_INGRESS}${INGRESS}x`]) {
        assert.equal((await b.post(route, op)).status, 403, `${op} on ${route}`);
      }
    }
    assert.equal(b.touched(), 0, 'the vault and keeper were never reached');
  } finally {
    b.close();
  }
  // A PC that has not made its ingress value yet refuses everything, including the bare ingress prefix.
  const none = await ingressBoard('work', '');
  try {
    for (const route of ['/peer', PEER_INGRESS, `${PEER_INGRESS}${INGRESS}`]) assert.equal((await none.post(route, 'vault_index')).status, 403);
  } finally {
    none.close();
  }
});

test('a request forwarded by Serve to the private ingress is accepted, and trust levels still hold', async () => {
  // What Serve really sends: plain HTTP from loopback, the mount's target path, Tailscale-User-Login and
  // X-Forwarded-For with the caller's tailnet address (checked with whois).
  const route = `${PEER_INGRESS}${INGRESS}`;
  const work = await ingressBoard('work');
  try {
    const peers = await work.post(route, 'peers');
    assert.equal(peers.status, 200);
    assert.equal((await work.post(`${route}/`, 'peers')).status, 200, 'a trailing slash from Serve is the same path');
    assert.notEqual((await work.post(route, 'vault_index')).status, 403);
    assert.ok(work.touched() > 0, 'work trust reaches the vault');
    // Still Tailscale identity, checked with whois.
    assert.equal((await work.post(route, 'peers', { 'tailscale-user-login': '' })).status, 403);
    assert.equal((await work.post(route, 'peers', { 'tailscale-user-login': 'someone-else@example.com' })).status, 403);
    assert.equal((await work.post(route, 'peers', { origin: 'https://evil.example' })).status, 403);
  } finally {
    work.close();
  }
  const talk = await ingressBoard('talk');
  try {
    assert.equal((await talk.post(route, 'peers')).status, 200);
    for (const op of ['state', 'glance', 'vault_index', 'vault_fetch', 'vault_write', 'conversations']) {
      const res = await talk.post(route, op);
      assert.equal(res.status, 403, op);
      assert.match(((await res.json()) as { error: string }).error, /needs "(share|work)" trust/);
    }
    assert.equal(talk.touched(), 0);
  } finally {
    talk.close();
  }
  const share = await ingressBoard('share');
  try {
    assert.equal((await share.post(route, 'state')).status, 200);
    assert.equal((await share.post(route, 'vault_index')).status, 403);
    assert.equal(share.touched(), 0);
  } finally {
    share.close();
  }
  const stranger = await ingressBoard(null);
  try {
    assert.equal((await stranger.post(route, 'peers')).status, 403);
  } finally {
    stranger.close();
  }
});

test('Serve forwards /peer to the private ingress; startup repairs an old entry and leaves other PCs alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-ingress-'));
  const before = SETTINGS.file;
  SETTINGS.file = path.join(dir, 'settings.json');
  fs.writeFileSync(SETTINGS.file, JSON.stringify({ person: 'Alex', trust: { [PC_B]: 'work' } }));
  try {
    const calls: string[][] = [];
    let status: object = {};
    const run = async (args: string[]) => { calls.push(args); return args[1] === 'status' ? JSON.stringify(status) : ''; };
    // Never exposed /peer, or only /phone: nothing is added.
    status = { Web: { 'pc.ts.net:443': { Handlers: { '/phone': { Proxy: 'http://127.0.0.1:47600/phone/_gateway/x' } } } } };
    assert.equal(await repairPeerServe(run), '');
    assert.deepEqual(calls, [['serve', 'status', '--json']]);
    assert.equal(ingressSecret(), '');
    // The old entry, straight to /peer: replaced by the private ingress, settings otherwise kept.
    calls.length = 0;
    status = { ...status, Web: { ...(status as { Web: object }).Web, [`pc.ts.net:${PORT}`]: { Handlers: { '/peer': { Proxy: `http://127.0.0.1:${PORT}/peer` } } } } };
    assert.equal(await repairPeerServe(run), '');
    const secret = ingressSecret();
    assert.match(secret, /^[a-f0-9]{64}$/);
    assert.deepEqual(calls[1], ['serve', '--bg', `--http=${PORT}`, '--set-path', '/peer', `http://127.0.0.1:${PORT}${PEER_INGRESS}${secret}`]);
    const kept = JSON.parse(fs.readFileSync(SETTINGS.file, 'utf8'));
    assert.equal(kept.person, 'Alex');
    assert.deepEqual(kept.trust, { [PC_B]: 'work' });
    // Already right: nothing changes. Pairing again reuses the same value.
    calls.length = 0;
    status = { Web: { [`pc.ts.net:${PORT}`]: { Handlers: { '/peer': { Proxy: `http://127.0.0.1:${PORT}${PEER_INGRESS}${secret}` } } } } };
    assert.equal(await repairPeerServe(run), '');
    assert.equal(calls.length, 1);
    assert.equal(await serveTailnet(run), '');
    assert.equal(calls.at(-1)!.at(-1), `http://127.0.0.1:${PORT}${PEER_INGRESS}${secret}`);
    assert.equal(ingressSecret(), secret);
    assert.match(await repairPeerServe(async () => { throw new Error('no tailscale'); }), /serve status failed/);
  } finally {
    SETTINGS.file = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('end to end: a session here messages a session on another PC, which reads it at its next step and can reply', async () => {
  const HERE = 'alex.tail1234.ts.net';
  const here = new Board();
  const there = new Board();
  const servers = [
    createServer(here, { }),
    // The other PC's board, as Tailscale Serve presents this PC to it.
    createServer(there, { lookup: async () => ({ login: 'alex@example.com', node: HERE }), trust: () => 'work', ingress: () => INGRESS }),
  ];
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))));
  const [herePort, therePort] = servers.map((s) => (s.address() as AddressInfo).port);
  // Tailscale Serve, in miniature: the request reaches the other board from loopback, on the private
  // ingress path its Serve entry names, with the caller's identity.
  const serve = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new URL(String(url)).pathname, '/peer', 'a calling board names only /peer');
    return fetch(`http://127.0.0.1:${therePort}${PEER_INGRESS}${INGRESS}`, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } });
  }) as typeof fetch;
  here.remote = remoteFor(here, (req) => callPeer(req, { fetch: serve, resolve: async () => PC_B }));
  const hook = (port: number, body: object) => fetch(`http://127.0.0.1:${port}/hook/claude`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const tool = async (port: number, name: string, args: object) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return ((await res.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
  };
  try {
    await hook(herePort!, { hook_event_name: 'SessionStart', source: 'startup', session_id: 'a', cwd: '' });
    await hook(therePort!, { hook_event_name: 'SessionStart', source: 'startup', session_id: 'b', cwd: '' });
    const me = here.sessions[0]!.name;
    const them = there.sessions[0]!.name;

    const peers = await tool(herePort!, 'remote', { me, op: 'peers', pc: 'pc-b', explicit: true });
    assert.match(peers, new RegExp(`"name":"${them}"`));
    assert.match(peers, /"via":"direct"/);

    const sent = JSON.parse(await tool(herePort!, 'remote', { me, op: 'send', pc: 'pc-b', to: them, text: 'the AOZ build is up', explicit: true }));
    assert.equal(sent.ok, true);
    const step = await (await hook(therePort!, { hook_event_name: 'PostToolUse', session_id: 'b', cwd: '' })).json() as
      { hookSpecificOutput: { additionalContext: string } };
    assert.match(step.hookSpecificOutput.additionalContext, new RegExp(`the AOZ build is up[\\s\\S]*Message from ${me}@${HERE}`));
    assert.ok(step.hookSpecificOutput.additionalContext.includes(`remote(op="send", pc="${HERE}", to="${me}"`));

    const receipt = JSON.parse(await tool(herePort!, 'remote', { me, op: 'receipt', pc: 'pc-b', id: sent.id, explicit: true }));
    assert.equal(receipt.state, 'queued');
    await hook(therePort!, { hook_event_name: 'PostToolUse', session_id: 'b', cwd: '' });
    const confirmed = JSON.parse(await tool(herePort!, 'remote', { me, op: 'receipt', pc: 'pc-b', id: sent.id, explicit: true }));
    assert.equal(confirmed.state, 'delivered');
    assert.deepEqual(here.feed.map((e) => [e.dir, e.op]), [['out', 'send']]);
    assert.deepEqual(there.feed.map((e) => [e.dir, e.op, e.agent]), [['in', 'send', me]]);
  } finally {
    servers.forEach((s) => s.close());
  }
});

test('a retried request is applied once', async () => {
  const { board, id } = boardWith();
  const deps = { lookup, trust: trusting('share') as () => Trust | null };
  const req = { op: 'send', me: 'Iris', to: 'Wren', text: 'once', envelope: 'e-1' };
  const first = await handlePeer(board, headers, req, deps);
  const again = await handlePeer(board, headers, req, deps);
  assert.deepEqual(again, first);
  assert.equal(board.messages.filter((m) => m.to === id).length, 1);
});

test('bridgeCaller: this PC by any of its names; without a known tailnet name, its host name decides (D97)', async () => {
  const ask = (pc: string, self: string[]) => bridgeCaller({}, { op: 'send', from: { pc, agent: 'A' } }, { self: () => self, trust: () => 'work' });
  assert.deepEqual(await ask('box.tail1.ts.net', ['box.tail1.ts.net', 'box', 'box-os']), { pc: 'box.tail1.ts.net', level: 'share' });
  assert.deepEqual(await ask('BOX-OS', ['box.tail1.ts.net', 'box', 'box-os']), { pc: 'box-os', level: 'share' });
  assert.equal(((await ask('box.tail2.ts.net', ['box.tail1.ts.net', 'box'])) as { status: number }).status, 403);
  assert.deepEqual(await ask('box.tail2.ts.net', ['box']), { pc: 'box.tail2.ts.net', level: 'share' });
  assert.equal(((await ask('other', ['box'])) as { status: number }).status, 403);
  // No name at all is this PC, under its first name; the trust list is never consulted for it.
  assert.deepEqual(await bridgeCaller({}, { op: 'peers' }, { self: () => ['box.tail1.ts.net'], trust: () => null }),
    { pc: 'box.tail1.ts.net', level: 'share' });
});
