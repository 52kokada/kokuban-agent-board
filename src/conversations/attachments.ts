import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatError, uuid } from './contracts.js';
export interface Attachment { id: string; name: string; bytes: number; mime: string; voiceNote?: boolean }
export interface RuntimeAttachment extends Attachment { path: string }
export const MAX_UPLOAD = 10 * 1024 * 1024;
export function attachmentPath(root: string, session: string, id: string): string { return path.join(root, uuid(session), uuid(id)); }
export function saveAttachment(root: string, session: string, name: string, data: Buffer): Attachment {
  if (!data.length || data.length > MAX_UPLOAD) throw new ChatError('Files must contain 1 byte to 10 MB', 413);
  if (!name || name.length > 160 || /[\x00-\x1f\x7f\\/]/.test(name)) throw new ChatError('Use a plain filename of at most 160 characters');
  const directory = path.join(root, uuid(session)); fs.mkdirSync(directory, { recursive: true });
  const files = fs.readdirSync(directory); const bytes = files.reduce((n, f) => n + fs.statSync(path.join(directory, f)).size, 0);
  if (files.length >= 100 || bytes + data.length > 250 * 1024 * 1024) throw new ChatError('This conversation attachment limit has been reached', 429, true);
  // Do not trust a browser-provided MIME type. Only known raster signatures become model images.
  const mime = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'image/jpeg'
    : /^GIF8[79]a/.test(data.subarray(0, 6).toString('ascii')) ? 'image/gif'
    : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : 'application/octet-stream';
  const a = { id: randomUUID(), name, bytes: data.length, mime };
  const fd = fs.openSync(attachmentPath(root, session, a.id), 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return a;
}
