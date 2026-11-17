import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { APP_KEY, HELLO_MS, forgetApp, nativeApp } from '../src/app-routes.js';
import { Board } from '../src/board.js';
import { SETTINGS, makeCard } from '../src/cards.js';
import { createServer } from '../src/daemon.js';
import { LATER_MS, STUCK_MS, act, changed, feedView, listen, localItems, pull, self, stateFor, usePost, type State } from '../src/feed.js';
import { projectOf } from '../src/git.js';
import { handlePeer } from '../src/peer.js';
import type { WorkTask } from '../src/tasks.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-feed-'));
SETTINGS.file = path.join(tmp, 'settings.json');
fs.writeFileSync(SETTINGS.file, JSON.stringify({ person: 'Alex', people: { Sam: ['pc-b'] }, trust: { 'pc-b.tail1234.ts.net': 'work' } }));

function clocked(): { board: Board; tick: (ms: number) => void } {
  let now = 1_000_000_000;
  return { board: new Board(null, () => now), tick: (ms) => { now += ms; } };
}

function task(board: Board, over: Partial<WorkTask>): WorkTask {
  const t: WorkTask = {
    id: `t-${board.workTasks.length + 1}`, key: 'k', requester: { id: 's-1', name: 'Coral' }, owner: { id: 'r-1', name: 'Iris', pc: 'pc-b.tail1234.ts.net' },
    text: 'Fix the double bookings', state: 'requested', detail: '', revision: 0, created: board.clock(), updated: board.clock(), afterMs: 900_000, ...over,
  };
  board.workTasks.push(t);
  return t;
}

test('a project is the same on every PC: owner/repo from the origin remote, else the folder', () => {
  const repo = path.join(tmp, 'Acme-Booking');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:example-org/Acme.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(projectOf(repo), 'example-org/acme');
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/example-org/kokuban\n');
  assert.equal(projectOf(path.join(repo)), 'example-org/kokuban');
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[core]\n');
  assert.equal(projectOf(repo), 'acme-booking');
});

test('card text and links reach the reader in full, including paragraphs and late URLs', () => {
  const { board } = clocked();
  const card = makeCard(board, { agent: 'Isla' }, { question: 'Open your strategy paper here', details: 'Long context '.repeat(80) + ' https://example.test/late-link', links: ['https://example.test/paper'] });
  card.thread.push({ from: 'agent', text: 'Updated paper https://example.test/follow-up', ts: board.clock() });
  const item = localItems(board).find(i => i.thread.endsWith(':' + card.id))!;
  assert.equal(item.body, card.details);
  assert.ok(item.links.includes('https://example.test/late-link'));
  assert.ok(item.links.includes('https://example.test/paper'));
  assert.ok(item.links.includes('https://example.test/follow-up'));
  assert.ok(item.steps.some(s => s.text.includes('https://example.test/follow-up')));
});

test('long agent follow-ups and task outcomes preserve all text and the original context', () => {
  const { board } = clocked();
  const details = ('Original context\n\n' + 'Evidence and receipt. '.repeat(60)).trim();
  const question = ('Should we approve? ' + 'Full question context '.repeat(8)).trim();
  const card = makeCard(board, { agent: 'Isla' }, { question, details, choices: ['Approve', 'Wait'] });
  assert.equal(localItems(board)[0]!.title, question);
  card.thread.push({ from: 'person', text: 'Approve', choice: 'Approve', ts: board.clock() });
  const followup = 'Follow-up\n\n' + 'Complete evidence. '.repeat(80) + 'Final receipt.';
  card.thread.push({ from: 'agent', text: followup, ts: board.clock() });
  const item = localItems(board).find(i => i.thread.endsWith(':' + card.id))!;
  assert.ok(item.body.endsWith(followup));
  assert.ok(item.steps.some(s => s.text.endsWith(details)));
  const outcome = task(board, { state: 'done', text: question, detail: followup });
  const result = localItems(board).find(i => i.thread === `task:${outcome.id}`)!;
  assert.equal(result.title, question);
  assert.equal(result.body, followup);
  assert.ok(result.steps.some(s => s.text.endsWith(followup)));
});

test('what waits on the person: questions asked here, and hand-offs sent away once they need them', () => {
  const { board, tick } = clocked();
  makeCard(board, { agent: 'Iris', pc: 'pc-b.tail1234.ts.net' }, { question: 'Ship the booking fix?', choices: ['Deploy', 'Not yet'], project: 'acme' });
  const blocked = task(board, { state: 'blocked', detail: 'needs the Stripe test key' });
  const unaccepted = task(board, {});
  task(board, { requester: { id: 'x', name: 'Iris', pc: 'pc-b' }, owner: { id: 's-1', name: 'Coral' }, state: 'blocked' });
  task(board, { owner: { id: 'r-2', name: 'Rook' }, state: 'blocked' });
  let items = localItems(board);
  assert.deepEqual(items.map((i) => i.kind), ['decide'], 'a fresh block or request is not the person\'s yet');
  assert.deepEqual(items[0]!.choices.map((c) => c.label), ['Close prompt', 'Deploy', 'Not yet']);
  assert.equal(items[0]!.person, 'Alex');
  assert.equal(items[0]!.pc, 'pc-b');

  tick(STUCK_MS);
  items = localItems(board);
  assert.deepEqual(items.map((i) => i.thread).sort(), [`card:${self()}:1`, `task:${blocked.id}`, `task:${unaccepted.id}`].sort(),
    'neither a hand-off asked of this PC nor one that stayed on it');
  assert.match(items.find((i) => i.thread === `task:${unaccepted.id}`)!.body, /Not picked up for 30 min/);

  blocked.state = 'done';
  blocked.detail = 'Connected; tests pass.';
  const done = localItems(board).find((i) => i.thread === `task:${blocked.id}`)!;
  assert.equal(done.kind, 'done');
  assert.deepEqual(done.choices, [{ id: 'seen', label: 'Seen' }]);
});

test('Later hides an item for two hours; Seen clears a finished one; a choice answers the question', async () => {
  const { board, tick } = clocked();
  const card = makeCard(board, { agent: 'Iris', sessionId: 'nobody' }, { question: 'Ship it?', choices: ['Yes', 'No'] });
  const thread = `card:${self()}:${card.id}`;
  await act(board, thread, 'later');
  assert.equal(feedView(board).mine.length, 0);
  assert.equal(feedView(board).later[0]!.until, board.clock() + LATER_MS);
  tick(LATER_MS + 1);
  assert.equal(feedView(board).mine.length, 1, 'back after two hours');

  await act(board, thread, 'pick:0');
  assert.equal(card.thread[0]!.choice, 'Yes');
  assert.equal(feedView(board).mine.length, 0, 'answered: no longer waiting');

  // The agent speaks after the answer: the card returns with its words, Seen, and only the other choice.
  card.thread.push({ from: 'agent', text: 'Opened the draft PR.', ts: board.clock() });
  let back = feedView(board).mine[0]!;
  assert.equal(back.body, 'You answered “Yes”. Opened the draft PR.');
  assert.deepEqual(back.choices, [{ id: 'close', label: 'Close prompt' }, { id: 'seen', label: 'Seen' }, { id: 'pick:1', label: 'No' }]);
  await act(board, thread, 'seen');
  assert.equal(feedView(board).mine.length, 0, 'seen until the agent says more');
  tick(1);
  card.thread.push({ from: 'agent', text: 'Checks are green.', ts: board.clock() });
  back = feedView(board).mine[0]!;
  assert.match(back.body, /Checks are green/);
  await act(board, thread, 'seen');

  const t = task(board, { state: 'done', detail: 'done' });
  assert.equal(feedView(board).mine.length, 1);
  await act(board, `task:${t.id}`, 'seen');
  assert.equal(feedView(board).mine.length, 0);
  await assert.rejects(act(board, 'card:otherpc:1', 'pick:0'), /answer it there/);
  await assert.rejects(act(board, 'task:missing', 'cancel'), /not on this PC/);
});

test('Cancel stops a hand-off for the person; a reply goes to the agent that is stuck', async () => {
  const { board } = clocked();
  const sent: Array<Record<string, unknown>> = [];
  board.remote = async (request) => { sent.push(request); return JSON.stringify({ ok: true }); };
  const t = task(board, { state: 'blocked', detail: 'needs a key' });
  assert.equal(await act(board, `task:${t.id}`, 'reply', 'It is in 1Password under Stripe test'), 'sent to Iris');
  assert.equal(sent[0]!.op, 'agent_send');
  assert.equal(sent[0]!.to, 'Iris');
  assert.match(String(sent[0]!.text), /Alex, about task t-1/);
  await act(board, `task:${t.id}`, 'cancel');
  assert.equal(t.cancelRequested, 'Cancelled by Alex from the feed.');
});

test('the view merges paired boards: their person\'s items, sessions by project, running work', async () => {
  const { board } = clocked();
  const { session } = board.touch('s-1', '', 'claude');
  session.project = 'example-org/acme';
  const theirs: State = {
    person: 'Sam', pc: 'pc-b', running: [{ thread: 'task:r', from: 'Iris@pc-b', to: 'Alder@keeper-pc', title: 'Booking', detail: '', state: 'accepted', ts: 1 }],
    items: [{ thread: 'card:pc-b:4', kind: 'decide', person: 'Sam', pc: 'pc-b', board: 'pc-b', agent: 'Brook', project: 'aoz', title: 'Approve the Slack reply?',
      body: '', choices: [], reply: true, ts: 5, lang: 'ja', steps: [], files: [], links: [] }],
    sessions: [{ name: 'Iris', host: 'claude', project: 'example-org/acme', where: 'acme@main', status: 'working', work: '', doing: 'Booking fix', next: '', holds: [], pc: 'pc-b', person: 'Sam' }],
    history: [],
  };
  const asked: string[] = [];
  usePost(board, async (pc, body) => { asked.push(`${pc}:${String(body.op)}`); return { ok: true, state: theirs }; });
  await pull(board, 'pc-b.tail1234.ts.net');
  const view = feedView(board);
  assert.deepEqual(view.theirs.map((t) => [t.person, t.items.length]), [['Sam', 1]]);
  assert.equal(view.mine.length, 0);
  const acme = view.projects.find((p) => p.project === 'example-org/acme')!;
  assert.deepEqual(acme.sessions.map((s) => `${s.name}@${s.pc}`).sort(), [`${session.name}@${self()}`, 'Iris@pc-b'].sort());
  assert.equal(view.running.length, 1);
  assert.equal(view.pcs.find((p) => p.pc === 'pc-b')!.ok, true);

  usePost(board, async () => { throw new Error('pc-b did not answer'); });
  await pull(board, 'pc-b.tail1234.ts.net');
  const stale = feedView(board);
  assert.equal(stale.pcs.find((p) => p.pc === 'pc-b')!.ok, false);
  assert.equal(stale.theirs.length, 1, 'what it last said is kept while it is away');

  await act(board, 'card:pc-b:4', 'seen');
  assert.equal(feedView(board).theirs.length, 0, 'clear only this reader\'s shared notification');
  assert.equal(theirs.items.length, 1, 'the source question remains unanswered');
  assert.equal(stateFor(board).items.length, 0, 'no answer or replacement question is created');
  await act(board, 'unrelated', 'later');
  assert.equal(feedView(board).theirs.length, 0, 'old seen marks survive pruning');
  theirs.items[0]!.ts = board.clock() + 1;
  usePost(board, async () => ({ ok: true, state: theirs }));
  await pull(board, 'pc-b.tail1234.ts.net');
  assert.equal(feedView(board).theirs.length, 1, 'a new update is visible again');
});

test('a change pokes paired boards once, and only when what they see changed', async () => {
  const { board } = clocked();
  const pokes: string[] = [];
  usePost(board, async (pc, body) => { pokes.push(`${pc}:${String(body.op)}`); return { ok: true }; });
  let heard = 0;
  listen(board, () => heard++);
  const pcs = () => ['pc-b.tail1234.ts.net'];
  changed(board, pcs);
  changed(board, pcs);
  await new Promise((r) => setTimeout(r, 900));
  assert.deepEqual(pokes, ['pc-b.tail1234.ts.net:poke']);
  changed(board, pcs);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(pokes.length, 1, 'nothing new for them');
  assert.equal(heard, 2, 'the windows here hear every change');
});

test('/peer "state" needs share trust; "poke" needs talk and asks this board to pull', async () => {
  const { board } = clocked();
  board.feedState = () => stateFor(board);
  const poked: string[] = [];
  board.onPoke = (pc) => poked.push(pc);
  const headers = { 'tailscale-user-login': 'k@example.com', 'x-forwarded-for': '100.64.0.11' };
  const lookup = async () => ({ login: 'k@example.com', node: 'pc-b.tail1234.ts.net' });
  const talk = await handlePeer(board, headers, { op: 'state' }, { lookup, trust: () => 'talk' });
  assert.equal(talk.status, 403);
  const share = await handlePeer(board, headers, { op: 'state' }, { lookup, trust: () => 'share' });
  assert.equal(share.status, 200);
  assert.equal((share.body as { state: State }).state.person, 'Alex');
  assert.equal((await handlePeer(board, headers, { op: 'poke' }, { lookup, trust: () => 'talk' })).status, 200);
  assert.deepEqual(poked, ['pc-b.tail1234.ts.net']);
});

test('the app routes need the key; a page elsewhere gets nothing', async () => {
  const { board } = clocked();
  makeCard(board, { agent: 'Iris', sessionId: 'nobody' }, { question: 'Ship it?', choices: ['Yes', 'No'] });
  const server = createServer(board);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/app/feed.json`)).status, 404);
    assert.equal((await fetch(`${base}/app/feed.json?t=${'0'.repeat(32)}`)).status, 404);
    const view = await (await fetch(`${base}/app/feed.json?t=${APP_KEY}`)).json() as { mine: Array<{ thread: string }> };
    assert.equal(view.mine.length, 1);
    assert.equal((await fetch(`${base}/app?t=${APP_KEY}&as=pill`)).status, 404, 'native app only: retired web page is gone');
    assert.equal((await fetch(`${base}/app/open?as=pill`, { headers: { origin: 'https://evil.example' } })).status, 403);
    const opened = await (await fetch(`${base}/app/open?as=auto`)).json() as { url: string };
    assert.match(opened.url, /&as=pill$/, 'something waits: the pill');
    const acted = await (await fetch(`${base}/app/act`, { method: 'POST', body: new URLSearchParams({ t: APP_KEY, thread: view.mine[0]!.thread, action: 'later' }) })).json() as { ok: boolean };
    assert.equal(acted.ok, true);
    const empty = await (await fetch(`${base}/app/open?as=auto`)).json() as { url: string };
    assert.match(empty.url, /&as=window$/, 'nothing waits: the window');
    const refused = await fetch(`${base}/app/act`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: new URLSearchParams({ t: APP_KEY, thread: 'x', action: 'later' }) });
    assert.equal(refused.status, 403);
    const key = await (await fetch(`${base}/app/key`)).json() as { key: string; api: number };
    assert.deepEqual(key, { key: APP_KEY, api: 1 }, 'a local program gets the key and the contract');
    assert.equal((await fetch(`${base}/app/key`, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/app/key`, { headers: { origin: base } })).status, 403, 'not even the page itself');
    const full = await (await fetch(`${base}/app/feed.json?t=${APP_KEY}`)).json() as { api: number; lang: string };
    assert.equal(full.api, 1);
    assert.match(full.lang, /^(en|ja)$/);
  } finally {
    server.close();
  }
});

test('the Windows app says hello, and while it runs the board leaves the pill and the cards to it', async () => {
  forgetApp();
  const { board } = clocked();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-file-'));
  const file = path.join(dir, 'plan.md');
  fs.writeFileSync(file, '# The plan');
  const card = makeCard(board, { agent: 'Iris', sessionId: 'nobody' }, { question: 'Read this?', choices: ['Yes'] }, [{ name: 'plan.md', path: file }]);
  const server = createServer(board);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal(nativeApp(), null, "no hello yet: today's behaviour");
    assert.equal((await fetch(`${base}/app/native`)).status, 404);
    const say = (body: Record<string, string>, headers: Record<string, string> = {}) =>
      fetch(`${base}/app/hello`, { method: 'POST', headers, body: new URLSearchParams({ t: APP_KEY, ...body }) });
    assert.equal((await say({ pid: String(process.pid), exe: 'C:\\Kokuban\\Kokuban.exe' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await say({ pid: 'x', exe: 'C:\\Kokuban\\Kokuban.exe' })).status, 400);
    assert.equal((await say({ pid: String(process.pid), exe: 'kokuban.sh' })).status, 400, 'only a Windows program path');
    assert.equal((await say({ pid: String(process.pid), exe: 'C:\\Windows\\notepad.exe' })).status, 400, 'only the app itself');
    assert.equal((await say({ pid: String(process.pid), exe: 'C:\\Kokuban\\Kokuban.exe' })).status, 200);
    assert.deepEqual(nativeApp(), { pid: process.pid, exe: 'C:\\Kokuban\\Kokuban.exe' });
    assert.equal(nativeApp(Date.now() + HELLO_MS + 1), null, 'two missed hellos: gone');
    assert.equal((await fetch(`${base}/app/native`)).status, 200);
    const thread = `card:${self()}:${card.id}`;
    const got = await fetch(`${base}/app/file?t=${APP_KEY}&thread=${encodeURIComponent(thread)}&n=0`);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), '# The plan');
    assert.match(got.headers.get('content-disposition') ?? '', /attachment; filename\*=UTF-8''plan\.md/);
    assert.equal((await fetch(`${base}/app/file?t=${APP_KEY}&thread=${encodeURIComponent(thread)}&n=1`)).status, 404);
    assert.equal((await fetch(`${base}/app/file?t=${APP_KEY}&thread=card:pc-b:${card.id}&n=0`)).status, 404, "another PC's card is served there");
    assert.equal((await fetch(`${base}/app/file?thread=${encodeURIComponent(thread)}&n=0`)).status, 404, 'the key is needed');
  } finally {
    server.close();
    forgetApp();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('self aliases and duplicate peer aliases contribute only one board', async () => {
  const { board } = clocked();
  board.touch('alias-test', '', 'codex');
  const local = stateFor(board);
  const remote: State = { ...local, pc: 'other-pc', sessions: local.sessions.map(s => ({ ...s, pc: 'other-pc' })) };
  usePost(board, async pc => ({ ok: true, state: pc === 'self-alias' ? local : remote }));
  await pull(board, 'self-alias');
  await pull(board, 'remote-alias-one');
  await pull(board, 'remote-alias-two');
  const view = feedView(board);
  assert.equal(view.projects.flatMap(p => p.sessions).length, local.sessions.length * 2);
  assert.equal(view.pcs.length, 2);
  assert.equal(view.pcs[0]!.pc, self());
});

// -- sessions that wait on the person (needs-you.ts, D134) ----------------------------------------

function mine(board: Board): ReturnType<typeof localItems> { return localItems(board).filter((i) => i.thread.startsWith('session:')); }
function sess(board: Board, id: string, name: string) {
  const s = board.touch(id, tmp, 'claude').session;
  s.name = name;
  return s;
}

test('a session that is blocked, or waits on the person by name, is an item; other states are not', () => {
  const { board } = clocked();
  const a = sess(board, 'sa', 'Rosa');
  const b = sess(board, 'sb', 'Iris');
  const c = sess(board, 'sc', 'Coral');
  const d = sess(board, 'sd', 'Mina');
  const e = sess(board, 'se', 'Nell');
  board.setWork(a, 'blocked', 'Needs the API key');
  board.setWork(b, 'waiting', 'Waiting for alex to pick the colours');
  board.setWork(c, 'waiting', 'Waiting for the build to finish');
  board.setWork(d, 'paused', 'Alex said stop');
  board.setWork(e, 'done');
  const items = mine(board);
  assert.deepEqual(items.map((i) => i.thread).sort(), ['session:sa:blocked', 'session:sb:waiting']);
  const blocked = items.find((i) => i.thread === 'session:sa:blocked')!;
  assert.equal(blocked.kind, 'blocked');
  assert.equal(blocked.body, 'Needs the API key');
  assert.equal(blocked.agent, 'Rosa');
  assert.equal(blocked.person, 'Alex');
  assert.equal(blocked.pc, self());
  assert.equal(blocked.reply, false);
  assert.deepEqual(blocked.choices, [{ id: 'seen', label: 'Seen' }]);
  assert.deepEqual([blocked.steps, blocked.files, blocked.links], [[], [], []]);
  assert.equal(items.find((i) => i.thread === 'session:sb:waiting')!.kind, 'decide');
  const view = feedView(board);
  assert.equal(view.mine.filter((i) => i.thread.startsWith('session:')).length, 2, 'they reach the shared list');
  assert.equal(stateFor(board).items.length, 2, 'and travel to paired boards through the state');
});

test('a person name inside another word does not count as naming the person', () => {
  const { board } = clocked();
  const s = sess(board, 'sa', 'Rosa');
  board.setWork(s, 'waiting', 'Waiting for Alexu-san review');
  assert.equal(mine(board).length, 0);
  board.setWork(s, 'waiting', 'Waiting for ALEX.');
  assert.equal(mine(board).length, 1);
});

test('a terminal question or approval is an item after 60 seconds; a managed session never is', () => {
  const { board, tick } = clocked();
  const a = sess(board, 'sa', 'Rosa');
  const m = sess(board, 'sm', 'Chiefy');
  m.managed = 'conv-1';
  a.waitingOnHuman = { kind: 'approval', since: board.clock(), via: 'claude' };
  m.waitingOnHuman = { kind: 'approval', since: board.clock(), via: 'claude' };
  tick(59_000);
  assert.equal(mine(board).length, 0, 'under a minute');
  tick(1_000);
  const items = mine(board);
  assert.deepEqual(items.map((i) => i.thread), ['session:sa:human']);
  assert.equal(items[0]!.kind, 'decide');
  assert.match(items[0]!.title, /approval in its terminal/);
  assert.equal(items[0]!.ts, a.waitingOnHuman.since);
  a.waitingOnHuman = { kind: 'question', since: board.clock(), via: 'claude' };
  tick(60_000);
  assert.match(mine(board)[0]!.title, /question in its terminal/);
  a.waitingOnHuman = undefined;
  assert.equal(mine(board).length, 0, 'cleared at its next step');
});

test('a session the board no longer lists is not an item; a wait older than three days is not either', () => {
  const { board, tick } = clocked();
  const a = sess(board, 'sa', 'Rosa');
  board.setWork(a, 'blocked', 'Needs a key');
  tick(2 * 86_400_000);
  a.seen = board.clock();
  assert.equal(mine(board).length, 1, 'two days old and live');
  tick(2 * 86_400_000);
  a.seen = board.clock();
  assert.equal(mine(board).length, 0, 'older than three days');
  const b = sess(board, 'sb', 'Iris');
  board.setWork(b, 'blocked', 'Needs a key');
  b.state = 'gone';
  assert.equal(mine(board).length, 0, 'gone');
});

test('Seen hides a session item until it changes; the same next recorded again does not change it', async () => {
  const { board, tick } = clocked();
  const a = sess(board, 'sa', 'Rosa');
  board.setWork(a, 'blocked', 'Needs a key');
  const thread = 'session:sa:blocked';
  assert.equal(feedView(board).mine.length, 1);
  tick(1000);
  assert.equal(await act(board, thread, 'seen'), 'seen');
  assert.equal(feedView(board).mine.length, 0);
  tick(1000);
  board.setWork(a, 'blocked', 'Needs   a key');
  assert.equal(feedView(board).mine.length, 0, 'same next, same time');
  assert.equal(a.workAt, 1_000_000_000);
  tick(1000);
  board.setWork(a, 'blocked', 'Needs a different key');
  assert.equal(feedView(board).mine.length, 1, 'a changed next shows it again');
  assert.equal(await act(board, thread, 'later'), 'later');
  assert.equal(feedView(board).mine.length, 0);
  assert.equal(feedView(board).later.length, 1);
});

test('other actions on a session thread fail cleanly', async () => {
  const { board } = clocked();
  const a = sess(board, 'sa', 'Rosa');
  board.setWork(a, 'blocked', 'Needs a key');
  for (const action of ['reply', 'cancel', 'pick:1', 'close']) {
    await assert.rejects(() => act(board, 'session:sa:blocked', action, 'hi'), /not on this PC/);
  }
});

test('/app/feed.json carries a session item in mine', async () => {
  const { board } = clocked();
  board.setWork(sess(board, 'sa', 'Rosa'), 'blocked', 'Needs a key');
  const server = createServer(board);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const view = await (await fetch(`${base}/app/feed.json?t=${APP_KEY}`)).json() as { mine: Array<{ thread: string; kind: string }> };
    assert.deepEqual(view.mine.map((i) => [i.thread, i.kind]), [['session:sa:blocked', 'blocked']]);
  } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});
