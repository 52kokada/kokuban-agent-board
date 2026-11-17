// npm test: run the built tests against a temp data folder and default settings, never this PC's live board.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'kokuban-test-state-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^KOKUBAN_/i.test(k)));
env.LOCALAPPDATA = state;
const list = (dir, keep) => fs.readdirSync(path.join(root, dir)).filter(keep).map((f) => path.join(dir, f));
const tests = [
  ...list('dist/tests', (f) => f.endsWith('.test.js')),
  ...list('tests/voice-worker', (f) => f.endsWith('.test.mjs')),
  ...list('tests', (f) => f === 'token-audit.test.mjs' || /^kimi-.*\.test\.mjs$/.test(f)),
];
const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
fs.rmSync(state, { recursive: true, force: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
