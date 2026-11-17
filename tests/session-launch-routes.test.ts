import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Board } from '../src/board.js';
import { createServer } from '../src/daemon.js';
import { APP_KEY } from '../src/app-routes.js';
import { sessionLaunch } from '../src/session-launch.js';
import { SETTINGS } from '../src/cards.js';

test('catalog is native-only, and a launch URI can claim only its own one-use plan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-launch-http-'));
  const board = new Board(); const id = '01a18676-615a-7f11-a692-0e7830720b32';
  const before = SETTINGS.file; SETTINGS.file = path.join(root, 'settings.json');
  fs.writeFileSync(SETTINGS.file, JSON.stringify({ sessionLauncher: { vscode: true } }));
  const transcript = path.join(root, `${id}.jsonl`); fs.writeFileSync(transcript, '{}');
  const s = board.touch(id, root, 'claude').session; s.transcript = transcript; board.end(id);
  const server = createServer(board); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (route: string, fields: Record<string,string>, headers = {}) => fetch(base+route, { method:'POST', body:new URLSearchParams(fields), headers });
  try {
    assert.equal((await fetch(base+'/app/sessions')).status,404);
    assert.equal((await fetch(base+`/app/sessions?t=${APP_KEY}`, {headers:{origin:'https://evil.example'}})).status,403);
    const response = await fetch(base+`/app/sessions?t=${APP_KEY}`); assert.equal(response.status, 200);
    const catalog = await response.json() as {sessions:Array<{id:string;canResume:boolean}>};
    assert.equal(catalog.sessions[0]!.id,id); assert.equal(catalog.sessions[0]!.canResume,true);
    const request = sessionLaunch(board).prepare({id,target:'vscode'});
    assert.equal((await post('/app/session-launch/claim',{grant:request.grant},{origin:'https://evil.example'})).status,403);
    assert.equal((await post('/app/session-launch/claim',{grant:'0'.repeat(64)})).status,409);
    const accepted = await post('/app/session-launch/claim',{grant:request.grant}); assert.equal(accepted.status,200);
    assert.equal(((await accepted.json()) as {id:string}).id,id);
    assert.equal((await post('/app/session-launch/claim',{grant:request.grant})).status,409);
    await post('/app/session-launch/failed',{grant:request.grant}); assert.equal(s.launchPending,undefined);
    const invalid = await post('/app/session-launch',{t:APP_KEY,host:'evil',cwd:root,target:'vscode'});
    assert.equal(((await invalid.json()) as {ok:boolean}).ok,false);
  } finally { SETTINGS.file = before; server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); fs.rmSync(root,{recursive:true,force:true}); }
});
