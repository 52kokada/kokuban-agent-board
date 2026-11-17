import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '../src/conversations/store.js';
import { saveAttachment, attachmentPath } from '../src/conversations/attachments.js';
import { ClaudeRuntime } from '../src/conversations/providers/claude.js';
import { CodexRuntime } from '../src/conversations/providers/codex.js';
import { backupConversations } from '../src/conversations/backup.js';

test('schema 1 migrates without losing history, attachment metadata survives reopen and schema 2 backs up', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-attachments-')); const file = path.join(root, 'c.sqlite');
  const id = randomUUID(); const session: any = { id, name: 'Files', phase: 'closed', revision: 0 };
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version=1; CREATE TABLE sessions(id TEXT PRIMARY KEY,name_key TEXT NOT NULL,live INTEGER NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL); CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session TEXT NOT NULL REFERENCES sessions(id),data TEXT NOT NULL); CREATE TABLE commands(actor TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(actor,id));');
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(id, 'files', 0, 0, JSON.stringify(session));
  db.prepare('INSERT INTO events(id,session,data) VALUES(?,?,?)').run(randomUUID(), id, JSON.stringify({ id: randomUUID(), kind: 'legacy', text: 'Keep this original history', sessionId: id })); db.close();
  let store = new ConversationStore(file);
  try {
    await store.ready;
    session.revision = 1;
    const a = saveAttachment(root, id, 'test.bin', Buffer.from([0,255,2]));
    await store.commit(session, 0, [{ id: randomUUID(), sessionId: id, kind: 'attachment', ts: Date.now(), data: { attachment: a } }]);
    await store.close(); store = new ConversationStore(file); await store.ready;
    assert.deepEqual(await store.attachment(id, a.id), a); assert.equal((await store.page(id, 0)).length, 2);
    assert.equal((await store.page(id, 0))[0].text, 'Keep this original history');
    assert.deepEqual(fs.readFileSync(attachmentPath(root, id, a.id)), Buffer.from([0,255,2]));
    const receipt = await backupConversations(file, path.join(root, 'backup.sqlite')); assert.equal(receipt.version, 2);
    const backup = new DatabaseSync(receipt.file, { readOnly: true });
    try { assert.equal(backup.prepare('SELECT count(*) AS n FROM attachments').get()!.n, 1); } finally { backup.close(); }
  } finally { await store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('provider adapters map images to native inputs and ordinary files to readable paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-image-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=', 'base64');
  const id = randomUUID(); const image = saveAttachment(root, id, 'photo.png', png), file = saveAttachment(root, id, 'note.txt', Buffer.from('hello'));
  const files = [image, file].map(a => ({ ...a, path: attachmentPath(root, id, a.id) }));
  const sink: any = { event() {}, turn() {}, complete() {}, approval: async () => false, exit() {} };
  try {
    const claude = new ClaudeRuntime({ id } as any, sink) as any; claude.query = {};
    await claude.send('Read these', files);
    const content = claude.inputs[0].message.content;
    assert.equal(content[1].type, 'image'); assert.equal(content[1].source.media_type, 'image/png'); assert.equal(content[1].source.data, png.toString('base64'));
    assert.ok(content[2].text.includes(files[1].path));
    const codex = new CodexRuntime({ id } as any, sink) as any; codex.child = {}; codex.thread = 'test'; let captured: any;
    codex.rpc = async (_method: string, params: unknown) => { captured = params; return { turn: { id: 'turn' } }; };
    await codex.send('Read these', files);
    assert.deepEqual(captured.input[1], { type: 'localImage', path: files[0].path }); assert.ok(captured.input[2].text.includes(files[1].path));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
