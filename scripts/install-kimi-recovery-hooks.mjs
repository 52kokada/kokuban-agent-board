// Add lifecycle observations without replacing unrelated Kimi settings or hooks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
const config = path.join(home, 'config.toml');
const original = fs.readFileSync(config, 'utf8');
const command = `node ${path.resolve(import.meta.dirname, 'kimi-hook.mjs').replaceAll('\\', '/')}`;
const blocks = original.split(/(?=^\[\[hooks\]\])/m);
const events = ['SessionStart', 'Interrupt', 'StopFailure', 'PostCompact'].filter(event => !blocks.some(block =>
  block.startsWith('[[hooks]]') && block.includes(`event = "${event}"`) && block.includes(command)));
if (!events.length) { console.log('Kimi recovery hooks already installed.'); process.exit(0); }
const backup = `${config}.backup-recovery-${Date.now()}`;
fs.copyFileSync(config, backup);
try {
  fs.writeFileSync(config, original + '\n' + events.map(event =>
    `[[hooks]]\nevent = "${event}"\ncommand = ${JSON.stringify(command)}\ntimeout = 6\n`).join('\n'));
  execFileSync(path.join(home, 'bin', process.platform === 'win32' ? 'kimi.exe' : 'kimi'), ['doctor'], {
    windowsHide: true, stdio: 'pipe',
  });
  console.log(JSON.stringify({ installed: events, backup, note: 'Reopened Kimi processes load the new hooks.' }));
} catch (error) {
  fs.copyFileSync(backup, config);
  throw error;
}
