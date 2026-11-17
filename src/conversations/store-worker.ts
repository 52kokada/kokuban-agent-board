// Only this worker touches the SQLite connection; fsync never blocks the board's event loop.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import type { ChatEvent, ChatSession } from './contracts.js';
const db = new DatabaseSync(workerData.file);
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000;');
const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
if (version > 3) throw new Error('Conversation database is newer than this board');
db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,name_key TEXT NOT NULL,live INTEGER NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS active_names ON sessions(name_key) WHERE live=1;
 CREATE UNIQUE INDEX IF NOT EXISTS one_chief ON sessions(json_extract(data,'$.role')) WHERE json_extract(data,'$.role')='chief';
 CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session TEXT NOT NULL REFERENCES sessions(id),data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS session_events ON events(session,seq);
 CREATE TABLE IF NOT EXISTS commands(actor TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(actor,id));
 CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,session TEXT NOT NULL REFERENCES sessions(id),data TEXT NOT NULL);
 PRAGMA user_version=${Math.max(2,version)}; COMMIT;`);
parentPort!.postMessage({ ready: true });
const PAGE_BYTES = 256 * 1024;
/** One event as pages carry it: oversized events keep a short text and point to their full detail. */
function project(row: Record<string, unknown>): ChatEvent & { seq: number } {
  const full = String(row.data), event = { ...JSON.parse(full), seq: Number(row.seq) };
  return Buffer.byteLength(full) > 60000 ? { ...event, text: event.text?.slice(0, 4000), data: { detailId: event.id, bytes: Buffer.byteLength(full), truncated: true } } : event;
}
parentPort!.on('message', ({ id, op, args }) => {
  try {
    let result: unknown;
    switch (op) {
      case 'attachment': { const r = db.prepare('SELECT data FROM attachments WHERE session=? AND id=?').get(args.sessionId, args.id); result = r ? JSON.parse(String(r.data)) : null; break; }
      case 'list': result = db.prepare("SELECT data FROM sessions ORDER BY CASE WHEN json_extract(data,'$.role')='chief' THEN 0 ELSE 1 END,rowid DESC LIMIT 500").all().map(r => JSON.parse(String(r.data))); break;
      case 'get': { const row = db.prepare('SELECT data FROM sessions WHERE id=?').get(args.id); result = row ? JSON.parse(String(row.data)) : null; break; }
      case 'receipt': { const r = db.prepare('SELECT hash,receipt FROM commands WHERE actor=? AND id=?').get(args.actor, args.id); result = r ? { hash: r.hash, receipt: JSON.parse(String(r.receipt)) } : null; break; }
      case 'page': {
        const rows = db.prepare('SELECT seq,data FROM events WHERE session=? AND seq>? ORDER BY seq LIMIT 200').all(args.sessionId, args.after);
        let bytes = 0;
        const page = [];
        for (const row of rows) {
          const projected = project(row);
          bytes += Buffer.byteLength(JSON.stringify(projected));
          if (bytes > PAGE_BYTES) break;
          page.push(projected);
        }
        result = page;
        break;
      }
      case 'history': {
        // The newest events before a cursor, read backwards on the (session, seq) index: opening a
        // long conversation never reads all of it. Returned in ascending order like 'page'.
        const before = args.before ?? Number.MAX_SAFE_INTEGER;
        const rows = db.prepare('SELECT seq,data FROM events WHERE session=? AND seq<? ORDER BY seq DESC LIMIT 200').all(args.sessionId, before);
        let bytes = 0;
        const page = [];
        for (const row of rows) {
          const projected = project(row);
          bytes += Buffer.byteLength(JSON.stringify(projected));
          if (bytes > PAGE_BYTES && page.length) break;
          page.push(projected);
        }
        page.reverse();
        const oldest = page.length ? page[0].seq : before;
        const more = page.length > 0 && Boolean(db.prepare('SELECT 1 FROM events WHERE session=? AND seq<? LIMIT 1').get(args.sessionId, oldest));
        result = { events: page, before: oldest, hasMore: more };
        break;
      }
      case 'detail': {
        const row = db.prepare('SELECT seq,data FROM events WHERE session=? AND id=?').get(args.sessionId, args.eventId);
        result = row ? { ...JSON.parse(String(row.data)), seq: Number(row.seq) } : null;
        break;
      }
      case 'commit': {
        db.exec('BEGIN IMMEDIATE');
        try {
          const s = args.session as ChatSession;
          // Older boards must never resume a chief/delegate without the enforced policy.
          if(s.role==='chief'||s.chiefParent)db.exec('PRAGMA user_version=3');
          const row = db.prepare('SELECT revision FROM sessions WHERE id=?').get(s.id);
          if ((row ? Number(row.revision) : -1) !== args.expected) throw new Error('Session changed; refresh before retrying');
          db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name_key=excluded.name_key,live=excluded.live,revision=excluded.revision,data=excluded.data')
            .run(s.id, s.name.toLowerCase(), s.phase === 'closed' ? 0 : 1, s.revision, JSON.stringify(s));
          for (const event of args.events as ChatEvent[]) {
            db.prepare('INSERT INTO events(id,session,data) VALUES(?,?,?)').run(event.id, s.id, JSON.stringify(event));
            if (event.kind === 'attachment') {
              const a = (event.data as { attachment: { id: string } }).attachment;
              db.prepare('INSERT INTO attachments VALUES(?,?,?)').run(a.id, s.id, JSON.stringify(a));
            }
          }
          if (args.command) db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(args.command.actor, args.command.id, args.command.hash, JSON.stringify(args.command.receipt));
          db.exec('COMMIT'); result = true;
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        break;
      }
      case 'close': db.close(); parentPort!.postMessage({ id, result: true }); parentPort!.close(); return;
      default: throw new Error('Unknown conversation storage operation');
    }
    parentPort!.postMessage({ id, result });
  } catch (e) { parentPort!.postMessage({ id, error: (e as Error).message }); }
});
