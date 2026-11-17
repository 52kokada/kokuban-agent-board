import { spawn } from 'node:child_process';
if (process.platform === 'win32') {
  const child = spawn('dotnet', ['publish', 'tools/AgentHost/AgentHost.csproj', '--configfile', 'app-windows/nuget.config', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-p:PublishSingleFile=true', '-o', 'assets/agent-host'], { windowsHide: true, stdio: 'inherit' });
  child.on('error', () => { process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
