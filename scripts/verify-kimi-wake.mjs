// Real CLI smoke test against a private, ephemeral board. No production messages.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const build = process.env.KOKUBAN_TEST_BUILD || 'dist';
const load = file => import(pathToFileURL(path.join(root, build, 'src', file)).href);
const { Board } = await load('board.js');
const { createServer } = await load('daemon.js');
const { wakeKimi, kimiExe } = await load('wake.js');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-kimi-smoke-'));
const board = new Board(null);
const server = createServer(board);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const prior = process.env.KOKUBAN_URL;
process.env.KOKUBAN_URL = base;
try {
  await new Promise((resolve, reject) => {
    const log = fs.openSync(path.join(cwd, 'seed.log'), 'a');
    const child = spawn(kimiExe(), ['--prompt', 'This is an isolated Kokuban delivery test. Reply only READY. Do not use tools or change files.'], {
      cwd, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, KOKUBAN_KIMI_WAKE: '1' },
    });
    child.once('error', reject);
    child.once('exit', code => { fs.closeSync(log); code === 0 ? resolve() : reject(Error(`seed exited ${code}; see ${cwd}/seed.log`)); });
  });
  const target = board.sessions.find(s => s.host === 'kimi');
  if (!target || target.state !== 'idle') throw Error('Seed did not register and stop on isolated board');
  const id = target.id;
  const name = target.name;
  const sender = board.touch('manual-kimi-smoke-sender', cwd, 'other').session;
  board.send(sender, name, 'Delivery smoke test: reply only AWAKE. Do not use tools or change files.');
  let wakeExited;
  wakeKimi(board, kimiExe(), (...args) => {
    const child = spawn(...args);
    wakeExited = new Promise(resolve => child.once('exit', resolve));
    return child;
  });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && !(board.messages[0]?.delivered && target.state === 'idle')) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!board.messages[0]?.delivered || target.state !== 'idle') throw Error('Wake did not complete with hook receipt');
  if (target.id !== id || target.name !== name) throw Error('Wake changed identity');
  if (await wakeExited !== 0) throw Error('Wake CLI did not exit successfully');
  console.log(JSON.stringify({ ok: true, sameSession: true, sameName: true, hookConfirmed: true, state: target.state, cwd }));
} finally {
  if (prior === undefined) delete process.env.KOKUBAN_URL; else process.env.KOKUBAN_URL = prior;
  server.closeAllConnections();
  server.close();
}
process.exit(0);
