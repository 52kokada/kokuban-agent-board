import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';

/** A consistent SQLite snapshot, including committed WAL data; never a raw database-file copy. */
export async function backupConversations(sourceFile: string, destinationFile: string): Promise<{ file: string; bytes: number; sha256: string; pages: number; version: number }> {
  const source = path.resolve(sourceFile), destination = path.resolve(destinationFile);
  if (!fs.statSync(source).isFile()) throw new Error('The source conversation database is not a file');
  if (source === destination || fs.existsSync(destination)) throw new Error('Backup destination must be a new file');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = path.join(path.dirname(destination), `.conversation-backup-${randomUUID()}.partial`);
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (![1, 2, 3].includes(version)) throw new Error('Unsupported conversation schema; keep the original database and use its matching board version');
    db.exec('BEGIN');
    // Pin a read snapshot while the live worker continues appending to the WAL.
    db.prepare('SELECT count(*) AS n FROM sessions').get();
    const pages = await backup(db, temporary, { rate: 256 });
    db.exec('ROLLBACK');
    // The copy keeps the source's WAL mode. Publish one self-contained file instead, so opening
    // it leaves no -wal/-shm sidecars behind and copying the file alone copies everything.
    const check = new DatabaseSync(temporary);
    try {
      check.exec('PRAGMA journal_mode=DELETE');
      if (check.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') throw new Error('Backup integrity check failed');
    } finally { check.close(); }
    const fd = fs.openSync(temporary, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(temporary)) hash.update(chunk);
    const bytes = fs.statSync(temporary).size;
    // Publishing a hard link is atomic and refuses an existing destination, including a race.
    fs.linkSync(temporary, destination);
    return { file: destination, bytes, sha256: hash.digest('hex'), pages, version };
  } finally {
    db.close();
    for (const file of [temporary, `${temporary}-wal`, `${temporary}-shm`, `${temporary}-journal`]) if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
