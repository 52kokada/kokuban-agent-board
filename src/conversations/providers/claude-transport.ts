import { Transform, type TransformCallback } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** The pinned CLI's public control protocol supports cancel_queued; the SDK wrapper omits it. */
export function cancelQueuedOnInterrupt(child: ChildProcessWithoutNullStreams): ChildProcessWithoutNullStreams {
  const target = child.stdin;
  let pending = '';
  const input = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      pending += chunk.toString('utf8');
      if (Buffer.byteLength(pending) > 16 * 1024 * 1024) { done(new Error('Claude input frame too large')); return; }
      let end: number;
      try {
        while ((end = pending.indexOf('\n')) >= 0) {
          const raw = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!raw.trim()) continue;
          const message = JSON.parse(raw);
          if (message.type === 'control_request' && message.request?.subtype === 'interrupt') message.request.cancel_queued = true;
          this.push(JSON.stringify(message) + '\n');
        }
        done();
      } catch { done(new Error('Claude SDK sent an invalid control frame')); }
    },
  });
  input.on('error', () => target.destroy()); target.on('error', () => input.destroy());
  input.pipe(target);
  Object.defineProperty(child, 'stdin', { value: input });
  return child;
}
