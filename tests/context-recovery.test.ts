import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Board, FORGET_MS, type Host } from '../src/board.js';
import { contextTool } from '../src/context.js';
import { taskTool } from '../src/tasks.js';
import { nativeMemoryDirectories } from '../src/native-memory.js';
import { handleHook } from '../src/hooks.js';
import { createServer } from '../src/daemon.js';
import type { AddressInfo } from 'node:net';

const hosts: Host[] = ['claude', 'codex', 'kimi'];
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-context-'));
  let now = 1_000_000;
  const board = new Board(path.join(directory, 'board.json'), () => now);
  const sessions = hosts.map(host => {
    const s = board.touch(host, directory, host).session;
    s.where = 'fixture@main'; s.project = 'owner/fixture';
    s.transcript = path.join(directory, `${host}.jsonl`);
    return s;
  });
  return { board, sessions, directory, tick: (ms: number) => { now += ms; }, clock: () => now };
}
function publicRecord(host: Host, text: string): object {
  if (host === 'claude') return { type: 'user', message: { content: text } };
  if (host === 'codex') return { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } };
  return { type: 'agent.message.appended', agentId: 'main', message: { message: { role: 'user', content: [{ type: 'text', text }] }, meta: { origin: { kind: 'user' } } } };
}
const json = (v: string) => JSON.parse(v);

for (const from of hosts) for (const to of hosts) if (from !== to) {
  test(`${from} -> ${to}: retrieve native evidence and shared checkpoint without copying a conversation`, async () => {
    const f = fixture(), owner = f.sessions.find(s => s.host === from)!, requester = f.sessions.find(s => s.host === to)!;
    fs.writeFileSync(owner.transcript!, JSON.stringify(publicRecord(from, 'Accepted reference café 日本: keep layout A.')) + '\n');
    const search = json(await contextTool(f.board, requester, { op: 'search', who: owner.id, q: 'café 日本' }));
    assert.equal(search.matches.length, 1);
    const match = search.matches[0];
    const detail = json(await contextTool(f.board, requester, { op: 'read', ref: match.ref, part: match.parts[0].part }));
    assert.match(detail.text, /Accepted reference café 日本/);
    const task = json(await taskTool(f.board, requester, { op: 'create', to: owner.name, text: 'Continue the agreed layout.' }));
    await taskTool(f.board, owner, { op: 'accept', id: task.id });
    await contextTool(f.board, owner, { op: 'checkpoint', task: task.id, expected_revision: 0,
      data: { objective: 'Implement layout A', next: 'Verify keyboard navigation', reference: match.ref,
        verified: ['Source compiles; browser verification is still outstanding'], remaining: ['Keyboard verification'], boundaries: ['No deployment'] } });
    const resume = json(await contextTool(f.board, requester, { op: 'resume', task: task.id }));
    assert.equal(resume.checkpoint.author.host, from);
    assert.equal(resume.checkpoint.data.next, 'Verify keyboard navigation');
    assert.equal(resume.tasks[0].state, 'accepted');
    f.board.flush();
    const recovered = new Board(path.join(f.directory, 'board.json'), f.clock);
    const reader = recovered.sessions.find(s => s.id === requester.id)!;
    assert.equal(json(await contextTool(recovered, reader, { op: 'resume', task: task.id })).checkpoint.revision, 1);
    assert.match(json(await contextTool(recovered, reader, { op: 'read', ref: match.ref })).text, /layout A/);
  });
}

test('search excludes private reasoning, schemas, subagents and compaction copies on every host', async () => {
  const f = fixture();
  const privateRecords: Record<string, object[]> = {
    claude: [
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'secretneedle' }] } },
      { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'secretneedle' }] } },
    ],
    codex: [
      { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'secretneedle' }] } },
      { type: 'compacted', payload: { replacement_history: [publicRecord('codex', 'secretneedle')] } },
    ],
    kimi: [
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'think', think: 'secretneedle' } } },
      { type: 'mcp.tools_discovered', text: 'secretneedle' },
      { ...publicRecord('kimi', 'secretneedle'), agentId: 'child' },
      { type: 'context.append_message', message: { role: 'user', content: 'secretneedle' } },
    ],
  };
  for (const s of f.sessions) fs.writeFileSync(s.transcript!, privateRecords[s.host]!.map(r => JSON.stringify(r)).join('\n') + '\n');
  const search = json(await contextTool(f.board, f.sessions[0]!, { op: 'search', q: 'secretneedle' }));
  assert.equal(search.matches.length, 0);
});

test('pagination searches beyond the glance tail and expands bounded excerpts with stable references', async () => {
  const f = fixture(), s = f.sessions[0]!;
  const records = [publicRecord('claude', 'needle at the beginning'), ...Array.from({ length: 3000 }, () => publicRecord('claude', 'filler'.repeat(25))),
    publicRecord('claude', 'needle ' + 'long evidence '.repeat(1000)), publicRecord('claude', 'needle last')];
  fs.writeFileSync(s.transcript!, records.map(r => JSON.stringify(r)).join('\r\n') + '\r\n');
  let cursor: string | null = null; const matches: any[] = [];
  do {
    const page = json(await contextTool(f.board, s, { op: 'search', who: s.id, q: 'needle', limit: 1, ...(cursor ? { cursor } : {}) }));
    matches.push(...page.matches); cursor = page.next_cursor;
  } while (cursor);
  assert.equal(matches.length, 3);
  const first = json(await contextTool(f.board, s, { op: 'read', ref: matches[1].ref }));
  assert.equal(first.text.length, 6000); assert.equal(first.next_offset, 6000);
  const second = json(await contextTool(f.board, s, { op: 'read', ref: matches[1].ref, offset: first.next_offset }));
  assert.ok(second.text.length > 0);
  fs.appendFileSync(s.transcript!, JSON.stringify(publicRecord('claude', 'appended')) + '\n');
  assert.equal(json(await contextTool(f.board, s, { op: 'read', ref: matches[0].ref })).text, 'needle at the beginning');
  await assert.rejects(contextTool(f.board, s, { op: 'search', q: 'other', cursor: json(await contextTool(f.board, s, { op: 'search', q: 'needle', limit: 1 })).next_cursor }), /different query/);
});

test('changed, missing and incomplete native records are reported without fabricating evidence', async () => {
  const f = fixture(), s = f.sessions[0]!;
  fs.writeFileSync(s.transcript!, JSON.stringify(publicRecord('claude', 'needle')));
  assert.equal(json(await contextTool(f.board, s, { op: 'search', who: s.id, q: 'needle' })).matches.length, 0);
  fs.appendFileSync(s.transcript!, '\n');
  const match = json(await contextTool(f.board, s, { op: 'search', who: s.id, q: 'needle' })).matches[0];
  fs.writeFileSync(s.transcript!, JSON.stringify(publicRecord('claude', 'edited')) + '\n');
  await assert.rejects(contextTool(f.board, s, { op: 'read', ref: match.ref }), /Source changed/);
  fs.unlinkSync(s.transcript!);
  await assert.rejects(contextTool(f.board, s, { op: 'read', ref: match.ref }), /unavailable/);
  assert.ok(json(await contextTool(f.board, s, { op: 'search', who: s.id, q: 'needle' })).unavailable.includes(s.id));
});

test('archived transcript pointers survive roster pruning; scope does not rely on matching repository basenames', async () => {
  const f = fixture(), s = f.sessions[0]!, other = f.sessions[1]!;
  fs.writeFileSync(s.transcript!, JSON.stringify(publicRecord('claude', 'archivedneedle')) + '\n');
  fs.writeFileSync(other.transcript!, JSON.stringify(publicRecord('codex', 'archivedneedle')) + '\n');
  other.project = 'someone-else/fixture';
  assert.equal(json(await contextTool(f.board, s, { op: 'search', q: 'archivedneedle' })).matches.length, 1);
  assert.equal(json(await contextTool(f.board, s, { op: 'search', q: 'archivedneedle', cross_repo: true })).matches.length, 2);
  f.board.save(); f.tick(FORGET_MS + 1);
  const fresh = f.board.touch('fresh', f.directory, 'kimi').session; fresh.where = s.where; fresh.project = s.project;
  assert.ok(!f.board.sessions.some(v => v.id === s.id));
  const found = json(await contextTool(f.board, fresh, { op: 'search', q: 'archivedneedle' }));
  assert.equal(found.matches.length, 1);
});

test('checkpoint writes reject stale revisions and unknown fields, preserving history without completing work', async () => {
  const f = fixture(), s = f.sessions[0]!;
  const initial = { objective: 'Build carefully', next: 'Run the integration test', boundaries: ['Do not deploy'] };
  await contextTool(f.board, s, { op: 'checkpoint', expected_revision: 0, data: initial });
  await assert.rejects(contextTool(f.board, s, { op: 'checkpoint', expected_revision: 0, data: { ...initial, next: 'Overwrite' } }), /revision changed/);
  await assert.rejects(contextTool(f.board, s, { op: 'checkpoint', expected_revision: 1, data: { ...initial, guessed: true } }), /Unknown checkpoint/);
  await contextTool(f.board, s, { op: 'checkpoint', expected_revision: 1, data: { ...initial, next: 'Review test evidence' } });
  assert.equal(s.checkpointHistory?.length, 1);
  assert.equal(s.checkpoint?.data.next, 'Review test evidence');
  assert.notEqual(s.work, 'done');
});

test('existing native memory is explicitly retrievable, including its final line; machine memory requires cross-repository scope', async () => {
  const f = fixture(), s = f.sessions[0]!;
  const oldClaude = process.env.CLAUDE_CONFIG_DIR, oldCodex = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = path.join(f.directory, 'claude'); process.env.CODEX_HOME = path.join(f.directory, 'codex');
  try {
    const dirs = nativeMemoryDirectories(s);
    for (const dir of dirs) { fs.mkdirSync(dir.directory, { recursive: true }); fs.writeFileSync(path.join(dir.directory, 'MEMORY.md'), 'native-memory-needle'); }
    const local = json(await contextTool(f.board, s, { op: 'search', source: 'memory', q: 'native-memory-needle' }));
    assert.equal(local.matches.length, 1);
    assert.equal(local.matches[0].host, 'claude');
    assert.equal(json(await contextTool(f.board, s, { op: 'read', source: 'memory', ref: local.matches[0].ref })).text, 'native-memory-needle');
    assert.equal(json(await contextTool(f.board, s, { op: 'search', source: 'memory', q: 'native-memory-needle', cross_repo: true })).matches.length, 2);
    assert.match(json(await contextTool(f.board, s, { op: 'capabilities' })).settings, /No memory settings changed/);
  } finally {
    if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
  }
});

test('discovery catalogs older Claude, Codex and Kimi logs in bounded metadata pages', async () => {
  const f = fixture(), s = f.sessions[0]!;
  s.project = path.basename(f.directory).toLowerCase();
  const old = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, KIMI_CODE_HOME: process.env.KIMI_CODE_HOME };
  process.env.CLAUDE_CONFIG_DIR = path.join(f.directory, 'native-claude');
  process.env.CODEX_HOME = path.join(f.directory, 'native-codex');
  process.env.KIMI_CODE_HOME = path.join(f.directory, 'native-kimi');
  const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
  try {
    write(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'project', 'old.jsonl'),
      JSON.stringify({ ...publicRecord('claude', 'historicalneedle'), cwd: f.directory, sessionId: 'old-claude' }) + '\n');
    write(path.join(process.env.CODEX_HOME, 'sessions', '2026', 'rollout-old.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id: 'old-codex', cwd: f.directory } }) + '\n' + JSON.stringify(publicRecord('codex', 'historicalneedle')) + '\n');
    const kimi = path.join(process.env.KIMI_CODE_HOME, 'sessions', 'wd_project', 'session_old');
    write(path.join(kimi, 'state.json'), JSON.stringify({ id: 'old-kimi', cwd: f.directory }));
    write(path.join(kimi, 'agents', 'main', 'wire.jsonl'), JSON.stringify(publicRecord('kimi', 'historicalneedle')) + '\n');
    let cursor: string | null = null, added = 0;
    do {
      const page = json(await contextTool(f.board, s, { op: 'discover', limit: 1, ...(cursor ? { cursor } : {}) }));
      assert.ok(page.inspected <= 1); added += page.added; cursor = page.next_cursor;
    } while (cursor);
    assert.equal(added, 3);
    const search = json(await contextTool(f.board, s, { op: 'search', q: 'historicalneedle' }));
    assert.equal(search.matches.length, 3);
    const recovered = new Board(path.join(f.directory, 'board.json'), f.clock);
    assert.equal(recovered.transcriptSources.filter(v => v.id.startsWith('old-') || v.id === 'kimi-old-kimi').length, 3);
  } finally {
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('search cursors detect rewritten source anchors and time/kind filters remain explicit', async () => {
  const f = fixture(), s = f.sessions[0]!;
  fs.writeFileSync(s.transcript!, [
    { ...publicRecord('claude', 'needle old'), timestamp: '2026-10-01T00:00:00Z' },
    { ...publicRecord('claude', 'needle new'), timestamp: '2026-11-01T00:00:00Z' },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(json(await contextTool(f.board, s, { op: 'search', who: s.id, q: 'needle', since: '2026-10-31T00:00:00Z', kind: 'asked' })).matches.length, 1);
  const page = json(await contextTool(f.board, s, { op: 'search', who: s.id, q: 'needle', limit: 1 }));
  fs.writeFileSync(s.transcript!, JSON.stringify(publicRecord('claude', 'needle replacement')) + '\n');
  await assert.rejects(contextTool(f.board, s, { op: 'search', who: s.id, q: 'needle', limit: 1, cursor: page.next_cursor }), /Source changed/);
});

test('resume distinguishes an old checkpoint from a changed branch or newer human request', async () => {
  const f = fixture(), s = f.sessions[0]!;
  await contextTool(f.board, s, { op: 'checkpoint', expected_revision: 0, data: { objective: 'Original task', next: 'Review original evidence' } });
  assert.equal(json(await contextTool(f.board, s, { op: 'resume' })).checkpoint_scope_matches, true);
  s.where = 'fixture@different-branch';
  handleHook(f.board, s.host, { hook_event_name: 'UserPromptSubmit', session_id: s.id, cwd: f.directory, prompt: 'A different task now.' });
  s.where = 'fixture@different-branch';
  const resume = json(await contextTool(f.board, s, { op: 'resume' }));
  assert.equal(resume.checkpoint_scope_matches, false);
  assert.equal(resume.newer_human_request, true);
  assert.equal(resume.checkpoint.data.objective, 'Original task', 'old state remains recoverable rather than silently redefined');
});

test('all three HTTP MCP routes expose and execute the same recovery contract', async t => {
  const f = fixture();
  for (const s of f.sessions) fs.writeFileSync(s.transcript!, JSON.stringify(publicRecord(s.host, `HTTP evidence from ${s.host}`)) + '\n');
  const server = createServer(f.board);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const s of f.sessions) {
    const route = s.host === 'claude' ? '/mcp' : `/mcp/${s.host}`;
    const rpc = async (method: string, params: object) => {
      const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      assert.equal(response.status, 200);
      return (await response.json() as any).result;
    };
    const tools = await rpc('tools/list', {});
    assert.ok(tools.tools.some((v: any) => v.name === 'context'));
    assert.ok(tools.tools.find((v: any) => v.name === 'inbox').inputSchema.properties.ack);
    const call = async (args: object) => {
      const result = await rpc('tools/call', { name: 'context', arguments: { me: s.name, ...args } });
      assert.notEqual(result.isError, true);
      return JSON.parse(result.content[0].text);
    };
    const search = await call({ op: 'search', q: 'HTTP evidence', limit: 1 });
    assert.equal(search.matches.length, 1);
    assert.match((await call({ op: 'read', ref: search.matches[0].ref })).text, /HTTP evidence/);
    await call({ op: 'checkpoint', expected_revision: 0, data: { objective: `HTTP ${s.host}`, next: 'Inspect source evidence' } });
    assert.equal((await call({ op: 'resume' })).checkpoint.author.host, s.host);
  }
});

test('checkpoints survive session expiry and same-repository recovery does not transfer task ownership', async () => {
  const f = fixture(), owner = f.sessions[0]!, requester = f.sessions[1]!;
  await contextTool(f.board, owner, { op: 'checkpoint', expected_revision: 0, data: { objective: 'Long-lived work', next: 'Review after recovery' } });
  const task = json(await taskTool(f.board, requester, { op: 'create', to: owner.name, text: 'Finish the shared work' }));
  await taskTool(f.board, owner, { op: 'accept', id: task.id });
  await contextTool(f.board, owner, { op: 'checkpoint', task: task.id, expected_revision: 0, data: { objective: 'Shared work', next: 'Inspect unfinished evidence' } });
  f.tick(FORGET_MS + 1);
  const fresh = f.board.touch('new-harness', f.directory, 'kimi').session; fresh.where = owner.where; fresh.project = owner.project;
  f.board.flush();
  const recovered = new Board(path.join(f.directory, 'board.json'), f.clock);
  const reader = recovered.sessions.find(s => s.id === fresh.id)!;
  const session = json(await contextTool(recovered, reader, { op: 'resume', who: owner.id }));
  assert.equal(session.archived, true);
  assert.equal(session.checkpoint.data.objective, 'Long-lived work');
  const handoff = json(await contextTool(recovered, reader, { op: 'resume', task: task.id }));
  assert.equal(handoff.recovery_only, true);
  assert.equal(handoff.checkpoint.data.next, 'Inspect unfinished evidence');
  await assert.rejects(taskTool(recovered, reader, { op: 'complete', id: task.id, text: 'Not mine' }), /unknown to this session/);
});

test('coordination frames remain retrievable as notices, never mislabeled as human requests', async () => {
  const f = fixture();
  const text = '<kokuban-message from="Peer" id="123">coordinationneedle: inspect the evidence</kokuban-message>';
  for (const s of f.sessions) {
    const record = s.host === 'claude' ? { type: 'attachment', attachment: { type: 'hook_additional_context', content: [text] } } : publicRecord(s.host, text);
    fs.writeFileSync(s.transcript!, JSON.stringify(record) + '\n');
  }
  const reader = f.sessions[0]!;
  const notices = json(await contextTool(f.board, reader, { op: 'search', q: 'coordinationneedle', kind: 'notice' }));
  assert.equal(notices.matches.length, 3);
  assert.equal(json(await contextTool(f.board, reader, { op: 'search', q: 'coordinationneedle', kind: 'asked' })).matches.length, 0);
});
