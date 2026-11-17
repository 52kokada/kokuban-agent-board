import { Worker } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatEvent, ChatSession } from './contracts.js';
import type { Attachment } from './attachments.js';
export interface Receipt { actor: string; id: string; hash: string; receipt: ChatSession }
export class ConversationStore {
  attachment(sessionId: string, id: string): Promise<Attachment | null> { return this.call('attachment', { sessionId, id }); }
  private worker: Worker;
  private serial = 0;
  private failure?: Error;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  readonly ready: Promise<void>;
  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.worker = new Worker(new URL('./store-worker.js', import.meta.url), { workerData: { file } });
    this.ready = new Promise((resolve, reject) => {
      this.worker.on('message', m => {
        if (m.ready) { resolve(); return; }
        const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      });
      const fail = (error: Error) => { this.failure = error; reject(error); for (const p of this.pending.values()) p.reject(error); this.pending.clear(); };
      this.worker.on('error', fail);
      this.worker.on('exit', code => fail(new Error(`Conversation storage closed (${code})`)));
    });
  }
  private async call<T>(op: string, args: object = {}): Promise<T> {
    await this.ready;
    if (this.failure) throw this.failure;
    return new Promise((resolve, reject) => { const id = ++this.serial; this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, op, args }); });
  }
  list(): Promise<ChatSession[]> { return this.call('list'); }
  get(id: string): Promise<ChatSession | null> { return this.call('get', { id }); }
  receipt(actor: string, id: string): Promise<{ hash: string; receipt: ChatSession } | null> { return this.call('receipt', { actor, id }); }
  page(sessionId: string, after: number): Promise<ChatEvent[]> { return this.call('page', { sessionId, after }); }
  history(sessionId: string, before?: number): Promise<{ events: ChatEvent[]; before: number; hasMore: boolean }> { return this.call('history', { sessionId, before }); }
  detail(sessionId: string, eventId: string): Promise<ChatEvent | null> { return this.call('detail', { sessionId, eventId }); }
  commit(session: ChatSession, expected: number, events: ChatEvent[], command?: Receipt): Promise<boolean> { return this.call('commit', { session, expected, events, command }); }
  async close(): Promise<void> { await this.call('close'); await this.worker.terminate(); }
}
