// Full verification without rebuilding installed dist or reading live board settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const stage = path.join(root, '.kokuban', 'isolated-verification');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-isolated-state-'));
const treeHash = directories => {
  const hash = createHash('sha256');
  for (const directory of directories) {
    const base = path.join(root, directory);
    if (!fs.existsSync(base)) continue;
    const names = fs.statSync(base).isFile() ? [''] : fs.readdirSync(base, { recursive: true }).filter(f => fs.statSync(path.join(base, f)).isFile()).sort();
    for (const name of names) { hash.update(directory + '/' + name + '\0'); hash.update(fs.readFileSync(path.join(base, name))); }
  }
  return hash.digest('hex');
};
const sourceRoots = ['src', 'tests', 'tsconfig.json', 'package.json', 'scripts/test-isolated.mjs', 'scripts/token-audit.mjs'];
const sourceHash = treeHash(sourceRoots), installedHash = treeHash(['dist']);
const run = (args, env = process.env) => {
  const result = spawnSync(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
};
fs.mkdirSync(stage, { recursive: true });
const compiled = run(['node_modules/typescript/bin/tsc', '--outDir', path.join(stage, 'dist')]);
if (compiled) process.exit(compiled);
fs.cpSync(path.join(root, 'src/voice/runtime'), path.join(stage, 'dist/src/voice/runtime'), { recursive: true });
fs.cpSync(path.join(root, 'assets'), path.join(stage, 'assets'), { recursive: true });
const tests = fs.readdirSync(path.join(root, 'tests')).filter(f => f.endsWith('.test.ts'))
  .map(f => path.join(stage, 'dist/tests', f.replace(/\.ts$/, '.js')));
const extra = [
  ...fs.readdirSync(path.join(root, 'tests/voice-worker')).filter(f => f.endsWith('.test.mjs')).map(f => path.join(root, 'tests/voice-worker', f)),
  ...fs.readdirSync(path.join(root, 'tests')).filter(f => /^kimi-.*\.test\.mjs$/.test(f) || f === 'token-audit.test.mjs').map(f => path.join(root, 'tests', f)),
];
const status = run(['--test', ...tests, ...extra], { ...process.env, LOCALAPPDATA: state });
const installedDistUntouched = installedHash === treeHash(['dist']);
const sourceUnchangedDuringTests = sourceHash === treeHash(sourceRoots);
const finalStatus = status || (!installedDistUntouched || !sourceUnchangedDuringTests ? 1 : 0);
const report = { at: new Date().toISOString(), installedDistUntouched, sourceUnchangedDuringTests, sourceHash, stage, isolatedState: state, status: finalStatus };
fs.writeFileSync(path.join(stage, 'last-result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
process.exitCode = finalStatus;
