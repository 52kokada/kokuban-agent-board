/**
 * One request to Codex's local app-server, reached with `codex app-server
 * proxy`. The proxy only carries bytes; the socket behind it speaks WebSocket,
 * so this does the handshake and framing itself.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { codexExe } from './wake.js';

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  let head: Buffer;
  if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) head = Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255]);
  else {
    // A steered batch of mail can pass 64 KiB once encoded; a 16-bit length would cut it short.
    head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([head, mask, payload.map((byte, i) => byte ^ mask[i % 4]!)]);
}

/** Resolves with the result, or null on any failure; never throws. */
export function codexRpc<T>(method: string, params: object): Promise<T | null> {
  const exe = codexExe();
  if (!exe) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(exe, ['app-server', 'proxy'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (result: T | null) => {
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), 8000);
    const send = (msg: object) => child.stdin.write(frame(JSON.stringify(msg)));
    let raw = Buffer.alloc(0);
    let upgraded = false;
    let text = '';
    child.on('error', () => finish(null));
    child.stdin.on('error', () => finish(null));
    child.stdout.on('data', (chunk: Buffer) => {
      raw = Buffer.concat([raw, chunk]);
      if (!upgraded) {
        const end = raw.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (!raw.subarray(0, end).toString().startsWith('HTTP/1.1 101')) return finish(null);
        raw = raw.subarray(end + 4);
        upgraded = true;
        send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'kokuban', title: 'kokuban', version: '0.4.0' } } });
      }
      while (raw.length >= 2) {
        let length = raw[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (raw.length < 4) return;
          length = raw.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (raw.length < 10) return;
          length = Number(raw.readBigUInt64BE(2));
          offset = 10;
        }
        if (raw.length < offset + length) return;
        const opcode = raw[0]! & 0x0f;
        const final = raw[0]! & 0x80;
        const body = raw.subarray(offset, offset + length).toString();
        raw = raw.subarray(offset + length);
        // Text frames and their continuations carry messages; pings and closes are skipped.
        if (opcode > 1) continue;
        text += body;
        if (!final) continue;
        let msg: { id?: number; result?: T; error?: unknown };
        try {
          msg = JSON.parse(text);
        } catch {
          msg = {};
        }
        text = '';
        if (msg.id === 0) {
          send({ method: 'initialized' });
          send({ id: 1, method, params });
        } else if (msg.id === 1) {
          return finish(msg.error ? null : msg.result ?? ({} as T));
        }
      }
    });
    child.stdin.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
}

/**
 * A thread's runtime status as app-server reports it. An active thread carries flags, such as
 * "waitingOnUserInput" while a blocking request_user_input waits for its human, or
 * "waitingOnApproval" while an approval prompt does (D127).
 */
export interface CodexThreadStatus { type: string; flags: string[] }

/** Which Codex threads are open right now: id → { type: "idle" | "active" | "notLoaded" | ..., flags }. */
export async function codexThreadStates(): Promise<Map<string, CodexThreadStatus> | null> {
  const list = await codexRpc<{ data: Array<{ id: string; status?: { type?: string; activeFlags?: unknown } }> }>('thread/list', { limit: 100 });
  return list?.data ? new Map(list.data.map((t) => [t.id, {
    type: t.status?.type ?? '',
    flags: Array.isArray(t.status?.activeFlags) ? t.status.activeFlags.filter((f): f is string => typeof f === 'string') : [],
  }])) : null;
}

/**
 * Add text to a thread's running turn (`turn/steer`), as another participant's input; the turn and
 * any question it asked its human stay as they are. Measured on Codex 0.166 (D127): while a blocking
 * request_user_input waits, the steer is accepted but the model reads it only once the human answers;
 * after an async question it reads it at once. Resolves the turn id it went into, or null.
 */
export async function codexSteer(threadId: string, text: string, rpc = codexRpc): Promise<string | null> {
  const turns = await rpc<{ data?: Array<{ id?: string; status?: string }> }>('thread/turns/list', { threadId, limit: 1 });
  const turn = turns?.data?.find((t) => t.status === 'inProgress')?.id;
  if (!turn) return null;
  const out = await rpc<{ turnId?: string }>('turn/steer', {
    threadId, expectedTurnId: turn, input: [{ type: 'text', text, text_elements: [] }],
  });
  return out?.turnId ?? null;
}
