import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ChatError } from '../contracts.js';

export function spawnOwned(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): ChildProcessWithoutNullStreams {
  if (process.platform !== 'win32') return spawn(exe, args, { cwd, env, signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const host = fileURLToPath(new URL('../../../../assets/agent-host/AgentHost.exe', import.meta.url));
  if (!fs.existsSync(host)) throw new ChatError('The managed agent process host is not built. Run npm run build:agent-host.', 503);
  return spawn(host, [String(process.pid), exe, ...args], { cwd, env, signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}
export async function closeOwned(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 2000);
  let deadline: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Agent shutdown was not confirmed')), 6000); });
  try { await Promise.race([exited, timeout]); } finally { clearTimeout(timer); clearTimeout(deadline!); }
}
