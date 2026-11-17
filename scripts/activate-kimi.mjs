// Routine restart; preserve the deployed build.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { backupConversations } from '../dist/src/conversations/backup.js';
await import('./wait-for-managed-idle.mjs');
const root = path.resolve(import.meta.dirname, '..');
const data = path.join(process.env.LOCALAPPDATA, 'kokuban');
const backup = path.join(data, 'activation-backups', `kimi-${Date.now()}`);
fs.mkdirSync(backup, { recursive: true });
for (const file of ['board.json', 'settings.json']) {
  if (fs.existsSync(path.join(data, file))) fs.copyFileSync(path.join(data, file), path.join(backup, file));
}
if (fs.existsSync(path.join(data, 'conversations.sqlite'))) {
  await backupConversations(path.join(data, 'conversations.sqlite'), path.join(backup, 'conversations.sqlite'));
}
const daemon = path.join(root, 'dist/src/daemon.js');
fs.copyFileSync(daemon, path.join(backup, 'daemon.js'));
let text = fs.readFileSync(daemon, 'utf8');
if (!text.includes("route === '/hook/kimi'")) {
  const changes = [
    ["if (route === '/hook/claude')", "if (route === '/hook/claude' || route === '/hook/kimi')"],
    ["handleHook(board, 'claude', parsed)", "handleHook(board, route === '/hook/kimi' ? 'kimi' : 'claude', parsed)"],
    ["if (route === '/mcp' || route === '/mcp/codex')", "if (route === '/mcp' || route === '/mcp/codex' || route === '/mcp/kimi')"],
    ["const agent = route === '/mcp/codex' ? 'codex' : 'claude'", "const agent = route === '/mcp/kimi' ? 'kimi' : route === '/mcp/codex' ? 'codex' : 'claude'"],
  ];
  for (const [from, to] of changes) {
    if (text.split(from).length !== 2) throw new Error(`Expected exactly one deployed match: ${from}`);
    text = text.replace(from, to);
  }
}
const processes = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
  "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
  { windowsHide: true, encoding: 'utf8' }));
const expected = { test: (cmd) => cmd.toLowerCase().endsWith(`"${path.join(root, 'dist', 'src', 'daemon.js')}"`.toLowerCase()) };
const matches = processes.filter(p => expected.test(p.CommandLine || ''));
if (matches.length !== 1) throw new Error('Expected exactly one known Kokuban daemon');
execFileSync(process.execPath, ['scripts/wait-for-managed-idle.mjs'], { cwd: root, windowsHide: true, stdio: 'inherit' });
fs.writeFileSync(daemon, text);
process.kill(matches[0].ProcessId);
await new Promise(resolve => setTimeout(resolve, 500));
const startup = path.join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Startup/kokuban.vbs');
const child = spawn('wscript.exe', [startup], { windowsHide: true, stdio: 'ignore' });
child.unref();
for (let i = 0; i < 60; i++) {
  try {
    const response = await fetch('http://127.0.0.1:47600/mcp/kimi', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }), signal: AbortSignal.timeout(1000),
    });
    if (response.ok && (await response.json()).result?.serverInfo?.name === 'kokuban') {
      console.log(JSON.stringify({ ready: true, backup, oldPid: matches[0].ProcessId }));
      process.exit(0);
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 250));
}
throw new Error(`Kokuban did not become ready; deployed daemon backup: ${backup}`);
