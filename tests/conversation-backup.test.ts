import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupConversations } from '../src/conversations/backup.js';

test('online backup retains committed WAL data, verifies integrity, and never replaces an existing file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-backup-'));
  const source = path.join(root, 'source.sqlite'), output = path.join(root, 'snapshot.sqlite');
  const live = new DatabaseSync(source);
  try {
    live.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=1; CREATE TABLE sessions(id TEXT, body TEXT);');
    live.prepare('INSERT INTO sessions VALUES (?,?)').run('committed-in-wal', 'あ'.repeat(100000));
    assert.ok(fs.statSync(source + '-wal').size > 100000);
    const receipt = await backupConversations(source, output);
    assert.equal(receipt.version, 1); assert.match(receipt.sha256, /^[a-f0-9]{64}$/); assert.ok(receipt.pages > 1);
    const restored = new DatabaseSync(output, { readOnly: true });
    try { assert.equal(restored.prepare('SELECT id FROM sessions').get()!.id, 'committed-in-wal'); }
    finally { restored.close(); }
    live.prepare('INSERT INTO sessions VALUES (?,?)').run('after-backup', 'later');
    await assert.rejects(backupConversations(source, output), /new file/);
    const intact = new DatabaseSync(output, { readOnly: true });
    try { assert.equal(intact.prepare('SELECT count(*) AS n FROM sessions').get()!.n, 1); }
    finally { intact.close(); }
    assert.deepEqual(fs.readdirSync(root).filter(n => n.includes('.partial')), []);
    // One self-contained file: not WAL mode, so readers create no sidecars next to it.
    const single = new DatabaseSync(output, { readOnly: true });
    try { assert.equal(single.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete'); }
    finally { single.close(); }
  } finally { live.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
