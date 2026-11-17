import { spawn } from 'node:child_process';
async function run(args) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: 'inherit' });
    child.on('error', reject); child.on('exit', resolve);
  });
  if (code !== 0) throw new Error('Managed agent build failed');
}
await run(['node_modules/typescript/bin/tsc']);
await run(['scripts/build-agent-host.mjs']);
await run(['scripts/build-chief-git.mjs']);
