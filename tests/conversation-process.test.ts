import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { spawnOwned, closeOwned } from '../src/conversations/providers/process-owner.js';

const available = process.platform === 'win32' && fs.existsSync('assets/agent-host/AgentHost.exe');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tree = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});console.log(JSON.stringify({parent:process.pid,child:c.pid}));setInterval(()=>{},1000);`;
async function firstLine(child: ReturnType<typeof spawn>): Promise<any> {
  return new Promise((resolve, reject) => {
    let text = ''; const timeout = setTimeout(() => { child.kill(); reject(new Error('No process receipt')); }, 10000);
    child.stdout!.on('data', b => { text += b; if (text.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(text.split('\n')[0])); } });
    child.on('error', e => { clearTimeout(timeout); reject(e); });
    child.stderr!.on('data', b => { if (String(b).includes('failed')) { clearTimeout(timeout); reject(new Error(String(b))); } });
  });
}
async function gone(...pids: number[]): Promise<void> {
  for (let i = 0; i < 100; i++) { if (pids.every(pid => !alive(pid))) return; await delay(30); }
  assert.fail('Owned process tree survived termination');
}
test('Windows agent host forwards pipes and exact quoted Unicode arguments', { skip: !available }, async () => {
  const values = ['space here', '日本語', 'quote"inside', 'C:\\folder with spaces\\', ''];
  const child = spawnOwned(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ...values], process.cwd());
  try { assert.deepEqual(await firstLine(child), values); } finally { await closeOwned(child); }
});
test('Shutdown kills only its contained provider and grandchild', { skip: !available }, async () => {
  const child = spawnOwned(process.execPath, ['-e', tree], process.cwd());
  const pids = await firstLine(child);
  await closeOwned(child);
  await gone(pids.parent, pids.child);
  assert.equal(alive(process.pid), true);
});
test('parent supervisor death closes the Job and kills the owned descendants', { skip: !available }, async () => {
  const module = pathToFileURL(path.resolve('dist/src/conversations/providers/process-owner.js')).href;
  const code = `import {spawnOwned} from ${JSON.stringify(module)}; const c=spawnOwned(process.execPath,['-e',${JSON.stringify(tree)}],process.cwd());c.stdout.pipe(process.stdout);c.stderr.pipe(process.stderr);setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  try { const pids = await firstLine(owner); owner.kill(); await gone(pids.parent, pids.child); }
  finally { if (owner.exitCode === null) owner.kill(); }
});
