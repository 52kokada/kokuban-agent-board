// Guarded local activation of the tested wake modules; preserve unrelated deployed code.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { backupConversations } from '../dist/src/conversations/backup.js';
await import('./wait-for-managed-idle.mjs');
const root = path.resolve(import.meta.dirname, '..');
const modules = process.argv.includes('--recovery') ? ['hooks.js', 'wake.js'] : process.argv.includes('--glance') ? ['glance.js'] : ['wake.js', 'daemon.js'];
const data = path.join(process.env.LOCALAPPDATA, 'kokuban');
const backup = path.join(data, 'activation-backups', `kimi-${process.argv.includes('--glance') ? 'glance' : 'wake'}-${Date.now()}`);
fs.mkdirSync(backup, { recursive: true });
for (const file of ['board.json', 'settings.json']) {
  if (fs.existsSync(path.join(data, file))) fs.copyFileSync(path.join(data, file), path.join(backup, file));
}
if (fs.existsSync(path.join(data, 'conversations.sqlite'))) {
  await backupConversations(path.join(data, 'conversations.sqlite'), path.join(backup, 'conversations.sqlite'));
}
const build = process.env.KOKUBAN_TEST_BUILD || 'dist-dev';
for (const file of modules) {
  fs.copyFileSync(path.join(root, 'dist/src', file), path.join(backup, file));
  if (!fs.existsSync(path.join(root, build, 'src', file))) throw Error('Compile the tested build first');
}
const processes = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
  "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
  { windowsHide: true, encoding: 'utf8' }));
const expected = { test: (cmd) => cmd.toLowerCase().endsWith(`"${path.join(root, 'dist', 'src', 'daemon.js')}"`.toLowerCase()) };
const matches = processes.filter(p => expected.test(p.CommandLine || ''));
if (matches.length !== 1) throw Error('Expected exactly one known Kokuban daemon');
execFileSync(process.execPath, ['scripts/wait-for-managed-idle.mjs'], { cwd: root, windowsHide: true, stdio: 'inherit' });
for (const file of modules) fs.copyFileSync(path.join(root, build, 'src', file), path.join(root, 'dist/src', file));
process.kill(matches[0].ProcessId);
await new Promise(resolve => setTimeout(resolve, 500));
const startup = path.join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Startup/kokuban.vbs');
spawn('wscript.exe', [startup], { windowsHide: true, stdio: 'ignore' }).unref();
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch('http://127.0.0.1:47600/mcp/kimi', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }), signal: AbortSignal.timeout(1000),
    });
    if (r.ok && (await r.json()).result?.serverInfo?.name === 'kokuban') {
      console.log(JSON.stringify({ ready: true, backup, oldPid: matches[0].ProcessId }));
      process.exit(0);
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 250));
}
throw Error(`Kokuban did not become ready; recovery backup: ${backup}`);
