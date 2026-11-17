/**
 * Local keyed API for the native Windows app, on 127.0.0.1 only:
 *
 *   GET  /app/feed.json?t=<key>                        the view (feed.ts)
 *   GET  /app/events?t=<key>                           a stream that says "changed" whenever the view may have
 *   POST /app/act                                      what the person did: t, thread, action, text
 *   GET  /app/open?as=pill|window                      the page's address, for the app started by its hotkey;
 *                                                      a local program's request only, like every other route
 *   GET  /app/key                                      the key and the contract (api), for the Windows app;
 *                                                      a local program's request only
 *   POST /app/hello                                    the Windows app is running: t, pid, exe; every minute
 *   GET  /app/native                                   the Windows app's program while it is running; local only
 *   GET  /app/file?t=&thread=&n=                       one of a card's attachments, for the Windows app
 *   GET  /app/releases/<file>                          the app's own releases, for its updater; local only
 *
 * The key is made when the board starts and is only ever handed to the app, so a page elsewhere
 * cannot read the feed or act on it.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as path from 'node:path';
import type { Board } from './board.js';
import { feedFile } from './app-update.js';
import { BASE_URL, PORT } from './config.js';
import { act, feedView, listen, readerLang, self } from './feed.js';
import { sessionLaunch } from './session-launch.js';

const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;
const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8' };

export const APP_KEY = randomBytes(16).toString('hex');
/** The contract a client that is not a page reads (the Windows app): bumped when feed.json or act change shape. */
export const APP_API = 1;

/** The Windows app says hello every minute while it runs; two missed and it is taken as gone. */
export const HELLO_MS = 150_000;
let hello: { pid: number; exe: string; at: number } | null = null;
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** The native app's recent heartbeat; null means cards remain saved without claiming display. */
export function nativeApp(now = Date.now()): { pid: number; exe: string } | null {
  if (!hello || now - hello.at > HELLO_MS || !alive(hello.pid)) return null;
  return { pid: hello.pid, exe: hello.exe };
}

/** Forget the app (tests). */
export function forgetApp(): void {
  hello = null;
}
export const appUrl = (as: 'pill' | 'window', item = ''): string =>
  `${BASE_URL}/app?t=${APP_KEY}&as=${as}${item ? `&item=${encodeURIComponent(item)}` : ''}`;

function body(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) return reject(new Error('request too large'));
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Answer a request for the app, if it is one. Resolves false for every other route. */
export async function appRoutes(board: Board, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname;
  if (route !== '/app' && !route.startsWith('/app/')) return false;
  const send = (status: number, text = '', type = 'application/json'): true => {
    res.writeHead(status, text ? { 'content-type': type, 'cache-control': 'no-store' } : {});
    res.end(text);
    return true;
  };
  const get = req.method === 'GET';
  const origin = req.headers.origin;
  if (origin && origin !== BASE_URL && origin !== `http://localhost:${PORT}`) return send(403);

  if (get && route === '/app/open') {
    if (origin) return send(403);
    // "auto", the hotkey's first press: the pill when something waits, otherwise the window.
    const asked = url.searchParams.get('as');
    const as = asked === 'window' || (asked === 'auto' && feedView(board).mine.length === 0) ? 'window' : 'pill';
    return send(200, JSON.stringify({ url: appUrl(as, url.searchParams.get('item') ?? '') }));
  }
  if (get && route === '/app/key') {
    if (origin) return send(403);
    return send(200, JSON.stringify({ key: APP_KEY, api: APP_API }));
  }
  if (get && route.startsWith('/app/releases/')) {
    // The app's updater on this PC reads its releases here (app-update.ts): a local program only.
    if (origin) return send(403);
    const data = feedFile(decodeURIComponent(route.slice('/app/releases/'.length)));
    if (!data) return send(404);
    res.writeHead(200, { 'content-type': route.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
    return true;
  }
  if (get && route === '/app/native') {
    if (origin) return send(403);
    const app = nativeApp();
    return app ? send(200, JSON.stringify(app)) : send(404);
  }
  // This route contains a UTF-8 JSON message inside form encoding (%XX per byte).
  const form = get ? url.searchParams : new URLSearchParams(await body(req, route === '/app/conversations' ? 160_000 : 64_000));
  // The URI carries only this random, short-lived capability, never shell input.
  if (req.method === 'POST' && route === '/app/session-launch/claim') {
    if (origin) return send(403);
    try { return send(200, JSON.stringify(sessionLaunch(board).consume(form.get('grant') ?? ''))); }
    catch (error) { return send(409, JSON.stringify({ error: (error as Error).message })); }
  }
  if (req.method === 'POST' && route === '/app/session-launch/failed') {
    if (origin) return send(403);
    sessionLaunch(board).failed(form.get('grant') ?? ''); return send(200, JSON.stringify({ ok: true }));
  }
  if (form.get('t') !== APP_KEY) return send(404);

  if (get && route === '/app/sessions') {
    if (origin) return send(403);
    return send(200, JSON.stringify(sessionLaunch(board).catalog()));
  }
  if (req.method === 'POST' && route === '/app/session-launch/reset') {
    if (origin) return send(403);
    if (form.get('confirm') !== 'checked') return send(400);
    try { sessionLaunch(board).reset(form.get('id') ?? ''); return send(200, JSON.stringify({ ok: true, done: '起動要求を解除しました。ターミナル自体は閉じていません。' })); }
    catch (error) { return send(200, JSON.stringify({ ok: false, error: (error as Error).message })); }
  }
  if (req.method === 'POST' && route === '/app/session-launch') {
    if (origin) return send(403);
    try {
      const launcher = sessionLaunch(board);
      const request = launcher.prepare({ id: form.get('id') || undefined, host: form.get('host') || undefined,
        cwd: form.get('cwd') || undefined, target: form.get('target') || undefined });
      try { await launcher.open(request.grant); } catch (error) { launcher.failed(request.grant); throw error; }
      return send(200, JSON.stringify({ ok: true, done: '起動を要求しました。対象アプリでセッションが開きます。' }));
    } catch (error) { return send(200, JSON.stringify({ ok: false, error: (error as Error).message })); }
  }

  if (req.method === 'POST' && route === '/app/conversations') {
    if (origin) return send(403);
    if (!board.conversations) return send(503, JSON.stringify({ error: 'Shared conversations are unavailable on this board' }));
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try { return send(200, JSON.stringify(await board.conversations.local(JSON.parse(form.get('request') ?? '{}'), abort.signal))); }
    catch (e) { return send(Number((e as { status?: number }).status) || 400, JSON.stringify({ error: (e as Error).message, definitive: (e as { definitive?: boolean }).definitive === true })); }
  }

  if (get && route === '/app/feed.json') return send(200, JSON.stringify({ api: APP_API, lang: readerLang(), ...feedView(board) }));
  if (get && route === '/app/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const stop = listen(board, () => res.write('data: changed\n\n'));
    // A comment now and then keeps the stream open through anything that drops quiet connections.
    const beat = setInterval(() => res.write(': beat\n\n'), 25_000);
    req.on('close', () => {
      stop();
      clearInterval(beat);
    });
    return true;
  }
  if (req.method === 'POST' && route === '/app/hello') {
    if (origin) return send(403);
    const pid = Number(form.get('pid'));
    const exe = form.get('exe') ?? '';
    // Only the app itself: a program called Kokuban.exe, as installed or as built in a checkout.
    if (!Number.isInteger(pid) || pid <= 0 || !/^[A-Za-z]:\\.+\\Kokuban\.exe$/i.test(exe)) return send(400);
    hello = { pid, exe, at: Date.now() };
    return send(200, JSON.stringify({ ok: true, every: 60 }));
  }
  if (get && route === '/app/file') {
    // A card asked on this PC: its files are here. One asked elsewhere is that board's to serve.
    const m = /^card:([^:]+):(\d+)$/.exec(url.searchParams.get('thread') ?? '');
    if (!m || m[1] !== self()) return send(404);
    const file = board.cards.find((c) => c.id === Number(m[2]))?.files[Number(url.searchParams.get('n'))];
    if (!file) return send(404);
    try {
      const data = fs.readFileSync(file.path);
      const ext = path.extname(file.name).slice(1).toLowerCase();
      res.writeHead(200, {
        'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': `${IMAGE.test(file.name) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      });
      res.end(data);
    } catch {
      return send(404);
    }
    return true;
  }
  if (req.method === 'POST' && route === '/app/act') {
    try {
      const done = await act(board, form.get('thread') ?? '', form.get('action') ?? '', form.get('text') ?? '');
      return send(200, JSON.stringify({ ok: true, done }));
    } catch (err) {
      return send(200, JSON.stringify({ ok: false, error: (err as Error).message }));
    }
  }
  return send(404);
}
