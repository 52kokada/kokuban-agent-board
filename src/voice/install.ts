import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VOICE_HOME, voicePaths } from './service.js';
function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => { const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => process.stdout.write(b)); child.stderr.on('data', b => process.stderr.write(b));
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('Voice installation failed. Install Python 3.12 and retry.')));
  });
}
export async function installVoice(): Promise<void> {
  fs.mkdirSync(VOICE_HOME, { recursive: true }); const p = voicePaths();
  await run(process.platform === 'win32' ? 'py' : 'python3.12', process.platform === 'win32' ? ['-3.12', '-m', 'venv', path.join(VOICE_HOME, 'venv')] : ['-m', 'venv', path.join(VOICE_HOME, 'venv')]);
  await run(p.python, ['-m', 'pip', 'install', '-r', fileURLToPath(new URL('./runtime/requirements-lock.txt', import.meta.url))]);
  for (const model of ['small', 'turbo'] as const) await run(p.python, [fileURLToPath(new URL('./runtime/download-model.py', import.meta.url)), '--model', model === 'small' ? 'small' : 'large-v3-turbo', '--model-dir', p[model]]);
  console.log('Local voice installed. Models remain offline during transcription.');
}
